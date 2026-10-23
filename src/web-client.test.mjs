import test from 'node:test';
import assert from 'node:assert/strict';
import {WebAPI,GENERATION_TIMEOUT_MS,GENERATION_WAIT_MS} from './web-client.mjs';
import {ARGON,generation} from './web-protocol.mjs';

const session={cookies:{'__Secure-1PSID':'private-cookie'},accessToken:'private-csrf',build:'build',sessionId:'session',pushId:'push'};
const auth={ensure:async()=>structuredClone(session)};
const frame=JSON.stringify([['wrb.fr',null,JSON.stringify([null,['c_abc','r_abc'],null,null,[['rc_abc',['answer'],null,null,null,null,null,null,[2]]]])]])+'\n';
async function done(api,id){await api.requests.get(id).task;return api.poll(id);}

test('HTTP client uploads, streams, deduplicates and reads history without attestations or credential leaks',async()=>{
  const calls=[];
  const api=new WebAPI({auth,fetchImpl:async(url,options)=>{
    calls.push({url,options});
    if(url.includes('content-push')){assert(!options.headers.cookie);assert.equal(options.body.get('file').type,'text/plain');return new Response('/contrib_service/test');}
    assert.equal(options.headers.cookie,'__Secure-1PSID=private-cookie');
    if(url.includes('StreamGenerate')){
      const body=JSON.parse(JSON.parse(options.body.get('f.req'))[1]);
      assert.equal(body[0][0],'exact prompt');assert.equal(body[3],null);assert.equal(body[4],null);
      assert.deepEqual(body[2].slice(0,3),['c_abc','r_abc','rc_abc']);assert.deepEqual(body[6],[0]);
      assert.equal(JSON.parse(options.headers['x-goog-ext-525001261-jspb'])[4],ARGON);
      const bytes=new TextEncoder().encode(frame);
      return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.slice(0,21));controller.enqueue(bytes.slice(21));controller.close();}}));
    }
    return new Response('history');
  }});
  assert.equal((await api.init()).browserRequired,false);
  const files=await api.upload([{name:'x.txt',base64:Buffer.from('file').toString('base64')}]);
  assert.deepEqual(files,[[['/contrib_service/test',3,null,'text/plain'],'x.txt',null,null,null,null,null,null,[0]]]);
  const input={id:'test-id',prompt:'exact prompt',metadata:['c_abc','r_abc','rc_abc'],files};
  const request=api.request.bind(api);
  api.request=(url,options,timeout)=>{
    if(url.includes('StreamGenerate')){
      assert.equal(timeout,30*60*1000);assert.equal(timeout,GENERATION_TIMEOUT_MS);
      assert(GENERATION_WAIT_MS>timeout);
    }
    return request(url,options,timeout);
  };
  await api.start(input);await api.start(input);
  const result=await done(api,input.id);
  assert(result.done&&result.exhausted);assert.equal(generation(result.raw).text,'answer');
  assert.equal(calls.filter(c=>c.url.includes('StreamGenerate')).length,1);
  await assert.rejects(api.start({...input,prompt:'changed'}),/REQUEST_ID_CONFLICT/);
  assert.equal(await api.history('c_abc'),'history');
  assert(!JSON.stringify(result).includes('private-'));
  await assert.rejects(new WebAPI({auth}).poll(input.id),/REQUEST_UNKNOWN/);
});

test('authentication failure and uncertain transport do not automatically resend',async()=>{
  let sent=0;
  const api=new WebAPI({auth:{ensure:async()=>{throw Error('LOGIN_REQUIRED');}},fetchImpl:async()=>{sent++;throw Error('private network detail');}});
  await api.start({id:'a',prompt:'test'});assert.equal((await done(api,'a')).error,'LOGIN_REQUIRED');assert.equal(sent,0);
  api.auth=auth;
  await api.start({id:'b',prompt:'test'});assert.equal((await done(api,'b')).error,'TRANSPORT_ERROR');
  await api.start({id:'b',prompt:'test'});assert.equal(sent,1);
  api.fetch=async()=>{sent++;throw new DOMException('private timeout detail','TimeoutError');};
  await api.start({id:'c',prompt:'test'});assert.equal((await done(api,'c')).error,'GENERATION_TIMEOUT');
  await api.start({id:'c',prompt:'test'});assert.equal(sent,2);
});

test('CSV and image uploads preserve their MIME type in both multipart and file descriptors',async()=>{
  const types=[];
  const api=new WebAPI({auth,fetchImpl:async(_url,options)=>{types.push(options.body.get('file').type);return new Response('/contrib_service/file');}});
  const files=await api.upload(['table.csv','image.png'].map(name=>({name,base64:Buffer.from('fixture').toString('base64')})));
  assert.deepEqual(types,['text/csv','image/png']);
  assert.deepEqual(files.map(file=>[file[0][1],file[0][3]]),[[3,'text/csv'],[1,'image/png']]);
});

test('history retries one transient read failure; mutating RPCs never retry',async()=>{
  let calls=0;
  const api=new WebAPI({auth,fetchImpl:async()=>{if(++calls===1)throw Error('HTTP_TRANSPORT_ERROR');return new Response('history');}});
  assert.equal(await api.history('c_abc'),'history');assert.equal(calls,2);
  calls=0;
  await assert.rejects(api.rpc('KDNZr',['c_abc','r_abc']),/HTTP_TRANSPORT_ERROR/);assert.equal(calls,1);
});
