'use strict';
// 问卷管理工作台：左树（结构/搜索）+ 中编辑器（选中节点）+ 右用户端预览。
// 风险变更在编辑时就镜像服务端规则（api/survey-schema.js 的 optsChanged/locked 语义）内联标记，
// 保存时汇总成确认对话框，不再用全局 force checkbox。
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const token=localStorage.getItem('adminToken');
if(!token)location.replace('/admin');
const KINDS={weekly:'每周恋爱问卷',buddy:'搭子卡片',deep:'深度交友问卷'};
const W_TYPES=['radio','multi','scale','month','age','education','college','number','height','hometown','text'];
const W_TYPE_NAMES={radio:'单选',multi:'多选',scale:'量表 1–7',month:'出生年月',age:'年龄差',education:'身份年级',college:'学校专业',number:'数字',height:'身高范围',hometown:'家乡',text:'文本'};
const D_TYPES=['options','tags','select','text','textarea','major','campus','expect-campus','personality','interests','photos','contacts'];
const D_TYPE_NAMES={'options':'单选按钮','tags':'多选标签','select':'下拉选择','text':'单行文本','textarea':'多行文本','major':'专业选择','campus':'校区联动','expect-campus':'期望校区多选','personality':'性格滑块','interests':'兴趣选择','photos':'照片上传','contacts':'联系方式'};
let kind='weekly',data=null,orig=null,locked=new Set(),dirty=false,sel=null,searchQ='';
let distCache={}; // kind -> 填写分布统计（保存/切换后清空）
const expanded=new Set(),treeDom=new Map(); // nodeId -> li（徽标就地更新，不整树重画）

const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const inp=(value,ph)=>{const i=el('input','sv-in');i.value=value??'';if(ph)i.placeholder=ph;return i;};
const chk=(on,label)=>{const l=el('label','inline');const i=el('input');i.type='checkbox';i.checked=!!on;l.append(i,document.createTextNode(' '+label));return l;};
const optValues=a=>(a||[]).map(v=>(v&&typeof v==='object'?v.value:v));
const optsChanged=(before,after)=>Array.isArray(before)&&(!Array.isArray(after)||before.some(v=>!after.includes(v)));
const clone=o=>JSON.parse(JSON.stringify(o));
function toast(msg,bad){const t=$('toast');t.textContent=msg;t.hidden=false;t.classList.toggle('bad',!!bad);clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.hidden=true,6000);}
async function api(path,method,body){const r=await fetch(path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const j=await r.json().catch(()=>({code:r.status,msg:'响应异常'}));if(r.status===401){localStorage.removeItem('adminToken');location.replace('/admin');throw Error('请重新登录');}return j;}

// ===== 页内对话框（替代 prompt/confirm）=====
let dlgOk=null;
function dialog(title,body,okText,onOk,cancelText){
 $('dlgTitle').textContent=title;const b=$('dlgBody');b.textContent='';
 if(typeof body==='string')b.append(el('p',null,body));
 else if(body)b.append(...(body instanceof Array?body:[body]));
 const ok=$('dlgOk');ok.textContent=okText||'确认';ok.hidden=!onOk;dlgOk=onOk;
 $('dlgCancel').textContent=cancelText||(onOk?'取消':'关闭');
 $('dlg').hidden=false;ok.focus();
}
function closeDlg(){$('dlg').hidden=true;dlgOk=null;}
$('dlgCancel').onclick=closeDlg;
$('dlgOk').onclick=()=>{const f=dlgOk;closeDlg();if(f)f();};
$('dlg').addEventListener('click',e=>{if(e.target===$('dlg'))closeDlg();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('dlg').hidden)closeDlg();});

// ===== 脏状态与风险镜像 =====
function markDirty(){if(!dirty){dirty=true;$('dirty').hidden=false;}scheduleBadges();}
let badgeTimer=null;
function scheduleBadges(){clearTimeout(badgeTimer);badgeTimer=setTimeout(()=>{const c=collectChanges();updateBadges(c);},250);}
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});

