import http.client
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SCRIPT=ROOT/'scripts'/'fixture_site.py'
import scripts.fixture_site as fs

class FixtureSiteTests(unittest.TestCase):
    def sandbox(self):
        temp=tempfile.TemporaryDirectory(prefix='fixture-sandbox-'); root=Path(temp.name); (root/fs.SANDBOX_MARKER).write_text('owned-test-sandbox\n',encoding='utf-8'); return temp,root
    def run_cmd(self,*args):
        return __import__('subprocess').run([sys.executable,'-X','utf8',str(SCRIPT),*args],cwd=ROOT,text=True,capture_output=True,timeout=30)
    def test_seed_is_idempotent_and_manifest_is_complete(self):
        temp,root=self.sandbox()
        try:
            run=root/'owned-site'; a=self.run_cmd('seed','--run-dir',str(run)); b=self.run_cmd('seed','--run-dir',str(run))
            self.assertEqual(a.returncode,0,a.stderr); self.assertEqual(b.returncode,0,b.stderr)
            self.assertEqual(json.loads(a.stdout)['product_ids'],json.loads(b.stdout)['product_ids'])
            self.assertEqual(json.loads((run/'resource-manifest.json').read_text())['fixture_version'],'1.0.0')
        finally: temp.cleanup()
    def test_reset_rejects_unowned_directory_and_preserves_sentinel(self):
        temp,root=self.sandbox()
        try:
            user=root/'user-data'; user.mkdir(); sentinel=user/'sentinel.txt'; sentinel.write_text('keep')
            result=self.run_cmd('reset','--run-dir',str(user)); self.assertNotEqual(result.returncode,0); self.assertTrue(sentinel.exists()); self.assertEqual(sentinel.read_text(),'keep')
        finally: temp.cleanup()

    def test_browser_result_propagates_semantic_mismatch_to_exit_code(self):
        one={'run_id':'run-1','semantic_sha256':'a'*64}; two={'run_id':'run-2','semantic_sha256':'b'*64}
        result, exit_code=fs.browser_result([one,two]); self.assertEqual(exit_code,1); self.assertEqual(result['status'],'fail'); self.assertFalse(result['comparison']['equal'])

    def test_seed_rejects_existing_and_dangling_managed_links(self):
        temp,root=self.sandbox()
        try:
            run=root/'owned-site'; self.assertEqual(self.run_cmd('seed','--run-dir',str(run)).returncode,0)
            outside=root/'outside.txt'; outside.write_text('keep'); managed=run/'products.json'; managed.unlink()
            try: os.symlink(outside, managed)
            except (OSError, NotImplementedError) as exc: self.skipTest(f'symlink unavailable: {exc}')
            result=self.run_cmd('seed','--run-dir',str(run)); self.assertNotEqual(result.returncode,0); self.assertEqual(outside.read_text(),'keep'); managed.unlink()
            os.symlink(root/'missing.txt', managed); result=self.run_cmd('reset','--run-dir',str(run)); self.assertNotEqual(result.returncode,0); self.assertFalse((root/'missing.txt').exists())
        finally: temp.cleanup()

    def test_seed_rejects_linked_path_and_unowned_existing_directory(self):
        temp,root=self.sandbox()
        try:
            user=root/'unowned'; user.mkdir(); self.assertNotEqual(self.run_cmd('seed','--run-dir',str(user)).returncode,0)
            linked=root/'linked'; target=root/'target'; target.mkdir()
            try: os.symlink(target, linked, target_is_directory=True)
            except (OSError, NotImplementedError) as exc: self.skipTest(f'directory symlink unavailable: {exc}')
            self.assertNotEqual(self.run_cmd('seed','--run-dir',str(linked/'owned-site')).returncode,0)
        finally: temp.cleanup()
    def test_reset_replaces_managed_files_without_recursive_delete(self):
        temp,root=self.sandbox()
        try:
            run=root/'owned-site'; self.assertEqual(self.run_cmd('seed','--run-dir',str(run)).returncode,0); sentinel=run/'unmanaged-sentinel.txt'; sentinel.write_text('keep'); products=run/'products.json'; products.write_text('{"products":[]}',encoding='utf-8')
            result=self.run_cmd('reset','--run-dir',str(run)); self.assertEqual(result.returncode,0,result.stderr); self.assertTrue(sentinel.exists()); self.assertEqual(len(json.loads(products.read_text())['products']),4)
        finally: temp.cleanup()
    def test_source_manifest_tamper_is_rejected_without_update(self):
        temp,root=self.sandbox(); copied=root/'owned-site'; shutil.copytree(fs.FIXTURE,copied)
        original=fs.FIXTURE; fs.FIXTURE=copied
        try:
            (copied/'assets'/'aurora-mug.svg').write_text('tampered',encoding='utf-8')
            with self.assertRaises(RuntimeError): fs.seed(copied/'run')
        finally: fs.FIXTURE=original; temp.cleanup()
    def test_runtime_server_reads_run_copy_and_reset_restores_it(self):
        temp,root=self.sandbox(); run=root/'owned-site'
        try:
            fs.seed(run); server=fs.make_server(run); thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
            try:
                def get():
                    c=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3); c.request('GET','/data/products.json'); r=c.getresponse(); data=json.loads(r.read()); c.close(); return data
                original=get(); changed=json.loads(json.dumps(original)); changed['products'][0]['name']='runtime change'; (run/'products.json').write_text(json.dumps(changed),encoding='utf-8'); self.assertEqual(get()['products'][0]['name'],'runtime change'); fs.reset(run); self.assertEqual(get()['products'][0]['name'],original['products'][0]['name'])
            finally: server.shutdown(); server.server_close(); thread.join(timeout=2)
        finally: temp.cleanup()
    def test_server_rejects_traversal_and_keeps_legal_resource(self):
        temp,root=self.sandbox(); run=root/'owned-site'
        try:
            fs.seed(run); (root/'sentinel.txt').write_text('secret sentinel'); server=fs.make_server(run); thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
            try:
                def request(path):
                    c=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=3); c.request('GET',path); r=c.getresponse(); body=r.read(); c.close(); return r.status,body
                self.assertEqual(request('/grid.html')[0],200)
                self.assertIn(request('/%2e%2e/sentinel.txt')[0],(400,404))
                self.assertIn(request('/%252e%252e/sentinel.txt')[0],(400,404))
                self.assertIn(request('/.git/config')[0],(400,404))
            finally: server.shutdown(); server.server_close(); thread.join(timeout=2)
        finally: temp.cleanup()

    def test_health_validates_origin_and_rejects_redirect_before_following(self):
        temp,root=self.sandbox(); run=root/'owned-site'; fs.seed(run)
        class TargetHandler(http.server.BaseHTTPRequestHandler):
            hits=0; redirect_port=0
            def do_GET(self):
                type(self).hits += 1
                if self.path == '/grid.html' and type(self).redirect_port:
                    self.send_response(302); self.send_header('Location',f'http://127.0.0.1:{type(self).redirect_port}/grid.html'); self.end_headers(); return
                self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
            def log_message(self,*args): pass
        server=ThreadingHTTPServer(('127.0.0.1',0),TargetHandler); thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        class SinkHandler(TargetHandler): hits=0; redirect_port=0
        sink=ThreadingHTTPServer(('127.0.0.1',0),SinkHandler); sink_thread=threading.Thread(target=sink.serve_forever,daemon=True); sink_thread.start()
        try:
            self.assertEqual(fs.health(f'https://127.0.0.1:{server.server_port}',run),1)
            self.assertEqual(fs.health(f'http://user:pass@127.0.0.1:{server.server_port}',run),1)
            self.assertEqual(fs.health(f'http://127.0.0.1:{server.server_port}',run),0)
            TargetHandler.redirect_port=sink.server_port
            self.assertEqual(fs.health(f'http://127.0.0.1:{server.server_port}',run),1); self.assertEqual(SinkHandler.hits,0)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2); sink.shutdown(); sink.server_close(); sink_thread.join(timeout=2); temp.cleanup()
    def test_missing_required_state_is_rejected(self):
        temp,root=self.sandbox(); copied=root/'owned-site'; shutil.copytree(fs.FIXTURE,copied); original=fs.FIXTURE; fs.FIXTURE=copied
        try:
            matrix=json.loads((copied/'STATE_MATRIX.json').read_text()); matrix['pages']=matrix['pages'][:2]; (copied/'STATE_MATRIX.json').write_text(json.dumps(matrix),encoding='utf-8')
            with self.assertRaises(RuntimeError): fs.seed(copied/'run')
        finally: fs.FIXTURE=original; temp.cleanup()
    def test_duplicate_seed_data_is_rejected(self):
        temp,root=self.sandbox(); copied=root/'owned-site'; shutil.copytree(fs.FIXTURE,copied); original=fs.FIXTURE; fs.FIXTURE=copied
        try:
            data=json.loads((copied/'data/products.json').read_text()); data['products'].append(dict(data['products'][0])); (copied/'data/products.json').write_text(json.dumps(data),encoding='utf-8')
            with self.assertRaises(RuntimeError): fs.seed(copied/'run')
        finally: fs.FIXTURE=original; temp.cleanup()

if __name__=='__main__': unittest.main()
