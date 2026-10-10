/**
 * PGlite behind a PostgreSQL socket server, for tests of what needs real connections to one database:
 * pg-boss, and several app instances sharing a database (DATABASE_URL).
 */
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readFile } from 'node:fs/promises';
import { inject } from 'vitest';

export interface PgServer {
  /** postgres://… for pg, pg-boss or DATABASE_URL */
  url: string;
  close(): Promise<void>;
}

/** An empty database, or (migrated) one started from the dump global-setup.ts made */
export async function pgliteServer(o: { migrated?: boolean } = {}): Promise<PgServer> {
  const loadDataDir = o.migrated ? new Blob([await readFile(inject('pgliteDump'))]) : undefined;
  const db = await PGlite.create({ loadDataDir, extensions: { pg_trgm } });
  const server = new PGLiteSocketServer({ db, port: 0, maxConnections: 100 });
  await server.start();
  return {
    url: `postgres://postgres:postgres@${server.getServerConn()}/postgres?sslmode=disable`,
    async close() {
      await server.stop();
      await db.close();
    },
  };
}
