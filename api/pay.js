'use strict';
/**
 * 通用支付接入模块（sysudate 作为 consumer）。
 *
 * 设计：价格由本应用后台自定义（pay_items 表），下单时服务端到服务端调用
 * 学人汇「通用开放支付」接口（HMAC 签名），拿到小程序支付入口（URL Link / Scheme），
 * 用户在小程序内完成微信支付；支付结果由学人汇签名回调本模块 /pay/notify。
 * **小程序侧无需任何改动。**
 *
 * 用法（在 index.js 中）：require('./pay')(app, {getPool, authMiddleware, adminAuthMiddleware});
 *
 * 凭据读取顺序：环境变量 → .private/pay.json（{app_id, app_secret, api_base, notify_url, return_url}）
 *   PAY_API_BASE   学人汇开放支付基址（默认 https://fhapi.thinkerhui.top/api/v1/pay/open）
 *   PAY_APP_ID     应用 ID（默认 sysudate）
 *   PAY_APP_SECRET 应用密钥（HMAC，必需）
 *   PAY_NOTIFY_URL 回调地址（默认 https://ssemarket.cn:23028/api/pay/notify）
 *   PAY_RETURN_URL 支付后返回页（可选）
 *
 * 对外路由（都带 /api 前缀）：
 *   用户端  GET  /pay/items                 商品列表
 *           POST /pay/create                下单 {item_key, resource_id?}
 *           GET  /pay/order/:outTradeNo     查单（仅限本人订单）
 *           GET  /pay/orders                我的订单
 *           GET  /pay/entitlements          我的权益（含名称/有效期/是否有效）
 *           GET  /pay/check?item_key=&resource_id=   权益校验
 *           POST /pay/notify                支付回调（HMAC 验签，学人汇调用）
 *   管理端  GET/POST /pay/admin/items       商品与价格
 *           POST /pay/admin/items/:key/delete  下架
 *           GET  /pay/admin/orders          订单列表
 *           GET  /pay/admin/stats           收入概览
 */
const crypto = require('crypto');
const fs = require('fs');
const nodePath = require('path');

function loadPrivateConfig() {
    try {
        return JSON.parse(fs.readFileSync(nodePath.join(__dirname, '..', '.private', 'pay.json'), 'utf8'));
    } catch { return {}; }
}

