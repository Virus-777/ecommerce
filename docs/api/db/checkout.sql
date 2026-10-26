-- checkout: MySQL schema generated from docs/api/spec/modules/checkout.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

-- checkout_sessions: FULLTEXT ngram over email: terms shorter than the ngram size fall back to LIKE (§6.1)
-- checkout_sessions: FULLTEXT ngram over contact_name: terms shorter than the ngram size fall back to LIKE (§6.1)
CREATE TABLE `checkout_sessions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source` TEXT NOT NULL,
  `cart_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `guest_session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `account` JSON NOT NULL,
  `email` VARCHAR(255) NULL,
  `contact_name` VARCHAR(255) NULL,
  `visitor_key` TEXT NULL,
  `personalization_allowed` TINYINT(1) NOT NULL,
  `address` JSON NULL,
  `address_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `status` VARCHAR(255) NOT NULL,
  `quote_version` INT NOT NULL,
  `quote_total` INT NOT NULL,
  `currency` TEXT NOT NULL,
  `totals` JSON NOT NULL,
  `coupon_codes` JSON NOT NULL,
  `credit` JSON NULL,
  `payment_selection` JSON NULL,
  `payment_intent_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `payment_state` VARCHAR(32) NULL,
  `order_attempt` INT NULL,
  `gift_note` TEXT NULL,
  `promotion_evaluation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `redemption_reservation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `stock_reservation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `credit_hold_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `hold_until` DATETIME(3) NULL,
  `attempt_count` INT NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_ref` TEXT NULL,
  `channel` TEXT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_checkout_sessions_1` (`customer_id`, `status`),
  KEY `ix_checkout_sessions_2` (`guest_session_id`, `status`),
  KEY `ix_checkout_sessions_3` (`status`, `expires_at`),
  UNIQUE KEY `uq_checkout_sessions_4` (`order_id`),
  KEY `ix_checkout_sessions_5` (`payment_intent_id`),
  FULLTEXT KEY `ft_checkout_sessions_6` (`email`) WITH PARSER ngram,
  FULLTEXT KEY `ft_checkout_sessions_7` (`contact_name`) WITH PARSER ngram,
  CONSTRAINT `ck_checkout_sessions_payment_state` CHECK (`payment_state` IN ('accepted', 'pending_check', 'failed', 'requires_action'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `checkout_session_lines` (
  `id` VARCHAR(255) NOT NULL,
  `session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `cart_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_type` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `profile_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `fulfilled_by` VARCHAR(32) NOT NULL,
  `package_key` TEXT NOT NULL,
  `quantity` INT NOT NULL,
  `unit_price` INT NOT NULL,
  `terms_version` INT NOT NULL,
  `discounts` JSON NOT NULL,
  `tax` INT NOT NULL,
  `status` TEXT NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_checkout_session_lines_1` (`session_id`),
  CONSTRAINT `ck_checkout_session_lines_fulfilled_by` CHECK (`fulfilled_by` IN ('official_warehouse', 'seller', 'marketly_service'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- checkout_session_packages: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `checkout_session_packages` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `package_key` VARCHAR(255) NOT NULL,
  `owner_type` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `fulfilled_by` VARCHAR(32) NOT NULL,
  `ships_from` TEXT NOT NULL,
  `options` JSON NOT NULL,
  `selected_option_id` TEXT NULL,
  `selected_option` JSON NULL,
  `return_terms` TEXT NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_checkout_session_packages_1` (`session_id`, `package_key`),
  CONSTRAINT `ck_checkout_session_packages_fulfilled_by` CHECK (`fulfilled_by` IN ('official_warehouse', 'seller', 'marketly_service'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `checkout_change_sets` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status` TEXT NOT NULL,
  `changes` JSON NOT NULL,
  `previous_total` INT NOT NULL,
  `new_total` INT NOT NULL,
  `decisions` JSON NULL,
  `created_at` DATETIME(3) NOT NULL,
  `decided_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_checkout_change_sets_1` (`session_id`, `created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `checkout_place_requests` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `idempotency_key` VARCHAR(255) NOT NULL,
  `request_hash` TEXT NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `outcome` TEXT NULL,
  `response` JSON NULL,
  `payment_intent_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_at` DATETIME(3) NOT NULL,
  `completed_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_checkout_place_requests_1` (`session_id`, `idempotency_key`),
  KEY `ix_checkout_place_requests_2` (`created_at`),
  CONSTRAINT `ck_checkout_place_requests_kind` CHECK (`kind` IN ('place', 'retry', 'complete_action'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `checkout_session_log` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `label` TEXT NOT NULL,
  `detail` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_checkout_session_log_1` (`session_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `checkout_session_lines` ADD CONSTRAINT `fk_checkout_session_lines_session_id` FOREIGN KEY (`session_id`) REFERENCES `checkout_sessions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `checkout_session_packages` ADD CONSTRAINT `fk_checkout_session_packages_session_id` FOREIGN KEY (`session_id`) REFERENCES `checkout_sessions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `checkout_change_sets` ADD CONSTRAINT `fk_checkout_change_sets_session_id` FOREIGN KEY (`session_id`) REFERENCES `checkout_sessions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `checkout_place_requests` ADD CONSTRAINT `fk_checkout_place_requests_session_id` FOREIGN KEY (`session_id`) REFERENCES `checkout_sessions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `checkout_session_log` ADD CONSTRAINT `fk_checkout_session_log_session_id` FOREIGN KEY (`session_id`) REFERENCES `checkout_sessions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
