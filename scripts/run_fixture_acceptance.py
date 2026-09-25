#!/usr/bin/env python3
"""Run fixture acceptance while preserving structured failure evidence."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


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
        result['status'] = 'passed'
        try:
            payload = json.loads(test.stdout)
            result['run_id'] = [payload.get('run_1', {}).get('run_id'), payload.get('run_2', {}).get('run_id')]
        except json.JSONDecodeError:
            result['status'] = 'started_failed'
            result['error'] = 'acceptance output was not valid JSON'
            return 1
        return 0
    finally:
        result_path.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == '__main__':
    raise SystemExit(main())
