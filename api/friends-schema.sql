CREATE TABLE IF NOT EXISTS friend_card_settings (
 account_id INT PRIMARY KEY,
 gender VARCHAR(12) NOT NULL DEFAULT '不透露',
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS friend_cards (
 id INT AUTO_INCREMENT PRIMARY KEY,
 account_id INT NOT NULL,
 slot TINYINT NOT NULL,
 type VARCHAR(16) NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT 0,
 deleted BOOLEAN NOT NULL DEFAULT 0,
 data JSON NOT NULL,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY account_slot(account_id,slot),
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS friend_card_pairs (
 id INT AUTO_INCREMENT PRIMARY KEY,
 a_card INT NOT NULL,
 b_card INT NOT NULL,
 a_id INT NOT NULL,
 b_id INT NOT NULL,
 week_key CHAR(10) NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'pending',
 a_agreed BOOLEAN NOT NULL DEFAULT 0,
 b_agreed BOOLEAN NOT NULL DEFAULT 0,
 a_wechat VARCHAR(32) NULL,
 b_wechat VARCHAR(32) NULL,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 INDEX pair_accounts(a_id,b_id),
 FOREIGN KEY(a_card) REFERENCES friend_cards(id) ON DELETE CASCADE,
 FOREIGN KEY(b_card) REFERENCES friend_cards(id) ON DELETE CASCADE,
 FOREIGN KEY(a_id) REFERENCES accounts(id) ON DELETE CASCADE,
 FOREIGN KEY(b_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS friend_card_weeks (
 card_id INT NOT NULL,
 week_key CHAR(10) NOT NULL,
 pair_id INT NOT NULL,
 PRIMARY KEY(card_id,week_key),
 FOREIGN KEY(card_id) REFERENCES friend_cards(id) ON DELETE CASCADE,
 FOREIGN KEY(pair_id) REFERENCES friend_card_pairs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS friend_account_weeks (
 account_id INT NOT NULL,
 week_key CHAR(10) NOT NULL,
 pair_id INT NOT NULL,
 PRIMARY KEY(account_id,week_key),
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO friend_account_weeks(account_id,week_key,pair_id)
 SELECT account_id,week_key,MIN(pair_id) FROM (
 SELECT a_id account_id,week_key,id pair_id FROM friend_card_pairs
 UNION ALL SELECT b_id account_id,week_key,id pair_id FROM friend_card_pairs
 ) past GROUP BY account_id,week_key;
