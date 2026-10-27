-- trust: MySQL schema generated from docs/api/spec/modules/trust.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

-- trust_reports: partial unique on dedupe_key where `status` IN ('open', 'under_review', 'escalated')
CREATE TABLE `trust_reports` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `type` VARCHAR(255) NOT NULL,
  `title` TEXT NOT NULL,
  `description` TEXT NOT NULL,
  `source` TEXT NOT NULL,
  `reporter_kind` VARCHAR(255) NOT NULL,
  `reporter_id` VARCHAR(255) NULL,
  `reporter_name` TEXT NULL,
  `reporter_org` TEXT NULL,
  `reporter_contact` TEXT NULL,
  `reporter_count` INT NOT NULL,
  `detector` TEXT NULL,
  `dedupe_key` VARCHAR(255) NULL,
  `status` VARCHAR(255) NOT NULL,
  `risk_score` INT NOT NULL,
  `risk_factors` JSON NOT NULL,
  `risk_override` JSON NULL,
  `assignee_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `due_at` DATETIME(3) NULL,
  `resolution` JSON NULL,
  `reporter_outcome` TEXT NULL,
  `assessment` JSON NULL,
  `merged_into_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_trust_reports_ref` (`ref`),
  KEY `ix_trust_reports_1` (`status`, `risk_score` DESC),
  KEY `ix_trust_reports_2` (`type`, `status`),
  KEY `ix_trust_reports_3` (`assignee_staff_id`, `status`),
  KEY `ix_trust_reports_4` (`merged_into_id`),
  UNIQUE KEY `uq_trust_reports_5` ((IF(`status` IN ('open', 'under_review', 'escalated'), `dedupe_key`, NULL))),
  KEY `ix_trust_reports_6` (`reporter_kind`, `reporter_id`, `created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- trust_report_subjects: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `trust_report_subjects` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `subject_type` VARCHAR(255) NOT NULL,
  `subject_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` TEXT NULL,
  `label` TEXT NOT NULL,
  PRIMARY KEY (`row_id`),
  KEY `ix_trust_report_subjects_1` (`subject_type`, `subject_id`),
  UNIQUE KEY `uq_trust_report_subjects_2` (`report_id`, `subject_type`, `subject_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `trust_evidence` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `result` TEXT NULL,
  `text` TEXT NOT NULL,
  `media_ids` JSON NOT NULL,
  `source` TEXT NOT NULL,
  `visibility` TEXT NOT NULL,
  `added_by_kind` TEXT NOT NULL,
  `added_by_id` TEXT NULL,
  `added_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_trust_evidence_1` (`report_id`, `added_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `trust_evidence_requests` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `to_type` VARCHAR(255) NOT NULL,
  `to_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `question` TEXT NOT NULL,
  `due_at` DATETIME(3) NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `answer` TEXT NULL,
  `answer_media_ids` JSON NOT NULL,
  `answered_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_trust_evidence_requests_1` (`report_id`),
  KEY `ix_trust_evidence_requests_2` (`to_type`, `to_id`, `state`),
  KEY `ix_trust_evidence_requests_3` (`state`, `due_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- trust_recommendations: partial index: approval_request_id from "where `approval_request_id` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `trust_recommendations` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `action` TEXT NOT NULL,
  `label` TEXT NOT NULL,
  `owner_team` VARCHAR(255) NOT NULL,
  `owner_role` TEXT NOT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `targets` JSON NOT NULL,
  `params` JSON NOT NULL,
  `rationale` TEXT NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `created_by` TEXT NULL,
  `routed_at` DATETIME(3) NULL,
  `routed_by` TEXT NULL,
  `decided_at` DATETIME(3) NULL,
  `decided_by` TEXT NULL,
  `decision_reason` TEXT NULL,
  `enforcement_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  KEY `ix_trust_recommendations_1` (`owner_team`, `state`),
  KEY `ix_trust_recommendations_2` (`report_id`),
  KEY `ix_trust_recommendations_3` (`approval_request_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- trust_enforcements: partial index: reversal_request_id from "where `reversal_request_id` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `trust_enforcements` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `recommendation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `action` TEXT NOT NULL,
  `owner_team` VARCHAR(255) NOT NULL,
  `targets` JSON NOT NULL,
  `reason` TEXT NOT NULL,
  `params` JSON NOT NULL,
  `effects` JSON NOT NULL,
  `recorded_by` TEXT NOT NULL,
  `recorded_at` DATETIME(3) NOT NULL,
  `execution_state` VARCHAR(255) NOT NULL,
  `applied_ref` TEXT NULL,
  `applied_at` DATETIME(3) NULL,
  `failure` TEXT NULL,
  `appealable` TINYINT(1) NOT NULL,
  `appeal_deadline` DATETIME(3) NULL,
  `reversed_at` DATETIME(3) NULL,
  `reversal_reason` TEXT NULL,
  `reversal_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_trust_enforcements_ref` (`ref`),
  KEY `ix_trust_enforcements_1` (`report_id`),
  KEY `ix_trust_enforcements_2` (`execution_state`),
  KEY `ix_trust_enforcements_3` (`owner_team`, `recorded_at` DESC),
  KEY `ix_trust_enforcements_4` (`reversal_request_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- trust_enforcement_targets: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `trust_enforcement_targets` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `enforcement_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `target_type` VARCHAR(255) NOT NULL,
  `target_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (`row_id`),
  KEY `ix_trust_enforcement_targets_1` (`target_type`, `target_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- trust_appeals: partial unique on source, external_appeal_id where `external_appeal_id` IS NOT NULL
CREATE TABLE `trust_appeals` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `source` VARCHAR(32) NOT NULL,
  `external_appeal_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `enforcement_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `appellant_kind` VARCHAR(255) NOT NULL,
  `appellant_id` VARCHAR(255) NOT NULL,
  `appellant_name` TEXT NOT NULL,
  `decision_appealed` TEXT NOT NULL,
  `argument` TEXT NOT NULL,
  `evidence_media_ids` JSON NOT NULL,
  `reviewer_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `original_decider_id` TEXT NOT NULL,
  `decide_by` DATETIME(3) NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `decision` JSON NULL,
  `filed_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_trust_appeals_ref` (`ref`),
  KEY `ix_trust_appeals_1` (`state`, `decide_by`),
  KEY `ix_trust_appeals_2` (`enforcement_id`),
  UNIQUE KEY `uq_trust_appeals_3` ((IF(`external_appeal_id` IS NOT NULL, `source`, NULL)), `external_appeal_id`),
  KEY `ix_trust_appeals_4` (`appellant_kind`, `appellant_id`),
  CONSTRAINT `ck_trust_appeals_source` CHECK (`source` IN ('trust', 'sellers'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `trust_report_notes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `body` TEXT NOT NULL,
  `author_id` TEXT NOT NULL,
  `author_name` TEXT NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_trust_report_notes_1` (`report_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `trust_report_events` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `detail` JSON NOT NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_trust_report_events_1` (`report_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `trust_detection_rules` (
  `key` VARCHAR(255) NOT NULL,
  `description` TEXT NOT NULL,
  `type` TEXT NOT NULL,
  `active` TINYINT(1) NOT NULL,
  `thresholds` JSON NOT NULL,
  `base_score` INT NOT NULL,
  `updated_by` TEXT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `last_run_at` DATETIME(3) NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `trust_risk_signals` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(255) NOT NULL,
  `subject_type` VARCHAR(255) NOT NULL,
  `subject_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `features` JSON NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_trust_risk_signals_1` (`kind`, `at`),
  KEY `ix_trust_risk_signals_2` (`subject_type`, `subject_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `trust_reports` ADD CONSTRAINT `fk_trust_reports_merged_into_id` FOREIGN KEY (`merged_into_id`) REFERENCES `trust_reports` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `trust_report_subjects` ADD CONSTRAINT `fk_trust_report_subjects_report_id` FOREIGN KEY (`report_id`) REFERENCES `trust_reports` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `trust_evidence` ADD CONSTRAINT `fk_trust_evidence_report_id` FOREIGN KEY (`report_id`) REFERENCES `trust_reports` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `trust_evidence_requests` ADD CONSTRAINT `fk_trust_evidence_requests_report_id` FOREIGN KEY (`report_id`) REFERENCES `trust_reports` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `trust_recommendations` ADD CONSTRAINT `fk_trust_recommendations_report_id` FOREIGN KEY (`report_id`) REFERENCES `trust_reports` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `trust_enforcements` ADD CONSTRAINT `fk_trust_enforcements_report_id` FOREIGN KEY (`report_id`) REFERENCES `trust_reports` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `trust_enforcements` ADD CONSTRAINT `fk_trust_enforcements_recommendation_id` FOREIGN KEY (`recommendation_id`) REFERENCES `trust_recommendations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `trust_enforcement_targets` ADD CONSTRAINT `fk_trust_enforcement_targets_enforcement_id` FOREIGN KEY (`enforcement_id`) REFERENCES `trust_enforcements` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `trust_appeals` ADD CONSTRAINT `fk_trust_appeals_report_id` FOREIGN KEY (`report_id`) REFERENCES `trust_reports` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `trust_appeals` ADD CONSTRAINT `fk_trust_appeals_enforcement_id` FOREIGN KEY (`enforcement_id`) REFERENCES `trust_enforcements` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `trust_report_notes` ADD CONSTRAINT `fk_trust_report_notes_report_id` FOREIGN KEY (`report_id`) REFERENCES `trust_reports` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `trust_report_events` ADD CONSTRAINT `fk_trust_report_events_report_id` FOREIGN KEY (`report_id`) REFERENCES `trust_reports` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- views: join shapes, merged into the query that reads them (§9.2)
CREATE OR REPLACE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW `trust_v_report_subjects` AS
SELECT s.*,
  r.ref AS report_ref, r.type, r.title, r.status, r.source, r.risk_score, r.assignee_staff_id, r.due_at,
  r.created_at AS report_created_at, r.updated_at AS report_updated_at
FROM trust_report_subjects s
JOIN trust_reports r ON r.id = s.report_id
WHERE r.merged_into_id IS NULL;