function collectChanges(){
 const risks=[],errors=[],next=data.schema,prev=orig;
 const R=(node,msg)=>risks.push({node,msg}),E=(node,msg)=>errors.push({node,msg});
 if(kind==='weekly'){
  const byId=Object.fromEntries(next.questions.map(q=>[String(q.id),q]));
  const prevById=Object.fromEntries(prev.questions.map(q=>[String(q.id),q]));
  for(const q of prev.questions){
   const id=String(q.id),after=byId[id];
   if(locked.has(id)){
    if(!after)E(q,'🔒 题 '+id+' 被匹配逻辑依赖，不能删除');
    else{if(after.type!==q.type)E(after,'🔒 题 '+id+' 被匹配逻辑依赖，不能改类型');
     if(optsChanged(q.options,after.options))R(after,'题 '+id+' 修改/删除了已有选项（匹配逻辑依赖）');}
   }else{
    if(!after)R(q,'删除题 '+id+'（'+q.title+'）');
    else if(optsChanged(q.options,after.options))R(after,'题 '+id+' 修改/删除了已有选项');
   }
  }
 }else if(kind==='buddy'){
  for(const [key,t] of Object.entries(prev.TYPES)){
   const after=next.TYPES[key];
   if(!after){R(t,'删除搭子类型「'+t.name+'」');continue;}
   if(optsChanged(t.main?.opts,after.main?.opts))R(after.main,'「'+t.name+'」主选项（'+t.main.label+'）改动');
   for(const bf of t.extra||[]){const af=(after.extra||[]).find(x=>x.key===bf.key);
    if(optsChanged(bf.opts,af?.opts))R(af||bf,'「'+t.name+'」'+bf.label+' 选项改动');}
  }
  for(const bf of prev.COMMON){const af=next.COMMON.find(x=>x.key===bf.key);
   if(!af)R(bf,'删除公共字段「'+bf.label+'」');
   else if(optsChanged(bf.opts,af.opts))R(af,'公共字段「'+bf.label+'」选项改动');}
 }else{
  const prevItems={};prev.cards.forEach(cs=>(cs||[]).forEach(c=>(c.items||[]).forEach(it=>prevItems[it.key]=it)));
  const seen={};
  next.cards.forEach(cs=>(cs||[]).forEach(c=>(c.items||[]).forEach(it=>seen[it.key]=it)));
  for(const [key,after] of Object.entries(seen)){
   const before=prevItems[key];
   if(!before){R(after,'新增字段「'+key+'」（需确认匹配逻辑兼容）');continue;}
   if(locked.has(key)&&after.type!==before.type)E(after,'🔒 字段「'+key+'」被匹配逻辑依赖，不能改类型');
   const bo=optValues(before.groups?Object.values(before.groups).flat():before.options);
   const ao=optValues(after.groups?Object.values(after.groups).flat():after.options);
   if(optsChanged(bo,ao))R(after,'字段「'+key+'」修改/删除了已有选项');
  }
  for(const [key,before] of Object.entries(prevItems)){
   if(locked.has(key)){if(!seen[key])E(before,'🔒 字段「'+key+'」被匹配逻辑依赖，不能删除');continue;}
   if(!seen[key])R(before,'删除字段「'+key+'」（'+(before.label||'')+'）');
  }
  for(const [school,cps] of Object.entries(prev.schools)){
   const after=next.schools[school];
   if(!after)R(prev,'删除学校「'+school+'」');
   else if(optsChanged(cps,after))R(after,'学校「'+school+'」校区改动');
  }
  const pi=prev.interests,ni=next.interests;
  if(optsChanged(pi.categories,ni.categories))R(ni,'兴趣大类改动（顺序参与匹配）');
  if(optsChanged(pi.skillLevels,ni.skillLevels))R(ni,'熟练度选项改动（按文案计分）');
  if(optsChanged(pi.freq,ni.freq))R(ni,'交流频次选项改动（按顺序计分）');
  if(optsChanged((prev.contacts||{}).methods,(next.contacts||{}).methods))R(next.contacts,'联系方式类型改动');
 }
 return {risks,errors};
}
function updateBadges({risks,errors}){
 const rs=new Set(risks.map(r=>r.node)),es=new Set(errors.map(r=>r.node));
 for(const [id,li] of treeDom){
  const node=li._node;let cls='';
  for(const n of rs)if(n===node.ref){cls='risk';break;}
  if(!cls)for(const n of es)if(n===node.ref){cls='err';break;}
  li.classList.toggle('has-risk',cls==='risk');li.classList.toggle('has-err',cls==='err');
 }
}

// ===== 结构树 =====
function buildTree(){
 const root=[];
 if(kind==='weekly'){
  root.push({id:'wglobal',label:'全局设置',icon:'⚙',t:'wglobal'});
  data.schema.sections.forEach((name,i)=>{
   const n={id:'wsec:'+i,label:name||('分区 '+(i+1)),icon:'📁',t:'wsec',i,children:[]};
   data.schema.questions.filter(q=>q.section===i).forEach(q=>n.children.push({id:'wq:'+q.id,label:q.id+'｜'+(q.title||'').slice(0,16),icon:locked.has(String(q.id))?'🔒':'❓',t:'wq',q,ref:q}));
   root.push(n);
  });
 }else if(kind==='buddy'){
  root.push({id:'bglobal',label:'全局设置（卡片上限 / 新增类型）',icon:'⚙',t:'bglobal'});
  const cn={id:'bcommon',label:'公共字段',icon:'📁',t:'bcommongrp',children:data.schema.COMMON.map(f=>({id:'bc:'+f.key,label:f.label,icon:'❓',t:'bcommon',f,ref:f}))};
  root.push(cn);
  for(const [key,t] of Object.entries(data.schema.TYPES)){
   const n={id:'bt:'+key,label:(t.icon||'🎯')+' '+t.name,icon:'',t:'btype',key,children:[],ref:t};
   n.children.push({id:'bf:'+key+':main',label:'主选项 · '+t.main.label,icon:'❓',t:'bfield',f:t.main,owner:t,ref:t.main});
   (t.extra||[]).forEach(f=>n.children.push({id:'bf:'+key+':'+f.key,label:f.label+(f.multi?'（多选）':''),icon:'❓',t:'bfield',f,owner:t,ref:f}));
   root.push(n);
  }
 }else{
  const sn={id:'dschools',label:'学校 → 校区',icon:'📁',t:'dschoolgrp',children:Object.keys(data.schema.schools).map(s=>({id:'ds:'+s,label:s,icon:'🏫',t:'dschool',name:s,ref:data.schema.schools[s]}))};
  root.push(sn);
  data.schema.cards.forEach((cards,si)=>{
   const n={id:'dstep:'+si,label:'第 '+(si+1)+' 步 · '+data.schema.steps[si],icon:'📁',t:'dstep',si,children:[]};
   cards.forEach((c,ci)=>{const cn={id:'dcard:'+si+':'+ci,label:c.label,icon:'🗂',t:'dcard',si,ci,children:c.items.map(it=>({id:'ditem:'+it.key,label:(locked.has(it.key)?'🔒 ':'')+it.key+' · '+(it.label||D_TYPE_NAMES[it.type]||it.type).toString().slice(0,14),icon:'',t:'ditem',si,ci,it,ref:it}))};
    n.children.push(cn);});
   root.push(n);
  });
  root.push({id:'dpersonality',label:'性格滑块维度',icon:'🎚',t:'dpersonality'});
  root.push({id:'dinterests',label:'兴趣模块',icon:'🎯',t:'dinterests',ref:data.schema.interests});
  root.push({id:'dmisc',label:'照片与联系方式',icon:'📷',t:'dmisc',ref:data.schema.contacts});
 }
 return root;
}
function matchNode(n){
 if(!searchQ)return true;
 const hay=(n.label||'')+(n.q?' '+n.q.title+' '+n.q.id:'')+(n.it?' '+n.it.key+' '+(n.it.label||''):'')+(n.f?' '+n.f.key+' '+n.f.label:'');
 if(hay.toLowerCase().includes(searchQ))return true;
 return (n.children||[]).some(matchNode);
}
function renderTree(){
 const tree=$('tree');tree.textContent='';treeDom.clear();
 const build=(nodes,parent)=>{
  for(const n of nodes){
   if(!matchNode(n))continue;
   const li=el('div','sv-node'+(sel&&sel.id===n.id?' sel':''));li._node=n;li.dataset.id=n.id;
   const hasKids=(n.children||[]).length>0;
   const row=el('div','sv-row');
   if(hasKids){const tw=el('button','sv-tw',expanded.has(n.id)?'▾':'▸');tw.type='button';tw.onclick=e=>{e.stopPropagation();expanded.has(n.id)?expanded.delete(n.id):expanded.add(n.id);renderTree();};row.append(tw);}
   else row.append(el('span','sv-tw','·'));
   row.append(el('span','sv-ic',n.icon||''),el('span','sv-lb',n.label));
   li.append(row);
   li.onclick=e=>{e.stopPropagation();sel=n;renderTree();renderEdit();renderPreview();};
   treeDom.set(n.id,li);
   parent.append(li);
   if(hasKids&&expanded.has(n.id)){
    const kids=el('div','sv-kids');build(n.children.filter(matchNode),kids);li.append(kids);
   }else if(hasKids&&!expanded.has(n.id)&&searchQ){ // 搜索时强制展开命中子树
    const kids=el('div','sv-kids');build(n.children.filter(matchNode),kids);li.append(kids);
   }
  }
 };
 build(buildTree(),tree);
 if(sel&&!treeDom.has(sel.id))sel=null;
 updateBadges(collectChanges());
}
$('search').addEventListener('input',()=>{searchQ=$('search').value.trim().toLowerCase();renderTree();});

