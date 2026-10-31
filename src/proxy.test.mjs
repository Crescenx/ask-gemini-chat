import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverProxies,createProxyRouter,proxyEnvironmentFor,selectedProxy,proxyFailure} from './proxy.mjs';

test('Windows and WSL read system settings and arbitrary proxy listener ports using PowerShell 7',async()=>{
  for(const platform of ['win32','linux']){
    const calls=[];
    const result=await discoverProxies({platform,env:{WSL_DISTRO_NAME:'test',HTTPS_PROXY:'http://user:secret@localhost:43210'},run:async(command,args)=>{
      calls.push({command,args});
      return {stdout:command==='pwsh.exe'?JSON.stringify({proxies:['http://localhost:43211'],listeners:['127.0.0.1:53210','[::1]:53211']}):''};
    }});
    assert.equal(calls[0].command,'pwsh.exe');
    assert.deepEqual(calls[0].args.slice(0,3),['-NoLogo','-NoProfile','-NonInteractive']);
    assert(result.candidates.some(c=>c.proxy==='http://localhost:43211'));
    assert(result.candidates.some(c=>c.proxy==='socks5h://[::1]:53211'));
    assert.equal(result.candidates.at(-1).proxy,null);
  }
});

test('Linux detects ports owned by proxy software and macOS reads static system proxies',async()=>{
  const linux=await discoverProxies({platform:'linux',env:{HTTPS_PROXY:'file:///private'},run:async()=>({stdout:'LISTEN 0 128 127.0.0.1:45678 0.0.0.0:* users:(("mihomo",pid=1,fd=3))\nLISTEN 0 128 127.0.0.1:45679 0.0.0.0:* users:(("database",pid=2,fd=3))'})});
  assert.deepEqual(linux.candidates.map(c=>c.proxy),['http://127.0.0.1:45678','socks5h://127.0.0.1:45678',null]);
  assert.equal(linux.warnings[0].code,'PROXY_INVALID_URL');
  const mac=await discoverProxies({platform:'darwin',env:{},run:async()=>({stdout:'HTTPSEnable : 1\nHTTPSProxy : localhost\nHTTPSPort : 45670\nSOCKSEnable : 1\nSOCKSProxy : localhost\nSOCKSPort : 45671'})});
  assert.deepEqual(mac.candidates.map(c=>c.proxy),['http://localhost:45670','socks5h://localhost:45671',null]);
});

test('discovery failures are reported and do not prevent checking an explicit route or direct connection',async()=>{
  const result=await discoverProxies({platform:'win32',env:{HTTPS_PROXY:'http://localhost:43210'},run:async()=>{throw Error('private command details');}});
  assert.equal(result.warnings[0].code,'PROXY_SYSTEM_DISCOVERY_FAILED');
  assert.equal(result.candidates.length,2);assert(!JSON.stringify(result).includes('private'));
  assert.equal(proxyEnvironmentFor({HTTPS_PROXY:'old',https_proxy:'older',OTHER:'keep',NO_PROXY:'localhost'},null).HTTPS_PROXY,undefined);
  assert.equal(proxyEnvironmentFor({NO_PROXY:'localhost'},'socks5h://localhost:43210').https_proxy,'socks5h://localhost:43210');
});

test('router verifies fallbacks, shares concurrent refresh, persists privately, and rechecks after a proxy switch',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'proxy-router-')),file=join(directory,'network.json');
  try{
    const old={proxy:'http://old:secret@localhost:43210',source:'environment:HTTPS_PROXY'};
    let current={proxy:'http://new:secret@localhost:43211',source:'windows-system'},discoveries=0;
    const checks=[];
    const discover=async()=>{discoveries++;return {candidates:[old,current,{proxy:null,source:'direct'}],warnings:[]};};
    const check=async proxy=>{checks.push(proxy);if(proxy!==current.proxy)throw Error('PROXY_CONNECT_FAILED');};
    const router=createProxyRouter({discover,test:check,file});
    const [a,b]=await Promise.all([router.refresh(),router.refresh()]);
    assert.deepEqual(a,b);assert.equal(discoveries,1);assert.equal(a.attempts[0].code,'PROXY_CONNECT_FAILED');
    assert(!JSON.stringify(a).includes('secret'));assert.equal((await stat(file)).mode&0o777,0o600);
    assert.equal((await selectedProxy('https://gemini.google.com/app',{file})).proxy,current.proxy);
    assert.equal(await selectedProxy('http://localhost/',{file}),undefined);
    checks.length=0;
    await createProxyRouter({discover,test:check,file}).refresh();
    assert.deepEqual(checks,[current.proxy]);
    current={proxy:'socks5h://localhost:43212',source:'windows-system'};
    const report=await router.refresh();assert.equal(report.endpoint,current.proxy);
    assert.equal(JSON.parse(await readFile(file)).proxy,current.proxy);
    const failed=createProxyRouter({discover,file,test:async()=>{throw Error('private credentials');}});
    await assert.rejects(failed.refresh(),error=>{
      assert.equal(error.code,'PROXY_NO_WORKING_ROUTE');
      assert.equal(error.network.attempts.length,3);assert(!JSON.stringify(error.network).includes('secret'));
      return true;
    });
    assert.equal(JSON.parse(await readFile(file)).proxy,current.proxy);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('proxy causes are separated from an origin failure or a stream interrupted after headers',()=>{
  assert.equal(proxyFailure({curl_code:5}),'PROXY_DNS_FAILED');
  assert.equal(proxyFailure({curl_code:7},'http://localhost:43210'),'PROXY_CONNECT_FAILED');
  assert.equal(proxyFailure({curl_code:7},null),'HTTP_TRANSPORT_ERROR_CURL_7');
  assert.equal(proxyFailure({curl_code:56,proxy_status:407}),'PROXY_AUTH_REQUIRED');
  assert.equal(proxyFailure({curl_code:56,proxy_status:502}),'PROXY_TUNNEL_FAILED');
  assert.equal(proxyFailure({curl_code:97}),'PROXY_HANDSHAKE_FAILED');
  assert.equal(proxyFailure({curl_code:56},'http://localhost:43210',true),'HTTP_TRANSPORT_ERROR_CURL_56');
});
