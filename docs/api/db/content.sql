-- content: MySQL schema generated from docs/api/spec/modules/content.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `content_home_sections` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `heading` TEXT NULL,
  `subheading` TEXT NULL,
  `config` JSON NOT NULL,
  `linked_promotion_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `linked_page_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `ad_placement_key` TEXT NULL,
  `show_from` DATETIME(3) NULL,
  `remove_at` DATETIME(3) NULL,
  `time_zone` TEXT NOT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `owner_role` TEXT NULL,
  `status` TEXT NOT NULL,
  `draft_position` INT NOT NULL,
  `removed_reason` TEXT NULL,
  `updated_by` TEXT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `content_pages` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(255) NOT NULL,
  `collection_kind` TEXT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `title` TEXT NOT NULL,
  `brand_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `linked_promotion_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `status` VARCHAR(255) NOT NULL,
  `publish_at` DATETIME(3) NULL,
  `unpublish_at` DATETIME(3) NULL,
  `time_zone` TEXT NOT NULL,
  `live_version_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `draft_version_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `removal` JSON NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_content_pages_slug` (`slug`),
  KEY `ix_content_pages_1` (`kind`, `status`),
  KEY `ix_content_pages_2` (`brand_id`, `status`),
  KEY `ix_content_pages_3` (`status`, `publish_at`),
  KEY `ix_content_pages_4` (`status`, `unpublish_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `content_versions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `entity` VARCHAR(32) NOT NULL,
  `entity_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `number` INT NOT NULL,
  `state` TEXT NOT NULL,
  `snapshot` JSON NOT NULL,
  `summary` TEXT NULL,
  `author_kind` TEXT NOT NULL,
  `author_id` TEXT NULL,
  `restored_from` INT NULL,
  `review_state` VARCHAR(32) NULL,
  `submitted_by` TEXT NULL,
  `submitted_at` DATETIME(3) NULL,
  `reviewed_by` TEXT NULL,
  `reviewed_at` DATETIME(3) NULL,
  `review_note` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `published_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_content_versions_1` (`entity`, `entity_id`, `number`),
  CONSTRAINT `ck_content_versions_entity` CHECK (`entity` IN ('homepage', 'page', 'article', 'news')),
  CONSTRAINT `ck_content_versions_review_state` CHECK (`review_state` IN ('not_submitted', 'in_review', 'approved', 'changes_requested'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `content_help_categories` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `icon` TEXT NULL,
  `description` TEXT NULL,
  `position` INT NOT NULL,
  `visible` TINYINT(1) NOT NULL,
  `audience` TEXT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_content_help_categories_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `content_help_articles` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `title` TEXT NOT NULL,
  `summary` TEXT NULL,
  `audience` TEXT NOT NULL,
  `topics` JSON NOT NULL,
  `related_ids` JSON NOT NULL,
  `policy_keys` JSON NOT NULL,
  `featured` TINYINT(1) NOT NULL,
  `popular_search` TEXT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `status` VARCHAR(255) NOT NULL,
  `publish_at` DATETIME(3) NULL,
  `unpublish_at` DATETIME(3) NULL,
  `effective_at` DATETIME(3) NULL,
  `review_due_at` DATETIME(3) NULL,
  `live_version_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `draft_version_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `views` INT NOT NULL,
  `search` TEXT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_content_help_articles_slug` (`slug`),
  KEY `ix_content_help_articles_1` (`category_id`, `status`),
  KEY `ix_content_help_articles_2` (`status`, `review_due_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `content_article_feedback` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `article_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `helpful` TINYINT(1) NOT NULL,
  `comment` TEXT NULL,
  `visitor_key` VARCHAR(255) NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_content_article_feedback_1` (`article_id`, `visitor_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `content_policies` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `key` VARCHAR(255) NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `title` TEXT NOT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `editor_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `audience` VARCHAR(32) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_content_policies_key` (`key`),
  CONSTRAINT `ck_content_policies_kind` CHECK (`kind` IN ('returns', 'shipping', 'privacy', 'purchase_terms', 'seller_rules', 'advertising', 'cookies', 'other')),
  CONSTRAINT `ck_content_policies_audience` CHECK (`audience` IN ('customer', 'seller', 'both'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `content_policy_versions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `policy_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `version` VARCHAR(255) NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `title` TEXT NOT NULL,
  `body` MEDIUMTEXT NOT NULL,
  `tables` JSON NULL,
  `effective_at` DATETIME(3) NULL,
  `change_summary` TEXT NULL,
  `impact` TEXT NOT NULL,
  `notify_customers` TINYINT(1) NOT NULL,
  `notify_sellers` TINYINT(1) NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_by` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `published_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_content_policy_versions_1` (`policy_id`, `version`),
  KEY `ix_content_policy_versions_2` (`policy_id`, `state`, `effective_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `content_policy_approvals` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `policy_version_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `role` TEXT NOT NULL,
  `reviewer_id` TEXT NULL,
  `state` TEXT NOT NULL,
  `note` TEXT NULL,
  `at` DATETIME(3) NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `content_navigation` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `area` VARCHAR(32) NOT NULL,
  `group_title` TEXT NULL,
  `position` INT NOT NULL,
  `label` TEXT NOT NULL,
  `url` TEXT NOT NULL,
  `kind` TEXT NOT NULL,
  `text` TEXT NULL,
  `active_from` DATETIME(3) NULL,
  `active_until` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `ck_content_navigation_area` CHECK (`area` IN ('header', 'footer', 'service_strip'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `content_news_categories` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `icon` TEXT NULL,
  `position` INT NOT NULL,
  `visible` TINYINT(1) NOT NULL,
  `previous_slugs` JSON NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_content_news_categories_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `content_news_posts` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `previous_slugs` JSON NOT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `title` TEXT NOT NULL,
  `summary` TEXT NOT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `status` VARCHAR(255) NOT NULL,
  `pinned` TINYINT(1) NOT NULL,
  `pinned_at` DATETIME(3) NULL,
  `publish_at` DATETIME(3) NULL,
  `unpublish_at` DATETIME(3) NULL,
  `archive_at` DATETIME(3) NULL,
  `published_at` DATETIME(3) NULL,
  `live_version_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `draft_version_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_content_news_posts_slug` (`slug`),
  KEY `ix_content_news_posts_1` (`status`, `published_at`),
  KEY `ix_content_news_posts_2` (`category_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `content_content_log` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `entity` VARCHAR(255) NOT NULL,
  `entity_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `action` TEXT NOT NULL,
  `reason` TEXT NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_content_content_log_1` (`entity`, `entity_id`, `at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `content_pages` ADD CONSTRAINT `fk_content_pages_live_version_id` FOREIGN KEY (`live_version_id`) REFERENCES `content_versions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `content_pages` ADD CONSTRAINT `fk_content_pages_draft_version_id` FOREIGN KEY (`draft_version_id`) REFERENCES `content_versions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `content_help_articles` ADD CONSTRAINT `fk_content_help_articles_category_id` FOREIGN KEY (`category_id`) REFERENCES `content_help_categories` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `content_help_articles` ADD CONSTRAINT `fk_content_help_articles_live_version_id` FOREIGN KEY (`live_version_id`) REFERENCES `content_versions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `content_help_articles` ADD CONSTRAINT `fk_content_help_articles_draft_version_id` FOREIGN KEY (`draft_version_id`) REFERENCES `content_versions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `content_article_feedback` ADD CONSTRAINT `fk_content_article_feedback_article_id` FOREIGN KEY (`article_id`) REFERENCES `content_help_articles` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `content_policy_versions` ADD CONSTRAINT `fk_content_policy_versions_policy_id` FOREIGN KEY (`policy_id`) REFERENCES `content_policies` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `content_policy_approvals` ADD CONSTRAINT `fk_content_policy_approvals_policy_version_id` FOREIGN KEY (`policy_version_id`) REFERENCES `content_policy_versions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `content_news_posts` ADD CONSTRAINT `fk_content_news_posts_category_id` FOREIGN KEY (`category_id`) REFERENCES `content_news_categories` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `content_news_posts` ADD CONSTRAINT `fk_content_news_posts_live_version_id` FOREIGN KEY (`live_version_id`) REFERENCES `content_versions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `content_news_posts` ADD CONSTRAINT `fk_content_news_posts_draft_version_id` FOREIGN KEY (`draft_version_id`) REFERENCES `content_versions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
