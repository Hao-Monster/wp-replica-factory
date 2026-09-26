import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {captureCandidate,handoffCandidate} from '../tools/candidate-capture/cli.mjs';
import {evaluate,verifyReport} from '../tools/visual-evaluator/evaluate.mjs';
import {readPng,writePng,sha} from '../tools/visual-evaluator/image-diff.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'candidate-capture-'));
const server=http.createServer((req,res)=>{
  res.setHeader('content-type','text/html');
  res.end(`<!doctype html><html><head><style>body{font:16px sans-serif;margin:0}.menu{display:none}.menu.open{display:block}.box{width:180px;height:80px;border:1px solid #222;margin:20px}</style></head><body><button data-replica-menu-toggle>menu</button><div class="menu">owned menu</div><button data-replica-add-fixture>add fixture</button><div class="box">${req.url}</div><script>document.querySelector('[data-replica-menu-toggle]').onclick=()=>document.querySelector('.menu').classList.add('open');document.querySelector('[data-replica-add-fixture]').onclick=()=>{document.body.dataset.cart='nonempty';document.querySelector('.box').textContent='cart-nonempty';};</script></body></html>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const policy={authorization:'owned-staging',previewUrl:base,routes:[
  {page:'home',route:'/',states:['default','menu-open']},
  {page:'category',route:'/product-category/replica-fixture/',states:['default']},
  {page:'product',route:'/product/replica-fixture-001/',states:['default']},
  {page:'cart',route:'/cart/',states:['default','cart-nonempty']},
  {page:'checkout',route:'/checkout/',states:['default']}
],viewports:[{id:'desktop',width:1440,height:1000},{id:'mobile',width:390,height:844}],ownedSelectors:{menuToggle:'[data-replica-menu-toggle]',addFixture:'[data-replica-add-fixture]'}};
const policyFile=path.join(root,'capture-policy.json');fs.writeFileSync(policyFile,JSON.stringify(policy));
const candidate=path.join(root,'candidate');
const captured=await captureCandidate({policyFile,out:candidate});
const manifest=JSON.parse(fs.readFileSync(path.join(candidate,'manifest.json')));
assert.equal(captured.candidate_path,path.resolve(candidate));
assert.equal(captured.candidate_manifest_sha,sha(path.join(candidate,'manifest.json')));
assert.equal(manifest.capture_policy_sha256,crypto.createHash('sha256').update(fs.readFileSync(policyFile)).digest('hex'));
assert.equal(manifest.screenshots.length,14);
assert.ok(manifest.screenshots.some(x=>x.viewport==='desktop'&&x.width===1440&&x.height===1000));
assert.ok(manifest.screenshots.some(x=>x.viewport==='mobile'&&x.width===390&&x.height===844));
for(const row of manifest.screenshots)assert.equal(row.sha256,sha(path.join(candidate,row.path)));

const baseline=path.join(root,'baseline');fs.cpSync(candidate,baseline,{recursive:true});
const bm=JSON.parse(fs.readFileSync(path.join(baseline,'manifest.json')));bm.baseline_set_id='owned-ci-baseline';fs.writeFileSync(path.join(baseline,'manifest.json'),JSON.stringify(bm));
const visualPolicy=path.join(root,'visual-policy.json');fs.writeFileSync(visualPolicy,JSON.stringify({pixel:{maxDifferentRatio:0,maxMeanAbsoluteError:0},maxCandidateAgeMinutes:30,requiredStates:manifest.screenshots.map(x=>({page:x.page,viewport:x.viewport,state:x.state})),regions:[],failOnMissingImages:true}));
const exactOut=path.join(root,'visual-exact');let report=evaluate({baseline,candidate,policy:visualPolicy,out:exactOut});
assert.equal(report.overall_status,'pass');assert.equal(verifyReport(exactOut).status,'verified');
const handoff=await handoffCandidate({capturePolicy:policyFile,out:path.join(root,'handoff-candidate'),baseline,visualPolicy,visualOut:path.join(root,'handoff-visual')});
assert.equal(handoff.visual_status,'pass');
assert.equal(handoff.candidate_manifest_sha,sha(path.join(root,'handoff-candidate','manifest.json')));
assert.ok(handoff.core_report_sha256);

const mismatch=path.join(root,'mismatch');fs.cpSync(candidate,mismatch,{recursive:true});
const mm=JSON.parse(fs.readFileSync(path.join(mismatch,'manifest.json')));const shot=path.join(mismatch,mm.screenshots[0].path);
const image=readPng(shot);image.data[0]=image.data[0]===0?255:0;writePng(shot,image.width,image.height,image.data);mm.screenshots[0].sha256=sha(shot);fs.writeFileSync(path.join(mismatch,'manifest.json'),JSON.stringify(mm));
report=evaluate({baseline,candidate:mismatch,policy:visualPolicy,out:path.join(root,'visual-mismatch')});assert.equal(report.overall_status,'fail');assert.ok(report.summary.failures.includes('pixel_threshold'));

const stale=path.join(root,'stale');fs.cpSync(candidate,stale,{recursive:true});
const sm=JSON.parse(fs.readFileSync(path.join(stale,'manifest.json')));for(const row of sm.screenshots)row.timestamp='2000-01-01T00:00:00Z';fs.writeFileSync(path.join(stale,'manifest.json'),JSON.stringify(sm));
report=evaluate({baseline,candidate:stale,policy:visualPolicy,out:path.join(root,'visual-stale')});assert.ok(report.summary.failures.includes('stale_candidate'));
server.close();console.log(JSON.stringify({status:'complete',screenshots:manifest.screenshots.length,checks:10}));
