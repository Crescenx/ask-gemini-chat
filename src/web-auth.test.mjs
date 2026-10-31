import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
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

test('login and every maintenance pass prepare the network; proxy failure preserves the saved session',()=>fixture(async file=>{
  let checks=0,broken=false;
  const network={state:'error',code:'PROXY_NO_WORKING_ROUTE',attempts:[{endpoint:'http://127.0.0.1:43210',source:'fixture',code:'PROXY_CONNECT_FAILED'}],warnings:[]};
  const auth=new SessionAuth({file,fetchImpl:async()=>new Response(page()),prepareNetwork:async()=>{
    checks++;if(broken)throw Object.assign(Error(network.code),{code:network.code,network});return {state:'ready'};
  }});
  await auth.import({'__Secure-1PSID':'test-secret'});assert.equal(checks,1);
  await Promise.all([auth.ensure({detectProxy:true}),auth.ensure({detectProxy:true})]);assert.equal(checks,2);
  await auth.ensure();assert.equal(checks,2);
  await auth.ensure({detectProxy:true});assert.equal(checks,3);
  const saved=await fs.readFile(file,'utf8');broken=true;
  const status=await auth.status();assert.equal(status.code,'PROXY_NO_WORKING_ROUTE');assert.deepEqual(status.network,network);
  assert.equal(await fs.readFile(file,'utf8'),saved);
}));
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
  let rotations=0,now=1000000;
  const auth=new SessionAuth({file,now:()=>now,fetchImpl:async(url,options)=>{
    if(url.endsWith('/RotateCookies')){rotations++;return new Response('[]',{headers:{'set-cookie':'__Secure-1PSIDTS=new-ts; Secure; HttpOnly'}});}
    if(rotations)assert(options.headers.cookie.includes('__Secure-1PSIDTS=new-ts'));
    return new Response(page());
  }});
  await auth.import({'__Secure-1PSID':'test-secret'});
  await Promise.all([auth.ensure(),auth.ensure()]);assert.equal(rotations,1);
  assert.equal(JSON.parse(await fs.readFile(file)).cookies['__Secure-1PSIDTS'],'new-ts');
  await auth.ensure();assert.equal(rotations,1);
  now+=600000;await auth.ensure();assert.equal(rotations,2);
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

test('separate processes serialize rotation and persist the newest cookies',()=>fixture(async file=>{
  const auth=new SessionAuth({file,fetchImpl:async()=>new Response(page())});
  await auth.import({'__Secure-1PSID':'root'});
  const source=`
    import {SessionAuth} from ${JSON.stringify(new URL('./web-auth.mjs',import.meta.url).href)};
    const auth=new SessionAuth({file:process.argv[1],fetchImpl:async(url,options)=>{
      if(url.endsWith('/RotateCookies')){
        const n=Number(options.headers.cookie.match(/__Secure-1PSIDTS=(\\d+)/)?.[1]||0)+1;
        await new Promise(r=>setTimeout(r,100));
        return new Response('[]',{headers:{'set-cookie':'__Secure-1PSIDTS='+n+'; Secure'}});
      }
      return new Response(${JSON.stringify(page())});
    }});
    await auth.ensure({refresh:true});
  `;
  const run=()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',source,file],{stdio:'ignore'});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('child exit '+code)));
  });
  await Promise.all([run(),run(),run()]);
  assert.equal((await auth.load()).cookies['__Secure-1PSIDTS'],'3');
}));

test('login waits for refresh and cannot be overwritten by its old snapshot',()=>fixture(async file=>{
  let unblock,entered;
  const started=new Promise(r=>{entered=r;});
  const auth=new SessionAuth({file,fetchImpl:async url=>{
    if(url.endsWith('/RotateCookies')){entered();await new Promise(r=>{unblock=r;});return new Response('[]');}
    return new Response(page());
  }});
  await auth.import({'__Secure-1PSID':'old'});
  const refresh=auth.ensure();await started;
  const other=new SessionAuth({file,fetchImpl:async()=>new Response(page())});
  const login=other.import({'__Secure-1PSID':'new'});
  unblock();await Promise.all([refresh,login]);
  assert.equal((await auth.load()).cookies['__Secure-1PSID'],'new');
}));

