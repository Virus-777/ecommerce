-- orders: MySQL schema generated from docs/api/spec/modules/orders.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

-- orders_orders: FULLTEXT ngram over contact_name: terms shorter than the ngram size fall back to LIKE (§6.1)
-- orders_orders: FULLTEXT ngram over contact_email: terms shorter than the ngram size fall back to LIKE (§6.1)
-- orders_orders: multi-valued index on flag_kinds: queried with MEMBER OF, one per value for an AND (§8.1)
CREATE TABLE `orders_orders` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `ref` VARCHAR(255) NOT NULL,
  `checkout_session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `attempt_no` INT NOT NULL,
  `reservation_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `delivery_address_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `customer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `contact_email` VARCHAR(255) COLLATE utf8mb4_0900_as_ci NOT NULL,
  `contact_phone` TEXT NULL,
  `contact_name` VARCHAR(255) NOT NULL,
  `channel` TEXT NOT NULL,
  `lifecycle` VARCHAR(32) NOT NULL,
  `display_status` VARCHAR(255) NOT NULL,
  `flag_kinds` JSON NOT NULL,
  `currency` TEXT NOT NULL,
  `items_total` INT NOT NULL,
  `discount_total` INT NOT NULL,
  `shipping_total` INT NOT NULL,
  `tax_total` INT NOT NULL,
  `total` INT NOT NULL,
  `delivery_address` JSON NOT NULL,
  `gift_note` TEXT NULL,
  `hide_prices` TINYINT(1) NOT NULL,
  `policy_versions` JSON NOT NULL,
  `coupon_codes` JSON NOT NULL,
  `payment_intent_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `payment_state` TEXT NOT NULL,
  `payment_method_label` TEXT NOT NULL,
  `captured_total` INT NOT NULL,
  `refunded_total` INT NOT NULL,
  `placed_at` DATETIME(3) NOT NULL,
  `accepted_at` DATETIME(3) NULL,
  `completed_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_orders_orders_ref` (`ref`),
  UNIQUE KEY `uq_orders_orders_1` (`checkout_session_id`, `attempt_no`),
  KEY `ix_orders_orders_2` (`customer_id`, `placed_at` DESC),
  KEY `ix_orders_orders_3` (`contact_email`),
  KEY `ix_orders_orders_4` (`display_status`, `placed_at` DESC),
  KEY `ix_orders_orders_5` (`lifecycle`),
  FULLTEXT KEY `ft_orders_orders_6` (`contact_name`) WITH PARSER ngram,
  FULLTEXT KEY `ft_orders_orders_7` (`contact_email`) WITH PARSER ngram,
  KEY `mv_orders_orders_8` ((CAST(`flag_kinds` AS CHAR(64) ARRAY))),
  KEY `ix_orders_orders_9` (`ref`),
  CONSTRAINT `ck_orders_orders_lifecycle` CHECK (`lifecycle` IN ('payment_pending', 'open', 'completed', 'cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `orders_order_facts` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `source_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `shipment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `ref` TEXT NULL,
  `status` TEXT NULL,
  `subkind` TEXT NULL,
  `customer_action` TEXT NULL,
  `amount` INT NULL,
  `item_ids` JSON NULL,
  `due_at` DATETIME(3) NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_orders_order_facts_1` (`order_id`, `kind`, `source_id`),
  KEY `ix_orders_order_facts_2` (`kind`, `source_id`),
  CONSTRAINT `ck_orders_order_facts_kind` CHECK (`kind` IN ('capture', 'chargeback', 'case', 'refund_sent', 'refund_approval', 'delivery_issue', 'seller_restricted', 'confirmation_resent'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `orders_seller_groups` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `position` INT NOT NULL,
  `owner_type` TEXT NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `seller_name` TEXT NOT NULL,
  `ships_from` TEXT NOT NULL,
  `fulfilled_by` TEXT NOT NULL,
  `delivery` JSON NOT NULL,
  `dispatch_by` DATETIME(3) NOT NULL,
  `dispatch_by_history` JSON NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `return_terms_summary` TEXT NOT NULL,
  `items_total` INT NOT NULL,
  `discount_total` INT NOT NULL,
  `shipping_total` INT NOT NULL,
  `tax_total` INT NOT NULL,
  `total` INT NOT NULL,
  `shipped_at` DATETIME(3) NULL,
  `delivered_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  KEY `ix_orders_seller_groups_1` (`seller_id`, `status`, `dispatch_by`),
  KEY `ix_orders_seller_groups_2` (`order_id`),
  KEY `ix_orders_seller_groups_3` (`status`, `dispatch_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `orders_order_items` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `stock_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `product_snapshot` JSON NOT NULL,
  `offer_snapshot` JSON NOT NULL,
  `return_terms` JSON NOT NULL,
  `quantity` INT NOT NULL,
  `unit_price` INT NOT NULL,
  `discounts` JSON NOT NULL,
  `shipping_share` INT NOT NULL,
  `tax_share` INT NOT NULL,
  `paid_amount` INT NOT NULL,
  `refunded_amount` INT NOT NULL,
  `refund_status` TEXT NOT NULL,
  `state` VARCHAR(255) NOT NULL,
  `state_before_request` TEXT NULL,
  `shipment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `return_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `return_ref` TEXT NULL,
  `delivered_at` DATETIME(3) NULL,
  `return_window_ends_at` DATETIME(3) NULL,
  `split_from_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `replacement_of_item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `checkout_line_id` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_orders_order_items_1` (`order_id`),
  KEY `ix_orders_order_items_2` (`group_id`, `state`),
  KEY `ix_orders_order_items_3` (`offer_id`),
  KEY `ix_orders_order_items_4` (`product_id`),
  KEY `ix_orders_order_items_5` (`split_from_item_id`),
  KEY `ix_orders_order_items_6` (`return_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `orders_item_state_log` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `from_state` TEXT NOT NULL,
  `to_state` VARCHAR(255) NOT NULL,
  `event` TEXT NOT NULL,
  `reason` TEXT NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_orders_item_state_log_1` (`item_id`, `at`),
  KEY `ix_orders_item_state_log_2` (`to_state`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `orders_cancellations` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `initiated_by` TEXT NOT NULL,
  `reason_code` TEXT NOT NULL,
  `reason` TEXT NULL,
  `items` JSON NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `respond_by` DATETIME(3) NULL,
  `decided_by` JSON NULL,
  `decided_at` DATETIME(3) NULL,
  `decline_reason` TEXT NULL,
  `refund_preview` JSON NOT NULL,
  `refund_status` TEXT NOT NULL,
  `payment_refund_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `idempotency_key` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_orders_cancellations_1` (`group_id`, `status`),
  KEY `ix_orders_cancellations_2` (`status`, `respond_by`),
  UNIQUE KEY `uq_orders_cancellations_3` (`order_id`, `idempotency_key`),
  KEY `ix_orders_cancellations_4` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `orders_shipment_refs` (
  `shipment_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `package_label` TEXT NOT NULL,
  `carrier` TEXT NULL,
  `service` TEXT NULL,
  `tracking_number` VARCHAR(255) NULL,
  `tracking_url` TEXT NULL,
  `status` TEXT NOT NULL,
  `estimated_arrival` JSON NULL,
  `shipped_at` DATETIME(3) NULL,
  `delivered_at` DATETIME(3) NULL,
  `item_ids` JSON NOT NULL,
  `lines` JSON NULL,
  PRIMARY KEY (`shipment_id`),
  KEY `ix_orders_shipment_refs_1` (`order_id`),
  KEY `ix_orders_shipment_refs_2` (`tracking_number`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `orders_timeline` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `item_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `visibility` VARCHAR(32) NOT NULL,
  `label` TEXT NOT NULL,
  `detail` TEXT NULL,
  `reason` TEXT NULL,
  `actor_kind` TEXT NOT NULL,
  `actor_id` TEXT NULL,
  `actor_name` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_orders_timeline_1` (`order_id`, `at` DESC),
  CONSTRAINT `ck_orders_timeline_visibility` CHECK (`visibility` IN ('customer', 'seller', 'staff'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `orders_notes` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `text` TEXT NOT NULL,
  `author_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `author_name` TEXT NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_orders_notes_1` (`order_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `orders_documents` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `order_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `group_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `kind` TEXT NOT NULL,
  `number` VARCHAR(255) NOT NULL,
  `issued_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_orders_documents_number` (`number`),
  KEY `ix_orders_documents_1` (`order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `orders_saved_filters` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_staff_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` TEXT NOT NULL,
  `query` JSON NOT NULL,
  `shared` TINYINT(1) NOT NULL,
  `cached_count` INT NULL,
  `counted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `orders_order_facts` ADD CONSTRAINT `fk_orders_order_facts_order_id` FOREIGN KEY (`order_id`) REFERENCES `orders_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `orders_seller_groups` ADD CONSTRAINT `fk_orders_seller_groups_order_id` FOREIGN KEY (`order_id`) REFERENCES `orders_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `orders_order_items` ADD CONSTRAINT `fk_orders_order_items_order_id` FOREIGN KEY (`order_id`) REFERENCES `orders_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `orders_order_items` ADD CONSTRAINT `fk_orders_order_items_group_id` FOREIGN KEY (`group_id`) REFERENCES `orders_seller_groups` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `orders_order_items` ADD CONSTRAINT `fk_orders_order_items_split_from_item_id` FOREIGN KEY (`split_from_item_id`) REFERENCES `orders_order_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `orders_order_items` ADD CONSTRAINT `fk_orders_order_items_replacement_of_item_id` FOREIGN KEY (`replacement_of_item_id`) REFERENCES `orders_order_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `orders_item_state_log` ADD CONSTRAINT `fk_orders_item_state_log_item_id` FOREIGN KEY (`item_id`) REFERENCES `orders_order_items` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `orders_cancellations` ADD CONSTRAINT `fk_orders_cancellations_order_id` FOREIGN KEY (`order_id`) REFERENCES `orders_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `orders_cancellations` ADD CONSTRAINT `fk_orders_cancellations_group_id` FOREIGN KEY (`group_id`) REFERENCES `orders_seller_groups` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `orders_shipment_refs` ADD CONSTRAINT `fk_orders_shipment_refs_order_id` FOREIGN KEY (`order_id`) REFERENCES `orders_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `orders_shipment_refs` ADD CONSTRAINT `fk_orders_shipment_refs_group_id` FOREIGN KEY (`group_id`) REFERENCES `orders_seller_groups` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `orders_timeline` ADD CONSTRAINT `fk_orders_timeline_order_id` FOREIGN KEY (`order_id`) REFERENCES `orders_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `orders_notes` ADD CONSTRAINT `fk_orders_notes_order_id` FOREIGN KEY (`order_id`) REFERENCES `orders_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `orders_documents` ADD CONSTRAINT `fk_orders_documents_order_id` FOREIGN KEY (`order_id`) REFERENCES `orders_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- views: join shapes, merged into the query that reads them (§9.2)
CREATE OR REPLACE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW `orders_v_group_rows` AS
SELECT g.*,
  o.ref AS order_ref, o.placed_at, o.lifecycle, o.display_status, o.channel, o.currency, o.hide_prices,
  o.customer_id, o.contact_name, o.contact_email, o.contact_phone
FROM orders_seller_groups g
JOIN orders_orders o ON o.id = g.order_id;

CREATE OR REPLACE ALGORITHM=MERGE SQL SECURITY INVOKER VIEW `orders_v_item_rows` AS
SELECT i.*,
  o.ref AS order_ref, o.placed_at, o.lifecycle, o.display_status, o.currency, o.customer_id, o.contact_name,
  g.owner_type, g.seller_id, g.seller_name, g.fulfilled_by, g.status AS group_status, g.dispatch_by
FROM orders_order_items i
JOIN orders_orders o ON o.id = i.order_id
JOIN orders_seller_groups g ON g.id = i.group_id;
