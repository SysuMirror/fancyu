'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

test('profile persistence, ownership, unique IDs, validation and cleanup', { skip: process.env.PROFILE_INTEGRATION_TEST !== '1' }, async () => {
    const mysql = require('mysql2/promise');
    const express = require('express');
    const jwt = require('jsonwebtoken');
    const pool = mysql.createPool({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE, connectionLimit: 3 });
    const run = 'profiletest_' + crypto.randomBytes(6).toString('hex');
    const liveBase = process.env.PROFILE_LIVE_BASE;
    const secret = liveBase ? process.env.JWT_SECRET : crypto.randomBytes(32).toString('hex');
    if (!secret) throw new Error('Live checks require the configured JWT_SECRET');
    const ids = [];
    let server;
    try {
        for (const suffix of ['a', 'b']) {
            const [result] = await pool.execute('INSERT INTO accounts (email, username, password_hash) VALUES (?, ?, ?)', [run + suffix + '@example.invalid', run + suffix, 'test-only-no-login']);
            ids.push(result.insertId);
        }
        const app = express();
        app.use(express.json({ limit: '4mb' }));
        require('../profile')(app, { getPool: async () => pool, verifyToken: token => { try { return jwt.verify(token, secret); } catch { return null; } } });
        if (!liveBase) {
            server = app.listen(0, '127.0.0.1');
            await new Promise(resolve => server.once('listening', resolve));
        }
        const base = liveBase || 'http://127.0.0.1:' + server.address().port;
        const tokens = ids.map(account_id => jwt.sign({ account_id }, secret, { expiresIn: '5m' }));
        async function request(index, method = 'GET', body, query = '') {
            const response = await fetch(base + '/account/profile' + query, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (tokens[index] || 'invalid') }, ...(body ? { body: JSON.stringify(body) } : {}) });
            return { status: response.status, data: await response.json() };
        }
        assert.equal((await request(-1)).status, 401);
        assert.equal((await request(0)).data.profile.profile_id, '');
        const image = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(__dirname, 'fixtures/profile-avatar.jpg')).toString('base64');
        const body = { profile_id: run, avatar: image, bio: '初次保存🌱', photos: [image, image], tags: ['摄影'], account_id: ids[1] };
        assert.equal((await request(0, 'PUT', body)).status, 200);
        assert.equal((await request(0)).data.profile.bio, '初次保存🌱');
        assert.equal((await request(0)).data.profile.avatar, image);
        assert.deepEqual((await request(0)).data.profile.photos, [image, image]);
        assert.equal((await request(1)).data.profile.profile_id, '');
        assert.equal((await request(1, 'PUT', { ...body, profile_id: run.toUpperCase() })).status, 409);
        assert.equal((await request(0)).data.profile.bio, '初次保存🌱');
        assert.equal((await request(0, 'PUT', { ...body, photos: ['javascript:alert(1)'] })).status, 400);
        const twelveTags = ['R&B', '独立音乐', 'City Pop', '谷子', '猫咪', '旅行', '摄影', '咖啡', '校园观星', '拼豆', '慢热', '自定义兴趣'];
        assert.equal((await request(0, 'PUT', { ...body, tags: twelveTags })).status, 200);
        assert.deepEqual((await request(0)).data.profile.tags, twelveTags);
        assert.equal((await request(0, 'PUT', { ...body, tags: [...twelveTags, '第十三个'] })).status, 400);
        assert.deepEqual((await request(0)).data.profile.tags, twelveTags);
        assert.equal((await request(0, 'PUT', { ...body, avatar: '', bio: '', tags: [], photos: [] })).status, 200);
        assert.deepEqual((await request(0)).data.profile.tags, []);
        assert.equal((await request(0)).data.profile.avatar, '');
        assert.deepEqual((await request(0)).data.profile.photos, []);
        assert.deepEqual((await request(0, 'GET', undefined, '?summary=1')).data.profile.photos, []);
        await pool.execute('DELETE FROM accounts WHERE id = ?', [ids[0]]);
        assert.equal((await request(0)).status, 401);
        const [remaining] = await pool.execute('SELECT account_id FROM account_profiles WHERE account_id = ?', [ids[0]]);
        assert.equal(remaining.length, 0);
    } finally {
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        for (const id of ids) await pool.execute('DELETE FROM accounts WHERE id = ?', [id]);
        await pool.end();
    }
});
