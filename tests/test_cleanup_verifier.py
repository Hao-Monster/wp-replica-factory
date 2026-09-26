import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("cleanup_verifier", ROOT / "scripts/verify_fixture_cleanup.py")
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)


def evidence():
    return {
        "fixture_product_ids": [11], "fixture_order_ids": [21],
        "sentinel_product": {"id": 12, "sku": "sentinel", "price": "99", "status": "publish"},
        "sentinel_order": {"id": 22, "status": "pending", "total": "99.00", "items": [{"product_id": 12, "quantity": 1}]},
    }


def snapshot():
    return {
        "woocommerce_version": "10.0.4", "order_storage_backend": "legacy",
        "marked_product_ids": [], "marked_order_ids": [],
        "known_fixture_products": {"11": False}, "known_fixture_orders": {"21": False},
        "sentinel_product": evidence()["sentinel_product"], "sentinel_order": evidence()["sentinel_order"],
    }


class CleanupVerifierTests(unittest.TestCase):
    def test_clean_state_with_only_unmarked_sentinel_passes(self):
        self.assertEqual(verifier.build_report(evidence(), snapshot())["status"], "pass")

    def test_only_exact_marker_candidates_are_counted(self):
        candidates = [
            {"id": 1, "marker": "replica-fixture"},
            {"id": 2, "marker": "replica-fixture-extra"},
            {"id": 3, "marker": ""},
            {"id": 4, "marker": "another-project"},
        ]
        self.assertEqual(verifier.exact_marker_ids(candidates), [1])

    def test_remaining_exact_fixture_order_fails(self):
        value = snapshot(); value["marked_order_ids"] = [21]; value["known_fixture_orders"]["21"] = True
        report = verifier.build_report(evidence(), value)
        self.assertEqual(report["status"], "fail"); self.assertIn("fixture orders remain", report["failure_reasons"][0])

    def test_known_order_with_removed_marker_still_fails(self):
        value = snapshot(); value["known_fixture_orders"]["21"] = True
        self.assertIn("created fixture order IDs still exist", " ".join(verifier.build_report(evidence(), value)["failure_reasons"]))

    def test_missing_or_changed_sentinel_fails(self):
        missing = snapshot(); missing["sentinel_order"] = None
        changed = snapshot(); changed["sentinel_product"] = {**changed["sentinel_product"], "price": "1"}
        self.assertEqual(verifier.build_report(evidence(), missing)["status"], "fail")
        self.assertEqual(verifier.build_report(evidence(), changed)["status"], "fail")

    def test_invalid_evidence_is_not_an_empty_success(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.json"; path.write_text("{")
            with self.assertRaisesRegex(ValueError, "invalid evidence"):
                verifier._read_json(path, "test")
