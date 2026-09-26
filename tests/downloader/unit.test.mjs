import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newOutput, safeFile, mapPath, exitCode, policyFor, normalizeUrl, bodyProblem, coreDigest } from '../../tools/downloader/core.mjs';
import { verify } from '../../tools/downloader/verify.mjs';
import { createNetworkGuard, isBlockedAddress, sanitizeUrl } from '../../tools/downloader/network-guard.mjs';

test('query order, case and Windows-reserved names never alias', () => {
  const urls = ['/a?x=1&y=2','/a?y=2&x=1','/a?x=2','/A','/a','/CON','/%E4%B8%AD%20%E6%96%87'];
  const paths = urls.map(x => mapPath('http://127.0.0.1:1234'+x, 'text/css'));
  assert.equal(new Set(paths.map(x => x.toLowerCase())).size, urls.length);
  for (const p of paths) assert.match(p, /^site\/objects\/[a-f0-9]+\.css$/);
});

for(const [name,input]of [
  ['external origin',{url:'http://example.invalid/'}],
  ['implicit loopback port',{url:'http://127.0.0.1/'}],
  ['hostname instead of literal loopback',{url:'http://localhost:8765/'}],
  ['credentialed URL',{url:'http://user:password@127.0.0.1:8765/'}],
  ['sensitive query',{url:'http://127.0.0.1:8765/?token=never-log-this'}],
  ['zero page budget',{url:'http://127.0.0.1:8765/',maxPages:0}],
  ['negative depth',{url:'http://127.0.0.1:8765/',maxDepth:-1}],
  ['invalid viewport',{url:'http://127.0.0.1:8765/',viewports:[{width:0,height:844}]}],
  ['unknown mode',{url:'http://127.0.0.1:8765/',mode:'production'}],
  ['wildcard asset permission',{url:'http://127.0.0.1:8765/',assetOrigins:['*']}],
  ['multiple page origins',{url:'http://127.0.0.1:8765/',pageOrigins:['http://127.0.0.1:8765','http://127.0.0.1:8766']}],
])test('policy rejects '+name,()=>assert.throws(()=>policyFor(input)));

test('URL normalization preserves query order and trailing slash, removes fragments',()=>{
  assert.equal(normalizeUrl('/a/?z=2&z=1#section','http://127.0.0.1:8765'),'http://127.0.0.1:8765/a/?z=2&z=1');
});
test('core digest includes route redirects and localized content, not only raw bodies',()=>{
  const route={url:'http://127.0.0.1:8765/',final_url:'http://127.0.0.1:8765/a',status:'visited'};
  const resource={url:route.url,method:'GET',response_url:route.final_url,mime:'text/html',http_status:200,status:'saved',raw_sha256:'a',local_sha256:'b'};
  const base=coreDigest([route],[resource]);
  assert.notEqual(base,coreDigest([{...route,final_url:route.url}],[resource]));
  assert.notEqual(base,coreDigest([route],[{...resource,local_sha256:'changed'}]));
  assert.notEqual(base,coreDigest([route],[{...resource,redirect_target:route.url}]));
});
for(const [name,body,type,mime,status]of [
  ['HTTP 404',Buffer.from('missing'),'image','image/png',404],
  ['HTML pretending to be JS',Buffer.from('<html>error</html>'),'script','application/javascript',200],
  ['invalid font magic',Buffer.from('not-a-font'),'font','font/ttf',200],
  ['malformed JSON',Buffer.from('{'),'fetch','application/json',200],
  ['CSS MIME mismatch',Buffer.from('body{}'),'stylesheet','text/plain',200],
])test('body verification rejects '+name,()=>assert.ok(bodyProblem(body,type,mime,status)));
test('never reuse a user directory; reject traversal and linked ancestors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'downloader-test-'));
  try {
    assert.throws(() => newOutput(root));
    const run = newOutput(path.join(root, 'new'));
    assert.throws(() => safeFile(run,'../escape'));
    assert.throws(() => safeFile(run,'site/../../escape'));
    const target = path.join(root,'target'); fs.mkdirSync(target);
    fs.symlinkSync(target,path.join(root,'link'),'junction');
    assert.throws(() => newOutput(path.join(root,'link','escape')));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('empty evidence and internal failure cannot pass', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'downloader-test-'));
  try {
    fs.writeFileSync(path.join(root,'manifest.json'),'{}');
    assert.equal(verify(root).status,'failed');
    assert.equal(exitCode('complete'),0);
    for (const state of ['partial','failed','blocked','unknown']) assert.notEqual(exitCode(state),0);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});


test('authorized-public policy requires explicit HTTPS origins',()=>{
  assert.throws(()=>policyFor({mode:'authorized-public',url:'https://public.test/'}));
  assert.throws(()=>policyFor({mode:'authorized-public',url:'http://public.test/',pageOrigins:['http://public.test'],assetOrigins:['http://public.test']}));
  assert.throws(()=>policyFor({mode:'authorized-public',url:'https://public.test/',pageOrigins:['https://public.test'],assetOrigins:['*']}));
  const p=policyFor({mode:'authorized-public',url:'https://public.test/',pageOrigins:['https://public.test'],assetOrigins:['https://public.test'],publicGetFixtures:['https://public.test/data.json']});
  assert.equal(p.mode,'authorized-public');assert.equal(p.maxRedirects,10);
});
test('public address guard rejects required private IPv4 and IPv6 ranges',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.1.2.3','::1','::','fc00::1','fd00::1','fe80::1','::ffff:127.0.0.1'])assert.equal(isBlockedAddress(ip),true,ip);
  assert.equal(isBlockedAddress('203.0.113.10'),false);
  assert.equal(isBlockedAddress('2001:4860:4860::8888'),false);
});
test('DNS private resolution and rebinding are blocked on every inspection',async()=>{
  const policy=policyFor({mode:'authorized-public',url:'https://public.test/',pageOrigins:['https://public.test'],assetOrigins:['https://public.test']});
  let calls=0;
  const guard=createNetworkGuard(policy,[],{resolver:async()=>[{address:++calls===1?'203.0.113.10':'10.0.0.9',family:4}]});
  assert.equal((await guard.inspect('https://public.test/',{kind:'page'})).allowed,true);
  const second=await guard.inspect('https://public.test/next',{kind:'page'});
  assert.equal(second.allowed,false);assert.equal(second.reason,'private_address');
});
test('unknown public origin needs approval and write methods are blocked',async()=>{
  const policy=policyFor({mode:'authorized-public',url:'https://public.test/',pageOrigins:['https://public.test'],assetOrigins:['https://public.test']});
  const resolver=async()=>[{address:'203.0.113.10',family:4}];
  const guard=createNetworkGuard(policy,[],{resolver});
  const cdn=await guard.inspect('https://cdn.test/a.js',{kind:'asset',resourceType:'script',firstSeenPage:'https://public.test/'});
  assert.equal(cdn.reason,'needs_approval');assert.equal(cdn.origin,'https://cdn.test');
  const post=await guard.inspect('https://public.test/write',{kind:'asset',method:'POST',resourceType:'fetch',firstSeenPage:'https://public.test/'});
  assert.equal(post.reason,'blocked_business_request');
});
test('public URL sanitization removes configured query values',()=>{
  assert.equal(sanitizeUrl('https://public.test/a?x=1&canary=SECRET_CANARY_QUERY',['canary']),'https://public.test/a?x=1&canary=%3Credacted%3E');
  assert.equal(exitCode('exhausted'),4);
});
