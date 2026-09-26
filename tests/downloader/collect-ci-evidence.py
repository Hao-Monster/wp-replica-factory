"""Allowlisted sanitized reports/screenshots only; never upload raw/HAR/site/fonts."""
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
import json, shutil

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT/'.replica/downloader-acceptance.json'
PUBLIC_REPORT = ROOT/'.replica/public-mvp-acceptance.json'
DEST = ROOT/'.replica/ci-evidence'
if DEST.exists():
    shutil.rmtree(DEST)
DEST.mkdir(parents=True, exist_ok=True)

SENSITIVE_HEADERS = {'cookie','set-cookie','authorization','proxy-authorization'}

def sanitize_url(value, sensitive_keys):
    try:
        parsed=urlsplit(value)
        if parsed.scheme not in {'http','https'}:
            return value
        pairs=[(k,'<redacted>' if k.lower() in sensitive_keys else v) for k,v in parse_qsl(parsed.query,keep_blank_values=True)]
        host=parsed.hostname or ''
        if ':' in host and not host.startswith('['):
            host=f'[{host}]'
        netloc=host+(f':{parsed.port}' if parsed.port else '')
        return urlunsplit((parsed.scheme,netloc,parsed.path,urlencode(pairs,doseq=True),parsed.fragment))
    except Exception:
        return '<invalid-url>'

def sanitize(value, sensitive_keys=frozenset()):
    if isinstance(value, dict):
        return {k: sanitize(v,sensitive_keys) for k,v in value.items() if k.lower() not in SENSITIVE_HEADERS}
    if isinstance(value, list):
        return [sanitize(v,sensitive_keys) for v in value]
    if isinstance(value, str):
        value=value.replace(str(ROOT), '<workspace>').replace(ROOT.as_posix(), '<workspace>')
        if value.startswith(('http://','https://')):
            return sanitize_url(value,sensitive_keys)
        return value
    return value

def save_json(name, value, sensitive_keys=frozenset()):
    (DEST/name).write_text(json.dumps(sanitize(value,sensitive_keys), ensure_ascii=False, indent=2)+'\n', encoding='utf-8')

if not REPORT.is_file():
    save_json('acceptance.json', {'schema': 1, 'status': 'failed', 'reason': 'acceptance report missing'})
    raise SystemExit('acceptance report missing')
report = json.loads(REPORT.read_text(encoding='utf-8'))
save_json('acceptance.json', report)
candidate = report.get('primary_download') or next((r['dir'] for r in report.get('runs', []) if r.get('name') == 'owned-1'), None)
if not candidate:
    raise SystemExit('no real owned-fixture download available for CI evidence')
run = Path(candidate).resolve(strict=True)
run.relative_to((ROOT/'.replica/downloads').resolve(strict=True))
manifest = json.loads((run/'manifest.json').read_text(encoding='utf-8'))
if manifest.get('policy', {}).get('mode') != 'owned-fixture':
    raise SystemExit('owned evidence candidate is not owned-fixture')
allowed = ['manifest.json', 'routes.json', 'resources.json', 'reports/download.json',
           'reports/references.json', 'reports/verify.json', 'reports/preview.json']
copied = []
for name in allowed:
    source = run/name
    if source.is_file() and not source.is_symlink():
        target = name.replace('/', '-')
        save_json(target, json.loads(source.read_text(encoding='utf-8')))
        copied.append(target)
for source in sorted((run/'reports').glob('preview-*.png')):
    if source.is_file() and not source.is_symlink() and source.stat().st_size < 8_000_000:
        shutil.copyfile(source, DEST/source.name)
        copied.append(source.name)

if PUBLIC_REPORT.is_file():
    public_report=json.loads(PUBLIC_REPORT.read_text(encoding='utf-8'))
    public_run=Path(public_report['run']).resolve(strict=True)
    public_run.relative_to((ROOT/'.replica/downloads').resolve(strict=True))
    public_manifest=json.loads((public_run/'manifest.json').read_text(encoding='utf-8'))
    if public_manifest.get('policy',{}).get('mode')!='authorized-public':
        raise SystemExit('public evidence candidate is not authorized-public')
    sensitive_keys={str(x).lower() for x in public_manifest.get('policy',{}).get('sensitiveQueryKeys',[])}
    save_json('public-mvp-acceptance.json',public_report,sensitive_keys)
    network=public_run/'reports/network-sanitized.json'
    if not network.is_file():
        raise SystemExit('sanitized public network report missing')
    save_json('public-network-sanitized.json',json.loads(network.read_text(encoding='utf-8')),sensitive_keys)
    copied.extend(['public-mvp-acceptance.json','public-network-sanitized.json'])

save_json('artifact-allowlist.json', {'files': copied, 'excluded': ['raw', 'site', 'network', 'HAR', 'font binaries', 'browser profiles'], 'retention_days': 7})
for file in DEST.rglob('*'):
    if file.is_file() and b'SECRET_CANARY_' in file.read_bytes():
        raise SystemExit(f'secret canary leaked into CI artifact: {file.name}')
print(json.dumps({'status': 'collected', 'files': len(copied), 'canary_occurrences': 0}))
