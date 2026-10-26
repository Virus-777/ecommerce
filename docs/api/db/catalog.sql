-- catalog: MySQL schema generated from docs/api/spec/modules/catalog.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `catalog_categories` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `parent_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `name` TEXT NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `position` INT NOT NULL,
  `visible` TINYINT(1) NOT NULL,
  `coming_soon` TINYINT(1) NOT NULL,
  `image_media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_catalog_categories_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `catalog_attributes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` TEXT NOT NULL,
  `kind` TEXT NOT NULL,
  `unit` TEXT NULL,
  `options` JSON NOT NULL,
  `required` TINYINT(1) NOT NULL,
  `filterable` TINYINT(1) NOT NULL,
  `variant_defining` TINYINT(1) NOT NULL,
  `position` INT NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `catalog_image_standards` (
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `min_width` INT NOT NULL,
  `min_count` INT NOT NULL,
  `rules` JSON NOT NULL,
  PRIMARY KEY (`category_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `catalog_brands` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `logo_media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `description` TEXT NULL,
  `banner_media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `status` VARCHAR(32) NOT NULL,
  `status_reason` TEXT NULL,
  `flag_note` TEXT NULL,
  `trust_report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `selling_policy` VARCHAR(32) NOT NULL,
  `requested_by_seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `requested_for_product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `requested_change_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_catalog_brands_slug` (`slug`),
  KEY `ix_catalog_brands_1` (`status`, `name`),
  CONSTRAINT `ck_catalog_brands_status` CHECK (`status` IN ('active', 'under_review', 'blocked')),
  CONSTRAINT `ck_catalog_brands_selling_policy` CHECK (`selling_policy` IN ('open', 'authorized_list', 'official_only'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- catalog_products: tsvector columns are not stored: the search engine owns them (§5.1)
-- catalog_products: gin(search) is dropped: the column is tsvector, which is not stored; the search engine owns this index (§5.1, §14)
CREATE TABLE `catalog_products` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `title` TEXT NOT NULL,
  `slug` TEXT NOT NULL,
  `brand_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `description` TEXT NOT NULL,
  `key_features` JSON NOT NULL,
  `specs` JSON NOT NULL,
  `included_items` JSON NOT NULL,
  `media_ids` JSON NOT NULL,
  `video_media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `model_number` TEXT NULL,
  `mpn` TEXT NULL,
  `no_gtin` TINYINT(1) NOT NULL,
  `requested_brand` JSON NULL,
  `content_score` INT NOT NULL,
  `owner_type` VARCHAR(32) NOT NULL,
  `owner_seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `review_state` VARCHAR(255) NOT NULL,
  `publication` VARCHAR(255) NOT NULL,
  `version` INT NOT NULL,
  `merged_into_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `listed_at` DATETIME(3) NULL,
  `recrop_media_ids` JSON NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_catalog_products_ref` (`ref`),
  KEY `ix_catalog_products_1` (`review_state`, `id`),
  KEY `ix_catalog_products_2` (`category_id`, `id`),
  KEY `ix_catalog_products_3` (`owner_seller_id`, `id`),
  KEY `ix_catalog_products_5` (`publication`, `id`),
  KEY `ix_catalog_products_6` (`brand_id`, `id`),
  KEY `ix_catalog_products_7` (`updated_at`, `id`),
  CONSTRAINT `ck_catalog_products_owner_type` CHECK (`owner_type` IN ('official', 'seller'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `catalog_variants` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `options` JSON NOT NULL,
  `gtin` VARCHAR(255) NULL,
  `media_ids` JSON NOT NULL,
  `position` INT NOT NULL,
  `weight_grams` INT NULL,
  `length_cm` INT NULL,
  `width_cm` INT NULL,
  `height_cm` INT NULL,
  `list_price_amount` BIGINT NULL,
  `list_price_currency` CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_catalog_variants_gtin` (`gtin`),
  KEY `ix_catalog_variants_1` (`product_id`, `position`),
  CONSTRAINT `ck_catalog_variants_weight_grams_range` CHECK (`weight_grams` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `catalog_review_log` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `action` TEXT NOT NULL,
  `reason` TEXT NULL,
  `fields` JSON NOT NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_catalog_review_log_1` (`product_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `catalog_correction_suggestions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `field` TEXT NOT NULL,
  `current` TEXT NULL,
  `proposed` TEXT NOT NULL,
  `evidence_media_ids` JSON NOT NULL,
  `state` TEXT NOT NULL,
  `decision_reason` TEXT NULL,
  `decided_by` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `catalog_submissions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `state` VARCHAR(32) NOT NULL,
  `product_version` INT NOT NULL,
  `submitted_at` DATETIME(3) NOT NULL,
  `submitted_by` JSON NOT NULL,
  `last_saved_at` DATETIME(3) NULL,
  `last_saved_by` JSON NULL,
  `expected_review_by` DATETIME(3) NULL,
  `review_due_at` DATETIME(3) NULL,
  `paused_at` DATETIME(3) NULL,
  `assignee_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `assignee_name` TEXT NULL,
  `decided_at` DATETIME(3) NULL,
  `note` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_catalog_submissions_ref` (`ref`),
  KEY `ix_catalog_submissions_1` (`state`, `review_due_at`),
  KEY `ix_catalog_submissions_2` (`product_id`, `submitted_at` DESC),
  CONSTRAINT `ck_catalog_submissions_kind` CHECK (`kind` IN ('new', 'content_change', 'resubmitted')),
  CONSTRAINT `ck_catalog_submissions_state` CHECK (`state` IN ('open', 'decided', 'withdrawn'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `catalog_submission_checks` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `submission_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(255) NOT NULL,
  `result` VARCHAR(32) NOT NULL,
  `message` TEXT NOT NULL,
  `details` JSON NOT NULL,
  `evidence` JSON NOT NULL,
  `ran_at` DATETIME(3) NOT NULL,
  `dismissed_at` DATETIME(3) NULL,
  `dismissed_by` JSON NULL,
  `dismiss_reason` TEXT NULL,
  `dismissed_matched_product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  KEY `ix_catalog_submission_checks_1` (`submission_id`),
  KEY `ix_catalog_submission_checks_2` (`kind`, `result`),
  CONSTRAINT `ck_catalog_submission_checks_result` CHECK (`result` IN ('pass', 'warn', 'fail'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `catalog_check_dismissals` (
  `check_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `matched_product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `dismissed_at` DATETIME(3) NOT NULL,
  `dismissed_by` JSON NOT NULL,
  `reason` TEXT NOT NULL,
  PRIMARY KEY (`check_id`, `matched_product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `catalog_review_drafts` (
  `submission_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `decision` TEXT NULL,
  `reason` TEXT NULL,
  `fields` JSON NOT NULL,
  `saved_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`submission_id`, `staff_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `catalog_brand_authorized_sellers` (
  `brand_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `source` VARCHAR(32) NOT NULL,
  `added_by` JSON NOT NULL,
  `added_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`brand_id`, `seller_id`),
  KEY `ix_catalog_brand_authorized_sellers_2` (`seller_id`),
  CONSTRAINT `ck_catalog_brand_authorized_sellers_source` CHECK (`source` IN ('staff', 'claim'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `catalog_offer_index` (
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_type` VARCHAR(32) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `seller_name` TEXT NULL,
  `condition` TEXT NOT NULL,
  `status` TEXT NOT NULL,
  `eligible` TINYINT(1) NOT NULL,
  `in_stock` TINYINT(1) NOT NULL,
  `price` JSON NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`offer_id`),
  KEY `ix_catalog_offer_index_1` (`product_id`),
  KEY `ix_catalog_offer_index_2` (`seller_id`),
  CONSTRAINT `ck_catalog_offer_index_owner_type` CHECK (`owner_type` IN ('official', 'seller'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `catalog_listing_stats` (
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `offer_count` INT NOT NULL,
  `live_offer_count` INT NOT NULL,
  `in_stock` TINYINT(1) NOT NULL,
  `best_price` JSON NULL,
  `offer_note` TEXT NULL,
  `refreshed_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `catalog_category_stats` (
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_count` INT NOT NULL,
  `offer_count` INT NOT NULL,
  `refreshed_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`category_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- catalog_brand_stats: the spec's key (brand_id, category_id) has a nullable part (category_id), which MySQL will not accept in a PRIMARY KEY. An invisible row_id is the primary key and the declared key is a UNIQUE with COALESCE on the nullable parts, so a null still counts as a value (§5.3, §6.1)
CREATE TABLE `catalog_brand_stats` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `brand_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `product_count` INT NOT NULL,
  `offer_count` INT NOT NULL,
  `seller_count` INT NOT NULL,
  `refreshed_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_catalog_brand_stats_pk` (`brand_id`, (COALESCE(`category_id`, ''))),
  KEY `ix_catalog_brand_stats_2` (`category_id`, `product_count` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `catalog_categories` ADD CONSTRAINT `fk_catalog_categories_parent_id` FOREIGN KEY (`parent_id`) REFERENCES `catalog_categories` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_attributes` ADD CONSTRAINT `fk_catalog_attributes_category_id` FOREIGN KEY (`category_id`) REFERENCES `catalog_categories` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_image_standards` ADD CONSTRAINT `fk_catalog_image_standards_category_id` FOREIGN KEY (`category_id`) REFERENCES `catalog_categories` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_products` ADD CONSTRAINT `fk_catalog_products_brand_id` FOREIGN KEY (`brand_id`) REFERENCES `catalog_brands` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_products` ADD CONSTRAINT `fk_catalog_products_category_id` FOREIGN KEY (`category_id`) REFERENCES `catalog_categories` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_variants` ADD CONSTRAINT `fk_catalog_variants_product_id` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_review_log` ADD CONSTRAINT `fk_catalog_review_log_product_id` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_correction_suggestions` ADD CONSTRAINT `fk_catalog_correction_suggestions_product_id` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_submissions` ADD CONSTRAINT `fk_catalog_submissions_product_id` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_submission_checks` ADD CONSTRAINT `fk_catalog_submission_checks_submission_id` FOREIGN KEY (`submission_id`) REFERENCES `catalog_submissions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_check_dismissals` ADD CONSTRAINT `fk_catalog_check_dismissals_check_id` FOREIGN KEY (`check_id`) REFERENCES `catalog_submission_checks` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_review_drafts` ADD CONSTRAINT `fk_catalog_review_drafts_submission_id` FOREIGN KEY (`submission_id`) REFERENCES `catalog_submissions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_brand_authorized_sellers` ADD CONSTRAINT `fk_catalog_brand_authorized_sellers_brand_id` FOREIGN KEY (`brand_id`) REFERENCES `catalog_brands` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_offer_index` ADD CONSTRAINT `fk_catalog_offer_index_product_id` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_listing_stats` ADD CONSTRAINT `fk_catalog_listing_stats_product_id` FOREIGN KEY (`product_id`) REFERENCES `catalog_products` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_category_stats` ADD CONSTRAINT `fk_catalog_category_stats_category_id` FOREIGN KEY (`category_id`) REFERENCES `catalog_categories` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `catalog_brand_stats` ADD CONSTRAINT `fk_catalog_brand_stats_brand_id` FOREIGN KEY (`brand_id`) REFERENCES `catalog_brands` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
