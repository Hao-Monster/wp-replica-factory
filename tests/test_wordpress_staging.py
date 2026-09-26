import importlib.util
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("staging", ROOT / "adapters/wordpress-staging/adapter.py")
staging = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = staging
SPEC.loader.exec_module(staging)

def base_config(**overrides):
    cfg = {
        "environment": "staging", "production": False,
        "siteUrl": "http://127.0.0.1:8080", "transport": "local",
        "runtime": {
            "type": "docker-compose-wordpress", "composePath": ".",
            "composeFile": "docker-compose.woocommerce-staging.yml",
            "service": "wordpress", "hostWpPath": "/tmp/wordpress",
            "containerWpPath": "/var/www/html",
        },
        "policy": {"allowDevelopment": False, "activate": True},
        "healthPaths": ["/", "/shop/"], "fixtureMarker": "replica-fixture",
    }
    cfg.update(overrides)
    return cfg

class FakeRunner:
    def __init__(self, *, service_running=True, container_has_wp=False):
        self.calls=[]; self.service_running=service_running
        self.container_has_wp=container_has_wp; self.env_file=None
        self.assert_mode_0600=False

    def run(self, argv, *, input_text=None, cwd=None, check=False):
        self.calls.append((list(argv), input_text, cwd)); text=" ".join(argv)
        if " compose " in f" {text} " and " ps -q " in f" {text} ":
            return staging.CommandResult(0, "cid123\n" if self.service_running else "", "")
        if "command -v wp" in text:
            return staging.CommandResult(0 if self.container_has_wp else 1, "/usr/local/bin/wp\n" if self.container_has_wp else "", "")
        if argv[:2]==["docker","exec"] and "WORDPRESS_DB_HOST" in text:
            return staging.CommandResult(0, "WORDPRESS_DB_HOST=db\nWORDPRESS_DB_USER=wordpress\nWORDPRESS_DB_PASSWORD=fixture-only\nWORDPRESS_DB_NAME=wordpress\n", "")
        if argv[:2]==["docker","inspect"]:
            return staging.CommandResult(0, "replica_default\n", "")
        if argv[:2]==["docker","run"]:
            if "--env-file" in argv:
                self.env_file=Path(argv[argv.index("--env-file")+1])
                self.assert_mode_0600=(self.env_file.stat().st_mode & 0o777)==0o600
            return staging.CommandResult(0, "staging", "")
        return staging.CommandResult(0, "", "")

class ConfigAndRuntimeTests(unittest.TestCase):
    def test_missing_compose_path_blocked(self):
        cfg=base_config(); del cfg["runtime"]["composePath"]
        with self.assertRaises(staging.Blocked): staging.validate_config(cfg)

    def test_missing_service_blocked(self):
        cfg=base_config(); del cfg["runtime"]["service"]
        with self.assertRaises(staging.Blocked): staging.validate_config(cfg)

    def test_service_not_running_blocked(self):
        adapter=staging.StagingAdapter(base_config(), runner=FakeRunner(service_running=False))
        with self.assertRaises(staging.Blocked): adapter.container_id()

    def test_container_without_wp_cli_uses_ephemeral_cli(self):
        runner=FakeRunner(container_has_wp=False); adapter=staging.StagingAdapter(base_config(), runner=runner)
        out=adapter.run_wp_cli(["eval","echo wp_get_environment_type();"])
        self.assertEqual(out,"staging")
        docker_runs=[call[0] for call in runner.calls if call[0][:2]==["docker","run"]]
        self.assertTrue(docker_runs)
        image_index=docker_runs[0].index(staging.EPHEMERAL_WPCLI_IMAGE)
        self.assertEqual(docker_runs[0][image_index+1],"wp")
        self.assertTrue(runner.assert_mode_0600)

    def test_ephemeral_cli_env_file_is_cleaned(self):
        runner=FakeRunner(container_has_wp=False); adapter=staging.StagingAdapter(base_config(), runner=runner)
        adapter.run_wp_cli(["core","version"])
        self.assertIsNotNone(runner.env_file); self.assertFalse(runner.env_file.exists())

    def test_container_wp_cli_does_not_use_ephemeral(self):
        runner=FakeRunner(container_has_wp=True); adapter=staging.StagingAdapter(base_config(), runner=runner)
        adapter.run_wp_cli(["core","version"])
        self.assertFalse(any(call[0][:2]==["docker","run"] for call in runner.calls))

