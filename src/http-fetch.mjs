import {spawn} from 'node:child_process';
import {installedPython,installationConfig} from './config.mjs';
import {fileURLToPath} from 'node:url';
import {selectedProxy,proxyEndpoint,proxyFailure} from './proxy.mjs';
import {randomUUID} from 'node:crypto';

const children=new Set();
process.once('exit',()=>{for(const child of children)child.kill();});

export function proxyEnvironment(env){
  const proxies={};
  for(const key of ['https_proxy','HTTPS_PROXY','http_proxy','HTTP_PROXY','all_proxy','ALL_PROXY']){
    if(!env[key])continue;
    try{
      const url=new URL(env[key].includes('://')?env[key]:'http://'+env[key]);
      proxies[key]=url.hostname?`${url.protocol}//${url.hostname}${url.port?':'+url.port:''}`:'invalid';
    }catch{proxies[key]='invalid';}
  }
  return proxies;
}

// One HTTP request per process; never retry a possibly submitted generation/upload.
export async function httpFetch(url,options={}){
  const request=new Request(url,options);
  if(!['http:','https:'].includes(new URL(request.url).protocol))throw Error('HTTP_SCHEME_UNSUPPORTED');
  request.signal.throwIfAborted();
  const body=Buffer.from(await request.arrayBuffer()).toString('base64');
  request.signal.throwIfAborted();
  const python=options.python||process.env.GEMINI_HTTP_PYTHON||installedPython||(process.platform==='win32'?'python':'python3');
  const env={...installationConfig?.env,...process.env},startedAt=Date.now(),transportId=randomUUID();
  const route=options.proxyRoute??await selectedProxy(request.url);
  return new Promise((resolve,reject)=>{
    const child=spawn(python,['-u',fileURLToPath(new URL('./http-fetch.py',import.meta.url))],{stdio:['pipe','pipe','pipe'],env});
    children.add(child);
    let prefix=Buffer.alloc(0),stderr='',controller,opened=false,ended=false,cancelled=false,inputFailed=false;
    const transportError=meta=>{
      const code=meta?.error==='HTTP_TRANSPORT_UNAVAILABLE'?meta.error:proxyFailure(meta,route?.proxy,opened),error=Error(code);
      if(typeof meta?.python_exception==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(meta.python_exception))error.pythonException=meta.python_exception;
      if(Number.isInteger(meta?.curl_code)&&meta.curl_code>0)error.curlCode=meta.curl_code;
      if(Number.isFinite(meta?.elapsed_ms)&&meta.elapsed_ms>=0)error.pythonElapsedMs=meta.elapsed_ms;
      if(['bootstrap','input','request','body'].includes(meta?.stage))error.pythonStage=meta.stage;
      if(code.startsWith('PROXY_'))error.proxyError={code,...(route?{endpoint:proxyEndpoint(route.proxy),source:route.source}:{}),...(meta?.curl_code?{curlCode:meta.curl_code}:{}),...(meta?.proxy_status?{httpStatus:meta.proxy_status}:{})};
      return error;
    };
    child.stderr.on('data',chunk=>{stderr+=chunk.toString('utf8');});
    const cleanup=()=>{children.delete(child);request.signal.removeEventListener('abort',abort);};
    const fail=error=>{
      if(ended)return;
      if(error instanceof Error){
        error.transportDiagnostics={transportId,proxyEnvironment:proxyEnvironment(env),noProxyConfigured:!!(env.no_proxy||env.NO_PROXY),elapsedMs:Date.now()-startedAt,...(route?{route:{endpoint:proxyEndpoint(route.proxy),source:route.source}}:{}),
          ...(error.pythonException?{pythonException:error.pythonException}:{}),...(error.curlCode?{curlCode:error.curlCode}:{}),
          ...(error.pythonElapsedMs!==undefined?{pythonElapsedMs:error.pythonElapsedMs}:{}),...(error.pythonStage?{pythonStage:error.pythonStage}:{})};
        const code=/^[A-Z][A-Z0-9_]*$/.test(error.message)?error.message:error.name==='TimeoutError'?'HTTP_TIMEOUT':error.name==='AbortError'?'HTTP_ABORTED':'HTTP_TRANSPORT_ERROR';
        console.error(JSON.stringify({event:'http.transport_error',at:new Date().toISOString(),code,origin:new URL(request.url).origin,method:request.method,...error.transportDiagnostics,...(error.proxyError?{proxy_error:error.proxyError}:{})}));
      }
      ended=true;cleanup();child.kill();
      if(opened){if(controller&&!cancelled)controller.error(error);}else reject(error);
    };
    const abort=()=>fail(request.signal.reason);
    request.signal.addEventListener('abort',abort,{once:true});
    if(request.signal.aborted){abort();return;}
    child.on('error',()=>fail(Error('HTTP_TRANSPORT_UNAVAILABLE')));
    child.stdin.on('error',()=>{inputFailed=true;});
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
        if(meta.error)throw transportError(meta);
        if(meta.status===407)throw transportError({...meta,proxy_status:407});
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
    child.on('close',(code,signal)=>{
      if(ended)return;
      if(code!==0||!opened||inputFailed){
        let meta;
        for(const line of stderr.split(/\r?\n/)){
          try{const value=JSON.parse(line);if(value.error==='HTTP_TRANSPORT_ERROR')meta=value;}catch{}
        }
        const error=transportError(meta);
        if(error.message==='HTTP_TRANSPORT_ERROR'&&!meta){
          if(signal)error.message+=`_SIGNAL_${signal}`;
          else if(code!==0&&code!==null)error.message+=`_EXIT_${String(code).replace('-','NEG_')}`;
        }
        fail(error);return;
      }
      ended=true;cleanup();controller?.close();
    });
    child.stdin.end(JSON.stringify({url:request.url,method:request.method,headers:[...request.headers],body,uploadFile:options.uploadFile,...(route?{proxy:route.proxy}:{})}));
  });
}
