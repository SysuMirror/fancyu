'use strict';
(()=>{
const $=id=>document.getElementById(id);let loading=false;
function status(title,copy,href,icon='→'){ $('statusTitle').textContent=title;$('statusText').textContent=copy;$('statusLink').href=href;$('statusIcon').textContent=icon;$('statusAnnouncement').textContent=title+'，'+copy; }
function guest(){ $('userMenu').hidden=true;$('loginLink').hidden=false;status('登录，开启校园相遇','选择一种方式，开始认识新朋友','/login?redirect=/'); }
async function loadAccount(){if(loading)return;const token=localStorage.getItem('token');if(!token){guest();return;}loading=true;status('正在读取账号状态','请稍候，正在确认学生邮箱验证状态','#');try{
 const headers={Authorization:'Bearer '+token};const responses=await Promise.all([fetch('/api/account/me',{headers}),fetch('/api/account/student-verification',{headers})]);
 if(responses.some(r=>r.status===401)){guest();return;}
 if(responses.some(r=>!r.ok))throw Error('unavailable');const [account,verification]=await Promise.all(responses.map(r=>r.json()));if(account.code!==200||verification.code!==200||!account.user)throw Error('unavailable');
 const name=account.user.nickname||account.user.username||'同学';$('userName').textContent=name;$('userAvatar').textContent=Array.from(name)[0].toUpperCase();$('userMenu').hidden=false;$('loginLink').hidden=true;
 if(verification.verified===true)status('学生邮箱已验证','下一步：选择一种方式，开始认识新朋友','#modes','✓');
 else status('先验证学生邮箱','完成验证后，即可参与三种配对','/verify-student');
}catch{status('暂时无法读取验证状态','点击这里重试；你仍可查看配对页面','#retry','↻');}finally{loading=false;}}
$('statusLink').addEventListener('click',e=>{if($('statusLink').getAttribute('href')==='#retry'){e.preventDefault();loadAccount();}else if(loading)e.preventDefault();});
$('logout').addEventListener('click',()=>{localStorage.removeItem('token');localStorage.removeItem('user');$('userMenu').open=false;guest();});
document.addEventListener('click',e=>{if(!$('userMenu').contains(e.target))$('userMenu').open=false;});
document.addEventListener('keydown',e=>{if(e.key==='Escape')$('userMenu').open=false;});
document.querySelectorAll('[data-dialog]').forEach(button=>button.addEventListener('click',()=>$(button.dataset.dialog).showModal()));
document.querySelectorAll('dialog').forEach(dialog=>{dialog.querySelector('[data-close]').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',e=>{const r=dialog.getBoundingClientRect();if(e.target===dialog&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))dialog.close();});});
loadAccount();
})();
