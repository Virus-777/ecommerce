-- food: MySQL schema generated from docs/api/spec/modules/food.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

CREATE TABLE `food_categories` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `icon` TEXT NULL,
  `image_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `position` INT NOT NULL,
  `visible` TINYINT(1) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_food_categories_slug` (`slug`),
  KEY `ix_food_categories_1` (`position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `food_restaurants` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `name` TEXT NOT NULL,
  `cuisine` TEXT NOT NULL,
  `category_ids` JSON NOT NULL,
  `image_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `logo_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `photo_ids` JSON NOT NULL,
  `address` TEXT NULL,
  `city` TEXT NULL,
  `region` TEXT NULL,
  `postal_code` TEXT NULL,
  `lat` DECIMAL(9,6) NULL,
  `lng` DECIMAL(9,6) NULL,
  `point_source` VARCHAR(32) NULL,
  `phone` TEXT NULL,
  `hours` JSON NOT NULL,
  `time_zone` TEXT NOT NULL,
  `delivery_min` INT NOT NULL,
  `delivery_max` INT NOT NULL,
  `delivery_fee` BIGINT NOT NULL,
  `free_delivery_over` BIGINT NULL,
  `min_order` BIGINT NULL,
  `currency` TEXT NOT NULL,
  `promo_text` TEXT NULL,
  `promo_badge` TEXT NULL,
  `status` VARCHAR(32) NOT NULL,
  `position` INT NOT NULL,
  `rating_sum` INT NOT NULL,
  `rating_count` INT NOT NULL,
  `rating_stars` JSON NOT NULL,
  `search_text` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_food_restaurants_slug` (`slug`),
  KEY `ix_food_restaurants_1` (`status`, `position`),
  CONSTRAINT `ck_food_restaurants_point_source` CHECK (`point_source` IN ('geocoded', 'staff')),
  CONSTRAINT `ck_food_restaurants_status` CHECK (`status` IN ('draft', 'published', 'paused', 'hidden'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `food_sections` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `restaurant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` TEXT NOT NULL,
  `position` INT NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_food_sections_1` (`restaurant_id`, `position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `food_items` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `restaurant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `section_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` TEXT NOT NULL,
  `description` TEXT NULL,
  `photo_ids` JSON NOT NULL,
  `price` BIGINT NOT NULL,
  `was_price` BIGINT NULL,
  `currency` TEXT NOT NULL,
  `tag` TEXT NULL,
  `diet_tags` JSON NOT NULL,
  `popular` TINYINT(1) NOT NULL,
  `recommended` TINYINT(1) NOT NULL,
  `option_groups` JSON NOT NULL,
  `available` TINYINT(1) NOT NULL,
  `position` INT NOT NULL,
  `rating_sum` INT NOT NULL,
  `rating_count` INT NOT NULL,
  `rating_stars` JSON NOT NULL,
  `search_text` TEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_food_items_1` (`restaurant_id`, `section_id`, `position`),
  KEY `ix_food_items_2` (`recommended`, `available`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `food_baskets` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `restaurant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `lines` JSON NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_food_baskets_customer_id` (`customer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `food_orders` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `restaurant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `restaurant` JSON NOT NULL,
  `lines` JSON NOT NULL,
  `subtotal` BIGINT NOT NULL,
  `delivery_fee` BIGINT NOT NULL,
  `total` BIGINT NOT NULL,
  `currency` TEXT NOT NULL,
  `address` JSON NOT NULL,
  `courier_note` TEXT NULL,
  `contact_phone` TEXT NULL,
  `status` VARCHAR(32) NOT NULL,
  `history` JSON NOT NULL,
  `restaurant_note` TEXT NULL,
  `staff_note` TEXT NULL,
  `intent_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `attempts` INT NOT NULL,
  `method_label` TEXT NULL,
  `eta_from` DATETIME(3) NULL,
  `eta_to` DATETIME(3) NULL,
  `placed_at` DATETIME(3) NULL,
  `accepted_at` DATETIME(3) NULL,
  `delivered_at` DATETIME(3) NULL,
  `reviewed` TINYINT(1) NOT NULL,
  `idempotency_key` VARCHAR(255) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_food_orders_ref` (`ref`),
  UNIQUE KEY `uq_food_orders_idempotency_key` (`idempotency_key`),
  KEY `ix_food_orders_1` (`customer_id`, `created_at`),
  KEY `ix_food_orders_2` (`status`, `created_at`),
  KEY `ix_food_orders_3` (`restaurant_id`, `status`, `created_at`),
  KEY `ix_food_orders_4` (`intent_id`),
  CONSTRAINT `ck_food_orders_status` CHECK (`status` IN ('payment_pending', 'payment_failed', 'placed', 'accepted', 'preparing', 'on_the_way', 'delivered', 'cancelled', 'declined'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `food_saved_restaurants` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `restaurant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_food_saved_restaurants_1` (`customer_id`, `restaurant_id`),
  KEY `ix_food_saved_restaurants_2` (`customer_id`, `created_at`),
  KEY `ix_food_saved_restaurants_3` (`restaurant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `food_reviews` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `restaurant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `item_ids` JSON NOT NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` TEXT NOT NULL,
  `stars` INT NOT NULL,
  `text` TEXT NULL,
  `hidden` TINYINT(1) NOT NULL,
  `hidden_reason` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_food_reviews_order_id` (`order_id`),
  KEY `ix_food_reviews_1` (`restaurant_id`, `hidden`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `food_sections` ADD CONSTRAINT `fk_food_sections_restaurant_id` FOREIGN KEY (`restaurant_id`) REFERENCES `food_restaurants` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `food_items` ADD CONSTRAINT `fk_food_items_restaurant_id` FOREIGN KEY (`restaurant_id`) REFERENCES `food_restaurants` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `food_items` ADD CONSTRAINT `fk_food_items_section_id` FOREIGN KEY (`section_id`) REFERENCES `food_sections` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `food_orders` ADD CONSTRAINT `fk_food_orders_restaurant_id` FOREIGN KEY (`restaurant_id`) REFERENCES `food_restaurants` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `food_saved_restaurants` ADD CONSTRAINT `fk_food_saved_restaurants_restaurant_id` FOREIGN KEY (`restaurant_id`) REFERENCES `food_restaurants` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `food_reviews` ADD CONSTRAINT `fk_food_reviews_order_id` FOREIGN KEY (`order_id`) REFERENCES `food_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `food_reviews` ADD CONSTRAINT `fk_food_reviews_restaurant_id` FOREIGN KEY (`restaurant_id`) REFERENCES `food_restaurants` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
