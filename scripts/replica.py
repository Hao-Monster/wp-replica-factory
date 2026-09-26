#!/usr/bin/env python3
"""Replica Factory control-plane starter. No network crawling or production deployment.
Python 3.10+. Commands validate configuration, seal baselines, gate trusted reports,
record checkpoints, and package an explicit theme directory. Not a security sandbox.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid
import zipfile
from datetime import datetime, timezone
from urllib.parse import urlsplit

class Invalid(ValueError):
    pass

def read_json(path: Path):
    def reject(value):
        raise Invalid(f"Non-finite JSON value: {value}")
    return json.loads(path.read_text(encoding="utf-8"), parse_constant=reject)

def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
        separators=(",", ":"), allow_nan=False).encode()).hexdigest()

def file_sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024*1024), b""):
            h.update(block)
    return h.hexdigest()

def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)+"\n", encoding="utf-8")
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)

def need(condition, message):
    if not condition:
        raise Invalid(message)

def ident(value):
    return isinstance(value,str) and re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,79}",value)

def safe_url(value):
    u = urlsplit(value)
    return u.scheme in ("http","https") and bool(u.hostname) and not u.username and not u.password and not u.fragment

def validate(cfg):
    need(isinstance(cfg,dict) and cfg.get("schema_version")==1,"Unsupported schema_version")
    need(ident(cfg.get("project_id")),"Invalid project_id")
    ref=cfg["reference"]; wp=cfg["wordpress"]; scope=cfg["scope"]
    need(safe_url(ref["base_url"]) and safe_url(wp["dev_url"]),"URLs must be HTTP(S) without embedded credentials")
    need(ref["base_url"].rstrip("/") != wp["dev_url"].rstrip("/"),"Reference and development URL must differ")
    need(ident(wp["theme_slug"]),"Invalid theme slug")
    need(ref.get("allowed_origins"),"Missing explicit reference allowlist")
    for origin in ref["allowed_origins"]:
        u=urlsplit(origin)
        need(safe_url(origin) and u.path in ("","/") and not u.query,"Allowlist entries must be origins")
    need(scope["pages"] and scope["viewports"],"Empty scope is forbidden")
    for group in (scope["pages"],scope["viewports"]):
        ids=[x["id"] for x in group]
        need(all(ident(x) for x in ids) and len(ids)==len(set(ids)),"Invalid or duplicate IDs")
    for page in scope["pages"]:
        for key in ("reference_path","target_path"):
            value=page[key]
            need(isinstance(value,str) and value.startswith("/") and not value.startswith("//"),"Page paths must be relative absolute paths")
        for key in ("states","regions"):
            values=page[key]
            need(values and all(ident(x) for x in values) and len(values)==len(set(values)),"Invalid or duplicate states/regions")
        need("full" in page["regions"],"Every page needs a full-page comparison")
    for view in scope["viewports"]:
        for k in ("width","height"):
            need(type(view[k]) is int and 1 <= view[k] <= 10000,"Invalid viewport size")
        dpr=view["device_scale_factor"]
        need(type(dpr) in (int,float) and math.isfinite(dpr) and 0 < dpr <= 4,"Invalid DPR")
    quality=cfg["quality"]
    need(quality["pixel_mode"]=="raw_rgba_equal","Starter gate only supports strict raw RGBA equality")
    need(quality["allow_skips"] is False,"Skipped cases are not allowed")
    required=quality["required_checks"]
    need(required and all(ident(x) for x in required) and len(required)==len(set(required)),"Invalid required checks")
    for key in ("reference_capture","asset_reuse"):
        need(type(cfg["authorization"][key]) is bool,"Authorization flags must be boolean")
    for key in ("max_rounds","max_stagnant_rounds","max_total_minutes","max_total_tokens"):
        need(type(cfg["loop"][key]) is int and cfg["loop"][key]>0,"Loop budgets must be positive integers")
    need(cfg["release"]["database_sync"] is False and cfg["release"]["orders_mutation"] is False,"DB sync and order mutations are forbidden")
    need(cfg["release"]["production_mode"] in ("disabled","approval"),"Starter does not support unattended production release")
    return cfg

def expected_visuals(cfg):
    return {f"{p['id']}:{v['id']}:{s}:{r}"
        for p in cfg["scope"]["pages"] for v in cfg["scope"]["viewports"]
        for s in p["states"] for r in p["regions"]}

def tree_hashes(root: Path):
    need(not root.is_symlink(),"Baseline root cannot be a symlink")
    root=root.resolve()
    need(root.is_dir(),"Missing baseline directory")
    found={}
    for path in sorted(root.rglob("*")):
        need(not path.is_symlink(),f"Symlink rejected: {path.name}")
        if path.is_file():
            found[path.relative_to(root).as_posix()]=file_sha(path)
        elif not path.is_dir():
            raise Invalid("Special files are forbidden")
    need(bool(found),"Empty baseline cannot be sealed")
    return found

def seal(root: Path, output: Path):
    need(not output.exists(),"Lock already exists; baseline changes require a separate approval process")
    need(not output.resolve().is_relative_to(root.resolve()),"Store the lock outside the baseline directory")
    hashes=tree_hashes(root)
    data={"schema_version":1,"root":str(root.resolve()),"files":hashes,"baseline_sha256":digest(hashes)}
    write_json(output,data)
    return data

def verify(lock_path: Path, root: Path | None=None):
    data=read_json(lock_path)
    need(digest(data["files"])==data["baseline_sha256"],"Lock contents are inconsistent")
    hashes=tree_hashes(root or Path(data["root"]))
    need(hashes==data["files"],"Baseline changed (modified, added or missing files)")
    return data["baseline_sha256"]

def gate(cfg, report, candidate_id, baseline_sha, policy_sha):
    validate(cfg)
    need(cfg["authorization"]["reference_capture"] and cfg["authorization"]["asset_reuse"],"Authorization/approved asset plan not confirmed")
    need(policy_sha==digest(cfg),"Trusted policy hash differs from configuration")
    for key,expected in (("candidate_id",candidate_id),("baseline_sha256",baseline_sha),("policy_sha256",policy_sha)):
        need(isinstance(expected,str) and re.fullmatch(r"[a-f0-9]{64}",expected),f"Expected {key} must be a SHA-256 digest")
        need(report.get(key)==expected,f"Report does not match current {key}")
    need(report.get("schema_version")==1 and report.get("runner_status")=="complete","Incomplete/invalid report")
    need(report.get("pixel_mode")=="raw_rgba_equal","Wrong pixel comparison mode")
    for key in ("missing_assets","missing_fonts","skipped","blocked"):
        need(type(report.get(key)) is int and report[key]==0,f"{key} must be explicitly zero")
    rows=report.get("visuals")
    need(isinstance(rows,list),"Missing visuals")
    ids=[row["id"] for row in rows]
    need(len(ids)==len(set(ids)) and set(ids)==expected_visuals(cfg),"Visual scope missing, duplicated or changed")
    for row in rows:
        need(row.get("status")=="pass",f"Visual failed: {row['id']}")
        need(type(row.get("different_pixels")) is int and row["different_pixels"]==0,"Pixel difference is not zero")
        need(type(row.get("total_pixels")) is int and row["total_pixels"]>0,"Missing pixel count")
        need(row.get("same_dimensions") is True,"Screenshot dimensions differ")
    checks=report.get("checks")
    need(isinstance(checks,list),"Missing functional/runtime checks")
    ids=[x["id"] for x in checks]
    need(len(ids)==len(set(ids)),"Duplicated check IDs")
    indexed={x["id"]:x for x in checks}
    need(set(cfg["quality"]["required_checks"]).issubset(indexed),"Required checks missing")
    need(all(x.get("status")=="pass" for x in checks),"A functional/runtime check failed or was skipped")
    return {"gate":"pass","candidate_id":candidate_id,"visual_cases":len(rows),"checks":len(checks)}

def package_theme(theme: Path, output: Path):
    need(not theme.is_symlink(),"Theme directory cannot be a symlink")
    theme=theme.resolve()
    need(theme.is_dir() and ident(theme.name),"Invalid theme directory")
    need((theme/"style.css").is_file(),"Theme requires style.css")
    need((theme/"index.php").is_file() or (theme/"templates/index.html").is_file(),"Theme needs index.php or templates/index.html")
    need(not output.resolve().is_relative_to(theme),"Output must be outside theme directory")
    need(not output.exists(),"Refusing to replace an existing release artifact")
    forbidden={"node_modules","uploads",".git",".secrets"}
    allowed={".php",".css",".js",".mjs",".json",".html",".htm",".svg",".png",".jpg",".jpeg",".webp",".gif",".avif",".ico",".woff",".woff2",".ttf",".otf",".txt",".md"}
    files=[]
    for p in sorted(theme.rglob("*")):
        need(not p.is_symlink(),"Symlink rejected in theme")
        rel=p.relative_to(theme)
        need(not any(x in forbidden or x.startswith(".") for x in rel.parts),"Forbidden hidden/build/data directory")
        if p.is_dir(): continue
        need(p.is_file(),"Special file rejected")
        need(p.suffix.lower() in allowed and p.name!="wp-config.php","Disallowed file type/config in theme package")
        files.append(p)
    output.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(output,"x",compression=zipfile.ZIP_DEFLATED) as z:
        for p in files:
            info=zipfile.ZipInfo((Path(theme.name)/p.relative_to(theme)).as_posix(),date_time=(2020,1,1,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=0o100644 << 16
            z.writestr(info,p.read_bytes())
    return {"artifact":str(output),"candidate_id":file_sha(output),"file_count":len(files),"note":"Packaging is not a security scan or deployment approval"}

def init_site(output: Path, reference: Path, project_id: str):
    need(not output.exists(), "Refusing to replace an existing site project")
    ref=reference.resolve(); need(ref.is_dir(), "Missing reference bundle")
    manifest=ref/"manifest.json"; need(manifest.is_file(), "Reference bundle manifest is required")
    data=read_json(manifest); need(data.get("status")=="complete", "Reference bundle is not complete")
    summary={"path":str(ref),"manifest_sha256":file_sha(manifest),"status":data["status"]}
    (output/"theme").mkdir(parents=True); (output/"reference").mkdir(); (output/"reports").mkdir()
    write_json(output/"project.json", {"schema":1,"project_id":project_id,"environment":"staging","production":False,"reference_bundle":summary,"theme_slug":"replica-woocommerce"})
    write_json(output/"reference"/"bundle.json", summary)
    (output/"README.md").write_text("# Replica staging site project\n\nGenerated from a validated Downloader bundle. Only metadata is stored in reference; raw/HAR/network data is never copied.\n",encoding="utf-8")
    return summary

def run_readonly(args):
    try:
        cp=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=15,check=False)
        return cp.returncode==0
    except (OSError,subprocess.TimeoutExpired):
        return False

def doctor(cfg,auth=False):
    names=("git","gh","node","php","wp","codex","agy")
    result={"tools":{n:bool(shutil.which(n)) for n in names},"notes":["No passwords/tokens printed","Does not prove SSH deploy capability, permission policy, browser stability or end-to-end readiness"]}
    if auth and shutil.which("gh"):
        result["github_auth_ok"]=run_readonly(["gh","auth","status"])
    if shutil.which("wp") and Path(cfg["wordpress"]["local_path"]).is_dir():
        prefix=["wp","--path="+cfg["wordpress"]["local_path"],"--skip-themes"]
        result["wp_installed"]=run_readonly(prefix+["core","is-installed"])
        result["woocommerce_active"]=run_readonly(prefix+["plugin","is-active","woocommerce"])
    return result

def main():
    p=argparse.ArgumentParser(description=__doc__)
    sub=p.add_subparsers(dest="command",required=True)
    for name in ("validate","doctor","init"):
        s=sub.add_parser(name);s.add_argument("--project",type=Path,required=True)
        if name=="doctor":s.add_argument("--auth",action="store_true")
        if name=="init":s.add_argument("--runs",type=Path,default=Path(".replica/runs"))
    s=sub.add_parser("status");s.add_argument("--state",type=Path,required=True)
    s=sub.add_parser("seal");s.add_argument("--directory",type=Path,required=True);s.add_argument("--output",type=Path,required=True)
    s=sub.add_parser("verify");s.add_argument("--lock",type=Path,required=True);s.add_argument("--directory",type=Path)
    s=sub.add_parser("gate")
    for arg in ("project","report"):s.add_argument("--"+arg,type=Path,required=True)
    for arg in ("candidate-id","baseline-sha","policy-sha"):s.add_argument("--"+arg,required=True)
    s=sub.add_parser("package-theme");s.add_argument("--theme-dir",type=Path,required=True);s.add_argument("--output",type=Path,required=True)
    s=sub.add_parser("init-site");s.add_argument("--output",type=Path,required=True);s.add_argument("--reference-bundle",type=Path,required=True);s.add_argument("--project-id",required=True)
    args=p.parse_args()
    try:
        if args.command=="init-site":
            result=init_site(args.output,args.reference_bundle,args.project_id)
        elif args.command in ("validate","doctor","init"):
            cfg=validate(read_json(args.project))
            if args.command=="validate":
                result={"valid":True,"policy_sha256":digest(cfg),"visual_cases":len(expected_visuals(cfg))}
            elif args.command=="doctor":result=doctor(cfg,args.auth)
            else:
                rid=uuid.uuid4().hex
                result={"run_id":rid,"project_id":cfg["project_id"],"phase":"PREFLIGHT","round":0,"policy_sha256":digest(cfg),"created_at":datetime.now(timezone.utc).isoformat(),"note":"Checkpoint only; no agent or scheduler has been started"}
                path=args.runs/rid/"state.json";write_json(path,result);result["state_path"]=str(path)
        elif args.command=="status":result=read_json(args.state)
        elif args.command=="seal":result=seal(args.directory,args.output)
        elif args.command=="verify":result={"verified":True,"baseline_sha256":verify(args.lock,args.directory)}
        elif args.command=="gate":result=gate(read_json(args.project),read_json(args.report),args.candidate_id,args.baseline_sha,args.policy_sha)
        else:result=package_theme(args.theme_dir,args.output)
        print(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False));return 0
    except (Invalid,KeyError,TypeError,ValueError,OSError) as e:
        print(json.dumps({"status":"blocked","error":str(e)},ensure_ascii=False),file=sys.stderr);return 2
if __name__=="__main__":
    sys.exit(main())
