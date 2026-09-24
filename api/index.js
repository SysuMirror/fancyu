const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ===== 部署补丁: /api 前缀剥离 + 静态页面托管 =====
const path = require('path');
const WEB_DIR = process.env.WEB_DIR || path.join(__dirname, '..', 'web');
app.use((req, res, next) => {
    if (req.url === '/api' || req.url.startsWith('/api/')) {
        req.url = req.url.slice(4) || '/';
    }
    next();
});

app.get('/favicon.ico', (req, res) => {
    res.setHeader('Content-Type', 'image/x-icon');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const blankIcon = Buffer.from('AAABAAEAEBACAAEAAQCwAAAAFgAAACgAAAAQAAAAIAAAAAEAAQAAAAAAQAAAAAAAAgAAAAAAAAAAAAAA////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA', 'base64');
    res.send(blankIcon);
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// ==================== 从环境变量读取配置 ====================

const MYSQL_HOST = process.env.MYSQL_HOST;
const MYSQL_PORT = parseInt(process.env.MYSQL_PORT || '3306');
const MYSQL_USER = process.env.MYSQL_USER;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD;
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'sysudate';

const ACCOUNT_NAME = process.env.ACCOUNT_NAME || 'sysudate.verify@sysudate.cn';
const FROM_ALIAS = process.env.FROM_ALIAS || 'SYSU Date';
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || '';
const SMTP_HOST = process.env.SMTP_HOST || 'smtpdm.aliyun.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465');

const JWT_SECRET = process.env.JWT_SECRET || 'sysudate';
const JWT_EXPIRES_IN = '30d';

if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_PASSWORD) {
    console.error('❌ 缺少必需的环境变量: MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD');
    throw new Error('Missing required environment variables');
}

if (!SMTP_PASSWORD) {
    console.warn('⚠️ SMTP_PASSWORD 未设置，邮件发送功能可能不可用');
}

console.log('✅ 环境变量验证通过');
console.log(`📧 邮件账户: ${ACCOUNT_NAME}`);
console.log(`🗄️ 数据库: ${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DATABASE}`);

const rateLimitMap = new Map();

const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: ACCOUNT_NAME, pass: SMTP_PASSWORD }
});

let pool = null;

async function getPool() {
    if (!pool) {
        pool = await mysql.createPool({
            host: MYSQL_HOST,
            port: MYSQL_PORT,
            user: MYSQL_USER,
            password: MYSQL_PASSWORD,
            database: MYSQL_DATABASE,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            connectTimeout: 10000,
            acquireTimeout: 10000,
            timeout: 60000,
            enableKeepAlive: true,
            keepAliveInitialDelay: 10000
        });
    }
    return pool;
}

// ==================== 频率限制 ====================

function checkRateLimit(ip, action, limit = 10, windowMs = 60000) {
    const key = `${ip}:${action}`;
    const now = Date.now();
    const record = rateLimitMap.get(key) || [];
    const recent = record.filter(t => now - t < windowMs);
    if (recent.length >= limit) return false;
    recent.push(now);
    rateLimitMap.set(key, recent);
    if (Math.random() < 0.01) {
        for (const [k, times] of rateLimitMap.entries()) {
            const cleanTimes = times.filter(t => now - t < 600000);
            if (cleanTimes.length === 0) rateLimitMap.delete(k);
            else rateLimitMap.set(k, cleanTimes);
        }
    }
    return true;
}

// ==================== 工具函数 ====================

function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateUniqueSerialNumber() {
    const uuid = crypto.randomUUID();
    return `SYSU-${uuid.toUpperCase()}`;
}

function isValidSysuEmail(email) {
    const allowedSuffixes = [
        'mail2.sysu.edu.cn',      // 中山大学
        'mail.sysu.edu.cn',       // 中山大学
        'sysu.edu.cn'             // 中山大学
    ];
    return allowedSuffixes.some(suffix => email.endsWith('@' + suffix));
}

function generateToken(account) {
    const payload = {
        account_id: account.id,
        email: account.email,
        username: account.username
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }
}

async function authMiddleware(req, res, next) {
    // 部署补丁: 免登录, 任意请求直接通过
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const decoded = verifyToken(authHeader.slice(7));
        if (decoded) { req.account = decoded; return next(); }
    }
    req.account = { account_id: parseInt(process.env.GUEST_ACCOUNT_ID || '1', 10), email: 'guest@sysudate.local', username: 'guest' };
    next();
}

async function parseJsonArray(value) {
    if (value === null || value === undefined || value === '') return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

function filterByDisplaySelf(userData, displaySelf) {
    if (!userData) return null;

    const displaySelfArray = parseJsonArray(displaySelf);
    if (displaySelfArray.length === 0) {
        return userData;
    }

    const moduleFields = {
        '基础背景': ['nickname', 'sex', 'grade', 'campus', 'major', 'hometown'],
        '个人特质': ['constellation', 'mbti', 'interests', 'interest_custom'],
        '外貌偏好': ['height', 'beauty_self', 'body_type', 'fitness_level'],
        '匹配问题': ['q1_co_dependent', 'q2_conflict', 'q3_ritual', 'q4_consumption', 'q5_life_focus', 'q6_emotion', 'agree_topics'],
        '自我描述': ['self_description'],
        '理想型': ['ideal_description'],
        '照片': ['photos']
    };

    const allowedFields = new Set();
    displaySelfArray.forEach(module => {
        if (moduleFields[module]) {
            moduleFields[module].forEach(field => allowedFields.add(field));
        }
    });

    const filtered = {};
    Object.keys(userData).forEach(key => {
        if (allowedFields.has(key)) {
            filtered[key] = userData[key];
        }
    });

    filtered.serial_number = userData.serial_number;
    filtered.nickname = userData.nickname;
    filtered.display_self = userData.display_self;

    return filtered;
}

function cleanDisplaySelf(value) {
    if (value === undefined || value === null) return null;
    
    if (Array.isArray(value)) {
        return JSON.stringify(value);
    }
    
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) {
                return value;
            }
        } catch (e) {
            const matches = value.match(/[\u4e00-\u9fa5\u4e00-\u9fa5]+/g);
            if (matches && matches.length) {
                return JSON.stringify(matches);
            }
        }
        return JSON.stringify([]);
    }
    
    return JSON.stringify([]);
}

// ==================== 数据库操作 ====================

async function saveCode(email, code, source) {
    const pool = await getPool();
    const query = `INSERT INTO verification_codes (email, code, expire_at, source) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE), ?)`;
    await pool.execute(query, [email, code, source || 'general']);
}

async function verifyCode(email, code) {
    // 部署补丁: 验证码任意通过
    return true;
}

async function verifyAndDeleteCode(email, code) {
    // 部署补丁: 验证码任意通过
    return true;
}

async function checkRecentSend(email) {
    const pool = await getPool();
    const query = `SELECT COUNT(*) as count FROM verification_codes WHERE email = ? AND send_at > DATE_SUB(NOW(), INTERVAL 60 SECOND)`;
    const [rows] = await pool.execute(query, [email]);
    return rows[0].count > 0;
}

async function checkVerifyAttempts(email) {
    const pool = await getPool();
    const query = `SELECT COUNT(*) as count FROM verification_codes WHERE email = ? AND send_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`;
    const [rows] = await pool.execute(query, [email]);
    return { attempts: rows[0].count, exceeded: rows[0].count >= 5 };
}

function getSurveyTable(surveyType) {
    return surveyType === 'friend' ? 'friend_survey' : 'users';
}

async function isSerialNumberUsed(serialNumber) {
    const pool = await getPool();
    const [loveRows] = await pool.execute(`SELECT COUNT(*) as count FROM users WHERE serial_number = ?`, [serialNumber]);
    if (loveRows[0].count > 0) return true;
    const [friendRows] = await pool.execute(`SELECT COUNT(*) as count FROM friend_survey WHERE serial_number = ?`, [serialNumber]);
    return friendRows[0].count > 0;
}

async function queryUserBySerial(serialNumber) {
    const pool = await getPool();
    const [loveRows] = await pool.execute(`SELECT *, 'love' as survey_type FROM users WHERE serial_number = ?`, [serialNumber]);
    if (loveRows[0]) return loveRows[0];
    const [friendRows] = await pool.execute(`SELECT *, 'friend' as survey_type FROM friend_survey WHERE serial_number = ?`, [serialNumber]);
    return friendRows[0] || null;
}

async function verifySerialAndEmail(serial, email) {
    const userData = await queryUserBySerial(serial);
    if (!userData) return false;
    return (userData.email === email || userData.contact_email === email);
}

// ==================== 账号系统数据库操作 ====================

async function createAccount(email, password, username) {
    const pool = await getPool();
    const passwordHash = await bcrypt.hash(password, 10);
    const query = `INSERT INTO accounts (email, username, password_hash, email_verified) VALUES (?, ?, ?, TRUE)`;
    const [result] = await pool.execute(query, [email, username, passwordHash]);
    return { id: result.insertId, email, username };
}

async function findAccountByEmailOrUsername(login) {
    const pool = await getPool();
    const query = `SELECT id, email, username, password_hash, email_verified FROM accounts WHERE email = ? OR username = ?`;
    const [rows] = await pool.execute(query, [login, login]);
    return rows[0] || null;
}

async function linkAccountToSerial(accountId, serialNumber) {
    const pool = await getPool();
    const [loveResult] = await pool.execute(`UPDATE users SET account_id = ? WHERE serial_number = ?`, [accountId, serialNumber]);
    if (loveResult.affectedRows === 0) {
        await pool.execute(`UPDATE friend_survey SET account_id = ? WHERE serial_number = ?`, [accountId, serialNumber]);
    }
}

async function getAccountSerials(accountId) {
    const pool = await getPool();
    const [loveRows] = await pool.execute(`SELECT serial_number FROM users WHERE account_id = ?`, [accountId]);
    const [friendRows] = await pool.execute(`SELECT serial_number FROM friend_survey WHERE account_id = ?`, [accountId]);
    return [...loveRows.map(r => r.serial_number), ...friendRows.map(r => r.serial_number)];
}

async function getAccountById(accountId) {
    const pool = await getPool();
    const query = `SELECT id, email, username, email_verified, created_at, last_login_at FROM accounts WHERE id = ?`;
    const [rows] = await pool.execute(query, [accountId]);
    return rows[0] || null;
}

async function updateLastLogin(accountId) {
    const pool = await getPool();
    const query = `UPDATE accounts SET last_login_at = NOW() WHERE id = ?`;
    await pool.execute(query, [accountId]);
}

async function updateAccountPassword(accountId, newPassword) {
    const pool = await getPool();
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const query = `UPDATE accounts SET password_hash = ? WHERE id = ?`;
    await pool.execute(query, [passwordHash, accountId]);
}

async function updateAccountUsername(accountId, newUsername) {
    const pool = await getPool();
    const query = `UPDATE accounts SET username = ? WHERE id = ?`;
    const [result] = await pool.execute(query, [newUsername, accountId]);
    return result.affectedRows > 0;
}

async function isUsernameTaken(username) {
    const pool = await getPool();
    const query = `SELECT id FROM accounts WHERE username = ?`;
    const [rows] = await pool.execute(query, [username]);
    return rows.length > 0;
}

async function deleteAccount(accountId) {
    const pool = await getPool();
    await pool.execute(`DELETE FROM account_preferences WHERE account_id = ?`, [accountId]);
    await pool.execute(`DELETE FROM match_history WHERE account_id = ? OR match_account_id = ?`, [accountId, accountId]);
    await pool.execute(`UPDATE users SET account_id = NULL WHERE account_id = ?`, [accountId]);
    await pool.execute(`UPDATE friend_survey SET account_id = NULL WHERE account_id = ?`, [accountId]);
    await pool.execute(`DELETE FROM accounts WHERE id = ?`, [accountId]);
}

async function getContactEmailByAccountId(accountId) {
    const pool = await getPool();
    const [loveRows] = await pool.execute(`SELECT contact_email FROM users WHERE account_id = ? LIMIT 1`, [accountId]);
    if (loveRows[0]?.contact_email) return loveRows[0].contact_email;
    const [friendRows] = await pool.execute(`SELECT contact_email FROM friend_survey WHERE account_id = ? LIMIT 1`, [accountId]);
    return friendRows[0]?.contact_email || null;
}

async function updateContactEmailByAccountId(accountId, contactEmail) {
    const pool = await getPool();
    const [r1] = await pool.execute(`UPDATE users SET contact_email = ? WHERE account_id = ?`, [contactEmail, accountId]);
    const [r2] = await pool.execute(`UPDATE friend_survey SET contact_email = ? WHERE account_id = ?`, [contactEmail, accountId]);
    return r1.affectedRows > 0 || r2.affectedRows > 0;
}

