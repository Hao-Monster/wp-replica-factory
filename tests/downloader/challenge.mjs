import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, readJSON, json, exitCode } from '../../tools/downloader/core.mjs';
import { download } from '../../tools/downloader/download.mjs';
import { verify, compareRuns } from '../../tools/downloader/verify.mjs';
import { serve } from '../../tools/downloader/preview.mjs';
import { guardedProxy } from '../../tools/downloader/network-guard.mjs';

const bucket=path.join(ROOT,'.replica/downloads/challenge-'+new Date().toISOString().replaceAll(':','-')+'-'+process.pid);
fs.mkdirSync(bucket,{recursive:true});
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'replica-challenge-'));
const key=path.join(tmp,'key.pem'),cert=path.join(tmp,'cert.pem');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=public.test','-addext','subjectAltName=DNS:public.test,DNS:cdn.test,DNS:private.test'],{stdio:'ignore'});


const hits={follow:0,action:0};
let port;
const server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{
 const url=new URL(req.url,'https://public.test');
 if(url.pathname==='/follow'){hits.follow++;}
 if(url.pathname==='/action'){hits.action++;}
 if(url.pathname==='/awswaf/challenge.js'){res.writeHead(200,{'content-type':'application/javascript'}).end('');return;}
 const cases={
  normal:'<title>Normal</title><h1>Content</h1><script>throw new Error("example page error SECRET_CANARY_RUNTIME")</script>',
  console:'<title>Normal</title><h1>Content</h1><script>console.error("SECRET_CANARY_CONSOLE")</script>',
  blog:'<title>How AWS WAF CAPTCHA works</title><article>AWS WAF captcha bot. Sign in and MFA explained.</article>',
  erroronly:'<title>Normal</title><h1>Content</h1><script>AwsWafIntegration.run()</script>',
  bot:'<title>Verify you are human</title><main id="challenge">Please verify you are human</main>',
  aws:'<title>Verify you are human</title><main id="challenge">Checking your browser</main><script src="/awswaf/challenge.js"></script><script>AwsWafIntegration.run()</script>',
  password:'<title>Protected</title><input type="password">',
  login:'<title>Sign in</title><form><input name="username" autocomplete="username"><button>Sign in</button></form>',
  captcha:'<title>CAPTCHA verification</title><div class="g-recaptcha" data-sitekey="SECRET_CANARY_SITEKEY"></div>',
  mfa:'<title>Two-factor authentication</title><input autocomplete="one-time-code">',
  denied:'<title>Access denied</title><p>Access denied</p>',
  rate:'<title>Too many requests</title><p>Try later</p>',
  aws403:'<title>Verify you are human</title><main id="challenge">Checking your browser</main><script src="/awswaf/challenge.js"></script><script>AwsWafIntegration.run()</script>',
  delayed:'<title>Loading</title><script>setTimeout(()=>{document.title="Verify you are human";document.body.innerHTML="<main id=challenge>Checking your browser</main>"},100)</script>'
 };
 const name=url.pathname.slice(1);
 res.writeHead(name==='denied'||name==='aws403'?403:name==='rate'?429:200,{'content-type':'text/html','set-cookie':'session=SECRET_CANARY_COOKIE'});
 res.end('<!doctype html>'+cases[name]+'<a href="/follow">Next</a><button id="action" onclick="fetch(\'/action\')">Action</button>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>{port=server.address().port;resolve();}));
const origin=`https://public.test:${port}`;
const report={schema:1,status:'running',checks:[],diagnostics:[]};
try {
 for(const [name,kind] of Object.entries({normal:null,console:null,blog:null,erroronly:null,bot:'waf_bot_challenge',aws:'waf_bot_challenge',password:'password',login:'login',captcha:'captcha',mfa:'mfa',denied:'access_denied',rate:'rate_limited',aws403:'waf_bot_challenge',delayed:'waf_bot_challenge'})){
  hits.follow=0;hits.action=0;
  const dir=path.join(bucket,name);
  const policy={mode:'authorized-public',url:origin+'/'+name,pageOrigins:[origin],assetOrigins:[origin],viewports:[{width:1440,height:1000},{width:390,height:844}],states:kind?[{name:'action',actions:[{type:'click',selector:'#action'}]}]:[],maxPages:3,budgetMs:30000,timeoutMs:5000};
  const {manifest:m}=await download(policy,dir,{ignoreHTTPSErrors:true,network:{resolver:async()=>[{address:'93.184.216.34',family:4}],dial:()=>net.connect({host:'127.0.0.1',port})}});
  if(kind){
   assert.equal(m.status,'blocked',name+JSON.stringify(m.failures));
   assert.equal(m.reason,'challenge_detected');assert.equal(m.challenge.kind,kind);
   assert.equal(exitCode(m.status),3);assert.equal(hits.follow,0);assert.equal(hits.action,0);
   assert.equal(m.captures.length,0);
   assert.equal(verify(dir).status,'failed');
   await assert.rejects(serve(dir),/blocked|invalid/);
   assert.equal(m.failures.some(f=>f.reason==='capture_runtime'),false);
   if(name==='aws'||name==='aws403')assert.equal(m.challenge.vendor,'aws-waf');
   const diagnostic=readJSON(dir,'reports/challenge.json');report.diagnostics.push(diagnostic);
  }else{
   assert.equal(m.status,'complete',name+JSON.stringify(m.failures));assert.equal(verify(dir).status,'complete');
   assert.equal(m.challenge.detected,false);
  }
  if(['normal','erroronly','console','aws','aws403'].includes(name)){
   assert.ok(m.pageRuntimeErrors.length>0,name);
   if(kind)assert.ok(m.pageRuntimeErrors.length>=1,name);
  }
  for(const filename of ['manifest.json','reports/page-runtime-errors.json','reports/download.json'])assert.equal(fs.readFileSync(path.join(dir,filename),'utf8').includes('SECRET_CANARY_'),false,filename);
  if(kind) assert.equal(fs.readFileSync(path.join(dir,'reports/challenge.json'),'utf8').includes('SECRET_CANARY_'),false);
  report.checks.push({id:name,status:'passed',result:m.status,kind:m.challenge.kind||null,runtime_errors:m.pageRuntimeErrors.length});console.log('PASS '+name);
 }
 report.status='complete';
}finally{
 await new Promise(resolve=>server.close(resolve));fs.rmSync(tmp,{recursive:true,force:true});
 fs.writeFileSync(path.join(ROOT,'.replica/challenge-acceptance.json'),json(report));
}
