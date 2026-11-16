'use strict';
const fs=require('fs'),path=require('path');
const {weekKey,weekDeadline,validateCard,MAX}=require('./friends-rules');const {exchangeState}=require('./contact-exchange');
const parse=x=>typeof x==='string'?JSON.parse(x):x;
module.exports=function(app,{getPool,authMiddleware,daily,studentVerification,observe=async()=>{},invalidateWeekly=async()=>{},now=()=>new Date(),getBuddy=()=>null}){
 let ready;
 function ensureSchema(){if(!ready)ready=(async()=>{await daily.ensureSchema();const p=await getPool();for(const sql of fs.readFileSync(path.join(__dirname,'friends-schema.sql'),'utf8').split(';').map(s=>s.trim()).filter(Boolean))await p.query(sql);})().catch(e=>{ready=null;throw e;});return ready;}
 const fail=(status,msg)=>{throw Object.assign(Error(msg),{status});};
 const route=fn=>async(req,res)=>{res.setHeader('Cache-Control','no-store');try{await ensureSchema();const buddy=getBuddy();if(buddy)await buddy.ensureSchema();const result=await daily.transaction(async c=>{const time=now(),week=weekKey(time);if(buddy)await buddy.sync(c,time);await c.execute("UPDATE friend_card_pairs SET status='expired',a_wechat=NULL,b_wechat=NULL WHERE status='pending' AND week_key<>?",[week]);const result=await fn(req,c,week);if(buddy&&req.method!=='GET')await buddy.sync(c,time);return result;});res.json({code:200,...result});}catch(e){console.error('Friends:',e.status||e.code||e.name);res.status(e.status||503).json({code:e.status||503,msg:e.status?e.message:'交友服务暂不可用，请稍后重试'});}};
 async function eligible(c,id){const [tables]=await c.query("SHOW TABLES LIKE 'weekly_match_bans'");if(tables.length){const [b]=await c.execute('SELECT account_id FROM weekly_match_bans WHERE account_id=?',[id]);if(b.length)return false;}const [r]=await c.execute('SELECT a.id FROM accounts a JOIN verified_students v ON v.account_id=a.id AND v.email=a.email LEFT JOIN daily_settings s ON s.account_id=a.id WHERE a.id=? AND COALESCE(s.banned,0)=0',[id]);return !!r.length;}
 async function requireEligible(c,id){if(!await eligible(c,id))fail(403,'请先验证学生邮箱；受限制账号暂不能参与匹配');}
 async function own(c,id,cardId){if(!Number.isSafeInteger(Number(cardId))||Number(cardId)<1)fail(400,'搭子卡编号无效');const [r]=await c.execute('SELECT * FROM friend_cards WHERE id=? AND account_id=? AND deleted=0',[cardId,id]);if(!r.length)fail(404,'搭子卡不存在');return {...r[0],v:parse(r[0].data)};}
 async function cancel(c,cardId,all=false){await c.execute(`UPDATE friend_card_pairs SET status='cancelled',a_wechat=NULL,b_wechat=NULL WHERE (a_card=? OR b_card=?) AND status IN (${all?"'pending','connected'":"'pending'"})`,[cardId,cardId]);}
 async function pair(c,id,pairId){if(!Number.isSafeInteger(Number(pairId))||Number(pairId)<1)fail(400,'配对编号无效');const [r]=await c.execute('SELECT * FROM friend_card_pairs WHERE id=? AND (a_id=? OR b_id=?)',[pairId,id,id]);if(!r.length)fail(404,'配对不存在');return r[0];}
 async function visible(c,p){if(!['pending','connected'].includes(p.status)||!await eligible(c,p.a_id)||!await eligible(c,p.b_id)||await daily.blocked(c,p.a_id,p.b_id))return false;
  const [r]=await c.execute('SELECT * FROM friend_cards WHERE id IN (?,?) AND deleted=0',[p.a_card,p.b_card]);return r.length===2&&(p.status==='connected'||r.every(x=>x.enabled));}
 async function present(c,p,id){if(!await visible(c,p))return null;const mine=p.a_id===id,other=mine?p.b_id:p.a_id;
  const [r]=await c.execute('SELECT a.username FROM accounts a WHERE a.id=?',[other]);
  const [cards]=await c.execute('SELECT type,data FROM friend_cards WHERE id=?',[mine?p.b_card:p.a_card]);
  const v=parse(cards[0].data);const {gender,...publicValues}=v;const a=r[0];
  let feedback=null,ex={exchanged:false,wechat:null,mine:false,other:false};if(p.status==='connected'){const [f]=await c.execute('SELECT answer FROM buddy_match_feedback WHERE pair_id=? AND account_id=?',[p.id,id]);feedback=f[0]?.answer||null;ex=await exchangeState(c,{mode:'buddy',pairId:p.id,id,other,legacy:p.a_wechat&&p.b_wechat?(mine?p.b_wechat:p.a_wechat):null});}
  return {id:p.id,card_id:mine?p.a_card:p.b_card,week:p.week_key,status:p.status,agreed:!!(mine?p.a_agreed:p.b_agreed),expires_at:p.status==='pending'?weekDeadline(p.week_key):null,person:{id:other,name:a.username,avatar:await require('./avatar-url')(c,other)},card:{type:cards[0].type,v:publicValues},...(p.status==='connected'?{channel:ex.channel,value:ex.value,wechat:ex.wechat,wechat_requested:ex.mine,wechat_incoming:ex.other&&!ex.exchanged,feedback}:{})};
 }
 app.get('/account/friends',authMiddleware,route(async(req,c,week)=>{
  const id=req.account.account_id;const [rows]=await c.execute('SELECT * FROM friend_cards WHERE account_id=? AND deleted=0 ORDER BY slot',[id]);
  const [settings]=await c.execute('SELECT gender FROM friend_card_settings WHERE account_id=?',[id]);
  const [used]=await c.execute('SELECT pair_id FROM friend_account_weeks WHERE account_id=? AND week_key=?',[id,week]);
  const [ps]=await c.execute("SELECT * FROM friend_card_pairs WHERE (a_id=? OR b_id=?) AND status IN ('pending','connected') ORDER BY id DESC",[id,id]);
  const pairs=[];for(const p of ps){const x=await present(c,p,id);if(x)pairs.push(x);}
  const [blocks]=await c.execute('SELECT b.target_id,a.username FROM daily_blocks b JOIN accounts a ON a.id=b.target_id WHERE b.owner_id=?',[id]);
  return {...(getBuddy()?{schedule:await getBuddy().state(c,now(),id)}:{}),prefill:await require('./reuse-defaults').forAccount(c,id,'buddy'),week,quota_used:used.length>0,verified:await studentVerification.verified(c,id),eligible:await eligible(c,id),gender:settings[0]?.gender||'不透露',cards:rows.map(x=>({id:x.id,type:x.type,on:!!x.enabled,v:parse(x.data),used:used.length>0})),pairs,history:await require('./match-history')(c,id,'buddy'),blocks};
 }));
 app.put('/account/friends/settings',authMiddleware,route(async(req,c)=>{
  const gender=req.body?.gender;if(!['男生','女生','不透露'].includes(gender))fail(400,'请选择有效性别');
  const id=req.account.account_id;await c.execute('INSERT INTO friend_card_settings(account_id,gender) VALUES (?,?) ON DUPLICATE KEY UPDATE gender=VALUES(gender)',[id,gender]);
  await c.execute("UPDATE friend_card_pairs SET status='cancelled',a_wechat=NULL,b_wechat=NULL WHERE (a_id=? OR b_id=?) AND status='pending'",[id,id]);return {msg:'信息已保存，原待确认推荐已撤回，本周名额不重置'};
 }));
 async function save(req,c,create){
  const id=req.account.account_id;let input;try{input=validateCard(req.body);}catch(e){fail(400,e.message);}
  let cardId,on;
  if(create){const [rows]=await c.execute('SELECT id,slot,deleted FROM friend_cards WHERE account_id=? ORDER BY slot',[id]);
   if(rows.filter(x=>!x.deleted).length>=MAX)fail(400,'最多保存 6 张搭子卡');
   on=await eligible(c,id);const reusable=rows.find(x=>x.deleted);
   if(reusable){cardId=reusable.id;await c.execute('UPDATE friend_cards SET type=?,data=?,deleted=0,enabled=? WHERE id=?',[input.type,JSON.stringify(input.v),on?1:0,cardId]);}
   else{const slot=Array.from({length:MAX},(_,i)=>i+1).find(n=>!rows.some(x=>x.slot===n));const [r]=await c.execute('INSERT INTO friend_cards(account_id,slot,type,data,enabled) VALUES (?,?,?,?,?)',[id,slot,input.type,JSON.stringify(input.v),on?1:0]);cardId=r.insertId;}
  }else{const old=await own(c,id,req.params.id);if(old.type!==input.type)fail(400,'编辑不能更换卡片类别');cardId=old.id;on=!!old.enabled&&await eligible(c,id);await cancel(c,cardId);await c.execute('UPDATE friend_cards SET data=?,enabled=? WHERE id=?',[JSON.stringify(input.v),on?1:0,cardId]);}
  return {id:cardId,msg:create?(on?'搭子卡已保存并开启匹配':'搭子卡已保存，验证学生邮箱后可开启匹配'):'修改已保存，待确认推荐已撤回，本周名额不重置'};
 }
 app.post('/account/friends/cards',authMiddleware,route((req,c)=>save(req,c,true)));
 app.put('/account/friends/cards/:id',authMiddleware,route((req,c)=>save(req,c,false)));
 app.post('/account/friends/cards/:id/toggle',authMiddleware,route(async(req,c)=>{
  const card=await own(c,req.account.account_id,req.params.id),on=req.body?.enabled;if(typeof on!=='boolean')fail(400,'开关必须为布尔值');if(on)await requireEligible(c,req.account.account_id);else await cancel(c,card.id);
  await c.execute('UPDATE friend_cards SET enabled=? WHERE id=?',[on?1:0,card.id]);return {msg:on?'已开启这张搭子卡':'已暂停，待确认推荐已撤回，已有连接保留'};
 }));
 app.delete('/account/friends/cards/:id',authMiddleware,route(async(req,c)=>{const card=await own(c,req.account.account_id,req.params.id);await cancel(c,card.id,true);await c.execute('UPDATE friend_cards SET deleted=1,enabled=0 WHERE id=?',[card.id]);return {msg:'已删除搭子卡并撤回关联配对，本周名额不重置'};}));
 app.post('/account/friends/cards/:id/recommend',authMiddleware,route(async()=>{fail(410,'已改为每周统一配对，无需点击推荐；开启搭子卡即可参与');}));
 app.post('/account/friends/pairs/:id/respond',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id;await requireEligible(c,id);const p=await pair(c,id,req.params.id);if(!await visible(c,p))fail(409,'这段推荐已结束或不可访问');if(p.status==='connected')return {msg:'你们已经建立连接'};
  if(req.body?.choice==='skip'){await c.execute("UPDATE friend_card_pairs SET status='skipped',a_wechat=NULL,b_wechat=NULL WHERE id=?",[p.id]);return {msg:'已跳过，本周账号不再补配'};}
  const {choice}=req.body||{};if(choice!=='like')fail(400,'请选择是否愿意认识');
  const side=p.a_id===id?'a':'b',other=side==='a'?'b':'a';await c.execute(`UPDATE friend_card_pairs SET ${side}_agreed=1,${side}_wechat=NULL,status=? WHERE id=?`,[p[other+'_agreed']?'connected':'pending',p.id]);return {msg:p[other+'_agreed']?'双方都愿意认识，可以开始站内聊天':'已记录，等待双方同意后开始站内聊天'};
 }));
 app.post('/account/friends/pairs/:id/close',authMiddleware,route(async(req,c)=>{const p=await pair(c,req.account.account_id,req.params.id);await c.execute("UPDATE friend_card_pairs SET status='closed',a_wechat=NULL,b_wechat=NULL WHERE id=?",[p.id]);return {msg:'已结束连接，停止展示联系方式'};}));
 app.post('/account/friends/pairs/:id/block',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id,p=await pair(c,id,req.params.id),other=p.a_id===id?p.b_id:p.a_id;
  await c.execute('INSERT IGNORE INTO daily_blocks(owner_id,target_id,created_at) VALUES (?,?,UTC_TIMESTAMP())',[id,other]);await invalidateWeekly(c,id,other);
  await c.execute("UPDATE friend_card_pairs SET status='blocked',a_wechat=NULL,b_wechat=NULL WHERE (a_id=? AND b_id=?) OR (a_id=? AND b_id=?)",[id,other,other,id]);
  await c.execute("UPDATE daily_pairs SET status='blocked',low_wechat=NULL,high_wechat=NULL WHERE low_id=? AND high_id=? AND status IN ('pending','connected')",[Math.min(id,other),Math.max(id,other)]);
  await c.execute('DELETE FROM match_history WHERE (account_id=? AND match_account_id=?) OR (account_id=? AND match_account_id=?)',[id,other,other,id]);return {msg:'已屏蔽，停止双方资料和联系方式访问'};
 }));
 app.delete('/account/friends/blocks/:id',authMiddleware,route(async(req,c)=>{const other=Number(req.params.id);if(!Number.isSafeInteger(other)||other<1)fail(400,'账号编号无效');await c.execute("UPDATE friend_card_pairs SET status='blocked',a_wechat=NULL,b_wechat=NULL WHERE ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?)) AND status IN ('pending','connected')",[req.account.account_id,other,other,req.account.account_id]);await invalidateWeekly(c,req.account.account_id,other);await c.execute('DELETE FROM daily_blocks WHERE owner_id=? AND target_id=?',[req.account.account_id,other]);return {msg:'已解除屏蔽，原配对不会恢复'};}));
 app.post('/account/friends/pairs/:id/report',authMiddleware,route(async(req,c)=>{const p=await pair(c,req.account.account_id,req.params.id),reason=req.body?.reason;if(typeof reason!=='string'||reason.trim().length<2||reason.length>500)fail(400,'请输入 2–500 字举报说明');await c.execute("INSERT INTO complaints(reporter_account_id,target_type,target_id,reason,description,status) VALUES (?,'user',?,?,?,'pending')",[req.account.account_id,String(p.a_id===req.account.account_id?p.b_id:p.a_id),'快速交友举报',reason.trim()]);return {msg:'举报已提交'};}));
 app.post('/account/friends/pairs/:id/feedback',authMiddleware,route(async(req,c)=>{const p=await pair(c,req.account.account_id,req.params.id);if(p.status!=='connected')fail(400,'建立连接后可填写反馈');const answer=req.body?.answer;if(!['未联系','已联系','已见面','不愿回答'].includes(answer))fail(400,'请选择反馈');await c.execute('INSERT INTO buddy_match_feedback(pair_id,account_id,answer,updated_at) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE answer=VALUES(answer),updated_at=VALUES(updated_at)',[p.id,req.account.account_id,answer,new Date().toISOString().slice(0,19).replace('T',' ')]);return {msg:'感谢反馈，不会向对方展示'};}));
 return {ensureSchema};
};
