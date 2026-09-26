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
import { verifyBrowser } from '../../tools/downloader/preview.mjs';
import { guardedProxy } from '../../tools/downloader/network-guard.mjs';

const bucket=path.join(ROOT,'.replica/downloads/public-mvp-'+new Date().toISOString().replaceAll(':','-')+'-'+process.pid);
fs.mkdirSync(bucket,{recursive:true});
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'replica-public-mvp-'));
const key=path.join(tmp,'key.pem'),cert=path.join(tmp,'cert.pem');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=public.test','-addext','subjectAltName=DNS:public.test,DNS:cdn.test,DNS:private.test'],{stdio:'ignore'});

const counters={requests:0,post:0,private:0,cdn:0};
let port=0;
const server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{
  counters.requests++;
  const host=String(req.headers.host||'').split(':')[0];
  if(host==='private.test')counters.private++;
  if(host==='cdn.test')counters.cdn++;
  if(req.method==='POST'){counters.post++;res.writeHead(200,{'content-type':'application/json'}).end('{"ok":true}');return;}
  const u=new URL(req.url,'https://'+(req.headers.host||'public.test'));
  if(u.pathname==='/redirect-private'){res.writeHead(302,{Location:`https://private.test:${port}/sink`}).end();return;}
  if(u.pathname==='/redirect-unapproved'){res.writeHead(302,{Location:`https://cdn.test:${port}/landing`}).end();return;}
  if(u.pathname==='/style.css'){res.writeHead(200,{'content-type':'text/css'}).end('body{font-family:sans-serif}');return;}
  if(u.pathname==='/big.js'){const body='/*'+('x'.repeat(5000))+'*/';res.writeHead(200,{'content-type':'application/javascript','content-length':Buffer.byteLength(body)}).end(body);return;}
  if(u.pathname==='/data.json'){res.writeHead(200,{'content-type':'application/json'}).end('{"fixture":"public-readonly"}');return;}
  if(u.pathname==='/second'){res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>Second</title><h1>Second page</h1><a href="/">Home</a>');return;}
  if(u.pathname==='/unknown'){res.writeHead(200,{'content-type':'text/html'}).end(`<!doctype html><title>Unknown CDN</title><script src="https://cdn.test:${port}/cdn.js"></script><h1>Unknown</h1>`);return;}
  if(u.pathname==='/post'){res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>Post</title><h1>Post</h1><script>fetch("/write",{method:"POST",body:"x"}).catch(()=>{})</script>');return;}
  if(u.pathname==='/login'){res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>Login</title><h1>Login</h1><input type="password">');return;}
  if(u.pathname==='/big'){res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>Big</title><h1>Big</h1><script src="/big.js"></script>');return;}
  if(host==='cdn.test'){res.writeHead(200,{'content-type':'application/javascript'}).end('window.cdnLoaded=true');return;}
  res.writeHead(200,{'content-type':'text/html','set-cookie':'sid=SECRET_CANARY_COOKIE; Secure; SameSite=Lax'}).end(
    '<!doctype html><title>Public MVP</title><link rel="stylesheet" href="/style.css"><h1>Public MVP</h1><a href="/second?b=2&a=1#frag">Second</a><button id="load-json">Load JSON</button>'+
    '<script>document.querySelector("#load-json").addEventListener("click",()=>fetch("/data.json?canary=SECRET_CANARY_QUERY",{headers:{Authorization:"SECRET_CANARY_AUTH"}}).catch(()=>{}))</script>'
  );
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{port=server.address().port;resolve();});});
const origin=`https://public.test:${port}`;
const publicIp='93.184.216.34';
const publicResolver=async hostname=>{
  const h=String(hostname).toLowerCase();
  if(h==='private.test')return [{address:'10.0.0.9',family:4}];
  return [{address:publicIp,family:4}];
};
const dial=()=>net.connect({host:'127.0.0.1',port});
const policy=(url=origin+'/',extra={})=>({
  mode:'authorized-public',url,pageOrigins:[origin],assetOrigins:[origin],publicGetFixtures:[origin+'/data.json?canary=SECRET_CANARY_QUERY'],
  maxPages:25,maxDepth:2,maxResources:2000,maxBytes:26214400,maxTotalBytes:157286400,budgetMs:180000,timeoutMs:15000,maxRedirects:10,
  viewports:[{width:1440,height:1000},{width:390,height:844}],states:[{name:'load-json',path:'/',actions:[{type:'click',selector:'#load-json'}]}],har:true,sensitiveQueryKeys:['canary','token','session'],...extra
});
const run=async(name,p=policy(),network={resolver:publicResolver,dial})=>{
  const dir=path.join(bucket,name);
  const result=await download(p,dir,{network,ignoreHTTPSErrors:true});
  return {dir,manifest:result.manifest};
};
const connectStatus=(proxyUrl,target)=>new Promise((resolve,reject)=>{
  const p=new URL(proxyUrl),socket=net.connect({host:'127.0.0.1',port:Number(p.port)},()=>socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  let data='';const timer=setTimeout(()=>{socket.destroy();reject(new Error('CONNECT timeout'));},5000);
  socket.on('data',chunk=>{data+=chunk.toString('latin1');if(data.includes('\r\n\r\n')){clearTimeout(timer);const m=data.match(/^HTTP\/1\.1 (\d+)/);socket.destroy();resolve(Number(m?.[1]||0));}});
  socket.on('error',reject);
});

const report={schema:1,status:'running',origin,checks:[]};
const check=(id,evidence={})=>{report.checks.push({id,status:'passed',...evidence});console.log('PASS '+id);};

try {
  const first=await run('positive-1');assert.equal(first.manifest.status,'complete',JSON.stringify(first.manifest.failures));
  assert.equal(verify(first.dir).status,'complete');assert.equal(first.manifest.counts.visited,2);
  assert.deepEqual(readJSON(first.dir,'routes.json').routes.filter(r=>r.status==='visited').map(r=>new URL(r.url).pathname).sort(),['/','/second']);
  assert.ok(readJSON(first.dir,'resources.json').resources.some(r=>r.url.includes('/data.json?canary=')&&r.status==='saved'));
  check('https-positive-seed-discovery-approved-json',{pages:first.manifest.counts.visited,resources:first.manifest.counts.saved_resources});

  const second=await run('positive-2');assert.equal(second.manifest.status,'complete');
  const comparison=compareRuns(first.dir,second.dir);assert.equal(comparison.equal,true);check('repeat-compare',{sha:comparison.first_sha256});

  await new Promise(resolve=>server.close(resolve));
  await assert.rejects(new Promise((resolve,reject)=>{const s=net.connect({host:'127.0.0.1',port},()=>{s.destroy();resolve();});s.once('error',reject);}));
  const preview=await verifyBrowser(first.dir,[]);assert.equal(preview.status,'complete',JSON.stringify(preview.failures));
  assert.ok(preview.requests.every(r=>new URL(r.url).origin===preview.origin));
  check('offline-preview',{pages:preview.pages.length,requests:preview.requests.length,failures:preview.failures.length});

  // Restart the same controlled HTTPS server for negative cases.
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});

  let privateDials=0;
  const privateGuard=await guardedProxy(policy(),[],{resolver:async()=>[{address:'10.0.0.1',family:4}],dial:()=>{privateDials++;return dial();}});
  assert.equal(await connectStatus(privateGuard.url,`public.test:${port}`),403);assert.equal(privateDials,0);await privateGuard.close();
  check('dns-private-blocked',{sink_hits:privateDials});

  let v6Dials=0;
  const v6Guard=await guardedProxy(policy(),[],{resolver:async()=>[{address:'::1',family:6}],dial:()=>{v6Dials++;return dial();}});
  assert.equal(await connectStatus(v6Guard.url,`public.test:${port}`),403);assert.equal(v6Dials,0);await v6Guard.close();
  check('ipv6-loopback-blocked',{sink_hits:v6Dials});

  let resolveCalls=0,rebindDials=0;
  const rebind=await guardedProxy(policy(),[],{resolver:async()=>[{address:++resolveCalls===1?publicIp:'10.0.0.9',family:4}],dial:()=>{rebindDials++;return dial();}});
  assert.equal(await connectStatus(rebind.url,`public.test:${port}`),200);
  assert.equal(await connectStatus(rebind.url,`public.test:${port}`),403);
  assert.equal(rebindDials,1);await rebind.close();check('dns-rebinding-second-connect-blocked',{resolve_calls:resolveCalls,sink_hits:rebindDials});

  counters.private=0;
  const redirPrivate=await run('redirect-private',policy(origin+'/redirect-private'));
  assert.equal(redirPrivate.manifest.status,'blocked');assert.equal(counters.private,0);check('redirect-private-blocked',{sink_hits:counters.private});

  const redirPublic=await run('redirect-unapproved',policy(origin+'/redirect-unapproved'));
  assert.equal(redirPublic.manifest.status,'partial');assert.ok(redirPublic.manifest.failures.some(f=>f.reason==='needs_approval'));check('redirect-unapproved-public',{status:redirPublic.manifest.status});

  const unknown=await run('unknown-cdn',policy(origin+'/unknown'));
  assert.equal(unknown.manifest.status,'partial');assert.ok(unknown.manifest.failures.some(f=>f.reason==='needs_approval'&&f.origin?.startsWith('https://cdn.test:')));
  check('unknown-cdn-needs-approval',{status:unknown.manifest.status});

  counters.post=0;
  const post=await run('post',policy(origin+'/post'));assert.equal(post.manifest.status,'blocked');assert.equal(counters.post,0);
  check('post-blocked-before-send',{sink_hits:counters.post});

  const login=await run('login',policy(origin+'/login'));assert.equal(login.manifest.status,'blocked');check('login-challenge-blocked',{status:login.manifest.status});

  const pages=await run('max-pages',policy(origin+'/',{maxPages:1,har:false}));assert.equal(pages.manifest.status,'exhausted');check('max-pages-exhausted',{exit_code:exitCode(pages.manifest.status)});
  const bytes=await run('max-bytes',policy(origin+'/big',{maxBytes:1024,har:false}));assert.equal(bytes.manifest.status,'exhausted');check('max-bytes-exhausted',{exit_code:exitCode(bytes.manifest.status)});

  const sanitized=fs.readFileSync(path.join(first.dir,'reports/network-sanitized.json'),'utf8');
  assert.equal(sanitized.includes('SECRET_CANARY_'),false);check('sanitized-canary-scan',{occurrences:0});

  report.status='complete';report.run=first.dir;report.repeat_run=second.dir;report.core_sha256=first.manifest.core_sha256;
  report.results={dns_private_sink_hits:privateDials,dns_rebinding_dial_hits:rebindDials,redirect_private_sink_hits:counters.private,post_sink_hits:counters.post,unknown_cdn:'partial/needs_approval',offline_preview:{pages:preview.pages.length,requests:preview.requests.length,failures:preview.failures.length}};
} catch(error) {
  report.status='failed';report.error=error.stack||error.message;console.error(report.error);process.exitCode=1;
} finally {
  if(server.listening)await new Promise(resolve=>server.close(resolve));
  fs.writeFileSync(path.join(ROOT,'.replica/public-mvp-acceptance.json'),json(report));
  fs.rmSync(tmp,{recursive:true,force:true});
  console.log(json({status:report.status,checks:report.checks.length,report:path.join(ROOT,'.replica/public-mvp-acceptance.json')}));
}
