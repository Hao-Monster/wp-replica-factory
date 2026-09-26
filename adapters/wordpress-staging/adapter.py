#!/usr/bin/env python3
"""Reusable WordPress/WooCommerce staging adapter.

The adapter supports local or SSH transport and two WordPress runtime modes:
host-wpcli and docker-compose-wordpress. Mutating operations are guarded by the
WordPress runtime's wp_get_environment_type(); configuration labels alone never
authorize a write.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import zipfile

EPHEMERAL_WPCLI_IMAGE = "wordpress:cli"
FIXTURE_SKUS = [f"replica-fixture-{i:03d}" for i in range(1, 5)]
REQUIRED_ARTIFACT_FIELDS = {
    "theme_slug", "theme_version", "git_sha", "artifact_sha256",
    "framework_version", "build_timestamp", "reference_status",
}


class Blocked(RuntimeError):
    pass


class AdapterError(RuntimeError):
    pass


class DeploymentError(AdapterError):
    pass


@dataclass
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


class SubprocessRunner:
    def run(self, argv, *, input_text=None, cwd=None, check=False):
        try:
            cp = subprocess.run(
                list(argv),
                input=input_text,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=cwd,
                timeout=120,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise AdapterError(f"command execution failed: {type(exc).__name__}") from exc
        result = CommandResult(cp.returncode, cp.stdout or "", cp.stderr or "")
        if check and result.returncode:
            raise AdapterError(f"command failed: {shlex.join(list(argv)[:4])}")
        return result


def sha256_file(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _need(condition, message, exc=Blocked):
    if not condition:
        raise exc(message)


def _safe_slug(value):
    return isinstance(value, str) and re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,79}", value) is not None


def _safe_site_url(value):
    if not isinstance(value, str):
        return False
    parsed = urlsplit(value)
    return (
        parsed.scheme in ("http", "https")
        and bool(parsed.hostname)
        and parsed.username is None
        and parsed.password is None
        and not parsed.fragment
    )


def validate_config(cfg):
    _need(isinstance(cfg, dict), "staging config must be an object")
    _need(cfg.get("production") is False, "production must be explicitly false")
    _need(cfg.get("environment") in ("staging", "development"), "environment must be staging or development")
    _need(_safe_site_url(cfg.get("siteUrl")), "siteUrl must be a safe HTTP(S) URL")
    _need(cfg.get("transport") in ("local", "ssh"), "transport must be local or ssh")
    if cfg["transport"] == "ssh":
        ssh = cfg.get("ssh") or {}
        _need(isinstance(ssh.get("host"), str) and ssh["host"].strip(), "ssh.host is required")
        if ssh.get("port") is not None:
            _need(type(ssh["port"]) is int and 1 <= ssh["port"] <= 65535, "invalid ssh.port")

    runtime = cfg.get("runtime")
    _need(isinstance(runtime, dict), "runtime is required")
    _need(runtime.get("type") in ("host-wpcli", "docker-compose-wordpress"), "unsupported runtime.type")
    if runtime["type"] == "host-wpcli":
        _need(isinstance(runtime.get("wpPath"), str) and runtime["wpPath"], "runtime.wpPath is required")
    else:
        for key in ("composePath", "service", "hostWpPath", "containerWpPath"):
            _need(isinstance(runtime.get(key), str) and runtime[key], f"runtime.{key} is required")
        _need(_safe_slug(runtime["service"]), "runtime.service must be a stable Compose service name")

    policy = cfg.setdefault("policy", {})
    _need(type(policy.get("allowDevelopment", False)) is bool, "policy.allowDevelopment must be boolean")
    _need(type(policy.get("activate", False)) is bool, "policy.activate must be boolean")
    health = cfg.setdefault("healthPaths", ["/", "/shop/"])
    _need(isinstance(health, list) and health, "healthPaths must be a non-empty list")
    for item in health:
        _need(isinstance(item, str) and item.startswith("/") and not item.startswith("//"), "health path must start with /")
    marker = cfg.setdefault("fixtureMarker", "replica-fixture")
    _need(marker == "replica-fixture", "fixtureMarker must use the framework-owned replica-fixture marker")
    return cfg


def load_config(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise Blocked("invalid staging config") from exc
    return validate_config(data)


def verify_artifact(artifact, manifest_path):
    artifact = Path(artifact)
    manifest_path = Path(manifest_path)
    _need(artifact.is_file() and artifact.name.endswith(".zip"), "theme.zip artifact is required", AdapterError)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AdapterError("invalid artifact manifest") from exc
    missing = REQUIRED_ARTIFACT_FIELDS - set(manifest)
    _need(not missing, "artifact manifest missing required fields", AdapterError)
    _need(_safe_slug(manifest.get("theme_slug")), "invalid theme_slug", AdapterError)
    _need(isinstance(manifest.get("theme_version"), str) and manifest["theme_version"], "invalid theme_version", AdapterError)
    _need(re.fullmatch(r"[0-9a-f]{40,64}", str(manifest.get("git_sha", ""))) is not None, "invalid git_sha", AdapterError)
    _need(re.fullmatch(r"[0-9a-f]{64}", str(manifest.get("artifact_sha256", ""))) is not None, "invalid artifact_sha256", AdapterError)
    _need(sha256_file(artifact) == manifest["artifact_sha256"], "artifact SHA256 mismatch", AdapterError)
    _need(manifest.get("reference_status") in ("owned", "authorized", "user-supplied"), "reference_status is not deployable", AdapterError)

    slug = manifest["theme_slug"]
    with zipfile.ZipFile(artifact) as archive:
        infos = archive.infolist()
        _need(bool(infos), "empty theme artifact", AdapterError)
        for info in infos:
            name = info.filename.replace("\\", "/")
            pure = PurePosixPath(name)
            _need(not pure.is_absolute() and ".." not in pure.parts, "unsafe path in theme artifact", AdapterError)
            _need(pure.parts and pure.parts[0] == slug, "artifact must contain exactly the declared theme root", AdapterError)
            mode = (info.external_attr >> 16) & 0xFFFF
            _need(not stat.S_ISLNK(mode), "symlink rejected in theme artifact", AdapterError)
            lower = name.lower()
            _need("wp-config.php" not in lower and "/uploads/" not in lower, "forbidden WordPress data/config in theme artifact", AdapterError)
    return manifest


class RedirectRecorder(HTTPRedirectHandler):
    def __init__(self):
        super().__init__()
        self.chain = []

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.chain.append(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class StagingAdapter:
    def __init__(self, config, runner=None):
        self.cfg = validate_config(config)
        self.runner = runner or SubprocessRunner()

    @property
    def runtime(self):
        return self.cfg["runtime"]

    def _ssh_argv(self):
        ssh = self.cfg.get("ssh") or {}
        argv = ["ssh", "-o", "BatchMode=yes"]
        if ssh.get("port"):
            argv += ["-p", str(ssh["port"])]
        target = (ssh.get("user") + "@" if ssh.get("user") else "") + ssh.get("host", "")
        return argv, target

    def _exec_host(self, argv, *, input_text=None, check=False):
        argv = [str(x) for x in argv]
        if self.cfg["transport"] == "local":
            return self.runner.run(argv, input_text=input_text, check=check)
        prefix, target = self._ssh_argv()
        remote = shlex.join(argv)
        return self.runner.run([*prefix, target, remote], input_text=input_text, check=check)

    def _host_shell(self, script, *, input_text=None, check=False):
        if self.cfg["transport"] == "local":
            return self.runner.run(["sh", "-lc", script], input_text=input_text, check=check)
        prefix, target = self._ssh_argv()
        return self.runner.run([*prefix, target, script], input_text=input_text, check=check)

    def remote_access_gate(self):
        result = self._exec_host(["true"])
        if result.returncode:
            raise Blocked("REMOTE_ACCESS_GATE failed")
        return "PASS"

    def _compose(self, args, *, check=False):
        runtime = self.runtime
        base = ["docker", "compose", "--project-directory", runtime["composePath"]]
        if runtime.get("composeFile"):
            compose_file = runtime["composeFile"]
            if not os.path.isabs(compose_file):
                compose_file = str(Path(runtime["composePath"]) / compose_file)
            base += ["-f", compose_file]
        return self._exec_host([*base, *args], check=check)

    def container_id(self):
        _need(self.runtime["type"] == "docker-compose-wordpress", "container_id only applies to docker-compose-wordpress")
        result = self._compose(["ps", "-q", self.runtime["service"]])
        if result.returncode or not result.stdout.strip():
            raise Blocked("docker compose WordPress service is not running")
        return result.stdout.strip().splitlines()[0]

    def _container_has_wp(self):
        result = self._compose([
            "exec", "-T", self.runtime["service"],
            "sh", "-lc", "command -v wp >/dev/null 2>&1",
        ])
        return result.returncode == 0

    def _db_env(self, cid):
        script = (
            'for k in WORDPRESS_DB_HOST WORDPRESS_DB_USER WORDPRESS_DB_PASSWORD WORDPRESS_DB_NAME; '
            'do printf "%s=" "$k"; printenv "$k"; done'
        )
        result = self._exec_host(["docker", "exec", cid, "sh", "-lc", script])
        if result.returncode:
            raise AdapterError("unable to read required WordPress DB environment")
        env = {}
        for line in result.stdout.splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                if key in {"WORDPRESS_DB_HOST", "WORDPRESS_DB_USER", "WORDPRESS_DB_PASSWORD", "WORDPRESS_DB_NAME"}:
                    env[key] = value
        if any(not env.get(key) for key in ("WORDPRESS_DB_HOST", "WORDPRESS_DB_USER", "WORDPRESS_DB_PASSWORD", "WORDPRESS_DB_NAME")):
            raise AdapterError("required WordPress DB environment is incomplete")
        return env

    def _network_name(self, cid):
        template = "{{range $k,$v := .NetworkSettings.Networks}}{{println $k}}{{end}}"
        result = self._exec_host(["docker", "inspect", "-f", template, cid])
        if result.returncode or not result.stdout.strip():
            raise AdapterError("WordPress container network not found")
        return result.stdout.strip().splitlines()[0]

    def _write_ephemeral_env(self, env):
        content = "".join(f"{key}={env[key]}\n" for key in (
            "WORDPRESS_DB_HOST", "WORDPRESS_DB_USER", "WORDPRESS_DB_PASSWORD", "WORDPRESS_DB_NAME"
        ))
        if self.cfg["transport"] == "local":
            fd, name = tempfile.mkstemp(prefix="replica-wpcli-", suffix=".env")
            try:
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    stream.write(content)
            except Exception:
                try:
                    os.close(fd)
                except OSError:
                    pass
                Path(name).unlink(missing_ok=True)
                raise
            return name, lambda: Path(name).unlink(missing_ok=True)
        remote = f"/tmp/replica-wpcli-{uuid.uuid4().hex}.env"
        quoted = shlex.quote(remote)
        result = self._host_shell(f"umask 077; cat > {quoted}", input_text=content)
        if result.returncode:
            raise AdapterError("unable to create ephemeral WP-CLI environment")
        return remote, lambda: self._host_shell(f"rm -f {quoted}")

    def wp_cli_mode(self):
        if self.runtime["type"] == "host-wpcli":
            return "host-wpcli"
        self.container_id()
        return "container-wpcli" if self._container_has_wp() else "ephemeral-wordpress-cli"

    def run_wp_cli(self, args):
        args = [str(x) for x in args]
        if self.runtime["type"] == "host-wpcli":
            result = self._exec_host(["wp", *args, "--path=" + self.runtime["wpPath"]])
            if result.returncode:
                raise AdapterError("host WP-CLI command failed")
            return result.stdout.strip()

        cid = self.container_id()
        if self._container_has_wp():
            result = self._compose([
                "exec", "-T", self.runtime["service"],
                "wp", *args,
                "--path=" + self.runtime["containerWpPath"],
                "--allow-root",
            ])
            if result.returncode:
                raise AdapterError("container WP-CLI command failed")
            return result.stdout.strip()

        env = self._db_env(cid)
        network = self._network_name(cid)
        env_file, cleanup = self._write_ephemeral_env(env)
        try:
            result = self._exec_host([
                "docker", "run", "--rm",
                "--network", network,
                "--volumes-from", cid,
                "-w", self.runtime["containerWpPath"],
                "--env-file", env_file,
                EPHEMERAL_WPCLI_IMAGE,
                "wp",
                *args,
                "--path=" + self.runtime["containerWpPath"],
                "--allow-root",
            ])
            if result.returncode:
                raise AdapterError("ephemeral WP-CLI command failed")
            return result.stdout.strip()
        finally:
            cleanup()

    def require_wordpress_environment(self):
        environment = self.run_wp_cli(["eval", "echo wp_get_environment_type();"]).strip()
        allowed = {"staging"}
        if self.cfg.get("policy", {}).get("allowDevelopment"):
            allowed.add("development")
        if environment not in allowed:
            raise Blocked(f"WORDPRESS_ENVIRONMENT_GATE blocked runtime environment: {environment or 'unknown'}")
        return environment

    def _runtime_option(self, name):
        try:
            return self.run_wp_cli(["option", "get", name, "--format=json"]).strip().strip('"')
        except AdapterError:
            return ""

    def _active_webhook_count(self):
        code = (
            "$n=(int)$GLOBALS['wpdb']->get_var("
            "\"SELECT COUNT(*) FROM {$GLOBALS['wpdb']->posts} "
            "WHERE post_type='shop_webhook' AND post_status='publish'\""
            "); echo $n;"
        )
        try:
            return int(self.run_wp_cli(["eval", code]).strip() or "0")
        except (AdapterError, ValueError):
            return -1

    def gate_report(self):
        report = {
            "REMOTE_ACCESS_GATE": "BLOCKED",
            "WORDPRESS_ENVIRONMENT_GATE": "BLOCKED",
            "THEME_DEPLOY_GATE": "BLOCKED",
            "PRODUCT_SEED_GATE": "BLOCKED",
            "CHECKOUT_GATE": "BLOCKED",
            "ORDER_GATE": "BLOCKED",
        }
        try:
            report["REMOTE_ACCESS_GATE"] = self.remote_access_gate()
            environment = self.require_wordpress_environment()
            report["WORDPRESS_ENVIRONMENT_GATE"] = "PASS"
            report["THEME_DEPLOY_GATE"] = "PASS"
        except (Blocked, AdapterError):
            return report

        marker_ok = self._runtime_option("replica_fixture_marker") == self.cfg["fixtureMarker"]
        if marker_ok:
            report["PRODUCT_SEED_GATE"] = "PASS"
        if marker_ok and self._runtime_option("replica_checkout_fixture_enabled") == "1":
            report["CHECKOUT_GATE"] = "PASS"

        order_options = (
            self._runtime_option("replica_real_payment_disabled") == "1"
            and self._runtime_option("replica_mail_disabled") == "1"
            and self._runtime_option("replica_external_inventory_sync_disabled") == "1"
            and marker_ok
        )
        if order_options and self._active_webhook_count() == 0:
            report["ORDER_GATE"] = "PASS"
        report["environment"] = environment
        return report

    def _request_health(self, path):
        url = urljoin(self.cfg["siteUrl"].rstrip("/") + "/", path.lstrip("/"))
        recorder = RedirectRecorder()
        opener = build_opener(recorder)
        try:
            with opener.open(Request(url, headers={"User-Agent": "Replica-Staging-Health/1"}), timeout=20) as response:
                body = response.read(1024 * 1024).decode("utf-8", "replace")
                status = int(response.status)
                final_url = response.geturl()
        except HTTPError as exc:
            body = exc.read(1024 * 1024).decode("utf-8", "replace")
            status = int(exc.code)
            final_url = exc.geturl()
        except (URLError, OSError) as exc:
            return {
                "path": path, "status": 0, "final_url": None,
                "redirect_chain": [url, *recorder.chain],
                "critical_mixed_content_failures": 0,
                "wordpress_critical_error": False,
                "ok": False, "error": type(exc).__name__,
            }
        critical = (
            "there has been a critical error on this website" in body.lower()
            or "fatal error" in body.lower()
        )
        mixed = 0
        if final_url.startswith("https://"):
            mixed = len(re.findall(r"(?:src|href)=[\"']http://", body, flags=re.I))
        ok = 200 <= status < 400 and not critical and mixed == 0
        return {
            "path": path,
            "status": status,
            "final_url": final_url,
            "https": final_url.startswith("https://"),
            "redirect_chain": [url, *recorder.chain],
            "critical_mixed_content_failures": mixed,
            "wordpress_critical_error": critical,
            "ok": ok,
        }

    def web_runtime_health(self):
        rows = [self._request_health(path) for path in self.cfg["healthPaths"]]
        return {"status": "pass" if all(x["ok"] for x in rows) else "fail", "requests": rows}

    def version_info(self, theme_slug=None):
        environment = self.run_wp_cli(["eval", "echo wp_get_environment_type();"]).strip()
        active = self.run_wp_cli(["theme", "list", "--status=active", "--field=name"]).splitlines()
        active_theme = active[0].strip() if active else ""
        active_version = self.run_wp_cli([
            "eval", "$t=wp_get_theme(); echo (string)$t->get('Version');"
        ]).strip()
        slug = theme_slug or self.cfg.get("themeSlug") or active_theme
        target_version = ""
        if slug:
            try:
                target_version = self.run_wp_cli(["theme", "get", slug, "--field=version"]).strip()
            except AdapterError:
                target_version = ""
        wc = self.run_wp_cli([
            "eval",
            "$p='woocommerce/woocommerce.php';"
            "$a=(array)get_option('active_plugins',[]);"
            "if(in_array($p,$a,true)){"
            "$d=get_file_data(WP_PLUGIN_DIR.'/'.$p,['Version'=>'Version']);"
            "echo (string)($d['Version']??'');}",
        ]).strip()
        return {
            "environment": environment,
            "active_theme": active_theme,
            "active_version": active_version,
            "target_theme": slug,
            "target_version": target_version,
            "woocommerce_active": bool(wc),
            "woocommerce_version": wc,
            "wordpress_version": self.run_wp_cli(["core", "version"]).strip(),
        }

    def health(self, *, write_report=False):
        versions = self.version_info()
        web = self.web_runtime_health()
        status_value = "pass" if web["status"] == "pass" and versions["environment"] in ("staging", "development") else "fail"
        report = {
            "schema_version": 1,
            "status": status_value,
            "environment": versions["environment"],
            "active_theme": versions["active_theme"],
            "theme_version": versions["active_version"],
            "woocommerce_active": versions["woocommerce_active"],
            "woocommerce_version": versions["woocommerce_version"],
            "wordpress_version": versions["wordpress_version"],
            "webRuntimeHealth": web,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        if write_report:
            target = Path(self.cfg.get("healthReportPath", ".replica/reports/staging-health.json"))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return report

    def doctor(self):
        cli_environment = ""
        try:
            cli_environment = self.run_wp_cli(["eval", "echo wp_get_environment_type();"]).strip()
        except AdapterError:
            pass
        gates = self.gate_report()
        return {
            "status": "ready" if gates["THEME_DEPLOY_GATE"] == "PASS" else "blocked",
            "runtime": self.runtime["type"],
            "wpCliMode": self.wp_cli_mode(),
            "cliRuntime": {
                "environment": cli_environment,
                "note": "CLI is_ssl() is not used as Web HTTPS evidence",
            },
            "webRuntimeHealth": self.web_runtime_health(),
            "gates": gates,
        }

    def validate_artifact(self, artifact, manifest_path):
        manifest = verify_artifact(artifact, manifest_path)
        with tempfile.TemporaryDirectory(prefix="replica-artifact-") as temp:
            with zipfile.ZipFile(artifact) as archive:
                archive.extractall(temp)
            for php in Path(temp, manifest["theme_slug"]).rglob("*.php"):
                self._lint_php_file(php)
        return manifest

    def _lint_php_file(self, path):
        php = shutil.which("php")
        if not php:
            return
        result = self.runner.run([php, "-l", str(path)])
        if result.returncode:
            raise AdapterError("PHP syntax error in theme artifact")

    def _theme_paths(self, slug):
        if self.runtime["type"] == "docker-compose-wordpress":
            host_root = Path(self.runtime["hostWpPath"]) / "wp-content" / "themes"
            container_root = PurePosixPath(self.runtime["containerWpPath"]) / "wp-content" / "themes"
            state_root = Path(self.runtime["hostWpPath"]) / ".replica-staging"
        else:
            host_root = Path(self.runtime["wpPath"]) / "wp-content" / "themes"
            container_root = None
            state_root = Path(self.runtime["wpPath"]) / ".replica-staging"
        return host_root, container_root, state_root

    def _copy_artifact_to_host(self, artifact):
        artifact = Path(artifact)
        if self.cfg["transport"] == "local":
            return str(artifact), lambda: None
        remote = f"/tmp/replica-theme-{uuid.uuid4().hex}.zip"
        _, target = self._ssh_argv()
        scp = ["scp"]
        ssh = self.cfg.get("ssh") or {}
        if ssh.get("port"):
            scp += ["-P", str(ssh["port"])]
        scp += [str(artifact), f"{target}:{remote}"]
        result = self.runner.run(scp)
        if result.returncode:
            raise AdapterError("theme artifact upload failed")
        return remote, lambda: self._host_shell(f"rm -f {shlex.quote(remote)}")

    def _remote_php_lint(self, slug):
        host_root, container_root, _ = self._theme_paths(slug)
        if self.runtime["type"] == "docker-compose-wordpress":
            target = str(container_root / f"{slug}.next")
            script = f"set -eu; find {shlex.quote(target)} -type f -name '*.php' -print0 | xargs -0 -r -n1 php -l >/dev/null"
            result = self._compose(["exec", "-T", self.runtime["service"], "sh", "-lc", script])
        else:
            target = str(host_root / f"{slug}.next")
            script = f"set -eu; find {shlex.quote(target)} -type f -name '*.php' -print0 | xargs -0 -r -n1 php -l >/dev/null"
            result = self._host_shell(script)
        if result.returncode:
            raise AdapterError("remote PHP syntax validation failed")

    def _write_state(self, path, value):
        payload = json.dumps(value, separators=(",", ":")) + "\n"
        script = (
            f"umask 077; mkdir -p {shlex.quote(str(path.parent))}; "
            f"cat > {shlex.quote(str(path))}"
        )
        result = self._host_shell(script, input_text=payload)
        if result.returncode:
            raise AdapterError("unable to persist theme rollback state")

    def _read_state(self, path):
        result = self._host_shell(f"cat {shlex.quote(str(path))}")
        if result.returncode:
            raise DeploymentError("rollback state is unavailable")
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise DeploymentError("rollback state is invalid") from exc

    def _deploy_theme_files(self, manifest, artifact):
        slug = manifest["theme_slug"]
        before = self.version_info(slug)
        host_root, _, state_root = self._theme_paths(slug)
        current = host_root / slug
        next_dir = host_root / f"{slug}.next"
        previous = host_root / f"{slug}.previous"
        unpack = host_root / f".replica-unpack-{slug}-{uuid.uuid4().hex[:10]}"
        state_path = state_root / f"{slug}.json"
        staged, cleanup_artifact = self._copy_artifact_to_host(artifact)
        try:
            script = (
                "set -eu; "
                f"mkdir -p {shlex.quote(str(host_root))}; "
                f"rm -rf {shlex.quote(str(next_dir))} {shlex.quote(str(unpack))}; "
                f"mkdir -p {shlex.quote(str(unpack))}; "
                f"unzip -q {shlex.quote(staged)} -d {shlex.quote(str(unpack))}; "
                f"test -d {shlex.quote(str(unpack / slug))}; "
                f"mv {shlex.quote(str(unpack / slug))} {shlex.quote(str(next_dir))}; "
                f"rm -rf {shlex.quote(str(unpack))}"
            )
            if self._host_shell(script).returncode:
                raise AdapterError("theme extraction failed")
            self._remote_php_lint(slug)
            state = {
                "theme_slug": slug,
                "before_active": before["active_theme"],
                "before_target_version": before["target_version"],
                "had_target": bool(before["target_version"]),
                "saved_at": datetime.now(timezone.utc).isoformat(),
            }
            self._write_state(state_path, state)
            swap = (
                "set -eu; "
                f"rm -rf {shlex.quote(str(previous))}; "
                f"if [ -d {shlex.quote(str(current))} ]; then mv {shlex.quote(str(current))} {shlex.quote(str(previous))}; fi; "
                f"mv {shlex.quote(str(next_dir))} {shlex.quote(str(current))}"
            )
            if self._host_shell(swap).returncode:
                raise DeploymentError("theme swap failed")
            if before["active_theme"] != slug and self.cfg["policy"].get("activate"):
                self.run_wp_cli(["theme", "activate", slug])
            return {
                "before_active": before["active_theme"],
                "before_target_version": before["target_version"],
                "state_path": str(state_path),
            }
        finally:
            cleanup_artifact()
            self._host_shell(
                f"rm -rf {shlex.quote(str(next_dir))} {shlex.quote(str(unpack))}"
            )

    def _rollback_theme_files(self):
        slug = self.cfg.get("themeSlug")
        if not slug:
            raise DeploymentError("themeSlug is required for rollback")
        host_root, _, state_root = self._theme_paths(slug)
        current = host_root / slug
        previous = host_root / f"{slug}.previous"
        state_path = state_root / f"{slug}.json"
        state = self._read_state(state_path)
        _need(state.get("theme_slug") == slug, "rollback state theme mismatch", DeploymentError)
        probe = self._host_shell(f"test -d {shlex.quote(str(previous))}")
        if state.get("had_target"):
            if probe.returncode:
                raise DeploymentError("previous theme files are unavailable")
            script = (
                "set -eu; "
                f"rm -rf {shlex.quote(str(current))}.failed; "
                f"if [ -d {shlex.quote(str(current))} ]; then mv {shlex.quote(str(current))} {shlex.quote(str(current))}.failed; fi; "
                f"mv {shlex.quote(str(previous))} {shlex.quote(str(current))}; "
                f"rm -rf {shlex.quote(str(current))}.failed"
            )
        else:
            script = f"set -eu; rm -rf {shlex.quote(str(current))} {shlex.quote(str(previous))}"
        if self._host_shell(script).returncode:
            raise DeploymentError("theme file rollback failed")
        before_active = state.get("before_active") or ""
        if before_active and before_active != slug:
            self.run_wp_cli(["theme", "activate", before_active])
        return {
            "expected_version": state.get("before_target_version") or "",
            "expected_active": before_active,
        }

    def deploy(self, artifact, manifest_path):
        self.require_wordpress_environment()
        manifest = self.validate_artifact(artifact, manifest_path)
        slug = manifest["theme_slug"]
        self.cfg["themeSlug"] = slug
        flow = self._deploy_theme_files(manifest, artifact)
        versions = self.version_info(slug)
        should_be_active = flow["before_active"] == slug or self.cfg["policy"].get("activate")
        mismatch = versions["target_version"] != manifest["theme_version"]
        if should_be_active:
            mismatch = mismatch or versions["active_theme"] != slug or versions["active_version"] != manifest["theme_version"]
        if mismatch:
            try:
                self.rollback()
            except (Blocked, AdapterError):
                raise DeploymentError("remote version mismatch; rollback failed")
            raise DeploymentError("remote version mismatch; rollback completed")
        health = self.health(write_report=True)
        if health["status"] != "pass":
            try:
                self.rollback()
            except (Blocked, AdapterError):
                raise DeploymentError("deployment health failed; rollback failed")
            raise DeploymentError("deployment health failed; rollback completed")
        return {
            "status": "deployed",
            "theme_slug": slug,
            "theme_version": manifest["theme_version"],
            "artifact_sha256": manifest["artifact_sha256"],
            "versions": versions,
            "health": health,
        }

    def rollback(self):
        self.require_wordpress_environment()
        restored = self._rollback_theme_files()
        versions = self.version_info(self.cfg.get("themeSlug"))
        if restored.get("expected_version") and versions["target_version"] != restored["expected_version"]:
            raise DeploymentError("rollback version verification failed")
        if restored.get("expected_active") and versions["active_theme"] != restored["expected_active"]:
            raise DeploymentError("rollback active theme verification failed")
        health = self.health(write_report=True)
        if health["status"] != "pass":
            raise DeploymentError("rollback health failed")
        return {"status": "rolled_back", "versions": versions, "health": health}

    def seed(self, *, fixture=False):
        if not fixture:
            raise Blocked("seed requires --fixture")
        gates = self.gate_report()
        if gates["PRODUCT_SEED_GATE"] != "PASS":
            raise Blocked("PRODUCT_SEED_GATE is not PASS")
        marker = self.cfg["fixtureMarker"]
        code = f"""
