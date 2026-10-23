import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {SessionAuth,importCookies} from './web-auth.mjs';

const page=(identity='test@example.invalid')=>JSON.stringify({SNlM0e:'csrf-test',oPEP7c:identity,cfb2h:'build',FdrFJe:'sid',qKIAYe:'push'});
async function fixture(fn){
  const root=await fs.mkdtemp(path.join(tmpdir(),'gemini-auth-test-'));
  try{await fn(path.join(root,'session.json'));}finally{await fs.rm(root,{recursive:true,force:true});}
}
test('cookie import filters domains and rejects ambiguity and header injection',()=>{
  assert.deepEqual(importCookies([{name:'__Secure-1PSID',value:'good',domain:'.google.com'},{name:'__Secure-1PSIDTS',value:'bad',domain:'evil.invalid'},{name:'unrelated',value:'secret'}]),{'__Secure-1PSID':'good'});
  assert.throws(()=>importCookies({'__Secure-1PSID':'bad\r\nheader'}),/INVALID_COOKIE/);
  assert.throws(()=>importCookies([{name:'__Secure-1PSID',value:'a'},{name:'__Secure-1PSID',value:'b'}]),/AMBIGUOUS/);
});
test('initial import validates directly over HTTP, stores private cookies and binds account',()=>fixture(async file=>{
  let identity='test@example.invalid';const requests=[];
  const auth=new SessionAuth({file,fetchImpl:async(url,options)=>{requests.push({url,options});return new Response(page(identity));}});
  const ready=await auth.import({'__Secure-1PSID':'test-secret'});
  assert.equal(ready.state,'ready');assert.equal(requests[0].url,'https://gemini.google.com/app');
  assert.equal((await fs.stat(file)).mode&0o777,0o600);
  const original=await fs.readFile(file,'utf8');assert(!original.includes('csrf-test'));assert(!original.includes(identity));
  identity='other@example.invalid';await assert.rejects(auth.import({'__Secure-1PSID':'other'}),/ACCOUNT_MISMATCH/);
  assert.equal(await fs.readFile(file,'utf8'),original);
}));
test('HTTP rotation updates cookies once for concurrent callers and revalidates account',()=>fixture(async file=>{
  let rotations=0;
  const auth=new SessionAuth({file,now:()=>1000000,fetchImpl:async(url,options)=>{
    if(url.endsWith('/RotateCookies')){rotations++;return new Response('[]',{headers:{'set-cookie':'__Secure-1PSIDTS=new-ts; Secure; HttpOnly'}});}
    if(rotations)assert(options.headers.cookie.includes('__Secure-1PSIDTS=new-ts'));
    return new Response(page());
  }});
  await auth.import({'__Secure-1PSID':'test-secret'});
  await Promise.all([auth.ensure(),auth.ensure()]);assert.equal(rotations,1);
  assert.equal(JSON.parse(await fs.readFile(file)).cookies['__Secure-1PSIDTS'],'new-ts');
  await auth.ensure();assert.equal(rotations,1);
}));
test('revoked login becomes explicit reauth; transient errors preserve session',()=>fixture(async file=>{
  let status=200;
  const auth=new SessionAuth({file,fetchImpl:async()=>new Response(status===200?page():'error',{status})});
  await auth.import({'__Secure-1PSID':'test-secret'});
  const original=await fs.readFile(file,'utf8');
  status=503;await assert.rejects(auth.ensure(),/HTTP_503/);assert.equal(await fs.readFile(file,'utf8'),original);
  status=401;await assert.rejects(auth.ensure(),/LOGIN_REQUIRED/);
  const state=JSON.parse(await fs.readFile(file));assert.equal(state.state,'login_required');assert(state.account);assert.equal(state.cookies['__Secure-1PSID'],'test-secret');
  status=200;await auth.import({'__Secure-1PSID':'new-secret'});assert.equal(JSON.parse(await fs.readFile(file)).state,'ready');
}));
test('stale imported cookies recover by rotation; failed reimport preserves working store',()=>fixture(async file=>{
  let expired=true,revoked=false,rotations=0;
  const auth=new SessionAuth({file,fetchImpl:async url=>{
    if(url.endsWith('/RotateCookies')){rotations++;expired=false;return new Response('[]',{headers:{'set-cookie':'__Secure-1PSIDTS=renewed; Secure'}});}
    return new Response(expired||revoked?'anonymous':page());
  }});
  await auth.import({'__Secure-1PSID':'root'});
  assert.equal(rotations,1);
  const original=await fs.readFile(file,'utf8');
  assert.equal(JSON.parse(original).cookies['__Secure-1PSIDTS'],'renewed');
  revoked=true;
  await assert.rejects(auth.import({'__Secure-1PSID':'revoked'}),/LOGIN_REQUIRED/);
  assert.equal(await fs.readFile(file,'utf8'),original);
}));
test('server-cleared root cookie stays recoverable through reimport',()=>fixture(async file=>{
  let revoked=false;
  const auth=new SessionAuth({file,fetchImpl:async()=>revoked?new Response('',{status:401,headers:{'set-cookie':'__Secure-1PSID=; Max-Age=0'}}):new Response(page())});
  await auth.import({'__Secure-1PSID':'root'});
  revoked=true;await assert.rejects(auth.ensure(),/LOGIN_REQUIRED/);
  assert.deepEqual(await auth.status(),{state:'login_required',code:'LOGIN_REQUIRED'});
  revoked=false;await auth.import({'__Secure-1PSID':'replacement'});
  assert.equal((await auth.status()).state,'ready');
}));
