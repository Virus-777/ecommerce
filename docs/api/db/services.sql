-- services: MySQL schema generated from docs/api/spec/modules/services.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `services_categories` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `area` VARCHAR(255) NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `icon` TEXT NULL,
  `position` INT NOT NULL,
  `visible` TINYINT(1) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_services_categories_1` (`area`, `slug`),
  KEY `ix_services_categories_2` (`area`, `position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `services_providers` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `logo` JSON NULL,
  `cover` JSON NULL,
  `kind` TEXT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `city` TEXT NULL,
  `verified` TINYINT(1) NOT NULL,
  `photos` JSON NOT NULL,
  `description` TEXT NULL,
  `since` INT NULL,
  `contacts` JSON NOT NULL,
  `location` JSON NULL,
  `point` JSON NULL,
  `hours` JSON NOT NULL,
  `staff` JSON NOT NULL,
  `reply_time` TEXT NULL,
  `status` VARCHAR(255) NOT NULL,
  `rating_sum` INT NOT NULL,
  `rating_count` INT NOT NULL,
  `rating_stars` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_services_providers_slug` (`slug`),
  KEY `ix_services_providers_1` (`status`, `name`),
  KEY `ix_services_providers_2` (`category_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `services_services` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `area` VARCHAR(255) NOT NULL,
  `provider_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `title` TEXT NOT NULL,
  `summary` TEXT NULL,
  `image` JSON NULL,
  `photos` JSON NOT NULL,
  `badge` TEXT NULL,
  `from_price` BIGINT NULL,
  `currency` TEXT NOT NULL,
  `price_unit` TEXT NOT NULL,
  `duration_label` TEXT NULL,
  `supported_label` TEXT NULL,
  `coverage` TEXT NULL,
  `tags` JSON NOT NULL,
  `description` TEXT NULL,
  `included` JSON NOT NULL,
  `requirements` JSON NOT NULL,
  `supported` JSON NOT NULL,
  `os_versions` JSON NOT NULL,
  `handover` JSON NOT NULL,
  `price_table` JSON NOT NULL,
  `price_table_title` TEXT NULL,
  `terms` JSON NOT NULL,
  `full_terms` TEXT NULL,
  `covered_by_warranty` TINYINT(1) NOT NULL,
  `steps` JSON NOT NULL,
  `slot_minutes` INT NULL,
  `duration_minutes` INT NULL,
  `status` VARCHAR(255) NOT NULL,
  `position` INT NOT NULL,
  `rating_sum` INT NOT NULL,
  `rating_count` INT NOT NULL,
  `rating_stars` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_services_services_slug` (`slug`),
  KEY `ix_services_services_1` (`area`, `status`, `position`),
  KEY `ix_services_services_2` (`provider_id`, `status`, `position`),
  KEY `ix_services_services_3` (`category_id`, `status`, `position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `services_requests` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `area` VARCHAR(255) NOT NULL,
  `service_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `provider_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slot_start` DATETIME(3) NULL,
  `slot_end` DATETIME(3) NULL,
  `staff_id` TEXT NULL,
  `device_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `device` JSON NULL,
  `contact` JSON NOT NULL,
  `details` JSON NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `provider_note` TEXT NULL,
  `staff_note` TEXT NULL,
  `history` JSON NOT NULL,
  `reviewed` TINYINT(1) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_services_requests_ref` (`ref`),
  KEY `ix_services_requests_1` (`customer_id`, `created_at`),
  KEY `ix_services_requests_2` (`area`, `status`, `created_at`),
  KEY `ix_services_requests_3` (`provider_id`, `slot_start`),
  KEY `ix_services_requests_4` (`service_id`, `slot_start`),
  KEY `ix_services_requests_5` (`device_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `services_reviews` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `service_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `provider_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `author_name` TEXT NOT NULL,
  `rating` INT NOT NULL,
  `text` TEXT NULL,
  `status` VARCHAR(255) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_services_reviews_request_id` (`request_id`),
  KEY `ix_services_reviews_1` (`service_id`, `status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `services_saved_providers` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `provider_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_services_saved_providers_1` (`customer_id`, `provider_id`),
  KEY `ix_services_saved_providers_2` (`customer_id`, `created_at`),
  KEY `ix_services_saved_providers_3` (`provider_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `services_devices` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `brand` TEXT NOT NULL,
  `model` TEXT NOT NULL,
  `storage` TEXT NULL,
  `imei` VARCHAR(255) NOT NULL,
  `imei_last4` TEXT NOT NULL,
  `purchase_date` DATE NOT NULL,
  `order_ref` TEXT NULL,
  `status` VARCHAR(32) NOT NULL,
  `covered_until` DATE NULL,
  `reject_reason` TEXT NULL,
  `staff_note` TEXT NULL,
  `verified_at` DATETIME(3) NULL,
  `verified_by` TEXT NULL,
  `history` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_services_devices_1` (`customer_id`, `created_at`),
  KEY `ix_services_devices_2` (`status`, `created_at`),
  KEY `ix_services_devices_3` (`imei`),
  CONSTRAINT `ck_services_devices_status` CHECK (`status` IN ('pending', 'verified', 'rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `services_providers` ADD CONSTRAINT `fk_services_providers_category_id` FOREIGN KEY (`category_id`) REFERENCES `services_categories` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `services_services` ADD CONSTRAINT `fk_services_services_provider_id` FOREIGN KEY (`provider_id`) REFERENCES `services_providers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `services_services` ADD CONSTRAINT `fk_services_services_category_id` FOREIGN KEY (`category_id`) REFERENCES `services_categories` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `services_requests` ADD CONSTRAINT `fk_services_requests_service_id` FOREIGN KEY (`service_id`) REFERENCES `services_services` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `services_requests` ADD CONSTRAINT `fk_services_requests_provider_id` FOREIGN KEY (`provider_id`) REFERENCES `services_providers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `services_requests` ADD CONSTRAINT `fk_services_requests_device_id` FOREIGN KEY (`device_id`) REFERENCES `services_devices` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `services_reviews` ADD CONSTRAINT `fk_services_reviews_service_id` FOREIGN KEY (`service_id`) REFERENCES `services_services` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `services_reviews` ADD CONSTRAINT `fk_services_reviews_provider_id` FOREIGN KEY (`provider_id`) REFERENCES `services_providers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `services_reviews` ADD CONSTRAINT `fk_services_reviews_request_id` FOREIGN KEY (`request_id`) REFERENCES `services_requests` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `services_saved_providers` ADD CONSTRAINT `fk_services_saved_providers_provider_id` FOREIGN KEY (`provider_id`) REFERENCES `services_providers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
