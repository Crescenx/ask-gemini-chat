import {statusText} from './sync.js';

const button=document.querySelector('#sync');
function render(status){
  const checking=!status||status.state==='checking';
  document.querySelector('#connection').textContent=checking?'检查中':({connected:'已连接',disconnected:'未连接',unknown:'未确认'}[status.connection]||'未确认');
  document.querySelector('#login').textContent=checking?'检查中':status.state==='ready'?'已验证':status.code==='ACCOUNT_MISMATCH'?'账号不一致':['LOGIN_REQUIRED','MISSING_1PSID'].includes(status.code)?'需要登录':'未验证';
  document.querySelector('#message').textContent=statusText(status);
  document.querySelector('#checked').textContent=status?.checkedAt?`最近检查：${new Date(status.checkedAt).toLocaleString()}`:'';
  button.disabled=checking;
  button.textContent=checking?'正在同步…':'立即同步';
}
async function sync(){
  render({state:'checking'});
  try{render(await chrome.runtime.sendMessage({type:'sync'}));}
  catch{render({connection:'unknown',state:'error',code:'LOCAL_ERROR'});}
}
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='session'&&changes.status)render(changes.status.newValue);
});
button.addEventListener('click',sync);
void sync();