$marker={json.dumps(marker)};
$term=term_exists('replica-fixture','product_cat');
if(!$term){{$term=wp_insert_term('Replica Fixture','product_cat',['slug'=>'replica-fixture']);}}
$term_id=is_array($term)?(int)$term['term_id']:(int)$term;
$skus={json.dumps(FIXTURE_SKUS)};
foreach($skus as $i=>$sku){{
  $id=wc_get_product_id_by_sku($sku);
  if(!$id){{
    $p=new WC_Product_Simple();
    $p->set_name('Replica Fixture '.str_pad((string)($i+1),3,'0',STR_PAD_LEFT));
    $p->set_sku($sku); $p->set_regular_price((string)(11+$i)); $p->set_status('publish');
    $p->set_category_ids([$term_id]); $id=$p->save();
  }}
  update_post_meta($id,'_replica_fixture_marker',$marker);
}}
echo json_encode(['marker'=>$marker,'skus'=>$skus]);
"""
        raw = self.run_wp_cli(["eval", code])
        return {"status": "seeded", "marker": marker, "skus": FIXTURE_SKUS, "runtime": raw}

    def cleanup(self, *, fixture=False):
        if not fixture:
            raise Blocked("cleanup requires --fixture")
        self.require_wordpress_environment()
        if self._runtime_option("replica_fixture_marker") != self.cfg["fixtureMarker"]:
            raise Blocked("PRODUCT_SEED_GATE is not PASS")
        marker = self.cfg["fixtureMarker"]
        code = f"""
