#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT, exitCode, json, put } from './core.mjs';
import { download } from './download.mjs';
import { verify, compareRuns } from './verify.mjs';
import { serve, openIsolated, verifyBrowser } from './preview.mjs';

try {
  const {positionals,values}=parseArgs({allowPositionals:true,options:{url:{type:'string'},out:{type:'string'},policy:{type:'string'},'max-pages':{type:'string'},'max-depth':{type:'string'},'page-origin':{type:'string',multiple:true},'asset-origin':{type:'string',multiple:true},'public-get':{type:'string',multiple:true},viewport:{type:'string',multiple:true},timeout:{type:'string'},budget:{type:'string'},har:{type:'boolean'},mode:{type:'string'},browser:{type:'boolean'},checks:{type:'string'},port:{type:'string'},open:{type:'boolean'},help:{type:'boolean'}}});
  const command=positionals[0];
  if(values.help||!command){console.log('download --url URL --policy POLICY.json [--out NEW-DIR] [--har]\nverify RUN-DIR [--browser --checks CHECKS.json]\npreview RUN-DIR [--port 8124 --open]\ncompare RUN-1 RUN-2\nOptions: --max-pages 25 --max-depth 2 --viewport 1440x1000 --timeout 15000 --budget 180000\nExplicit origins: --page-origin ORIGIN --asset-origin ORIGIN --public-get URL\nOnly owned-fixture is executable; authorized-public is blocked.');}
  else if(command==='download') {
    const policy=values.policy?JSON.parse(fs.readFileSync(values.policy,'utf8')):{};
    for(const key of ['url','mode','har'])if(values[key]!==undefined)policy[key]=values[key];
    for(const [flag,key]of Object.entries({'max-pages':'maxPages','max-depth':'maxDepth',timeout:'timeoutMs',budget:'budgetMs'}))if(values[flag]!==undefined)policy[key]=Number(values[flag]);
    for(const [flag,key]of Object.entries({'page-origin':'pageOrigins','asset-origin':'assetOrigins','public-get':'publicGetFixtures'}))if(values[flag])policy[key]=values[flag];
    if(values.viewport)policy.viewports=values.viewport.map(v=>{const [width,height]=v.split('x').map(Number);return {width,height};});
    const out=values.out||path.join(ROOT,'.replica/downloads',new Date().toISOString().replaceAll(':','-')+'-'+Math.random().toString(16).slice(2,8));
    const {root,manifest}=await download(policy,out);
    const validation=verify(root);put(root,'reports/verify.json',json(validation));
    console.log(json({root,status:manifest.status,counts:manifest.counts,core_sha256:manifest.core_sha256,validation}));
    process.exitCode=manifest.status==='complete'&&validation.status!=='complete'?1:exitCode(manifest.status);
  } else if(command==='verify') {
    if(!positionals[1])throw new Error('RUN-DIR required');
    const root=path.resolve(positionals[1]);
    const checks=values.checks?JSON.parse(fs.readFileSync(values.checks,'utf8')):[];
    const result=values.browser?await verifyBrowser(root,checks):verify(root);
    console.log(json(result));process.exitCode=exitCode(result.status);
  } else if(command==='compare') {
    if(!positionals[1]||!positionals[2])throw new Error('two run directories required');
    const result=compareRuns(positionals[1],positionals[2]);console.log(json(result));process.exitCode=exitCode(result.status);
  } else if(command==='preview') {
    if(!positionals[1])throw new Error('RUN-DIR required');
    const root=path.resolve(positionals[1]);const server=await serve(root,Number(values.port||8124));
    const isolated=values.open?await openIsolated(root,server):null;
    console.log(json({origin:server.origin,entry:server.origin+server.entry,serves:'site/ only',browser:isolated?'new isolated Chromium':'not launched; use --open for an isolated browser',proxy_to_source:false}));
    let stopping=false;
    const stop=async()=>{if(stopping)return;stopping=true;if(isolated)await isolated.close();await server.close();};
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
  } else throw new Error('unknown command');
} catch(error) {console.error(json({status:'failed',error:error.message}));process.exitCode=1;}
