'use strict';
module.exports=function(app,{getPool,ensureSchema,authMiddleware}){
 async function verified(pool,id){const [rows]=await pool.execute('SELECT a.id FROM accounts a JOIN verified_students v ON v.account_id=a.id AND v.email=a.email WHERE a.id=?',[id]);return rows.length>0;}
 async function requireVerified(req,res,next){try{await ensureSchema();if(await verified(await getPool(),req.account.account_id))return next();return res.status(403).json({code:403,reason:'STUDENT_EMAIL_REQUIRED',msg:'请先验证学生邮箱，才能开启配对或查看配对资料',verification_url:'verify-student.html'});}catch(e){res.status(503).json({code:503,msg:'学生邮箱验证状态暂不可用，请稍后重试'});}}
 app.get('/account/student-verification',authMiddleware,async(req,res)=>{res.setHeader('Cache-Control','no-store');try{await ensureSchema();const p=await getPool();res.json({code:200,verified:await verified(p,req.account.account_id)});}catch(e){res.status(503).json({code:503,msg:'暂时无法读取验证状态'});}});
 for(const [url,field]of [['/account/toggle-matching','join_matching'],['/account/toggle-friend-matching','join_friend_matching']])app.post(url,authMiddleware,(req,res,next)=>{
  if(typeof req.body?.[field]!=='boolean')return res.status(400).json({code:400,msg:'配对开关必须为 true 或 false'});
  if(req.body[field]===false)return next();return requireVerified(req,res,next);
 });
 app.get('/account/matches',authMiddleware,requireVerified);
 app.post('/account/exchange-contact',authMiddleware,requireVerified);
 app.get('/',(req,res,next)=>['query','queryByUserId'].includes(req.query.action)?authMiddleware(req,res,()=>requireVerified(req,res,next)):next());
 return {verified,requireVerified};
};
