import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { ROOT, normalizeUrl } from './core.mjs';

// Project-owned browser installation only; never select the user's daily browser.
const localBrowsers=path.join(ROOT,'.replica/browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(localBrowsers)) process.env.PLAYWRIGHT_BROWSERS_PATH=localBrowsers;
const require=createRequire(import.meta.url);
export const { chromium }=require('playwright');
export const playwrightVersion=require('playwright/package.json').version;

// Exact loopback forwarding boundary for the OWNED fixture. Every redirect must
// pass it again. This is not a public-web sandbox or DNS-rebinding claim.
export async function scopedProxy(origins, failures=[]) {
  const server=http.createServer((req,res)=>{
    let u;
    try { u=new URL(normalizeUrl(req.url)); } catch { res.writeHead(403).end(); return; }
    if (req.method!=='GET'||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!origins.includes(u.origin)) {
      failures.push({reason:'network_scope',url:u.href,method:req.method});
      res.writeHead(403).end('Blocked by owned-fixture network boundary'); return;
    }
    const headers={...req.headers,host:u.host};
    for(const key of ['authorization','cookie','proxy-authorization','proxy-connection']) delete headers[key];
    const upstream=http.request({hostname:'127.0.0.1',port:u.port,path:u.pathname+u.search,method:'GET',headers,timeout:15000},response=>{
      const clean={...response.headers}; delete clean['set-cookie'];
      res.writeHead(response.statusCode,clean); response.pipe(res);
    });
    upstream.on('timeout',()=>upstream.destroy(new Error('upstream timeout')));
    upstream.on('error',()=>{ if(!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted',()=>upstream.destroy()); upstream.end();
  });
  server.on('connect',(_req,socket)=>{socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); failures.push({reason:'connect_blocked'});});
  server.on('upgrade',(_req,socket)=>{socket.destroy(); failures.push({reason:'websocket_blocked'});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
export async function launch(proxy,headless=true) {
  return chromium.launch({headless,proxy:{server:proxy.url,bypass:'<-loopback>'},args:['--proxy-bypass-list=<-loopback>','--disable-background-networking','--disable-component-update']});
}
export async function restrictContext(context,policy,failures) {
  await context.route('**/*', async route=>{
    const req=route.request(); let reason=''; let u;
    try { u=new URL(normalizeUrl(req.url())); } catch { reason='invalid_url'; }
    if(!reason) {
      const allowed=req.isNavigationRequest()?policy.pageOrigins:policy.assetOrigins;
      if(req.method()!=='GET') reason='method_blocked';
      else if(!allowed.includes(u.origin)) reason='origin_blocked';
      else if(['fetch','xhr'].includes(req.resourceType())&&!policy.publicGetFixtures.includes(u.href)) reason='unapproved_get_fixture';
      else if(req.isNavigationRequest()&&req.frame().parentFrame()) reason='iframe_unsupported';
    }
    if(reason) { failures.push({reason,url:u?.href||'[invalid URL]',method:req.method()}); await route.abort('blockedbyclient'); }
    else await route.continue();
  });
  await context.routeWebSocket('**/*',ws=>{failures.push({reason:'websocket_blocked',url:ws.url()});ws.close();});
}
