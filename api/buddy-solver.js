'use strict';
const {spawn}=require('child_process'),path=require('path');
module.exports=data=>new Promise((resolve,reject)=>{
 const child=spawn(process.env.WEEKLY_PYTHON||path.join(__dirname,'../.private/weekly-venv/bin/python'),[path.join(__dirname,'buddy-solver.py')],{stdio:['pipe','pipe','pipe'],env:{...process.env,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}});
 let out='',done=false;const end=(err,value)=>{if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(value);};
 const timer=setTimeout(()=>{child.kill();end(Error('buddy_solver_timeout'));},45000);
 child.on('error',e=>end(e));child.stdin.on('error',e=>end(e));child.stderr.resume();child.stdout.on('data',b=>{out+=b;if(out.length>100000){child.kill();end(Error('buddy_solver_output_limit'));}});
 child.on('close',code=>{if(code!==0)return end(Error('buddy_solver_failed'));try{const x=JSON.parse(out);if(!Array.isArray(x.pairs))throw Error('invalid_result');end(null,x.pairs);}catch(e){end(e);}});child.stdin.end(JSON.stringify(data));
});
