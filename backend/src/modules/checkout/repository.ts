import type { Page, PageRequest } from '../../kernel/lib/pagination.js';
import { orThrow } from '../../kernel/lib/or-throw.js';
import { contains, type Filter, type ModuleStore } from '../../kernel/mongo/index.js';
import type { AdminSessionFilter, ChangeSetRow, LineRow, Lock, LogRow, Owner, PackageRow, PlaceRequestRow, SessionRow } from './ports.js';

/** checkout.sessions, checkout.session_lines, checkout.session_packages, checkout.change_sets, checkout.place_requests, checkout.session_log (MongoDB, docs/04-mongodb-migration.md) */
export class CheckoutRepository {
  readonly #t;

  constructor(private readonly store: ModuleStore) {
    this.#t = {
      sessions: store.table<SessionRow>('sessions'),
      lines: store.table<LineRow>('session_lines'),
      packages: store.table<PackageRow>('session_packages'),
      changeSets: store.table<ChangeSetRow>('change_sets'),
      requests: store.table<PlaceRequestRow>('place_requests'),
      log: store.table<LogRow>('session_log'),
    };
  }

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: CheckoutRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new CheckoutRepository(tx)));
  }

  /* ---------------------------------------------------------------- sessions */

  insertSession(row: SessionRow): Promise<SessionRow> {
    return this.#t.sessions.insert(row);
  }

  /** Any session (consumers, jobs, staff) */
  getSession(id: string, lock?: Lock): Promise<SessionRow | undefined> {
    return this.#t.sessions.get(id, { forUpdate: lock?.forUpdate });
  }

  /** The owner's session; another shopper's session is simply not found */
  getOwnSession(owner: Owner, id: string, lock?: Lock): Promise<SessionRow | undefined> {
    // record scope: a customer reaches their sessions, a visitor only its own unclaimed guest sessions
    const scope = owner.customerId ? { id, customer_id: owner.customerId } : { id, guest_session_id: owner.guestSessionId!, customer_id: null };
    return this.#t.sessions.findOne(scope, { forUpdate: lock?.forUpdate });
  }

  async updateSession(id: string, patch: Partial<SessionRow>): Promise<SessionRow> {
    return orThrow(await this.#t.sessions.update(id, patch), `checkout: session ${id}`);
  }

  /**
   * One more authorization attempt, and the session after it. An atomic increment rather than reading
   * `attempt_count` and writing `+ 1`, so the attempt number belongs to this caller even without a lock
   * (BUILDING-MODULES.md: a value written back is locked first, or the write is made atomic).
   */
  async bumpAttempt(id: string): Promise<SessionRow> {
    return orThrow(await this.#t.sessions.update(id, { $inc: { attempt_count: 1 } }), `checkout: session ${id}`);
  }

  findSessionByOrder(orderId: string): Promise<SessionRow | undefined> {
    return this.#t.sessions.findOne({ order_id: orderId });
  }

  /** Open guest sessions of a visitor session (claimed at sign-in) */
  async listGuestSessions(guestSessionId: string, statuses: string[]): Promise<SessionRow[]> {
    if (!statuses.length) return [];
    return this.#t.sessions.find({ guest_session_id: guestSessionId, customer_id: null, status: { $in: statuses } });
  }

  /** Idle open sessions and failed ones past their retry window */
  listExpirable(now: Date, limit: number): Promise<SessionRow[]> {
    return this.#t.sessions.find(
      {
        $or: [
          { status: { $in: ['open', 'changes_pending'] }, expires_at: { $lte: now } },
          { status: 'payment_failed', hold_until: { $ne: null, $lte: now } },
        ],
      },
      { sort: { updated_at: 1 }, limit },
    );
  }

  /** Sessions in these statuses after a session id (a keyset walk for jobs) */
  async listByStatusAfter(statuses: string[], afterId: string | null, limit: number): Promise<SessionRow[]> {
    if (!statuses.length) return [];
    return this.#t.sessions.find({ status: { $in: statuses }, ...(afterId ? { id: { $gt: afterId } } : {}) }, { sort: { id: 1 }, limit });
  }

  listSessionsAdmin(filter: AdminSessionFilter, page: PageRequest): Promise<Page<SessionRow>> {
    // guests who have not reached the contact step are listed too (email null on the row)
    const and: Filter[] = [];
    if (filter.statuses?.length) and.push({ status: { $in: filter.statuses } });
    if (filter.from) and.push({ created_at: { $gte: filter.from } });
    if (filter.to) and.push({ created_at: { $lt: filter.to } });
    if (filter.q?.trim()) {
      const like = contains(filter.q);
      and.push({ $or: [{ email: like }, { contact_name: like }, { order_ref: like }] });
    }
    return this.#t.sessions.page(and.length ? { $and: and } : {}, page, { column: 'created_at', direction: 'desc' });
  }

  /* ---------------------------------------------------------------- lines and packages */

  listLines(sessionId: string): Promise<LineRow[]> {
    return this.#t.lines.find({ session_id: sessionId });
  }

  listPackages(sessionId: string): Promise<PackageRow[]> {
    return this.#t.packages.find({ session_id: sessionId });
  }

  /** Replaces every line and package of the session */
  async replaceLinesAndPackages(sessionId: string, lines: LineRow[], packages: PackageRow[]): Promise<void> {
    await this.#t.lines.deleteMany({ session_id: sessionId });
    await this.#t.packages.deleteMany({ session_id: sessionId });
    await this.#t.lines.insertMany(lines);
    await this.#t.packages.insertMany(packages);
  }

  /* ---------------------------------------------------------------- change sets */

  insertChangeSet(row: ChangeSetRow): Promise<ChangeSetRow> {
    return this.#t.changeSets.insert(row);
  }

  getChangeSet(sessionId: string, id: string, lock?: Lock): Promise<ChangeSetRow | undefined> {
    return this.#t.changeSets.findOne({ session_id: sessionId, id }, { forUpdate: lock?.forUpdate });
  }

  latestChangeSet(sessionId: string): Promise<ChangeSetRow | undefined> {
    return this.#t.changeSets.findOne({ session_id: sessionId }, { sort: { created_at: -1, id: -1 } });
  }

  openChangeSet(sessionId: string): Promise<ChangeSetRow | undefined> {
    return this.#t.changeSets.findOne({ session_id: sessionId, status: 'open' }, { sort: { created_at: -1 } });
  }

  listChangeSets(sessionId: string): Promise<ChangeSetRow[]> {
    return this.#t.changeSets.find({ session_id: sessionId }, { sort: { created_at: -1 } });
  }

  async updateChangeSet(id: string, patch: Partial<ChangeSetRow>): Promise<ChangeSetRow> {
    return orThrow(await this.#t.changeSets.update(id, patch), `checkout: change set ${id}`);
  }

  /** Marks every open change set of the session superseded */
  async supersedeOpenChangeSets(sessionId: string): Promise<void> {
    await this.#t.changeSets.updateMany({ session_id: sessionId, status: 'open' }, { status: 'superseded' });
  }

  /* ---------------------------------------------------------------- place requests */

  getPlaceRequest(sessionId: string, key: string): Promise<PlaceRequestRow | undefined> {
    return this.#t.requests.findOne({ session_id: sessionId, idempotency_key: key });
  }

  /**
   * undefined when the (session, key) pair already exists (unique index): of two requests with the same key
   * racing, one is recorded.
   */
  insertPlaceRequest(row: PlaceRequestRow): Promise<PlaceRequestRow | undefined> {
    return this.#t.requests.insertIfAbsent(row);
  }

  async updatePlaceRequest(id: string, patch: Partial<PlaceRequestRow>): Promise<PlaceRequestRow> {
    return orThrow(await this.#t.requests.update(id, patch), `checkout: place request ${id}`);
  }

  async deletePlaceRequest(id: string): Promise<void> {
    await this.#t.requests.delete(id);
  }

  listPlaceRequests(sessionId: string): Promise<PlaceRequestRow[]> {
    return this.#t.requests.find({ session_id: sessionId }, { sort: { created_at: 1, id: 1 } });
  }

  latestPlaceRequest(sessionId: string): Promise<PlaceRequestRow | undefined> {
    return this.#t.requests.findOne({ session_id: sessionId }, { sort: { created_at: -1, id: -1 } });
  }

  purgePlaceRequests(before: Date): Promise<number> {
    return this.#t.requests.deleteMany({ created_at: { $lt: before } });
  }

  /* ---------------------------------------------------------------- log */

  async log(row: LogRow): Promise<void> {
    await this.#t.log.insert(row);
  }

  listLog(sessionId: string): Promise<LogRow[]> {
    return this.#t.log.find({ session_id: sessionId }, { sort: { at: 1, id: 1 } });
  }

  countLog(sessionId: string, label: string, since: Date): Promise<number> {
    return this.#t.log.count({ session_id: sessionId, label, at: { $gte: since } });
  }
}
