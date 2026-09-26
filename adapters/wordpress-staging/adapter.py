#!/usr/bin/env python3
"""Safe local/SSH WP-CLI staging adapter for the Replica Factory pilot.

Every mutating command performs the same environment proof before invoking WP-CLI.
The adapter never accepts production credentials, database resets, uploads, or orders
outside the replica fixture marker.
"""
from __future__ import annotations
import argparse, hashlib, json, os, shlex, subprocess, sys, tempfile, zipfile
from pathlib import Path
from urllib.request import Request, urlopen

MARKER = "replica-fixture"
ROOT = Path(__file__).resolve().parents[2]

class Blocked(RuntimeError): pass
class AdapterError(RuntimeError): pass

def load(path):
    data=json.loads(Path(path).read_text(encoding="utf-8"))
    if data.get("environment") != "staging" or data.get("production") is not False:
        raise Blocked("configuration must explicitly set environment=staging and production=false")
    if data.get("transport") not in ("local", "ssh"):
        raise Blocked("transport must be local or ssh")
    if not data.get("site_url") or not data.get("wp_path"):
        raise Blocked("site_url and wp_path are required")
    if data["transport"] == "ssh" and not data.get("ssh_host"):
        raise Blocked("ssh_host is required for ssh transport")
    return data

def cmd(cfg, args, write=False):
    base=["wp", *args, "--path="+cfg["wp_path"], "--skip-plugins=", "--skip-themes="]
    if cfg["transport"] == "ssh":
        remote=" ".join(shlex.quote(x) for x in base)
        base=["ssh", cfg["ssh_user"]+"@"+cfg["ssh_host"], remote]
    env=os.environ.copy(); env["WP_CLI_DISABLE_AUTO_CHECK_UPDATE"]="1"
    p=subprocess.run(base, text=True, capture_output=True, env=env)
    if p.returncode: raise AdapterError((p.stderr or p.stdout).strip())
    return p.stdout.strip()

def proof(cfg):
    # The marker is stored in the target wp-config/environment and is mandatory.
    marker=cmd(cfg,["option","get","replica_staging_marker","--format=json"])
    if marker.strip('"\n ') != MARKER: raise Blocked("staging marker is missing or incorrect")
    env=cmd(cfg,["eval","echo wp_get_environment_type();"])
    if env.strip() == "production": raise Blocked("WordPress environment is production")
    integ=cmd(cfg,["option","get","active_plugins","--format=json"])
    if any(x in integ.lower() for x in ("stripe","paypal","webhook","crm","erp")):
        raise Blocked("external payment/webhook integration detected")

def ref_bundle(path):
    root=Path(path); required=["manifest.json","routes.json","resources.json"]
    if not root.is_dir() or any(not (root/x).is_file() for x in required): raise AdapterError("invalid downloader bundle")
    m=json.loads((root/"manifest.json").read_text(encoding="utf-8"))
    if m.get("status") != "complete": raise AdapterError("reference bundle is not complete")
    for name in ("resources.json", "routes.json"):
        json.loads((root/name).read_text(encoding="utf-8"))
    # Verify only declared local resources; raw/HAR are intentionally excluded.
    res=json.loads((root/"resources.json").read_text(encoding="utf-8")).get("resources",[])
    for item in res:
        rel=item.get("local_path") or item.get("raw_path")
        if rel and ("raw" in Path(rel).parts or "har" in rel.lower()): continue
        if rel and not (root/rel).is_file(): raise AdapterError("missing bundle resource: "+rel)
    return hashlib.sha256((root/"manifest.json").read_bytes()).hexdigest()

def json_out(value): print(json.dumps(value, ensure_ascii=False, indent=2))

