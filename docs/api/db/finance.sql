-- finance: MySQL schema generated from docs/api/spec/modules/finance.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `finance_seller_accounts` (
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `pending` BIGINT NOT NULL,
  `available` BIGINT NOT NULL,
  `held` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `negative_since` DATETIME(3) NULL,
  `payouts_blocked_reason` TEXT NULL,
  `fee_override_set_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `new_seller_until` DATE NULL,
  `new_seller_extra_days` INT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`seller_id`),
  KEY `ix_finance_seller_accounts_1` (`updated_at` DESC, `seller_id` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- finance_ledger_entries: append-only: UPDATE and DELETE are refused; a retention purge sets @marketly_purge = 'finance_ledger_entries' in its own session (§6.3)
CREATE TABLE `finance_ledger_entries` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `at` DATETIME(3) NOT NULL,
  `type` VARCHAR(255) NOT NULL,
  `ref_kind` VARCHAR(255) NOT NULL,
  `ref_id` VARCHAR(255) NOT NULL,
  `ref_label` TEXT NULL,
  `description` TEXT NOT NULL,
  `amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `bucket` TEXT NOT NULL,
  `balance_after` BIGINT NOT NULL,
  `lot_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `statement_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `recorded_by` TEXT NULL,
  `source_event_id` VARCHAR(255) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_finance_ledger_entries_source_event_id` (`source_event_id`),
  KEY `ix_finance_ledger_entries_1` (`seller_id`, `at` DESC),
  KEY `ix_finance_ledger_entries_2` (`ref_kind`, `ref_id`),
  KEY `ix_finance_ledger_entries_3` (`statement_id`),
  KEY `ix_finance_ledger_entries_4` (`lot_id`),
  KEY `ix_finance_ledger_entries_5` (`type`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_earnings_lots` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `gross` BIGINT NOT NULL,
  `fee` BIGINT NOT NULL,
  `net` BIGINT NOT NULL,
  `delivered_at` DATETIME(3) NULL,
  `available_at` DATETIME(3) NULL,
  `payout_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `left_pending_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_finance_earnings_lots_order_item_id` (`order_item_id`),
  KEY `ix_finance_earnings_lots_1` (`state`, `available_at`),
  KEY `ix_finance_earnings_lots_2` (`seller_id`, `state`),
  KEY `ix_finance_earnings_lots_3` (`payout_id`),
  KEY `ix_finance_earnings_lots_4` (`order_id`),
  KEY `ix_finance_earnings_lots_5` (`left_pending_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_fee_rule_sets` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `version` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `basis` TEXT NOT NULL,
  `include_shipping` TINYINT(1) NOT NULL,
  `platform_discounts_reduce_fee` TINYINT(1) NOT NULL,
  `default_rate_bps` INT NOT NULL,
  `treatment` JSON NOT NULL,
  `agreement_version` TEXT NOT NULL,
  `effective_from` DATETIME(3) NULL,
  `reason` TEXT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_by` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_finance_fee_rule_sets_1` (`status`, `effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- finance_fee_category_rates: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `finance_fee_category_rates` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `rule_set_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `category_name` TEXT NOT NULL,
  `rate_bps` INT NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_finance_fee_category_rates_1` (`rule_set_id`, `category_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_fee_charges` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `rule_set_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `basis_amount` BIGINT NOT NULL,
  `rate_bps` INT NOT NULL,
  `fee` BIGINT NOT NULL,
  `refunded_fee` BIGINT NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `changed_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_finance_fee_charges_order_item_id` (`order_item_id`),
  KEY `ix_finance_fee_charges_1` (`changed_at`, `id`),
  CONSTRAINT `ck_finance_fee_charges_status` CHECK (`status` IN ('charged', 'kept_disputed', 'reversed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_refund_allocations` (
  `refund_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `payment_refund_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_type` VARCHAR(32) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `funded_by` TEXT NOT NULL,
  `seller_share` BIGINT NOT NULL,
  `platform_share` BIGINT NOT NULL,
  `breakdown` JSON NOT NULL,
  `applied_at` DATETIME(3) NULL,
  PRIMARY KEY (`refund_request_id`),
  KEY `ix_finance_refund_allocations_1` (`payment_refund_id`),
  KEY `ix_finance_refund_allocations_2` (`applied_at`),
  CONSTRAINT `ck_finance_refund_allocations_owner_type` CHECK (`owner_type` IN ('official', 'seller'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_holds` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `amount` BIGINT NOT NULL,
  `released_amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `reason_code` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `review_date` DATE NOT NULL,
  `ref_kind` VARCHAR(255) NULL,
  `ref_id` VARCHAR(255) NULL,
  `status` VARCHAR(255) NOT NULL,
  `placed_by` TEXT NOT NULL,
  `placed_at` DATETIME(3) NOT NULL,
  `released_at` DATETIME(3) NULL,
  `release_reason` TEXT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `trust_report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  KEY `ix_finance_holds_1` (`seller_id`, `status`),
  KEY `ix_finance_holds_2` (`status`, `review_date`),
  KEY `ix_finance_holds_3` (`ref_kind`, `ref_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_adjustments` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `direction` TEXT NOT NULL,
  `amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `reason_code` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `ref_kind` TEXT NULL,
  `ref_id` TEXT NULL,
  `status` VARCHAR(255) NOT NULL,
  `recorded_by` TEXT NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `idempotency_key` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_finance_adjustments_ref` (`ref`),
  UNIQUE KEY `uq_finance_adjustments_idempotency_key` (`idempotency_key`),
  KEY `ix_finance_adjustments_1` (`seller_id`, `created_at` DESC),
  KEY `ix_finance_adjustments_2` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_seller_credits` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `ref_kind` TEXT NOT NULL,
  `ref_id` TEXT NOT NULL,
  `ref_label` TEXT NULL,
  `status` VARCHAR(32) NOT NULL,
  `idempotency_key` VARCHAR(255) NOT NULL,
  `requested_by` TEXT NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `ledger_entry_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_at` DATETIME(3) NOT NULL,
  `decided_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_finance_seller_credits_idempotency_key` (`idempotency_key`),
  KEY `ix_finance_seller_credits_1` (`seller_id`, `created_at` DESC),
  KEY `ix_finance_seller_credits_2` (`status`),
  CONSTRAINT `ck_finance_seller_credits_status` CHECK (`status` IN ('posted', 'pending_approval', 'rejected', 'withdrawn'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_amounts_owed` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `amount` BIGINT NOT NULL,
  `remaining` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `since` DATE NOT NULL,
  `due_by` DATE NULL,
  `status` VARCHAR(255) NOT NULL,
  `origin` JSON NOT NULL,
  `note` TEXT NULL,
  `write_off_amount` BIGINT NULL,
  `write_off_reason` TEXT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  KEY `ix_finance_amounts_owed_1` (`seller_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_payout_destinations` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `sellers_account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `label` TEXT NOT NULL,
  `provider_destination_id` TEXT NULL,
  `status` TEXT NOT NULL,
  `verified_at` DATETIME(3) NULL,
  `active` TINYINT(1) NOT NULL,
  `pause_until` DATETIME(3) NULL,
  `deposits_sent_at` DATETIME(3) NULL,
  `deposit_attempts` INT NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_finance_payout_destinations_1` (`seller_id`, `active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_destination_reviews` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `destination_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `from_label` TEXT NULL,
  `to_label` TEXT NOT NULL,
  `requested_by` TEXT NOT NULL,
  `requested_at` DATETIME(3) NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `checks` JSON NOT NULL,
  `decided_by` TEXT NULL,
  `decided_at` DATETIME(3) NULL,
  `reason` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_finance_destination_reviews_1` (`status`, `requested_at`),
  KEY `ix_finance_destination_reviews_2` (`seller_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- finance_payout_runs: partial unique on cutoff_at where `status` <> 'cancelled'
CREATE TABLE `finance_payout_runs` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `scheduled_release` DATETIME(3) NOT NULL,
  `cutoff_at` DATETIME(3) NOT NULL,
  `total` BIGINT NOT NULL,
  `paying_now` BIGINT NOT NULL,
  `held` BIGINT NOT NULL,
  `negative_offset` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `approvals` JSON NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_at` DATETIME(3) NOT NULL,
  `released_at` DATETIME(3) NULL,
  `completed_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_finance_payout_runs_ref` (`ref`),
  KEY `ix_finance_payout_runs_1` (`status`, `scheduled_release`),
  UNIQUE KEY `uq_finance_payout_runs_2` ((IF(`status` <> 'cancelled', `cutoff_at`, NULL))),
  CONSTRAINT `ck_finance_payout_runs_status` CHECK (`status` IN ('draft', 'pending_approval', 'approved', 'releasing', 'completed', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_payouts` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `run_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `destination_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `requested_on` DATE NOT NULL,
  `released_at` DATETIME(3) NULL,
  `paid_at` DATETIME(3) NULL,
  `failed_at` DATETIME(3) NULL,
  `failure_code` TEXT NULL,
  `failure_reason` TEXT NULL,
  `retry_of` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `provider_payout_id` VARCHAR(255) NULL,
  `bank_reference` TEXT NULL,
  `statement_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `holds_withheld` BIGINT NOT NULL,
  `negative_offset` BIGINT NOT NULL,
  `idempotency_key` VARCHAR(255) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_finance_payouts_ref` (`ref`),
  UNIQUE KEY `uq_finance_payouts_provider_payout_id` (`provider_payout_id`),
  UNIQUE KEY `uq_finance_payouts_idempotency_key` (`idempotency_key`),
  KEY `ix_finance_payouts_1` (`seller_id`, `requested_on` DESC),
  KEY `ix_finance_payouts_2` (`run_id`, `status`),
  KEY `ix_finance_payouts_3` (`status`, `paid_at`),
  KEY `ix_finance_payouts_4` (`retry_of`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_statements` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `period_from` DATE NOT NULL,
  `period_to` DATE NOT NULL,
  `status` TEXT NOT NULL,
  `issued_at` DATETIME(3) NULL,
  `payout_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `sections` JSON NOT NULL,
  `reconciliation` JSON NOT NULL,
  `rule_version` TEXT NOT NULL,
  `pdf_media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `csv_media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_finance_statements_ref` (`ref`),
  KEY `ix_finance_statements_1` (`seller_id`, `period_to` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_trading_entries` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `at` DATETIME(3) NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `ref_kind` VARCHAR(255) NULL,
  `ref_id` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_finance_trading_entries_1` (`at`),
  KEY `ix_finance_trading_entries_2` (`kind`, `at`),
  KEY `ix_finance_trading_entries_3` (`ref_kind`, `at`),
  CONSTRAINT `ck_finance_trading_entries_kind` CHECK (`kind` IN ('sale', 'cost_of_goods', 'buying_cost', 'discount', 'shipping_expense', 'return', 'write_off', 'chargeback_loss', 'supplier_credit'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_trading_targets` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `period` VARCHAR(255) NOT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `sales_target` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `margin_target_bps` INT NULL,
  `note` TEXT NULL,
  `set_by` TEXT NOT NULL,
  `set_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_finance_trading_targets_1` (`period`, `category_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_recon_days` (
  `date` DATE NOT NULL,
  `status` TEXT NOT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `backup_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `due_at` DATETIME(3) NOT NULL,
  `checklist` JSON NOT NULL,
  `completed_by` TEXT NULL,
  `completed_at` DATETIME(3) NULL,
  PRIMARY KEY (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_recon_items` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `date` DATE NOT NULL,
  `check` VARCHAR(255) NOT NULL,
  `ref_kind` TEXT NULL,
  `ref_id` TEXT NULL,
  `subject` TEXT NOT NULL,
  `description` TEXT NOT NULL,
  `expected` BIGINT NOT NULL,
  `actual` BIGINT NOT NULL,
  `credit` BIGINT NOT NULL,
  `difference` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `detected_at` DATETIME(3) NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `note` TEXT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `correction` JSON NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  KEY `ix_finance_recon_items_1` (`date`, `check`),
  KEY `ix_finance_recon_items_2` (`status`, `detected_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_captures` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `intent_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `card_amount` BIGINT NOT NULL,
  `credit_amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `provider_ref` TEXT NULL,
  `captured_at` DATETIME(3) NOT NULL,
  `recon_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  KEY `ix_finance_captures_1` (`captured_at`),
  KEY `ix_finance_captures_2` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_discount_funding` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `at` DATETIME(3) NOT NULL,
  `redemption_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `funded_by` VARCHAR(32) NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  KEY `ix_finance_discount_funding_1` (`at`),
  KEY `ix_finance_discount_funding_2` (`redemption_id`),
  CONSTRAINT `ck_finance_discount_funding_funded_by` CHECK (`funded_by` IN ('platform', 'seller')),
  CONSTRAINT `ck_finance_discount_funding_kind` CHECK (`kind` IN ('redeemed', 'reversed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_platform_costs` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `at` DATETIME(3) NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `ref_kind` VARCHAR(32) NULL,
  `ref_id` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_finance_platform_costs_1` (`at`),
  KEY `ix_finance_platform_costs_2` (`kind`, `at`),
  CONSTRAINT `ck_finance_platform_costs_kind` CHECK (`kind` IN ('label', 'refund', 'carrier_claim', 'goodwill_credit', 'credit_correction', 'credit_breakage', 'write_off')),
  CONSTRAINT `ck_finance_platform_costs_ref_kind` CHECK (`ref_kind` IN ('label', 'refund', 'claim', 'wallet_entry', 'amount_owed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `finance_store_credit_liability` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `at` DATETIME(3) NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `wallet_entry_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  KEY `ix_finance_store_credit_liability_1` (`at`),
  CONSTRAINT `ck_finance_store_credit_liability_kind` CHECK (`kind` IN ('granted', 'used', 'reversed', 'expired', 'corrected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `finance_fee_category_rates` ADD CONSTRAINT `fk_finance_fee_category_rates_rule_set_id` FOREIGN KEY (`rule_set_id`) REFERENCES `finance_fee_rule_sets` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `finance_fee_charges` ADD CONSTRAINT `fk_finance_fee_charges_rule_set_id` FOREIGN KEY (`rule_set_id`) REFERENCES `finance_fee_rule_sets` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `finance_seller_credits` ADD CONSTRAINT `fk_finance_seller_credits_ledger_entry_id` FOREIGN KEY (`ledger_entry_id`) REFERENCES `finance_ledger_entries` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `finance_destination_reviews` ADD CONSTRAINT `fk_finance_destination_reviews_destination_id` FOREIGN KEY (`destination_id`) REFERENCES `finance_payout_destinations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `finance_payouts` ADD CONSTRAINT `fk_finance_payouts_run_id` FOREIGN KEY (`run_id`) REFERENCES `finance_payout_runs` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `finance_payouts` ADD CONSTRAINT `fk_finance_payouts_destination_id` FOREIGN KEY (`destination_id`) REFERENCES `finance_payout_destinations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `finance_payouts` ADD CONSTRAINT `fk_finance_payouts_retry_of` FOREIGN KEY (`retry_of`) REFERENCES `finance_payouts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `finance_recon_items` ADD CONSTRAINT `fk_finance_recon_items_date` FOREIGN KEY (`date`) REFERENCES `finance_recon_days` (`date`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- views: join shapes, merged into the query that reads them (§9.2)
CREATE OR REPLACE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW `finance_v_statement_entries` AS
SELECT e.*,
  l.state AS lot_state, l.order_id, l.order_item_id, l.gross AS lot_gross, l.fee AS lot_fee, l.net AS lot_net,
  l.delivered_at AS lot_delivered_at, l.available_at AS lot_available_at,
  p.ref AS payout_ref, p.status AS payout_status, p.paid_at AS payout_paid_at, p.run_id,
  r.ref AS run_ref, r.status AS run_status, r.released_at AS run_released_at
FROM finance_ledger_entries e
LEFT JOIN finance_earnings_lots l ON l.id = e.lot_id
LEFT JOIN finance_payouts p ON p.id = l.payout_id
LEFT JOIN finance_payout_runs r ON r.id = p.run_id;

CREATE OR REPLACE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW `finance_v_lot_entries` AS
SELECT l.*,
  e.id AS entry_id, e.at AS entry_at, e.type AS entry_type, e.amount AS entry_amount,
  e.description AS entry_description, e.statement_id AS entry_statement_id
FROM finance_earnings_lots l
LEFT JOIN finance_ledger_entries e ON e.lot_id = l.id AND e.bucket = 'pending';

-- append-only guards (§6.3)
CREATE TRIGGER `finance_ledger_entries_no_update` BEFORE UPDATE ON `finance_ledger_entries` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_ledger_entries is append-only';

CREATE TRIGGER `finance_ledger_entries_no_delete` BEFORE DELETE ON `finance_ledger_entries` FOR EACH ROW
BEGIN
  IF COALESCE(@marketly_purge, '') <> 'finance_ledger_entries' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_ledger_entries is append-only';
  END IF;
END
