/** Shared helpers for the audit behaviour tests. */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { newId } from '../../../kernel/lib/ids.js';
import type { ModuleStore } from '../../../kernel/mysql/module-store.js';
import type { StoreTable } from '../../../kernel/store/index.js';
import type { AuditDb, AuditPublicApi, AuditTables, RecordInput } from '../../../spec/audit.js';
import { unit } from '../mysql-schema.js';

export const auditApi = (app: FastifyInstance) => app.kernel.boot.apis.get('audit') as AuditPublicApi;

export const staffActor = (name = 'Priya Nair', id = newId()) => ({ kind: 'staff' as const, id, name });

/** A minimal valid entry; override what the test cares about. */
export function entry(over: Partial<RecordInput> = {}): RecordInput {
  return {
    actor: staffActor(),
    action: 'finance.hold.released',
    actionLabel: 'Released payout hold',
    module: 'finance',
    category: 'financial',
    target: { type: 'hold', id: newId(), ref: 'HLD-261009-0001', label: 'Casa Verde Home' },
    reason: 'Delivery confirmed',
    ...over,
  };
}

/** The methods that change rows behind the app's back, which is what an append-only table refuses on MySQL */
const TAMPERS = new Set(['update', 'updateOne', 'updateMany', 'delete', 'deleteMany']);

/** The generated append-only triggers of one of the module's MySQL tables (docs/10 §6.3); MongoDB has none */
const triggersOf = (table: string) => unit.tables.find((t) => t.name === `audit_${table}`)?.triggers ?? [];

/**
 * One of the module's tables as its repository reads it (rows in spec shape), **through the store the app chose** —
 * MongoDB or MySQL, whichever `MYSQL_MODULES` put this module's data in. A helper that built a MongoDB store of its
 * own would read a database the module no longer writes to: the rows would simply not be there, and nothing in the
 * log would say why (docs/10 §10.5c).
 *
 * Writing through it changes rows behind the app's back, **as someone with database access would** — and on MySQL
 * that is more than a figure of speech. audit.entries, audit.entry_targets and audit.checkpoints are append-only,
 * which on MySQL means two triggers per table: UPDATE is refused outright, and DELETE to everyone but the retention
 * purge (§6.3). So a write through this helper takes those triggers off for the one statement and puts them straight
 * back, which is what a person holding the database — rather than the application — would have to do to forge
 * history. The tests that prove the hash chain notices then read the same on either store, assertions unchanged.
 */
export function auditTable<T extends keyof AuditDb & string>(app: FastifyInstance, name: T): StoreTable<AuditDb[T]> {
  const store = app.kernel.boot.stores.get('audit')!;
  const table = store.table<AuditDb[T]>(name);
  const db = (store as Partial<ModuleStore<AuditTables>>).db; // undefined unless this module's data is in MySQL
  const triggers = triggersOf(name);
  if (!db || !triggers.length) return table;
  return new Proxy(table, {
    get(t, prop) {
      const member = Reflect.get(t, prop, t);
      if (typeof member !== 'function') return member;
      const method = (member as (...a: never[]) => Promise<unknown>).bind(t);
      if (!TAMPERS.has(String(prop))) return method;
      return async (...args: never[]) => {
        for (const g of triggers) await sql.raw(`DROP TRIGGER IF EXISTS ${g.name}`).execute(db);
        try {
          return await method(...args);
        } finally {
          for (const g of triggers) await sql.raw(g.ddl).execute(db);
        }
      };
    },
  });
}

export async function waitForEvents(app: FastifyInstance) {
  await app.kernel.events.drain();
}
