import fs from 'node:fs';
import { SCHEMA, sha, safeFile, noLinks, readJSON, coreDigest, bodyProblem } from './core.mjs';

export function verify(root,{requirePreview=false}={}) {
  const errors=[];
  const check=(condition,message)=>{if(!condition)errors.push(message);};
  try {
    noLinks(root);
    check(fs.readFileSync(safeFile(root,'.downloader-owned'),'utf8')===SCHEMA+'\n','ownership marker');
    const m=readJSON(root,'manifest.json'),rs=readJSON(root,'resources.json'),rt=readJSON(root,'routes.json'),report=readJSON(root,'reports/download.json');
    check(m.status!=='blocked','blocked reference capture'+(m.reason?': '+m.reason:''));
    check(m.schema===SCHEMA&&typeof m.run_id==='string'&&m.run_id.length>10,'manifest schema/run_id');
    check(m.status==='complete','download status '+m.status);
    check(report.schema===1&&report.status===m.status&&report.run_id===m.run_id,'download report structure/status');
    check(Array.isArray(m.failures)&&m.failures.length===0,'download failures');
    check(Array.isArray(report.failures)&&report.failures.length===0,'report failures');
    if(rs.schema!==1||!Array.isArray(rs.resources)||!rs.resources.length) throw new Error('resources must be nonempty');
    if(rt.schema!==1||!Array.isArray(rt.routes)||!rt.routes.length) throw new Error('routes must be nonempty');
    const resources=rs.resources,routes=rt.routes;
    check(m.policy_sha256===sha(JSON.stringify(m.policy,null,2)+'\n'),'policy digest');
    check(typeof m.engine?.browser==='string'&&typeof m.engine.playwright==='string','browser/runtime evidence');
    check(/^[a-f0-9]{64}$/.test(m.engine?.adapter_sha256||''),'adapter source digest missing');
    check(m.core_sha256===coreDigest(routes,resources)&&report.core_sha256===m.core_sha256,'core digest');
    check(routes.every(r=>typeof r.url==='string'&&Array.isArray(r.from)&&['visited','excluded'].includes(r.status)),'pending/failed/malformed route');
    check(routes.some(r=>r.url===m.policy.url&&r.status==='visited'),'entry route not visited');
    const actualCounts={discovered:routes.length,visited:routes.filter(r=>r.status==='visited').length,excluded:routes.filter(r=>r.status==='excluded').length,failed:routes.filter(r=>r.status==='failed').length,pending:routes.filter(r=>r.status==='pending').length,resources:resources.length,saved_resources:resources.filter(r=>r.status==='saved').length,failed_resources:resources.filter(r=>r.status==='failed').length};
    for(const [k,v] of Object.entries(actualCounts)) check(m.counts?.[k]===v&&report.counts?.[k]===v,'count '+k);
    const fileHash=(rel,expected)=>{
      const content=fs.readFileSync(safeFile(root,rel));check(content.length>0,'empty file '+rel);check(sha(content)===expected,'hash mismatch '+rel);return content;
    };
    const paths=new Map();
    for(const r of resources) {
      check(r.method==='GET'&&typeof r.mime==='string'&&typeof r.response_url==='string'&&Array.isArray(r.references)&&Array.isArray(r.observations)&&r.observations.length>0,'resource schema');
      if(r.status==='redirect') {check(r.http_status>=300&&r.http_status<400,'invalid redirect');continue;}
      check(r.status==='saved','resource failed '+r.url);
      if(!r.raw_path?.startsWith('raw/')||!r.local_path?.startsWith('site/objects/')) throw new Error('resource path role violation');
      const raw=fileHash(r.raw_path,r.raw_sha256),local=fileHash(r.local_path,r.local_sha256);
      check(raw.length===r.bytes&&local.length===r.local_bytes,'resource byte counts');
      check(!bodyProblem(raw,r.request_type,r.mime,r.http_status),'resource content invalid '+r.url);
      if(r.kind==='image')check(r.decoded===true,'image decode missing '+r.url);
      const key=r.local_path.toLowerCase();
      check(!paths.has(key)||paths.get(key)===r.raw_sha256,'case-insensitive output collision');paths.set(key,r.raw_sha256);
    }
    if(!Array.isArray(m.captures)||!m.captures.length) throw new Error('capture evidence missing');
    for(const r of routes.filter(r=>r.status==='visited')) {
      for(const v of m.policy.viewports) {
        const states=['default',...m.policy.states.filter(s=>!s.path||s.path===new URL(r.url).pathname).map(s=>s.name)];
        for(const state of states)check(m.captures.some(c=>c.url===r.url&&c.viewport.width===v.width&&c.viewport.height===v.height&&c.state===state),'missing route/viewport/state evidence');
      }
    }
    for(const c of m.captures) {
      for(const name of ['rendered.html','signals.json','screenshot.png']) {
        const f=c.files?.[name];if(!f||!f.path.startsWith('pages/'))throw new Error('missing page evidence '+name);
        const body=fileHash(f.path,f.sha256);
        if(name==='screenshot.png') check(body.subarray(0,8).toString('hex')==='89504e470d0a1a0a'&&body.readUInt32BE(16)>=c.viewport.width,'invalid screenshot');
        if(name==='signals.json') {const s=JSON.parse(body);check(s.capture_id===c.capture_id&&s.signals?.viewport?.width===c.viewport.width&&s.signals?.viewport?.height===c.viewport.height,'viewport evidence mismatch');}
      }
    }
    const mapping=readJSON(root,'site/route-map.json');
    if(mapping.schema!==1||!mapping.aliases||!Object.keys(mapping.aliases).length) throw new Error('empty route map');
    for(const [url,target] of Object.entries(mapping.aliases)) {
      check(url.startsWith('/')&&typeof target.mime==='string','alias schema');
      fileHash('site/'+target.path,target.sha256);
      check(resources.some(r=>r.local_path==='site/'+target.path&&r.local_sha256===target.sha256&&r.mime===target.mime),'alias not backed by verified resource');
    }
    for(const route of routes.filter(r=>r.status==='visited')) {
      const u=new URL(route.url),key=u.pathname+u.search,target=mapping.aliases[key];
      const expected=resources.find(r=>r.url===(route.final_url||route.url)&&r.status==='saved'&&r.request_type==='document');
      check(Boolean(expected&&target&&'site/'+target.path===expected.local_path),'missing or incorrect page alias '+key);
    }
    for(const r of resources.filter(r=>r.status==='saved')) {
      const target=mapping.aliases['/'+r.local_path.slice(5)];
      check(Boolean(target&&'site/'+target.path===r.local_path),'missing object alias '+r.url);
    }
    check(typeof mapping.entry==='string'&&Object.hasOwn(mapping.aliases,mapping.entry),'entry alias missing');
    const refs=readJSON(root,'reports/references.json');
    check(refs.schema===1&&Array.isArray(refs.references)&&Array.isArray(refs.gaps)&&refs.gaps.length===0&&Array.isArray(refs.warnings),'reference report');
    check(refs.references?.every(ref=>resources.some(r=>r.url===ref.to&&r.status==='saved')),'reference targets missing');
    if(m.policy?.mode==='authorized-public') {
      const network=readJSON(root,'reports/network-sanitized.json');
      check(network.schema===1&&network.run_id===m.run_id&&network.mode==='authorized-public','sanitized network report provenance');
      check(Array.isArray(network.events)&&Array.isArray(network.har),'sanitized network report structure');
      const serialized=JSON.stringify(network).toLowerCase();
      check(!serialized.includes('set-cookie')||network.sensitive_headers_removed?.includes('set-cookie'),'sanitized network header contract');
      check(Array.isArray(network.sensitive_query_keys),'sanitized query-key contract');
    }
    if(m.har?.enabled) {
      const data=fileHash(m.har.path,m.har.sha256),har=JSON.parse(data);
      check(m.har.session_id===m.session_id&&har.log?.version==='1.2'&&har.log.entries?.length>0&&har.log.entries.length===m.har.entries,'HAR structure/session');
      check(har.log.entries.some(e=>e.response?.content?.text),'HAR response content missing');
    }
    if(requirePreview) {
      const p=readJSON(root,'reports/preview.json');
      check(p.schema===1&&p.run_id===m.run_id&&p.core_sha256===m.core_sha256&&p.status==='complete','preview status/provenance');
      check(Array.isArray(p.pages)&&p.pages.length===m.counts.visited*m.policy.viewports.length&&p.pages.every(x=>x.status==='passed'),'preview coverage');
      const expectedCases=new Set(routes.filter(r=>r.status==='visited').flatMap(r=>m.policy.viewports.map(v=>JSON.stringify([new URL(r.url).pathname+new URL(r.url).search,v.width,v.height]))));
      const actualCases=new Set(p.pages?.map(c=>JSON.stringify([c.path,c.viewport.width,c.viewport.height])));
      check(actualCases.size===expectedCases.size&&[...expectedCases].every(c=>actualCases.has(c)),'preview case identity/duplicate');
      check(Array.isArray(p.requests)&&p.requests.length>0&&Array.isArray(p.failures)&&p.failures.length===0,'preview request evidence');
      check(Array.isArray(p.checks)&&p.checks.every(c=>c.status==='passed'&&Array.isArray(c.assertions)&&c.assertions.length>0),'preview checks');
      if(Array.isArray(p.pages))for(const page of p.pages) {
        check(page.observations?.viewport?.width===page.viewport?.width&&page.observations?.viewport?.height===page.viewport?.height,'preview viewport mismatch');
        check(Array.isArray(page.observations?.images)&&page.observations.images.every(i=>i.decoded===true),'preview image evidence');
        check(Array.isArray(page.errors)&&page.errors.length===0,'preview page errors');
        if(!page.screenshot?.startsWith('reports/'))throw new Error('missing preview screenshot');
        fileHash(page.screenshot,page.screenshot_sha256);
      }
      check(p.requests?.every(r=>r.method==='GET'&&new URL(r.url).origin===p.origin),'preview outbound request');
      check(p.checks?.every(c=>c.assertions.every(a=>a.passed===true&&a.actual&&a.expected)),'preview failed assertion');
    }
  } catch(error) {errors.push(error.message);}
  return {schema:1,status:errors.length?'failed':'complete',errors};
}

