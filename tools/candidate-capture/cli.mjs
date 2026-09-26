#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {evaluate,verifyReport} from '../visual-evaluator/evaluate.mjs';
import {sha,writePng} from '../visual-evaluator/image-diff.mjs';

const require=createRequire(new URL('../downloader/package.json',import.meta.url));
const {chromium}=require('playwright');
const ALLOWED_STATES=new Set(['default','menu-open','cart-nonempty']);
const ident=v=>typeof v==='string'&&/^[a-z0-9][a-z0-9_.-]{0,79}$/.test(v);
const ownedSelector=v=>typeof v==='string'&&/^\[data-replica-[a-z0-9-]+\]$/.test(v);
const assertionSelector=v=>typeof v==='string'&&/^(?:[a-z][a-z0-9-]*)?(?:\.[a-z0-9_-]+)+$|^\[data-replica-[a-z0-9-]+(?:="[a-z0-9_.-]+")?\]$/i.test(v);
const load=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const digest=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

export class CaptureError extends Error{
  constructor(code,message,details={}){super(message);this.name='CaptureError';this.code=code;this.details=details;}
}

const stateSpec=value=>typeof value==='string'?{id:value}:value;
const pathOnly=value=>{const p=new URL(value,'http://owned.invalid').pathname;return p.endsWith('/')?p:`${p}/`;};

function validateAssertions(assertions,label){
  if(assertions===undefined)return;
  if(!Array.isArray(assertions))throw Error(`${label} assertions must be an array`);
  for(const item of assertions){
    if(!item||!assertionSelector(item.selector))throw Error(`${label} assertion selector is not allowed`);
    if(item.minCount!==undefined&&(!Number.isInteger(item.minCount)||item.minCount<0))throw Error(`${label} minCount is invalid`);
    if(item.maxCount!==undefined&&(!Number.isInteger(item.maxCount)||item.maxCount<0))throw Error(`${label} maxCount is invalid`);
    if(item.text!==undefined&&(typeof item.text!=='string'||!item.text.length||item.text.length>160))throw Error(`${label} text is invalid`);
  }
}

function validatePolicy(policy){
  if(!policy||policy.authorization!=='owned-staging')throw Error('candidate capture requires authorization=owned-staging');
  const base=new URL(policy.previewUrl);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.hash)throw Error('invalid previewUrl');
  if(!Array.isArray(policy.routes)||!policy.routes.length)throw Error('routes required');
  if(!Array.isArray(policy.viewports)||!policy.viewports.length)throw Error('viewports required');
  const pages=new Set();
  for(const item of policy.routes){
    if(!ident(item.page)||pages.has(item.page))throw Error('invalid or duplicate page');
    pages.add(item.page);
    if(typeof item.route!=='string'||!item.route.startsWith('/')||item.route.startsWith('//'))throw Error('route must be same-origin relative path');
    if(!Array.isArray(item.states)||!item.states.length)throw Error('states required');
    for(const raw of item.states){
      const state=stateSpec(raw);
      if(!state||!ALLOWED_STATES.has(state.id))throw Error('unsupported candidate state');
      if(state.action!==undefined&&!['menuToggle','addFixture'].includes(state.action))throw Error('unsupported candidate action');
      if(state.setupRoute!==undefined&&(typeof state.setupRoute!=='string'||!state.setupRoute.startsWith('/')||state.setupRoute.startsWith('//')))throw Error('setupRoute must be same-origin relative path');
      if(state.expectedPath!==undefined&&(typeof state.expectedPath!=='string'||!state.expectedPath.startsWith('/')||state.expectedPath.startsWith('//')))throw Error('expectedPath must be same-origin relative path');
      validateAssertions(state.before,'before'); validateAssertions(state.required,'required'); validateAssertions(state.forbidden,'forbidden');
    }
  }
  const ids=new Set();
  for(const viewport of policy.viewports){
    if(!ident(viewport.id)||ids.has(viewport.id))throw Error('invalid or duplicate viewport');
    ids.add(viewport.id);
    for(const key of ['width','height'])if(!Number.isInteger(viewport[key])||viewport[key]<1||viewport[key]>4000)throw Error('invalid viewport');
  }
  const hooks=policy.ownedSelectors||{};
  const specs=policy.routes.flatMap(x=>x.states.map(stateSpec));
  if(specs.some(x=>x.id==='menu-open'||x.action==='menuToggle')&&!ownedSelector(hooks.menuToggle))throw Error('menu-open requires controlled selector');
  if(specs.some(x=>x.id==='cart-nonempty'||x.action==='addFixture')&&!ownedSelector(hooks.addFixture))throw Error('cart-nonempty requires controlled selector');
  return {policy,base};
}

