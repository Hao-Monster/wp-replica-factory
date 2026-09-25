import json
import os
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess, TimeoutExpired
from unittest.mock import patch

import scripts.run_fixture_acceptance as runner


def valid_report():
    run = {'run_id': 'run-1', 'observations': {'desktop': {}}, 'semantic_sha256': 'a' * 64, 'runtime_changed_seen': True, 'runtime_reset_seen': True}
    other = dict(run, run_id='run-2')
    return {'status': 'pass', 'run_1': run, 'run_2': other, 'comparison': {'equal': True, 'differing_fields': []}}


class AcceptanceReportTests(unittest.TestCase):
    def test_complete_success_report_is_accepted(self):
        self.assertEqual(runner.validate_report(valid_report()), (True, ''))

    def test_invalid_status_is_rejected(self):
        report = valid_report(); report['status'] = 'fail'; self.assertFalse(runner.validate_report(report)[0])

    def test_false_comparison_is_rejected(self):
        report = valid_report(); report['comparison'] = {'equal': False, 'differing_fields': ['observations']}; self.assertFalse(runner.validate_report(report)[0])

    def test_missing_runs_and_required_fields_are_rejected(self):
        for report in ({}, {'status': 'pass'}, {'status': 'pass', 'run_1': {}, 'run_2': {}}):
            self.assertFalse(runner.validate_report(report)[0])

    def test_hash_difference_cannot_be_claimed_equal(self):
        report = valid_report(); report['run_2']['semantic_sha256'] = 'b' * 64; self.assertFalse(runner.validate_report(report)[0])

    def test_nonzero_subprocess_saves_failure_and_returns_nonzero(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'result.json'; env = {'FIXTURE_RESULT_PATH': str(path)}
            seed = CompletedProcess([], 0, '{}', '')
            failed = CompletedProcess([], 7, '', 'real failure')
            with patch.dict(os.environ, env, clear=False), patch('scripts.run_fixture_acceptance.subprocess.run', side_effect=[seed, failed]):
                self.assertEqual(runner.main(), 7)
            saved = json.loads(path.read_text()); self.assertEqual(saved['status'], 'started_failed'); self.assertIn('real failure', saved['error'])

    def test_timeout_and_corrupt_json_save_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'result.json'; seed = CompletedProcess([], 0, '{}', '')
            with patch.dict(os.environ, {'FIXTURE_RESULT_PATH': str(path)}, clear=False), patch('scripts.run_fixture_acceptance.subprocess.run', side_effect=[seed, TimeoutExpired([], 1)]):
                self.assertEqual(runner.main(), 124)
            self.assertEqual(json.loads(path.read_text())['status'], 'started_failed')
            with patch.dict(os.environ, {'FIXTURE_RESULT_PATH': str(path)}, clear=False), patch('scripts.run_fixture_acceptance.subprocess.run', side_effect=[seed, CompletedProcess([], 0, '{', '')]):
                self.assertEqual(runner.main(), 1)
            self.assertIn('valid JSON', json.loads(path.read_text())['error'])


if __name__ == '__main__':
    unittest.main()
