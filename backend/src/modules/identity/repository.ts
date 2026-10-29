import { orThrow } from '../../kernel/lib/or-throw.js';
import type { PageRequest } from '../../kernel/lib/pagination.js';
import { inc, type Store, type StoreTable, type Where, type WhereWithOr } from '../../kernel/store/index.js';
import type { Page } from '../../spec/common.js';
import type { IdentityDb } from '../../spec/identity.js';
import type {
  AccountFilter,
  AccountRow,
  Audience,
  ChallengeRow,
  DeviceRow,
  DeviceWithSessions,
  ForUpdate,
  GuestGrantRow,
  GuestSessionRow,
  InvitationRow,
  OrderLinkRow,
  PasswordResetRow,
  Realm,
  ReauthTokenRow,
  RecoveryCodeRow,
  SecurityEventFilter,
  SecurityEventRow,
  SellerAccessRow,
  SessionRow,
  SessionSelector,
  SignInAttemptInsert,
  TwoStepMethodRow,
} from './ports.js';
import type { IdentityQueries } from './queries.js';

type PasswordHistoryRow = IdentityDb['password_history'];
type SignInAttemptRow = IdentityDb['sign_in_attempts'];

/** Stored bytes: a Buffer (Mongoose refuses a plain Uint8Array) */
const bin = (v: Uint8Array | null | undefined) => (v ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);
/** A JSON value as stored: what JSON.stringify keeps */
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? {})) as never;

