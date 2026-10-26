-- workqueues: MySQL schema generated from docs/api/spec/modules/workqueues.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `workqueues_queues` (
  `key` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `area` TEXT NOT NULL,
  `owner_role` TEXT NOT NULL,
  `lead_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `backup_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `escalation_route` JSON NOT NULL,
  `escalation_label` TEXT NOT NULL,
  `default_deadline_minutes` INT NOT NULL,
  `business_hours_only` TINYINT(1) NOT NULL,
  `pause_while_waiting` TINYINT(1) NOT NULL,
  `screen` TEXT NOT NULL,
  `screen_filter` TEXT NULL,
  `visible_to_seller` TINYINT(1) NOT NULL,
  `active` TINYINT(1) NOT NULL,
  `updated_by` TEXT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- workqueues_intake_rules: partial index: event plus active from "where `active` = 1" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `workqueues_intake_rules` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `event` VARCHAR(255) NOT NULL,
  `queue_key` VARCHAR(255) NOT NULL,
  `kind` TEXT NOT NULL,
  `title_template` TEXT NOT NULL,
  `dedupe_key_template` TEXT NOT NULL,
  `deadline_rule` TEXT NOT NULL,
  `priority` TEXT NOT NULL,
  `resolves_on` JSON NOT NULL,
  `active` TINYINT(1) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_workqueues_intake_rules_1` (`event`, `active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- workqueues_items: partial unique on dedupe_key where `state` IN ('open', 'assigned', 'in_progress', 'waiting')
-- workqueues_items: partial index: deadline_state, due_at plus state from "where `state` IN ('open', 'assigned', 'in_progress', 'waiting')" — confirm the column order with EXPLAIN in Y2
-- workqueues_items: partial index: seller_id, state plus visible_to_seller from "where `visible_to_seller` = 1" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `workqueues_items` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `queue_key` VARCHAR(255) NOT NULL,
  `kind` TEXT NOT NULL,
  `title` TEXT NOT NULL,
  `summary` TEXT NULL,
  `subject_type` VARCHAR(255) NOT NULL,
  `subject_id` VARCHAR(255) NOT NULL,
  `subject_ref` TEXT NULL,
  `subject_label` TEXT NULL,
  `related_subjects` JSON NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `seller_name` TEXT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `amount_minor` BIGINT NULL,
  `currency` TEXT NULL,
  `owner_role` TEXT NOT NULL,
  `assignee_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `due_at` DATETIME(3) NOT NULL,
  `deadline_state` VARCHAR(32) NOT NULL,
  `priority` TEXT NOT NULL,
  `state` VARCHAR(32) NOT NULL,
  `waiting_on` TEXT NULL,
  `waiting_since` DATETIME(3) NULL,
  `escalation_level` INT NOT NULL,
  `escalated_to` TEXT NULL,
  `dedupe_key` VARCHAR(255) NOT NULL,
  `source_module` TEXT NOT NULL,
  `source_event` TEXT NULL,
  `links` JSON NOT NULL,
  `visible_to_seller` TINYINT(1) NOT NULL,
  `opened_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `resolved_at` DATETIME(3) NULL,
  `resolution` JSON NULL,
  `archived_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_workqueues_items_ref` (`ref`),
  UNIQUE KEY `uq_workqueues_items_1` ((IF(`state` IN ('open', 'assigned', 'in_progress', 'waiting'), `dedupe_key`, NULL))),
  KEY `ix_workqueues_items_2` (`queue_key`, `state`, `due_at`),
  KEY `ix_workqueues_items_3` (`assignee_staff_id`, `state`),
  KEY `ix_workqueues_items_4` (`deadline_state`, `due_at`, `state`),
  KEY `ix_workqueues_items_5` (`seller_id`, `state`, `visible_to_seller`),
  KEY `ix_workqueues_items_6` (`subject_type`, `subject_id`),
  CONSTRAINT `ck_workqueues_items_deadline_state` CHECK (`deadline_state` IN ('on_time', 'due_soon', 'overdue')),
  CONSTRAINT `ck_workqueues_items_state` CHECK (`state` IN ('open', 'assigned', 'in_progress', 'waiting', 'resolved', 'dismissed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `workqueues_item_events` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `detail` JSON NOT NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_workqueues_item_events_1` (`item_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `workqueues_item_notes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `body` TEXT NOT NULL,
  `author_id` TEXT NOT NULL,
  `author_name` TEXT NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_workqueues_item_notes_1` (`item_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- workqueues_saved_filters: partial index: shared from "where `shared` = 1" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `workqueues_saved_filters` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` TEXT NOT NULL,
  `shared` TINYINT(1) NOT NULL,
  `target` TEXT NOT NULL,
  `screen` TEXT NULL,
  `screen_state` TEXT NULL,
  `filters` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_workqueues_saved_filters_1` (`owner_staff_id`),
  KEY `ix_workqueues_saved_filters_2` (`shared`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `workqueues_day_end_reviews` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `date` DATE NOT NULL,
  `due_at` DATETIME(3) NOT NULL,
  `state` TEXT NOT NULL,
  `shared_with_roles` JSON NOT NULL,
  `items` JSON NOT NULL,
  `completed_by` TEXT NULL,
  `completed_at` DATETIME(3) NULL,
  `summary_sent_to` JSON NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_workqueues_day_end_reviews_date` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `workqueues_routine_templates` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `title` TEXT NOT NULL,
  `area_label` TEXT NOT NULL,
  `owner_roles` JSON NOT NULL,
  `due_time` TEXT NOT NULL,
  `weekdays` JSON NOT NULL,
  `active` TINYINT(1) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `workqueues_routine_checks` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `template_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `date` DATE NOT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `due_at` DATETIME(3) NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `done_at` DATETIME(3) NULL,
  `done_by` TEXT NULL,
  `note` TEXT NULL,
  `check_ins` JSON NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_workqueues_routine_checks_1` (`template_id`, `date`),
  KEY `ix_workqueues_routine_checks_2` (`date`, `state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- workqueues_daily_counts: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `workqueues_daily_counts` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `queue_key` VARCHAR(255) NOT NULL,
  `date` DATE NOT NULL,
  `open` INT NOT NULL,
  `overdue` INT NOT NULL,
  `opened` INT NOT NULL,
  `resolved` INT NOT NULL,
  `median_resolve_minutes` INT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_workqueues_daily_counts_1` (`queue_key`, `date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `workqueues_intake_rules` ADD CONSTRAINT `fk_workqueues_intake_rules_queue_key` FOREIGN KEY (`queue_key`) REFERENCES `workqueues_queues` (`key`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `workqueues_items` ADD CONSTRAINT `fk_workqueues_items_queue_key` FOREIGN KEY (`queue_key`) REFERENCES `workqueues_queues` (`key`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `workqueues_item_events` ADD CONSTRAINT `fk_workqueues_item_events_item_id` FOREIGN KEY (`item_id`) REFERENCES `workqueues_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `workqueues_item_notes` ADD CONSTRAINT `fk_workqueues_item_notes_item_id` FOREIGN KEY (`item_id`) REFERENCES `workqueues_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `workqueues_routine_checks` ADD CONSTRAINT `fk_workqueues_routine_checks_template_id` FOREIGN KEY (`template_id`) REFERENCES `workqueues_routine_templates` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
