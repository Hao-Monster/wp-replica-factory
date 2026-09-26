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
const load=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const digest=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

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
    for(const state of item.states)if(!ALLOWED_STATES.has(state))throw Error('unsupported candidate state');
  }
  const ids=new Set();
  for(const viewport of policy.viewports){
    if(!ident(viewport.id)||ids.has(viewport.id))throw Error('invalid or duplicate viewport');
    ids.add(viewport.id);
    for(const key of ['width','height'])if(!Number.isInteger(viewport[key])||viewport[key]<1||viewport[key]>4000)throw Error('invalid viewport');
  }
  const hooks=policy.ownedSelectors||{};
  if(policy.routes.some(x=>x.states.includes('menu-open'))&&!ownedSelector(hooks.menuToggle))throw Error('menu-open requires controlled selector');
  if(policy.routes.some(x=>x.states.includes('cart-nonempty'))&&!ownedSelector(hooks.addFixture))throw Error('cart-nonempty requires controlled selector');
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

async function prepareState(page,state,hooks){
  if(state==='default')return;
  const chosen=state==='menu-open'?hooks.menuToggle:hooks.addFixture;
  const loc=page.locator(chosen);
  if(await loc.count()!==1)throw Error(`controlled state selector missing or ambiguous: ${state}`);
  await loc.click();
  await page.waitForLoadState('networkidle',{timeout:3000}).catch(()=>{});
  await page.waitForTimeout(80);
}

export async function captureCandidate({policyFile,out}){
  const policyPath=path.resolve(policyFile);
  const {policy,base}=validatePolicy(load(policyPath));
  const root=path.resolve(out),shots=path.join(root,'screenshots');
  fs.rmSync(root,{recursive:true,force:true}); fs.mkdirSync(shots,{recursive:true});
  const browser=await chromium.launch({headless:true});
  const rows=[],failedImages=[];
  try{
    for(const item of policy.routes)for(const viewport of policy.viewports)for(const state of item.states){
      const context=await browser.newContext({viewport:{width:viewport.width,height:viewport.height},deviceScaleFactor:1,serviceWorkers:'block'});
      const page=await context.newPage(),failures=[];
      page.on('requestfailed',req=>{if(req.resourceType()==='image')failures.push({url:req.url(),reason:req.failure()?.errorText||'requestfailed'});});
      page.on('response',resp=>{if(resp.request().resourceType()==='image'&&resp.status()>=400)failures.push({url:resp.url(),status:resp.status()});});
      await page.route('**/*',async route=>{
        const u=new URL(route.request().url());
        if(['data:','blob:'].includes(u.protocol)||u.origin===base.origin)return route.continue();
        return route.abort('blockedbyclient');
      });
      await page.goto(new URL(item.route,base).href,{waitUntil:'networkidle',timeout:30000});
      if(new URL(page.url()).origin!==base.origin)throw Error('cross-origin redirect blocked');
      await prepareState(page,state,policy.ownedSelectors||{});
      if(new URL(page.url()).origin!==base.origin)throw Error('state action left owned preview origin');
      const file=`${safeName(item.page)}.${safeName(viewport.id)}.${safeName(state)}.png`;
      const full=path.join(shots,file);
      await page.screenshot({path:full,fullPage:false,animations:'disabled'});
      normalizeScreenshotRgba(full);
      rows.push({page:item.page,route:item.route,viewport:viewport.id,state,path:`screenshots/${file}`,sha256:sha(full),width:viewport.width,height:viewport.height,timestamp:new Date().toISOString()});
      for(const failure of failures)failedImages.push({page:item.page,viewport:viewport.id,state,...failure});
      await context.close();
    }
  }finally{await browser.close();}
  const manifest={capture_version:'1',candidate_set_id:crypto.randomUUID(),preview_origin:base.origin,capture_policy_sha256:digest(policyPath),screenshots:rows,failedImages,missingImages:[],fonts:[],captured_at:new Date().toISOString()};
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
  main().then(code=>{process.exitCode=code;}).catch(err=>{console.error(JSON.stringify({status:'invalid',error:err.message}));process.exitCode=3;});
}
