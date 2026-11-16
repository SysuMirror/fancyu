'use strict';
// 后台统一审计（DB 表 admin_audit_log）+ 账号处置所需的列迁移。
//
// 约定：
//  - write() 永不抛错、永不阻断业务（审计失败只打一行日志）；调用点放在业务事务提交之后。
//  - 管理员标识只此一种写法：adminKey(req.admin) = admin_account_id（新式）→ username（legacy）→ 'unknown'。
//  - detail 只放 id / 状态 / 计数等结构化摘要，禁止放密码、验证码、token、正文。
// 与既有三份 JSONL 的关系：JSONL 全部保留（AI 查询路径一行不改，只能靠 JSONL 留痕）；
// 联系方式查看、聊天举报核查这两处同时双写一条 DB 记录。

const MAX = { action: 64, target_type: 24, target_id: 64, path: 255, admin_key: 120 };

function adminKey(admin) {
  if (!admin) return 'unknown';
  if (admin.admin_account_id !== undefined && admin.admin_account_id !== null) return String(admin.admin_account_id);
  if (admin.username) return String(admin.username);
  return 'unknown';
}

module.exports = function ({ getPool }) {
  let ready;
  function ensureSchema() {
    if (!ready) ready = (async () => {
      const p = await getPool();
      await p.query(`CREATE TABLE IF NOT EXISTS admin_audit_log (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        admin_key VARCHAR(120) NOT NULL,
        admin_account_id INT NULL,
        admin_username VARCHAR(120) NULL,
        action VARCHAR(64) NOT NULL,
        target_type VARCHAR(24) NULL,
        target_id VARCHAR(64) NULL,
        method VARCHAR(8) NULL,
        path VARCHAR(255) NULL,
        status_code INT NULL,
        detail JSON NULL,
        ip VARCHAR(45) NULL,
        INDEX idx_at (at),
        INDEX idx_admin (admin_key, at),
        INDEX idx_target (target_type, target_id, at),
        INDEX idx_action (action, at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      // accounts：账号处置列。force_logout_at 存 UTC epoch 秒（与 JWT 的 iat 同源），刻意不用 TIMESTAMP 以绕开会话时区。
      const addCol = async (table, col, def) => {
        try { await p.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
        catch (e) { if (!/Duplicate|already/i.test(e.message || '')) throw e; }
      };
      await addCol('accounts', 'force_logout_at', 'BIGINT UNSIGNED NULL DEFAULT NULL');
      await addCol('accounts', 'banned', 'TINYINT(1) NOT NULL DEFAULT 0');
      await addCol('accounts', 'banned_at', 'TIMESTAMP NULL DEFAULT NULL');
      await addCol('accounts', 'ban_reason', 'VARCHAR(255) NULL');
      await addCol('accounts', 'must_reset_password', 'TINYINT(1) NOT NULL DEFAULT 0');
      // complaints 的处置留痕列（handled_by / handled_at）由 index.js 的 ensureComplaintTable 负责，
      // 那里既有建表也有容错补列——此处不重复 ALTER，避免在 complaints 尚未建表时把迁移整体带失败。
      // 邀请增长看板要按被邀请人聚合
      try { await p.query('ALTER TABLE accounts ADD INDEX idx_invited_by (invited_by)'); }
      catch (e) { if (!/Duplicate|already|Duplicate key name/i.test(e.message || '')) { /* 索引失败不影响功能 */ } }
    })().catch(e => { ready = null; throw e; });
    return ready;
  }

  const clip = (v, n) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, n));

  async function write(admin, meta = {}) {
    try {
      await ensureSchema();
      const p = await getPool();
      const detail = meta.detail === undefined || meta.detail === null ? null : JSON.stringify(meta.detail);
      await p.execute(
        `INSERT INTO admin_audit_log(admin_key,admin_account_id,admin_username,action,target_type,target_id,method,path,status_code,detail,ip)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [clip(adminKey(admin), MAX.admin_key),
         admin && admin.admin_account_id != null ? Number(admin.admin_account_id) : null,
         clip(admin && admin.username, MAX.admin_key),
         clip(meta.action, MAX.action) || 'unknown',
         clip(meta.target_type, MAX.target_type),
         clip(meta.target_id, MAX.target_id),
         clip(meta.method, 8),
         clip(meta.path, MAX.path),
         meta.status_code != null ? Number(meta.status_code) : null,
         detail,
         clip(meta.ip, 45)]);
    } catch (e) { console.error('Audit write:', e.code || e.name || e.message); }
  }

  return { ensureSchema, write, adminKey };
};
module.exports.adminKey = adminKey;
