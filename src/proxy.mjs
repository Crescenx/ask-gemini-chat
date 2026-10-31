import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dataDirectory,installationConfig,installedPython} from './config.mjs';

const execute=promisify(execFile);
const keys=['https_proxy','HTTPS_PROXY','all_proxy','ALL_PROXY','http_proxy','HTTP_PROXY'];
const hosts=new Set(['gemini.google.com','accounts.google.com','content-push.googleapis.com']);
const target='https://gemini.google.com/app';
const networkFile=join(dataDirectory,'network.json');
const proxyProcesses='clash|mihomo|sing.?box|hiddify|v2ray|xray|ss-local|sslocal|shadowsocks|trojan|naive|nekoray|nekobox|outline|brook|gost';

export function proxyURL(value){
  const url=new URL(value.includes('://')?value:'http://'+value);
  if(!['http:','https:','socks4:','socks4a:','socks5:','socks5h:'].includes(url.protocol)||!url.hostname||url.pathname!=='/'&&url.pathname!==''||url.search||url.hash)throw Error('PROXY_INVALID_URL');
  return url.href.replace(/\/$/,'');
}
export function proxyEndpoint(value){
  if(value===null)return 'direct';
  try{const url=new URL(value);return `${url.protocol}//${url.hostname}${url.port?':'+url.port:''}`;}catch{return 'invalid';}
}
export function proxyFailure(meta={},proxy=null,opened=false){
  const curl=meta.curl_code,status=meta.proxy_status;
  if(status===407)return 'PROXY_AUTH_REQUIRED';
  if(status>=400)return 'PROXY_TUNNEL_FAILED';
  if(curl===5)return 'PROXY_DNS_FAILED';
  if(curl===97)return 'PROXY_HANDSHAKE_FAILED';
  if(proxy&&!opened&&curl===7)return 'PROXY_CONNECT_FAILED';
  return Number.isInteger(curl)&&curl>0?`HTTP_TRANSPORT_ERROR_CURL_${curl}`:'HTTP_TRANSPORT_ERROR';
}

// Query the user's current system settings, not a stale proxy inherited by PowerShell.
const windowsDiscovery=`
$ErrorActionPreference = 'Stop'
foreach ($name in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY')) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
$proxies = @()
$warnings = @()
try {
  $target = [Uri]'https://gemini.google.com/app'
  $proxy = [System.Net.Http.HttpClient]::DefaultProxy.GetProxy($target)
  if ($proxy -and $proxy.AbsoluteUri -ne $target.AbsoluteUri) { $proxies += $proxy.AbsoluteUri }
} catch { $warnings += 'PROXY_SYSTEM_DISCOVERY_FAILED' }
$listeners = @()
try {
  $ids = @(Get-Process | Where-Object { $_.ProcessName -match '${proxyProcesses}' } | Select-Object -ExpandProperty Id)
  if ($ids.Count) {
    $listeners = @(Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in $ids -and $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::1','::') } | ForEach-Object {
      $hostName = if ($_.LocalAddress -in @('::1','::')) { '[::1]' } else { '127.0.0.1' }
      $hostName + ':' + $_.LocalPort
    } | Sort-Object -Unique)
  }
} catch { $warnings += 'PROXY_LISTENER_DISCOVERY_FAILED' }
@{proxies=$proxies;listeners=$listeners;warnings=$warnings} | ConvertTo-Json -Compress
`;

export async function discoverProxies({env={...installationConfig?.env,...process.env},platform=process.platform,run=execute}={}){
  const candidates=[],warnings=[];
  const add=(proxy,source)=>{
    try{proxy=proxy===null?null:proxyURL(proxy);}
    catch{warnings.push({code:'PROXY_INVALID_URL',source});return;}
    if(!candidates.some(c=>c.proxy===proxy))candidates.push({proxy,source});
  };
  for(const key of keys)if(env[key])add(env[key],`environment:${key}`);
  if(platform==='win32'||env.WSL_DISTRO_NAME||env.WSL_INTEROP){
    try{
      const {stdout}=await run('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',windowsDiscovery],{maxBuffer:Infinity});
      const system=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());
      for(const code of system.warnings??[])warnings.push({code,source:'windows'});
      for(const proxy of system.proxies??[])add(proxy,'windows-system');
      for(const address of system.listeners??[])for(const scheme of ['http','socks5h'])add(`${scheme}://${address}`,'windows-listener');
    }catch{warnings.push({code:'PROXY_SYSTEM_DISCOVERY_FAILED',source:'windows'});}
  }
  if(platform==='darwin'){
    try{
      const {stdout}=await run('scutil',['--proxy'],{maxBuffer:Infinity});
      const get=key=>stdout.match(new RegExp(`\\b${key}\\s*:\\s*(\\S+)`))?.[1];
      for(const [name,scheme] of [['HTTPS','http'],['HTTP','http'],['SOCKS','socks5h']])if(get(name+'Enable')==='1'&&get(name+'Proxy')&&get(name+'Port'))add(`${scheme}://${get(name+'Proxy')}:${get(name+'Port')}`,'macos-system');
    }catch{warnings.push({code:'PROXY_SYSTEM_DISCOVERY_FAILED',source:'macos'});}
  }
  if(platform==='linux'){
    try{
      const {stdout}=await run('ss',['-ltnpH'],{maxBuffer:Infinity});
      for(const line of stdout.split('\n'))if(new RegExp(proxyProcesses,'i').test(line)){
        const address=line.trim().split(/\s+/)[3];
        const match=address?.match(/^(127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]|\*):(\d+)$/);
        if(match)for(const scheme of ['http','socks5h'])add(`${scheme}://${match[1].includes(':')?'[::1]':'127.0.0.1'}:${match[2]}`,'linux-listener');
      }
    }catch{warnings.push({code:'PROXY_LISTENER_DISCOVERY_FAILED',source:'linux'});}
  }
  add(null,'direct');
  return {candidates,warnings};
}