def seed(cfg):
    proof(cfg)
    cats=["Replica Home","Replica Stationery"]
    for cat in cats:
        slug=cat.lower().replace(" ","-")
        if cmd(cfg,["term","list","product_cat","--slug="+slug,"--format=count"]).strip()=="0":
            cmd(cfg,["term","create","product_cat",cat,"--slug="+slug,"--porcelain"],write=True)
    for i in range(1,5):
        sku=f"replica-fixture-{i:03d}"
        exists=cmd(cfg,["wc","product","list","--sku="+sku,"--format=count"])
        if exists.strip() == "0":
            cmd(cfg,["wc","product","create","--name=Replica Fixture %03d"%i,"--type=simple","--regular_price=%d"%(10+i),"--sku="+sku,"--status=publish","--categories=Replica Home"],write=True)
    json_out({"status":"seeded","skus":[f"replica-fixture-{i:03d}" for i in range(1,5)],"categories":cats})

def version(cfg):
    proof(cfg); theme=cmd(cfg,["theme","list","--status=active","--field=name"]); ver=cmd(cfg,["eval","$t=wp_get_theme(); echo $t->get('Version');"])
    json_out({"active_theme":theme,"theme_version":ver,"wordpress":cmd(cfg,["core","version"]),"woocommerce":cmd(cfg,["plugin","get","woocommerce","--field=version"])})

def health(cfg):
    proof(cfg); paths=["/","/product-category/replica-home/","/product/replica-fixture-001/","/cart/","/checkout/"]; result=[]
    for path in paths:
        with urlopen(Request(cfg["site_url"].rstrip("/")+path),timeout=20) as r: result.append({"path":path,"status":r.status})
    data={"status":"complete","pages":result,"versions":json.loads(version_capture(cfg))}; Path("reports").mkdir(exist_ok=True); Path("reports/staging-health.json").write_text(json.dumps(data,indent=2),encoding="utf-8"); json_out(data)

def version_capture(cfg):
    # Avoid recursive JSON printing from version().
    return json.dumps({"active_theme":cmd(cfg,["theme","list","--status=active","--field=name"]),"theme_version":cmd(cfg,["eval","$t=wp_get_theme(); echo $t->get('Version');"]),"wordpress":cmd(cfg,["core","version"]),"woocommerce":cmd(cfg,["plugin","get","woocommerce","--field=version"])})

def cleanup(cfg):
    proof(cfg)
    for i in range(1,5):
        sku=f"replica-fixture-{i:03d}"; ids=cmd(cfg,["wc","product","list","--sku="+sku,"--format=ids"]).split()
        for pid in ids: cmd(cfg,["wc","product","delete",pid,"--force"] ,write=True)
    ids=cmd(cfg,["post","list","--post_type=shop_order","--meta_key=_replica_fixture_marker","--meta_value="+MARKER,"--format=ids"]).split()
    for oid in ids: cmd(cfg,["wc","order","delete",oid,"--force"],write=True)
    json_out({"status":"cleaned","marker":MARKER})

def deploy(cfg, artifact):
    proof(cfg); z=Path(artifact)
    if not z.is_file() or z.suffix!='.zip': raise AdapterError('theme artifact zip is required')
    cmd(cfg,["theme","install",str(z),"--force"],write=True); cmd(cfg,["theme","activate","replica-woocommerce"],write=True); return version_capture(cfg)
def rollback(cfg, artifact):
    proof(cfg); return deploy(cfg,artifact)
def main():
    p=argparse.ArgumentParser(); p.add_argument("--config",required=True); p.add_argument("command",choices="doctor seed version health deploy rollback cleanup".split()); p.add_argument("--artifact"); a=p.parse_args(); cfg=load(a.config)
    try:
        if a.command=="doctor": proof(cfg); json_out({"status":"ready"})
        elif a.command=="seed": seed(cfg)
        elif a.command=="version": version(cfg)
        elif a.command=="health": health(cfg)
        elif a.command=="deploy": json_out({"status":"deployed","versions":json.loads(deploy(cfg,a.artifact or ""))})
        elif a.command=="rollback": json_out({"status":"rolled_back","versions":json.loads(rollback(cfg,a.artifact or ""))})
        else: cleanup(cfg)
    except (Blocked,AdapterError) as e: print("BLOCKED: "+str(e),file=sys.stderr); return 2
    return 0
if __name__=="__main__": sys.exit(main())