const safeName=v=>v.replace(/[^a-z0-9_.-]+/g,'-');

const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
function normalizeScreenshotRgba(file){
  const png=fs.readFileSync(file);
  if(!png.subarray(0,8).equals(PNG_SIGNATURE))throw Error('candidate screenshot is not PNG');
  let pos=8,width=0,height=0,depth=0,colour=-1,interlace=-1;
  const idat=[];
  while(pos+12<=png.length){
    const size=png.readUInt32BE(pos);
    if(pos+12+size>png.length)throw Error('candidate screenshot PNG is truncated');
    const type=png.toString('ascii',pos+4,pos+8);
    const data=png.subarray(pos+8,pos+8+size);
    pos+=size+12;
    if(type==='IHDR'){
      width=data.readUInt32BE(0); height=data.readUInt32BE(4);
      depth=data[8]; colour=data[9]; interlace=data[12];
    }else if(type==='IDAT')idat.push(data);
    else if(type==='IEND')break;
  }
  if(depth!==8||interlace!==0||!width||!height||![2,6].includes(colour))throw Error('candidate screenshot must be non-interlaced 8-bit RGB/RGBA PNG');
  if(colour===6)return;
  const bpp=3,stride=width*bpp,raw=zlib.inflateSync(Buffer.concat(idat));
  if(raw.length!==height*(stride+1))throw Error('candidate screenshot PNG row size mismatch');
  const rgb=Buffer.alloc(height*stride);
  let q=0;
  for(let y=0;y<height;y++){
    const filter=raw[q++],row=raw.subarray(q,q+stride); q+=stride;
    for(let x=0;x<stride;x++){
      const left=x>=bpp?rgb[y*stride+x-bpp]:0;
      const up=y?rgb[(y-1)*stride+x]:0;
      const upLeft=y&&x>=bpp?rgb[(y-1)*stride+x-bpp]:0;
      let value=row[x];
      if(filter===1)value+=left;
      else if(filter===2)value+=up;
      else if(filter===3)value+=Math.floor((left+up)/2);
      else if(filter===4){
        const p=left+up-upLeft,pa=Math.abs(p-left),pb=Math.abs(p-up),pc=Math.abs(p-upLeft);
        value+=pa<=pb&&pa<=pc?left:pb<=pc?up:upLeft;
      }else if(filter!==0)throw Error('unsupported candidate screenshot PNG filter');
      rgb[y*stride+x]=value&255;
    }
  }
  const rgba=Buffer.alloc(width*height*4);
  for(let src=0,dst=0;src<rgb.length;src+=3,dst+=4){
    rgba[dst]=rgb[src]; rgba[dst+1]=rgb[src+1]; rgba[dst+2]=rgb[src+2]; rgba[dst+3]=255;
  }
  writePng(file,width,height,rgba);
}

function redirectChain(response){
  if(!response)return [];
  const chain=[];let request=response.request();
  while(request){chain.unshift(request.url());request=request.redirectedFrom();}
  if(chain.at(-1)!==response.url())chain.push(response.url());
  return chain;
}

async function checkAssertions(page,items,phase){
  const results=[];
  for(const item of items||[]){
    const loc=page.locator(item.selector),count=await loc.count();
    const visibleCount=count?await loc.evaluateAll(nodes=>nodes.filter(node=>{const s=getComputedStyle(node),r=node.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;}).length):0;
    const texts=count?await loc.allTextContents():[];
    const min=item.minCount??1,max=item.maxCount??Number.MAX_SAFE_INTEGER;
    const textOk=item.text===undefined||texts.some(text=>text.includes(item.text));
    results.push({selector:item.selector,count,visibleCount,text:item.text??null,status:count>=min&&count<=max&&visibleCount>=Math.min(min,1)&&textOk?'pass':'fail'});
  }
  const failed=results.filter(x=>x.status!=='pass');
  if(failed.length)throw new CaptureError('required_content_missing',`${phase} assertions failed`,{phase,failed});
  return results;
}

