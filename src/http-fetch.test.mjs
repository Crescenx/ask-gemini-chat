import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {httpFetch} from './http-fetch.mjs';

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
    await assert.rejects(httpFetch(root+'/break'),/HTTP_TRANSPORT_ERROR/);assert.equal(calls,5);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('missing HTTP helper fails explicitly and an already aborted call does not start',async()=>{
  const prior=process.env.GEMINI_HTTP_PYTHON;
  process.env.GEMINI_HTTP_PYTHON='/missing/gemini-python';
  try{
    await assert.rejects(httpFetch('http://localhost/'),/HTTP_TRANSPORT_UNAVAILABLE/);
    await assert.rejects(httpFetch('http://localhost/',{signal:AbortSignal.abort()}),{name:'AbortError'});
  }finally{if(prior===undefined)delete process.env.GEMINI_HTTP_PYTHON;else process.env.GEMINI_HTTP_PYTHON=prior;}
});
