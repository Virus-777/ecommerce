#!/usr/bin/env tsx
/**
 * `npm run test:http` with some modules' data — and the kernel's own — in MySQL, which is Y2's third exit
 * criterion (docs/10 §23: "each module's tests, contract and `test:http` pass on MySQL").
 *
 *   npm run test:http-mysql -- --only media,backups
 *   npm run test:http-mysql -- --only media --url mysql://root@127.0.0.1:3306   a server you already have
 *
 * Without `--url` a portable server is started here and thrown away with its data directory afterwards, the
 * way tools/run-on-mysql80.ts does it for the test suite. The named modules are the ones whose data moves;
 * the rest stay in MongoDB, exactly as a half-migrated deployment runs.
 */
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createConnection } from 'mysql2/promise';
import { CLIENT_OPTIONS, startPortableMysql, type PortableMysql } from '../src/kernel/mysql/portable.js';

const { values } = parseArgs({ options: { only: { type: 'string' }, url: { type: 'string' }, port: { type: 'string' }, database: { type: 'string' } } });
const modules = values.only ?? '';
if (!modules) throw new Error('test:http-mysql needs --only <modules>: the modules whose data is in MySQL');
const database = values.database ?? 'marketly_http';

/** The database the app will connect to has to exist first: `db-setup` makes it on the server */
async function createDatabase(base: string): Promise<void> {
  const u = new URL(base);
  const conn = await createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username || 'root'),
    password: decodeURIComponent(u.password || ''),
    ...CLIENT_OPTIONS,
  });
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await conn.query(`CREATE DATABASE \`${database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
  } finally {
    await conn.end();
  }
}

let server: PortableMysql | undefined;
const base = values.url ?? (server = await startPortableMysql({ dataDir: `${process.env.TEMP ?? '.'}/marketly-http-mysql`, port: Number(values.port ?? 3341), forTests: true })).url;
try {
  await createDatabase(base);
  console.log(`test:http with ${modules} in MySQL (${base.replace(/\/\/[^@]*@/, '//')}/${database}), the kernel's data too`);
  const res = spawnSync('npm', ['run', 'test:http', '--', '--only', modules], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, MYSQL_URL: `${base}/${database}`, MYSQL_MODULES: modules, KERNEL_STORE: 'mysql', MIGRATE_ON_START: 'true' },
  });
  process.exitCode = res.status ?? 1;
} finally {
  await server?.stop();
}
