/**
 * `migrateMysql` against a real server (docs/10-mysql-migration.md §17.3).
 *
 * The first block is the one the rest rests on: for every kind of column the generator writes, what
 * `parseColumnDdl` reads out of our own line has to be what `information_schema` says about the stored
 * column. If those two ever disagree the diff is worthless in both directions — migrate would refuse a
 * schema that is already right, or quietly accept one that is wrong — and nothing else here would notice.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { testMysql } from '../../testing/mysql.js';
import type { MysqlStore } from './index.js';
import { createTableSql, migrateMysql, parseColumnDdl, SchemaRewriteNeeded, type MysqlUnit, type TableSchema } from './schema.js';

let store: MysqlStore;
const logged: string[] = [];
const log = (m: string) => logged.push(m);

const rows = async <T extends RowDataPacket>(sql: string, params: unknown[] = []): Promise<T[]> => (await store.pool.query<T[]>(sql, params))[0];

const table = (name: string, columns: string[], o: Partial<TableSchema> = {}): TableSchema => ({
  name,
  columns: columns.map((ddl) => ({ name: /^`([^`]+)`/.exec(ddl)![1]!, ddl })),
  primaryKey: o.primaryKey ?? ['id'],
  keys: o.keys ?? [],
  checks: o.checks ?? [],
  foreignKeys: o.foreignKeys ?? [],
  triggers: o.triggers ?? [],
});

const unit = (module: string, tables: TableSchema[], rest: Partial<MysqlUnit> = {}): MysqlUnit => ({ module, tables, ...rest });

beforeAll(async () => {
  store = await testMysql();
});
afterAll(async () => {
  await store?.close();
});
afterEach(async () => {
  const names = (await rows<RowDataPacket & { t: string }>("SELECT TABLE_NAME t, TABLE_TYPE k FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT LIKE 'kernel\\_%'")).map(
    (r) => r.t,
  );
  await store.pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const n of names) await store.pool.query(`DROP TABLE IF EXISTS \`${n}\``).catch(() => undefined);
  for (const n of names) await store.pool.query(`DROP VIEW IF EXISTS \`${n}\``).catch(() => undefined);
  await store.pool.query('SET FOREIGN_KEY_CHECKS = 1');
  await store.pool.query('DELETE FROM `kernel_migrations`');
  logged.length = 0;
});

/** Every column shape the generator writes (tools/lib/mysql-types.ts), one of each */
const EVERY_KIND = [
  '`id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL',
  '`code` CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NULL',
  '`ip` VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NULL',
  '`name` VARCHAR(255) NOT NULL',
  '`email` VARCHAR(255) COLLATE utf8mb4_0900_as_ci NULL',
  '`body` TEXT NULL',
  '`notes` MEDIUMTEXT NULL',
  '`huge` LONGTEXT NULL',
  '`qty` INT NOT NULL',
  '`small` SMALLINT NULL',
  '`big` BIGINT NULL',
  '`price` DECIMAL(12,2) NOT NULL',
  '`active` TINYINT(1) NOT NULL',
  '`day` DATE NULL',
  '`at_time` TIME NULL',
  '`at` DATETIME(3) NOT NULL',
  '`payload` JSON NULL',
  '`digest` BINARY(32) NULL',
  '`secret_encrypted` BLOB NULL',
];

