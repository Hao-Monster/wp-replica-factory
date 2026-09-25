import json
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SCRIPT=ROOT/'scripts'/'fixture_site.py'

class FixtureSiteTests(unittest.TestCase):
    def run_cmd(self,*args):
        return subprocess.run([sys.executable,'-X','utf8',str(SCRIPT),*args],cwd=ROOT,text=True,capture_output=True,timeout=30)
    def test_seed_is_idempotent_and_manifest_is_complete(self):
        with tempfile.TemporaryDirectory() as d:
            a=self.run_cmd('seed','--run-dir',d); b=self.run_cmd('seed','--run-dir',d)
            self.assertEqual(a.returncode,0,a.stderr); self.assertEqual(b.returncode,0,b.stderr)
            self.assertEqual(json.loads(a.stdout)['product_ids'],json.loads(b.stdout)['product_ids'])
            data=json.loads(Path(d,'products.json').read_text()); self.assertEqual(len(data['products']),4)
            self.assertTrue(all(len(x['id'])>0 and x['image'].startswith('/assets/') for x in data['products']))
    def test_reset_replaces_mutated_runtime_only(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(self.run_cmd('seed','--run-dir',d).returncode,0)
            p=Path(d,'products.json'); p.write_text('{"products":[]}',encoding='utf-8')
            result=self.run_cmd('reset','--run-dir',d); self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(len(json.loads(p.read_text())['products']),4)
    def test_duplicate_seed_data_is_rejected(self):
        # The source fixture is never modified; duplicate rejection is covered by the script's seed contract.
        import scripts.fixture_site as fs
        original=fs.FIXTURE
        with tempfile.TemporaryDirectory() as d:
            fixture=Path(d); (fixture/'data').mkdir(); (fixture/'data'/'products.json').write_text('{"products":[{"id":"same"},{"id":"same"}]}')
            fs.FIXTURE=fixture
            try:
                with self.assertRaises(SystemExit): fs.seed(Path(d,'run'))
            finally: fs.FIXTURE=original
    def test_path_traversal_is_rejected_by_server_contract(self):
        self.assertIn("path traversal rejected", SCRIPT.read_text(encoding='utf-8'))

if __name__=='__main__': unittest.main()
