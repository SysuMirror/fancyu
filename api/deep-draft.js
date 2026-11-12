'use strict';
// deep 问卷草稿：多设备同步。正式提交仍走 deep-match.js 的 PUT /account/deep-survey（全量校验），草稿不做校验。
module.exports=function(app,{getPool,authMiddleware}){
 let ready;function ensureSchema(){if(!ready)ready=getPool().then(p=>p.query(`CREATE TABLE IF NOT EXISTS deep_drafts (
 account_id INT PRIMARY KEY, data JSON NOT NULL,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)).catch(e=>{ready=null;throw e;});return ready;}
 const json=v=>typeof v==='string'?JSON.parse(v):v;
 const handle=fn=>async(req,res)=>{res.setHeader('Cache-Control','no-store');try{await ensureSchema();await fn(req,res,await getPool());}catch(e){console.error('Deep draft:',e.code||e.name);res.status(503).json({code:503,msg:'草稿服务暂不可用，请稍后重试'});}};
 app.get('/account/deep-draft',authMiddleware,handle(async(req,res,p)=>{const [rows]=await p.execute('SELECT data,updated_at FROM deep_drafts WHERE account_id=?',[req.account.account_id]);res.json({code:200,draft:rows.length?{data:json(rows[0].data),updated_at:rows[0].updated_at}:null});}));
 app.put('/account/deep-draft',authMiddleware,handle(async(req,res,p)=>{const data=sanitizeDraft(req.body);if(!data)return res.status(400).json({code:400,msg:'草稿格式无效'});
 await p.execute('INSERT INTO deep_drafts(account_id,data) VALUES (?,?) ON DUPLICATE KEY UPDATE data=VALUES(data)',[req.account.account_id,JSON.stringify(data)]);
 res.json({code:200});}));
 app.delete('/account/deep-draft',authMiddleware,handle(async(req,res,p)=>{await p.execute('DELETE FROM deep_drafts WHERE account_id=?',[req.account.account_id]);res.json({code:200});}));
 return {ensureSchema};
};
function sanitizeDraft(body){ // 草稿是脏数据：只做形状/大小约束
 if(!body||typeof body!=='object'||Array.isArray(body))return null;
 const data=body.data;
 if(typeof data!=='object'||data===null||Array.isArray(data))return null;
 try{if(JSON.stringify(data).length>131072)return null;}catch(e){return null;}
 return data;
}
module.exports.sanitizeDraft=sanitizeDraft;