async function prepareState(page,state,hooks){
  const action=state.action||(state.id==='menu-open'?'menuToggle':state.id==='cart-nonempty'?'addFixture':null);
  if(!action)return null;
  const chosen=hooks[action];
  const loc=page.locator(chosen);
  if(await loc.count()!==1)throw new CaptureError('state_not_reached',`controlled state selector missing or ambiguous: ${state.id}`,{selector:chosen,count:await loc.count()});
  let response=null;
  if(action==='addFixture'){
    [response]=await Promise.all([page.waitForNavigation({waitUntil:'networkidle',timeout:10000}),loc.click()]);
  }else{
    await loc.click();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  }
  return response;
}

export async function captureCandidate({policyFile,out}){
  const policyPath=path.resolve(policyFile);
  const {policy,base}=validatePolicy(load(policyPath));
  const root=path.resolve(out),shots=path.join(root,'screenshots');
  fs.rmSync(root,{recursive:true,force:true}); fs.mkdirSync(shots,{recursive:true});
  const browser=await chromium.launch({headless:true});
  const rows=[],failedImages=[];
  try{
    for(const item of policy.routes)for(const viewport of policy.viewports)for(const rawState of item.states){
      const state=stateSpec(rawState);
      const context=await browser.newContext({viewport:{width:viewport.width,height:viewport.height},deviceScaleFactor:1,serviceWorkers:'block'});
      const page=await context.newPage(),failures=[];
      page.on('requestfailed',req=>{if(req.resourceType()==='image')failures.push({url:req.url(),reason:req.failure()?.errorText||'requestfailed'});});
      page.on('response',resp=>{if(resp.request().resourceType()==='image'&&resp.status()>=400)failures.push({url:resp.url(),status:resp.status()});});
      await page.route('**/*',async route=>{
        const u=new URL(route.request().url());
        if(['data:','blob:'].includes(u.protocol)||u.origin===base.origin)return route.continue();
        return route.abort('blockedbyclient');
      });
      let response;
      try{
        const firstRoute=state.setupRoute||item.route;
        response=await page.goto(new URL(firstRoute,base).href,{waitUntil:'networkidle',timeout:30000});
        if(new URL(page.url()).origin!==base.origin)throw new CaptureError('unexpected_route','cross-origin redirect blocked',{requested:firstRoute,final:page.url()});
        if(!response||response.status()>=400)throw new CaptureError('unexpected_route','main document request failed',{requested:firstRoute,final:page.url(),status:response?.status()??null});
        const before=await checkAssertions(page,state.before,'before');
        const actionResponse=await prepareState(page,state,policy.ownedSelectors||{});
        if(actionResponse)response=actionResponse;
        if(state.setupRoute){response=await page.goto(new URL(item.route,base).href,{waitUntil:'networkidle',timeout:30000});}
        if(new URL(page.url()).origin!==base.origin)throw new CaptureError('unexpected_route','state action left owned preview origin',{requested:item.route,final:page.url()});
        const expectedPath=pathOnly(state.expectedPath||item.route),actualPath=pathOnly(page.url());
        if(actualPath!==expectedPath)throw new CaptureError('unexpected_route','final route does not match capture contract',{requested:item.route,expectedPath,actualPath,final:page.url()});
        const assertions=await checkAssertions(page,state.required,'required');
        await checkAssertions(page,(state.forbidden||[]).map(x=>({...x,minCount:0,maxCount:0})),'forbidden');
        const file=`${safeName(item.page)}.${safeName(viewport.id)}.${safeName(state.id)}.png`;
        const full=path.join(shots,file);
        const scroll=await page.evaluate(()=>({x:scrollX,y:scrollY}));
        await page.screenshot({path:full,fullPage:false,animations:'disabled'});
        normalizeScreenshotRgba(full);
        const cookies=await context.cookies();
        rows.push({page:item.page,route:item.route,final_route:actualPath,main_document_status:response?.status()??null,redirect_chain:redirectChain(response),viewport:viewport.id,state:state.id,path:`screenshots/${file}`,sha256:sha(full),width:viewport.width,height:viewport.height,device_scale_factor:1,scroll,assertions:{before,required:assertions},session_cookie_count:cookies.length,timestamp:new Date().toISOString()});
      }catch(error){
        const diagnosticDir=path.join(root,'diagnostics');fs.mkdirSync(diagnosticDir,{recursive:true});
        const diagnosticName=`${safeName(item.page)}.${safeName(viewport.id)}.${safeName(state.id)}`;
        await page.screenshot({path:path.join(diagnosticDir,`${diagnosticName}.png`),fullPage:false,animations:'disabled'}).catch(()=>{});
        fs.writeFileSync(path.join(diagnosticDir,`${diagnosticName}.json`),JSON.stringify({status:'failed',code:error.code||'capture_failed',message:error.message,details:error.details||{},requested_route:item.route,final_url:page.url(),viewport:viewport.id,state:state.id},null,2)+'\n');
        throw error;
      }
      for(const failure of failures)failedImages.push({page:item.page,viewport:viewport.id,state:state.id,...failure});
      await context.close();
    }
  }finally{await browser.close();}
  const manifest={capture_version:'1',candidate_set_id:crypto.randomUUID(),preview_origin:base.origin,capture_policy_sha256:digest(policyPath),runtime:{browser:'chromium',browser_version:browser.version(),device_scale_factor:1,source_sha:process.env.GITHUB_SHA||process.env.REPLICA_SOURCE_SHA||null,run_id:process.env.GITHUB_RUN_ID||process.env.REPLICA_RUN_ID||null},screenshots:rows,failedImages,missingImages:[],fonts:[],captured_at:new Date().toISOString()};
  const manifestPath=path.join(root,'manifest.json');
  fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  return {status:'captured',candidate_path:root,candidate_manifest_sha:sha(manifestPath),screenshot_count:rows.length};
}