$marker={json.dumps(marker)};
$products=new WP_Query(['post_type'=>'product','post_status'=>'any','posts_per_page'=>-1,
  'meta_key'=>'_replica_fixture_marker','meta_value'=>$marker,'fields'=>'ids']);
foreach($products->posts as $id){{wp_delete_post($id,true);}}
$orders=wc_get_orders(['limit'=>-1,'type'=>'shop_order','return'=>'objects',
  'meta_query'=>[['key'=>'_replica_fixture_marker','value'=>$marker]]]);
$deleted_orders=0;
foreach($orders as $order){{
  if((string)$order->get_meta('_replica_fixture_marker') !== (string)$marker){{continue;}}
  $order->delete(true); $deleted_orders++;
}}
$term=get_term_by('slug','replica-fixture','product_cat');
if($term && !is_wp_error($term)){{wp_delete_term($term->term_id,'product_cat');}}
echo json_encode(['deleted_products'=>count($products->posts),'deleted_orders'=>$deleted_orders,'marker'=>$marker]);
"""
        raw = self.run_wp_cli(["eval", code])
        return {"status": "cleaned", "marker": marker, "runtime": raw}

    def order_test(self, *, fixture=False):
        if not fixture:
            raise Blocked("TEST_ORDER_BLOCKED")
        gates = self.gate_report()
        if gates["ORDER_GATE"] != "PASS":
            raise Blocked("TEST_ORDER_BLOCKED")
        marker = self.cfg["fixtureMarker"]
        code = f"""
