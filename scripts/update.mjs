#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root=fileURLToPath(new URL('..',import.meta.url));
export function update({npm=process.env.npm_execpath,run=(command,args)=>{
  const result=spawnSync(command,args,{cwd:root,stdio:'inherit'});
  if(result.error||result.status!==0)throw Error('UPDATE_STEP_FAILED');
}}={}){
  if(!npm)throw Error('RUN_NPM_RUN_UPDATE');
  run('git',['pull','--ff-only']);
  run(process.execPath,[npm,'run','setup']);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{update();}catch(error){console.error(error.message);process.exitCode=1;}
}
