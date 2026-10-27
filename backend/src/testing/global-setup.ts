/**
 * Runs once per test run: starts one in-memory MongoDB replica set (transactions need a replica set) and one
 * MySQL server (kernel/mysql/portable.ts). Test apps and test files take databases of their own from them
 * (testing/mongo.ts, testing/mysql.ts).
 *
 * TEST_MONGODB_URI runs the tests on a real server instead (a replica set, e.g.
 * mongodb://127.0.0.1:27017/?replicaSet=rs0). The tests then create databases named t<slot>_<n> on it and drop them
 * at the end; never point it at a server whose databases could have such names. MONGODB_URI is never used here, so
 * tests cannot touch the development database.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';
import { useInstalledMongod } from '../kernel/mongo/binary.js';
import { CLIENT_OPTIONS, startPortableMysql, type PortableMysql } from '../kernel/mysql/portable.js';

declare module 'vitest' {
  interface ProvidedContext {
    /** The run's MongoDB replica set (testing/mongo.ts) */
    mongoUri: string;
    /** The run's MySQL server, without a database (testing/mysql.ts); '' when there is none */
    mysqlUrl: string;
    /** Why there is no MySQL, for the error the MySQL tests then fail with */
    mysqlError: string;
  }
}

/** The databases testing/mongo.ts creates */
const TEST_DATABASE = /^t\d+_\d+$/;

/**
 * One MySQL for the whole run. A machine without a server must still be able to run the MongoDB tests, so a
 * failure here is reported to testing/mysql.ts rather than thrown: only the MySQL tests then fail, and they
 * fail with the reason.
 */
async function startMysql(project: TestProject): Promise<PortableMysql | undefined> {
  project.provide('mysqlUrl', '');
  project.provide('mysqlError', '');
  try {
    if (process.env.TEST_MYSQL_URL) {
      project.provide('mysqlUrl', process.env.TEST_MYSQL_URL);
      return undefined;
    }
    const mysql = await startPortableMysql({ dataDir: join(tmpdir(), 'marketly-test-mysql'), forTests: true });
    project.provide('mysqlUrl', mysql.url);
    return mysql;
  } catch (err) {
    project.provide('mysqlError', `the MySQL tests need a server: ${(err as Error).message}`);
    return undefined;
  }
}

/** The databases testing/mysql.ts creates */
const TEST_MYSQL_DATABASE = /^t\d+_\d+$/;

/** Drops the test databases left on a real server (the portable one is thrown away with its data directory) */
async function dropTestDatabases(url: string) {
  const u = new URL(url);
  const conn = await createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username || 'root'),
    password: decodeURIComponent(u.password || ''),
    ...CLIENT_OPTIONS,
  });
  try {
    const [rows] = await conn.query<RowDataPacket[]>('SHOW DATABASES');
    for (const r of rows) if (TEST_MYSQL_DATABASE.test(String(r.Database))) await conn.query(`DROP DATABASE \`${r.Database}\``);
  } finally {
    await conn.end();
  }
}

export default async function setup(project: TestProject) {
  const mysql = await startMysql(project);
  const stopMysql = async () => {
    if (process.env.TEST_MYSQL_URL) await dropTestDatabases(process.env.TEST_MYSQL_URL).catch(() => undefined);
    await mysql?.stop();
  };
  const real = process.env.TEST_MONGODB_URI;
  if (real) {
    project.provide('mongoUri', real);
    return async () => {
      const conn = await mongoose.createConnection(real).asPromise();
      const { databases } = await conn.db!.admin().listDatabases({ nameOnly: true });
      for (const d of databases) if (TEST_DATABASE.test(d.name)) await conn.useDb(d.name).dropDatabase();
      await conn.close();
      await stopMysql();
    };
  }
  useInstalledMongod();
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  project.provide('mongoUri', mongo.getUri());
  return async () => {
    await mongo.stop();
    await stopMysql();
  };
}
