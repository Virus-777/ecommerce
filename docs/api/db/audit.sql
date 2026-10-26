-- audit: MySQL schema generated from docs/api/spec/modules/audit.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

-- audit_entries: partial index: seller_id, at plus visible_to_seller from "where `visible_to_seller` = 1" — confirm the column order with EXPLAIN in Y2
-- audit_entries: multi-valued index on search_words: queried with MEMBER OF, one per value for an AND (§8.1)
-- audit_entries: append-only: UPDATE and DELETE are refused; a retention purge sets @marketly_purge = 'audit_entries' in its own session (§6.3)
CREATE TABLE `audit_entries` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seq` BIGINT NOT NULL AUTO_INCREMENT,
  `at` DATETIME(3) NOT NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` VARCHAR(255) NULL,
  `actor_name` TEXT NULL,
  `actor_roles` JSON NOT NULL,
  `action` TEXT NOT NULL,
  `action_label` TEXT NOT NULL,
  `module` TEXT NOT NULL,
  `category` VARCHAR(255) NOT NULL,
  `target_type` VARCHAR(255) NOT NULL,
  `target_id` VARCHAR(255) NOT NULL,
  `target_ref` TEXT NULL,
  `target_label` TEXT NULL,
  `target_screen` TEXT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `reason` TEXT NULL,
  `before` JSON NULL,
  `after` JSON NULL,
  `before_text` TEXT NULL,
  `after_text` TEXT NULL,
  `evidence` JSON NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `approval_note` TEXT NULL,
  `request_id` TEXT NULL,
  `ip` VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `visible_to_seller` TINYINT(1) NOT NULL,
  `search_words` JSON NOT NULL,
  `prev_hash` BINARY(32) NOT NULL,
  `hash` BINARY(32) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_audit_entries_seq` (`seq`),
  KEY `ix_audit_entries_1` (`at` DESC, `id`),
  KEY `ix_audit_entries_2` (`target_type`, `target_id`, `at` DESC),
  KEY `ix_audit_entries_3` (`actor_id`, `at` DESC),
  KEY `ix_audit_entries_4` (`category`, `at` DESC),
  KEY `ix_audit_entries_5` (`seller_id`, `at` DESC, `visible_to_seller`),
  KEY `ix_audit_entries_6` (`approval_request_id`),
  KEY `mv_audit_entries_7` ((CAST(`search_words` AS CHAR(64) ARRAY)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- audit_entry_targets: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
-- audit_entry_targets: append-only: UPDATE and DELETE are refused; a retention purge sets @marketly_purge = 'audit_entry_targets' in its own session (§6.3)
CREATE TABLE `audit_entry_targets` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `entry_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `target_type` VARCHAR(255) NOT NULL,
  `target_id` VARCHAR(255) NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`row_id`),
  KEY `ix_audit_entry_targets_1` (`target_type`, `target_id`, `at` DESC),
  KEY `ix_audit_entry_targets_2` (`entry_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `audit_approval_states` (
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `approvers` JSON NOT NULL,
  `steps` JSON NOT NULL,
  `awaiting` TEXT NULL,
  `decided_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`approval_request_id`),
  KEY `ix_audit_approval_states_1` (`state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `audit_retention` (
  `id` INT NOT NULL,
  `retain_years` INT NOT NULL,
  `pending_years` INT NULL,
  `pending_reason` TEXT NULL,
  `pending_approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `pending_requested_by` TEXT NULL,
  `updated_by` TEXT NULL,
  `updated_at` DATETIME(3) NULL,
  `last_purge_at` DATETIME(3) NULL,
  `last_purge_removed` BIGINT NULL,
  `last_purge_through` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `ck_audit_retention_id_range` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- audit_checkpoints: append-only: UPDATE and DELETE are refused; a retention purge sets @marketly_purge = 'audit_checkpoints' in its own session (§6.3)
CREATE TABLE `audit_checkpoints` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seq` BIGINT NOT NULL,
  `hash` BINARY(32) NOT NULL,
  `mac` TEXT NOT NULL,
  `key_id` TEXT NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_audit_checkpoints_seq` (`seq`),
  KEY `ix_audit_checkpoints_1` (`created_at` DESC),
  CONSTRAINT `ck_audit_checkpoints_kind` CHECK (`kind` IN ('verified', 'purge'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `audit_integrity_checks` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `started_at` DATETIME(3) NOT NULL,
  `finished_at` DATETIME(3) NULL,
  `from_seq` BIGINT NOT NULL,
  `to_seq` BIGINT NOT NULL,
  `ok` TINYINT(1) NULL,
  `broken_at_seq` BIGINT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_audit_integrity_checks_1` (`started_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- append-only guards (§6.3)
CREATE TRIGGER `audit_entries_no_update` BEFORE UPDATE ON `audit_entries` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_entries is append-only';

CREATE TRIGGER `audit_entries_no_delete` BEFORE DELETE ON `audit_entries` FOR EACH ROW
BEGIN
  IF COALESCE(@marketly_purge, '') <> 'audit_entries' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_entries is append-only';
  END IF;
END

CREATE TRIGGER `audit_entry_targets_no_update` BEFORE UPDATE ON `audit_entry_targets` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_entry_targets is append-only';

CREATE TRIGGER `audit_entry_targets_no_delete` BEFORE DELETE ON `audit_entry_targets` FOR EACH ROW
BEGIN
  IF COALESCE(@marketly_purge, '') <> 'audit_entry_targets' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_entry_targets is append-only';
  END IF;
END

CREATE TRIGGER `audit_checkpoints_no_update` BEFORE UPDATE ON `audit_checkpoints` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_checkpoints is append-only';

CREATE TRIGGER `audit_checkpoints_no_delete` BEFORE DELETE ON `audit_checkpoints` FOR EACH ROW
BEGIN
  IF COALESCE(@marketly_purge, '') <> 'audit_checkpoints' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_checkpoints is append-only';
  END IF;
END
