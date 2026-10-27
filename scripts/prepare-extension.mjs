#!/usr/bin/env node
import {mkdir,writeFile,readFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nativeHostName} from '../src/extension-bridge.mjs';

const rootDirectory=fileURLToPath(new URL('..',import.meta.url));
const exec=promisify(execFile);
export async function fixedExtensionId(root=rootDirectory){
  const manifest=JSON.parse(await readFile(join(root,'extension','manifest.json'),'utf8'));
  if(!manifest.key)throw Error('EXTENSION_KEY_MISSING');
  return createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
}
async function readJSON(file){
  try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return undefined;throw error;}
}
async function saveJSON(file,value){
  const temp=file+'.tmp';
  await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  await rename(temp,file);
}

export function launcher(node,script,platform=process.platform){
  if(platform==='win32'){
    if([node,script].some(p=>/["%\r\n]/.test(p)))throw Error('UNSUPPORTED_LAUNCHER_PATH');
    return `@echo off\r\n"${node}" "${script}" %*\r\n`;
  }
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  return `#!/bin/sh\nexec ${quote(node)} ${quote(script)} "$@"\n`;
}

export async function prepareExtension(extensionId,root=rootDirectory){
  extensionId??=await fixedExtensionId(root);
  if(!/^[a-p]{32}$/.test(extensionId??''))throw Error('EXTENSION_ID_REQUIRED');
  const directory=join(root,'.runtime');
  await mkdir(directory,{recursive:true,mode:0o700});
  const host=join(directory,process.platform==='win32'?'extension-host.cmd':'extension-host');
  await writeFile(host,launcher(process.execPath,join(root,'scripts','extension-host.mjs')),{mode:0o700});
  const previous=await readJSON(join(directory,'extension.json'));
  const extensionIds=[...new Set([extensionId,...(previous?.extensionIds??[]),previous?.extensionId].filter(id=>/^[a-p]{32}$/.test(id??'')))];
  await saveJSON(join(directory,'extension.json'),{extensionId,extensionIds});
  const manifest=join(directory,nativeHostName+'.json');
  await saveJSON(manifest,{name:nativeHostName,description:'Gemini login synchronization',path:host,type:'stdio',allowed_origins:extensionIds.map(id=>`chrome-extension://${id}/`)});
  return {manifest,extensionId};
}

export async function registerExtension({root=rootDirectory,platform=process.platform,env=process.env,home=homedir(),execute=exec}={}){
  const prepared=await prepareExtension(undefined,root);
  const script=join(root,'scripts','extension-host.mjs');
  if(platform==='win32'||env.WSL_DISTRO_NAME){
    const toWindows=async file=>env.WSL_DISTRO_NAME?(await execute('wslpath',['-w',file])).stdout.trim():file;
    const args=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',await toWindows(join(root,'scripts','register-extension.ps1')),
      '-ManifestFile',await toWindows(prepared.manifest),'-OwnerScript',script];
    if(env.WSL_DISTRO_NAME){
      const values=[env.WSL_DISTRO_NAME,process.execPath,script];
      if(values.some(v=>/["%\r\n]/.test(v)))throw Error('UNSUPPORTED_LAUNCHER_PATH');
      // WSL may treat unnecessary quotes around --distribution as part of its name.
      const distribution=/[\s&|<>^()]/.test(values[0])?`"${values[0]}"`:values[0];
      const file=join(root,'.runtime','extension-host-wsl.cmd');
      await writeFile(file,`@echo off\r\n"%SystemRoot%\\System32\\wsl.exe" --distribution ${distribution} --exec "${values[1]}" "${values[2]}" %*\r\n`,{mode:0o700});
      args.push('-WslLauncherFile',await toWindows(file));
    }
    await execute('pwsh.exe',args,{timeout:30000});
  }else{
    const directory=platform==='darwin'?join(home,'Library','Application Support','Google','Chrome','NativeMessagingHosts'):
      join(env.XDG_CONFIG_HOME||join(home,'.config'),'google-chrome','NativeMessagingHosts');
    const destination=join(directory,nativeHostName+'.json');
    const incoming=await readJSON(prepared.manifest),existing=await readJSON(destination);
    if(existing&&existing.path!==incoming.path)throw Error('NATIVE_HOST_OWNED_BY_OTHER_CHECKOUT');
    await mkdir(directory,{recursive:true,mode:0o700});
    await saveJSON(destination,incoming);
  }
  return {...prepared,state:'registered'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  prepareExtension(process.argv[2]).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
