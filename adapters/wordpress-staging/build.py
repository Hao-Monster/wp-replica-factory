#!/usr/bin/env python3
"""Validate a Downloader bundle and package the generic WooCommerce theme."""
import argparse, hashlib, json, shutil, subprocess, tempfile, zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def sha(p):
 h=hashlib.sha256();
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
 return h.hexdigest()
def main():
 p=argparse.ArgumentParser();p.add_argument('--reference-bundle',required=True);p.add_argument('--out',default='.replica/artifacts');p.add_argument('--wordpress-version',default='6.8.2');p.add_argument('--woocommerce-version',default='10.1.2');a=p.parse_args()
 r=Path(a.reference_bundle);m=json.loads((r/'manifest.json').read_text());assert m.get('status')=='complete';
 for n in ('routes.json','resources.json'):
  assert (r/n).is_file();json.loads((r/n).read_text())
 ref=sha(r/'manifest.json'); run=hashlib.sha256((ref+a.wordpress_version+a.woocommerce_version).encode()).hexdigest()[:16]; dest=Path(a.out)/run;dest.mkdir(parents=True)
 z=dest/'replica-theme.zip';
 with zipfile.ZipFile(z,'w',zipfile.ZIP_DEFLATED) as out:
  for f in sorted((ROOT/'templates/woocommerce-theme').rglob('*')):
   if f.is_file(): out.write(f, 'replica-woocommerce/'+f.relative_to(ROOT/'templates/woocommerce-theme').as_posix())
 manifest={'schema':1,'theme_version':'0.1.0','git_sha':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'artifact_sha256':sha(z),'wordpress_version':a.wordpress_version,'woocommerce_version':a.woocommerce_version,'reference_bundle_sha256':ref}
 (dest/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps({'status':'built','artifact':str(z),'manifest':manifest},indent=2))
if __name__=='__main__':main()
