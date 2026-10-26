-- customers: MySQL schema generated from docs/api/spec/modules/customers.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

-- customers_customers: FULLTEXT ngram over first_name, last_name, email: terms shorter than the ngram size fall back to LIKE (§6.1)
CREATE TABLE `customers_customers` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `first_name` VARCHAR(255) NOT NULL,
  `last_name` VARCHAR(255) NOT NULL,
  `email` VARCHAR(255) NOT NULL,
  `email_verified_at` DATETIME(3) NULL,
  `phone` TEXT NULL,
  `phone_verified_at` DATETIME(3) NULL,
  `account_status` VARCHAR(255) NOT NULL,
  `default_address_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_count` INT NOT NULL,
  `total_spend_minor` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `closed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_customers_customers_user_id` (`user_id`),
  UNIQUE KEY `uq_customers_customers_ref` (`ref`),
  KEY `ix_customers_customers_1` (`account_status`, `id`),
  KEY `ix_customers_customers_2` (`email`),
  KEY `ix_customers_customers_3` (`created_at`, `id`),
  FULLTEXT KEY `ft_customers_customers_4` (`first_name`, `last_name`, `email`) WITH PARSER ngram
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- customers_addresses: partial unique on customer_id where `is_default` = 1 AND `deleted_at` IS NULL
CREATE TABLE `customers_addresses` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `label` TEXT NULL,
  `name` TEXT NOT NULL,
  `line1` TEXT NOT NULL,
  `line2` TEXT NULL,
  `city` TEXT NOT NULL,
  `region` TEXT NOT NULL,
  `postal_code` TEXT NOT NULL,
  `country` TEXT NOT NULL,
  `phone` TEXT NULL,
  `delivery_instructions` TEXT NULL,
  `is_default` TINYINT(1) NOT NULL,
  `validated_at` DATETIME(3) NULL,
  `lat` DECIMAL(9,6) NULL,
  `lng` DECIMAL(9,6) NULL,
  `geocoded_at` DATETIME(3) NULL,
  `geocode_precision` VARCHAR(32) NULL,
  `last_used_at` DATETIME(3) NULL,
  `deleted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_customers_addresses_1` (`customer_id`),
  UNIQUE KEY `uq_customers_addresses_2` ((IF(`is_default` = 1 AND `deleted_at` IS NULL, `customer_id`, NULL))),
  KEY `ix_customers_addresses_3` (`geocoded_at`),
  CONSTRAINT `ck_customers_addresses_geocode_precision` CHECK (`geocode_precision` IN ('zip', 'city'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `customers_marketing_preferences` (
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `email_promotions` TINYINT(1) NOT NULL,
  `sms_promotions` TINYINT(1) NOT NULL,
  `push_promotions` TINYINT(1) NOT NULL,
  `wishlist_alerts` TINYINT(1) NOT NULL,
  `personalized_recommendations` TINYINT(1) NOT NULL,
  `recent_searches` TINYINT(1) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`customer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `customers_consent_log` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `channel` TEXT NOT NULL,
  `granted` TINYINT(1) NOT NULL,
  `source` TEXT NOT NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `ip` VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_customers_consent_log_1` (`customer_id`, `at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `customers_recently_viewed` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_kind` VARCHAR(32) NOT NULL,
  `owner_id` VARCHAR(255) NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `title` TEXT NOT NULL,
  `image_media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `viewed_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_customers_recently_viewed_1` (`owner_kind`, `owner_id`, `product_id`),
  KEY `ix_customers_recently_viewed_2` (`owner_kind`, `owner_id`, `viewed_at` DESC),
  KEY `ix_customers_recently_viewed_3` (`viewed_at`),
  CONSTRAINT `ck_customers_recently_viewed_owner_kind` CHECK (`owner_kind` IN ('customer', 'guest'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `customers_account_restrictions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `scope` TEXT NOT NULL,
  `reason_code` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `still_works` JSON NOT NULL,
  `appeal_route` TEXT NOT NULL,
  `appeal_deadline` DATETIME(3) NULL,
  `starts_at` DATETIME(3) NOT NULL,
  `ends_at` DATETIME(3) NULL,
  `state` VARCHAR(255) NOT NULL,
  `set_by_kind` TEXT NOT NULL,
  `set_by_id` TEXT NULL,
  `trust_report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `trust_enforcement_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `lifted_at` DATETIME(3) NULL,
  `lift_reason` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_customers_account_restrictions_1` (`customer_id`, `state`),
  KEY `ix_customers_account_restrictions_2` (`state`, `ends_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `customers_account_actions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `action` TEXT NOT NULL,
  `reason_code` TEXT NOT NULL,
  `details` TEXT NOT NULL,
  `from_status` TEXT NULL,
  `to_status` TEXT NULL,
  `restriction_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_customers_account_actions_1` (`customer_id`, `at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `customers_guest_buyers` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `email_normalized` VARCHAR(255) NOT NULL,
  `email` TEXT NOT NULL,
  `name` TEXT NOT NULL,
  `order_count` INT NOT NULL,
  `total_spend` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `first_order_at` DATETIME(3) NOT NULL,
  `last_order_at` DATETIME(3) NOT NULL,
  `last_order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `last_order_ref` TEXT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_customers_guest_buyers_email_normalized` (`email_normalized`),
  KEY `ix_customers_guest_buyers_1` (`last_order_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `customers_customer_notes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `body` TEXT NOT NULL,
  `author_id` TEXT NOT NULL,
  `author_name` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_customers_customer_notes_1` (`customer_id`, `created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `customers_data_requests` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `requested_at` DATETIME(3) NOT NULL,
  `due_by` DATETIME(3) NOT NULL,
  `file_media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `ready_at` DATETIME(3) NULL,
  `expires_at` DATETIME(3) NULL,
  `scheduled_for` DATETIME(3) NULL,
  `completed_at` DATETIME(3) NULL,
  `cancelled_at` DATETIME(3) NULL,
  `failure` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_customers_data_requests_1` (`state`, `due_by`),
  KEY `ix_customers_data_requests_2` (`customer_id`, `requested_at` DESC),
  CONSTRAINT `ck_customers_data_requests_kind` CHECK (`kind` IN ('export', 'closure'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `customers_guest_lookup_attempts` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `email_hash` VARCHAR(255) NOT NULL,
  `ip` VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `guest_session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `succeeded` TINYINT(1) NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_customers_guest_lookup_attempts_1` (`email_hash`, `at` DESC),
  KEY `ix_customers_guest_lookup_attempts_2` (`ip`, `at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `customers_customers` ADD CONSTRAINT `fk_customers_customers_default_address_id` FOREIGN KEY (`default_address_id`) REFERENCES `customers_addresses` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `customers_addresses` ADD CONSTRAINT `fk_customers_addresses_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `customers_customers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `customers_marketing_preferences` ADD CONSTRAINT `fk_customers_marketing_preferences_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `customers_customers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `customers_consent_log` ADD CONSTRAINT `fk_customers_consent_log_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `customers_customers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `customers_account_restrictions` ADD CONSTRAINT `fk_customers_account_restrictions_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `customers_customers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `customers_account_actions` ADD CONSTRAINT `fk_customers_account_actions_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `customers_customers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `customers_customer_notes` ADD CONSTRAINT `fk_customers_customer_notes_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `customers_customers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `customers_data_requests` ADD CONSTRAINT `fk_customers_data_requests_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `customers_customers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
