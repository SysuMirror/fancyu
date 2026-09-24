-- SYSUDate 本地部署 schema v1 (db_3b7f53b7)
-- 账号 + 双问卷 + 验证码; account_preferences/match_history/chat_sessions/complaints 由后端运行时自建

CREATE TABLE IF NOT EXISTS `accounts` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `email` VARCHAR(255) NOT NULL UNIQUE,
    `username` VARCHAR(50) NOT NULL UNIQUE,
    `password_hash` VARCHAR(255) NOT NULL,
    `email_verified` BOOLEAN DEFAULT TRUE,
    `school` VARCHAR(100) NULL,
    `join_matching` TINYINT(1) DEFAULT 1,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `last_login_at` TIMESTAMP NULL,
    INDEX `idx_email` (`email`),
    INDEX `idx_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 问卷字段全集(后端 getExistingColumns 按实际列过滤插入)
CREATE TABLE IF NOT EXISTS `users` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `account_id` INT NULL,
    `user_id` VARCHAR(100) NULL,
    `serial_number` VARCHAR(50) UNIQUE,
    `email` VARCHAR(255) NULL,
    `contact_email` VARCHAR(255) NULL,
    `contact_info` TEXT NULL,
    `survey_type` VARCHAR(20) DEFAULT 'love',
    `school` VARCHAR(100) NULL,
    `nickname` VARCHAR(100) NULL,
    `sex` VARCHAR(10) NULL,
    `sex_choice` VARCHAR(20) NULL,
    `grade` VARCHAR(20) NULL,
    `grade_prefer` VARCHAR(255) NULL,
    `relationship_goal` VARCHAR(50) NULL,
    `friend_goal` VARCHAR(50) NULL,
    `experience` VARCHAR(50) NULL,
    `ex_prefer` VARCHAR(255) NULL,
    `future_plan` VARCHAR(50) NULL,
    `major` VARCHAR(100) NULL,
    `prefer_major` TEXT NULL,
    `campus` VARCHAR(50) NULL,
    `hometown` VARCHAR(100) NULL,
    `my_school` VARCHAR(100) NULL,
    `school_prefer` TEXT NULL,
    `constellation` VARCHAR(20) NULL,
    `constellation_prefer` VARCHAR(255) NULL,
    `mbti` VARCHAR(10) NULL,
    `mbti_prefer` VARCHAR(255) NULL,
    `interests` TEXT NULL,
    `interest_custom` TEXT NULL,
    `height` VARCHAR(10) NULL,
    `height_min` VARCHAR(10) NULL,
    `height_max` VARCHAR(10) NULL,
    `beauty_self` VARCHAR(20) NULL,
    `beauty_prefer_min` VARCHAR(20) NULL,
    `body_type` VARCHAR(20) NULL,
    `fitness_level` VARCHAR(20) NULL,
    `body_prefer` VARCHAR(255) NULL,
    `fitness_prefer` VARCHAR(255) NULL,
    `q1_co_dependent` VARCHAR(50) NULL,
    `q2_conflict` VARCHAR(50) NULL,
    `q3_ritual` VARCHAR(50) NULL,
    `q4_consumption` VARCHAR(50) NULL,
    `q5_life_focus` VARCHAR(50) NULL,
    `q6_emotion` VARCHAR(50) NULL,
    `agree_topics` TEXT NULL,
    `self_description` TEXT NULL,
    `ideal_description` TEXT NULL,
    `ideal_friend` TEXT NULL,
    `photos` TEXT NULL,
    `photo_urls` TEXT NULL,
    `display_self` TEXT NULL,
    `feedback` TEXT NULL,
    `avatar` TEXT NULL,
    `sex_prefer` VARCHAR(20) NULL,
    `major_prefer` TEXT NULL,
    `online_offline` VARCHAR(20) NULL,
    `special_request` TEXT NULL,
    `personality_self_1` VARCHAR(50) NULL,
    `personality_self_2` VARCHAR(50) NULL,
    `personality_self_3` VARCHAR(50) NULL,
    `personality_self_4` VARCHAR(50) NULL,
    `personality_self_5` VARCHAR(50) NULL,
    `personality_expect_1` VARCHAR(50) NULL,
    `personality_expect_2` VARCHAR(50) NULL,
    `personality_expect_3` VARCHAR(50) NULL,
    `personality_expect_4` VARCHAR(50) NULL,
    `personality_expect_5` VARCHAR(50) NULL,
    `personality_expect_1_no_pref` TINYINT(1) NULL,
    `personality_expect_2_no_pref` TINYINT(1) NULL,
    `personality_expect_3_no_pref` TINYINT(1) NULL,
    `personality_expect_4_no_pref` TINYINT(1) NULL,
    `personality_expect_5_no_pref` TINYINT(1) NULL,
    `expect_schools` TEXT NULL,
    `expect_school_campuses` TEXT NULL,
    `expect_quick` VARCHAR(50) NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_account_id` (`account_id`),
    INDEX `idx_user_id` (`user_id`),
    INDEX `idx_account_id_survey` (`account_id`, `survey_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `friend_survey` LIKE `users`;
ALTER TABLE `friend_survey` DROP INDEX `serial_number`, ADD UNIQUE INDEX `idx_serial` (`serial_number`);

CREATE TABLE IF NOT EXISTS `verification_codes` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `email` VARCHAR(255) NOT NULL,
    `code` VARCHAR(10) NOT NULL,
    `expire_at` TIMESTAMP NOT NULL,
    `source` VARCHAR(20) DEFAULT 'general',
    `send_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Personal homepage fields are independent of surveys and login usernames.
CREATE TABLE IF NOT EXISTS `account_profiles` (
    `account_id` INT PRIMARY KEY,
    `profile_id` VARCHAR(24) NOT NULL UNIQUE,
    `avatar` MEDIUMTEXT NOT NULL,
    `bio` VARCHAR(1200) NOT NULL DEFAULT '',
    `tags` JSON NOT NULL,
    `photos` MEDIUMTEXT NOT NULL,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT `fk_profile_account` FOREIGN KEY (`account_id`)
        REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- queryByUserId 的 LEFT JOIN 依赖此表
CREATE TABLE IF NOT EXISTS `account_emails` (
    `account_id` INT NOT NULL,
    `email` VARCHAR(255) NULL,
    INDEX `idx_account_id` (`account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
