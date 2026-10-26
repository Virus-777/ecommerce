-- rewards: MySQL schema generated from docs/api/spec/modules/rewards.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `rewards_program` (
  `id` VARCHAR(255) NOT NULL,
  `check_in_points` JSON NOT NULL,
  `enabled` TINYINT(1) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `updated_by` TEXT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `rewards_tasks` (
  `key` VARCHAR(255) NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `title` TEXT NOT NULL,
  `points` INT NOT NULL,
  `target` INT NOT NULL,
  `path` TEXT NULL,
  `visible` TINYINT(1) NOT NULL,
  `position` INT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`key`),
  KEY `ix_rewards_tasks_1` (`visible`, `position`),
  CONSTRAINT `ck_rewards_tasks_kind` CHECK (`kind` IN ('visit_store', 'share_product', 'write_review', 'place_order'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `rewards_accounts` (
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `balance` INT NOT NULL,
  `streak` INT NOT NULL,
  `last_check_in` DATE NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`customer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `rewards_entries` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `points` INT NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `title` TEXT NOT NULL,
  `ref` TEXT NULL,
  `dedupe_key` VARCHAR(255) NOT NULL,
  `balance_after` INT NOT NULL,
  `by` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rewards_entries_dedupe_key` (`dedupe_key`),
  KEY `ix_rewards_entries_1` (`customer_id`, `at`),
  CONSTRAINT `ck_rewards_entries_kind` CHECK (`kind` IN ('check_in', 'task', 'redeem', 'adjust'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `rewards_progress` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `task_key` VARCHAR(255) NOT NULL,
  `day` DATE NOT NULL,
  `count` INT NOT NULL,
  `refs` JSON NOT NULL,
  `claimed` TINYINT(1) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rewards_progress_1` (`customer_id`, `task_key`, `day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `rewards_rewards` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `title` TEXT NOT NULL,
  `condition` TEXT NOT NULL,
  `cost` INT NOT NULL,
  `tint` TEXT NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock` INT NULL,
  `redeemed` INT NOT NULL,
  `visible` TINYINT(1) NOT NULL,
  `position` INT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_rewards_rewards_1` (`visible`, `position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `rewards_redemptions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reward_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `title` TEXT NOT NULL,
  `condition` TEXT NOT NULL,
  `cost` INT NOT NULL,
  `code_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `code` TEXT NOT NULL,
  `ends_at` DATETIME(3) NULL,
  `idempotency_key` VARCHAR(255) NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rewards_redemptions_idempotency_key` (`idempotency_key`),
  KEY `ix_rewards_redemptions_1` (`customer_id`, `at`),
  KEY `ix_rewards_redemptions_2` (`reward_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `rewards_redemptions` ADD CONSTRAINT `fk_rewards_redemptions_reward_id` FOREIGN KEY (`reward_id`) REFERENCES `rewards_rewards` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
