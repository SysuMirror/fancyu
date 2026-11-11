'use strict';
const {validate}=require('./weekly-validation');
module.exports=function(app,{getPool,authMiddleware,adminAuthMiddleware,transaction,onSave=async()=>{}}){
 require('./core-metrics').registerSurveyRoutes(app,{getPool,authMiddleware});
 let ready;function ensureSchema(){if(!ready)ready=getPool().then(p=>p.query(`CREATE TABLE IF NOT EXISTS weekly_questionnaires (
 account_id INT PRIMARY KEY, version VARCHAR(12) NOT NULL, answers JSON NOT NULL, important JSON NOT NULL,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)).then(async()=>require('./core-metrics').ensureSchema(await getPool())).catch(e=>{ready=null;throw e;});return ready;}
 const json=v=>typeof v==='string'?JSON.parse(v):v;
 const handle=fn=>async(req,res)=>{res.setHeader('Cache-Control','no-store');try{await ensureSchema();await fn(req,res,await getPool());}catch(e){console.error('Weekly questionnaire:',e.code||e.name);res.status(503).json({code:503,msg:'问卷服务暂不可用，请稍后重试'});}};
 app.get('/account/weekly-survey',authMiddleware,handle(async(req,res,p)=>{const [rows]=await p.execute('SELECT version,answers,important,updated_at FROM weekly_questionnaires WHERE account_id=?',[req.account.account_id]);res.json({code:200,survey:rows.length?{...rows[0],answers:json(rows[0].answers),important:json(rows[0].important)}:null});}));
 app.put('/account/weekly-survey',authMiddleware,handle(async(req,res,p)=>{let clean;try{clean=validate(req.body);}catch(e){return res.status(400).json({code:400,msg:e.message});}
 const save=async(c,time)=>{ await c.execute('INSERT INTO weekly_questionnaires(account_id,version,answers,important) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE version=VALUES(version),answers=VALUES(answers),important=VALUES(important),updated_at=CURRENT_TIMESTAMP',[req.account.account_id,clean.version,JSON.stringify(clean.answers),JSON.stringify(clean.important)]); await onSave(c,req.account.account_id,clean,time); await require('./core-metrics').completeSurvey(c,'love',req.account.account_id); };
 if(transaction)await transaction(save);else await save(p,new Date());
 res.json({code:200,msg:'每周配对问卷已保存',uniform:clean.uniform});}));
 app.get('/admin/weekly-surveys',adminAuthMiddleware,handle(async(req,res,p)=>{const page=Math.max(1,parseInt(req.query.page)||1),offset=Math.min(page-1,100000)*20;const [rows]=await p.query('SELECT account_id,version,answers,important,updated_at FROM weekly_questionnaires ORDER BY updated_at DESC LIMIT 20 OFFSET ?',[offset]);res.json({code:200,data:rows.map(r=>({...r,answers:json(r.answers),important:json(r.important)}))});}));
 return {ensureSchema};
};
