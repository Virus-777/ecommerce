-- advertising: MySQL schema generated from docs/api/spec/modules/advertising.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `advertising_placements` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `key` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `kind` TEXT NOT NULL,
  `enabled` TINYINT(1) NOT NULL,
  `availability` TEXT NOT NULL,
  `eligible_pages` JSON NOT NULL,
  `formats` JSON NOT NULL,
  `frequency_cap` JSON NULL,
  `trigger` JSON NULL,
  `rotation` JSON NOT NULL,
  `dismissal` JSON NOT NULL,
  `max_per_page` INT NULL,
  `positions` JSON NULL,
  `label` TEXT NOT NULL,
  `description` TEXT NOT NULL,
  `version` INT NOT NULL,
  `updated_by` TEXT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_advertising_placements_key` (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `advertising_global_rules` (
  `version` INT NOT NULL,
  `rules` JSON NOT NULL,
  `effective_at` DATETIME(3) NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_by` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `advertising_campaigns` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `origin` VARCHAR(32) NOT NULL,
  `advertiser_kind` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `brand_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `goal` TEXT NOT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `linked_promotion_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `placement_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `pages` JSON NOT NULL,
  `page_category_ids` JSON NOT NULL,
  `audience` JSON NOT NULL,
  `destination` JSON NOT NULL,
  `starts_at` DATETIME(3) NULL,
  `ends_at` DATETIME(3) NULL,
  `time_zone` TEXT NOT NULL,
  `frequency_cap` JSON NOT NULL,
  `dismissal` JSON NOT NULL,
  `priority` INT NOT NULL,
  `billing` TEXT NOT NULL,
  `rate` BIGINT NULL,
  `daily_limit` BIGINT NULL,
  `total_limit` BIGINT NULL,
  `delivery_cap` INT NULL,
  `spent` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `stop_with_promotion` TINYINT(1) NOT NULL,
  `after_approval` VARCHAR(32) NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `paused_reason` TEXT NULL,
  `paused_by` TEXT NULL,
  `paused_at` DATETIME(3) NULL,
  `pause_cause` VARCHAR(32) NULL,
  `rejected_reason` TEXT NULL,
  `finished_reason` TEXT NULL,
  `note_to_reviewers` TEXT NULL,
  `position` INT NULL,
  `alt` TEXT NULL,
  `pending_change` JSON NULL,
  `created_by` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `version` INT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_advertising_campaigns_ref` (`ref`),
  KEY `ix_advertising_campaigns_1` (`status`, `starts_at`),
  KEY `ix_advertising_campaigns_2` (`status`, `ends_at`),
  KEY `ix_advertising_campaigns_3` (`placement_id`, `status`),
  KEY `ix_advertising_campaigns_4` (`seller_id`, `status`),
  KEY `ix_advertising_campaigns_5` (`linked_promotion_id`),
  KEY `ix_advertising_campaigns_6` (`placement_id`, `position`),
  CONSTRAINT `ck_advertising_campaigns_origin` CHECK (`origin` IN ('staff', 'seller_request')),
  CONSTRAINT `ck_advertising_campaigns_after_approval` CHECK (`after_approval` IN ('schedule', 'activate')),
  CONSTRAINT `ck_advertising_campaigns_pause_cause` CHECK (`pause_cause` IN ('promotion', 'offer', 'stock', 'product', 'availability', 'seller', 'trust'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- advertising_campaign_items: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `advertising_campaign_items` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `target_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `label` TEXT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`row_id`),
  KEY `ix_advertising_campaign_items_1` (`kind`, `target_id`),
  KEY `ix_advertising_campaign_items_2` (`product_id`),
  KEY `ix_advertising_campaign_items_3` (`campaign_id`),
  CONSTRAINT `ck_advertising_campaign_items_kind` CHECK (`kind` IN ('offer', 'product', 'seller_store', 'brand'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- advertising_campaign_creatives: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `advertising_campaign_creatives` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `creative_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `device` TEXT NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_advertising_campaign_creatives_1` (`campaign_id`, `creative_id`),
  KEY `ix_advertising_campaign_creatives_2` (`creative_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `advertising_approval_steps` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `submission` INT NOT NULL,
  `role` TEXT NOT NULL,
  `reviewer_id` TEXT NULL,
  `state` TEXT NOT NULL,
  `note` TEXT NULL,
  `decided_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_advertising_approval_steps_1` (`campaign_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `advertising_creatives` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `advertiser_kind` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `brand_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `kind` TEXT NOT NULL,
  `device` TEXT NOT NULL,
  `placement_key` TEXT NOT NULL,
  `media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `file_name` TEXT NULL,
  `width` INT NULL,
  `height` INT NULL,
  `bytes` INT NULL,
  `duration_seconds` INT NULL,
  `headline` TEXT NULL,
  `body` TEXT NULL,
  `button_text` TEXT NULL,
  `link` TEXT NULL,
  `status` VARCHAR(255) NOT NULL,
  `link_check` JSON NOT NULL,
  `auto_checks` JSON NOT NULL,
  `created_by` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_advertising_creatives_1` (`status`, `created_at`),
  KEY `ix_advertising_creatives_2` (`seller_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `advertising_creative_reviews` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `creative_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reviewer_id` TEXT NOT NULL,
  `role` TEXT NOT NULL,
  `decision` TEXT NOT NULL,
  `reason_code` TEXT NULL,
  `comment` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_advertising_creative_reviews_1` (`creative_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `advertising_campaign_log` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `action` VARCHAR(255) NOT NULL,
  `from_status` TEXT NULL,
  `to_status` TEXT NULL,
  `reason` TEXT NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_advertising_campaign_log_1` (`campaign_id`, `action`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `advertising_ad_events` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `impression_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `creative_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `placement_key` VARCHAR(255) NOT NULL,
  `kind` VARCHAR(255) NOT NULL,
  `visitor_key` VARCHAR(255) NOT NULL,
  `session_id` TEXT NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `page` TEXT NOT NULL,
  `device` TEXT NOT NULL,
  `at` DATETIME(3) NOT NULL,
  `cost` BIGINT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_advertising_ad_events_1` (`campaign_id`, `at`),
  KEY `ix_advertising_ad_events_2` (`visitor_key`, `campaign_id`, `kind`, `at`),
  KEY `ix_advertising_ad_events_3` (`at`),
  KEY `ix_advertising_ad_events_4` (`customer_id`, `kind`, `at`),
  KEY `ix_advertising_ad_events_5` (`placement_key`, `kind`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- advertising_frequency_state: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `advertising_frequency_state` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `visitor_key` VARCHAR(255) NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `session_id` TEXT NULL,
  `session_displays` INT NOT NULL,
  `window_displays` INT NOT NULL,
  `window_started_at` DATETIME(3) NOT NULL,
  `display_day` DATE NULL,
  `day_displays` INT NOT NULL,
  `total_displays` INT NOT NULL,
  `last_display_at` DATETIME(3) NULL,
  `suppressed_until` DATETIME(3) NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_advertising_frequency_state_1` (`visitor_key`, `campaign_id`),
  KEY `ix_advertising_frequency_state_2` (`window_started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `advertising_attributions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `click_event_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `attributed_at` DATETIME(3) NOT NULL,
  `reversed` TINYINT(1) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_advertising_attributions_1` (`order_id`, `campaign_id`),
  KEY `ix_advertising_attributions_2` (`attributed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- advertising_daily_stats: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `advertising_daily_stats` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `day` DATE NOT NULL,
  `displays` INT NOT NULL,
  `clicks` INT NOT NULL,
  `dismissals` INT NOT NULL,
  `spend` BIGINT NOT NULL,
  `attributed_orders` INT NOT NULL,
  `attributed_sales` BIGINT NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_advertising_daily_stats_1` (`campaign_id`, `day`),
  KEY `ix_advertising_daily_stats_2` (`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `advertising_ad_charges` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `day` DATE NOT NULL,
  `basis` TEXT NOT NULL,
  `units` INT NOT NULL,
  `rate` BIGINT NOT NULL,
  `amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `posted_at` DATETIME(3) NULL,
  `ledger_entry_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `statement_ref` TEXT NULL,
  `reason` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_advertising_ad_charges_1` (`campaign_id`, `day`),
  KEY `ix_advertising_ad_charges_2` (`seller_id`, `state`),
  KEY `ix_advertising_ad_charges_3` (`state`, `day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `advertising_campaigns` ADD CONSTRAINT `fk_advertising_campaigns_placement_id` FOREIGN KEY (`placement_id`) REFERENCES `advertising_placements` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `advertising_campaign_items` ADD CONSTRAINT `fk_advertising_campaign_items_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `advertising_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `advertising_campaign_creatives` ADD CONSTRAINT `fk_advertising_campaign_creatives_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `advertising_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `advertising_campaign_creatives` ADD CONSTRAINT `fk_advertising_campaign_creatives_creative_id` FOREIGN KEY (`creative_id`) REFERENCES `advertising_creatives` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `advertising_approval_steps` ADD CONSTRAINT `fk_advertising_approval_steps_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `advertising_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `advertising_creative_reviews` ADD CONSTRAINT `fk_advertising_creative_reviews_creative_id` FOREIGN KEY (`creative_id`) REFERENCES `advertising_creatives` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `advertising_campaign_log` ADD CONSTRAINT `fk_advertising_campaign_log_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `advertising_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `advertising_ad_charges` ADD CONSTRAINT `fk_advertising_ad_charges_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `advertising_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
