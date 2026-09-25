#!/usr/bin/env python3
"""Local-only owned fixture site lifecycle and browser acceptance runner."""
from __future__ import annotations
import argparse, hashlib, json, os, shutil, sys, tempfile, threading, time
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
    current = Path(path.anchor) if path.anchor else Path('.')
    parts = path.parts[1:] if path.anchor else path.parts
    for part in parts:
        current /= part
        if os.path.lexists(current) and (current.is_symlink() or getattr(os.path, 'isjunction', lambda _: False)(current)):
            raise RuntimeError(f'refusing symlink/junction path component: {current}')


def managed_run_path(value: Path, *, allow_create: bool = False) -> Path:
    raw = value.expanduser()
    candidate = Path(os.path.abspath(os.path.normpath(str(raw if raw.is_absolute() else ROOT / raw))))
    _no_symlink_components(candidate)
    real_candidate = candidate.resolve(strict=False)
    if real_candidate == ROOT or real_candidate == ROOT / '.git' or real_candidate == Path(real_candidate.anchor):
        raise RuntimeError('run directory is outside the dedicated fixture runtime boundary')
    default_root = (ROOT / '.replica').resolve()
    if real_candidate == default_root / 'owned-site':
        allowed = True
    else:
        sandbox = next((p for p in [candidate, *candidate.parents] if (p / SANDBOX_MARKER).is_file()), None)
        allowed = sandbox is not None and ROOT not in real_candidate.parents
    if not allowed:
        raise RuntimeError('run directory must be under .replica/owned-site or a marked external fixture sandbox')
    if os.path.lexists(candidate) and not candidate.is_dir():
        raise RuntimeError('run directory must be a directory')
    if os.path.lexists(candidate) and not (candidate / RUN_MARKER).is_file():
        raise RuntimeError('run directory is not owned by this fixture lifecycle')
    if not allow_create and not (candidate / RUN_MARKER).is_file():
        raise RuntimeError('run directory is not owned by this fixture lifecycle')
    return real_candidate


def managed_file_target(run: Path, name: str) -> Path:
    target = run / name
    if os.path.lexists(target) and (target.is_symlink() or getattr(os.path, 'isjunction', lambda _: False)(target) or not target.is_file()):
        raise RuntimeError(f'refusing to replace non-regular managed file: {target}')
    _no_symlink_components(target)
    return target


def seed(run_value: Path, emit: bool = True) -> None:
    verify_fixture()
    run = managed_run_path(run_value, allow_create=True)
    run.mkdir(parents=True, exist_ok=True)
    marker = run / RUN_MARKER
    if os.path.lexists(marker) and (marker.is_symlink() or not marker.is_file()):
        raise RuntimeError(f'refusing to replace non-regular ownership marker: {marker}')
    if marker.exists() and marker.read_text(encoding='utf-8') != 'owned-fixture-run-v1\n':
        raise RuntimeError('run ownership marker is invalid')
    products_target = managed_file_target(run, 'products.json')
    manifest_target = managed_file_target(run, 'resource-manifest.json')
    marker.write_text('owned-fixture-run-v1\n', encoding='utf-8')
    data = json.loads((FIXTURE / 'data/products.json').read_text(encoding='utf-8'))
    ids = validate_products(data)
    products_target.write_text(json.dumps(data, sort_keys=True, indent=2) + '\n', encoding='utf-8')
    manifest_target.write_text(json.dumps(json.loads((FIXTURE / 'RESOURCE_MANIFEST.json').read_text(encoding='utf-8')), sort_keys=True, indent=2) + '\n', encoding='utf-8')
    if emit:
        print(json.dumps({'status': 'seeded', 'run_dir': str(run), 'product_ids': ids, 'fixture': verify_fixture()}, ensure_ascii=False))


def reset(run_value: Path, emit: bool = True) -> None:
    run = managed_run_path(run_value)
    for name in ('products.json', 'resource-manifest.json'):
        managed_file_target(run, name)
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
    import urllib.error, urllib.request
    run = managed_run_path(run_value)
    parsed_url = urlparse(url)
    if parsed_url.scheme != 'http' or parsed_url.hostname != '127.0.0.1' or parsed_url.port is None or parsed_url.username or parsed_url.password or parsed_url.query or parsed_url.fragment:
        print('health failed: target must be an explicit local HTTP origin without credentials or redirects', file=sys.stderr); return 1
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPRedirectHandler)
    class RejectRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            raise urllib.error.HTTPError(req.full_url, code, 'redirect rejected', headers, fp)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), RejectRedirect())
    fixture = verify_fixture()
    expected = json.loads((FIXTURE / 'RESOURCE_MANIFEST.json').read_text(encoding='utf-8'))
    runtime = json.loads((run / 'resource-manifest.json').read_text(encoding='utf-8'))
    validate_products(json.loads((run / 'products.json').read_text(encoding='utf-8')))
    if runtime != expected:
        print('health failed: runtime manifest differs from versioned fixture manifest', file=sys.stderr); return 1
    checks = []
    for path in ['/grid.html', '/lazy.html', '/filters.html', '/data/products.json', '/assets/FixtureSans-Regular.ttf']:
        try:
            target = url.rstrip('/') + path
            target_parsed = urlparse(target)
            if (target_parsed.scheme, target_parsed.hostname, target_parsed.port) != (parsed_url.scheme, parsed_url.hostname, parsed_url.port):
                raise RuntimeError('health target escaped the approved origin')
            with opener.open(target, timeout=5) as response:
                checks.append({'path': path, 'status': response.status})
        except Exception as exc:
            print(f'health failed: {path}: {exc}', file=sys.stderr); return 1
    print(json.dumps({'status': 'pass', 'fixture_integrity': fixture, 'runtime_data_sha256': sha(run / 'products.json'), 'http_checks': checks}, ensure_ascii=False)); return 0