// ==================== 问卷操作 ====================

// 所有可能的问卷字段
const ALL_SURVEY_FIELDS = [
    'account_id', 'serial_number', 'email', 'contact_email', 'contact_entries', 'survey_type',
    'school',
    'nickname', 'sex', 'sex_choice', 'grade', 'grade_prefer',
    'relationship_goal', 'experience', 'ex_prefer', 'future_plan',
    'major', 'prefer_major', 'campus', 'hometown',
    'constellation', 'constellation_prefer', 'mbti', 'mbti_prefer',
    'interests', 'interest_custom',
    'height', 'height_min', 'height_max', 'beauty_self', 'beauty_prefer_min',
    'body_type', 'fitness_level', 'body_prefer', 'fitness_prefer',
    'q1_co_dependent', 'q2_conflict', 'q3_ritual', 'q4_consumption',
    'q5_life_focus', 'q6_emotion', 'agree_topics',
    'self_description', 'ideal_description',
    'photos', 'display_self', 'feedback', 'avatar',
    'sex_prefer', 'major_prefer', 'online_offline', 'friend_goal',
    'ideal_friend', 'special_request',
    'personality_self_1', 'personality_self_2', 'personality_self_3',
    'personality_self_4', 'personality_self_5',
    'personality_expect_1', 'personality_expect_2', 'personality_expect_3',
    'personality_expect_4', 'personality_expect_5',
    'personality_expect_1_no_pref', 'personality_expect_2_no_pref',
    'personality_expect_3_no_pref', 'personality_expect_4_no_pref',
    'personality_expect_5_no_pref',
    'expect_schools', 'expect_school_campuses', 'expect_quick'
];

// 缓存表结构，避免每次查询
const columnCache = {};

async function getExistingColumns(pool, tableName) {
    if (columnCache[tableName]) return columnCache[tableName];
    const [rows] = await pool.execute(
        `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`,
        [tableName]
    );
    const cols = new Set(rows.map(r => r.COLUMN_NAME));
    columnCache[tableName] = cols;
    return cols;
}

function buildFieldValue(field, data, email) {
    if (field === 'email') return email || data['account_email'] || null;
    if (field === 'contact_email') return data['contact_email'] || email || data['account_email'] || null;
    const val = data[field];
    if (val === undefined || val === null) return null;
    if (field === 'display_self') return cleanDisplaySelf(val);
    if (Array.isArray(val)) return JSON.stringify(val);
    return val;
}

async function saveSurveyData(email, data) {
    const pool = await getPool();
    const serialNumber = data['serial_number'];

    if (await isSerialNumberUsed(serialNumber)) {
        throw new Error('序列号已被使用');
    }

    const tableName = getSurveyTable(data['survey_type']);
    const existingCols = await getExistingColumns(pool, tableName);
    const fields = ALL_SURVEY_FIELDS.filter(f => existingCols.has(f));

    const placeholders = fields.map(() => '?').join(', ');
    const query = `INSERT INTO ${tableName} (${fields.join(', ')}) VALUES (${placeholders})`;
    const values = fields.map(field => buildFieldValue(field, data, email));

    const [result] = await pool.execute(query, values);
    return { serialNumber, recordId: result.insertId };
}

async function updateSurveyData(serialNumber, newData, surveyType) {
    const pool = await getPool();
    const tableName = getSurveyTable(surveyType || 'love');
    const existingCols = await getExistingColumns(pool, tableName);

    const updateFields = ALL_SURVEY_FIELDS.filter(f =>
        existingCols.has(f) && f !== 'serial_number' && f !== 'account_id'
    );

    const setClause = updateFields.map(f => `${f} = ?`).join(', ');
    const values = updateFields.map(f => {
        const val = newData[f];
        if (val === undefined || val === null) return null;
        if (f === 'display_self') return cleanDisplaySelf(val);
        return Array.isArray(val) ? JSON.stringify(val) : val;
    });
    values.push(serialNumber);
    
    const query = `UPDATE ${tableName} SET ${setClause}, updated_at = NOW() WHERE serial_number = ?`;
    await pool.execute(query, values);
}

async function saveFriendSurveyData(accountId, data) {
    const sensitiveFields = ['friend_goal', 'interests', 'interest_custom', 'self_description', 'ideal_friend'];
    for (const field of sensitiveFields) {
        if (data[field]) {
            const found = containsSensitiveWords(data[field]);
            if (found) {
                throw new Error(`内容包含敏感词「${found}」，请修改后重新提交`);
            }
        }
    }

    if (data['contact_entries'] && Array.isArray(data['contact_entries'])) {
        for (const entry of data['contact_entries']) {
            if (entry.value) {
                const found = containsSensitiveWords(entry.value);
                if (found) {
                    throw new Error(`联系方式包含敏感词「${found}」，请修改后重新提交`);
                }
            }
        }
        data['contact_info'] = JSON.stringify(data['contact_entries']);
    }

    const pool = await getPool();

    try {
        await pool.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_goal VARCHAR(50) NULL AFTER relationship_goal`);
    } catch (e) {}
    try {
        await pool.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ideal_friend TEXT NULL AFTER self_description`);
    } catch (e) {}

    const existingQuery = `SELECT id FROM users WHERE account_id = ? AND survey_type = 'friend' LIMIT 1`;
    const [existing] = await pool.execute(existingQuery, [accountId]);

    const friendFields = [
        'account_id', 'user_id', 'email', 'contact_email',
        'sex', 'grade', 'campus', 'major', 'hometown', 'my_school', 'school_prefer',
        'friend_goal', 'mbti', 'interests', 'interest_custom',
        'self_description', 'ideal_friend',
        'photos', 'display_self', 'contact_info', 'survey_type'
    ];

    if (existing.length > 0) {
        const setClause = friendFields.filter(f => f !== 'account_id' && f !== 'survey_type' && f !== 'email').map(f => `${f} = ?`).join(', ');
        const updateValues = friendFields.filter(f => f !== 'account_id' && f !== 'survey_type' && f !== 'email').map(f => {
            const val = data[f];
            if (val === undefined || val === null) return null;
            if (f === 'display_self') return cleanDisplaySelf(val);
            return Array.isArray(val) ? JSON.stringify(val) : val;
        });
        updateValues.push(existing[0].id);
        await pool.execute(`UPDATE users SET ${setClause}, updated_at = NOW() WHERE id = ?`, updateValues);
        return { updated: true, id: existing[0].id };
    } else {
        const insertFields = friendFields;
        const placeholders = insertFields.map(() => '?').join(', ');
        const query = `INSERT INTO users (${insertFields.join(', ')}) VALUES (${placeholders})`;
        const values = insertFields.map(field => {
            if (field === 'account_id') return accountId;
            if (field === 'user_id') return data['user_id'] || null;
            if (field === 'email') return data['email'] || null;
            if (field === 'contact_email') return data['contact_info'] || data['email'] || null;
            if (field === 'survey_type') return 'friend';
            const val = data[field];
            if (val === undefined || val === null) return null;
            if (field === 'display_self') return cleanDisplaySelf(val);
            return Array.isArray(val) ? JSON.stringify(val) : val;
        });
        const [result] = await pool.execute(query, values);
        return { inserted: true, id: result.insertId };
    }
}

// ==================== 发送邮件 ====================

async function sendVerificationEmail(toEmail, verifyCode) {
    const mailOptions = {
        from: `${FROM_ALIAS} <${ACCOUNT_NAME}>`,
        to: toEmail,
        subject: '【SYSU Date】邮箱验证码',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                <h2 style="color: #00552E;">SYSU Date</h2>
                <p>您好，</p>
                <p>您的验证码是：</p>
                <div style="font-size: 32px; font-weight: bold; color: #00853E; background: #f5f5f5; padding: 15px; text-align: center; letter-spacing: 5px; margin: 20px 0;">
                    ${verifyCode}
                </div>
                <p>验证码有效期为 <strong>5 分钟</strong>，请尽快完成验证。</p>
                <p style="color: #666; font-size: 12px; margin-top: 30px;">—— SYSU Date 团队</p>
            </div>
        `
    };
    return await transporter.sendMail(mailOptions);
}

async function sendConfirmationEmail(toEmail, serialNumber) {
    const mailOptions = {
        from: `${FROM_ALIAS} <${ACCOUNT_NAME}>`,
        to: toEmail,
        subject: '【SYSU Date】问卷提交成功',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                <h2 style="color: #00552E;">SYSU Date · 中意你</h2>
                <p>你好！</p>
                <p>你的匹配问卷已成功提交。</p>
                <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p style="margin: 0;"><strong>你的序列号：</strong></p>
                    <p style="font-size: 18px; color: #00853E; margin: 10px 0; font-weight: bold;">${serialNumber}</p>
                </div>
                <p>请妥善保存序列号，用于后续查询与修改资料。</p>
                <p style="color: #666; font-size: 12px; margin-top: 30px;">—— SYSU Date 团队</p>
            </div>
        `
    };
    return await transporter.sendMail(mailOptions);
}

// ==================== Express 路由 ====================

