import fs from 'node:fs';
import http from 'node:http';
import { readJSON, safeFile, sha, put, json } from './core.mjs';
import { verify } from './verify.mjs';
import { scopedProxy, launch, restrictContext } from './runtime.mjs';

const CSP="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-scripts allow-same-origin";
export async function serve(root,port=0) {
  const validation=verify(root);
  if(validation.status!=='complete')throw new Error('refusing invalid download: '+validation.errors.join('; '));
  const manifest=readJSON(root,'manifest.json'),mapping=readJSON(root,'site/route-map.json');
  const server=http.createServer((req,res)=>{
    res.setHeader('Content-Security-Policy',CSP);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    if(req.headers.host!==`127.0.0.1:${server.address().port}`){res.writeHead(403).end();return;}
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'}).end();return;}
    try {
      if(!req.url.startsWith('/')||req.url.startsWith('//'))throw new Error('invalid path');
      let decoded=req.url.split('?')[0];
      for(let i=0;i<3;i++)decoded=decodeURIComponent(decoded);
      if(decoded.includes('\\')||decoded.includes('\0')||decoded.split('/').some(x=>x==='..'||x==='.')||decoded.includes(':'))throw new Error('path traversal');
      const key=new URL(req.url,'http://127.0.0.1').pathname+new URL(req.url,'http://127.0.0.1').search;
      if(key==='/'&&!mapping.aliases[key]){res.writeHead(302,{Location:mapping.entry}).end();return;}
      const target=Object.hasOwn(mapping.aliases,key)?mapping.aliases[key]:null;
      if(!target){res.writeHead(404).end('Not captured; no upstream proxy');return;}
      const body=fs.readFileSync(safeFile(root,'site/'+target.path));
      if(sha(body)!==target.sha256)throw new Error('artifact changed after verification');
      res.writeHead(200,{'Content-Type':target.mime,'Content-Length':body.length});res.end(req.method==='HEAD'?undefined:body);
    } catch {res.writeHead(400).end('Unsafe or changed artifact');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const close=()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
  if([...manifest.policy.pageOrigins,...manifest.policy.assetOrigins].includes(origin)){await close();throw new Error('preview must use a different origin from capture');}
  return {origin,entry:mapping.entry,close};
}
export function previewPolicy(root,origin) {
  const map=readJSON(root,'site/route-map.json');
  return {pageOrigins:[origin],assetOrigins:[origin],publicGetFixtures:Object.entries(map.aliases).filter(([,x])=>x.mime.includes('json')).map(([key])=>origin+key)};
}
export async function openIsolated(root,server,{headless=false}={}) {
  const failures=[];
  const proxy=await scopedProxy([server.origin],failures),browser=await launch(proxy,headless);
  const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,viewport:{width:1440,height:1000},locale:'en-US',timezoneId:'UTC'});
  await restrictContext(context,previewPolicy(root,server.origin),failures);
  const page=await context.newPage();await page.goto(server.origin+server.entry);
  return {browser,context,page,failures,close:async()=>{await context.close();await browser.close();await proxy.close();}};
}

async function assertion(page,step) {
  const loc=page.locator(step.selector);
  const actual={selector:step.selector};
  if('count' in step)actual.count=await loc.count();
  if('visible' in step)actual.visible=await loc.isVisible();
  if('text' in step)actual.text=await loc.innerText();
  if('ids' in step)actual.ids=await loc.evaluateAll(els=>els.map(e=>e.dataset.productId));
  if('columns' in step)actual.columns=await loc.evaluateAll(els=>new Set(els.map(e=>Math.round(e.getBoundingClientRect().left))).size);
  if('attribute' in step)actual.value=await loc.getAttribute(step.attribute);
  if('backgroundLoaded' in step)actual.backgroundLoaded=await loc.evaluate(async el=>{
    const bg=getComputedStyle(el).backgroundImage;
    if(bg==='none')return false;
    const match=bg.match(/^url\(["']?(.*?)["']?\)$/);if(!match)return false;
    const image=new Image();image.src=match[1];try{await image.decode();return image.naturalWidth>0;}catch{return false;}
  });
  const fields=['count','visible','text','ids','columns','value','backgroundLoaded'].filter(k=>k in step);
  if(!fields.length)throw new Error('assertion has no expected values');
  const passed=fields.every(k=>JSON.stringify(actual[k])===JSON.stringify(step[k]));
  return {expected:step,actual,passed};
}

export async function verifyBrowser(root,checks=[]) {
  const structural=verify(root);
  if(structural.status!=='complete')return structural;
  if(!Array.isArray(checks))throw new Error('checks must be an array');
  const manifest=readJSON(root,'manifest.json'),routes=readJSON(root,'routes.json').routes.filter(r=>r.status==='visited');
  const result={schema:1,run_id:manifest.run_id,core_sha256:manifest.core_sha256,status:'failed',isolation:'fresh Chromium; exact preview-origin proxy; source/CDN/other origins denied; no replay proxy',pages:[],checks:[],requests:[],failures:[],started_at:new Date().toISOString()};
  let server,proxy,browser,context;
  try {
    server=await serve(root);result.origin=server.origin;
    proxy=await scopedProxy([server.origin],result.failures);browser=await launch(proxy);
    context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,locale:'en-US',timezoneId:'UTC',deviceScaleFactor:1});context.setDefaultTimeout(8000);
    await restrictContext(context,previewPolicy(root,server.origin),result.failures);
    context.on('request',req=>result.requests.push({url:req.url(),method:req.method(),type:req.resourceType()}));
    context.on('requestfailed',req=>result.failures.push({reason:'request_failed',url:req.url()}));
    context.on('response',response=>{if(response.status()>=400)result.failures.push({reason:'http_'+response.status(),url:response.url()});});
    for(const viewport of manifest.policy.viewports) for(const route of routes) {
      const page=await context.newPage();await page.setViewportSize(viewport);
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      const u=new URL(route.url),entry={path:u.pathname+u.search,viewport,status:'failed',observations:null};
      try {
        const response=await page.goto(server.origin+entry.path,{waitUntil:'networkidle'});
        await page.waitForFunction(()=>document.fonts.status==='loaded');
        entry.observations=await page.evaluate(()=>({title:document.title,images:[...document.images].map(i=>({src:i.currentSrc,decoded:i.complete&&i.naturalWidth>0})),fonts:[...document.fonts].map(f=>({family:f.family,status:f.status})),viewport:{width:innerWidth,height:innerHeight},h1:[...document.querySelectorAll('h1')].map(e=>e.textContent)}));
        if(response.status()!==200||entry.observations.images.some(i=>!i.decoded)||entry.observations.fonts.some(f=>f.status==='error')||errors.length)throw new Error('page render/decode/JavaScript check failed');
        entry.status='passed';
        const screenshot=`reports/preview-${sha(entry.path+JSON.stringify(viewport)).slice(0,20)}.png`;
        await page.screenshot({path:safeFile(root,screenshot),fullPage:true});entry.screenshot=screenshot;entry.screenshot_sha256=sha(fs.readFileSync(safeFile(root,screenshot)));
      }catch(e){entry.error=e.message;result.failures.push({reason:'preview_page',path:entry.path,detail:e.message});}
      entry.errors=errors;result.pages.push(entry);await page.close();
    }
    for(const spec of checks) {
      const record={id:spec.id,path:spec.path,viewport:spec.viewport,status:'failed',assertions:[]};
      const page=await context.newPage();await page.setViewportSize(spec.viewport||manifest.policy.viewports[0]);
      page.on('pageerror',e=>result.failures.push({reason:'check_page_error',id:spec.id,detail:e.message}));
      try {
        if(!spec.id||!spec.path?.startsWith('/')||!Array.isArray(spec.steps))throw new Error('malformed check');
        await page.goto(server.origin+spec.path,{waitUntil:'networkidle'});
        for(const step of spec.steps) {
          if(step.type==='assert') {
            const evidence=await assertion(page,step);record.assertions.push(evidence);if(!evidence.passed)throw new Error('DOM assertion failed: '+JSON.stringify(evidence));
          } else if(['click','hover'].includes(step.type)) {
            await page.locator(step.selector)[step.type]();await page.waitForLoadState('networkidle');
          } else if(step.type==='scroll') {
            await page.locator(step.selector).scrollIntoViewIfNeeded();await page.waitForTimeout(250);await page.waitForLoadState('networkidle');
          } else if(step.type==='wait')await page.locator(step.selector).waitFor();
          else throw new Error('unsupported check step');
        }
        if(!record.assertions.length)throw new Error('empty assertions');record.status='passed';
      }catch(error){record.error=error.message;result.failures.push({reason:'preview_check',id:spec.id,detail:error.message});}
      result.checks.push(record);await page.close();
    }
  }catch(error){result.failures.push({reason:'preview_runtime',detail:error.message});}
  finally {if(context)await context.close();if(browser)await browser.close();if(proxy)await proxy.close();if(server)await server.close();}
  result.status=result.failures.length?'failed':'complete';result.finished_at=new Date().toISOString();
  put(root,'reports/preview.json',json(result));
  return result;
}
