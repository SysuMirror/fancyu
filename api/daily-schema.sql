CREATE TABLE IF NOT EXISTS account_profiles (
 account_id INT PRIMARY KEY,profile_id VARCHAR(24) NOT NULL UNIQUE,avatar MEDIUMTEXT NOT NULL,
 bio VARCHAR(1200) NOT NULL DEFAULT '',tags JSON NOT NULL,photos MEDIUMTEXT NOT NULL,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS verified_students (
 account_id INT PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, verified_at DATETIME NOT NULL,
 FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS secure_email_codes (
 email VARCHAR(255) NOT NULL, purpose VARCHAR(20) NOT NULL, code_hash CHAR(64) NOT NULL,
 expires_at DATETIME NOT NULL, sent_at DATETIME NOT NULL, attempts INT NOT NULL DEFAULT 0,
 PRIMARY KEY (email,purpose)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS daily_mutex (id INT PRIMARY KEY) ENGINE=InnoDB;
INSERT IGNORE INTO daily_mutex (id) VALUES (1);
CREATE TABLE IF NOT EXISTS daily_settings (
 account_id INT PRIMARY KEY, enabled TINYINT NOT NULL DEFAULT 0, banned TINYINT NOT NULL DEFAULT 0,
 settings JSON NOT NULL, consent_version VARCHAR(30) NOT NULL, updated_at DATETIME NOT NULL,
 FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS daily_pairs (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, low_id INT NOT NULL, high_id INT NOT NULL,
 low_choice VARCHAR(12) NOT NULL DEFAULT 'pending', high_choice VARCHAR(12) NOT NULL DEFAULT 'pending',
 low_wechat VARCHAR(64) NULL, high_wechat VARCHAR(64) NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'pending', created_at DATETIME NOT NULL, expires_at DATETIME NOT NULL,
 cooldown_until DATETIME NULL, connected_at DATETIME NULL,
 INDEX idx_pair (low_id,high_id,status),
 FOREIGN KEY (low_id) REFERENCES accounts(id) ON DELETE CASCADE,
 FOREIGN KEY (high_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS daily_days (
 account_id INT NOT NULL, day_key DATE NOT NULL, pair_id BIGINT NULL,
 PRIMARY KEY(account_id,day_key), INDEX idx_pair(pair_id),
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
 FOREIGN KEY(pair_id) REFERENCES daily_pairs(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS daily_blocks (
 owner_id INT NOT NULL, target_id INT NOT NULL, created_at DATETIME NOT NULL,
 PRIMARY KEY(owner_id,target_id),
 FOREIGN KEY(owner_id) REFERENCES accounts(id) ON DELETE CASCADE,
 FOREIGN KEY(target_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS complaints (
 id INT AUTO_INCREMENT PRIMARY KEY, reporter_account_id INT NULL, reporter_email VARCHAR(255),
 target_type ENUM('user','content','other') DEFAULT 'other',target_id VARCHAR(255),
 reason TEXT NOT NULL,description TEXT,contact_email VARCHAR(255),
 status ENUM('pending','processing','resolved','dismissed') DEFAULT 'pending',admin_reply TEXT,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 INDEX idx_status(status),INDEX idx_reporter(reporter_account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