class EnvironmentGateTests(unittest.TestCase):
    def test_production_environment_blocked(self):
        adapter=staging.StagingAdapter(base_config(), runner=FakeRunner())
        with mock.patch.object(adapter,"run_wp_cli",return_value="production"):
            with self.assertRaises(staging.Blocked): adapter.require_wordpress_environment()

    def test_unknown_environment_blocked(self):
        adapter=staging.StagingAdapter(base_config(), runner=FakeRunner())
        with mock.patch.object(adapter,"run_wp_cli",return_value=""):
            with self.assertRaises(staging.Blocked): adapter.require_wordpress_environment()

    def test_doctor_reports_blocked_when_runtime_is_production(self):
        adapter=staging.StagingAdapter(base_config(), runner=FakeRunner())
        with (
            mock.patch.object(adapter,"run_wp_cli",return_value="production"),
            mock.patch.object(adapter,"wp_cli_mode",return_value="ephemeral-wordpress-cli"),
            mock.patch.object(adapter,"web_runtime_health",return_value={"status":"pass","requests":[]}),
        ):
            self.assertEqual(adapter.doctor()["status"],"blocked")

    def test_development_only_allowed_by_policy(self):
        cfg=base_config(); cfg["policy"]["allowDevelopment"]=True
        adapter=staging.StagingAdapter(cfg, runner=FakeRunner())
        with mock.patch.object(adapter,"run_wp_cli",return_value="development"):
            self.assertEqual(adapter.require_wordpress_environment(),"development")

class ArtifactTests(unittest.TestCase):
    def make_artifact(self, root, php="<?php echo 'ok';"):
        theme=Path(root)/"theme"; theme.mkdir()
        (theme/"style.css").write_text("/*\nTheme Name: Fixture\nVersion: 1.2.3\n*/\n",encoding="utf-8")
        (theme/"index.php").write_text(php,encoding="utf-8")
        z=Path(root)/"theme.zip"
        with zipfile.ZipFile(z,"w") as out:
            for p in theme.iterdir(): out.write(p,f"replica-fixture-theme/{p.name}")
        manifest={"theme_slug":"replica-fixture-theme","theme_version":"1.2.3","git_sha":"a"*40,
          "artifact_sha256":staging.sha256_file(z),"framework_version":"0.1.1",
          "build_timestamp":"2026-09-26T00:00:00Z","reference_status":"owned"}
        m=Path(root)/"manifest.json"; m.write_text(json.dumps(manifest),encoding="utf-8"); return z,m

    def test_bad_artifact_sha_fails(self):
        with tempfile.TemporaryDirectory() as d:
            z,m=self.make_artifact(d); data=json.loads(m.read_text()); data["artifact_sha256"]="0"*64; m.write_text(json.dumps(data))
            with self.assertRaises(staging.AdapterError): staging.verify_artifact(z,m)

    def test_bad_php_syntax_fails(self):
        with tempfile.TemporaryDirectory() as d:
            z,m=self.make_artifact(d,"<?php function broken( {")
            adapter=staging.StagingAdapter(base_config(), runner=FakeRunner())
            with mock.patch.object(adapter,"_lint_php_file",side_effect=staging.AdapterError("PHP syntax error")):
                with self.assertRaises(staging.AdapterError): adapter.validate_artifact(z,m)

