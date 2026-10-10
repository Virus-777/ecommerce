import { sql, type Kysely } from 'kysely';
import type { Inbox } from '../../../../kernel/events/inbox.js';
import { paginate } from '../../../../kernel/lib/pagination.js';
import type { WalletDb } from '../../../../spec/wallet.js';
import type { BalanceSnapshot, WalletRepository } from '../../ports.js';

const n = (v: unknown) => Number(v ?? 0);

/** Postgres adapter for WalletRepository. `db` is scoped to the `wallet` schema. */
export function createPostgresWalletRepository(db: Kysely<WalletDb>, inbox: Inbox): WalletRepository {
  const repo: WalletRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresWalletRepository(trx, inbox)));
    },
    claim(key) {
      return inbox.claim(db, key);
    },

    /* ---------------------------------------------------------------- accounts */
    async getAccount(customerId) {
      return db.selectFrom('accounts').selectAll().where('customer_id', '=', customerId).executeTakeFirst();
    },
    async lockAccount(customerId) {
      return db.selectFrom('accounts').selectAll().where('customer_id', '=', customerId).forUpdate().executeTakeFirst();
    },
    async lockOrCreateAccount(customerId, currency, now) {
      await db
        .insertInto('accounts')
        .values({ customer_id: customerId, currency, available: 0, held: 0, updated_at: now, version: 0 })
        .onConflict((oc) => oc.column('customer_id').doNothing())
        .execute();
      return db.selectFrom('accounts').selectAll().where('customer_id', '=', customerId).forUpdate().executeTakeFirstOrThrow();
    },
    async updateAccount(customerId, patch) {
      return db
        .updateTable('accounts')
        .set({ ...patch, version: sql<number>`version + 1` })
        .where('customer_id', '=', customerId)
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    /* ---------------------------------------------------------------- lots */
    async insertLot(row) {
      return db.insertInto('lots').values(row).returningAll().executeTakeFirstOrThrow();
    },
    async getLots(ids, o) {
      if (!ids.length) return [];
      let q = db.selectFrom('lots').selectAll().where('id', 'in', [...new Set(ids)]).orderBy('id');
      if (o?.forUpdate) q = q.forUpdate();
      return q.execute();
    },
    async updateLot(id, patch) {
      return db.updateTable('lots').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async usableLots(customerId, now, o) {
      let q = db
        .selectFrom('lots')
        .selectAll()
        .where('customer_id', '=', customerId)
        .where('state', '=', 'active')
        .where('remaining', '>', 0)
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
        .orderBy(sql`expires_at asc nulls last`)
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc');
      if (o?.forUpdate) q = q.forUpdate();
      return q.execute();
    },
    async dueLots(customerId, now, o) {
      let q = db.selectFrom('lots').selectAll().where('customer_id', '=', customerId).where('state', '=', 'active').where('expires_at', '<=', now).orderBy('expires_at').orderBy('id');
      if (o?.forUpdate) q = q.forUpdate();
      return q.execute();
    },
    async customersWithDueLots(now, limit) {
      const rows = await db.selectFrom('lots').select('customer_id').distinct().where('state', '=', 'active').where('expires_at', '<=', now).orderBy('customer_id').limit(limit).execute();
      return rows.map((r) => r.customer_id);
    },
    async lotsExpiringBetween(from, to, limit) {
      return db
        .selectFrom('lots')
        .selectAll()
        .where('state', '=', 'active')
        .where('remaining', '>', 0)
        .where('expires_at', '>=', from)
        .where('expires_at', '<', to)
        .orderBy('expires_at')
        .orderBy('id')
        .limit(limit)
        .execute();
    },

    /* ---------------------------------------------------------------- ledger */
    async insertEntry(row) {
      return db
        .insertInto('ledger')
        .values({ ...row, lot_allocations: JSON.stringify(row.lot_allocations) as never })
        .returningAll()
        .executeTakeFirstOrThrow();
    },
    async getEntry(id) {
      return db.selectFrom('ledger').selectAll().where('id', '=', id).executeTakeFirst();
    },
    async getEntries(ids) {
      if (!ids.length) return [];
      return db.selectFrom('ledger').selectAll().where('id', 'in', [...new Set(ids)]).execute();
    },
    async entryByKey(key) {
      return db.selectFrom('ledger').selectAll().where('idempotency_key', '=', key).executeTakeFirst();
    },
    async entriesOfRefund(refundId) {
      return db.selectFrom('ledger').selectAll().where('refund_id', '=', refundId).orderBy('at').orderBy('id').execute();
    },
    async entryOfHold(holdId, kind) {
      return db.selectFrom('ledger').selectAll().where('hold_id', '=', holdId).where('kind', '=', kind).executeTakeFirst();
    },
    async orderCredit(customerId, orderId) {
      const rows = await db
        .selectFrom('ledger')
        .select(['kind', sql<number>`coalesce(sum(amount), 0)::bigint`.as('total')])
        .where('customer_id', '=', customerId)
        .where('order_id', '=', orderId)
        .where('kind', 'in', ['capture', 'order_refund_returned'])
        .groupBy('kind')
        .execute();
      const of = (k: string) => n(rows.find((r) => r.kind === k)?.total);
      return { used: -of('capture'), returned: of('order_refund_returned') };
    },
    async entriesPage(customerId, f, page) {
      let q = db.selectFrom('ledger').selectAll().where('customer_id', '=', customerId);
      if (f.kinds?.length) q = q.where('kind', 'in', [...f.kinds]);
      if (f.excludeKinds?.length) q = q.where('kind', 'not in', [...f.excludeKinds]);
      return paginate(q, page, { column: 'at', direction: 'desc' });
    },
    async recentEntries(customerId, limit, excludeKinds) {
      let q = db.selectFrom('ledger').selectAll().where('customer_id', '=', customerId);
      if (excludeKinds?.length) q = q.where('kind', 'not in', [...excludeKinds]);
      return q.orderBy('at', 'desc').orderBy('id', 'desc').limit(limit).execute();
    },

    /* ---------------------------------------------------------------- holds */
    async insertHold(row) {
      return db.insertInto('holds').values(row).returningAll().executeTakeFirstOrThrow();
    },
    async getHold(id, o) {
      let q = db.selectFrom('holds').selectAll().where('id', '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async holdByKey(key) {
      return db.selectFrom('holds').selectAll().where('idempotency_key', '=', key).executeTakeFirst();
    },
    async liveHoldOfQuote(quoteId, o) {
      let q = db.selectFrom('holds').selectAll().where('quote_id', '=', quoteId).where('state', '=', 'held');
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async holdsOfQuote(quoteId) {
      return db.selectFrom('holds').selectAll().where('quote_id', '=', quoteId).orderBy('expires_at', 'desc').execute();
    },
    async updateHold(id, patch) {
      return db.updateTable('holds').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async staleHolds(now, limit) {
      return db.selectFrom('holds').selectAll().where('state', '=', 'held').where('expires_at', '<=', now).orderBy('expires_at').orderBy('id').limit(limit).execute();
    },

    /* ---------------------------------------------------------------- goodwill */
    async insertGrant(row) {
      return db.insertInto('goodwill_grants').values(row).onConflict((oc) => oc.column('idempotency_key').doNothing()).returningAll().executeTakeFirst();
    },
    async getGrant(id, o) {
      let q = db.selectFrom('goodwill_grants').selectAll().where('id', '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async grantByKey(key) {
      return db.selectFrom('goodwill_grants').selectAll().where('idempotency_key', '=', key).executeTakeFirst();
    },
    async grantByApproval(requestId) {
      return db.selectFrom('goodwill_grants').selectAll().where('approval_request_id', '=', requestId).executeTakeFirst();
    },
    async grantsOfEntries(entryIds) {
      if (!entryIds.length) return [];
      return db.selectFrom('goodwill_grants').selectAll().where('ledger_entry_id', 'in', [...new Set(entryIds)]).execute();
    },
    async updateGrant(id, patch) {
      return db.updateTable('goodwill_grants').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async grantsPage(f, page) {
      let q = db.selectFrom('goodwill_grants').selectAll();
      if (f.state) q = q.where('state', '=', f.state);
      if (f.customerId) q = q.where('customer_id', '=', f.customerId);
      if (f.from) q = q.where('created_at', '>=', f.from);
      if (f.to) q = q.where('created_at', '<', f.to);
      if (f.requestedBy) q = q.where(sql<string>`requested_by::jsonb ->> 'id'`, '=', f.requestedBy);
      return paginate(q, page, { column: 'created_at', direction: 'desc' });
    },
    async grantsOfCustomer(customerId, states) {
      if (!states.length) return [];
      return db.selectFrom('goodwill_grants').selectAll().where('customer_id', '=', customerId).where('state', 'in', [...states]).orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
    },
    async goodwillSince(customerId, since) {
      const r = await db
        .selectFrom('goodwill_grants')
        .select(sql<number>`coalesce(sum(amount), 0)::bigint`.as('total'))
        .where('customer_id', '=', customerId)
        .where('state', 'in', ['granted', 'pending_approval'])
        .where('created_at', '>', since)
        .executeTakeFirst();
      return n(r?.total);
    },

    /* ---------------------------------------------------------------- gift cards */
    async insertGiftCards(rows) {
      if (rows.length) await db.insertInto('gift_cards').values(rows).execute();
    },
    async getGiftCard(id, o) {
      let q = db.selectFrom('gift_cards').selectAll().where('id', '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async giftCardByHash(codeHash, o) {
      let q = db.selectFrom('gift_cards').selectAll().where('code_hash', '=', codeHash);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async giftCardsOfBatch(batchId) {
      return db.selectFrom('gift_cards').selectAll().where('batch_id', '=', batchId).orderBy('created_at').orderBy('id').execute();
    },
    async updateGiftCard(id, patch) {
      return db.updateTable('gift_cards').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async giftCardsPage(f, page) {
      let q = db.selectFrom('gift_cards').selectAll();
      if (f.last4) q = q.where('code_last4', '=', f.last4.trim().toUpperCase());
      if (f.batchId) q = q.where('batch_id', '=', f.batchId);
      if (f.state) q = q.where('state', '=', f.state);
      return paginate(q, page, { column: 'created_at', direction: 'desc' });
    },
    async dueGiftCards(now, limit) {
      return db.selectFrom('gift_cards').selectAll().where('state', '=', 'active').where('expires_at', '<=', now).orderBy('expires_at').orderBy('id').limit(limit).execute();
    },

    /* ---------------------------------------------------------------- gift card batches */
    async insertBatch(row) {
      await db.insertInto('gift_card_batches').values(row).onConflict((oc) => oc.doNothing()).execute();
      return db.selectFrom('gift_card_batches').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow();
    },
    async getBatch(id, o) {
      let q = db.selectFrom('gift_card_batches').selectAll().where('id', '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async updateBatch(id, patch) {
      return db.updateTable('gift_card_batches').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async clearExpiredBatchCodes(now) {
      const r = await db.updateTable('gift_card_batches').set({ codes_ciphertext: null }).where('codes_ciphertext', 'is not', null).where('codes_expire_at', '<=', now).executeTakeFirst();
      return Number(r.numUpdatedRows ?? 0);
    },

    /* ---------------------------------------------------------------- loyalty */
    async loyaltyPoints(customerId) {
      const r = await db.selectFrom('loyalty_entries').select(sql<number>`coalesce(sum(points), 0)::int`.as('points')).where('customer_id', '=', customerId).executeTakeFirst();
      return n(r?.points);
    },

    /* ---------------------------------------------------------------- checks */
    async balanceSnapshots(after, limit) {
      const rows = await sql<{ customer_id: string; available: number; held: number; ledger_sum: number; lots_sum: number; holds_sum: number }>`
        select a.customer_id, a.available, a.held,
          coalesce((select sum(l.amount) from wallet.ledger l where l.customer_id = a.customer_id), 0)::bigint as ledger_sum,
          coalesce((select sum(t.remaining) from wallet.lots t where t.customer_id = a.customer_id and t.state = 'active'), 0)::bigint as lots_sum,
          coalesce((select sum(h.amount) from wallet.holds h where h.customer_id = a.customer_id and h.state = 'held'), 0)::bigint as holds_sum
        from wallet.accounts a
        ${after ? sql`where a.customer_id > ${after}` : sql``}
        order by a.customer_id
        limit ${limit}`.execute(db);
      return rows.rows.map(
        (r): BalanceSnapshot => ({ customerId: r.customer_id, available: n(r.available), held: n(r.held), ledgerSum: n(r.ledger_sum), lotsSum: n(r.lots_sum), holdsSum: n(r.holds_sum) }),
      );
    },
    async liabilityNow() {
      const r = await sql<{ available: number; held: number; accounts: number }>`
        select coalesce(sum(available), 0)::bigint as available, coalesce(sum(held), 0)::bigint as held, count(*)::int as accounts
        from wallet.accounts`.execute(db);
      const x = r.rows[0];
      return { available: n(x?.available), held: n(x?.held), accounts: n(x?.accounts) };
    },
    async liabilityAt(asOf) {
      // total: the ledger up to asOf (append-only, so the sum is the balance then);
      // held: holds whose 'hold' entry is at or before asOf and that no capture or release ended by then
      const r = await sql<{ total: number; held: number; accounts: number }>`
        select
          coalesce((select sum(amount) from wallet.ledger where at <= ${asOf}), 0)::bigint as total,
          coalesce((
            select sum(h.amount) from wallet.holds h
            where exists (select 1 from wallet.ledger e where e.hold_id = h.id and e.kind = 'hold' and e.at <= ${asOf})
              and not exists (select 1 from wallet.ledger e where e.hold_id = h.id and e.kind in ('capture', 'release') and e.at <= ${asOf})
          ), 0)::bigint as held,
          (select count(distinct customer_id) from wallet.ledger where at <= ${asOf})::int as accounts`.execute(db);
      const x = r.rows[0];
      return { total: n(x?.total), held: n(x?.held), accounts: n(x?.accounts) };
    },
  };
  return repo;
}
