-- shipping: MySQL schema generated from docs/api/spec/modules/shipping.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `shipping_carriers` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `code` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `account_label` TEXT NULL,
  `status` TEXT NOT NULL,
  `tracking_mode` TEXT NOT NULL,
  `credentials_ref` TEXT NULL,
  `contacts` JSON NOT NULL,
  `last_event_at` DATETIME(3) NULL,
  `on_time_rate_30d` DECIMAL(5,2) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shipping_carriers_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_carrier_services` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `carrier_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `code` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `transit_min` INT NOT NULL,
  `transit_max` INT NOT NULL,
  `enabled` TINYINT(1) NOT NULL,
  `label_supported` TINYINT(1) NOT NULL,
  `tracking_pattern` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shipping_carrier_services_1` (`carrier_id`, `code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_methods` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `code` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `customer_label` TEXT NOT NULL,
  `transit_min` INT NOT NULL,
  `transit_max` INT NOT NULL,
  `carrier_service_ids` JSON NOT NULL,
  `active` TINYINT(1) NOT NULL,
  `position` INT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shipping_methods_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_zones` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` TEXT NOT NULL,
  `kind` TEXT NOT NULL,
  `regions` JSON NOT NULL,
  `postal_prefixes` JSON NOT NULL,
  `address_kinds` JSON NOT NULL,
  `transit_by_method` JSON NOT NULL,
  `status` TEXT NOT NULL,
  `customer_message` TEXT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_profiles` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `lineage_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_type` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `name` TEXT NOT NULL,
  `is_default` TINYINT(1) NOT NULL,
  `methods` JSON NOT NULL,
  `free_threshold` INT NULL,
  `free_method_code` TEXT NULL,
  `currency` TEXT NOT NULL,
  `version` INT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `effective_from` DATETIME(3) NOT NULL,
  `updated_by` JSON NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_shipping_profiles_1` (`lineage_id`, `status`),
  KEY `ix_shipping_profiles_2` (`seller_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_seller_settings` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_type` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `coverage` JSON NOT NULL,
  `handling_days` INT NOT NULL,
  `same_day_cutoff` TEXT NOT NULL,
  `business_days` JSON NOT NULL,
  `buy_labels` TINYINT(1) NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `effective_from` DATETIME(3) NOT NULL,
  `updated_by` JSON NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `default_parcel` JSON NULL,
  `ships_from` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_shipping_seller_settings_1` (`seller_id`, `status`),
  CONSTRAINT `ck_shipping_seller_settings_status` CHECK (`status` IN ('scheduled', 'active', 'superseded'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_closures` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_type` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `name` TEXT NOT NULL,
  `from_date` DATE NOT NULL,
  `to_date` DATE NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_shipping_closures_1` (`seller_id`, `from_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_dispatch_targets` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `official` JSON NOT NULL,
  `seller_default` JSON NOT NULL,
  `effective_from` DATETIME(3) NOT NULL,
  `set_by` JSON NOT NULL,
  `reason` TEXT NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_notices` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `title` TEXT NOT NULL,
  `kind` TEXT NOT NULL,
  `from_date` DATE NOT NULL,
  `to_date` DATE NOT NULL,
  `carrier_codes` JSON NOT NULL,
  `carrier_service_ids` JSON NOT NULL,
  `regions` JSON NOT NULL,
  `postal_prefixes` JSON NOT NULL,
  `zone_ids` JSON NOT NULL,
  `seller_scope` TEXT NOT NULL,
  `effect` JSON NOT NULL,
  `customer_message` TEXT NOT NULL,
  `show_from` DATETIME(3) NULL,
  `surfaces` JSON NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `created_by` JSON NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_shipping_notices_1` (`status`, `from_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_free_shipping_rules` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` TEXT NOT NULL,
  `scope` TEXT NOT NULL,
  `min_order_value` INT NULL,
  `method_code` TEXT NOT NULL,
  `funded_by` TEXT NOT NULL,
  `starts_on` DATE NULL,
  `ends_on` DATE NULL,
  `status` TEXT NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_shipments` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_ref` TEXT NOT NULL,
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `owner_type` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `fulfilled_by` VARCHAR(32) NOT NULL,
  `package_no` INT NOT NULL,
  `carrier_code` VARCHAR(255) NULL,
  `service_name` TEXT NULL,
  `tracking_number` VARCHAR(255) NULL,
  `tracking_state` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `ship_from` TEXT NOT NULL,
  `to_address` JSON NOT NULL,
  `shipped_at` DATETIME(3) NULL,
  `dispatch_due_at` DATETIME(3) NULL,
  `dispatched_on_time` TINYINT(1) NULL,
  `estimated_arrival` JSON NULL,
  `delivered_at` DATETIME(3) NULL,
  `failed_delivery` JSON NULL,
  `recorded_by` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_shipping_shipments_1` (`order_id`),
  KEY `ix_shipping_shipments_2` (`group_id`),
  KEY `ix_shipping_shipments_3` (`return_id`),
  KEY `ix_shipping_shipments_4` (`carrier_code`, `tracking_number`),
  KEY `ix_shipping_shipments_5` (`seller_id`, `status`),
  KEY `ix_shipping_shipments_6` (`status`, `shipped_at`),
  KEY `ix_shipping_shipments_7` (`status`, `id`),
  CONSTRAINT `ck_shipping_shipments_fulfilled_by` CHECK (`fulfilled_by` IN ('official_warehouse', 'seller', 'marketly_service'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- shipping_shipment_lines: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `shipping_shipment_lines` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `shipment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `title` TEXT NOT NULL,
  `variant_label` TEXT NOT NULL,
  `quantity` INT NOT NULL,
  PRIMARY KEY (`row_id`),
  KEY `ix_shipping_shipment_lines_1` (`shipment_id`),
  KEY `ix_shipping_shipment_lines_2` (`order_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_tracking_events` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `shipment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `code` TEXT NOT NULL,
  `label` TEXT NOT NULL,
  `detail` TEXT NULL,
  `location` TEXT NULL,
  `source` TEXT NOT NULL,
  `carrier_event_id` VARCHAR(255) NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_shipping_tracking_events_1` (`shipment_id`, `at`),
  UNIQUE KEY `uq_shipping_tracking_events_2` (`shipment_id`, `carrier_event_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_tracking_corrections` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `shipment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `from_value` TEXT NOT NULL,
  `to_value` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `by` JSON NOT NULL,
  `customer_notified` TINYINT(1) NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_shipping_tracking_corrections_1` (`shipment_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_labels` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `shipment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `carrier_service_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `cost` INT NOT NULL,
  `currency` TEXT NOT NULL,
  `billed_to` VARCHAR(32) NOT NULL,
  `tracking_number` TEXT NOT NULL,
  `storage_key` TEXT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `qr_code` TEXT NULL,
  `format` TEXT NOT NULL,
  `drop_off_by` DATETIME(3) NULL,
  `status` TEXT NOT NULL,
  `idempotency_key` VARCHAR(255) NOT NULL,
  `purchased_by` JSON NOT NULL,
  `purchased_at` DATETIME(3) NOT NULL,
  `voided_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shipping_labels_idempotency_key` (`idempotency_key`),
  KEY `ix_shipping_labels_1` (`shipment_id`),
  CONSTRAINT `ck_shipping_labels_billed_to` CHECK (`billed_to` IN ('seller', 'company', 'platform', 'customer')),
  CONSTRAINT `ck_shipping_labels_kind` CHECK (`kind` IN ('outbound', 'replacement', 'return'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_label_quotes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `carrier_service_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `cost` INT NOT NULL,
  `parcel` JSON NOT NULL,
  `estimated_arrival` JSON NOT NULL,
  `keeps_promise` TINYINT(1) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- shipping_dispatch_watch: partial index: due_at plus overdue_since from "where `overdue_since` IS NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `shipping_dispatch_watch` (
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_type` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `fulfilled_by` VARCHAR(32) NOT NULL,
  `due_at` DATETIME(3) NOT NULL,
  `open_item_ids` JSON NOT NULL,
  `overdue_since` DATETIME(3) NULL,
  PRIMARY KEY (`group_id`),
  KEY `ix_shipping_dispatch_watch_1` (`due_at`, `overdue_since`),
  CONSTRAINT `ck_shipping_dispatch_watch_fulfilled_by` CHECK (`fulfilled_by` IN ('official_warehouse', 'seller', 'marketly_service'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- shipping_exceptions: partial unique on group_id, kind, shipment_id where `status` IN ('open', 'in_progress', 'escalated')
CREATE TABLE `shipping_exceptions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(255) NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_ref` TEXT NOT NULL,
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `shipment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `owner_type` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `fulfilled_by` VARCHAR(32) NOT NULL,
  `items_summary` TEXT NOT NULL,
  `order_item_ids` JSON NOT NULL,
  `item_quantities` JSON NULL,
  `situation` TEXT NOT NULL,
  `next_step` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `owner_name` TEXT NULL,
  `owner_role` TEXT NULL,
  `due_at` DATETIME(3) NOT NULL,
  `customer_notified_at` DATETIME(3) NULL,
  `seller_notified_at` DATETIME(3) NULL,
  `escalated_to` TEXT NULL,
  `seller_response` JSON NULL,
  `resolution` JSON NULL,
  `claim_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `case_ref` TEXT NULL,
  `opened_by` JSON NOT NULL,
  `opened_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_shipping_exceptions_1` (`kind`, `status`, `due_at`),
  KEY `ix_shipping_exceptions_2` (`seller_id`, `status`),
  KEY `ix_shipping_exceptions_3` (`group_id`),
  KEY `ix_shipping_exceptions_4` (`order_id`),
  KEY `ix_shipping_exceptions_5` (`shipment_id`),
  UNIQUE KEY `uq_shipping_exceptions_6` ((IF(`status` IN ('open', 'in_progress', 'escalated'), (COALESCE(`group_id`, '')), NULL)), (COALESCE(`kind`, '')), (COALESCE(`shipment_id`, ''))),
  CONSTRAINT `ck_shipping_exceptions_fulfilled_by` CHECK (`fulfilled_by` IN ('official_warehouse', 'seller', 'marketly_service'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_exception_log` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `exception_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `action` TEXT NOT NULL,
  `detail` TEXT NULL,
  `actor` JSON NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_shipping_exception_log_1` (`exception_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_claims` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `claim_number` TEXT NULL,
  `carrier_code` TEXT NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `shipment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `exception_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `amount` INT NOT NULL,
  `currency` TEXT NOT NULL,
  `filed_by` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `filed_at` DATE NULL,
  `status` VARCHAR(255) NOT NULL,
  `owner` TEXT NOT NULL,
  `evidence_ids` JSON NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `paid_amount` INT NULL,
  `decided_at` DATETIME(3) NULL,
  `note` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_shipping_claims_1` (`status`),
  KEY `ix_shipping_claims_2` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `shipping_webhook_events` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `carrier_code` VARCHAR(255) NOT NULL,
  `external_id` VARCHAR(255) NOT NULL,
  `payload` JSON NOT NULL,
  `received_at` DATETIME(3) NOT NULL,
  `processed_at` DATETIME(3) NULL,
  `error` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shipping_webhook_events_1` (`carrier_code`, `external_id`),
  KEY `ix_shipping_webhook_events_2` (`processed_at`, `received_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `shipping_carrier_services` ADD CONSTRAINT `fk_shipping_carrier_services_carrier_id` FOREIGN KEY (`carrier_id`) REFERENCES `shipping_carriers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `shipping_shipment_lines` ADD CONSTRAINT `fk_shipping_shipment_lines_shipment_id` FOREIGN KEY (`shipment_id`) REFERENCES `shipping_shipments` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `shipping_tracking_events` ADD CONSTRAINT `fk_shipping_tracking_events_shipment_id` FOREIGN KEY (`shipment_id`) REFERENCES `shipping_shipments` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `shipping_tracking_corrections` ADD CONSTRAINT `fk_shipping_tracking_corrections_shipment_id` FOREIGN KEY (`shipment_id`) REFERENCES `shipping_shipments` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `shipping_labels` ADD CONSTRAINT `fk_shipping_labels_shipment_id` FOREIGN KEY (`shipment_id`) REFERENCES `shipping_shipments` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `shipping_labels` ADD CONSTRAINT `fk_shipping_labels_carrier_service_id` FOREIGN KEY (`carrier_service_id`) REFERENCES `shipping_carrier_services` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `shipping_exception_log` ADD CONSTRAINT `fk_shipping_exception_log_exception_id` FOREIGN KEY (`exception_id`) REFERENCES `shipping_exceptions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `shipping_claims` ADD CONSTRAINT `fk_shipping_claims_shipment_id` FOREIGN KEY (`shipment_id`) REFERENCES `shipping_shipments` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `shipping_claims` ADD CONSTRAINT `fk_shipping_claims_exception_id` FOREIGN KEY (`exception_id`) REFERENCES `shipping_exceptions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