$id=wc_get_product_id_by_sku('replica-fixture-001');
if(!$id){{throw new Exception('fixture product missing');}}
$order=wc_create_order(['status'=>'pending','created_via'=>'replica-fixture']);
$order->add_product(wc_get_product($id),1);
$order->update_meta_data('_replica_fixture_marker',{json.dumps(marker)});
$order->calculate_totals(); $order->save();
echo (string)$order->get_id();
"""
        order_id = self.run_wp_cli(["eval", code]).strip()
        return {"status": "created", "order_id": order_id, "marker": marker}


def _json(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("command", choices=[
        "doctor", "gates", "version", "health", "deploy", "rollback",
        "seed", "cleanup", "order-test",
    ])
    parser.add_argument("--artifact", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--fixture", action="store_true")
    args = parser.parse_args()
    try:
        cfg = load_config(args.config)
        adapter = StagingAdapter(cfg)
        if args.command == "doctor":
            result = adapter.doctor()
        elif args.command == "gates":
            result = adapter.gate_report()
        elif args.command == "version":
            result = adapter.version_info(cfg.get("themeSlug"))
        elif args.command == "health":
            result = adapter.health(write_report=True)
        elif args.command == "deploy":
            _need(args.artifact is not None, "--artifact is required", AdapterError)
            manifest = args.manifest or args.artifact.with_name("manifest.json")
            result = adapter.deploy(args.artifact, manifest)
        elif args.command == "rollback":
            result = adapter.rollback()
        elif args.command == "seed":
            result = adapter.seed(fixture=args.fixture)
        elif args.command == "cleanup":
            result = adapter.cleanup(fixture=args.fixture)
        else:
            result = adapter.order_test(fixture=args.fixture)
        _json(result)
        return 0 if result.get("status") not in ("fail", "blocked") else 2
    except Blocked as exc:
        print(json.dumps({"status": "blocked", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    except (AdapterError, OSError, ValueError, KeyError, zipfile.BadZipFile) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
