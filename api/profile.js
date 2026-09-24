'use strict';

const { validateProfile } = require('./profile-validation');

// Own-account profile data. No guest fallback and no account ID from the request body.
module.exports = function registerProfileRoutes(app, { getPool, verifyToken }) {
    let tableReady;
    function ensureTable() {
        if (!tableReady) {
            tableReady = getPool().then(pool => pool.execute(`
                CREATE TABLE IF NOT EXISTS account_profiles (
                    account_id INT PRIMARY KEY,
                    profile_id VARCHAR(24) NOT NULL UNIQUE,
                    avatar MEDIUMTEXT NOT NULL,
                    bio VARCHAR(1200) NOT NULL DEFAULT '',
                    tags JSON NOT NULL,
                    photos MEDIUMTEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    CONSTRAINT fk_profile_account FOREIGN KEY (account_id)
                        REFERENCES accounts(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `)).catch(error => { tableReady = null; throw error; });
        }
        return tableReady;
    }

    async function requireAccount(req, res, next) {
        res.setHeader('Cache-Control', 'no-store');
        const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
        const token = match && verifyToken(match[1]);
        if (!token || !Number.isSafeInteger(token.account_id) || token.account_id < 1) {
            return res.status(401).json({ code: 401, msg: '请先登录后编辑个人主页' });
        }
        try {
            const pool = await getPool();
            const [accounts] = await pool.execute('SELECT id, username FROM accounts WHERE id = ?', [token.account_id]);
            if (!accounts.length) return res.status(401).json({ code: 401, msg: '账号不存在，请重新登录' });
            req.profileAccount = accounts[0];
            next();
        } catch (error) {
            console.error('Profile authentication:', error.code || error.name);
            res.status(503).json({ code: 503, msg: '个人主页暂时不可用，请稍后重试' });
        }
    }

    app.get('/account/profile', requireAccount, async (req, res) => {
        try {
            await ensureTable();
            const pool = await getPool();
            const fields = req.query.summary === '1' ? "profile_id, avatar, bio, tags, '[]' AS photos, updated_at" : 'profile_id, avatar, bio, tags, photos, updated_at';
            const [rows] = await pool.execute(`SELECT ${fields} FROM account_profiles WHERE account_id = ?`, [req.profileAccount.id]);
            const row = rows[0];
            const profile = row ? {
                ...row,
                tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
                photos: JSON.parse(row.photos)
            } : { profile_id: '', avatar: '', bio: '', tags: [], photos: [], updated_at: null };
            res.json({ code: 200, profile: { ...profile, username: req.profileAccount.username } });
        } catch (error) {
            console.error('Profile read:', error.code || error.name);
            res.status(503).json({ code: 503, msg: '加载失败，请重试；已保存的资料不会丢失' });
        }
    });

    app.put('/account/profile', requireAccount, async (req, res) => {
        let profile;
        try { profile = validateProfile(req.body); }
        catch (error) { return res.status(400).json({ code: 400, msg: error.message }); }
        let connection;
        try {
            await ensureTable();
            const pool = await getPool();
            connection = await pool.getConnection();
            await connection.beginTransaction();
            // Lock the account to serialize first saves without ever overwriting another ID owner.
            const [accounts] = await connection.execute('SELECT id FROM accounts WHERE id = ? FOR UPDATE', [req.profileAccount.id]);
            if (!accounts.length) {
                await connection.rollback();
                return res.status(401).json({ code: 401, msg: '账号不存在，请重新登录' });
            }
            const [existing] = await connection.execute('SELECT account_id FROM account_profiles WHERE account_id = ?', [req.profileAccount.id]);
            const values = [profile.profile_id, profile.avatar, profile.bio, JSON.stringify(profile.tags), JSON.stringify(profile.photos), req.profileAccount.id];
            if (existing.length) {
                await connection.execute('UPDATE account_profiles SET profile_id = ?, avatar = ?, bio = ?, tags = ?, photos = ? WHERE account_id = ?', values);
            } else {
                await connection.execute('INSERT INTO account_profiles (profile_id, avatar, bio, tags, photos, account_id) VALUES (?, ?, ?, ?, ?, ?)', values);
            }
            await connection.commit();
            res.json({ code: 200, msg: '个人主页已保存', profile: { ...profile, username: req.profileAccount.username } });
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ code: 409, msg: '这个主页 ID 已被使用，请换一个' });
            console.error('Profile save:', error.code || error.name);
            res.status(503).json({ code: 503, msg: '保存失败，请稍后重试；编辑内容已保留' });
        } finally {
            if (connection) connection.release();
        }
    });
};
