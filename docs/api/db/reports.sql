-- reports: MySQL schema generated from docs/api/spec/modules/reports.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `reports_metric_definitions` (
  `key` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `group_key` TEXT NOT NULL,
  `definition` TEXT NOT NULL,
  `formula` TEXT NOT NULL,
  `unit` TEXT NOT NULL,
  `includes` JSON NOT NULL,
  `excludes` JSON NOT NULL,
  `date_basis_options` JSON NOT NULL,
  `default_date_basis` TEXT NOT NULL,
  `currency_rule` TEXT NOT NULL,
  `time_zone` TEXT NOT NULL,
  `related_keys` JSON NOT NULL,
  `audience` TEXT NOT NULL,
  `launch_measure` TINYINT(1) NOT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `status` TEXT NOT NULL,
  `version` INT NOT NULL,
  `effective_from` DATE NOT NULL,
  `reviewed_at` DATE NULL,
  `change_note` TEXT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reports_metric_owner_changes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `metric_key` VARCHAR(255) NOT NULL,
  `from_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `to_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reason` TEXT NOT NULL,
  `changed_by` TEXT NOT NULL,
  `changed_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_reports_metric_owner_changes_1` (`metric_key`, `changed_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reports_metric_versions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `metric_key` VARCHAR(255) NOT NULL,
  `version` INT NOT NULL,
  `snapshot` JSON NOT NULL,
  `change_note` TEXT NOT NULL,
  `changed_by` TEXT NOT NULL,
  `effective_from` DATE NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reports_metric_versions_1` (`metric_key`, `version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reports_metric_suggestions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `metric_key` VARCHAR(255) NOT NULL,
  `proposed` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `suggested_by` TEXT NOT NULL,
  `state` TEXT NOT NULL,
  `decision_note` TEXT NULL,
  `decided_by` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reports_report_definitions` (
  `key` VARCHAR(255) NOT NULL,
  `group_key` TEXT NOT NULL,
  `title` TEXT NOT NULL,
  `description` TEXT NOT NULL,
  `metrics` JSON NOT NULL,
  `dimensions` JSON NOT NULL,
  `filters` JSON NOT NULL,
  `permission` TEXT NOT NULL,
  `audience` TEXT NOT NULL,
  `layout` JSON NOT NULL,
  `phase` INT NOT NULL,
  `active` TINYINT(1) NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reports_report_groups` (
  `key` VARCHAR(255) NOT NULL,
  `label` TEXT NOT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `position` INT NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reports_saved_views` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `report_key` TEXT NOT NULL,
  `name` TEXT NOT NULL,
  `query` JSON NOT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `shared` TINYINT(1) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reports_report_schedules` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `report_key` TEXT NOT NULL,
  `saved_view_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `recipients` JSON NOT NULL,
  `frequency` TEXT NOT NULL,
  `day_of_week` INT NULL,
  `time` TEXT NOT NULL,
  `format` VARCHAR(32) NOT NULL,
  `next_run_at` DATETIME(3) NOT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `active` TINYINT(1) NOT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `ck_reports_report_schedules_format` CHECK (`format` IN ('csv', 'xlsx'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reports_export_datasets` (
  `key` VARCHAR(255) NOT NULL,
  `owner_module` TEXT NOT NULL,
  `title` TEXT NOT NULL,
  `permission` TEXT NOT NULL,
  `audience` VARCHAR(32) NOT NULL,
  `columns` JSON NOT NULL,
  `screens` JSON NOT NULL,
  `available` TINYINT(1) NOT NULL,
  `phase` INT NOT NULL,
  `registered_at` DATETIME(3) NULL,
  PRIMARY KEY (`key`),
  CONSTRAINT `ck_reports_export_datasets_audience` CHECK (`audience` IN ('staff', 'seller'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reports_export_jobs` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `dataset` TEXT NOT NULL,
  `report_key` TEXT NULL,
  `format` TEXT NOT NULL,
  `filters` JSON NOT NULL,
  `requested_by_kind` TEXT NOT NULL,
  `requested_by_id` VARCHAR(255) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `state` VARCHAR(255) NOT NULL,
  `row_count` INT NULL,
  `columns_excluded` JSON NOT NULL,
  `file_media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `sha256` TEXT NULL,
  `expires_at` DATETIME(3) NULL,
  `error` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `finished_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reports_export_jobs_ref` (`ref`),
  KEY `ix_reports_export_jobs_1` (`requested_by_id`, `created_at` DESC),
  KEY `ix_reports_export_jobs_2` (`state`, `created_at`),
  KEY `ix_reports_export_jobs_3` (`state`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reports_fact_order_items` (
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_type` VARCHAR(32) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `customer_key` VARCHAR(255) NOT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `quantity` INT NOT NULL,
  `item_minor` BIGINT NOT NULL,
  `shipping_minor` BIGINT NOT NULL,
  `discount_platform_minor` BIGINT NOT NULL,
  `discount_seller_minor` BIGINT NOT NULL,
  `tax_minor` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `placed_at` DATETIME(3) NOT NULL,
  `paid_at` DATETIME(3) NULL,
  `shipped_at` DATETIME(3) NULL,
  `delivered_at` DATETIME(3) NULL,
  `completed_at` DATETIME(3) NULL,
  `cancelled_at` DATETIME(3) NULL,
  `cancelled_by` TEXT NULL,
  `cancelled_minor` BIGINT NOT NULL,
  `refunded_minor` BIGINT NOT NULL,
  `last_refund_at` DATETIME(3) NULL,
  `buying_cost_minor` BIGINT NULL,
  `fee_minor` BIGINT NULL,
  `accepted_at` DATETIME(3) NULL,
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `fulfilled_by` VARCHAR(32) NULL,
  PRIMARY KEY (`order_item_id`),
  KEY `ix_reports_fact_order_items_1` (`placed_at`),
  KEY `ix_reports_fact_order_items_2` (`paid_at`),
  KEY `ix_reports_fact_order_items_3` (`shipped_at`),
  KEY `ix_reports_fact_order_items_4` (`completed_at`),
  KEY `ix_reports_fact_order_items_5` (`seller_id`, `placed_at`),
  KEY `ix_reports_fact_order_items_6` (`product_id`, `placed_at`),
  KEY `ix_reports_fact_order_items_7` (`order_id`, `group_id`),
  KEY `ix_reports_fact_order_items_8` (`cancelled_at`),
  KEY `ix_reports_fact_order_items_9` (`customer_key`, `order_id`),
  CONSTRAINT `ck_reports_fact_order_items_owner_type` CHECK (`owner_type` IN ('official', 'seller')),
  CONSTRAINT `ck_reports_fact_order_items_fulfilled_by` CHECK (`fulfilled_by` IN ('official_warehouse', 'seller', 'marketly_service'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reports_fact_refunds` (
  `refund_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_type` VARCHAR(32) NOT NULL,
  `amount_minor` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `reason` TEXT NULL,
  `after_payout` TINYINT(1) NOT NULL,
  `sent_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`refund_id`, `seller_id`),
  KEY `ix_reports_fact_refunds_2` (`sent_at`),
  KEY `ix_reports_fact_refunds_3` (`seller_id`, `sent_at`),
  CONSTRAINT `ck_reports_fact_refunds_owner_type` CHECK (`owner_type` IN ('official', 'seller'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reports_fact_returns` (
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `units` INT NOT NULL,
  `reason` TEXT NOT NULL,
  `requested_at` DATETIME(3) NOT NULL,
  `outcome` TEXT NULL,
  `stock_outcome` TEXT NULL,
  PRIMARY KEY (`return_id`),
  KEY `ix_reports_fact_returns_1` (`seller_id`, `requested_at`),
  KEY `ix_reports_fact_returns_2` (`product_id`, `requested_at`),
  KEY `ix_reports_fact_returns_3` (`requested_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- reports_fact_marketplace_finance_daily: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `reports_fact_marketplace_finance_daily` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `day` DATE NOT NULL,
  `seller_sales_minor` BIGINT NOT NULL,
  `fee_income_minor` BIGINT NOT NULL,
  `platform_discount_minor` BIGINT NOT NULL,
  `seller_discount_minor` BIGINT NOT NULL,
  `held_minor` BIGINT NOT NULL,
  `payouts_paid_minor` BIGINT NOT NULL,
  `payouts_failed` INT NOT NULL,
  `owed_minor` BIGINT NOT NULL,
  `ad_charges_minor` BIGINT NOT NULL,
  `service_fees_minor` BIGINT NOT NULL,
  `fee_gross_minor` BIGINT NOT NULL,
  `fee_refunds_minor` BIGINT NOT NULL,
  `refunds_minor` BIGINT NOT NULL,
  `shipping_charged_minor` BIGINT NOT NULL,
  `label_charges_minor` BIGINT NOT NULL,
  `adjustments_minor` BIGINT NOT NULL,
  `chargebacks_minor` BIGINT NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_reports_fact_marketplace_finance_daily_1` (`seller_id`, `day`),
  KEY `ix_reports_fact_marketplace_finance_daily_2` (`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- reports_fact_company_daily: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `reports_fact_company_daily` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `day` DATE NOT NULL,
  `source` VARCHAR(32) NOT NULL,
  `kind` VARCHAR(255) NOT NULL,
  `amount_minor` BIGINT NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_reports_fact_company_daily_1` (`day`, `source`, `kind`),
  CONSTRAINT `ck_reports_fact_company_daily_source` CHECK (`source` IN ('trading', 'platform_cost', 'discount_funding'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- reports_fact_seller_balances_daily: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `reports_fact_seller_balances_daily` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `day` DATE NOT NULL,
  `pending_minor` BIGINT NOT NULL,
  `available_minor` BIGINT NOT NULL,
  `held_minor` BIGINT NOT NULL,
  `owed_minor` BIGINT NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_reports_fact_seller_balances_daily_1` (`seller_id`, `day`),
  KEY `ix_reports_fact_seller_balances_daily_2` (`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- reports_fact_service_daily: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `reports_fact_service_daily` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `day` DATE NOT NULL,
  `dispatched` INT NOT NULL,
  `dispatched_on_time` INT NOT NULL,
  `overdue` INT NOT NULL,
  `valid_tracking` INT NOT NULL,
  `seller_cancellations` INT NOT NULL,
  `delivery_exceptions` INT NOT NULL,
  `messages_received` INT NOT NULL,
  `first_reply_minutes_p50` INT NULL,
  `cases_opened` INT NOT NULL,
  `cases_open_eod` INT NOT NULL,
  `complaints_by_category` JSON NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_reports_fact_service_daily_1` (`seller_id`, `day`),
  KEY `ix_reports_fact_service_daily_2` (`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- reports_fact_marketly_fulfillment_daily: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `reports_fact_marketly_fulfillment_daily` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `day` DATE NOT NULL,
  `dispatched` INT NOT NULL,
  `dispatched_on_time` INT NOT NULL,
  `overdue` INT NOT NULL,
  `delivery_exceptions` INT NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_reports_fact_marketly_fulfillment_daily_1` (`seller_id`, `day`),
  KEY `ix_reports_fact_marketly_fulfillment_daily_2` (`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- reports_fact_discovery_daily: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `reports_fact_discovery_daily` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `day` DATE NOT NULL,
  `views` INT NOT NULL,
  `cart_adds` INT NOT NULL,
  `purchases` INT NOT NULL,
  `stockout_minutes` INT NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_reports_fact_discovery_daily_1` (`product_id`, `day`),
  KEY `ix_reports_fact_discovery_daily_2` (`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- reports_fact_search_misses_daily: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `reports_fact_search_misses_daily` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `day` DATE NOT NULL,
  `query_norm` VARCHAR(255) NOT NULL,
  `count` INT NOT NULL,
  `had_unavailable_match` TINYINT(1) NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_reports_fact_search_misses_daily_1` (`day`, `query_norm`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reports_fact_customers` (
  `customer_key` VARCHAR(255) NOT NULL,
  `first_order_at` DATETIME(3) NOT NULL,
  `last_order_at` DATETIME(3) NOT NULL,
  `orders` INT NOT NULL,
  `net_spend_minor` BIGINT NOT NULL,
  PRIMARY KEY (`customer_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- reports_fact_campaigns_daily: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `reports_fact_campaigns_daily` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `campaign_kind` VARCHAR(32) NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `day` DATE NOT NULL,
  `sales_minor` BIGINT NOT NULL,
  `discount_cost_minor` BIGINT NOT NULL,
  `funded_by` JSON NOT NULL,
  `redemptions` INT NOT NULL,
  `displays` INT NOT NULL,
  `clicks` INT NOT NULL,
  `dismissals` INT NOT NULL,
  `spend_minor` BIGINT NOT NULL,
  `attributed_purchases` INT NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_reports_fact_campaigns_daily_1` (`campaign_kind`, `campaign_id`, `day`),
  KEY `ix_reports_fact_campaigns_daily_2` (`day`),
  CONSTRAINT `ck_reports_fact_campaigns_daily_campaign_kind` CHECK (`campaign_kind` IN ('promotion', 'ad'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reports_open_stockouts` (
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `since` DATETIME(3) NOT NULL,
  PRIMARY KEY (`stock_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reports_campaign_refs` (
  `kind` VARCHAR(32) NOT NULL,
  `ref_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`kind`, `ref_id`),
  CONSTRAINT `ck_reports_campaign_refs_kind` CHECK (`kind` IN ('redemption', 'charge'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reports_read_model_checkpoints` (
  `key` VARCHAR(255) NOT NULL,
  `last_event_id` TEXT NULL,
  `last_event_at` DATETIME(3) NULL,
  `state` TEXT NOT NULL,
  `rebuild_started_at` DATETIME(3) NULL,
  `rebuild_progress` INT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `reports_metric_owner_changes` ADD CONSTRAINT `fk_reports_metric_owner_changes_metric_key` FOREIGN KEY (`metric_key`) REFERENCES `reports_metric_definitions` (`key`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `reports_metric_versions` ADD CONSTRAINT `fk_reports_metric_versions_metric_key` FOREIGN KEY (`metric_key`) REFERENCES `reports_metric_definitions` (`key`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `reports_metric_suggestions` ADD CONSTRAINT `fk_reports_metric_suggestions_metric_key` FOREIGN KEY (`metric_key`) REFERENCES `reports_metric_definitions` (`key`) ON DELETE RESTRICT ON UPDATE RESTRICT;
