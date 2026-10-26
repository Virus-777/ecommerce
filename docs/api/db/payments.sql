-- payments: MySQL schema generated from docs/api/spec/modules/payments.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

-- payments_intents: partial unique on checkout_session_id where `status` IN ('created', 'authorizing', 'requires_action', 'pending_check', 'authorized', 'partially_captured', 'captured')
-- payments_intents: partial unique on purchase_module, purchase_ref_id where `status` IN ('created', 'authorizing', 'requires_action', 'pending_check', 'authorized', 'captured')
CREATE TABLE `payments_intents` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `purpose` VARCHAR(32) NOT NULL,
  `purchase_module` VARCHAR(255) NULL,
  `purchase_ref_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `purchase_ref` TEXT NULL,
  `checkout_session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `attempt_no` INT NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `guest_email` TEXT NULL,
  `amount` INT NOT NULL,
  `currency` TEXT NOT NULL,
  `tenders` JSON NOT NULL,
  `method` JSON NOT NULL,
  `provider` VARCHAR(255) NOT NULL,
  `provider_ref` VARCHAR(255) NULL,
  `status` VARCHAR(32) NOT NULL,
  `decline` JSON NULL,
  `next_action` JSON NULL,
  `authorized_amount` INT NOT NULL,
  `captured_amount` INT NOT NULL,
  `refunded_amount` INT NOT NULL,
  `authorized_at` DATETIME(3) NULL,
  `captured_at` DATETIME(3) NULL,
  `authorization_expires_at` DATETIME(3) NULL,
  `last_checked_at` DATETIME(3) NULL,
  `next_check_at` DATETIME(3) NULL,
  `check_attempts` INT NOT NULL,
  `orphan` TINYINT(1) NOT NULL,
  `idempotency_key` VARCHAR(255) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payments_intents_ref` (`ref`),
  UNIQUE KEY `uq_payments_intents_idempotency_key` (`idempotency_key`),
  KEY `ix_payments_intents_1` (`checkout_session_id`, `attempt_no`),
  UNIQUE KEY `uq_payments_intents_2` ((IF(`status` IN ('created', 'authorizing', 'requires_action', 'pending_check', 'authorized', 'partially_captured', 'captured'), `checkout_session_id`, NULL))),
  KEY `ix_payments_intents_3` (`order_id`),
  KEY `ix_payments_intents_4` (`status`, `next_check_at`),
  KEY `ix_payments_intents_5` (`provider`, `provider_ref`),
  KEY `ix_payments_intents_6` (`status`, `updated_at`, `id`),
  KEY `ix_payments_intents_7` (`customer_id`, `status`, `updated_at`),
  KEY `ix_payments_intents_8` (`idempotency_key`),
  KEY `ix_payments_intents_9` (`purchase_module`, `purchase_ref_id`),
  UNIQUE KEY `uq_payments_intents_10` ((IF(`status` IN ('created', 'authorizing', 'requires_action', 'pending_check', 'authorized', 'captured'), `purchase_module`, NULL)), `purchase_ref_id`),
  CONSTRAINT `ck_payments_intents_purpose` CHECK (`purpose` IN ('checkout', 'purchase')),
  CONSTRAINT `ck_payments_intents_status` CHECK (`status` IN ('created', 'authorizing', 'requires_action', 'pending_check', 'authorized', 'partially_captured', 'captured', 'failed', 'voided', 'expired'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- payments_allocations: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `payments_allocations` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `intent_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_type` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `amount` INT NOT NULL,
  PRIMARY KEY (`row_id`),
  KEY `ix_payments_allocations_1` (`intent_id`),
  KEY `ix_payments_allocations_2` (`group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `payments_captures` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `intent_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `amount` INT NOT NULL,
  `credit_amount` INT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `provider_ref` TEXT NULL,
  `idempotency_key` VARCHAR(255) NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payments_captures_idempotency_key` (`idempotency_key`),
  KEY `ix_payments_captures_1` (`intent_id`),
  KEY `ix_payments_captures_2` (`idempotency_key`),
  KEY `ix_payments_captures_3` (`status`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `payments_provider_calls` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `intent_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `refund_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `operation` TEXT NOT NULL,
  `outcome` TEXT NOT NULL,
  `provider_ref` TEXT NULL,
  `message` TEXT NULL,
  `latency_ms` INT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_payments_provider_calls_1` (`intent_id`, `at`),
  KEY `ix_payments_provider_calls_2` (`refund_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- payments_refunds: partial unique on origin, origin_id where `origin_id` IS NOT NULL AND `origin` <> 'cancellation' AND `status` <> 'cancelled'
CREATE TABLE `payments_refunds` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `checkout_session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `intent_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `origin` VARCHAR(32) NOT NULL,
  `origin_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `origin_ref` TEXT NULL,
  `amount` INT NOT NULL,
  `currency` TEXT NOT NULL,
  `destination` TEXT NOT NULL,
  `destination_label` TEXT NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `attempts` INT NOT NULL,
  `outcome_unknown` TINYINT(1) NOT NULL,
  `failure_code` TEXT NULL,
  `failure_reason` TEXT NULL,
  `provider_ref` VARCHAR(255) NULL,
  `reason` TEXT NOT NULL,
  `requested_by` JSON NOT NULL,
  `idempotency_key` VARCHAR(255) NOT NULL,
  `destination_ref` TEXT NULL,
  `attempt_key` TEXT NULL,
  `sent_at` DATETIME(3) NULL,
  `last_attempt_at` DATETIME(3) NULL,
  `next_attempt_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payments_refunds_ref` (`ref`),
  UNIQUE KEY `uq_payments_refunds_idempotency_key` (`idempotency_key`),
  KEY `ix_payments_refunds_1` (`order_id`),
  KEY `ix_payments_refunds_2` (`checkout_session_id`),
  KEY `ix_payments_refunds_3` (`status`, `next_attempt_at`),
  UNIQUE KEY `uq_payments_refunds_4` ((IF(`origin_id` IS NOT NULL AND `origin` <> 'cancellation' AND `status` <> 'cancelled', `origin`, NULL)), `origin_id`),
  KEY `ix_payments_refunds_5` (`origin`, `origin_id`),
  KEY `ix_payments_refunds_6` (`intent_id`),
  KEY `ix_payments_refunds_7` (`idempotency_key`),
  KEY `ix_payments_refunds_8` (`ref`),
  KEY `ix_payments_refunds_9` (`provider_ref`),
  CONSTRAINT `ck_payments_refunds_origin` CHECK (`origin` IN ('cancellation', 'return', 'case', 'exception', 'correction', 'orphan_payment')),
  CONSTRAINT `ck_payments_refunds_status` CHECK (`status` IN ('requested', 'processing', 'sent', 'failed', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- payments_refund_items: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `payments_refund_items` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `refund_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `amount` INT NOT NULL,
  PRIMARY KEY (`row_id`),
  KEY `ix_payments_refund_items_1` (`order_item_id`),
  KEY `ix_payments_refund_items_2` (`refund_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `payments_refund_log` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `refund_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `from_status` TEXT NULL,
  `to_status` TEXT NOT NULL,
  `detail` TEXT NULL,
  `actor` JSON NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_payments_refund_log_1` (`refund_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- payments_disputes: partial index: approval_request_id from "where `approval_request_id` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `payments_disputes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `kind` TEXT NOT NULL,
  `provider` VARCHAR(255) NOT NULL,
  `provider_case_id` VARCHAR(255) NOT NULL,
  `intent_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `reason_code` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `amount` INT NOT NULL,
  `currency` TEXT NOT NULL,
  `evidence_due_at` DATETIME(3) NULL,
  `due_soon_flagged_at` DATETIME(3) NULL,
  `status` VARCHAR(255) NOT NULL,
  `evidence` JSON NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `concession_reason` TEXT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `opened_at` DATETIME(3) NOT NULL,
  `decided_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payments_disputes_ref` (`ref`),
  UNIQUE KEY `uq_payments_disputes_1` (`provider`, `provider_case_id`),
  KEY `ix_payments_disputes_2` (`status`, `evidence_due_at`),
  KEY `ix_payments_disputes_3` (`approval_request_id`),
  KEY `ix_payments_disputes_4` (`intent_id`),
  KEY `ix_payments_disputes_5` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `payments_dispute_log` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `dispute_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `label` TEXT NOT NULL,
  `detail` TEXT NULL,
  `actor` JSON NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_payments_dispute_log_1` (`dispute_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `payments_saved_methods` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `provider` VARCHAR(255) NOT NULL,
  `provider_method_id` VARCHAR(255) NOT NULL,
  `kind` TEXT NOT NULL,
  `brand` TEXT NOT NULL,
  `last4` TEXT NOT NULL,
  `exp_month` INT NOT NULL,
  `exp_year` INT NOT NULL,
  `label` TEXT NOT NULL,
  `billing_address` JSON NOT NULL,
  `is_default` TINYINT(1) NOT NULL,
  `removed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_payments_saved_methods_1` (`customer_id`),
  KEY `ix_payments_saved_methods_2` (`provider`, `provider_method_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `payments_webhook_events` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `provider` VARCHAR(255) NOT NULL,
  `external_id` VARCHAR(255) NOT NULL,
  `type` TEXT NOT NULL,
  `payload` JSON NOT NULL,
  `intent_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `refund_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `received_at` DATETIME(3) NOT NULL,
  `processed_at` DATETIME(3) NULL,
  `outcome` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payments_webhook_events_1` (`provider`, `external_id`),
  KEY `ix_payments_webhook_events_2` (`intent_id`, `received_at`),
  KEY `ix_payments_webhook_events_3` (`refund_id`, `received_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- payments_ref_sequences: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `payments_ref_sequences` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `kind` VARCHAR(255) NOT NULL,
  `day` DATE NOT NULL,
  `last_value` INT NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_payments_ref_sequences_1` (`kind`, `day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `payments_allocations` ADD CONSTRAINT `fk_payments_allocations_intent_id` FOREIGN KEY (`intent_id`) REFERENCES `payments_intents` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `payments_captures` ADD CONSTRAINT `fk_payments_captures_intent_id` FOREIGN KEY (`intent_id`) REFERENCES `payments_intents` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `payments_refunds` ADD CONSTRAINT `fk_payments_refunds_intent_id` FOREIGN KEY (`intent_id`) REFERENCES `payments_intents` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `payments_refund_items` ADD CONSTRAINT `fk_payments_refund_items_refund_id` FOREIGN KEY (`refund_id`) REFERENCES `payments_refunds` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `payments_refund_log` ADD CONSTRAINT `fk_payments_refund_log_refund_id` FOREIGN KEY (`refund_id`) REFERENCES `payments_refunds` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `payments_disputes` ADD CONSTRAINT `fk_payments_disputes_intent_id` FOREIGN KEY (`intent_id`) REFERENCES `payments_intents` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `payments_dispute_log` ADD CONSTRAINT `fk_payments_dispute_log_dispute_id` FOREIGN KEY (`dispute_id`) REFERENCES `payments_disputes` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