// ===== 通用编辑小件 =====
function frow(label,inputEl,hint){const r=el('div','sv-frow');const l=el('label',null,label);l.append(inputEl);r.append(l);if(hint)r.append(el('p','hint',hint));return r;}
function chips(arr,opts){ // 字符串数组 或 {value,label} 数组，就地编辑
 opts=opts||{};
 const box=el('div','sv-chips');
 const redraw=()=>{box.textContent='';
  arr.forEach((v,i)=>{
   const c=el('div','sv-chip');
   if(v&&typeof v==='object'){
    const lab=inp(v.label);lab.oninput=()=>{v.label=lab.value;markDirty();schedulePreview();};
    c.append(lab,el('span','sv-chip-v',v.value));
   }else{
    const lab=inp(v);lab.oninput=()=>{arr[i]=lab.value;markDirty();schedulePreview();};
    c.append(lab);
   }
   const del=el('button','sv-chip-x','✕');del.type='button';del.title='删除该选项';
   del.onclick=()=>{arr.splice(i,1);markDirty();redraw();schedulePreview();};
   c.append(del);box.append(c);
  });
  const add=el('div','sv-chip sv-chip-add');
  const ai=inp('',opts.ph||'新选项，回车添加');ai.onkeydown=e=>{if(e.key==='Enter'&&ai.value.trim()){e.preventDefault();arr.push(opts.objects?{value:ai.value.trim(),label:ai.value.trim()}:ai.value.trim());markDirty();redraw();schedulePreview();}};
  add.append(ai);box.append(add);
 };redraw();return box;
}
function numIn(v,min,max){const i=inp(v);i.type='number';if(min!=null)i.min=min;if(max!=null)i.max=max;return i;}
function editorHead(title,badges){const h=el('div','sv-eh');h.append(el('h2',null,title));if(badges)h.append(badges);return h;}
function riskBadge(){return el('span','sv-risktag','⚠ 此处改动保存时需确认');}
function delBtn(label,fn){const b=el('button',null,label);b.type='button';b.onclick=fn;return b;}

