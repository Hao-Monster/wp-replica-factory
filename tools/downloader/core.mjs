import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SCHEMA = 'replica-downloader/v0.1';
export const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export const exitCode = status => ({complete:0, partial:2, failed:1, blocked:3, exhausted:4}[status] ?? 1);
export const json = value => JSON.stringify(value, null, 2)+'\n';

export function noLinks(value) {
  const full = path.resolve(value);
  let current = path.parse(full).root;
  for (const segment of full.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('linked path refused: '+current);
  }
  return full;
}
export function newOutput(value) {
  const full = noLinks(value);
  if (fs.existsSync(full)) throw new Error('output must be a NEW dedicated directory');
  fs.mkdirSync(path.dirname(full), {recursive:true});
  fs.mkdirSync(full);
  fs.writeFileSync(path.join(full,'.downloader-owned'),SCHEMA+'\n',{flag:'wx'});
  for (const dir of ['raw','pages','site/objects','reports','network']) fs.mkdirSync(path.join(full,dir),{recursive:true});
  return full;
}
export function safeFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || relative.includes('\0') || path.posix.isAbsolute(relative) || relative.split('/').some(x=>x==='..'||x==='.'||!x)) throw new Error('unsafe relative path');
  const base = noLinks(root), full = noLinks(path.join(base,...relative.split('/')));
  if (!full.startsWith(base+path.sep)) throw new Error('path escaped output');
  return full;
}
export function put(root, relative, content, immutable=false) {
  const file = safeFile(root, relative);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if (immutable && fs.existsSync(file)) {
    if (sha(fs.readFileSync(file)) !== sha(content)) throw new Error('immutable evidence collision');
    return;
  }
  fs.writeFileSync(file,content,{flag:immutable?'wx':'w'});
}
export const readJSON = (root, name) => JSON.parse(fs.readFileSync(safeFile(root,name),'utf8'));
export function adapterFingerprint() {
  const directory=path.join(ROOT,'tools/downloader'),entries=[];
  function walk(dir) {
    for(const name of fs.readdirSync(dir).sort()) {
      if(name==='node_modules')continue;
      const p=path.join(dir,name),stat=fs.lstatSync(p);
      if(stat.isDirectory())walk(p);
      else if(name.endsWith('.mjs')||['package.json','package-lock.json'].includes(name))entries.push([path.relative(directory,p).split(path.sep).join('/'),sha(fs.readFileSync(p))]);
    }
  }
  walk(directory);return sha(JSON.stringify(entries));
}
export function extension(mime) {
  const m=mime.split(';')[0].trim().toLowerCase();
  return ({'text/html':'html','text/css':'css','application/javascript':'js','text/javascript':'js','application/json':'json','image/svg+xml':'svg','image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif','font/ttf':'ttf','application/x-font-ttf':'ttf','font/otf':'otf','font/woff':'woff','font/woff2':'woff2','application/font-woff':'woff','application/wasm':'wasm','image/x-icon':'ico'})[m] || 'bin';
}
export const mapPath = (url,mime,body='') => `site/objects/${sha(url+'\0'+body)}.${extension(mime)}`;
export function normalizeUrl(raw, base) {
  const u = new URL(raw,base);
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password) throw new Error('invalid or credentialed URL');
  if ([...u.searchParams.keys()].some(k=>/^(token|access_token|api_key|password|secret|authorization|session|cookie)$/i.test(k))) throw new Error('sensitive URL refused');
  u.hash=''; // Query order and trailing slash are deliberately preserved.
  return u.href;
}
export function policyFor(input) {
  if(!input||typeof input!=='object')throw new Error('policy must be an object');
  const mode=input.mode??'owned-fixture';
  if (!['owned-fixture','authorized-public'].includes(mode)) throw new Error('unknown mode');
  const publicExplicit=mode==='authorized-public';
  if(publicExplicit&&(!Array.isArray(input.pageOrigins)||!input.pageOrigins.length||!Array.isArray(input.assetOrigins)||!input.assetOrigins.length)) throw new Error('authorized-public requires explicit pageOrigins and assetOrigins');
  const p={mode,maxPages:25,maxDepth:2,timeoutMs:15000,budgetMs:180000,maxBytes:25*1024*1024,maxTotalBytes:150*1024*1024,maxResources:2000,maxRedirects:10,scrollStep:700,maxScrollSteps:80,settleMs:250,har:false,viewports:[{width:1440,height:1000}],states:[],publicGetFixtures:[],sensitiveQueryKeys:['token','access_token','api_key','password','secret','authorization','session','cookie'],...input};
  p.url=normalizeUrl(p.url);
  p.pageOrigins=p.pageOrigins ?? [new URL(p.url).origin];
  p.assetOrigins=p.assetOrigins ?? [...p.pageOrigins];
  for (const key of ['maxPages','timeoutMs','budgetMs','maxBytes','maxTotalBytes','maxResources','maxRedirects','scrollStep','maxScrollSteps']) if (!Number.isSafeInteger(p[key])||p[key]<1) throw new Error('invalid '+key);
  if (!Number.isSafeInteger(p.maxDepth)||p.maxDepth<0||!Number.isSafeInteger(p.settleMs)||p.settleMs<0) throw new Error('invalid depth or settle');
  if (!Array.isArray(p.viewports)||!p.viewports.length||p.viewports.some(v=>!Number.isSafeInteger(v.width)||!Number.isSafeInteger(v.height)||v.width<100||v.height<100||v.width>4096||v.height>4096)) throw new Error('invalid viewports');
  if(!Array.isArray(p.sensitiveQueryKeys)||p.sensitiveQueryKeys.some(x=>typeof x!=='string'||!x))throw new Error('invalid sensitiveQueryKeys');
  p.sensitiveQueryKeys=[...new Set(p.sensitiveQueryKeys.map(x=>x.toLowerCase()))];
  for (const list of [p.pageOrigins,p.assetOrigins]) {
    if (!Array.isArray(list)||!list.length) throw new Error('explicit origins required');
    for (const raw of list) {
      if(raw==='*')throw new Error('wildcard origins are forbidden');
      const u=new URL(raw);
      if (raw!==u.origin || u.username || u.password) throw new Error('allowlist entries must be exact origins');
      if (p.mode==='owned-fixture' && (u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port)) throw new Error('owned-fixture requires explicit http://127.0.0.1:port origins');
      if (p.mode==='authorized-public' && u.protocol!=='https:') throw new Error('authorized-public origins must use https');
    }
  }
  const entryOrigin=new URL(p.url).origin;
  if (!p.pageOrigins.includes(entryOrigin)) throw new Error('entry outside page allowlist');
  if (p.pageOrigins.length!==1||p.pageOrigins[0]!==entryOrigin) throw new Error('one exact page origin is required');
  if(p.mode==='authorized-public'&&new URL(p.url).protocol!=='https:')throw new Error('authorized-public entry must use https');
  if (!Array.isArray(p.publicGetFixtures)) throw new Error('publicGetFixtures must be an array');
  p.publicGetFixtures=p.publicGetFixtures.map(u=>normalizeUrl(u,p.url));
  if(p.mode==='authorized-public'&&p.publicGetFixtures.some(u=>new URL(u).protocol!=='https:'||!p.assetOrigins.includes(new URL(u).origin)))throw new Error('publicGetFixtures must be exact HTTPS URLs on approved asset origins');
  if (p.required_states && !Array.isArray(p.required_states)) throw new Error('required_states must be an array');
  if (Array.isArray(p.states)) for (const s of p.states) if (!s.name && s.state_id) s.name = s.state_id;
  if (!Array.isArray(p.states)||p.states.some(s=>!s.name||!Array.isArray(s.actions)||s.actions.some(a=>!['scroll','hover','click'].includes(a.type)||((a.type!=='scroll')&&!a.selector)))) throw new Error('invalid approved state operations');
  return p;
}
export function resourceKind(type,mime) {
  if(type==='document') return 'html';
  if(mime.includes('json')) return 'json';
  if(type==='script'||mime.includes('javascript')) return 'js';
  return ({stylesheet:'css',image:'image',font:'font',media:'media'})[type] || 'other';
}
export function bodyProblem(body,type,mime,status) {
  if(status<200||status>=300) return 'http_'+status;
  if(!body.length) return 'empty_body';
  const m=mime.toLowerCase(), head=body.subarray(0,512).toString('utf8').trim();
  if(type==='stylesheet'&&!m.includes('text/css')) return 'stylesheet_mime';
  if(type==='script'&&!/javascript|ecmascript/.test(m)) return 'script_mime';
  if(type==='document'&&!m.includes('text/html')) return 'document_mime';
  if(type!=='document'&&(/^<!doctype html|^<html/i.test(head)||m.includes('text/html'))) return 'html_instead_of_resource';
  if(type==='image'&&!m.startsWith('image/')) return 'image_mime';
  if(m.includes('svg')&&!/<svg[\s>]/i.test(head)) return 'corrupt_svg';
  if(m.includes('json')) { try{ JSON.parse(body.toString('utf8')); } catch { return 'corrupt_json'; } }
  if(type==='font' && !['00010000','4f54544f','774f4646','774f4632','74746366'].includes(body.subarray(0,4).toString('hex'))) return 'corrupt_font';
  return null;
}
export function coreDigest(routes,resources) {
  const r=routes.map(x=>[x.url,x.final_url||'',x.status,x.reason||'']).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const s=resources.map(x=>[x.url,x.method,x.response_url,x.redirect_target||'',x.mime,x.http_status,x.status,x.raw_sha256||'',x.local_sha256||'']).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return sha(JSON.stringify({routes:r,resources:s}));
}
