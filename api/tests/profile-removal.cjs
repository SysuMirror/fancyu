'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
(async()=>{let child;const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
try{child=spawn(process.execPath,[path.resolve(__dirname,'../index.js')],{env:{...process.env,PORT:String(port),WEB_DIR:path.resolve(__dirname,'../../web')},stdio:['ignore','pipe','pipe']});let ready=false;child.stdout.on('data',b=>{if(String(b).includes('Server running on port'))ready=true;});child.stderr.on('data',()=>{});
for(let i=0;i<100&&!ready;i++){if(child.exitCode!==null)throw Error('Server exited');await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'server started');const base='http://127.0.0.1:'+port;
for(const p of ['/homepage.html','/homepage.js','/homepage.css','/homepage%2ehtml','/api/account/profile','/api/account/profile?summary=1'])assert.equal((await fetch(base+p)).status,410,p);
assert.equal((await fetch(base+'/api/account/profile',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{}'})).status,410);
for(const p of ['/profile.html','/','/weekly-match.js']){const r=await fetch(base+p);assert.equal(r.status,200);const text=await r.text();assert.ok(!text.includes('homepage.html'));assert.ok(!text.includes('loadHomepageSummary'));}
assert.equal((await fetch(base+'/api/account/me')).status,401);
assert.equal((await fetch(base+'/api/account/student-verification')).status,401);
const login=await fetch(base+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:process.env.ADMIN_USERNAME||'mony',password:process.env.ADMIN_PASSWORD})});const auth=await login.json();assert.equal(auth.code,200);
const headers={Authorization:'Bearer '+auth.token};const overview=await(await fetch(base+'/api/admin/overview',{headers})).json();assert.equal(overview.code,200);assert.equal(overview.data.modes.length,3);assert.equal(overview.data.totals.profiles,undefined);assert.ok(!overview.data.modes.some(x=>x.key==='daily'));assert.equal(overview.data.active.daily,undefined);assert.equal(overview.data.statuses.daily,undefined);assert.ok(overview.data.observations.every(x=>x.mode!=='daily'));
for(const p of ['/api/admin/weekly-batches','/api/admin/deep-batches']){const r=await fetch(base+p,{headers});assert.notEqual(r.status,500);assert.notEqual(r.status,503);}
console.log('PASS: personal homepage removed, account center preserved, private APIs blocked, verification preserved, three-mode analytics.');
}finally{if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}}})().catch(e=>{console.error(e.message);process.exitCode=1;});
