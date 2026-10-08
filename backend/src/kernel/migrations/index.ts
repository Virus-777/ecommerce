/**
 * Migrations: the kernel's own tables first, then each enabled module's, in dependency order.
 * Each module owns one PostgreSQL schema (its name in snake_case); no foreign keys cross schemas.
 * Disabling or deleting a module leaves its schema in place until someone drops it on purpose.
 */
import { createHash } from 'node:crypto';
import type { Database } from '../db/index.js';

export interface Migration {
  /** e.g. 0001_init. Never edit a migration after it ran anywhere: add the next one. */
  id: string;
  sql: string;
}

export interface MigrationUnit {
  module: string;
  schema: string;
  migrations: Migration[];
}

const KERNEL: MigrationUnit = {
  module: 'kernel',
  schema: 'kernel',
  migrations: [
    {
      id: '0001_init',
      sql: /* sql */ `
create extension if not exists pg_trgm with schema public;
create table kernel.idempotency_keys (
  scope text not null,
  key text not null,
  request_hash text not null,
  status text not null check (status in ('in_progress', 'completed')),
  response_status int,
  response_body jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (scope, key)
);
comment on table kernel.idempotency_keys is 'Idempotency-Key replay store: same key + same body returns the first result (common.json headers)';
create index on kernel.idempotency_keys (created_at);
create table kernel.ref_counters (
  prefix text not null,
  period text not null,
  value int not null,
  primary key (prefix, period)
);
comment on table kernel.ref_counters is 'Sequences behind human references such as MK-YYMMDD-NNNNN';
`,
    },
  ],
};

const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex').slice(0, 16);
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface MigrationResult {
  applied: { module: string; id: string }[];
}

export async function migrate(db: Database, units: MigrationUnit[], log: (msg: string) => void = () => {}): Promise<MigrationResult> {
  await db.exec(`
create schema if not exists kernel;
create table if not exists kernel.schema_migrations (
  module text not null,
  id text not null,
  checksum text not null,
  applied_at timestamptz not null default now(),
  primary key (module, id)
);`);
  const { rows } = await db.kysely
    .selectFrom('kernel.schema_migrations')
    .select(['module', 'id', 'checksum'])
    .execute()
    .then((r) => ({ rows: r as { module: string; id: string; checksum: string }[] }));
  const done = new Map(rows.map((r) => [`${r.module}/${r.id}`, r.checksum]));
  const applied: MigrationResult['applied'] = [];

  for (const unit of [KERNEL, ...units]) {
    const seen = new Set<string>();
    for (const m of unit.migrations) {
      if (seen.has(m.id)) throw new Error(`Module ${unit.module}: migration id ${m.id} is listed twice`);
      seen.add(m.id);
      const sum = checksum(m.sql);
      const prev = done.get(`${unit.module}/${m.id}`);
      if (prev) {
        if (prev !== sum) throw new Error(`Module ${unit.module}: migration ${m.id} changed after it ran. Revert it and add a new migration instead.`);
        continue;
      }
      const script = `begin;
create schema if not exists ${unit.schema};
set local search_path to ${unit.schema}, public;
${m.sql}
insert into kernel.schema_migrations (module, id, checksum) values (${quote(unit.module)}, ${quote(m.id)}, ${quote(sum)});
commit;`;
      try {
        await db.exec(script);
      } catch (e) {
        await db.exec('rollback;').catch(() => {});
        throw new Error(`Module ${unit.module}: migration ${m.id} failed: ${(e as Error).message}`);
      }
      applied.push({ module: unit.module, id: m.id });
      log(`migrated ${unit.module}/${m.id}`);
    }
  }
  return { applied };
}
