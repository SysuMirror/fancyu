'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
module.exports = function(app, { getPool, generateToken, authMiddleware, transporter, emailConfigured, from, ensureSchema, secret }) {
    const validEmail = x => typeof x === 'string' && /^[^\s@]+@(?:mail[23]?\.)?sysu\.edu\.cn$/.test(x);
    const digest = (email, purpose, code) => crypto.createHmac('sha256', secret).update(email + ':' + purpose + ':' + code).digest('hex');
    const wrap = fn => async (req,res,next) => { try { await ensureSchema(); await fn(req,res,next); } catch(e) { console.error('Secure auth:',e.code || e.name); if (!res.headersSent) res.status(503).json({code:503,msg:'服务暂时不可用，请稍后重试'}); } };
    const attempts = new Map();
    function limit(req,res,next) {
        const key = req.socket.remoteAddress;
        const now = Date.now();
        if (attempts.size > 5000) for (const [k,v] of attempts) if (now-v.start > 600000) attempts.delete(k);
        let v=attempts.get(key);
        if (!v || now-v.start>600000) { v={start:now,n:0}; attempts.set(key,v); }
        if (++v.n>30) return res.status(429).json({code:429,msg:'操作过于频繁，请稍后重试'});
        next();
    }
    async function send(email,purpose) {
        if (!validEmail(email)) return {code:400,msg:'请输入中大学生邮箱'};
        if (!emailConfigured) return {code:503,msg:'学生邮箱邮件服务尚未配置，暂不能开启配对。请联系管理员。'};
        const pool=await getPool(), c=await pool.getConnection();
        const code=String(crypto.randomInt(100000,1000000));
        try {
            await c.beginTransaction();
            await c.execute('INSERT IGNORE INTO secure_email_codes (email,purpose,code_hash,expires_at,sent_at) VALUES (?,?,?,UTC_TIMESTAMP(),DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY))',[email,purpose,'']);
            const [rows]=await c.execute('SELECT TIMESTAMPDIFF(SECOND,sent_at,UTC_TIMESTAMP()) AS age FROM secure_email_codes WHERE email=? AND purpose=? FOR UPDATE',[email,purpose]);
            if(rows[0].age<60){await c.rollback();return {code:429,msg:'请等待 60 秒后再发送'};}
            await c.execute('UPDATE secure_email_codes SET code_hash=?,expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 5 MINUTE),sent_at=UTC_TIMESTAMP(),attempts=0 WHERE email=? AND purpose=?',[digest(email,purpose,code),email,purpose]);
            await c.commit();
            try { await transporter.sendMail({from,to:email,subject:'FancyU 学生邮箱验证码',text:`你的验证码是 ${code}，5 分钟内有效。请勿向他人透露。`}); }
            catch(e) { await pool.execute('DELETE FROM secure_email_codes WHERE email=? AND purpose=? AND code_hash=?',[email,purpose,digest(email,purpose,code)]); throw e; }
            return {code:200,msg:'验证码已发送，请查收学生邮箱'};
        } catch(e){await c.rollback();throw e;}finally{c.release();}
    }
    async function check(email,purpose,code,consume=true) {
        if (typeof email!=='string'||typeof code!=='string'||!/^\d{6}$/.test(code)) return false;
        const pool=await getPool(), c=await pool.getConnection();
        try { await c.beginTransaction();
            const [rows]=await c.execute('SELECT code_hash,attempts,expires_at>UTC_TIMESTAMP() AS valid FROM secure_email_codes WHERE email=? AND purpose=? FOR UPDATE',[email,purpose]);
            const row=rows[0];
            if(!row||!row.valid||row.attempts>=5){await c.rollback();return false;}
            const ok=row.code_hash===digest(email,purpose,code);
            if(ok&&consume) await c.execute('DELETE FROM secure_email_codes WHERE email=? AND purpose=?',[email,purpose]);
            else if(!ok) await c.execute('UPDATE secure_email_codes SET attempts=attempts+1 WHERE email=? AND purpose=?',[email,purpose]);
            await c.commit(); return ok;
        }catch(e){await c.rollback();throw e;}finally{c.release();}
    }
    async function markVerified(id,email) {
        const pool=await getPool();
        await pool.execute('INSERT INTO verified_students(account_id,email,verified_at) VALUES (?,?,UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE verified_at=UTC_TIMESTAMP()',[id,email]);
    }
    app.post('/account/login',limit,wrap(async(req,res)=>{
        const {login,password}=req.body||{};
        if(typeof login!=='string'||typeof password!=='string'||password.length>200) return res.status(400).json({code:400,msg:'请输入账号和密码'});
        if(password.length<8)return res.status(401).json({code:401,msg:'请使用至少 8 位的账号密码。旧体验账号请通过学生邮箱重置密码。'});
        const pool=await getPool();const [rows]=await pool.execute('SELECT id,email,username,password_hash FROM accounts WHERE email=? OR username=? LIMIT 1',[login.trim(),login.trim()]);
        const a=rows[0];
        if(!a||!(await bcrypt.compare(password,a.password_hash||''))) return res.status(401).json({code:401,msg:'账号或密码错误'});
        res.json({code:200,token:generateToken(a),user:{account_id:a.id,email:a.email,username:a.username},msg:'登录成功'});
    }));
    app.post('/account/register',limit,wrap(async(req,res)=>{
        const b=req.body||{}, email=String(b.email||'').trim().toLowerCase(), username=String(b.username||b.nickname||'').trim();
        if(!validEmail(email)||username.length<2||username.length>30||typeof b.password!=='string'||b.password.length<8||b.password.length>72) return res.status(400).json({code:400,msg:'请输入中大邮箱、2–30 字用户名和 8–72 位密码'});
        const pool=await getPool();const [old]=await pool.execute('SELECT id FROM accounts WHERE email=? OR username=?',[email,username]);
        if(old.length) return res.status(409).json({code:409,msg:'邮箱或用户名已被使用'});
        if(!await check(email,'register',b.code))return res.status(400).json({code:400,msg:'验证码错误、过期或尝试次数过多'});
        const [r]=await pool.execute('INSERT INTO accounts(email,username,password_hash,email_verified) VALUES (?,?,?,TRUE)',[email,username,await bcrypt.hash(b.password,10)]);
        await markVerified(r.insertId,email);const a={id:r.insertId,email,username};res.json({code:200,token:generateToken(a),user:{account_id:a.id,email,username},msg:'注册成功'});
    }));
    app.post('/account/reset-password',limit,wrap(async(req,res)=>{
        const b=req.body||{};const email=String(b.email||'').trim().toLowerCase();
        if(typeof b.new_password!=='string'||b.new_password.length<8||b.new_password.length>72)return res.status(400).json({code:400,msg:'密码需为 8–72 位'});
        if(!await check(email,'reset',b.code))return res.status(400).json({code:400,msg:'验证码错误或已过期'});
        const pool=await getPool();await pool.execute('UPDATE accounts SET password_hash=? WHERE email=?',[await bcrypt.hash(b.new_password,10),email]);
        res.json({code:200,msg:'密码已更新，请重新登录'});
    }));
    app.post('/',limit,wrap(async(req,res,next)=>{
        if(!['sendCode','checkCode'].includes(req.body?.action))return next();
        const b=req.body, email=String(b.email||'').trim().toLowerCase();
        const purpose=b.source==='reset'?'reset':'register';
        const result=b.action==='sendCode'? await send(email,purpose):{code:await check(email,purpose,b.code,false)?200:400,msg:'验证码校验完成'};
        res.status(result.code).json(result);
    }));
    app.post(['/daily/verification/send','/account/student-verification/send'],authMiddleware,limit,wrap(async(req,res)=>{
        const pool=await getPool();const [rows]=await pool.execute('SELECT email FROM accounts WHERE id=?',[req.account.account_id]);
        const result=await send(rows[0]?.email,'daily');res.status(result.code).json(result);
    }));
    app.post(['/daily/verification/confirm','/account/student-verification/confirm'],authMiddleware,limit,wrap(async(req,res)=>{
        const pool=await getPool();const [rows]=await pool.execute('SELECT email FROM accounts WHERE id=?',[req.account.account_id]);const email=rows[0]?.email;
        if(!validEmail(email)||!await check(email,'daily',req.body?.code))return res.status(400).json({code:400,msg:'验证码错误、过期或尝试次数过多'});
        await markVerified(req.account.account_id,email);res.json({code:200,msg:'学生邮箱验证成功'});
    }));
    return {check,send};
};
