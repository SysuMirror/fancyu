'use strict';
const jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs');
module.exports=function({getPool,secret,legacyUsername,legacyPasswordHash,legacyEnabled}){
 let ready;
 function ensureSchema(){if(!ready)ready=getPool().then(p=>p.query(`CREATE TABLE IF NOT EXISTS account_admin_roles (
 account_id INT PRIMARY KEY,granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)).catch(e=>{ready=null;throw e;});return ready;}
 async function authorize(req,res,next){
  let data;try{const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))throw Error();data=jwt.verify(h.slice(7),secret);if(data.isAdmin!==true||data.security_version!==2)throw Error();}catch(e){return res.status(401).json({code:401,msg:'请登录管理员账号'});}
  if(data.admin_account_id!==undefined){try{await ensureSchema();const [r]=await(await getPool()).execute('SELECT a.id FROM accounts a JOIN account_admin_roles r ON r.account_id=a.id WHERE a.id=?',[data.admin_account_id]);if(!r.length)return res.status(401).json({code:401,msg:'管理员权限已失效，请重新登录'});}catch(e){return res.status(503).json({code:503,msg:'管理员权限暂时无法核验'});}}
  else if(!legacyEnabled||data.username!==legacyUsername)return res.status(401).json({code:401,msg:'请登录管理员账号'});
  req.admin=data;return next();
 }
 async function login(req,res){
  const username=typeof req.body?.username==='string'?req.body.username.trim():'',password=req.body?.password;
  const denied=()=>res.status(401).json({code:401,msg:'账号、密码或管理员权限不正确'});
  if(!username||username.length>255||typeof password!=='string'||password.length>200)return denied();
  try{
   let claims;
   if(legacyEnabled&&username===legacyUsername&&await bcrypt.compare(password,legacyPasswordHash))claims={username};
   else{await ensureSchema();const [r]=await(await getPool()).execute('SELECT a.id,a.username,a.password_hash FROM accounts a JOIN account_admin_roles r ON r.account_id=a.id WHERE a.email=? OR a.username=? LIMIT 1',[username,username]);const a=r[0];if(!a||!await bcrypt.compare(password,a.password_hash||''))return denied();claims={username:a.username,admin_account_id:a.id};}
   return res.json({code:200,msg:'登录成功',username:claims.username,token:jwt.sign({...claims,isAdmin:true,security_version:2},secret,{expiresIn:'24h'})});
  }catch(e){console.error('Admin account login:',e.code||e.name);return res.status(503).json({code:503,msg:'管理员登录暂不可用'});}
 }
 async function accountIsAdmin(accountId){
  const id=Number(accountId);
  if(!Number.isSafeInteger(id)||id<1)return false;
  try{await ensureSchema();const [r]=await(await getPool()).execute('SELECT 1 AS ok FROM account_admin_roles WHERE account_id=? LIMIT 1',[id]);return r.length>0;}
  catch(e){return false;}
 }
 async function entryForAccount(account){
  if(!account||!await accountIsAdmin(account.id))return null;
  const claims={username:account.username,admin_account_id:account.id};
  return {username:account.username,token:jwt.sign({...claims,isAdmin:true,security_version:2},secret,{expiresIn:'24h'})};
 }
 return {ensureSchema,authorize,login,accountIsAdmin,entryForAccount};
};
