#!/usr/bin/env python3
"""Run fixture acceptance while preserving structured failure evidence."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def validate_report(payload: object) -> tuple[bool, str]:
    if not isinstance(payload, dict):
        return False, 'report must be an object'
    if payload.get('status') != 'pass':
        return False, 'report status is not pass'
    runs = [payload.get('run_1'), payload.get('run_2')]
    if any(not isinstance(run, dict) for run in runs):
        return False, 'run_1 and run_2 must be objects'
    for index, run in enumerate(runs, 1):
        if not isinstance(run.get('run_id'), str) or not isinstance(run.get('observations'), dict):
            return False, f'run_{index} is missing run_id or observations'
        if not isinstance(run.get('semantic_sha256'), str) or len(run['semantic_sha256']) != 64:
            return False, f'run_{index} has an invalid semantic hash'
        if run.get('runtime_changed_seen') is not True or run.get('runtime_reset_seen') is not True:
            return False, f'run_{index} runtime recovery was not observed'
    comparison = payload.get('comparison')
    if not isinstance(comparison, dict) or comparison.get('equal') is not True or not isinstance(comparison.get('differing_fields'), list) or comparison['differing_fields']:
        return False, 'comparison is not an equal, empty-difference result'
    if runs[0]['semantic_sha256'] != runs[1]['semantic_sha256']:
        return False, 'run semantic hashes differ'
    return True, ''


def main() -> int:
    result_path = Path(os.environ.get('FIXTURE_RESULT_PATH', 'fixture-test-result.json'))
    result = {'status': 'not_started', 'run_id': None, 'error': None, 'output': None}
    commands = [[sys.executable, '-X', 'utf8', 'scripts/fixture_site.py', 'seed'],
                [sys.executable, '-X', 'utf8', 'scripts/fixture_site.py', 'test']]
    try:
        seed = subprocess.run(commands[0], text=True, capture_output=True, timeout=60)
        if seed.returncode:
            result.update(status='started_failed', error=seed.stderr[-4000:], output=seed.stdout[-4000:])
            return seed.returncode
        result['status'] = 'started'
        test = subprocess.run(commands[1], text=True, capture_output=True, timeout=600)
        result['output'] = test.stdout[-12000:]
        result['error'] = test.stderr[-4000:] or None
        if test.returncode:
            result['status'] = 'started_failed'
            return test.returncode
        try:
            payload = json.loads(test.stdout)
            valid, reason = validate_report(payload)
            if not valid:
                result['status'] = 'started_failed'; result['error'] = reason; return 1
            result['status'] = 'passed'
            result['run_id'] = [payload['run_1']['run_id'], payload['run_2']['run_id']]
        except json.JSONDecodeError:
            result['status'] = 'started_failed'
            result['error'] = 'acceptance output was not valid JSON'
            return 1
        return 0
    except subprocess.TimeoutExpired as exc:
        result.update(status='started_failed', error=f'acceptance timed out: {exc}')
        return 124
    finally:
        result_path.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == '__main__':
    raise SystemExit(main())
