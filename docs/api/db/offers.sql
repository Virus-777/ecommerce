-- offers: MySQL schema generated from docs/api/spec/modules/offers.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

-- offers_offers: partial unique on owner_type, seller_id, variant_id where `condition` = 'new' AND `status` <> 'removed'
-- offers_offers: partial unique on stock_item_id where `status` <> 'removed'
-- offers_offers: FULLTEXT ngram over title: terms shorter than the ngram size fall back to LIKE (§6.1)
CREATE TABLE `offers_offers` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_type` VARCHAR(32) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `condition` VARCHAR(255) NOT NULL,
  `condition_notes` TEXT NULL,
  `included_items` JSON NOT NULL,
  `missing_items` JSON NOT NULL,
  `missing_items_stale` TINYINT(1) NOT NULL,
  `seller_sku` VARCHAR(255) NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `price_amount` BIGINT NOT NULL,
  `currency` CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `compare_at_amount` BIGINT NULL,
  `compare_at_basis` TEXT NULL,
  `compare_at_verified` TINYINT(1) NOT NULL,
  `sale_ends_at` DATETIME(3) NULL,
  `purchase_limit` INT NULL,
  `dispatch_business_days` INT NOT NULL,
  `same_day_cutoff` TIME NULL,
  `ships_from` TEXT NOT NULL,
  `shipping_profile_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `fulfilled_by` VARCHAR(32) NOT NULL,
  `return_kind` TEXT NOT NULL,
  `return_window_days` INT NOT NULL,
  `free_return_shipping` TINYINT(1) NOT NULL,
  `return_policy_version` TEXT NULL,
  `return_category_exception` TEXT NULL,
  `warranty_kind` TEXT NOT NULL,
  `warranty_months` INT NULL,
  `warranty_handled_by` TEXT NULL,
  `status` VARCHAR(32) NOT NULL,
  `status_before_ineligible` TEXT NULL,
  `ineligible_source` JSON NULL,
  `status_reason` JSON NULL,
  `publish_on_approval` TINYINT(1) NOT NULL,
  `content_gaps` JSON NOT NULL,
  `terms_version` INT NOT NULL,
  `published_at` DATETIME(3) NULL,
  `removed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_offers_offers_1` ((COALESCE(`owner_type`, '')), (COALESCE(`seller_id`, '')), (COALESCE(`seller_sku`, ''))),
  UNIQUE KEY `uq_offers_offers_2` ((IF(`condition` = 'new' AND `status` <> 'removed', (COALESCE(`owner_type`, '')), NULL)), (COALESCE(`seller_id`, '')), (COALESCE(`variant_id`, ''))),
  UNIQUE KEY `uq_offers_offers_3` ((IF(`status` <> 'removed', `stock_item_id`, NULL))),
  KEY `ix_offers_offers_4` (`product_id`, `variant_id`, `status`),
  KEY `ix_offers_offers_5` (`variant_id`, `status`, `price_amount`),
  KEY `ix_offers_offers_6` (`seller_id`, `status`, `id`),
  KEY `ix_offers_offers_7` (`seller_id`, `updated_at`, `id`),
  KEY `ix_offers_offers_8` (`status`, `id`),
  KEY `ix_offers_offers_9` (`stock_item_id`),
  KEY `ix_offers_offers_10` (`shipping_profile_id`, `status`),
  FULLTEXT KEY `ft_offers_offers_11` (`title`) WITH PARSER ngram,
  CONSTRAINT `ck_offers_offers_owner_type` CHECK (`owner_type` IN ('official', 'seller')),
  CONSTRAINT `ck_offers_offers_fulfilled_by` CHECK (`fulfilled_by` IN ('official_warehouse', 'seller', 'marketly_service')),
  CONSTRAINT `ck_offers_offers_status` CHECK (`status` IN ('draft', 'active', 'paused', 'out_of_stock', 'ineligible', 'removed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `offers_offer_price_history` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `price_amount` BIGINT NOT NULL,
  `compare_at_amount` BIGINT NULL,
  `valid_from` DATETIME(3) NOT NULL,
  `valid_to` DATETIME(3) NULL,
  `price_change_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_offers_offer_price_history_1` (`offer_id`, `valid_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `offers_price_changes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `from_amount` BIGINT NOT NULL,
  `to_amount` BIGINT NOT NULL,
  `change_pct` DECIMAL(6,2) NOT NULL,
  `compare_at_amount` BIGINT NULL,
  `compare_at_basis` TEXT NULL,
  `starts_at` DATETIME(3) NULL,
  `ends_at` DATETIME(3) NULL,
  `revert_to_amount` BIGINT NULL,
  `reason` TEXT NULL,
  `source` TEXT NOT NULL,
  `bulk_job_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `state` VARCHAR(255) NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `requested_by_kind` TEXT NOT NULL,
  `requested_by_id` TEXT NULL,
  `decided_at` DATETIME(3) NULL,
  `applied_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_offers_price_changes_1` (`state`, `starts_at`),
  KEY `ix_offers_price_changes_2` (`state`, `ends_at`),
  KEY `ix_offers_price_changes_3` (`offer_id`, `created_at`),
  KEY `ix_offers_price_changes_4` (`approval_request_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `offers_offer_status_log` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `from_status` TEXT NULL,
  `to_status` TEXT NOT NULL,
  `event` TEXT NOT NULL,
  `reason_code` TEXT NULL,
  `reason` TEXT NULL,
  `affected_activity` TEXT NULL,
  `appeal_route` TEXT NULL,
  `review_date` DATE NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_offers_offer_status_log_1` (`offer_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `offers_offer_eligibility` (
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `eligible` TINYINT(1) NOT NULL,
  `reasons` JSON NOT NULL,
  `seller_on_time_pct` DECIMAL(5,2) NULL,
  `seller_restriction_ref` TEXT NULL,
  `evaluated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`offer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- offers_featured_offers: partial index: dirty from "where `dirty` = 1" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `offers_featured_offers` (
  `variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `condition_group` VARCHAR(32) NOT NULL,
  `zone_key` VARCHAR(255) NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `rule_version` INT NOT NULL,
  `candidates` JSON NOT NULL,
  `dirty` TINYINT(1) NOT NULL,
  `computed_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`variant_id`, `condition_group`, `zone_key`),
  KEY `ix_offers_featured_offers_2` (`product_id`),
  KEY `ix_offers_featured_offers_3` (`dirty`),
  CONSTRAINT `ck_offers_featured_offers_condition_group` CHECK (`condition_group` IN ('new', 'used', 'refurbished'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `offers_featured_rules` (
  `version` INT NOT NULL,
  `text` TEXT NOT NULL,
  `steps` JSON NOT NULL,
  `parameters` JSON NOT NULL,
  `effective_from` DATETIME(3) NOT NULL,
  `reason` TEXT NOT NULL,
  `published_by` TEXT NOT NULL,
  `published_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `offers_bulk_update_jobs` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_type` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `file_media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `file_name` TEXT NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `totals` JSON NOT NULL,
  `report_media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `uploaded_by` TEXT NOT NULL,
  `uploaded_at` DATETIME(3) NOT NULL,
  `applied_by` TEXT NULL,
  `applied_at` DATETIME(3) NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `failure` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_offers_bulk_update_jobs_1` (`seller_id`, `uploaded_at`),
  KEY `ix_offers_bulk_update_jobs_2` (`state`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `offers_bulk_update_rows` (
  `job_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `row_no` INT NOT NULL,
  `seller_sku` TEXT NOT NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `price_from` BIGINT NULL,
  `price_to` BIGINT NULL,
  `qty_from` INT NULL,
  `qty_to` INT NULL,
  `cost_from` BIGINT NULL,
  `cost_to` BIGINT NULL,
  `result` VARCHAR(255) NOT NULL,
  `error_code` TEXT NULL,
  `error_message` TEXT NULL,
  PRIMARY KEY (`job_id`, `row_no`),
  KEY `ix_offers_bulk_update_rows_2` (`job_id`, `result`, `row_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `offers_offer_costs` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `unit_cost_minor` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `effective_from` DATE NOT NULL,
  `note` TEXT NULL,
  `set_by_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `set_by_name` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_offers_offer_costs_1` (`offer_id`, `effective_from` DESC, `created_at` DESC),
  KEY `ix_offers_offer_costs_2` (`seller_id`, `created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `offers_offer_price_history` ADD CONSTRAINT `fk_offers_offer_price_history_offer_id` FOREIGN KEY (`offer_id`) REFERENCES `offers_offers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `offers_offer_price_history` ADD CONSTRAINT `fk_offers_offer_price_history_price_change_id` FOREIGN KEY (`price_change_id`) REFERENCES `offers_price_changes` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `offers_price_changes` ADD CONSTRAINT `fk_offers_price_changes_offer_id` FOREIGN KEY (`offer_id`) REFERENCES `offers_offers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `offers_price_changes` ADD CONSTRAINT `fk_offers_price_changes_bulk_job_id` FOREIGN KEY (`bulk_job_id`) REFERENCES `offers_bulk_update_jobs` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `offers_offer_status_log` ADD CONSTRAINT `fk_offers_offer_status_log_offer_id` FOREIGN KEY (`offer_id`) REFERENCES `offers_offers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `offers_offer_eligibility` ADD CONSTRAINT `fk_offers_offer_eligibility_offer_id` FOREIGN KEY (`offer_id`) REFERENCES `offers_offers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `offers_bulk_update_rows` ADD CONSTRAINT `fk_offers_bulk_update_rows_job_id` FOREIGN KEY (`job_id`) REFERENCES `offers_bulk_update_jobs` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `offers_offer_costs` ADD CONSTRAINT `fk_offers_offer_costs_offer_id` FOREIGN KEY (`offer_id`) REFERENCES `offers_offers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
