import {spawn} from 'node:child_process';
import {installedPython,installationConfig} from './config.mjs';
import {fileURLToPath} from 'node:url';

const children=new Set();
process.once('exit',()=>{for(const child of children)child.kill();});

// One HTTP request per process; never retry a possibly submitted generation/upload.
export async function httpFetch(url,options={}){
  const request=new Request(url,options);
  if(!['http:','https:'].includes(new URL(request.url).protocol))throw Error('HTTP_SCHEME_UNSUPPORTED');
  request.signal.throwIfAborted();
  const body=Buffer.from(await request.arrayBuffer()).toString('base64');
  request.signal.throwIfAborted();
  const python=process.env.GEMINI_HTTP_PYTHON||installedPython||(process.platform==='win32'?'python':'python3');
  return new Promise((resolve,reject)=>{
    const child=spawn(python,['-u',fileURLToPath(new URL('./http-fetch.py',import.meta.url))],{stdio:['pipe','pipe','ignore'],env:{...installationConfig?.env,...process.env}});
    children.add(child);
    let prefix=Buffer.alloc(0),controller,opened=false,ended=false,cancelled=false;
    const cleanup=()=>{children.delete(child);request.signal.removeEventListener('abort',abort);};
    const fail=error=>{
      if(ended)return;
      ended=true;cleanup();child.kill();
      if(opened){if(controller&&!cancelled)controller.error(error);}else reject(error);
    };
    const abort=()=>fail(request.signal.reason);
    request.signal.addEventListener('abort',abort,{once:true});
    if(request.signal.aborted){abort();return;}
    child.on('error',()=>fail(Error('HTTP_TRANSPORT_UNAVAILABLE')));
    child.stdin.on('error',()=>fail(Error('HTTP_TRANSPORT_ERROR')));
    const enqueue=chunk=>{if(controller&&chunk.length){controller.enqueue(chunk);if(controller.desiredSize<=0)child.stdout.pause();}};
    child.stdout.on('data',chunk=>{
      if(ended)return;
      if(opened){enqueue(chunk);return;}
      prefix=Buffer.concat([prefix,chunk]);
      const newline=prefix.indexOf(10);
      if((newline<0?prefix.length:newline)>65536){fail(Error('HTTP_HEADERS_TOO_LARGE'));return;}
      if(newline<0)return;
      try{
        const meta=JSON.parse(prefix.subarray(0,newline));
        if(meta.error)throw Error(meta.error==='HTTP_TRANSPORT_UNAVAILABLE'?meta.error:'HTTP_TRANSPORT_ERROR');
        if(options.redirect==='error'&&[301,302,303,307,308].includes(meta.status))throw Error('HTTP_REDIRECT_REJECTED');
        const noBody=request.method==='HEAD'||[204,205,304].includes(meta.status);
        const stream=noBody?null:new ReadableStream({
          start(c){controller=c;},pull(){child.stdout.resume();},
          cancel(){cancelled=true;ended=true;cleanup();child.kill();}
        });
        const response=new Response(stream,{status:meta.status,headers:meta.headers});
        opened=true;resolve(response);enqueue(prefix.subarray(newline+1));prefix=Buffer.alloc(0);
      }catch(error){fail(error);}
    });
    child.on('close',code=>{
      if(ended)return;
      if(code!==0||!opened){fail(Error('HTTP_TRANSPORT_ERROR'));return;}
      ended=true;cleanup();controller?.close();
    });
    child.stdin.end(JSON.stringify({url:request.url,method:request.method,headers:[...request.headers],body}));
  });
}
