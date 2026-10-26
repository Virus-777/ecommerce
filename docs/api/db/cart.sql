-- cart: MySQL schema generated from docs/api/spec/modules/cart.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

-- cart_carts: partial unique on customer_id where `status` = 'active'
-- cart_carts: partial unique on guest_session_id where `status` = 'active'
CREATE TABLE `cart_carts` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_kind` VARCHAR(32) NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `guest_session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `status` VARCHAR(32) NOT NULL,
  `currency` TEXT NOT NULL,
  `destination` JSON NULL,
  `coupon_codes` JSON NOT NULL,
  `merged_into_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `checked_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cart_carts_1` ((IF(`status` = 'active', `customer_id`, NULL))),
  UNIQUE KEY `uq_cart_carts_2` ((IF(`status` = 'active', `guest_session_id`, NULL))),
  KEY `ix_cart_carts_3` (`status`, `expires_at`),
  KEY `ix_cart_carts_4` (`customer_id`, `status`),
  KEY `ix_cart_carts_5` (`guest_session_id`, `status`),
  CONSTRAINT `ck_cart_carts_owner_kind` CHECK (`owner_kind` IN ('customer', 'guest')),
  CONSTRAINT `ck_cart_carts_status` CHECK (`status` IN ('active', 'merged', 'converted', 'expired'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `cart_cart_items` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `cart_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_type` VARCHAR(32) NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ships_from` TEXT NOT NULL,
  `fulfilled_by` VARCHAR(32) NULL,
  `condition` VARCHAR(32) NULL,
  `quantity` INT NOT NULL,
  `price_at_add` INT NOT NULL,
  `accepted_price` INT NOT NULL,
  `accepted_terms_version` INT NOT NULL,
  `currency` TEXT NOT NULL,
  `source` TEXT NULL,
  `added_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `last_checked_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cart_cart_items_1` (`cart_id`, `offer_id`),
  KEY `ix_cart_cart_items_2` (`offer_id`),
  KEY `ix_cart_cart_items_3` (`seller_id`),
  KEY `ix_cart_cart_items_4` (`stock_item_id`),
  KEY `ix_cart_cart_items_5` (`product_id`),
  CONSTRAINT `ck_cart_cart_items_owner_type` CHECK (`owner_type` IN ('official', 'seller')),
  CONSTRAINT `ck_cart_cart_items_fulfilled_by` CHECK (`fulfilled_by` IN ('official_warehouse', 'seller', 'marketly_service')),
  CONSTRAINT `ck_cart_cart_items_condition` CHECK (`condition` IN ('new', 'used_like_new', 'used_good', 'used_acceptable', 'refurbished'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `cart_cart_item_notices` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` TEXT NOT NULL,
  `severity` TEXT NOT NULL,
  `previous` JSON NOT NULL,
  `current` JSON NOT NULL,
  `detected_at` DATETIME(3) NOT NULL,
  `accepted_at` DATETIME(3) NULL,
  `resolved_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_cart_cart_item_notices_1` (`item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `cart_saved_items` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_kind` TEXT NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `guest_session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `saved_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cart_saved_items_1` (`customer_id`, `offer_id`),
  UNIQUE KEY `uq_cart_saved_items_2` (`guest_session_id`, `offer_id`),
  KEY `ix_cart_saved_items_3` (`guest_session_id`),
  KEY `ix_cart_saved_items_4` (`customer_id`, `saved_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `cart_cart_merges` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `from_cart_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `into_cart_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `report` JSON NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_cart_cart_merges_1` (`from_cart_id`),
  KEY `ix_cart_cart_merges_2` (`into_cart_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `cart_recheck_queue` (
  `item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reason` TEXT NOT NULL,
  `queued_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`item_id`),
  KEY `ix_cart_recheck_queue_1` (`queued_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `cart_carts` ADD CONSTRAINT `fk_cart_carts_merged_into_id` FOREIGN KEY (`merged_into_id`) REFERENCES `cart_carts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `cart_cart_items` ADD CONSTRAINT `fk_cart_cart_items_cart_id` FOREIGN KEY (`cart_id`) REFERENCES `cart_carts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `cart_cart_item_notices` ADD CONSTRAINT `fk_cart_cart_item_notices_item_id` FOREIGN KEY (`item_id`) REFERENCES `cart_cart_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `cart_cart_merges` ADD CONSTRAINT `fk_cart_cart_merges_from_cart_id` FOREIGN KEY (`from_cart_id`) REFERENCES `cart_carts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `cart_cart_merges` ADD CONSTRAINT `fk_cart_cart_merges_into_cart_id` FOREIGN KEY (`into_cart_id`) REFERENCES `cart_carts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `cart_recheck_queue` ADD CONSTRAINT `fk_cart_recheck_queue_item_id` FOREIGN KEY (`item_id`) REFERENCES `cart_cart_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
