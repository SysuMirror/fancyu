'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('path'),net=require('net'),{spawn}=require('child_process');
test('full Express integration rejects legacy bypasses and serves daily UI',{skip:process.env.DAILY_INTEGRATION_TEST!=='1'},async()=>{
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const web=path.resolve(__dirname,'../../web');const child=spawn(process.execPath,[path.resolve(__dirname,'../index.js')],{env:{...process.env,PORT:String(port),WEB_DIR:web,SMTP_PASSWORD:'',ADMIN_USERNAME:'smoke-admin',ADMIN_PASSWORD:'smoke-admin-password'},stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
try{
 await new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(log.includes('Server running on port')){clearInterval(timer);resolve();}else if(child.exitCode!==null){clearInterval(timer);reject(Error('Test server failed to start'));}},25);setTimeout(()=>{clearInterval(timer);reject(Error('Server startup timeout'));},10000).unref();});
 const base='http://127.0.0.1:'+port;
 async function call(url,body,token){const r=await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};}
 assert.equal((await call('/api/health')).status,200);assert.equal((await fetch(base+'/daily.html')).status,200);
 assert.equal((await call('/api/daily/state')).status,401);assert.equal((await call('/api/account/me')).status,401);assert.equal((await call('/api/account/profile')).status,401);assert.equal((await call('/api/admin/users')).status,401);
 assert.equal((await call('/api/account/login',{login:'not-a-real-account',password:'guest'})).status,401);
 assert.equal((await call('/api/account/register',{email:'not@sysu.edu.cn',username:'test',password:'valid_password',code:'123456'})).status,400);
 assert.equal((await call('/api',{action:'sendCode',email:'test@mail2.sysu.edu.cn',source:'register'})).status,503);
 assert.equal((await call('/api/admin/login',{username:'anything',password:'anything'})).status,401);
 const admin=await call('/api/admin/login',{username:'smoke-admin',password:'smoke-admin-password'});assert.equal(admin.status,200);
 assert.equal((await call('/api/admin/import-matches',{matches:[]},admin.data.token)).data.code,200);
 assert.equal((await fetch(base+'/all_users.html')).status,403);assert.equal((await fetch(base+'/all_users%2ehtml')).status,403);assert.equal((await fetch(base+'/photos/test.jpg')).status,403);
 const jwt=require('jsonwebtoken');const legacy=jwt.sign({account_id:1},process.env.JWT_SECRET);assert.equal((await call('/api/account/me',null,legacy)).status,401);
 assert.equal((await call('/api?action=debug&serial=anything')).status,403);
}finally{child.kill('SIGTERM');if(child.exitCode===null)await new Promise(r=>child.once('exit',r));}
});
