-- warehouse: MySQL schema generated from docs/api/spec/modules/warehouse.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `warehouse_bins` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `code` VARCHAR(255) NOT NULL,
  `zone` VARCHAR(255) NOT NULL,
  `kind` TEXT NOT NULL,
  `barcode` VARCHAR(255) NOT NULL,
  `active` TINYINT(1) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_warehouse_bins_1` (`location_id`, `code`),
  UNIQUE KEY `uq_warehouse_bins_2` (`barcode`),
  KEY `ix_warehouse_bins_3` (`location_id`, `zone`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- warehouse_bin_assignments: partial unique on stock_item_id where `primary_bin` = 1
CREATE TABLE `warehouse_bin_assignments` (
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `bin_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `primary_bin` TINYINT(1) NOT NULL,
  `assigned_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`stock_item_id`, `bin_id`),
  UNIQUE KEY `uq_warehouse_bin_assignments_2` ((IF(`primary_bin` = 1, `stock_item_id`, NULL))),
  KEY `ix_warehouse_bin_assignments_3` (`bin_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `warehouse_fulfillments` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_ref` TEXT NOT NULL,
  `seller_group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `fulfilled_by` VARCHAR(32) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `seller_name` TEXT NULL,
  `location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `ship_by` DATETIME(3) NOT NULL,
  `delivery_choice` TEXT NOT NULL,
  `ship_to` JSON NOT NULL,
  `wave_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `hold_reason` TEXT NULL,
  `dispatch_overdue_at` DATETIME(3) NULL,
  `discrepancy_ids` JSON NOT NULL,
  `total_packages_in_order` INT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_warehouse_fulfillments_seller_group_id` (`seller_group_id`),
  KEY `ix_warehouse_fulfillments_1` (`status`, `ship_by`),
  KEY `ix_warehouse_fulfillments_2` (`wave_id`),
  KEY `ix_warehouse_fulfillments_3` (`order_id`),
  KEY `ix_warehouse_fulfillments_4` (`seller_group_id`),
  KEY `ix_warehouse_fulfillments_5` (`status`, `updated_at`),
  CONSTRAINT `ck_warehouse_fulfillments_fulfilled_by` CHECK (`fulfilled_by` IN ('official_warehouse', 'marketly_service'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `warehouse_fulfillment_lines` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `fulfillment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `sku` TEXT NOT NULL,
  `label` TEXT NOT NULL,
  `quantity` INT NOT NULL,
  `bin_code` VARCHAR(255) NULL,
  `picked` INT NOT NULL,
  `short` INT NOT NULL,
  `state` TEXT NOT NULL,
  `picked_by` TEXT NULL,
  `picked_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_warehouse_fulfillment_lines_1` (`fulfillment_id`),
  KEY `ix_warehouse_fulfillment_lines_2` (`bin_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `warehouse_waves` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` TEXT NOT NULL,
  `location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `carrier_pickup_at` DATETIME(3) NULL,
  `created_by` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `completed_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_warehouse_waves_1` (`location_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `warehouse_scan_log` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `context` VARCHAR(255) NOT NULL,
  `context_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `code` TEXT NOT NULL,
  `result` TEXT NOT NULL,
  `actor_id` TEXT NOT NULL,
  `station` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_warehouse_scan_log_1` (`context`, `context_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `warehouse_box_types` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` TEXT NOT NULL,
  `kind` TEXT NOT NULL,
  `dimensions` JSON NOT NULL,
  `max_weight` JSON NULL,
  `active` TINYINT(1) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `warehouse_packages` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `fulfillment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `index_in_order` INT NOT NULL,
  `of_in_order` INT NOT NULL,
  `status` TEXT NOT NULL,
  `box_type_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `dimensions` JSON NULL,
  `weight` JSON NULL,
  `fragile` TINYINT(1) NOT NULL,
  `handling_note` TEXT NULL,
  `carrier` TEXT NULL,
  `service` TEXT NULL,
  `carrier_service_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `tracking_number` VARCHAR(255) NULL,
  `label_media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `label_idempotency_key` TEXT NULL,
  `shipment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `packed_by` TEXT NULL,
  `packed_at` DATETIME(3) NULL,
  `station` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_warehouse_packages_1` (`fulfillment_id`),
  UNIQUE KEY `uq_warehouse_packages_2` (`tracking_number`),
  KEY `ix_warehouse_packages_3` (`shipment_id`),
  KEY `ix_warehouse_packages_4` (`packed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `warehouse_package_items` (
  `package_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `quantity` INT NOT NULL,
  `scanned` INT NOT NULL,
  `serial_numbers` JSON NOT NULL,
  PRIMARY KEY (`package_id`, `order_item_id`),
  KEY `ix_warehouse_package_items_2` (`order_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `warehouse_putaway_tasks` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `receipt_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `receipt_ref` TEXT NOT NULL,
  `location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `quantity` INT NOT NULL,
  `suggested_bin_code` TEXT NULL,
  `bin_code` TEXT NULL,
  `status` VARCHAR(255) NOT NULL,
  `done_by` TEXT NULL,
  `done_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_warehouse_putaway_tasks_1` (`status`, `receipt_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `warehouse_return_parcels` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `return_ref` TEXT NULL,
  `order_ref` TEXT NULL,
  `tracking_number` VARCHAR(255) NULL,
  `status` VARCHAR(255) NOT NULL,
  `expected_by` DATE NULL,
  `expected_items` JSON NOT NULL,
  `unexpected` TINYINT(1) NOT NULL,
  `parcel_condition` TEXT NULL,
  `photo_media_ids` JSON NOT NULL,
  `note` TEXT NULL,
  `received_by` TEXT NULL,
  `received_at` DATETIME(3) NULL,
  `handed_over_to` TEXT NULL,
  `handed_over_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_warehouse_return_parcels_1` (`status`, `expected_by`),
  KEY `ix_warehouse_return_parcels_2` (`return_id`),
  KEY `ix_warehouse_return_parcels_3` (`tracking_number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `warehouse_bin_assignments` ADD CONSTRAINT `fk_warehouse_bin_assignments_bin_id` FOREIGN KEY (`bin_id`) REFERENCES `warehouse_bins` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `warehouse_fulfillments` ADD CONSTRAINT `fk_warehouse_fulfillments_wave_id` FOREIGN KEY (`wave_id`) REFERENCES `warehouse_waves` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `warehouse_fulfillment_lines` ADD CONSTRAINT `fk_warehouse_fulfillment_lines_fulfillment_id` FOREIGN KEY (`fulfillment_id`) REFERENCES `warehouse_fulfillments` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `warehouse_packages` ADD CONSTRAINT `fk_warehouse_packages_fulfillment_id` FOREIGN KEY (`fulfillment_id`) REFERENCES `warehouse_fulfillments` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `warehouse_packages` ADD CONSTRAINT `fk_warehouse_packages_box_type_id` FOREIGN KEY (`box_type_id`) REFERENCES `warehouse_box_types` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `warehouse_package_items` ADD CONSTRAINT `fk_warehouse_package_items_package_id` FOREIGN KEY (`package_id`) REFERENCES `warehouse_packages` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
