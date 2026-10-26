-- fulfillment-service: MySQL schema generated from docs/api/spec/modules/fulfillment-service.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `fulfillment_service_enrollments` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `state` TEXT NOT NULL,
  `terms_version` TEXT NOT NULL,
  `fee_schedule_version` TEXT NOT NULL,
  `accepted_at` DATETIME(3) NULL,
  `accepted_by` TEXT NULL,
  `max_cubic_feet` DECIMAL(12,3) NOT NULL,
  `max_skus` INT NOT NULL,
  `expected_skus` INT NOT NULL,
  `expected_monthly_units` INT NOT NULL,
  `categories` JSON NOT NULL,
  `contact_note` TEXT NULL,
  `reason` TEXT NULL,
  `seller_suspension_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `reviewer_id` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `decided_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fulfillment_service_enrollments_seller_id` (`seller_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `fulfillment_service_sku_enrollments` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `sku` TEXT NOT NULL,
  `dimensions` JSON NOT NULL,
  `weight_grams` INT NOT NULL,
  `size_tier` TEXT NOT NULL,
  `barcode` TEXT NULL,
  `label_required` TINYINT(1) NOT NULL,
  `restricted` TINYINT(1) NOT NULL,
  `restriction_reason` TEXT NULL,
  `hazmat` TINYINT(1) NOT NULL,
  `notes` TEXT NULL,
  `state` VARCHAR(255) NOT NULL,
  `inventory_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fulfillment_service_sku_enrollments_offer_id` (`offer_id`),
  KEY `ix_fulfillment_service_sku_enrollments_1` (`seller_id`, `state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `fulfillment_service_inbound_shipments` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `ship_from` JSON NOT NULL,
  `destination` JSON NOT NULL,
  `boxes` INT NOT NULL,
  `carrier` TEXT NULL,
  `tracking` TEXT NULL,
  `expected_arrival` DATE NULL,
  `arrived_at` DATETIME(3) NULL,
  `received_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fulfillment_service_inbound_shipments_ref` (`ref`),
  KEY `ix_fulfillment_service_inbound_shipments_1` (`seller_id`, `state`),
  KEY `ix_fulfillment_service_inbound_shipments_2` (`state`, `expected_arrival`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- fulfillment_service_inbound_lines: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `fulfillment_service_inbound_lines` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `inbound_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `sku_enrollment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `expected` INT NOT NULL,
  `received` INT NOT NULL,
  `damaged` INT NOT NULL,
  PRIMARY KEY (`row_id`),
  KEY `ix_fulfillment_service_inbound_lines_1` (`inbound_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `fulfillment_service_inbound_receipts` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `inbound_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seq` INT NOT NULL,
  `inventory_receipt_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `lines` JSON NOT NULL,
  `state` VARCHAR(32) NOT NULL,
  `counted_by` TEXT NOT NULL,
  `counted_at` DATETIME(3) NOT NULL,
  `confirmed_by` TEXT NULL,
  `confirmed_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fulfillment_service_inbound_receipts_1` (`inbound_id`, `seq`),
  KEY `ix_fulfillment_service_inbound_receipts_2` (`inventory_receipt_id`),
  CONSTRAINT `ck_fulfillment_service_inbound_receipts_state` CHECK (`state` IN ('submitted', 'confirmed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `fulfillment_service_discrepancies` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `inbound_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `summary` TEXT NOT NULL,
  `evidence_media_ids` JSON NOT NULL,
  `seller_response` TEXT NOT NULL,
  `claim_note` TEXT NULL,
  `decision` TEXT NULL,
  `decided_by` TEXT NULL,
  `decided_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_fulfillment_service_discrepancies_1` (`inbound_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `fulfillment_service_ownership_ledger` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `sku_enrollment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `movement` TEXT NOT NULL,
  `quantity` INT NOT NULL,
  `from_group` TEXT NULL,
  `to_group` TEXT NULL,
  `reference` TEXT NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `reason` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_fulfillment_service_ownership_ledger_1` (`seller_id`, `at`),
  KEY `ix_fulfillment_service_ownership_ledger_2` (`sku_enrollment_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `fulfillment_service_fulfillment_requests` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_ref` TEXT NOT NULL,
  `seller_group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `items` JSON NOT NULL,
  `warehouse_task_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `shipment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `dispatch_by` DATETIME(3) NOT NULL,
  `short_reported_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fulfillment_service_fulfillment_requests_seller_group_id` (`seller_group_id`),
  KEY `ix_fulfillment_service_fulfillment_requests_1` (`seller_id`, `state`),
  KEY `ix_fulfillment_service_fulfillment_requests_2` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `fulfillment_service_service_returns` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `return_ref` TEXT NOT NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `sku_enrollment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `quantity` INT NOT NULL,
  `outcome` VARCHAR(255) NOT NULL,
  `proposed_outcome` TEXT NULL,
  `inspection_note` TEXT NULL,
  `evidence_media_ids` JSON NOT NULL,
  `inspected_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fulfillment_service_service_returns_1` (`return_id`, `order_item_id`),
  KEY `ix_fulfillment_service_service_returns_2` (`seller_id`, `outcome`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `fulfillment_service_removal_orders` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `lines` JSON NOT NULL,
  `ship_to` JSON NULL,
  `tracking` TEXT NULL,
  `reason` TEXT NULL,
  `fee_amount` BIGINT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `approved_at` DATETIME(3) NULL,
  `completed_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fulfillment_service_removal_orders_ref` (`ref`),
  KEY `ix_fulfillment_service_removal_orders_1` (`seller_id`, `state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `fulfillment_service_stock_differences` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `sku_enrollment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `day` DATE NOT NULL,
  `ledger` JSON NOT NULL,
  `inventory` JSON NOT NULL,
  `state` VARCHAR(32) NOT NULL,
  `decision` TEXT NULL,
  `reason` TEXT NULL,
  `amount` BIGINT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `decided_by` TEXT NULL,
  `decided_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fulfillment_service_stock_differences_1` (`sku_enrollment_id`, `day`),
  KEY `ix_fulfillment_service_stock_differences_2` (`state`, `day`),
  KEY `ix_fulfillment_service_stock_differences_3` (`seller_id`, `state`),
  CONSTRAINT `ck_fulfillment_service_stock_differences_state` CHECK (`state` IN ('open', 'resolved'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `fulfillment_service_fee_schedules` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `version` VARCHAR(255) NOT NULL,
  `effective_at` DATETIME(3) NOT NULL,
  `rates` JSON NOT NULL,
  `state` TEXT NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fulfillment_service_fee_schedules_version` (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `fulfillment_service_fee_charges` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `type` VARCHAR(255) NOT NULL,
  `period` VARCHAR(255) NULL,
  `reference` VARCHAR(255) NULL,
  `units` DECIMAL(14,3) NOT NULL,
  `rate` BIGINT NOT NULL,
  `amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `posted_at` DATETIME(3) NULL,
  `ledger_entry_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `reason` TEXT NULL,
  `idempotency_key` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fulfillment_service_fee_charges_idempotency_key` (`idempotency_key`),
  KEY `ix_fulfillment_service_fee_charges_1` (`seller_id`, `state`),
  KEY `ix_fulfillment_service_fee_charges_2` (`type`, `period`),
  KEY `ix_fulfillment_service_fee_charges_3` (`seller_id`, `period`),
  KEY `ix_fulfillment_service_fee_charges_4` (`reference`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- fulfillment_service_storage_snapshots: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `fulfillment_service_storage_snapshots` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `day` DATE NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `sku_enrollment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `units` INT NOT NULL,
  `cubic_feet` DECIMAL(12,3) NOT NULL,
  `aged_units` JSON NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_fulfillment_service_storage_snapshots_1` (`day`, `sku_enrollment_id`),
  KEY `ix_fulfillment_service_storage_snapshots_2` (`seller_id`, `day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `fulfillment_service_inbound_lines` ADD CONSTRAINT `fk_fulfillment_service_inbound_lines_inbound_id` FOREIGN KEY (`inbound_id`) REFERENCES `fulfillment_service_inbound_shipments` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `fulfillment_service_inbound_lines` ADD CONSTRAINT `fk_fulfillment_service_inbound_lines_sku_enrollment_id` FOREIGN KEY (`sku_enrollment_id`) REFERENCES `fulfillment_service_sku_enrollments` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `fulfillment_service_inbound_receipts` ADD CONSTRAINT `fk_fulfillment_service_inbound_receipts_inbound_id` FOREIGN KEY (`inbound_id`) REFERENCES `fulfillment_service_inbound_shipments` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `fulfillment_service_discrepancies` ADD CONSTRAINT `fk_fulfillment_service_discrepancies_inbound_id` FOREIGN KEY (`inbound_id`) REFERENCES `fulfillment_service_inbound_shipments` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `fulfillment_service_ownership_ledger` ADD CONSTRAINT `fk_fulfillment_service_ownership_ledger_sku_enrollment_id` FOREIGN KEY (`sku_enrollment_id`) REFERENCES `fulfillment_service_sku_enrollments` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `fulfillment_service_stock_differences` ADD CONSTRAINT `fk_fulfillment_service_stock_differences_sku_enrollment_id` FOREIGN KEY (`sku_enrollment_id`) REFERENCES `fulfillment_service_sku_enrollments` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
