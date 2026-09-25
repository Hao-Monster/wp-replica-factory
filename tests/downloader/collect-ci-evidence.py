"""Allowlisted owned-fixture reports/screenshots only; never upload raw/HAR/site."""
from pathlib import Path
import json, shutil

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT/'.replica/downloader-acceptance.json'
DEST = ROOT/'.replica/ci-evidence'
DEST.mkdir(parents=True, exist_ok=True)

def sanitize(value):
    if isinstance(value, dict):
        return {k: sanitize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    if isinstance(value, str):
        return value.replace(str(ROOT), '<workspace>').replace(ROOT.as_posix(), '<workspace>')
    return value

def save_json(name, value):
    (DEST/name).write_text(json.dumps(sanitize(value), ensure_ascii=False, indent=2)+'\n', encoding='utf-8')

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
    raise SystemExit('only owned-fixture artifacts may be uploaded')
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
save_json('artifact-allowlist.json', {'files': copied, 'excluded': ['raw', 'site', 'network', 'HAR', 'font binaries'], 'retention_days': 7})
print(json.dumps({'status': 'collected', 'files': len(copied)}))
