import fs from 'node:fs';
import { parse, serialize } from 'parse5';
import postcss from 'postcss';
import safeParser from 'postcss-safe-parser';
import valueParser from 'postcss-value-parser';
import { parseSrcset, stringifySrcset } from 'srcset';
import { normalizeUrl, safeFile, put, sha, json } from './core.mjs';

export function localize(root,policy,routes,resources,gaps,warnings) {
  const successful=resources.filter(r=>r.status==='saved');
  const byUrl=new Map();
  for(const r of successful) {
    if(!byUrl.has(r.url)) byUrl.set(r.url,r);
    else if(byUrl.get(r.url).raw_sha256!==r.raw_sha256) gaps.push({reason:'response_variant_conflict',url:r.url,variants:[byUrl.get(r.url).local_path,r.local_path]});
  }
  // Resolve only redirect targets actually captured in this same session. This
  // never fetches or serves an online fallback and preserves the original URL.
  const redirects=resources.filter(r=>r.status==='redirect'&&r.redirect_target);
  for(let pass=0;pass<redirects.length;pass++)for(const r of redirects) {
    const target=byUrl.get(r.redirect_target);
    if(target&&!byUrl.has(r.url))byUrl.set(r.url,target);
  }
  const pageMap=new Map(routes.filter(r=>r.status==='visited').map(r=>[r.url,byUrl.get(r.final_url||r.url)]));
  const references=[];
  const reference=(raw,base,kind,owner,optional=false)=>{
    if(!raw||raw.startsWith('#')||raw.startsWith('data:')) return raw;
    let u;
    try{u=new URL(raw,base);}catch{gaps.push({reason:'invalid_reference',owner});return '/__missing/invalid';}
    if(!['http:','https:'].includes(u.protocol)) { if(kind==='page') return '#'; gaps.push({reason:'unsupported_reference',owner,protocol:u.protocol});return '/__missing/protocol'; }
    const fragment=u.hash; u.hash=''; const abs=u.href;
    const record=kind==='page'?pageMap.get(abs):byUrl.get(abs);
    if(record) {
      references.push({from:owner,to:record.url,kind});
      record.references.push({from:owner,kind});
      // Original virtual route layout is retained for navigation and JS fetch.
      if(kind==='page'&&new URL(abs).origin===new URL(policy.url).origin) return u.pathname+u.search+fragment;
      return '/'+record.local_path.slice('site/'.length)+fragment;
    }
    const failure={reason:optional?'uncaptured_responsive_candidate':'dependency_gap',url:abs,from:owner,kind};
    if(kind==='page'&&!policy.pageOrigins.includes(u.origin)) return '#';
    (optional?warnings:gaps).push(failure);
    return '/__missing/'+sha(abs);
  };
  const rewriteValue=(text,base,owner,importRule=false)=>{
    const ast=valueParser(text);
    ast.walk(node=>{
      if(node.type==='function'&&node.value.toLowerCase()==='url') {
        const raw=valueParser.stringify(node.nodes).trim().replace(/^(['"])(.*)\1$/s,'$2');
        node.nodes=[{type:'string',quote:'"',value:reference(raw,base,'asset',owner)}];return false;
      }
    });
    if(importRule&&ast.nodes[0]?.type==='string') ast.nodes[0].value=reference(ast.nodes[0].value,base,'asset',owner);
    return ast.toString();
  };
  const rewriteCss=(text,base,owner)=>{
    let ast;
    try { ast=postcss.parse(text,{from:undefined}); }
    catch(error) {
      // Browsers recover from invalid declarations/trailing tokens. Keep the raw
      // response untouched; use an actual tolerant parser, never regex-delete it.
      warnings.push({reason:'css_parser_recovery',url:owner,detail:error.reason});
      ast=safeParser(text,{from:undefined});
    }
    ast.walkDecls(decl=>{decl.value=rewriteValue(decl.value,base,owner);});
    ast.walkAtRules('import',rule=>{rule.params=rewriteValue(rule.params,base,owner,true);});
    return ast.toString();
  };
  for(const record of successful) {
    let body=fs.readFileSync(safeFile(root,record.raw_path));
    try {
      if(record.mime.includes('text/css')) body=Buffer.from(rewriteCss(body.toString('utf8'),record.response_url,record.url));
      if(record.mime.includes('text/html')) {
        const ast=parse(body.toString('utf8'));
        let base=record.response_url;
        function findBase(node) {
          if(node.tagName==='base') {const href=node.attrs.find(a=>a.name==='href')?.value;if(href)base=new URL(href,base).href;}
          for(const child of node.childNodes||[]) findBase(child);
        }
        findBase(ast);
        function walk(node) {
          if(node.childNodes) node.childNodes=node.childNodes.filter(c=>c.tagName!=='base'&&!(c.tagName==='meta'&&c.attrs?.some(a=>a.name==='http-equiv'&&['refresh','content-security-policy'].includes(a.value.toLowerCase()))));
          if(node.attrs) {
            node.attrs=node.attrs.filter(a=>!['integrity','crossorigin','ping'].includes(a.name));
            for(const attr of node.attrs) {
              if(['src','poster','href','xlink:href','data'].includes(attr.name)) {
                if(node.tagName==='link'&&node.attrs.find(a=>a.name==='rel')?.value==='canonical') {attr.value='#';continue;}
                attr.value=reference(attr.value,base,node.tagName==='a'?'page':'asset',record.url);
              } else if(attr.name==='srcset') {
                const candidates=parseSrcset(attr.value); for(const item of candidates) item.url=reference(item.url,base,'asset',record.url,true);
                attr.value=stringifySrcset(candidates);
              } else if(attr.name==='style') attr.value=rewriteCss(attr.value,base,record.url);
              else if(['action','formaction'].includes(attr.name)) attr.value='about:blank';
            }
          }
          if(node.tagName==='style') for(const child of node.childNodes||[]) if(child.nodeName==='#text') child.value=rewriteCss(child.value,base,record.url);
          for(const child of node.childNodes||[]) walk(child);
          if(node.content) walk(node.content);
        }
        walk(ast); body=Buffer.from(serialize(ast));
      }
      put(root,record.local_path,body);
      record.local_sha256=sha(body); record.local_bytes=body.length;
    } catch(error) { record.status='failed';record.reason='localization: '+error.message;gaps.push({reason:record.reason,url:record.url}); }
  }
  const aliases={};
  for(const r of successful.filter(r=>r.status==='saved')) {
    aliases['/'+r.local_path.slice(5)]={path:r.local_path.slice(5),mime:r.mime,sha256:r.local_sha256};
    const u=new URL(r.url);
    if(u.origin===new URL(policy.url).origin&&!aliases[u.pathname+u.search]) aliases[u.pathname+u.search]={path:r.local_path.slice(5),mime:r.mime,sha256:r.local_sha256};
  }
  for(const [url,record] of pageMap) if(record?.status==='saved') {
    const u=new URL(url);aliases[u.pathname+u.search]={path:record.local_path.slice(5),mime:record.mime,sha256:record.local_sha256};
  }
  for(const r of redirects) {
    const record=byUrl.get(r.url),u=new URL(r.url);
    if(record?.status==='saved'&&u.origin===new URL(policy.url).origin)aliases[u.pathname+u.search]={path:record.local_path.slice(5),mime:record.mime,sha256:record.local_sha256};
  }
  put(root,'site/route-map.json',json({schema:1,entry:new URL(policy.url).pathname+new URL(policy.url).search,aliases}));
  put(root,'reports/references.json',json({schema:1,references,gaps,warnings}));
}