describe('what a column line says, and what the server says back', () => {
  it('agrees for every kind of column the generator writes', async () => {
    const t = table('kinds', EVERY_KIND);
    await store.pool.query(createTableSql(t));
    const stored = new Map(
      (await rows<RowDataPacket>('SELECT COLUMN_NAME n, COLUMN_TYPE t, IS_NULLABLE nu, EXTRA e, COLLATION_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', ['kinds'])).map((r) => [
        String(r.n),
        { type: String(r.t).toLowerCase(), nullable: String(r.nu) === 'YES', collation: r.c ? String(r.c) : undefined },
      ]),
    );
    const disagreements: string[] = [];
    for (const c of t.columns) {
      const want = parseColumnDdl(c.ddl, c.name);
      const has = stored.get(c.name)!;
      if (want.type !== has.type) disagreements.push(`${c.name}: wrote ${want.type}, server says ${has.type}`);
      if (want.nullable !== has.nullable) disagreements.push(`${c.name}: wrote nullable=${want.nullable}, server says ${has.nullable}`);
      if (want.collation !== has.collation) disagreements.push(`${c.name}: wrote collation ${want.collation}, server says ${has.collation}`);
    }
    expect(disagreements).toEqual([]);
    // and migrate sees nothing to do on a table it just made
    await migrateMysql(store, [unit('kinds', [t])], log);
    expect(logged.filter((l) => l.includes('added'))).toEqual([]);
  });

  it('reads AUTO_INCREMENT and an invisible surrogate', () => {
    expect(parseColumnDdl('`row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT INVISIBLE', 'x')).toEqual({
      type: 'bigint unsigned',
      nullable: false,
      autoIncrement: true,
      invisible: true,
      collation: undefined,
    });
  });

  it('refuses a line it cannot read rather than guessing at it', () => {
    expect(() => parseColumnDdl('status VARCHAR(16)', 'x.status')).toThrow(/cannot read the column definition/);
    expect(() => parseColumnDdl('`status`', 'x.status')).toThrow(/cannot read the column definition/);
  });
});

describe('from nothing', () => {
  const ORDERS = table('shop_orders', ['`id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL', '`total` DECIMAL(12,2) NOT NULL', '`status` VARCHAR(16) NOT NULL'], {
    keys: [{ name: 'ix_shop_orders_status', ddl: 'KEY `ix_shop_orders_status` (`status`)' }],
    checks: [{ name: 'ck_shop_orders_status', ddl: "CONSTRAINT `ck_shop_orders_status` CHECK (`status` IN ('open', 'closed'))" }],
  });

  it('creates the tables and does nothing the second time', async () => {
    const result = await migrateMysql(store, [unit('shop', [ORDERS])], log);
    expect(result.applied).toEqual(['shop/schema']);
    expect(await rows('SELECT 1 FROM `shop_orders`')).toEqual([]);

    logged.length = 0;
    const again = await migrateMysql(store, [unit('shop', [ORDERS])], log);
    expect(again.applied).toEqual([]); // skipped by hash
    expect(logged).toEqual([]);
  });

  it('creates the kernel tables too', async () => {
    await migrateMysql(store, [], log);
    const [row] = await rows<RowDataPacket & { n: number }>("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'kernel\\_%'");
    expect(Number(row!.n)).toBe(11);
  });

  it('applies the checks it created, so a bad row is refused', async () => {
    await migrateMysql(store, [unit('shop', [ORDERS])]);
    await expect(store.pool.query("INSERT INTO `shop_orders` VALUES ('a', 1, 'nonsense')")).rejects.toMatchObject({ errno: 3819 });
  });
});

