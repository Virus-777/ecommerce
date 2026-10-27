/**
 * The whole schema, built from the generated per-module units by `migrateMysql` (§17.2, §17.3).
 *
 * `npm run check:ddl` already proves the generated *SQL* is accepted by a server. This proves the other half: that
 * the pieces the modules ship — the DDL objects migrate reads, hashes and diffs — build the same schema, and that
 * a second start applies nothing. Those are different code paths over the same spec, and only one of them runs in
 * production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { testMysql } from '../testing/mysql.js';
import type { MysqlStore } from '../kernel/mysql/index.js';
import { migrateMysql, type MysqlUnit } from '../kernel/mysql/schema.js';
import { mysqlSchemas } from './index.js';

let store: MysqlStore;
let units: MysqlUnit[];
const logged: string[] = [];

const rows = async <T extends RowDataPacket>(sql: string): Promise<T[]> => (await store.pool.query<T[]>(sql))[0];
const count = async (sql: string): Promise<number> => Number((await rows<RowDataPacket & { n: number }>(sql))[0]!.n);

beforeAll(async () => {
  store = await testMysql();
  units = await Promise.all(Object.values(mysqlSchemas).map(async (load) => (await load()).unit));

  // an empty database: the slot's database is reused by every test file in it, and this one is about creation
  const names = (await rows<RowDataPacket & { t: string }>("SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT LIKE 'kernel\_%'")).map((r) => r.t);
  await store.pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const n of names) await store.pool.query(`DROP TABLE IF EXISTS \`${n}\``).catch(() => undefined);
  for (const n of names) await store.pool.query(`DROP VIEW IF EXISTS \`${n}\``).catch(() => undefined);
  await store.pool.query('SET FOREIGN_KEY_CHECKS = 1');
  await store.pool.query('DELETE FROM `kernel_migrations`');
}, 120_000);

afterAll(async () => {
  await store?.close();
});

describe('every module ships its tables', () => {
  it('a unit per module folder, named after it, and every table named <module>_<table>', () => {
    expect(Object.keys(mysqlSchemas)).toEqual(Object.keys(mysqlSchemas).toSorted());
    expect(units.map((u) => u.module)).toEqual(Object.keys(mysqlSchemas));
    for (const u of units) {
      const prefix = `${u.module.replace(/-/g, '_')}_`;
      expect(u.tables.filter((t) => !t.name.startsWith(prefix)).map((t) => t.name), `${u.module} tables are not prefixed`).toEqual([]);
    }
  });

  it('a foreign key never leaves its module (§6.2)', () => {
    for (const u of units) {
      const own = new Set(u.tables.map((t) => t.name));
      for (const t of u.tables) {
        for (const fk of t.foreignKeys) {
          const target = /REFERENCES `([^`]+)`/.exec(fk.ddl)?.[1];
          expect(target, `${fk.name}: no target`).toBeTruthy();
          expect(own.has(target!), `${fk.name} points at ${target}, which is not ${u.module}'s`).toBe(true);
        }
      }
    }
  });
});

describe('migrate builds it', () => {
  it('creates every table, key, check and trigger the units describe, and nothing else', async () => {
    const want = {
      tables: units.reduce((n, u) => n + u.tables.length, 0),
      foreignKeys: units.reduce((n, u) => n + u.tables.reduce((k, t) => k + t.foreignKeys.length, 0), 0),
      checks: units.reduce((n, u) => n + u.tables.reduce((k, t) => k + t.checks.length, 0), 0),
      triggers: units.reduce((n, u) => n + u.tables.reduce((k, t) => k + t.triggers.length, 0), 0),
      views: units.reduce((n, u) => n + (u.views?.length ?? 0), 0),
    };
    // the census of the plan: if these are suddenly small, the units are empty and the rest proves nothing
    expect(await count("SELECT COUNT(*) n FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'ops\_v\_%'")).toBe(0);
    expect(want.tables).toBeGreaterThan(400);
    expect(want.foreignKeys).toBeGreaterThan(300);
    expect(want.views).toBeGreaterThan(5);

    const result = await migrateMysql(store, units, (m) => logged.push(m));
    // every module, then the maintainer's views — which on a database with every module get built in full
    expect(result.applied).toEqual([...units.map((u) => `${u.module}/schema`), 'kernel/ops-views']);
    expect(result.extra).toEqual([]);
    expect(logged).toContain('ops views: 5 of 5');
    expect(logged.filter((l) => l.startsWith('ops view skipped'))).toEqual([]);

    expect({
      // BASE TABLE: information_schema.TABLES counts the views as well
      tables: await count("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME NOT LIKE 'kernel\_%'"),
      foreignKeys: await count("SELECT COUNT(*) n FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND TABLE_NAME NOT LIKE 'kernel\_%'"),
      // the kernel's own tables are hand-written and not in any unit (its jobs table has the one CHECK)
      checks: await count("SELECT COUNT(*) n FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'CHECK' AND TABLE_NAME NOT LIKE 'kernel\_%'"),
      triggers: await count("SELECT COUNT(*) n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE NOT LIKE 'kernel\_%'"),
      // that these exist at all is the proof that MySQL merged every one of them: migrate reads warning 1354
      // after each CREATE and throws ViewNotMergeable rather than leave a view it would rebuild on every read.
      // The maintainer's ops_v_* views are counted by the line above instead: they are not asked to merge (§9.2)
      views: await count("SELECT COUNT(*) n FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT LIKE 'ops\_v\_%'"),
    }).toEqual(want);

    // and the five of MAINTAINING.md §6a, which only exist on a database that has every module's tables
    expect((await rows<RowDataPacket & { v: string }>("SELECT TABLE_NAME v FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'ops\\_v\\_%' ORDER BY TABLE_NAME")).map((r) => r.v)).toEqual([
      'ops_v_audit_recent',
      'ops_v_jobs',
      'ops_v_orders',
      'ops_v_seller_money',
      'ops_v_stock',
    ]);
  }, 600_000);

  it('a view reads through to the base table and its index, which is the whole point of MERGE (§9.1)', async () => {
    // "MySQL merged it" and "the query that reads it uses the base indexes" are not the same claim. The first is
    // what migrate checks for every view; this is the second, on one view, against the real plan: a filter on
    // seller_id has to reach orders_seller_groups and pick the (seller_id, status, dispatch_by) index — not scan
    // a temporary table built from the join.
    const [plan] = await rows<RowDataPacket & { EXPLAIN: string }>(
      "EXPLAIN FORMAT=JSON SELECT * FROM `orders_v_group_rows` WHERE `seller_id` = '00000000-0000-4000-8000-000000000001'",
    );
    const explained = JSON.stringify(JSON.parse(plan!.EXPLAIN));
    expect(explained).toContain('orders_seller_groups');
    expect(explained).toContain('ix_orders_seller_groups_1'); // (seller_id, status, dispatch_by)
    expect(explained).not.toContain('materialized');
    expect(explained).not.toContain('temporary');
  }, 120_000);

  it('a second start applies nothing and asks the database for nothing it already knows', async () => {
    logged.length = 0;
    const again = await migrateMysql(store, units, (m) => logged.push(m));
    expect(again.applied).toEqual([]);
    expect(again.extra).toEqual([]);
    expect(logged).toEqual([]);
  }, 300_000);

  it('adds a column the spec gained, to that module only', async () => {
    const first = units[0]!;
    const probe = { name: 'migrate_probe', ddl: '`migrate_probe` INT NULL' };
    const table = first.tables[0]!;
    const changed = units.map((u) => (u === first ? { ...u, tables: [{ ...table, columns: [...table.columns, probe] }, ...u.tables.slice(1)] } : u));
    logged.length = 0;

    const result = await migrateMysql(store, changed, (m) => logged.push(m));
    // only the module whose tables changed: every other hash still matches, which is what makes a restart cheap
    expect(result.applied).toEqual([`${first.module}/schema`]);
    expect(logged).toContain(`schema ${first.module}: added ${table.name}.migrate_probe`);
    const columns = await rows<RowDataPacket & { c: string }>(
      `SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table.name}'`,
    );
    expect(columns.map((r) => r.c)).toContain('migrate_probe');

    // and it is the spec that decides: with the column gone from the unit again, migrate leaves the database
    // alone and reports the column as something the database has and the spec does not (§17.3)
    const back = await migrateMysql(store, units, (m) => logged.push(m));
    expect(back.extra).toContain(`column ${table.name}.migrate_probe is in the database and not in the spec`);
    await store.pool.query(`ALTER TABLE \`${table.name}\` DROP COLUMN \`migrate_probe\``);
  }, 300_000);
});