export async function selectedProxy(url,{file=networkFile}={}){
  if(!hosts.has(new URL(url).hostname))return undefined;
  let state;
  try{state=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return undefined;throw Error('PROXY_STATE_UNREADABLE');}
  if(state.version!==1||state.proxy!==null&&typeof state.proxy!=='string')throw Error('PROXY_STATE_UNREADABLE');
  if(state.proxy!==null)proxyURL(state.proxy);
  return {proxy:state.proxy,source:state.source};
}

export function proxyEnvironmentFor(env,proxy){
  const result={...env};
  for(const key of keys)delete result[key];
  if(proxy)for(const key of keys)result[key]=proxy;
  return result;
}

export async function probeProxy(proxy,{python}={}){
  const {httpFetch}=await import('./http-fetch.mjs');
  const response=await httpFetch(target,{python,proxyRoute:{proxy,source:'probe'},signal:AbortSignal.timeout(30000)});
  await response.body?.cancel();
  if(response.status===407)throw Error('PROXY_AUTH_REQUIRED');
  if(response.status<200||response.status>=400)throw Error(`NETWORK_HTTP_${response.status}`);
}

// System curl can bootstrap npm/pip before curl_cffi has been installed.
export async function bootstrapProbe(proxy,{python=installedPython||(process.platform==='win32'?'python':'python3')}={}){
  const config=`url = ${JSON.stringify(target)}\nproxy = ${JSON.stringify(proxy??'')}\nnoproxy = ""\nsilent\nconnect-timeout = 20\nmax-time = 30\noutput = ${JSON.stringify(process.platform==='win32'?'NUL':'/dev/null')}\nwrite-out = "%{http_code} %{http_connect}"\n`;
  await new Promise((resolve,reject)=>{
    const child=spawn(process.platform==='win32'?'curl.exe':'curl',['--config','-'],{stdio:['pipe','pipe','ignore']});
    let stdout='',missing=false;
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stdin.on('error',()=>{});
    child.once('error',error=>{if(error.code==='ENOENT'){missing=true;resolve(false);}else reject(Error('PROXY_PROBE_UNAVAILABLE'));});
    child.once('close',code=>{
      if(missing)return;
      const [status,proxyStatus]=stdout.trim().split(/\s+/).map(Number);
      if(code===0&&status>=200&&status<400)resolve(true);
      else reject(Error(status===407?'PROXY_AUTH_REQUIRED':code===0?`NETWORK_HTTP_${status}`:proxyFailure({curl_code:code,proxy_status:proxyStatus},proxy)));
    });
    child.stdin.end(config);
  }).then(async available=>{
    if(available)return;
    const {stdout}=await new Promise((resolve,reject)=>{
      const child=spawn(python,[fileURLToPath(new URL('./proxy-probe.py',import.meta.url))],{stdio:['pipe','pipe','ignore']});
      let stdout='';
      child.stdout.on('data',chunk=>{stdout+=chunk;});child.stdin.on('error',()=>{});
      child.once('error',()=>reject(Error('PROXY_PROBE_UNAVAILABLE')));
      child.once('close',()=>resolve({stdout}));child.stdin.end(JSON.stringify({url:target,proxy}));
    });
    let result;try{result=JSON.parse(stdout);}catch{throw Error('PROXY_PROBE_UNAVAILABLE');}
    if(result.error)throw Error(result.error);
  });
}

export function createProxyRouter({discover=discoverProxies,test=probeProxy,file=networkFile}={}){
  let pending,previous,signature;
  return {refresh(){
    if(pending)return pending;
    pending=(async()=>{
      const {candidates,warnings}=await discover();
      const nextSignature=JSON.stringify(candidates);
      if(!previous&&file){
        try{
          const stored=JSON.parse(await readFile(file,'utf8'));
          if(stored.signature===nextSignature){previous=candidates.find(c=>c.proxy===stored.proxy);signature=nextSignature;}
        }catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
      }
      const ordered=signature===nextSignature&&previous?[previous,...candidates.filter(c=>c.proxy!==previous.proxy)]:candidates;
      const attempts=[];
      for(const candidate of ordered){
        const detail={endpoint:proxyEndpoint(candidate.proxy),source:candidate.source};
        try{await test(candidate.proxy);}
        catch(error){attempts.push({...detail,code:/^[A-Z][A-Z0-9_]*$/.test(error.message)?error.message:'NETWORK_ERROR'});continue;}
        const checkedAt=new Date().toISOString();
        const report={state:'ready',...detail,checkedAt,attempts,warnings};
        if(file){
          await mkdir(dirname(file),{recursive:true,mode:0o700});
          const temp=file+'.'+randomUUID()+'.tmp';
          await writeFile(temp,JSON.stringify({version:1,...candidate,checkedAt,signature:nextSignature}),{mode:0o600});await rename(temp,file);
        }
        previous=candidate;signature=nextSignature;
        return report;
      }
      const code=candidates.some(c=>c.proxy)?'PROXY_NO_WORKING_ROUTE':'NETWORK_UNREACHABLE';
      throw Object.assign(Error(code),{code,network:{state:'error',code,attempts,warnings}});
    })().finally(()=>{pending=null;});
    return pending;
  }};
}
export const automaticProxy=createProxyRouter();
