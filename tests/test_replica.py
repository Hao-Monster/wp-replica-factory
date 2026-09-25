import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
R=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("replica",R/"scripts/replica.py")
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def config():
    c=json.loads((R/"examples/project.example.json").read_text())
    c["authorization"]["reference_capture"]=True
    c["authorization"]["asset_reuse"]=True
    return c

def report(c):
    return {"schema_version":1,"candidate_id":"a"*64,"baseline_sha256":"b"*64,
        "policy_sha256":m.digest(c),"runner_status":"complete","pixel_mode":"raw_rgba_equal",
        "missing_assets":0,"missing_fonts":0,"skipped":0,"blocked":0,
        "visuals":[{"id":x,"status":"pass","different_pixels":0,"total_pixels":100,"same_dimensions":True} for x in sorted(m.expected_visuals(c))],
        "checks":[{"id":x,"status":"pass"} for x in c["quality"]["required_checks"]]}

class Gates(unittest.TestCase):
    def setUp(self):self.c=config();self.r=report(self.c)
    def gate(self):return m.gate(self.c,self.r,"a"*64,"b"*64,m.digest(self.c))
    def test_complete(self):self.assertEqual(self.gate()["gate"],"pass")
    def test_missing_visual(self):
        self.r["visuals"].pop()
        with self.assertRaises(m.Invalid):self.gate()
    def test_duplicate_visual(self):
        self.r["visuals"].append(self.r["visuals"][0])
        with self.assertRaises(m.Invalid):self.gate()
    def test_stale_candidate(self):
        self.r["candidate_id"]="c"*64
        with self.assertRaises(m.Invalid):self.gate()
    def test_wrong_policy(self):
        self.r["policy_sha256"]="c"*64
        with self.assertRaises(m.Invalid):self.gate()
    def test_missing_asset(self):
        self.r["missing_assets"]=1
        with self.assertRaises(m.Invalid):self.gate()
    def test_missing_font_field(self):
        del self.r["missing_fonts"]
        with self.assertRaises(m.Invalid):self.gate()
    def test_pixel_difference(self):
        self.r["visuals"][0]["different_pixels"]=1
        with self.assertRaises(m.Invalid):self.gate()
    def test_boolean_not_pixel_count(self):
        self.r["visuals"][0]["different_pixels"]=False
        with self.assertRaises(m.Invalid):self.gate()
    def test_missing_functional_check(self):
        self.r["checks"].pop()
        with self.assertRaises(m.Invalid):self.gate()
    def test_skipped_check(self):
        self.r["checks"][0]["status"]="skipped"
        with self.assertRaises(m.Invalid):self.gate()
    def test_scope_cannot_be_empty(self):
        self.c["scope"]["pages"]=[]
        with self.assertRaises(m.Invalid):m.validate(self.c)
    def test_authorization_block(self):
        self.c["authorization"]["asset_reuse"]=False
        with self.assertRaises(m.Invalid):self.gate()
    def test_nan_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"x.json";p.write_text('{"value":NaN}')
            with self.assertRaises(m.Invalid):m.read_json(p)
    def test_baseline_changed(self):
        with tempfile.TemporaryDirectory() as d:
            r=Path(d)/"reference";r.mkdir();(r/"page.txt").write_text("a")
            lock=Path(d)/"baseline.lock.json";m.seal(r,lock);m.verify(lock)
            (r/"page.txt").write_text("b")
            with self.assertRaises(m.Invalid):m.verify(lock)
    def test_baseline_added_file(self):
        with tempfile.TemporaryDirectory() as d:
            r=Path(d)/"reference";r.mkdir();(r/"a").write_text("a")
            lock=Path(d)/"lock.json";m.seal(r,lock);(r/"b").write_text("b")
            with self.assertRaises(m.Invalid):m.verify(lock)
    def test_baseline_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            r=Path(d)/"reference";r.mkdir();(r/"a").symlink_to(Path(d)/"elsewhere")
            with self.assertRaises(m.Invalid):m.tree_hashes(r)
    def test_theme_package(self):
        with tempfile.TemporaryDirectory() as d:
            t=Path(d)/"demo-theme";t.mkdir();(t/"style.css").write_text("/* Theme Name: Demo */")
            (t/"index.php").write_text("<?php // demo")
            result=m.package_theme(t,Path(d)/"out.zip")
            self.assertEqual(result["file_count"],2)
            self.assertEqual(len(result["candidate_id"]),64)
    def test_theme_reject_secret_file(self):
        with tempfile.TemporaryDirectory() as d:
            t=Path(d)/"demo-theme";t.mkdir();(t/"style.css").write_text("/* Theme Name: Demo */")
            (t/"index.php").write_text("<?php // demo");(t/".env").write_text("SECRET=x")
            with self.assertRaises(m.Invalid):m.package_theme(t,Path(d)/"out.zip")
if __name__=="__main__":unittest.main()
