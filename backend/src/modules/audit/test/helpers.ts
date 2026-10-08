/** Shared helpers for the audit behaviour tests. */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { newId } from '../../../kernel/lib/ids.js';
import type { AuditPublicApi, RecordInput } from '../../../spec/audit.js';

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

/** Changes rows behind the app's back, as someone with database access would (the append-only trigger off). */
export async function tamper(app: FastifyInstance, statement: ReturnType<typeof sql>) {
  const db = app.kernel.database.kysely;
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    await statement.execute(trx);
  });
}

export async function waitForEvents(app: FastifyInstance) {
  await app.kernel.events.drain();
}
