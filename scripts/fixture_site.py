#!/usr/bin/env python3
"""Local-only owned fixture site lifecycle and browser acceptance runner."""
from __future__ import annotations
import argparse, hashlib, json, shutil, socket, subprocess, sys, tempfile, threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT=Path(__file__).resolve().parents[1]; FIXTURE=ROOT/'tests'/'fixtures'/'owned-site'; DEFAULT_RUN=ROOT/'.replica'/'owned-site'
VIEWPORTS={'desktop':{'width':1440,'height':1000,'dpr':1,'locale':'en-US','timezone':'UTC'},'mobile':{'width':390,'height':844,'dpr':1,'locale':'en-US','timezone':'UTC'}}

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def files(): return sorted(p for p in FIXTURE.rglob('*') if p.is_file() and p.name not in {'RESOURCE_MANIFEST.json','STATE_MATRIX.md','README.md'})
def manifest():
    return {'fixture_version':'1.0.0','resources':[{'path':p.relative_to(FIXTURE).as_posix(),'type':'font' if p.suffix=='.ttf' else 'image' if p.suffix in {'.svg','.png','.jpg'} else 'data' if p.suffix=='.json' else 'source','sha256':sha(p),'source':'self-authored fixture' if p.suffix=='.svg' else 'Google Fonts Inter, SIL Open Font License 1.1' if p.suffix=='.ttf' else 'repository fixture','pages':['/grid.html','/lazy.html','/filters.html']} for p in files()]}
def seed(run):
    run.mkdir(parents=True,exist_ok=True); data=json.loads((FIXTURE/'data/products.json').read_text(encoding='utf-8')); ids=[p['id'] for p in data['products']]
    if len(ids)!=len(set(ids)): raise SystemExit('seed rejected duplicate product IDs')
    (run/'products.json').write_text(json.dumps(data,sort_keys=True,indent=2)+'\n',encoding='utf-8'); (run/'resource-manifest.json').write_text(json.dumps(manifest(),sort_keys=True,indent=2)+'\n',encoding='utf-8'); print(json.dumps({'status':'seeded','run_dir':str(run),'product_ids':ids},ensure_ascii=False));
def reset(run):
    if run.exists(): shutil.rmtree(run)
    seed(run); print(json.dumps({'status':'reset','browser_storage':'new context required; fixture has no persistent storage'}))
def handler():
    fixture=str(FIXTURE)
    class H(SimpleHTTPRequestHandler):
        def __init__(self,*a,**kw): super().__init__(*a,directory=fixture,**kw)
        def do_GET(self):
            if self.path=='/data/products.json': self.path='/data/products.json'
            if '..' in urlparse(self.path).path.split('/'):
                self.send_error(400,'path traversal rejected'); return
            super().do_GET()
        def log_message(self,*args): pass
    return H
def serve(port):
    httpd=ThreadingHTTPServer(('127.0.0.1',port),handler()); print(f'http://127.0.0.1:{httpd.server_port}',flush=True); httpd.serve_forever()
def health(url):
    import urllib.request
    checks=[]
    for path in ['/grid.html','/lazy.html','/filters.html','/data/products.json','/assets/FixtureSans-Regular.ttf']:
        try:
            with urllib.request.urlopen(url.rstrip('/')+path,timeout=5) as r: checks.append({'path':path,'status':r.status})
        except Exception as e: print(f'health failed: {path}: {e}',file=sys.stderr); return 1
    print(json.dumps({'status':'pass','checks':checks,'resource_manifest_sha256':sha(FIXTURE/'data/products.json')},ensure_ascii=False)); return 0
def browser_test():
    from playwright.sync_api import sync_playwright
    import urllib.request
    httpd=ThreadingHTTPServer(('127.0.0.1',0),handler()); t=threading.Thread(target=httpd.serve_forever,daemon=True); t.start(); base=f'http://127.0.0.1:{httpd.server_port}'
    summaries=[]
    try:
      with sync_playwright() as p:
       browser=p.chromium.launch(headless=True)
       for run in range(2):
        context=browser.new_context(locale='en-US',timezone_id='UTC',device_scale_factor=1); result={'run':run+1,'viewports':{}}
        for name,v in VIEWPORTS.items():
         page=context.new_page(); page.set_viewport_size({'width':v['width'],'height':v['height']}); requests=[]; page.on('request',lambda req: requests.append(req.url))
         page.goto(base+'/grid.html'); cards=page.locator('[data-testid=product-grid] .product-card'); assert cards.count()==4; assert [cards.nth(i).get_attribute('data-product-id') for i in range(4)]==['owned-001','owned-002','owned-003','owned-004']; assert cards.nth(0).locator('img').evaluate('(img)=>img.complete && img.naturalWidth>0'); assert page.evaluate('document.fonts.check("16px FixtureSans")')
         page.goto(base+'/lazy.html'); panel=page.locator('#lazy-panel'); assert panel.get_attribute('data-loaded')=='false'; page.locator('#lazy-panel').scroll_into_view_if_needed(); page.wait_for_function("document.querySelector('#lazy-panel').dataset.loaded === 'true'"); assert 'loaded' in page.locator('#lazy-status').inner_text().lower()
         page.goto(base+'/filters.html'); page.locator('.menu-toggle').click(); assert page.locator('#site-menu').is_visible(); page.locator('.menu-toggle').click(); assert page.locator('#site-menu').is_hidden(); page.locator('[data-filter=home]').click(); assert page.locator('#filter-grid .product-card').count()==2; page.locator('[data-filter=missing]').click(); assert page.locator('#filter-grid .product-card').count()==0; page.locator('[data-filter=clear]').click(); assert page.locator('#filter-grid .product-card').count()==4
         external=[u for u in requests if not u.startswith(base)]; assert not external, external
         result['viewports'][name]={'grid_count':4,'mobile_columns':2 if name=='mobile' else 4,'lazy_loaded':True,'filter_states':['home=2','missing=0','clear=4'],'external_requests':external}; page.close()
        summaries.append(result); context.close()
       browser.close()
    finally: httpd.shutdown(); httpd.server_close()
    normalized=json.dumps(summaries,sort_keys=True,separators=(',',':')); print(json.dumps({'status':'pass','runs':summaries,'state_summary_sha256':hashlib.sha256(normalized.encode()).hexdigest()},ensure_ascii=False)); return 0

def main():
 p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='cmd',required=True); s=sub.add_parser('seed'); s.add_argument('--run-dir',type=Path,default=DEFAULT_RUN); s=sub.add_parser('reset'); s.add_argument('--run-dir',type=Path,default=DEFAULT_RUN); s=sub.add_parser('serve'); s.add_argument('--port',type=int,default=0); s=sub.add_parser('health'); s.add_argument('--url',default='http://127.0.0.1:8765'); sub.add_parser('test'); a=p.parse_args();
 if a.cmd=='seed': seed(a.run_dir); return 0
 if a.cmd=='reset': reset(a.run_dir); return 0
 if a.cmd=='serve': serve(a.port); return 0
 if a.cmd=='health': return health(a.url)
 return browser_test()
if __name__=='__main__': raise SystemExit(main())
