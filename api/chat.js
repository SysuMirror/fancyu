'use strict';
const fs=require('fs'),path=require('path');
const TABLES={love:'weekly_match_pairs',deep:'deep_pairs',buddy:'friend_card_pairs'};
const fail=(status,msg)=>{throw Object.assign(Error(msg),{status});};
const positive=x=>{const n=Number(x);if(!Number.isSafeInteger(n)||n<1)fail(400,'编号无效');return n;};
module.exports=function(app,{getPool,authMiddleware,adminAuthMiddleware,daily,verifyToken,now=()=>new Date()}){
 let ready;const sockets=new Map();
 function ensureSchema(){if(!ready)ready=(async()=>{const p=await getPool();for(const sql of fs.readFileSync(path.join(__dirname,'chat-schema.sql'),'utf8').split(';').map(x=>x.trim()).filter(Boolean))await p.query(sql);const c=await p.getConnection();try{await c.beginTransaction();const [marker]=await c.execute('INSERT IGNORE INTO user_chat_meta(id) VALUES (1)');if(marker.affectedRows){for(const [mode,table]of Object.entries(TABLES)){const condition=mode==='love'?'connected_at IS NOT NULL':'a_agreed=1 AND b_agreed=1';await c.query(`INSERT IGNORE INTO user_chat_contact_events(mode,pair_id,exchanged_at) SELECT '${mode}',id,created_at FROM ${table} WHERE ${condition}`);}}await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}})().catch(e=>{ready=null;throw e;});return ready;}
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
  const [rows]=await c.execute('SELECT account_id,wechat FROM user_chat_exchange WHERE mode=? AND pair_id=?',[mode,pairId]);
  const mine=rows.find(x=>x.account_id===id),other=rows.find(x=>x.account_id===(p.a_id===id?p.b_id:p.a_id));
  const legacy=p.a_wechat&&p.b_wechat;
  return {requested:!!mine,incoming:!!other,exchanged:!!legacy||!!(mine&&other),wechat:legacy?(p.a_id===id?p.b_wechat:p.a_wechat):(mine&&other?other.wechat:null)};
 }
 app.get('/account/chat',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id,rooms=[];
  for(const [mode,table]of Object.entries(TABLES)){const [rows]=await c.execute(`SELECT id FROM ${table} WHERE (a_id=? OR b_id=?) AND status='connected' ORDER BY id DESC LIMIT 100`,[id,id]);
   for(const row of rows){let a;try{a=await access(c,id,mode,row.id);}catch(e){if(e.status)continue;throw e;}
    const [[counts]]=await c.execute('SELECT COUNT(*) unread,MAX(id) last_id FROM user_chat_messages WHERE mode=? AND pair_id=? AND sender_id<>? AND id>COALESCE((SELECT last_read FROM user_chat_reads WHERE mode=? AND pair_id=? AND account_id=?),0)',[mode,row.id,id,mode,row.id,id]);
    const [last]=await c.execute('SELECT id,body,created_at FROM user_chat_messages WHERE mode=? AND pair_id=? ORDER BY id DESC LIMIT 1',[mode,row.id]);
    rooms.push({mode,pair_id:row.id,name:a.name,unread:Number(counts.unread),last_id:last[0]?.id||0,last_preview:last[0]?String(last[0].body).slice(0,60):'',updated_at:last[0]?.created_at||null});
   }
  }rooms.sort((a,b)=>b.last_id-a.last_id);return {rooms,unread:rooms.reduce((n,r)=>n+r.unread,0)};
 }));
 app.get('/account/chat/:mode/:id',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id,mode=req.params.mode,pairId=positive(req.params.id),a=await access(c,id,mode,pairId);
  const after=req.query.after===undefined?null:Math.max(0,Number(req.query.after)),before=req.query.before===undefined?null:positive(req.query.before);
  if(after!==null&&!Number.isSafeInteger(after)||after!==null&&before!==null)fail(400,'分页参数无效');
  const [rows]=await c.execute(`SELECT id,sender_id,client_id,body,created_at FROM user_chat_messages WHERE mode=? AND pair_id=? ${after!==null?'AND id>?':before!==null?'AND id<?':''} ORDER BY id ${after!==null?'ASC':'DESC'} LIMIT 51`,[mode,pairId,...(after!==null?[after]:before!==null?[before]:[])]);
  const [reads]=await c.execute('SELECT last_read FROM user_chat_reads WHERE mode=? AND pair_id=? AND account_id=?',[mode,pairId,a.other]);
  const otherLastRead=reads.length?Number(reads[0].last_read):0;
  const more=rows.length>50,messages=rows.slice(0,50);if(after===null)messages.reverse();return {name:a.name,messages:messages.map(m=>({...m,mine:m.sender_id===id,sender_id:undefined})),more,other_last_read:otherLastRead,exchange:await exchange(c,id,mode,pairId,a.p)};
 }));
 app.post('/account/chat/:mode/:id/messages',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id,mode=req.params.mode,pairId=positive(req.params.id),a=await access(c,id,mode,pairId),{body,client_id}=req.body||{};
  if(typeof body!=='string'||!body.trim()||body.length>2000||typeof client_id!=='string'||!/^[-a-zA-Z0-9_]{16,64}$/.test(client_id))fail(400,'消息需为1–2000字');
  const [existing]=await c.execute('SELECT id,body FROM user_chat_messages WHERE mode=? AND pair_id=? AND sender_id=? AND client_id=?',[mode,pairId,id,client_id]);
  if(existing.length){if(existing[0].body!==body.trim())fail(409,'重试内容已变化，请重新发送');return {id:existing[0].id,duplicate:true};}
  const [[{n}]]=await c.execute('SELECT COUNT(*) n FROM user_chat_messages WHERE sender_id=? AND created_at>DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE)',[id]);if(Number(n)>=30)fail(429,'发送太快，请稍后再试');
  const [r]=await c.execute('INSERT INTO user_chat_messages(mode,pair_id,sender_id,client_id,body) VALUES (?,?,?,?,?)',[mode,pairId,id,client_id,body.trim()]);
  return {id:r.insertId,notify:[id,a.other]};
 }));
 app.post('/account/chat/:mode/:id/read',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id,mode=req.params.mode,pairId=positive(req.params.id),a=await access(c,id,mode,pairId);const last=positive(req.body?.last_id);
  const [m]=await c.execute('SELECT id FROM user_chat_messages WHERE mode=? AND pair_id=? AND id=?',[mode,pairId,last]);if(!m.length)fail(400,'已读位置无效');
  await c.execute('INSERT INTO user_chat_reads(mode,pair_id,account_id,last_read) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE last_read=GREATEST(last_read,VALUES(last_read))',[mode,pairId,id,last]);return {notify:[id,a.other]};
 }));
 app.post('/account/chat/:mode/:id/exchange',authMiddleware,route(async(req,c)=>{
  const id=req.account.account_id,mode=req.params.mode,pairId=positive(req.params.id),a=await access(c,id,mode,pairId),{wechat,consent}=req.body||{};
  if(consent!==true||typeof wechat!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{5,31}$/.test(wechat))fail(400,'请填写6–32位有效微信号，并同意双方申请后互相展示');
  const state=await exchange(c,id,mode,pairId,a.p);if(state.exchanged)return {exchange:state,msg:'你们已交换微信'};
  await c.execute('INSERT INTO user_chat_exchange(mode,pair_id,account_id,wechat) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE wechat=VALUES(wechat),consented_at=UTC_TIMESTAMP()',[mode,pairId,id,wechat]);
  const updated=await exchange(c,id,mode,pairId,a.p);if(updated.exchanged)await c.execute('INSERT IGNORE INTO user_chat_contact_events(mode,pair_id) VALUES (?,?)',[mode,pairId]);return {exchange:updated,msg:'申请已记录，双方同意后互相展示微信',notify:[id,a.other]};
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
 function attach(server){const {WebSocketServer}=require('ws'),wss=new WebSocketServer({noServer:true,maxPayload:8192,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{if(req.url!=='/api/chat/socket')return socket.destroy();const origin=req.headers.origin;try{if(origin&&new URL(origin).host!==req.headers.host)return socket.destroy();}catch{return socket.destroy();}if(wss.clients.size>=500)return socket.destroy();wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));});
  wss.on('connection',ws=>{let identity=null,busy=false;const timeout=setTimeout(()=>ws.close(1008,'请登录'),5000);ws.on('error',()=>{});ws.on('message',async raw=>{if(identity||busy)return ws.close(1008,'不支持的操作');busy=true;try{const msg=JSON.parse(raw),decoded=verifyToken(msg.token);if(msg.type!=='auth'||!decoded)throw Error();const [r]=await(await getPool()).execute('SELECT id FROM accounts WHERE id=?',[decoded.account_id]);if(!r.length||ws.readyState!==1)throw Error();if((sockets.get(decoded.account_id)?.size||0)>=3)throw Error();identity=decoded;ws.token=msg.token;ws.alive=true;clearTimeout(timeout);if(!sockets.has(identity.account_id))sockets.set(identity.account_id,new Set());sockets.get(identity.account_id).add(ws);ws.send('{"type":"ready"}');}catch{ws.close(1008,'登录失效');}});ws.on('pong',()=>{ws.alive=true;});ws.on('close',()=>{clearTimeout(timeout);if(identity){const set=sockets.get(identity.account_id);set?.delete(ws);if(!set?.size)sockets.delete(identity.account_id);}});});
  const timer=setInterval(()=>{for(const ws of wss.clients){if(!ws.token)continue;if(!verifyToken(ws.token)||!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}},25000);timer.unref();wss.on('close',()=>clearInterval(timer));return wss;
 }
 return {ensureSchema,attach,access};
};
