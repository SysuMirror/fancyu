/* 管理员发布的「通知 / 问卷调研」。
   - announcements 同时承载通知（kind='notice'）与调研（kind='survey'，多带 questions JSON）；
   - announcement_audience 是「发布时刻的人群快照」：未答名单可精确、投递幂等（INSERT IGNORE）；
   - announcement_responses 一人一份（UNIQUE），只存自己答案。
   时间一律 UTC（与 notify 的 user_notifications 同源，比较用 UTC_TIMESTAMP()）。 */
CREATE TABLE IF NOT EXISTS announcements (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 kind VARCHAR(16) NOT NULL DEFAULT 'notice',
 title VARCHAR(120) NOT NULL,
 summary VARCHAR(300) NOT NULL DEFAULT '',
 body MEDIUMTEXT NOT NULL,
 link VARCHAR(200) NOT NULL DEFAULT '',
 questions JSON NULL,
 audience VARCHAR(16) NOT NULL DEFAULT 'all',
 audience_meta JSON NULL,
 channel_reminder TINYINT(1) NOT NULL DEFAULT 0,
 channel_home TINYINT(1) NOT NULL DEFAULT 1,
 start_at DATETIME NULL,
 end_at DATETIME NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'draft',
 revision INT NOT NULL DEFAULT 1,
 published_at DATETIME NULL,
 notified_at DATETIME NULL,
 created_by VARCHAR(120) NOT NULL DEFAULT '',
 created_by_id INT NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 INDEX idx_window (status,start_at,end_at),
 INDEX idx_created (created_at),
 FOREIGN KEY(created_by_id) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS announcement_audience (
 announcement_id BIGINT UNSIGNED NOT NULL,
 account_id INT NOT NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(announcement_id,account_id),
 INDEX idx_account (account_id),
 FOREIGN KEY(announcement_id) REFERENCES announcements(id) ON DELETE CASCADE,
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS announcement_responses (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 announcement_id BIGINT UNSIGNED NOT NULL,
 account_id INT NOT NULL,
 answers JSON NOT NULL,
 submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY uniq_responder (announcement_id,account_id),
 INDEX idx_announcement (announcement_id),
 FOREIGN KEY(announcement_id) REFERENCES announcements(id) ON DELETE CASCADE,
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
