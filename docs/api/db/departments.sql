-- departments: MySQL schema generated from docs/api/spec/modules/departments.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `departments_phone_picks` (
  `id` VARCHAR(255) NOT NULL,
  `product_ids` JSON NOT NULL,
  `updated_by` TEXT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_phones` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `brand` TEXT NOT NULL,
  `name` TEXT NOT NULL,
  `overview` TEXT NULL,
  `storage` JSON NOT NULL,
  `colors` JSON NOT NULL,
  `photos` JSON NOT NULL,
  `ad_images` JSON NOT NULL,
  `spec_groups` JSON NOT NULL,
  `show_services` TINYINT(1) NOT NULL,
  `search_term` TEXT NULL,
  `status` VARCHAR(32) NOT NULL,
  `position` INT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `updated_by` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_phones_slug` (`slug`),
  KEY `ix_departments_phones_1` (`status`, `position`),
  CONSTRAINT `ck_departments_phones_status` CHECK (`status` IN ('published', 'hidden'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_blog_topics` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `position` INT NOT NULL,
  `visible` TINYINT(1) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_blog_topics_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_blog_authors` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `email` TEXT NULL,
  `avatar` JSON NULL,
  `bio` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_blog_authors_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_blog_posts` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `title` TEXT NOT NULL,
  `summary` TEXT NULL,
  `body` MEDIUMTEXT NOT NULL,
  `cover` JSON NULL,
  `topic_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `author_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `featured` TINYINT(1) NOT NULL,
  `published_at` DATETIME(3) NULL,
  `read_minutes` INT NOT NULL,
  `like_count` INT NOT NULL,
  `dislike_count` INT NOT NULL,
  `reply_count` INT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_blog_posts_slug` (`slug`),
  KEY `ix_departments_blog_posts_1` (`status`, `published_at`),
  KEY `ix_departments_blog_posts_2` (`topic_id`, `status`, `published_at`),
  KEY `ix_departments_blog_posts_3` (`author_id`, `status`, `published_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_blog_reactions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `post_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reaction` TEXT NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_blog_reactions_1` (`post_id`, `customer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_blog_replies` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `post_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `parent_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `author_name` TEXT NOT NULL,
  `text` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `like_count` INT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_departments_blog_replies_1` (`post_id`, `status`, `created_at`),
  KEY `ix_departments_blog_replies_2` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_blog_reports` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `target_type` VARCHAR(255) NOT NULL,
  `target_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reporter_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reason` TEXT NOT NULL,
  `note` TEXT NULL,
  `status` VARCHAR(255) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `decided_at` DATETIME(3) NULL,
  `decided_by` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_blog_reports_1` (`target_type`, `target_id`, `reporter_id`),
  KEY `ix_departments_blog_reports_2` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_industries` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `position` INT NOT NULL,
  `visible` TINYINT(1) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_industries_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_companies` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `logo` JSON NULL,
  `industry_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `city` TEXT NULL,
  `tagline` TEXT NULL,
  `verified` TINYINT(1) NOT NULL,
  `description` TEXT NULL,
  `photos` JSON NOT NULL,
  `founded` INT NULL,
  `employees` TEXT NULL,
  `contacts` JSON NOT NULL,
  `location` JSON NULL,
  `status` VARCHAR(255) NOT NULL,
  `position` INT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_companies_slug` (`slug`),
  KEY `ix_departments_companies_1` (`status`, `position`),
  KEY `ix_departments_companies_2` (`industry_id`, `status`, `position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_inquiries` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `company_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `name` TEXT NOT NULL,
  `email` TEXT NOT NULL,
  `phone` TEXT NULL,
  `message` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `staff_note` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_departments_inquiries_1` (`status`, `created_at`),
  KEY `ix_departments_inquiries_2` (`company_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_games` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `title` TEXT NOT NULL,
  `genre` TEXT NOT NULL,
  `icon` JSON NULL,
  `cover` JSON NULL,
  `players_label` TEXT NULL,
  `featured` TINYINT(1) NOT NULL,
  `description` TEXT NULL,
  `how_to_play` JSON NOT NULL,
  `prizes` JSON NOT NULL,
  `prize_note` TEXT NULL,
  `status` VARCHAR(255) NOT NULL,
  `position` INT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_games_slug` (`slug`),
  KEY `ix_departments_games_1` (`status`, `position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_rankings` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `game_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `period` VARCHAR(255) NOT NULL,
  `entries` JSON NOT NULL,
  `updated_by` TEXT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_rankings_1` (`game_id`, `period`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_blog_saves` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `post_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `saved_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_blog_saves_1` (`customer_id`, `post_id`),
  KEY `ix_departments_blog_saves_2` (`customer_id`, `saved_at`),
  KEY `ix_departments_blog_saves_3` (`post_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_blog_follows` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `author_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `followed_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_blog_follows_1` (`author_id`, `customer_id`),
  KEY `ix_departments_blog_follows_2` (`customer_id`, `followed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_blog_reply_likes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reply_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `post_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_blog_reply_likes_1` (`reply_id`, `customer_id`),
  KEY `ix_departments_blog_reply_likes_2` (`post_id`, `customer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_reviews` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `target_type` VARCHAR(32) NOT NULL,
  `target_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` TEXT NOT NULL,
  `stars` INT NOT NULL,
  `text` TEXT NULL,
  `hidden` TINYINT(1) NOT NULL,
  `hidden_reason` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_reviews_1` (`target_type`, `target_id`, `customer_id`),
  KEY `ix_departments_reviews_2` (`target_type`, `target_id`, `hidden`, `updated_at`),
  KEY `ix_departments_reviews_3` (`hidden`, `updated_at`),
  CONSTRAINT `ck_departments_reviews_target_type` CHECK (`target_type` IN ('company', 'game'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_players` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `code` VARCHAR(255) NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_players_code` (`code`),
  UNIQUE KEY `uq_departments_players_customer_id` (`customer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_game_keys` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `game_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `key_hash` VARCHAR(255) NOT NULL,
  `hint` TEXT NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `created_by` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `last_used_at` DATETIME(3) NULL,
  `revoked_at` DATETIME(3) NULL,
  `revoked_by` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_game_keys_key_hash` (`key_hash`),
  KEY `ix_departments_game_keys_1` (`game_id`, `status`),
  CONSTRAINT `ck_departments_game_keys_status` CHECK (`status` IN ('active', 'revoked'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_scores` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `game_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `partner_score_id` VARCHAR(255) NOT NULL,
  `player_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `score` INT NOT NULL,
  `played_at` DATETIME(3) NOT NULL,
  `day` DATE NOT NULL,
  `week` DATE NOT NULL,
  `received_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_scores_1` (`game_id`, `partner_score_id`),
  KEY `ix_departments_scores_2` (`game_id`, `week`, `score`),
  KEY `ix_departments_scores_3` (`game_id`, `day`, `score`),
  KEY `ix_departments_scores_4` (`game_id`, `score`),
  KEY `ix_departments_scores_5` (`game_id`, `customer_id`, `played_at`),
  KEY `ix_departments_scores_6` (`customer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_prize_weeks` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `game_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `week` DATE NOT NULL,
  `state` VARCHAR(32) NOT NULL,
  `winners` INT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_prize_weeks_1` (`game_id`, `week`),
  CONSTRAINT `ck_departments_prize_weeks_state` CHECK (`state` IN ('awarding', 'done'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_prize_awards` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `game_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `week` DATE NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` TEXT NOT NULL,
  `rank` INT NOT NULL,
  `score` INT NOT NULL,
  `reward` TEXT NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `code` TEXT NULL,
  `code_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `state` VARCHAR(32) NOT NULL,
  `error` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_departments_prize_awards_1` (`game_id`, `week`, `customer_id`),
  KEY `ix_departments_prize_awards_2` (`game_id`, `week`, `rank`),
  KEY `ix_departments_prize_awards_3` (`state`, `week`),
  CONSTRAINT `ck_departments_prize_awards_state` CHECK (`state` IN ('issued', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `departments_farm_setup` (
  `id` VARCHAR(255) NOT NULL,
  `types` JSON NOT NULL,
  `machines` JSON NOT NULL,
  `updated_by` TEXT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `departments_blog_posts` ADD CONSTRAINT `fk_departments_blog_posts_topic_id` FOREIGN KEY (`topic_id`) REFERENCES `departments_blog_topics` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `departments_blog_posts` ADD CONSTRAINT `fk_departments_blog_posts_author_id` FOREIGN KEY (`author_id`) REFERENCES `departments_blog_authors` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `departments_blog_reactions` ADD CONSTRAINT `fk_departments_blog_reactions_post_id` FOREIGN KEY (`post_id`) REFERENCES `departments_blog_posts` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `departments_blog_replies` ADD CONSTRAINT `fk_departments_blog_replies_post_id` FOREIGN KEY (`post_id`) REFERENCES `departments_blog_posts` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `departments_companies` ADD CONSTRAINT `fk_departments_companies_industry_id` FOREIGN KEY (`industry_id`) REFERENCES `departments_industries` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `departments_inquiries` ADD CONSTRAINT `fk_departments_inquiries_company_id` FOREIGN KEY (`company_id`) REFERENCES `departments_companies` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `departments_rankings` ADD CONSTRAINT `fk_departments_rankings_game_id` FOREIGN KEY (`game_id`) REFERENCES `departments_games` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `departments_blog_saves` ADD CONSTRAINT `fk_departments_blog_saves_post_id` FOREIGN KEY (`post_id`) REFERENCES `departments_blog_posts` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `departments_blog_follows` ADD CONSTRAINT `fk_departments_blog_follows_author_id` FOREIGN KEY (`author_id`) REFERENCES `departments_blog_authors` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `departments_blog_reply_likes` ADD CONSTRAINT `fk_departments_blog_reply_likes_reply_id` FOREIGN KEY (`reply_id`) REFERENCES `departments_blog_replies` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `departments_blog_reply_likes` ADD CONSTRAINT `fk_departments_blog_reply_likes_post_id` FOREIGN KEY (`post_id`) REFERENCES `departments_blog_posts` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `departments_game_keys` ADD CONSTRAINT `fk_departments_game_keys_game_id` FOREIGN KEY (`game_id`) REFERENCES `departments_games` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `departments_scores` ADD CONSTRAINT `fk_departments_scores_game_id` FOREIGN KEY (`game_id`) REFERENCES `departments_games` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `departments_scores` ADD CONSTRAINT `fk_departments_scores_player_id` FOREIGN KEY (`player_id`) REFERENCES `departments_players` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `departments_prize_weeks` ADD CONSTRAINT `fk_departments_prize_weeks_game_id` FOREIGN KEY (`game_id`) REFERENCES `departments_games` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `departments_prize_awards` ADD CONSTRAINT `fk_departments_prize_awards_game_id` FOREIGN KEY (`game_id`) REFERENCES `departments_games` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
