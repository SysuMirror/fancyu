CREATE TABLE IF NOT EXISTS analytics_metadata (name VARCHAR(40) PRIMARY KEY,started_at DATETIME NOT NULL) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS core_survey_funnels (
 mode VARCHAR(12) NOT NULL,account_id INT NOT NULL,started_at DATETIME(3) NOT NULL,
 completed_at DATETIME(3) NULL,is_revision BOOLEAN NOT NULL DEFAULT 0,
 PRIMARY KEY(mode,account_id),INDEX cohort(started_at),
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS core_metric_batches (
 mode VARCHAR(12) NOT NULL,batch_key CHAR(10) NOT NULL,published_at DATETIME(3) NOT NULL,
 algorithm VARCHAR(64) NOT NULL,PRIMARY KEY(mode,batch_key),INDEX published(published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS core_metric_participants (
 mode VARCHAR(12) NOT NULL,batch_key CHAR(10) NOT NULL,account_id INT NOT NULL,matched BOOLEAN NOT NULL,
 PRIMARY KEY(mode,batch_key,account_id),
 FOREIGN KEY(mode,batch_key) REFERENCES core_metric_batches(mode,batch_key) ON DELETE CASCADE,
 FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS core_metric_exclusions (
 account_id INT PRIMARY KEY,FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
