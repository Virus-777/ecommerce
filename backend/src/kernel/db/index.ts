/**
 * PostgreSQL through Kysely. Production uses a pg pool (DATABASE_URL); development and tests use
 * PGlite, real PostgreSQL compiled to WASM running in-process (nothing to install).
 *
 * Value conventions (match the generated row types in src/spec/*.ts):
 *   bigint/int8 → number (money minor units fit easily), numeric → string (exact), date → 'YYYY-MM-DD' string.
 */
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { Kysely, PGliteDialect, PostgresDialect } from 'kysely';
import pg from 'pg';

const { INT8, DATE, NUMERIC } = pg.types.builtins;
const asText = (v: string) => v;
const PARSERS: Record<number, (value: string) => unknown> = { [INT8]: Number, [DATE]: asText, [NUMERIC]: asText };

export interface Database {
  kind: 'postgres' | 'pglite';
  /** Unscoped query builder; modules get `ctx.db`, already scoped to their own schema. */
  kysely: Kysely<any>;
  /** Run a multi-statement SQL script (migrations). */
  exec(script: string): Promise<void>;
  close(): Promise<void>;
  /** PGlite only: the whole database as a tarball, to start other databases from */
  dump?(): Promise<Blob>;
}

export interface DatabaseOptions {
  url?: string;
  /** PGlite data directory; omitted = in memory */
  pgliteDir?: string;
  /** Start PGlite from a dump (tests start from a database that is already migrated) */
  pgliteDump?: Blob;
}

export async function createDatabase(opts: DatabaseOptions = {}): Promise<Database> {
  if (opts.url) {
    for (const [oid, parse] of Object.entries(PARSERS)) pg.types.setTypeParser(Number(oid), parse);
    const pool = new pg.Pool({ connectionString: opts.url, max: 20 });
    const kysely = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
    return {
      kind: 'postgres',
      kysely,
      async exec(script) {
        const client = await pool.connect();
        try {
          await client.query(script);
        } catch (err) {
          await client.query('rollback').catch(() => {}); // the script may have opened a transaction
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => kysely.destroy(),
    };
  }
  const pglite = await PGlite.create({ dataDir: opts.pgliteDir, loadDataDir: opts.pgliteDump, extensions: { pg_trgm }, parsers: PARSERS });
  const kysely = new Kysely<any>({ dialect: new PGliteDialect({ pglite }) });
  return {
    kind: 'pglite',
    kysely,
    async exec(script) {
      try {
        await pglite.exec(script);
      } catch (err) {
        await pglite.exec('rollback').catch(() => {});
        throw err;
      }
    },
    dump: () => pglite.dumpDataDir('none') as Promise<Blob>,
    async close() {
      await kysely.destroy();
      if (!pglite.closed) await pglite.close();
    },
  };
}

