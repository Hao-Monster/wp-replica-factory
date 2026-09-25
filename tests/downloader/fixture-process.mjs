import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../../tools/downloader/core.mjs';

export function startFixture() {
  const child=spawn(process.env.PYTHON||'python',['-B','-X','utf8',path.join(ROOT,'tests/downloader/serve_fixture.py')],{cwd:ROOT,stdio:['pipe','pipe','pipe']});
  return new Promise((resolve,reject)=>{
    let output='',error='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('fixture startup timeout: '+error));},20000);
    child.on('error',reject);child.stderr.on('data',chunk=>error+=chunk.toString());
    child.on('exit',code=>{clearTimeout(timer);if(!output.includes('\n'))reject(new Error('fixture exited '+code+': '+error));});
    child.stdout.on('data',chunk=>{
      output+=chunk.toString();if(!output.includes('\n'))return;
      clearTimeout(timer);
      try {
        const data=JSON.parse(output.split('\n')[0]);
        resolve({...data,stop:()=>new Promise((done,fail)=>{
          const t=setTimeout(()=>{child.kill();fail(new Error('fixture shutdown timeout'));},15000);
          child.once('exit',code=>{clearTimeout(t);code===0?done():fail(new Error('fixture shutdown '+code));});
          child.stdin.end('stop\n');
        })});
      }catch(e){reject(e);}
    });
  });
}
export function cli(args,{timeout=240000}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(ROOT,'tools/downloader/cli.mjs'),...args],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill();},timeout);
    child.on('error',reject);child.stdout.on('data',b=>stdout+=b.toString());child.stderr.on('data',b=>stderr+=b.toString());
    child.on('close',(code,signal)=>{
      clearTimeout(timer);let data=null;try{data=JSON.parse(stdout);}catch{}
      resolve({code,signal,timedOut,stdout,stderr,data});
    });
  });
}
