'use strict';
const assert=require('node:assert/strict'),mysql=require('mysql2/promise'),crypto=require('node:crypto'),express=require('express'),{WebSocket}=require('ws');
(async()=>{
 const real=mysql.createPool({host:process.env.MYSQL_HOST,port:process.env.MYSQL_PORT,user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE,connectionLimit:4,timezone:'Z'});
 const prefix='chattest_'+crypto.randomBytes(5).toString('hex')+'_';
 const original=['accounts','verified_students','daily_settings','weekly_match_bans','daily_blocks','friend_cards','weekly_match_pairs','deep_pairs','friend_card_pairs','complaints','daily_mutex'];
 const names=[...original,'user_chat_messages','user_chat_reads','user_chat_exchange','user_chat_reports','user_chat_contact_events','user_chat_meta'];
 const re=new RegExp('\\b('+names.join('|')+')\\b','g'),sql=s=>s.replace(re,x=>prefix+x);
 const wrap=c=>({query:(s,a)=>c.query(sql(s),a),execute:(s,a)=>c.execute(sql(s),a),beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release()});
 const db={...wrap(real),getConnection:async()=>wrap(await real.getConnection())};let server,wss;const sockets=[];
 try{
  for(const name of original)await real.query('CREATE TABLE `'+prefix+name+'` LIKE `'+name+'`');
  await db.query('INSERT INTO daily_mutex(id) VALUES (1)');const ids=[];
  for(let i=0;i<3;i++){const email='chat'+i+'@example.invalid';const [r]=await db.execute('INSERT INTO accounts(email,username,password_hash) VALUES (?,?,?)',[email,'chat'+i,'fixture-not-password']);ids.push(r.insertId);await db.execute('INSERT INTO verified_students(account_id,email,verified_at) VALUES (?,?,UTC_TIMESTAMP())',[r.insertId,email]);}
  const app=express();app.use(express.json());
  const auth=(req,res,next)=>{const id=Number(req.headers['x-fixture']);if(!ids.includes(id))return res.status(401).json({code:401});req.account={account_id:id};next();};
  const admin=(req,res,next)=>{if(req.headers['x-admin']!=='yes')return res.status(401).json({code:401});req.admin={username:'chat-test'};next();};
  const daily={transaction:async fn=>{const c=await db.getConnection();try{await c.beginTransaction();await c.query('SELECT id FROM daily_mutex WHERE id=1 FOR UPDATE');const r=await fn(c);await c.commit();return r;}catch(e){await c.rollback();throw e;}finally{c.release();}},blocked:async(c,a,b)=>(await c.execute('SELECT owner_id FROM daily_blocks WHERE (owner_id=? AND target_id=?) OR (owner_id=? AND target_id=?)',[a,b,b,a]))[0].length>0};
  let tokenValid=true;const verifyToken=t=>tokenValid&&t==='fixture-token'?{account_id:ids[0]}:null;
  const chat=require('../chat')(app,{getPool:async()=>db,authMiddleware:auth,adminAuthMiddleware:admin,daily,verifyToken});await chat.ensureSchema();
  const cards=[];for(let i=0;i<2;i++){const [r]=await db.execute("INSERT INTO friend_cards(account_id,slot,type,data) VALUES (?,1,'sport','{}')",[ids[i]]);cards.push(r.insertId);}
  await db.execute("INSERT INTO weekly_match_pairs(id,batch_key,a_id,b_id,reasons,score_data,created_at,expires_at) VALUES (1,'2026-10-26',?,?,'[]','{}',UTC_TIMESTAMP(),DATE_ADD(UTC_TIMESTAMP(),INTERVAL 7 DAY))",ids.slice(0,2));
  await db.execute("INSERT INTO deep_pairs(id,week_key,a_id,b_id,created_at) VALUES (1,'2026-10-26',?,?,UTC_TIMESTAMP())",ids.slice(0,2));
  await db.execute("INSERT INTO friend_card_pairs(id,week_key,a_id,b_id,a_card,b_card) VALUES (1,'2026-10-26',?,?,?,?)",[...ids.slice(0,2),...cards]);
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));wss=chat.attach(server);const base='http://127.0.0.1:'+server.address().port;
  async function api(path='',i=0,method='GET',body,adm=false){const r=await fetch(base+(path.startsWith('/admin')?path:'/account/chat'+path),{method,headers:{'Content-Type':'application/json','x-fixture':String(ids[i]||0),...(adm?{'x-admin':'yes'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {http:r.status,...await r.json()};}
  const send=(mode,i,body,client_id=crypto.randomUUID())=>api('/'+mode+'/1/messages',i,'POST',{body,client_id});
  assert.equal((await api('',9)).http,401);
  for(const [mode,table]of Object.entries({love:'weekly_match_pairs',deep:'deep_pairs',buddy:'friend_card_pairs'})){
   assert.equal((await send(mode,0,'pending')).http,409);await db.query(`UPDATE ${table} SET status='connected' WHERE id=1`);
   assert.equal((await api('/'+mode+'/1',2)).http,404);assert.equal((await send(mode,2,'intruder')).http,404);
   const nonce=crypto.randomUUID(),sent=await send(mode,0,'<script>alert(1)</script>',nonce);assert.equal(sent.http,200,JSON.stringify(sent));assert.equal(sent.notify,undefined);
   assert.equal((await send(mode,0,'<script>alert(1)</script>',nonce)).id,sent.id);assert.equal((await send(mode,0,'changed',nonce)).http,409);
   const messages=await api('/'+mode+'/1',1);assert.equal(messages.messages.length,1);assert.equal(messages.messages[0].sender_id,undefined);assert.equal(messages.messages[0].mine,false);
   assert.equal((await api('',1)).rooms.find(r=>r.mode===mode).unread,1);
   await api('/'+mode+'/1/read',1,'POST',{last_id:sent.id});assert.equal((await api('',1)).rooms.find(r=>r.mode===mode).unread,0);
   assert.equal((await api('/'+mode+'/1/exchange',2,'POST',{wechat:'outsider',consent:true})).http,404);
   assert.equal((await api('/'+mode+'/1/exchange',0,'POST',{wechat:'fixture_one',consent:false})).http,400);
   await api('/'+mode+'/1/exchange',0,'POST',{wechat:'fixture_one',consent:true});let state=(await api('/'+mode+'/1',1)).exchange;assert.equal(state.incoming,true);assert.equal(state.wechat,null);
   await api('/'+mode+'/1/exchange',0,'DELETE');assert.equal((await api('/'+mode+'/1',1)).exchange.incoming,false);
   await api('/'+mode+'/1/exchange',0,'POST',{wechat:'fixture_one',consent:true});await api('/'+mode+'/1/exchange',1,'POST',{wechat:'fixture_two',consent:true});state=(await api('/'+mode+'/1')).exchange;assert.equal(state.wechat,'fixture_two');assert.equal(state.exchanged,true);
   assert.equal((await api('/'+mode+'/1/exchange',0,'DELETE')).http,409);
   assert.equal((await api('/'+mode+'/1/report',0,'POST',{message_id:sent.id,reason:'self report'})).http,404);
   assert.equal((await api('/'+mode+'/1/report',1,'POST',{message_id:sent.id,reason:'test harassment'})).http,200);
   await db.query(`UPDATE ${table} SET status='closed' WHERE id=1`);assert.equal((await api('/'+mode+'/1')).http,409);assert.equal((await send(mode,0,'closed')).http,409);assert.equal((await api('/'+mode+'/1/exchange',0,'POST',{wechat:'fixture_one',consent:true})).http,409);
   await db.query(`UPDATE ${table} SET status='connected' WHERE id=1`);
  }
  assert.equal((await db.query('SELECT COUNT(*) n FROM user_chat_contact_events'))[0][0].n,3);
  assert.equal((await api('/admin/chat-reports')).http,401);const reports=await api('/admin/chat-reports',0,'GET',null,true);assert.equal(reports.reports.length,3);assert.equal((await api('/admin/chat-reports/'+reports.reports[0].complaint_id,0,'GET',null,true)).messages.length,1);assert.equal((await api('/admin/chat-reports/99999999',0,'GET',null,true)).http,404);
  await db.execute('INSERT INTO daily_blocks(owner_id,target_id,created_at) VALUES (?,?,UTC_TIMESTAMP())',ids.slice(0,2));for(const mode of ['love','deep','buddy'])assert.equal((await send(mode,0,'blocked')).http,403);await db.query('DELETE FROM daily_blocks');
  await db.execute('INSERT INTO weekly_match_bans(account_id) VALUES (?)',[ids[1]]);assert.equal((await api('/love/1')).http,403);await db.query('DELETE FROM weekly_match_bans');
  await db.query('UPDATE friend_cards SET deleted=1 WHERE id='+cards[0]);assert.equal((await api('/buddy/1')).http,409);await db.query('UPDATE friend_cards SET deleted=0');
  await db.execute("UPDATE accounts SET email='changed@example.invalid' WHERE id=?",[ids[0]]);assert.equal((await api('/deep/1')).http,403);await db.execute("UPDATE accounts SET email='chat0@example.invalid' WHERE id=?",[ids[0]]);
  const ws=new WebSocket(base.replace('http','ws')+'/api/chat/socket');sockets.push(ws);await new Promise((resolve,reject)=>{ws.on('open',()=>ws.send(JSON.stringify({type:'auth',token:'fixture-token'})));ws.once('message',raw=>{try{assert.deepEqual(JSON.parse(raw),{type:'ready'});resolve();}catch(e){reject(e);}});ws.once('error',reject);});
  const notified=new Promise(resolve=>ws.once('message',raw=>resolve(JSON.parse(raw))));await send('love',1,'hello realtime');assert.deepEqual(await notified,{type:'refresh'});
  const bad=new WebSocket(base.replace('http','ws')+'/api/chat/socket');sockets.push(bad);assert.equal(await new Promise(resolve=>{bad.on('open',()=>bad.send(JSON.stringify({type:'auth',token:'bad'})));bad.on('close',code=>resolve(code));}),1008);
  for(let i=0;i<55;i++)await db.execute("INSERT INTO user_chat_messages(mode,pair_id,sender_id,client_id,body,created_at) VALUES ('love',1,?,?,?,DATE_SUB(UTC_TIMESTAMP(),INTERVAL 2 MINUTE))",[ids[0],crypto.randomUUID(),'history '+i]);
  const latest=await api('/love/1');assert.equal(latest.messages.length,50);assert.equal(latest.more,true);const older=await api('/love/1?before='+latest.messages[0].id);assert.ok(older.messages.length>0);assert.ok(older.messages.at(-1).id<latest.messages[0].id);
  assert.equal((await api('/deep/1/read',1,'POST',{last_id:latest.messages[0].id})).http,400);
  assert.equal((await send('love',0,'x'.repeat(2001))).http,400);
  let throttled=false;for(let i=0;i<35;i++){if((await send('love',0,'rate '+i)).http===429){throttled=true;break;}}assert.equal(throttled,true);
  tokenValid=false;await Promise.race([new Promise(resolve=>ws.once('close',resolve)),new Promise((_,reject)=>setTimeout(()=>reject(Error('expired websocket remained open')),28000).unref())]);
  console.log('PASS chat: all three modes, pending/closed/blocked/banned/unverified, outsider isolation, idempotency, unread, consent, reports/audit, pagination, rate limit, websocket auth, expiry and notifications.');
 }finally{for(const ws of sockets)ws.terminate();if(wss)await new Promise(r=>wss.close(r));if(server)await new Promise(r=>server.close(r));const c=await real.getConnection();try{await c.query('SET FOREIGN_KEY_CHECKS=0');for(const name of [...names].reverse())await c.query('DROP TABLE IF EXISTS `'+prefix+name+'`');await c.query('SET FOREIGN_KEY_CHECKS=1');}finally{c.release();await real.end();}}
})().catch(e=>{console.error(e);process.exitCode=1;});
