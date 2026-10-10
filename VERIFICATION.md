# 学生邮箱统一配对门槛

每周配对、每周交友、日常配对都要求学生邮箱验证。使用 `verified_students` 中与账号当前邮箱一致的真实验证记录；历史 `accounts.email_verified` 布尔值不作为验证依据。

未验证可以填写、保存本人的问卷和资料，以及退出配对；不能开启配对、查看他人配对资料、获取匹配结果或交换联系方式。结果导入检查双方验证记录，读取已有结果也过滤未验证对象。

统一验证页面：`verify-student.html`，个人中心和问卷页面有入口。发送及确认验证码分别调用 `/api/account/student-verification/send`、`/confirm`；与日常配对使用相同的验证记录和验证码机制，一次验证通用。邮件服务未配置时明确报错，不绕过验证。

新账号参与开关默认为关闭；部署时将未验证老账号的每周配对/交友开关关闭。验证成功不自动开启，需用户主动选择。迁移前备份开关数据至服务器私有 `.verification-backups/`，不提交 Git。

`VERIFICATION_INTEGRATION_TEST=1 node --test api/tests/verification.test.js` 验证未验证拒绝、可退出、问卷仍可读写、双方导入门槛、验证后手动开启、对方失去验证后结果和联系方式不可访问。