function group<R, K extends string>(rows: R[], key: (r: R) => K) {
  const m = new Map<K, R[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
}

/**
 * "It has a value" — MongoDB's own `$ne: null`, which is what `is not` means on either store. `<>` null
 * matches nothing at all, so this is the one place the two readings are not a choice.
 */
const SET = { op: 'is not' as const, value: null };

/** Sessions in force at `now`: not revoked, not past either expiry */
const live = (now: Date): Where<SessionRow> => ({ revoked_at: null, expires_at: { op: '>', value: now }, absolute_expires_at: { op: '>', value: now } });

/** Ids of the first `limit` rows matching (a bounded batch for the jobs) */
const batch = async <R extends object, K extends keyof R>(table: StoreTable<R>, where: WhereWithOr<R>, limit: number, key: K): Promise<R[K][]> =>
  (await table.find(where, { limit })).map((r) => r[key]);

/**
 * The identity module's tables, in the neutral vocabulary on `ctx.store`, so its data lives in either
 * database (docs/10-mysql-migration.md §10.5). The two reads that are not one sentence in both — the newest
 * events per account (a window function) and the expiry sweep's computed `revoked_at` — are in `queries.ts`,
 * with one implementation per store.
 */
export class IdentityRepository {
  readonly #t;

  constructor(
    private readonly store: Store,
    private readonly queries: IdentityQueries,
  ) {
    this.#t = {
      accounts: store.table<AccountRow>('accounts'),
      passwordHistory: store.table<PasswordHistoryRow>('password_history'),
      methods: store.table<TwoStepMethodRow>('two_step_methods'),
      recoveryCodes: store.table<RecoveryCodeRow>('recovery_codes'),
      challenges: store.table<ChallengeRow>('challenges'),
      resets: store.table<PasswordResetRow>('password_resets'),
      devices: store.table<DeviceRow>('devices'),
      sessions: store.table<SessionRow>('sessions'),
      sellerAccess: store.table<SellerAccessRow>('seller_access'),
      invitations: store.table<InvitationRow>('invitations'),
      guestSessions: store.table<GuestSessionRow>('guest_sessions'),
      grants: store.table<GuestGrantRow>('guest_order_grants'),
      orderLinks: store.table<OrderLinkRow>('order_links'),
      securityEvents: store.table<SecurityEventRow>('security_events'),
      signInAttempts: store.table<SignInAttemptRow>('sign_in_attempts'),
      reauth: store.table<ReauthTokenRow>('reauth_tokens'),
    };
  }

  /** Runs fn in one transaction with a repository bound to it */
  transaction<R>(fn: (tx: IdentityRepository) => Promise<R>): Promise<R> {
    return this.store.transaction((tx) => fn(new IdentityRepository(tx, this.queries)));
  }

  /* ---------------------------------------------------------------- accounts */
  getAccount(id: string, o?: ForUpdate): Promise<AccountRow | undefined> {
    return this.#t.accounts.get(id, { forUpdate: o?.forUpdate });
  }

  getAccounts(ids: readonly string[]): Promise<AccountRow[]> {
    return this.#t.accounts.getMany(ids);
  }

  findAccount(realm: Realm, email: string, o?: ForUpdate): Promise<AccountRow | undefined> {
    return this.#t.accounts.findOne({ realm, email_normalized: email }, { forUpdate: o?.forUpdate });
  }

  findAccountsByEmail(email: string): Promise<AccountRow[]> {
    return this.#t.accounts.find({ email_normalized: email });
  }

  async insertAccount(row: AccountRow): Promise<void> {
    await this.#t.accounts.insert(row);
  }

  async updateAccount(id: string, patch: Partial<AccountRow>): Promise<AccountRow> {
    // version + 1 on every change (a version in the patch is overridden)
    const { version: _version, ...set } = patch;
    return orThrow(await this.#t.accounts.update(id, { ...set, version: inc('version', 1) }), `identity: account ${id}`);
  }

  async listAccounts(f: AccountFilter, page: PageRequest): Promise<Page<AccountRow>> {
    const where: WhereWithOr<AccountRow> = { realm: f.realm };
    if (f.status) where.status = f.status;
    // the search box matches either column, trimmed and ignoring case — one spelling on both stores
    if (f.q?.trim()) where.or = [{ email_normalized: { op: 'contains', value: f.q } }, { display_name: { op: 'contains', value: f.q } }];
    if (f.twoStepEnabled !== undefined && f.twoStepEnabled !== null) {
      // accounts with a confirmed method that is not removed (a join is two reads)
      const withMethod = await this.#t.methods.distinct<string>('account_id', { removed_at: null, confirmed_at: SET });
      // "one of none" matches nothing and an empty `not in` filters nothing, which is what each means when
      // no account has 2-step on at all
      where.id = f.twoStepEnabled ? withMethod : { op: 'not in', value: withMethod };
    }
    return this.#t.accounts.page(where, page, { column: 'created_at', direction: 'desc' });
  }

  /** Unverified member accounts created before `before`, deleted with everything they own */
  async deleteUnverifiedAccounts(before: Date, limit: number): Promise<number> {
    const ids = await batch(this.#t.accounts, { realm: 'member', status: 'pending_verification', email_verified_at: null, created_at: { op: '<', value: before } }, limit, 'id');
    if (!ids.length) return 0;
    const owned = { account_id: ids };
    await this.#t.reauth.deleteMany(owned);
    await this.#t.sessions.deleteMany(owned);
    for (const table of [this.#t.passwordHistory, this.#t.methods, this.#t.recoveryCodes, this.#t.challenges, this.#t.resets, this.#t.devices, this.#t.sellerAccess, this.#t.securityEvents]) await table.deleteMany(owned);
    await this.#t.invitations.updateMany(owned, { account_id: null });
    return this.#t.accounts.deleteMany({ id: ids });
  }

  /* ---------------------------------------------------------------- passwords */
  async addPasswordHistory(row: { id: string; account_id: string; password_hash: string; created_at: Date }): Promise<void> {
    await this.#t.passwordHistory.insert(row);
  }

  async recentPasswordHashes(accountId: string, limit: number): Promise<string[]> {
    return (await this.#t.passwordHistory.find({ account_id: accountId }, { sort: { created_at: -1, id: -1 }, limit })).map((r) => r.password_hash);
  }

  /* ---------------------------------------------------------------- 2-step */
  /**
   * `forUpdate` where the caller then writes one of these rows: checking a TOTP code reads `last_used_step`
   * and writes the step it accepted, which is a read-modify-write and the replay guard itself (§11.2 rule 1).
   */
  activeMethods(ids: readonly string[], o?: ForUpdate): Promise<TwoStepMethodRow[]> {
    return ids.length ? this.#t.methods.find({ account_id: [...ids], removed_at: null, confirmed_at: SET }, { sort: { confirmed_at: 1 }, forUpdate: o?.forUpdate }) : Promise.resolve([]);
  }

  /** The accounts among ids with 2-step on (a confirmed method): their ids only, not the method rows */
  async withTwoStep(ids: readonly string[]): Promise<Set<string>> {
    return new Set(ids.length ? await this.#t.methods.distinct<string>('account_id', { account_id: [...ids], removed_at: null, confirmed_at: SET }) : []);
  }

  async insertMethod(row: TwoStepMethodRow): Promise<void> {
    await this.#t.methods.insert({ ...row, secret_encrypted: bin(row.secret_encrypted), phone_e164_encrypted: bin(row.phone_e164_encrypted) });
  }

  async updateMethod(id: string, patch: Partial<TwoStepMethodRow>): Promise<void> {
    await this.#t.methods.update(id, patch);
  }

  removeAllMethods(accountId: string, at: Date): Promise<number> {
    return this.#t.methods.updateMany({ account_id: accountId, removed_at: null }, { removed_at: at });
  }

  async replaceRecoveryCodes(accountId: string, rows: RecoveryCodeRow[]): Promise<void> {
    await this.#t.recoveryCodes.deleteMany({ account_id: accountId });
    await this.#t.recoveryCodes.insertMany(rows);
  }

  /** Marks an unused code used; false when there is none with that hash */
  async useRecoveryCode(accountId: string, codeHash: string, at: Date): Promise<boolean> {
    // a conditional update: only an unused code is marked, so a code works once even under concurrent use
    return (await this.#t.recoveryCodes.updateMany({ account_id: accountId, code_hash: codeHash, used_at: null }, { used_at: at })) > 0;
  }

  async remainingRecoveryCodes(ids: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!ids.length) return out;
    // how many unused codes per account: a plain count per key, the one aggregate both stores read alike
    for (const r of await this.#t.recoveryCodes.countBy(['account_id'], { account_id: [...ids], used_at: null })) out.set(r.account_id, r.n);
    return out;
  }

  async deleteRecoveryCodes(accountId: string): Promise<void> {
    await this.#t.recoveryCodes.deleteMany({ account_id: accountId });
  }

  /* ---------------------------------------------------------------- challenges */
  async insertChallenge(row: ChallengeRow): Promise<void> {
    await this.#t.challenges.insert({ ...row, payload: json(row.payload), target_phone_encrypted: bin(row.target_phone_encrypted) });
  }

  getChallenge(id: string, o?: ForUpdate): Promise<ChallengeRow | undefined> {
    return this.#t.challenges.get(id, { forUpdate: o?.forUpdate });
  }

  async updateChallenge(id: string, patch: Partial<ChallengeRow>): Promise<ChallengeRow> {
    const p = 'payload' in patch ? { ...patch, payload: json(patch.payload) } : patch;
    return orThrow(await this.#t.challenges.update(id, p), `identity: challenge ${id}`);
  }

  /**
   * Pending challenges of an account and purpose move to expired (superseded)
   *
   * **No test covers `exceptId`**, and none can: all five callers supersede before inserting the replacement,
   * so none of them passes it. Dropping the condition altogether changes no test's answer (checked), and the
   * argument is kept because it is the only thing standing between "supersede the others" and "supersede the
   * one I just made" the day a caller needs that.
   */
  async supersedeChallenges(accountId: string, purpose: ChallengeRow['purpose'], exceptId?: string): Promise<void> {
    // `<>` rather than `is not`: `id` is the primary key, so "not this one" and "not this one, a null
    // included" are the same rows, and `<>` is the reading the spec's conditions are written in
    await this.#t.challenges.updateMany({ account_id: accountId, purpose, status: 'pending', ...(exceptId ? { id: { op: '<>' as const, value: exceptId } } : {}) }, { status: 'expired' });
  }

  /** Pending email changes (new address) per account */
  async pendingEmailChanges(ids: readonly string[], now: Date): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const rows = await this.#t.challenges.find({ account_id: [...ids], purpose: 'email_change', status: 'pending', expires_at: { op: '>', value: now } }, { sort: { created_at: 1 } });
    for (const r of rows) if (r.account_id && r.target_email) out.set(r.account_id, r.target_email);
    return out;
  }

  /* ---------------------------------------------------------------- password resets */
  async insertReset(row: PasswordResetRow): Promise<void> {
    await this.#t.resets.insert(row);
  }

  findResetByHash(hash: string, o?: ForUpdate): Promise<PasswordResetRow | undefined> {
    return this.#t.resets.findOne({ token_hash: hash }, { forUpdate: o?.forUpdate });
  }

  async updateReset(id: string, patch: Partial<PasswordResetRow>): Promise<void> {
    await this.#t.resets.update(id, patch);
  }

  /** Unused links of an account stop working (a new request replaces them) */
  async invalidateResets(accountId: string, at: Date): Promise<void> {
    await this.#t.resets.updateMany({ account_id: accountId, used_at: null, expires_at: { op: '>', value: at } }, { expires_at: at });
  }

  latestReset(accountId: string): Promise<PasswordResetRow | undefined> {
    return this.#t.resets.findOne({ account_id: accountId }, { sort: { created_at: -1 } });
  }

  /* ---------------------------------------------------------------- devices */
  /** `forUpdate` on the sign-in path, which stamps the device it recognises (§11.2 rule 1) */
  findDeviceByInstallation(accountId: string, installationId: string, o?: ForUpdate): Promise<DeviceRow | undefined> {
    return this.#t.devices.findOne({ account_id: accountId, installation_id: installationId }, { forUpdate: o?.forUpdate });
  }

  findWebDevice(accountId: string, userAgent: string | null, o?: ForUpdate): Promise<DeviceRow | undefined> {
    return this.#t.devices.findOne({ account_id: accountId, kind: 'web', installation_id: null, user_agent: userAgent }, { sort: { last_active_at: -1 }, forUpdate: o?.forUpdate });
  }

  countDevices(accountId: string): Promise<number> {
    return this.#t.devices.count({ account_id: accountId });
  }

  async insertDevice(row: DeviceRow): Promise<void> {
    await this.#t.devices.insert(row);
  }

  async updateDevice(id: string, patch: Partial<DeviceRow>): Promise<void> {
    await this.#t.devices.update(id, patch);
  }

  getDevice(id: string): Promise<DeviceRow | undefined> {
    return this.#t.devices.get(id);
  }

  /** Devices with live sessions, most recently active first */
  async devicesOf(ids: readonly string[], now: Date): Promise<Map<string, DeviceWithSessions[]>> {
    const out = new Map<string, DeviceWithSessions[]>();
    if (!ids.length) return out;
    // devices joined with their live sessions: two reads
    const sessions = await this.#t.sessions.find({ account_id: [...ids], ...live(now) }, { sort: { created_at: 1, id: 1 } });
    const byDevice = group(sessions, (s) => s.device_id);
    if (!byDevice.size) return out;
    const devices = await this.#t.devices.find({ id: [...byDevice.keys()], account_id: [...ids] }, { sort: { last_active_at: -1 } });
    for (const device of devices) {
      const own = byDevice.get(device.id)!;
      const d: DeviceWithSessions = { ...device, audiences: [...new Set(own.map((s) => s.audience))].sort() as DeviceWithSessions['audiences'], sessionIds: own.map((s) => s.id) };
      out.set(d.account_id, [...(out.get(d.account_id) ?? []), d]);
    }
    return out;
  }

  async clearDeviceTrust(accountId: string): Promise<void> {
    await this.#t.devices.updateMany({ account_id: accountId }, { two_step_trusted_until: null });
  }

  /* ---------------------------------------------------------------- sessions */
  async insertSession(row: SessionRow): Promise<void> {
    await this.#t.sessions.insert(row);
  }

  getSession(id: string, o?: ForUpdate): Promise<SessionRow | undefined> {
    return this.#t.sessions.get(id, { forUpdate: o?.forUpdate });
  }

  /** The session whose current or previous refresh token has this hash */
  findSessionByRefreshHash(hash: string, o?: ForUpdate): Promise<SessionRow | undefined> {
    return this.#t.sessions.findOne({ or: [{ refresh_token_hash: hash }, { previous_token_hash: hash }] }, { forUpdate: o?.forUpdate });
  }

  async updateSession(id: string, patch: Partial<SessionRow>): Promise<void> {
    await this.#t.sessions.update(id, patch);
  }

  /** Live sessions (not revoked, not expired), oldest refresh first */
  liveSessions(accountId: string, now: Date, audience?: Audience): Promise<SessionRow[]> {
    return this.#t.sessions.find({ account_id: accountId, ...live(now), ...(audience ? { audience } : {}) }, { sort: { last_refreshed_at: 1, id: 1 } });
  }

  /** Revokes the live sessions matched; returns their ids */
  async revokeSessions(sel: SessionSelector, reason: string, at: Date): Promise<string[]> {
    if (sel.sessionIds && !sel.sessionIds.length) return [];
    // both selectors are conditions on `id`, and one object cannot hold two of the same name. `<>` for "not
    // this one": `id` is the primary key, so a null does not come into it
    const byId: Where<SessionRow>[] = [];
    if (sel.exceptSessionId) byId.push({ id: { op: '<>', value: sel.exceptSessionId } });
    if (sel.sessionIds) byId.push({ id: sel.sessionIds });
    const where: WhereWithOr<SessionRow> = {
      account_id: sel.accountId,
      ...live(at),
      ...(sel.audience ? { audience: sel.audience } : {}),
      ...(sel.deviceId ? { device_id: sel.deviceId } : {}),
      ...(sel.sellerId ? { seller_id: sel.sellerId } : {}),
      ...(byId.length ? { and: byId } : {}),
    };
    // update … returning id: the sessions are locked (forUpdate) and revoked in one transaction, so the ids
    // returned are exactly the sessions this call revoked
    return this.store.transaction(async (tx) => {
      const sessions = tx.table<SessionRow>('sessions');
      const ids = (await sessions.find(where, { forUpdate: true })).map((s) => s.id);
      if (ids.length) await sessions.updateMany({ id: ids }, { revoked_at: at, revoke_reason: reason });
      return ids;
    });
  }

  /* ---------------------------------------------------------------- seller access */
  /**
   * `forUpdate` where the caller goes on to write one of these rows in the same transaction: the sign-in
   * path reads the account's contexts to choose one and then stamps `last_used_at` on it (§11.2 rule 1 —
   * the detector is right that the account's own lock says nothing about the next writer of this table).
   */
  activeSellerAccess(accountId: string, o?: ForUpdate): Promise<SellerAccessRow[]> {
    return this.#t.sellerAccess.find({ account_id: accountId, revoked_at: null }, { sort: { seller_name: 1 }, forUpdate: o?.forUpdate });
  }

  getSellerAccess(accountId: string, sellerId: string, o?: ForUpdate): Promise<SellerAccessRow | undefined> {
    return this.#t.sellerAccess.findOne({ account_id: accountId, seller_id: sellerId }, { forUpdate: o?.forUpdate });
  }

  async upsertSellerAccess(row: SellerAccessRow): Promise<void> {
    await this.#t.sellerAccess.upsert(row, {
      key: ['account_id', 'seller_id'],
      update: { seller_member_id: row.seller_member_id, seller_name: row.seller_name, role_label: row.role_label, is_owner: row.is_owner, granted_at: row.granted_at, revoked_at: null },
    });
  }

  async updateSellerAccess(accountId: string, sellerId: string, patch: Partial<SellerAccessRow>): Promise<void> {
    await this.#t.sellerAccess.updateMany({ account_id: accountId, seller_id: sellerId }, patch);
  }

  async sellerCounts(ids: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!ids.length) return out;
    // how many live seller accesses per account: a plain count per key, so not a port query
    for (const r of await this.#t.sellerAccess.countBy(['account_id'], { account_id: [...ids], revoked_at: null })) out.set(r.account_id, r.n);
    return out;
  }

  async activeSellerAccessOf(ids: readonly string[]): Promise<Map<string, SellerAccessRow[]>> {
    if (!ids.length) return new Map<string, SellerAccessRow[]>();
    return group(await this.#t.sellerAccess.find({ account_id: [...ids], revoked_at: null }, { sort: { seller_name: 1 } }), (r) => r.account_id);
  }

  /* ---------------------------------------------------------------- invitations */
  async insertInvitation(row: InvitationRow): Promise<void> {
    await this.#t.invitations.insert(row);
  }

  getInvitation(id: string, o?: ForUpdate): Promise<InvitationRow | undefined> {
    return this.#t.invitations.get(id, { forUpdate: o?.forUpdate });
  }

  findInvitationByHash(hash: string, o?: ForUpdate): Promise<InvitationRow | undefined> {
    return this.#t.invitations.findOne({ token_hash: hash }, { forUpdate: o?.forUpdate });
  }

  async updateInvitation(id: string, patch: Partial<InvitationRow>): Promise<InvitationRow> {
    return orThrow(await this.#t.invitations.update(id, patch), `identity: invitation ${id}`);
  }

  listInvitations(f: { purpose: InvitationRow['purpose']; status?: string | null }, page: PageRequest): Promise<Page<InvitationRow>> {
    return this.#t.invitations.page({ purpose: f.purpose, ...(f.status ? { status: f.status } : {}) }, page, { column: 'sent_at', direction: 'desc' });
  }

  /** Staff invitations a staff member sent that are still waiting to be accepted */
  pendingStaffInvitationsBy(accountId: string): Promise<InvitationRow[]> {
    return this.#t.invitations.find({ purpose: 'staff', status: 'pending', invited_by_kind: 'staff', invited_by_id: accountId });
  }

  /** Pending invitations to the same person and context are revoked when a new one is sent */
  async revokePendingInvitations(sel: { email: string; purpose: InvitationRow['purpose']; contextRef: string | null }, reason: string, at: Date): Promise<void> {
    await this.#t.invitations.updateMany({ email: sel.email, purpose: sel.purpose, status: 'pending', context_ref: sel.contextRef }, { status: 'revoked', revoked_at: at, revoke_reason: reason });
  }

  async latestInvitations(ids: readonly string[]): Promise<Map<string, InvitationRow>> {
    const out = new Map<string, InvitationRow>();
    if (!ids.length) return out;
    for (const r of await this.#t.invitations.find({ account_id: [...ids] }, { sort: { sent_at: 1 } })) if (r.account_id) out.set(r.account_id, r);
    return out;
  }

  /* ---------------------------------------------------------------- visitor sessions */
  async insertGuestSession(row: GuestSessionRow): Promise<void> {
    await this.#t.guestSessions.insert(row);
  }

  getGuestSession(id: string, o?: ForUpdate): Promise<GuestSessionRow | undefined> {
    return this.#t.guestSessions.get(id, { forUpdate: o?.forUpdate });
  }

  findGuestSessionByRefreshHash(hash: string, o?: ForUpdate): Promise<GuestSessionRow | undefined> {
    return this.#t.guestSessions.findOne({ or: [{ refresh_token_hash: hash }, { previous_token_hash: hash }] }, { forUpdate: o?.forUpdate });
  }

  async updateGuestSession(id: string, patch: Partial<GuestSessionRow>): Promise<void> {
    await this.#t.guestSessions.update(id, patch);
  }

  async upsertGrant(row: GuestGrantRow): Promise<void> {
    await this.#t.grants.upsert(row, { key: ['guest_session_id', 'order_id'], update: { email_normalized: row.email_normalized, via: row.via, granted_at: row.granted_at, expires_at: row.expires_at } });
  }

  async liveGrantOrderIds(guestSessionId: string, now: Date): Promise<string[]> {
    return (await this.#t.grants.find({ guest_session_id: guestSessionId, expires_at: { op: '>', value: now } }, { sort: { granted_at: 1 } })).map((r) => r.order_id);
  }

  hasLiveGrant(guestSessionId: string, orderId: string, now: Date): Promise<boolean> {
    return this.#t.grants.exists({ guest_session_id: guestSessionId, order_id: orderId, expires_at: { op: '>', value: now } });
  }

  /* ---------------------------------------------------------------- order links */
  async insertOrderLink(row: OrderLinkRow): Promise<void> {
    await this.#t.orderLinks.insert(row);
  }

  findOrderLinkByHash(hash: string, o?: ForUpdate): Promise<OrderLinkRow | undefined> {
    return this.#t.orderLinks.findOne({ token_hash: hash }, { forUpdate: o?.forUpdate });
  }

  async updateOrderLink(id: string, patch: Partial<OrderLinkRow>): Promise<void> {
    await this.#t.orderLinks.update(id, patch);
  }

  /* ---------------------------------------------------------------- security activity */
  async insertSecurityEvent(row: SecurityEventRow): Promise<void> {
    await this.#t.securityEvents.insert({ ...row, detail: json(row.detail) });
  }

  listSecurityEvents(accountId: string, f: SecurityEventFilter, page: PageRequest): Promise<Page<SecurityEventRow>> {
    // `since` and `until` are two conditions on `at`, which one object cannot hold
    const at: Where<SecurityEventRow>[] = [];
    if (f.since) at.push({ at: { op: '>=', value: f.since } });
    if (f.until) at.push({ at: { op: '<', value: f.until } });
    return this.#t.securityEvents.page(
      { account_id: accountId, ...(at.length ? { and: at } : {}), ...(f.result ? { result: f.result } : {}), ...(f.kind ? { kind: f.kind } : {}) },
      page,
      { column: 'at', direction: 'desc' },
    );
  }

  /** Newest first, at most `limit` per account */
  async recentSecurityEvents(ids: readonly string[], limit: number, since?: Date): Promise<Map<string, SecurityEventRow[]>> {
    if (!ids.length) return new Map<string, SecurityEventRow[]>();
    // "the newest `limit` per account" is a window function, so it belongs to the store (queries.ts)
    return group(await this.queries.recentSecurityEvents({ accountIds: ids, limit, since }), (r) => r.account_id);
  }

  /* ---------------------------------------------------------------- sign-in attempts */
  async insertSignInAttempt(row: SignInAttemptInsert): Promise<void> {
    // `id` is the spec's one `bigserial`, and the generator gives MySQL a plain BIGINT for it rather than an
    // AUTO_INCREMENT (its `TableDef.identity` is null), so the row has to arrive numbered. The counter named
    // here is the one MongoDB's own `Table` took its numbers from, so the sequence is unbroken either way.
    await this.#t.signInAttempts.insert({ ...row, id: await this.store.nextValue('sign_in_attempts.id') });
  }

  async failedAttemptsSince(email: string, since: Date): Promise<Date[]> {
    return (await this.#t.signInAttempts.find({ email_normalized: email, succeeded: false, at: { op: '>=', value: since } }, { sort: { at: 1 } })).map((r) => r.at);
  }

  /* ---------------------------------------------------------------- re-auth tokens */
  async insertReauthToken(row: ReauthTokenRow): Promise<void> {
    await this.#t.reauth.insert(row);
  }

  getReauthToken(hash: string): Promise<ReauthTokenRow | undefined> {
    return this.#t.reauth.get(hash);
  }

  /** true when this call marked it (it was unused) */
  async markReauthUsed(hash: string, at: Date): Promise<boolean> {
    // claims the token only if unused: one conditional update, so two concurrent uses cannot both succeed
    return (await this.#t.reauth.updateMany({ token_hash: hash, used_at: null }, { used_at: at })) > 0;
  }

  async clearReauthUsed(hash: string): Promise<void> {
    await this.#t.reauth.update(hash, { used_at: null });
  }

  /* ---------------------------------------------------------------- revocation feed */
  async revokedSessionsSince(since: Date): Promise<{ id: string; at: Date }[]> {
    // `>` never matches a null, on either store, so a live session (revoked_at null) stays out of the feed
    return (await this.#t.sessions.find({ revoked_at: { op: '>', value: since } })).map((r) => ({ id: r.id, at: r.revoked_at! }));
  }

  async claimedGuestSessionsSince(since: Date): Promise<{ id: string; at: Date }[]> {
    return (await this.#t.guestSessions.find({ claimed_at: { op: '>', value: since } })).map((r) => ({ id: r.id, at: r.claimed_at! }));
  }

  async accountRevocationsSince(since: Date): Promise<{ id: string; at: Date }[]> {
    return (await this.#t.accounts.find({ tokens_valid_after: { op: '>', value: since } })).map((r) => ({ id: r.id, at: r.tokens_valid_after! }));
  }

  /* ---------------------------------------------------------------- jobs */
  async deleteExpiredChallenges(now: Date, limit: number): Promise<number> {
    const ids = await batch(this.#t.challenges, { expires_at: { op: '<', value: now } }, limit, 'id');
    return ids.length ? this.#t.challenges.deleteMany({ id: ids }) : 0;
  }

  async deleteExpiredResets(now: Date, limit: number): Promise<number> {
    const ids = await batch(this.#t.resets, { expires_at: { op: '<', value: now } }, limit, 'id');
    return ids.length ? this.#t.resets.deleteMany({ id: ids }) : 0;
  }

  async deleteExpiredReauthTokens(now: Date, limit: number): Promise<number> {
    const hashes = await batch(this.#t.reauth, { expires_at: { op: '<', value: now } }, limit, 'token_hash');
    return hashes.length ? this.#t.reauth.deleteMany({ token_hash: hashes }) : 0;
  }

  async deleteExpiredOrderLinks(now: Date, limit: number): Promise<number> {
    const ids = await batch(this.#t.orderLinks, { expires_at: { op: '<', value: now } }, limit, 'id');
    return ids.length ? this.#t.orderLinks.deleteMany({ id: ids }) : 0;
  }

  async deleteExpiredGrants(now: Date, limit: number): Promise<number> {
    const keys = await this.#t.grants.find({ expires_at: { op: '<', value: now } }, { limit });
    if (!keys.length) return 0;
    // the table's key is a pair, so the batch is named one pair at a time
    return this.#t.grants.deleteMany({ or: keys.map((k) => ({ guest_session_id: k.guest_session_id, order_id: k.order_id })) });
  }

  /** Visitor sessions past their TTL that no longer carry a live order grant */
  async deleteExpiredGuestSessions(now: Date, limit: number): Promise<number> {
    // past their TTL and no longer carrying a live order grant (not exists: two reads). An empty `not in`
    // leaves the column unfiltered, which is what "no session is spoken for" means
    const withLiveGrant = await this.#t.grants.distinct<string>('guest_session_id', { expires_at: { op: '>=', value: now } });
    const doomed = await batch(this.#t.guestSessions, { expires_at: { op: '<', value: now }, id: { op: 'not in', value: withLiveGrant } }, limit, 'id');
    if (!doomed.length) return 0;
    await this.#t.grants.deleteMany({ guest_session_id: doomed });
    return this.#t.guestSessions.deleteMany({ id: doomed });
  }

  async expirePendingInvitations(now: Date, limit: number): Promise<number> {
    const ids = await batch(this.#t.invitations, { status: 'pending', expires_at: { op: '<', value: now } }, limit, 'id');
    return ids.length ? this.#t.invitations.updateMany({ id: ids }, { status: 'expired' }) : 0;
  }

  async expireSessions(now: Date, staffIdleBefore: Date, limit: number): Promise<number> {
    const ids = await batch(
      this.#t.sessions,
      { revoked_at: null, or: [{ expires_at: { op: '<=', value: now } }, { absolute_expires_at: { op: '<=', value: now } }, { audience: 'admin', last_active_at: { op: '<', value: staffIdleBefore } }] },
      limit,
      'id',
    );
    if (!ids.length) return 0;
    // revoked when it ran out: least(expires_at, absolute_expires_at, now), computed per row by the server
    return this.queries.revokeRanOut(ids, now);
  }

  async pruneRevokedSessions(before: Date, limit: number): Promise<number> {
    // `<` matches no null on either store, so a live session is never pruned
    const doomed = await batch(this.#t.sessions, { revoked_at: { op: '<', value: before } }, limit, 'id');
    if (!doomed.length) return 0;
    await this.#t.reauth.deleteMany({ session_id: doomed });
    return this.#t.sessions.deleteMany({ id: doomed });
  }

  async deleteSecurityEventsBefore(before: Date, limit: number): Promise<number> {
    const ids = await batch(this.#t.securityEvents, { at: { op: '<', value: before } }, limit, 'id');
    return ids.length ? this.#t.securityEvents.deleteMany({ id: ids }) : 0;
  }

  async deleteSignInAttemptsBefore(before: Date, limit: number): Promise<number> {
    const ids = await batch(this.#t.signInAttempts, { at: { op: '<', value: before } }, limit, 'id');
    return ids.length ? this.#t.signInAttempts.deleteMany({ id: ids }) : 0;
  }
}
