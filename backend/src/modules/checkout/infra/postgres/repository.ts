import { sql, type Kysely } from 'kysely';
import { paginate, type PageRequest } from '../../../../kernel/lib/pagination.js';
import type { CheckoutDb } from '../../../../spec/checkout.js';
import type { CheckoutRepository, LineRow, Owner, PackageRow } from '../../ports.js';

/** jsonb columns are written as JSON text (the driver would turn arrays into Postgres arrays) */
const jsonCols = ['account', 'address', 'totals', 'coupon_codes', 'credit', 'payment_selection', 'discounts', 'options', 'selected_option', 'changes', 'decisions', 'response'] as const;
function encode<T extends object>(row: T): T {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const c of jsonCols) if (c in out && out[c] !== null && out[c] !== undefined) out[c] = JSON.stringify(out[c]);
  return out as T;
}

/** Postgres adapter for CheckoutRepository. `db` is scoped to the `checkout` schema. */
export function createPostgresCheckoutRepository(db: Kysely<CheckoutDb>): CheckoutRepository {
  const repo: CheckoutRepository = {
    transaction: (fn) => db.transaction().execute((trx) => fn(createPostgresCheckoutRepository(trx))),

    /* ---------------------------------------------------------------- sessions */
    async insertSession(row) {
      return db.insertInto('sessions').values(encode(row)).returningAll().executeTakeFirstOrThrow();
    },
    async getSession(id, lock) {
      let q = db.selectFrom('sessions').selectAll().where('id', '=', id);
      if (lock?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async getOwnSession(owner: Owner, id, lock) {
      let q = db.selectFrom('sessions').selectAll().where('id', '=', id);
      // record scope: a customer reaches their sessions, a visitor only its own unclaimed guest sessions
      if (owner.customerId) q = q.where('customer_id', '=', owner.customerId);
      else q = q.where('guest_session_id', '=', owner.guestSessionId!).where('customer_id', 'is', null);
      if (lock?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async updateSession(id, patch) {
      return db.updateTable('sessions').set(encode(patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async findSessionByOrder(orderId) {
      return db.selectFrom('sessions').selectAll().where('order_id', '=', orderId).executeTakeFirst();
    },
    async listGuestSessions(guestSessionId, statuses) {
      if (!statuses.length) return [];
      return db.selectFrom('sessions').selectAll().where('guest_session_id', '=', guestSessionId).where('customer_id', 'is', null).where('status', 'in', statuses).execute();
    },
    async listExpirable(now, limit) {
      return db
        .selectFrom('sessions')
        .selectAll()
        .where((eb) =>
          eb.or([
            eb.and([eb('status', 'in', ['open', 'changes_pending']), eb('expires_at', '<=', now)]),
            eb.and([eb('status', '=', 'payment_failed'), eb('hold_until', 'is not', null), eb('hold_until', '<=', now)]),
          ]),
        )
        .orderBy('updated_at')
        .limit(limit)
        .execute();
    },
    async listByStatus(statuses, limit) {
      if (!statuses.length) return [];
      return db.selectFrom('sessions').selectAll().where('status', 'in', statuses).orderBy('updated_at').limit(limit).execute();
    },
    async listSessionsAdmin(filter, page: PageRequest) {
      // guests who have not reached the contact step are listed too (email null on the row)
      let q = db.selectFrom('sessions').selectAll();
      if (filter.statuses?.length) q = q.where('status', 'in', filter.statuses);
      if (filter.from) q = q.where('created_at', '>=', filter.from);
      if (filter.to) q = q.where('created_at', '<', filter.to);
      if (filter.q?.trim()) {
        const like = `%${filter.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
        q = q.where(sql<boolean>`(email ilike ${like} or contact_name ilike ${like} or order_ref ilike ${like})`);
      }
      return paginate(q, page, { column: 'created_at', direction: 'desc' });
    },

    /* ---------------------------------------------------------------- lines and packages */
    async listLines(sessionId) {
      return db.selectFrom('session_lines').selectAll().where('session_id', '=', sessionId).execute();
    },
    async listPackages(sessionId) {
      return db.selectFrom('session_packages').selectAll().where('session_id', '=', sessionId).execute();
    },
    async replaceLinesAndPackages(sessionId, lines: LineRow[], packages: PackageRow[]) {
      await db.deleteFrom('session_lines').where('session_id', '=', sessionId).execute();
      await db.deleteFrom('session_packages').where('session_id', '=', sessionId).execute();
      if (lines.length) await db.insertInto('session_lines').values(lines.map(encode)).execute();
      if (packages.length) await db.insertInto('session_packages').values(packages.map(encode)).execute();
    },

    /* ---------------------------------------------------------------- change sets */
    async insertChangeSet(row) {
      return db.insertInto('change_sets').values(encode(row)).returningAll().executeTakeFirstOrThrow();
    },
    async getChangeSet(sessionId, id, lock) {
      let q = db.selectFrom('change_sets').selectAll().where('session_id', '=', sessionId).where('id', '=', id);
      if (lock?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async latestChangeSet(sessionId) {
      return db.selectFrom('change_sets').selectAll().where('session_id', '=', sessionId).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    },
    async openChangeSet(sessionId) {
      return db.selectFrom('change_sets').selectAll().where('session_id', '=', sessionId).where('status', '=', 'open').orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    },
    async listChangeSets(sessionId) {
      return db.selectFrom('change_sets').selectAll().where('session_id', '=', sessionId).orderBy('created_at', 'desc').execute();
    },
    async updateChangeSet(id, patch) {
      return db.updateTable('change_sets').set(encode(patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async supersedeOpenChangeSets(sessionId) {
      await db.updateTable('change_sets').set({ status: 'superseded' }).where('session_id', '=', sessionId).where('status', '=', 'open').execute();
    },

    /* ---------------------------------------------------------------- place requests */
    async getPlaceRequest(sessionId, key) {
      return db.selectFrom('place_requests').selectAll().where('session_id', '=', sessionId).where('idempotency_key', '=', key).executeTakeFirst();
    },
    async insertPlaceRequest(row) {
      return db
        .insertInto('place_requests')
        .values(encode(row))
        .onConflict((oc) => oc.columns(['session_id', 'idempotency_key']).doNothing())
        .returningAll()
        .executeTakeFirst();
    },
    async updatePlaceRequest(id, patch) {
      return db.updateTable('place_requests').set(encode(patch)).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async deletePlaceRequest(id) {
      await db.deleteFrom('place_requests').where('id', '=', id).execute();
    },
    async listPlaceRequests(sessionId) {
      return db.selectFrom('place_requests').selectAll().where('session_id', '=', sessionId).orderBy('created_at').orderBy('id').execute();
    },
    async latestPlaceRequest(sessionId) {
      return db.selectFrom('place_requests').selectAll().where('session_id', '=', sessionId).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    },
    async purgePlaceRequests(before) {
      const r = await db.deleteFrom('place_requests').where('created_at', '<', before).executeTakeFirst();
      return Number(r.numDeletedRows ?? 0);
    },

    /* ---------------------------------------------------------------- log */
    async log(row) {
      await db.insertInto('session_log').values(row).execute();
    },
    async listLog(sessionId) {
      return db.selectFrom('session_log').selectAll().where('session_id', '=', sessionId).orderBy('at').orderBy('id').execute();
    },
    async countLog(sessionId, label, since) {
      const r = await db
        .selectFrom('session_log')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('session_id', '=', sessionId)
        .where('label', '=', label)
        .where('at', '>=', since)
        .executeTakeFirst();
      return Number(r?.n ?? 0);
    },
  };
  return repo;
}
