'use strict';
const $=id=>document.getElementById(id);
let state,activePair,busy=false;
const token=localStorage.getItem('token');
if(!token)location.replace('login.html?redirect=daily.html');
function notice(message){$('notice').textContent=message||'';}
async function api(path,method='GET',body){const res=await fetch('/api/daily/'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await res.json();if(data.code!==200)throw Error(data.msg||'操作失败，请稍后重试');return data;}
async function perform(fn){if(busy)return;busy=true;const controls=[...document.querySelectorAll('button')].filter(x=>!x.disabled);controls.forEach(x=>x.disabled=true);try{await fn();}catch(e){notice(e.message);}finally{busy=false;controls.forEach(x=>x.disabled=false);if(state)applyDisabled();}}
function node(tag,text,className){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
function button(text,fn,className){const b=node('button',text,className);b.type='button';b.addEventListener('click',fn);return b;}
function showTab(id){document.querySelectorAll('.pane').forEach(p=>p.hidden=p.id!==id);document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===id)));}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{showTab(b.dataset.tab);if(state)perform(()=>refresh(false));});
document.querySelectorAll('[data-open-settings]').forEach(b=>b.onclick=()=>showTab('settings'));
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
function image(src,alt,className){const img=node('img',undefined,className);img.src=src;img.alt=alt;img.loading='lazy';return img;}
function profileContent(person){const box=node('div');const top=node('div',undefined,'person-top');top.append(person.avatar?image(person.avatar,'主页头像','avatar'):node('div','♡','avatar fallback'));
 const info=node('div');info.append(node('h3',person.id||person.profile_id||'尚未设置主页 ID'));if(person.age)info.append(node('div',[person.age+' 岁',person.campus,person.grade,person.gender].filter(Boolean).join(' · '),'person-meta'));top.append(info);box.append(top);
 if(person.bio)box.append(node('p',person.bio,'bio'));const tags=node('div',undefined,'tags');(person.tags||[]).forEach(t=>tags.append(node('span',t,'tag')));box.append(tags);
 if(person.photos?.length){const photos=node('div',undefined,'photos');person.photos.forEach((src,i)=>photos.append(image(src,'个人照片 '+(i+1))));box.append(photos);}return box;
}
function pairAction(id,action,body){return perform(async()=>{const result=await api('pairs/'+id+'/'+action,'POST',body||{});notice(result.msg);await refresh(false);});}
function card(data){const root=node('article',undefined,'person-card');root.append(profileContent(data.person));root.append(node('p',data.reason,'reason'));
 if(data.status==='connected'){
   root.append(node('div','对方微信：'+data.wechat,'wechat'));root.append(node('p','双方已确认愿意认识。可以从共同兴趣开始聊聊。','muted'));
   root.append(button('关闭这段连接',()=>{if(confirm('关闭后双方都不能继续查看这段连接的资料和微信，且不会恢复。对方已保存的信息无法收回。确定关闭？'))pairAction(data.pair_id,'close');}));
 }else{const expires=new Date(data.expires_at);const text=expires.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
   root.append(node('p','邀请有效至 '+text+'（北京时间）','muted'));
   if(data.my_choice==='like')root.append(node('p','你的心意已记录，等待双方确认。','status'));
   else{const actions=node('div',undefined,'actions');actions.append(button('先跳过',()=>{if(confirm('跳过后今天不再补配，30 天内不会再次推荐这位对象。确定跳过？'))pairAction(data.pair_id,'respond',{choice:'skip'});}),button('♡ 想认识',()=>{activePair=data.pair_id;$('likeForm').reset();$('likeDialog').showModal();},'primary'));root.append(actions);}
 }
 const minor=node('div',undefined,'minor-actions');minor.append(button('举报',()=>{activePair=data.pair_id;$('reportForm').reset();$('reportDialog').showModal();}),button('屏蔽',()=>{if(confirm('屏蔽后双方都不能再查看对方的配对资料或联系方式，也不会被重新推荐。确定屏蔽？'))pairAction(data.pair_id,'block');}));root.append(minor);return root;
}
function applyDisabled(){$('settingsFields').disabled=!state.verified||state.banned||!state.profile_ready;$('pause').disabled=!state.enabled;$('draw').disabled=!state.enabled||state.banned||state.today_used;}
function options(select,values,value){select.replaceChildren(new Option('请选择',''),...values.map(v=>new Option(v,v)));select.value=value||'';}
function fillForm(){const f=$('settingsForm'),s=state.settings||{},d=state.dictionaries;
 options(f.elements.gender,d.genders,s.gender);options(f.elements.campus,d.campuses,s.campus);options(f.elements.grade,d.grades,s.grade);
 for(const key of ['genders','campuses']){const box=$(key);box.replaceChildren();d[key].forEach(v=>{const l=node('label');const input=node('input');input.type='checkbox';input.name=key;input.value=v;input.checked=(s[key]||[]).includes(v);l.append(input,document.createTextNode(v));box.append(l);});}
 for(const key of ['birth_date','min_age','max_age','schedule','pace'])if(s[key]!==undefined)f.elements[key].value=s[key];
 f.elements.show_gender.checked=!!s.show_gender;
 // Each save requires an explicit renewed confirmation of the display preview.
 f.elements.single_adult_student.checked=false;f.elements.display_consent.checked=false;basicPreview();
}
function basicPreview(){const f=$('settingsForm');let age='未填写年龄';if(f.elements.birth_date.value&&state){const today=state.date,b=f.elements.birth_date.value;age=(Number(today.slice(0,4))-Number(b.slice(0,4))-(today.slice(5)<b.slice(5)?1:0))+' 岁';}
 $('basicPreview').textContent='基本资料展示预览：'+[age,f.elements.campus.value||'未选校区',f.elements.grade.value||'未选年级',f.elements.show_gender.checked?f.elements.gender.value:'性别不公开'].filter(Boolean).join(' · ');
}
$('settingsForm').addEventListener('change',basicPreview);
async function refresh(fill=true){state=await api('state');$('dailyDate').textContent=state.date+' · 北京时间每日零点重置，不累积';
 $('onboarding').hidden=state.enabled&&state.verified&&!state.banned;$('drawPanel').hidden=!state.enabled||!state.verified||state.banned||state.today_used;
 const today=state.cards.find(c=>c.pair_id===state.today_pair);$('todayCard').replaceChildren(...(today?[card(today)]:[]));$('usedEmpty').hidden=!state.today_used||!!today;
 const pending=state.cards.filter(c=>c.status==='pending'&&c.pair_id!==state.today_pair);$('pendingSection').hidden=!pending.length;$('pendingCards').replaceChildren(...pending.map(card));
 const connections=state.cards.filter(c=>c.status==='connected');$('connectionCount').textContent=connections.length;$('connectedCards').replaceChildren(...(connections.length?connections.map(card):[node('div','还没有建立连接。双方都想认识后，就会在这里相遇。','panel')]));
 $('verifyStatus').textContent=state.verified?'学生邮箱已验证。':'请先验证当前账号的中大学生邮箱。验证码不会发送到其他邮箱。';$('verifyControls').hidden=state.verified;
 $('profilePreview').replaceChildren(...(state.preview?[profileContent(state.preview)]:[node('p','请先到我的主页设置 ID 并保存资料。')]));
 $('participation').textContent=state.banned?'账号暂不能参与日常配对，请联系管理员。':state.enabled?'你已开启日常配对。':'你尚未开启，或已暂停日常配对。';
 $('blockList').replaceChildren(...(state.blocks.length?state.blocks.map((b,i)=>{const row=node('div',undefined,'block-row');row.append(node('span','已屏蔽对象 '+(i+1)),button('解除屏蔽',()=>{if(confirm('解除后旧连接和邀请不会恢复。确定解除？'))perform(async()=>{const result=await api('blocks/'+b.target_id,'DELETE');notice(result.msg);await refresh(false);});}));return row;}):[node('p','暂无屏蔽对象','muted')]));
 if(fill)fillForm();applyDisabled();
}
$('draw').onclick=()=>perform(async()=>{const result=await api('today','POST',{});notice(result.msg);await refresh(false);});
$('pause').onclick=()=>{if(confirm('暂停会结束所有待处理邀请，保留已有连接。确定暂停日常配对？'))perform(async()=>{const result=await api('pause','POST',{});notice(result.msg);await refresh(false);});};
$('sendCode').onclick=()=>perform(async()=>{const result=await api('verification/send','POST',{});notice(result.msg);});
$('verifyForm').onsubmit=e=>{e.preventDefault();perform(async()=>{const result=await api('verification/confirm','POST',{code:e.target.elements.code.value.trim()});notice(result.msg);e.target.reset();await refresh(false);});};
$('settingsForm').onsubmit=e=>{e.preventDefault();const f=e.target,body={};for(const key of ['birth_date','gender','campus','grade','schedule','pace'])body[key]=f.elements[key].value;
 for(const key of ['min_age','max_age'])body[key]=Number(f.elements[key].value);for(const key of ['show_gender','single_adult_student','display_consent'])body[key]=f.elements[key].checked;
 for(const key of ['genders','campuses'])body[key]=[...f.querySelectorAll('input[name="'+key+'"]:checked')].map(i=>i.value);
 perform(async()=>{const result=await api('settings','PUT',body);notice(result.msg);await refresh();showTab('today');});};
$('likeForm').onsubmit=e=>{e.preventDefault();perform(async()=>{const result=await api('pairs/'+activePair+'/respond','POST',{choice:'like',wechat:e.target.elements.wechat.value.trim(),consent:e.target.elements.consent.checked});$('likeDialog').close();e.target.reset();notice(result.msg);await refresh(false);});};
$('reportForm').onsubmit=e=>{e.preventDefault();perform(async()=>{const result=await api('pairs/'+activePair+'/report','POST',{reason:e.target.elements.reason.value.trim()});$('reportDialog').close();e.target.reset();notice(result.msg);});};
// Clear sensitive rendered cards when leaving; returning to this page fetches current permissions.
window.addEventListener('pagehide',()=>{['todayCard','pendingCards','connectedCards'].forEach(id=>$(id).replaceChildren());});
window.addEventListener('pageshow',e=>{if(e.persisted)perform(()=>refresh(false));});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&token)perform(()=>refresh(false));});
setInterval(()=>{if(!document.hidden&&state&&new Date(Date.now()+8*3600000).toISOString().slice(0,10)!==state.date)perform(()=>refresh(false));},30000);
if(token)perform(()=>refresh());
