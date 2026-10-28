/**
 * The per-module choice of database, through a real app (§10.5a): @MYSQL_MODULES@ decides which modules get a
 * MySQL @ctx.store@, the app creates **their** tables there and no others, and a module named without a MySQL
 * to put it in is refused at boot rather than at its first query.
 *
 * This is about the wiring, not about any module's data access: the pilots' repositories are converted
 * separately, and until then a module named here simply has its tables created and its store pointed at them.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { withDependencies } from '../module-system/loader.js';
import { TEST_JWK } from '../../testing/app.js';
import { testMongo } from '../../testing/mongo.js';
import { testMysql } from '../../testing/mysql.js';
import type { MongoStore } from '../mongo/index.js';
import type { MysqlStore } from '../mysql/index.js';

let mongo: MongoStore;
let mysql: MysqlStore;

const base = {
  env: { NODE_ENV: 'test' as const },
  config: { devTokens: true, devSigning: { file: '', jwk: TEST_JWK }, rateLimits: false },
};

const tablesLike = async (prefix: string): Promise<string[]> =>
  (
    await mysql.pool.query<(RowDataPacket & { t: string })[]>(
      'SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE ? ORDER BY TABLE_NAME',
      [`${prefix}%`],
    )
  )[0].map((r) => r.t);

beforeAll(async () => {
  [mongo, mysql] = await Promise.all([testMongo(), testMysql()]);
  // This file is about what the app creates, so it starts from none of it — including access, whose tables
  // another file in this worker's database may have created (the slot's database is shared, and `settings`
  // depends on `access`, so the module is loaded here either way). Migrate creates what is missing, so a
  // later file in this worker is unaffected.
  await mysql.pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const prefix of ['settings_', 'access_']) for (const t of await tablesLike(prefix)) await mysql.pool.query(`DROP TABLE IF EXISTS \`${t}\``);
  await mysql.pool.query('SET FOREIGN_KEY_CHECKS = 1');
  await mysql.pool.query('DELETE FROM `kernel_migrations` WHERE `id` LIKE ? OR `id` LIKE ?', ['settings/%', 'access/%']);
}, 120_000);

afterAll(async () => {
  await Promise.all([mongo?.close(), mysql?.close()]);
});

describe('which database a module uses', () => {
  it('creates the tables of the named modules, and only those', async () => {
    const app = await buildApp({
      ...base,
      mongo,
      mysql,
      modules: withDependencies(['settings']),
      config: { ...base.config, mysqlModules: ['settings'], migrateOnStart: true },
    });
    try {
      const created = await tablesLike('settings_');
      expect(created, 'the settings module ships five tables').toEqual([
        'settings_change_keys',
        'settings_changes',
        'settings_definitions',
        'settings_feature_flags',
        'settings_values',
      ]);
      // a module that was not named has no business having tables here, even though its spec has them
      expect(await tablesLike('access_')).toEqual([]);
      expect(app.kernel.mysql, 'the kernel exposes the store, as it does mongo').toBe(mysql);
    } finally {
      await app.close();
    }
  }, 120_000);

  it('leaves MySQL alone when no module is named', async () => {
    const app = await buildApp({ ...base, mongo, modules: withDependencies(['settings']), config: { ...base.config, mysqlModules: [], migrateOnStart: false } });
    try {
      expect(app.kernel.mysql).toBeUndefined();
    } finally {
      await app.close();
    }
  }, 120_000);

  it('refuses to start when a named module has no MySQL to put it in', async () => {
    await expect(
      buildApp({ ...base, mongo, modules: withDependencies(['settings']), config: { ...base.config, mysqlModules: ['settings'], migrateOnStart: false } }),
    ).rejects.toThrow(/MYSQL_MODULES names settings, but this process has no MySQL/);
  }, 120_000);
});
