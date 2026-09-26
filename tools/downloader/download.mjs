import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ROOT, SCHEMA, sha, json, put, safeFile, newOutput, policyFor, mapPath, normalizeUrl, resourceKind, bodyProblem, coreDigest, adapterFingerprint } from './core.mjs';
import { launch, restrictContext, playwrightVersion } from './runtime.mjs';
import { guardedProxy, sanitizeUrl } from './network-guard.mjs';
import { collectPage } from './vendor/open-design/route-crawl.mjs';
import { collectSignals } from './vendor/open-design/recon-site.mjs';
import { classify } from './vendor/open-design/asset-harvest.mjs';
import { scrollThroughPage } from './vendor/open-design/mirror-site.mjs';
import { captureResponses } from './vendor/open-design/network-capture.mjs';
import { localize } from './localize.mjs';

export async function download(input,output,options={}) {
  const policy=policyFor(input);
  if(policy.mode==='authorized-public'&&policy.har) {
    const replicaRoot=path.resolve(ROOT,'.replica'),out=path.resolve(output);
    if(!(out===replicaRoot||out.startsWith(replicaRoot+path.sep)))throw new Error('authorized-public HAR output must stay under .replica');
  }
  const root=newOutput(output);
  const run_id=crypto.randomUUID(), session_id=crypto.randomUUID(), started_at=new Date().toISOString();
  const manifest={schema:SCHEMA,run_id,session_id,started_at,engine:{name:'OpenDesign web-clone selective adapter',version:'0.1.0',upstream:'1b47e60bd46641469fcd8b69c496c4e3a548bc28',playwright:playwrightVersion,node:process.version,os:os.platform(),browser:null},policy,policy_sha256:sha(json(policy)),status:'failed',mirror_mode:'original-html-and-client-scripts',limitations:['authorized-public MVP supports HTTPS, one page origin, explicit asset origins and GET/HEAD only','no automatic interaction discovery','hash routes, iframe, Shadow DOM, Canvas and server-side business state are not generalized','responsive candidates not requested by configured viewports are reported; no automatic supplemental GET','conflicting response variants are retained but default replay selects the first and marks partial'],failures:[],har:{enabled:policy.har,session_id,sensitive:true,uploaded:false}};
  const routes=[],resources=[],captures=[],gaps=[],warnings=[],networkFailures=[],networkEvents=[];
  manifest.engine.adapter_sha256=adapterFingerprint();
  const byKey=new Map(), routeMap=new Map();
  let current={session_id},totalBytes=0,context,browser,proxy,listener,closed=false,budgetExpired=false;
  const deadline=Date.now()+policy.budgetMs;
  const remaining=()=>Math.max(1,Math.min(policy.timeoutMs,deadline-Date.now()));
  const fail=entry=>manifest.failures.push(entry);
  const save=async(entry,body)=>{
    const observation=entry.observation;delete entry.observation;
    const raw_sha256=body?sha(body):null;
    const key=JSON.stringify([entry.url,entry.method,entry.http_status,raw_sha256]);
    if(byKey.has(key)) { byKey.get(key).observations.push(observation);return; }
    if(resources.length>=policy.maxResources) {fail({reason:'resource_count_budget',url:entry.url});return;}
    totalBytes+=body?.length||0;
    if(totalBytes>policy.maxTotalBytes) {fail({reason:'total_byte_budget',url:entry.url});return;}
    const upstreamKind=classify(entry.url,entry.request_type,entry.mime);
    const record={...entry,source:'browser-response-body',captured_at:new Date().toISOString(),kind:upstreamKind==='stylesheet'?'css':upstreamKind||resourceKind(entry.request_type,entry.mime),status:body?'saved':'redirect',raw_sha256,raw_path:null,local_path:null,bytes:body?.length||0,observations:[observation],references:[]};
    if(body) {
      record.raw_path=`raw/${raw_sha256}.bin`;record.local_path=mapPath(entry.url,entry.mime,raw_sha256);
      put(root,record.raw_path,body,true);
      const problem=bodyProblem(body,entry.request_type,entry.mime,entry.http_status);
      if(problem) {record.status='failed';record.reason=problem;fail({reason:problem,url:entry.url});}
      else {put(root,record.local_path,body,true);record.local_sha256=sha(body);record.local_bytes=body.length;}
    }
    resources.push(record);byKey.set(key,record);
  };
  const queue=[];
  const discover=(url,depth,from)=>{
    if(routeMap.has(url)) {if(from&&!routeMap.get(url).from.includes(from))routeMap.get(url).from.push(from);return;}
    const entry={url,depth,from:from?[from]:[],status:policy.pageOrigins.includes(new URL(url).origin)?'pending':'excluded',reason:''};
    if(entry.status==='excluded') entry.reason='page_origin_not_allowed';
    routes.push(entry);routeMap.set(url,entry);if(entry.status==='pending')queue.push(entry);
  };
  discover(policy.url,0,'');
  let timer;
  try {
    proxy=await guardedProxy(policy,networkFailures,options.network||{});
    browser=await launch(proxy);manifest.engine.browser=browser.version();
    context=await browser.newContext({viewport:policy.viewports[0],deviceScaleFactor:1,locale:'en-US',timezoneId:'UTC',colorScheme:'light',reducedMotion:'reduce',serviceWorkers:'block',acceptDownloads:false,ignoreHTTPSErrors:options.ignoreHTTPSErrors===true,...(policy.har?{recordHar:{path:safeFile(root,'network/capture.har'),mode:'full',content:'embed'}}:{})});
    await context.clearPermissions();
    context.setDefaultTimeout(policy.timeoutMs);
    await restrictContext(context,policy,networkFailures,{guard:proxy.guard,observe:()=>current,events:networkEvents});
    listener=captureResponses(context,{maxBytes:policy.maxBytes,observe:()=>current,save,fail,shouldSave:entry=>policy.mode!=='authorized-public'||!['fetch','xhr'].includes(entry.request_type)||policy.publicGetFixtures.includes(entry.url),metadata:entry=>networkEvents.push({url:sanitizeUrl(entry.url,policy.sensitiveQueryKeys),method:entry.method,resource_type:entry.request_type,action:'metadata_only',reason:null,first_seen_page:entry.observation?.route||''})});
    context.on('requestfailed',req=>fail({reason:'request_failed',url:req.url(),detail:req.failure()?.errorText}));
    timer=setTimeout(()=>{
      budgetExpired=true;fail({reason:'total_time_budget'});
      for(const p of context.pages()) p.close().catch(()=>{});
    },Math.max(1,deadline-Date.now()));
    let attempted=0;
    while(queue.length&&attempted<policy.maxPages&&!budgetExpired&&Date.now()<deadline) {
      const route=queue.shift();
      if(route.depth>policy.maxDepth) {route.reason='max_depth';continue;}
      attempted++;
      const states=[{name:'default',actions:[]},...policy.states.filter(s=>!s.path||s.path===new URL(route.url).pathname)];
      try {
        for(const viewport of policy.viewports) for(const state of states) {
          if(Date.now()>=deadline) throw new Error('total_time_budget');
          const capture_id=sha(JSON.stringify([route.url,viewport,state.name])).slice(0,32);
          current={session_id,capture_id,route:route.url,viewport,state:state.name};
          const page=await context.newPage();await page.setViewportSize(viewport);
          page.setDefaultTimeout(remaining());
          page.on('pageerror',error=>fail({reason:'page_error',route:route.url,state:state.name,detail:error.message}));
          page.on('console',message=>{if(message.type()==='error')fail({reason:'console_error',route:route.url,detail:message.text()});});
          try {
            const response=await page.goto(route.url,{waitUntil:'domcontentloaded',timeout:remaining()});
            if(!response) throw new Error('navigation_http_0');
            if([401,403].includes(response.status())) throw new Error('authorization_or_challenge_required');
            if(response.status()>=400) throw new Error('navigation_http_'+response.status());
            if(!policy.pageOrigins.includes(new URL(page.url()).origin)) throw new Error('redirect_outside_scope');
            route.final_url=normalizeUrl(page.url());
            await page.waitForLoadState('networkidle',{timeout:remaining()});
            if(policy.readySelector) await page.locator(policy.readySelector).waitFor({timeout:remaining()});
            await page.waitForFunction(()=>document.fonts.status==='loaded',null,{timeout:remaining()});
            const challenge=await page.evaluate(()=>({
              password:document.querySelectorAll('input[type=password]').length,
              captcha:document.querySelectorAll('iframe[src*="captcha" i],[data-sitekey],[class*="captcha" i]').length,
              text:(document.title+' '+(document.body?.innerText||'')).slice(0,12000),
            }));
            if(challenge.password||challenge.captcha||/\b(?:captcha|multi[- ]?factor|\bmfa\b|sign[ -]?in|log[ -]?in|verify you are human|bot challenge)\b/i.test(challenge.text)) throw new Error('authorization_or_challenge_required');
            for(const action of state.actions) {
              if(action.type==='scroll') {
                if(action.selector) await page.locator(action.selector).scrollIntoViewIfNeeded({timeout:remaining()});
                else await page.evaluate(y=>window.scrollTo(0,y),Number(action.y)||0);
              } else await page.locator(action.selector)[action.type]({timeout:remaining()});
              await page.waitForLoadState('networkidle',{timeout:remaining()});
            }
            const scroll=await scrollThroughPage(page,policy,deadline);
            await page.waitForLoadState('networkidle',{timeout:remaining()});
            await page.waitForFunction(()=>document.fonts.status==='loaded',null,{timeout:remaining()});
            const links=await collectPage(page), signals=await collectSignals(page);
            const extra=await page.evaluate(()=>({images:[...document.images].map(img=>({src:img.src,currentSrc:img.currentSrc,srcset:img.srcset,decoded:img.complete&&img.naturalWidth>0})),fonts:[...document.fonts].map(f=>({family:f.family,status:f.status})),dynamicStyles:[...document.querySelectorAll('style')].map(s=>s.textContent),styleSheets:[...document.styleSheets].map(s=>{try{return {href:s.href,rules:[...s.cssRules].map(r=>r.cssText)}}catch{return {href:s.href,unreadable:true}}}),shadowHosts:[...document.querySelectorAll('*')].filter(e=>e.shadowRoot).length,iframes:document.querySelectorAll('iframe').length,canvas:document.querySelectorAll('canvas').length}));
            if(extra.images.some(i=>!i.decoded)) fail({reason:'image_decode',route:route.url,capture_id});
            if(extra.fonts.some(f=>f.status==='error')) fail({reason:'font_load',route:route.url,capture_id});
            for(const name of ['shadowHosts','iframes','canvas']) if(extra[name]) gaps.push({reason:name+'_unsupported',route:route.url,count:extra[name]});
            for(const link of links.links) {
              try {
                if(/^#\//.test(new URL(link.href).hash)) {gaps.push({reason:'hash_route_unsupported',url:link.href});continue;}
                discover(normalizeUrl(link.href,route.url),route.depth+1,route.url);
              } catch {warnings.push({reason:'non_http_or_sensitive_link',from:route.url});}
            }
            const prefix=`pages/${capture_id}`;
            const rendered=await page.content();put(root,prefix+'/rendered.html',rendered,true);
            put(root,prefix+'/signals.json',json({schema:1,...current,scroll,signals,...extra}),true);
            await page.screenshot({path:safeFile(root,prefix+'/screenshot.png'),fullPage:true,timeout:remaining()});
            const evidence={capture_id,url:route.url,final_url:route.final_url,viewport,state:state.name,files:{}};
            for(const name of ['rendered.html','signals.json','screenshot.png']) {const rel=prefix+'/'+name;evidence.files[name]={path:rel,sha256:sha(fs.readFileSync(safeFile(root,rel)))};}
            captures.push(evidence);
            await listener.drain();
          } finally {await page.close();}
        }
        route.status='visited';
      } catch(error) {route.status='failed';route.reason=error.message;fail({reason:error.message,url:route.url});}
    }
    for(const route of routes.filter(r=>r.status==='pending')) route.reason=route.reason||((budgetExpired||Date.now()>=deadline)?'time_budget':'max_pages');
    await listener.drain();
    // Decode every captured image, including CSS backgrounds not represented by img.
    if(!budgetExpired&&Date.now()<deadline) {
      const decoder=await context.newPage();
      for(const r of resources.filter(r=>r.kind==='image'&&r.status==='saved')) {
        const data='data:'+r.mime.split(';')[0]+';base64,'+fs.readFileSync(safeFile(root,r.raw_path)).toString('base64');
        const valid=await decoder.evaluate(async data=>{const image=new Image();image.src=data;try{await image.decode();return image.naturalWidth>0&&image.naturalHeight>0;}catch{return false;}},data);
        r.decoded=valid;if(!valid){r.status='failed';r.reason='image_decode';fail({reason:'image_decode',url:r.url});}
      }
      await decoder.close();
    }
  } catch(error) {fail({reason:'capture_runtime',detail:error.message});}
  finally {
    clearTimeout(timer);
    if(listener) {await listener.drain();listener.detach();}
    if(context) {try {await context.close();closed=true;}catch(error){fail({reason:'context_close',detail:error.message});}}
    if(browser) await browser.close();
    if(proxy) await proxy.close();
  }
  manifest.failures.push(...networkFailures);
  let harEntries=[];
  if(policy.har) {
    try {
      if(!closed) throw new Error('context_not_closed');
      const body=fs.readFileSync(safeFile(root,'network/capture.har')),har=JSON.parse(body);
      if(har.log?.version!=='1.2'||!har.log.entries?.length||!har.log.entries.some(e=>e.response?.content?.text)) throw new Error('empty_or_invalid_native_har');
      harEntries=har.log.entries;
      Object.assign(manifest.har,{path:'network/capture.har',sha256:sha(body),entries:har.log.entries.length,mode:'full',content:'embed'});
    } catch(error) {fail({reason:'har_invalid',detail:error.message});}
  }
  const sanitizedNetwork={
    schema:1,run_id,mode:policy.mode,
    sensitive_headers_removed:['cookie','set-cookie','authorization','proxy-authorization'],
    sensitive_query_keys:policy.sensitiveQueryKeys,
    events:networkEvents.map(e=>({...e,url:sanitizeUrl(e.url,policy.sensitiveQueryKeys)})),
    har:harEntries.map(e=>({url:sanitizeUrl(e.request?.url||'',policy.sensitiveQueryKeys),method:e.request?.method||'',status:e.response?.status||0,mime:e.response?.content?.mimeType||''})),
  };
  put(root,'reports/network-sanitized.json',json(sanitizedNetwork));
  try {localize(root,policy,routes,resources,gaps,warnings);}catch(error){fail({reason:'localization',detail:error.message});}
  manifest.failures.push(...gaps);
  manifest.captures=captures;
  manifest.counts={discovered:routes.length,visited:routes.filter(r=>r.status==='visited').length,excluded:routes.filter(r=>r.status==='excluded').length,failed:routes.filter(r=>r.status==='failed').length,pending:routes.filter(r=>r.status==='pending').length,resources:resources.length,saved_resources:resources.filter(r=>r.status==='saved').length,failed_resources:resources.filter(r=>r.status==='failed').length,by_kind:{},raw_bytes:totalBytes};
  for(const r of resources.filter(r=>r.status==='saved')) manifest.counts.by_kind[r.kind]=(manifest.counts.by_kind[r.kind]||0)+1;
  const auth=manifest.failures.some(f=>/authorization_or_challenge|http_401|http_403/.test(f.reason));
  const safety=manifest.failures.some(f=>['private_address','dns_failed','scheme_blocked','credentialed_url','blocked_business_request','redirect_limit'].includes(f.reason));
  const needsApproval=manifest.failures.some(f=>f.reason==='needs_approval');
  const exhausted=policy.mode==='authorized-public'&&(manifest.failures.some(f=>/budget/.test(f.reason))||routes.some(r=>r.status==='pending'&&['max_pages','max_depth','time_budget'].includes(r.reason)));
  manifest.status=policy.mode==='authorized-public'
    ?(auth||safety?'blocked':exhausted?'exhausted':needsApproval?'partial':!manifest.counts.visited?'failed':manifest.failures.length||manifest.counts.pending||manifest.counts.failed?'partial':'complete')
    :(auth?'blocked':!manifest.counts.visited?'failed':manifest.failures.length||manifest.counts.pending||manifest.counts.failed?'partial':'complete');
  manifest.core_sha256=coreDigest(routes,resources);manifest.finished_at=new Date().toISOString();
  manifest.warnings=warnings;
  put(root,'routes.json',json({schema:1,routes}));put(root,'resources.json',json({schema:1,resources}));
  put(root,'reports/download.json',json({schema:1,run_id,status:manifest.status,counts:manifest.counts,failures:manifest.failures,warnings,core_sha256:manifest.core_sha256}));
  put(root,'manifest.json',json(manifest));
  return {root,manifest};
}
