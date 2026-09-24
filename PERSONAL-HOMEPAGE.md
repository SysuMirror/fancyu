# 个人主页版本说明

入口：网站首页 → 我的／个人中心 → 我的主页（`/homepage.html`）。

支持修改头像、独立主页 ID、300 字简介、8 个标签和 6 张照片。主页 ID 不区分大小写，不修改登录用户名。图片由浏览器压缩为 JPEG，每张保存大小不超过 350 KiB。主页当前仅本人可查看，暂不提供公开浏览或分享链接。

## 实现位置

- `web/homepage.html`、`homepage.css`、`homepage.js`：展示、编辑、图片处理。
- `web/profile.html`：个人中心入口和头像、ID 摘要。
- `api/profile.js`：主页读写、有效账号令牌检查、事务与 ID 唯一性处理。
- `api/profile-validation.js`：字段与图片大小、格式校验。
- `schema.sql`：新增 `account_profiles` 表；后端也会在第一次访问时创建该表。

接口：`GET /api/account/profile`、`PUT /api/account/profile`。GET 可带 `summary=1` 省略相册图片。账号编号只从有效令牌读取；删除账号时通过外键级联删除主页。图片以压缩后的 Data URL 存在独立主页表中，当前没有独立文件上传服务。

## 验证

在 `api` 目录运行 `node --test tests/profile-validation.test.js`。

数据库集成测试：配置 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE`，设置 `PROFILE_INTEGRATION_TEST=1` 后运行 `node --test tests/profile.integration.test.js`。测试创建独立临时账号并清理，不使用现有用户账号。测试用图片为合成图片。

如设置 `PROFILE_LIVE_BASE=http://127.0.0.1:8080/api` 和服务对应的 `JWT_SECRET`，同一测试会验证实际运行接口；凭据不可写入版本库。

## 已有系统限制

本模块拒绝缺失或无效的令牌，但项目原有登录接口仍保留免密码的演示补丁。因此部署为正式用户服务前，仍需恢复整个系统的真实登录与管理员鉴权。本次没有修改旧登录行为。
