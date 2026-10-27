/**
 * Generates the MySQL schema from the spec and **applies it to a real server** (docs/10-mysql-migration.md §17.2).
 *
 * This is the only way to know the translation is right. A generated string can look perfect and still be refused:
 * a key too long, a CHECK that names a column it cannot see, a functional index MySQL will not accept, a foreign
 * key whose target is not a key. So the whole schema is created on a throwaway database, and what the server says
 * is the answer.
 *
 *   npx tsx tools/check-mysql-ddl.ts            # portable server, a scratch database, dropped afterwards
 *   npx tsx tools/check-mysql-ddl.ts --keep     # leave the database to look at
 *   MYSQL_URL=... npx tsx tools/check-mysql-ddl.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Connection } from 'mysql2/promise';
import { apiDir, loadModules } from './lib/spec.js';
import { moduleDdl, moduleSql, type ModuleDdl } from './lib/mysql.js';
import { CONNECT_CHARSET, SESSION_COLLATION, startPortableMysql, type PortableMysql } from '../src/kernel/mysql/portable.js';
import { parseColumnDdl } from '../src/kernel/mysql/schema.js';

const keep = process.argv.includes('--keep');
const DB = 'marketly_ddl_check';

async function connect(url: string): Promise<Connection> {
  const u = new URL(url);
  const conn = await createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username || 'root'),
    password: decodeURIComponent(u.password || ''),
    charset: CONNECT_CHARSET,
    multipleStatements: false,
  });
  await conn.query(SESSION_COLLATION);
  return conn;
}

const modules = loadModules();
const all: ModuleDdl[] = modules.map((m) => moduleDdl(m));

// write the readable per-module files first: they are useful even when the server refuses something
const outDir = join(apiDir, 'db');
mkdirSync(outDir, { recursive: true });
for (const ddl of all) writeFileSync(join(outDir, `${ddl.module}.sql`), moduleSql(ddl));

const generatorProblems = all.flatMap((d) => d.problems);
const tables = all.reduce((n, d) => n + d.tables.length, 0);
const keys = all.reduce((n, d) => n + d.tables.flatMap((t) => t.foreignKeys).length, 0);
const triggers = all.reduce((n, d) => n + d.tables.flatMap((t) => t.triggers).length, 0);
console.log(`generated ${tables} tables, ${keys} foreign keys, ${triggers} triggers in ${all.length} modules -> docs/api/db/`);
if (generatorProblems.length) {
  console.error(`\n${generatorProblems.length} the generator could not translate:`);
  for (const p of generatorProblems) console.error(`  ${p}`);
  process.exit(1);
}

let server: PortableMysql | undefined;
let url = process.env.MYSQL_URL;
if (!url) {
  server = await startPortableMysql({ dataDir: join(tmpdir(), 'marketly-ddl-check'), port: 3398, forTests: true });
  url = server.url;
  console.log(`started MySQL ${server.version} on ${server.port}`);
}

const conn = await connect(url);
const failures: { at: string; sql: string; error: string }[] = [];
let misread: string[] = [];
const apply = async (at: string, sql: string) => {
  try {
    await conn.query(sql);
  } catch (err) {
    failures.push({ at, sql, error: (err as Error).message });
  }
};

try {
  await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await conn.query(`CREATE DATABASE \`${DB}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
  await conn.query(`USE \`${DB}\``);

  for (const ddl of all) for (const t of ddl.tables) await apply(`${ddl.module}.${t.name}`, t.create);
  for (const ddl of all) for (const t of ddl.tables) for (const fk of t.foreignKeys) await apply(`${ddl.module}.${t.name} fk`, fk);
  for (const ddl of all) for (const t of ddl.tables) for (const tr of t.triggers) await apply(`${ddl.module}.${t.name} trigger`, tr);

  const [[counted]] = (await conn.query(`SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${DB}'`)) as any;
  const [[fks]] = (await conn.query(`SELECT COUNT(*) n FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = '${DB}' AND CONSTRAINT_TYPE = 'FOREIGN KEY'`)) as any;
  const [[checks]] = (await conn.query(`SELECT COUNT(*) n FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = '${DB}' AND CONSTRAINT_TYPE = 'CHECK'`)) as any;
  const [[indexes]] = (await conn.query(`SELECT COUNT(DISTINCT TABLE_NAME, INDEX_NAME) n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = '${DB}'`)) as any;
  const [[trig]] = (await conn.query(`SELECT COUNT(*) n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '${DB}'`)) as any;

  console.log('\non the server:');
  console.log(`  tables       ${counted.n} of ${tables}`);
  console.log(`  indexes      ${indexes.n}`);
  console.log(`  foreign keys ${fks.n} of ${keys}`);
  console.log(`  checks       ${checks.n}`);
  console.log(`  triggers     ${trig.n} of ${triggers}`);

  // What `npm run migrate` believes each column line says has to be what the server says the stored column
  // is, for every column in the whole schema — otherwise the diff in kernel/mysql/schema.ts is worthless in
  // both directions: it would refuse a schema that is already right, or accept one that is wrong. This is the
  // same check the unit test makes over a handful of hand-picked columns, over all ~4,000 real ones.
  const stored = new Map<string, { type: string; nullable: boolean; collation: string | undefined }>();
  for (const r of (await conn.query(
    `SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE ty, IS_NULLABLE nu, COLLATION_NAME co FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${DB}'`,
  ))[0] as any[]) {
    stored.set(`${r.t}.${r.c}`, { type: String(r.ty).toLowerCase(), nullable: String(r.nu) === 'YES', collation: r.co ? String(r.co) : undefined });
  }
  misread = [];
  let columnsChecked = 0;
  for (const ddl of all) {
    for (const t of ddl.tables) {
      for (const c of t.schema.columns) {
        const has = stored.get(`${t.name}.${c.name}`);
        if (!has) continue; // the table itself was refused; that failure is reported above
        columnsChecked++;
        const want = parseColumnDdl(c.ddl, `${t.name}.${c.name}`);
        if (want.type !== has.type) misread.push(`${t.name}.${c.name}: read type ${want.type}, server says ${has.type}`);
        else if (want.nullable !== has.nullable) misread.push(`${t.name}.${c.name}: read nullable=${want.nullable}, server says ${has.nullable}`);
        else if (want.collation !== has.collation) misread.push(`${t.name}.${c.name}: read collation ${want.collation}, server says ${has.collation}`);
      }
    }
  }
  console.log(`  columns      ${columnsChecked} read back and compared`);
  if (misread.length) {
    console.error(`\n${misread.length} column(s) migrate would read differently from the server:\n`);
    for (const m of misread.slice(0, 25)) console.error(`  ${m}`);
    if (misread.length > 25) console.error(`  … and ${misread.length - 25} more`);
  }

  if (failures.length) {
    console.error(`\n${failures.length} statement(s) the server refused:\n`);
    for (const f of failures.slice(0, 25)) {
      console.error(`  ${f.at}\n    ${f.error}\n    ${f.sql.split('\n').slice(0, 3).join('\n    ')}\n`);
    }
    if (failures.length > 25) console.error(`  … and ${failures.length - 25} more`);
  } else if (!misread.length) {
    console.log('\nthe server accepted every statement, and migrate reads every column as the server stores it');
  }
  if (!keep) await conn.query(`DROP DATABASE \`${DB}\``);
  else console.log(`\nkept: ${DB} on ${url}`);
} finally {
  await conn.end().catch(() => undefined);
  await server?.stop();
}

process.exit(failures.length || misread.length ? 1 : 0);
