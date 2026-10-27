/**
 * The maintainer's views (§9.2, docs/MAINTAINING.md): that they are valid SQL against the real schema, and that a
 * module being switched off costs its view rather than the migration.
 *
 * The SQL cannot be checked by reading it — every one of these names columns across two or three tables — so each
 * is created on a server and then selected from.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { testMysql } from '../../testing/mysql.js';
import type { MysqlStore } from './index.js';
import { createOpsViews, OPS_VIEWS } from './ops-views.js';

let store: MysqlStore;

const rows = async <T extends RowDataPacket>(sql: string): Promise<T[]> => (await store.pool.query<T[]>(sql))[0];
const tableNames = async (): Promise<Set<string>> =>
  new Set((await rows<RowDataPacket & { t: string }>('SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()')).map((r) => r.t));

/** Just enough of the real tables for the views to read: the columns each one names */
const FIXTURES = [
  'CREATE TABLE `orders_orders` (`id` CHAR(36) NOT NULL PRIMARY KEY, `ref` VARCHAR(32) NOT NULL, `placed_at` DATETIME(3) NULL, `lifecycle` VARCHAR(16) NOT NULL, `display_status` VARCHAR(32) NOT NULL, `channel` VARCHAR(16) NOT NULL, `contact_name` VARCHAR(255) NOT NULL, `contact_email` VARCHAR(255) NOT NULL, `contact_phone` VARCHAR(32) NULL, `customer_id` CHAR(36) NULL, `currency` CHAR(3) NOT NULL, `items_total` DECIMAL(12,2) NOT NULL, `discount_total` DECIMAL(12,2) NOT NULL, `shipping_total` DECIMAL(12,2) NOT NULL, `tax_total` DECIMAL(12,2) NOT NULL, `total` DECIMAL(12,2) NOT NULL, `payment_state` VARCHAR(16) NOT NULL, `payment_method_label` VARCHAR(64) NULL, `captured_total` DECIMAL(12,2) NOT NULL, `refunded_total` DECIMAL(12,2) NOT NULL, `accepted_at` DATETIME(3) NULL, `completed_at` DATETIME(3) NULL)',
  'CREATE TABLE `finance_seller_accounts` (`seller_id` CHAR(36) NOT NULL PRIMARY KEY, `currency` CHAR(3) NOT NULL, `pending` DECIMAL(12,2) NOT NULL, `available` DECIMAL(12,2) NOT NULL, `held` DECIMAL(12,2) NOT NULL, `negative_since` DATETIME(3) NULL, `payouts_blocked_reason` VARCHAR(255) NULL, `new_seller_until` DATETIME(3) NULL, `updated_at` DATETIME(3) NOT NULL)',
  'CREATE TABLE `inventory_stock_items` (`id` CHAR(36) NOT NULL PRIMARY KEY, `sku` VARCHAR(64) NOT NULL, `label` VARCHAR(255) NOT NULL, `condition` VARCHAR(16) NOT NULL, `owner_type` VARCHAR(16) NOT NULL, `seller_id` CHAR(36) NULL, `low_stock_threshold` INT NULL, `primary_bin_code` VARCHAR(32) NULL, `archived` TINYINT(1) NOT NULL)',
  'CREATE TABLE `inventory_locations` (`id` CHAR(36) NOT NULL PRIMARY KEY, `code` VARCHAR(32) NOT NULL, `name` VARCHAR(255) NOT NULL, `kind` VARCHAR(16) NOT NULL, `owner_type` VARCHAR(16) NOT NULL, `sellable` TINYINT(1) NOT NULL)',
  'CREATE TABLE `inventory_stock_levels` (`stock_item_id` CHAR(36) NOT NULL, `location_id` CHAR(36) NOT NULL, `available` INT NOT NULL, `reserved` INT NOT NULL, `incoming` INT NOT NULL, `damaged_held` INT NOT NULL, `returned` INT NOT NULL, `updated_at` DATETIME(3) NOT NULL, PRIMARY KEY (`stock_item_id`, `location_id`))',
  'CREATE TABLE `audit_entries` (`id` CHAR(36) NOT NULL PRIMARY KEY, `seq` BIGINT NOT NULL, `at` DATETIME(3) NOT NULL, `actor_kind` VARCHAR(16) NOT NULL, `actor_name` VARCHAR(255) NOT NULL, `action` VARCHAR(64) NOT NULL, `action_label` VARCHAR(255) NOT NULL, `module` VARCHAR(32) NOT NULL, `category` VARCHAR(32) NOT NULL, `target_type` VARCHAR(32) NOT NULL, `target_id` CHAR(36) NULL, `target_ref` VARCHAR(64) NULL, `target_label` VARCHAR(255) NULL, `seller_id` CHAR(36) NULL, `reason` TEXT NULL, `approval_request_id` CHAR(36) NULL, `request_id` CHAR(36) NULL, `ip` VARCHAR(45) NULL)',
];

