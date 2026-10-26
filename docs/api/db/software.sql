-- software: MySQL schema generated from docs/api/spec/modules/software.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `software_categories` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `icon` TEXT NULL,
  `position` INT NOT NULL,
  `visible` TINYINT(1) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_software_categories_slug` (`slug`),
  KEY `ix_software_categories_1` (`position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `software_apps` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `title` TEXT NOT NULL,
  `company` JSON NOT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `subcategory` TEXT NULL,
  `brief` TEXT NOT NULL,
  `icon_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `screenshot_ids` JSON NOT NULL,
  `description` TEXT NOT NULL,
  `more_description` TEXT NULL,
  `what_you_get` JSON NOT NULL,
  `free` TINYINT(1) NOT NULL,
  `price` BIGINT NULL,
  `sale_price` BIGINT NULL,
  `sale_ends_at` DATETIME(3) NULL,
  `currency` TEXT NOT NULL,
  `licence_label` TEXT NULL,
  `licence_devices` INT NULL,
  `package` JSON NULL,
  `databases` JSON NOT NULL,
  `databases_note` TEXT NULL,
  `size_bytes` BIGINT NOT NULL,
  `version` TEXT NULL,
  `released_at` DATE NULL,
  `whats_new` TEXT NULL,
  `version_history` JSON NOT NULL,
  `platforms` JSON NOT NULL,
  `platform_labels` JSON NOT NULL,
  `min_requirements` TEXT NULL,
  `notice` TEXT NULL,
  `permissions` JSON NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `show_in_department` TINYINT(1) NOT NULL,
  `allow_reviews` TINYINT(1) NOT NULL,
  `position` INT NOT NULL,
  `views` BIGINT NOT NULL,
  `downloads` BIGINT NOT NULL,
  `owners` INT NOT NULL,
  `rating_sum` INT NOT NULL,
  `rating_count` INT NOT NULL,
  `rating_stars` JSON NOT NULL,
  `search_text` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `updated_by` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_software_apps_slug` (`slug`),
  KEY `ix_software_apps_1` (`status`, `show_in_department`, `category_id`, `position`),
  KEY `ix_software_apps_2` (`status`, `released_at`),
  KEY `ix_software_apps_3` (`status`, `sale_ends_at`),
  KEY `ix_software_apps_4` (`status`, `rating_count`),
  CONSTRAINT `ck_software_apps_status` CHECK (`status` IN ('draft', 'in_review', 'published', 'hidden'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `software_packs` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `summary` TEXT NULL,
  `app_ids` JSON NOT NULL,
  `price` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `licence_label` TEXT NULL,
  `visible` TINYINT(1) NOT NULL,
  `position` INT NOT NULL,
  `sold` INT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_software_packs_slug` (`slug`),
  KEY `ix_software_packs_1` (`visible`, `position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `software_rails` (
  `key` VARCHAR(255) NOT NULL,
  `title` TEXT NOT NULL,
  `source` TEXT NOT NULL,
  `style` TEXT NOT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `platform` TEXT NULL,
  `app_ids` JSON NOT NULL,
  `limit` INT NOT NULL,
  `visible` TINYINT(1) NOT NULL,
  `position` INT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`key`),
  KEY `ix_software_rails_1` (`position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `software_purchases` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `app_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `pack_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `title` TEXT NOT NULL,
  `items` JSON NOT NULL,
  `amount` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `intent_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `attempts` INT NOT NULL,
  `method_label` TEXT NULL,
  `decline_message` TEXT NULL,
  `idempotency_key` VARCHAR(255) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `paid_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_software_purchases_ref` (`ref`),
  UNIQUE KEY `uq_software_purchases_idempotency_key` (`idempotency_key`),
  KEY `ix_software_purchases_1` (`customer_id`, `created_at`),
  KEY `ix_software_purchases_2` (`status`, `created_at`),
  KEY `ix_software_purchases_3` (`intent_id`),
  CONSTRAINT `ck_software_purchases_status` CHECK (`status` IN ('pending_payment', 'requires_action', 'paid', 'failed', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `software_entitlements` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `app_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source` VARCHAR(32) NOT NULL,
  `purchase_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `granted_by` TEXT NULL,
  `licence_key` VARCHAR(255) NULL,
  `licence_issued_at` DATETIME(3) NULL,
  `licence_reissues` INT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_software_entitlements_licence_key` (`licence_key`),
  UNIQUE KEY `uq_software_entitlements_1` (`customer_id`, `app_id`),
  KEY `ix_software_entitlements_2` (`app_id`),
  KEY `ix_software_entitlements_3` (`created_at`),
  CONSTRAINT `ck_software_entitlements_source` CHECK (`source` IN ('free', 'purchase', 'pack', 'staff'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `software_reviews` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `app_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` TEXT NOT NULL,
  `stars` INT NOT NULL,
  `text` TEXT NULL,
  `hidden` TINYINT(1) NOT NULL,
  `hidden_reason` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_software_reviews_1` (`app_id`, `customer_id`),
  KEY `ix_software_reviews_2` (`app_id`, `hidden`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `software_apps` ADD CONSTRAINT `fk_software_apps_category_id` FOREIGN KEY (`category_id`) REFERENCES `software_categories` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `software_entitlements` ADD CONSTRAINT `fk_software_entitlements_app_id` FOREIGN KEY (`app_id`) REFERENCES `software_apps` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `software_reviews` ADD CONSTRAINT `fk_software_reviews_app_id` FOREIGN KEY (`app_id`) REFERENCES `software_apps` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
