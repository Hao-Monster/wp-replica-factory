"""Read-only pinned PR #5 fixture, with a separate disposable runtime sandbox."""
from pathlib import Path
import argparse, importlib.util, json, subprocess, sys, tempfile, threading

PIN = '66e30c9fa6fa5977f088c380e22838648399e2e1'
ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--fixture-root', type=Path, default=ROOT/'.replica/dependencies/fixture')
parser.add_argument('--port', type=int, default=0)
args = parser.parse_args()
source = args.fixture_root.resolve()
actual = subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'], text=True).strip()
if actual != PIN:
    raise SystemExit('fixture head differs from reviewed PR #5 SHA')
# PR #5 marks ** (including binary fonts) as text. Git's clean filter can report
# a dirty TTF even when its on-disk bytes exactly equal the pinned Git blob.
# Compare actual bytes of every reported change; do not edit attributes or fonts.
dirty = subprocess.check_output(['git','-C',str(source),'diff','HEAD','--name-only','-z']).decode('utf-8').split('\0')
for name in filter(None, dirty):
    expected = subprocess.check_output(['git','-C',str(source),'show',PIN+':'+name])
    if not (source/name).is_file() or (source/name).read_bytes() != expected:
        raise SystemExit('fixture tracked bytes differ from pinned commit: '+name)
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('pinned_fixture', source/'scripts/fixture_site.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
with tempfile.TemporaryDirectory(prefix='downloader-owned-fixture-') as temp:
    sandbox = Path(temp)
    (sandbox/fixture.SANDBOX_MARKER).write_text('downloader test sandbox\n',encoding='utf-8')
    run = sandbox/'runtime'
    fixture.seed(run, emit=False)
    server = fixture.make_server(run,args.port)
    def stop_on_stdin():
        sys.stdin.readline()
        server.shutdown()
    threading.Thread(target=stop_on_stdin,daemon=True).start()
    print(json.dumps({'origin':f'http://127.0.0.1:{server.server_port}','fixture_sha':actual,'source':str(source)}),flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