// ===== 编辑器（按节点类型）=====
function renderEdit(){
 const box=$('edit');box.textContent='';
 if(!sel){box.append(el('p','hint','在左侧选择一个节点开始编辑。'));return;}
 const n=sel,s=data.schema;
 const head=(t,b)=>box.append(editorHead(t,b));
 if(n.t==='wglobal'){
  head('全局设置');
  const li=inp(s.longTerm,'长期恋爱方向的选项文案（题 12 选此项时显示 conditional 题）');
  li.oninput=()=>{s.longTerm=li.value;markDirty();};
  box.append(frow('长期恋爱选项文案',li),'');
  box.append(el('p','hint','匹配权重（题组 → 0–5）在每道题的编辑器里设置。'));
 }else if(n.t==='wsec'){
  head('分区 '+(n.i+1));
  const ni=inp(s.sections[n.i],'分区名');ni.oninput=()=>{s.sections[n.i]=ni.value;markDirty();refreshTreeSoon();};
  box.append(frow('分区名',ni));
  const del=delBtn('删除分区',()=>{if(s.questions.some(q=>q.section===n.i))return toast('该分区下还有题目，先把题目移到别的分区',1);
   dialog('删除分区','删除分区「'+s.sections[n.i]+'」？','删除',()=>{s.sections.splice(n.i,1);s.questions.forEach(q=>{if(q.section>n.i)q.section--;});sel=null;markDirty();renderAll();});});
  box.append(del);
 }else if(n.t==='wq'){
  const q=n.q,isLock=locked.has(String(q.id));
  head('题 '+q.id+(isLock?' 🔒':''),collectChanges().risks.some(r=>r.node===q)||collectChanges().errors.some(r=>r.node===q)?riskBadge():null);
  const ti=inp(q.title,'题干');ti.oninput=()=>{q.title=ti.value;markDirty();refreshTreeSoon();};
  box.append(frow('题干',ti));
  const hi=inp(q.hint,'提示（可空）');hi.oninput=()=>{q.hint=hi.value||undefined;markDirty();schedulePreview();};
  box.append(frow('提示',hi));
  const ts=el('select','sv-in');W_TYPES.forEach(t=>ts.append(new Option(W_TYPE_NAMES[t],t)));ts.value=q.type;
  ts.disabled=isLock;ts.onchange=()=>{q.type=ts.value;markDirty();renderEdit();renderPreview();};
  box.append(frow('类型',ts,isLock?el('span',null,'🔒 被匹配逻辑依赖，不能改类型'):null));
  if(['radio','multi','scale'].includes(q.type))box.append(frow('选项（每行一个 → 改/删已有项需确认，追加安全）',chips(q.options)));
  if(q.type==='multi'){
   const mi=numIn(q.min,1,99),xi=numIn(q.max,1,99);
   mi.oninput=()=>{q.min=Number(mi.value)||1;markDirty();};xi.oninput=()=>{q.max=Number(xi.value)||1;markDirty();};
   const r=el('div','sv-frow');r.append(el('label',null,'最少 '),mi,el('label',null,' 最多 '),xi);box.append(r);
  }
  const flags=el('div','sv-flags');
  for(const [k,label] of [['important','可设为重要'],['display','资料卡展示'],['optional','选填'],['conditional','仅长期恋爱方向显示']]){
   const c=chk(q[k],label);c.querySelector('input').onchange=e=>{q[k]=e.target.checked;markDirty();};flags.append(c);
  }
  box.append(flags);
  const r2=el('div','sv-frow');
  const sec=el('select','sv-in');s.sections.forEach((nm,i)=>sec.append(new Option(nm,i)));sec.value=q.section;
  sec.onchange=()=>{q.section=Number(sec.value);markDirty();renderAll();};
  const gi=inp(q.group,'题组号');gi.style.width='80px';gi.oninput=()=>{q.group=gi.value;markDirty();};
  s.weights=s.weights||{};
  const wi=numIn(s.weights[q.group]??'',0,5);wi.step='0.5';wi.oninput=()=>{if(wi.value==='')delete s.weights[q.group];else s.weights[q.group]=Number(wi.value);markDirty();};
  r2.append(el('label',null,'分区 ',sec),el('label',null,' 题组 ',gi),el('label',null,' 权重(0–5) ',wi));
  box.append(r2);
  const acts=el('div','actions');
  acts.append(delBtn('↑ 上移',()=>{const i=s.questions.indexOf(q);if(i>0){[s.questions[i-1],s.questions[i]]=[s.questions[i],s.questions[i-1]];markDirty();renderAll();}}));
  acts.append(delBtn('↓ 下移',()=>{const i=s.questions.indexOf(q);if(i<s.questions.length-1){[s.questions[i+1],s.questions[i]]=[s.questions[i],s.questions[i+1]];markDirty();renderAll();}}));
  const del=delBtn('删除题目',()=>dialog('删除题目','删除题 '+q.id+'（'+q.title+'）？','删除',()=>{s.questions=s.questions.filter(x=>x!==q);sel=null;markDirty();renderAll();}));
  if(isLock){del.disabled=true;del.title='被匹配逻辑依赖，不能删除';}
  acts.append(del);box.append(acts);
 }else if(n.t==='bglobal'){
  head('搭子卡片 · 全局');
  const mi=numIn(s.MAX,1,20);mi.oninput=()=>{s.MAX=Number(mi.value)||6;markDirty();};
  box.append(frow('每人最多卡片数',mi));
  const add=el('div','sv-frow');const ki=inp('','英文 key，如 sport2');const ni=inp('','类型名');
  const btn=delBtn('＋ 新增搭子类型',()=>{const k=ki.value.trim();if(!k||!ni.value.trim()||s.TYPES[k])return toast('需要未重复的英文 key 和类型名',1);
   s.TYPES[k]={name:ni.value.trim(),icon:'🎯',main:{key:'item',label:'项目',opts:['选项1','选项2']},extra:[]};
   markDirty();renderAll();toast('已新增类型「'+ni.value.trim()+'」，记得补全选项');});
  add.append(ki,ni,btn);box.append(add);
 }else if(n.t==='bcommongrp'){
  head('公共字段（所有搭子类型共用）');
  const add=el('div','sv-frow');const ki=inp('','英文 key');const li=inp('','字段名');
  const btn=delBtn('＋ 新增公共字段',()=>{const k=ki.value.trim();if(!k||!li.value.trim()||s.COMMON.some(f=>f.key===k))return toast('需要未重复的英文 key 和字段名',1);
   s.COMMON.push({key:k,label:li.value.trim(),opts:['选项1','选项2']});markDirty();renderAll();});
  add.append(ki,li,btn);box.append(add);
  box.append(el('p','hint','点击左侧具体字段进行编辑。'));
 }else if(n.t==='bcommon'||n.t==='bfield'){
  const f=n.f,isCommon=n.t==='bcommon';
  head((isCommon?'公共字段 ':'')+f.key+(f.multi?'（多选）':f.select?'（下拉）':f.text?'（文本填写）':''),collectChanges().risks.some(r=>r.node===f)?riskBadge():null);
  const li=inp(f.label,'字段名');li.oninput=()=>{f.label=li.value;markDirty();refreshTreeSoon();};
  box.append(frow('字段名',li));
  if(f.text){box.append(el('p','hint','文本填写型（如游戏名），无选项列表。'));}
  else box.append(frow('选项（改/删已有项需确认）',chips(f.opts)));
  const acts=el('div','actions');
  if(isCommon)acts.append(delBtn('删除公共字段',()=>dialog('删除字段','删除公共字段「'+f.label+'」？','删除',()=>{s.COMMON=s.COMMON.filter(x=>x!==f);sel=null;markDirty();renderAll();})));
  else if(n.f!==n.owner.main)acts.append(delBtn('删除字段',()=>dialog('删除字段','删除「'+n.owner.name+'」的字段「'+f.label+'」？','删除',()=>{n.owner.extra=n.owner.extra.filter(x=>x!==f);sel=null;markDirty();renderAll();})));
  box.append(acts);
 }else if(n.t==='btype'){
  const t=data.schema.TYPES[n.key];head((t.icon||'🎯')+' '+t.name+'（'+n.key+'）',collectChanges().risks.some(r=>r.node===t)?riskBadge():null);
  const ni=inp(t.name,'类型名');ni.oninput=()=>{t.name=ni.value;markDirty();refreshTreeSoon();};
  const ic=inp(t.icon,'图标');ic.style.width='70px';ic.oninput=()=>{t.icon=ic.value;markDirty();refreshTreeSoon();};
  const oc=chk(t.online,'线上类型');oc.querySelector('input').onchange=e=>{t.online=e.target.checked;markDirty();};
  const r=el('div','sv-frow');r.append(el('label',null,'类型名 ',ni),el('label',null,' 图标 ',ic),oc);box.append(r);
  const add=el('div','sv-frow');const ki=inp('','英文 key');const li2=inp('','字段名');
  const btn=delBtn('＋ 新增字段',()=>{const k=ki.value.trim();if(!k||!li2.value.trim()||(t.extra||[]).some(x=>x.key===k))return toast('需要未重复的英文 key 和字段名',1);
   (t.extra=t.extra||[]).push({key:k,label:li2.value.trim(),opts:['选项1','选项2']});markDirty();renderAll();});
  add.append(ki,li2,btn);box.append(add);
  const del=delBtn('删除该类型',()=>dialog('删除类型','删除搭子类型「'+t.name+'」？保存时需确认影响。','删除',()=>{delete s.TYPES[n.key];sel=null;markDirty();renderAll();}));
  box.append(del);
 }else if(n.t==='dschoolgrp'){
  head('学校 → 校区');
  const add=el('div','sv-frow');const ni=inp('','学校名');
  const btn=delBtn('＋ 新增学校',()=>{const v=ni.value.trim();if(!v||s.schools[v])return toast('学校名不能为空或重复',1);
   s.schools[v]=['校区1'];markDirty();renderAll();});
  add.append(ni,btn);box.append(add);
  box.append(el('p','hint','点击左侧学校编辑校区列表。删除学校/改校区保存时需确认。'));
 }else if(n.t==='dschool'){
  head('🏫 '+n.name,collectChanges().risks.some(r=>r.node===s.schools[n.name])?riskBadge():null);
  box.append(frow('校区列表（改/删需确认）',chips(s.schools[n.name])));
  const rn=inp(n.name,'学校名');rn.oninput=()=>{const v=rn.value;if(v&&v!==n.name){s.schools[v]=s.schools[n.name];delete s.schools[n.name];n.name=v;markDirty();refreshTreeSoon();}};
  box.append(frow('学校名',rn));
  box.append(delBtn('删除学校',()=>dialog('删除学校','删除学校「'+n.name+'」？保存时需确认影响。','删除',()=>{delete s.schools[n.name];sel=null;markDirty();renderAll();})));
 }else if(n.t==='dstep'){
  head('第 '+(n.si+1)+' 步');
  const ni=inp(s.steps[n.si],'步骤名');ni.oninput=()=>{s.steps[n.si]=ni.value;markDirty();refreshTreeSoon();};
  box.append(frow('步骤名',ni));
  box.append(delBtn('＋ 新增卡片',()=>{s.cards[n.si].push({label:'新卡片',items:[]});markDirty();renderAll();}));
 }else if(n.t==='dcard'){
  const c=s.cards[n.si][n.ci];head('🗂 '+c.label);
  const li=inp(c.label,'卡片标题');li.oninput=()=>{c.label=li.value;markDirty();refreshTreeSoon();};
  box.append(frow('卡片标题',li));
  const hi=inp(c.hint,'卡片提示（可空）');hi.oninput=()=>{c.hint=hi.value||undefined;markDirty();schedulePreview();};
  box.append(frow('提示',hi));
  const rc=chk(c.required,'必填卡片');rc.querySelector('input').onchange=e=>{c.required=e.target.checked;markDirty();};box.append(rc);
  const add=el('div','sv-frow');const ki=inp('','英文 key');const tsel=el('select','sv-in');D_TYPES.forEach(t=>tsel.append(new Option(D_TYPE_NAMES[t],t)));
  const btn=delBtn('＋ 新增字段',()=>{const k=ki.value.trim();if(!k)return toast('需要英文 key',1);
   c.items.push({key:k,type:tsel.value,label:'新字段',options:['选项1','选项2']});markDirty();renderAll();toast('新增字段保存时需确认匹配逻辑兼容');});
  add.append(ki,tsel,btn);box.append(add);
  box.append(delBtn('删除卡片',()=>dialog('删除卡片','删除卡片「'+c.label+'」？','删除',()=>{s.cards[n.si]=s.cards[n.si].filter(x=>x!==c);sel=null;markDirty();renderAll();})));
 }else if(n.t==='ditem'){
  const it=n.it,isLock=locked.has(it.key);
  const risky=collectChanges().risks.some(r=>r.node===it)||collectChanges().errors.some(r=>r.node===it);
  head((isLock?'🔒 ':'')+it.key+' · '+(D_TYPE_NAMES[it.type]||it.type),risky?riskBadge():null);
  if(it.label!==undefined){const li=inp(it.label,'字段文案');li.oninput=()=>{it.label=li.value;markDirty();refreshTreeSoon();};box.append(frow('字段文案',li));}
  if(it.placeholder!==undefined){const pi=inp(it.placeholder,'占位提示');pi.oninput=()=>{it.placeholder=pi.value;markDirty();schedulePreview();};box.append(frow('占位提示',pi));}
  if(it.hint!==undefined){const hi=inp(it.hint,'提示');hi.oninput=()=>{it.hint=hi.value;markDirty();schedulePreview();};box.append(frow('提示',hi));}
  const ts=el('select','sv-in');D_TYPES.forEach(t=>ts.append(new Option(D_TYPE_NAMES[t],t)));ts.value=it.type;ts.disabled=isLock;
  ts.onchange=()=>{it.type=ts.value;markDirty();renderEdit();renderPreview();};
  box.append(frow('类型',ts,isLock?el('span',null,'🔒 不能改类型'):null));
  if(it.type==='options'||it.type==='tags')box.append(frow('选项（改/删已有项需确认，追加安全）',chips(it.options)));
  if(it.type==='select'&&!it.fromSchools){
   if(it.groups){const g=el('div');
    for(const [gname,arr] of Object.entries(it.groups)){
     const gn=inp(gname,'组名');gn.oninput=()=>{if(gn.value&&gn.value!==gname){it.groups[gn.value]=arr;delete it.groups[gname];markDirty();}};
     g.append(frow('分组：',gn),chips(arr));
    }
    const gb=delBtn('＋ 新增分组',()=>{const nm='分组'+(Object.keys(it.groups).length+1);it.groups[nm]=['选项1'];markDirty();renderEdit();});
    g.append(gb);box.append(frow('分组选项',g));
   }else box.append(frow('选项（改/删已有项需确认）',chips(it.options)));
  }
  if(it.fromSchools)box.append(el('p','hint','选项来自「学校 → 校区」的学校列表（fromSchools）。'));
  if(it.type==='campus'||it.type==='expect-campus')box.append(el('p','hint','校区联动组件，选项来自学校列表。'));
  if(it.type==='personality')box.append(el('p','hint','滑块维度在「性格滑块维度」节点编辑。'));
  if(it.type==='interests')box.append(el('p','hint','兴趣选项在「兴趣模块」节点编辑。'));
  if(it.type==='photos')box.append(el('p','hint','照片上传组件，上限在「照片与联系方式」节点编辑。'));
  if(it.type==='contacts')box.append(el('p','hint','联系方式类型在「照片与联系方式」节点编辑。'));
  const acts=el('div','actions');
  acts.append(delBtn('↑ 上移',()=>{const c=s.cards[n.si][n.ci],i=c.items.indexOf(it);if(i>0){[c.items[i-1],c.items[i]]=[c.items[i],c.items[i-1]];markDirty();renderAll();}}));
  acts.append(delBtn('↓ 下移',()=>{const c=s.cards[n.si][n.ci],i=c.items.indexOf(it);if(i<c.items.length-1){[c.items[i+1],c.items[i]]=[c.items[i],c.items[i+1]];markDirty();renderAll();}}));
  const del=delBtn('删除字段',()=>dialog('删除字段','删除字段 '+it.key+'？','删除',()=>{const c=s.cards[n.si][n.ci];c.items=c.items.filter(x=>x!==it);sel=null;markDirty();renderAll();}));
  if(isLock){del.disabled=true;del.title='被匹配逻辑依赖，不能删除';}
  acts.append(del);box.append(acts);
 }else if(n.t==='dpersonality'){
  head('性格滑块维度');
  box.append(el('p','hint','文案可自由改（不影响存储与匹配）；数量即匹配维度，1–12 个。'));
  s.personality.forEach((p,i)=>{
   const r=el('div','sv-prow');
   for(const k of ['title','self','left','right']){
    const x=inp(p[k],{title:'维度名',self:'自评题干',left:'左端',right:'右端'}[k]);
    x.oninput=()=>{p[k]=x.value;markDirty();schedulePreview();};r.append(x);
   }
   r.append(delBtn('✕',()=>dialog('删除维度','删除性格维度「'+p.title+'」？','删除',()=>{s.personality.splice(i,1);markDirty();renderAll();})));
   box.append(r);
  });
  box.append(delBtn('＋ 新增维度',()=>{s.personality.push({title:'新维度',self:'自评题干',left:'左',right:'右'});markDirty();renderAll();}));
 }else if(n.t==='dinterests'){
  const it=s.interests;head('兴趣模块',collectChanges().risks.some(r=>r.node===it)?riskBadge():null);
  box.append(frow('兴趣大类（顺序即匹配优先级，改/删需确认）',chips(it.categories)));
  box.append(el('h3',null,'各大类细分'));
  for(const [cat,arr] of Object.entries(it.subcategories)){
   const g=el('div','sv-subcat');g.append(el('b',null,cat),chips(arr));box.append(g);
  }
  const add=el('div','sv-frow');const ci=inp('','大类名（须已在大类列表中）');
  const btn=delBtn('＋ 为新大类添加细分',()=>{const v=ci.value.trim();if(!v||it.subcategories[v])return toast('大类名不能为空或重复',1);
   it.subcategories[v]=['细分1'];markDirty();renderEdit();});
  add.append(ci,btn);box.append(add);
  box.append(frow('熟练度（按文案计分，改/删需确认）',chips(it.skillLevels)));
  box.append(frow('交流频次（按顺序计分，必须含「没要求」）',chips(it.freq)));
 }else if(n.t==='dmisc'){
  head('照片与联系方式');
  const pm=numIn(s.photos.max,1,6);pm.oninput=()=>{s.photos.max=Number(pm.value)||3;markDirty();schedulePreview();};
  box.append(frow('照片上限（1–6）',pm));
  box.append(frow('联系方式类型（改/删需确认）',chips(s.contacts.methods)));
 }
}
let treeTimer=null;
function refreshTreeSoon(){clearTimeout(treeTimer);treeTimer=setTimeout(renderTree,300);}
let pvTimer=null;
function schedulePreview(){clearTimeout(pvTimer);pvTimer=setTimeout(renderPreview,150);}

