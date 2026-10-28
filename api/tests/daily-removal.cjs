'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
(async()=>{let child;const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
try{child=spawn(process.execPath,[path.resolve(__dirname,'../index.js')],{env:{...process.env,PORT:String(port),WEB_DIR:path.resolve(__dirname,'../../web')},stdio:['ignore','pipe','pipe']});let ready=false;child.stdout.on('data',b=>{if(String(b).includes('Server running on port'))ready=true;});child.stderr.on('data',()=>{});
for(let i=0;i<100&&!ready;i++){if(child.exitCode!==null)throw Error('Server exited');await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'server started');const base='http://127.0.0.1:'+port;
for(const p of ['/daily.html','/daily.js','/daily.css','/daily%2ehtml','/api/daily/state','/daily/state','/api/admin/daily/accounts/1/ban'])assert.equal((await fetch(base+p)).status,410,p);
for(const p of ['/api/daily/today','/api/daily/pause','/api/daily/pairs/1/respond'])assert.equal((await fetch(base+p,{method:'POST'})).status,410,p);
assert.equal((await fetch(base+'/api/daily/settings',{method:'PUT'})).status,410);
for(const p of ['/api/daily/verification/send','/api/daily/verification/confirm'])assert.equal((await fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401,p);
for(const p of ['/','/verify-student.html']){const r=await fetch(base+p);assert.equal(r.status,200);assert.ok(!(await r.text()).includes('daily.html'));}
const login=await fetch(base+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:process.env.ADMIN_USERNAME||'mony',password:process.env.ADMIN_PASSWORD})});const auth=await login.json();assert.equal(auth.code,200);
const headers={Authorization:'Bearer '+auth.token};const overview=await(await fetch(base+'/api/admin/overview',{headers})).json();assert.equal(overview.code,200);assert.equal(overview.data.modes.length,3);assert.ok(!overview.data.modes.some(x=>x.key==='daily'));assert.equal(overview.data.active.daily,undefined);assert.equal(overview.data.statuses.daily,undefined);assert.ok(overview.data.observations.every(x=>x.mode!=='daily'));
for(const p of ['/api/admin/weekly-batches','/api/admin/deep-batches']){const r=await fetch(base+p,{headers});assert.notEqual(r.status,500);assert.notEqual(r.status,503);}
console.log('PASS: removed pages/APIs, verification preserved, homepage, three-mode analytics and other batch endpoints.');
}finally{if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}}})().catch(e=>{console.error(e.message);process.exitCode=1;});
