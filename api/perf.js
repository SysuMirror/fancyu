'use strict';
// 增量索引迁移：只加索引，绝不改结构，属于可安全重跑的加法迁移。
//
// MySQL 没有 CREATE INDEX IF NOT EXISTS，所以逐条执行、按错误码跳过：
//   1061 ER_DUP_KEYNAME   → 索引已存在（正常，重复部署时必然命中）
//   1146 ER_NO_SUCH_TABLE → 表还没建（模块先于本模块运行），下次部署再补
// 其余错误只记日志，不阻断启动（索引缺失只影响性能，不该让服务起不来）。
const INDEXES = [
    // 通知排水：每 60s 扫 push_sent_at IS NULL，没有索引就是全表扫
    ['user_notifications', 'idx_push_sent_at', 'user_notifications(push_sent_at)'],
    // 报名 / 深度条目按账号查（PK 分别是 (batch_key,account_id) 和 (batch_key,card_id)，账号维度用不上）
    ['weekly_match_enrollments', 'idx_wme_account', 'weekly_match_enrollments(account_id)'],
    ['deep_entries', 'idx_deep_entries_account', 'deep_entries(account_id)'],
    // 按周查待回应的 pair（截止提醒用 week_key）
    ['deep_slots', 'idx_deep_slots_week', 'deep_slots(week_key)'],
    // 配对表的反向列顺序：原来的 (a_id,b_id) 只覆盖 OR 的一半，补 (b_id,a_id) 让两条都能走索引
    ['weekly_match_pairs', 'idx_wmp_ba', 'weekly_match_pairs(b_id,a_id)'],
    ['deep_pairs', 'idx_deep_ba', 'deep_pairs(b_id,a_id)'],
    ['friend_card_pairs', 'idx_fcp_ba', 'friend_card_pairs(b_id,a_id)']
];

module.exports = function ({ getPool }) {
    let ready;
    function ensureIndexes() {
        if (!ready) ready = (async () => {
            const p = await getPool();
            let added = 0;
            for (const [, name, target] of INDEXES) {
                try {
                    await p.query(`CREATE INDEX ${name} ON ${target}`);
                    added++;
                } catch (e) {
                    if (e.errno !== 1061 && e.errno !== 1146) console.error('[perf] 建索引失败', name, e.code || e.name);
                }
            }
            if (added) console.log(`[perf] 新增索引 ${added} 个`);
        })().catch(e => { ready = null; throw e; });
        return ready;
    }
    return { ensureIndexes };
};
