import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';

const IPV4_RANGES = [
  ['127.0.0.0',8],['10.0.0.0',8],['172.16.0.0',12],['192.168.0.0',16],
  ['169.254.0.0',16],['100.64.0.0',10],['0.0.0.0',8],
];

function ipv4Number(address) {
  const parts=address.split('.');
  if(parts.length!==4||parts.some(x=>!/^(?:0|[1-9]\d{0,2})$/.test(x)||Number(x)>255))return null;
  return parts.reduce((n,x)=>(n<<8n)+BigInt(Number(x)),0n);
}
function ipv4InCidr(address,base,prefix) {
  const a=ipv4Number(address),b=ipv4Number(base);if(a===null||b===null)return false;
  const shift=32n-BigInt(prefix);return (a>>shift)===(b>>shift);
}
function ipv6Number(input) {
  let address=input.toLowerCase().replace(/^\[|\]$/g,'').split('%')[0];
  if(address.includes('.')) {
    const i=address.lastIndexOf(':');const v4=ipv4Number(address.slice(i+1));if(v4===null)return null;
    address=address.slice(0,i)+':'+((v4>>16n)&0xffffn).toString(16)+':'+(v4&0xffffn).toString(16);
  }
  const halves=address.split('::');if(halves.length>2)return null;
  const left=halves[0]?halves[0].split(':'):[],right=halves[1]?halves[1].split(':'):[];
  const missing=8-left.length-right.length;if(missing<0||(halves.length===1&&missing!==0))return null;
  const parts=[...left,...Array(missing).fill('0'),...right];
  if(parts.length!==8||parts.some(x=>!/^[0-9a-f]{1,4}$/.test(x)))return null;
  return parts.reduce((n,x)=>(n<<16n)+BigInt(parseInt(x,16)),0n);
}
export function isBlockedAddress(address) {
  const raw=String(address||'').replace(/^\[|\]$/g,'').split('%')[0];
  if(net.isIP(raw)===4)return IPV4_RANGES.some(([base,prefix])=>ipv4InCidr(raw,base,prefix));
  const n=ipv6Number(raw);if(n===null)return true;
  if(n===0n||n===1n)return true;
  if((n>>121n)===126n)return true; // fc00::/7
  if((n>>118n)===1018n)return true; // fe80::/10
  if((n>>32n)===0xffffn) {
    const v4=Number(n&0xffffffffn);
    const mapped=[v4>>>24,(v4>>>16)&255,(v4>>>8)&255,v4&255].join('.');
    return isBlockedAddress(mapped);
  }
  return false;
}
export async function defaultResolver(hostname) {
  const host=String(hostname).replace(/^\[|\]$/g,'');
  if(net.isIP(host))return [{address:host,family:net.isIP(host)}];
  return dns.lookup(host,{all:true,verbatim:true});
}
export function sanitizeUrl(raw,sensitiveKeys=[]) {
  try {
    const u=new URL(raw);const keys=new Set(sensitiveKeys.map(x=>String(x).toLowerCase()));
    for(const key of [...u.searchParams.keys()])if(keys.has(key.toLowerCase()))u.searchParams.set(key,'<redacted>');
    u.username='';u.password='';return u.href;
  } catch {return '[invalid-url]';}
}
function record(failures,event) {
  failures.push({...event,at:new Date().toISOString()});return event;
}
export class NetworkGuard {
  constructor(policy,failures=[],options={}) {
    this.policy=policy;this.failures=failures;this.resolver=options.resolver||defaultResolver;this.dial=options.dial||null;
  }
  async inspect(raw,{kind='asset',method='GET',resourceType='',firstSeenPage=''}={}) {
    let u;
    try {u=new URL(raw);} catch {return {allowed:false,...record(this.failures,{reason:'invalid_url',url:'[invalid-url]',method})};}
    if(u.username||u.password)return {allowed:false,...record(this.failures,{reason:'credentialed_url',url:sanitizeUrl(u.href,this.policy.sensitiveQueryKeys),method})};
    if(this.policy.mode==='owned-fixture') {
      const allowed=kind==='page'?this.policy.pageOrigins:this.policy.assetOrigins;
      if(method!=='GET')return {allowed:false,...record(this.failures,{reason:'method_blocked',url:u.href,method})};
      if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!allowed.includes(u.origin))return {allowed:false,...record(this.failures,{reason:'network_scope',url:u.href,method})};
      return {allowed:true,url:u.href,addresses:[{address:'127.0.0.1',family:4}],metadataOnly:false};
    }
    if(u.protocol!=='https:')return {allowed:false,...record(this.failures,{reason:'scheme_blocked',url:sanitizeUrl(u.href,this.policy.sensitiveQueryKeys),method})};
    const hostname=u.hostname.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
    if(hostname==='localhost'||hostname.endsWith('.localhost'))return {allowed:false,...record(this.failures,{reason:'private_address',url:sanitizeUrl(u.href,this.policy.sensitiveQueryKeys),address:hostname,first_seen_page:firstSeenPage})};
    if(kind!=='proxy'&&!['GET','HEAD'].includes(method))return {allowed:false,...record(this.failures,{reason:'blocked_business_request',url:sanitizeUrl(u.href,this.policy.sensitiveQueryKeys),method,resource_type:resourceType,first_seen_page:firstSeenPage})};
    let addresses;
    try {addresses=await this.resolver(u.hostname);} catch(error){return {allowed:false,...record(this.failures,{reason:'dns_failed',url:sanitizeUrl(u.href,this.policy.sensitiveQueryKeys),detail:error.message})};}
    if(!Array.isArray(addresses)||!addresses.length)return {allowed:false,...record(this.failures,{reason:'dns_failed',url:sanitizeUrl(u.href,this.policy.sensitiveQueryKeys),detail:'empty resolution'})};
    const blocked=addresses.find(x=>isBlockedAddress(x.address));
    if(blocked)return {allowed:false,...record(this.failures,{reason:'private_address',url:sanitizeUrl(u.href,this.policy.sensitiveQueryKeys),address:blocked.address,first_seen_page:firstSeenPage})};
    const allowedOrigins=kind==='page'?this.policy.pageOrigins:kind==='proxy'?[...new Set([...this.policy.pageOrigins,...this.policy.assetOrigins])]:this.policy.assetOrigins;
    if(!allowedOrigins.includes(u.origin))return {allowed:false,...record(this.failures,{reason:'needs_approval',origin:u.origin,url:sanitizeUrl(u.href,this.policy.sensitiveQueryKeys),resource_type:resourceType,first_seen_page:firstSeenPage})};
    const metadataOnly=['fetch','xhr'].includes(resourceType)&&!this.policy.publicGetFixtures.includes(u.href);
    return {allowed:true,url:u.href,addresses,metadataOnly};
  }
}
export function createNetworkGuard(policy,failures=[],options={}) {return new NetworkGuard(policy,failures,options);}