export async function handoffCandidate({capturePolicy,out,baseline,visualPolicy,visualOut}){
  const captured=await captureCandidate({policyFile:capturePolicy,out});
  const report=evaluate({baseline:path.resolve(baseline),candidate:captured.candidate_path,policy:path.resolve(visualPolicy),out:path.resolve(visualOut)});
  const verified=verifyReport(path.resolve(visualOut));
  return {candidate_path:captured.candidate_path,candidate_manifest_sha:captured.candidate_manifest_sha,visual_report_path:path.resolve(visualOut,'reports/visual-report.json'),visual_status:report.overall_status,core_report_sha256:verified.core_report_sha256};
}

function arg(args,name){const i=args.indexOf(name);if(i<0||i+1>=args.length)throw Error(`missing ${name}`);return args[i+1];}
async function main(){
  const args=process.argv.slice(2);
  if(args[0]==='capture'){
    console.log(JSON.stringify(await captureCandidate({policyFile:arg(args,'--policy'),out:arg(args,'--out')}))); return 0;
  }
  if(args[0]==='handoff'){
    const result=await handoffCandidate({capturePolicy:arg(args,'--capture-policy'),out:arg(args,'--candidate-out'),baseline:arg(args,'--baseline'),visualPolicy:arg(args,'--visual-policy'),visualOut:arg(args,'--visual-out')});
    console.log(JSON.stringify(result)); return result.visual_status==='pass'?0:2;
  }
  throw Error('usage: capture --policy FILE --out DIR | handoff --capture-policy FILE --candidate-out DIR --baseline DIR --visual-policy FILE --visual-out DIR');
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url))){
  main().then(code=>{process.exitCode=code;}).catch(err=>{console.error(JSON.stringify({status:'invalid',code:err.code||'capture_invalid',error:err.message,details:err.details||{}}));process.exitCode=3;});
}
