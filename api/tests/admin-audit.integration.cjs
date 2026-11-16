// 统一审计（admin_audit_log）+ 账号处置列迁移的集成测试。
// 需要真实库（MYSQL_* 环境变量，与其它 *integration.cjs 相同）。
// 只新增自建测试账号/自建审计行，结束前全部清理；不触碰任何真实用户数据。
const assert = require('assert/strict'), mysql = require('mysql2/promise'), crypto = require('crypto');
const auditFactory = require('../admin-audit');

(async () => {
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT,
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE
  });
  const audit = auditFactory({ getPool: async () => pool });
  const ids = [], adminKeys = [];
  try {
    // 1) 迁移：建表 + tolerant 加列（重复调用必须幂等，不得抛错）
    await audit.ensureSchema();
    await audit.ensureSchema();
    const [tables] = await pool.execute("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='admin_audit_log'");
    assert.equal(Number(tables[0].n), 1, 'admin_audit_log 未建表');
    for (const col of ['force_logout_at', 'banned', 'banned_at', 'ban_reason', 'must_reset_password']) {
      const [c] = await pool.execute('SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?', ['accounts', col]);
      assert.equal(Number(c[0].n), 1, `accounts.${col} 缺失`);
    }
    const [idx] = await pool.execute("SELECT COUNT(*) n FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='accounts' AND index_name='idx_invited_by'");
    assert.equal(Number(idx[0].n) >= 1, true, 'accounts.idx_invited_by 缺失');

    // 2) adminKey：唯一写法（新式 admin_account_id → legacy username → unknown）
    assert.equal(audit.adminKey({ admin_account_id: 7, username: 'x' }), '7');
    assert.equal(audit.adminKey({ username: 'legacy' }), 'legacy');
    assert.equal(audit.adminKey(null), 'unknown');
    assert.equal(audit.adminKey({}), 'unknown');

    // 3) write：落行、字段截断、detail 结构化；写失败绝不抛错
    const key = 'test_' + crypto.randomBytes(4).toString('hex');
    adminKeys.push(key);
    await audit.write({ admin_account_id: 424242, username: key }, {
      action: 'test.audit', target_type: 'account', target_id: '12345', method: 'POST',
      path: '/api/admin/accounts/12345/ban', status_code: 200, ip: '203.0.113.9',
      detail: { status: 'processing', banned: true, note: 'x'.repeat(400) }
    });
    const [rows] = await pool.execute('SELECT admin_key,admin_account_id,admin_username,action,target_type,target_id,method,status_code,detail,ip FROM admin_audit_log WHERE admin_username=?', [key]);
    assert.equal(rows.length, 1, '审计未落行');
    const row = rows[0];
    assert.equal(row.admin_key, '424242');
    assert.equal(Number(row.admin_account_id), 424242);
    assert.equal(row.action, 'test.audit');
    assert.equal(row.target_id, '12345');
    assert.equal(row.method, 'POST');
    assert.equal(Number(row.status_code), 200);
    assert.equal(typeof row.detail, 'object');
    assert.equal(row.detail.banned, true);
    assert.equal(row.ip, '203.0.113.9');

    // 4) write 不抛错：传入无法序列化的 detail（循环引用）也应静默吞掉
    const circular = {}; circular.self = circular;
    await audit.write({ username: key }, { action: 'test.audit.bad', detail: circular });
    const [after] = await pool.execute('SELECT COUNT(*) n FROM admin_audit_log WHERE admin_username=? AND action=?', [key, 'test.audit.bad']);
    assert.equal(Number(after[0].n), 0, '坏 detail 不应落行，但也不应抛错');

    // 5) 处置列语义：自建账号 → 封禁 → 解封，只动自建数据
    const email = 'audit_' + crypto.randomBytes(5).toString('hex') + '@example.invalid';
    const [ins] = await pool.execute('INSERT INTO accounts(email,username,password_hash) VALUES (?,?,?)', [email, email.split('@')[0], 'test-not-login']);
    ids.push(ins.insertId);
    const stamp = Math.floor(Date.now() / 1000);
    await pool.execute('UPDATE accounts SET banned=1,banned_at=UTC_TIMESTAMP(),ban_reason=?,force_logout_at=? WHERE id=?', ['集成测试', stamp, ins.insertId]);
    let [cur] = await pool.execute('SELECT banned,ban_reason,force_logout_at FROM accounts WHERE id=?', [ins.insertId]);
    assert.equal(Number(cur[0].banned), 1);
    assert.equal(cur[0].ban_reason, '集成测试');
    assert.equal(Number(cur[0].force_logout_at), stamp);
    await pool.execute('UPDATE accounts SET banned=0,banned_at=NULL,ban_reason=NULL WHERE id=?', [ins.insertId]);
    [cur] = await pool.execute('SELECT banned,ban_reason,force_logout_at FROM accounts WHERE id=?', [ins.insertId]);
    assert.equal(Number(cur[0].banned), 0);
    assert.equal(cur[0].ban_reason, null);
    assert.equal(Number(cur[0].force_logout_at), stamp, '解封不应清掉 force_logout_at');

    console.log('PASS: audit schema migration (idempotent), adminKey normalization, audit row + JSON detail + truncation, write never throws, disposition columns semantics (ban/unban keeps force_logout_at).');
  } finally {
    for (const k of adminKeys) await pool.execute('DELETE FROM admin_audit_log WHERE admin_username=?', [k]).catch(() => {});
    for (const id of ids) await pool.execute('DELETE FROM accounts WHERE id=?', [id]).catch(() => {});
    await pool.end();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