function parseConnectTarget(value) {
  const u=new URL('https://'+value.replace(/^\//,'')+'/');
  return {url:u.href,port:Number(u.port||443)};
}
export async function guardedProxy(policy,failures=[],options={}) {
  const guard=createNetworkGuard(policy,failures,options);
  const server=http.createServer(async(req,res)=>{
    if(policy.mode!=='owned-fixture'){res.writeHead(403).end('HTTPS CONNECT only');return;}
    let u;try{u=new URL(req.url);}catch{res.writeHead(403).end();return;}
    const verdict=await guard.inspect(u.href,{kind:'asset',method:req.method||'GET'});
    if(!verdict.allowed){res.writeHead(403).end('Blocked by network guard');return;}
    const headers={...req.headers,host:u.host};for(const key of ['authorization','cookie','proxy-authorization','proxy-connection'])delete headers[key];
    const upstream=http.request({hostname:'127.0.0.1',port:u.port,path:u.pathname+u.search,method:'GET',headers,timeout:15000},response=>{
      const clean={...response.headers};delete clean['set-cookie'];res.writeHead(response.statusCode,clean);response.pipe(res);
    });
    upstream.on('timeout',()=>upstream.destroy(new Error('upstream timeout')));
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    req.on('aborted',()=>upstream.destroy());upstream.end();
  });
  server.on('connect',async(req,socket,head)=>{
    if(policy.mode==='owned-fixture'){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');record(failures,{reason:'connect_blocked'});return;}
    let target;try{target=parseConnectTarget(req.url);}catch{socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');record(failures,{reason:'invalid_connect_target'});return;}
    const verdict=await guard.inspect(target.url,{kind:'proxy',method:'CONNECT'});
    if(!verdict.allowed){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
    const address=verdict.addresses[0].address;
    const upstream=guard.dial?guard.dial({address,port:target.port,url:target.url}):net.connect({host:address,port:target.port});
    upstream.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head?.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
    upstream.once('error',()=>{try{socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');}catch{}});
    socket.once('error',()=>upstream.destroy());
  });
  server.on('upgrade',(_req,socket)=>{socket.destroy();record(failures,{reason:'websocket_blocked'});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:`http://127.0.0.1:${server.address().port}`,guard,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
