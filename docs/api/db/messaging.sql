-- messaging: MySQL schema generated from docs/api/spec/modules/messaging.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

-- messaging_conversations: partial unique on kind, customer_id, seller_id, application_id, order_id, order_item_id, return_id, product_id where `kind` <> 'support'
-- messaging_conversations: partial unique on kind, customer_id, order_id, case_id where `kind` = 'support'
CREATE TABLE `messaging_conversations` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `guest_session_id` VARCHAR(255) NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `case_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `application_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `started_by_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `subject` JSON NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `locked_reason` TEXT NULL,
  `locked_by_enforcement_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `reply_state` VARCHAR(255) NOT NULL,
  `reply_due_at` DATETIME(3) NULL,
  `awaiting_since` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `last_message_at` DATETIME(3) NOT NULL,
  `archive_after` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_messaging_conversations_1` (`customer_id`, `last_message_at` DESC),
  KEY `ix_messaging_conversations_2` (`guest_session_id`),
  KEY `ix_messaging_conversations_3` (`seller_id`, `reply_state`, `reply_due_at`),
  KEY `ix_messaging_conversations_4` (`reply_state`, `reply_due_at`),
  KEY `ix_messaging_conversations_5` (`status`, `archive_after`),
  KEY `ix_messaging_conversations_6` (`order_id`),
  KEY `ix_messaging_conversations_7` (`order_item_id`),
  KEY `ix_messaging_conversations_8` (`return_id`),
  KEY `ix_messaging_conversations_9` (`case_id`),
  UNIQUE KEY `uq_messaging_conversations_10` ((IF(`kind` <> 'support', (COALESCE(`kind`, '')), NULL)), (COALESCE(`customer_id`, '')), (COALESCE(`seller_id`, '')), (COALESCE(`application_id`, '')), (COALESCE(`order_id`, '')), (COALESCE(`order_item_id`, '')), (COALESCE(`return_id`, '')), (COALESCE(`product_id`, ''))),
  UNIQUE KEY `uq_messaging_conversations_11` ((IF(`kind` = 'support', (COALESCE(`kind`, '')), NULL)), (COALESCE(`customer_id`, '')), (COALESCE(`order_id`, '')), (COALESCE(`case_id`, ''))),
  CONSTRAINT `ck_messaging_conversations_kind` CHECK (`kind` IN ('order', 'support', 'staff_seller'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- messaging_participants: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `messaging_participants` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `conversation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(255) NOT NULL,
  `participant_id` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `label` TEXT NOT NULL,
  `joined_at` DATETIME(3) NOT NULL,
  `joined_from_case_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `last_read_message_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `unread_count` INT NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_messaging_participants_1` (`conversation_id`, `kind`, `participant_id`),
  KEY `ix_messaging_participants_2` (`kind`, `participant_id`, `unread_count`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `messaging_messages` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `conversation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `author_kind` TEXT NULL,
  `author_id` VARCHAR(255) NULL,
  `author_label` TEXT NOT NULL,
  `body` TEXT NOT NULL,
  `original_body` TEXT NULL,
  `media_ids` JSON NOT NULL,
  `redactions` JSON NOT NULL,
  `hidden` TINYINT(1) NOT NULL,
  `hidden_reason` TEXT NULL,
  `client_message_id` VARCHAR(255) NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_messaging_messages_1` (`conversation_id`, `at` DESC),
  UNIQUE KEY `uq_messaging_messages_2` (`conversation_id`, `author_id`, `client_message_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `messaging_message_reports` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `message_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `conversation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reporter_kind` TEXT NOT NULL,
  `reporter_id` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `note` TEXT NULL,
  `status` VARCHAR(255) NOT NULL,
  `outcome` TEXT NULL,
  `decided_by` TEXT NULL,
  `decided_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_messaging_message_reports_1` (`status`, `created_at`),
  KEY `ix_messaging_message_reports_2` (`message_id`),
  KEY `ix_messaging_message_reports_3` (`conversation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `messaging_reply_templates` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` TEXT NOT NULL,
  `body` TEXT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_messaging_reply_templates_1` (`seller_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `messaging_conversation_aliases` (
  `old_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `conversation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `merged_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`old_id`),
  KEY `ix_messaging_conversation_aliases_1` (`conversation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `messaging_staff_access_log` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `conversation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reason` TEXT NOT NULL,
  `case_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_messaging_staff_access_log_1` (`conversation_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `messaging_seller_reply_stats` (
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `period_from` DATE NOT NULL,
  `period_to` DATE NOT NULL,
  `average_reply_minutes` INT NULL,
  `median_reply_minutes` INT NULL,
  `replied` INT NOT NULL,
  `replied_within_target` INT NOT NULL,
  `decided` INT NOT NULL,
  `computed_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`seller_id`),
  KEY `ix_messaging_seller_reply_stats_1` (`computed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `messaging_participants` ADD CONSTRAINT `fk_messaging_participants_conversation_id` FOREIGN KEY (`conversation_id`) REFERENCES `messaging_conversations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `messaging_messages` ADD CONSTRAINT `fk_messaging_messages_conversation_id` FOREIGN KEY (`conversation_id`) REFERENCES `messaging_conversations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `messaging_message_reports` ADD CONSTRAINT `fk_messaging_message_reports_message_id` FOREIGN KEY (`message_id`) REFERENCES `messaging_messages` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `messaging_message_reports` ADD CONSTRAINT `fk_messaging_message_reports_conversation_id` FOREIGN KEY (`conversation_id`) REFERENCES `messaging_conversations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `messaging_conversation_aliases` ADD CONSTRAINT `fk_messaging_conversation_aliases_conversation_id` FOREIGN KEY (`conversation_id`) REFERENCES `messaging_conversations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `messaging_staff_access_log` ADD CONSTRAINT `fk_messaging_staff_access_log_conversation_id` FOREIGN KEY (`conversation_id`) REFERENCES `messaging_conversations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
