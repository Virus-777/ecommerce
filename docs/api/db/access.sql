-- access: MySQL schema generated from docs/api/spec/modules/access.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `access_roles` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `key` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `work_area` TEXT NOT NULL,
  `description` TEXT NULL,
  `system` TINYINT(1) NOT NULL,
  `escalation_role_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `archived_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `version` INT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_access_roles_key` (`key`),
  CONSTRAINT `ck_access_roles_kind` CHECK (`kind` IN ('owner', 'management', 'task', 'custom'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `access_permissions` (
  `key` VARCHAR(255) NOT NULL,
  `module` VARCHAR(255) NOT NULL,
  `area` TEXT NOT NULL,
  `label` TEXT NOT NULL,
  `description` TEXT NOT NULL,
  `sensitive` TINYINT(1) NOT NULL,
  `registered_at` DATETIME(3) NOT NULL,
  `unavailable_since` DATETIME(3) NULL,
  PRIMARY KEY (`key`),
  KEY `ix_access_permissions_1` (`module`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `access_role_permissions` (
  `role_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `permission_key` VARCHAR(255) NOT NULL,
  `granted_by` TEXT NOT NULL,
  `granted_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`role_id`, `permission_key`),
  KEY `ix_access_role_permissions_2` (`permission_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- access_role_assignments: partial index: account_id plus status from "where `status` = 'active'" — confirm the column order with EXPLAIN in Y2
