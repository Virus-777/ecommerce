-- reviews: MySQL schema generated from docs/api/spec/modules/reviews.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `reviews_product_reviews` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `display_name` TEXT NOT NULL,
  `show_name` TINYINT(1) NOT NULL,
  `verified` TINYINT(1) NOT NULL,
  `rating` INT NOT NULL,
  `headline` TEXT NOT NULL,
  `body` TEXT NOT NULL,
  `media_ids` JSON NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `visible` TINYINT(1) NOT NULL,
  `helpful_count` INT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `published_at` DATETIME(3) NULL,
  `edited_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reviews_product_reviews_1` (`customer_id`, `product_id`),
  KEY `ix_reviews_product_reviews_2` (`product_id`, `status`, `helpful_count` DESC),
  KEY `ix_reviews_product_reviews_3` (`product_id`, `status`, `published_at` DESC),
  KEY `ix_reviews_product_reviews_4` (`seller_id`, `published_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reviews_seller_feedback` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `display_name` TEXT NOT NULL,
  `as_described` TINYINT(1) NOT NULL,
  `dispatch_rating` INT NOT NULL,
  `communication_rating` INT NULL,
  `overall` INT NOT NULL,
  `sentiment` TEXT NOT NULL,
  `comment` TEXT NULL,
  `status` VARCHAR(255) NOT NULL,
  `visible` TINYINT(1) NOT NULL,
  `refunded` TINYINT(1) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `edited_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reviews_seller_feedback_1` (`order_id`, `seller_id`, `customer_id`),
  KEY `ix_reviews_seller_feedback_2` (`seller_id`, `status`, `created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reviews_seller_responses` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `target_type` VARCHAR(255) NOT NULL,
  `target_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `text` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `rule_check` JSON NOT NULL,
  `created_by` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `published_at` DATETIME(3) NULL,
  `editable_until` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reviews_seller_responses_1` (`target_type`, `target_id`),
  KEY `ix_reviews_seller_responses_2` (`seller_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reviews_questions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `display_name` TEXT NOT NULL,
  `text` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `answer_count` INT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_reviews_questions_1` (`product_id`, `status`, `created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reviews_answers` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `question_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `author_kind` TEXT NOT NULL,
  `author_id` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `display_name` TEXT NOT NULL,
  `text` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `rule_check` JSON NOT NULL,
  `helpful_count` INT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `published_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_reviews_answers_1` (`question_id`, `status`),
  KEY `ix_reviews_answers_2` (`seller_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reviews_question_skips` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `question_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `skipped_by` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reviews_question_skips_1` (`seller_id`, `question_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- reviews_helpful_votes: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `reviews_helpful_votes` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `target_type` VARCHAR(255) NOT NULL,
  `target_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `helpful` TINYINT(1) NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_reviews_helpful_votes_1` (`target_type`, `target_id`, `customer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reviews_reports` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `target_type` TEXT NOT NULL,
  `target_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `moderation_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reporter_kind` VARCHAR(255) NOT NULL,
  `reporter_id` VARCHAR(255) NULL,
  `reason` TEXT NOT NULL,
  `note` TEXT NULL,
  `status` TEXT NOT NULL,
  `outcome_text` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `decided_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_reviews_reports_1` (`reporter_kind`, `reporter_id`, `created_at` DESC),
  KEY `ix_reviews_reports_2` (`moderation_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reviews_moderation_items` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `content_type` VARCHAR(255) NOT NULL,
  `content_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `queue` VARCHAR(255) NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `visibility` TEXT NOT NULL,
  `reasons` JSON NOT NULL,
  `report_count` INT NOT NULL,
  `first_reported_at` DATETIME(3) NOT NULL,
  `decided_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_reviews_moderation_items_1` (`status`, `queue`, `first_reported_at`),
  KEY `ix_reviews_moderation_items_2` (`content_type`, `content_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reviews_moderation_decisions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `moderation_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `decision` TEXT NOT NULL,
  `reason_code` TEXT NOT NULL,
  `message_to_reporter` TEXT NULL,
  `message_to_author` TEXT NULL,
  `edit_request` TEXT NULL,
  `moderator_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `decided_at` DATETIME(3) NOT NULL,
  `appeal_by` DATETIME(3) NULL,
  `trust_enforcement_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`id`),
  KEY `ix_reviews_moderation_decisions_1` (`moderation_item_id`),
  KEY `ix_reviews_moderation_decisions_2` (`trust_enforcement_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reviews_referrals` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `moderation_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `content_type` VARCHAR(255) NOT NULL,
  `content_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `author_id` TEXT NOT NULL,
  `note` TEXT NOT NULL,
  `referred_by` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `referred_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_reviews_referrals_1` (`moderation_item_id`),
  KEY `ix_reviews_referrals_2` (`content_type`, `content_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reviews_appeals` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `decision_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `content_type` TEXT NOT NULL,
  `content_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `by_kind` TEXT NOT NULL,
  `by_id` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `reviewer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `outcome` TEXT NULL,
  `submitted_at` DATETIME(3) NOT NULL,
  `decided_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_reviews_appeals_1` (`status`, `submitted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reviews_product_rating_summaries` (
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `rating_count` INT NOT NULL,
  `written_count` INT NOT NULL,
  `sum_ratings` INT NOT NULL,
  `distribution` JSON NOT NULL,
  `with_photos` INT NOT NULL,
  `answered_questions` INT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reviews_review_invites` (
  `order_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `delivered_at` DATETIME(3) NOT NULL,
  `due_at` DATETIME(3) NOT NULL,
  `state` VARCHAR(32) NOT NULL,
  `sent_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`order_item_id`),
  KEY `ix_reviews_review_invites_1` (`state`, `due_at`),
  KEY `ix_reviews_review_invites_2` (`customer_id`),
  CONSTRAINT `ck_reviews_review_invites_state` CHECK (`state` IN ('pending', 'sent', 'cancelled', 'reviewed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `reviews_seller_feedback_summaries` (
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `count` INT NOT NULL,
  `positive` INT NOT NULL,
  `neutral` INT NOT NULL,
  `negative` INT NOT NULL,
  `as_described_yes` INT NOT NULL,
  `dispatch_sum` INT NOT NULL,
  `communication_sum` INT NOT NULL,
  `communication_count` INT NOT NULL,
  `overall_sum` INT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`seller_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `reviews_answers` ADD CONSTRAINT `fk_reviews_answers_question_id` FOREIGN KEY (`question_id`) REFERENCES `reviews_questions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `reviews_question_skips` ADD CONSTRAINT `fk_reviews_question_skips_question_id` FOREIGN KEY (`question_id`) REFERENCES `reviews_questions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `reviews_reports` ADD CONSTRAINT `fk_reviews_reports_moderation_item_id` FOREIGN KEY (`moderation_item_id`) REFERENCES `reviews_moderation_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `reviews_moderation_decisions` ADD CONSTRAINT `fk_reviews_moderation_decisions_moderation_item_id` FOREIGN KEY (`moderation_item_id`) REFERENCES `reviews_moderation_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `reviews_referrals` ADD CONSTRAINT `fk_reviews_referrals_moderation_item_id` FOREIGN KEY (`moderation_item_id`) REFERENCES `reviews_moderation_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `reviews_appeals` ADD CONSTRAINT `fk_reviews_appeals_decision_id` FOREIGN KEY (`decision_id`) REFERENCES `reviews_moderation_decisions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
