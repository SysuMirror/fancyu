CREATE TABLE IF NOT EXISTS weekly_match_bans (
 account_id INT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS weekly_match_batches (
 batch_key CHAR(10) PRIMARY KEY, cutoff_at DATETIME NOT NULL, release_at DATETIME NOT NULL, expires_at DATETIME NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'open', algorithm VARCHAR(32) NOT NULL, config JSON NOT NULL, seed VARCHAR(64) NOT NULL,
 plan JSON NULL, stats JSON NULL, revision INT NOT NULL DEFAULT 0, approved_revision INT NULL,
 approved_by VARCHAR(100) NULL, approved_at DATETIME NULL, published_at DATETIME NULL, last_error VARCHAR(64) NULL,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS weekly_match_enrollments (
 batch_key CHAR(10) NOT NULL, account_id INT NOT NULL, active BOOLEAN NOT NULL DEFAULT 1,
 snapshot JSON NOT NULL, consent_version VARCHAR(32) NOT NULL, enrolled_at DATETIME NOT NULL,
 assigned BOOLEAN NOT NULL DEFAULT 0, eligible_at_run BOOLEAN NOT NULL DEFAULT 0,
 PRIMARY KEY(batch_key,account_id),
 FOREIGN KEY(batch_key) REFERENCES weekly_match_batches(batch_key) ON DELETE CASCADE,
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS weekly_match_pairs (
 id BIGINT AUTO_INCREMENT PRIMARY KEY,batch_key CHAR(10) NOT NULL,a_id INT NOT NULL,b_id INT NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'pending',a_choice VARCHAR(12) NOT NULL DEFAULT 'pending',b_choice VARCHAR(12) NOT NULL DEFAULT 'pending',
 a_wechat VARCHAR(32) NULL,b_wechat VARCHAR(32) NULL,reasons JSON NOT NULL,score_data JSON NOT NULL,
 created_at DATETIME NOT NULL,expires_at DATETIME NOT NULL,connected_at DATETIME NULL,cooldown_until DATETIME NULL,
 UNIQUE KEY unique_pair(batch_key,a_id,b_id),INDEX idx_accounts(a_id,b_id),
 FOREIGN KEY(batch_key) REFERENCES weekly_match_batches(batch_key),
 FOREIGN KEY(a_id) REFERENCES accounts(id) ON DELETE CASCADE,
 FOREIGN KEY(b_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS weekly_match_slots (
 batch_key CHAR(10) NOT NULL,account_id INT NOT NULL,pair_id BIGINT NOT NULL,
 PRIMARY KEY(batch_key,account_id),FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
 FOREIGN KEY(pair_id) REFERENCES weekly_match_pairs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS weekly_match_feedback (
 pair_id BIGINT NOT NULL,account_id INT NOT NULL,answer VARCHAR(24) NOT NULL,updated_at DATETIME NOT NULL,
 PRIMARY KEY(pair_id,account_id),FOREIGN KEY(pair_id) REFERENCES weekly_match_pairs(id) ON DELETE CASCADE,
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
