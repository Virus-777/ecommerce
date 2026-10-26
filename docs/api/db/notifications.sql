-- notifications: MySQL schema generated from docs/api/spec/modules/notifications.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `notifications_topics` (
  `key` VARCHAR(255) NOT NULL,
  `audience` TEXT NOT NULL,
  `category` TEXT NOT NULL,
  `group_key` TEXT NOT NULL,
  `label` TEXT NOT NULL,
  `description` TEXT NOT NULL,
  `triggers` JSON NOT NULL,
  `opens` TEXT NOT NULL,
  `channels` JSON NOT NULL,
  `action_required` TINYINT(1) NOT NULL,
  `staff_role_keys` JSON NOT NULL,
  `seller_permission` TEXT NULL,
  `owner_only` TINYINT(1) NOT NULL,
  `frequency_label` TEXT NULL,
  `variables` JSON NOT NULL,
  `phase` INT NOT NULL,
  `updated_by` TEXT NULL,
  `updated_at` DATETIME(3) NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `notifications_templates` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `topic_key` VARCHAR(255) NOT NULL,
  `channel` VARCHAR(255) NOT NULL,
  `language` VARCHAR(255) NOT NULL,
  `live_version_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_notifications_templates_1` (`topic_key`, `channel`, `language`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- notifications_template_versions: partial index: template_id plus status from "where `status` = 'draft'" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `notifications_template_versions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `template_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `version` INT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `content` JSON NOT NULL,
  `note` TEXT NULL,
  `created_by` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `published_by` TEXT NULL,
  `published_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_notifications_template_versions_1` (`template_id`, `version`),
  KEY `ix_notifications_template_versions_2` (`template_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- notifications_notices: gin(link jsonb_path_ops) becomes generated columns, chosen per query in Y2 (Appendix B); no key emitted
CREATE TABLE `notifications_notices` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `topic_key` TEXT NOT NULL,
  `audience` TEXT NOT NULL,
  `address_kind` VARCHAR(32) NOT NULL,
  `address_id` VARCHAR(255) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `group_key` TEXT NOT NULL,
  `title` TEXT NOT NULL,
  `body` TEXT NOT NULL,
  `icon` TEXT NULL,
  `tone` TEXT NOT NULL,
  `link` JSON NOT NULL,
  `linked_ref` TEXT NULL,
  `action_required` TINYINT(1) NOT NULL,
  `deadline_at` DATETIME(3) NULL,
  `dedupe_key` VARCHAR(255) NULL,
  `resolved_at` DATETIME(3) NULL,
  `resolve_note` TEXT NULL,
  `expired_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_notifications_notices_1` (`address_kind`, `address_id`, `created_at` DESC),
  KEY `ix_notifications_notices_2` (`dedupe_key`),
  KEY `ix_notifications_notices_3` (`expires_at`),
  CONSTRAINT `ck_notifications_notices_address_kind` CHECK (`address_kind` IN ('customer', 'seller', 'role', 'staff'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `notifications_notice_recipients` (
  `notice_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reason` TEXT NOT NULL,
  `covering_for` TEXT NULL,
  `read_at` DATETIME(3) NULL,
  `archived_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`notice_id`, `account_id`),
  KEY `ix_notifications_notice_recipients_2` (`account_id`, `read_at`, `created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `notifications_scheduled_notifications` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `dedupe_key` VARCHAR(255) NOT NULL,
  `send_at` DATETIME(3) NOT NULL,
  `input` JSON NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `created_by_module` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_notifications_scheduled_notifications_1` (`status`, `send_at`),
  KEY `ix_notifications_scheduled_notifications_2` (`dedupe_key`),
  CONSTRAINT `ck_notifications_scheduled_notifications_status` CHECK (`status` IN ('pending', 'sent', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `notifications_deliveries` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `notice_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `topic_key` VARCHAR(255) NOT NULL,
  `channel` TEXT NOT NULL,
  `recipient_kind` TEXT NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `address_hash` VARCHAR(255) NOT NULL,
  `address_masked` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `skip_reason` TEXT NULL,
  `attempts` INT NOT NULL,
  `last_error` TEXT NULL,
  `provider_message_id` VARCHAR(255) NULL,
  `template_version_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `subject` TEXT NULL,
  `linked_ref` VARCHAR(255) NULL,
  `dedupe_key` VARCHAR(255) NULL,
  `broadcast_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_at` DATETIME(3) NOT NULL,
  `sent_at` DATETIME(3) NULL,
  `delivered_at` DATETIME(3) NULL,
  `next_attempt_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_notifications_deliveries_1` (`status`, `next_attempt_at`),
  KEY `ix_notifications_deliveries_2` (`provider_message_id`),
  KEY `ix_notifications_deliveries_3` (`account_id`, `created_at` DESC),
  KEY `ix_notifications_deliveries_4` (`address_hash`, `created_at` DESC),
  KEY `ix_notifications_deliveries_5` (`topic_key`, `created_at` DESC),
  KEY `ix_notifications_deliveries_6` (`linked_ref`),
  KEY `ix_notifications_deliveries_7` (`dedupe_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `notifications_delivery_events` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `delivery_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `type` TEXT NOT NULL,
  `provider_event_id` VARCHAR(255) NULL,
  `detail` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_notifications_delivery_events_provider_event_id` (`provider_event_id`),
  KEY `ix_notifications_delivery_events_1` (`delivery_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `notifications_member_preferences` (
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `member_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `groups` JSON NOT NULL,
  `channel` TEXT NOT NULL,
  `updated_by` TEXT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`seller_id`, `member_id`),
  KEY `ix_notifications_member_preferences_2` (`account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `notifications_invited_members` (
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `member_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `email` TEXT NOT NULL,
  `invited_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`seller_id`, `member_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `notifications_staff_preferences` (
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `email_by_area` JSON NOT NULL,
  `email_for_mentions` TINYINT(1) NOT NULL,
  `daily_digest` TINYINT(1) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- notifications_push_devices: partial index: account_id plus invalidated_at from "where `invalidated_at` IS NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `notifications_push_devices` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `audience` VARCHAR(32) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `platform` TEXT NOT NULL,
  `token_encrypted` BLOB NOT NULL,
  `token_hash` VARCHAR(255) NOT NULL,
  `app_version` TEXT NOT NULL,
  `installation_id` TEXT NULL,
  `enabled` TINYINT(1) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `last_seen_at` DATETIME(3) NOT NULL,
  `invalidated_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_notifications_push_devices_token_hash` (`token_hash`),
  KEY `ix_notifications_push_devices_1` (`account_id`, `invalidated_at`),
  CONSTRAINT `ck_notifications_push_devices_audience` CHECK (`audience` IN ('customer', 'seller'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- notifications_suppressions: partial unique on channel, address_hash where `removed_at` IS NULL
CREATE TABLE `notifications_suppressions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `channel` VARCHAR(255) NOT NULL,
  `address_hash` VARCHAR(255) NOT NULL,
  `address_masked` TEXT NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `reason` TEXT NOT NULL,
  `source` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `removed_at` DATETIME(3) NULL,
  `removed_by` TEXT NULL,
  `remove_reason` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_notifications_suppressions_1` ((IF(`removed_at` IS NULL, `channel`, NULL)), `address_hash`),
  KEY `ix_notifications_suppressions_2` (`account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `notifications_broadcasts` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` TEXT NOT NULL,
  `audience` TEXT NOT NULL,
  `topic_key` TEXT NOT NULL,
  `template_version_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `segment` JSON NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `scheduled_at` DATETIME(3) NULL,
  `sent_at` DATETIME(3) NULL,
  `recipient_estimate` INT NOT NULL,
  `stats` JSON NOT NULL,
  `campaign_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_by` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_notifications_broadcasts_1` (`status`, `scheduled_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `notifications_announcements` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `title` TEXT NOT NULL,
  `body` TEXT NOT NULL,
  `audience` VARCHAR(32) NOT NULL,
  `seller_ids` JSON NOT NULL,
  `seller_count` INT NOT NULL,
  `link` JSON NULL,
  `sent_by` TEXT NOT NULL,
  `sent_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_notifications_announcements_1` (`sent_at` DESC),
  CONSTRAINT `ck_notifications_announcements_audience` CHECK (`audience` IN ('all', 'chosen'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `notifications_templates` ADD CONSTRAINT `fk_notifications_templates_topic_key` FOREIGN KEY (`topic_key`) REFERENCES `notifications_topics` (`key`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `notifications_templates` ADD CONSTRAINT `fk_notifications_templates_live_version_id` FOREIGN KEY (`live_version_id`) REFERENCES `notifications_template_versions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `notifications_template_versions` ADD CONSTRAINT `fk_notifications_template_versions_template_id` FOREIGN KEY (`template_id`) REFERENCES `notifications_templates` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `notifications_notice_recipients` ADD CONSTRAINT `fk_notifications_notice_recipients_notice_id` FOREIGN KEY (`notice_id`) REFERENCES `notifications_notices` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `notifications_deliveries` ADD CONSTRAINT `fk_notifications_deliveries_notice_id` FOREIGN KEY (`notice_id`) REFERENCES `notifications_notices` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `notifications_delivery_events` ADD CONSTRAINT `fk_notifications_delivery_events_delivery_id` FOREIGN KEY (`delivery_id`) REFERENCES `notifications_deliveries` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `notifications_broadcasts` ADD CONSTRAINT `fk_notifications_broadcasts_template_version_id` FOREIGN KEY (`template_version_id`) REFERENCES `notifications_template_versions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
