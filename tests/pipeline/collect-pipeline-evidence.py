#!/usr/bin/env python3
"""
Collect sanitized pipeline CI quality evidence.

Collects and validates:
- visual-report.json (exact visual evaluator output from image-diff.mjs)
- visual-summary.md (markdown comparison table)
- visual-diffs/*.png (source, rerender, and diff PNGs for evaluated cases)
- offline-network-requests.json (request logs demonstrating 0 external/upstream requests)
- test-execution-summary.json (suite timing, SHA, and runId)
- preview-manifest.json / reference-index.json (page/state/viewport mappings)
- _pipeline_checkpoint.json (sanitized checkpoint status)

Gate rule:
- If evidence is missing or empty, exits with error code 1 and logs EVIDENCE_MISSING.
"""
import os
import sys
import json
import shutil
import hashlib

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
DST = os.path.join(ROOT, '.replica', 'pipeline-ci-evidence')
DIST_PREVIEW = os.path.join(ROOT, 'dist-preview')
PIPELINE_RUN = os.path.join(DST, 'pipeline-run')
TEST_WORK = os.path.join(ROOT, '.replica', 'pipeline-test-work')

os.makedirs(DST, exist_ok=True)

# 1. Copy preview manifest if present
manifest_src = os.path.join(DIST_PREVIEW, 'preview-manifest.json')
if os.path.isfile(manifest_src):
    shutil.copy2(manifest_src, os.path.join(DST, 'preview-manifest.json'))

contract_src = os.path.join(DIST_PREVIEW, 'contract.json')
if os.path.isfile(contract_src):
    shutil.copy2(contract_src, os.path.join(DST, 'contract.json'))

# 2. Copy pipeline-run files if present
if os.path.isdir(PIPELINE_RUN):
    for fname in os.listdir(PIPELINE_RUN):
        fpath = os.path.join(PIPELINE_RUN, fname)
        if os.path.isfile(fpath) and fname in ('reference-index.json', '_pipeline_checkpoint.json'):
            shutil.copy2(fpath, os.path.join(DST, fname))

# 3. Check for required evidence files
REQUIRED_FILES = [
    'visual-report.json',
    'visual-summary.md',
    'offline-network-requests.json',
    'preview-manifest.json',
]

missing_required = []
for req in REQUIRED_FILES:
    p = os.path.join(DST, req)
    if not os.path.isfile(p) or os.path.getsize(p) == 0:
        missing_required.append(req)

# Check visual diffs directory
diff_dir = os.path.join(DST, 'visual-diffs')
diff_count = 0
if os.path.isdir(diff_dir):
    diff_count = len([f for f in os.listdir(diff_dir) if f.endswith('.png')])

if diff_count == 0:
    missing_required.append('visual-diffs/*.png')

if missing_required:
    print(f"EVIDENCE_MISSING: Missing required quality evidence files in {DST}: {missing_required}")
    with open(os.path.join(DST, 'evidence-summary.json'), 'w') as f:
        json.dump({'status': 'EVIDENCE_MISSING', 'missing': missing_required}, f, indent=2)
    sys.exit(1)

# 4. Inventory all files in DST and build summary
collected_files = []
for root, dirs, files in os.walk(DST):
    for fname in files:
        if fname == 'evidence-summary.json':
            continue
        fpath = os.path.join(root, fname)
        rel_path = os.path.relpath(fpath, DST).replace('\\', '/')
        file_size = os.path.getsize(fpath)
        
        # Calculate SHA256
        h = hashlib.sha256()
        with open(fpath, 'rb') as f:
            while chunk := f.read(65536):
                h.update(chunk)
        
        collected_files.append({
            'path': rel_path,
            'size_bytes': file_size,
            'sha256': h.hexdigest(),
        })

# Read visual report summary if present
visual_status = 'UNKNOWN'
total_compared = 0
visual_report_path = os.path.join(DST, 'visual-report.json')
if os.path.isfile(visual_report_path):
    try:
        with open(visual_report_path, 'r', encoding='utf-8') as f:
            vr = json.load(f)
            visual_status = vr.get('overall_status', 'UNKNOWN')
            total_compared = vr.get('summary', {}).get('total', 0)
    except Exception:
        pass

# Read offline network report if present
external_reqs = -1
all_local = False
net_report_path = os.path.join(DST, 'offline-network-requests.json')
if os.path.isfile(net_report_path):
    try:
        with open(net_report_path, 'r', encoding='utf-8') as f:
            nr = json.load(f)
            external_reqs = nr.get('external_requests', -1)
            all_local = nr.get('all_matched_local_origin', False)
    except Exception:
        pass

summary = {
    'status': 'QUALITY_EVIDENCE_SAVED',
    'total_files': len(collected_files),
    'visual_status': visual_status,
    'total_compared_cases': total_compared,
    'external_network_requests': external_reqs,
    'zero_upstream_requests_verified': all_local,
    'files': collected_files,
}

with open(os.path.join(DST, 'evidence-summary.json'), 'w') as f:
    json.dump(summary, f, indent=2)

print("=" * 60)
print(f"PIPELINE QUALITY EVIDENCE COLLECTED: {len(collected_files)} files")
print(f"Visual Comparisons Status: {visual_status} ({total_compared} cases)")
print(f"Zero Upstream Requests Verified: {all_local} (external requests: {external_reqs})")
print(f"Diff Artifacts: {diff_count} PNG files in visual-diffs/")
print("=" * 60)
