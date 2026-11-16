'use strict';
const fs=require('fs'),path=require('path');
const TABLES={love:'weekly_match_pairs',deep:'deep_pairs',buddy:'friend_card_pairs'};
const fail=(status,msg)=>{throw Object.assign(Error(msg),{status});};
const positive=x=>{const n=Number(x);if(!Number.isSafeInteger(n)||n<1)fail(400,'编号无效');return n;};
const json=x=>typeof x==='string'?JSON.parse(x):x;
const RECALL_MS=2*60*1000; // 发送后 2 分钟内可撤回
module.exports=function(app,{getPool,authMiddleware,adminAuthMiddleware,daily,verifyToken,uploads,notify:notifier,now=()=>new Date()}){
 let ready;const sockets=new Map();
 function ensureSchema(){if(!ready)ready=(async()=>{const p=await getPool();for(const sql of fs.readFileSync(path.join(__dirname,'chat-schema.sql'),'utf8').split(';').map(x=>x.trim()).filter(Boolean))await p.query(sql);
  // 线上表已存在：把「只换微信」扩展为「可选渠道 + 内容」，旧行默认微信。
  try{await p.query("ALTER TABLE user_chat_exchange ADD COLUMN channel VARCHAR(12) NOT NULL DEFAULT '微信'");}catch(e){if(!/Duplicate|already/i.test(e.message))throw e;}
  // 联系方式从「微信号」扩为「渠道 + 内容」：内容最长 100 字（非微信渠道），线上列需加宽。
  try{await p.query("ALTER TABLE user_chat_exchange MODIFY COLUMN wechat VARCHAR(100) NOT NULL");}catch(e){if(!/Duplicate|already/i.test(e.message))throw e;}
  // 图片消息 + 撤回（软删）：线上表已存在，启动时补列。
  for(const ddl of ["ALTER TABLE user_chat_messages ADD COLUMN image_id BIGINT UNSIGNED NULL","ALTER TABLE user_chat_messages ADD COLUMN deleted_at DATETIME NULL"]){try{await p.query(ddl);}catch(e){if(!/Duplicate|already/i.test(e.message))throw e;}}
  const c=await p.getConnection();try{await c.beginTransaction();const [marker]=await c.execute('INSERT IGNORE INTO user_chat_meta(id) VALUES (1)');if(marker.affectedRows){for(const [mode,table]of Object.entries(TABLES)){const condition=mode==='love'?'connected_at IS NOT NULL':'a_agreed=1 AND b_agreed=1';await c.query(`INSERT IGNORE INTO user_chat_contact_events(mode,pair_id,exchanged_at) SELECT '${mode}',id,created_at FROM ${table} WHERE ${condition}`);}}await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}})().catch(e=>{ready=null;throw e;});return ready;}
 async function access(c,id,mode,pairId){
  if(!Object.hasOwn(TABLES,mode))fail(400,'会话类型无效');pairId=positive(pairId);
  const [rows]=await c.execute(`SELECT * FROM ${TABLES[mode]} WHERE id=? AND (a_id=? OR b_id=?)`,[pairId,id,id]);
  if(!rows.length)fail(404,'会话不存在');const p=rows[0];
  if(p.status!=='connected')fail(409,'会话已结束或双方尚未同意');
  if(await daily.blocked(c,p.a_id,p.b_id))fail(403,'该会话不可访问');
  const [members]=await c.execute('SELECT a.id,a.username FROM accounts a JOIN verified_students v ON v.account_id=a.id AND v.email=a.email LEFT JOIN daily_settings d ON d.account_id=a.id LEFT JOIN weekly_match_bans b ON b.account_id=a.id WHERE a.id IN (?,?) AND COALESCE(d.banned,0)=0 AND b.account_id IS NULL',[p.a_id,p.b_id]);
  if(members.length!==2)fail(403,'当前账号状态不允许聊天');
  if(mode==='buddy'){const [[{n}]]=await c.execute('SELECT COUNT(*) n FROM friend_cards WHERE id IN (?,?) AND deleted=0',[p.a_card,p.b_card]);if(Number(n)!==2)fail(409,'搭子卡已删除，会话已结束');}
  const other=p.a_id===id?p.b_id:p.a_id;return {p,other,name:members.find(x=>x.id===other).username};
 }
 function notify(ids){for(const id of ids)for(const ws of sockets.get(id)||[])if(ws.readyState===1&&ws.bufferedAmount<8192)ws.send('{"type":"refresh"}');}
 const route=fn=>async(req,res)=>{res.setHeader('Cache-Control','no-store');try{await ensureSchema();const result=await daily.transaction(c=>fn(req,c));const {notify:recipients,...data}=result;res.json({code:200,...data});if(recipients)notify(recipients);}catch(e){console.error('Chat:',e.status||e.code||e.name);res.status(e.status||503).json({code:e.status||503,msg:e.status?e.message:'聊天暂时不可用，请稍后重试'});}};
 async function exchange(c,id,mode,pairId,p){
  const [rows]=await c.execute('SELECT account_id,wechat,channel FROM user_chat_exchange WHERE mode=? AND pair_id=?',[mode,pairId]);
  const mine=rows.find(x=>x.account_id===id),other=rows.find(x=>x.account_id===(p.a_id===id?p.b_id:p.a_id));
  const legacy=p.a_wechat&&p.b_wechat;
  const peer=legacy?{channel:'微信',value:(p.a_id===id?p.b_wechat:p.a_wechat)}:(mine&&other?{channel:other.channel||'微信',value:other.wechat}:null);
  return {requested:!!mine,incoming:!!other,exchanged:!!peer,mine_channel:mine?(mine.channel||'微信'):null,
   channel:peer?peer.channel:null,value:peer?peer.value:null,wechat:peer&&peer.channel==='微信'?peer.value:null};
 }
 // 会话内对方资料卡：头像 + 昵称 + 各线公开资料（只取 publicData 允许展示的字段）。
 async function peerCard(c,mode,other,p){
  const [acc]=await c.execute('SELECT username FROM accounts WHERE id=?',[other]);
  if(!acc.length)return null;
  const card={id:other,name:acc[0].username,avatar:await require('./avatar-url')(c,other)};
  try{
   if(mode==='love'){
    const [rows]=await c.execute('SELECT snapshot FROM weekly_match_enrollments WHERE account_id=? AND batch_key=?',[other,p.batch_key]);
    if(rows.length){const a=json(rows[0].snapshot).answers||{};card.campus=a['7']||'';card.college=a['9']||'';card.hometown=a['11']||'';card.interests=a['47']||'';}
   }else if(mode==='deep'){
    const [rows]=await c.execute('SELECT s.data FROM deep_entries e JOIN deep_surveys s ON s.account_id=e.account_id WHERE e.batch_key=? AND e.account_id=?',[p.week_key,other]);
    if(rows.length){const pub=require('./deep-rules').publicData(json(rows[0].data));card.bio=pub.bio||'';card.campus=pub.own_campus||'';card.college=pub.major||'';card.hometown=pub.hometown||'';}
   }else{
    const [rows]=await c.execute('SELECT type,data FROM friend_cards WHERE id=?',[p.a_id===other?p.a_card:p.b_card]);
    if(rows.length){const v=json(rows[0].data)||{};card.type=rows[0].type;card.bio=v.intro||v.description||'';card.tags=Array.isArray(v.tags)?v.tags:[];}
   }
  }catch(e){/* 资料源缺失时只保留昵称与头像 */}
  return card;
 }
 app.get('/account/chat',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id,rooms=[];
  const [hiddenRows]=await c.execute('SELECT mode,pair_id,hidden_at FROM user_chat_hidden WHERE account_id=?',[id]);
  const hidden=new Map(hiddenRows.map(r=>[r.mode+':'+r.pair_id,new Date(r.hidden_at).getTime()]));
  for(const [mode,table]of Object.entries(TABLES)){const [rows]=await c.execute(`SELECT id FROM ${table} WHERE (a_id=? OR b_id=?) AND status='connected' ORDER BY id DESC LIMIT 100`,[id,id]);
   for(const row of rows){let a;try{a=await access(c,id,mode,row.id);}catch(e){if(e.status)continue;throw e;}
    const [[counts]]=await c.execute('SELECT COUNT(*) unread,MAX(id) last_id FROM user_chat_messages WHERE mode=? AND pair_id=? AND sender_id<>? AND id>COALESCE((SELECT last_read FROM user_chat_reads WHERE mode=? AND pair_id=? AND account_id=?),0)',[mode,row.id,id,mode,row.id,id]);
    const [last]=await c.execute('SELECT id,body,image_id,deleted_at,created_at FROM user_chat_messages WHERE mode=? AND pair_id=? ORDER BY id DESC LIMIT 1',[mode,row.id]);
    const stamp=last[0]?.created_at?new Date(last[0].created_at).getTime():0;
    const hiddenAt=hidden.get(mode+':'+row.id);
    if(hiddenAt&&hiddenAt>=stamp)continue; // 隐藏后没有新消息 → 不出现
    rooms.push({mode,pair_id:row.id,name:a.name,unread:Number(counts.unread),last_id:last[0]?.id||0,last_preview:last[0]?(last[0].deleted_at?'[已撤回]':String(last[0].body).trim()||(last[0].image_id?'[图片]':'')):'',updated_at:last[0]?.created_at||null});
   }
  }rooms.sort((a,b)=>b.last_id-a.last_id);const history=require('./match-history');const archived=[];for(const mode of Object.keys(TABLES))for(const h of await history(c,id,mode,30))archived.push(h);archived.sort((a,b)=>String(b.ended_at||'').localeCompare(String(a.ended_at||'')));return {rooms,unread:rooms.reduce((n,r)=>n+r.unread,0),archived};
 }));
 // 聊天内搜索：只搜「我参与且仍连接」的会话。三线各 UNION 一段，靠 JOIN 配对表把可见性收在 SQL 里。
 app.get('/account/chat/search',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id,q=String(req.query.q||'').trim();
  if(q.length<1||q.length>40)fail(400,'请输入 1–40 字的搜索词');
  // LIKE 里的 % 和 _ 必须转义，否则搜 "50%" 会变成通配
  const like='%'+q.replace(/[\\%_]/g,ch=>'\\'+ch)+'%';
  const parts=[],args=[];
  for(const [mode,table]of Object.entries(TABLES)){
   parts.push(`SELECT m.mode,m.pair_id,m.id,m.sender_id,m.body,LEFT(m.body,120) AS snippet,m.created_at FROM user_chat_messages m JOIN ${table} p ON p.id=m.pair_id AND (p.a_id=? OR p.b_id=?) WHERE m.mode=? AND m.deleted_at IS NULL AND m.image_id IS NULL AND p.status='connected' AND m.body LIKE ?`);
   args.push(id,id,mode,like);
  }
  const [rows]=await c.execute(parts.join(' UNION ALL ')+' ORDER BY created_at DESC LIMIT 50',args);
  const names=new Map();const results=[];
  for(const r of rows){
   const key=r.mode+':'+r.pair_id;
   if(!names.has(key)){let n=null;try{const a=await access(c,id,r.mode,r.pair_id);n=a.name;}catch(e){names.set(key,null);continue;}names.set(key,n);}
   const name=names.get(key);if(!name)continue;
   results.push({mode:r.mode,pair_id:Number(r.pair_id),message_id:Number(r.id),name,snippet:String(r.snippet||''),created_at:r.created_at,mine:r.sender_id===id});
  }
  return {q,results,count:results.length};
 }));
 app.get('/account/chat/:mode/:id',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id,mode=req.params.mode,pairId=positive(req.params.id),a=await access(c,id,mode,pairId);
  const after=req.query.after===undefined?null:Math.max(0,Number(req.query.after)),before=req.query.before===undefined?null:positive(req.query.before);
  if(after!==null&&!Number.isSafeInteger(after)||after!==null&&before!==null)fail(400,'分页参数无效');
  const [rows]=await c.execute(`SELECT id,sender_id,client_id,body,image_id,deleted_at,created_at FROM user_chat_messages WHERE mode=? AND pair_id=? ${after!==null?'AND id>?':before!==null?'AND id<?':''} ORDER BY id ${after!==null?'ASC':'DESC'} LIMIT 51`,[mode,pairId,...(after!==null?[after]:before!==null?[before]:[])]);
  const [reads]=await c.execute('SELECT last_read FROM user_chat_reads WHERE mode=? AND pair_id=? AND account_id=?',[mode,pairId,a.other]);
  const otherLastRead=reads.length?Number(reads[0].last_read):0;
  const more=rows.length>50,messages=rows.slice(0,50);if(after===null)messages.reverse();const peer=await peerCard(c,mode,a.other,a.p);return {name:a.name,peer,messages:messages.map(m=>({id:m.id,client_id:m.client_id,created_at:m.created_at,body:m.deleted_at?'':m.body,image:m.deleted_at||!m.image_id?null:'/api/account/uploads/'+m.image_id,recalled:!!m.deleted_at,mine:m.sender_id===id})),more,other_last_read:otherLastRead,exchange:await exchange(c,id,mode,pairId,a.p)};
 }));
 app.post('/account/chat/:mode/:id/messages',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id,mode=req.params.mode,pairId=positive(req.params.id),a=await access(c,id,mode,pairId),{body,client_id,image_id}=req.body||{};
  if(typeof client_id!=='string'||!/^[-a-zA-Z0-9_]{16,64}$/.test(client_id))fail(400,'消息编号无效');
  const text=typeof body==='string'?body.trim():'';
  let image=null;
  if(image_id!==undefined&&image_id!==null&&image_id!==''){if(!uploads)fail(503,'图片功能暂未开放');image=positive(image_id);if(!await uploads.own(c,id,image))fail(403,'图片不可用，请重新上传');}
  if(!text&&!image)fail(400,'消息不能为空');if(text.length>2000)fail(400,'消息需为1–2000字');
  const [existing]=await c.execute('SELECT id,body,image_id FROM user_chat_messages WHERE mode=? AND pair_id=? AND sender_id=? AND client_id=?',[mode,pairId,id,client_id]);
  if(existing.length){const same=String(existing[0].body)===text&&(image?Number(existing[0].image_id)===image:!existing[0].image_id);if(!same)fail(409,'重试内容已变化，请重新发送');return {id:existing[0].id,duplicate:true};}
  const [[{n}]]=await c.execute('SELECT COUNT(*) n FROM user_chat_messages WHERE sender_id=? AND created_at>DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE)',[id]);if(Number(n)>=30)fail(429,'发送太快，请稍后再试');
  const [r]=await c.execute('INSERT INTO user_chat_messages(mode,pair_id,sender_id,client_id,body,image_id) VALUES (?,?,?,?,?,?)',[mode,pairId,id,client_id,text,image]);
  if(notifier){const [[me]]=await c.execute('SELECT username FROM accounts WHERE id=?',[id]);
   // 同一会话 5 分钟内的多条消息合并成一条通知（用户要求：不刷屏）
   await notifier.record(c,{account_id:a.other,kind:'chat',title:(me?.username||'对方')+' 发来新消息',body:text?text.slice(0,60):'[图片]',link:'/chat?mode='+mode+'&pair='+pairId,dedup_key:'chat:'+mode+':'+pairId+':'+notifier.chatBucket(now())});}
  return {id:r.insertId,notify:[id,a.other]};
 }));
 app.post('/account/chat/:mode/:id/messages/:messageId/recall',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id,mode=req.params.mode,pairId=positive(req.params.id),a=await access(c,id,mode,pairId),messageId=positive(req.params.messageId);
  const [rows]=await c.execute('SELECT id,sender_id,deleted_at,created_at FROM user_chat_messages WHERE id=? AND mode=? AND pair_id=?',[messageId,mode,pairId]);
  if(!rows.length)fail(404,'消息不存在');const m=rows[0];
  if(m.sender_id!==id)fail(403,'只能撤回自己发送的消息');
  if(m.deleted_at)return {msg:'消息已撤回'};
  if(now().getTime()-new Date(m.created_at).getTime()>RECALL_MS)fail(409,'超过 2 分钟的消息无法撤回');
  await c.execute('UPDATE user_chat_messages SET deleted_at=UTC_TIMESTAMP() WHERE id=? AND deleted_at IS NULL',[messageId]);return {msg:'已撤回',notify:[id,a.other]};
 }));
 app.delete('/account/chat/:mode/:id',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id,mode=req.params.mode,pairId=positive(req.params.id),a=await access(c,id,mode,pairId);
  await c.execute('INSERT INTO user_chat_hidden(mode,pair_id,account_id,hidden_at) VALUES (?,?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE hidden_at=UTC_TIMESTAMP()',[mode,pairId,id]);
  return {msg:'已从你的列表移除；对方发来新消息后会重新出现'};
 }));
 app.post('/account/chat/:mode/:id/read',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id,mode=req.params.mode,pairId=positive(req.params.id),a=await access(c,id,mode,pairId);const last=positive(req.body?.last_id);
  const [m]=await c.execute('SELECT id FROM user_chat_messages WHERE mode=? AND pair_id=? AND id=?',[mode,pairId,last]);if(!m.length)fail(400,'已读位置无效');
  await c.execute('INSERT INTO user_chat_reads(mode,pair_id,account_id,last_read) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE last_read=GREATEST(last_read,VALUES(last_read))',[mode,pairId,id,last]);return {notify:[id,a.other]};
 }));
 app.post('/account/chat/:mode/:id/exchange',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id,mode=req.params.mode,pairId=positive(req.params.id),a=await access(c,id,mode,pairId);
  const {consent}=req.body||{},wechat=req.body?.wechat,value=req.body?.value;
  const methods=(()=>{try{return require('./survey-schema').current('deep').contacts.methods;}catch(e){return ['微信','QQ','小红书','邮箱','其他'];}})();
  const channel=typeof req.body?.channel==='string'&&req.body.channel?req.body.channel:(wechat?'微信':'');
  if(consent!==true||!methods.includes(channel))fail(400,'请选择联系方式并同意双方申请后互相展示');
  const text=typeof value==='string'?value.trim():(wechat||'').trim();
  if(!text)fail(400,'请填写联系方式');
  if(channel==='微信'&&!/^[A-Za-z0-9][A-Za-z0-9_-]{5,31}$/.test(text))fail(400,'请填写6–32位有效微信号，并同意双方申请后互相展示');
  if(channel!=='微信'&&(text.length>100||[...text].some(ch=>ch.codePointAt(0)<32)))fail(400,'联系方式需为 1–100 字，且不含换行等控制字符');
  const state=await exchange(c,id,mode,pairId,a.p);if(state.exchanged)return {exchange:state,msg:'你们已交换联系方式'};
  await c.execute('INSERT INTO user_chat_exchange(mode,pair_id,account_id,wechat,channel) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE wechat=VALUES(wechat),channel=VALUES(channel),consented_at=UTC_TIMESTAMP()',[mode,pairId,id,text,channel]);
  const updated=await exchange(c,id,mode,pairId,a.p);if(updated.exchanged)await c.execute('INSERT IGNORE INTO user_chat_contact_events(mode,pair_id) VALUES (?,?)',[mode,pairId]);
  if(notifier){const link='/chat?mode='+mode+'&pair='+pairId;
   if(updated.exchanged)for(const who of [id,a.other])await notifier.record(c,{account_id:who,kind:'exchange',title:'联系方式已互换',body:'双方都同意交换联系方式了，可在会话内查看。',link,dedup_key:'exchange:done:'+mode+':'+pairId+':'+who});
   else await notifier.record(c,{account_id:a.other,kind:'exchange',title:'对方申请交换联系方式',body:'自愿选择是否接受；双方都同意后才会互相展示。',link,dedup_key:'exchange:ask:'+mode+':'+pairId+':'+id});}
  return {exchange:updated,msg:'申请已记录，双方同意后互相展示',notify:[id,a.other]};
 }));
 app.delete('/account/chat/:mode/:id/exchange',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id,mode=req.params.mode,pairId=positive(req.params.id),a=await access(c,id,mode,pairId);
  if((await exchange(c,id,mode,pairId,a.p)).exchanged)fail(409,'已交换的信息无法撤回；可结束连接停止展示');
  await c.execute('DELETE FROM user_chat_exchange WHERE mode=? AND pair_id=? AND account_id=?',[mode,pairId,id]);return {msg:'申请已撤回',notify:[id,a.other]};
 }));
 app.post('/account/chat/:mode/:id/report',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id,mode=req.params.mode,pairId=positive(req.params.id),a=await access(c,id,mode,pairId),messageId=positive(req.body?.message_id),reason=req.body?.reason;
  if(typeof reason!=='string'||reason.trim().length<2||reason.length>500)fail(400,'举报说明需为2–500字');
  const [rows]=await c.execute('SELECT id FROM user_chat_messages WHERE id=? AND mode=? AND pair_id=? AND sender_id=?',[messageId,mode,pairId,a.other]);if(!rows.length)fail(404,'举报消息不存在');
  const [[{n}]]=await c.execute('SELECT COUNT(*) n FROM user_chat_reports WHERE reporter_id=? AND message_id=?',[id,messageId]);if(n)return {msg:'该消息已举报'};
  const [r]=await c.execute("INSERT INTO complaints(reporter_account_id,target_type,target_id,reason,description,status) VALUES (?,'user',?,?,?,'pending')",[id,String(a.other),'站内聊天举报',reason.trim()]);
  await c.execute('INSERT INTO user_chat_reports(complaint_id,mode,pair_id,message_id,reporter_id) VALUES (?,?,?,?,?)',[r.insertId,mode,pairId,messageId,id]);return {msg:'举报已提交，管理员可核查对应消息'};
 }));
 app.get('/admin/chat-reports',adminAuthMiddleware,route(async(req,c)=>{const [reports]=await c.query('SELECT r.complaint_id,r.mode,r.message_id,c.description,c.status,c.created_at FROM user_chat_reports r JOIN complaints c ON c.id=r.complaint_id ORDER BY r.complaint_id DESC LIMIT 100');return {reports};}));
 app.get('/admin/chat-reports/:id',adminAuthMiddleware,route(async(req,c)=>{
  const [r]=await c.execute('SELECT mode,pair_id,message_id FROM user_chat_reports WHERE complaint_id=?',[positive(req.params.id)]);if(!r.length)fail(404,'没有该举报关联的聊天证据');const report=r[0];
  const [rows]=await c.execute('SELECT id,sender_id,body,created_at FROM user_chat_messages WHERE mode=? AND pair_id=? AND id<=? ORDER BY id DESC LIMIT 11',[report.mode,report.pair_id,report.message_id]);
  fs.mkdirSync(path.join(__dirname,'../.private'),{recursive:true,mode:0o700});fs.appendFileSync(path.join(__dirname,'../.private/chat-review.jsonl'),JSON.stringify({at:now().toISOString(),admin:req.admin?.admin_account_id??req.admin?.username,complaint:positive(req.params.id)})+'\n',{mode:0o600});return {message_id:report.message_id,messages:rows.reverse()};
 }));
 /* ---------- 在线 / 正在输入（房间 = 一次会话） ---------- */
 // 进房间要过一次 access()（归属 + 连接状态 + 双方未被封禁），结果在 socket 上缓存 60s：
 // 打字事件频率很高，不能每个按键都打库。
 const rooms=new Map(); // key -> Set<ws>
 function roomTell(key,fromAccount,payload){
  const s=JSON.stringify(payload);
  for(const ws of rooms.get(key)||[]){if(ws.identity.account_id===fromAccount)continue;if(ws.readyState===1&&ws.bufferedAmount<8192)ws.send(s);}
 }
 async function validateRoom(ws,mode,pairId){
  const key=mode+':'+pairId,nowMs=Date.now(),hit=ws.rooms.get(key);
  if(hit&&hit>nowMs)return key;
  const c=await(await getPool()).getConnection();
  try{await access(c,ws.identity.account_id,mode,pairId);}finally{c.release();}
  ws.rooms.set(key,nowMs+60000);
  return key;
 }
 async function roomMessage(ws,msg){
  if(!Object.hasOwn(TABLES,msg.mode))return;
  const pairId=Number(msg.pair_id);
  if(!Number.isSafeInteger(pairId)||pairId<1)return;
  let key;try{key=await validateRoom(ws,msg.mode,pairId);}catch(e){return;} // 不可访问的房间静默忽略
  if(msg.type==='typing'){roomTell(key,ws.identity.account_id,{type:'typing',key});return;}
  const leave=msg.online===false;
  let set=rooms.get(key);
  if(!set){if(leave)return;set=new Set();rooms.set(key,set);} // 空房间里「离线」无事可做
  const before=set.has(ws);
  if(before===!leave)return;                       // 状态没变就不广播
  if(leave)set.delete(ws);else set.add(ws);
  if(!set.size)rooms.delete(key);
  roomTell(key,ws.identity.account_id,{type:'presence',key,online:!leave});
  // 新加入者拿一次快照：否则对方「早就开着」时我看不到他在线
  if(!leave&&ws.readyState===1){try{ws.send(JSON.stringify({type:'presence-self',key,peer_online:set.size>1}));}catch(e){}}
 }
 function leaveAllRooms(ws){
  for(const key of [...ws.rooms.keys()]){const set=rooms.get(key);if(!set)continue;
   if(set.delete(ws))roomTell(key,ws.identity.account_id,{type:'presence',key,online:false});
   if(!set.size)rooms.delete(key);}
 }
 function attach(server){const {WebSocketServer}=require('ws'),wss=new WebSocketServer({noServer:true,maxPayload:8192,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{if(req.url!=='/api/chat/socket')return socket.destroy();const origin=req.headers.origin;try{if(origin&&new URL(origin).host!==req.headers.host)return socket.destroy();}catch{return socket.destroy();}if(wss.clients.size>=500)return socket.destroy();wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));});
  wss.on('connection',ws=>{let identity=null,busy=false;ws.rooms=new Map();const timeout=setTimeout(()=>ws.close(1008,'请登录'),5000);ws.on('error',()=>{});
  ws.on('message',async raw=>{if(busy)return;let msg;try{msg=JSON.parse(raw);}catch{return ws.close(1008,'消息格式无效');}
   if(!identity){
    if(msg.type!=='auth')return ws.close(1008,'不支持的操作');
    busy=true;
    try{const decoded=verifyToken(msg.token);if(!decoded)throw Error();const [r]=await(await getPool()).execute('SELECT id FROM accounts WHERE id=?',[decoded.account_id]);if(!r.length||ws.readyState!==1)throw Error();if((sockets.get(decoded.account_id)?.size||0)>=3)throw Error();identity=decoded;ws.token=msg.token;ws.alive=true;clearTimeout(timeout);if(!sockets.has(identity.account_id))sockets.set(identity.account_id,new Set());sockets.get(identity.account_id).add(ws);ws.send('{"type":"ready"}');}
    catch{ws.close(1008,'登录失效');}finally{busy=false;}
    return;
   }
   // 已认证：白名单只放「在线状态 / 正在输入」，其余一律断开（避免这条通道变成通用消息总线）
   busy=true;
   try{if(msg.type==='presence'||msg.type==='typing')await roomMessage(ws,msg);else ws.close(1008,'不支持的操作');}
   catch(e){/* 单条事件失败不影响连接 */}
   finally{busy=false;}
  });
  ws.on('pong',()=>{ws.alive=true;});
  ws.on('close',()=>{clearTimeout(timeout);if(identity){leaveAllRooms(ws);const set=sockets.get(identity.account_id);set?.delete(ws);if(!set?.size)sockets.delete(identity.account_id);}});});
  const timer=setInterval(()=>{for(const ws of wss.clients){if(!ws.token)continue;if(!verifyToken(ws.token)||!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}},25000);timer.unref();wss.on('close',()=>clearInterval(timer));return wss;
 }
 return {ensureSchema,attach,access,notify};
};
