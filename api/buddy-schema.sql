CREATE TABLE IF NOT EXISTS buddy_batches (
 batch_key CHAR(10) PRIMARY KEY, status VARCHAR(16) NOT NULL DEFAULT 'open',
 algorithm VARCHAR(32) NOT NULL DEFAULT 'buddy-v4-weekly', plan JSON NULL, stats JSON NULL,
 revision INT NOT NULL DEFAULT 0, approved_revision INT NULL, approved_by VARCHAR(100) NULL,
 published_at DATETIME NULL, last_error VARCHAR(64) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS buddy_entries (
 batch_key CHAR(10) NOT NULL, card_id INT NOT NULL, account_id INT NOT NULL,
 snapshot JSON NOT NULL, active BOOLEAN NOT NULL DEFAULT 1,
 PRIMARY KEY(batch_key,card_id),
 FOREIGN KEY(batch_key) REFERENCES buddy_batches(batch_key) ON DELETE CASCADE,
 FOREIGN KEY(card_id) REFERENCES friend_cards(id) ON DELETE CASCADE,
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS buddy_match_feedback (
 pair_id INT NOT NULL,account_id INT NOT NULL,answer VARCHAR(24) NOT NULL,updated_at DATETIME NOT NULL,
 PRIMARY KEY(pair_id,account_id),FOREIGN KEY(pair_id) REFERENCES friend_card_pairs(id) ON DELETE CASCADE,
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;