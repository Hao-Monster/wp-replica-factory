#!/usr/bin/env python3
"""Local-only owned fixture site lifecycle and browser acceptance runner."""
from __future__ import annotations
import argparse, hashlib, json, shutil, sys, tempfile, threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'tests' / 'fixtures' / 'owned-site'
DEFAULT_RUN = ROOT / '.replica' / 'owned-site'
RUN_MARKER = '.owned-fixture-run'
SANDBOX_MARKER = '.fixture-sandbox'
VIEWPORTS = {
    'desktop': {'width': 1440, 'height': 1000, 'dpr': 1, 'locale': 'en-US', 'timezone': 'UTC', 'expected_columns': 4},
    'mobile': {'width': 390, 'height': 844, 'dpr': 1, 'locale': 'en-US', 'timezone': 'UTC', 'expected_columns': 2},
}
TEXT_RESOURCE_SUFFIXES = {'.css', '.html', '.js', '.json', '.svg'}


def sha(path: Path) -> str:
    data = path.read_bytes()
    # Hash text resources in canonical LF form so the versioned manifest is
    # identical on Windows checkouts that use CRLF and Linux checkouts that use LF.
    if path.suffix.lower() in TEXT_RESOURCE_SUFFIXES:
        data = data.replace(b'\r\n', b'\n')
    return hashlib.sha256(data).hexdigest()


def source_files() -> list[Path]:
    excluded = {'RESOURCE_MANIFEST.json', 'STATE_MATRIX.md', 'README.md'}
    return sorted(
        (p for p in FIXTURE.rglob('*') if p.is_file() and p.name not in excluded),
        key=lambda p: p.relative_to(FIXTURE).as_posix().casefold(),
    )


def calculated_manifest() -> dict:
    return {'fixture_version': '1.0.0', 'resources': [
        {'path': p.relative_to(FIXTURE).as_posix(),
         'type': 'font' if p.suffix == '.ttf' else 'image' if p.suffix in {'.svg', '.png', '.jpg'} else 'data' if p.suffix == '.json' else 'source',
         'sha256': sha(p),
         'source': 'self-authored fixture' if p.suffix == '.svg' else 'Google Fonts Inter, SIL Open Font License 1.1' if p.suffix == '.ttf' else 'repository fixture',
         'pages': ['/grid.html', '/lazy.html', '/filters.html']}
        for p in source_files()]}


def validate_products(data: dict) -> list[str]:
    products = data.get('products') if isinstance(data, dict) else None
    if not isinstance(products, list) or not products:
        raise RuntimeError('product seed must contain a non-empty products list')
    ids = [p.get('id') for p in products]
    if any(not isinstance(p, dict) or not all(p.get(k) for k in ('id','sku','name','category','price','image')) for p in products):
        raise RuntimeError('product seed contains incomplete product fields')
    if len(ids) != len(set(ids)):
        raise RuntimeError('product seed contains duplicate business IDs')
    listed = {r['path'] for r in json.loads((FIXTURE/'RESOURCE_MANIFEST.json').read_text(encoding='utf-8'))['resources']}
    for product in products:
        image = product['image'].lstrip('/')
        if image not in listed or not (FIXTURE/image).is_file():
            raise RuntimeError(f'product image is not a listed fixture resource: {product["image"]}')
    return ids

def verify_fixture() -> dict:
    expected_path = FIXTURE / 'RESOURCE_MANIFEST.json'
    if not expected_path.is_file():
        raise RuntimeError('missing versioned RESOURCE_MANIFEST.json')
    expected = json.loads(expected_path.read_text(encoding='utf-8'))
    actual = calculated_manifest()
    if expected != actual:
        raise RuntimeError('fixture resource manifest mismatch; restore or review versioned expected hashes')
    required = {'grid.html', 'lazy.html', 'filters.html', 'data/products.json', 'assets/FixtureSans-Regular.ttf', 'assets/FixtureSans-Semibold.ttf'}
    listed = {x['path'] for x in expected['resources']}
    missing = sorted(required - listed)
    if missing:
        raise RuntimeError(f'fixture manifest missing required resources: {missing}')
    states = json.loads((FIXTURE / 'STATE_MATRIX.json').read_text(encoding='utf-8'))
    page_ids = [x['page_id'] for x in states['pages']]
    if len(page_ids) != len(set(page_ids)) or set(page_ids) != {'grid', 'lazy', 'filters'}:
        raise RuntimeError('state matrix page IDs are missing or duplicated')
    return {'fixture_version': expected['fixture_version'], 'resource_count': len(expected['resources']), 'manifest_sha256': sha(expected_path), 'state_count': len(states['pages'])}


