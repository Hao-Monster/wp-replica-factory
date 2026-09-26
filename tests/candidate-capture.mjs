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
const page=(kind,content,add='/cart/?add-fixture=1')=>`<!doctype html><html><head><style>body{font:16px sans-serif;margin:0}.replica-menu{display:none}.replica-menu.is-open{display:block}.box{width:360px;min-height:80px;border:1px solid #222;margin:20px}</style></head><body class="${kind}"><button data-replica-menu-toggle>menu</button><div class="replica-menu">owned menu</div><a data-replica-add-fixture href="${add}">add fixture</a><main class="box">${content}</main><script>document.querySelector('[data-replica-menu-toggle]').onclick=()=>document.querySelector('.replica-menu').classList.add('is-open');</script></body></html>`;
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://owned.invalid'),hasCart=(req.headers.cookie||'').includes('fixture_cart=1');
  res.setHeader('content-type','text/html');
  if(url.pathname==='/cart/'&&url.searchParams.has('add-fixture')){res.statusCode=302;res.setHeader('set-cookie','fixture_cart=1; Path=/; HttpOnly');res.setHeader('location','/cart/');return res.end();}
  if(url.pathname==='/cart/'&&url.searchParams.has('broken-add')){res.statusCode=302;res.setHeader('location','/cart/');return res.end();}
  if(url.pathname==='/checkout/'&&!hasCart){res.statusCode=302;res.setHeader('location','/cart/');return res.end();}
  if(url.pathname==='/')return res.end(page('home','<h1>Home</h1>'));
  if(url.pathname==='/product-category/replica-fixture/')return res.end(page('tax-product_cat','<ul class="products"><li>Fixture category</li></ul>'));
  if(url.pathname==='/product/replica-fixture-001/')return res.end(page('single-product','<div class="product">Replica Fixture 001</div>'));
  if(url.pathname==='/cart/')return res.end(hasCart?page('woocommerce-cart','<form class="woocommerce-cart-form"><div class="woocommerce-cart-form__cart-item">Replica Fixture 001</div></form>'):page('woocommerce-cart','<div class="cart-empty">Cart is empty</div>',url.searchParams.has('broken')?'/cart/?broken-add=1':undefined));
  if(url.pathname==='/checkout/')return res.end(page('woocommerce-checkout','<form class="woocommerce-checkout">Checkout form</form>'));
  if(url.pathname==='/fallback-cart/')return res.end(page('home','<h1>Home fallback</h1>'));
  res.statusCode=404;res.end(page('error404','not found'));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const cartEmpty={required:[{selector:'.cart-empty',minCount:1}],forbidden:[{selector:'.woocommerce-cart-form__cart-item'}]};
const cartFull={required:[{selector:'.woocommerce-cart-form__cart-item',minCount:1,text:'Replica Fixture 001'}],forbidden:[{selector:'.cart-empty'}]};
const policy={authorization:'owned-staging',previewUrl:base,routes:[
  {page:'home',route:'/',states:[{id:'default',required:[{selector:'body.home'}]},{id:'menu-open',action:'menuToggle',required:[{selector:'body.home'},{selector:'.replica-menu.is-open'}]}]},
  {page:'category',route:'/product-category/replica-fixture/',states:[{id:'default',required:[{selector:'body.tax-product_cat'},{selector:'ul.products'}]}]},
  {page:'product',route:'/product/replica-fixture-001/',states:[{id:'default',required:[{selector:'body.single-product'},{selector:'.product',text:'Replica Fixture 001'}]}]},
  {page:'cart',route:'/cart/',states:[{id:'default',expectedPath:'/cart/',...cartEmpty},{id:'cart-nonempty',action:'addFixture',expectedPath:'/cart/',before:cartEmpty.required,...cartFull}]},
  {page:'checkout',route:'/checkout/',states:[{id:'default',setupRoute:'/cart/',action:'addFixture',expectedPath:'/checkout/',before:cartEmpty.required,required:[{selector:'body.woocommerce-checkout'},{selector:'form.woocommerce-checkout'}]}]}
],viewports:[{id:'desktop',width:1440,height:1000},{id:'mobile',width:390,height:844}],ownedSelectors:{menuToggle:'[data-replica-menu-toggle]',addFixture:'[data-replica-add-fixture]'}};
const policyFile=path.join(root,'capture-policy.json');fs.writeFileSync(policyFile,JSON.stringify(policy));
const candidate=path.join(root,'candidate');
const captured=await captureCandidate({policyFile,out:candidate});
const manifest=JSON.parse(fs.readFileSync(path.join(candidate,'manifest.json')));
assert.equal(captured.candidate_path,path.resolve(candidate));
assert.equal(captured.candidate_manifest_sha,sha(path.join(candidate,'manifest.json')));
assert.equal(manifest.capture_policy_sha256,crypto.createHash('sha256').update(fs.readFileSync(policyFile)).digest('hex'));
assert.equal(manifest.screenshots.length,14);
assert.equal(new Set(manifest.screenshots.map(x=>`${x.page}:${x.viewport}:${x.state}`)).size,14);
assert.ok(manifest.runtime.browser_version);
assert.ok(manifest.screenshots.every(x=>x.main_document_status===200&&x.final_route===x.route));
assert.ok(manifest.screenshots.every(x=>x.redirect_chain.length>=1&&x.assertions.required.every(a=>a.status==='pass')));
assert.ok(manifest.screenshots.some(x=>x.viewport==='desktop'&&x.width===1440&&x.height===1000));
assert.ok(manifest.screenshots.some(x=>x.viewport==='mobile'&&x.width===390&&x.height===844));
for(const row of manifest.screenshots)assert.equal(row.sha256,sha(path.join(candidate,row.path)));
const cartDefault=manifest.screenshots.find(x=>x.page==='cart'&&x.viewport==='desktop'&&x.state==='default');
const cartFullShot=manifest.screenshots.find(x=>x.page==='cart'&&x.viewport==='desktop'&&x.state==='cart-nonempty');
assert.notEqual(cartDefault.sha256,cartFullShot.sha256);

async function expectCaptureFailure(name,routes,code){
  const file=path.join(root,`${name}.json`);fs.writeFileSync(file,JSON.stringify({...policy,routes,viewports:[{id:'desktop',width:900,height:700}]}));
  await assert.rejects(()=>captureCandidate({policyFile:file,out:path.join(root,name)}),error=>error.code===code);
}
await expectCaptureFailure('state-not-reached',[{page:'cart',route:'/cart/?broken=1',states:[{id:'cart-nonempty',action:'addFixture',expectedPath:'/cart/',before:cartEmpty.required,...cartFull}]}],'required_content_missing');
await expectCaptureFailure('cart-fallback',[{page:'cart',route:'/fallback-cart/',states:[{id:'default',expectedPath:'/fallback-cart/',...cartEmpty}]}],'required_content_missing');
await expectCaptureFailure('checkout-redirect',[{page:'checkout',route:'/checkout/',states:[{id:'default',expectedPath:'/checkout/',required:[{selector:'form.woocommerce-checkout'}]}]}],'unexpected_route');

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
server.close();console.log(JSON.stringify({status:'complete',screenshots:manifest.screenshots.length,checks:13}));
