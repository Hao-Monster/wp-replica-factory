import http from 'node:http';

// Small edge-case HTTP responses, not a replacement for the three PR #5 pages.
export async function edgeFixture() {
  const state={mode:'good',version:1,variantCount:0,writeRequests:0,leakHits:0,requests:[]};
  const leak=http.createServer((_req,res)=>{state.leakHits++;res.writeHead(200,{'Content-Type':'image/svg+xml'}).end('<svg xmlns="http://www.w3.org/2000/svg"/>');});
  await new Promise(resolve=>leak.listen(0,'127.0.0.1',resolve));
  const svg=color=>`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="${color}"/></svg>`;
  const server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://127.0.0.1'),p=decodeURIComponent(u.pathname);
    state.requests.push({url:req.url,method:req.method});
    if(req.method!=='GET'){state.writeRequests++;res.writeHead(405).end();return;}
    const send=(mime,body,status=200)=>res.writeHead(status,{'Content-Type':mime+(mime.startsWith('text/')&&state.mode!=='badcharset'?'; charset=utf-8':''),'Content-Length':Buffer.byteLength(body)}).end(body);
    if(p==='/') {
      const additions={
        missing:'<img src="/missing.png">',
        corrupt:'<img src="/bad.png">',
        wrongmime:'<script src="/bad.js"></script>',
        font:'<style>@font-face{font-family:Bad;src:url(/bad.ttf)}h1{font-family:Bad}</style>',
        redirect:'<img src="/redirect.svg">',
        post:'<script>fetch("/write",{method:"POST",body:"not-a-business-operation"}).catch(()=>{})</script>',
        unapproved:'<script>fetch("/unapproved.json").catch(()=>{})</script>',
        frontier:'<a href="/next">Next</a>',
        variant:'<link rel="stylesheet" href="/variant.css">',
        responsive:'<img src="/image.svg?v=a" srcset="/image.svg?v=a 1x, /unfetched.svg 2x">',
        ownedredirect:'<img src="/owned-redirect.svg">',
      }[state.mode]||'';
      send('text/html',`<!doctype html><html><head><title>Owned downloader edge</title><link rel="stylesheet" href="/theme.css"></head><body><h1>Edge ${state.version}</h1><img src="/image.svg?v=a"><img src="/image.svg?v=b"><img src="/%E4%B8%AD%E6%96%87%20%E5%9B%BE.svg"><div class="bg">Nested CSS background</div>${additions}</body></html>`);
    }else if(p==='/theme.css')send('text/css','@import "/nested/base.css";body{margin:24px}');
    else if(p==='/nested/base.css')send('text/css','.bg{width:100px;height:100px;background-image:url("../中文 图.svg")}');
    else if(p==='/image.svg')send('image/svg+xml',svg(u.search==='?v=a'?'#224466':'#aa6622'));
    else if(p==='/中文 图.svg')send('image/svg+xml',svg('#228833'));
    else if(p==='/bad.png')send('image/png','not a decodable PNG');
    else if(p==='/bad.js')send('application/javascript','<!doctype html><html>server error</html>');
    else if(p==='/bad.ttf')send('font/ttf','not a font');
    else if(p==='/redirect.svg')res.writeHead(302,{Location:`http://127.0.0.1:${leak.address().port}/outside.svg`}).end();
    else if(p==='/owned-redirect.svg')res.writeHead(302,{Location:'/image.svg?v=a'}).end();
    else if(p==='/variant.css')send('text/css',`h1{color:${++state.variantCount%2?'red':'blue'}}`);
    else if(p==='/next')send('text/html','<!doctype html><h1>Next</h1>');
    else if(p==='/unapproved.json')send('application/json','{"unapproved":true}');
    else send('text/plain','not found',404);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const stopServer=s=>new Promise(resolve=>{s.closeAllConnections();s.close(resolve);});
  return {origin:`http://127.0.0.1:${server.address().port}`,state,stop:async()=>{await stopServer(server);await stopServer(leak);}};
}