export function compareRuns(first,second) {
  const a=verify(first),b=verify(second);
  if(a.status!=='complete'||b.status!=='complete')return {status:'failed',equal:false,first:a,second:b};
  const one=readJSON(first,'manifest.json'),two=readJSON(second,'manifest.json');
  const samePolicy=one.policy_sha256===two.policy_sha256;
  const sameRuntime=one.engine.browser===two.engine.browser&&one.engine.playwright===two.engine.playwright&&one.engine.adapter_sha256===two.engine.adapter_sha256;
  const equal=one.core_sha256===two.core_sha256&&samePolicy&&sameRuntime;
  const aResources=readJSON(first,'resources.json').resources,bResources=readJSON(second,'resources.json').resources;
  const aKeys=new Set(aResources.map(r=>JSON.stringify([r.url,r.status,r.raw_sha256]))),bKeys=new Set(bResources.map(r=>JSON.stringify([r.url,r.status,r.raw_sha256])));
  return {status:equal?'complete':'failed',equal,same_policy:samePolicy,same_runtime:sameRuntime,first_sha256:one.core_sha256,second_sha256:two.core_sha256,metadata_excluded:['run_id','session_id','capture timestamps','HAR timings','observation ordering'],differing:equal?[]:['routes/resources, policy or runtime'],only_first:[...aKeys].filter(k=>!bKeys.has(k)).map(JSON.parse),only_second:[...bKeys].filter(k=>!aKeys.has(k)).map(JSON.parse)};
}

// A child exit code is not acceptance. This same function is used by the real
// end-to-end runner and its negative cases (including a lying exit-zero child).
export function executionVerdict(result,root,options={}) {
  const validation=verify(root,options);
  const errors=[...validation.errors];
  if(result.code!==0) errors.push('child nonzero exit');
  if(result.timedOut) errors.push('child timeout');
  if(!result.data||result.data.status!=='complete') errors.push('child result incomplete or malformed');
  return {status:errors.length?'failed':'complete',errors};
}