describe('adding to a table that is already there', () => {
  const V1 = table('shop_items', ['`id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL', '`name` VARCHAR(64) NOT NULL']);

  const withRow = async () => {
    await migrateMysql(store, [unit('shop', [V1])]);
    await store.pool.query("INSERT INTO `shop_items` VALUES ('a', 'Alpha')");
  };

  it('adds a column and keeps the rows', async () => {
    await withRow();
    const v2 = table('shop_items', [...V1.columns.map((c) => c.ddl), '`note` VARCHAR(32) NULL']);
    const result = await migrateMysql(store, [unit('shop', [v2])], log);
    expect(result.applied).toEqual(['shop/schema']);
    expect(logged).toContain('schema shop: added shop_items.note');
    expect(await rows('SELECT `id`, `name`, `note` FROM `shop_items`')).toEqual([{ id: 'a', name: 'Alpha', note: null }]);
  });

  it('adds a key, and drops one the spec no longer declares', async () => {
    await withRow();
    const withKey = { ...V1, keys: [{ name: 'ix_shop_items_name', ddl: 'KEY `ix_shop_items_name` (`name`)' }] };
    await migrateMysql(store, [unit('shop', [withKey])], log);
    expect(logged).toContain('schema shop: added key ix_shop_items_name on shop_items');

    logged.length = 0;
    await migrateMysql(store, [unit('shop', [V1])], log); // the key is gone from the spec
    expect(logged).toContain('schema shop: dropped key ix_shop_items_name on shop_items, which the spec no longer declares');
    const keys = (await rows<RowDataPacket & { i: string }>('SELECT DISTINCT INDEX_NAME i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', ['shop_items'])).map((r) => r.i);
    expect(keys).toEqual(['PRIMARY']); // and the primary key is not ours to drop
  });

  it('adds a check and a trigger', async () => {
    await withRow();
    const v2: TableSchema = {
      ...V1,
      checks: [{ name: 'ck_shop_items_name', ddl: "CONSTRAINT `ck_shop_items_name` CHECK (`name` <> '')" }],
      triggers: [{ name: 'shop_items_no_delete', ddl: "CREATE TRIGGER `shop_items_no_delete` BEFORE DELETE ON `shop_items` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'append-only'" }],
    };
    await migrateMysql(store, [unit('shop', [v2])], log);
    await expect(store.pool.query("INSERT INTO `shop_items` VALUES ('b', '')")).rejects.toMatchObject({ errno: 3819 });
    await expect(store.pool.query("DELETE FROM `shop_items` WHERE `id` = 'a'")).rejects.toMatchObject({ errno: 1644 });
  });

  it('adds a foreign key between two tables of the module', async () => {
    const parent = table('shop_carts', ['`id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL']);
    const child = table('shop_lines', ['`id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL', '`cart_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL'], {
      keys: [{ name: 'ix_shop_lines_cart_id', ddl: 'KEY `ix_shop_lines_cart_id` (`cart_id`)' }],
      foreignKeys: [
        {
          name: 'fk_shop_lines_cart_id',
          ddl: 'ALTER TABLE `shop_lines` ADD CONSTRAINT `fk_shop_lines_cart_id` FOREIGN KEY (`cart_id`) REFERENCES `shop_carts` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT',
        },
      ],
    });
    // the child is listed first on purpose: the keys are applied after every table exists
    await migrateMysql(store, [unit('shop', [child, parent])], log);
    await expect(store.pool.query("INSERT INTO `shop_lines` VALUES ('l', 'no-such-cart')")).rejects.toMatchObject({ errno: 1452 });
    await store.pool.query("INSERT INTO `shop_carts` VALUES ('c')");
    await store.pool.query("INSERT INTO `shop_lines` VALUES ('l', 'c')");
    await store.pool.query("DELETE FROM `shop_carts` WHERE `id` = 'c'");
    expect(await rows('SELECT 1 FROM `shop_lines`')).toEqual([]); // ON DELETE CASCADE
  });
});

