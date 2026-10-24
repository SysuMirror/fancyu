const {spawn}=require('child_process'),path=require('path');
module.exports=function solve(graph){return new Promise((resolve,reject)=>{
 const python=process.env.WEEKLY_PYTHON||path.join(__dirname,'../.private/weekly-venv/bin/python');
 const p=spawn(python,[path.join(__dirname,'weekly-solver.py')],{stdio:['pipe','pipe','pipe']});let output='',done=false;
 const timer=setTimeout(()=>{p.kill('SIGKILL');finish(Error('weekly_solver_timeout'));},30000);
 function finish(err,value){if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(value);}
 p.stdout.on('data',d=>{output+=d;if(output.length>100000){p.kill();finish(Error('solver_output_limit'));}});p.stderr.resume();p.on('error',()=>finish(Error('weekly_solver_unavailable')));p.stdin.on('error',()=>{});
 p.on('close',code=>{if(code!==0)return finish(Error('weekly_solver_failed'));try{const result=JSON.parse(output);if(!Array.isArray(result.pairs))throw Error();finish(null,result.pairs);}catch(e){finish(Error('invalid_solver_result'));}});p.stdin.end(JSON.stringify(graph));
});};
