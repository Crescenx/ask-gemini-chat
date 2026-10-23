#!/usr/bin/env node
import fs from 'node:fs/promises';
import { sessionFile } from '../src/config.mjs';
import {SessionAuth,AuthError} from '../src/web-auth.mjs';

const [command='status',input]=process.argv.slice(2);
const auth=new SessionAuth({file:sessionFile});
try{
  if(command==='login'){
    const {browserLogin}=await import('../src/browser-login.mjs');
    console.log(JSON.stringify(await browserLogin(auth,{notify:code=>console.error(JSON.stringify({state:'waiting_for_user',code,next:guidance(code)}))})));
  }else if(command==='import'){
    if(!input)throw new AuthError('COOKIE_FILE_REQUIRED');
    const raw=input==='-'?await new Promise((resolve,reject)=>{let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>{data+=x;if(data.length>100000){reject(new AuthError('INPUT_TOO_LARGE'));process.stdin.destroy();}});process.stdin.on('end',()=>resolve(data));process.stdin.on('error',reject);}):await fs.readFile(input,'utf8');
    if(raw.length>100000)throw new AuthError('INPUT_TOO_LARGE');
    let parsed;try{parsed=JSON.parse(raw);}catch{throw new AuthError('INVALID_COOKIE_JSON');}
    console.log(JSON.stringify(await auth.import(parsed)));
  }else if(command==='refresh'){
    const session=await auth.ensure({refresh:true});console.log(JSON.stringify({state:'ready',account:session.account}));
  }else if(command==='status'){
    const status=await auth.status();console.log(JSON.stringify(status));if(status.state!=='ready')process.exitCode=2;
  }else throw new AuthError('USE_LOGIN_IMPORT_STATUS_OR_REFRESH');
}catch(e){console.error(JSON.stringify({state:'error',code:e instanceof AuthError?e.code:'LOCAL_ERROR',next:guidance(e.code)}));process.exitCode=2;}

function guidance(code) {
  const messages = {
    ENABLE_CHROME_REMOTE_DEBUGGING: 'In your own Chrome 144+, open chrome://inspect/#remote-debugging and enable Remote Debugging. Open https://gemini.google.com/app and sign in, then rerun login.',
    ALLOW_CHROME_CONNECTION: 'Confirm Allow in Chrome once. Keep this process running; it reuses this connection while you sign in.',
    OPEN_GEMINI_IN_BROWSER: 'Open https://gemini.google.com/app in this Chrome profile and sign in yourself. This process is waiting.',
    SIGN_IN_TO_GEMINI: 'Finish Google sign-in and any MFA in your own browser. Do not send passwords or cookies to the agent.',
    LOGIN_REQUIRED: 'Finish signing in to Gemini and run npm run auth -- login. The MCP server resumes without restarting.',
    BROWSER_PROFILE_AMBIGUOUS: 'Select your Chrome User Data directory with GEMINI_CHROME_PROFILE. Do not guess between profiles.',
    OPEN_DEFAULT_GEMINI_ACCOUNT: 'Open Gemini with the default Google account (account 0), or use a separate Chrome profile for the intended account.',
    ACCOUNT_MISMATCH: 'The browser account differs from the saved account. Use a separate GEMINI_DATA_DIR for a different account; do not replace existing state.',
    BROWSER_PERMISSION_TIMEOUT: 'The Chrome permission dialog timed out. Check Chrome, then retry once when ready.',
    BROWSER_UNAVAILABLE: 'Check that Chrome is running with Remote Debugging enabled. For custom profiles, set GEMINI_CHROME_PROFILE to the User Data directory.',
    NETWORK_ERROR: 'Check network and proxy settings. Do not reimport cookies to fix a transport error.',
  };
  return messages[code] || 'See INSTALL.md troubleshooting. Do not print session files or cookie values.';
}