-- access_role_assignments: partial index: role_id plus status from "where `status` = 'active'" — confirm the column order with EXPLAIN in Y2
-- access_role_assignments: partial unique on account_id, role_id where `status` IN ('active', 'pending_acceptance', 'pending_approval')
CREATE TABLE `access_role_assignments` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `role_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `granted_by_kind` TEXT NOT NULL,
  `granted_by_id` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `granted_at` DATETIME(3) NOT NULL,
  `expires_at` DATETIME(3) NULL,
  `revoked_at` DATETIME(3) NULL,
  `revoked_by` TEXT NULL,
  `revoke_reason` TEXT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  KEY `ix_access_role_assignments_1` (`account_id`, `status`),
  KEY `ix_access_role_assignments_2` (`role_id`, `status`),
  UNIQUE KEY `uq_access_role_assignments_3` ((IF(`status` IN ('active', 'pending_acceptance', 'pending_approval'), `account_id`, NULL)), `role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `access_role_coverage` (
  `role_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `lead_account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `backup_account_ids` JSON NOT NULL,
  `updated_by` TEXT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `access_approval_actions` (
  `key` VARCHAR(255) NOT NULL,
  `module` TEXT NOT NULL,
  `label` TEXT NOT NULL,
  `limit_kind` VARCHAR(32) NOT NULL,
  `second_reviewer` VARCHAR(32) NOT NULL,
  `approvers` TEXT NULL,
  `default_eligible_role_keys` JSON NOT NULL,
  `unavailable_since` DATETIME(3) NULL,
  PRIMARY KEY (`key`),
  CONSTRAINT `ck_access_approval_actions_limit_kind` CHECK (`limit_kind` IN ('money', 'units', 'percent', 'none')),
  CONSTRAINT `ck_access_approval_actions_second_reviewer` CHECK (`second_reviewer` IN ('always', 'above-limit', 'never'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `access_approval_limits` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `role_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `action_key` VARCHAR(255) NOT NULL,
  `authority` TEXT NOT NULL,
  `limit_amount_minor` BIGINT NULL,
  `limit_currency` TEXT NULL,
  `limit_number` DECIMAL(14,4) NULL,
  `second_above_amount_minor` BIGINT NULL,
  `second_above_number` DECIMAL(14,4) NULL,
  `second_reviewer_role_keys` JSON NOT NULL,
  `effective_from` DATETIME(3) NOT NULL,
  `effective_to` DATETIME(3) NULL,
  `limit_change_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  KEY `ix_access_approval_limits_1` (`role_id`, `action_key`, `effective_from` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `access_limit_changes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `role_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `changes` JSON NOT NULL,
  `reason` TEXT NOT NULL,
  `effective_from` DATETIME(3) NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `proposed_by_kind` TEXT NOT NULL,
  `proposed_by_id` TEXT NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_at` DATETIME(3) NOT NULL,
  `applied_at` DATETIME(3) NULL,
  `cancel_reason` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_access_limit_changes_1` (`status`, `effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- access_approval_requests: partial unique on action_key, target_type, target_id where `status` IN ('pending', 'partially_approved', 'returned')
CREATE TABLE `access_approval_requests` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `action_key` VARCHAR(255) NOT NULL,
  `module` VARCHAR(255) NOT NULL,
  `target_type` VARCHAR(255) NOT NULL,
  `target_id` VARCHAR(255) NOT NULL,
  `target_ref` TEXT NULL,
  `target_label` TEXT NULL,
  `target_screen` TEXT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `amount_minor` BIGINT NULL,
  `currency` TEXT NULL,
  `quantity` DECIMAL(14,4) NULL,
  `summary` TEXT NOT NULL,
  `details` JSON NOT NULL,
  `reason` TEXT NOT NULL,
  `requested_by_kind` TEXT NOT NULL,
  `requested_by_id` VARCHAR(255) NOT NULL,
  `requester_roles` JSON NOT NULL,
  `requester_counts_as_first` TINYINT(1) NOT NULL,
  `required_approvals` INT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `eligible_role_keys` JSON NOT NULL,
  `nominated_reviewer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `limit_snapshot` JSON NOT NULL,
  `due_at` DATETIME(3) NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `decided_at` DATETIME(3) NULL,
  `outcome_reason` TEXT NULL,
  `last_reminded_at` DATETIME(3) NULL,
  `version` INT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_access_approval_requests_ref` (`ref`),
  KEY `ix_access_approval_requests_1` (`status`, `created_at`),
  KEY `ix_access_approval_requests_2` (`module`, `target_type`, `target_id`),
  KEY `ix_access_approval_requests_3` (`requested_by_id`, `status`),
  UNIQUE KEY `uq_access_approval_requests_4` ((IF(`status` IN ('pending', 'partially_approved', 'returned'), `action_key`, NULL)), `target_type`, `target_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- access_approval_decisions: partial unique on request_id, by_account_id where `decision` = 'approved'
CREATE TABLE `access_approval_decisions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `step` INT NOT NULL,
  `decision` VARCHAR(255) NOT NULL,
  `by_account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `roles` JSON NOT NULL,
  `note` TEXT NULL,
  `via_delegation_from` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_access_approval_decisions_1` (`request_id`, `step`),
  UNIQUE KEY `uq_access_approval_decisions_2` ((IF(`decision` = 'approved', `request_id`, NULL)), `by_account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `access_away_periods` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `starts_at` DATETIME(3) NOT NULL,
  `ends_at` DATETIME(3) NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `delegate_approvals` TINYINT(1) NOT NULL,
  `reason` TEXT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_by_kind` TEXT NOT NULL,
  `created_by_id` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `ended_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_access_away_periods_1` (`account_id`, `starts_at`),
  KEY `ix_access_away_periods_2` (`status`, `starts_at`),
  KEY `ix_access_away_periods_3` (`status`, `ends_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `access_away_coverage` (
  `away_period_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `role_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `covered_by_account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (`away_period_id`, `role_id`),
  KEY `ix_access_away_coverage_2` (`covered_by_account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `access_roles` ADD CONSTRAINT `fk_access_roles_escalation_role_id` FOREIGN KEY (`escalation_role_id`) REFERENCES `access_roles` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `access_role_permissions` ADD CONSTRAINT `fk_access_role_permissions_role_id` FOREIGN KEY (`role_id`) REFERENCES `access_roles` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `access_role_permissions` ADD CONSTRAINT `fk_access_role_permissions_permission_key` FOREIGN KEY (`permission_key`) REFERENCES `access_permissions` (`key`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `access_role_assignments` ADD CONSTRAINT `fk_access_role_assignments_role_id` FOREIGN KEY (`role_id`) REFERENCES `access_roles` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `access_role_assignments` ADD CONSTRAINT `fk_access_role_assignments_approval_request_id` FOREIGN KEY (`approval_request_id`) REFERENCES `access_approval_requests` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `access_role_coverage` ADD CONSTRAINT `fk_access_role_coverage_role_id` FOREIGN KEY (`role_id`) REFERENCES `access_roles` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `access_approval_limits` ADD CONSTRAINT `fk_access_approval_limits_role_id` FOREIGN KEY (`role_id`) REFERENCES `access_roles` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `access_approval_limits` ADD CONSTRAINT `fk_access_approval_limits_action_key` FOREIGN KEY (`action_key`) REFERENCES `access_approval_actions` (`key`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `access_approval_limits` ADD CONSTRAINT `fk_access_approval_limits_limit_change_id` FOREIGN KEY (`limit_change_id`) REFERENCES `access_limit_changes` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `access_limit_changes` ADD CONSTRAINT `fk_access_limit_changes_role_id` FOREIGN KEY (`role_id`) REFERENCES `access_roles` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `access_limit_changes` ADD CONSTRAINT `fk_access_limit_changes_approval_request_id` FOREIGN KEY (`approval_request_id`) REFERENCES `access_approval_requests` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `access_approval_decisions` ADD CONSTRAINT `fk_access_approval_decisions_request_id` FOREIGN KEY (`request_id`) REFERENCES `access_approval_requests` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `access_away_periods` ADD CONSTRAINT `fk_access_away_periods_approval_request_id` FOREIGN KEY (`approval_request_id`) REFERENCES `access_approval_requests` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `access_away_coverage` ADD CONSTRAINT `fk_access_away_coverage_away_period_id` FOREIGN KEY (`away_period_id`) REFERENCES `access_away_periods` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `access_away_coverage` ADD CONSTRAINT `fk_access_away_coverage_role_id` FOREIGN KEY (`role_id`) REFERENCES `access_roles` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
