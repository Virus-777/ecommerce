-- inventory: MySQL schema generated from docs/api/spec/modules/inventory.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `inventory_locations` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `code` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `kind` TEXT NOT NULL,
  `owner_type` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `address` JSON NULL,
  `time_zone` TEXT NOT NULL,
  `sellable` TINYINT(1) NOT NULL,
  `active` TINYINT(1) NOT NULL,
  `is_default` TINYINT(1) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_locations_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- inventory_stock_items: partial index: service_location_id from "where `service_location_id` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `inventory_stock_items` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_type` VARCHAR(32) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `sku` VARCHAR(255) NOT NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `condition` TEXT NOT NULL,
  `label` TEXT NOT NULL,
  `low_stock_threshold` INT NULL,
  `reorder_quantity` INT NULL,
  `unit_cost_amount` BIGINT NULL,
  `currency` CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `primary_bin_code` TEXT NULL,
  `low_since` DATETIME(3) NULL,
  `service_location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `archived` TINYINT(1) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_stock_items_1` (`owner_type`, (COALESCE(`seller_id`, '00000000-0000-0000-0000-000000000000')), `sku`),
  KEY `ix_inventory_stock_items_2` (`seller_id`, `archived`),
  KEY `ix_inventory_stock_items_3` (`offer_id`),
  KEY `ix_inventory_stock_items_4` (`variant_id`),
  KEY `ix_inventory_stock_items_5` (`service_location_id`),
  CONSTRAINT `ck_inventory_stock_items_owner_type` CHECK (`owner_type` IN ('official', 'seller'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `inventory_stock_levels` (
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `available` INT NOT NULL,
  `reserved` INT NOT NULL,
  `incoming` INT NOT NULL,
  `damaged_held` INT NOT NULL,
  `returned` INT NOT NULL,
  `version` INT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`stock_item_id`, `location_id`),
  KEY `ix_inventory_stock_levels_2` (`location_id`),
  CONSTRAINT `ck_inventory_stock_levels_available_range` CHECK (`available` >= 0),
  CONSTRAINT `ck_inventory_stock_levels_reserved_range` CHECK (`reserved` >= 0),
  CONSTRAINT `ck_inventory_stock_levels_incoming_range` CHECK (`incoming` >= 0),
  CONSTRAINT `ck_inventory_stock_levels_damaged_held_range` CHECK (`damaged_held` >= 0),
  CONSTRAINT `ck_inventory_stock_levels_returned_range` CHECK (`returned` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `inventory_stock_movements` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `from_group` TEXT NOT NULL,
  `to_group` TEXT NOT NULL,
  `quantity` INT NOT NULL,
  `reason_code` VARCHAR(255) NOT NULL,
  `note` TEXT NULL,
  `ref_kind` VARCHAR(255) NULL,
  `ref_id` VARCHAR(255) NULL,
  `ref_label` TEXT NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `actor_name` TEXT NULL,
  `approved_by` TEXT NULL,
  `after` JSON NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_inventory_stock_movements_1` (`stock_item_id`, `at`),
  KEY `ix_inventory_stock_movements_2` (`ref_kind`, `ref_id`),
  KEY `ix_inventory_stock_movements_3` (`reason_code`, `at`),
  CONSTRAINT `ck_inventory_stock_movements_quantity_range` CHECK (`quantity` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `inventory_incoming_expectations` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source_kind` VARCHAR(32) NOT NULL,
  `source_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source_ref` TEXT NOT NULL,
  `quantity_open` INT NOT NULL,
  `expected_date` DATE NULL,
  PRIMARY KEY (`id`),
  KEY `ix_inventory_incoming_expectations_1` (`stock_item_id`, `expected_date`),
  KEY `ix_inventory_incoming_expectations_2` (`source_kind`, `source_id`),
  CONSTRAINT `ck_inventory_incoming_expectations_source_kind` CHECK (`source_kind` IN ('purchase_order', 'transfer', 'service_inbound'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `inventory_reservations` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source` VARCHAR(32) NOT NULL,
  `key` VARCHAR(255) NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_ref` TEXT NULL,
  `state` VARCHAR(255) NOT NULL,
  `expires_at` DATETIME(3) NULL,
  `released_reason` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_reservations_1` (`source`, `key`),
  KEY `ix_inventory_reservations_2` (`state`, `expires_at`),
  KEY `ix_inventory_reservations_3` (`order_id`),
  CONSTRAINT `ck_inventory_reservations_source` CHECK (`source` IN ('checkout', 'replacement', 'exchange'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `inventory_reservation_lines` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reservation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `quantity` INT NOT NULL,
  `fulfilled_qty` INT NOT NULL,
  `released_qty` INT NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_inventory_reservation_lines_1` (`reservation_id`),
  KEY `ix_inventory_reservation_lines_2` (`stock_item_id`, `state`),
  KEY `ix_inventory_reservation_lines_3` (`order_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `inventory_adjustments` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `from_group` TEXT NOT NULL,
  `to_group` TEXT NOT NULL,
  `quantity` INT NOT NULL,
  `reason_code` TEXT NOT NULL,
  `note` TEXT NULL,
  `review_date` DATE NULL,
  `state` VARCHAR(255) NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `requested_by` TEXT NOT NULL,
  `decided_by` TEXT NULL,
  `movement_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_at` DATETIME(3) NOT NULL,
  `applied_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_inventory_adjustments_1` (`state`, `created_at`),
  KEY `ix_inventory_adjustments_2` (`stock_item_id`),
  KEY `ix_inventory_adjustments_3` (`approval_request_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- inventory_held_stock: partial index: review_date plus released_at from "where `released_at` IS NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `inventory_held_stock` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `quantity` INT NOT NULL,
  `reason_code` TEXT NOT NULL,
  `reason` TEXT NULL,
  `review_date` DATE NOT NULL,
  `source_ref` TEXT NULL,
  `released_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_inventory_held_stock_1` (`review_date`, `released_at`),
  KEY `ix_inventory_held_stock_2` (`stock_item_id`, `location_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `inventory_inbound_receipts` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `receipt_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `receipt_ref` TEXT NOT NULL,
  `source_kind` VARCHAR(32) NOT NULL,
  `source_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `source_ref` TEXT NULL,
  `owner_type` VARCHAR(32) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `purchase_order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `purchase_order_ref` TEXT NULL,
  `supplier_name` TEXT NOT NULL,
  `location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `received_by` TEXT NOT NULL,
  `received_at` DATETIME(3) NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `confirmed_by` TEXT NULL,
  `confirmed_at` DATETIME(3) NULL,
  `note` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_inbound_receipts_receipt_id` (`receipt_id`),
  KEY `ix_inventory_inbound_receipts_1` (`state`, `received_at`),
  KEY `ix_inventory_inbound_receipts_2` (`source_kind`, `source_id`),
  CONSTRAINT `ck_inventory_inbound_receipts_source_kind` CHECK (`source_kind` IN ('purchase_order', 'service_inbound')),
  CONSTRAINT `ck_inventory_inbound_receipts_owner_type` CHECK (`owner_type` IN ('official', 'seller'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `inventory_inbound_lines` (
  `inbound_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `expected` INT NOT NULL,
  `received` INT NOT NULL,
  `damaged` INT NOT NULL,
  `bin_code` TEXT NULL,
  `unit_cost_amount` BIGINT NULL,
  `sellable` INT NULL,
  `reason` TEXT NULL,
  PRIMARY KEY (`inbound_id`, `stock_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `inventory_return_outcomes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `return_ref` TEXT NOT NULL,
  `order_ref` TEXT NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `quantity` INT NOT NULL,
  `inspected_condition` TEXT NOT NULL,
  `proposed_outcome` TEXT NOT NULL,
  `proposed_target_sku` TEXT NULL,
  `state` VARCHAR(255) NOT NULL,
  `recorded_outcome` TEXT NULL,
  `target_stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `recorded_by` TEXT NULL,
  `recorded_at` DATETIME(3) NULL,
  `inspected_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_return_outcomes_1` (`return_id`, `stock_item_id`),
  KEY `ix_inventory_return_outcomes_2` (`state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `inventory_discrepancies` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `bin_code` TEXT NULL,
  `quantity` INT NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_ref` TEXT NULL,
  `note` TEXT NULL,
  `photo_media_ids` JSON NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `resolution` TEXT NULL,
  `resolution_note` TEXT NULL,
  `reported_by` TEXT NOT NULL,
  `reported_at` DATETIME(3) NOT NULL,
  `resolved_by` TEXT NULL,
  `resolved_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_inventory_discrepancies_1` (`state`, `reported_at`),
  KEY `ix_inventory_discrepancies_2` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `inventory_transfers` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `from_location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `to_location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `state` TEXT NOT NULL,
  `created_by` TEXT NOT NULL,
  `note` TEXT NULL,
  `shipped_at` DATETIME(3) NULL,
  `received_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_transfers_ref` (`ref`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `inventory_transfer_lines` (
  `transfer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `quantity` INT NOT NULL,
  `received_quantity` INT NULL,
  PRIMARY KEY (`transfer_id`, `stock_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `inventory_valuation_snapshots` (
  `snapshot_date` DATE NOT NULL,
  `stock_group` VARCHAR(32) NOT NULL,
  `units` INT NOT NULL,
  `value_at_cost_amount` BIGINT NOT NULL,
  `currency` CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `sku_count` INT NOT NULL,
  `taken_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`snapshot_date`, `stock_group`),
  CONSTRAINT `ck_inventory_valuation_snapshots_stock_group` CHECK (`stock_group` IN ('available', 'reserved', 'incoming', 'damaged_held', 'returned'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `inventory_stock_counts` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `scope` TEXT NOT NULL,
  `state` TEXT NOT NULL,
  `created_by` TEXT NOT NULL,
  `submitted_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `inventory_count_lines` (
  `count_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `bin_code` TEXT NULL,
  `expected` INT NOT NULL,
  `counted` INT NULL,
  PRIMARY KEY (`count_id`, `stock_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `inventory_stock_items` ADD CONSTRAINT `fk_inventory_stock_items_service_location_id` FOREIGN KEY (`service_location_id`) REFERENCES `inventory_locations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_stock_levels` ADD CONSTRAINT `fk_inventory_stock_levels_stock_item_id` FOREIGN KEY (`stock_item_id`) REFERENCES `inventory_stock_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_stock_levels` ADD CONSTRAINT `fk_inventory_stock_levels_location_id` FOREIGN KEY (`location_id`) REFERENCES `inventory_locations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_stock_movements` ADD CONSTRAINT `fk_inventory_stock_movements_stock_item_id` FOREIGN KEY (`stock_item_id`) REFERENCES `inventory_stock_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_stock_movements` ADD CONSTRAINT `fk_inventory_stock_movements_location_id` FOREIGN KEY (`location_id`) REFERENCES `inventory_locations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_incoming_expectations` ADD CONSTRAINT `fk_inventory_incoming_expectations_stock_item_id` FOREIGN KEY (`stock_item_id`) REFERENCES `inventory_stock_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_incoming_expectations` ADD CONSTRAINT `fk_inventory_incoming_expectations_location_id` FOREIGN KEY (`location_id`) REFERENCES `inventory_locations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_reservation_lines` ADD CONSTRAINT `fk_inventory_reservation_lines_reservation_id` FOREIGN KEY (`reservation_id`) REFERENCES `inventory_reservations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_reservation_lines` ADD CONSTRAINT `fk_inventory_reservation_lines_stock_item_id` FOREIGN KEY (`stock_item_id`) REFERENCES `inventory_stock_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_reservation_lines` ADD CONSTRAINT `fk_inventory_reservation_lines_location_id` FOREIGN KEY (`location_id`) REFERENCES `inventory_locations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_adjustments` ADD CONSTRAINT `fk_inventory_adjustments_stock_item_id` FOREIGN KEY (`stock_item_id`) REFERENCES `inventory_stock_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_adjustments` ADD CONSTRAINT `fk_inventory_adjustments_location_id` FOREIGN KEY (`location_id`) REFERENCES `inventory_locations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_adjustments` ADD CONSTRAINT `fk_inventory_adjustments_movement_id` FOREIGN KEY (`movement_id`) REFERENCES `inventory_stock_movements` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_held_stock` ADD CONSTRAINT `fk_inventory_held_stock_stock_item_id` FOREIGN KEY (`stock_item_id`) REFERENCES `inventory_stock_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_held_stock` ADD CONSTRAINT `fk_inventory_held_stock_location_id` FOREIGN KEY (`location_id`) REFERENCES `inventory_locations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_inbound_receipts` ADD CONSTRAINT `fk_inventory_inbound_receipts_location_id` FOREIGN KEY (`location_id`) REFERENCES `inventory_locations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_inbound_lines` ADD CONSTRAINT `fk_inventory_inbound_lines_inbound_id` FOREIGN KEY (`inbound_id`) REFERENCES `inventory_inbound_receipts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_inbound_lines` ADD CONSTRAINT `fk_inventory_inbound_lines_stock_item_id` FOREIGN KEY (`stock_item_id`) REFERENCES `inventory_stock_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_return_outcomes` ADD CONSTRAINT `fk_inventory_return_outcomes_stock_item_id` FOREIGN KEY (`stock_item_id`) REFERENCES `inventory_stock_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_discrepancies` ADD CONSTRAINT `fk_inventory_discrepancies_stock_item_id` FOREIGN KEY (`stock_item_id`) REFERENCES `inventory_stock_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_discrepancies` ADD CONSTRAINT `fk_inventory_discrepancies_location_id` FOREIGN KEY (`location_id`) REFERENCES `inventory_locations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_transfers` ADD CONSTRAINT `fk_inventory_transfers_from_location_id` FOREIGN KEY (`from_location_id`) REFERENCES `inventory_locations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_transfers` ADD CONSTRAINT `fk_inventory_transfers_to_location_id` FOREIGN KEY (`to_location_id`) REFERENCES `inventory_locations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_transfer_lines` ADD CONSTRAINT `fk_inventory_transfer_lines_transfer_id` FOREIGN KEY (`transfer_id`) REFERENCES `inventory_transfers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_transfer_lines` ADD CONSTRAINT `fk_inventory_transfer_lines_stock_item_id` FOREIGN KEY (`stock_item_id`) REFERENCES `inventory_stock_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_stock_counts` ADD CONSTRAINT `fk_inventory_stock_counts_location_id` FOREIGN KEY (`location_id`) REFERENCES `inventory_locations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_count_lines` ADD CONSTRAINT `fk_inventory_count_lines_count_id` FOREIGN KEY (`count_id`) REFERENCES `inventory_stock_counts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `inventory_count_lines` ADD CONSTRAINT `fk_inventory_count_lines_stock_item_id` FOREIGN KEY (`stock_item_id`) REFERENCES `inventory_stock_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
