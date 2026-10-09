/**
 * Inbox for idempotent event consumers. A consumer claims a key (usually the event envelope id, or a
 * natural key such as `order-placed:<orderId>`) inside the same transaction as its effects: the claim and
 * the effects commit together, so a redelivered event (or a second publisher of the same fact) changes
 * nothing, and a failed attempt leaves the key free for the retry.
 *
 *   ctx.events.on('orders.order.placed', (e) => service.onOrderPlaced(e.payload, e.id));
 *   await ctx.db.transaction().execute(async (trx) => {
 *     if (!(await ctx.inbox.claim(trx, `order-placed:${payload.orderId}`))) return; // already handled
 *     ... effects on trx ...
 *   });
 */
import { sql, type Kysely } from 'kysely';

export interface Inbox {
  /** true the first time this module claims the key (within `db`'s transaction when one is given) */
  claim(db: Kysely<any>, key: string): Promise<boolean>;
  /** Whether the key was already claimed (read-only) */
  seen(db: Kysely<any>, key: string): Promise<boolean>;
}

export function moduleInbox(module: string): Inbox {
  return {
    async claim(db, key) {
      const r = await sql<{ key: string }>`insert into kernel.processed_events (module, key) values (${module}, ${key}) on conflict do nothing returning key`.execute(db);
      return r.rows.length > 0;
    },
    async seen(db, key) {
      const r = await sql<{ n: number }>`select 1 as n from kernel.processed_events where module = ${module} and key = ${key}`.execute(db);
      return r.rows.length > 0;
    },
  };
}
