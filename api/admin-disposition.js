'use strict';
// 账号处置（管理员）：封禁 / 解封 / 强制下线 / 重置密码 / 重发学邮验证。
//
// 生效机制（不改 token 结构、不建 token 表、不动 security_version）：
//  - 封禁：accounts.banned=1，由 authMiddleware 每请求拦截（403, banned:true）+ /account/login 拦截。
//  - 强制下线：accounts.force_logout_at = 当前 UTC epoch 秒；authMiddleware 比较 JWT 自带的 iat
//    （同为 UTC 秒）——iat < force_logout_at 的旧 token 一律失效，重新登录即可拿到新 token。
//  - 重置密码：默认走"发重置验证码 + 作废旧密码"，不发明文密码；也可由管理员直接指定新密码。
//
// 每个动作都落 admin_audit_log（写失败不阻断业务）。

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const nowSec = () => Math.floor(Date.now() / 1000);

module.exports = function (app, { getPool, adminAuthMiddleware, audit, secureAuth }) {
  const route = fn => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) return res.status(400).json({ code: 400, msg: '账号编号无效' });
    try { await fn(req, res, Number(req.params.id)); }
    catch (e) { console.error('Admin disposition:', e.code || e.name); if (!res.headersSent) res.status(503).json({ code: 503, msg: '处置失败，请稍后重试' }); }
  };
  const auditIt = (req, action, id, detail, ok = true) => audit.write(req.admin, {
    action, target_type: 'account', target_id: id, method: req.method, path: req.originalUrl,
    status_code: ok ? 200 : 400, detail, ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || null
  });
  const findAccount = async (p, id) => {
    const [rows] = await p.execute('SELECT id,username,email,banned FROM accounts WHERE id=?', [id]);
    return rows[0] || null;
  };

  // 当前处置状态（只读，供后台弹窗显示按钮文案；不含任何联系方式）
  app.get('/admin/accounts/:id/state', adminAuthMiddleware, route(async (req, res, id) => {
    const p = await getPool();
    const [rows] = await p.execute('SELECT banned,banned_at,ban_reason,must_reset_password,force_logout_at FROM accounts WHERE id=?', [id]);
    const a = rows[0];
    if (!a) return res.status(404).json({ code: 404, msg: '账号不存在' });
    return res.json({ code: 200, banned: !!a.banned, banned_at: a.banned_at, ban_reason: a.ban_reason, must_reset_password: !!a.must_reset_password, force_logout_at: a.force_logout_at ? Number(a.force_logout_at) : null });
  }));

  // 封禁（幂等）
  app.post('/admin/accounts/:id/ban', adminAuthMiddleware, route(async (req, res, id) => {
    const p = await getPool();
    const a = await findAccount(p, id);
    if (!a) { auditIt(req, 'account.ban', id, { result: 'not_found' }, false); return res.status(404).json({ code: 404, msg: '账号不存在' }); }
    const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 255) : null;
    const wasBanned = !!a.banned;
    await p.execute('UPDATE accounts SET banned=1, banned_at=UTC_TIMESTAMP(), ban_reason=?, force_logout_at=? WHERE id=?', [reason, nowSec(), id]);
    auditIt(req, 'account.ban', id, { username: a.username, reason, idempotent: wasBanned });
    return res.json({ code: 200, msg: wasBanned ? '该账号此前已被封禁' : '已封禁并下线该账号的所有登录状态', force_logged_out: true });
  }));

  // 解封（不动 force_logout_at，用户重新登录即可）
  app.post('/admin/accounts/:id/unban', adminAuthMiddleware, route(async (req, res, id) => {
    const p = await getPool();
    const a = await findAccount(p, id);
    if (!a) { auditIt(req, 'account.unban', id, { result: 'not_found' }, false); return res.status(404).json({ code: 404, msg: '账号不存在' }); }
    await p.execute('UPDATE accounts SET banned=0, banned_at=NULL, ban_reason=NULL WHERE id=?', [id]);
    auditIt(req, 'account.unban', id, { username: a.username });
    return res.json({ code: 200, msg: '已解封，用户可重新登录' });
  }));

  // 强制下线（不封禁，只让现有 token 失效）
  app.post('/admin/accounts/:id/force-logout', adminAuthMiddleware, route(async (req, res, id) => {
    const p = await getPool();
    const a = await findAccount(p, id);
    if (!a) { auditIt(req, 'account.force_logout', id, { result: 'not_found' }, false); return res.status(404).json({ code: 404, msg: '账号不存在' }); }
    await p.execute('UPDATE accounts SET force_logout_at=? WHERE id=?', [nowSec(), id]);
    auditIt(req, 'account.force_logout', id, { username: a.username });
    return res.json({ code: 200, msg: '已强制下线，该账号需重新登录', force_logged_out: true });
  }));

  // 重置密码：默认发重置验证码并作废旧密码（不在邮件里发明文密码）；也可显式指定新密码
  app.post('/admin/accounts/:id/reset-password', adminAuthMiddleware, route(async (req, res, id) => {
    const p = await getPool();
    const a = await findAccount(p, id);
    if (!a) { auditIt(req, 'account.reset_password', id, { result: 'not_found' }, false); return res.status(404).json({ code: 404, msg: '账号不存在' }); }
    const explicit = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (explicit) {
      if (explicit.length < 8 || explicit.length > 72) {
        auditIt(req, 'account.reset_password', id, { mode: 'explicit', result: 'invalid_password' }, false);
        return res.status(400).json({ code: 400, msg: '密码需为 8–72 位' });
      }
      await p.execute('UPDATE accounts SET password_hash=?, must_reset_password=0, force_logout_at=? WHERE id=?', [await bcrypt.hash(explicit, 10), nowSec(), id]);
      auditIt(req, 'account.reset_password', id, { mode: 'explicit' });
      return res.json({ code: 200, msg: '已设置新密码，该账号需重新登录', force_logged_out: true });
    }
    // 邮件通道：先发码，发不出去就一个字节都不改（避免把用户锁死）
    const sent = await secureAuth.send(a.email, 'reset');
    if (!sent || sent.code !== 200) {
      auditIt(req, 'account.reset_password', id, { mode: 'email', result: 'send_failed', upstream_code: sent && sent.code }, false);
      return res.status(sent && sent.code ? sent.code : 503).json({ code: sent && sent.code ? sent.code : 503, msg: (sent && sent.msg) || '重置验证码发送失败' });
    }
    const scrambled = crypto.randomBytes(24).toString('hex').slice(0, 40);
    await p.execute('UPDATE accounts SET password_hash=?, must_reset_password=1, force_logout_at=? WHERE id=?', [await bcrypt.hash(scrambled, 10), nowSec(), id]);
    auditIt(req, 'account.reset_password', id, { mode: 'email' });
    return res.json({ code: 200, msg: '重置验证码已发送到该账号邮箱，旧密码已作废并已下线', force_logged_out: true });
  }));

  // 重发学邮验证码（与用户自助「学生邮箱验证」同一用途）
  app.post('/admin/accounts/:id/resend-verification', adminAuthMiddleware, route(async (req, res, id) => {
    const p = await getPool();
    const a = await findAccount(p, id);
    if (!a) { auditIt(req, 'account.resend_verification', id, { result: 'not_found' }, false); return res.status(404).json({ code: 404, msg: '账号不存在' }); }
    const sent = await secureAuth.send(a.email, 'daily');
    auditIt(req, 'account.resend_verification', id, { upstream_code: sent && sent.code });
    return res.status(sent && sent.code ? sent.code : 503).json({ code: sent && sent.code ? sent.code : 503, msg: (sent && sent.msg) || '验证码发送失败' });
  }));
};
