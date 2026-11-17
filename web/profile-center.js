'use strict';
const API_URL='/api';let currentUser=null,authToken=localStorage.getItem('token'),previousFocus=null;
const $=id=>document.getElementById(id);
function requireLogin(){if(window.__loginRedirecting)return;window.__loginRedirecting=true;localStorage.removeItem('token');localStorage.removeItem('user');location.replace('/login?redirect=/profile');}
function getAuthHeaders(){return {Authorization:'Bearer '+authToken};}
async function read(path){const r=await fetch(API_URL+'/account/'+path,{headers:getAuthHeaders()});const d=await r.json();if(r.status===401||d.code===401){requireLogin();throw Error('请重新登录');}if(!r.ok||d.code!==200)throw Error(d.msg||'暂时无法读取');return d;}
function renderProfile(){if(!currentUser)return;const name=currentUser.nickname||currentUser.username||'用户';$('profileName').textContent=name;const av=$("profileAvatar"),letter=name.charAt(0).toUpperCase();av.textContent=letter;const old=av.querySelector("img");if(old)old.remove();if(currentUser.avatar){const img=document.createElement("img");img.alt="头像";img.setAttribute("data-auth-img",currentUser.avatar);av.append(img);if(window.fancyuAuthImages)window.fancyuAuthImages(av);}const email=currentUser.email||'';const at=email.lastIndexOf('@');$('profileEmail').textContent=at>0?email.slice(0,1)+'***'+email.slice(at):'未设置邮箱';const ce=$('contactEmailValue');if(ce)ce.textContent=currentUser.contact_email||'未设置';}
function setBadge(id,text,tone='neutral'){const e=$(id);e.textContent=text;e.className='badge '+tone;}
function setLink(id,text,href){const e=$(id);e.textContent=text;e.href=href;}
function setCard(key,{status,tone,detail,progress,action,href}){setBadge(key+'Status',status,tone);$(key+'Detail').textContent=detail;$(key+'Progress').textContent=progress;setLink(key+'Action',action+' →',href);}
function hasResults(d){return Array.isArray(d.pairs)&&d.pairs.some(p=>p.status==='pending'||p.status==='connected');}
function completion(key,ready){setLink(key+'Secondary',ready?'修改问卷':'填写 / 补全问卷',key==='weekly'?'/survey':'/friend_survey');}
function renderWeekly(d){const ready=!!d.survey_ready,enrolled=!!d.registration?.enrolled,results=hasResults(d);completion('weekly',ready);let v={status:enrolled?'已报名':'未报名',tone:enrolled?'':'neutral',detail:ready?'已填写':'待填写 / 补全',progress:enrolled?'等待本批结果':'每周主动报名',action:enrolled?'查看进度':'去报名',href:'/weekly-match'};
 if(!ready)v={...v,status:'待完善问卷',tone:'warning',progress:'完成问卷后可报名',action:'填写问卷',href:'/survey'};
 else if(!d.eligible)v={...v,status:'待确认资格',tone:'warning',progress:'进入板块查看参与条件',action:'查看参与条件'};
 else if(enrolled){const row=(d.enrollments||[]).find(e=>e.batch===d.registration.key);if(row?.status==='published')v={...v,status:'本批已结束',progress:row.assigned?'本批结果已发布':'本批暂无合适配对',action:'查看结果'};}
 if(results)v={...v,status:'有推荐 / 连接',tone:'',progress:'前往查看推荐与已有连接',action:'查看结果',href:'/weekly-match'};
 setCard('weekly',v);
}
function renderDeep(d){const ready=!!d.survey_ready,enabled=!!d.enabled;completion('deep',ready);let v={status:enabled?'参与已开启':'未开启',tone:enabled?'':'neutral',detail:ready?'已填写':'待填写 / 补全',progress:enabled?'按每周安排参与':'开启后每周自动参与',action:enabled?'查看进度':'去开启',href:'/deep'};
 if(!ready)v={...v,status:'待完善问卷',tone:'warning',progress:'保存完整问卷后可参与',action:'填写问卷',href:'/friend_survey'};
 else if(!d.eligible)v={...v,status:'待确认资格',tone:'warning',progress:'进入板块查看参与条件',action:'查看参与条件'};
 if(hasResults(d))v={...v,status:'有推荐 / 连接',tone:'',progress:'前往查看推荐与已有连接',action:'查看结果',href:'/deep'};
 setCard('deep',v);
}
function renderBuddy(d){const cards=d.cards||[],enabled=cards.filter(c=>c.on).length;const labels={sport:'运动',study:'自习',game:'游戏',meal:'吃饭',food:'吃饭',movie:'电影',trip:'逛街 / 旅游',show:'演出 / 展览',other:'其他'};const names=[...new Set(cards.map(c=>labels[c.type]||'活动'))];let v={status:enabled?enabled+' 张卡片已开启':cards.length?'卡片已暂停':'暂无卡片',tone:enabled?'':'neutral',detail:cards.length?names.join('、'):'尚未创建',progress:'按卡片开启',action:cards.length?'管理搭子卡':'创建搭子卡',href:'/friends#quick'};
 if(cards.length&&!d.eligible)v={...v,status:'待确认资格',tone:'warning',progress:'进入板块查看参与条件'};
 if(hasResults(d))v={...v,status:'有推荐 / 连接',tone:'',action:'查看结果'};
 setCard('buddy',v);
}
const loaders={weekly:()=>read('weekly-match').then(renderWeekly),deep:()=>read('deep-match').then(renderDeep),buddy:()=>read('friends').then(renderBuddy)};
async function loadCard(key){const retry=document.querySelector('[data-retry="'+key+'"]');retry.hidden=true;try{await loaders[key]();}catch(e){if(window.__loginRedirecting)return;setBadge(key+'Status','读取失败','warning');$(key+'Detail').textContent='暂时无法读取';$(key+'Progress').textContent='请重试或进入板块查看';setLink(key+'Action','进入板块 →',{weekly:'/weekly-match',deep:'/deep',buddy:'/friends#quick'}[key]);retry.hidden=false;}}
async function loadIdentity(){try{const d=await read('me');if(!d.user)throw Error();currentUser=d.user;localStorage.setItem('user',JSON.stringify(currentUser));renderProfile();if(window.fancyuShowAdminEntry)window.fancyuShowAdminEntry(currentUser.admin===true);}catch(e){$('accountError').hidden=false;$('profileName').textContent='账号信息暂不可用';}}
async function loadVerification(){try{const d=await read('student-verification');setBadge('verificationBadge',d.verified?'学生邮箱已验证':'待验证学生邮箱',d.verified?'':'warning');$('verificationStatus').textContent=d.verified?'已验证':'去验证';}catch(e){setBadge('verificationBadge','认证状态待重试','warning');$('verificationStatus').textContent='进入查看';}}
function openModal(id){previousFocus=document.activeElement;$(id).classList.add('show');document.body.classList.add('modal-open');$(id).querySelector('input,button').focus();}
function closeModal(id){$(id).classList.remove('show');document.body.classList.remove('modal-open');$(id).querySelectorAll('input[type=password]').forEach(e=>e.value='');previousFocus?.focus();}
function openNicknameModal(){$('nicknameInput').value=currentUser?.nickname||currentUser?.username||'';openModal('nicknameModal');}
function openPasswordModal(){openModal('passwordModal');}
function openContactEmailModal(){$('contactEmailInput').value=currentUser?.contact_email||'';openModal('contactEmailModal');}
function openDeleteModal(){openModal('deleteModal');}
document.querySelectorAll('.modal-mask').forEach(mask=>mask.addEventListener('click',e=>{if(e.target===mask)closeModal(mask.id);}));
document.addEventListener('keydown',e=>{const m=document.querySelector('.modal-mask.show');if(!m)return;if(e.key==='Escape'){e.preventDefault();closeModal(m.id);}if(e.key==='Tab'){const els=[...m.querySelectorAll('input,button,a[href]')].filter(x=>!x.disabled);const first=els[0],last=els.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
document.querySelectorAll('[data-retry]').forEach(b=>b.addEventListener('click',()=>loadCard(b.dataset.retry)));
$('logout').addEventListener('click',()=>{localStorage.removeItem('token');localStorage.removeItem('user');location.href='/';});

let pendingAvatar=null;
function openAvatarSheet(){
  pendingAvatar=null;
  const stage=$('avatarStage');
  if(stage){stage.replaceChildren();stage.textContent='还没有照片';}
  if($('avatarMeta'))$('avatarMeta').textContent='选好后会在这里预览。图片会先在这台设备上缩小。';
  if($('avatarSave'))$('avatarSave').disabled=true;
  openModal('avatarModal');
}
async function decodeAvatar(file){
  if(window.createImageBitmap){
    try{return await createImageBitmap(file,{imageOrientation:'from-image'});}
    catch(e){try{return await createImageBitmap(file);}catch(e2){}}
  }
  const url=URL.createObjectURL(file);
  try{
    return await new Promise((resolve,reject)=>{
      const img=new Image();
      img.onload=()=>resolve(img);
      img.onerror=()=>reject(Error('unreadable'));
      img.src=url;
    });
  }finally{URL.revokeObjectURL(url);}
}
function drawAvatar(source,edge,quality){
  const sw=source.naturalWidth||source.width,sh=source.naturalHeight||source.height;
  if(!sw||!sh)return Promise.reject(Error('这张图片无法读取，请换一张 JPEG、PNG 或 WebP'));
  const side=Math.min(sw,sh);
  const canvas=document.createElement('canvas');
  canvas.width=edge;canvas.height=edge;
  canvas.getContext('2d').drawImage(source,(sw-side)/2,(sh-side)/2,side,side,0,0,edge,edge);
  return new Promise((resolve,reject)=>{
    canvas.toBlob(blob=>blob?resolve(blob):reject(Error('压缩失败，请换一张图片')),'image/jpeg',quality);
  });
}
async function compressAvatar(file){
  if(file.size>25*1024*1024)throw Error('图片太大，请换一张较小的');
  const source=await decodeAvatar(file).catch(()=>{throw Error('这张图片无法读取，请换一张 JPEG、PNG 或 WebP');});
  const steps=[[720,0.82],[720,0.68],[512,0.72],[512,0.58],[384,0.6]];
  let blob=null;
  try{
    for(const step of steps){
      blob=await drawAvatar(source,step[0],step[1]);
      if(blob.size<=200*1024)break;
    }
  }finally{if(source.close)source.close();}
  if(!blob)throw Error('压缩失败，请换一张图片');
  return blob;
}
async function previewAvatar(file){
  if(!file)return;
  $('avatarSave').disabled=true;
  $('avatarMeta').textContent='正在这台设备上缩小图片…';
  try{
    const blob=await compressAvatar(file);
    pendingAvatar=blob;
    const url=URL.createObjectURL(blob);
    const img=document.createElement('img');
    img.alt='头像预览';
    img.src=url;
    img.onload=()=>URL.revokeObjectURL(url);
    $('avatarStage').replaceChildren(img);
    $('avatarMeta').textContent='已缩小到约 '+Math.max(1,Math.round(blob.size/1024))+' KB，确认后上传。';
    $('avatarSave').disabled=false;
  }catch(e){
    pendingAvatar=null;
    $('avatarMeta').textContent=e.message||'这张图片无法读取';
  }
}
async function saveAvatar(){
  if(!pendingAvatar)return;
  const btn=$('avatarSave');
  btn.disabled=true;
  $('avatarMeta').textContent='正在上传…';
  try{
    const res=await fetch(API_URL+'/account/avatar',{method:'PUT',headers:Object.assign({'Content-Type':'image/jpeg'},getAuthHeaders()),body:pendingAvatar});
    const result=await res.json().catch(()=>({}));
    if(!res.ok||result.code!==200)throw Error(result.msg||'上传失败');
    if(currentUser)currentUser.avatar=result.url||'';
    try{localStorage.setItem('user',JSON.stringify(currentUser||{}));}catch(e){}
    renderProfile();
    closeModal('avatarModal');
    profileToast('头像已更新');
    loadGuide();
  }catch(e){
    $('avatarMeta').textContent=e.message||'上传失败';
    btn.disabled=!pendingAvatar;
  }
}

/* ---------- 新手任务 ---------- */
function profileToast(msg,isError){const el=$('toast');if(!el)return;el.textContent=msg;el.className=isError?'toast show error':'toast show';setTimeout(()=>el.classList.remove('show'),3000);}
function appInstalled(){
  try{if(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)return true;}catch(e){}
  return typeof navigator!=='undefined'&&navigator.standalone===true;
}
async function notifyTaskDone(){
  if(!appInstalled()||!window.fancyuPush||!window.fancyuPush.status)return false;
  try{const s=await window.fancyuPush.status();return !!(s&&s.subscribed);}catch(e){return false;}
}
async function loadGuide(){
  const retry=$('guideRetry'),list=$('guideList');
  retry.hidden=true;
  try{
    const d=await read('profile-guide');
    const items=(d.items||[]).slice();
    const task={key:'install',label:'安装应用并开启通知',hint:'先装到主屏幕，再打开系统通知',link:'/notifications',done:await notifyTaskDone()};
    const at=items.findIndex(it=>it.key==='verified');
    items.splice(at<0?items.length:at+1,0,task);
    const done=items.filter(it=>it.done).length;
    const total=items.length||1;
    const percent=Math.round(done*100/total);
    $('guidePercent').textContent='已完成 '+done+'/'+total+'（'+percent+'%）';
    $('guideBar').style.width=percent+'%';
    $('guideBarWrap').setAttribute('aria-valuenow',String(percent));
    list.replaceChildren();
    items.forEach(it=>{
      const li=document.createElement('li');li.className=it.done?'done':'todo';
      const mark=document.createElement('span');mark.className='guide-mark';mark.textContent=it.done?'✓':'○';mark.setAttribute('aria-hidden','true');
      const text=document.createElement('span');text.className='guide-text';
      const b=document.createElement('b');b.textContent=it.label;
      const hint=document.createElement('span');hint.className='muted';hint.textContent=it.done?'已完成':it.hint;
      text.append(b,hint);li.append(mark,text);
      if(!it.done){
        if(it.key==='avatar'){const b=document.createElement('button');b.type='button';b.className='guide-go';b.textContent='去完成 →';b.addEventListener('click',openAvatarSheet);li.append(b);}
        else{const a=document.createElement('a');a.className='guide-go';a.href=it.link;a.textContent='去完成 →';li.append(a);}
      }
      list.append(li);
    });
  }catch(e){
    if(window.__loginRedirecting)return;
    $('guidePercent').textContent='读取失败';$('guideBar').style.width='0%';retry.hidden=false;
  }
}
/* ---------- 邀请好友 ---------- */
let inviteInfo=null;
async function loadInvite(){
  try{
    const d=await read('invite');inviteInfo=d;
    $('inviteCount').textContent=d.invited>0?('已邀请 '+d.invited+' 人'):'去邀请';
    $('inviteCode').textContent=d.invite_code||'—';
    $('inviteStat').textContent=d.invited>0?('已成功邀请 '+d.invited+' 位同学'):'还没有人通过你的邀请注册';
  }catch(e){$('inviteCount').textContent='去邀请';}
}
function openInviteModal(){openModal('inviteModal');}
function copyInviteLink(){
  const link=inviteInfo&&inviteInfo.link?location.origin+inviteInfo.link:'';
  if(!link){profileToast('邀请信息还没读取到，请稍后重试',true);return;}
  const ok=()=>profileToast('邀请链接已复制，发给同学即可');
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(link).then(ok,()=>window.prompt('复制这条链接发给同学：',link));}
  else window.prompt('复制这条链接发给同学：',link);
}
/* ---------- 深色模式开关 ---------- */
function themeLabel(){const saved=(()=>{try{return localStorage.getItem('fancyu-theme')||'';}catch(e){return '';}})();return saved==='dark'?'已开启':'已关闭';}
function renderThemeState(){const el=$('themeState');if(el)el.textContent=themeLabel();}
function toggleTheme(){if(!window.fancyuSetTheme)return;window.fancyuSetTheme(!window.fancyuTheme());renderThemeState();}
if($('inviteEntry'))$('inviteEntry').addEventListener('click',openInviteModal);
if($('themeToggle'))$('themeToggle').addEventListener('click',toggleTheme);
if($('guideRetry'))$('guideRetry').addEventListener('click',loadGuide);

if($('avatarChoose'))$('avatarChoose').addEventListener('click',()=>$('avatarPick').click());
if($('avatarPick'))$('avatarPick').addEventListener('change',()=>{const f=$('avatarPick').files&&$('avatarPick').files[0];$('avatarPick').value='';previewAvatar(f);});
if($('avatarSave'))$('avatarSave').addEventListener('click',saveAvatar);
if($('avatarCancel'))$('avatarCancel').addEventListener('click',()=>closeModal('avatarModal'));
renderThemeState();
if(!authToken)requireLogin();else{loadIdentity();loadVerification();Object.keys(loaders).forEach(loadCard);loadGuide();loadInvite();}
