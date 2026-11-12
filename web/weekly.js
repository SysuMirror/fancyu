'use strict';
let schema=window.WeeklySchema;const $=id=>document.getElementById(id),token=localStorage.getItem('token');
let answers={},important=[],section=0,dirty=false,saving=false;
const surveyMetrics=window.createSurveyMetrics('love',()=>token);
const DRAFT_KEY='weeklyDraft';let draftTimer=null,serverState=null;
function saveDraftNow(){try{localStorage.setItem(DRAFT_KEY,JSON.stringify({answers:read(),important}));}catch(e){}}
function scheduleDraft(){clearTimeout(draftTimer);draftTimer=setTimeout(saveDraftNow,500);}
function clearDraft(){clearTimeout(draftTimer);try{localStorage.removeItem(DRAFT_KEY);}catch(e){}hideDraftBanner();}
function readDraft(){try{const d=JSON.parse(localStorage.getItem(DRAFT_KEY));return d&&d.answers&&typeof d.answers==='object'?d:null;}catch(e){return null;}}
function showDraftBanner(){if($('draftBanner'))return;const b=el('div');b.id='draftBanner';b.className='draft-banner';b.append(document.createTextNode('已恢复上次填写进度'));const d=el('button','放弃草稿');d.type='button';d.onclick=()=>{clearDraft();if(serverState){answers=serverState.answers;important=serverState.important;}fill();sync();dirty=false;$('message').textContent='已放弃草稿，恢复为已保存的问卷。';};b.append(d);$('message').after(b);}
function hideDraftBanner(){const b=$('draftBanner');if(b)b.remove();}
for(const event of ['input','change'])$('surveyForm').addEventListener(event,()=>surveyMetrics.start());
if(!token)location.replace('/login?redirect=/survey');
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
function input(type,name,value){const i=el('input');i.type=type;i.name=name;if(value!==undefined)i.value=value;return i;}
function field(box,label,type,name,value){const l=el('label',label),i=input(type,name,value);l.append(i);box.append(l);return i;}
function select(box,label,name,values){const l=el('label',label),s=el('select');s.name=name;s.append(new Option('请选择',''));values.forEach(v=>s.append(new Option(v,v)));l.append(s);box.append(l);return s;}
function datalist(i,name,values){i.setAttribute('list',name);const d=el('datalist');d.id=name;values.forEach(v=>d.append(new Option(v,v)));i.after(d);}
const majorCategories=AcademicFields.categories;
const provinces='北京 天津 上海 重庆 河北 山西 辽宁 吉林 黑龙江 江苏 浙江 安徽 福建 江西 山东 河南 湖北 湖南 广东 海南 四川 贵州 云南 陕西 甘肃 青海 内蒙古 广西 西藏 宁夏 新疆 香港 澳门 台湾 海外'.split(' ');
function render(){schema.sections.forEach((s,i)=>{const b=el('button',s);b.type='button';b.onclick=()=>show(i);$('sections').append(b);});
for(const q of schema.questions){const box=el('section');box.className='question';box.id='q'+q.id;box.dataset.section=q.section;const head=el('div');head.className='qhead';const title=el('h2',q.id+'｜'+(q.type==='college'?'我的专业':q.title));if(q.display){const t=el('span','会展示');t.className='display';title.append(t);}head.append(title);
if(q.important){const b=el('button','☆ 设为重要');b.type='button';b.className='star';b.dataset.group=q.group;b.onclick=()=>{if(important.includes(q.group))important=important.filter(x=>x!==q.group);else if(important.length<5)important.push(q.group);else{$('message').textContent='最多可将 5 道题设为重要。';return;}dirty=true;sync();};head.append(b);}box.append(head);
if(q.hint){const p=el('p',q.hint);p.className='hint';box.append(p);}if(q.id==='34'){const p=el('p','请根据过去感情经历作答；如果还没谈过恋爱，请想象自己在一段感情中的样子。');p.className='hint';box.append(p);}
if(['radio','multi','scale'].includes(q.type)){const opts=el('div');opts.className=q.type==='scale'?'scale':'options';let group='';for(const value of q.options){if(q.optionGroups&&q.optionGroups[value]!==group){group=q.optionGroups[value];const h=el('div',group);h.className='group-label';opts.append(h);}const l=el('label');l.className='option';const i=input(q.type==='multi'?'checkbox':'radio',q.id,value);l.append(i,document.createTextNode(value==='没有要求'?'这一项我没有要求（不计分）':String(value)));opts.append(l);}box.append(opts);
 if(q.type==='multi'){const h=el('p',q.min===q.max?'请选择 '+q.min+' 项':q.max<q.options.length?'请选择 '+q.min+'–'+q.max+' 项':'可多选');h.className='hint';box.append(h);}
 if(q.id==='26')field(box,'其他饮食限制','text','diet_other').maxLength=80;
}else{const fields=el('div');fields.className='fields';box.append(fields);
 if(q.type==='month')field(fields,'出生年月','month',q.id);
 if(q.type==='number'){const i=field(fields,'身高（cm）','number',q.id);i.min=100;i.max=250;}
 if(q.type==='age'){const l=el('label');l.className='none';l.append(input('checkbox','age_unlimited'),document.createTextNode('没有特殊要求，先看看'));box.prepend(l);for(const [key,label]of [['older','比我大最多（岁）'],['younger','比我小最多（岁）']]){const i=field(fields,label,'number','age_'+key);i.min=0;i.max=82;}}
 if(q.type==='education'){select(fields,'身份','degree',['本科','硕士','博士']);select(fields,'年级','year',[1,2,3,4,5,6,7,8,9,10]);}
 if(q.type==='height'){for(const key of ['min','max']){const i=field(fields,key==='min'?'最低身高（cm）':'最高身高（cm）','number','height_'+key);i.min=100;i.max=250;}const hint=el('p','设置身高要求后，仅推荐填写了身高且在范围内的人，可匹配人数可能减少。两项留空表示不限。');hint.className='hint';box.append(hint);}
 if(q.type==='college'){const school=field(fields,'学校','text','school',AcademicFields.school);school.readOnly=true;select(fields,'专业大类',q.id+'_category',majorCategories);const i=field(fields,'细分专业','text',q.id+'_major');i.maxLength=60;i.placeholder='例如：汉语言文学、计算机科学与技术、临床医学';}
 if(q.type==='hometown'){const i=field(fields,'省份 / 地区','text','province');i.maxLength=30;datalist(i,'provinces',provinces);const city=field(fields,'城市（可选择或输入）','text','city');city.maxLength=40;datalist(city,'cities',['广州','深圳','珠海','佛山','东莞','北京','上海','杭州','南京','成都','武汉']);}
 if(q.type==='text'){const t=el('textarea');t.name=q.id;t.rows=3;t.placeholder='50 字以内，可以留空';fields.append(t);}
} $('questions').append(box);
}
$('surveyForm').addEventListener('change',e=>{dirty=true;const q=schema.questions.find(q=>q.id===e.target.name);if(q?.type==='multi'){const checked=[...document.querySelectorAll('input[name="'+q.id+'"]:checked')];if(['6','26'].includes(q.id)&&e.target.checked){const none=q.id==='6'?'没有特殊要求':'无';checked.forEach(i=>{if(i!==e.target&&(i.value===none||e.target.value===none))i.checked=false;});}
if(q.id==='47'&&e.target.checked){const none='对运动完全不感兴趣';checked.forEach(i=>{if(i!==e.target&&((e.target.value===none&&q.optionGroups[i.value]==='一起动起来')||(q.optionGroups[e.target.value]==='一起动起来'&&i.value===none)))i.checked=false;});}
if(document.querySelectorAll('input[name="'+q.id+'"]:checked').length>q.max){e.target.checked=false;$('message').textContent='第 '+q.id+' 题最多选择 '+q.max+' 项。';}}
answers=read();sync();scheduleDraft();});$('surveyForm').addEventListener('input',()=>{dirty=true;scheduleDraft();});
}
function val(name){return $('surveyForm').elements.namedItem(name)?.value||'';}
function num(name){return val(name)===''?null:Number(val(name));}
function read(){const a={};for(const q of schema.questions){if(q.type==='multi')a[q.id]=[...document.querySelectorAll('input[name="'+q.id+'"]:checked')].map(x=>x.value);
else if(q.type==='scale')a[q.id]=val(q.id)==='没有要求'?'没有要求':num(q.id);
else if(q.type==='age')a[q.id]={unlimited:!!$('surveyForm').elements.age_unlimited.checked,older:num('age_older'),younger:num('age_younger')};
else if(q.type==='education')a[q.id]={degree:val('degree'),year:num('year')};
else if(q.type==='hometown')a[q.id]={province:val('province'),city:val('city')};
else if(q.type==='height')a[q.id]=num('height_min')===null&&num('height_max')===null?null:{min:num('height_min'),max:num('height_max')};
else if(q.type==='college')a[q.id]=val(q.id+'_category')&&val(q.id+'_major').trim()?val(q.id+'_category')+' · '+val(q.id+'_major').trim():'';
else a[q.id]=q.type==='number'?num(q.id):val(q.id);}
a.diet_other=val('diet_other');return a;}
function fill(){for(const [name,value]of Object.entries(answers)){const q=schema.questions.find(q=>q.id===name);if(!q)continue;if(['radio','multi','scale'].includes(q.type)){document.querySelectorAll('input[name="'+name+'"]').forEach(i=>i.checked=Array.isArray(value)?value.includes(i.value):String(value)===i.value);}else if(q.type==='college'){const raw=String(value??''),cut=raw.indexOf(' · '),category=cut>0?raw.slice(0,cut):'';const known=majorCategories.includes(category);$('surveyForm').elements.namedItem(name+'_category').value=known?category:'';$('surveyForm').elements.namedItem(name+'_major').value=known?raw.slice(cut+3):raw;}else if(['month','number','text'].includes(q.type))$('surveyForm').elements.namedItem(name).value=value??'';}
const set=(name,value)=>$('surveyForm').elements.namedItem(name).value=value??'';
$('surveyForm').elements.age_unlimited.checked=!!answers['4']?.unlimited;set('age_older',answers['4']?.older);set('age_younger',answers['4']?.younger);set('degree',answers['5']?.degree);set('year',answers['5']?.year);set('province',answers['11']?.province);set('city',answers['11']?.city);set('height_min',answers['10b']?.min);set('height_max',answers['10b']?.max);set('diet_other',answers.diet_other);}
function sync(){const active=val('12')===schema.longTerm;
for(const q of schema.questions){const hide=q.conditional&&!active;const box=$('q'+q.id);box.hidden=q.section!==section||hide;box.querySelectorAll('input,select,textarea').forEach(i=>{i.disabled=hide;if(hide){if(i.type==='radio'||i.type==='checkbox')i.checked=false;else i.value='';}});if(hide)delete answers[q.id];}
if(!active)important=important.filter(x=>!['13','15','16','18'].includes(x));
const unlimited=$('surveyForm').elements.age_unlimited.checked;for(const name of ['age_older','age_younger']){const i=$('surveyForm').elements.namedItem(name);i.disabled=unlimited;if(unlimited)i.value='';}
const diet=[...document.querySelectorAll('input[name="26"]:checked')].some(i=>i.value==='其他');const extra=$('surveyForm').elements.diet_other;extra.parentElement.hidden=!diet;extra.disabled=!diet;if(!diet)extra.value='';
document.querySelectorAll('.star').forEach(b=>{const yes=important.includes(b.dataset.group);b.setAttribute('aria-pressed',String(yes));b.textContent=yes?'★ 已设重要':'☆ 设为重要';});$('stars').textContent='重要 '+important.length+' / 5';}
function show(n){section=n;sync();[...$('sections').children].forEach((b,i)=>b.setAttribute('aria-current',String(i===n)));$('previous').hidden=n===0;$('next').hidden=n===schema.sections.length-1;$('save').hidden=false;$('step').textContent=(n+1)+' / 5 · '+schema.sections[n];surveyMetrics.reportStep(n);}
async function load(){try{const r=await fetch('/api/account/weekly-survey',{headers:{Authorization:'Bearer '+token}});const d=await r.json();if(d.code!==200)throw Error(d.msg||'加载失败');answers=d.survey?.answers||d.prefill||{};important=(d.survey?.important||[]).filter(x=>!['15','16'].includes(x));delete answers['15'];delete answers['16'];serverState={answers:structuredClone(answers),important:[...important]};const draft=readDraft();if(draft){answers=draft.answers||{};important=(draft.important||[]).filter(x=>!['15','16'].includes(x));delete answers['15'];delete answers['16'];}fill();show(0);$('surveyForm').hidden=false;$('retry').hidden=true;$('message').textContent=d.survey?'已载入保存的问卷，可以继续修改。':(Object.keys(d.prefill||{}).length?'已带入你在其他配对中填写的基本资料，可直接修改。':'请按真实想法填写。');if(draft){showDraftBanner();dirty=true;$('message').textContent='已恢复上次填写进度，记得保存。';}else dirty=false;}catch(e){$('message').textContent=e.message;$('retry').hidden=false;}}
$('previous').onclick=()=>{show(section-1);window.scrollTo(0,0);};$('next').onclick=()=>{show(section+1);window.scrollTo(0,0);};$('retry').onclick=()=>location.reload();
$('surveyForm').onsubmit=async e=>{e.preventDefault();if(saving)return;let clean;try{sync();clean=WeeklyValidation.validate({answers:read(),important});}catch(e){$('message').textContent=e.message;const id=e.fields?.find(f=>f.id)?.id,q=schema.questions.find(q=>q.id===id);if(q){show(q.section);const box=$('q'+id);box.scrollIntoView({behavior:'smooth',block:'center'});box.querySelector('input,select,textarea')?.focus();}return;}
if(clean.uniform&&!confirm('你在 90% 以上的 1–7 分题中选择了同一个数字。请确认答案是否反映真实想法，点击确定继续保存。'))return;
saving=true;$('save').disabled=true;try{await surveyMetrics.start();const r=await fetch('/api/account/weekly-survey',{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(clean)});const d=await r.json();if(d.code!==200)throw Error(d.msg||'保存失败');answers=clean.answers;important=clean.important;dirty=false;clearDraft();$('message').textContent='问卷已保存，之后可从每周配对入口继续修改。';window.scrollTo(0,0);}catch(e){$('message').textContent=e.message;}finally{saving=false;$('save').disabled=false;}};
window.addEventListener('beforeunload',e=>{if(dirty){saveDraftNow();e.preventDefault();e.returnValue='';}});
(async()=>{let ok=false;try{const r=await fetch('/api/survey-schema/weekly');const d=await r.json();if(d.code===200&&d.schema&&Array.isArray(d.schema.questions)&&d.schema.questions.length){schema=d.schema;window.WeeklySchema=d.schema;ok=true;}}catch(e){}
if(!ok){try{await new Promise((res,rej)=>{const s=document.createElement('script');s.src='weekly-schema.js';s.onload=res;s.onerror=()=>rej(Error('seed load failed'));document.head.append(s);});}catch(e){}
if(window.WeeklySchema)schema=window.WeeklySchema;}
if(!schema){$('message').textContent='问卷加载失败，请检查网络后重试。';$('retry').hidden=false;return;}
render();if(token)load();})();
