'use strict';
// 三线「历史连接」归档：只读列表，已脱敏（不含任何联系方式），不带可操作按钮。
// 结束时间从既有字段推导（连接时间 → 回应期/周截止 → 创建时间），不新增列、不改既有状态判定。
const TABLES = { love: 'weekly_match_pairs', deep: 'deep_pairs', buddy: 'friend_card_pairs' };
const REASON = { expired: '回应期已结束', closed: '已结束连接', skipped: '已跳过', cancelled: '已退出或撤回', blocked: '已屏蔽', missed: '本批未发布' };
const ENDED = { love: p => p.connected_at || p.expires_at || p.created_at, deep: p => p.connected_at || p.created_at, buddy: p => p.created_at };

module.exports = async function history(c, id, mode, limit = 50) {
    const table = TABLES[mode];
    if (!table) return [];
    const n = Math.min(100, Math.max(1, Number(limit) || 50));
    const [rows] = await c.execute(`SELECT * FROM ${table} WHERE (a_id=? OR b_id=?) AND status NOT IN ('pending','connected') ORDER BY id DESC LIMIT ${n}`, [id, id]);
    if (!rows.length) return [];
    const others = [...new Set(rows.map(r => (r.a_id === id ? r.b_id : r.a_id)))].filter(x => x != null);
    if (!others.length) return [];
    const [names] = await c.execute(`SELECT id,username FROM accounts WHERE id IN (${others.map(() => '?').join(',')})`, others);
    const nameMap = new Map(names.map(x => [x.id, x.username]));
    return rows.map(r => {
        const other = r.a_id === id ? r.b_id : r.a_id;
        const t = (ENDED[mode] || (p => p.created_at))(r) || r.created_at;
        return {
            id: r.id, mode, status: r.status, reason: REASON[r.status] || '已结束',
            batch: r.batch_key || r.week_key || null,
            name: nameMap.get(other) || '对方',
            ended_at: t ? new Date(t).toISOString() : null
        };
    });
};