def browser_negative_lazy_cases(playwright) -> None:
    """Run controlled browser failures against a local-only test server."""
    from http.server import BaseHTTPRequestHandler
    for mode in ('404', 'abort', 'corrupt', 'eager'):
        class CaseHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == '/lazy.html':
                    eager = "#lazy-panel{background-image:url('/assets/fern-pattern.svg')}" if mode == 'eager' else ''
                    script = "const p=document.querySelector('#lazy-panel');new IntersectionObserver(()=>{p.style.backgroundImage=\"url('/assets/fern-pattern.svg')\"}).observe(p)" if mode != 'eager' else ''
                    body=f'<style>{eager}#lazy-panel{{height:1200px;margin-top:1000px}}</style><div id="lazy-panel"></div><script>{script}</script>'.encode()
                    self.send_response(200); self.send_header('Content-Type','text/html'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body); return
                if self.path == '/assets/fern-pattern.svg':
                    if mode == 'abort': self.close_connection = True; self.connection.close(); return
                    body = b'not-an-image' if mode == 'corrupt' else (b'' if mode == '404' else b'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>')
                    self.send_response(404 if mode == '404' else 200); self.send_header('Content-Type','image/svg+xml'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body); return
                self.send_error(404)
            def log_message(self,*args): pass
        server=ThreadingHTTPServer(('127.0.0.1',0), CaseHandler); thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        browser=playwright.chromium.launch(headless=True); page=browser.new_page(viewport={'width': 390, 'height': 844});
        try:
            report = observe_lazy_contract(page, f'http://127.0.0.1:{server.server_port}/lazy.html')
            contract_ok=report['background_rendered']
            if contract_ok: raise AssertionError(f'negative lazy case unexpectedly passed: {mode}')
        finally:
            page.close(); browser.close(); server.shutdown(); server.server_close(); thread.join(timeout=2)


def observe_lazy_contract(page, url: str) -> dict:
    """Observe one lazy background using the same contract for positive/negative cases."""
    responses=[]
    page.on('response', lambda response: responses.append(response) if 'fern-pattern.svg' in response.url else None)
    page.goto(url)
    panel=page.locator('#lazy-panel')
    before_requests=len(responses)
    before_state=panel.get_attribute('data-loaded')
    panel.scroll_into_view_if_needed()
    try:
        page.wait_for_function("document.querySelector('#lazy-panel').dataset.loaded === 'true'", timeout=5000)
    except Exception:
        pass
    deadline=time.monotonic()+5; response=None
    while time.monotonic() < deadline and not response:
        response=next((r for r in responses if r.request.resource_type == 'image'), None)
        if not response: page.wait_for_timeout(50)
    after_requests=[r for r in responses if r.request.resource_type == 'image']
    response_ok=bool(response) and response.status == 200
    body=response.body() if response_ok else b''
    content_valid=response_ok and b'<svg' in body[:512]
    decoded=False
    if response_ok:
        try:
            decoded=bool(page.locator('#lazy-panel').evaluate("async el => { const raw = getComputedStyle(el).backgroundImage; const image = new Image(); image.src = raw.slice(raw.indexOf('(') + 1, -1).replaceAll('\\\"', '').replaceAll(\"'\", ''); await new Promise((resolve,reject)=>{image.onload=resolve; image.onerror=reject}); return image.naturalWidth > 0 && image.naturalHeight > 0 }"))
        except Exception:
            decoded=False
    background_image=page.locator('#lazy-panel').evaluate("el=>getComputedStyle(el).backgroundImage")
    applied='fern-pattern.svg' in background_image
    return {'before_state':before_state,'after_state':panel.get_attribute('data-loaded'),'background_requests_before':before_requests,'background_requests_after':len(after_requests),'background_response_ok':response_ok,'background_content_valid':content_valid,'background_decoded':decoded,'background_applied':applied,'background_rendered':before_requests == 0 and bool(after_requests) and response_ok and content_valid and decoded and applied}


