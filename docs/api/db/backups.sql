-- backups: MySQL schema generated from docs/api/spec/modules/backups.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `backups_operations` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `state` VARCHAR(32) NOT NULL,
  `backup_id` TEXT NULL,
  `upload_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `safety_backup_id` TEXT NULL,
  `note` TEXT NULL,
  `reason` TEXT NULL,
  `message` TEXT NULL,
  `params` JSON NULL,
  `requested_by` JSON NOT NULL,
  `requested_at` DATETIME(3) NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `started_at` DATETIME(3) NULL,
  `finished_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_backups_operations_1` (`state`, `requested_at`),
  KEY `ix_backups_operations_2` (`requested_at`),
  KEY `ix_backups_operations_3` (`approval_request_id`),
  CONSTRAINT `ck_backups_operations_kind` CHECK (`kind` IN ('backup', 'restore', 'schedule')),
  CONSTRAINT `ck_backups_operations_state` CHECK (`state` IN ('waiting_approval', 'queued', 'running', 'done', 'failed', 'rejected', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `backups_uploads` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `label` TEXT NOT NULL,
  `state` VARCHAR(32) NOT NULL,
  `database_bytes` BIGINT NULL,
  `files_bytes` BIGINT NULL,
  `uploaded_by` JSON NOT NULL,
  `error` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_backups_uploads_1` (`created_at`),
  CONSTRAINT `ck_backups_uploads_state` CHECK (`state` IN ('receiving', 'ready', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
