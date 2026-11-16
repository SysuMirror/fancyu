const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
// 保留原始请求体字节，供支付回调 HMAC 验签使用（与学人汇签名逐字节一致）。
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

// ===== 部署补丁: /api 前缀剥离 + 静态页面托管 =====
const path = require('path');
const WEB_DIR = process.env.WEB_DIR || path.join(__dirname, '..', 'web');
app.use((req, res, next) => {
    if (req.url === '/api' || req.url.startsWith('/api/') || req.url.startsWith('/api?')) {
        req.url = req.url.slice(4) || '/';
        if(req.url.startsWith('?'))req.url='/'+req.url;
    }
    next();
});

// ===== 安全响应头：在浏览器侧兜住 XSS 升级与点击劫持 =====
// 页面仍使用内联事件处理器（onclick=…），故 script-src 必须保留 'unsafe-inline'；
// 但外部域脚本被禁止，配合 nosniff 可以挡掉「注入 <script src=//evil>」这类升级路径。
// 站点字体全部走本地栈（已移除两处 Google Fonts 引用），故外部源一律不放行：
// connect-src 收紧到 'self' 之后，即便有人注入脚本也没有可用的外发通道。
const CSP = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",   // 聊天用同源 WebSocket（部分浏览器不把 ws:// 算进 'self'）
    "form-action 'self'",
    "manifest-src 'self'"
].join('; ');
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // HSTS 只在 HTTPS 下才有意义（本站由前置代理终止 TLS，所以看 X-Forwarded-Proto）。
    if (req.secure || String(req.headers['x-forwarded-proto'] || '') === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
});

// ===== gzip：JSON 响应 =====
// 没有引 compression 包（pod 里装包流程复杂），用内置 zlib 只对 JSON 做同步压缩：
// 接口体积普遍几 KB~几十 KB，压完通常小 70%+，对手机端首屏意义明显。
const zlib = require('zlib');
function gzipOk(req) { return /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')); }
app.use((req, res, next) => {
    const can = gzipOk(req);
    const json = res.json.bind(res);
    res.json = function (body) {
        if (!can || res.headersSent || res.getHeader('Content-Encoding')) return json(body);
        let buf;
        try { buf = Buffer.from(JSON.stringify(body)); } catch (e) { return json(body); }
        if (buf.length < 512) return json(body);           // 小响应压了反而更大
        try { buf = zlib.gzipSync(buf); } catch (e) { return json(body); }
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', String(buf.length));
        res.setHeader('Vary', 'Accept-Encoding');
        return res.end(buf);
    };
    next();
});

// ===== 客户端 IP（限流键）=====
// 只信 X-Forwarded-For 的「最后一跳」：它由本站前置代理追加，客户端伪造不到末位。
// 以前直接用整串 XFF 当键，攻击者每次换一个值就能把限流键打散（/admin/login 实测可无限重试）。
function isIpLike(v) {
    if (!v) return false;
    v = String(v).trim();
    return v.length > 0 && v.length <= 45 && /^[0-9a-fA-F:.]+$/.test(v) && /[0-9a-fA-F]/.test(v);
}
function trustedIp(req) {
    const raw = req.headers['x-forwarded-for'];
    let ip = '';
    if (typeof raw === 'string' && raw.length) { const parts = raw.split(','); ip = parts[parts.length - 1]; }
    ip = String(ip || '').trim().replace(/^::ffff:/, '');
    if (!isIpLike(ip)) ip = String((req.socket && req.socket.remoteAddress) || '').trim().replace(/^::ffff:/, '');
    return isIpLike(ip) ? ip.toLowerCase() : 'unknown';
}

// 站点图标：优先返回 web/favicon.ico（品牌绿叶标），文件缺失时回退空白图标。
app.get('/favicon.ico', (req, res) => {
    res.setHeader('Content-Type', 'image/x-icon');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.sendFile(path.join(WEB_DIR, 'favicon.ico'), (err) => {
        if (!err) return;
        const blankIcon = Buffer.from('AAABAAEAEBACAAEAAQCwAAAAFgAAACgAAAAQAAAAIAAAAAEAAQAAAAAAQAAAAAAAAgAAAAAAAAAAAAAA////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA//8AAP//AAD//wAA', 'base64');
        res.end(blankIcon);
    });
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

// 必须由环境注入：以前兜底成字面量 'sysudate'，一旦某次部署漏注入就等于签名密钥公开，
// 任何人都能伪造任意 account_id 的 token（账号接管）。缺失/过短一律拒绝启动。
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '30d';

if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_PASSWORD) {
    console.error('❌ 缺少必需的环境变量: MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD');
    throw new Error('Missing required environment variables');
}

if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('❌ JWT_SECRET 缺失或过短（至少 32 字符），拒绝启动：它一旦退化为公开常量即可被伪造登录');
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
        username: account.username, security_version: 2
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        return decoded.security_version === 2 && Number.isInteger(decoded.account_id) ? decoded : null;
    } catch (err) {
        return null;
    }
}