app.use((req, res, next) => {
    const allowedOrigins = ['https://sysudate.cn', 'http://sysudate.cn', 'http://localhost:3000', 'https://oss-cn-hongkong.aliyuncs.com', 'http://oss-cn-hongkong.aliyuncs.com', 'https://sysu-date.oss-cn-hongkong.aliyuncs.com', 'http://sysu-date.oss-cn-hongkong.aliyuncs.com'];
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

// ==================== 账号系统 API ====================

// 注册新账号
app.post('/account/register', async (req, res) => {
    // 部署补丁: 免注册, 任意输入直接通过; 账号不存在则自动创建
    try {
        const { email, password, username } = req.body;
        const key = (email && String(email).trim()) || ('guest-' + Date.now());
        let account = await findAccountByEmailOrUsername(key);
        if (!account) {
            account = await createAccount(key, password || 'guest', username || ('u' + Math.random().toString(36).slice(2, 10)));
        }
        const token = generateToken(account);
        await updateLastLogin(account.id);
        return res.json({
            code: 200, msg: '注册成功', token,
            user: { account_id: account.id, email: account.email, username: account.username, serials: [] }
        });
    } catch (error) {
        console.error('Register Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// 老用户绑定序列号
app.post('/account/bind', async (req, res) => {
    const { serial_number, email, code, password, username } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    
    try {
        if (!checkRateLimit(clientIp, 'bind', 5, 60000)) {
            return res.json({ code: 429, msg: '请求过于频繁，请稍后再试' });
        }
        
        if (!serial_number || !email || !code || !password) {
            return res.json({ code: 400, msg: '序列号、邮箱、验证码和密码不能为空' });
        }
        
        if (!isValidSysuEmail(email)) {
            return res.json({ code: 400, msg: '仅支持指定学校官方邮箱' });
        }
        
        if (password.length < 6) {
            return res.json({ code: 400, msg: '密码长度至少为6位' });
        }
        
        const isValid = await verifyAndDeleteCode(email, code);
        if (!isValid) {
            return res.json({ code: 400, msg: '验证码错误或已过期' });
        }
        
        const userData = await queryUserBySerial(serial_number);
        if (!userData) {
            return res.json({ code: 404, msg: '序列号不存在' });
        }
        
        if (userData.email !== email && userData.contact_email !== email) {
            return res.json({ code: 403, msg: '序列号与邮箱不匹配' });
        }
        
        if (userData.account_id) {
            return res.json({ code: 400, msg: '该序列号已绑定账号' });
        }
        
        const existingAccount = await findAccountByEmailOrUsername(email);
        if (existingAccount) {
            return res.json({ code: 400, msg: '该邮箱已注册，请直接登录' });
        }
        
        const finalUsername = username || email.split('@')[0];
        const usernameCheck = await findAccountByEmailOrUsername(finalUsername);
        if (usernameCheck) {
            return res.json({ code: 400, msg: '该用户名已被使用' });
        }
        
        const account = await createAccount(email, password, finalUsername);
        await linkAccountToSerial(account.id, serial_number);
        const token = generateToken(account);
        await updateLastLogin(account.id);
        
        return res.json({
            code: 200,
            msg: '绑定成功',
            token,
            user: {
                account_id: account.id,
                email: account.email,
                username: account.username,
                serials: [serial_number]
            }
        });
    } catch (error) {
        console.error('Bind Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// 登录
app.post('/account/login', async (req, res) => {
    // 部署补丁: 免登录, 任意输入直接通过; 账号不存在则自动创建
    try {
        const { login, password } = req.body;
        const key = (login && String(login).trim()) || ('guest-' + Date.now());
        let account = await findAccountByEmailOrUsername(key);
        if (!account) {
            const username = 'u' + Math.random().toString(36).slice(2, 10);
            account = await createAccount(key, password || 'guest', username);
        }
        const token = generateToken(account);
        await updateLastLogin(account.id);
        return res.json({
            code: 200, msg: '登录成功', token,
            user: { account_id: account.id, email: account.email, username: account.username, serials: [] }
        });
    } catch (error) {
        console.error('Login Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// 个人主页：独立模块，使用有效账号令牌，不使用游客账号回退。
require('./profile')(app, { getPool, verifyToken });

// 获取当前用户信息
app.get('/account/me', authMiddleware, async (req, res) => {
    try {
        const account = await getAccountById(req.account.account_id);
        if (!account) {
            return res.json({ code: 404, msg: '账号不存在' });
        }

        const serials = await getAccountSerials(account.id);
        const contactEmail = await getContactEmailByAccountId(account.id);
        const pool = await getPool();
        await ensurePreferencesTable(pool);
        const prefs = await getAccountPreferences(pool, account.id);

        return res.json({
            code: 200,
            user: {
                account_id: account.id,
                email: account.email,
                username: account.username,
                created_at: account.created_at,
                join_matching: prefs ? !!prefs.join_matching : true,
                join_friend_matching: prefs ? !!prefs.join_friend_matching : true,
                contact_email: contactEmail,
                serials
            }
        });
    } catch (error) {
        console.error('Get Me Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// 修改密码（需登录）
app.post('/account/change-password', authMiddleware, async (req, res) => {
    try {
        const { old_password, new_password } = req.body;
        if (!old_password || !new_password) {
            return res.json({ code: 400, msg: '旧密码和新密码不能为空' });
        }
        if (new_password.length < 6) {
            return res.json({ code: 400, msg: '新密码长度不能少于6位' });
        }
        
        const account = await findAccountByEmailOrUsername(req.account.email);
        if (!account) {
            return res.json({ code: 404, msg: '账号不存在' });
        }
        
        const isMatch = await bcrypt.compare(old_password, account.password_hash);
        if (!isMatch) {
            return res.json({ code: 400, msg: '旧密码错误' });
        }
        
        await updateAccountPassword(req.account.account_id, new_password);
        return res.json({ code: 200, msg: '密码修改成功' });
    } catch (error) {
        console.error('Change Password Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// 找回密码（通过验证邮箱重置，无需登录）
app.post('/account/reset-password', async (req, res) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    try {
        if (!checkRateLimit(clientIp, 'resetPassword', 3, 60000)) {
            return res.json({ code: 429, msg: '请求过于频繁，请稍后再试' });
        }
        
        const { email, code, new_password } = req.body;
        if (!email || !code || !new_password) {
            return res.json({ code: 400, msg: '邮箱、验证码和新密码不能为空' });
        }
        if (new_password.length < 6) {
            return res.json({ code: 400, msg: '新密码长度不能少于6位' });
        }
        
        const isValid = await verifyAndDeleteCode(email, code);
        if (!isValid) {
            return res.json({ code: 400, msg: '验证码错误或已过期' });
        }
        
        const account = await findAccountByEmailOrUsername(email);
        if (!account) {
            return res.json({ code: 404, msg: '该邮箱未注册' });
        }
        
        await updateAccountPassword(account.id, new_password);
        return res.json({ code: 200, msg: '密码重置成功' });
    } catch (error) {
        console.error('Reset Password Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// 修改用户名（需登录）
app.post('/account/change-username', authMiddleware, async (req, res) => {
    try {
        const { new_username } = req.body;
        if (!new_username) {
            return res.json({ code: 400, msg: '用户名不能为空' });
        }
        if (new_username.length > 20) {
            return res.json({ code: 400, msg: '用户名不能超过20个字符' });
        }
        if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(new_username)) {
            return res.json({ code: 400, msg: '用户名只能包含字母、数字、下划线和中文' });
        }
        
        if (new_username !== req.account.username && await isUsernameTaken(new_username)) {
            return res.json({ code: 400, msg: '该用户名已被使用' });
        }
        
        await updateAccountUsername(req.account.account_id, new_username);
        
        const newToken = generateToken({
            id: req.account.account_id,
            email: req.account.email,
            username: new_username
        });
        
        return res.json({ code: 200, msg: '用户名修改成功', token: newToken, username: new_username });
    } catch (error) {
        console.error('Change Username Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// 修改联系邮箱（需登录）
app.post('/account/change-contact-email', authMiddleware, async (req, res) => {
    try {
        const { contact_email } = req.body;
        if (!contact_email) {
            return res.json({ code: 400, msg: '联系邮箱不能为空' });
        }
        
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(contact_email)) {
            return res.json({ code: 400, msg: '邮箱格式不正确' });
        }
        
        await updateContactEmailByAccountId(req.account.account_id, contact_email);
        return res.json({ code: 200, msg: '联系邮箱修改成功' });
    } catch (error) {
        console.error('Change Contact Email Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// 注销账号（需登录 + 密码确认）
app.post('/account/delete', authMiddleware, async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) {
            return res.json({ code: 400, msg: '请输入密码确认注销' });
        }
        
        const account = await findAccountByEmailOrUsername(req.account.email);
        if (!account) {
            return res.json({ code: 404, msg: '账号不存在' });
        }
        
        const isMatch = await bcrypt.compare(password, account.password_hash);
        if (!isMatch) {
            return res.json({ code: 400, msg: '密码错误' });
        }
        
        await deleteAccount(req.account.account_id);
        return res.json({ code: 200, msg: '账号已注销' });
    } catch (error) {
        console.error('Delete Account Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// 检查用户名是否可用
app.get('/account/check-username', async (req, res) => {
    try {
        const { username } = req.query;
        if (!username) return res.json({ code: 400, msg: '用户名不能为空' });
        if (username.length < 2) return res.json({ code: 200, available: false, msg: '用户名至少2个字符' });
        const taken = await isUsernameTaken(username);
        return res.json({ code: 200, available: !taken, msg: taken ? '该用户名已被使用' : '用户名可用' });
    } catch (error) {
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// 切换是否参与恋爱匹配（需登录）
app.post('/account/toggle-matching', authMiddleware, async (req, res) => {
    try {
        const { join_matching } = req.body;
        const value = join_matching ? 1 : 0;
        const pool = await getPool();
        await ensurePreferencesTable(pool);
        await setAccountPreference(pool, req.account.account_id, 'join_matching', value);
        return res.json({ code: 200, msg: value ? '已加入本轮恋爱匹配' : '已退出本轮恋爱匹配', join_matching: !!value });
    } catch (error) {
        console.error('Toggle Matching Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

async function ensureColumn(pool, table, column, definition) {
    try {
        await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (e) {
        if (!e.message.includes('Duplicate') && !e.message.includes('already')) {
            console.log('Column check:', e.message.substring(0, 100));
        }
    }
}

async function ensurePreferencesTable(pool) {
    try {
        await pool.execute(`CREATE TABLE IF NOT EXISTS account_preferences (
            account_id INT PRIMARY KEY,
            join_matching TINYINT(1) DEFAULT 1,
            join_friend_matching TINYINT(1) DEFAULT 1,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )`);
    } catch (e) {
        console.log('ensurePreferencesTable:', e.message.substring(0, 100));
    }
}

async function getAccountPreferences(pool, accountId) {
    try {
        const [rows] = await pool.execute(`SELECT join_matching, join_friend_matching FROM account_preferences WHERE account_id = ?`, [accountId]);
        return rows[0] || null;
    } catch (e) {
        return null;
    }
}

async function setAccountPreference(pool, accountId, field, value) {
    try {
        await pool.execute(`INSERT INTO account_preferences (account_id, ${field}) VALUES (?, ?) ON DUPLICATE KEY UPDATE ${field} = ?`, [accountId, value, value]);
        return true;
    } catch (e) {
        console.error('setAccountPreference error:', e.message.substring(0, 100));
        return false;
    }
}

// 切换是否参与交友匹配（需登录）
app.post('/account/toggle-friend-matching', authMiddleware, async (req, res) => {
    try {
        const { join_friend_matching } = req.body;
        const value = join_friend_matching ? 1 : 0;
        const pool = await getPool();
        await ensurePreferencesTable(pool);
        await setAccountPreference(pool, req.account.account_id, 'join_friend_matching', value);
        return res.json({ code: 200, msg: value ? '已加入本轮交友匹配' : '已退出本轮交友匹配', join_friend_matching: !!value });
    } catch (error) {
        console.error('Toggle Friend Matching Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// ==================== 匹配历史与联系方式交换 ====================

async function ensureMatchHistoryTable(pool) {
    try {
        await pool.execute(`CREATE TABLE IF NOT EXISTS match_history (
            id INT AUTO_INCREMENT PRIMARY KEY,
            account_id INT NOT NULL,
            match_account_id INT NOT NULL,
            survey_type ENUM('love', 'friend') DEFAULT 'love',
            match_round INT DEFAULT 1,
            match_data JSON,
            user_agreed TINYINT(1) DEFAULT 0,
            match_agreed TINYINT(1) DEFAULT 0,
            contact_exchanged TINYINT(1) DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_account (account_id),
            INDEX idx_match_account (match_account_id),
            INDEX idx_round (match_round)
        )`);
    } catch (e) {
        console.log('ensureMatchHistoryTable:', e.message.substring(0, 100));
    }
}

async function getMatchHistory(pool, accountId) {
    const [rows] = await pool.execute(
        `SELECT mh.*,
            u.nickname as match_nickname, u.sex as match_sex, u.grade as match_grade,
            u.school as match_school, u.campus as match_campus, u.major as match_major, u.mbti as match_mbti,
            u.interests as match_interests, u.self_description as match_self_description,
            u.height as match_height, u.body_type as match_body_type, u.fitness_level as match_fitness_level,
            a.username as match_username
        FROM match_history mh
        LEFT JOIN users u ON u.account_id = mh.match_account_id
        LEFT JOIN accounts a ON a.id = mh.match_account_id
        WHERE mh.account_id = ?
        ORDER BY mh.created_at DESC`,
        [accountId]
    );
    return rows;
}

async function getMatchById(pool, matchId, accountId) {
    const [rows] = await pool.execute(
        `SELECT * FROM match_history WHERE id = ? AND account_id = ?`,
        [matchId, accountId]
    );
    return rows[0] || null;
}

async function updateMatchAgreement(pool, matchId, accountId, field) {
    await pool.execute(
        `UPDATE match_history SET ${field} = 1 WHERE id = ? AND account_id = ?`,
        [matchId, accountId]
    );
    const [rows] = await pool.execute(
        `SELECT user_agreed, match_agreed FROM match_history WHERE id = ?`,
        [matchId]
    );
    if (rows.length > 0 && rows[0].user_agreed && rows[0].match_agreed) {
        await pool.execute(
            `UPDATE match_history SET contact_exchanged = 1 WHERE id = ?`,
            [matchId]
        );
        return true;
    }
    return false;
}

async function getContactInfo(pool, accountId) {
    const [rows] = await pool.execute(
        `SELECT contact_email, email FROM users WHERE account_id = ? LIMIT 1`,
        [accountId]
    );
    if (rows.length > 0) {
        return rows[0].contact_email || rows[0].email || null;
    }
    const [accRows] = await pool.execute(
        `SELECT email FROM accounts WHERE id = ? LIMIT 1`,
        [accountId]
    );
    return accRows[0]?.email || null;
}

// 查询问卷填写状态
app.get('/account/survey-status', authMiddleware, async (req, res) => {
    try {
        const pool = await getPool();
        const accountId = req.account.account_id;
        const [loveRows] = await pool.execute(
            `SELECT COUNT(*) as count FROM users WHERE account_id = ?`,
            [accountId]
        );
        const [friendRows] = await pool.execute(
            `SELECT COUNT(*) as count FROM friend_survey WHERE account_id = ?`,
            [accountId]
        );
        return res.json({
            code: 200,
            data: {
                love: { filled: loveRows[0].count > 0 },
                friend: { filled: friendRows[0].count > 0 }
            }
        });
    } catch (error) {
        console.error('Survey Status Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// 获取匹配历史
app.get('/account/matches', authMiddleware, async (req, res) => {
    try {
        const pool = await getPool();
        await ensureMatchHistoryTable(pool);
        const matches = await getMatchHistory(pool, req.account.account_id);

        const result = await Promise.all(matches.map(async (m) => {
            const matchData = m.match_data ? JSON.parse(m.match_data) : {};
            const contactExchanged = m.contact_exchanged === 1;
            let contact = null;
            if (contactExchanged) {
                contact = await getContactInfo(pool, m.match_account_id);
            }
            return {
                id: m.id,
                survey_type: m.survey_type,
                match_round: m.match_round,
                created_at: m.created_at,
                contact_exchanged: contactExchanged,
                user_agreed: m.user_agreed === 1,
                match_agreed: m.match_agreed === 1,
                match_data: {
                    person: {
                        name: m.match_nickname || m.match_username || '匿名用户',
                        school: m.match_school || await getSchoolFromEmailByAccountId(pool, m.match_account_id),
                        grade: m.match_grade,
                        major: m.match_major,
                        mbti: m.match_mbti,
                        hobbies: m.match_interests,
                        self_description: m.match_self_description,
                        height: m.match_height,
                        body_type: m.match_body_type,
                        fitness_level: m.match_fitness_level
                    },
                    contact: contact
                }
            };
        }));

        return res.json({ code: 200, data: result });
    } catch (error) {
        console.error('Get Matches Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

async function getSchoolFromEmailByAccountId(pool, accountId) {
    try {
        const [rows] = await pool.execute(
            `SELECT email FROM accounts WHERE id = ? LIMIT 1`,
            [accountId]
        );
        if (rows.length > 0) {
            const email = rows[0].email;
            if (email.endsWith('mail.sysu.edu.cn') || email.endsWith('mail2.sysu.edu.cn')) return '中山大学';
            if (email.endsWith('scut.edu.cn')) return '华南理工大学';
        }
    } catch (e) {}
    return '';
}

// 同意交换联系方式
app.post('/account/exchange-contact', authMiddleware, async (req, res) => {
    try {
        const { match_id } = req.body;
        if (!match_id) {
            return res.json({ code: 400, msg: 'match_id 不能为空' });
        }

        const pool = await getPool();
        await ensureMatchHistoryTable(pool);

        const match = await getMatchById(pool, match_id, req.account.account_id);
        if (!match) {
            return res.json({ code: 404, msg: '匹配记录不存在' });
        }

        if (match.user_agreed) {
            return res.json({ code: 200, msg: '您已同意交换联系方式', contact_exchanged: match.contact_exchanged === 1 });
        }

        const exchanged = await updateMatchAgreement(pool, match_id, req.account.account_id, 'user_agreed');

        return res.json({
            code: 200,
            msg: exchanged ? '双方已同意，联系方式已显示' : '已同意交换联系方式，等待对方确认',
            contact_exchanged: exchanged
        });
    } catch (error) {
        console.error('Exchange Contact Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// ==================== 管理员 API ====================

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'mony';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
    console.warn('\x1b[33m%s\x1b[0m', '⚠ WARNING: ADMIN_PASSWORD 环境变量未设置，使用默认密码！请在生产环境中设置强密码！');
}
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD || '123456', 10);

const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 3;
const LOGIN_WINDOW_MS = 60 * 1000;

function rateLimitMiddleware(req, res, next) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const record = loginAttempts.get(ip);

    if (!record) {
        loginAttempts.set(ip, { count: 1, firstAttempt: now });
        return next();
    }

    if (now - record.firstAttempt > LOGIN_WINDOW_MS) {
        loginAttempts.set(ip, { count: 1, firstAttempt: now });
        return next();
    }

    if (record.count >= LOGIN_MAX_ATTEMPTS) {
        const waitTime = Math.ceil((LOGIN_WINDOW_MS - (now - record.firstAttempt)) / 1000);
        return res.json({ code: 429, msg: `登录过于频繁，请 ${waitTime} 秒后重试` });
    }

    record.count++;
    next();
}

function adminAuthMiddleware(req, res, next) {
    // 部署补丁: 管理端免登录
    next();
}

app.post('/admin/login', rateLimitMiddleware, async (req, res) => {
    // 部署补丁: 管理端免登录
    const { username } = req.body || {};
    const token = jwt.sign({ isAdmin: true, username: username || 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ code: 200, msg: '登录成功', token });
});

app.get('/admin/users', adminAuthMiddleware, async (req, res) => {
    try {
        const pool = await getPool();
        const { page = 1, pageSize = 20, sort = 'created_at', order = 'DESC', search, sex, campus, grade, join_matching } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(pageSize);
        
        let where = ['1=1'];
        let params = [];
        
        if (search) {
            where.push(`(u.nickname LIKE ? OR u.serial_number LIKE ? OR u.email LIKE ? OR u.contact_email LIKE ?)`);
            const s = `%${search}%`;
            params.push(s, s, s, s);
        }
        if (sex) { where.push(`u.sex = ?`); params.push(sex); }
        if (campus) { where.push(`u.campus = ?`); params.push(campus); }
        if (grade) { where.push(`u.grade = ?`); params.push(grade); }
        if (join_matching !== undefined && join_matching !== '') {
            where.push(`a.join_matching = ?`);
            params.push(join_matching === 'true' || join_matching === '1' ? 1 : 0);
        }
        
        const allowedSorts = ['created_at', 'updated_at', 'nickname', 'sex', 'campus', 'grade', 'height'];
        const sortField = allowedSorts.includes(sort) ? sort : 'created_at';
        const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        
        const countQuery = `SELECT COUNT(*) as total FROM users u LEFT JOIN accounts a ON u.account_id = a.id WHERE ${where.join(' AND ')}`;
        const [countResult] = await pool.execute(countQuery, params);
        const total = countResult[0].total;
        
        const dataQuery = `SELECT u.*, a.join_matching, a.username as account_username FROM users u LEFT JOIN accounts a ON u.account_id = a.id WHERE ${where.join(' AND ')} ORDER BY u.${sortField} ${sortOrder} LIMIT ${parseInt(pageSize)} OFFSET ${offset}`;
        const [rows] = await pool.execute(dataQuery, params);
        
        return res.json({ code: 200, data: rows, total, page: parseInt(page), pageSize: parseInt(pageSize) });
    } catch (error) {
        console.error('Admin Users Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

app.get('/admin/user/:serial', adminAuthMiddleware, async (req, res) => {
    try {
        const pool = await getPool();
        const [rows] = await pool.execute(`SELECT u.*, a.join_matching, a.username as account_username, a.email as account_email, a.created_at as account_created_at FROM users u LEFT JOIN accounts a ON u.account_id = a.id WHERE u.serial_number = ?`, [req.params.serial]);
        if (rows.length === 0) return res.json({ code: 404, msg: '未找到该用户' });
        return res.json({ code: 200, data: rows[0] });
    } catch (error) {
        console.error('Admin User Detail Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

app.get('/admin/stats', adminAuthMiddleware, async (req, res) => {
    try {
        const pool = await getPool();
        
        const [[{totalUsers}]] = await pool.execute(`SELECT COUNT(*) as totalUsers FROM users`);
        const [[{totalAccounts}]] = await pool.execute(`SELECT COUNT(*) as totalAccounts FROM accounts`);
        const [[{joinMatching}]] = await pool.execute(`SELECT COUNT(*) as joinMatching FROM accounts WHERE join_matching = 1`);
        const [sexDist] = await pool.execute(`SELECT sex, COUNT(*) as count FROM users GROUP BY sex`);
        const [campusDist] = await pool.execute(`SELECT campus, COUNT(*) as count FROM users GROUP BY campus`);
        const [gradeDist] = await pool.execute(`SELECT grade, COUNT(*) as count FROM users GROUP BY grade`);
        const [mbtiDist] = await pool.execute(`SELECT mbti, COUNT(*) as count FROM users WHERE mbti IS NOT NULL AND mbti != '' GROUP BY mbti ORDER BY count DESC LIMIT 20`);
        const [constellationDist] = await pool.execute(`SELECT constellation, COUNT(*) as count FROM users WHERE constellation IS NOT NULL AND constellation != '' GROUP BY constellation ORDER BY count DESC`);
        const [relationshipGoalDist] = await pool.execute(`SELECT relationship_goal, COUNT(*) as count FROM users GROUP BY relationship_goal`);
        const [[{avgHeight}]] = await pool.execute(`SELECT AVG(CAST(height AS DECIMAL)) as avgHeight FROM users WHERE height IS NOT NULL AND height != '' AND CAST(height AS DECIMAL) BETWEEN 100 AND 250`);
        const [dailyReg] = await pool.execute(`SELECT DATE(created_at) as date, COUNT(*) as count FROM accounts GROUP BY DATE(created_at) ORDER BY date DESC LIMIT 30`);
        const [dailySurvey] = await pool.execute(`SELECT DATE(created_at) as date, COUNT(*) as count FROM users GROUP BY DATE(created_at) ORDER BY date DESC LIMIT 30`);
        const [sexChoiceDist] = await pool.execute(`SELECT sex_choice, COUNT(*) as count FROM users GROUP BY sex_choice`);
        const [majorDist] = await pool.execute(`SELECT major, COUNT(*) as count FROM users WHERE major IS NOT NULL AND major != '' GROUP BY major ORDER BY count DESC LIMIT 20`);
        
        return res.json({
            code: 200,
            data: {
                totalUsers, totalAccounts, joinMatching,
                sexDist, campusDist, gradeDist, mbtiDist, constellationDist,
                relationshipGoalDist, avgHeight: avgHeight ? Math.round(avgHeight * 10) / 10 : null,
                dailyReg, dailySurvey, sexChoiceDist, majorDist
            }
        });
    } catch (error) {
        console.error('Admin Stats Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// 管理员获取交友问卷数据
app.get('/admin/friend-surveys', adminAuthMiddleware, async (req, res) => {
    try {
        const pool = await getPool();
        const { page = 1, pageSize = 50 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(pageSize);
        
        const [[{total}]] = await pool.execute(`SELECT COUNT(*) as total FROM friend_survey`);
        const [rows] = await pool.execute(
            `SELECT f.*, a.email as account_email FROM friend_survey f LEFT JOIN accounts a ON f.account_id = a.id ORDER BY f.created_at DESC LIMIT ${parseInt(pageSize)} OFFSET ${offset}`
        );
        return res.json({ code: 200, data: rows, total, page: parseInt(page), pageSize: parseInt(pageSize) });
    } catch (error) {
        console.error('Admin Friend Surveys Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// 管理员批量导出匹配结果
app.post('/admin/import-matches', adminAuthMiddleware, async (req, res) => {
    try {
        const pool = await getPool();
        await ensureMatchHistoryTable(pool);
        const { matches, match_round = 1, survey_type = 'love' } = req.body;
        
        if (!Array.isArray(matches)) {
            return res.json({ code: 400, msg: 'matches 必须是数组' });
        }
        
        let successCount = 0;
        let skipCount = 0;
        let failCount = 0;
        
        for (const match of matches) {
            const { account_email, match_email, match_data } = match;
            
            // 查找account_id
            const [accRows1] = await pool.execute(`SELECT id FROM accounts WHERE email = ?`, [account_email]);
            const [accRows2] = await pool.execute(`SELECT id FROM accounts WHERE email = ?`, [match_email]);
            
            if (!accRows1.length || !accRows2.length) {
                failCount++;
                continue;
            }
            
            const accountId = accRows1[0].id;
            const matchAccountId = accRows2[0].id;
            
            // 检查是否已存在
            const [existing] = await pool.execute(
                `SELECT id FROM match_history WHERE account_id = ? AND match_account_id = ? AND match_round = ? AND survey_type = ?`,
                [accountId, matchAccountId, match_round, survey_type]
            );
            if (existing.length > 0) {
                skipCount++;
                continue;
            }
            
            await pool.execute(
                `INSERT INTO match_history (account_id, match_account_id, survey_type, match_round, match_data, user_agreed, match_agreed, contact_exchanged, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, NOW(), NOW())`,
                [accountId, matchAccountId, survey_type, match_round, JSON.stringify(match_data)]
            );
            successCount++;
        }
        
        return res.json({ code: 200, data: { success: successCount, skip: skipCount, fail: failCount } });
    } catch (error) {
        console.error('Admin Import Matches Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

app.delete('/admin/user/:serial', adminAuthMiddleware, async (req, res) => {
    try {
        const pool = await getPool();
        const [rows] = await pool.execute(`SELECT account_id FROM users WHERE serial_number = ?`, [req.params.serial]);
        if (rows.length === 0) return res.json({ code: 404, msg: '未找到该用户' });
        const accountId = rows[0].account_id;
        if (accountId) {
            await pool.execute(`DELETE FROM account_preferences WHERE account_id = ?`, [accountId]);
            await pool.execute(`DELETE FROM match_history WHERE account_id = ? OR match_account_id = ?`, [accountId, accountId]);
            await pool.execute(`UPDATE complaints SET status = 'dismissed' WHERE reporter_account_id = ?`, [accountId]);
        }
        await pool.execute(`DELETE FROM users WHERE serial_number = ?`, [req.params.serial]);
        return res.json({ code: 200, msg: '已删除' });
    } catch (error) {
        console.error('Admin Delete Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

const LLM_API_URL = process.env.LLM_API_URL || 'http://ssemarket.cn:8888/v1/chat/completions';

function parseUserQuery(query) {
    const q = query.toLowerCase().trim();
    const result = { action: null, params: {} };

    // ====== 用户详情查询 ======
    const serialMatch = q.match(/(?:序列号|编号|serial|sn)[：:\s]*([a-z0-9]+[-]?[a-z0-9]+)/i);
    if (serialMatch) {
        result.action = 'user_detail';
        result.params.serial = serialMatch[1].toUpperCase();
        return result;
    }

    // ====== 匹配统计 ======
    if (q.includes('匹配') && (q.includes('统计') || q.includes('多少') || q.includes('分布') || q.includes('情况'))) {
        result.action = 'matching_stats';
        return result;
    }

    // ====== 最近注册/新用户 ======
    if (q.includes('最近注册') || q.includes('新用户') || q.includes('最新注册') || q.includes('最近加入')) {
        result.action = 'recent_users';
        const match = q.match(/(\d+)/);
        result.params.limit = match ? Math.min(parseInt(match[1]), 100) : 10;
        return result;
    }

    // ====== 统计类查询 ======
    if (q.includes('统计') || q.includes('分布') || q.includes('有多少') || q.includes('占比') || q.includes('比例')) {
        if (q.includes('性别') || q.includes('男女') || q.includes('男生') || q.includes('女生')) {
            result.action = 'stats_sex';
        } else if (q.includes('校区') || q.includes('校园') || q.includes('南校') || q.includes('北校') || q.includes('东校') || q.includes('珠海') || q.includes('深圳')) {
            result.action = 'stats_campus';
        } else if (q.includes('年级') || q.includes('大一') || q.includes('大二') || q.includes('大三') || q.includes('大四') || q.includes('研一') || q.includes('研二') || q.includes('研三') || q.includes('博士')) {
            result.action = 'stats_grade';
        } else if (q.includes('mbti') || q.includes('性格')) {
            result.action = 'stats_mbti';
        } else if (q.includes('星座')) {
            result.action = 'stats_constellation';
        } else if (q.includes('专业')) {
            result.action = 'stats_major';
        } else if (q.includes('恋爱目的') || q.includes('关系目标') || q.includes('找对象目的')) {
            result.action = 'stats_relationship_goal';
        } else if (q.includes('恋爱经验') || q.includes('母胎') || q.includes('solo') || q.includes('感情经历')) {
            result.action = 'stats_experience';
        } else if (q.includes('未来计划') || q.includes('未来打算') || q.includes('毕业') || q.includes('就业') || q.includes('深造')) {
            result.action = 'stats_future_plan';
        } else if (q.includes('健身') || q.includes('运动') || q.includes('锻炼')) {
            result.action = 'stats_fitness';
        } else if (q.includes('家乡') || q.includes('来自')) {
            result.action = 'stats_hometown';
        } else if (q.includes('身高')) {
            result.action = 'stats_height';
        } else if (q.includes('颜值') || q.includes('评分') || q.includes('自评')) {
            result.action = 'stats_beauty';
        } else if (q.includes('身材') || q.includes('体型')) {
            result.action = 'stats_body_type';
        } else if (q.includes('兴趣') || q.includes('爱好')) {
            result.action = 'stats_interests';
        } else if (q.includes('体重')) {
            result.action = 'stats_weight';
        } else {
            result.action = 'stats_all';
        }
        return result;
    }

    // ====== 搜索/查找类查询 ======
    if (q.includes('查找') || q.includes('搜索') || q.includes('查询') || q.includes('找') || q.includes('推荐') || q.includes('介绍') || q.includes('有没有')) {
        result.action = 'search_users';

        // 性别
        if (/女(生|孩子|的)?$|^女(生|孩子|的)?[\s,，]/.test(q) || /找.*女/.test(q)) result.params.sex = '女';
        else if (/男(生|孩子|的)?$|^男(生|孩子|的)?[\s,，]/.test(q) || /找.*男/.test(q)) result.params.sex = '男';

        // 校区
        if (q.includes('珠海')) result.params.campus = '珠海';
        else if (q.includes('深圳')) result.params.campus = '深圳';
        else if (q.includes('南校') || q.includes('南校园') || q.includes('广州南')) result.params.campus = '南校园';
        else if (q.includes('北校') || q.includes('北校园') || q.includes('广州北')) result.params.campus = '北校园';
        else if (q.includes('东校') || q.includes('东校园') || q.includes('广州东') || q.includes('大学城')) result.params.campus = '东校园';

        // 年级
        const gradeMatch = q.match(/(大一|大二|大三|大四|大五|研一|研二|研三|研0|博士|博一|博二|博三)/);
        if (gradeMatch) result.params.grade = gradeMatch[1].replace('博一', '博士').replace('博二', '博士').replace('博三', '博士');

        // MBTI
        const mbtiMatch = q.match(/\b(INTJ|INTP|ENTJ|ENTP|INFJ|INFP|ENFJ|ENFP|ISTJ|ISFJ|ESTJ|ESFJ|ISTP|ISFP|ESTP|ESFP)\b/i);
        if (mbtiMatch) result.params.mbti = mbtiMatch[1].toUpperCase();

        // 兴趣爱好
        const interestMap = {
            '音乐': ['音乐', '唱歌', '听歌', '乐器', '弹琴', '吉他'],
            '运动': ['运动', '跑步', '健身', '体育', '打球', '篮球', '足球', '羽毛球', '游泳', '瑜伽'],
            '阅读': ['阅读', '读书', '看书', '小说', '文学', '看书'],
            '游戏': ['游戏', '打游戏', '电竞', '王者', '原神', 'LOL'],
            '美食': ['美食', '做饭', '烹饪', '烘焙', '吃货', '做菜', '料理'],
            '摄影': ['摄影', '拍照', '摄像', '相机'],
            '旅行': ['旅行', '旅游', '旅游', '出游', '自驾'],
            '动漫': ['动漫', '动画', '漫画', '二次元', '番剧', '日漫'],
            '绘画': ['绘画', '画画', '画图', '素描', '水彩', '插画'],
            '户外': ['户外', '露营', '爬山', '徒步', '骑行', '登山'],
            '手工': ['手工', 'DIY', '手作', '编织', '陶艺'],
            '电影': ['电影', '看电影', '影视', '追剧', '美剧', '日剧'],
            '宠物': ['宠物', '猫', '狗', '猫咪', '狗狗', '撸猫'],
            '舞蹈': ['舞蹈', '跳舞', '街舞', '芭蕾'],
            '书法': ['书法', '写字', '练字', '毛笔']
        };
        for (const [interest, keywords] of Object.entries(interestMap)) {
            if (keywords.some(k => q.includes(k))) {
                result.params.interests = interest;
                break;
            }
        }

        // 身高范围
        const heightMatch = q.match(/(\d{3})\s*[~\-到至]\s*(\d{3})/);
        if (heightMatch) {
            result.params.height_min = parseInt(heightMatch[1]);
            result.params.height_max = parseInt(heightMatch[2]);
        } else {
            const heightMinMatch = q.match(/(?:高于|不低于|至少|以上|≥|>)\s*(\d{3})/);
            if (heightMinMatch) result.params.height_min = parseInt(heightMinMatch[1]);
            const heightMaxMatch = q.match(/(?:低于|不超过|至多|以下|≤|<)\s*(\d{3})/);
            if (heightMaxMatch) result.params.height_max = parseInt(heightMaxMatch[1]);
        }

        // 匹配状态
        if (q.includes('参与匹配') || q.includes('开放匹配') || q.includes('可匹配')) {
            result.params.join_matching = 1;
        }

        // 专业
        const majorMap = {
            '人文社科类': ['人文', '社科', '文学', '历史', '哲学', '社会', '新闻', '传播', '外语', '英语', '法学', '法律', '政治', '心理'],
            '工学类': ['工学', '工程', '计算机', '软件', '电子', '通信', '机械', '土木', '自动化', '电气', '建筑', '材料'],
            '理学类': ['理学', '数学', '物理', '化学', '生物', '统计', '地理', '天文'],
            '医学类': ['医学', '临床', '药学', '护理', '口腔', '预防', '中医', '医'],
            '商学类': ['商学', '金融', '经济', '管理', '会计', '市场', '工商', '国贸', '财务'],
            '艺术类': ['艺术', '设计', '美术', '音乐', '表演', '舞蹈', '传媒', '编导']
        };
        for (const [major, keywords] of Object.entries(majorMap)) {
            if (keywords.some(k => q.includes(k))) {
                result.params.major = major;
                break;
            }
        }

        // 星座
        const constellationList = ['白羊座', '金牛座', '双子座', '巨蟹座', '狮子座', '处女座', '天秤座', '天蝎座', '射手座', '摩羯座', '水瓶座', '双鱼座'];
        for (const c of constellationList) {
            if (q.includes(c) || q.includes(c.replace('座', ''))) {
                result.params.constellation = c;
                break;
            }
        }

        // 恋爱目的
        if (q.includes('真诚恋爱') || q.includes('认真') || q.includes('结婚')) result.params.relationship_goal = '真诚恋爱';
        else if (q.includes('随缘')) result.params.relationship_goal = '随缘';
        else if (q.includes('短期') || q.includes('玩玩')) result.params.relationship_goal = '短期相处';

        return result;
    }

    // ====== 总数查询 ======
    if (q.includes('总数') || q.includes('总用户') || q.includes('一共') || q.includes('总共') || q.includes('多少人')) {
        result.action = 'count_users';
        return result;
    }

    // ====== 匹配推荐 ======
    if (q.includes('推荐') || q.includes('匹配推荐') || q.includes('合适')) {
        result.action = 'matching_recommend';
        return result;
    }

    // ====== 默认：综合查询 ======
    result.action = 'general_query';
    return result;
}

async function executeDatabaseQuery(action, params, pool) {
    try {
        switch (action) {
            case 'user_detail':
                const [userRows] = await pool.execute(
                    `SELECT u.*, a.join_matching, a.username as account_username,
                     a.email as account_email, a.created_at as account_created_at
                     FROM users u LEFT JOIN accounts a ON u.account_id = a.id
                     WHERE u.serial_number = ?`, [params.serial]
                );
                if (userRows.length === 0) {
                    return { type: 'empty', message: `未找到序列号为 ${params.serial} 的用户` };
                }
                return { type: 'detail', title: `用户 ${params.serial} 详情`, data: userRows[0] };

            case 'matching_stats':
                const [[matchTotal]] = await pool.execute(`SELECT COUNT(*) as count FROM accounts WHERE join_matching = 1`);
                const [[matchMale]] = await pool.execute(`SELECT COUNT(*) as count FROM accounts a JOIN users u ON a.id = u.account_id WHERE a.join_matching = 1 AND u.sex = '男'`);
                const [[matchFemale]] = await pool.execute(`SELECT COUNT(*) as count FROM accounts a JOIN users u ON a.id = u.account_id WHERE a.join_matching = 1 AND u.sex = '女'`);
                const [[totalAcc]] = await pool.execute(`SELECT COUNT(*) as count FROM accounts`);
                const [matchByCampus] = await pool.execute(
                    `SELECT u.campus, COUNT(*) as count FROM accounts a
                     JOIN users u ON a.id = u.account_id
                     WHERE a.join_matching = 1 AND u.campus IS NOT NULL
                     GROUP BY u.campus ORDER BY count DESC`
                );
                const [matchByGrade] = await pool.execute(
                    `SELECT u.grade, COUNT(*) as count FROM accounts a
                     JOIN users u ON a.id = u.account_id
                     WHERE a.join_matching = 1 AND u.grade IS NOT NULL
                     GROUP BY u.grade ORDER BY count DESC`
                );
                return {
                    type: 'stats',
                    title: '匹配参与统计',
                    data: {
                        totalAccounts: totalAcc?.count || 0,
                        totalMatching: matchTotal?.count || 0,
                        maleCount: matchMale?.count || 0,
                        femaleCount: matchFemale?.count || 0,
                        participationRate: totalAcc?.count > 0 ? Math.round((matchTotal?.count || 0) / totalAcc.count * 100) : 0,
                        byCampus: matchByCampus,
                        byGrade: matchByGrade
                    }
                };

            case 'recent_users':
                const limit = parseInt(params.limit) || 10;
                const [recentUsers] = await pool.query(
                    `SELECT serial_number, nickname, sex, sex_choice, campus, grade, major,
                     constellation, mbti, relationship_goal, experience, future_plan,
                     hometown, interests, height, body_type, fitness_level, created_at
                     FROM users ORDER BY created_at DESC LIMIT ${limit}`
                );
                return { type: 'table', title: `最近注册的 ${recentUsers.length} 个用户`, data: recentUsers };

            case 'stats_all':
                const [[totalUsers], [avgHeight], [avgBeauty],
                    sexDist, campusDist, gradeDist, mbtiDist, constellationDist,
                    relationshipGoalDist, experienceDist, futurePlanDist, hometownDist,
                    fitnessDist, bodyTypeDist] = await Promise.all([
                    pool.execute(`SELECT COUNT(*) as count FROM users`),
                    pool.execute(`SELECT AVG(height) as avg FROM users WHERE height IS NOT NULL`),
                    pool.execute(`SELECT AVG(beauty_self) as avg FROM users WHERE beauty_self IS NOT NULL`),
                    pool.execute(`SELECT sex, COUNT(*) as count FROM users GROUP BY sex`),
                    pool.execute(`SELECT campus, COUNT(*) as count FROM users GROUP BY campus`),
                    pool.execute(`SELECT grade, COUNT(*) as count FROM users GROUP BY grade`),
                    pool.execute(`SELECT mbti, COUNT(*) as count FROM users WHERE mbti IS NOT NULL AND mbti != '' GROUP BY mbti ORDER BY count DESC LIMIT 10`),
                    pool.execute(`SELECT constellation, COUNT(*) as count FROM users GROUP BY constellation`),
                    pool.execute(`SELECT relationship_goal, COUNT(*) as count FROM users GROUP BY relationship_goal`),
                    pool.execute(`SELECT experience, COUNT(*) as count FROM users GROUP BY experience`),
                    pool.execute(`SELECT future_plan, COUNT(*) as count FROM users GROUP BY future_plan`),
                    pool.execute(`SELECT hometown, COUNT(*) as count FROM users GROUP BY hometown ORDER BY count DESC LIMIT 15`),
                    pool.execute(`SELECT fitness_level, COUNT(*) as count FROM users GROUP BY fitness_level`),
                    pool.execute(`SELECT body_type, COUNT(*) as count FROM users GROUP BY body_type`)
                ]);
                return {
                    type: 'stats',
                    data: {
                        totalUsers, avgHeight: avgHeight?.avg || 0, avgBeauty: avgBeauty?.avg || 0,
                        sexDist, campusDist, gradeDist, mbtiDist, constellationDist,
                        relationshipGoalDist, experienceDist, futurePlanDist, hometownDist,
                        fitnessDist, bodyTypeDist
                    }
                };

            case 'stats_sex':
                const [sexStats] = await pool.execute(`SELECT sex, COUNT(*) as count FROM users GROUP BY sex`);
                return { type: 'stats', title: '性别分布', data: sexStats };

            case 'stats_campus':
                const [campusStats] = await pool.execute(`SELECT campus, COUNT(*) as count FROM users GROUP BY campus`);
                return { type: 'stats', title: '校区分布', data: campusStats };

            case 'stats_grade':
                const [gradeStats] = await pool.execute(`SELECT grade, COUNT(*) as count FROM users GROUP BY grade`);
                return { type: 'stats', title: '年级分布', data: gradeStats };

            case 'stats_mbti':
                const [mbtiStats] = await pool.execute(`SELECT mbti, COUNT(*) as count FROM users WHERE mbti IS NOT NULL AND mbti != '' GROUP BY mbti ORDER BY count DESC LIMIT 20`);
                return { type: 'stats', title: 'MBTI分布', data: mbtiStats };

            case 'stats_constellation':
                const [constellationStats] = await pool.execute(`SELECT constellation, COUNT(*) as count FROM users GROUP BY constellation`);
                return { type: 'stats', title: '星座分布', data: constellationStats };

            case 'stats_major':
                const [majorStats] = await pool.execute(`SELECT major, COUNT(*) as count FROM users GROUP BY major`);
                return { type: 'stats', title: '专业分布', data: majorStats };

            case 'stats_relationship_goal':
                const [goalStats] = await pool.execute(`SELECT relationship_goal, COUNT(*) as count FROM users GROUP BY relationship_goal`);
                return { type: 'stats', title: '恋爱目的分布', data: goalStats };

            case 'stats_experience':
                const [expStats] = await pool.execute(`SELECT experience, COUNT(*) as count FROM users GROUP BY experience`);
                return { type: 'stats', title: '恋爱经验分布', data: expStats };

            case 'stats_future_plan':
                const [futureStats] = await pool.execute(`SELECT future_plan, COUNT(*) as count FROM users GROUP BY future_plan`);
                return { type: 'stats', title: '未来计划分布', data: futureStats };

            case 'stats_fitness':
                const [fitnessStats] = await pool.execute(`SELECT fitness_level, COUNT(*) as count FROM users GROUP BY fitness_level`);
                return { type: 'stats', title: '健身水平分布', data: fitnessStats };

            case 'stats_body_type':
                const [bodyTypeStats] = await pool.execute(`SELECT body_type, COUNT(*) as count FROM users WHERE body_type IS NOT NULL AND body_type != '' GROUP BY body_type ORDER BY count DESC`);
                return { type: 'stats', title: '身材类型分布', data: bodyTypeStats };

            case 'stats_interests':
                const [interestStats] = await pool.execute(`SELECT interests, COUNT(*) as count FROM users WHERE interests IS NOT NULL AND interests != '' GROUP BY interests ORDER BY count DESC LIMIT 20`);
                return { type: 'stats', title: '兴趣爱好分布', data: interestStats };

            case 'stats_weight':
                const [avgWeightResult] = await pool.query(`SELECT AVG(weight) as avg FROM users WHERE weight IS NOT NULL AND weight > 0 AND weight < 300`);
                const [minWeightResult] = await pool.query(`SELECT MIN(weight) as min FROM users WHERE weight IS NOT NULL AND weight > 0 AND weight < 300`);
                const [maxWeightResult] = await pool.query(`SELECT MAX(weight) as max FROM users WHERE weight IS NOT NULL AND weight > 0 AND weight < 300`);
                return { type: 'stats', title: '体重统计', data: { avg: avgWeightResult[0]?.avg || 0, min: minWeightResult[0]?.min || 0, max: maxWeightResult[0]?.max || 0 } };

            case 'stats_hometown':
                const [hometownStats] = await pool.execute(`SELECT hometown, COUNT(*) as count FROM users GROUP BY hometown ORDER BY count DESC LIMIT 20`);
                return { type: 'stats', title: '家乡分布', data: hometownStats };

            case 'stats_height':
                const [avgHeightResult] = await pool.query(`SELECT AVG(height) as avg FROM users WHERE height IS NOT NULL AND height > 0 AND height < 300`);
                const [minHeightResult] = await pool.query(`SELECT MIN(height) as min FROM users WHERE height IS NOT NULL AND height > 0 AND height < 300`);
                const [maxHeightResult] = await pool.query(`SELECT MAX(height) as max FROM users WHERE height IS NOT NULL AND height > 0 AND height < 300`);
                const [heightDist] = await pool.query(
                    `SELECT CASE
                        WHEN height < 155 THEN '150-155cm'
                        WHEN height < 160 THEN '155-160cm'
                        WHEN height < 165 THEN '160-165cm'
                        WHEN height < 170 THEN '165-170cm'
                        WHEN height < 175 THEN '170-175cm'
                        WHEN height < 180 THEN '175-180cm'
                        WHEN height < 185 THEN '180-185cm'
                        ELSE '185cm以上'
                    END as range, COUNT(*) as count
                    FROM users WHERE height IS NOT NULL AND height > 0 AND height < 300
                    GROUP BY range ORDER BY range`
                );
                return { type: 'stats', title: '身高统计', data: { avg: avgHeightResult[0]?.avg || 0, min: minHeightResult[0]?.min || 0, max: maxHeightResult[0]?.max || 0, distribution: heightDist } };

            case 'stats_beauty':
                const [avgBeautyResult] = await pool.query(`SELECT AVG(beauty_self) as avg FROM users WHERE beauty_self IS NOT NULL AND beauty_self > 0 AND beauty_self <= 10`);
                const [beautyDist] = await pool.query(`SELECT beauty_self as score, COUNT(*) as count FROM users WHERE beauty_self IS NOT NULL AND beauty_self > 0 AND beauty_self <= 10 GROUP BY beauty_self ORDER BY beauty_self`);
                return { type: 'stats', title: '颜值评分统计', data: { avg: avgBeautyResult[0]?.avg || 0, distribution: beautyDist } };

            case 'search_users':
                let where = '1=1';
                let queryParams = [];
                if (params.sex) {
                    where += ' AND sex = ?';
                    queryParams.push(params.sex);
                }
                if (params.campus) {
                    where += ' AND campus = ?';
                    queryParams.push(params.campus);
                }
                if (params.join_matching) {
                    where += ' AND account_id IN (SELECT id FROM accounts WHERE join_matching = 1)';
                }
                if (params.interests) {
                    where += ' AND interests LIKE ?';
                    queryParams.push(`%${params.interests}%`);
                }
                if (params.grade) {
                    where += ' AND grade = ?';
                    queryParams.push(params.grade);
                }
                if (params.mbti) {
                    where += ' AND mbti = ?';
                    queryParams.push(params.mbti);
                }
                if (params.major) {
                    where += ' AND major LIKE ?';
                    queryParams.push(`%${params.major}%`);
                }
                if (params.constellation) {
                    where += ' AND constellation = ?';
                    queryParams.push(params.constellation);
                }
                if (params.relationship_goal) {
                    where += ' AND relationship_goal = ?';
                    queryParams.push(params.relationship_goal);
                }
                if (params.height_min) {
                    where += ' AND CAST(height AS DECIMAL) >= ?';
                    queryParams.push(params.height_min);
                }
                if (params.height_max) {
                    where += ' AND CAST(height AS DECIMAL) <= ?';
                    queryParams.push(params.height_max);
                }
                const [searchUsers] = await pool.query(
                    `SELECT serial_number, nickname, sex, sex_choice, school, campus, grade, major,
                     constellation, mbti, relationship_goal, experience, future_plan,
                     hometown, interests, height, body_type, fitness_level,
                     beauty_self, self_description, created_at
                     FROM users WHERE ${where} LIMIT 50`,
                    queryParams
                );
                return { type: 'table', title: `搜索结果（共 ${searchUsers.length} 条）`, data: searchUsers };

            case 'count_users':
                const [[countResult]] = await pool.execute(`SELECT COUNT(*) as count FROM users`);
                const [[maleCount]] = await pool.execute(`SELECT COUNT(*) as count FROM users WHERE sex = '男'`);
                const [[femaleCount]] = await pool.execute(`SELECT COUNT(*) as count FROM users WHERE sex = '女'`);
                return { type: 'count', data: { total: countResult.count, male: maleCount.count, female: femaleCount.count } };

            case 'matching_recommend':
                const [recommendUsers] = await pool.execute(
                    `SELECT serial_number, nickname, sex, school, campus, grade, major,
                     constellation, mbti, relationship_goal, interests, height,
                     self_description, created_at
                     FROM users WHERE account_id IN (SELECT id FROM accounts WHERE join_matching = 1)
                     ORDER BY RAND() LIMIT 10`
                );
                return { type: 'table', title: '匹配推荐用户', data: recommendUsers };

            default:
                const [allUsers] = await pool.execute(
                    `SELECT serial_number, nickname, sex, school, campus, grade, major, created_at
                     FROM users ORDER BY created_at DESC LIMIT 20`
                );
                const [[totalCount]] = await pool.execute(`SELECT COUNT(*) as count FROM users`);
                return { type: 'table', title: `用户列表（共 ${totalCount.count} 人，显示最近 20 条）`, data: allUsers };
        }
    } catch (error) {
        console.error('Database query error:', error);
        throw error;
    }
}

app.post('/llm/chat', adminAuthMiddleware, async (req, res) => {
    try {
        const { messages, max_tokens = 2000, temperature = 0.7 } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.json({ code: 400, msg: '无效的请求参数' });
        }

        const userMessage = messages[messages.length - 1].content;
        const queryPlan = parseUserQuery(userMessage);

        const pool = await getPool();
        const queryResult = await executeDatabaseQuery(queryPlan.action, queryPlan.params, pool);

        const fieldDescriptions = {
            'id': '用户ID（数据库自增）',
            'account_id': '关联的账号ID',
            'serial_number': '用户唯一序列号（如SYSU-XXXXXX）',
            'email': '邮箱',
            'contact_email': '联系邮箱',
            'nickname': '昵称',
            'sex': '性别（男/女）',
            'sex_choice': '期望的性别（想找男/女）',
            'grade': '年级（大一/大二/大三/大四/大五(医学)/研一/研二/研三/博士/研0）',
            'grade_prefer': '期望的年级范围',
            'relationship_goal': '恋爱目的（如：真诚恋爱、短期相处、随缘等）',
            'experience': '恋爱经验（如：母胎solo、有一段经历、有多段经历等）',
            'ex_prefer': '对前任的期望',
            'future_plan': '未来计划（如：直接就业、继续深造、出国等）',
            'major': '专业大类（如：人文社科类、工学类、理学类、医学类、商学类、艺术类等）',
            'prefer_major': '期望的专业大类',
            'campus': '校区（南校园/北校园/东校园/珠海/深圳）',
            'hometown': '家乡',
            'constellation': '星座',
            'constellation_prefer': '期望的星座',
            'mbti': 'MBTI性格类型（如：INTJ、ENFP、INFJ等，共16种）',
            'mbti_prefer': '期望的MBTI',
            'interests': '兴趣爱好（如：音乐,运动,阅读,游戏,美食,摄影,旅行,动漫,绘画,健身,跑步,烹饪,手工,户外等）',
            'interest_custom': '自定义兴趣',
            'height': '身高(cm)',
            'height_min': '期望的最低身高(cm)',
            'height_max': '期望的最高身高(cm)',
            'beauty_self': '自我评分(1-10分)',
            'beauty_prefer_min': '对对方最低颜值要求(1-10分)',
            'body_type': '身材类型（如：偏瘦,匀称,偏壮,健壮等）',
            'fitness_level': '健身水平（如：不太运动、偶尔运动、经常运动、健身达人）',
            'body_prefer': '对对方身材期望',
            'fitness_prefer': '对对方健身水平期望',
            'q1_co_dependent': '问卷问题1：关于恋爱中的依赖程度',
            'q2_conflict': '问卷问题2：关于冲突处理方式',
            'q3_ritual': '问卷问题3：关于恋爱仪式感',
            'q4_consumption': '问卷问题4：关于消费观念',
            'q5_life_focus': '问卷问题5：关于生活重心',
            'q6_emotion': '问卷问题6：关于情绪表达',
            'agree_topics': '共同话题',
            'self_description': '自我介绍',
            'ideal_description': '理想对象描述',
            'photos': '照片URL列表',
            'display_self': '展示设置',
            'feedback': '反馈',
            'avatar': '头像URL',
            'created_at': '注册/创建时间',
            'updated_at': '最后更新时间',
            'join_matching': '是否参与匹配(1=参与,NULL=未参与)',
            'account_username': '关联的账号用户名'
        };

        const resultType = queryResult.type;
        let resultSummary = '';

        if (resultType === 'table') {
            resultSummary = `查询到 ${queryResult.data.length} 条记录`;
        } else if (resultType === 'stats') {
            resultSummary = '统计数据';
        } else if (resultType === 'count') {
            resultSummary = `总用户数: ${queryResult.data.total}（男 ${queryResult.data.male} / 女 ${queryResult.data.female}）`;
        } else if (resultType === 'detail') {
            resultSummary = `用户 ${queryResult.data.nickname || queryResult.data.serial_number} 的详细信息`;
        } else if (resultType === 'empty') {
            resultSummary = queryResult.message;
        }

        const systemPrompt = `你是 FancyU 管理后台的数据分析助手。你基于真实的数据库查询结果回答管理员的问题。

【你的身份】
- 你是专业的数据分析师，回答要简洁、准确、有条理
- 使用中文回答，语气专业友好

【重要规则 - 必须严格遵守】
1. 只使用查询结果中提供的数据，不要编造、推断或联想任何不在结果中的信息
2. 如果结果为空或数量为0，明确告知用户"没有找到符合条件的用户"
3. 字段对应关系（不要混淆！）：
   - major = 专业大类（如"人文社科类"、"工学类"、"理学类"、"医学类"、"商学类"、"艺术类"等）
   - interests = 兴趣爱好（如"音乐"、"运动"、"阅读"、"游戏"、"美食"、"摄影"、"旅行"、"动漫"、"绘画"、"健身"、"烹饪"、"手工"、"户外"等）
   - relationship_goal = 恋爱目的（如"真诚恋爱"、"短期相处"、"随缘"等）
   - experience = 恋爱经验（如"母胎solo"、"有一段经历"、"有多段经历"等）
   - fitness_level = 健身水平（如"不太运动"、"偶尔运动"、"经常运动"、"健身达人"等）
   - body_type = 身材类型（如"偏瘦"、"匀称"、"偏壮"、"健壮"等）
   - campus = 校区（南校园/北校园/东校园/珠海/深圳）
4. 只描述结果中实际存在的数据，不要添加你的个人理解或推断

【回答格式要求】
- 先给出总体结论/摘要
- 然后列出具体数据
- 如果是用户列表，列出昵称、性别、校区、年级等关键信息
- 如果是统计数据，列出各项的数值和占比
- 使用数字和列表让回答更清晰

【本次查询信息】
- 用户问题: "${userMessage}"
- 识别到的查询类型: ${queryPlan.action}
- 查询参数: ${JSON.stringify(queryPlan.params)}
- 结果摘要: ${resultSummary}

【字段说明】
${Object.entries(fieldDescriptions).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

【查询结果】
${JSON.stringify(queryResult, null, 2)}

请基于以上真实的查询结果回答用户的问题。`;

        const chatMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
        ];

        const response = await fetch(LLM_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: '/home/sse/model/qwen3.5-2b',
                messages: chatMessages,
                max_tokens: max_tokens,
                temperature: temperature
            })
        });

        if (!response.ok) {
            console.error('LLM API error:', response.status);
            return res.json({ code: 502, msg: 'LLM 服务不可用' });
        }

        const data = await response.json();
        return res.json({ code: 200, data: data });

    } catch (error) {
        console.error('LLM chat error:', error);
        return res.json({ code: 500, msg: '处理失败: ' + error.message });
    }
});

// ==================== AI助手对话存储 ====================

async function ensureChatSessionsTable(pool) {
    try {
        await pool.execute(`CREATE TABLE IF NOT EXISTS chat_sessions (
            id VARCHAR(64) PRIMARY KEY,
            title VARCHAR(255) NOT NULL DEFAULT '新对话',
            messages JSON NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_updated (updated_at)
        )`);
    } catch (e) {
        console.log('ensureChatSessionsTable:', e.message.substring(0, 100));
    }
}

app.get('/admin/chat/list', adminAuthMiddleware, async (req, res) => {
    try {
        const pool = await getPool();
        await ensureChatSessionsTable(pool);
        const [rows] = await pool.execute(
            `SELECT id, title, created_at, updated_at FROM chat_sessions ORDER BY updated_at DESC LIMIT 50`
        );
        return res.json({ code: 200, data: rows });
    } catch (error) {
        console.error('Chat list error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

app.get('/admin/chat/:id', adminAuthMiddleware, async (req, res) => {
    try {
        const pool = await getPool();
        await ensureChatSessionsTable(pool);
        const [rows] = await pool.execute(
            `SELECT * FROM chat_sessions WHERE id = ?`, [req.params.id]
        );
        if (rows.length === 0) return res.json({ code: 404, msg: '对话不存在' });
        const chat = rows[0];
        chat.messages = typeof chat.messages === 'string' ? JSON.parse(chat.messages) : chat.messages;
        return res.json({ code: 200, data: chat });
    } catch (error) {
        console.error('Chat get error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

app.post('/admin/chat/save', adminAuthMiddleware, async (req, res) => {
    try {
        const { id, title, messages } = req.body;
        if (!id || !messages) {
            return res.json({ code: 400, msg: '缺少必要参数' });
        }
        const pool = await getPool();
        await ensureChatSessionsTable(pool);
        const chatTitle = title || (messages.length > 0 ? messages[0].content.substring(0, 30) : '新对话');
        await pool.execute(
            `INSERT INTO chat_sessions (id, title, messages) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE title = VALUES(title), messages = VALUES(messages)`,
            [id, chatTitle, JSON.stringify(messages)]
        );
        return res.json({ code: 200, msg: '保存成功' });
    } catch (error) {
        console.error('Chat save error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

app.delete('/admin/chat/:id', adminAuthMiddleware, async (req, res) => {
    try {
        const pool = await getPool();
        await ensureChatSessionsTable(pool);
        await pool.execute(`DELETE FROM chat_sessions WHERE id = ?`, [req.params.id]);
        return res.json({ code: 200, msg: '已删除' });
    } catch (error) {
        console.error('Chat delete error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// ==================== 投诉管理（管理员） ====================

app.get('/admin/complaints', adminAuthMiddleware, async (req, res) => {
    try {
        const pool = await getPool();
        await ensureComplaintTable(pool);
        const { status, page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let query = `SELECT * FROM complaints`;
        let countQuery = `SELECT COUNT(*) as total FROM complaints`;
        const params = [];

        if (status) {
            query += ` WHERE status = ?`;
            countQuery += ` WHERE status = ?`;
            params.push(status);
        }

        query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;

        const [countRows] = await pool.execute(countQuery, status ? [status] : []);
        const total = countRows[0].total;

        const [rows] = await pool.execute(query, [...params, parseInt(limit), offset]);

        return res.json({
            code: 200,
            data: {
                complaints: rows,
                total,
                page: parseInt(page),
                limit: parseInt(limit)
            }
        });
    } catch (error) {
        console.error('Admin complaints error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

app.post('/admin/complaint/:id/status', adminAuthMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, admin_reply } = req.body;

        if (!status || !['pending', 'processing', 'resolved', 'dismissed'].includes(status)) {
            return res.json({ code: 400, msg: '无效的状态值' });
        }

        const pool = await getPool();
        await ensureComplaintTable(pool);

        await pool.execute(
            `UPDATE complaints SET status = ?, admin_reply = ? WHERE id = ?`,
            [status, admin_reply || null, id]
        );

        return res.json({ code: 200, msg: '状态已更新' });
    } catch (error) {
        console.error('Admin complaint status error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// ==================== 数据库迁移端点 ====================

app.post('/migrate', async (req, res) => {
    return res.json({ code: 403, msg: '迁移端点已禁用' });
});

// ==================== 原有 API（保持兼容） ====================

app.get('/', async (req, res) => {
    const { action, email, serial, code } = req.query;
    if (!action) {
        // 部署补丁: 根路径返回首页
        return res.sendFile(path.join(WEB_DIR, 'index.html'));
    }
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    
    try {
        if (action === 'generateSerial') {
            if (!checkRateLimit(clientIp, 'generateSerial', 5, 60000)) {
                return res.json({ code: 429, msg: '请求过于频繁，请稍后再试' });
            }
            if (!email) {
                return res.json({ code: 400, msg: '邮箱不能为空' });
            }
            const serialNumber = generateUniqueSerialNumber();
            return res.json({ code: 200, serialNumber });
        }
        
        if (action === 'query') {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.json({ code: 401, msg: '请先登录后再查询' });
            }
            const decoded = verifyToken(authHeader.slice(7));
            if (!decoded) {
                return res.json({ code: 401, msg: '登录已过期，请重新登录' });
            }
            if (!serial) {
                return res.json({ code: 400, msg: '缺少序列号参数' });
            }
            const userData = await queryUserBySerial(serial);
            if (!userData) {
                return res.json({ code: 404, msg: '未找到该用户' });
            }
            const filteredData = filterByDisplaySelf(userData, userData.display_self);
            if (filteredData) {
                filteredData.contact_email = userData.contact_email;
                filteredData.display_self = userData.display_self;
            }
            return res.json({ code: 200, msg: '查询成功', data: filteredData });
        }

        if (action === 'debug') {
            if (!serial) {
                return res.json({ code: 400, msg: '缺少序列号参数' });
            }
            const userData = await queryUserBySerial(serial);
            if (!userData) {
                return res.json({ code: 404, msg: '未找到该用户' });
            }
            return res.json({ code: 200, msg: '调试数据', debug: {
                hometown: userData.hometown,
                display_self: userData.display_self,
                interests: userData.interests,
                interest_custom: userData.interest_custom,
                full_data: userData
            }});
        }
        
        if (action === 'getSurveyData') {
            if (!checkRateLimit(clientIp, 'getSurveyData', 10, 60000)) {
                return res.json({ code: 429, msg: '请求过于频繁，请稍后再试' });
            }
            if (!serial || !email || !code) {
                return res.json({ code: 400, msg: '缺少必要参数（serial, email, code）' });
            }
            
            const isValidCode = await verifyAndDeleteCode(email, code);
            if (!isValidCode) {
                return res.json({ code: 400, msg: '验证码错误或已过期' });
            }
            
            const userData = await queryUserBySerial(serial);
            if (!userData) {
                return res.json({ code: 404, msg: '未找到该序列号对应的问卷' });
            }
            if (userData.email !== email && userData.contact_email !== email) {
                return res.json({ code: 403, msg: '序列号与邮箱不匹配' });
            }
            
            return res.json({ code: 200, data: userData });
        }

        if (action === 'queryByUserId') {
            const { userId } = req.query;
            if (!userId) {
                return res.json({ code: 400, msg: '缺少userId参数' });
            }
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.json({ code: 401, msg: '请先登录后再查询' });
            }
            const decoded = verifyToken(authHeader.slice(7));
            if (!decoded) {
                return res.json({ code: 401, msg: '登录已过期，请重新登录' });
            }
            const [rows] = await pool.execute(
                `SELECT u.account_id, u.nickname, u.sex, u.grade, u.major, u.mbti,
                        u.interests, u.self_description, u.height, u.body_type, u.hometown,
                        u.photo_urls, u.display_self, u.created_at,
                        ae.email as contact_email
                 FROM users u
                 LEFT JOIN account_emails ae ON u.account_id = ae.account_id
                 WHERE u.account_id = ?`,
                [userId]
            );
            if (rows.length === 0) {
                return res.json({ code: 404, msg: '未找到该用户' });
            }
            const userData = rows[0];
            const filteredData = filterByDisplaySelf(userData, userData.display_self);
            if (filteredData) {
                filteredData.contact_email = userData.contact_email;
                filteredData.display_self = userData.display_self;
            }
            return res.json({ code: 200, msg: '查询成功', data: filteredData });
        }

        return res.json({ code: 400, msg: '无效请求' });
    } catch (error) {
        console.error('GET API Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

app.post('/', async (req, res) => {
    const { action, email, code, serial, source, data } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    
    try {
        if (action === 'sendCode') {
            if (!checkRateLimit(clientIp, 'sendCode', 5, 60000)) {
                return res.json({ code: 429, msg: '请求过于频繁，请稍后再试' });
            }
            if (!email) {
                return res.json({ code: 400, msg: '邮箱不能为空' });
            }

            // 部署补丁: 不检查邮箱后缀

            if (source === 'index') {
                const { exceeded, attempts } = await checkVerifyAttempts(email);
                if (exceeded) {
                    return res.json({ code: 429, msg: `验证码尝试次数过多（${attempts}/5），请1小时后再试` });
                }
            }
            
            if (await checkRecentSend(email)) {
                return res.json({ code: 400, msg: '请等待60秒后再试' });
            }
            
            const verifyCode = generateCode();
            // 部署补丁: 不实际发信(无SMTP), 任意验证码可通过
            try { await saveCode(email, verifyCode, source || 'general'); } catch (e) {}
            
            return res.json({ code: 200, msg: '验证码已发送' });
        }
        
        if (action === 'checkCode') {
            if (!email || !code) {
                return res.json({ code: 400, msg: '邮箱和验证码不能为空' });
            }
            const isValid = await verifyCode(email, code);
            return isValid 
                ? res.json({ code: 200, msg: '验证通过' })
                : res.json({ code: 400, msg: '验证码错误或已过期' });
        }
        
        if (action === 'verifyMatch') {
            if (!checkRateLimit(clientIp, 'verifyMatch', 5, 60000)) {
                return res.json({ code: 429, msg: '请求过于频繁，请稍后再试' });
            }
            if (!serial || !email) {
                return res.json({ code: 400, msg: '序列号和邮箱不能为空' });
            }
            
            const isMatch = await verifySerialAndEmail(serial, email);
            if (!isMatch) {
                return res.json({ code: 403, msg: '序列号与邮箱不匹配' });
            }
            
            if (await checkRecentSend(email)) {
                return res.json({ code: 400, msg: '请等待60秒后再试' });
            }
            
            const verifyCode = generateCode();
            await sendVerificationEmail(email, verifyCode);
            await saveCode(email, verifyCode, 'modify');
            
            return res.json({ code: 200, msg: '验证码已发送' });
        }
        
        if (action === 'submitSurvey') {
            if (!checkRateLimit(clientIp, 'submitSurvey', 5, 60000)) {
                return res.json({ code: 429, msg: '请求过于频繁，请稍后再试' });
            }
            if (!data) {
                return res.json({ code: 400, msg: '缺少必要参数' });
            }

            // 设置问卷类型
            if (!data['survey_type']) {
                data['survey_type'] = 'love';
            }

            // 自动生成序列号
            if (!data['serial_number']) {
                data['serial_number'] = generateUniqueSerialNumber();
            }

            // 从 JWT token 提取 account_id 和账号邮箱
            let accountEmail = null;
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const decoded = verifyToken(authHeader.slice(7));
                if (decoded) {
                    if (decoded.account_id) {
                        data['account_id'] = decoded.account_id;
                    }
                    if (decoded.email) {
                        accountEmail = decoded.email;
                        data['account_email'] = decoded.email;
                    }
                }
            }

            // 从 contact_entries 中提取邮箱，或使用账号邮箱（不强制要求邮箱）
            let submitEmail = data['contact_email'] || email;
            if (!submitEmail && data['contact_entries'] && data['contact_entries'].length > 0) {
                const emailEntry = data['contact_entries'].find(e => e.method === '邮箱');
                if (emailEntry) {
                    submitEmail = emailEntry.value;
                }
            }
            if (!submitEmail) {
                submitEmail = accountEmail;
            }

            // 前端 own_campus 映射到后端 campus 字段
            if (data['own_campus'] && !data['campus']) {
                data['campus'] = data['own_campus'];
            }

            const result = await saveSurveyData(submitEmail, data);

            // 有邮箱才发送确认邮件
            if (submitEmail) {
                try {
                    await sendConfirmationEmail(submitEmail, result.serialNumber);
                } catch (emailError) {
                    console.error('确认邮件发送失败:', emailError);
                }
            }
            
            return res.json({ code: 200, msg: '提交成功', serialNumber: result.serialNumber });
        }

        if (action === 'submitFriendSurvey') {
            if (!checkRateLimit(clientIp, 'submitFriendSurvey', 5, 60000)) {
                return res.json({ code: 429, msg: '请求过于频繁，请稍后再试' });
            }
            if (!data) {
                return res.json({ code: 400, msg: '缺少必要参数' });
            }

            let accountId = null;
            let userEmail = email;

            const authHeader = req.headers['authorization'];
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.slice(7);
                const decoded = verifyToken(token);
                if (decoded) {
                    accountId = decoded.account_id;
                    userEmail = decoded.email;
                }
            }

            if (!accountId) {
                return res.json({ code: 401, msg: '请先登录' });
            }

            if (!data['contact_entries'] || !Array.isArray(data['contact_entries']) || data['contact_entries'].length === 0) {
                return res.json({ code: 400, msg: '请添加至少一种联系方式' });
            }

            data['email'] = userEmail;
            const result = await saveFriendSurveyData(accountId, data);

            return res.json({ code: 200, msg: '提交成功' });
        }
        
        if (action === 'updateSurvey' || action === 'modifySurvey') {
            if (!checkRateLimit(clientIp, 'updateSurvey', 3, 60000)) {
                return res.json({ code: 429, msg: '请求过于频繁，请稍后再试' });
            }
            if (!serial || !email || !data) {
                return res.json({ code: 400, msg: '缺少必要参数（serial, email, data）' });
            }
            
            const existingUser = await queryUserBySerial(serial);
            if (!existingUser) {
                return res.json({ code: 404, msg: '未找到该序列号对应的问卷' });
            }
            if (existingUser.email !== email && existingUser.contact_email !== email) {
                return res.json({ code: 403, msg: '序列号与邮箱不匹配' });
            }
            
            // 前端字段映射: own_campus → campus
            if (data['own_campus'] && !data['campus']) {
                data['campus'] = data['own_campus'];
            }

            await updateSurveyData(serial, data, existingUser.survey_type);

            return res.json({ code: 200, msg: '更新成功' });
        }
        
        return res.json({ code: 400, msg: '无效请求' });
    } catch (error) {
        console.error('POST API Error:', error);
        return res.json({ code: 500, msg: error.message || '服务器错误' });
    }
});

// ==================== 敏感词过滤 ====================

const SENSITIVE_WORDS = [
    '暴力', '色情', '赌博', '毒品', '枪支', '弹药', '爆炸',
    '杀人', '抢劫', '诈骗', '传销', '邪教', '恐怖', '分裂',
    '反动', '卖淫', '嫖娼', '吸毒', '贩毒', '走私', '洗钱',
    '代购', '刷单', '兼职', '日结', '高薪', '招嫖', '约炮',
    '一夜情', '裸聊', '援交', '包养', '小三', '二奶', '情妇',
    '赌博网站', '彩票', '赌场', '赌球', '赌马',
    '枪支', '仿真枪', '管制刀具', '弩',
    '办证', '发票', '发票代开', '代开发票',
    '作弊', '代考', '替考', '代写论文', '代写作业',
    '器官', '卖肾', '捐卵', '代孕',
    '封建迷信', '算命', '看相', '风水'
];

function containsSensitiveWords(text) {
    if (!text) return false;
    // 如果是数组，转为字符串再检查
    const str = Array.isArray(text) ? JSON.stringify(text) : String(text);
    const lower = str.toLowerCase();
    for (const word of SENSITIVE_WORDS) {
        if (lower.includes(word.toLowerCase())) {
            return word;
        }
    }
    return false;
}

// ==================== 投诉举报 ====================

async function ensureComplaintTable(pool) {
    try {
        await pool.execute(`CREATE TABLE IF NOT EXISTS complaints (
            id INT AUTO_INCREMENT PRIMARY KEY,
            reporter_account_id INT,
            reporter_email VARCHAR(255),
            target_type ENUM('user', 'content', 'other') DEFAULT 'other',
            target_id VARCHAR(255),
            reason TEXT NOT NULL,
            description TEXT,
            contact_email VARCHAR(255),
            status ENUM('pending', 'processing', 'resolved', 'dismissed') DEFAULT 'pending',
            admin_reply TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_status (status),
            INDEX idx_reporter (reporter_account_id)
        )`);
    } catch (e) {
        console.log('ensureComplaintTable:', e.message.substring(0, 100));
    }
}

app.post('/api/complaint', async (req, res) => {
    try {
        const { target_type, target_id, reason, description, contact_email } = req.body;
        if (!reason) {
            return res.json({ code: 400, msg: '请填写投诉原因' });
        }
        const pool = await getPool();
        await ensureComplaintTable(pool);
        let reporterAccountId = null;
        try {
            const authHeader = req.headers['authorization'];
            if (authHeader) {
                const token = authHeader.split(' ')[1];
                const decoded = jwt.verify(token, JWT_SECRET);
                reporterAccountId = decoded.account_id;
            }
        } catch (e) {}
        await pool.execute(
            `INSERT INTO complaints (reporter_account_id, reporter_email, target_type, target_id, reason, description, contact_email)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [reporterAccountId, null, target_type || 'other', target_id || null, reason, description || null, contact_email || null]
        );
        return res.json({ code: 200, msg: '投诉已提交，我们会尽快处理' });
    } catch (error) {
        console.error('Complaint Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// ==================== 撤回同意 ====================

app.post('/account/withdraw-consent', authMiddleware, async (req, res) => {
    try {
        const accountId = req.account.account_id;
        const pool = await getPool();
        await pool.execute(`UPDATE account_preferences SET join_matching = 0, join_friend_matching = 0 WHERE account_id = ?`, [accountId]);
        await pool.execute(`DELETE FROM match_history WHERE account_id = ?`, [accountId]);
        return res.json({ code: 200, msg: '已撤回同意，您已退出所有匹配并清空匹配历史' });
    } catch (error) {
        console.error('Withdraw Consent Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

// ==================== 在问卷提交中应用敏感词过滤 ====================

const originalSaveSurveyData = saveSurveyData;
saveSurveyData = async function(email, data) {
    const sensitiveFields = ['nickname', 'interests', 'interest_custom', 'self_description', 'ideal_description', 'feedback'];
    for (const field of sensitiveFields) {
        if (data[field]) {
            const found = containsSensitiveWords(data[field]);
            if (found) {
                throw new Error(`内容包含敏感词「${found}」，请修改后重新提交`);
            }
        }
    }
    return originalSaveSurveyData.call(this, email, data);
};

// 部署补丁: 静态页面托管(放在所有 API 路由之后) + 端口取环境变量
app.use(express.static(WEB_DIR));
app.use((req, res) => {
    if (req.method === 'GET' && !req.path.startsWith('/account') && !req.path.startsWith('/admin') && !req.path.startsWith('/api') && !req.path.startsWith('/llm')) {
        return res.status(404).sendFile(path.join(WEB_DIR, 'index.html'));
    }
    return res.json({ code: 404, msg: 'Not Found' });
});

const PORT = parseInt(process.env.PORT || '9000', 10);
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

console.log('Function instance started successfully');