def _no_symlink_components(path: Path) -> None:
    current = path.anchor and Path(path.anchor) or Path(path.root)
    for part in path.parts[1:] if path.anchor else path.parts:
        current /= part
        if current.exists() and current.is_symlink():
            raise RuntimeError(f'refusing symlink/junction path component: {current}')


def managed_run_path(value: Path, *, allow_create: bool = False) -> Path:
    raw = value.expanduser()
    candidate = raw if raw.is_absolute() else ROOT / raw
    candidate = candidate.resolve(strict=False)
    _no_symlink_components(candidate)
    if candidate == ROOT or candidate == ROOT / '.git' or candidate == Path(candidate.anchor):
        raise RuntimeError('run directory is outside the dedicated fixture runtime boundary')
    default_root = (ROOT / '.replica').resolve()
    if candidate == default_root / 'owned-site' or default_root in candidate.parents:
        allowed = True
    else:
        sandbox = next((p for p in [candidate.parent, *candidate.parents] if (p / SANDBOX_MARKER).is_file()), None)
        allowed = sandbox is not None and ROOT not in candidate.parents
    if not allowed:
        raise RuntimeError('run directory must be under .replica/owned-site or a marked external fixture sandbox')
    if candidate.exists() and not candidate.is_dir():
        raise RuntimeError('run directory must be a directory')
    if not allow_create and not (candidate / RUN_MARKER).is_file():
        raise RuntimeError('run directory is not owned by this fixture lifecycle')
    return candidate


def seed(run_value: Path, emit: bool = True) -> None:
    verify_fixture()
    run = managed_run_path(run_value, allow_create=True)
    run.mkdir(parents=True, exist_ok=True)
    marker = run / RUN_MARKER
    if marker.exists() and marker.read_text(encoding='utf-8') != 'owned-fixture-run-v1\n':
        raise RuntimeError('run ownership marker is invalid')
    marker.write_text('owned-fixture-run-v1\n', encoding='utf-8')
    data = json.loads((FIXTURE / 'data/products.json').read_text(encoding='utf-8'))
    ids = validate_products(data)
    (run / 'products.json').write_text(json.dumps(data, sort_keys=True, indent=2) + '\n', encoding='utf-8')
    (run / 'resource-manifest.json').write_text(json.dumps(json.loads((FIXTURE / 'RESOURCE_MANIFEST.json').read_text(encoding='utf-8')), sort_keys=True, indent=2) + '\n', encoding='utf-8')
    if emit:
        print(json.dumps({'status': 'seeded', 'run_dir': str(run), 'product_ids': ids, 'fixture': verify_fixture()}, ensure_ascii=False))


def reset(run_value: Path, emit: bool = True) -> None:
    run = managed_run_path(run_value)
    for name in ('products.json', 'resource-manifest.json'):
        target = run / name
        if target.exists() and (target.is_symlink() or not target.is_file()):
            raise RuntimeError(f'refusing to replace non-regular managed file: {target}')
    seed(run, emit=False)
    if emit:
        print(json.dumps({'status': 'reset', 'browser_storage': 'new browser context is required; no persistent storage is used'}))


def fixture_handler(run: Path):
    fixture = str(FIXTURE)
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=fixture, **kwargs)
        def do_GET(self):
            decoded = unquote(unquote(urlparse(self.path).path))
            if any(part in {'..', ''} and part == '..' for part in decoded.split('/')) or '\\' in decoded:
                self.send_error(400, 'path traversal rejected')
                return
            if decoded == '/data/products.json':
                payload = (run / 'products.json').read_bytes()
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(payload))); self.end_headers(); self.wfile.write(payload); return
            if decoded.startswith('/.git') or decoded.startswith('/.env') or decoded.startswith('/.replica'):
                self.send_error(404, 'not found'); return
            self.path = decoded
            super().do_GET()
        def log_message(self, *_args):
            return
    return Handler


def make_server(run: Path, port: int = 0):
    return ThreadingHTTPServer(('127.0.0.1', port), fixture_handler(run))


def serve(port: int, run_value: Path) -> None:
    run = managed_run_path(run_value)
    httpd = make_server(run, port)
    print(f'http://127.0.0.1:{httpd.server_port}', flush=True)
    httpd.serve_forever()


