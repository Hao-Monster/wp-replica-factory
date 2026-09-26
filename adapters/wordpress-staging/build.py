#!/usr/bin/env python3
"""Build the reusable theme.zip + manifest.json staging artifact."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

ROOT=Path(__file__).resolve().parents[2]

def sha(path):
    h=hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda:f.read(1024*1024),b""):
            h.update(block)
    return h.hexdigest()

def git_sha():
    try:
        value=subprocess.check_output(["git","rev-parse","HEAD"],text=True,stderr=subprocess.DEVNULL).strip()
    except Exception:
        value=""
    if not re.fullmatch(r"[0-9a-f]{40,64}",value):
        raise SystemExit("git SHA is unavailable")
    return value

def parse_version(style):
    text=Path(style).read_text(encoding="utf-8",errors="replace")
    m=re.search(r"(?mi)^\s*Version:\s*([^\r\n]+)",text)
    if not m:
        raise SystemExit("theme style.css is missing Version")
    return m.group(1).strip()

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--theme-dir",type=Path,default=ROOT/"templates/woocommerce-theme")
    p.add_argument("--out",type=Path,default=Path(".replica/artifacts/theme"))
    p.add_argument("--theme-slug",default="replica-woocommerce")
    p.add_argument("--theme-version")
    p.add_argument("--reference-status",choices=("owned","authorized","user-supplied"),required=True)
    a=p.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,79}",a.theme_slug):
        raise SystemExit("invalid theme slug")
    if not a.theme_dir.is_dir() or not (a.theme_dir/"style.css").is_file():
        raise SystemExit("theme directory is invalid")
    version=a.theme_version or parse_version(a.theme_dir/"style.css")
    a.out.mkdir(parents=True,exist_ok=True)
    artifact=a.out/"theme.zip"
    manifest_path=a.out/"manifest.json"
    artifact.unlink(missing_ok=True)
    manifest_path.unlink(missing_ok=True)
    forbidden={".git","node_modules","uploads",".secrets"}
    with zipfile.ZipFile(artifact,"x",zipfile.ZIP_DEFLATED) as z:
        for f in sorted(a.theme_dir.rglob("*")):
            rel=f.relative_to(a.theme_dir)
            if any(part in forbidden or part.startswith(".") for part in rel.parts):
                raise SystemExit("forbidden path in theme")
            if f.is_dir():
                continue
            if f.is_symlink():
                raise SystemExit("symlink rejected in theme")
            info=zipfile.ZipInfo((Path(a.theme_slug)/rel).as_posix(),date_time=(2020,1,1,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=0o100644<<16
            z.writestr(info,f.read_bytes())
    manifest={
        "theme_slug":a.theme_slug,
        "theme_version":version,
        "git_sha":git_sha(),
        "artifact_sha256":sha(artifact),
        "framework_version":(ROOT/"VERSION").read_text(encoding="utf-8").strip(),
        "build_timestamp":datetime.now(timezone.utc).isoformat(),
        "reference_status":a.reference_status,
    }
    manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"status":"built","artifact":str(artifact),"manifest_path":str(manifest_path),"manifest":manifest},ensure_ascii=False,indent=2))

if __name__=="__main__":
    main()
