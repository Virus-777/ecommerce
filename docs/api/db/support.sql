-- support: MySQL schema generated from docs/api/spec/modules/support.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `support_case_categories` (
  `key` VARCHAR(255) NOT NULL,
  `label` TEXT NOT NULL,
  `audience` TEXT NOT NULL,
  `group_key` TEXT NOT NULL,
  `default_priority` TEXT NOT NULL,
  `team` TEXT NOT NULL,
  `seller_handles_first` TINYINT(1) NOT NULL,
  `first_response_business_hours` INT NOT NULL,
  `next_response_business_hours` INT NOT NULL,
  `resolution_business_days` INT NOT NULL,
  `active` TINYINT(1) NOT NULL,
  `updated_by` TEXT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- support_cases: partial index: approval_request_id from "where `approval_request_id` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
-- support_cases: partial index: trust_report_id from "where `trust_report_id` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `support_cases` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `kind` VARCHAR(255) NOT NULL,
  `category_key` VARCHAR(255) NOT NULL,
  `priority` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `subject` TEXT NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `guest_session_id` VARCHAR(255) NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `handler_kind` TEXT NOT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `team` TEXT NOT NULL,
  `support_following` TINYINT(1) NOT NULL,
  `next_action` JSON NOT NULL,
  `first_response_due_at` DATETIME(3) NULL,
  `next_response_due_at` DATETIME(3) NULL,
  `resolution_due_at` DATETIME(3) NULL,
  `waiting_on` TEXT NULL,
  `reply_channel` TEXT NULL,
  `decision` JSON NULL,
  `decision_draft` JSON NULL,
  `appeal_deadline` DATETIME(3) NULL,
  `reopen_until` DATETIME(3) NULL,
  `reopen_count` INT NOT NULL,
  `opened_by` TEXT NOT NULL,
  `opened_at` DATETIME(3) NOT NULL,
  `first_replied_at` DATETIME(3) NULL,
  `resolved_at` DATETIME(3) NULL,
  `closed_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `order_ref` TEXT NULL,
  `placed_at` DATETIME(3) NULL,
  `return_ref` TEXT NULL,
  `customer_name` TEXT NULL,
  `contact_email` TEXT NULL,
  `city` TEXT NULL,
  `seller_name` TEXT NULL,
  `owner_type` VARCHAR(32) NULL,
  `reference` TEXT NULL,
  `trust_report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `problem_type` VARCHAR(32) NULL,
  `desired_remedy` VARCHAR(32) NULL,
  `callback_phone` TEXT NULL,
  `info_request_from` VARCHAR(32) NULL,
  `info_request_question` TEXT NULL,
  `info_request_due_at` DATETIME(3) NULL,
  `info_requested_at` DATETIME(3) NULL,
  `info_requested_by` TEXT NULL,
  `escalated_at` DATETIME(3) NULL,
  `escalated_by` TEXT NULL,
  `escalation_reason` TEXT NULL,
  `escalated_to` TEXT NULL,
  `escalation_note` TEXT NULL,
  `seller_replied_at` DATETIME(3) NULL,
  `dispatch_overdue_due_at` DATETIME(3) NULL,
  `dispatch_overdue_noted_at` DATETIME(3) NULL,
  `overdue_notified_for` DATETIME(3) NULL,
  `appeal_window_closed` TINYINT(1) NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `pending_decision` JSON NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_support_cases_ref` (`ref`),
  KEY `ix_support_cases_1` (`status`, `next_response_due_at`),
  KEY `ix_support_cases_2` (`owner_staff_id`, `status`),
  KEY `ix_support_cases_3` (`customer_id`, `opened_at` DESC),
  KEY `ix_support_cases_4` (`seller_id`, `status`),
  KEY `ix_support_cases_5` (`order_id`),
  KEY `ix_support_cases_6` (`return_id`),
  KEY `ix_support_cases_7` (`guest_session_id`),
  KEY `ix_support_cases_8` (`first_replied_at`),
  KEY `ix_support_cases_9` (`kind`, `status`),
  KEY `ix_support_cases_10` (`approval_request_id`),
  KEY `ix_support_cases_11` (`trust_report_id`),
  CONSTRAINT `ck_support_cases_owner_type` CHECK (`owner_type` IN ('official', 'seller')),
  CONSTRAINT `ck_support_cases_problem_type` CHECK (`problem_type` IN ('missing_item', 'damaged', 'wrong_item', 'not_arrived', 'other')),
  CONSTRAINT `ck_support_cases_desired_remedy` CHECK (`desired_remedy` IN ('refund', 'keep_waiting', 'replacement', 'other')),
  CONSTRAINT `ck_support_cases_info_request_from` CHECK (`info_request_from` IN ('customer', 'seller'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- support_case_items: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `support_case_items` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `case_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `snapshot` JSON NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_support_case_items_1` (`case_id`, `order_item_id`),
  KEY `ix_support_case_items_2` (`order_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `support_case_messages` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `case_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `author_kind` TEXT NOT NULL,
  `author_id` TEXT NULL,
  `author_label` TEXT NOT NULL,
  `role` TEXT NOT NULL,
  `audience` TEXT NOT NULL,
  `body` TEXT NOT NULL,
  `media_ids` JSON NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_support_case_messages_1` (`case_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `support_case_evidence` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `case_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `party` TEXT NOT NULL,
  `kind` TEXT NOT NULL,
  `media_ids` JSON NOT NULL,
  `note` TEXT NULL,
  `added_by` TEXT NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_support_case_evidence_1` (`case_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `support_case_offers` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `case_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `from_party` TEXT NOT NULL,
  `kind` TEXT NOT NULL,
  `amount` BIGINT NULL,
  `currency` TEXT NULL,
  `ship_by` DATE NULL,
  `note` TEXT NULL,
  `status` VARCHAR(255) NOT NULL,
  `respond_by` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `responded_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_support_case_offers_1` (`case_id`),
  KEY `ix_support_case_offers_2` (`status`, `respond_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `support_case_remedies` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `case_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `amount` BIGINT NULL,
  `currency` TEXT NULL,
  `charged_to` TEXT NULL,
  `order_item_ids` JSON NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `refund_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `replacement_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `goodwill_grant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `due_at` DATETIME(3) NULL,
  `note` TEXT NULL,
  `created_by` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_support_case_remedies_1` (`case_id`),
  KEY `ix_support_case_remedies_2` (`refund_request_id`),
  KEY `ix_support_case_remedies_3` (`status`),
  KEY `ix_support_case_remedies_4` (`replacement_id`),
  KEY `ix_support_case_remedies_5` (`goodwill_grant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `support_case_appeals` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `case_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `by_kind` TEXT NOT NULL,
  `by_id` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `media_ids` JSON NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `reviewer_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `submitted_at` DATETIME(3) NOT NULL,
  `decided_at` DATETIME(3) NULL,
  `outcome` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_support_case_appeals_1` (`case_id`),
  KEY `ix_support_case_appeals_2` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `support_case_events` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `case_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `label` TEXT NOT NULL,
  `detail` TEXT NULL,
  `visibility` VARCHAR(32) NOT NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `reason` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_support_case_events_1` (`case_id`, `at`),
  CONSTRAINT `ck_support_case_events_visibility` CHECK (`visibility` IN ('customer', 'seller', 'all', 'staff'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `support_cases` ADD CONSTRAINT `fk_support_cases_category_key` FOREIGN KEY (`category_key`) REFERENCES `support_case_categories` (`key`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `support_case_items` ADD CONSTRAINT `fk_support_case_items_case_id` FOREIGN KEY (`case_id`) REFERENCES `support_cases` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `support_case_messages` ADD CONSTRAINT `fk_support_case_messages_case_id` FOREIGN KEY (`case_id`) REFERENCES `support_cases` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `support_case_evidence` ADD CONSTRAINT `fk_support_case_evidence_case_id` FOREIGN KEY (`case_id`) REFERENCES `support_cases` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `support_case_offers` ADD CONSTRAINT `fk_support_case_offers_case_id` FOREIGN KEY (`case_id`) REFERENCES `support_cases` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `support_case_remedies` ADD CONSTRAINT `fk_support_case_remedies_case_id` FOREIGN KEY (`case_id`) REFERENCES `support_cases` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `support_case_appeals` ADD CONSTRAINT `fk_support_case_appeals_case_id` FOREIGN KEY (`case_id`) REFERENCES `support_cases` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `support_case_events` ADD CONSTRAINT `fk_support_case_events_case_id` FOREIGN KEY (`case_id`) REFERENCES `support_cases` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