def health(url: str, run_value: Path) -> int:
    import urllib.request
    run = managed_run_path(run_value)
    fixture = verify_fixture()
    expected = json.loads((FIXTURE / 'RESOURCE_MANIFEST.json').read_text(encoding='utf-8'))
    runtime = json.loads((run / 'resource-manifest.json').read_text(encoding='utf-8'))
    validate_products(json.loads((run / 'products.json').read_text(encoding='utf-8')))
    if runtime != expected:
        print('health failed: runtime manifest differs from versioned fixture manifest', file=sys.stderr); return 1
    checks = []
    for path in ['/grid.html', '/lazy.html', '/filters.html', '/data/products.json', '/assets/FixtureSans-Regular.ttf']:
        try:
            with urllib.request.urlopen(url.rstrip('/') + path, timeout=5) as response:
                checks.append({'path': path, 'status': response.status})
        except Exception as exc:
            print(f'health failed: {path}: {exc}', file=sys.stderr); return 1
    print(json.dumps({'status': 'pass', 'fixture_integrity': fixture, 'runtime_data_sha256': sha(run / 'products.json'), 'http_checks': checks}, ensure_ascii=False)); return 0


def browser_test() -> int:
    from playwright.sync_api import sync_playwright
    summaries = []
    with tempfile.TemporaryDirectory(prefix='owned-fixture-') as temp:
        sandbox = Path(temp); (sandbox / SANDBOX_MARKER).write_text('test-owned-sandbox\n', encoding='utf-8')
        with sync_playwright() as playwright:
            for run_number in (1, 2):
                run = sandbox / f'run-{run_number}'; seed(run, emit=False)
                server = make_server(run); thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start(); base = f'http://127.0.0.1:{server.server_port}'
                try:
                    browser = playwright.chromium.launch(headless=True); context = browser.new_context(locale='en-US', timezone_id='UTC', device_scale_factor=1); context.set_default_timeout(5000)
                    blocked = []
                    def route(request):
                        parsed = urlparse(request.request.url)
                        if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.port != server.server_port:
                            blocked.append(request.request.url); request.abort(); return
                        request.continue_()
                    context.route('**/*', route)
                    observations = {}
                    for viewport_id, spec in VIEWPORTS.items():
                        page = context.new_page(); page.set_viewport_size({'width': spec['width'], 'height': spec['height']}); requests=[]; page.on('request', lambda req: requests.append(req.url))
                        page.goto(base + '/grid.html'); cards=page.locator('[data-testid=product-grid] .product-card'); ids=[cards.nth(i).get_attribute('data-product-id') for i in range(cards.count())]; images=[cards.nth(i).locator('img').evaluate('(img)=>img.complete && img.naturalWidth>0') for i in range(cards.count())]; xs=page.locator('.product-card').evaluate_all('(els)=>[...new Set(els.map(e=>Math.round(e.getBoundingClientRect().left)))]'); columns=len(xs); font=page.locator('h1').evaluate("el => ({family:getComputedStyle(el).fontFamily, status:document.fonts.status, loaded:[...document.fonts].some(f=>f.family==='FixtureSans' && f.status==='loaded'), check:document.fonts.check('16px FixtureSans')})"); viewport_observations={'grid':{'visible_ids':ids,'image_decoded':images,'columns':columns,'font':font} }
                        page.goto(base + '/lazy.html'); before=[u for u in requests if 'fern-pattern.svg' in u]; panel=page.locator('#lazy-panel'); before_state=panel.get_attribute('data-loaded'); page.locator('#lazy-panel').scroll_into_view_if_needed(); page.wait_for_function("document.querySelector('#lazy-panel').dataset.loaded === 'true'"); after=[u for u in requests if 'fern-pattern.svg' in u]; background_image=page.locator('#lazy-panel').evaluate("el=>getComputedStyle(el).backgroundImage"); resource_loaded='fern-pattern.svg' in background_image; viewport_observations['lazy']={'before_state':before_state,'after_state':panel.get_attribute('data-loaded'),'background_requests_before':[urlparse(u).path for u in before],'background_requests_after':[urlparse(u).path for u in after],'resource_loaded':resource_loaded,'background_rendered':resource_loaded,'svg_count':page.locator('.svg-mark').count()}
                        page.goto(base + '/filters.html'); page.locator('.menu-toggle').click(); menu_open=page.locator('#site-menu').is_visible(); page.locator('.menu-toggle').click(); menu_closed=page.locator('#site-menu').is_hidden(); states={}
                        for filter_id in ('all','home','stationery','bags','missing','clear'):
                            page.locator(f'[data-filter={filter_id}]').click(); states[filter_id]={'visible_ids':page.locator('#filter-grid .product-card').evaluate_all('(els)=>els.map(e=>e.dataset.productId)'), 'selected':page.locator(f'[data-filter={filter_id}]').get_attribute('class')}
                        viewport_observations['filters']={'menu_open':menu_open,'menu_closed':menu_closed,'states':states}; observations[viewport_id]=viewport_observations
                        expected_filters={};
                        for state in json.loads((FIXTURE / 'STATE_MATRIX.json').read_text(encoding='utf-8'))['pages'][2]['states']:
                            if state['state_id'].startswith('filter-'): expected_filters[state['state_id'][7:]]=state['expected_ids']
                        if any(states[k]['visible_ids'] != v for k,v in expected_filters.items()): raise AssertionError(f'filter state observation mismatch: {states}'); page.close()
                        summaries_expected= {'columns':spec['expected_columns']}
                        if columns != summaries_expected['columns'] or not all(images) or not font['loaded'] or not font['check'] or not resource_loaded or not menu_open or not menu_closed or blocked:
                            raise AssertionError(f'fixture observation failed for {viewport_id}: {viewport_observations['grid']}, {viewport_observations['lazy']}, blocked={blocked}')
                    original=json.loads((run/'products.json').read_text(encoding='utf-8')); changed=json.loads(json.dumps(original)); changed['products'][0]['name']='Changed Runtime Product'; (run/'products.json').write_text(json.dumps(changed),encoding='utf-8'); page=context.new_page(); page.goto(base+'/grid.html'); page.wait_for_selector('[data-product-id="owned-001"] h2'); changed_seen=page.locator('[data-product-id="owned-001"] h2').inner_text() == 'Changed Runtime Product'; reset(run, emit=False); page.reload(); page.wait_for_selector('[data-product-id="owned-001"] h2'); reset_seen=page.locator('[data-product-id="owned-001"] h2').inner_text() == original['products'][0]['name']; page.close(); context.close(); browser.close();
                    if not changed_seen or not reset_seen: raise AssertionError('runtime mutation/reset was not observed by the running service')
                    normalized=json.dumps(observations, sort_keys=True, separators=(',', ':')); summaries.append({'run_id': f'run-{run_number}', 'observations': observations, 'semantic_sha256': hashlib.sha256(normalized.encode()).hexdigest(), 'runtime_changed_seen': changed_seen, 'runtime_reset_seen': reset_seen})
                finally:
                    server.shutdown(); server.server_close(); thread.join(timeout=2)
    comparison={'equal': summaries[0]['observations'] == summaries[1]['observations'], 'differing_fields': []}
    if not comparison['equal']:
        comparison['differing_fields']=['observations']
    print(json.dumps({'status':'pass','run_1':summaries[0],'run_2':summaries[1],'comparison':comparison}, ensure_ascii=False)); return 0


