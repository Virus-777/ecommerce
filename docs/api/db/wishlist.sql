-- wishlist: MySQL schema generated from docs/api/spec/modules/wishlist.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

-- wishlist_lists: partial unique on customer_id where `is_default` = 1
CREATE TABLE `wishlist_lists` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` TEXT NOT NULL,
  `is_default` TINYINT(1) NOT NULL,
  `share_token` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wishlist_lists_share_token` (`share_token`),
  KEY `ix_wishlist_lists_1` (`customer_id`),
  UNIQUE KEY `uq_wishlist_lists_2` ((IF(`is_default` = 1, `customer_id`, NULL)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `wishlist_items` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `list_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `price_when_saved` BIGINT NULL,
  `currency` TEXT NOT NULL,
  `note` TEXT NULL,
  `added_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wishlist_items_1` ((COALESCE(`list_id`, '')), (COALESCE(`product_id`, '')), (COALESCE(`variant_id`, ''))),
  KEY `ix_wishlist_items_2` (`customer_id`, `product_id`),
  KEY `ix_wishlist_items_3` (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `wishlist_alerts` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `kind` VARCHAR(255) NOT NULL,
  `target_price` BIGINT NULL,
  `reference_price` BIGINT NULL,
  `state` VARCHAR(255) NOT NULL,
  `triggered_at` DATETIME(3) NULL,
  `triggered_price` BIGINT NULL,
  `paused_reason` TEXT NULL,
  `last_notified_at` DATETIME(3) NULL,
  `armed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_wishlist_alerts_1` (`product_id`, `kind`, `state`),
  KEY `ix_wishlist_alerts_2` (`customer_id`, `state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `wishlist_items` ADD CONSTRAINT `fk_wishlist_items_list_id` FOREIGN KEY (`list_id`) REFERENCES `wishlist_lists` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `wishlist_alerts` ADD CONSTRAINT `fk_wishlist_alerts_item_id` FOREIGN KEY (`item_id`) REFERENCES `wishlist_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
