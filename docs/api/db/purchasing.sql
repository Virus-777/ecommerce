-- purchasing: MySQL schema generated from docs/api/spec/modules/purchasing.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `purchasing_suppliers` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `location` TEXT NULL,
  `contact_name` TEXT NULL,
  `email` TEXT NULL,
  `phone` TEXT NULL,
  `address` JSON NULL,
  `payment_terms` TEXT NOT NULL,
  `lead_time_days` INT NOT NULL,
  `return_authorization_required` TINYINT(1) NOT NULL,
  `active` TINYINT(1) NOT NULL,
  `notes` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_purchasing_suppliers_1` (`active`, `name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- purchasing_supplier_items: partial index: stock_item_id plus preferred from "where `preferred` = 1" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `purchasing_supplier_items` (
  `supplier_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `supplier_sku` TEXT NULL,
  `unit_cost_amount` BIGINT NOT NULL,
  `currency` CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `min_order_qty` INT NULL,
  `lead_time_days` INT NULL,
  `preferred` TINYINT(1) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`supplier_id`, `stock_item_id`),
  KEY `ix_purchasing_supplier_items_2` (`stock_item_id`, `preferred`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `purchasing_supplier_performance` (
  `supplier_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `window_days` INT NOT NULL,
  `on_time_pct` DECIMAL(5,2) NULL,
  `avg_lead_time_days` DECIMAL(6,2) NULL,
  `shortage_rate_pct` DECIMAL(5,2) NULL,
  `damage_rate_pct` DECIMAL(5,2) NULL,
  `deliveries` INT NOT NULL,
  `computed_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`supplier_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `purchasing_purchase_orders` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `supplier_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ship_to_location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `payment_terms` TEXT NOT NULL,
  `expected_date` DATE NULL,
  `freight_amount` BIGINT NOT NULL,
  `currency` CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `total_amount` BIGINT NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `approval_state` VARCHAR(32) NULL,
  `notes` TEXT NULL,
  `attachment_media_ids` JSON NOT NULL,
  `created_by` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `sent_at` DATETIME(3) NULL,
  `closed_at` DATETIME(3) NULL,
  `close_reason` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchasing_purchase_orders_ref` (`ref`),
  KEY `ix_purchasing_purchase_orders_1` (`status`, `expected_date`),
  KEY `ix_purchasing_purchase_orders_2` (`supplier_id`, `created_at`),
  KEY `ix_purchasing_purchase_orders_3` (`approval_request_id`),
  CONSTRAINT `ck_purchasing_purchase_orders_approval_state` CHECK (`approval_state` IN ('pending', 'approved', 'rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `purchasing_purchase_order_lines` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `purchase_order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `sku` TEXT NOT NULL,
  `label` TEXT NOT NULL,
  `qty_ordered` INT NOT NULL,
  `qty_received` INT NOT NULL,
  `qty_damaged` INT NOT NULL,
  `qty_closed` INT NOT NULL,
  `unit_cost_amount` BIGINT NOT NULL,
  `expected_date` DATE NULL,
  PRIMARY KEY (`id`),
  KEY `ix_purchasing_purchase_order_lines_1` (`purchase_order_id`),
  KEY `ix_purchasing_purchase_order_lines_2` (`stock_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `purchasing_purchase_order_events` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `purchase_order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `label` TEXT NOT NULL,
  `detail` TEXT NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_purchasing_purchase_order_events_1` (`purchase_order_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `purchasing_deliveries` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `purchase_order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `carrier` TEXT NULL,
  `tracking_ref` TEXT NULL,
  `window_from` DATETIME(3) NOT NULL,
  `window_to` DATETIME(3) NOT NULL,
  `units` INT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `delay_reason` TEXT NULL,
  `arrived_at` DATETIME(3) NULL,
  `dock` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_purchasing_deliveries_1` (`status`, `window_from`),
  KEY `ix_purchasing_deliveries_2` (`purchase_order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- purchasing_receipts: partial unique on delivery_id where `status` = 'in_progress'
CREATE TABLE `purchasing_receipts` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `purchase_order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `delivery_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `location_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `note` TEXT NULL,
  `received_by` TEXT NOT NULL,
  `started_at` DATETIME(3) NOT NULL,
  `submitted_at` DATETIME(3) NULL,
  `confirmed_by` TEXT NULL,
  `confirmed_at` DATETIME(3) NULL,
  `inbound_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchasing_receipts_ref` (`ref`),
  KEY `ix_purchasing_receipts_1` (`status`, `started_at`),
  UNIQUE KEY `uq_purchasing_receipts_2` ((IF(`status` = 'in_progress', `delivery_id`, NULL)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `purchasing_receipt_lines` (
  `receipt_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `purchase_order_line_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `expected` INT NOT NULL,
  `received` INT NOT NULL,
  `damaged` INT NOT NULL,
  `bin_code` TEXT NULL,
  `photo_media_ids` JSON NOT NULL,
  `note` TEXT NULL,
  PRIMARY KEY (`receipt_id`, `purchase_order_line_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `purchasing_supplier_claims` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `supplier_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `purchase_order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `receipt_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `kind` TEXT NOT NULL,
  `lines` JSON NOT NULL,
  `amount` BIGINT NOT NULL,
  `currency` CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `settlement` TEXT NULL,
  `settled_amount` BIGINT NULL,
  `supplier_reference` TEXT NULL,
  `owner_id` TEXT NOT NULL,
  `notes` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `decided_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_purchasing_supplier_claims_ref` (`ref`),
  KEY `ix_purchasing_supplier_claims_1` (`status`, `created_at`),
  KEY `ix_purchasing_supplier_claims_2` (`supplier_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `purchasing_supplier_items` ADD CONSTRAINT `fk_purchasing_supplier_items_supplier_id` FOREIGN KEY (`supplier_id`) REFERENCES `purchasing_suppliers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `purchasing_supplier_performance` ADD CONSTRAINT `fk_purchasing_supplier_performance_supplier_id` FOREIGN KEY (`supplier_id`) REFERENCES `purchasing_suppliers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `purchasing_purchase_orders` ADD CONSTRAINT `fk_purchasing_purchase_orders_supplier_id` FOREIGN KEY (`supplier_id`) REFERENCES `purchasing_suppliers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `purchasing_purchase_order_lines` ADD CONSTRAINT `fk_purchasing_purchase_order_lines_purchase_order_id` FOREIGN KEY (`purchase_order_id`) REFERENCES `purchasing_purchase_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `purchasing_purchase_order_events` ADD CONSTRAINT `fk_purchasing_purchase_order_events_purchase_order_id` FOREIGN KEY (`purchase_order_id`) REFERENCES `purchasing_purchase_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `purchasing_deliveries` ADD CONSTRAINT `fk_purchasing_deliveries_purchase_order_id` FOREIGN KEY (`purchase_order_id`) REFERENCES `purchasing_purchase_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `purchasing_receipts` ADD CONSTRAINT `fk_purchasing_receipts_purchase_order_id` FOREIGN KEY (`purchase_order_id`) REFERENCES `purchasing_purchase_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `purchasing_receipts` ADD CONSTRAINT `fk_purchasing_receipts_delivery_id` FOREIGN KEY (`delivery_id`) REFERENCES `purchasing_deliveries` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `purchasing_receipt_lines` ADD CONSTRAINT `fk_purchasing_receipt_lines_receipt_id` FOREIGN KEY (`receipt_id`) REFERENCES `purchasing_receipts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `purchasing_receipt_lines` ADD CONSTRAINT `fk_purchasing_receipt_lines_purchase_order_line_id` FOREIGN KEY (`purchase_order_line_id`) REFERENCES `purchasing_purchase_order_lines` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `purchasing_supplier_claims` ADD CONSTRAINT `fk_purchasing_supplier_claims_supplier_id` FOREIGN KEY (`supplier_id`) REFERENCES `purchasing_suppliers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `purchasing_supplier_claims` ADD CONSTRAINT `fk_purchasing_supplier_claims_purchase_order_id` FOREIGN KEY (`purchase_order_id`) REFERENCES `purchasing_purchase_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `purchasing_supplier_claims` ADD CONSTRAINT `fk_purchasing_supplier_claims_receipt_id` FOREIGN KEY (`receipt_id`) REFERENCES `purchasing_receipts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- views: join shapes, merged into the query that reads them (§9.2)
CREATE OR REPLACE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW `purchasing_v_receipt_lines` AS
SELECT rl.*,
  rc.ref AS receipt_ref, rc.purchase_order_id, rc.delivery_id, rc.location_id, rc.status AS receipt_status,
  rc.confirmed_at AS receipt_confirmed_at,
  d.carrier, d.tracking_ref, d.window_from, d.window_to, d.arrived_at, d.status AS delivery_status, d.delay_reason,
  pol.sku AS line_sku, pol.label AS line_label, pol.qty_ordered, pol.unit_cost_amount, pol.expected_date,
  po.ref AS purchase_order_ref, po.supplier_id, po.status AS purchase_order_status
FROM purchasing_receipt_lines rl
JOIN purchasing_receipts rc ON rc.id = rl.receipt_id
JOIN purchasing_deliveries d ON d.id = rc.delivery_id
JOIN purchasing_purchase_order_lines pol ON pol.id = rl.purchase_order_line_id
JOIN purchasing_purchase_orders po ON po.id = rc.purchase_order_id;
