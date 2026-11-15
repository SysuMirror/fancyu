const token=localStorage.getItem('token'),statusBox=document.getElementById('status'),controls=document.getElementById('controls');
if(!token)location.replace('/login?redirect=/verify-student');
async function call(suffix='',body){const r=await fetch('/api/account/student-verification'+suffix,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(d.code!==200)throw Error(d.msg||'暂时无法验证，请稍后重试');return d;}
function setStatus(msg,isErr){statusBox.textContent=msg;statusBox.classList.toggle('error',!!isErr);}
async function load(){try{const d=await call();controls.hidden=d.verified;setStatus(d.verified?'学生邮箱已验证。你可以主动开启任一种配对。':'请获取并填写学生邮箱收到的验证码。');}catch(e){setStatus(e.message,true);}}
async function action(fn){const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{await fn();}catch(e){setStatus(e.message,true);}finally{buttons.forEach(b=>b.disabled=false);}}
let sendTimer=null;
function startSendCountdown(sec){const b=document.getElementById('send');let n=sec;b.disabled=true;b.textContent='重新发送（'+n+'s）';clearInterval(sendTimer);sendTimer=setInterval(()=>{n-=1;if(n<=0){clearInterval(sendTimer);b.disabled=false;b.textContent='重新发送验证码';}else b.textContent='重新发送（'+n+'s）';},1000);}
document.getElementById('send').onclick=async()=>{let ok=false;await action(async()=>{const d=await call('/send',{});setStatus(d.msg);ok=true;});if(ok)startSendCountdown(60);};
document.getElementById('verifyForm').onsubmit=e=>{e.preventDefault();const input=e.target.elements.code;action(async()=>{await call('/confirm',{code:input.value.trim()});e.target.reset();await load();});};
if(token)load();