def main() -> int:
    parser=argparse.ArgumentParser(); sub=parser.add_subparsers(dest='cmd', required=True)
    for name in ('seed','reset','serve','health'): pass
    seed_parser=sub.add_parser('seed'); seed_parser.add_argument('--run-dir', type=Path, default=DEFAULT_RUN)
    reset_parser=sub.add_parser('reset'); reset_parser.add_argument('--run-dir', type=Path, default=DEFAULT_RUN)
    serve_parser=sub.add_parser('serve'); serve_parser.add_argument('--port', type=int, default=0); serve_parser.add_argument('--run-dir', type=Path, default=DEFAULT_RUN)
    health_parser=sub.add_parser('health'); health_parser.add_argument('--url', default='http://127.0.0.1:8765'); health_parser.add_argument('--run-dir', type=Path, default=DEFAULT_RUN)
    sub.add_parser('test'); args=parser.parse_args()
    try:
        if args.cmd == 'seed': seed(args.run_dir); return 0
        if args.cmd == 'reset': reset(args.run_dir); return 0
        if args.cmd == 'serve': serve(args.port, args.run_dir); return 0
        if args.cmd == 'health': return health(args.url, args.run_dir)
        return browser_test()
    except (RuntimeError, OSError, json.JSONDecodeError, AssertionError) as exc:
        print(f'fixture check failed: {exc}', file=sys.stderr); return 1

if __name__ == '__main__': raise SystemExit(main())
