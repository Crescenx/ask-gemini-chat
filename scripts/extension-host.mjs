#!/usr/bin/env node
import fs from 'node:fs/promises';
import {SessionAuth} from '../src/web-auth.mjs';
import {readNativeMessage,nativeFrame,handleExtensionMessage} from '../src/extension-bridge.mjs';

try{
  const config=JSON.parse(await fs.readFile(new URL('../.runtime/extension.json',import.meta.url),'utf8'));
  const ids=config.extensionIds??[config.extensionId];
  if(!ids.some(id=>/^[a-p]{32}$/.test(id)&&process.argv[2]===`chrome-extension://${id}/`))throw Error('EXTENSION_NOT_ALLOWED');
  const message=await readNativeMessage(process.stdin);
  const result=await handleExtensionMessage(new SessionAuth(),message);
  process.stdout.end(nativeFrame(result));
}catch{
  // Never send exception text: request errors may contain authentication material.
  process.stdout.end(nativeFrame({version:1,connection:'connected',state:'error',code:'BRIDGE_ERROR',checkedAt:Date.now()}));
  process.exitCode=1;
}