// ===== 填写分布（真实答案聚合，按 kind 缓存一次）=====
async function distFor(k){
 if(distCache[k]!==undefined)return distCache[k];
 try{const j=await api('/api/admin/survey-stats/'+k);distCache[k]=j.code===200?j:null;}
 catch(e){distCache[k]=null;}
 return distCache[k];
}
function distKey(n){
 if(n.t==='wq')return String(n.q.id);
 if(n.t==='bcommon'||n.t==='bfield')return n.f.key;
 if(n.t==='ditem')return n.it.key;
 return null;
}
async function renderDist(n){
 const host=$('dist');host.textContent='';
 const key=distKey(n);
 if(!key){host.append(el('p','hint','选中带选项的题目后，这里显示真实填写分布。'));return;}
 const s=await distFor(kind);
 if(!s){host.append(el('p','hint','填写分布暂不可用，可稍后重试。'));return;}
 const q=s.questions.find(x=>x.id===key);
 if(!q){host.append(el('p','hint','该题暂无统计数据。'));return;}
 host.append(el('h2',null,'填写分布 · 共 '+s.total+' 份答卷'));
 if(!q.counts){host.append(el('p','hint','填写型题目：'+q.answered+' 人已填写。'));return;}
 const entries=Object.entries(q.counts),max=Math.max(1,...entries.map(e=>e[1]));
 for(const [opt,cnt] of entries){
  const row=el('div','sv-dist-row'+(cnt?'':' zero'));
  const bar=el('div','sv-dist-bar');bar.style.width=(cnt?Math.max(2,cnt/max*100):0)+'%';
  row.append(el('span','sv-dist-lb',opt),bar,el('span','sv-dist-n',cnt?cnt+' 人':'0 人选择'));
  host.append(row);
 }
}