def browser_result(summaries: list[dict]) -> tuple[dict, int]:
    comparison={'equal': summaries[0]['semantic_sha256'] == summaries[1]['semantic_sha256'], 'differing_fields': []}
    if not comparison['equal']:
        comparison['differing_fields']=['observations']
    result={'status':'pass' if comparison['equal'] else 'fail','run_1':summaries[0],'run_2':summaries[1],'comparison':comparison}
    return result, 0 if comparison['equal'] else 1


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
                        lazy_page=context.new_page(); lazy_page.set_viewport_size({'width': spec['width'], 'height': spec['height']}); lazy_report=observe_lazy_contract(lazy_page, base + '/lazy.html'); actual_viewport=lazy_page.evaluate('({width: innerWidth, height: innerHeight})'); lazy_report['viewport']=actual_viewport; lazy_report['background_requests_before']=lazy_report['background_requests_before']; lazy_report['svg_count']=lazy_page.locator('.svg-mark').count(); viewport_observations['lazy']=lazy_report; lazy_page.close()
                        if actual_viewport != {'width': spec['width'], 'height': spec['height']} or not lazy_report['background_rendered']:
                            raise AssertionError(f'lazy background contract failed for {viewport_id}: {lazy_report}')
                        page.goto(base + '/filters.html'); page.locator('.menu-toggle').click(); menu_open=page.locator('#site-menu').is_visible(); page.locator('.menu-toggle').click(); menu_closed=page.locator('#site-menu').is_hidden(); states={}
                        for filter_id in ('all','home','stationery','bags','missing','clear'):
                            page.locator(f'[data-filter={filter_id}]').click(); states[filter_id]={'visible_ids':page.locator('#filter-grid .product-card').evaluate_all('(els)=>els.map(e=>e.dataset.productId)'), 'selected':page.locator(f'[data-filter={filter_id}]').get_attribute('class')}
                        viewport_observations['filters']={'menu_open':menu_open,'menu_closed':menu_closed,'states':states}; observations[viewport_id]=viewport_observations
                        expected_filters={};
                        for state in json.loads((FIXTURE / 'STATE_MATRIX.json').read_text(encoding='utf-8'))['pages'][2]['states']:
                            if state['state_id'].startswith('filter-'): expected_filters[state['state_id'][7:]]=state['expected_ids']
                        if any(states[k]['visible_ids'] != v for k,v in expected_filters.items()): raise AssertionError(f'filter state observation mismatch: {states}'); page.close()
                        summaries_expected= {'columns':spec['expected_columns']}
                        if columns != summaries_expected['columns'] or not all(images) or not font['loaded'] or not font['check'] or not viewport_observations['lazy']['background_rendered'] or not menu_open or not menu_closed or blocked:
                            raise AssertionError(f'fixture observation failed for {viewport_id}: {viewport_observations['grid']}, {viewport_observations['lazy']}, blocked={blocked}')
                    original=json.loads((run/'products.json').read_text(encoding='utf-8')); changed=json.loads(json.dumps(original)); changed['products'][0]['name']='Changed Runtime Product'; (run/'products.json').write_text(json.dumps(changed),encoding='utf-8'); page=context.new_page(); page.goto(base+'/grid.html'); page.wait_for_selector('[data-product-id="owned-001"] h2'); changed_seen=page.locator('[data-product-id="owned-001"] h2').inner_text() == 'Changed Runtime Product'; reset(run, emit=False); page.reload(); page.wait_for_selector('[data-product-id="owned-001"] h2'); reset_seen=page.locator('[data-product-id="owned-001"] h2').inner_text() == original['products'][0]['name']; page.close(); context.close(); browser.close();
                    if not changed_seen or not reset_seen: raise AssertionError('runtime mutation/reset was not observed by the running service')
                    def semantic(value):
                        if isinstance(value, dict):
                            return {k: semantic(v) for k, v in value.items() if not k.startswith('background_requests_')}
                        if isinstance(value, list):
                            return [semantic(v) for v in value]
                        return value
                    semantic_observations = semantic(observations)
                    normalized=json.dumps(semantic_observations, sort_keys=True, separators=(',', ':')); summaries.append({'run_id': f'run-{run_number}', 'observations': observations, 'semantic_sha256': hashlib.sha256(normalized.encode()).hexdigest(), 'runtime_changed_seen': changed_seen, 'runtime_reset_seen': reset_seen})
                finally:
                    server.shutdown(); server.server_close(); thread.join(timeout=2)
            browser_negative_lazy_cases(playwright)
    result, exit_code = browser_result(summaries)
    print(json.dumps(result, ensure_ascii=False)); return exit_code


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
