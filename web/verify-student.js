const token=localStorage.getItem('token'),statusBox=document.getElementById('status'),controls=document.getElementById('controls');
if(!token)location.replace('/login?redirect=/verify-student');
async function call(suffix='',body){const r=await fetch('/api/account/student-verification'+suffix,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(d.code!==200)throw Error(d.msg||'暂时无法验证，请稍后重试');return d;}
async function load(){try{const d=await call();controls.hidden=d.verified;statusBox.textContent=d.verified?'学生邮箱已验证。你可以主动开启任一种配对。':'请获取并填写学生邮箱收到的验证码。';}catch(e){statusBox.textContent=e.message;}}
async function action(fn){const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{await fn();}catch(e){statusBox.textContent=e.message;}finally{buttons.forEach(b=>b.disabled=false);}}
document.getElementById('send').onclick=()=>action(async()=>{const d=await call('/send',{});statusBox.textContent=d.msg;});
document.getElementById('verifyForm').onsubmit=e=>{e.preventDefault();action(async()=>{await call('/confirm',{code:e.target.elements.code.value.trim()});e.target.reset();await load();});};
if(token)load();
