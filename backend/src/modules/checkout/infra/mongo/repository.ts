import type { ModuleStore } from '../../../../kernel/mongo/index.js';
import type { Filter } from '../../../../kernel/mongo/table.js';
import type { ChangeSetRow, CheckoutRepository, LineRow, LogRow, PackageRow, PlaceRequestRow, SessionRow } from '../../ports.js';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** MongoDB adapter for CheckoutRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoCheckoutRepository(store: ModuleStore): CheckoutRepository {
  const t = {
    sessions: store.table<SessionRow>('sessions'),
    lines: store.table<LineRow>('session_lines'),
    packages: store.table<PackageRow>('session_packages'),
    changeSets: store.table<ChangeSetRow>('change_sets'),
    requests: store.table<PlaceRequestRow>('place_requests'),
    log: store.table<LogRow>('session_log'),
  };

  const orThrow = <R>(row: R | undefined, what: string): R => {
    if (!row) throw new Error(`checkout: ${what} not found`);
    return row;
  };

  const repo: CheckoutRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoCheckoutRepository(tx))),

    /* ---------------------------------------------------------------- sessions */
    insertSession: (row) => t.sessions.insert(row),
    getSession: (id, lock) => t.sessions.get(id, { forUpdate: lock?.forUpdate }),
    getOwnSession: (owner, id, lock) =>
      // record scope: a customer reaches their sessions, a visitor only its own unclaimed guest sessions
      t.sessions.findOne(owner.customerId ? { id, customer_id: owner.customerId } : { id, guest_session_id: owner.guestSessionId!, customer_id: null }, { forUpdate: lock?.forUpdate }),
    updateSession: async (id, patch) => orThrow(await t.sessions.update(id, patch), `session ${id}`),
    findSessionByOrder: (orderId) => t.sessions.findOne({ order_id: orderId }),
    async listGuestSessions(guestSessionId, statuses) {
      if (!statuses.length) return [];
      return t.sessions.find({ guest_session_id: guestSessionId, customer_id: null, status: { $in: statuses } });
    },
    listExpirable: (now, limit) =>
      t.sessions.find(
        {
          $or: [
            { status: { $in: ['open', 'changes_pending'] }, expires_at: { $lte: now } },
            { status: 'payment_failed', hold_until: { $ne: null, $lte: now } },
          ],
        },
        { sort: { updated_at: 1 }, limit },
      ),
    async listByStatus(statuses, limit) {
      if (!statuses.length) return [];
      return t.sessions.find({ status: { $in: statuses } }, { sort: { updated_at: 1 }, limit });
    },
    listSessionsAdmin(filter, page) {
      // guests who have not reached the contact step are listed too (email null on the row)
      const and: Filter[] = [];
      if (filter.statuses?.length) and.push({ status: { $in: filter.statuses } });
      if (filter.from) and.push({ created_at: { $gte: filter.from } });
      if (filter.to) and.push({ created_at: { $lt: filter.to } });
      if (filter.q?.trim()) {
        const like = { $regex: escapeRegExp(filter.q.trim()), $options: 'i' };
        and.push({ $or: [{ email: like }, { contact_name: like }, { order_ref: like }] });
      }
      return t.sessions.page(and.length ? { $and: and } : {}, page, { column: 'created_at', direction: 'desc' });
    },

    /* ---------------------------------------------------------------- lines and packages */
    listLines: (sessionId) => t.lines.find({ session_id: sessionId }),
    listPackages: (sessionId) => t.packages.find({ session_id: sessionId }),
    async replaceLinesAndPackages(sessionId, lines, packages) {
      await t.lines.deleteMany({ session_id: sessionId });
      await t.packages.deleteMany({ session_id: sessionId });
      await t.lines.insertMany(lines);
      await t.packages.insertMany(packages);
    },

    /* ---------------------------------------------------------------- change sets */
    insertChangeSet: (row) => t.changeSets.insert(row),
    getChangeSet: (sessionId, id, lock) => t.changeSets.findOne({ session_id: sessionId, id }, { forUpdate: lock?.forUpdate }),
    latestChangeSet: (sessionId) => t.changeSets.findOne({ session_id: sessionId }, { sort: { created_at: -1, id: -1 } }),
    openChangeSet: (sessionId) => t.changeSets.findOne({ session_id: sessionId, status: 'open' }, { sort: { created_at: -1 } }),
    listChangeSets: (sessionId) => t.changeSets.find({ session_id: sessionId }, { sort: { created_at: -1 } }),
    updateChangeSet: async (id, patch) => orThrow(await t.changeSets.update(id, patch), `change set ${id}`),
    async supersedeOpenChangeSets(sessionId) {
      await t.changeSets.updateMany({ session_id: sessionId, status: 'open' }, { status: 'superseded' });
    },

    /* ---------------------------------------------------------------- place requests */
    getPlaceRequest: (sessionId, key) => t.requests.findOne({ session_id: sessionId, idempotency_key: key }),
    async insertPlaceRequest(row) {
      // one request per (session, key): on conflict do nothing
      try {
        return await t.requests.insertIfAbsent(row, ['session_id', 'idempotency_key']);
      } catch (err) {
        // two requests with the same key racing outside a transaction: the other one was recorded
        if (!store.inTransaction && (err as { code?: number }).code === 11000) return undefined;
        throw err;
      }
    },
    updatePlaceRequest: async (id, patch) => orThrow(await t.requests.update(id, patch), `place request ${id}`),
    async deletePlaceRequest(id) {
      await t.requests.delete(id);
    },
    listPlaceRequests: (sessionId) => t.requests.find({ session_id: sessionId }, { sort: { created_at: 1, id: 1 } }),
    latestPlaceRequest: (sessionId) => t.requests.findOne({ session_id: sessionId }, { sort: { created_at: -1, id: -1 } }),
    purgePlaceRequests: (before) => t.requests.deleteMany({ created_at: { $lt: before } }),

    /* ---------------------------------------------------------------- log */
    async log(row) {
      await t.log.insert(row);
    },
    listLog: (sessionId) => t.log.find({ session_id: sessionId }, { sort: { at: 1, id: 1 } }),
    countLog: (sessionId, label, since) => t.log.count({ session_id: sessionId, label, at: { $gte: since } }),
  };
  return repo;
}
