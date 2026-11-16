'use strict';
// 私有上传存储：头像 + 聊天图片共用。文件落 .private/uploads/（hostPath 持久、软链进 clone），
// 读取一律走 /api/account/*（鉴权 + 归属 + 配对可见性双校验），绝不暴露成公开静态资源。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const ROOT = path.join(__dirname, '..', '.private', 'uploads');
const MAX_BYTES = 5 * 1024 * 1024;
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const TABLES = { love: 'weekly_match_pairs', deep: 'deep_pairs', buddy: 'friend_card_pairs' };
// 每账号配额：磁盘是 hostPath 共享的，没有上限的话单个账号就能把节点写满。
const QUOTA_BYTES = 100 * 1024 * 1024;
const QUOTA_COUNT = 300;
// 简易上传限流（进程内，够用；单进程部署）。
const RATE_MAX = 20, RATE_WINDOW = 5 * 60 * 1000;
const hits = new Map();
function rateOk(accountId) {
    const now = Date.now();
    const arr = (hits.get(accountId) || []).filter(t => now - t < RATE_WINDOW);
    if (arr.length >= RATE_MAX) { hits.set(accountId, arr); return false; }
    arr.push(now);
    hits.set(accountId, arr);
    if (hits.size > 2000) for (const [k, v] of hits) if (!v.some(t => now - t < RATE_WINDOW)) hits.delete(k);
    return true;
}

const fail = (status, msg) => { throw Object.assign(Error(msg), { status }); };
const positive = x => { const n = Number(x); if (!Number.isSafeInteger(n) || n < 1) fail(400, '编号无效'); return n; };

// 服务端 magic-bytes 嗅探：只认 JPEG/PNG/WebP，明确拒绝 SVG（防 SVG 内嵌脚本 XSS）。
function sniff(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
    if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return null;
}