module.exports = function payModule(app, ctx) {
    const { getPool, authMiddleware, adminAuthMiddleware } = ctx;
    const FILE_CFG = loadPrivateConfig();

    const PAY_API_BASE = (process.env.PAY_API_BASE || FILE_CFG.api_base || 'https://fhapi.thinkerhui.top/api/v1/pay/open').replace(/\/$/, '');
    const PAY_APP_ID = process.env.PAY_APP_ID || FILE_CFG.app_id || 'sysudate';
    const PAY_APP_SECRET = process.env.PAY_APP_SECRET || FILE_CFG.app_secret || '';
    const PAY_NOTIFY_URL = process.env.PAY_NOTIFY_URL || FILE_CFG.notify_url || 'https://ssemarket.cn:23028/api/pay/notify';
    const PAY_RETURN_URL = process.env.PAY_RETURN_URL || FILE_CFG.return_url || '';

    const CREATE_PATH = '/api/v1/pay/open/orders';
    const NOTIFY_PATH = (() => {
        try { return new URL(PAY_NOTIFY_URL).pathname; } catch { return '/api/pay/notify'; }
    })();

    // ---------- HMAC-SHA256（与学人汇 open_pay_sign.py 一致）----------
    function signature(secret, method, reqPath, ts, nonce, bodyBuf) {
        const digest = crypto.createHash('sha256').update(bodyBuf || Buffer.alloc(0)).digest('hex');
        const canon = [method.toUpperCase(), reqPath, String(ts), nonce, digest].join('\n');
        return crypto.createHmac('sha256', secret).update(canon).digest('hex');
    }
    function verifySignature(secret, method, reqPath, ts, nonce, bodyBuf, sig) {
        const expected = signature(secret, method, reqPath, ts, nonce, bodyBuf);
        const a = Buffer.from(expected), b = Buffer.from(String(sig || '').toLowerCase());
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    function signedHeaders(method, reqPath, bodyBuf) {
        const ts = String(Math.floor(Date.now() / 1000));
        const nonce = crypto.randomBytes(8).toString('hex');
        return {
            'Content-Type': 'application/json',
            'X-App-Id': PAY_APP_ID,
            'X-Timestamp': ts,
            'X-Nonce': nonce,
            'X-Signature': signature(PAY_APP_SECRET, method, reqPath, ts, nonce, bodyBuf),
        };
    }

    async function callOpenApi(method, reqPath, payload) {
        if (!PAY_APP_SECRET) throw new Error('未配置 PAY_APP_SECRET');
        const bodyBuf = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload), 'utf8');
        const res = await fetch(PAY_API_BASE + reqPath.replace(/^\/api\/v1\/pay\/open/, ''), {
            method,
            headers: signedHeaders(method, reqPath, bodyBuf),
            body: payload === undefined ? undefined : bodyBuf,
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        if (!res.ok) {
            const msg = (json && (json.detail || json.msg)) || ('开放支付接口错误 ' + res.status);
            const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
            err.status = res.status;
            throw err;
        }
        return json;
    }

    // ---------- schema ----------
    let schemaReady = null;
    async function columnExists(pool, table, col) {
        const [r] = await pool.execute(
            'SELECT COUNT(*) c FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?',
            [table, col]);
        return Number(r[0].c) > 0;
    }
    async function ensureColumn(pool, table, col, ddl) {
        if (!(await columnExists(pool, table, col))) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
    async function ensureSchema() {
        if (!schemaReady) {
            schemaReady = (async () => {
                const pool = await getPool();
                await pool.query(`CREATE TABLE IF NOT EXISTS pay_items (
                    item_key VARCHAR(64) PRIMARY KEY,
                    title VARCHAR(128) NOT NULL,
                    amount_cents INT NOT NULL,
                    description VARCHAR(255) NULL,
                    duration_days INT NULL,
                    is_active TINYINT(1) NOT NULL DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
                await pool.query(`CREATE TABLE IF NOT EXISTS pay_orders (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    out_trade_no VARCHAR(64) NOT NULL UNIQUE,
                    fs_order_no VARCHAR(64) NULL,
                    item_key VARCHAR(64) NOT NULL,
                    subject VARCHAR(128) NULL,
                    amount_cents INT NOT NULL,
                    account_id INT NULL,
                    username VARCHAR(64) NULL,
                    resource_id VARCHAR(160) NULL,
                    status VARCHAR(16) NOT NULL DEFAULT 'pending',
                    transaction_id VARCHAR(64) NULL,
                    paid_at TIMESTAMP NULL,
                    raw_notify TEXT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_status (status),
                    INDEX idx_account (account_id, created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
                await pool.query(`CREATE TABLE IF NOT EXISTS pay_entitlements (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    account_id INT NOT NULL,
                    item_key VARCHAR(64) NOT NULL,
                    resource_id VARCHAR(160) NULL,
                    out_trade_no VARCHAR(64) NOT NULL,
                    expires_at TIMESTAMP NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY uniq_ent (out_trade_no, item_key),
                    INDEX idx_acc_item (account_id, item_key)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
                // 兼容已存在的旧表
                await ensureColumn(pool, 'pay_items', 'duration_days', 'duration_days INT NULL');
                await ensureColumn(pool, 'pay_entitlements', 'expires_at', 'expires_at TIMESTAMP NULL');
            })().catch(e => { schemaReady = null; throw e; });
        }
        return schemaReady;
    }

    app.use(['/pay/items', '/pay/create', '/pay/order', '/pay/orders', '/pay/entitlements', '/pay/check', '/pay/admin'],
        async (req, res, next) => {
            try { await ensureSchema(); next(); } catch (e) { res.status(503).json({ code: 503, msg: '支付服务暂不可用' }); }
        });

    const accOf = req => (req.account && req.account.account_id) || null;

    // ---------- 用户端 ----------
    app.get('/pay/items', async (req, res) => {
        try {
            const pool = await getPool();
            const [rows] = await pool.query('SELECT item_key, title, amount_cents, description, duration_days FROM pay_items WHERE is_active=1 ORDER BY amount_cents ASC');
            res.json({ code: 200, items: rows.map(r => ({ key: r.item_key, title: r.title, amount_cents: r.amount_cents, description: r.description, duration_days: r.duration_days })) });
        } catch (e) { res.status(500).json({ code: 500, msg: '读取商品失败' }); }
    });

    app.post('/pay/create', authMiddleware, async (req, res) => {
        try {
            const itemKey = String((req.body && req.body.item_key) || '').trim();
            const resourceId = req.body && req.body.resource_id ? String(req.body.resource_id).slice(0, 160) : null;
            if (!itemKey) return res.status(400).json({ code: 400, msg: '缺少 item_key' });
            const pool = await getPool();
            const [items] = await pool.execute('SELECT * FROM pay_items WHERE item_key=? AND is_active=1', [itemKey]);
            if (!items.length) return res.status(404).json({ code: 404, msg: '商品不存在或已下架' });
            const item = items[0];

            const accountId = accOf(req);
            let username = null;
            if (accountId) {
                const [a] = await pool.execute('SELECT username FROM accounts WHERE id=?', [accountId]);
                if (a.length) username = a[0].username;
            }
            let outTradeNo = req.body && req.body.out_trade_no ? String(req.body.out_trade_no).slice(0, 64) : '';
            if (outTradeNo) {
                if (!/^[A-Za-z0-9_-]{6,64}$/.test(outTradeNo)) return res.status(400).json({ code: 400, msg: 'out_trade_no 非法' });
                const [exist] = await pool.execute('SELECT * FROM pay_orders WHERE out_trade_no=?', [outTradeNo]);
                if (exist.length) {
                    // 幂等：已存在则直接复用（仅限本人）
                    const o = exist[0];
                    if (o.account_id !== accountId) return res.status(409).json({ code: 409, msg: '订单号已被占用' });
                    return res.json({ code: 200, out_trade_no: o.out_trade_no, amount_cents: o.amount_cents, currency: 'CNY', subject: o.subject, short_url: '', scheme_url: '', reused: true });
                }
            } else {
                outTradeNo = 'SD' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
            }

            const payload = {
                amount_cents: item.amount_cents,
                subject: item.title,
                out_trade_no: outTradeNo,
                resource_id: resourceId || undefined,
                return_url: PAY_RETURN_URL || undefined,
                extra: { item_key: itemKey, account_id: accountId, username },
            };
            const r = await callOpenApi('POST', CREATE_PATH, payload);

            await pool.execute(
                `INSERT INTO pay_orders (out_trade_no, fs_order_no, item_key, subject, amount_cents, account_id, username, resource_id, status)
                 VALUES (?,?,?,?,?,?,?,?, 'pending')`,
                [outTradeNo, r.order_no || null, itemKey, item.title, item.amount_cents, accountId, username, resourceId]);

            res.json({
                code: 200, out_trade_no: outTradeNo, amount_cents: item.amount_cents, currency: 'CNY',
                subject: item.title, short_url: r.short_url || '', scheme_url: r.scheme_url || '',
            });
        } catch (e) {
            console.error('[pay] create failed:', e.message);
            res.status(e.status && e.status < 600 ? e.status : 500).json({ code: 500, msg: '下单失败：' + e.message });
        }
    });

    // 仅允许本人查询自己的订单（管理员用 /pay/admin/orders）
    async function fetchOrder(pool, outTradeNo, accountId) {
        const [rows] = await pool.execute('SELECT * FROM pay_orders WHERE out_trade_no=? AND account_id<=>?', [outTradeNo, accountId]);
        return rows[0] || null;
    }

    app.get('/pay/order/:outTradeNo', authMiddleware, async (req, res) => {
        try {
            const pool = await getPool();
            const accountId = accOf(req);
            let order = await fetchOrder(pool, req.params.outTradeNo, accountId);
            if (!order) return res.status(404).json({ code: 404, msg: '订单不存在' });
            if (order.status !== 'paid') {
                try {
                    const r = await callOpenApi('GET', '/api/v1/pay/open/orders/' + encodeURIComponent(order.out_trade_no));
                    if (r && r.paid) {
                        await settlePaid(order.out_trade_no, r.transaction_id || null, { source: 'status_poll', amount_cents: r.amount_cents });
                        order = await fetchOrder(pool, req.params.outTradeNo, accountId);
                    }
                } catch (e) { /* 回源失败不阻断 */ }
            }
            res.json({ code: 200, order: {
                out_trade_no: order.out_trade_no, item_key: order.item_key, subject: order.subject,
                amount_cents: order.amount_cents, status: order.status,
                paid: order.status === 'paid', transaction_id: order.transaction_id, paid_at: order.paid_at } });
        } catch (e) { res.status(500).json({ code: 500, msg: '查单失败' }); }
    });

    app.get('/pay/orders', authMiddleware, async (req, res) => {
        try {
            const accountId = accOf(req);
            if (!accountId) return res.json({ code: 200, orders: [] });
            const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
            const pool = await getPool();
            const [rows] = await pool.execute(
                'SELECT out_trade_no, item_key, subject, amount_cents, status, paid_at, created_at FROM pay_orders WHERE account_id=? ORDER BY id DESC LIMIT ' + limit,
                [accountId]);
            res.json({ code: 200, orders: rows });
        } catch (e) { res.status(500).json({ code: 500, msg: '读取订单失败' }); }
    });

    app.get('/pay/entitlements', authMiddleware, async (req, res) => {
        try {
            const accountId = accOf(req);
            if (!accountId) return res.json({ code: 200, entitlements: [] });
            const pool = await getPool();
            const [rows] = await pool.execute(
                `SELECT e.item_key, e.resource_id, e.out_trade_no, e.expires_at, e.created_at, i.title
                 FROM pay_entitlements e LEFT JOIN pay_items i ON i.item_key=e.item_key
                 WHERE e.account_id=? ORDER BY e.id DESC LIMIT 100`, [accountId]);
            const now = Date.now();
            res.json({ code: 200, entitlements: rows.map(r => ({
                item_key: r.item_key, title: r.title || r.item_key, resource_id: r.resource_id,
                out_trade_no: r.out_trade_no, expires_at: r.expires_at, created_at: r.created_at,
                valid: !r.expires_at || new Date(r.expires_at).getTime() > now,
            })) });
        } catch (e) { res.status(500).json({ code: 500, msg: '读取权益失败' }); }
    });

    // 权益校验：其他页面可直接调用判断「某用户是否已购买/是否仍有效」
    app.get('/pay/check', authMiddleware, async (req, res) => {
        try {
            const itemKey = String(req.query.item_key || '').trim();
            const resourceId = req.query.resource_id ? String(req.query.resource_id).slice(0, 160) : null;
            const accountId = accOf(req);
            if (!itemKey || !accountId) return res.json({ code: 200, entitled: false, item_key: itemKey });
            const pool = await getPool();
            const [rows] = await pool.execute(
                `SELECT expires_at FROM pay_entitlements WHERE account_id=? AND item_key=? ${resourceId ? 'AND resource_id<=>?' : ''} ORDER BY id DESC LIMIT 1`,
                resourceId ? [accountId, itemKey, resourceId] : [accountId, itemKey]);
            const top = rows[0];
            const valid = !!top && (!top.expires_at || new Date(top.expires_at).getTime() > Date.now());
            res.json({ code: 200, entitled: valid, item_key: itemKey, resource_id: resourceId, expires_at: top ? top.expires_at : null });
        } catch (e) { res.status(500).json({ code: 500, msg: '权益校验失败' }); }
    });

    // ---------- 支付结果回调（学人汇 → 本应用；HMAC 验签）----------
    app.post('/pay/notify', async (req, res) => {
        try {
            // 必须使用原始字节验签（与学人汇签名逐字节一致）；req.rawBody 由 express.json 的 verify 捕获。
            const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody
                : (Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ? JSON.stringify(req.body) : '', 'utf8'));
            const ts = req.headers['x-timestamp'], nonce = req.headers['x-nonce'], sig = req.headers['x-signature'], appId = req.headers['x-app-id'];
            if (!ts || !nonce || !sig || appId !== PAY_APP_ID) return res.status(401).json({ code: 401, msg: '验签失败' });
            if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(ts, 10)) > 300) return res.status(401).json({ code: 401, msg: '回调已过期' });
            if (!verifySignature(PAY_APP_SECRET, 'POST', NOTIFY_PATH, ts, nonce, raw, sig)) return res.status(401).json({ code: 401, msg: '验签失败' });

            const data = JSON.parse(raw.toString('utf8'));
            if (data.event !== 'payment.succeeded') return res.json({ code: 200, msg: 'ignored' });
            await ensureSchema();
            await settlePaid(data.out_trade_no, data.transaction_id || null, data);
            res.json({ code: 200, msg: 'ok' });
        } catch (e) {
            console.error('[pay] notify failed:', e.message);
            res.status(500).json({ code: 500, msg: '回调处理失败' });
        }
    });

    async function settlePaid(outTradeNo, transactionId, raw) {
        const pool = await getPool();
        const [rows] = await pool.execute('SELECT * FROM pay_orders WHERE out_trade_no=?', [outTradeNo]);
        if (!rows.length) { console.error('[pay] notify for unknown order', outTradeNo); return; }
        const order = rows[0];
        if (order.status === 'paid') return;

        // 商品时长（天）→ 权益到期时间；未设置=永久
        let expiresAt = null;
        try {
            const [its] = await pool.execute('SELECT duration_days FROM pay_items WHERE item_key=?', [order.item_key]);
            const days = its.length && its[0].duration_days ? Number(its[0].duration_days) : 0;
            if (days > 0) expiresAt = new Date(Date.now() + days * 86400000);
        } catch (e) { /* 忽略 */ }

        await pool.execute(
            `UPDATE pay_orders SET status='paid', transaction_id=?, paid_at=NOW(), raw_notify=? WHERE out_trade_no=? AND status<>'paid'`,
            [transactionId, JSON.stringify(raw || {}), outTradeNo]);
        if (order.account_id) {
            await pool.execute(
                `INSERT IGNORE INTO pay_entitlements (account_id, item_key, resource_id, out_trade_no, expires_at) VALUES (?,?,?,?,?)`,
                [order.account_id, order.item_key, order.resource_id, outTradeNo, expiresAt]);
        }
        console.log('[pay] settled', outTradeNo, order.item_key, 'account=' + order.account_id, expiresAt ? ('until ' + expiresAt.toISOString()) : 'perpetual');
    }

    // ---------- 管理端：后台改价格 ----------
    app.get('/pay/admin/items', adminAuthMiddleware, async (req, res) => {
        try {
            const pool = await getPool();
            const [rows] = await pool.query('SELECT * FROM pay_items ORDER BY item_key ASC');
            res.json({ code: 200, items: rows });
        } catch (e) { res.status(500).json({ code: 500, msg: '读取失败' }); }
    });

    app.post('/pay/admin/items', adminAuthMiddleware, async (req, res) => {
        try {
            const b = req.body || {};
            const key = String(b.item_key || '').trim();
            const title = String(b.title || '').trim();
            const amount = parseInt(b.amount_cents, 10);
            if (!/^[a-z0-9_][a-z0-9_.-]{0,63}$/i.test(key)) return res.status(400).json({ code: 400, msg: 'item_key 非法（字母数字 _ . -）' });
            if (!title || title.length > 128) return res.status(400).json({ code: 400, msg: '标题非法' });
            if (!Number.isInteger(amount) || amount < 1 || amount > 5000000) return res.status(400).json({ code: 400, msg: '金额需为 1 ~ 5,000,000 分' });
            const desc = b.description ? String(b.description).slice(0, 255) : null;
            let days = null;
            if (b.duration_days !== undefined && b.duration_days !== null && b.duration_days !== '') {
                days = parseInt(b.duration_days, 10);
                if (!Number.isInteger(days) || days < 0 || days > 3650) return res.status(400).json({ code: 400, msg: '时长需为 0 ~ 3650 天' });
                if (days === 0) days = null;
            }
            const active = b.is_active === false || b.is_active === 0 ? 0 : 1;
            const pool = await getPool();
            await pool.execute(
                `INSERT INTO pay_items (item_key, title, amount_cents, description, duration_days, is_active) VALUES (?,?,?,?,?,?)
                 ON DUPLICATE KEY UPDATE title=VALUES(title), amount_cents=VALUES(amount_cents), description=VALUES(description), duration_days=VALUES(duration_days), is_active=VALUES(is_active)`,
                [key, title, amount, desc, days, active]);
            console.log('[pay] item upserted', key, amount, 'days=' + days, 'active=' + active);
            res.json({ code: 200, msg: '已保存：' + key + ' = ¥' + (amount / 100).toFixed(2) + (days ? ' / ' + days + '天' : '') });
        } catch (e) { res.status(500).json({ code: 500, msg: '保存失败' }); }
    });

    app.post('/pay/admin/items/:key/delete', adminAuthMiddleware, async (req, res) => {
        try {
            const pool = await getPool();
            await pool.execute('UPDATE pay_items SET is_active=0 WHERE item_key=?', [req.params.key]);
            res.json({ code: 200, msg: '已下架：' + req.params.key });
        } catch (e) { res.status(500).json({ code: 500, msg: '下架失败' }); }
    });

    app.get('/pay/admin/orders', adminAuthMiddleware, async (req, res) => {
        try {
            const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
            const pool = await getPool();
            const [rows] = await pool.query('SELECT out_trade_no, fs_order_no, item_key, subject, amount_cents, username, status, paid_at, created_at FROM pay_orders ORDER BY id DESC LIMIT ' + limit);
            res.json({ code: 200, orders: rows });
        } catch (e) { res.status(500).json({ code: 500, msg: '读取失败' }); }
    });

    app.get('/pay/admin/stats', adminAuthMiddleware, async (req, res) => {
        try {
            const pool = await getPool();
            const summary = async (where) => {
                const [r] = await pool.query(
                    `SELECT COUNT(*) orders, COALESCE(SUM(status='paid'),0) paid, COALESCE(SUM(CASE WHEN status='paid' THEN amount_cents ELSE 0 END),0) amount FROM pay_orders ${where}`);
                const x = r[0];
                return { orders: Number(x.orders), paid: Number(x.paid), amount_cents: Number(x.amount) };
            };
            const total = await summary('');
            const today = await summary('WHERE created_at>=CURDATE()');
            const [it] = await pool.query('SELECT COUNT(*) c FROM pay_items WHERE is_active=1');
            res.json({ code: 200, total, today, active_items: Number(it[0].c) });
        } catch (e) { res.status(500).json({ code: 500, msg: '统计失败' }); }
    });

    ensureSchema().catch(e => console.error('[pay] ensureSchema failed:', e.message));

    return { ensureSchema, settlePaid };
};