async function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({code:401,msg:'请重新登录'});
    try { const pool=await getPool(); const [rows]=await pool.execute('SELECT id FROM accounts WHERE id=?',[decoded.account_id]);
        if(!rows.length)return res.status(401).json({code:401,msg:'账号已失效'});
        req.account=decoded;next();
    } catch(e){res.status(503).json({code:503,msg:'账号服务暂不可用'});}
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

async function verifyCode(email,code) { return secureAuth.check(email,'register',code,false); }
async function verifyAndDeleteCode(email,code) { return secureAuth.check(email,'register',code,true); }

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

async function saveFriendSurveyData(accountId, data, connection) {
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

    const pool = connection || await getPool();




    const existingQuery = `SELECT id FROM friend_survey WHERE account_id = ? AND survey_type = 'friend' LIMIT 1`;
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
        await pool.execute(`UPDATE friend_survey SET ${setClause}, updated_at = NOW() WHERE id = ?`, updateValues);
        return { updated: true, id: existing[0].id };
    } else {
        const insertFields = [...friendFields,'serial_number'];
        const placeholders = insertFields.map(() => '?').join(', ');
        const query = `INSERT INTO friend_survey (${insertFields.join(', ')}) VALUES (${placeholders})`;
        const values = insertFields.map(field => {
            if (field === 'serial_number') return 'F'+crypto.randomBytes(10).toString('hex');
            if (field === 'account_id') return accountId;
            if (field === 'user_id') return data['user_id'] || null;
            if (field === 'email') return data['email'] || null;
            if (field === 'contact_email') return data['contact_email'] || data['email'] || null;
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

// Daily matching is retired. Legacy verification URLs remain available for all modes.
app.use('/daily', (req,res,next)=>{
 if(['/verification/send','/verification/confirm'].includes(req.path))return next();
 res.setHeader('Cache-Control','no-store');return res.status(410).json({code:410,msg:'日常配对功能已下线'});
});
app.use('/admin/daily',(req,res)=>res.status(410).json({code:410,msg:'日常配对功能已下线'}));
const analytics = require('./admin-analytics')({getPool});
const daily = require('./daily')(app, {getPool,authMiddleware,adminAuthMiddleware,observe:analytics.observe,invalidateWeekly:(c,a,b)=>weeklyMatch.invalidatePair(c,a,b),banWeekly:(c,id)=>weeklyMatch.ban(c,id),prepare:async pool=>{
    await analytics.ensureSchema();
    await ensureMatchHistoryTable(pool);await ensureComplaintTable(pool);
}});
const secureAuth = require('./secure-auth')(app, {getPool,generateToken,authMiddleware,transporter,clientIp:trustedIp,
    emailConfigured:!!SMTP_PASSWORD,from:FROM_ALIAS+' <'+ACCOUNT_NAME+'>',ensureSchema:daily.ensureSchema,secret:JWT_SECRET});

const studentVerification = require('./verification-guard')(app,{getPool,ensureSchema:daily.ensureSchema,authMiddleware});

// 老用户绑定序列号
// 绑定前置校验：只检查序列号与邮箱是否匹配、是否已绑定，不消耗验证码、不建账号。
// 供 bind 页面「验证序列号」这一步使用（原先前端用一次假的 /account/bind 探测，既会误判又会占用限流额度）。
app.post('/account/bind/check', async (req, res) => {
    const { serial_number, email } = req.body || {};
    const clientIp = trustedIp(req);

    try {
        if (!checkRateLimit(clientIp, 'bindcheck', 10, 60000)) {
            return res.json({ code: 429, msg: '请求过于频繁，请稍后再试' });
        }

        if (!serial_number || !email) {
            return res.json({ code: 400, msg: '序列号、邮箱不能为空' });
        }

        if (!isValidSysuEmail(email)) {
            return res.json({ code: 400, msg: '仅支持指定学校官方邮箱' });
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

        return res.json({ code: 200, msg: 'ok' });
    } catch (error) {
        console.error('Bind Check Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

app.post('/account/bind', async (req, res) => {
    const { serial_number, email, code, password, username } = req.body;
    const clientIp = trustedIp(req);

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

        if (password.length < 8) {
            return res.json({ code: 400, msg: '密码长度至少为8位' });
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

// 密码登录由 secure-auth 模块处理。

// Personal showcase retired; account management stays available.
app.use('/account/profile',(req,res)=>res.status(410).set('Cache-Control','no-store').json({code:410,msg:'个人主页功能已下线'}));
// 通知中心 + Web Push：各业务模块在事务里只写 user_notifications，出网推送统一由 notify 的 tick 排水。
const chatRef={}; // 延后拿到 chat 的 WebSocket 广播函数（构造顺序在后）
const notify=require('./notify')(app,{getPool,authMiddleware,refresh:ids=>{try{chatRef.notify&&chatRef.notify(ids);}catch(e){/* 广播失败不影响主流程 */}}});
const weekly = require('./weekly')(app, {getPool,authMiddleware,adminAuthMiddleware,transaction:fn=>weeklyMatch.tx(fn),onSave:(c,id,clean,time)=>weeklyMatch.syncSnapshot(c,id,clean,time)});
const weeklyMatch = require('./weekly-match')(app,{getPool,authMiddleware,adminAuthMiddleware,daily,weekly,notify});
weeklyMatch.start();
const friends = require('./friends')(app,{getPool,authMiddleware,daily,notify,studentVerification,getBuddy:()=>buddyMatch,observe:analytics.observe,invalidateWeekly:(c,a,b)=>weeklyMatch.invalidatePair(c,a,b)});
const buddyMatch=require('./buddy-match')(app,{getPool,authMiddleware,adminAuthMiddleware,daily,friends,notify,observe:analytics.observe});
buddyMatch.start();
const deepMatch=require('./deep-match')(app,{getPool,authMiddleware,adminAuthMiddleware,daily,notify,prepare:async()=>{await friends.ensureSchema();await ensurePreferencesTable(await getPool());},saveLegacy:saveFriendSurveyData,invalidateOthers:async(c,a,b)=>{await weeklyMatch.invalidatePair(c,a,b);await c.execute("UPDATE daily_pairs SET status='blocked',low_wechat=NULL,high_wechat=NULL WHERE low_id=? AND high_id=?",[Math.min(a,b),Math.max(a,b)]);await c.execute("UPDATE friend_card_pairs SET status='blocked',a_wechat=NULL,b_wechat=NULL WHERE (a_id=? AND b_id=?) OR (a_id=? AND b_id=?)",[a,b,b,a]);await c.execute('DELETE FROM match_history WHERE (account_id=? AND match_account_id=?) OR (account_id=? AND match_account_id=?)',[a,b,b,a]);}});
// 私有上传（头像 / 聊天图片）：文件落 .private/uploads，读取走 /api/account/* 鉴权。
// 先于 chat 构造，聊天发图要拿它校验图片归属。
const uploads=require('./uploads')(app,{getPool,authMiddleware});
const perf=require('./perf')({getPool});
// 邀请码：列是加法迁移，注册时带上 ?invite= 即记录邀请关系。
const invite=require('./invite')(app,{getPool,authMiddleware});
// 资料完善度引导：只读检查，各模块表缺失时该项算未完成。
const profileGuide=require('./profile-guide')(app,{getPool,authMiddleware});
const userChat=require('./chat')(app,{getPool,authMiddleware,adminAuthMiddleware,daily,verifyToken,uploads,notify});
chatRef.notify=userChat.notify;
// 模型服务配置（.private/admin-ai.json）：管理员数据助手与用户侧 AI 破冰助手共用同一份。
const aiConfigPath = require('path').join(__dirname, '../.private/admin-ai.json');
const aiConfig = require('fs').existsSync(aiConfigPath)
  ? JSON.parse(require('fs').readFileSync(aiConfigPath, 'utf8')) : {};
// 破冰话题：复用 chat 的 access() 做可见性判定（不属于我的会话拿不到话题）。
// 空白会话给静态话题；双方都开口之后才走 /icebreakers/llm 的 AI 版（缓存入库，两边共用同一批）。
require('./icebreakers')(app,{getPool,authMiddleware,access:userChat.access,env:{...process.env,...aiConfig}});
const deepDraft=require('./deep-draft')(app,{getPool,authMiddleware});
// 通用支付接入：价格在本应用后台自定义，下单→小程序支付→签名回调发货。小程序无需改动。
const pay = require('./pay')(app, {getPool, authMiddleware, adminAuthMiddleware});
require('./survey-admin')(app, {getPool, adminAuthMiddleware});
require('./survey-stats')(app, {getPool, adminAuthMiddleware});
deepMatch.start();
analytics.register(app,{adminAuthMiddleware,prepare:async()=>{await daily.ensureSchema();await weekly.ensureSchema();await friends.ensureSchema();await weeklyMatch.ensureSchema();await buddyMatch.ensureSchema();await deepMatch.ensureSchema();await ensurePreferencesTable(await getPool());}});

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
        await daily.ensureSchema();
        const studentVerified=await studentVerification.verified(pool,account.id);
        const avatar=await require('./avatar-url')(pool,account.id);

        return res.json({
            code: 200,
            user: {
                account_id: account.id,
                email: account.email,
                username: account.username,
                created_at: account.created_at,
                student_email_verified: studentVerified,
                join_matching: studentVerified && !!prefs?.join_matching,
                join_friend_matching: studentVerified && !!prefs?.join_friend_matching,
                contact_email: contactEmail,
                avatar,
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
        if (new_password.length < 8) {
            return res.json({ code: 400, msg: '新密码长度不能少于8位' });
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
        // 免登录 + 可枚举用户名，必须限流，否则能被拿来批量探测账号是否存在。
        if (!checkRateLimit(trustedIp(req), 'check-username', 20, 60000)) {
            return res.json({ code: 429, msg: '操作过于频繁，请稍后再试' });
        }
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
        if(!await setAccountPreference(pool, req.account.account_id, 'join_matching', value))throw Error('preference write failed');
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
            join_matching TINYINT(1) DEFAULT 0,
            join_friend_matching TINYINT(1) DEFAULT 0,
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
        await pool.execute(`INSERT INTO account_preferences (account_id, join_matching, join_friend_matching) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE ${field} = VALUES(${field})`, [accountId,field==='join_matching'?value:0,field==='join_friend_matching'?value:0]);
        if(field==='join_matching')await pool.execute('UPDATE accounts SET join_matching=? WHERE id=?',[value,accountId]);
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
        if(!await setAccountPreference(pool, req.account.account_id, 'join_friend_matching', value))throw Error('preference write failed');
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
        await weekly.ensureSchema();
        const [loveRows] = await pool.execute(
            `SELECT COUNT(*) as count FROM weekly_questionnaires WHERE account_id = ?`,
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
        const history = await getMatchHistory(pool, req.account.account_id);
        const matches=[];for(const match of history)if(await studentVerification.verified(pool,match.match_account_id))matches.push(match);

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

        if(!await studentVerification.verified(pool,match.match_account_id))return res.status(403).json({code:403,msg:'对方尚未通过学生邮箱验证，暂不能交换联系方式'});
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
    console.warn('\x1b[33m%s\x1b[0m', '⚠ WARNING: ADMIN_PASSWORD 环境变量未设置，管理员登录已停用，请设置管理员密码。');
}
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD || crypto.randomBytes(32).toString('hex'), 10);

const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 3;
const LOGIN_WINDOW_MS = 60 * 1000;

function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    // 双维度限流：只按 IP 的话，换代理或伪造就绕过了；账号维度才是真正拦住爆破的那层。
    const user = String((req.body && req.body.username) || '').slice(0, 40).toLowerCase();
    const keys = ['admin-ip:' + trustedIp(req)];
    if (user) keys.push('admin-user:' + user);

    // 键含请求头，以前只增不减；被持续扫描会一直吃内存。超过阈值就顺手清过期的。
    if (loginAttempts.size > 500) {
        for (const [k, r] of loginAttempts) if (now - r.firstAttempt > LOGIN_WINDOW_MS) loginAttempts.delete(k);
    }

    for (const k of keys) {
        const r = loginAttempts.get(k);
        if (r && now - r.firstAttempt <= LOGIN_WINDOW_MS && r.count >= LOGIN_MAX_ATTEMPTS) {
            const waitTime = Math.ceil((LOGIN_WINDOW_MS - (now - r.firstAttempt)) / 1000);
            return res.json({ code: 429, msg: `登录过于频繁，请 ${waitTime} 秒后重试` });
        }
    }
    for (const k of keys) {
        const r = loginAttempts.get(k);
        if (!r || now - r.firstAttempt > LOGIN_WINDOW_MS) loginAttempts.set(k, { count: 1, firstAttempt: now });
        else r.count++;
    }
    next();
}

const adminAccounts = require('./admin-accounts')({getPool,secret:JWT_SECRET,legacyUsername:ADMIN_USERNAME,legacyPasswordHash:ADMIN_PASSWORD_HASH,legacyEnabled:!!ADMIN_PASSWORD});
function adminAuthMiddleware(req,res,next) { return adminAccounts.authorize(req,res,next); }
app.post('/admin/login',rateLimitMiddleware,(req,res)=>adminAccounts.login(req,res));

app.get('/admin/users', adminAuthMiddleware, async (req, res) => {
    try {
        const pool = await getPool();
        const { page = 1, pageSize = 20, sort = 'created_at', order = 'DESC', search, sex, campus, grade, join_matching } = req.query;
        const safePage = Math.max(1, parseInt(page) || 1);
        const safeSize = Math.min(100, Math.max(1, parseInt(pageSize) || 20));
        const offset = (safePage - 1) * safeSize;

        let where = ['1=1'];
        let params = [];

        if (search) {
            where.push(`(COALESCE(u.nickname,a.username) LIKE ? OR u.serial_number LIKE ? OR COALESCE(a.email,u.email) LIKE ? OR u.contact_email LIKE ?)`);
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
        const sortOrder = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        const countQuery = `SELECT COUNT(*) as total FROM (SELECT a0.id AS account_id, (SELECT MAX(u0.serial_number) FROM users u0 WHERE u0.account_id=a0.id) AS serial_number FROM accounts a0 UNION ALL SELECT NULL, u0.serial_number FROM users u0 LEFT JOIN accounts a0 ON a0.id=u0.account_id WHERE a0.id IS NULL) r LEFT JOIN users u ON u.serial_number=r.serial_number LEFT JOIN accounts a ON a.id=r.account_id WHERE ${where.join(' AND ')}`;
        const [countResult] = await pool.execute(countQuery, params);
        const total = countResult[0].total;

        const dataQuery = `SELECT u.*, EXISTS(SELECT 1 FROM weekly_questionnaires w WHERE w.account_id=a.id) AS has_love, EXISTS(SELECT 1 FROM deep_surveys d WHERE d.account_id=a.id) AS has_deep, EXISTS(SELECT 1 FROM friend_survey f WHERE f.account_id=a.id) AS has_legacy_deep, (SELECT COUNT(*) FROM friend_cards c WHERE c.account_id=a.id AND c.deleted=0) AS buddy_count, a.id AS account_id, COALESCE(u.nickname,a.username) AS nickname, COALESCE(a.email,u.email) AS email, COALESCE(a.created_at,u.created_at) AS created_at, a.email_verified, a.join_matching, a.username as account_username FROM (SELECT a0.id AS account_id, (SELECT MAX(u0.serial_number) FROM users u0 WHERE u0.account_id=a0.id) AS serial_number FROM accounts a0 UNION ALL SELECT NULL, u0.serial_number FROM users u0 LEFT JOIN accounts a0 ON a0.id=u0.account_id WHERE a0.id IS NULL) r LEFT JOIN users u ON u.serial_number=r.serial_number LEFT JOIN accounts a ON a.id=r.account_id WHERE ${where.join(' AND ')} ORDER BY ${sortField === 'created_at' ? 'COALESCE(a.created_at,u.created_at)' : sortField === 'nickname' ? 'COALESCE(u.nickname,a.username)' : 'u.'+sortField} ${sortOrder} LIMIT ${safeSize} OFFSET ${offset}`;
        const [rows] = await pool.execute(dataQuery, params);

        return res.json({ code: 200, data: rows, total, page: safePage, pageSize: safeSize });
    } catch (error) {
        console.error('Admin Users Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});

app.get('/admin/user/:serial', adminAuthMiddleware, async (req, res) => {
    try {
        const pool = await getPool();
        if (/^account-\d+$/.test(req.params.serial)) {
            const [accounts] = await pool.execute('SELECT id AS account_id, username AS nickname, email, email_verified, created_at, last_login_at FROM accounts WHERE id = ?', [req.params.serial.slice(8)]);
            return res.json(accounts.length ? {code:200,data:accounts[0]} : {code:404,msg:'未找到该账号'});
        }
        const [rows] = await pool.execute(`SELECT u.*, a.join_matching, a.username as account_username, a.email as account_email, a.created_at as account_created_at FROM (SELECT a0.id AS account_id, (SELECT MAX(u0.serial_number) FROM users u0 WHERE u0.account_id=a0.id) AS serial_number FROM accounts a0 UNION ALL SELECT NULL, u0.serial_number FROM users u0 LEFT JOIN accounts a0 ON a0.id=u0.account_id WHERE a0.id IS NULL) r LEFT JOIN users u ON u.serial_number=r.serial_number LEFT JOIN accounts a ON a.id=r.account_id WHERE u.serial_number = ?`, [req.params.serial]);
        if (rows.length === 0) return res.json({ code: 404, msg: '未找到该用户' });
        return res.json({ code: 200, data: rows[0] });
    } catch (error) {
        console.error('Admin User Detail Error:', error);
        return res.json({ code: 500, msg: '服务器错误' });
    }
});


app.get('/admin/accounts/:id/materials', adminAuthMiddleware, async (req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(!/^\d+$/.test(req.params.id)||!Number.isSafeInteger(Number(req.params.id)))return res.status(400).json({code:400,msg:'账号编号无效'});
 try{
 const p=await getPool(),id=Number(req.params.id);
 const [a]=await p.execute('SELECT id FROM accounts WHERE id=?',[id]);
 if(!a.length)return res.status(404).json({code:404,msg:'账号不存在'});
 const [love]=await p.execute('SELECT version,answers,important,updated_at FROM weekly_questionnaires WHERE account_id=?',[id]);
 const [deep]=await p.execute('SELECT data FROM deep_surveys WHERE account_id=?',[id]);
 const [old]=deep.length? [[]]:await p.execute('SELECT sex,grade,major,hometown,friend_goal,mbti,interests,self_description,ideal_friend,photos,display_self,contact_info FROM friend_survey WHERE account_id=? ORDER BY id DESC LIMIT 1',[id]);
 const [cards]=await p.execute('SELECT id,type,enabled,data FROM friend_cards WHERE account_id=? AND deleted=0 ORDER BY slot',[id]);
 const parse=x=>typeof x==='string'?JSON.parse(x):x;
 res.json({code:200,love:love.length?{...love[0],answers:parse(love[0].answers),important:parse(love[0].important)}:null,deep:deep.length?parse(deep[0].data):old[0]||null,deep_legacy:!deep.length&&!!old.length,cards:cards.map(c=>({...c,data:parse(c.data)}))});
 }catch(e){console.error('Admin materials:',e.code||e.name);res.status(503).json({code:503,msg:'资料暂时无法读取，请重试'});}
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
        const result = await daily.transaction(async (pool,time) => {
        const { matches, match_round = 1, survey_type = 'love' } = req.body;
        if(['love','friend'].includes(survey_type))return {code:400,msg:'每周恋爱配对请使用批次预览和发布，不再接受手工导入'};

        if (!Array.isArray(matches)) {
            return { code: 400, msg: 'matches 必须是数组' };
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

            if(!await studentVerification.verified(pool,accountId)||!await studentVerification.verified(pool,matchAccountId)){skipCount++;continue;}
            if(accountId===matchAccountId || await daily.weeklyGuard(pool,accountId,matchAccountId,time)){skipCount++;continue;}
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

        return { code: 200, data: { success: successCount, skip: skipCount, fail: failCount } };
        });
        return res.json(result);
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

const adminAiConfig = aiConfig;   // 见 userChat 之上的 aiConfig（同一份配置，管理员助手与破冰助手共用）
app.post('/llm/chat', adminAuthMiddleware, require('./admin-ai')({analytics,business:require('./admin-business')({getPool}),env:{...process.env,...adminAiConfig}}));

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

app.get('/', (req,res,next)=>{
    if(['debug','queryByUserId'].includes(req.query.action))return res.status(403).json({code:403,msg:'请从已授权的配对页面查看资料'});
    next();
});
app.get('/', async (req, res) => {
    const { action, email, serial, code } = req.query;
    if (!action) {
        // 部署补丁: 根路径返回首页
        return res.sendFile(path.join(WEB_DIR, 'index.html'));
    }
    const clientIp = trustedIp(req);

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
            if(!userData.account_id||!await studentVerification.verified(await getPool(),userData.account_id))return res.status(403).json({code:403,msg:'该资料暂不可访问'});
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
    const clientIp = trustedIp(req);

    try {
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

            const result = await secureAuth.send(email,'register');
            return res.status(result.code).json(result);
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
            const result = await deepMatch.saveSurvey(accountId, data);

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

// 注意：index.js 顶部会把 /api 前缀剥掉，所以这里只能注册 /complaint（写 /api/complaint 永远匹配不上）。
app.post('/complaint', async (req, res) => {
    try {
        // 未登录也能提交（会留联系邮箱），但必须限流，否则就是一个匿名刷库的口子。
        if (!checkRateLimit(trustedIp(req), 'complaint', 5, 600000)) {
            return res.json({ code: 429, msg: '提交过于频繁，请稍后再试' });
        }
        const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
        const { target_type, target_id, reason, description, contact_email } = req.body || {};
        if (!reason || !String(reason).trim()) {
            return res.json({ code: 400, msg: '请填写投诉原因' });
        }
        if (String(reason).length > 100 || String(description || '').length > 2000 || String(contact_email || '').length > 120) {
            return res.json({ code: 400, msg: '内容过长' });
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
            [reporterAccountId, null, clip(target_type || 'other', 30), clip(target_id, 64), clip(reason, 100), clip(description, 2000), clip(contact_email, 120)]
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
        await daily.transaction(async c=>{
            await c.execute('UPDATE daily_settings SET enabled=0 WHERE account_id=?',[accountId]);
            await c.execute("UPDATE daily_pairs SET status='cancelled',low_wechat=NULL,high_wechat=NULL WHERE (low_id=? OR high_id=?) AND status IN ('pending','connected')",[accountId,accountId]);
        });
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
app.use((req,res,next)=>{
    let decodedPath;try{decodedPath=decodeURIComponent(req.path);}catch(e){return res.status(400).end();}
    if(/^\/(all_users\.html|photos(?:\/|$))/i.test(decodedPath))return res.status(403).send('请通过已授权的资料页面访问');
    if(/^\/daily\.(html|js|css)$/i.test(decodedPath))return res.status(410).set('Cache-Control','no-store').send('日常配对功能已下线，请返回首页。');
    next();
});
app.use((req,res,next)=>{
 let p;try{p=decodeURIComponent(req.path);}catch{return res.status(400).end();}
 if(/^\/homepage\.(html|js|css)$/i.test(p))return res.status(410).set('Cache-Control','no-store').send('个人主页功能已下线，请返回个人中心。');
 next();
});
// 部署补丁: 干净链接 + 一级/二级层级。规范见 .claude/skills/fancyu-aesthetic/SKILL.md。
// 映射：/pay → web/pay.html；/admin/pay → web/admin-pay.html。
// 规范化（302，保留查询串）：/x.html → /x；/index.html → /；旧一级 /admin-x → 新二级 /admin/x。
// 注意：后端另有裸 /admin/* API 命名空间（/admin/chat-reports、/admin/users ...），
//       所以二级地址一律用下面的显式路由表，不能靠 <组>-<名> 猜测（chat-reports 会撞 API）。
app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let p; try { p = decodeURIComponent(req.path); } catch (e) { return res.status(400).end(); }
    if (/^\/(all_users)(\/|\.html)?$/i.test(p)) return res.status(403).send('请通过已授权的资料页面访问');
    if (/^\/(daily|homepage)(\.html)?$/i.test(p)) return res.status(410).set('Cache-Control','no-store').send('该功能已下线，请返回首页。');
    // 旧序列号流程整体下线（/bind /modify /query /update /dashboard）：
    // 用「每周配对 / 深度交友 / 约个搭子」+ 个人中心取代。可逆：删掉本行即恢复。
    if (/^\/(bind|modify|query|update|dashboard)(\.html)?$/i.test(p)) return res.status(410).set('Cache-Control','no-store').send('旧的序列号流程已下线，请使用「每周恋爱配对 / 深度交友 / 约个搭子」，账号信息在 <a href="/profile">个人中心</a> 管理。');

    // 二级页面路由表：'<一级>/<二级>' → web 下的真实文件名
    const PAGES2 = {
        'admin/pay': 'admin-pay.html',
        'admin/weekly': 'admin-weekly.html',
        'admin/deep': 'admin-deep.html',
        'admin/buddy': 'admin-buddy.html',
        'admin/reports': 'admin-chat-reports.html',
            'admin/survey': 'admin-survey.html'
    };
    const FLAT2HIER = {                       // 旧一级地址 → 新二级地址
        'admin-pay': 'admin/pay', 'admin-weekly': 'admin/weekly', 'admin-deep': 'admin/deep',
        'admin-buddy': 'admin/buddy', 'admin-chat-reports': 'admin/reports'
    };

    let std = p.replace(/\.html$/i, '');
    if (std === '/index') std = '/';
    const flatKey = std.replace(/^\//, '');
    if (FLAT2HIER[flatKey]) std = '/' + FLAT2HIER[flatKey];
    if (std !== p) return res.redirect(302, std + req.originalUrl.slice(req.path.length));

    if (p === '/' || p.includes('.')) return next();
    const rel = p.replace(/^\/+/, '').replace(/\/+$/, '');
    const name = PAGES2[rel] || rel + '.html';
    const file = path.join(WEB_DIR, name);
    if (file.startsWith(WEB_DIR + path.sep) && require('fs').existsSync(file)) return res.sendFile(file);
    next();
});
// 静态资源：文本类（html/css/js/json/svg/webmanifest）走 gzip + 长缓存；其余交给 express.static。
// HTML 用 no-cache（每次协商，避免发版后拿到旧页面），资源用 ?v= 版本号，故可以放心长缓存。
const STATIC_TEXT_EXT = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const gzCache = new Map();                 // abs+mtime+size → gzip buffer（有界，超了整体清空）
const staticMw = express.static(WEB_DIR, {
    setHeaders: (res, file) => res.setHeader('Cache-Control', /\.html?$/i.test(file) ? 'no-cache' : 'public, max-age=604800')
});
app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return staticMw(req, res, next);
    if (!gzipOk(req)) return staticMw(req, res, next);
    let p; try { p = decodeURIComponent(req.path); } catch (e) { return staticMw(req, res, next); }
    const ext = path.extname(p).toLowerCase();
    const type = STATIC_TEXT_EXT[ext];
    if (!type) return staticMw(req, res, next);
    const abs = path.join(WEB_DIR, p);
    if (!abs.startsWith(WEB_DIR + path.sep)) return staticMw(req, res, next);
    try {
        const st = require('fs').statSync(abs);
        if (!st.isFile()) return staticMw(req, res, next);
        const etag = 'W/"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"';
        res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=604800');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
        const key = abs + ':' + st.mtimeMs + ':' + st.size;
        let gz = gzCache.get(key);
        if (!gz) {
            gz = zlib.gzipSync(require('fs').readFileSync(abs));
            if (gzCache.size > 200) gzCache.clear();
            gzCache.set(key, gz);
        }
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Type', type);
        res.setHeader('Content-Length', String(gz.length));
        return res.end(req.method === 'HEAD' ? undefined : gz);
    } catch (e) { return staticMw(req, res, next); }
});
app.use(staticMw);
app.use((req, res) => {
    if (req.method === 'GET' && !req.path.startsWith('/account') && !req.path.startsWith('/admin') && !req.path.startsWith('/api') && !req.path.startsWith('/llm')) {
        // 未知页面：给品牌化的 404 页（不再是「404 + 首页」那种把错地址伪装成成功的做法）。
        const notFound = path.join(WEB_DIR, '404.html');
        if (require('fs').existsSync(notFound)) return res.status(404).sendFile(notFound);
        return res.status(404).sendFile(path.join(WEB_DIR, 'index.html'));
    }
    return res.json({ code: 404, msg: 'Not Found' });
});

const PORT = parseInt(process.env.PORT || '9000', 10);
(async()=>{await weeklyMatch.ensureSchema();await deepMatch.ensureSchema();await deepDraft.ensureSchema();await userChat.ensureSchema();await uploads.ensureSchema();await notify.ensureSchema();await invite.ensureSchema();await perf.ensureIndexes();notify.start();const server=app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));userChat.attach(server);})().catch(e=>{console.error('Startup failed:',e.code||e.name);process.exit(1);});

console.log('Function instance started successfully');
