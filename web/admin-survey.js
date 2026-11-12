'use strict';
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const token=localStorage.getItem('adminToken');
if(!token)location.replace('/admin');
const KINDS={weekly:'每周恋爱问卷',buddy:'搭子卡片','deep-options':'深度交友选项'};
let kind='weekly',data=null,locked=new Set();
function toast(msg,bad){const t=$('toast');t.textContent=msg;t.hidden=false;t.classList.toggle('bad',!!bad);clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.hidden=true,6000);}
async function api(path,method,body){const r=await fetch(path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const j=await r.json().catch(()=>({code:r.status,msg:'响应异常'}));if(r.status===401){localStorage.removeItem('adminToken');location.replace('/admin');throw Error('请重新登录');}return j;}
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const inp=(value,ph)=>{const i=el('input');i.value=value??'';if(ph)i.placeholder=ph;return i;};
const ta=(value)=>{const t=el('textarea');t.value=(value||[]).join('\n');t.rows=Math.min(8,Math.max(3,(value||[]).length||3));return t;};
const chk=(on,label)=>{const l=el('label','inline');const i=el('input');i.type='checkbox';i.checked=!!on;l.append(i,document.createTextNode(' '+label));return l;};
const card=(title)=>{const s=el('section','card');if(title)s.append(el('h2',null,title));return s;};
const lines=t=>t.value.split('\n').map(x=>x.trim()).filter(Boolean);

async function load(){const j=await api('/api/admin/survey-schema/'+kind);if(j.code!==200){$('app').textContent=j.msg||'读取失败';return;}data=j;locked=new Set(j.locked||[]);render();}
function renderKinds(){const nav=$('kinds');nav.textContent='';for(const [k,name] of Object.entries(KINDS)){const b=el('div','stat');const v=el('div','v',name);const l=el('div','l',k===kind?'当前编辑中':'点击切换');b.onclick=()=>{kind=k;load();};if(k===kind)b.style.borderColor='var(--green)';b.append(v,l);nav.append(b);}}

// ===== weekly =====
function renderWeekly(){
 const s=data.schema,box=$('app');box.textContent='';
 const sec=card('分区');const secList=el('div');
 s.sections.forEach((name,i)=>{const row=el('div','row');const w=el('div');const ni=inp(name,'分区名');ni.oninput=()=>s.sections[i]=ni.value;w.append(ni);row.append(w);const del=el('button',null,'删除分区');del.onclick=()=>{if(s.questions.some(q=>q.section===i))return toast('该分区下还有题目，先移走题目',1);s.sections.splice(i,1);renderWeekly();};const act=el('div','actions');act.append(del);row.append(act);secList.append(row);});
 sec.append(secList);const add=el('button',null,'＋ 新增分区');add.onclick=()=>{s.sections.push('新分区');renderWeekly();};sec.append(add);box.append(sec);

 const wcard=card('匹配权重（题组号 → 0–5，0 表示不参与计分）');const wgrid=el('div','stats');
 const groups=[...new Set(s.questions.map(q=>q.group))];
 s.weights=s.weights||{};
 for(const g of groups){const q=s.questions.find(x=>x.group===g);const st=el('div','stat');const i=inp(s.weights[g]??'');i.type='number';i.min=0;i.max=5;i.step='0.5';i.oninput=()=>{if(i.value==='')delete s.weights[g];else s.weights[g]=Number(i.value);};st.append(el('div','l',(locked.has(q.id)?'🔒 ':'')+g+'｜'+q.title.slice(0,14)),i);wgrid.append(st);}
 wcard.append(wgrid);box.append(wcard);

 const qc=card('题目（'+s.questions.length+' 题）');
 for(const q of s.questions){
  const row=el('div','row');const left=el('div');
  left.append(el('b',null,(locked.has(q.id)?'🔒 ':'')+q.id+' · '+q.type+(q.type==='multi'?'（'+q.min+'–'+q.max+'）':'')),el('br'));
  const ti=inp(q.title,'题干');ti.oninput=()=>q.title=ti.value;left.append(ti,el('br'));
  const hi=inp(q.hint,'提示（可空）');hi.oninput=()=>q.hint=hi.value||undefined;left.append(hi,el('br'));
  if(['radio','multi','scale'].includes(q.type)){const t=ta(q.options);t.oninput=()=>q.options=lines(t);left.append(t,el('br'));}
  if(q.type==='multi'){const m=el('span',null,'最少');const mi=inp(q.min);mi.type='number';mi.style.width='70px';mi.oninput=()=>q.min=Number(mi.value)||1;const mx=el('span',null,'最多');const xi=inp(q.max);xi.type='number';xi.style.width='70px';xi.oninput=()=>q.max=Number(xi.value)||1;left.append(m,mi,mx,xi,el('br'));}
  const flags=el('div');flags.style.cssText='display:flex;flex-wrap:wrap;gap:4px 14px';
  for(const [k,label] of [['important','可设为重要'],['display','资料卡展示'],['optional','选填'],['conditional','仅长期恋爱方向显示']]){const c=chk(q[k],label);c.querySelector('input').onchange=e=>q[k]=e.target.checked;flags.append(c);}
  left.append(flags);
  const sel=el('select');s.sections.forEach((n,i)=>sel.append(new Option(n,i)));sel.value=q.section;sel.onchange=()=>q.section=Number(sel.value);left.append(sel);
  row.append(left);
  const act=el('div','actions');const del=el('button',null,'删除');
  if(locked.has(q.id)){del.disabled=true;del.title='匹配逻辑依赖，不能删除';}
  del.onclick=()=>{if(!confirm('删除题 '+q.id+'？'))return;s.questions=s.questions.filter(x=>x!==q);renderWeekly();};
  act.append(del);row.append(act);qc.append(row);
 }
 const addq=el('button',null,'＋ 新增题目');addq.onclick=()=>{
  const nums=s.questions.map(q=>Number(String(q.id).replace(/[ab]/g,''))).filter(Number.isFinite);
  const id=String(Math.max(0,...nums)+1);
  s.questions.push({id,title:'新题目',options:[],group:id,section:0,important:false,display:false,optional:true,conditional:false,type:'radio'});
  renderWeekly();};
 qc.append(addq);box.append(qc);
}

// ===== buddy =====
function renderBuddy(){
 const s=data.schema,box=$('app');box.textContent='';
 const mc=card('公共字段（所有搭子类型共用）');
 for(const f of s.COMMON){
  const row=el('div','row');const left=el('div');
  const li=inp(f.label,'字段名');li.oninput=()=>f.label=li.value;left.append(el('b',null,f.key+(f.multi?'（多选）':f.select?'（下拉）':'')),el('br'),li,el('br'));
  if(!f.text){const t=ta(f.opts);t.oninput=()=>f.opts=lines(t);left.append(t);}
  row.append(left);mc.append(row);
 }
 const maxc=card('每人最多卡片数');const mi=inp(s.MAX);mi.type='number';mi.min=1;mi.max=20;mi.oninput=()=>s.MAX=Number(mi.value)||6;maxc.append(mi);box.append(mc,maxc);
 for(const [key,t] of Object.entries(s.TYPES)){
  const c=card(t.name+'（'+key+'）'+(t.online?' · 线上':''));
  const ni=inp(t.name,'类型名');ni.oninput=()=>t.name=ni.value;const ic=inp(t.icon,'图标');ic.style.width='70px';ic.oninput=()=>t.icon=ic.value;
  c.append(ni,ic,el('br'));
  const main=el('div');main.append(el('b',null,'主选项：'+t.main.label));
  if(t.main.text){main.append(el('p','hint','文本填写型（如游戏名），无选项'));}else{const mt=ta(t.main.opts);mt.oninput=()=>t.main.opts=lines(mt);main.append(mt);}
  c.append(main);
  for(const f of t.extra||[]){
   const row=el('div','row');const left=el('div');
   const li=inp(f.label,'字段名');li.oninput=()=>f.label=li.value;left.append(el('b',null,f.key+(f.multi?'（多选）':'')),el('br'),li,el('br'));
   if(!f.text){const t2=ta(f.opts);t2.oninput=()=>f.opts=lines(t2);left.append(t2);}
   row.append(left);c.append(row);
  }
  const del=el('button',null,'删除该类型');del.onclick=()=>{if(!confirm('删除搭子类型「'+t.name+'」？需勾选「我已了解影响」才能保存。'))return;delete s.TYPES[key];renderBuddy();};
  c.append(del);box.append(c);
 }
 const add=el('button',null,'＋ 新增搭子类型');add.onclick=()=>{const key=prompt('类型英文 key（如 sport2）');if(!key)return;s.TYPES[key]={name:'新类型',icon:'🎯',main:{key:'item',label:'项目',opts:['选项1','选项2']},extra:[]};renderBuddy();};
 box.append(add);
}

// ===== deep-options =====
function renderDeep(){
 const s=data.schema,box=$('app');box.textContent='';
 const sc=card('学校 → 校区');
 for(const [school,campuses] of Object.entries(s.schools)){
  const row=el('div','row');const left=el('div');
  const ni=inp(school,'学校名');ni.oninput=()=>{const v=ni.value;if(v&&v!==school){s.schools[v]=s.schools[school];delete s.schools[school];}};
  left.append(el('b',null,'学校'),el('br'),ni,el('br'));
  const t=ta(campuses);t.oninput=()=>s.schools[school]=lines(t);left.append(t);
  row.append(left);const act=el('div','actions');const del=el('button',null,'删除');del.onclick=()=>{if(!confirm('删除学校「'+school+'」？需勾选「我已了解影响」。'))return;delete s.schools[school];renderDeep();};act.append(del);row.append(act);sc.append(row);
 }
 const add=el('button',null,'＋ 新增学校');add.onclick=()=>{const n=prompt('学校名');if(!n)return;s.schools[n]=['校区1'];renderDeep();};
 sc.append(add);box.append(sc);
 const cc=card('兴趣大类');const t=ta(s.categories);t.oninput=()=>s.categories=lines(t);cc.append(t);box.append(cc);
}

function render(){renderKinds();if(kind==='weekly')renderWeekly();else if(kind==='buddy')renderBuddy();else renderDeep();$('ver').textContent='当前版本 '+data.version;}
$('reload').onclick=()=>load();
$('save').onclick=async()=>{
 const j=await api('/api/admin/survey-schema/'+kind,'PUT',{schema:data.schema,force:$('force').checked});
 if(j.code===200){toast(j.msg);$('force').checked=false;await load();}
 else{toast((j.problems||[j.msg||'保存失败']).join('；'),1);if((j.problems||[]).some(p=>p.includes('我已了解影响'))&&!$('force').checked)toast('如确认要这样改，请勾选底部「我已了解影响」后再保存',1);}
};
load().catch(e=>toast(e.message,1));
