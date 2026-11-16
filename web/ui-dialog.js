/* ui-dialog.js — 页内 confirm/prompt 替代（FancyU 统一交互）。自含样式，不依赖页面 CSS。 */
(()=>{'use strict';
const CSS=`.uidlg-mask{position:fixed;inset:0;background:rgba(10,20,15,.45);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:500;padding:20px}
.uidlg{background:#faf9f5;color:#073b32;border:1px solid #cad8c8;border-radius:20px;box-shadow:0 16px 48px rgba(7,59,50,.25);width:100%;max-width:400px;padding:22px;font-family:Inter,"PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif;font-size:15px;line-height:1.65}
.uidlg h3{margin:0 0 8px;font-size:17px;font-weight:700}
.uidlg p{margin:0 0 14px;white-space:pre-line}
.uidlg input{width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border:1px solid #b7ccb9;border-radius:12px;background:#fcfdf9;color:#073b32;min-height:44px}
.uidlg .uidlg-err{color:#a6372d;margin:8px 0 0;font-size:13px}
.uidlg-btns{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}
.uidlg-btns button{font:inherit;font-weight:600;cursor:pointer;border-radius:12px;padding:10px 18px;min-height:44px;border:1px solid #073b32;background:#fafcf9;color:#073b32}
.uidlg-btns .ok{background:linear-gradient(130deg,#265a48,#00362f);color:#fff;border:0}
.uidlg-btns .ok.danger{background:linear-gradient(130deg,#a6372d,#7c241c)}
@media(prefers-color-scheme:dark){.uidlg{background:#192d22;color:#e7eee8;border-color:#30493a}.uidlg input{background:#0f1c15;color:#e7eee8;border-color:#30493a}.uidlg-btns button{background:#192d22;color:#e7eee8;border-color:#4b6a58}}`;
let style=null;
function ensureStyle(){if(!style){style=document.createElement('style');style.textContent=CSS;document.head.appendChild(style);}}
function open({title='',body='',okText='确定',cancelText='取消',danger=false,placeholder='',withInput=false,validate,onlyOk=false}){
 ensureStyle();
 return new Promise(resolve=>{
  const mask=document.createElement('div');mask.className='uidlg-mask';
  mask.innerHTML=`<div class="uidlg" role="dialog" aria-modal="true" aria-labelledby="uidlgTitle"><h3 id="uidlgTitle"></h3>${body?'<p></p>':''}${withInput?'<input type="text" autocomplete="off">':''}<p class="uidlg-err" hidden></p><div class="uidlg-btns">${onlyOk?'':'<button type="button" data-no></button>'}<button type="button" class="ok${danger?' danger':''}" data-yes></button></div></div>`;
  const q=s=>mask.querySelector(s),dlg=q('.uidlg'),input=q('input'),err=q('.uidlg-err');
  q('h3').textContent=title;body&&(q('p').textContent=body);
  const noBtn=q('[data-no]');noBtn&&(noBtn.textContent=cancelText);q('[data-yes]').textContent=okText;
  if(input){input.placeholder=placeholder;}
  const prev=document.activeElement;
  let done=false;
  const close=v=>{if(done)return;done=true;mask.remove();document.removeEventListener('keydown',onKey);prev&&prev.focus&&prev.focus();resolve(v);}
  function fail(msg){err.textContent=msg;err.hidden=false;if(typeof window.toast==='function')window.toast(msg);}
  function submit(){const val=input?input.value:null;
   if(input&&validate){const m=validate(val);if(m){fail(m);input.focus();return;}}
   close(input?(val||'').trim():true);}
  mask.addEventListener('click',e=>{if(e.target===mask)close(input?null:false);});
  mask.addEventListener('click',e=>{if(e.target.closest('[data-no]'))close(input?null:false);if(e.target.closest('[data-yes]'))submit();});
  input&&input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();submit();}});
  function onKey(e){if(e.key==='Escape'){e.preventDefault();close(input?null:false);}}
  document.addEventListener('keydown',onKey);
  document.body.appendChild(mask);
  (input||q('[data-yes]')).focus();
 });
}
window.uiConfirm=o=>open({...o,withInput:false});
window.uiAlert=o=>open({...o,onlyOk:true,okText:(o&&o.okText)||'知道了'});
window.uiPrompt=o=>open({...o,withInput:true,okText:o&&o.okText||'提交'});
})();
