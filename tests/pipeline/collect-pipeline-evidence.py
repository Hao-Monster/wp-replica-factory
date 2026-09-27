#!/usr/bin/env python3
"""
Collect sanitized pipeline CI evidence.

Copies only:
- reference-index.json (page/state/viewport map – no raw HTML)
- _pipeline_checkpoint.json (status, stats, error list – no file paths to raw)
- reports/download.json per capture (status, counts – no raw bytes)

Does NOT copy:
- Raw HTML responses
- Screenshots (may contain PII)
- Fonts or binary assets
- HAR files
- Any file matching credentials patterns
"""
import os
import json
import shutil
import hashlib
import re

SRC = os.path.join(os.path.dirname(__file__), '../../.replica/pipeline-test-work')
DST = os.path.join(os.path.dirname(__file__), '../../.replica/pipeline-ci-evidence')
ALLOWLIST = {
    'reference-index.json',
    '_pipeline_checkpoint.json',
    'download.json',  # in reports/
}
DENY_PATTERNS = [
    re.compile(r'\.har$', re.I),
    re.compile(r'\.png$', re.I),
    re.compile(r'\.ttf$', re.I),
    re.compile(r'\.woff', re.I),
    re.compile(r'rendered\.html$', re.I),
    re.compile(r'signals\.json$', re.I),
]

os.makedirs(DST, exist_ok=True)

collected = []
skipped = []

if not os.path.isdir(SRC):
    print(f'No pipeline-test-work found at {SRC} – nothing to collect')
    with open(os.path.join(DST, 'no-evidence.json'), 'w') as f:
        json.dump({'reason': 'pipeline-test-work directory not found'}, f)
    exit(0)

for root, dirs, files in os.walk(SRC):
    # Skip node_modules and queue storage
    dirs[:] = [d for d in dirs if d not in ('node_modules', 'request_queues', 'key_value_stores', 'datasets')]
    for fname in files:
        if fname not in ALLOWLIST:
            continue
        fpath = os.path.join(root, fname)
        if any(p.search(fpath) for p in DENY_PATTERNS):
            skipped.append(fpath)
            continue
        # Relative path for destination
        rel = os.path.relpath(fpath, SRC)
        dst_path = os.path.join(DST, rel)
        os.makedirs(os.path.dirname(dst_path), exist_ok=True)
        # Sanitize: strip raw_path and local_path values from download.json
        if fname == 'download.json':
            try:
                with open(fpath, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                # Remove large or sensitive fields
                for key in ('raw_path', 'local_path', 'har'):
                    data.pop(key, None)
                with open(dst_path, 'w', encoding='utf-8') as f:
                    json.dump(data, f, indent=2)
                collected.append(rel)
                continue
            except Exception as e:
                print(f'Warning: could not sanitize {fpath}: {e}')
        shutil.copy2(fpath, dst_path)
        collected.append(rel)

summary = {
    'collected': len(collected),
    'skipped': len(skipped),
    'files': collected,
}
with open(os.path.join(DST, 'evidence-summary.json'), 'w') as f:
    json.dump(summary, f, indent=2)

print(f'Collected {len(collected)} files, skipped {len(skipped)}')
print(json.dumps(summary, indent=2))