test('a crashed refresh releases the cross-process lock',()=>fixture(async file=>{
  const auth=new SessionAuth({file,fetchImpl:async()=>new Response(page())});
  await auth.import({'__Secure-1PSID':'root'});
  const source=`
    import {SessionAuth} from ${JSON.stringify(new URL('./web-auth.mjs',import.meta.url).href)};
    const auth=new SessionAuth({file:process.argv[1]});
    await auth.exclusive(async()=>{console.log('locked');await new Promise(r=>setTimeout(r,60000));});
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',source,file],{stdio:['ignore','pipe','ignore']});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  try{
    await new Promise((resolve,reject)=>{
      child.stdout.once('data',resolve);child.once('error',reject);
      child.once('exit',()=>reject(Error('child exited before locking')));
    });
    child.kill('SIGKILL');await exited;
    await auth.ensure();assert.equal((await auth.load()).state,'ready');
  }finally{child.kill('SIGKILL');await exited;}
}));

test('account mismatch pauses maintenance without replacing account or cookies',()=>fixture(async file=>{
  let changed=false;
  const auth=new SessionAuth({file,fetchImpl:async url=>url.endsWith('/RotateCookies')
    ?new Response('[]',{headers:{'set-cookie':'__Secure-1PSIDTS=changed; Secure'}})
    :new Response(page(changed?'different@example.invalid':'test@example.invalid'))});
  await auth.import({'__Secure-1PSID':'root','__Secure-1PSIDTS':'original'});
  const before=await auth.load();changed=true;
  await assert.rejects(auth.ensure(),/ACCOUNT_MISMATCH/);
  const after=await auth.load();
  assert.equal(after.state,'login_required');assert.equal(after.account,before.account);
  assert.deepEqual(after.cookies,before.cookies);
}));

test('browser synchronization keeps HTTP-rotated cookies until the browser snapshot changes',()=>fixture(async file=>{
  let rotations=0,identity='test@example.invalid',now=1000000,fail=false;
  const auth=new SessionAuth({file,now:()=>now,fetchImpl:async url=>{
    if(fail)throw Error('offline');
    if(url.endsWith('/RotateCookies'))return new Response('[]',{headers:{'set-cookie':`__Secure-1PSIDTS=http-${++rotations}; Secure`}});
    return new Response(page(identity));
  }});
  const browser={'__Secure-1PSID':'browser','__Secure-1PSIDTS':'browser-ts'};
  await auth.syncBrowser(browser);
  await auth.ensure();
  assert.equal((await auth.load()).cookies['__Secure-1PSIDTS'],'http-1');
  await auth.syncBrowser(browser);
  assert.equal((await auth.load()).cookies['__Secure-1PSIDTS'],'http-1');
  assert.equal(rotations,1);
  const before=await fs.readFile(file,'utf8');
  fail=true;await assert.rejects(auth.syncBrowser(browser),/NETWORK_ERROR/);
  assert.equal(await fs.readFile(file,'utf8'),before);
  fail=false;identity='other@example.invalid';
  await assert.rejects(auth.syncBrowser({'__Secure-1PSID':'other'}),/ACCOUNT_MISMATCH/);
  assert.equal(await fs.readFile(file,'utf8'),before);
  identity='test@example.invalid';now+=600000;
  await auth.syncBrowser({'__Secure-1PSID':'new-login'});
  assert.equal((await auth.load()).cookies['__Secure-1PSID'],'new-login');
}));

test('browser synchronization retries import after a saved session is revoked',()=>fixture(async file=>{
  let dead=false;
  const auth=new SessionAuth({file,fetchImpl:async(url,options)=>{
    if(url.endsWith('/RotateCookies'))return new Response('[]',{headers:{'set-cookie':'__Secure-1PSIDTS=bad; Secure'}});
    return new Response(dead&&options.headers.cookie.includes('=bad')?'anonymous':page());
  }});
  const cookies={'__Secure-1PSID':'browser','__Secure-1PSIDTS':'good'};
  await auth.syncBrowser(cookies);await auth.ensure();
  dead=true;
  await auth.syncBrowser(cookies);
  assert.equal((await auth.load()).state,'ready');
  assert.equal((await auth.load()).cookies['__Secure-1PSIDTS'],'good');
}));