class DeploymentFailureTests(unittest.TestCase):
    def setUp(self):
        self.adapter=staging.StagingAdapter(base_config(), runner=FakeRunner())
        self.manifest={"theme_slug":"replica-fixture-theme","theme_version":"1.2.3"}

    def test_version_mismatch_triggers_rollback(self):
        versions={"active_theme":"replica-fixture-theme","active_version":"9.9.9","target_theme":"replica-fixture-theme","target_version":"9.9.9"}
        with (
            mock.patch.object(self.adapter,"require_wordpress_environment",return_value="staging"),
            mock.patch.object(self.adapter,"validate_artifact",return_value=self.manifest),
            mock.patch.object(self.adapter,"_deploy_theme_files",return_value={"before_active":"replica-fixture-theme"}) as deploy_files,
            mock.patch.object(self.adapter,"version_info",return_value=versions),
            mock.patch.object(self.adapter,"rollback",return_value={"status":"rolled_back"}) as rollback,
        ):
            with self.assertRaises(staging.DeploymentError): self.adapter.deploy(Path("theme.zip"),Path("manifest.json"))
            deploy_files.assert_called_once(); rollback.assert_called_once()

    def test_health_failure_triggers_rollback(self):
        versions={"active_theme":"replica-fixture-theme","active_version":"1.2.3","target_theme":"replica-fixture-theme","target_version":"1.2.3"}
        with (
            mock.patch.object(self.adapter,"require_wordpress_environment",return_value="staging"),
            mock.patch.object(self.adapter,"validate_artifact",return_value=self.manifest),
            mock.patch.object(self.adapter,"_deploy_theme_files",return_value={"before_active":"replica-fixture-theme"}),
            mock.patch.object(self.adapter,"version_info",return_value=versions),
            mock.patch.object(self.adapter,"health",return_value={"status":"fail"}),
            mock.patch.object(self.adapter,"rollback",return_value={"status":"rolled_back"}) as rollback,
        ):
            with self.assertRaises(staging.DeploymentError): self.adapter.deploy(Path("theme.zip"),Path("manifest.json"))
            rollback.assert_called_once()

    def test_rollback_success_requires_version_and_health(self):
        with (
            mock.patch.object(self.adapter,"require_wordpress_environment",return_value="staging"),
            mock.patch.object(self.adapter,"_rollback_theme_files",return_value={"expected_version":"1.0.0"}),
            mock.patch.object(self.adapter,"version_info",return_value={"target_version":"1.0.0","active_theme":"replica-fixture-theme","active_version":"1.0.0"}),
            mock.patch.object(self.adapter,"health",return_value={"status":"pass"}),
        ):
            self.assertEqual(self.adapter.rollback()["status"],"rolled_back")

    def test_rollback_failure_is_reported(self):
        with (
            mock.patch.object(self.adapter,"require_wordpress_environment",return_value="staging"),
            mock.patch.object(self.adapter,"_rollback_theme_files",return_value={"expected_version":"1.0.0"}),
            mock.patch.object(self.adapter,"version_info",return_value={"target_version":"1.0.0"}),
            mock.patch.object(self.adapter,"health",return_value={"status":"fail"}),
        ):
            with self.assertRaises(staging.DeploymentError): self.adapter.rollback()

class SideEffectGateTests(unittest.TestCase):
    def test_seed_requires_fixture_flag(self):
        adapter=staging.StagingAdapter(base_config(), runner=FakeRunner())
        with self.assertRaises(staging.Blocked): adapter.seed(fixture=False)

    def test_order_gate_blocks_missing_runtime_proofs(self):
        adapter=staging.StagingAdapter(base_config(), runner=FakeRunner())
        with (
            mock.patch.object(adapter,"require_wordpress_environment",return_value="staging"),
            mock.patch.object(adapter,"_runtime_option",return_value="0"),
            mock.patch.object(adapter,"_active_webhook_count",return_value=0),
        ):
            report=adapter.gate_report()
            self.assertEqual(report["THEME_DEPLOY_GATE"],"PASS")
            self.assertEqual(report["ORDER_GATE"],"BLOCKED")

    def test_cleanup_uses_owned_marker_and_hpos_safe_order_api(self):
        adapter=staging.StagingAdapter(base_config(), runner=FakeRunner())
        seen=[]
        with (
            mock.patch.object(adapter,"require_wordpress_environment",return_value="staging"),
            mock.patch.object(adapter,"_runtime_option",return_value="replica-fixture"),
            mock.patch.object(adapter,"run_wp_cli",side_effect=lambda args: seen.append(args) or "{}"),
        ):
            result=adapter.cleanup(fixture=True)
        self.assertEqual(result["status"],"cleaned")
        code=next(args[1] for args in seen if args[0]=="eval")
        self.assertIn("wc_get_orders",code)
        self.assertIn("_replica_fixture_marker",code)
        self.assertNotIn("TRUNCATE",code.upper())

class ControlledWorkflowContractTests(unittest.TestCase):
    def test_owned_cart_and_checkout_pages_are_deterministic_shortcodes(self):
        workflow=(ROOT/".github/workflows/woocommerce-staging.yml").read_text(encoding="utf-8")
        self.assertIn("wpcli post update \"$CART_ID\" --post_content='[woocommerce_cart]'",workflow)
        self.assertIn("wpcli post update \"$CHECKOUT_ID\" --post_content='[woocommerce_checkout]'",workflow)
        self.assertIn('wpcli option update woocommerce_cart_page_id "$CART_ID"',workflow)
        self.assertIn('wpcli option update woocommerce_checkout_page_id "$CHECKOUT_ID"',workflow)

if __name__=="__main__":
    unittest.main()