beforeAll(async () => {
  store = await testMysql();
  // The slot's database is shared with every other file in it, and one of them creates the real 471 tables with
  // their foreign keys. These stand-ins hold only the columns the views read, so the real ones are cleared out
  // first -- a dangling foreign key from one of them is what made the first version of this fail.
  const names = await tableNames();
  await store.pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const n of names) {
    if (n.startsWith('kernel_')) continue;
    await store.pool.query(`DROP TABLE IF EXISTS \`${n}\``).catch(() => undefined);
    await store.pool.query(`DROP VIEW IF EXISTS \`${n}\``).catch(() => undefined);
  }
  for (const sql of FIXTURES) await store.pool.query(sql);
  await store.pool.query('SET FOREIGN_KEY_CHECKS = 1');
}, 120_000);

afterAll(async () => {
  for (const v of OPS_VIEWS) await store?.pool.query(`DROP VIEW IF EXISTS \`${v.name}\``).catch(() => undefined);
  for (const sql of FIXTURES) {
    const name = /`([a-z_]+)`/.exec(sql)![1]!;
    await store?.pool.query(`DROP TABLE IF EXISTS \`${name}\``).catch(() => undefined);
  }
  await store?.close();
});

describe('the five the maintainer asks for', () => {
  it('are created, and each one answers a SELECT', async () => {
    const conn = await store.pool.getConnection();
    try {
      const result = await createOpsViews(conn, await tableNames());
      expect(result.created).toEqual(OPS_VIEWS.map((v) => v.name));
      expect(result.skipped).toEqual([]);
    } finally {
      conn.release();
    }

    // valid SQL over the real column names, which is the thing that cannot be checked by reading it
    for (const view of OPS_VIEWS) {
      expect(await rows(`SELECT * FROM \`${view.name}\` LIMIT 1`), view.name).toEqual([]);
    }
  }, 120_000);

  it('read what they say they read', async () => {
    await store.pool.query(
      "INSERT INTO `orders_orders` VALUES ('11111111-1111-4111-8111-111111111111', 'MK-260101-00001', NOW(3), 'open', 'Placed', 'web', 'A Customer', 'a@example.test', NULL, NULL, 'USD', 10, 0, 2, 1, 13, 'captured', 'Card', 13, 0, NULL, NULL)",
    );
    const [order] = await rows<RowDataPacket & { ref: string; total: string; contact_email: string }>('SELECT * FROM `ops_v_orders`');
    expect(order).toMatchObject({ ref: 'MK-260101-00001', contact_email: 'a@example.test', display_status: 'Placed' });
    expect(Number(order!.total)).toBe(13);
  }, 120_000);

  it('skip the view of a module that is switched off, and name what is missing', async () => {
    // a server running without inventory has no inventory_* tables, and CREATE VIEW over a missing table is an
    // error, not a warning: the alternative to skipping is a migration that cannot finish
    const without = new Set([...(await tableNames())].filter((t) => !t.startsWith('inventory_')));
    const conn = await store.pool.getConnection();
    try {
      const result = await createOpsViews(conn, without);
      expect(result.created).not.toContain('ops_v_stock');
      expect(result.created).toContain('ops_v_orders');
      expect(result.skipped).toEqual(['ops_v_stock (no inventory_stock_levels, inventory_stock_items, inventory_locations)']);
    } finally {
      conn.release();
    }
  }, 120_000);

  it('name every table they read, so none is skipped for a table it does not need or kept for one it does', () => {
    for (const view of OPS_VIEWS) {
      const read = [...view.sql.matchAll(/\b(?:FROM|JOIN)\s+`([a-z_]+)`/gi)].map((m) => m[1]!);
      expect(read.toSorted(), view.name).toEqual([...view.needs].toSorted());
    }
  });
});
