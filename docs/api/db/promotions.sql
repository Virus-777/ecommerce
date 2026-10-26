-- promotions: MySQL schema generated from docs/api/spec/modules/promotions.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `promotions_campaigns` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `description` TEXT NULL,
  `internal_note` TEXT NULL,
  `owner_kind` VARCHAR(32) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `kind` TEXT NOT NULL,
  `discount` JSON NOT NULL,
  `auto_apply` TINYINT(1) NOT NULL,
  `starts_at` DATETIME(3) NOT NULL,
  `ends_at` DATETIME(3) NOT NULL,
  `time_zone` TEXT NOT NULL,
  `scope_mode` TEXT NOT NULL,
  `eligibility` JSON NOT NULL,
  `budget_amount` BIGINT NULL,
  `budget_used` BIGINT NOT NULL,
  `usage_cap` INT NULL,
  `usage_count` INT NOT NULL,
  `per_customer` INT NULL,
  `per_order` INT NULL,
  `per_customer_units` INT NULL,
  `funding_owner` TEXT NOT NULL,
  `platform_share_bps` INT NULL,
  `cost_center` TEXT NULL,
  `funding_note` TEXT NULL,
  `stacking` JSON NOT NULL,
  `exclusive_group` TEXT NULL,
  `participation` JSON NULL,
  `deals` JSON NULL,
  `terms` TEXT NULL,
  `status` VARCHAR(255) NOT NULL,
  `ended_reason` TEXT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `currency` TEXT NOT NULL,
  `created_by` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `version` INT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_promotions_campaigns_ref` (`ref`),
  KEY `ix_promotions_campaigns_1` (`status`, `starts_at`),
  KEY `ix_promotions_campaigns_2` (`status`, `ends_at`),
  KEY `ix_promotions_campaigns_3` (`seller_id`, `status`),
  KEY `ix_promotions_campaigns_4` (`owner_kind`, `status`, `id`),
  CONSTRAINT `ck_promotions_campaigns_owner_kind` CHECK (`owner_kind` IN ('platform', 'seller'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- promotions_campaign_targets: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `promotions_campaign_targets` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(255) NOT NULL,
  `target_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `excluded` TINYINT(1) NOT NULL,
  `label` TEXT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_promotions_campaign_targets_1` (`campaign_id`, `kind`, `target_id`),
  KEY `ix_promotions_campaign_targets_2` (`kind`, `target_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- promotions_eligible_offers: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `promotions_eligible_offers` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `official_store` TINYINT(1) NOT NULL,
  `eligible` TINYINT(1) NOT NULL,
  `reason` TEXT NULL,
  `refreshed_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`row_id`),
  KEY `ix_promotions_eligible_offers_1` (`offer_id`, `campaign_id`),
  KEY `ix_promotions_eligible_offers_2` (`campaign_id`, `seller_id`),
  KEY `ix_promotions_eligible_offers_3` (`seller_id`, `eligible`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `promotions_funding_reviews` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `state` TEXT NOT NULL,
  `sent_at` DATETIME(3) NOT NULL,
  `reviewer_id` TEXT NULL,
  `decided_at` DATETIME(3) NULL,
  `checks` JSON NOT NULL,
  `platform_max` BIGINT NOT NULL,
  `sellers_max` BIGINT NOT NULL,
  `expected_sales` BIGINT NULL,
  `margin_impact_pts` DECIMAL(6,2) NULL,
  `comment` TEXT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `promotions_participations` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `seller_share_bps` INT NOT NULL,
  `platform_share_bps` INT NOT NULL,
  `respond_by` DATETIME(3) NULL,
  `consented_at` DATETIME(3) NULL,
  `consented_by` TEXT NULL,
  `consent_text` TEXT NULL,
  `reason` TEXT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_promotions_participations_1` (`campaign_id`, `seller_id`),
  KEY `ix_promotions_participations_2` (`seller_id`, `state`),
  KEY `ix_promotions_participations_3` (`state`, `respond_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- promotions_participation_offers: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `promotions_participation_offers` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `participation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `eligible` TINYINT(1) NOT NULL,
  `ineligible_reasons` JSON NOT NULL,
  `included` TINYINT(1) NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_promotions_participation_offers_1` (`participation_id`, `offer_id`),
  KEY `ix_promotions_participation_offers_2` (`offer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `promotions_flash_items` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `deal_price` BIGINT NOT NULL,
  `regular_price` BIGINT NOT NULL,
  `deal_stock` INT NOT NULL,
  `claimed` INT NOT NULL,
  `reserved` INT NOT NULL,
  `purchase_limit` INT NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `sold_out_at` DATETIME(3) NULL,
  `approved_deal_price` BIGINT NULL,
  `approved_deal_stock` INT NULL,
  `approved_purchase_limit` INT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_promotions_flash_items_1` (`campaign_id`, `offer_id`),
  KEY `ix_promotions_flash_items_2` (`offer_id`, `state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- promotions_coupon_codes: partial unique on code where `active` = 1
CREATE TABLE `promotions_coupon_codes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `code` VARCHAR(255) COLLATE utf8mb4_0900_as_ci NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `max_redemptions` INT NULL,
  `redemptions` INT NOT NULL,
  `assigned_customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `issue_key` VARCHAR(255) NULL,
  `active` TINYINT(1) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_promotions_coupon_codes_1` ((IF(`active` = 1, `code`, NULL))),
  KEY `ix_promotions_coupon_codes_2` (`campaign_id`, `created_at`),
  KEY `ix_promotions_coupon_codes_3` (`assigned_customer_id`),
  UNIQUE KEY `uq_promotions_coupon_codes_4` (`issue_key`),
  CONSTRAINT `ck_promotions_coupon_codes_kind` CHECK (`kind` IN ('shared', 'unique'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- promotions_coupon_clips: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `promotions_coupon_clips` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `code_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `clipped_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_promotions_coupon_clips_1` (`customer_id`, `campaign_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `promotions_evaluations` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `input_hash` VARCHAR(255) NOT NULL,
  `result` JSON NOT NULL,
  `valid_until` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_promotions_evaluations_1` (`input_hash`, `valid_until`),
  KEY `ix_promotions_evaluations_2` (`valid_until`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `promotions_redemptions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `code_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `reservation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `idempotency_key` VARCHAR(255) NOT NULL,
  `evaluation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `guest_key` TEXT NULL,
  `state` VARCHAR(255) NOT NULL,
  `amount` BIGINT NOT NULL,
  `platform_part` BIGINT NOT NULL,
  `seller_part` BIGINT NOT NULL,
  `reversed` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `expires_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_promotions_redemptions_1` (`reservation_id`, `campaign_id`),
  KEY `ix_promotions_redemptions_2` (`campaign_id`, `state`),
  KEY `ix_promotions_redemptions_3` (`customer_id`, `campaign_id`),
  KEY `ix_promotions_redemptions_4` (`order_id`),
  KEY `ix_promotions_redemptions_5` (`idempotency_key`, `state`),
  KEY `ix_promotions_redemptions_6` (`evaluation_id`, `idempotency_key`),
  KEY `ix_promotions_redemptions_7` (`state`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- promotions_redemption_lines: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `promotions_redemption_lines` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `redemption_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `line_id` VARCHAR(255) NOT NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `quantity` INT NOT NULL,
  `amount` BIGINT NOT NULL,
  `platform_part` BIGINT NOT NULL,
  `seller_part` BIGINT NOT NULL,
  `reversed` BIGINT NOT NULL,
  PRIMARY KEY (`row_id`),
  KEY `ix_promotions_redemption_lines_1` (`order_item_id`),
  KEY `ix_promotions_redemption_lines_2` (`redemption_id`, `line_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- promotions_usage_counters: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `promotions_usage_counters` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_key` VARCHAR(255) NOT NULL,
  `uses` INT NOT NULL,
  `units` INT NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_promotions_usage_counters_1` (`campaign_id`, `customer_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- promotions_event_reminders: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `promotions_event_reminders` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `sent_at` DATETIME(3) NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_promotions_event_reminders_1` (`customer_id`, `campaign_id`),
  KEY `ix_promotions_event_reminders_2` (`campaign_id`, `sent_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `promotions_campaign_log` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `action` VARCHAR(255) NOT NULL,
  `reason` TEXT NULL,
  `detail` JSON NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_promotions_campaign_log_1` (`campaign_id`, `action`),
  KEY `ix_promotions_campaign_log_2` (`campaign_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- promotions_campaign_results_daily: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `promotions_campaign_results_daily` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `day` DATE NOT NULL,
  `sales` BIGINT NOT NULL,
  `orders` INT NOT NULL,
  `cost_platform` BIGINT NOT NULL,
  `cost_seller` BIGINT NOT NULL,
  `redemptions` INT NOT NULL,
  `returned_items` INT NOT NULL,
  `official_cost_basis` BIGINT NOT NULL,
  `official_revenue` BIGINT NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_promotions_campaign_results_daily_1` (`campaign_id`, `day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `promotions_campaign_targets` ADD CONSTRAINT `fk_promotions_campaign_targets_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `promotions_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `promotions_eligible_offers` ADD CONSTRAINT `fk_promotions_eligible_offers_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `promotions_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `promotions_funding_reviews` ADD CONSTRAINT `fk_promotions_funding_reviews_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `promotions_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `promotions_participations` ADD CONSTRAINT `fk_promotions_participations_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `promotions_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `promotions_participation_offers` ADD CONSTRAINT `fk_promotions_participation_offers_participation_id` FOREIGN KEY (`participation_id`) REFERENCES `promotions_participations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `promotions_flash_items` ADD CONSTRAINT `fk_promotions_flash_items_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `promotions_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `promotions_coupon_codes` ADD CONSTRAINT `fk_promotions_coupon_codes_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `promotions_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `promotions_coupon_clips` ADD CONSTRAINT `fk_promotions_coupon_clips_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `promotions_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `promotions_coupon_clips` ADD CONSTRAINT `fk_promotions_coupon_clips_code_id` FOREIGN KEY (`code_id`) REFERENCES `promotions_coupon_codes` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `promotions_redemptions` ADD CONSTRAINT `fk_promotions_redemptions_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `promotions_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `promotions_redemption_lines` ADD CONSTRAINT `fk_promotions_redemption_lines_redemption_id` FOREIGN KEY (`redemption_id`) REFERENCES `promotions_redemptions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `promotions_usage_counters` ADD CONSTRAINT `fk_promotions_usage_counters_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `promotions_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `promotions_event_reminders` ADD CONSTRAINT `fk_promotions_event_reminders_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `promotions_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `promotions_campaign_log` ADD CONSTRAINT `fk_promotions_campaign_log_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `promotions_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `promotions_campaign_results_daily` ADD CONSTRAINT `fk_promotions_campaign_results_daily_campaign_id` FOREIGN KEY (`campaign_id`) REFERENCES `promotions_campaigns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
