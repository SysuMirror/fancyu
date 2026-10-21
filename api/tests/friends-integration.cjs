const assert=require('assert/strict'),crypto=require('crypto'),mysql=require('mysql2/promise'),express=require('express');
(async()=>{
 const pool=mysql.createPool({host:process.env.MYSQL_HOST,port:process.env.MYSQL_PORT,user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE});
 const ids=[],name='friendtest_'+crypto.randomBytes(5).toString('hex');let server;
 try{
  for(let i=0;i<4;i++){const email=name+i+'@example.invalid';const [r]=await pool.execute('INSERT INTO accounts(email,username,password_hash) VALUES (?,?,?)',[email,name+i,'not-a-real-login']);ids.push(r.insertId);if(i!==2)await pool.execute('INSERT INTO verified_students(account_id,email,verified_at) VALUES (?,?,UTC_TIMESTAMP())',[r.insertId,email]);}
  const app=express();app.use(express.json());const auth=(req,res,next)=>{const id=Number(req.headers['x-fixture']);if(!ids.includes(id))return res.status(401).json({code:401});req.account={account_id:id};next();};
  const getPool=async()=>pool;const daily=require('../daily')(app,{getPool,authMiddleware:auth,adminAuthMiddleware:auth});const studentVerification=require('../verification-guard')(app,{getPool,ensureSchema:daily.ensureSchema,authMiddleware:auth});let date=new Date('2026-10-21T12:00:00Z');
  const friends=require('../friends')(app,{getPool,authMiddleware:auth,daily,studentVerification,now:()=>date});await friends.ensureSchema();server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  async function api(i,path='',method='GET',body){const r=await fetch(base+'/account/friends'+path,{method,headers:{'Content-Type':'application/json','x-fixture':String(ids[i]||0)},...(body?{body:JSON.stringify(body)}:{})});return {http:r.status,...await r.json()};}
  const value={type:'game',v:{item:name,level:'一般',mic:'都行',time:['周末晚上'],gender:'不限',freq:'每周'}};
  assert.equal((await api(10)).http,401);
  const a=await api(0,'/cards','POST',value),b=await api(1,'/cards','POST',value),unverified=await api(2,'/cards','POST',value);
  assert.equal(a.code,200);assert.equal((await api(2)).cards[0].on,false);assert.equal((await api(2,'/cards/'+unverified.id+'/toggle','POST',{enabled:true})).http,403);
  assert.equal((await api(1,'/cards/'+a.id,'PUT',value)).http,404);
  const attempts=await Promise.all(Array.from({length:8},()=>api(0,'/cards/'+a.id+'/recommend','POST')));assert.ok(attempts.every(x=>x.code===200));assert.equal(new Set(attempts.map(x=>x.pair_id)).size,1);
  const pair=attempts[0].pair_id;assert.ok(pair);assert.equal((await api(1)).cards[0].used,true);assert.equal((await api(1)).pairs[0].id,pair);
  assert.equal((await api(3,'/pairs/'+pair+'/respond','POST',{choice:'skip'})).http,404);
  assert.equal((await api(0,'/pairs/'+pair+'/respond','POST',{choice:'like',wechat:'fixture_one',consent:false})).http,400);
  await api(0,'/pairs/'+pair+'/respond','POST',{choice:'like',wechat:'fixture_one',consent:true});assert.equal((await api(1)).pairs[0].wechat,undefined);
  await api(1,'/pairs/'+pair+'/respond','POST',{choice:'like',wechat:'fixture_two',consent:true});assert.equal((await api(0)).pairs[0].wechat,'fixture_two');
  await api(0,'/cards/'+a.id+'/toggle','POST',{enabled:false});assert.equal((await api(0)).pairs[0].status,'connected');
  await api(1,'/pairs/'+pair+'/block','POST');assert.equal((await api(0)).pairs.length,0);await api(1,'/blocks/'+ids[0],'DELETE');assert.equal((await api(0)).pairs.length,0);
  await api(0,'/cards/'+a.id,'DELETE');const recreated=await api(0,'/cards','POST',value);assert.equal(recreated.id,a.id);assert.equal((await api(0)).cards[0].used,true);
  const limit=await Promise.all(Array.from({length:8},()=>api(0,'/cards','POST',value)));assert.equal(limit.filter(x=>x.code===200).length,5);assert.equal((await api(0)).cards.length,6);
  // Pending offers expire exactly at the Beijing week boundary.
  const c=await api(3,'/cards','POST',{...value,v:{...value.v,item:name+'new'}});const d=await api(1,'/cards','POST',{...value,v:{...value.v,item:name+'new'}});
  const newPair=await api(3,'/cards/'+c.id+'/recommend','POST');assert.ok(newPair.pair_id);date=new Date('2026-10-25T16:00:00Z');assert.equal((await api(3)).pairs.length,0);assert.equal((await api(3)).cards[0].used,false);
  const empty=await api(3,'/cards/'+c.id+'/recommend','POST');assert.equal(empty.empty,true);assert.equal((await api(3)).cards[0].used,false);
  console.log('PASS: real DB persistence, ownership, verification, concurrent weekly quota, mutual consent privacy, pause/block/delete/recreate, six-card limit, week expiry, empty pool.');
 }finally{if(server)await new Promise(r=>server.close(r));for(const id of ids)await pool.execute('DELETE FROM accounts WHERE id=?',[id]);await pool.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
