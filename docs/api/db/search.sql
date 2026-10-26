-- search: MySQL schema generated from docs/api/spec/modules/search.json by `npm run gen`.
-- Do not edit: change the spec and regenerate. Tables first, then foreign keys, then the append-only guards.

-- search_search_documents: gin(terms jsonb_path_ops) becomes generated columns, chosen per query in Y2 (Appendix B); no key emitted
-- search_search_documents: FULLTEXT ngram over title_norm: terms shorter than the ngram size fall back to LIKE (§6.1)
-- search_search_documents: multi-valued index on seller_ids: queried with MEMBER OF, one per value for an AND (§8.1)
-- search_search_documents: multi-valued index on category_path_ids: queried with MEMBER OF, one per value for an AND (§8.1)
-- search_search_documents: gin(attributes jsonb_path_ops) becomes generated columns, chosen per query in Y2 (Appendix B); no key emitted
-- search_search_documents: no key for (category_path_ids, rank_in_stock, product_id): category_path_ids, rank_in_stock is an array column. §8.1 makes this a child table or a multi-valued index — write the one the query needs in the spec as gin(...) or a child table
-- search_search_documents: no key for (category_path_ids, rank_all, product_id): category_path_ids, rank_all is an array column. §8.1 makes this a child table or a multi-valued index — write the one the query needs in the spec as gin(...) or a child table
CREATE TABLE `search_search_documents` (
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `slug` TEXT NOT NULL,
  `title` TEXT NOT NULL,
  `brand_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `brand_name` TEXT NULL,
  `category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `category_path_ids` JSON NOT NULL,
  `attributes` JSON NOT NULL,
  `variant_count` INT NOT NULL,
  `variant_options` JSON NOT NULL,
  `image` JSON NULL,
  `seller_ids` JSON NOT NULL,
  `has_official` TINYINT(1) NOT NULL,
  `conditions` JSON NOT NULL,
  `offer_count` INT NOT NULL,
  `featured_offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `featured_price` BIGINT NULL,
  `featured_seller_name` TEXT NULL,
  `featured_official` TINYINT(1) NOT NULL,
  `min_price` BIGINT NULL,
  `max_price` BIGINT NULL,
  `currency` CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `was_price` BIGINT NULL,
  `deal_ends_at` DATETIME(3) NULL,
  `on_sale` TINYINT(1) NOT NULL,
  `gtins` JSON NOT NULL,
  `variant_gtins` JSON NOT NULL,
  `badges` JSON NOT NULL,
  `in_stock` TINYINT(1) NOT NULL,
  `low_stock` TINYINT(1) NOT NULL,
  `free_delivery` TINYINT(1) NOT NULL,
  `fastest_dispatch_days` INT NULL,
  `same_day_cutoff` TIME NULL,
  `rating` DECIMAL(2,1) NULL,
  `rating_count` INT NOT NULL,
  `sales_30d` INT NOT NULL,
  `first_listed_at` DATETIME(3) NOT NULL,
  `popularity` DECIMAL(12,6) NOT NULL,
  `terms` JSON NULL,
  `title_norm` VARCHAR(255) NOT NULL,
  `version` BIGINT NOT NULL,
  `indexed_at` DATETIME(3) NOT NULL,
  `offers` JSON NULL,
  `card_all` JSON NULL,
  `card_all_n` INT NULL,
  `card_in_stock` JSON NULL,
  `card_in_stock_n` INT NULL,
  `rank_all` JSON NULL,
  `rank_in_stock` JSON NULL,
  `rank_key` VARCHAR(255) NULL,
  `best_seller_rank` INT NULL,
  `best_seller_category_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (`product_id`),
  FULLTEXT KEY `ft_search_search_documents_2` (`title_norm`) WITH PARSER ngram,
  KEY `mv_search_search_documents_3` ((CAST(`seller_ids` AS CHAR(64) ARRAY))),
  KEY `mv_search_search_documents_4` ((CAST(`category_path_ids` AS CHAR(64) ARRAY))),
  KEY `ix_search_search_documents_6` (`in_stock`, `featured_price`),
  KEY `ix_search_search_documents_7` (`first_listed_at`),
  KEY `ix_search_search_documents_8` (`rating`, `rating_count`),
  KEY `ix_search_search_documents_9` (`brand_id`),
  KEY `ix_search_search_documents_10` (`sales_30d`),
  KEY `ix_search_search_documents_11` (`rank_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `search_search_offers` (
  `offer_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `variant_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `seller_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `official` TINYINT(1) NOT NULL,
  `condition` VARCHAR(255) NOT NULL,
  `price` BIGINT NOT NULL,
  `in_stock` TINYINT(1) NOT NULL,
  `free_delivery` TINYINT(1) NOT NULL,
  `dispatch_days` INT NOT NULL,
  `featured_eligible` TINYINT(1) NOT NULL,
  PRIMARY KEY (`offer_id`),
  KEY `ix_search_search_offers_1` (`product_id`),
  KEY `ix_search_search_offers_2` (`seller_id`, `price`),
  KEY `ix_search_search_offers_3` (`condition`, `price`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- search_suggestion_terms: FULLTEXT ngram over term: terms shorter than the ngram size fall back to LIKE (§6.1)
CREATE TABLE `search_suggestion_terms` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `term` VARCHAR(255) NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `target_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `weight` DECIMAL(12,6) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  FULLTEXT KEY `ft_search_suggestion_terms_1` (`term`) WITH PARSER ngram,
  KEY `ix_search_suggestion_terms_2` (`kind`, `weight` DESC),
  CONSTRAINT `ck_search_suggestion_terms_kind` CHECK (`kind` IN ('query', 'category', 'brand', 'store', 'product'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `search_synonyms` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `terms` JSON NOT NULL,
  `kind` TEXT NOT NULL,
  `from_term` TEXT NULL,
  `active` TINYINT(1) NOT NULL,
  `note` TEXT NULL,
  `updated_by` TEXT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `search_recent_searches` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_kind` VARCHAR(32) NOT NULL,
  `owner_id` VARCHAR(255) NOT NULL,
  `query` TEXT NOT NULL,
  `filters` JSON NOT NULL,
  `searched_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_search_recent_searches_1` (`owner_kind`, `owner_id`, `searched_at` DESC),
  CONSTRAINT `ck_search_recent_searches_owner_kind` CHECK (`owner_kind` IN ('customer', 'guest'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- search_query_log: partial index: results, at from "where `results` = 0" — confirm the column order with EXPLAIN in Y2
CREATE TABLE `search_query_log` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `search_id` TEXT NOT NULL,
  `raw` TEXT NULL,
  `normalized` VARCHAR(255) NULL,
  `filters` JSON NOT NULL,
  `sort` TEXT NOT NULL,
  `results` INT NOT NULL,
  `corrected_to` TEXT NULL,
  `session_key` TEXT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_search_query_log_1` (`normalized`, `at`),
  KEY `ix_search_query_log_2` (`results`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- search_click_log: no key in the spec: an invisible row_id is the primary key, so SELECT * keeps the spec shape (§5.3)
CREATE TABLE `search_click_log` (
  `row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE,
  `search_id` VARCHAR(255) NOT NULL,
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `position` INT NOT NULL,
  `sponsored` TINYINT(1) NOT NULL,
  `at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`row_id`),
  KEY `ix_search_click_log_1` (`search_id`),
  KEY `ix_search_click_log_2` (`product_id`, `at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `search_product_sales_daily` (
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `day` DATE NOT NULL,
  `units` INT NOT NULL,
  `orders` INT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`product_id`, `day`),
  KEY `ix_search_product_sales_daily_2` (`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `search_dirty_documents` (
  `product_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `reason` TEXT NOT NULL,
  `queued_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `search_reindex_jobs` (
  `id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `scope` TEXT NOT NULL,
  `ids` JSON NOT NULL,
  `state` TEXT NOT NULL,
  `total` INT NOT NULL,
  `processed` INT NOT NULL,
  `requested_by` TEXT NOT NULL,
  `reason` TEXT NOT NULL,
  `started_at` DATETIME(3) NULL,
  `finished_at` DATETIME(3) NULL,
  `error` TEXT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE `search_ranking_policies` (
  `version` INT NOT NULL,
  `text` TEXT NOT NULL,
  `factors` JSON NOT NULL,
  `effective_from` DATETIME(3) NOT NULL,
  `reason` TEXT NOT NULL,
  `published_by` TEXT NOT NULL,
  `published_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

-- foreign keys, inside this module only (§6.2)
ALTER TABLE `search_search_offers` ADD CONSTRAINT `fk_search_search_offers_product_id` FOREIGN KEY (`product_id`) REFERENCES `search_search_documents` (`product_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
