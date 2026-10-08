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

const INT8 = 20;
const DATE = 1082;
const NUMERIC = 1700;

export interface Database {
  kind: 'postgres' | 'pglite';
  /** Unscoped query builder; modules get `ctx.db`, already scoped to their own schema. */
  kysely: Kysely<any>;
  /** Run a multi-statement SQL script (migrations). */
  exec(script: string): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  url?: string;
  /** PGlite data directory; omitted = in memory */
  pgliteDir?: string;
}

export async function createDatabase(opts: DatabaseOptions = {}): Promise<Database> {
  if (opts.url) {
    pg.types.setTypeParser(INT8, (v) => Number(v));
    pg.types.setTypeParser(DATE, (v) => v);
    pg.types.setTypeParser(NUMERIC, (v) => v);
    const pool = new pg.Pool({ connectionString: opts.url, max: 20 });
    const kysely = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
    return {
      kind: 'postgres',
      kysely,
      async exec(script) {
        const client = await pool.connect();
        try {
          await client.query(script);
        } finally {
          client.release();
        }
      },
      close: () => kysely.destroy(),
    };
  }
  const pglite = await PGlite.create({
    ...(opts.pgliteDir ? { dataDir: opts.pgliteDir } : {}),
    extensions: { pg_trgm },
    parsers: { [INT8]: (v: string) => Number(v), [DATE]: (v: string) => v, [NUMERIC]: (v: string) => v },
  });
  const kysely = new Kysely<any>({ dialect: new PGliteDialect({ pglite }) });
  return {
    kind: 'pglite',
    kysely,
    async exec(script) {
      await pglite.exec(script);
    },
    async close() {
      await kysely.destroy();
      if (!pglite.closed) await pglite.close();
    },
  };
}
