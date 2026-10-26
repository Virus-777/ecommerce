-- settings: MySQL schema generated from docs/api/spec/modules/settings.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `settings_definitions` (
  `key` VARCHAR(255) NOT NULL,
  `module` VARCHAR(255) NOT NULL,
  `section` VARCHAR(255) NOT NULL,
  `label` TEXT NOT NULL,
  `description` TEXT NOT NULL,
  `value_type` TEXT NOT NULL,
  `schema` JSON NOT NULL,
  `default_value` JSON NOT NULL,
  `editable` TINYINT(1) NOT NULL,
  `approval` TEXT NOT NULL,
  `min_lead_days` INT NOT NULL,
  `apply_scopes` JSON NOT NULL,
  `seller_visible` TINYINT(1) NOT NULL,
  `public` TINYINT(1) NOT NULL,
  `example_value` TINYINT(1) NOT NULL,
  `edit_permission` TEXT NOT NULL,
  `registered_at` DATETIME(3) NOT NULL,
  `unavailable_since` DATETIME(3) NULL,
  PRIMARY KEY (`key`),
  KEY `ix_settings_definitions_1` (`module`),
  KEY `ix_settings_definitions_2` (`section`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `settings_values` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `key` VARCHAR(255) NOT NULL,
  `version` INT NOT NULL,
  `value` JSON NOT NULL,
  `effective_from` DATETIME(3) NOT NULL,
  `effective_to` DATETIME(3) NULL,
  `apply_scope` TEXT NOT NULL,
  `change_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `changed_by_kind` TEXT NOT NULL,
  `changed_by_id` TEXT NOT NULL,
  `approved_by_id` TEXT NULL,
  `reason` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_settings_values_1` (`key`, `version`),
  KEY `ix_settings_values_2` (`key`, `effective_from` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `settings_changes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `items` JSON NOT NULL,
  `effective_at` DATETIME(3) NOT NULL,
  `apply_scope` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `impact` JSON NOT NULL,
  `created_by_kind` TEXT NOT NULL,
  `created_by_id` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `submitted_at` DATETIME(3) NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `applied_at` DATETIME(3) NULL,
  `cancel_reason` TEXT NULL,
  `version` INT NOT NULL,
  `announced_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_settings_changes_ref` (`ref`),
  KEY `ix_settings_changes_1` (`status`, `effective_at`),
  KEY `ix_settings_changes_2` (`created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- settings_change_keys: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
-- settings_change_keys: partial unique on key where `open` = 1
CREATE TABLE `settings_change_keys` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `change_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `key` VARCHAR(255) NOT NULL,
  `open` TINYINT(1) NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_settings_change_keys_1` ((IF(`open` = 1, `key`, NULL)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `settings_feature_flags` (
  `key` VARCHAR(255) NOT NULL,
  `module` TEXT NOT NULL,
  `label` TEXT NOT NULL,
  `description` TEXT NOT NULL,
  `enabled` TINYINT(1) NOT NULL,
  `rollout` TEXT NOT NULL,
  `percentage` INT NULL,
  `public` TINYINT(1) NOT NULL,
  `planned_phase` INT NULL,
  `updated_by` TEXT NULL,
  `updated_at` DATETIME(3) NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `settings_values` ADD CONSTRAINT `fk_settings_values_key` FOREIGN KEY (`key`) REFERENCES `settings_definitions` (`key`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `settings_values` ADD CONSTRAINT `fk_settings_values_change_id` FOREIGN KEY (`change_id`) REFERENCES `settings_changes` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `settings_change_keys` ADD CONSTRAINT `fk_settings_change_keys_change_id` FOREIGN KEY (`change_id`) REFERENCES `settings_changes` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
