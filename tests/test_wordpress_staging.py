import json, tempfile, unittest
from pathlib import Path
import importlib.util
ROOT=Path(__file__).parents[1]
spec=importlib.util.spec_from_file_location('staging',ROOT/'adapters/wordpress-staging/adapter.py'); staging=importlib.util.module_from_spec(spec); spec.loader.exec_module(staging)

class StagingTests(unittest.TestCase):
    def test_production_and_missing_marker_are_blocked_before_wp(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'cfg.json'; p.write_text(json.dumps({'environment':'production','production':True,'site_url':'http://x','wp_path':'/x','transport':'local'}))
            with self.assertRaises(staging.Blocked): staging.load(p)
    def test_reference_bundle_requires_complete_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); (root/'manifest.json').write_text('{"status":"failed"}'); (root/'routes.json').write_text('{}'); (root/'resources.json').write_text('{}')
            with self.assertRaises(staging.AdapterError): staging.ref_bundle(root)
    def test_example_is_explicit_staging(self):
        cfg=staging.load(ROOT/'examples/wordpress-staging.example.json'); self.assertFalse(cfg['production']); self.assertEqual(cfg['environment'],'staging')
