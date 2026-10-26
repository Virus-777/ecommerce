-- wallet: MySQL schema generated from docs/api/spec/modules/wallet.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `wallet_accounts` (
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `currency` TEXT NOT NULL,
  `available` BIGINT NOT NULL,
  `held` BIGINT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `version` INT NOT NULL,
  PRIMARY KEY (`customer_id`),
  CONSTRAINT `ck_wallet_accounts_available_range` CHECK (`available` >= 0),
  CONSTRAINT `ck_wallet_accounts_held_range` CHECK (`held` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- wallet_lots: partial index: state, expires_at from "where `state` = 'active'" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `wallet_lots` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source` VARCHAR(32) NOT NULL,
  `original` BIGINT NOT NULL,
  `remaining` BIGINT NOT NULL,
  `expires_at` DATETIME(3) NULL,
  `reference` TEXT NULL,
  `state` VARCHAR(32) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_wallet_lots_1` (`customer_id`, `state`, `expires_at`),
  KEY `ix_wallet_lots_2` (`state`, `expires_at`),
  CONSTRAINT `ck_wallet_lots_source` CHECK (`source` IN ('refund', 'goodwill', 'price_adjustment', 'gift_card', 'correction')),
  CONSTRAINT `ck_wallet_lots_original_range` CHECK (`original` > 0),
  CONSTRAINT `ck_wallet_lots_remaining_range` CHECK (`remaining` >= 0),
  CONSTRAINT `ck_wallet_lots_state` CHECK (`state` IN ('active', 'depleted', 'expired'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- wallet_ledger: partial unique on refund_id, kind where `refund_id` IS NOT NULL
-- wallet_ledger: partial index: order_id from "where `order_id` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
-- wallet_ledger: partial index: hold_id from "where `hold_id` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
-- wallet_ledger: append-only: UPDATE and DELETE are refused; a retention purge sets @marketly_purge = 'wallet_ledger' in its own session (§6.3)
CREATE TABLE `wallet_ledger` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(255) NOT NULL,
  `amount` BIGINT NOT NULL,
  `balance_after` BIGINT NOT NULL,
  `lot_allocations` JSON NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `refund_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `case_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `hold_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `idempotency_key` VARCHAR(255) NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `reason` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_wallet_ledger_1` (`customer_id`, `at`),
  UNIQUE KEY `uq_wallet_ledger_2` (`idempotency_key`),
  UNIQUE KEY `uq_wallet_ledger_3` ((IF(`refund_id` IS NOT NULL, `refund_id`, NULL)), `kind`),
  KEY `ix_wallet_ledger_4` (`order_id`),
  KEY `ix_wallet_ledger_5` (`hold_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- wallet_holds: partial unique on quote_id where `state` = 'held'
CREATE TABLE `wallet_holds` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `quote_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `amount` BIGINT NOT NULL,
  `state` VARCHAR(32) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `idempotency_key` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wallet_holds_idempotency_key` (`idempotency_key`),
  UNIQUE KEY `uq_wallet_holds_1` ((IF(`state` = 'held', `quote_id`, NULL))),
  KEY `ix_wallet_holds_2` (`state`, `expires_at`),
  KEY `ix_wallet_holds_3` (`customer_id`, `state`),
  CONSTRAINT `ck_wallet_holds_amount_range` CHECK (`amount` > 0),
  CONSTRAINT `ck_wallet_holds_state` CHECK (`state` IN ('held', 'captured', 'released'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- wallet_gift_card_batches: partial index: codes_expire_at plus codes_ciphertext from "where `codes_ciphertext` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `wallet_gift_card_batches` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `count` INT NOT NULL,
  `amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `purpose` TEXT NOT NULL,
  `expires_at` DATETIME(3) NULL,
  `reason` TEXT NOT NULL,
  `cost_center` TEXT NULL,
  `status` VARCHAR(32) NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `codes_ciphertext` VARCHAR(255) NULL,
  `codes_file_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `codes_delivered_at` DATETIME(3) NULL,
  `codes_expire_at` DATETIME(3) NULL,
  `created_by` TEXT NOT NULL,
  `idempotency_key` VARCHAR(255) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wallet_gift_card_batches_idempotency_key` (`idempotency_key`),
  KEY `ix_wallet_gift_card_batches_1` (`status`, `created_at`),
  KEY `ix_wallet_gift_card_batches_2` (`codes_expire_at`, `codes_ciphertext`),
  CONSTRAINT `ck_wallet_gift_card_batches_status` CHECK (`status` IN ('pending_approval', 'issued', 'rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- wallet_goodwill_grants: partial index: approval_request_id from "where `approval_request_id` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
-- wallet_goodwill_grants: partial index: ledger_entry_id from "where `ledger_entry_id` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `wallet_goodwill_grants` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `reason_code` TEXT NOT NULL,
  `case_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `charged_to` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `state` VARCHAR(32) NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `requested_by` TEXT NOT NULL,
  `decided_by` TEXT NULL,
  `ledger_entry_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `idempotency_key` VARCHAR(255) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wallet_goodwill_grants_idempotency_key` (`idempotency_key`),
  KEY `ix_wallet_goodwill_grants_1` (`state`, `created_at`),
  KEY `ix_wallet_goodwill_grants_2` (`customer_id`, `created_at`),
  KEY `ix_wallet_goodwill_grants_3` (`approval_request_id`),
  KEY `ix_wallet_goodwill_grants_4` (`ledger_entry_id`),
  CONSTRAINT `ck_wallet_goodwill_grants_amount_range` CHECK (`amount` > 0),
  CONSTRAINT `ck_wallet_goodwill_grants_state` CHECK (`state` IN ('pending_approval', 'granted', 'rejected', 'reversed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `wallet_gift_cards` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `code_hash` VARCHAR(255) NOT NULL,
  `code_last4` VARCHAR(255) NOT NULL,
  `batch_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `initial` BIGINT NOT NULL,
  `remaining` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `state` VARCHAR(32) NOT NULL,
  `purpose` TEXT NOT NULL,
  `expires_at` DATETIME(3) NULL,
  `redeemed_by` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `redeemed_at` DATETIME(3) NULL,
  `created_by` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wallet_gift_cards_code_hash` (`code_hash`),
  KEY `ix_wallet_gift_cards_1` (`batch_id`, `created_at`),
  KEY `ix_wallet_gift_cards_2` (`code_last4`),
  KEY `ix_wallet_gift_cards_3` (`state`, `expires_at`),
  CONSTRAINT `ck_wallet_gift_cards_initial_range` CHECK (`initial` > 0),
  CONSTRAINT `ck_wallet_gift_cards_remaining_range` CHECK (`remaining` >= 0),
  CONSTRAINT `ck_wallet_gift_cards_state` CHECK (`state` IN ('issued', 'active', 'redeemed', 'voided', 'expired'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- wallet_credit_corrections: partial index: approval_request_id from "where `approval_request_id` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `wallet_credit_corrections` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `reference` TEXT NULL,
  `state` VARCHAR(32) NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `requested_by` TEXT NOT NULL,
  `decided_by` TEXT NULL,
  `decided_at` DATETIME(3) NULL,
  `ledger_entry_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `failure` TEXT NULL,
  `idempotency_key` VARCHAR(255) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wallet_credit_corrections_idempotency_key` (`idempotency_key`),
  KEY `ix_wallet_credit_corrections_1` (`customer_id`, `state`, `created_at`),
  KEY `ix_wallet_credit_corrections_2` (`approval_request_id`),
  CONSTRAINT `ck_wallet_credit_corrections_state` CHECK (`state` IN ('pending_approval', 'applied', 'rejected', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `wallet_loyalty_entries` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `points` INT NOT NULL,
  `kind` TEXT NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_wallet_loyalty_entries_1` (`customer_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `wallet_lots` ADD CONSTRAINT `fk_wallet_lots_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `wallet_accounts` (`customer_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `wallet_ledger` ADD CONSTRAINT `fk_wallet_ledger_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `wallet_accounts` (`customer_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `wallet_holds` ADD CONSTRAINT `fk_wallet_holds_customer_id` FOREIGN KEY (`customer_id`) REFERENCES `wallet_accounts` (`customer_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- append-only guards (§6.3)
CREATE TRIGGER `wallet_ledger_no_update` BEFORE UPDATE ON `wallet_ledger` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'wallet_ledger is append-only';

CREATE TRIGGER `wallet_ledger_no_delete` BEFORE DELETE ON `wallet_ledger` FOR EACH ROW
BEGIN
  IF COALESCE(@marketly_purge, '') <> 'wallet_ledger' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'wallet_ledger is append-only';
  END IF;
END
