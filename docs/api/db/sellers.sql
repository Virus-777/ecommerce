-- sellers: MySQL schema generated from docs/api/spec/modules/sellers.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

-- sellers_sellers: FULLTEXT ngram over store_name, legal_name: terms shorter than the ngram size fall back to LIKE (§6.1)
CREATE TABLE `sellers_sellers` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `store_name` VARCHAR(255) NOT NULL,
  `legal_name` VARCHAR(255) NOT NULL,
  `seller_type` TEXT NOT NULL,
  `business_type` TEXT NOT NULL,
  `state_of_registration` TEXT NULL,
  `registry_number` TEXT NULL,
  `tax_id_type` TEXT NOT NULL,
  `tax_id_encrypted` BLOB NOT NULL,
  `tax_id_last4` TEXT NOT NULL,
  `business_address` JSON NOT NULL,
  `phone` TEXT NOT NULL,
  `website` TEXT NULL,
  `contact` JSON NOT NULL,
  `market` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `status_since` DATETIME(3) NOT NULL,
  `closed_reason` TEXT NULL,
  `verification_state` VARCHAR(255) NOT NULL,
  `verification_checked` JSON NOT NULL,
  `verified_at` DATETIME(3) NULL,
  `verification_expires_at` DATETIME(3) NULL,
  `launch_review` JSON NOT NULL,
  `payout_readiness` TEXT NOT NULL,
  `payout_destination_label` TEXT NULL,
  `payout_blocked_reasons` JSON NOT NULL,
  `account_manager_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `application_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `approved_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sellers_sellers_ref` (`ref`),
  UNIQUE KEY `uq_sellers_sellers_slug` (`slug`),
  KEY `ix_sellers_sellers_1` (`status`, `id`),
  KEY `ix_sellers_sellers_2` (`verification_state`),
  FULLTEXT KEY `ft_sellers_sellers_3` (`store_name`, `legal_name`) WITH PARSER ngram,
  KEY `ix_sellers_sellers_4` (`created_at`, `id`),
  KEY `ix_sellers_sellers_5` (`store_name`, `id`),
  KEY `ix_sellers_sellers_6` (`approved_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_applications` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `applicant_account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `invitation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `state` VARCHAR(255) NOT NULL,
  `current_step` TEXT NOT NULL,
  `completed_steps` JSON NOT NULL,
  `account` JSON NOT NULL,
  `business` JSON NOT NULL,
  `verification` JSON NOT NULL,
  `tax_id_hash` VARCHAR(255) NULL,
  `payout` JSON NOT NULL,
  `return_address` JSON NOT NULL,
  `decision` JSON NULL,
  `reviewer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `submitted_at` DATETIME(3) NULL,
  `decision_target_at` DATETIME(3) NULL,
  `can_reapply_from` DATE NULL,
  `draft_saved_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sellers_applications_ref` (`ref`),
  KEY `ix_sellers_applications_1` (`state`, `decision_target_at`),
  KEY `ix_sellers_applications_2` (`applicant_account_id`),
  KEY `ix_sellers_applications_3` (`reviewer_id`, `state`),
  KEY `ix_sellers_applications_4` (`tax_id_hash`),
  KEY `ix_sellers_applications_5` (`decision_target_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_application_documents` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `application_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `kind` TEXT NOT NULL,
  `media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `file_name` TEXT NOT NULL,
  `size_bytes` INT NOT NULL,
  `status` TEXT NOT NULL,
  `note` TEXT NULL,
  `delete_after` DATE NULL,
  `uploaded_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sellers_application_documents_1` (`application_id`),
  KEY `ix_sellers_application_documents_2` (`delete_after`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_verification_checks` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `application_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `kind` VARCHAR(255) NOT NULL,
  `result` TEXT NOT NULL,
  `summary` TEXT NOT NULL,
  `source` TEXT NOT NULL,
  `provider` VARCHAR(255) NULL,
  `provider_ref` VARCHAR(255) NULL,
  `accepted_note` TEXT NULL,
  `checked_by` TEXT NULL,
  `checked_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sellers_verification_checks_1` (`application_id`),
  KEY `ix_sellers_verification_checks_2` (`seller_id`, `kind`),
  UNIQUE KEY `uq_sellers_verification_checks_3` (`provider`, `provider_ref`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_information_requests` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `application_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `items` JSON NOT NULL,
  `message` TEXT NOT NULL,
  `due_at` DATETIME(3) NOT NULL,
  `reminder` TEXT NOT NULL,
  `reminded_at` DATETIME(3) NULL,
  `requested_by` TEXT NOT NULL,
  `requested_at` DATETIME(3) NOT NULL,
  `responded_at` DATETIME(3) NULL,
  `state` VARCHAR(32) NOT NULL,
  `draft_saved_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sellers_information_requests_1` (`state`, `due_at`),
  KEY `ix_sellers_information_requests_2` (`application_id`, `state`),
  CONSTRAINT `ck_sellers_information_requests_state` CHECK (`state` IN ('open', 'answered', 'expired'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_risk_reviews` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `application_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `trust_report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `state` TEXT NOT NULL,
  `level` TEXT NULL,
  `flags` JSON NOT NULL,
  `recommendation` TEXT NULL,
  `reviewed_by` TEXT NULL,
  `reviewed_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sellers_risk_reviews_1` (`application_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_agreement_acceptances` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `application_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `policy_key` VARCHAR(255) NOT NULL,
  `version_label` TEXT NOT NULL,
  `policy_version_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `signed_name` TEXT NOT NULL,
  `accepted_by` TEXT NOT NULL,
  `ip` VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `accepted_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sellers_agreement_acceptances_1` (`seller_id`, `policy_key`, `accepted_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_store_profiles` (
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `logo_media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `banner_media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `introduction` TEXT NULL,
  `location` TEXT NULL,
  `contact_options` JSON NOT NULL,
  `warranty` TEXT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `tagline` TEXT NULL,
  PRIMARY KEY (`seller_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_featured_collections` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `title` TEXT NOT NULL,
  `image_media_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `offer_ids` JSON NOT NULL,
  `position` INT NOT NULL,
  `visible` TINYINT(1) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sellers_featured_collections_1` (`seller_id`, `position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_public_claims` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `text` TEXT NOT NULL,
  `brand_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `evidence_media_ids` JSON NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `decision_reason` TEXT NULL,
  `decided_by` TEXT NULL,
  `submitted_at` DATETIME(3) NOT NULL,
  `decided_at` DATETIME(3) NULL,
  `expires_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sellers_public_claims_1` (`state`, `submitted_at`),
  KEY `ix_sellers_public_claims_2` (`seller_id`, `state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_change_requests` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `current` JSON NULL,
  `proposed` JSON NOT NULL,
  `evidence_media_ids` JSON NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `decision_reason` TEXT NULL,
  `impact` TEXT NULL,
  `submitted_by` TEXT NOT NULL,
  `submitted_at` DATETIME(3) NOT NULL,
  `decided_by` TEXT NULL,
  `decided_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sellers_change_requests_1` (`state`, `submitted_at`),
  KEY `ix_sellers_change_requests_2` (`seller_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- sellers_members: partial unique on seller_id, email where `status` IN ('invited', 'active', 'suspended')
-- sellers_members: partial unique on seller_id where `is_owner` = 1 AND `status` = 'active'
CREATE TABLE `sellers_members` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `name` TEXT NOT NULL,
  `email` VARCHAR(255) NOT NULL,
  `role` TEXT NOT NULL,
  `permissions` JSON NOT NULL,
  `is_owner` TINYINT(1) NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `invitation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `invited_by` TEXT NULL,
  `invited_at` DATETIME(3) NULL,
  `invite_expires_at` DATETIME(3) NULL,
  `joined_at` DATETIME(3) NULL,
  `last_active_at` DATETIME(3) NULL,
  `removed_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sellers_members_1` ((IF(`status` IN ('invited', 'active', 'suspended'), `seller_id`, NULL)), `email`),
  KEY `ix_sellers_members_2` (`account_id`),
  UNIQUE KEY `uq_sellers_members_3` ((IF(`is_owner` = 1 AND `status` = 'active', `seller_id`, NULL))),
  KEY `ix_sellers_members_4` (`seller_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_performance_events` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `subject_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `value` DECIMAL(14,4) NULL,
  `occurred_at` DATETIME(3) NOT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sellers_performance_events_1` (`seller_id`, `kind`, `occurred_at`),
  UNIQUE KEY `uq_sellers_performance_events_2` (`kind`, `subject_id`),
  CONSTRAINT `ck_sellers_performance_events_kind` CHECK (`kind` IN ('order_accepted', 'dispatched', 'dispatched_late', 'tracking_valid', 'tracking_missing', 'seller_cancelled', 'units_sold', 'return_requested', 'message_received', 'first_reply', 'case_opened', 'case_resolved', 'case_overdue', 'policy_violation'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_performance_snapshots` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `computed_at` DATETIME(3) NOT NULL,
  `window_from` DATE NOT NULL,
  `window_to` DATE NOT NULL,
  `order_count` INT NOT NULL,
  `metrics` JSON NOT NULL,
  `overall` TEXT NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sellers_performance_snapshots_1` (`seller_id`, `computed_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_performance_targets` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `metric` VARCHAR(255) NOT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `comparator` TEXT NOT NULL,
  `threshold` DECIMAL(14,4) NOT NULL,
  `unit` TEXT NOT NULL,
  `window_days` INT NOT NULL,
  `is_example` TINYINT(1) NOT NULL,
  `effective_from` DATE NOT NULL,
  `set_by` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sellers_performance_targets_1` (`metric`, `category_id`, `effective_from` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_warnings` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `title` TEXT NOT NULL,
  `detail` TEXT NOT NULL,
  `state` TEXT NOT NULL,
  `issued_by` TEXT NOT NULL,
  `issued_at` DATETIME(3) NOT NULL,
  `resolved_at` DATETIME(3) NULL,
  `resolution_note` TEXT NULL,
  `trust_enforcement_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sellers_warnings_1` (`seller_id`, `issued_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_restrictions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `title` TEXT NOT NULL,
  `reason_code` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `rule_ref` TEXT NULL,
  `affected_activities` JSON NOT NULL,
  `scope` JSON NOT NULL,
  `affected_summary` TEXT NOT NULL,
  `still_works` JSON NOT NULL,
  `to_resolve` TEXT NOT NULL,
  `appeal_route` JSON NOT NULL,
  `review_date` DATE NOT NULL,
  `started_at` DATETIME(3) NULL,
  `ends_at` DATETIME(3) NULL,
  `set_by` TEXT NOT NULL,
  `recommended_by` TEXT NULL,
  `trust_report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `trust_enforcement_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `resolution_evidence` JSON NOT NULL,
  `lifted_at` DATETIME(3) NULL,
  `lift_reason` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sellers_restrictions_ref` (`ref`),
  KEY `ix_sellers_restrictions_1` (`seller_id`, `state`),
  KEY `ix_sellers_restrictions_2` (`state`, `review_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_suspensions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `state` VARCHAR(32) NOT NULL,
  `reason_code` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `review_date` DATE NOT NULL,
  `open_orders` TEXT NOT NULL,
  `requested_by` TEXT NOT NULL,
  `second_reviewer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `trust_report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `trust_enforcement_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `appeal_route` JSON NOT NULL,
  `started_at` DATETIME(3) NULL,
  `ended_at` DATETIME(3) NULL,
  `end_reason` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sellers_suspensions_ref` (`ref`),
  KEY `ix_sellers_suspensions_1` (`seller_id`, `state`),
  CONSTRAINT `ck_sellers_suspensions_state` CHECK (`state` IN ('pending_approval', 'active', 'ended', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- sellers_payout_changes: partial unique on seller_id where `state` = 'pending'
-- sellers_payout_changes: partial unique on seller_id where `state` = 'verified'
CREATE TABLE `sellers_payout_changes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `account_holder_name` TEXT NOT NULL,
  `account_type` TEXT NOT NULL,
  `label` TEXT NOT NULL,
  `provider_destination_id` TEXT NOT NULL,
  `previous_label` TEXT NULL,
  `state` VARCHAR(32) NOT NULL,
  `rejection_reason` TEXT NULL,
  `review_id` TEXT NULL,
  `requested_by` JSON NOT NULL,
  `requested_at` DATETIME(3) NOT NULL,
  `decided_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sellers_payout_changes_1` (`seller_id`, `requested_at` DESC),
  UNIQUE KEY `uq_sellers_payout_changes_2` ((IF(`state` = 'pending', `seller_id`, NULL))),
  UNIQUE KEY `uq_sellers_payout_changes_3` ((IF(`state` = 'verified', `seller_id`, NULL))),
  CONSTRAINT `ck_sellers_payout_changes_kind` CHECK (`kind` IN ('initial', 'change')),
  CONSTRAINT `ck_sellers_payout_changes_state` CHECK (`state` IN ('pending', 'verified', 'rejected', 'replaced'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_pending_changes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `target_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `approval_request_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `payload` JSON NOT NULL,
  `reason` TEXT NOT NULL,
  `requested_by` JSON NOT NULL,
  `state` VARCHAR(32) NOT NULL,
  `requested_at` DATETIME(3) NOT NULL,
  `decided_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sellers_pending_changes_approval_request_id` (`approval_request_id`),
  KEY `ix_sellers_pending_changes_1` (`kind`, `state`),
  KEY `ix_sellers_pending_changes_2` (`seller_id`, `state`),
  CONSTRAINT `ck_sellers_pending_changes_kind` CHECK (`kind` IN ('closure', 'restriction_change', 'performance_targets')),
  CONSTRAINT `ck_sellers_pending_changes_state` CHECK (`state` IN ('pending', 'applied', 'declined'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_appeals` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `subject` VARCHAR(255) NOT NULL,
  `subject_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `level` INT NOT NULL,
  `argument` TEXT NOT NULL,
  `evidence_media_ids` JSON NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `reviewer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `original_decider_id` TEXT NOT NULL,
  `decide_by` DATETIME(3) NOT NULL,
  `decision` JSON NULL,
  `trust_report_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `submitted_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sellers_appeals_ref` (`ref`),
  KEY `ix_sellers_appeals_1` (`state`, `decide_by`),
  KEY `ix_sellers_appeals_2` (`seller_id`),
  UNIQUE KEY `uq_sellers_appeals_3` (`subject`, `subject_id`, `level`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_seller_notes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `application_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `body` TEXT NOT NULL,
  `author_id` TEXT NOT NULL,
  `author_name` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sellers_seller_notes_1` (`seller_id`, `created_at`),
  KEY `ix_sellers_seller_notes_2` (`application_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_account_events` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `title` TEXT NOT NULL,
  `detail` TEXT NULL,
  `visibility` VARCHAR(32) NOT NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `ref` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sellers_account_events_1` (`seller_id`, `at` DESC),
  CONSTRAINT `ck_sellers_account_events_visibility` CHECK (`visibility` IN ('seller', 'staff'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_template_grants` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `template` VARCHAR(32) NOT NULL,
  `permission` VARCHAR(255) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `applied_at` DATETIME(3) NULL,
  `members_updated` INT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sellers_template_grants_1` (`template`, `permission`),
  CONSTRAINT `ck_sellers_template_grants_template` CHECK (`template` IN ('products_inventory', 'shipping', 'customer_service'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `sellers_seller_invitations` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `email` VARCHAR(255) NOT NULL,
  `business_name` TEXT NOT NULL,
  `message` TEXT NULL,
  `code_hash` VARCHAR(255) NOT NULL,
  `invited_by` TEXT NOT NULL,
  `sent_at` DATETIME(3) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `application_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sellers_seller_invitations_code_hash` (`code_hash`),
  KEY `ix_sellers_seller_invitations_1` (`email`),
  KEY `ix_sellers_seller_invitations_2` (`state`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `sellers_applications` ADD CONSTRAINT `fk_sellers_applications_seller_id` FOREIGN KEY (`seller_id`) REFERENCES `sellers_sellers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_applications` ADD CONSTRAINT `fk_sellers_applications_invitation_id` FOREIGN KEY (`invitation_id`) REFERENCES `sellers_seller_invitations` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_application_documents` ADD CONSTRAINT `fk_sellers_application_documents_application_id` FOREIGN KEY (`application_id`) REFERENCES `sellers_applications` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_verification_checks` ADD CONSTRAINT `fk_sellers_verification_checks_application_id` FOREIGN KEY (`application_id`) REFERENCES `sellers_applications` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_verification_checks` ADD CONSTRAINT `fk_sellers_verification_checks_seller_id` FOREIGN KEY (`seller_id`) REFERENCES `sellers_sellers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_information_requests` ADD CONSTRAINT `fk_sellers_information_requests_application_id` FOREIGN KEY (`application_id`) REFERENCES `sellers_applications` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_risk_reviews` ADD CONSTRAINT `fk_sellers_risk_reviews_application_id` FOREIGN KEY (`application_id`) REFERENCES `sellers_applications` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_agreement_acceptances` ADD CONSTRAINT `fk_sellers_agreement_acceptances_seller_id` FOREIGN KEY (`seller_id`) REFERENCES `sellers_sellers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_agreement_acceptances` ADD CONSTRAINT `fk_sellers_agreement_acceptances_application_id` FOREIGN KEY (`application_id`) REFERENCES `sellers_applications` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_store_profiles` ADD CONSTRAINT `fk_sellers_store_profiles_seller_id` FOREIGN KEY (`seller_id`) REFERENCES `sellers_sellers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_featured_collections` ADD CONSTRAINT `fk_sellers_featured_collections_seller_id` FOREIGN KEY (`seller_id`) REFERENCES `sellers_sellers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_public_claims` ADD CONSTRAINT `fk_sellers_public_claims_seller_id` FOREIGN KEY (`seller_id`) REFERENCES `sellers_sellers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_change_requests` ADD CONSTRAINT `fk_sellers_change_requests_seller_id` FOREIGN KEY (`seller_id`) REFERENCES `sellers_sellers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_members` ADD CONSTRAINT `fk_sellers_members_seller_id` FOREIGN KEY (`seller_id`) REFERENCES `sellers_sellers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_performance_snapshots` ADD CONSTRAINT `fk_sellers_performance_snapshots_seller_id` FOREIGN KEY (`seller_id`) REFERENCES `sellers_sellers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_warnings` ADD CONSTRAINT `fk_sellers_warnings_seller_id` FOREIGN KEY (`seller_id`) REFERENCES `sellers_sellers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_restrictions` ADD CONSTRAINT `fk_sellers_restrictions_seller_id` FOREIGN KEY (`seller_id`) REFERENCES `sellers_sellers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_suspensions` ADD CONSTRAINT `fk_sellers_suspensions_seller_id` FOREIGN KEY (`seller_id`) REFERENCES `sellers_sellers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_payout_changes` ADD CONSTRAINT `fk_sellers_payout_changes_seller_id` FOREIGN KEY (`seller_id`) REFERENCES `sellers_sellers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_appeals` ADD CONSTRAINT `fk_sellers_appeals_seller_id` FOREIGN KEY (`seller_id`) REFERENCES `sellers_sellers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_seller_notes` ADD CONSTRAINT `fk_sellers_seller_notes_seller_id` FOREIGN KEY (`seller_id`) REFERENCES `sellers_sellers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_seller_notes` ADD CONSTRAINT `fk_sellers_seller_notes_application_id` FOREIGN KEY (`application_id`) REFERENCES `sellers_applications` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `sellers_account_events` ADD CONSTRAINT `fk_sellers_account_events_seller_id` FOREIGN KEY (`seller_id`) REFERENCES `sellers_sellers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