// ===== 用户端预览（轻量独立渲染器，pv-* 自带样式）=====
function pvOpt(text,cls){return el('button','pv-opt'+(cls?' '+cls:''),text);}
function renderPreview(){
 const box=$('preview');box.textContent='';
 if(!sel){box.append(el('p','hint','选择节点后这里显示用户端的样子。'));return;}
 const s=data.schema,n=sel;
 const wrap=el('div','pv-card');
 if(n.t==='wq'){
  const q=n.q;
  wrap.append(el('div','pv-title',q.id+'｜'+(q.type==='college'?'我的专业':q.title)));
  if(q.display)wrap.append(el('span','pv-badge','会展示'));
  if(q.hint)wrap.append(el('p','pv-hint',q.hint));
  if(q.important)wrap.append(el('div','pv-star','☆ 设为重要'));
  const o=el('div','pv-opts');
  if(['radio','multi','scale'].includes(q.type)){q.options.forEach(v=>o.append(pvOpt(v)));wrap.append(o);
   if(q.type==='multi')wrap.append(el('p','pv-hint','请选择 '+q.min+'–'+q.max+' 项'));}
  else if(q.type==='month'){const i=el('input','pv-input');i.type='month';wrap.append(i);}
  else if(q.type==='age'){const none=el('label','pv-line');none.append(el('input'),document.createTextNode(' 没有特殊要求，先看看'));wrap.append(none);
   for(const l of ['比我大最多（岁）','比我小最多（岁）']){const i=el('input','pv-input');i.type='number';const r=el('div','pv-line');r.append(document.createTextNode(l+' '),i);wrap.append(r);}}
  else if(q.type==='education'){for(const l of ['身份','年级']){const d=el('select','pv-select');d.append(new Option('请选择',''));wrap.append(el('div','pv-line',l+' '),d);}}
  else if(q.type==='number'){const i=el('input','pv-input');i.type='number';i.placeholder='身高（cm）';wrap.append(i);}
  else if(q.type==='height'){wrap.append(el('div','pv-line','最低身高 '),Object.assign(el('input','pv-input'),{type:'number'}),el('div','pv-line',' 最高身高 '),Object.assign(el('input','pv-input'),{type:'number'}));}
  else if(q.type==='college'){const i=el('input','pv-input');i.readOnly=true;i.value='中山大学';wrap.append(el('div','pv-line','学校 '),i);
   const c=el('select','pv-select');c.append(new Option('请选择',''));wrap.append(el('div','pv-line','专业大类 '),c);
   const m=el('input','pv-input');m.placeholder='例如：汉语言文学';wrap.append(el('div','pv-line','细分专业 '),m);}
  else if(q.type==='hometown'){const p=el('input','pv-input');p.placeholder='省份 / 地区';const c=el('input','pv-input');c.placeholder='城市';wrap.append(p,c);}
  else if(q.type==='text'){const t=el('textarea','pv-textarea');t.rows=3;t.placeholder='50 字以内，可以留空';wrap.append(t);}
 }else if(n.t==='bcommon'||n.t==='bfield'){
  const f=n.f;wrap.append(el('div','pv-title',f.label));
  if(f.text){const i=el('input','pv-input');i.placeholder='例如：王者荣耀、原神';wrap.append(i);}
  else if(f.select||(!f.multi&&!f.opts)){const d=el('select','pv-select');d.append(new Option('请选择',''));(f.opts||[]).forEach(v=>d.append(new Option(v,v)));wrap.append(d);}
  else{const o=el('div','pv-opts');(f.opts||[]).forEach(v=>o.append(pvOpt(v,f.multi?'pv-tag':'')));wrap.append(o);}
 }else if(n.t==='btype'){
  const t=s.TYPES[n.key];wrap.append(el('div','pv-title',(t.icon||'🎯')+' '+t.name+(t.online?' · 线上':'')));
  const o=el('div','pv-opts');if(t.main.text){const i=el('input','pv-input');i.placeholder=t.main.ph||'文本填写';wrap.append(el('div','pv-line',t.main.label+' '),i);}
  else{const oo=el('div','pv-opts');t.main.opts.forEach(v=>oo.append(pvOpt(v)));wrap.append(el('div','pv-line',t.main.label),oo);}
  (t.extra||[]).forEach(f=>{const oo=el('div','pv-opts');f.opts.forEach(v=>oo.append(pvOpt(v,f.multi?'pv-tag':'')));wrap.append(el('div','pv-line',f.label),oo);});
 }else if(n.t==='ditem'||n.t==='dcard'||n.t==='dstep'){
  const items=n.t==='ditem'?[n.it]:n.t==='dcard'?s.cards[n.si][n.ci].items:s.cards[n.si].flatMap(c=>c.items);
  if(n.t==='dcard')wrap.append(el('div','pv-title',s.cards[n.si][n.ci].label));
  if(n.t==='dstep')wrap.append(el('div','pv-title','第 '+(n.si+1)+' 步 · '+s.steps[n.si]));
  items.forEach(it=>{
   if(it.label)wrap.append(el('div','pv-line pv-strong',it.label));
   if(it.hint)wrap.append(el('p','pv-hint',it.hint));
   const type=it.type;
   if(type==='options'||type==='tags'){const o=el('div','pv-opts');(it.options||[]).forEach(v=>o.append(pvOpt(v&&v.label!==undefined?v.label:String(v),type==='tags'?'pv-tag':'')));wrap.append(o);}
   else if(type==='select'||type==='major'){
    const d=el('select','pv-select');if(it.placeholder)d.append(new Option(it.placeholder,''));
    if(it.fromSchools)Object.keys(s.schools).forEach(v=>d.append(new Option(v,v)));
    else if(it.groups)for(const [g,arr] of Object.entries(it.groups)){const og=el('optgroup');og.label=g;arr.forEach(v=>og.append(new Option(v&&v.label!==undefined?v.label:String(v),v&&v.value!==undefined?v.value:v)));d.append(og);}
    else (it.options||[]).forEach(v=>d.append(new Option(v&&v.label!==undefined?v.label:String(v),v&&v.value!==undefined?v.value:v)));
    wrap.append(d);
   }
   else if(type==='text'){const i=el('input','pv-input');i.placeholder=it.placeholder||'';if(it.max)i.maxLength=it.max;wrap.append(i);}
   else if(type==='textarea'){const t=el('textarea','pv-textarea');t.rows=3;t.placeholder=it.placeholder||'';wrap.append(t);}
   else if(type==='campus'){const d=el('select','pv-select');d.append(new Option('选择校区',''));(s.schools['中山大学']||[]).forEach(c=>d.append(new Option(c,c)));wrap.append(d);}
   else if(type==='expect-campus'){const d=el('select','pv-select');d.append(new Option(it.label||'+ 添加校区偏好',''));Object.keys(s.schools).forEach(v=>d.append(new Option(v,v)));wrap.append(d);}
   else if(type==='personality'){s.personality.forEach(p=>{
    const r=el('div','pv-slider');r.append(el('span','pv-slider-l',p.left));
    const t=el('div','pv-track');const i=el('input','pv-range');i.type='range';i.min=1;i.max=5;i.value=3;t.append(i);r.append(t,el('span','pv-slider-r',p.right));
    wrap.append(el('div','pv-line pv-strong',p.title),r);});}
   else if(type==='interests'){const o=el('div','pv-opts');s.interests.categories.slice(0,12).forEach(c=>o.append(pvOpt(c,'pv-tag')));wrap.append(o,el('p','pv-hint','（共 '+s.interests.categories.length+' 个大类，点击后展开细分/熟练度/频次）'));}
   else if(type==='photos'){for(let i=0;i<(s.photos.max||3);i++)wrap.append(el('div','pv-upload','＋ 上传照片'));}
   else if(type==='contacts'){const d=el('select','pv-select');d.append(new Option('选择方式',''));s.contacts.methods.forEach(m=>d.append(new Option(m,m)));wrap.append(d,el('input','pv-input'));}
  });
 }else if(n.t==='dschool'){
  wrap.append(el('div','pv-title','🏫 '+n.name));
  const o=el('div','pv-opts');s.schools[n.name].forEach(c=>o.append(pvOpt(c)));wrap.append(o);
 }else if(n.t==='dpersonality'){
  s.personality.forEach(p=>{wrap.append(el('div','pv-line pv-strong',p.title));
   const r=el('div','pv-slider');r.append(el('span','pv-slider-l',p.left));const t=el('div','pv-track');const i=el('input','pv-range');i.type='range';i.min=1;i.max=5;i.value=3;t.append(i);r.append(t,el('span','pv-slider-r',p.right));wrap.append(r);});
 }else if(n.t==='dinterests'){
  wrap.append(el('div','pv-title','兴趣大类（顺序即优先级）'));
  const o=el('div','pv-opts');s.interests.categories.forEach(c=>o.append(pvOpt(c,'pv-tag')));wrap.append(o);
 }else if(n.t==='dmisc'){
  wrap.append(el('div','pv-title','照片上限 '+s.photos.max));
  for(let i=0;i<s.photos.max;i++)wrap.append(el('div','pv-upload','＋ 上传照片'));
  wrap.append(el('div','pv-title','联系方式'));
  const d=el('select','pv-select');d.append(new Option('选择方式',''));s.contacts.methods.forEach(m=>d.append(new Option(m,m)));wrap.append(d);
 }else if(n.t==='wglobal'||n.t==='bglobal'||n.t==='bcommongrp'||n.t==='dschoolgrp'){
  wrap.append(el('p','hint','该节点是设置项，无用户端组件。'));
 }
 box.append(wrap);
 renderDist(n);
}

