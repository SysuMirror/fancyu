'use strict';
const catalog=require('./admin-business-catalog.json'),fs=require('fs'),path=require('path');
const secret=/(password|passwd|secret|token|api.?key|code_hash|authorization|cookie)/i;
const contact=/(email|wechat|phone|mobile|contact|微信|手机|电话|邮箱|^qq$)/i;
const freeText=/^(bio|self_description|ideal_description|ideal_friend|special_request|description|reason|admin_reply|feedback|interest_custom|note|custom|text|value|49)$/i;
function scrub(v,key='',depth=0){
 if(secret.test(key))return '[认证信息已排除]';
 if(contact.test(key))return v==null||v===''?v:'[联系方式已脱敏]';
 if(/avatar|photo/i.test(key))return v?'[图片请在用户详情查看]':v;
 if(freeText.test(key))return v?'[自由文本可能含联系方式，请在用户详情查看]':v;
 if(depth>10)return '[内容层级过深]';if(v instanceof Date)return v.toISOString();
 if(typeof v==='string'){try{if(/^[\[{]/.test(v))return scrub(JSON.parse(v),key,depth+1);}catch{}
 return v.replace(/sk-[a-z\d_-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|\$2[aby]\$\S+/gi,'[认证信息已排除]').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)|(?:微信|wechat|手机号|电话|QQ)\s*[:：号]?\s*[a-z\d_+@.-]+/gi,'[联系方式已脱敏]').slice(0,1200);}
 if(Array.isArray(v))return v.slice(0,100).map(x=>scrub(x,key,depth+1));
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!secret.test(k)).map(([k,x])=>[k,scrub(x,k,depth+1)]));return v;
}
const ident=s=>'`'+s+'`';
function cleanAuth(v){if(typeof v==='string'){try{if(/^[\[{]/.test(v))return cleanAuth(JSON.parse(v));}catch{}return v.replace(/(?:password|密码|token|secret|api.?key)\s*[:=：]\s*\S+/gi,'[认证信息已排除]');}if(Array.isArray(v))return v.map(cleanAuth);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!secret.test(k)).map(([k,x])=>[k,cleanAuth(x)]));return v;}
function compile(q){
 if(!q||!Object.hasOwn(catalog,q.table))throw Error('不允许查询该表');const cols=catalog[q.table];
 const check=k=>{if(!cols.includes(k)||secret.test(k))throw Error('不允许查询该字段');return ident(k);};
 const filters=q.filters??[];if(!Array.isArray(filters)||filters.length>8)throw Error('筛选条件过多');const values=[],where=[];
 for(const f of filters){const c=check(f.field);if(contact.test(f.field))throw Error('联系方式不能用于批量筛选');if(!['eq','gte','lte','contains'].includes(f.op))throw Error('不支持该条件');if(!['string','number','boolean'].includes(typeof f.value)||String(f.value).length>200)throw Error('条件值无效');where.push(c+({eq:' = ?',gte:' >= ?',lte:' <= ?',contains:' LIKE ?'}[f.op]));values.push(f.op==='contains'?'%'+f.value+'%':f.value);}
 const count=q.count===true;const selected=q.columns??cols;if(!Array.isArray(selected)||!selected.length)throw Error('字段无效');const fields=count?'COUNT(*) AS total':selected.map(check).join(',');
 const offset=q.offset??0;if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw Error('分页偏移无效');
 const order=q.order_by?check(q.order_by)+(q.desc===false?' ASC':' DESC'):check(cols[0])+' ASC';
 return {sql:'SELECT /*+ MAX_EXECUTION_TIME(3000) */ '+fields+' FROM '+ident(q.table)+(where.length?' WHERE '+where.join(' AND '):'')+(count?'':' ORDER BY '+order+' LIMIT 51 OFFSET '+offset),values,offset};
}
module.exports=function({getPool,auditPath=path.join(__dirname,'../.private/admin-ai-queries.jsonl')}){
 function audit(admin,meta){fs.appendFileSync(auditPath,JSON.stringify({at:new Date().toISOString(),admin:admin?.admin_account_id??admin?.username??'unknown',...meta})+'\n',{mode:0o600});}
 async function read(fn){const c=await(await getPool()).getConnection();try{await c.query('START TRANSACTION READ ONLY');const out=await fn(c);await c.commit();return out;}catch(e){await c.rollback();throw e;}finally{c.release();}}
 async function query(plan,admin){if(!Array.isArray(plan)||!plan.length||plan.length>4)throw Error('每次仅支持1至4项查询');const compiled=plan.map(compile);audit(admin,{action:'query',tables:plan.map(q=>q.table)});return read(async c=>{const results=[];for(let i=0;i<plan.length;i++){const q=plan[i],b=compiled[i];let sql=b.sql,values=b.values;if(q.username!==undefined){if(typeof q.username!=='string'||q.username.length>100)throw Error('账号名无效');const [a]=await c.execute('SELECT id FROM accounts WHERE BINARY username=?',[q.username]);if(a.length!==1){results.push({table:q.table,rows:[],note:'未找到唯一账号'});continue;}const owner=q.table==='accounts'?['id']:['account_id','a_id','b_id','low_id','high_id','owner_id','reporter_account_id'].filter(k=>catalog[q.table].includes(k));if(!owner.length)throw Error('此表不能按账号筛选');const clause='('+owner.map(k=>ident(k)+'=?').join(' OR ')+')';const split=sql.search(/ ORDER BY | LIMIT /);let base=split<0?sql:sql.slice(0,split),tail=split<0?'':sql.slice(split);sql=base+(base.includes(' WHERE ')?' AND ':' WHERE ')+clause+tail;values=[...values,...owner.map(()=>a[0].id)];}
 const [rows]=await c.execute(sql,values);results.push({table:q.table,rows:scrub(rows.slice(0,50)),truncated:rows.length>50,next_offset:rows.length>50?b.offset+50:null});}return results;});}
 async function contacts(question,admin){const m=question.trim().match(/^(?:查看|查询|显示)用户[「“"]([^」”"]{1,100})[」”"]的(?:完整)?联系方式[。？?]?$/);if(!m)return null;audit(admin,{action:'explicit_contact_lookup',username:m[1]});return read(async c=>{const [a]=await c.execute('SELECT id,username,email FROM accounts WHERE BINARY username=?',[m[1]]);if(a.length!==1)return '未找到该账号。';const id=a[0].id,out=[{来源:'账号邮箱',内容:a[0].email}];for(const t of ['users','friend_survey']){const [rows]=await c.execute('SELECT contact_email,contact_info FROM '+ident(t)+' WHERE account_id=? LIMIT 10',[id]);for(const x of rows)out.push({来源:t,...x});}const [d]=await c.execute('SELECT data FROM deep_surveys WHERE account_id=?',[id]);for(const x of d){const v=typeof x.data==='string'?JSON.parse(x.data):x.data;out.push({来源:'深度交友问卷',联系方式:v.contact_entries||[]});}for(const t of ['weekly_match_pairs','deep_pairs','friend_card_pairs','daily_pairs']){const low=t==='daily_pairs'?'low':'a',high=t==='daily_pairs'?'high':'b';const [rows]=await c.execute(`SELECT id, CASE WHEN ${low}_id=? THEN ${low}_wechat ELSE ${high}_wechat END AS wechat FROM ${ident(t)} WHERE ${low}_id=? OR ${high}_id=? ORDER BY id DESC LIMIT 50`,[id,id,id]);for(const x of rows)if(x.wechat)out.push({来源:t,配对编号:x.id,微信:x.wechat});}
 // Only the explicitly selected account's contact fields. This response never goes to the model.
 const clean=JSON.stringify(cleanAuth(out),null,2).replace(/sk-[a-z\d_-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|\$2[aby]\$\S+/gi,'[认证信息已排除]');return '用户 '+a[0].username+' 的联系方式（管理员明确查询，仅本次展示；配对来源最多最近50条）：\n```json\n'+clean+'\n```';});}
 return {catalog,query,contacts};
};
module.exports.compile=compile;module.exports.scrub=scrub;
