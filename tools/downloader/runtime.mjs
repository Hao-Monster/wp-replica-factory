import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, normalizeUrl } from './core.mjs';
import { guardedProxy, createNetworkGuard, sanitizeUrl } from './network-guard.mjs';

// Project-owned browser installation only; never select the user's daily browser.
const localBrowsers=path.join(ROOT,'.replica/browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(localBrowsers)) process.env.PLAYWRIGHT_BROWSERS_PATH=localBrowsers;
const require=createRequire(import.meta.url);
export const { chromium }=require('playwright');
export const playwrightVersion=require('playwright/package.json').version;

export async function scopedProxy(origins, failures=[]) {
  return guardedProxy({mode:'owned-fixture',pageOrigins:origins,assetOrigins:origins,publicGetFixtures:[],sensitiveQueryKeys:[]},failures);
}
export async function launch(proxy,headless=true) {
  return chromium.launch({headless,proxy:{server:proxy.url,bypass:'<-loopback>'},args:['--proxy-bypass-list=<-loopback>','--disable-background-networking','--disable-component-update']});
}
export async function restrictContext(context,policy,failures,options={}) {
  const events=options.events||[],observe=options.observe||(()=>({}));
  const guard=options.guard||createNetworkGuard(policy,failures,options.network||{});
  await context.route('**/*', async route=>{
    const req=route.request();let reason='',u,verdict=null;
    try {u=new URL(normalizeUrl(req.url()));} catch {reason='invalid_url';}
    const firstSeenPage=observe()?.route||req.frame().url()||'';
    if(!reason&&policy.mode==='authorized-public') {
      let redirects=0,previous=req.redirectedFrom();
      while(previous){redirects++;previous=previous.redirectedFrom();}
      if(redirects>policy.maxRedirects) {
        reason='redirect_limit';
        failures.push({reason,url:sanitizeUrl(u.href,policy.sensitiveQueryKeys),first_seen_page:firstSeenPage});
      } else if(req.isNavigationRequest()&&req.frame().parentFrame()) {
        reason='iframe_unsupported';
        failures.push({reason,url:sanitizeUrl(u.href,policy.sensitiveQueryKeys),first_seen_page:firstSeenPage});
      } else {
        verdict=await guard.inspect(u.href,{kind:req.isNavigationRequest()?'page':'asset',method:req.method(),resourceType:req.resourceType(),firstSeenPage});
        if(!verdict.allowed)reason=verdict.reason;
      }
    } else if(!reason) {
      const allowed=req.isNavigationRequest()?policy.pageOrigins:policy.assetOrigins;
      if(req.method()!=='GET') reason='method_blocked';
      else if(!allowed.includes(u.origin)) reason='origin_blocked';
      else if(['fetch','xhr'].includes(req.resourceType())&&!policy.publicGetFixtures.includes(u.href)) reason='unapproved_get_fixture';
      else if(req.isNavigationRequest()&&req.frame().parentFrame()) reason='iframe_unsupported';
      if(reason)failures.push({reason,url:u.href,method:req.method()});
    }
    events.push({url:sanitizeUrl(u?.href||req.url(),policy.sensitiveQueryKeys||[]),method:req.method(),resource_type:req.resourceType(),first_seen_page:firstSeenPage,action:reason?'blocked':verdict?.metadataOnly?'metadata_only':'allowed',reason:reason||null});
    if(reason) await route.abort('blockedbyclient');
    else await route.continue();
  });
  await context.routeWebSocket('**/*',ws=>{failures.push({reason:'websocket_blocked',url:sanitizeUrl(ws.url(),policy.sensitiveQueryKeys||[])});ws.close();});
  return guard;
}
