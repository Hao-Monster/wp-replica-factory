// Derived from nexu-io/open-design@1b47e60bd46641469fcd8b69c496c4e3a548bc28.
// Copyright (c) 2026 Jane (@xiaoerzhan / 小耳). MIT; see LICENSE.
// Modified: reusable context listener, policy-selected GET response bodies, no
// request headers/postData persistence. Unapproved XHR/fetch can remain metadata-only.
// Pending bodies are drained before context closure; no second GET is issued.
export function captureResponses(context, {maxBytes, observe, save, fail, shouldSave=()=>true, metadata=()=>{}}) {
  const pending=new Set();
  const listener=response=>{
    const request=response.request(), headers=response.headers();
    const entry={url:request.url(),response_url:response.url(),http_status:response.status(),method:request.method(),request_type:request.resourceType(),mime:headers['content-type']||'',observation:{...observe()}};
    if(entry.http_status>=300&&entry.http_status<400&&headers.location)entry.redirect_target=new URL(headers.location,response.url()).href;
    const task=(async()=>{
      try {
        if(!['GET','HEAD'].includes(entry.method)) return;
        if(!shouldSave(entry)) { metadata(entry); return; }
        if(entry.method==='HEAD') { metadata(entry); return; }
        if(entry.http_status>=300&&entry.http_status<400) { await save(entry,null); return; }
        if(Number(headers['content-length']||0)>maxBytes) throw new Error('response_byte_budget');
        const body=await response.body();
        if(body.length>maxBytes) throw new Error('response_byte_budget');
        await save(entry,body);
      } catch(error) { fail({...entry,reason:error.message}); }
    })();
    pending.add(task); task.finally(()=>pending.delete(task));
  };
  context.on('response',listener);
  return {
    async drain() { while(pending.size) await Promise.all([...pending]); },
    detach() { context.off('response',listener); },
  };
}
