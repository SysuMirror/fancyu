'use strict';
// 通知中心 + Web Push。
//
// - 各业务模块在自己的事务里调用 record()「只写库」，绝不在事务里出网；
// - 出网推送统一由本模块的 60s tick 排水（user_notifications.push_sent_at IS NULL）；
// - 站内通知是主通道，Web Push 是尽力而为的增强（iOS 需先「添加到主屏」才能收到）。
const fs = require('fs');
const path = require('path');
const TABLES = { love: 'weekly_match_pairs', deep: 'deep_pairs', buddy: 'friend_card_pairs' };
const fail = (status, msg) => { throw Object.assign(Error(msg), { status }); };
const stamp = d => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
const KINDS = ['match', 'chat', 'exchange', 'deadline', 'batch'];

module.exports = function (app, { getPool, authMiddleware, now = () => new Date(), refresh = () => {} }) {
    let ready, running = false, lib;      // lib: undefined=未尝试 false=不可用 object=可用
    function ensureSchema() {
        if (!ready) ready = (async () => {
            const p = await getPool();
            for (const sql of fs.readFileSync(path.join(__dirname, 'notify-schema.sql'), 'utf8').split(';').map(x => x.trim()).filter(Boolean)) await p.query(sql);
        })().catch(e => { ready = null; throw e; });
        return ready;
    }

    /* ---------- VAPID 密钥（持久化在 .private/vapid.json，0600；重新生成会让既有订阅全部失效） ---------- */
    let keys;
    function vapid() {
        if (keys !== undefined) return keys;
        const file = path.join(__dirname, '..', '.private', 'vapid.json');
        try {
            if (fs.existsSync(file)) keys = JSON.parse(fs.readFileSync(file, 'utf8'));
            else if (pushLib()) {
                fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
                keys = pushLib().generateVAPIDKeys();
                fs.writeFileSync(file, JSON.stringify({ publicKey: keys.publicKey, privateKey: keys.privateKey }), { mode: 0o600 });
                console.log('[notify] 已生成新的 VAPID 密钥（指纹 ' + String(keys.publicKey).slice(-12) + '）');
            } else keys = null;
        } catch (e) { console.error('[notify] VAPID 密钥不可用：', e.code || e.name); keys = null; }
        return keys;
    }
    function pushLib() {
        if (lib === undefined) {
            try { lib = require('web-push'); } catch (e) { lib = false; console.warn('[notify] 未安装 web-push，浏览器推送已停用（站内通知不受影响）'); }
        }
        return lib || null;
    }

    /* ---------- 写入（供各模块在自己的事务内调用） ---------- */
    async function record(c, { account_id, kind, title, body = '', link = '', dedup_key }) {
        if (!account_id || !dedup_key) return;
        try {
            await c.execute('INSERT IGNORE INTO user_notifications(account_id,kind,title,body,link,dedup_key) VALUES (?,?,?,?,?,?)',
                [account_id, KINDS.includes(kind) ? kind : 'match', String(title).slice(0, 80), String(body).slice(0, 300), String(link).slice(0, 200), String(dedup_key).slice(0, 120)]);
        } catch (e) {
            // 通知只是辅助通道：缺表/约束异常不能影响主流程（例如模块先于 notify 建表运行）
            if (!/doesn't exist|no such table|Unknown table/i.test(e.message || '')) console.error('[notify] record:', e.code || e.name);
        }
    }
    // 同一会话 5 分钟内的多条新消息合并成一条通知
    const chatBucket = time => Math.floor(new Date(time).getTime() / 300000);

    /* ---------- 接口 ---------- */
    const route = fn => async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            await ensureSchema();
            const c = await (await getPool()).getConnection();
            try { res.json(Object.assign({ code: 200 }, await fn(req, c))); }
            finally { c.release(); }
        } catch (e) {
            console.error('Notify:', e.status || e.code || e.name);
            if (!res.headersSent) res.status(e.status || 503).json({ code: e.status || 503, msg: e.status ? e.message : '通知服务暂时不可用，请稍后重试' });
        }
    };

    app.get('/account/notifications', authMiddleware, route(async (req, c) => {
        const id = req.account.account_id;
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
        const before = req.query.before ? Number(req.query.before) : null;
        if (before !== null && (!Number.isSafeInteger(before) || before < 1)) fail(400, '分页参数无效');
        const [rows] = await c.execute(`SELECT id,kind,title,body,link,created_at,read_at FROM user_notifications WHERE account_id=? ${before ? 'AND id<?' : ''} ORDER BY id DESC LIMIT ${limit + 1}`,
            before ? [id, before] : [id]);
        const more = rows.length > limit;
        const list = rows.slice(0, limit).map(r => ({ ...r, read: !!r.read_at, read_at: undefined, created_at: new Date(r.created_at).toISOString() }));
        const [[{ unread }]] = await c.execute('SELECT COUNT(*) unread FROM user_notifications WHERE account_id=? AND read_at IS NULL', [id]);
        return { notifications: list, more, unread: Number(unread) };
    }));

    app.get('/account/notifications/unread-count', authMiddleware, route(async (req, c) => {
        const [[{ unread }]] = await c.execute('SELECT COUNT(*) unread FROM user_notifications WHERE account_id=? AND read_at IS NULL', [req.account.account_id]);
        return { unread: Number(unread) };
    }));

    app.post('/account/notifications/read', authMiddleware, route(async (req, c) => {
        const id = req.account.account_id, ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 200).map(Number).filter(x => Number.isSafeInteger(x) && x > 0) : [];
        if (!ids.length) fail(400, '请选择要标记的通知');
        await c.execute(`UPDATE user_notifications SET read_at=COALESCE(read_at,UTC_TIMESTAMP()) WHERE account_id=? AND id IN (${ids.map(() => '?').join(',')})`, [id, ...ids]);
        const [[{ unread }]] = await c.execute('SELECT COUNT(*) unread FROM user_notifications WHERE account_id=? AND read_at IS NULL', [id]);
        return { msg: '已标记为已读', unread: Number(unread) };
    }));

    app.post('/account/notifications/read-all', authMiddleware, route(async (req, c) => {
        const id = req.account.account_id;
        await c.execute('UPDATE user_notifications SET read_at=COALESCE(read_at,UTC_TIMESTAMP()) WHERE account_id=? AND read_at IS NULL', [id]);
        return { msg: '已全部标记为已读', unread: 0 };
    }));

    app.get('/account/push/vapid', authMiddleware, route(async () => {
        const k = vapid();
        return { enabled: !!(k && pushLib()), publicKey: k ? k.publicKey : null };
    }));

    app.post('/account/push/subscribe', authMiddleware, route(async (req, c) => {
        const id = req.account.account_id, sub = req.body?.subscription || req.body || {};
        const endpoint = String(sub.endpoint || ''), p256dh = String(sub.keys?.p256dh || ''), auth = String(sub.keys?.auth || '');
        if (!/^https:\/\//.test(endpoint) || endpoint.length > 400 || !p256dh || p256dh.length > 200 || !auth || auth.length > 64) fail(400, '推送订阅信息无效');
        await c.execute(`INSERT INTO user_push_subscriptions(account_id,endpoint,p256dh,auth,ua) VALUES (?,?,?,?,?)
            ON DUPLICATE KEY UPDATE account_id=VALUES(account_id),p256dh=VALUES(p256dh),auth=VALUES(auth),ua=VALUES(ua),fail_count=0`,
            [id, endpoint, p256dh, auth, String(req.headers['user-agent'] || '').slice(0, 200)]);
        return { msg: '已开启浏览器通知' };
    }));

    app.post('/account/push/unsubscribe', authMiddleware, route(async (req, c) => {
        const endpoint = String(req.body?.endpoint || '');
        if (!endpoint) fail(400, '缺少订阅信息');
        await c.execute('DELETE FROM user_push_subscriptions WHERE account_id=? AND endpoint=?', [req.account.account_id, endpoint]);
        return { msg: '已关闭浏览器通知' };
    }));

    /* ---------- 通知偏好（只影响浏览器推送；站内通知中心始终完整） ---------- */
    app.get('/account/notification-prefs', authMiddleware, route(async (req, c) => {
        const [rows] = await c.execute('SELECT kind,enabled FROM user_notification_prefs WHERE account_id=?', [req.account.account_id]);
        const saved = new Map(rows.map(r => [r.kind, !!r.enabled]));
        // 没存过的视为开启：新用户不该"默认收不到"
        return { prefs: KINDS.map(kind => ({ kind, enabled: saved.has(kind) ? saved.get(kind) : true })) };
    }));

    app.post('/account/notification-prefs', authMiddleware, route(async (req, c) => {
        const id = req.account.account_id, items = Array.isArray(req.body?.prefs) ? req.body.prefs.slice(0, 20) : [];
        if (!items.length) fail(400, '请提供要保存的通知偏好');
        let n = 0;
        for (const it of items) {
            const kind = String(it?.kind || '');
            if (!KINDS.includes(kind)) continue;
            await c.execute('INSERT INTO user_notification_prefs(account_id,kind,enabled) VALUES (?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled)', [id, kind, it.enabled ? 1 : 0]);
            n++;
        }
        if (!n) fail(400, '通知偏好无效');
        return { msg: '已保存通知偏好' };
    }));

    /* ---------- 排水：出网推送（绝不在事务里） ---------- */
    // 排水分三段，网络 I/O 期间不持有数据库连接（池只有 10 条，一个卡死的推送端点会把它们耗光）：
    //   ① 短连接取待推行 + 标记过期积压；② 无连接地出网；③ 短连接写回结果。
    async function drain() {
        const pool = await getPool();
        let rows = [], c;
        c = await pool.getConnection();
        try {
            [rows] = await c.query(`SELECT id,account_id,kind,title,body,link,created_at FROM user_notifications
                WHERE push_sent_at IS NULL AND created_at>DATE_SUB(UTC_TIMESTAMP(),INTERVAL 20 MINUTE) ORDER BY id LIMIT 200`);
            // 更早的历史积压不再补推，只做标记，避免上线后刷屏
            await c.query('UPDATE user_notifications SET push_sent_at=UTC_TIMESTAMP() WHERE push_sent_at IS NULL AND created_at<=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 20 MINUTE)');
        } finally { c.release(); }
        if (!rows.length) return 0;

        const p = pushLib(), k = p && vapid();
        const mark = rows.map(r => r.id);

        // 订阅一次性取全（原来每行一次 SELECT，是 200 次往返）；顺带把「关掉推送」的账号×类型取出来。
        const subsByAcc = new Map(), muted = new Set();
        if (p && k) {
            const ids = [...new Set(rows.map(r => r.account_id))];
            const ph = ids.map(() => '?').join(',');
            let sc = await pool.getConnection();
            try {
                const [subs] = await sc.query(`SELECT id,account_id,endpoint,p256dh,auth FROM user_push_subscriptions WHERE account_id IN (${ph}) AND fail_count<5`, ids);
                for (const s of subs) { if (!subsByAcc.has(s.account_id)) subsByAcc.set(s.account_id, []); subsByAcc.get(s.account_id).push(s); }
            } finally { sc.release(); }
            try {
                const [prefs] = await pool.query(`SELECT account_id,kind FROM user_notification_prefs WHERE enabled=0 AND account_id IN (${ph})`, ids);
                for (const r of prefs) muted.add(r.account_id + ':' + r.kind);
            } catch (e) { /* 偏好表还没建时按全开处理 */ }
        }

        let sent = 0;
        const ok = [], bad = [], dead = [];
        if (p && k) {
            for (const n of rows) {
                if (muted.has(n.account_id + ':' + n.kind)) continue;   // 用户关掉了这类推送：只留在通知中心
                const subs = subsByAcc.get(n.account_id) || [];
                if (!subs.length) continue;
                const payload = JSON.stringify({ title: n.title, body: n.body, url: n.link || '/notifications', kind: n.kind, id: n.id });
                const details = { vapidDetails: { subject: process.env.VAPID_SUBJECT || 'mailto:zhongyinidate@163.com', publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 86400, timeout: 10000 };
                for (const s of subs) {
                    try {
                        await p.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, details);
                        ok.push(s.id); sent++;
                    } catch (e) {
                        const code = e.statusCode || e.status;
                        if (code === 404 || code === 410) dead.push(s.id);
                        else bad.push(s.id);
                    }
                }
            }
        }

        c = await pool.getConnection();
        try {
            for (const id of dead) await c.execute('DELETE FROM user_push_subscriptions WHERE id=?', [id]);
            for (const id of ok) await c.execute('UPDATE user_push_subscriptions SET last_ok=UTC_TIMESTAMP(),fail_count=0 WHERE id=?', [id]);
            for (const id of bad) await c.execute('UPDATE user_push_subscriptions SET fail_count=fail_count+1 WHERE id=?', [id]);
            await c.query(`UPDATE user_notifications SET push_sent_at=UTC_TIMESTAMP() WHERE id IN (${mark.map(() => '?').join(',')})`, mark);
        } finally { c.release(); }
        return sent;
    }

    /* ---------- 待回应临近截止提醒（回应期还剩 6 小时内，同一配对本轮只提醒一次） ---------- */
    async function deadlines(c, time) {
        const soon = stamp(new Date(+time + 6 * 3600000)), from = stamp(time);
        const week = require('./friends-rules').weekDeadline;
        const jobs = [
            ['love', "SELECT id,a_id,b_id,expires_at AS at FROM weekly_match_pairs WHERE status='pending' AND expires_at>? AND expires_at<=?", [from, soon], '/weekly-match'],
            ['deep', null, [week(require('./friends-rules').weekKey(time))], '/deep'],
            ['buddy', null, [week(require('./friends-rules').weekKey(time))], '/friends']
        ];
        for (const [mode, sql, args, link] of jobs) {
            let rows = [];
            if (sql) [rows] = await c.execute(sql, args);
            else {
                const at = args[0], ms = at ? new Date(at).getTime() - (+time) : -1;
                if (!(ms > 0 && ms <= 6 * 3600000)) continue; // 只在该批回应期还剩 6 小时内提醒
                [rows] = await c.execute(`SELECT id,a_id,b_id FROM ${TABLES[mode]} WHERE status='pending' AND week_key=?`, [require('./friends-rules').weekKey(time)]);
            }
            for (const r of rows) for (const who of [r.a_id, r.b_id])
                await record(c, { account_id: who, kind: 'deadline', title: '还没回应本周推荐', body: '回应时间就要结束了，去 ' + (mode === 'love' ? '每周恋爱配对' : mode === 'deep' ? '深度交友' : '约个搭子') + ' 看看对方是否愿意认识。', link, dedup_key: `deadline:${mode}:${r.id}:${who}` });
        }
    }

    /* ---------- 发布闸门提醒（不改闸门语义：管理员未确认时只提醒，不自动发布） ---------- */
    async function gate() {
        for (const [mode, table, keyCol] of [['love', 'weekly_match_batches', 'batch_key'], ['deep', 'deep_batches', 'batch_key']]) {
            try {
                const p = await getPool();
                const [rows] = await p.query(`SELECT ${keyCol} AS key,revision,approved_revision,release_at,expires_at FROM ${table} WHERE status='preview' AND (approved_revision IS NULL OR approved_revision<>revision)`);
                for (const r of rows) {
                    const left = (new Date(r.release_at || r.expires_at).getTime() - now().getTime()) / 60000;
                    if (left < 180) console.warn(`[release-gate] ${mode} 批次 ${r.key} 预览尚未确认，距发布约 ${Math.round(Math.max(left, 0))} 分钟`);
                }
            } catch (e) { /* 表不存在或字段差异不影响主流程 */ }
        }
    }

    async function tick() {
        if (running) return;
        running = true;
        try {
            await ensureSchema();
            const c = await (await getPool()).getConnection();
            try { await deadlines(c, now()); } finally { c.release(); }
            await drain();          // drain 自管连接：出网期间不占用连接池
            await gate();
        } catch (e) { console.error('Notify scheduler:', e.status || e.code || e.name); }
        finally { running = false; }
    }

    function start() {
        const t = setInterval(() => tick(), 60000); t.unref();
        const f = setTimeout(() => tick(), 8000); f.unref();
        return () => { clearInterval(t); clearTimeout(f); };
    }

    return { ensureSchema, record, chatBucket, tick, start, refresh };
};
