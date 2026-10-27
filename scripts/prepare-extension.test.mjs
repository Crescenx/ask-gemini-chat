import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {prepareExtension,launcher,registerExtension,fixedExtensionId} from './prepare-extension.mjs';
import {nativeFrame,readNativeMessage} from '../src/extension-bridge.mjs';

test('development preparation confines artifacts to runtime and binds one extension',async()=>{
  const root=await fs.mkdtemp(join(tmpdir(),'gemini-extension-'));
  try{
    await assert.rejects(prepareExtension('invalid',root),/EXTENSION_ID_REQUIRED/);
    const id='a'.repeat(32),result=await prepareExtension(id,root);
    const manifest=JSON.parse(await fs.readFile(result.manifest));
    assert.deepEqual(manifest.allowed_origins,[`chrome-extension://${id}/`]);
    assert.deepEqual(await fs.readdir(root),['.runtime']);
    assert.equal(JSON.parse(await fs.readFile(join(root,'.runtime','extension.json'))).extensionId,id);
    assert.match(launcher('C:\\Program Files\\node.exe','C:\\Work\\extension-host.mjs','win32'),/"C:\\Program Files\\node.exe"/);
    assert.throws(()=>launcher('C:\\%TEMP%\\node.exe','host','win32'),/UNSUPPORTED_LAUNCHER_PATH/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('real host rejects an unapproved caller without leaking local configuration',async()=>{
  const child=spawn(process.execPath,['scripts/extension-host.mjs','chrome-extension://invalid/'],{stdio:['pipe','pipe','pipe']});
  const exit=new Promise(resolve=>child.on('exit',resolve));
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdin.on('error',()=>{});child.stdin.end(nativeFrame({version:1,type:'status'}));
  const response=await readNativeMessage(child.stdout);
  assert.equal(response.code,'BRIDGE_ERROR');assert.equal(await exit,1);
  assert(!JSON.stringify(response).includes(process.cwd()));assert(!stderr.includes('session.json'));
});

test('automatic registration is idempotent, retains legacy IDs and refuses another checkout',async()=>{
  const root=await fs.mkdtemp(join(tmpdir(),'gemini-register-'));
  try{
    await fs.mkdir(join(root,'extension'));
    await fs.copyFile(new URL('../extension/manifest.json',import.meta.url),join(root,'extension','manifest.json'));
    const old='b'.repeat(32),id=await fixedExtensionId(root);
    await prepareExtension(old,root);
    const options={root,platform:'linux',env:{},home:join(root,'home')};
    await registerExtension(options);await registerExtension(options);
    const config=JSON.parse(await fs.readFile(join(root,'.runtime','extension.json')));
    assert.equal(config.extensionId,id);assert.deepEqual(config.extensionIds,[id,old]);
    const target=join(root,'home','.config','google-chrome','NativeMessagingHosts','com.ask_gemini_chat.auth.json');
    const manifest=JSON.parse(await fs.readFile(target));
    assert.deepEqual(manifest.allowed_origins,[id,old].map(id=>`chrome-extension://${id}/`));
    manifest.path='/other/checkout/host';await fs.writeFile(target,JSON.stringify(manifest));
    await assert.rejects(registerExtension(options),/NATIVE_HOST_OWNED_BY_OTHER_CHECKOUT/);
    assert.equal(JSON.parse(await fs.readFile(target)).path,manifest.path);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('WSL registration derives Windows paths and distribution without hardcoded user names',async()=>{
  const root=await fs.mkdtemp(join(tmpdir(),'gemini-wsl-'));
  try{
    await fs.mkdir(join(root,'extension'));
    await fs.copyFile(new URL('../extension/manifest.json',import.meta.url),join(root,'extension','manifest.json'));
    const calls=[];
    await registerExtension({root,platform:'linux',env:{WSL_DISTRO_NAME:'Custom Linux'},execute:async(command,args)=>{
      calls.push([command,args]);return {stdout:command==='wslpath'?'C:\\mapped\\'+args[1].split('/').at(-1):'registered'};
    }});
    const [command,args]=calls.at(-1);assert.equal(command,'pwsh.exe');
    assert(args.includes('-WslLauncherFile'));assert(args.includes('-NoProfile'));
    assert.match(await fs.readFile(join(root,'.runtime','extension-host-wsl.cmd'),'utf8'),/--distribution "Custom Linux"/);
    await registerExtension({root,platform:'linux',env:{WSL_DISTRO_NAME:'Ubuntu-26.04'},execute:async command=>({stdout:command==='wslpath'?'C:\\mapped':'registered'})});
    assert.match(await fs.readFile(join(root,'.runtime','extension-host-wsl.cmd'),'utf8'),/--distribution Ubuntu-26\.04 --exec/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
