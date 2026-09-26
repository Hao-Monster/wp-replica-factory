"""Serve the framework-owned fixture from the current checkout with isolated runtime data."""
from pathlib import Path
import argparse, importlib.util, json, sys, tempfile, threading

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=0)
args = parser.parse_args()
script = ROOT/'scripts/fixture_site.py'
if not script.is_file() or not (ROOT/'tests/fixtures/owned-site/STATE_MATRIX.json').is_file():
    raise SystemExit('owned fixture is missing from current checkout')
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('framework_owned_fixture', script)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
integrity = fixture.verify_fixture()
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
    print(json.dumps({'origin':f'http://127.0.0.1:{server.server_port}','source':str(ROOT),'fixture':integrity}),flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