// ===== 载入 / 保存 =====
function renderAll(){renderTree();renderEdit();renderPreview();}
function renderKinds(){const nav=$('kinds');nav.textContent='';
 for(const [k,name] of Object.entries(KINDS)){const b=el('button',k===kind?'on':'',name);b.type='button';
  b.onclick=()=>{if(k===kind)return;if(dirty){dialog('切换问卷类型','有未保存的修改，切换将丢弃。仍要切换？','切换',()=>{dirty=false;$('dirty').hidden=true;kind=k;sel=null;load();});return;}kind=k;sel=null;load();};
  nav.append(b);}}
async function load(){
 $('app').textContent='正在读取…';$('work').hidden=true;
 const j=await api('/api/admin/survey-schema/'+kind);
 if(j.code!==200){$('app').textContent=j.msg||'读取失败';return;}
 data=j;locked=new Set(j.locked||[]);orig=clone(j.schema);dirty=false;$('dirty').hidden=true;distCache={};
 expanded.clear();if(kind==='weekly')expanded.add('wsec:0');else if(kind==='deep'){expanded.add('dstep:0');expanded.add('dschools');}else expanded.add('bcommon');
 sel=null;$('app').textContent='';$('work').hidden=false;
 $('ver').textContent='当前版本 v'+data.version;
 renderKinds();renderAll();
}
$('reload').onclick=()=>{
 if(dirty){dialog('重新载入','有未保存的修改，重新载入将丢弃。仍要继续？','重新载入',load);return;}
 load();
};
$('save').onclick=async()=>{
 const {risks,errors}=collectChanges();
 if(errors.length){dialog('无法保存',errors.map(e=>el('li','sv-errli',e.msg)),null,null);return;}
 const doSave=async force=>{
  const j=await api('/api/admin/survey-schema/'+kind,'PUT',{schema:data.schema,force});
  if(j.code===200){toast(j.msg);dirty=false;$('dirty').hidden=true;await load();}
  else dialog('保存失败',(j.problems||[j.msg||'保存失败']).map(p=>el('li','sv-errli',p)),null,null);
 };
 if(risks.length){
  const ul=el('ul','sv-risklist');risks.forEach(r=>ul.append(el('li',null,'⚠ '+r.msg)));
  dialog('以下改动会影响已有用户答案，请逐条确认',ul,'我已了解影响，保存',()=>doSave(true));
 }else doSave(false);
};
load().catch(e=>toast(e.message,1));
