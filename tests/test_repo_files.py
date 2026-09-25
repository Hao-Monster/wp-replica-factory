import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('repo_files', ROOT/'scripts/check_repo_files.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class RepoFiles(unittest.TestCase):
    def test_env_files_blocked(self):
        for path in ['.env', '.env.production', 'nested/.env.local']:
            self.assertIsNotNone(m.forbidden_reason(path))

    def test_sanitized_examples_allowed(self):
        for path in ['.env.example', 'examples/project.example.json', '.github/workflows/control-tests.yml']:
            self.assertIsNone(m.forbidden_reason(path))

    def test_project_and_sessions_blocked(self):
        for path in ['project.json', 'x/storageState.json', 'playwright/.auth/user.json', '.ssh/config']:
            self.assertIsNotNone(m.forbidden_reason(path))

    def test_business_and_runtime_files_blocked(self):
        for path in ['wp-content/uploads/photo.png', 'orders.sql.gz', 'reference/page.png', 'artifacts/theme.zip']:
            self.assertIsNotNone(m.forbidden_reason(path))

    def test_skills_and_synthetic_fixtures_allowed(self):
        for path in ['.agents/skills/replica-factory/SKILL.md', 'tests/fixtures/reports/expected.json', 'fixtures/demo.svg']:
            self.assertIsNone(m.forbidden_reason(path))

    def test_windows_paths(self):
        self.assertIsNotNone(m.forbidden_reason(r'wp-content\uploads\photo.png'))
        self.assertIsNotNone(m.forbidden_reason(r'.secrets\preview.json'))

    def test_reads_real_git_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(['git', 'init', '-q', str(root)], check=True, capture_output=True)
            (root/'README.md').write_text('Safe test fixture\n', encoding='utf-8')
            (root/'.env').write_text('FAKE_TEST_VALUE=not-a-secret\n', encoding='utf-8')
            subprocess.run(['git', '-C', str(root), 'add', 'README.md', '.env'], check=True, capture_output=True)
            self.assertEqual(set(m.indexed_paths(root)), {'README.md', '.env'})
            self.assertIsNotNone(m.forbidden_reason('.env'))

if __name__ == '__main__':
    unittest.main()
