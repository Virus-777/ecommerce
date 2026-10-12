import type { ModuleStore } from '../../../../kernel/mongo/index.js';
import type { Filter } from '../../../../kernel/mongo/table.js';
import type { IdentityDb } from '../../../../spec/identity.js';
import type {
  AccountRow,
  ChallengeRow,
  DeviceRow,
  DeviceWithSessions,
  GuestGrantRow,
  GuestSessionRow,
  IdentityRepository,
  InvitationRow,
  OrderLinkRow,
  PasswordResetRow,
  ReauthTokenRow,
  RecoveryCodeRow,
  SecurityEventRow,
  SellerAccessRow,
  SessionRow,
  TwoStepMethodRow,
} from '../../ports.js';

type PasswordHistoryRow = IdentityDb['password_history'];
type SignInAttemptRow = IdentityDb['sign_in_attempts'];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Stored bytes (bytea): a Buffer, as the PostgreSQL adapter wrote them */
const bin = (v: Uint8Array | null | undefined) => (v ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);
/** A json column as jsonb kept it (JSON.stringify) */
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? {})) as never;

function group<R, K extends string>(rows: R[], key: (r: R) => K) {
  const m = new Map<K, R[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
}

/** Sessions in force at `now`: not revoked, not past either expiry */
const live = (now: Date): Filter => ({ revoked_at: null, expires_at: { $gt: now }, absolute_expires_at: { $gt: now } });

/** MongoDB adapter for IdentityRepository (docs/04-mongodb-migration.md): one collection per spec table. */
export function createMongoIdentityRepository(store: ModuleStore): IdentityRepository {
  const t = {
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

  /** Ids of the first `limit` rows matching (a bounded batch for the jobs) */
  const batch = async <R extends object>(table: { find(f: Filter, o: { limit: number }): Promise<R[]> }, f: Filter, limit: number, key: keyof R) =>
    (await table.find(f, { limit })).map((r) => r[key]);

  const repo: IdentityRepository = {
    transaction: (fn) => store.transaction((tx) => fn(createMongoIdentityRepository(tx))),

    /* ---------------------------------------------------------------- accounts */
    getAccount: (id, o) => t.accounts.get(id, { forUpdate: o?.forUpdate }),
    getAccounts: (ids) => t.accounts.getMany(ids),
    findAccount: (realm, email, o) => t.accounts.findOne({ realm, email_normalized: email }, { forUpdate: o?.forUpdate }),
    findAccountsByEmail: (email) => t.accounts.find({ email_normalized: email }),
    async insertAccount(row) {
      await t.accounts.insert(row);
    },
    async updateAccount(id, patch) {
      // version + 1 on every change (a version in the patch is overridden, as in the SQL update)
      const { version: _version, ...set } = patch;
      const r = await t.accounts.update(id, { $set: set, $inc: { version: 1 } });
      if (!r) throw new Error(`identity: account ${id} not found`);
      return r;
    },
    async listAccounts(f, page) {
      const and: Filter[] = [{ realm: f.realm }];
      if (f.status) and.push({ status: f.status });
      if (f.q?.trim()) {
        const term = escapeRegExp(f.q.trim().toLowerCase());
        and.push({ $or: [{ email_normalized: { $regex: term } }, { display_name: { $regex: term, $options: 'i' } }] });
      }
      if (f.twoStepEnabled !== undefined && f.twoStepEnabled !== null) {
        // accounts with a confirmed method that is not removed (a join is two reads)
        const withMethod = await t.methods.distinct<string>('account_id', { removed_at: null, confirmed_at: { $ne: null } });
        and.push({ id: f.twoStepEnabled ? { $in: withMethod } : { $nin: withMethod } });
      }
      return t.accounts.page({ $and: and }, page, { column: 'created_at', direction: 'desc' });
    },
    async deleteUnverifiedAccounts(before, limit) {
      const ids = await batch(t.accounts, { realm: 'member', status: 'pending_verification', email_verified_at: null, created_at: { $lt: before } }, limit, 'id');
      if (!ids.length) return 0;
      const owned = { account_id: { $in: ids } };
      await t.reauth.deleteMany(owned);
      await t.sessions.deleteMany(owned);
      for (const table of [t.passwordHistory, t.methods, t.recoveryCodes, t.challenges, t.resets, t.devices, t.sellerAccess, t.securityEvents]) await table.deleteMany(owned);
      await t.invitations.updateMany(owned, { account_id: null });
      return t.accounts.deleteMany({ id: { $in: ids } });
    },

    /* ---------------------------------------------------------------- passwords */
    async addPasswordHistory(row) {
      await t.passwordHistory.insert(row);
    },
    async recentPasswordHashes(accountId, limit) {
      return (await t.passwordHistory.find({ account_id: accountId }, { sort: { created_at: -1, id: -1 }, limit })).map((r) => r.password_hash);
    },

    /* ---------------------------------------------------------------- 2-step */
    activeMethods: (ids) => (ids.length ? t.methods.find({ account_id: { $in: [...ids] }, removed_at: null, confirmed_at: { $ne: null } }, { sort: { confirmed_at: 1 } }) : Promise.resolve([])),
    async insertMethod(row) {
      await t.methods.insert({ ...row, secret_encrypted: bin(row.secret_encrypted), phone_e164_encrypted: bin(row.phone_e164_encrypted) });
    },
    async updateMethod(id, patch) {
      await t.methods.update(id, patch);
    },
    removeAllMethods: (accountId, at) => t.methods.updateMany({ account_id: accountId, removed_at: null }, { removed_at: at }),
    async replaceRecoveryCodes(accountId, rows) {
      await t.recoveryCodes.deleteMany({ account_id: accountId });
      await t.recoveryCodes.insertMany(rows);
    },
    async useRecoveryCode(accountId, codeHash, at) {
      // a conditional update: only an unused code is marked, so a code works once even under concurrent use
      return (await t.recoveryCodes.updateMany({ account_id: accountId, code_hash: codeHash, used_at: null }, { used_at: at })) > 0;
    },
    async remainingRecoveryCodes(ids) {
      const out = new Map<string, number>();
      if (!ids.length) return out;
      const rows = await t.recoveryCodes.aggregate<{ _id: string; n: number }>([{ $match: { account_id: { $in: [...ids] }, used_at: null } }, { $group: { _id: '$account_id', n: { $sum: 1 } } }]);
      for (const r of rows) out.set(r._id, r.n);
      return out;
    },
    async deleteRecoveryCodes(accountId) {
      await t.recoveryCodes.deleteMany({ account_id: accountId });
    },

    /* ---------------------------------------------------------------- challenges */
    async insertChallenge(row) {
      await t.challenges.insert({ ...row, payload: json(row.payload), target_phone_encrypted: bin(row.target_phone_encrypted) });
    },
    getChallenge: (id, o) => t.challenges.get(id, { forUpdate: o?.forUpdate }),
    async updateChallenge(id, patch) {
      const p = 'payload' in patch ? { ...patch, payload: json(patch.payload) } : patch;
      const r = await t.challenges.update(id, p);
      if (!r) throw new Error(`identity: challenge ${id} not found`);
      return r;
    },
    async supersedeChallenges(accountId, purpose, exceptId) {
      await t.challenges.updateMany({ account_id: accountId, purpose, status: 'pending', ...(exceptId ? { id: { $ne: exceptId } } : {}) }, { status: 'expired' });
    },
    async pendingEmailChanges(ids, now) {
      const out = new Map<string, string>();
      if (!ids.length) return out;
      const rows = await t.challenges.find({ account_id: { $in: [...ids] }, purpose: 'email_change', status: 'pending', expires_at: { $gt: now } }, { sort: { created_at: 1 } });
      for (const r of rows) if (r.account_id && r.target_email) out.set(r.account_id, r.target_email);
      return out;
    },

    /* ---------------------------------------------------------------- password resets */
    async insertReset(row) {
      await t.resets.insert(row);
    },
    findResetByHash: (hash, o) => t.resets.findOne({ token_hash: hash }, { forUpdate: o?.forUpdate }),
    async updateReset(id, patch) {
      await t.resets.update(id, patch);
    },
    async invalidateResets(accountId, at) {
      await t.resets.updateMany({ account_id: accountId, used_at: null, expires_at: { $gt: at } }, { expires_at: at });
    },
    latestReset: (accountId) => t.resets.findOne({ account_id: accountId }, { sort: { created_at: -1 } }),

    /* ---------------------------------------------------------------- devices */
    findDeviceByInstallation: (accountId, installationId) => t.devices.findOne({ account_id: accountId, installation_id: installationId }),
    findWebDevice: (accountId, userAgent) => t.devices.findOne({ account_id: accountId, kind: 'web', installation_id: null, user_agent: userAgent }, { sort: { last_active_at: -1 } }),
    countDevices: (accountId) => t.devices.count({ account_id: accountId }),
    async insertDevice(row) {
      await t.devices.insert(row);
    },
    async updateDevice(id, patch) {
      await t.devices.update(id, patch);
    },
    getDevice: (id) => t.devices.get(id),
    async devicesOf(ids, now) {
      const out = new Map<string, DeviceWithSessions[]>();
      if (!ids.length) return out;
      // devices joined with their live sessions: two reads
      const sessions = await t.sessions.find({ account_id: { $in: [...ids] }, ...live(now) }, { sort: { created_at: 1, id: 1 } });
      const byDevice = group(sessions, (s) => s.device_id);
      if (!byDevice.size) return out;
      const devices = await t.devices.find({ id: { $in: [...byDevice.keys()] }, account_id: { $in: [...ids] } }, { sort: { last_active_at: -1 } });
      for (const device of devices) {
        const own = byDevice.get(device.id)!;
        const d: DeviceWithSessions = { ...device, audiences: [...new Set(own.map((s) => s.audience))].sort() as DeviceWithSessions['audiences'], sessionIds: own.map((s) => s.id) };
        out.set(d.account_id, [...(out.get(d.account_id) ?? []), d]);
      }
      return out;
    },
    async clearDeviceTrust(accountId) {
      await t.devices.updateMany({ account_id: accountId }, { two_step_trusted_until: null });
    },

    /* ---------------------------------------------------------------- sessions */
    async insertSession(row) {
      await t.sessions.insert(row);
    },
    getSession: (id, o) => t.sessions.get(id, { forUpdate: o?.forUpdate }),
    findSessionByRefreshHash: (hash, o) => t.sessions.findOne({ $or: [{ refresh_token_hash: hash }, { previous_token_hash: hash }] }, { forUpdate: o?.forUpdate }),
    async updateSession(id, patch) {
      await t.sessions.update(id, patch);
    },
    liveSessions: (accountId, now, audience) => t.sessions.find({ account_id: accountId, ...live(now), ...(audience ? { audience } : {}) }, { sort: { last_refreshed_at: 1, id: 1 } }),
    async revokeSessions(sel, reason, at) {
      if (sel.sessionIds && !sel.sessionIds.length) return [];
      const id: Record<string, unknown> = {};
      if (sel.exceptSessionId) id.$ne = sel.exceptSessionId;
      if (sel.sessionIds) id.$in = sel.sessionIds;
      const filter: Filter = {
        account_id: sel.accountId,
        ...live(at),
        ...(sel.audience ? { audience: sel.audience } : {}),
        ...(sel.deviceId ? { device_id: sel.deviceId } : {}),
        ...(sel.sellerId ? { seller_id: sel.sellerId } : {}),
        ...(Object.keys(id).length ? { id } : {}),
      };
      // update … returning id: the sessions are locked (lock-by-write) and revoked in one transaction, so the ids
      // returned are exactly the sessions this call revoked
      return store.transaction(async (tx) => {
        const sessions = tx.table<SessionRow>('sessions');
        const ids = (await sessions.find(filter, { forUpdate: true })).map((s) => s.id);
        if (ids.length) await sessions.updateMany({ id: { $in: ids } }, { revoked_at: at, revoke_reason: reason });
        return ids;
      });
    },

    /* ---------------------------------------------------------------- seller access */
    activeSellerAccess: (accountId) => t.sellerAccess.find({ account_id: accountId, revoked_at: null }, { sort: { seller_name: 1 } }),
    getSellerAccess: (accountId, sellerId) => t.sellerAccess.findOne({ account_id: accountId, seller_id: sellerId }),
    async upsertSellerAccess(row) {
      await t.sellerAccess.upsert(row, {
        key: ['account_id', 'seller_id'],
        update: { seller_member_id: row.seller_member_id, seller_name: row.seller_name, role_label: row.role_label, is_owner: row.is_owner, granted_at: row.granted_at, revoked_at: null },
      });
    },
    async updateSellerAccess(accountId, sellerId, patch) {
      await t.sellerAccess.updateMany({ account_id: accountId, seller_id: sellerId }, patch);
    },
    async sellerCounts(ids) {
      const out = new Map<string, number>();
      if (!ids.length) return out;
      const rows = await t.sellerAccess.aggregate<{ _id: string; n: number }>([{ $match: { account_id: { $in: [...ids] }, revoked_at: null } }, { $group: { _id: '$account_id', n: { $sum: 1 } } }]);
      for (const r of rows) out.set(r._id, r.n);
      return out;
    },
    async activeSellerAccessOf(ids) {
      if (!ids.length) return new Map<string, SellerAccessRow[]>();
      return group(await t.sellerAccess.find({ account_id: { $in: [...ids] }, revoked_at: null }, { sort: { seller_name: 1 } }), (r) => r.account_id);
    },

    /* ---------------------------------------------------------------- invitations */
    async insertInvitation(row) {
      await t.invitations.insert(row);
    },
    getInvitation: (id, o) => t.invitations.get(id, { forUpdate: o?.forUpdate }),
    findInvitationByHash: (hash, o) => t.invitations.findOne({ token_hash: hash }, { forUpdate: o?.forUpdate }),
    async updateInvitation(id, patch) {
      const r = await t.invitations.update(id, patch);
      if (!r) throw new Error(`identity: invitation ${id} not found`);
      return r;
    },
    listInvitations: (f, page) => t.invitations.page({ purpose: f.purpose, ...(f.status ? { status: f.status } : {}) }, page, { column: 'sent_at', direction: 'desc' }),
    async revokePendingInvitations(sel, reason, at) {
      await t.invitations.updateMany({ email: sel.email, purpose: sel.purpose, status: 'pending', context_ref: sel.contextRef }, { status: 'revoked', revoked_at: at, revoke_reason: reason });
    },
    async latestInvitations(ids) {
      const out = new Map<string, InvitationRow>();
      if (!ids.length) return out;
      for (const r of await t.invitations.find({ account_id: { $in: [...ids] } }, { sort: { sent_at: 1 } })) if (r.account_id) out.set(r.account_id, r);
      return out;
    },

    /* ---------------------------------------------------------------- visitor sessions */
    async insertGuestSession(row) {
      await t.guestSessions.insert(row);
    },
    getGuestSession: (id, o) => t.guestSessions.get(id, { forUpdate: o?.forUpdate }),
    findGuestSessionByRefreshHash: (hash, o) => t.guestSessions.findOne({ $or: [{ refresh_token_hash: hash }, { previous_token_hash: hash }] }, { forUpdate: o?.forUpdate }),
    async updateGuestSession(id, patch) {
      await t.guestSessions.update(id, patch);
    },
    async upsertGrant(row) {
      await t.grants.upsert(row, { key: ['guest_session_id', 'order_id'], update: { email_normalized: row.email_normalized, via: row.via, granted_at: row.granted_at, expires_at: row.expires_at } });
    },
    async liveGrantOrderIds(guestSessionId, now) {
      return (await t.grants.find({ guest_session_id: guestSessionId, expires_at: { $gt: now } }, { sort: { granted_at: 1 } })).map((r) => r.order_id);
    },
    hasLiveGrant: (guestSessionId, orderId, now) => t.grants.exists({ guest_session_id: guestSessionId, order_id: orderId, expires_at: { $gt: now } }),

    /* ---------------------------------------------------------------- order links */
    async insertOrderLink(row) {
      await t.orderLinks.insert(row);
    },
    findOrderLinkByHash: (hash, o) => t.orderLinks.findOne({ token_hash: hash }, { forUpdate: o?.forUpdate }),
    async updateOrderLink(id, patch) {
      await t.orderLinks.update(id, patch);
    },

    /* ---------------------------------------------------------------- security activity */
    async insertSecurityEvent(row) {
      await t.securityEvents.insert({ ...row, detail: json(row.detail) });
    },
    listSecurityEvents(accountId, f, page) {
      const at: Record<string, Date> = {};
      if (f.since) at.$gte = f.since;
      if (f.until) at.$lt = f.until;
      return t.securityEvents.page(
        { account_id: accountId, ...(Object.keys(at).length ? { at } : {}), ...(f.result ? { result: f.result } : {}), ...(f.kind ? { kind: f.kind } : {}) },
        page,
        { column: 'at', direction: 'desc' },
      );
    },
    async recentSecurityEvents(ids, limit, since) {
      if (!ids.length) return new Map<string, SecurityEventRow[]>();
      // row_number() over (partition by account_id order by at desc, id desc) <= limit: the top `limit` per account
      // ($documentNumber needs a single sort field on 6.0, the order here has two)
      const docs = await t.securityEvents.aggregate<Record<string, unknown>>([
        { $match: { account_id: { $in: [...ids] }, ...(since ? { at: { $gte: since } } : {}) } },
        { $group: { _id: '$account_id', top: { $topN: { n: limit, sortBy: { at: -1, _id: -1 }, output: '$$ROOT' } } } },
        { $unwind: '$top' },
        { $replaceRoot: { newRoot: '$top' } },
        { $sort: { at: -1, _id: -1 } },
      ]);
      return group(
        docs.map((d) => t.securityEvents.fromDoc(d)),
        (r) => r.account_id,
      );
    },

    /* ---------------------------------------------------------------- sign-in attempts */
    async insertSignInAttempt(row) {
      await t.signInAttempts.insert(row);
    },
    async failedAttemptsSince(email, since) {
      return (await t.signInAttempts.find({ email_normalized: email, succeeded: false, at: { $gte: since } }, { sort: { at: 1 } })).map((r) => r.at);
    },

    /* ---------------------------------------------------------------- re-auth tokens */
    async insertReauthToken(row) {
      await t.reauth.insert(row);
    },
    getReauthToken: (hash) => t.reauth.get(hash),
    async markReauthUsed(hash, at) {
      // claims the token only if unused: one conditional update, so two concurrent uses cannot both succeed
      return (await t.reauth.updateMany({ token_hash: hash, used_at: null }, { used_at: at })) > 0;
    },
    async clearReauthUsed(hash) {
      await t.reauth.update(hash, { used_at: null });
    },

    /* ---------------------------------------------------------------- revocation feed */
    async revokedSessionsSince(since) {
      return (await t.sessions.find({ revoked_at: { $gt: since } })).map((r) => ({ id: r.id, at: r.revoked_at! }));
    },
    async claimedGuestSessionsSince(since) {
      return (await t.guestSessions.find({ claimed_at: { $gt: since } })).map((r) => ({ id: r.id, at: r.claimed_at! }));
    },
    async accountRevocationsSince(since) {
      return (await t.accounts.find({ tokens_valid_after: { $gt: since } })).map((r) => ({ id: r.id, at: r.tokens_valid_after! }));
    },

    /* ---------------------------------------------------------------- jobs */
    async deleteExpiredChallenges(now, limit) {
      const ids = await batch(t.challenges, { expires_at: { $lt: now } }, limit, 'id');
      return ids.length ? t.challenges.deleteMany({ id: { $in: ids } }) : 0;
    },
    async deleteExpiredResets(now, limit) {
      const ids = await batch(t.resets, { expires_at: { $lt: now } }, limit, 'id');
      return ids.length ? t.resets.deleteMany({ id: { $in: ids } }) : 0;
    },
    async deleteExpiredReauthTokens(now, limit) {
      const hashes = await batch(t.reauth, { expires_at: { $lt: now } }, limit, 'token_hash');
      return hashes.length ? t.reauth.deleteMany({ token_hash: { $in: hashes } }) : 0;
    },
    async deleteExpiredOrderLinks(now, limit) {
      const ids = await batch(t.orderLinks, { expires_at: { $lt: now } }, limit, 'id');
      return ids.length ? t.orderLinks.deleteMany({ id: { $in: ids } }) : 0;
    },
    async deleteExpiredGrants(now, limit) {
      const keys = await t.grants.find({ expires_at: { $lt: now } }, { limit });
      if (!keys.length) return 0;
      return t.grants.deleteMany({ $or: keys.map((k) => ({ guest_session_id: k.guest_session_id, order_id: k.order_id })) });
    },
    async deleteExpiredGuestSessions(now, limit) {
      // past their TTL and no longer carrying a live order grant (not exists: two reads)
      const withLiveGrant = await t.grants.distinct<string>('guest_session_id', { expires_at: { $gte: now } });
      const doomed = await batch(t.guestSessions, { expires_at: { $lt: now }, ...(withLiveGrant.length ? { id: { $nin: withLiveGrant } } : {}) }, limit, 'id');
      if (!doomed.length) return 0;
      await t.grants.deleteMany({ guest_session_id: { $in: doomed } });
      return t.guestSessions.deleteMany({ id: { $in: doomed } });
    },
    async expirePendingInvitations(now, limit) {
      const ids = await batch(t.invitations, { status: 'pending', expires_at: { $lt: now } }, limit, 'id');
      return ids.length ? t.invitations.updateMany({ id: { $in: ids } }, { status: 'expired' }) : 0;
    },
    async expireSessions(now, staffIdleBefore, limit) {
      const ids = await batch(
        t.sessions,
        { revoked_at: null, $or: [{ expires_at: { $lte: now } }, { absolute_expires_at: { $lte: now } }, { audience: 'admin', last_active_at: { $lt: staffIdleBefore } }] },
        limit,
        'id',
      );
      if (!ids.length) return 0;
      // revoked when it ran out: least(expires_at, absolute_expires_at, now)
      return t.sessions.updateMany({ id: { $in: ids } }, [{ $set: { revoked_at: { $min: ['$expires_at', '$absolute_expires_at', now] }, revoke_reason: 'expired' } }]);
    },
    async pruneRevokedSessions(before, limit) {
      const doomed = await batch(t.sessions, { revoked_at: { $lt: before } }, limit, 'id');
      if (!doomed.length) return 0;
      await t.reauth.deleteMany({ session_id: { $in: doomed } });
      return t.sessions.deleteMany({ id: { $in: doomed } });
    },
    async deleteSecurityEventsBefore(before, limit) {
      const ids = await batch(t.securityEvents, { at: { $lt: before } }, limit, 'id');
      return ids.length ? t.securityEvents.deleteMany({ id: { $in: ids } }) : 0;
    },
    async deleteSignInAttemptsBefore(before, limit) {
      const ids = await batch(t.signInAttempts, { at: { $lt: before } }, limit, 'id');
      return ids.length ? t.signInAttempts.deleteMany({ id: { $in: ids } }) : 0;
    },
  };
  return repo;
}
