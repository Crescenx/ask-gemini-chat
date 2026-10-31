import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {httpFetch,proxyEnvironment} from './http-fetch.mjs';
import {mkdtemp,open,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('proxy diagnostics show endpoints without credentials, query strings or unrelated environment',()=>{
  assert.deepEqual(proxyEnvironment({HTTPS_PROXY:'http://user:secret@127.0.0.1:4290/private?token=secret',
    ALL_PROXY:'socks5h://user:secret@[::1]:7890/path',http_proxy:'localhost:8080',https_proxy:'http://bad host',OTHER:'secret'}),
    {HTTPS_PROXY:'http://127.0.0.1:4290',http_proxy:'http://localhost:8080',ALL_PROXY:'socks5h://[::1]:7890',https_proxy:'invalid'});
});

test('explicit automatic routes override inherited bypass rules and identify proxy auth and connection failures',async()=>{
  let calls=0;
  const proxy=http.createServer((req,res)=>{calls++;assert.equal(req.url,'http://origin.invalid/check');res.end('through proxy');});
  proxy.on('connect',(req,socket)=>{calls++;socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const port=proxy.address().port,proxyRoute={proxy:`http://127.0.0.1:${port}`,source:'fixture'};
  const prior=process.env.NO_PROXY;process.env.NO_PROXY='*';
  try{
    const response=await httpFetch('http://origin.invalid/check',{proxyRoute});
    assert.equal(await response.text(),'through proxy');
    await assert.rejects(httpFetch('https://origin.invalid/check',{proxyRoute}),error=>{
      assert.equal(error.message,'PROXY_AUTH_REQUIRED');assert.equal(error.proxyError.httpStatus,407);
      assert.equal(error.proxyError.endpoint,proxyRoute.proxy);return true;
    });
    assert.equal(calls,2);
  }finally{
    if(prior===undefined)delete process.env.NO_PROXY;else process.env.NO_PROXY=prior;
    proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));
  }
  await assert.rejects(httpFetch('https://origin.invalid/check',{proxyRoute}),error=>{
    assert.equal(error.message,'PROXY_CONNECT_FAILED');assert.equal(error.proxyError.curlCode,7);return true;
  });
});

test('HTTP transport preserves multipart bytes, streams, cookies and status; never follows or retries',async()=>{
  let calls=0,finish;
  const server=http.createServer(async(req,res)=>{
    calls++;
    if(req.url==='/break'){res.destroy();return;}
    if(req.url==='/redirect'){res.writeHead(302,{location:'/unexpected'});res.end();return;}
    if(req.url==='/stream'){
      res.writeHead(200,{'content-type':'text/plain','set-cookie':['a=1; Path=/','b=2; Path=/']});
      res.write('first');finish=()=>res.end('中文 😀');return;
    }
    if(req.url==='/wait'){res.writeHead(200);res.write('started');return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks);
    assert.match(req.headers['content-type'],/^multipart\/form-data; boundary=/);
    assert(body.includes(Buffer.from([0,1,255,13,10])));
    res.writeHead(201);res.end('uploaded');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://localhost:${server.address().port}`;
  try{
    const form=new FormData();form.append('file',new Blob([Buffer.from([0,1,255,13,10])],{type:'application/octet-stream'}),'x.bin');
    const uploaded=await httpFetch(root,{method:'POST',body:form});
    assert.equal(uploaded.status,201);assert.equal(await uploaded.text(),'uploaded');
    const response=await httpFetch(root+'/stream');
    assert.deepEqual(response.headers.getSetCookie(),['a=1; Path=/','b=2; Path=/']);
    const reader=response.body.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'first');
    finish();let rest='';const decoder=new TextDecoder();for(;;){const {value,done}=await reader.read();if(done)break;rest+=decoder.decode(value,{stream:true});}rest+=decoder.decode();assert.equal(rest,'中文 😀');
    await assert.rejects(httpFetch(root+'/redirect',{redirect:'error'}),/HTTP_REDIRECT_REJECTED/);
    const abort=new AbortController(),pending=await httpFetch(root+'/wait',{signal:abort.signal});
    const body=pending.body.getReader();await body.read();abort.abort();await assert.rejects(body.read(),{name:'AbortError'});
    assert.equal(calls,4);
    await assert.rejects(httpFetch(root+'/break'),{message:'HTTP_TRANSPORT_ERROR_CURL_52'});assert.equal(calls,5);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('a broken response retains received bytes and the libcurl cause without retrying or exposing its URL',async t=>{
  const logs=[];t.mock.method(console,'error',value=>logs.push(JSON.parse(value)));
  const directory=await mkdtemp(join(tmpdir(),'python-warning-'));
  await writeFile(join(directory,'sitecustomize.py'),'import sys\nsys.stderr.write("warning: private/path?token=secret\\n")\n');
  const priorPath=process.env.PYTHONPATH;process.env.PYTHONPATH=directory;
  let calls=0,disconnect;
  const server=http.createServer((req,res)=>{
    calls++;
    res.writeHead(200,{'content-length':'1000'});
    res.write('preamble');disconnect=()=>res.socket.destroy();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await httpFetch(`http://127.0.0.1:${server.address().port}/private?token=secret`);
    const reader=response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value),'preamble');
    disconnect();
    await assert.rejects(reader.read(),error=>{
      assert.equal(error.message,'HTTP_TRANSPORT_ERROR_CURL_18');
      assert(error.transportDiagnostics.elapsedMs>=0);
      assert.match(error.transportDiagnostics.pythonException,/^[A-Za-z_][A-Za-z0-9_]*$/);
      assert.equal(error.transportDiagnostics.curlCode,18);
      assert(error.transportDiagnostics.pythonElapsedMs>=0);
      assert.equal(error.transportDiagnostics.pythonStage,'body');
      assert.deepEqual(error.transportDiagnostics.proxyEnvironment,proxyEnvironment(process.env));
      assert.equal(logs.length,1);assert.equal(logs[0].event,'http.transport_error');
      assert.equal(logs[0].transportId,error.transportDiagnostics.transportId);
      assert.equal(logs[0].pythonException,error.transportDiagnostics.pythonException);
      assert.equal(logs[0].curlCode,18);assert(logs[0].pythonElapsedMs>=0);assert(logs[0].elapsedMs>=0);
      assert(!JSON.stringify(logs).includes('private'));assert(!JSON.stringify(logs).includes('secret'));
      return true;
    });
    assert.equal(calls,1);
  }finally{
    if(priorPath===undefined)delete process.env.PYTHONPATH;else process.env.PYTHONPATH=priorPath;
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});
  }
});

test('Python failures before headers retain the exception class and timing without the exception text',async t=>{
  const logs=[];t.mock.method(console,'error',value=>logs.push(JSON.parse(value)));
  await assert.rejects(httpFetch('http://localhost/private?token=secret',{uploadFile:{name:'private-secret',path:'/private/path'}}),error=>{
    assert.equal(error.message,'HTTP_TRANSPORT_ERROR');assert.equal(error.transportDiagnostics.pythonException,'KeyError');
    assert.equal(error.transportDiagnostics.pythonStage,'input');assert(error.transportDiagnostics.pythonElapsedMs>=0);
    assert.equal(error.transportDiagnostics.curlCode,undefined);return true;
  });
  assert.equal(logs.length,1);assert.equal(logs[0].pythonException,'KeyError');
  assert(!JSON.stringify(logs).includes('private'));assert(!JSON.stringify(logs).includes('secret'));
});

test('native dependency load failure retains its Python type even when the helper exits before reading stdin',async t=>{
  const logs=[];t.mock.method(console,'error',value=>logs.push(JSON.parse(value)));
  const directory=await mkdtemp(join(tmpdir(),'python-load-failure-'));
  await writeFile(join(directory,'curl_cffi.py'),'raise OSError("private/path secret")\n');
  const prior=process.env.PYTHONPATH;process.env.PYTHONPATH=directory;
  try{
    await assert.rejects(httpFetch('http://localhost/private?token=secret'),error=>{
      assert.equal(error.message,'HTTP_TRANSPORT_UNAVAILABLE');assert.equal(error.transportDiagnostics.pythonException,'OSError');
      assert.equal(error.transportDiagnostics.pythonStage,'bootstrap');assert(error.transportDiagnostics.pythonElapsedMs>=0);return true;
    });
    assert.equal(logs.length,1);assert(!JSON.stringify(logs).includes('private'));assert(!JSON.stringify(logs).includes('secret'));
  }finally{
    if(prior===undefined)delete process.env.PYTHONPATH;else process.env.PYTHONPATH=prior;
    await rm(directory,{recursive:true,force:true});
  }
});

test('disk multipart uploads beyond the former limit without encoding the file in the IPC request',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'http-upload-'));
  const path=join(directory,'large.bin'),size=21*1024*1024;
  const file=await open(path,'wx',0o600);await file.truncate(size);await file.write(Buffer.from('FILE_END'),0,8,size-8);await file.close();
  let received=0,tail=Buffer.alloc(0);
  const server=http.createServer(async(req,res)=>{
    assert.match(req.headers['content-type'],/^multipart\/form-data; boundary=/);
    for await(const chunk of req){received+=chunk.length;tail=Buffer.concat([tail,chunk]).subarray(-256);}
    res.end('ok');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await httpFetch(`http://127.0.0.1:${server.address().port}`,{method:'POST',uploadFile:{path,name:'large.bin',type:'application/octet-stream'}});
    assert.equal(await response.text(),'ok');assert(received>size);assert(received<size+1024);assert(tail.includes(Buffer.from('FILE_END')));
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});

test('missing HTTP helper fails explicitly and an already aborted call does not start',async()=>{
  const prior=process.env.GEMINI_HTTP_PYTHON;
  process.env.GEMINI_HTTP_PYTHON='/missing/gemini-python';
  try{
    await assert.rejects(httpFetch('http://localhost/'),/HTTP_TRANSPORT_UNAVAILABLE/);
    await assert.rejects(httpFetch('http://localhost/',{signal:AbortSignal.abort()}),{name:'AbortError'});
    // A process that exits before sending metadata must retain its exit code.
    process.env.GEMINI_HTTP_PYTHON=process.execPath;
    await assert.rejects(httpFetch('http://localhost/'),{message:'HTTP_TRANSPORT_ERROR_EXIT_9'});
  }finally{if(prior===undefined)delete process.env.GEMINI_HTTP_PYTHON;else process.env.GEMINI_HTTP_PYTHON=prior;}
});

test('disk upload parameters use UTF-8 even when Python stdin defaults to a Windows locale',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'http-upload-'));
  const path=join(directory,'中文文档.docx'),content=Buffer.from('word fixture');
  await writeFile(path,content);
  let received;
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    received=Buffer.concat(chunks);res.end('ok');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const previous=process.env.PYTHONIOENCODING;
  process.env.PYTHONIOENCODING='gbk';
  try{
    const response=await httpFetch(`http://127.0.0.1:${server.address().port}`,{method:'POST',uploadFile:{path,name:'中文文档.docx',type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}});
    assert.equal(await response.text(),'ok');
    assert(received.includes(Buffer.from('中文文档.docx')));assert(received.includes(content));
  }finally{
    if(previous===undefined)delete process.env.PYTHONIOENCODING;else process.env.PYTHONIOENCODING=previous;
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});
  }
});
