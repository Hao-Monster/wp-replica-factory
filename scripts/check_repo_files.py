#!/usr/bin/env python3
"""Check tracked/staged filenames, not file contents, for sensitive project data.
Run after git add and before commit/push. Not a complete secret or history scanner.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys

FORBIDDEN_DIRS = {'.secrets', '.ssh', '.auth', '.replica', 'browser-profile', 'browser-profiles'}
RUNTIME_ROOTS = {'runs', 'reference', 'reports', 'artifacts', 'playwright-report', 'test-results'}
FORBIDDEN_NAMES = {'project.json', 'project.local.json', 'wp-config.php', 'cookies.json',
                   'storagestate.json', 'storage-state.json', 'credentials.json', 'secrets.json'}
FORBIDDEN_SUFFIXES = ('.pem', '.key', '.p12', '.pfx', '.sql', '.sql.gz', '.sqlite', '.sqlite3', '.db', '.har', '.log')

def forbidden_reason(path: str) -> str | None:
    """Return a rule name, never a file's potentially secret contents."""
    parts = PurePosixPath(path.replace('\\', '/')).parts
    if not parts:
        return None
    names = tuple(p.lower() for p in parts)
    name = names[-1]
    if any(p in FORBIDDEN_DIRS for p in names):
        return 'credential-or-session-directory'
    if names[0] in RUNTIME_ROOTS:
        return 'runtime-evidence-in-framework'
    if any(names[i:i+2] == ('wp-content', 'uploads') for i in range(len(names)-1)):
        return 'wordpress-user-uploads'
    if name in FORBIDDEN_NAMES:
        return 'machine-specific-or-sensitive-config'
    if (name == '.env' or name.startswith('.env.')) and name != '.env.example':
        return 'environment-secrets-file'
    if name.endswith(('.local.json', '.local.yaml', '.local.yml', '.local.toml')):
        return 'local-config'
    if name.endswith(FORBIDDEN_SUFFIXES):
        return 'sensitive-or-generated-file-type'
    return None

def indexed_paths(root: Path) -> list[str]:
    cp = subprocess.run(['git', '-C', str(root), 'ls-files', '--cached', '-z'],
                        capture_output=True, timeout=20, check=True)
    return [p.decode('utf-8', errors='surrogateescape') for p in cp.stdout.split(b'\0') if p]

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    try:
        cp = subprocess.run(['git', '-C', str(args.repo), 'rev-parse', '--show-toplevel'],
                            capture_output=True, text=True, timeout=20, check=True)
        root = Path(cp.stdout.strip()).resolve()
        paths = indexed_paths(root)
    except (OSError, subprocess.SubprocessError):
        print('BLOCKED: an accessible, initialized Git repository is required.', file=sys.stderr)
        return 2
    if not paths:
        print('BLOCKED: Git index is empty. Stage reviewed source files first.', file=sys.stderr)
        return 2
    violations = [{'path': p, 'rule': why} for p in paths if (why := forbidden_reason(p))]
    print(json.dumps({'status': 'fail' if violations else 'pass', 'indexed_files': len(paths),
                      'violations': violations,
                      'scope': 'Filename/path rules only. No content or history secret scan.'},
                     ensure_ascii=True, indent=2))
    return 1 if violations else 0

if __name__ == '__main__':
    sys.exit(main())