describe('what it refuses, and what it only reports', () => {
  const V1 = table('shop_things', ['`id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL', '`size` INT NOT NULL', '`label` VARCHAR(32) NULL']);

  it('refuses a type change by name, with both definitions', async () => {
    await migrateMysql(store, [unit('shop', [V1])]);
    const v2 = table('shop_things', ['`id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL', '`size` BIGINT NOT NULL', '`label` VARCHAR(32) NULL']);
    await expect(migrateMysql(store, [unit('shop', [v2])])).rejects.toThrow(SchemaRewriteNeeded);
    await expect(migrateMysql(store, [unit('shop', [v2])])).rejects.toThrow(/shop_things\.size: type int should be bigint/);
    // and nothing was changed on the way to refusing
    const [row] = await rows<RowDataPacket & { t: string }>('SELECT COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', ['shop_things', 'size']);
    expect(String(row!.t)).toBe('int');
  });

  it('refuses a narrowing and a nullability change', async () => {
    await migrateMysql(store, [unit('shop', [V1])]);
    const narrower = table('shop_things', ['`id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL', '`size` INT NOT NULL', '`label` VARCHAR(8) NOT NULL']);
    const err = await migrateMysql(store, [unit('shop', [narrower])]).catch((e: SchemaRewriteNeeded) => e);
    expect((err as SchemaRewriteNeeded).changes).toEqual(['shop_things.label: type varchar(32) should be varchar(8)']);
  });

  it('reports a column the spec does not have, and leaves it alone', async () => {
    await migrateMysql(store, [unit('shop', [V1])]);
    await store.pool.query('ALTER TABLE `shop_things` ADD COLUMN `leftover` INT NULL');
    await store.pool.query('DELETE FROM `kernel_migrations`'); // force the unit to be looked at again
    const result = await migrateMysql(store, [unit('shop', [V1])], log);
    expect(result.extra).toContain('column shop_things.leftover is in the database and not in the spec');
    const [row] = await rows<RowDataPacket & { n: number }>('SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', ['shop_things', 'leftover']);
    expect(Number(row!.n)).toBe(1); // reported, not dropped
  });

  it('reports a table the spec does not have, and leaves it alone', async () => {
    await store.pool.query('CREATE TABLE `shop_old` (`id` INT PRIMARY KEY)');
    const result = await migrateMysql(store, [unit('shop', [V1])], log);
    expect(result.extra).toContain('table shop_old is in the database and not in the spec');
    expect(await rows('SELECT 1 FROM `shop_old`')).toEqual([]); // still there
  });
});

describe('views and data migrations', () => {
  const V1 = table('shop_rows', ['`id` INT NOT NULL', '`n` INT NOT NULL']);

  it('creates a view and replaces it when it changes', async () => {
    const one = unit('shop', [V1], { views: [{ name: 'shop_big', ddl: 'CREATE OR REPLACE VIEW `shop_big` AS SELECT `id` FROM `shop_rows` WHERE `n` > 10' }] });
    await migrateMysql(store, [one]);
    await store.pool.query('INSERT INTO `shop_rows` VALUES (1, 5), (2, 50)');
    expect(await rows('SELECT `id` FROM `shop_big`')).toEqual([{ id: 2 }]);

    const two = unit('shop', [V1], { views: [{ name: 'shop_big', ddl: 'CREATE OR REPLACE VIEW `shop_big` AS SELECT `id` FROM `shop_rows` WHERE `n` > 1' }] });
    await migrateMysql(store, [two]);
    expect(await rows('SELECT `id` FROM `shop_big` ORDER BY `id`')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('runs each data migration once, in order', async () => {
    const ran: string[] = [];
    const migrations = [
      { id: '001-seed', up: async (s: MysqlStore) => void (ran.push('001'), await s.pool.query('INSERT INTO `shop_rows` VALUES (1, 1)')) },
      { id: '002-bump', up: async (s: MysqlStore) => void (ran.push('002'), await s.pool.query('UPDATE `shop_rows` SET `n` = 2')) },
    ];
    const result = await migrateMysql(store, [unit('shop', [V1], { migrations })], log);
    expect(result.applied).toEqual(['shop/schema', 'shop/001-seed', 'shop/002-bump']);
    expect(ran).toEqual(['001', '002']);
    expect(await rows('SELECT `n` FROM `shop_rows`')).toEqual([{ n: 2 }]);

    const again = await migrateMysql(store, [unit('shop', [V1], { migrations })]);
    expect(again.applied).toEqual([]);
    expect(ran).toEqual(['001', '002']); // not run a second time
  });
});