module.exports = function (app, { getPool, authMiddleware }) {
    let ready;
    function ensureSchema() {
        if (!ready) ready = (async () => {
            const p = await getPool();
            for (const sql of fs.readFileSync(path.join(__dirname, 'uploads-schema.sql'), 'utf8').split(';').map(x => x.trim()).filter(Boolean)) await p.query(sql);
            fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
        })().catch(e => { ready = null; throw e; });
        return ready;
    }

    const readRaw = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_BYTES });

    // 统一的裸连接包装（读为主，写由 file+DB 自行保证一致）。
    const guard = fn => async (req, res) => {
        try {
            await ensureSchema();
            const c = await (await getPool()).getConnection();
            try { await fn(req, res, c, req.account.account_id); }
            finally { c.release(); }
        } catch (e) {
            console.error('Uploads:', e.status || e.code || e.name);
            if (!res.headersSent) res.status(e.status || 503).json({ code: e.status || 503, msg: e.status ? e.message : '上传服务暂时不可用，请稍后重试' });
        }
    };

    async function store(c, accountId, scope, buf, mode, pairId) {
        if (!rateOk(accountId)) fail(429, '上传太频繁了，请稍后再试');
        const mime = sniff(buf);
        if (!mime) fail(400, '只支持 JPEG / PNG / WebP 图片');
        if (buf.length > MAX_BYTES) fail(413, '图片过大（上限 5MB）');
        const [[q]] = await c.execute('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS used FROM user_uploads WHERE account_id=?', [accountId]);
        if (Number(q.n) >= QUOTA_COUNT) fail(413, `图片数量已达上限（${QUOTA_COUNT} 张），请先删除一些再上传`);
        if (Number(q.used) + buf.length > QUOTA_BYTES) fail(413, '存储空间已满（上限 100MB），请先删除一些图片');
        const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const dir = path.join(ROOT, String(accountId), day);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const name = crypto.randomBytes(8).toString('hex') + '.' + MIME_EXT[mime];
        const abs = path.join(dir, name);
        const rel = path.relative(ROOT, abs);
        fs.writeFileSync(abs, buf, { mode: 0o600 });
        try {
            const [r] = await c.execute(
                'INSERT INTO user_uploads(account_id,scope,mime,bytes,rel_path,mode,pair_id) VALUES (?,?,?,?,?,?,?)',
                [accountId, scope, mime, buf.length, rel, scope === 'chat' ? mode : null, scope === 'chat' ? pairId : null]);
            return r.insertId;
        } catch (e) {
            try { fs.unlinkSync(abs); } catch (_) { /* 文件回滚失败不影响主流程 */ }
            throw e;
        }
    }

    function sendFile(res, u) {
        const abs = path.join(ROOT, u.rel_path);
        if (!abs.startsWith(ROOT + path.sep)) fail(400, '路径无效');
        if (!fs.existsSync(abs)) fail(404, '图片已失效');
        res.setHeader('Content-Type', u.mime);
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.sendFile(abs);
    }

    // 我能否看到 accountId 的头像：本人，或与该账号存在可见配对（pending/connected）。
    async function canSeeAvatar(c, me, owner) {
        if (me === owner) return;
        for (const table of Object.values(TABLES)) {
            const [rows] = await c.execute(
                `SELECT id FROM ${table} WHERE ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?)) AND status IN ('pending','connected') LIMIT 1`,
                [me, owner, owner, me]);
            if (rows.length) return;
        }
        fail(403, '无权查看该头像');
    }

    // 上传聊天图片：需是该 (mode,pair_id) 会话的成员且会话处于 connected。
    async function assertChatPair(c, me, mode, pairId) {
        if (!Object.hasOwn(TABLES, mode)) fail(400, '会话类型无效');
        const [rows] = await c.execute(`SELECT a_id,b_id,status FROM ${TABLES[mode]} WHERE id=? AND (a_id=? OR b_id=?)`, [pairId, me, me]);
        if (!rows.length) fail(404, '会话不存在');
        if (rows[0].status !== 'connected') fail(409, '会话已结束或双方尚未同意');
    }

    // ---- 头像 ----
    app.get('/account/avatar/:accountId', authMiddleware, guard(async (req, res, c, me) => {
        const owner = positive(req.params.accountId);
        await canSeeAvatar(c, me, owner);
        const [rows] = await c.execute("SELECT * FROM user_uploads WHERE account_id=? AND scope='avatar' ORDER BY id DESC LIMIT 1", [owner]);
        if (!rows.length) return res.status(404).json({ code: 404, msg: '未设置头像' });
        sendFile(res, rows[0]);
    }));

    app.put('/account/avatar', authMiddleware, readRaw, guard(async (req, res, c, me) => {
        if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, '请上传 JPEG / PNG / WebP 图片');
        const newId = await store(c, me, 'avatar', req.body);
        const [old] = await c.execute("SELECT id,rel_path FROM user_uploads WHERE account_id=? AND scope='avatar' AND id<>?", [me, newId]);
        for (const o of old) {
            await c.execute('DELETE FROM user_uploads WHERE id=?', [o.id]);
            try { fs.unlinkSync(path.join(ROOT, o.rel_path)); } catch (_) { /* 忽略 */ }
        }
        res.json({ code: 200, id: newId, url: '/api/account/avatar/' + me + '?v=' + newId });
    }));

    app.delete('/account/avatar', authMiddleware, guard(async (req, res, c, me) => {
        const [old] = await c.execute("SELECT id,rel_path FROM user_uploads WHERE account_id=? AND scope='avatar'", [me]);
        for (const o of old) { try { fs.unlinkSync(path.join(ROOT, o.rel_path)); } catch (_) { /* 忽略 */ } }
        await c.execute("DELETE FROM user_uploads WHERE account_id=? AND scope='avatar'", [me]);
        res.json({ code: 200, msg: '头像已移除' });
    }));

    // ---- 聊天图片 ----
    app.post('/account/uploads', authMiddleware, readRaw, guard(async (req, res, c, me) => {
        const scope = String(req.query.scope || 'chat');
        if (scope !== 'chat') fail(400, '不支持的上传类型');
        const mode = String(req.query.mode || ''), pairId = positive(req.query.pair_id);
        await assertChatPair(c, me, mode, pairId);
        const newId = await store(c, me, 'chat', req.body, mode, pairId);
        res.json({ code: 200, id: newId, url: '/api/account/uploads/' + newId });
    }));

    app.get('/account/uploads/:id', authMiddleware, guard(async (req, res, c, me) => {
        const id = positive(req.params.id);
        const [rows] = await c.execute('SELECT * FROM user_uploads WHERE id=?', [id]);
        if (!rows.length) fail(404, '图片不存在');
        const u = rows[0];
        if (u.scope === 'avatar') await canSeeAvatar(c, me, u.account_id);
        else if (u.account_id !== me) {
            if (!u.mode || !u.pair_id) fail(403, '无权访问该图片');
            const [p] = await c.execute(`SELECT a_id,b_id,status FROM ${TABLES[u.mode]} WHERE id=?`, [u.pair_id]);
            if (!p.length || p[0].status !== 'connected' || (p[0].a_id !== me && p[0].b_id !== me)) fail(403, '无权访问该图片');
        }
        sendFile(res, u);
    }));

    // 供其它模块（聊天）在发图后校验图片归属。
    async function own(c, accountId, uploadId) {
        const [rows] = await c.execute("SELECT id FROM user_uploads WHERE id=? AND account_id=? AND scope='chat'", [uploadId, accountId]);
        return rows.length > 0;
    }

    return { ensureSchema, own, store };
};
