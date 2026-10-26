-- returns: MySQL schema generated from docs/api/spec/modules/returns.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `returns_policy_versions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `version` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `window_days` INT NOT NULL,
  `seller_response_business_days` INT NOT NULL,
  `info_reply_days` INT NOT NULL,
  `drop_off_days` INT NOT NULL,
  `inspection_target_business_days` INT NOT NULL,
  `refund_target_business_days` INT NOT NULL,
  `responsibilities` JSON NOT NULL,
  `effective_from` DATETIME(3) NULL,
  `change_reason` TEXT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_by` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_returns_policy_versions_1` (`status`, `effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `returns_category_exceptions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `window_days` INT NULL,
  `change_of_mind_allowed` TINYINT(1) NOT NULL,
  `condition` TEXT NOT NULL,
  `fault_returns_window_days` INT NOT NULL,
  `shown_on` JSON NOT NULL,
  `effective_from` DATETIME(3) NOT NULL,
  `effective_to` DATETIME(3) NULL,
  `apply_scope` TEXT NOT NULL,
  `status` TEXT NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `reason` TEXT NOT NULL,
  `created_by` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_returns_category_exceptions_1` (`category_id`, `effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `returns_seller_terms` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `version` INT NOT NULL,
  `window_days` INT NOT NULL,
  `change_of_mind_paid_by` TEXT NOT NULL,
  `free_returns` TINYINT(1) NOT NULL,
  `remedies` JSON NOT NULL,
  `return_address` JSON NOT NULL,
  `return_contact_email` TEXT NULL,
  `receiving_hours` TEXT NULL,
  `response_target_business_days` INT NOT NULL,
  `refund_target_days` INT NOT NULL,
  `effective_from` DATETIME(3) NOT NULL,
  `superseded_at` DATETIME(3) NULL,
  `created_by` TEXT NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_returns_seller_terms_1` (`seller_id`, `effective_from` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `returns_returns` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_ref` TEXT NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `guest_session_id` TEXT NULL,
  `owner_type` VARCHAR(32) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `fulfilled_by` VARCHAR(32) NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `reason` TEXT NOT NULL,
  `details` TEXT NOT NULL,
  `media_ids` JSON NOT NULL,
  `remedy` TEXT NOT NULL,
  `exchange_variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `handled_by` TEXT NOT NULL,
  `terms_snapshot` JSON NOT NULL,
  `shipping_paid_by` TEXT NOT NULL,
  `response_due_at` DATETIME(3) NULL,
  `info_request` JSON NULL,
  `decision` JSON NULL,
  `platform_handling` TINYINT(1) NOT NULL,
  `escalation` JSON NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `case_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `conversation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `exception` JSON NULL,
  `inspector` JSON NULL,
  `inspection_started_at` DATETIME(3) NULL,
  `requested_at` DATETIME(3) NOT NULL,
  `received_at` DATETIME(3) NULL,
  `completed_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_returns_returns_ref` (`ref`),
  KEY `ix_returns_returns_1` (`seller_id`, `status`, `response_due_at`),
  KEY `ix_returns_returns_2` (`seller_id`, `requested_at` DESC),
  KEY `ix_returns_returns_3` (`customer_id`, `requested_at` DESC),
  KEY `ix_returns_returns_4` (`order_id`),
  KEY `ix_returns_returns_5` (`status`, `response_due_at`),
  KEY `ix_returns_returns_6` (`status`, `requested_at` DESC),
  KEY `ix_returns_returns_7` (`owner_staff_id`, `status`),
  KEY `ix_returns_returns_8` (`status`, `id`),
  CONSTRAINT `ck_returns_returns_owner_type` CHECK (`owner_type` IN ('official', 'seller')),
  CONSTRAINT `ck_returns_returns_fulfilled_by` CHECK (`fulfilled_by` IN ('official_warehouse', 'seller', 'marketly_service'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `returns_return_items` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `title` TEXT NOT NULL,
  `options` JSON NOT NULL,
  `sku` TEXT NULL,
  `quantity` INT NOT NULL,
  `unit_price` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_returns_return_items_1` (`return_id`),
  KEY `ix_returns_return_items_2` (`order_item_id`),
  KEY `ix_returns_return_items_3` (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `returns_return_shipments` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `method` TEXT NOT NULL,
  `carrier` TEXT NULL,
  `service` TEXT NULL,
  `tracking_number` VARCHAR(255) NULL,
  `label_url` TEXT NULL,
  `qr_code_url` TEXT NULL,
  `drop_off_code` TEXT NULL,
  `drop_off_by` DATETIME(3) NULL,
  `from_address` JSON NULL,
  `to_address` JSON NOT NULL,
  `cost` BIGINT NULL,
  `paid_by` TEXT NOT NULL,
  `shipping_shipment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `label_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `carrier_service_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_at` DATETIME(3) NOT NULL,
  `delivered_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_returns_return_shipments_1` (`return_id`),
  KEY `ix_returns_return_shipments_2` (`tracking_number`),
  KEY `ix_returns_return_shipments_3` (`shipping_shipment_id`),
  KEY `ix_returns_return_shipments_4` (`status`, `drop_off_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `returns_inspection_drafts` (
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `inspection` JSON NOT NULL,
  `remedy` JSON NULL,
  `saved_by` JSON NOT NULL,
  `saved_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`return_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `returns_return_evidence` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `media_ids` JSON NOT NULL,
  `note` TEXT NULL,
  `party` TEXT NOT NULL,
  `added_by` JSON NOT NULL,
  `added_at` DATETIME(3) NOT NULL,
  `case_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  KEY `ix_returns_return_evidence_1` (`return_id`, `added_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `returns_inspections` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `inspected_by` TEXT NOT NULL,
  `inspected_at` DATETIME(3) NOT NULL,
  `condition_outcome` TEXT NOT NULL,
  `grade` TEXT NOT NULL,
  `checks` JSON NOT NULL,
  `missing_parts` JSON NOT NULL,
  `notes` TEXT NULL,
  `media_ids` JSON NOT NULL,
  `proposed_stock_outcome` TEXT NOT NULL,
  `regrade_condition` TEXT NULL,
  `stock_outcome_recorded_by` TEXT NULL,
  `stock_outcome_recorded_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_returns_inspections_1` (`return_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `returns_refund_requests` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `source` TEXT NOT NULL,
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `case_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_type` VARCHAR(32) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `contact_email` TEXT NULL,
  `customer_name` TEXT NULL,
  `seller_name` TEXT NULL,
  `order_ref` TEXT NULL,
  `status` VARCHAR(255) NOT NULL,
  `item_amount` BIGINT NOT NULL,
  `discount_share` BIGINT NOT NULL,
  `shipping_refund` BIGINT NOT NULL,
  `return_shipping_deduction` BIGINT NOT NULL,
  `deductions` JSON NOT NULL,
  `tax_refund` BIGINT NULL,
  `max_refundable` BIGINT NOT NULL,
  `destination` VARCHAR(32) NOT NULL,
  `destination_label` TEXT NOT NULL,
  `remedy_kind` TEXT NOT NULL,
  `total` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `funded_by` TEXT NOT NULL,
  `seller_share` BIGINT NULL,
  `platform_share` BIGINT NULL,
  `reason_code` TEXT NULL,
  `reason` TEXT NULL,
  `trust_report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `proposed_by` TEXT NOT NULL,
  `approved_by` TEXT NULL,
  `approved_at` DATETIME(3) NULL,
  `decline_reason` TEXT NULL,
  `payment_refund_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `failed_reason` TEXT NULL,
  `sent_at` DATETIME(3) NULL,
  `note` TEXT NULL,
  `idempotency_key` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_returns_refund_requests_ref` (`ref`),
  UNIQUE KEY `uq_returns_refund_requests_idempotency_key` (`idempotency_key`),
  KEY `ix_returns_refund_requests_1` (`status`, `created_at`),
  KEY `ix_returns_refund_requests_2` (`order_id`),
  KEY `ix_returns_refund_requests_3` (`return_id`),
  KEY `ix_returns_refund_requests_4` (`case_id`),
  KEY `ix_returns_refund_requests_5` (`customer_id`, `created_at`),
  CONSTRAINT `ck_returns_refund_requests_owner_type` CHECK (`owner_type` IN ('official', 'seller')),
  CONSTRAINT `ck_returns_refund_requests_destination` CHECK (`destination` IN ('original_method', 'store_credit'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `returns_refund_request_items` (
  `refund_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `position` INT NOT NULL,
  `quantity` INT NULL,
  `amount` BIGINT NOT NULL,
  PRIMARY KEY (`refund_request_id`, `order_item_id`),
  KEY `ix_returns_refund_request_items_2` (`order_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `returns_refund_request_events` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `refund_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `at` DATETIME(3) NOT NULL,
  `label` TEXT NOT NULL,
  `detail` TEXT NULL,
  `actor_kind` TEXT NULL,
  `actor_id` TEXT NULL,
  `actor_name` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_returns_refund_request_events_1` (`refund_request_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `returns_replacements` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `case_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `quantity` INT NOT NULL,
  `reservation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `shipping_shipment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `cancel_reason` TEXT NULL,
  `idempotency_key` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `shipped_at` DATETIME(3) NULL,
  `delivered_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_returns_replacements_idempotency_key` (`idempotency_key`),
  KEY `ix_returns_replacements_1` (`return_id`),
  KEY `ix_returns_replacements_2` (`case_id`),
  KEY `ix_returns_replacements_3` (`order_id`),
  KEY `ix_returns_replacements_4` (`shipping_shipment_id`),
  KEY `ix_returns_replacements_5` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `returns_return_events` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `label` TEXT NOT NULL,
  `detail` TEXT NULL,
  `visibility` VARCHAR(32) NOT NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_returns_return_events_1` (`return_id`, `at`),
  CONSTRAINT `ck_returns_return_events_visibility` CHECK (`visibility` IN ('customer', 'seller', 'staff'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `returns_return_items` ADD CONSTRAINT `fk_returns_return_items_return_id` FOREIGN KEY (`return_id`) REFERENCES `returns_returns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `returns_return_shipments` ADD CONSTRAINT `fk_returns_return_shipments_return_id` FOREIGN KEY (`return_id`) REFERENCES `returns_returns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `returns_inspection_drafts` ADD CONSTRAINT `fk_returns_inspection_drafts_return_id` FOREIGN KEY (`return_id`) REFERENCES `returns_returns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `returns_return_evidence` ADD CONSTRAINT `fk_returns_return_evidence_return_id` FOREIGN KEY (`return_id`) REFERENCES `returns_returns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `returns_inspections` ADD CONSTRAINT `fk_returns_inspections_return_id` FOREIGN KEY (`return_id`) REFERENCES `returns_returns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `returns_refund_requests` ADD CONSTRAINT `fk_returns_refund_requests_return_id` FOREIGN KEY (`return_id`) REFERENCES `returns_returns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `returns_refund_request_items` ADD CONSTRAINT `fk_returns_refund_request_items_refund_request_id` FOREIGN KEY (`refund_request_id`) REFERENCES `returns_refund_requests` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `returns_refund_request_events` ADD CONSTRAINT `fk_returns_refund_request_events_refund_request_id` FOREIGN KEY (`refund_request_id`) REFERENCES `returns_refund_requests` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `returns_replacements` ADD CONSTRAINT `fk_returns_replacements_return_id` FOREIGN KEY (`return_id`) REFERENCES `returns_returns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `returns_return_events` ADD CONSTRAINT `fk_returns_return_events_return_id` FOREIGN KEY (`return_id`) REFERENCES `returns_returns` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
