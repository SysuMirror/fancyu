'use strict';
// 邀请好友：每个账号一枚邀请码，新用户注册时带上即记录邀请关系。
// 列是加法迁移（accounts.invite_code / invited_by），无 UNIQUE 冲突风险：邀请码按需惰性生成。
const crypto = require('crypto');

// 去掉容易看错的字符（0/O/1/I/L）
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z0-9]{6,12}$/;

function newCode() {
    let s = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
    return s;
}

module.exports = function (app, { getPool, authMiddleware }) {
    let ready;
    async function ensureSchema() {
        if (!ready) ready = (async () => {
            const p = await getPool();
            const add = async (col, def) => {
                try { await p.query(`ALTER TABLE accounts ADD COLUMN ${col} ${def}`); }
                catch (e) { if (!/Duplicate|already/i.test(e.message)) throw e; }
            };
            await add('invite_code', 'VARCHAR(12) NULL');
            await add('invited_by', 'INT NULL');
            try { await p.query('CREATE UNIQUE INDEX uniq_invite_code ON accounts(invite_code)'); }
            catch (e) { if (e.errno !== 1061 && e.errno !== 1146) console.error('[invite] index:', e.code || e.name); }
        })().catch(e => { ready = null; throw e; });
        return ready;
    }

    // 惰性取码：没有就生成（唯一索引兜底，冲突时重试）
    async function codeFor(accountId) {
        const p = await getPool();
        const [rows] = await p.execute('SELECT invite_code FROM accounts WHERE id=?', [accountId]);
        if (rows.length && rows[0].invite_code) return rows[0].invite_code;
        for (let i = 0; i < 5; i++) {
            const code = newCode();
            try {
                const [r] = await p.execute('UPDATE accounts SET invite_code=? WHERE id=? AND invite_code IS NULL', [code, accountId]);
                if (r.affectedRows) return code;
            } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; continue; }
            const [again] = await p.execute('SELECT invite_code FROM accounts WHERE id=?', [accountId]);
            if (again.length && again[0].invite_code) return again[0].invite_code;
        }
        return null;
    }

    app.get('/account/invite', authMiddleware, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            await ensureSchema();
            const id = req.account.account_id;
            const code = await codeFor(id);
            const p = await getPool();
            const [[{ n }]] = await p.execute('SELECT COUNT(*) AS n FROM accounts WHERE invited_by=?', [id]);
            res.json({ code: 200, invite_code: code, invited: Number(n) || 0, link: code ? '/register?invite=' + code : '' });
        } catch (e) {
            console.error('Invite:', e.status || e.code || e.name);
            res.status(503).json({ code: 503, msg: '邀请信息暂时不可用，请稍后重试' });
        }
    });

    return { ensureSchema, codeFor, validCode: c => typeof c === 'string' && CODE_RE.test(c.trim().toUpperCase()) };
};
