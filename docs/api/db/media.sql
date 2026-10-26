-- media: MySQL schema generated from docs/api/spec/modules/media.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `media_assets` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `purpose` VARCHAR(255) NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `file_name` TEXT NOT NULL,
  `content_type` TEXT NOT NULL,
  `size_bytes` BIGINT NOT NULL,
  `sha256` TEXT NULL,
  `phash` BIGINT NULL,
  `width` INT NULL,
  `height` INT NULL,
  `duration_seconds` DECIMAL(10,3) NULL,
  `page_count` INT NULL,
  `alt` TEXT NULL,
  `title` TEXT NULL,
  `owner_kind` VARCHAR(255) NOT NULL,
  `owner_id` VARCHAR(255) NULL,
  `owner_label` TEXT NULL,
  `visibility` TEXT NOT NULL,
  `storage_bucket` TEXT NOT NULL,
  `storage_key` VARCHAR(255) NOT NULL,
  `check_result` JSON NULL,
  `rejection_reason` TEXT NULL,
  `removed_reason` TEXT NULL,
  `removed_by` TEXT NULL,
  `removed_at` DATETIME(3) NULL,
  `show_placeholder` TINYINT(1) NULL,
  `retain_until` DATETIME(3) NULL,
  `expires_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `ready_at` DATETIME(3) NULL,
  `deleted_at` DATETIME(3) NULL,
  `processing_spec` JSON NULL,
  PRIMARY KEY (`id`),
  KEY `ix_media_assets_1` (`owner_kind`, `owner_id`, `created_at` DESC),
  KEY `ix_media_assets_2` (`status`, `created_at`),
  KEY `ix_media_assets_3` (`purpose`, `created_at`),
  KEY `ix_media_assets_4` (`owner_kind`, `owner_id`, `phash`),
  KEY `ix_media_assets_5` (`retain_until`),
  KEY `ix_media_assets_6` (`expires_at`),
  KEY `ix_media_assets_7` (`storage_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `media_renditions` (
  `asset_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `size` VARCHAR(255) NOT NULL,
  `storage_key` TEXT NOT NULL,
  `url` TEXT NOT NULL,
  `width` INT NOT NULL,
  `height` INT NOT NULL,
  `format` VARCHAR(255) NOT NULL,
  `bytes` BIGINT NOT NULL,
  PRIMARY KEY (`asset_id`, `size`, `format`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- media_uploads: partial index: url_expires_at plus completed_at from "where `completed_at` IS NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `media_uploads` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `asset_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `expected_bytes` BIGINT NOT NULL,
  `expected_sha256` TEXT NULL,
  `url_expires_at` DATETIME(3) NOT NULL,
  `completed_at` DATETIME(3) NULL,
  `client_ip` VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_by_kind` TEXT NOT NULL,
  `created_by_id` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_media_uploads_1` (`url_expires_at`, `completed_at`),
  KEY `ix_media_uploads_2` (`asset_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- media_usages: partial index: asset_id plus detached_at from "where `detached_at` IS NULL" — confirm the column order with EXPLAIN in Y2
-- media_usages: partial unique on asset_id, module, kind, ref_id where `detached_at` IS NULL
CREATE TABLE `media_usages` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `asset_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `module` VARCHAR(32) NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `ref_id` VARCHAR(64) NOT NULL,
  `ref_label` TEXT NULL,
  `evidence` TINYINT(1) NOT NULL,
  `attached_at` DATETIME(3) NOT NULL,
  `detached_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_media_usages_1` (`asset_id`, `detached_at`),
  UNIQUE KEY `uq_media_usages_2` ((IF(`detached_at` IS NULL, `asset_id`, NULL)), `module`, `kind`, `ref_id`),
  KEY `ix_media_usages_3` (`module`, `kind`, `ref_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `media_processing_jobs` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `asset_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `step` VARCHAR(32) NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `attempts` INT NOT NULL,
  `provider_ref` VARCHAR(255) NULL,
  `error` TEXT NULL,
  `next_attempt_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `finished_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_media_processing_jobs_1` (`status`, `next_attempt_at`),
  KEY `ix_media_processing_jobs_2` (`provider_ref`),
  KEY `ix_media_processing_jobs_3` (`asset_id`),
  CONSTRAINT `ck_media_processing_jobs_step` CHECK (`step` IN ('scan', 'probe', 'strip', 'renditions', 'transcode', 'check'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `media_upload_counters` (
  `owner_kind` VARCHAR(255) NOT NULL,
  `owner_id` VARCHAR(255) NOT NULL,
  `day` DATE NOT NULL,
  `count` INT NOT NULL,
  `bytes` BIGINT NOT NULL,
  PRIMARY KEY (`owner_kind`, `owner_id`, `day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `media_renditions` ADD CONSTRAINT `fk_media_renditions_asset_id` FOREIGN KEY (`asset_id`) REFERENCES `media_assets` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `media_uploads` ADD CONSTRAINT `fk_media_uploads_asset_id` FOREIGN KEY (`asset_id`) REFERENCES `media_assets` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `media_usages` ADD CONSTRAINT `fk_media_usages_asset_id` FOREIGN KEY (`asset_id`) REFERENCES `media_assets` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `media_processing_jobs` ADD CONSTRAINT `fk_media_processing_jobs_asset_id` FOREIGN KEY (`asset_id`) REFERENCES `media_assets` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
