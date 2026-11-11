'use strict';
const API_URL='/api';let currentUser=null,authToken=localStorage.getItem('token'),previousFocus=null;
const $=id=>document.getElementById(id);
function requireLogin(){if(window.__loginRedirecting)return;window.__loginRedirecting=true;localStorage.removeItem('token');localStorage.removeItem('user');location.replace('/login?redirect=/profile');}
function getAuthHeaders(){return {Authorization:'Bearer '+authToken};}
async function read(path){const r=await fetch(API_URL+'/account/'+path,{headers:getAuthHeaders()});const d=await r.json();if(r.status===401||d.code===401){requireLogin();throw Error('请重新登录');}if(!r.ok||d.code!==200)throw Error(d.msg||'暂时无法读取');return d;}
function renderProfile(){if(!currentUser)return;const name=currentUser.nickname||currentUser.username||'用户';$('profileName').textContent=name;$('profileAvatar').textContent=name.charAt(0).toUpperCase();const email=currentUser.email||'';const at=email.lastIndexOf('@');$('profileEmail').textContent=at>0?email.slice(0,1)+'***'+email.slice(at):'未设置邮箱';}
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
async function loadIdentity(){try{const d=await read('me');if(!d.user)throw Error();currentUser=d.user;localStorage.setItem('user',JSON.stringify(currentUser));renderProfile();}catch(e){$('accountError').hidden=false;$('profileName').textContent='账号信息暂不可用';}}
async function loadVerification(){try{const d=await read('student-verification');setBadge('verificationBadge',d.verified?'学生邮箱已验证':'待验证学生邮箱',d.verified?'':'warning');$('verificationStatus').textContent=d.verified?'已验证':'去验证';}catch(e){setBadge('verificationBadge','认证状态待重试','warning');$('verificationStatus').textContent='进入查看';}}
function openModal(id){previousFocus=document.activeElement;$(id).classList.add('show');document.body.classList.add('modal-open');$(id).querySelector('input,button').focus();}
function closeModal(id){$(id).classList.remove('show');document.body.classList.remove('modal-open');$(id).querySelectorAll('input[type=password]').forEach(e=>e.value='');previousFocus?.focus();}
function openNicknameModal(){$('nicknameInput').value=currentUser?.nickname||currentUser?.username||'';openModal('nicknameModal');}
function openPasswordModal(){openModal('passwordModal');}
function openDeleteModal(){openModal('deleteModal');}
document.querySelectorAll('.modal-mask').forEach(mask=>mask.addEventListener('click',e=>{if(e.target===mask)closeModal(mask.id);}));
document.addEventListener('keydown',e=>{const m=document.querySelector('.modal-mask.show');if(!m)return;if(e.key==='Escape'){e.preventDefault();closeModal(m.id);}if(e.key==='Tab'){const els=[...m.querySelectorAll('input,button,a[href]')].filter(x=>!x.disabled);const first=els[0],last=els.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
document.querySelectorAll('[data-retry]').forEach(b=>b.addEventListener('click',()=>loadCard(b.dataset.retry)));
$('logout').addEventListener('click',()=>{localStorage.removeItem('token');localStorage.removeItem('user');location.href='/';});
if(!authToken)requireLogin();else{loadIdentity();loadVerification();Object.keys(loaders).forEach(loadCard);}
