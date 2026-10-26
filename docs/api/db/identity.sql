-- identity: MySQL schema generated from docs/api/spec/modules/identity.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

-- identity_accounts: partial index: tokens_valid_after from "where `tokens_valid_after` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `identity_accounts` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `realm` VARCHAR(32) NOT NULL,
  `email` TEXT NOT NULL,
  `email_normalized` VARCHAR(255) NOT NULL,
  `email_verified_at` DATETIME(3) NULL,
  `display_name` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `password_hash` TEXT NULL,
  `password_changed_at` DATETIME(3) NULL,
  `must_reset_password` TINYINT(1) NOT NULL,
  `failed_sign_ins` INT NOT NULL,
  `failed_window_started_at` DATETIME(3) NULL,
  `locked_until` DATETIME(3) NULL,
  `lock_reason` TEXT NULL,
  `locked_by` TEXT NULL,
  `closed_at` DATETIME(3) NULL,
  `accepted_terms_version` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `last_sign_in_at` DATETIME(3) NULL,
  `last_active_at` DATETIME(3) NULL,
  `version` INT NOT NULL,
  `tokens_valid_after` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_identity_accounts_1` (`realm`, `email_normalized`),
  KEY `ix_identity_accounts_2` (`status`, `id`),
  KEY `ix_identity_accounts_3` (`realm`, `created_at`),
  KEY `ix_identity_accounts_4` (`tokens_valid_after`),
  CONSTRAINT `ck_identity_accounts_realm` CHECK (`realm` IN ('member', 'staff'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `identity_password_history` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `password_hash` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_identity_password_history_1` (`account_id`, `created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- identity_two_step_methods: partial index: account_id plus removed_at from "where `removed_at` IS NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `identity_two_step_methods` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `method` VARCHAR(32) NOT NULL,
  `secret_encrypted` BLOB NULL,
  `phone_e164_encrypted` BLOB NULL,
  `phone_masked` TEXT NULL,
  `confirmed_at` DATETIME(3) NULL,
  `last_used_at` DATETIME(3) NULL,
  `last_used_step` BIGINT NULL,
  `removed_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_identity_two_step_methods_1` (`account_id`, `removed_at`),
  CONSTRAINT `ck_identity_two_step_methods_method` CHECK (`method` IN ('totp', 'sms'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `identity_recovery_codes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `code_hash` TEXT NOT NULL,
  `batch_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `used_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_identity_recovery_codes_1` (`account_id`, `batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `identity_challenges` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `purpose` VARCHAR(32) NOT NULL,
  `target_email` TEXT NULL,
  `code_hash` TEXT NULL,
  `payload` JSON NOT NULL,
  `attempts` INT NOT NULL,
  `max_attempts` INT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `resend_available_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `completed_at` DATETIME(3) NULL,
  `target_phone_encrypted` BLOB NULL,
  PRIMARY KEY (`id`),
  KEY `ix_identity_challenges_1` (`account_id`, `purpose`, `status`),
  KEY `ix_identity_challenges_2` (`expires_at`),
  CONSTRAINT `ck_identity_challenges_purpose` CHECK (`purpose` IN ('email_verification', 'email_change', 'phone_verification', 'sign_in_second_factor', 'two_step_setup'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `identity_password_resets` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `token_hash` VARCHAR(255) NOT NULL,
  `forced_by` TEXT NULL,
  `forced_reason` TEXT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `used_at` DATETIME(3) NULL,
  `requested_ip` VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_identity_password_resets_token_hash` (`token_hash`),
  KEY `ix_identity_password_resets_1` (`account_id`, `created_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- identity_devices: partial unique on account_id, installation_id where `installation_id` IS NOT NULL
CREATE TABLE `identity_devices` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `label` TEXT NOT NULL,
  `installation_id` VARCHAR(255) NULL,
  `user_agent` TEXT NULL,
  `app_version` TEXT NULL,
  `last_ip` VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `last_location` TEXT NULL,
  `two_step_trusted_until` DATETIME(3) NULL,
  `first_seen_at` DATETIME(3) NOT NULL,
  `last_active_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_identity_devices_1` (`account_id`, `last_active_at` DESC),
  UNIQUE KEY `uq_identity_devices_2` ((IF(`installation_id` IS NOT NULL, `account_id`, NULL)), `installation_id`),
  CONSTRAINT `ck_identity_devices_kind` CHECK (`kind` IN ('web', 'android'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- identity_sessions: partial index: account_id plus revoked_at from "where `revoked_at` IS NULL" — confirm the column order with EXPLAIN in Y2
-- identity_sessions: partial index: seller_id plus revoked_at from "where `revoked_at` IS NULL" — confirm the column order with EXPLAIN in Y2
-- identity_sessions: partial index: previous_token_hash from "where `previous_token_hash` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
-- identity_sessions: partial index: revoked_at from "where `revoked_at` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `identity_sessions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `device_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `audience` VARCHAR(32) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `seller_member_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `refresh_token_hash` VARCHAR(255) NOT NULL,
  `previous_token_hash` VARCHAR(255) NULL,
  `keep_signed_in` TINYINT(1) NOT NULL,
  `two_step_verified_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `last_refreshed_at` DATETIME(3) NOT NULL,
  `last_active_at` DATETIME(3) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `absolute_expires_at` DATETIME(3) NOT NULL,
  `revoked_at` DATETIME(3) NULL,
  `revoke_reason` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_identity_sessions_refresh_token_hash` (`refresh_token_hash`),
  KEY `ix_identity_sessions_1` (`account_id`, `revoked_at`),
  KEY `ix_identity_sessions_2` (`device_id`),
  KEY `ix_identity_sessions_3` (`seller_id`, `revoked_at`),
  KEY `ix_identity_sessions_4` (`previous_token_hash`),
  KEY `ix_identity_sessions_5` (`revoked_at`),
  CONSTRAINT `ck_identity_sessions_audience` CHECK (`audience` IN ('store', 'seller', 'admin'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `identity_seller_access` (
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_member_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_name` TEXT NOT NULL,
  `role_label` TEXT NOT NULL,
  `is_owner` TINYINT(1) NOT NULL,
  `granted_at` DATETIME(3) NOT NULL,
  `revoked_at` DATETIME(3) NULL,
  `last_used_at` DATETIME(3) NULL,
  PRIMARY KEY (`account_id`, `seller_id`),
  KEY `ix_identity_seller_access_2` (`seller_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- identity_invitations: partial index: account_id from "where `account_id` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `identity_invitations` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `realm` TEXT NOT NULL,
  `purpose` VARCHAR(32) NOT NULL,
  `email` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `context_ref` TEXT NULL,
  `context_label` TEXT NULL,
  `token_hash` VARCHAR(255) NOT NULL,
  `pass_code_hash` TEXT NULL,
  `pass_code_attempts` INT NOT NULL,
  `invited_by_kind` TEXT NOT NULL,
  `invited_by_id` TEXT NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `sent_at` DATETIME(3) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `accepted_at` DATETIME(3) NULL,
  `revoked_at` DATETIME(3) NULL,
  `revoke_reason` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_identity_invitations_token_hash` (`token_hash`),
  KEY `ix_identity_invitations_1` (`status`, `expires_at`),
  KEY `ix_identity_invitations_2` (`email`),
  KEY `ix_identity_invitations_3` (`account_id`),
  CONSTRAINT `ck_identity_invitations_purpose` CHECK (`purpose` IN ('staff', 'seller_member'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- identity_guest_sessions: partial index: previous_token_hash from "where `previous_token_hash` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
-- identity_guest_sessions: partial index: claimed_at from "where `claimed_at` IS NOT NULL" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `identity_guest_sessions` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `device_kind` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `last_seen_at` DATETIME(3) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `claimed_by_account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `claimed_at` DATETIME(3) NULL,
  `audience` VARCHAR(32) NOT NULL,
  `refresh_token_hash` VARCHAR(255) NOT NULL,
  `previous_token_hash` VARCHAR(255) NULL,
  `rotated_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_identity_guest_sessions_refresh_token_hash` (`refresh_token_hash`),
  KEY `ix_identity_guest_sessions_1` (`expires_at`),
  KEY `ix_identity_guest_sessions_2` (`previous_token_hash`),
  KEY `ix_identity_guest_sessions_3` (`claimed_at`),
  CONSTRAINT `ck_identity_guest_sessions_audience` CHECK (`audience` IN ('store', 'seller', 'admin'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `identity_guest_order_grants` (
  `guest_session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `email_normalized` VARCHAR(255) NOT NULL,
  `via` VARCHAR(32) NOT NULL,
  `granted_at` DATETIME(3) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`guest_session_id`, `order_id`),
  KEY `ix_identity_guest_order_grants_2` (`email_normalized`),
  CONSTRAINT `ck_identity_guest_order_grants_via` CHECK (`via` IN ('checkout', 'lookup', 'link'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `identity_order_links` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `token_hash` VARCHAR(255) NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_ref` TEXT NULL,
  `email_normalized` TEXT NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `last_redeemed_at` DATETIME(3) NULL,
  `redeem_count` INT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_identity_order_links_token_hash` (`token_hash`),
  KEY `ix_identity_order_links_1` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `identity_security_events` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(255) NOT NULL,
  `result` TEXT NOT NULL,
  `audience` TEXT NULL,
  `device_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `device_label` TEXT NULL,
  `ip` VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `location` TEXT NULL,
  `actor_kind` TEXT NULL,
  `actor_id` TEXT NULL,
  `reason` TEXT NULL,
  `detail` JSON NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_identity_security_events_1` (`account_id`, `at` DESC),
  KEY `ix_identity_security_events_2` (`kind`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `identity_sign_in_attempts` (
  `id` BIGINT NOT NULL,
  `email_normalized` VARCHAR(255) NOT NULL,
  `ip` VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `succeeded` TINYINT(1) NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_identity_sign_in_attempts_1` (`email_normalized`, `at`),
  KEY `ix_identity_sign_in_attempts_2` (`ip`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `identity_reauth_tokens` (
  `token_hash` VARCHAR(255) NOT NULL,
  `account_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `purpose` TEXT NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `used_at` DATETIME(3) NULL,
  PRIMARY KEY (`token_hash`),
  KEY `ix_identity_reauth_tokens_1` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `identity_password_history` ADD CONSTRAINT `fk_identity_password_history_account_id` FOREIGN KEY (`account_id`) REFERENCES `identity_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `identity_two_step_methods` ADD CONSTRAINT `fk_identity_two_step_methods_account_id` FOREIGN KEY (`account_id`) REFERENCES `identity_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `identity_recovery_codes` ADD CONSTRAINT `fk_identity_recovery_codes_account_id` FOREIGN KEY (`account_id`) REFERENCES `identity_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `identity_challenges` ADD CONSTRAINT `fk_identity_challenges_account_id` FOREIGN KEY (`account_id`) REFERENCES `identity_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `identity_password_resets` ADD CONSTRAINT `fk_identity_password_resets_account_id` FOREIGN KEY (`account_id`) REFERENCES `identity_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `identity_devices` ADD CONSTRAINT `fk_identity_devices_account_id` FOREIGN KEY (`account_id`) REFERENCES `identity_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `identity_sessions` ADD CONSTRAINT `fk_identity_sessions_account_id` FOREIGN KEY (`account_id`) REFERENCES `identity_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `identity_sessions` ADD CONSTRAINT `fk_identity_sessions_device_id` FOREIGN KEY (`device_id`) REFERENCES `identity_devices` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `identity_seller_access` ADD CONSTRAINT `fk_identity_seller_access_account_id` FOREIGN KEY (`account_id`) REFERENCES `identity_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `identity_invitations` ADD CONSTRAINT `fk_identity_invitations_account_id` FOREIGN KEY (`account_id`) REFERENCES `identity_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `identity_guest_order_grants` ADD CONSTRAINT `fk_identity_guest_order_grants_guest_session_id` FOREIGN KEY (`guest_session_id`) REFERENCES `identity_guest_sessions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `identity_security_events` ADD CONSTRAINT `fk_identity_security_events_account_id` FOREIGN KEY (`account_id`) REFERENCES `identity_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `identity_reauth_tokens` ADD CONSTRAINT `fk_identity_reauth_tokens_account_id` FOREIGN KEY (`account_id`) REFERENCES `identity_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `identity_reauth_tokens` ADD CONSTRAINT `fk_identity_reauth_tokens_session_id` FOREIGN KEY (`session_id`) REFERENCES `identity_sessions` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
