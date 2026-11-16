'use strict';
// 返回某账号头像的鉴权访问地址；没有头像或表还不存在时返回 ''（前端回退到首字母占位）。
// 只用于把地址塞进配对结果的 person 字段，实际读取仍由 api/uploads.js 校验「本人或可见配对方」。
module.exports = async function avatarUrl(c, accountId) {
    try {
        const [rows] = await c.execute("SELECT id FROM user_uploads WHERE account_id=? AND scope='avatar' ORDER BY id DESC LIMIT 1", [accountId]);
        return rows.length ? '/api/account/avatar/' + accountId + '?v=' + rows[0].id : '';
    } catch (e) {
        return '';
    }
};
