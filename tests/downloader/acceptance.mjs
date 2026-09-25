import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { ROOT, json, readJSON, safeFile, sha } from '../../tools/downloader/core.mjs';
import { verify, compareRuns, executionVerdict } from '../../tools/downloader/verify.mjs';
import { serve } from '../../tools/downloader/preview.mjs';
import { startFixture, cli } from './fixture-process.mjs';
import { ownedChecks } from './owned-checks.mjs';
import { edgeFixture } from './edge-fixture.mjs';

const bucket=path.join(ROOT,'.replica/downloads/acceptance-'+new Date().toISOString().replaceAll(':','-')+'-'+process.pid);
fs.mkdirSync(bucket,{recursive:true});
const report={schema:1,status:'running',bucket,started_at:new Date().toISOString(),fixture_sha:'66e30c9fa6fa5977f088c380e22838648399e2e1',checks:[],runs:[]};
const reportPath=path.join(ROOT,'.replica/downloader-acceptance.json');
const persist=()=>{fs.writeFileSync(reportPath,json(report));fs.writeFileSync(path.join(bucket,'acceptance.json'),json(report));};persist();
const record=(id,evidence)=>{report.checks.push({id,status:'passed',...evidence});console.log('PASS '+id);persist();};
const output=name=>path.join(bucket,name);
async function runDownload(name,origin,extra=[]) {
  const dir=output(name);
  const result=await cli(['download','--url',origin+'/','--out',dir,...extra]);
  fs.writeFileSync(path.join(bucket,name+'-process.json'),json(result));
  report.runs.push({name,dir,exit_code:result.code,status:result.data?.status||'failed'});persist();
  return {dir,result};
}
function positive(run) {
  const verdict=executionVerdict(run.result,run.dir);
  assert.equal(verdict.status,'complete',JSON.stringify({verdict,stderr:run.result.stderr}));
}
function negative(run,allowed=['partial','failed','blocked']) {
  assert.notEqual(run.result.code,0,'negative child exited zero');
  assert.equal(run.result.timedOut,false,'negative child timed out instead of reporting');
  const m=readJSON(run.dir,'manifest.json');assert.ok(allowed.includes(m.status));
  assert.equal(verify(run.dir).status,'failed');
  assert.equal(executionVerdict({...run.result,code:0,data:{status:'complete'}},run.dir).status,'failed','lying wrapper accepted internal failure');
  return {exit_code:run.result.code,status:m.status,failures:m.failures.map(f=>f.reason)};
}
let source,edge,sourceStopped=false;
try {
  source=await startFixture();report.source_origin=source.origin;persist();
  for(const n of [1,2]) {
    const dir=output('owned-'+n);
    // Exactly ONE entry. The expected three routes are never downloader seeds.
    const result=await cli(['download','--url',source.origin+'/grid.html','--public-get',source.origin+'/data/products.json','--viewport','1440x1000','--viewport','390x844','--har','--out',dir]);
    fs.writeFileSync(path.join(bucket,`owned-${n}-process.json`),json(result));
    const run={dir,result};positive(run);
    report.runs.push({name:'owned-'+n,dir,exit_code:result.code,status:result.data.status});
    const m=readJSON(dir,'manifest.json'),rs=readJSON(dir,'resources.json').resources,rt=readJSON(dir,'routes.json').routes;
    assert.deepEqual(rt.map(r=>new URL(r.url).pathname).sort(),['/filters.html','/grid.html','/lazy.html']);
    assert.ok(rt.filter(r=>r.url!==m.policy.url).every(r=>r.from.length>0));
    assert.deepEqual(m.counts.by_kind,{html:3,css:1,js:4,json:1,font:2,image:5});
    assert.equal(rs.length,16);assert.equal(m.captures.length,6);
    for(const r of rs)assert.equal(sha(fs.readFileSync(safeFile(dir,r.raw_path))),r.raw_sha256);
    record('A-B-owned-capture-'+n,{directory:dir,counts:m.counts,core_sha256:m.core_sha256,browser:m.engine.browser});
    const har=readJSON(dir,'network/capture.har');
    assert.equal(har.log.version,'1.2');assert.ok(har.log.entries.length>0);
    assert.ok(har.log.entries.every(e=>e.request.method==='GET'&&e.request.url.startsWith(source.origin+'/')));
    assert.ok(har.log.entries.some(e=>e.response.content.text&&e.response.content.encoding==='base64'));
    record('H-native-HAR-'+n,{entries:har.log.entries.length,session_id:m.session_id,content:'full/embed',uploaded:false});
  }
  const comparison=compareRuns(output('owned-1'),output('owned-2'));assert.equal(comparison.status,'complete');record('F-repeat-capture',comparison);
  await source.stop();sourceStopped=true;
  await assert.rejects(fetch(source.origin+'/grid.html',{signal:AbortSignal.timeout(2000)}));report.source_stopped_before_preview=true;
  for(const n of [1,2]) {
    const dir=output('owned-'+n),checksPath=path.join(dir,'reports/approved-preview-checks.json');fs.writeFileSync(checksPath,json(ownedChecks()));
    const result=await cli(['verify',dir,'--browser','--checks',checksPath]);
    assert.equal(result.code,0,JSON.stringify(result.data?.failures||result));
    assert.equal(result.data?.status,'complete');assert.equal(verify(dir,{requirePreview:true}).status,'complete');
    assert.equal((await cli(['verify',dir,'--require-preview'])).code,0,'strict preview CLI must accept genuine evidence');
    assert.equal(result.data.checks.length,6);assert.ok(result.data.checks.every(c=>c.status==='passed'));
    assert.ok(result.data.requests.every(r=>new URL(r.url).origin===result.data.origin));
    record('C-offline-preview-'+n,{directory:dir,pages:result.data.pages.length,checks:result.data.checks.length,assertions:result.data.checks.reduce((n,c)=>n+c.assertions.length,0),requests:result.data.requests.length,source_stopped:true});
  }
  // Exercise the HTTP server's actual boundary, not merely a path helper.
  const server=await serve(output('owned-1'));
  try {
    const request=(p,method='GET',host)=>new Promise((resolve,reject)=>{
      const u=new URL(server.origin);const req=http.request({hostname:'127.0.0.1',port:u.port,path:p,method,headers:host?{Host:host}:{}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();
    });
    const statuses=[];
    for(const p of ['/raw/x','/network/capture.har','/.git/config','/../manifest.json','/%252e%252e/manifest.json','/site/route-map.json'])statuses.push(await request(p));
    statuses.push(await request('/grid.html','POST'));statuses.push(await request('/grid.html','GET','unapproved.local'));
    assert.ok(statuses.every(x=>x>=400));record('E-preview-boundary',{statuses});
  }finally{await server.close();}
  // Real copies of an owned download solely for destructive negative tests.
  const cases=[
    ['missing-file',dir=>{const r=readJSON(dir,'resources.json').resources.find(r=>r.kind==='image');fs.unlinkSync(safeFile(dir,r.local_path));}],
    ['hash-mismatch',dir=>{const r=readJSON(dir,'resources.json').resources.find(r=>r.kind==='js');fs.appendFileSync(safeFile(dir,r.local_path),'tamper');}],
    ['empty-manifest',dir=>fs.writeFileSync(path.join(dir,'manifest.json'),'{}')],
    ['empty-resource-map',dir=>fs.writeFileSync(path.join(dir,'resources.json'),'{}')],
    ['empty-download-report',dir=>fs.writeFileSync(path.join(dir,'reports/download.json'),'{}')],
    ['internal-failed',dir=>{const m=readJSON(dir,'manifest.json');m.status='failed';fs.writeFileSync(path.join(dir,'manifest.json'),json(m));}],
    ['fake-HAR',dir=>fs.writeFileSync(path.join(dir,'network/capture.har'),'{"requests":[]}')],
    ['alias-outside-site',dir=>{const m=readJSON(dir,'site/route-map.json');m.aliases['/escape']={path:'../manifest.json',mime:'text/html',sha256:'0'.repeat(64)};fs.writeFileSync(path.join(dir,'site/route-map.json'),json(m));}],
    ['missing-page-alias',dir=>{const m=readJSON(dir,'site/route-map.json');delete m.aliases['/grid.html'];fs.writeFileSync(path.join(dir,'site/route-map.json'),json(m));}],
    ['missing-adapter-digest',dir=>{const m=readJSON(dir,'manifest.json');delete m.engine.adapter_sha256;fs.writeFileSync(path.join(dir,'manifest.json'),json(m));}],
    ['empty-preview-report',dir=>fs.writeFileSync(path.join(dir,'reports/preview.json'),'{}'),true],
    ['duplicate-preview-page',dir=>{const p=readJSON(dir,'reports/preview.json');p.pages[1]=p.pages[0];fs.writeFileSync(path.join(dir,'reports/preview.json'),json(p));},true],
  ];
  for(const [name,mutate,requirePreview=false]of cases) {
    const dir=output('tamper-'+name);fs.cpSync(output('owned-1'),dir,{recursive:true});mutate(dir);
    const validation=verify(dir,{requirePreview});assert.equal(validation.status,'failed',name);
    const process=await cli(['verify',dir,...(requirePreview?['--require-preview']:[])]);assert.notEqual(process.code,0);
    assert.equal(executionVerdict({code:0,timedOut:false,data:{status:'complete'}},dir,{requirePreview}).status,'failed');
    record('G-'+name,{exit_code:process.code,errors:validation.errors});
  }
  for(const child of [{code:0,data:{}},{code:0,data:{status:'failed'}},{code:1,data:{status:'complete'}},{code:0,timedOut:true,data:{status:'complete'}}])assert.equal(executionVerdict(child,output('owned-1')).status,'failed');
  record('G-wrapper-status-exit-consistency',{cases:4});
  edge=await edgeFixture();
  const good=await runDownload('edge-query-css',edge.origin);positive(good);
  const resources=readJSON(good.dir,'resources.json').resources;
  const queries=resources.filter(r=>r.url.includes('/image.svg?'));
  assert.equal(queries.length,2);assert.notEqual(queries[0].local_path,queries[1].local_path);assert.notEqual(queries[0].raw_sha256,queries[1].raw_sha256);
  assert.ok(resources.some(r=>r.url.includes('%E4%B8%AD%E6%96%87%20')));
  const preview=await cli(['verify',good.dir,'--browser']);assert.equal(preview.code,0,preview.stdout+preview.stderr);
  record('D-query-nested-CSS-unicode',{resources:resources.length,query_paths:queries.map(r=>r.local_path)});
  edge.state.version=2;const different=await runDownload('edge-different',edge.origin);positive(different);
  const difference=compareRuns(good.dir,different.dir);assert.equal(difference.equal,false);assert.equal(difference.status,'failed');record('F-substantive-difference-rejected',difference);edge.state.version=1;
  for(const mode of ['missing','corrupt','wrongmime','font','redirect','post','unapproved','badcharset']) {
    edge.state.mode=mode;const run=await runDownload('negative-'+mode,edge.origin);
    record('E-'+mode,negative(run));
  }
  assert.equal(edge.state.leakHits,0);assert.equal(edge.state.writeRequests,0);record('E-no-redirect-egress-or-write',{leak_hits:0,write_requests:0});
  edge.state.mode='frontier';
  for(const [name,args]of [['page-budget',['--max-pages','1']],['depth-budget',['--max-depth','0']],['time-budget',['--budget','1']]]) {
    const run=await runDownload('negative-'+name,edge.origin,args);record('E-'+name,negative(run));
    if(name!=='time-budget')assert.equal(readJSON(run.dir,'manifest.json').counts.pending,1);
  }
  edge.state.mode='variant';edge.state.variantCount=0;
  const variant=await runDownload('negative-variant',edge.origin,['--viewport','1440x1000','--viewport','390x844']);negative(variant,['partial']);
  const variants=readJSON(variant.dir,'resources.json').resources.filter(r=>r.url.endsWith('/variant.css'));assert.equal(variants.length,2);assert.notEqual(variants[0].local_path,variants[1].local_path);
  record('D-response-variants-preserved',{paths:variants.map(r=>r.local_path),conflict:readJSON(variant.dir,'manifest.json').failures.some(f=>f.reason==='response_variant_conflict')});
  edge.state.mode='responsive';const responsive=await runDownload('edge-responsive',edge.origin);positive(responsive);
  assert.ok(readJSON(responsive.dir,'manifest.json').warnings.some(w=>w.reason==='uncaptured_responsive_candidate'));record('D-responsive-candidate-gap-visible',{});
  edge.state.mode='ownedredirect';const redirected=await runDownload('edge-owned-redirect',edge.origin);positive(redirected);
  const redirectPreview=await cli(['verify',redirected.dir,'--browser']);assert.equal(redirectPreview.code,0,redirectPreview.stdout);
  record('D-approved-redirect-mapped',{exit_code:redirected.result.code});
  edge.state.mode='good';
  const existing=output('user-existing');fs.mkdirSync(existing);fs.writeFileSync(path.join(existing,'keep.txt'),'untouched');
  const denied=await cli(['download','--url',edge.origin+'/','--out',existing]);assert.notEqual(denied.code,0);assert.equal(fs.readFileSync(path.join(existing,'keep.txt'),'utf8'),'untouched');
  const linked=output('linked'),target=output('target');fs.mkdirSync(target);fs.symlinkSync(target,linked,'junction');
  const linkDenied=await cli(['download','--url',edge.origin+'/','--out',path.join(linked,'escape')]);assert.notEqual(linkDenied.code,0);assert.equal(fs.existsSync(path.join(target,'escape')),false);
  record('E-output-ownership-link-refusal',{existing_exit:denied.code,linked_exit:linkDenied.code});
  const publicRun=await runDownload('public-blocked',edge.origin,['--mode','authorized-public']);record('E-public-isolation-blocked',negative(publicRun,['blocked']));
  report.status='complete';report.primary_download=output('owned-1');report.repeat_download=output('owned-2');
} catch(error) {
  report.status='failed';report.error=error.stack||error.message;console.error(report.error);process.exitCode=1;
} finally {
  if(source&&!sourceStopped)await source.stop().catch(error=>{report.status='failed';report.cleanup_error=error.message;process.exitCode=1;});
  if(edge)await edge.stop();
  report.finished_at=new Date().toISOString();persist();
  console.log(json({status:report.status,checks:report.checks.length,report:reportPath,primary_download:report.primary_download||null}));
}
