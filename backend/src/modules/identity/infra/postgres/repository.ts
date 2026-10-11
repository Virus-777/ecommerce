import { sql, type Kysely } from 'kysely';
import { paginate } from '../../../../kernel/lib/pagination.js';
import type { IdentityDb } from '../../../../spec/identity.js';
import type { DeviceWithSessions, IdentityRepository, SecurityEventRow, SellerAccessRow, InvitationRow } from '../../ports.js';

/** Postgres adapter for IdentityRepository. `db` is scoped to the `identity` schema. */
export function createPostgresIdentityRepository(db: Kysely<IdentityDb>): IdentityRepository {
  const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const live = (now: Date) => (eb: any) => eb.and([eb('revoked_at', 'is', null), eb('expires_at', '>', now), eb('absolute_expires_at', '>', now)]);
  const group = <R, K extends string>(rows: R[], key: (r: R) => K) => {
    const m = new Map<K, R[]>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return m;
  };
  const count = (r: { numDeletedRows?: bigint; numUpdatedRows?: bigint } | undefined) => Number(r?.numDeletedRows ?? r?.numUpdatedRows ?? 0);

  const repo: IdentityRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresIdentityRepository(trx)));
    },

    /* ---------------------------------------------------------------- accounts */
    async getAccount(id, o) {
      let q = db.selectFrom('accounts').selectAll().where('id', '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async getAccounts(ids) {
      if (!ids.length) return [];
      return db.selectFrom('accounts').selectAll().where('id', 'in', [...ids]).execute();
    },
    async findAccount(realm, email, o) {
      let q = db.selectFrom('accounts').selectAll().where('realm', '=', realm).where('email_normalized', '=', email);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async findAccountsByEmail(email) {
      return db.selectFrom('accounts').selectAll().where('email_normalized', '=', email).execute();
    },
    async insertAccount(row) {
      await db.insertInto('accounts').values(row).execute();
    },
    async updateAccount(id, patch) {
      return db
        .updateTable('accounts')
        .set({ ...patch, version: sql`version + 1` } as never)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    },
    async listAccounts(f, page) {
      let q = db.selectFrom('accounts').selectAll('accounts').where('realm', '=', f.realm);
      if (f.status) q = q.where('status', '=', f.status);
      if (f.q?.trim()) {
        const term = like(f.q.trim().toLowerCase());
        q = q.where((eb) => eb.or([eb('email_normalized', 'like', term), eb(sql`lower(display_name)`, 'like', term)]));
      }
      if (f.twoStepEnabled !== undefined && f.twoStepEnabled !== null) {
        const has = (eb: any) =>
          eb.exists(eb.selectFrom('two_step_methods as m').select('m.id').whereRef('m.account_id', '=', 'accounts.id').where('m.removed_at', 'is', null).where('m.confirmed_at', 'is not', null));
        q = q.where((eb) => (f.twoStepEnabled ? has(eb) : eb.not(has(eb))));
      }
      return paginate(q, page, { column: 'created_at', direction: 'desc' });
    },
    async deleteUnverifiedAccounts(before, limit) {
      const ids = (
        await db
          .selectFrom('accounts')
          .select('id')
          .where('realm', '=', 'member')
          .where('status', '=', 'pending_verification')
          .where('email_verified_at', 'is', null)
          .where('created_at', '<', before)
          .limit(limit)
          .execute()
      ).map((r) => r.id);
      if (!ids.length) return 0;
      await db.deleteFrom('reauth_tokens').where('account_id', 'in', ids).execute();
      await db.deleteFrom('sessions').where('account_id', 'in', ids).execute();
      for (const t of ['password_history', 'two_step_methods', 'recovery_codes', 'challenges', 'password_resets', 'devices', 'seller_access', 'security_events'] as const) {
        await db.deleteFrom(t).where('account_id', 'in', ids).execute();
      }
      await db.updateTable('invitations').set({ account_id: null }).where('account_id', 'in', ids).execute();
      return count(await db.deleteFrom('accounts').where('id', 'in', ids).executeTakeFirst());
    },

    /* ---------------------------------------------------------------- passwords */
    async addPasswordHistory(row) {
      await db.insertInto('password_history').values(row).execute();
    },
    async recentPasswordHashes(accountId, limit) {
      const rows = await db.selectFrom('password_history').select('password_hash').where('account_id', '=', accountId).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
      return rows.map((r) => r.password_hash);
    },

    /* ---------------------------------------------------------------- 2-step */
    async activeMethods(ids) {
      if (!ids.length) return [];
      return db
        .selectFrom('two_step_methods')
        .selectAll()
        .where('account_id', 'in', [...ids])
        .where('removed_at', 'is', null)
        .where('confirmed_at', 'is not', null)
        .orderBy('confirmed_at', 'asc')
        .execute();
    },
    async insertMethod(row) {
      await db.insertInto('two_step_methods').values({ ...row, secret_encrypted: row.secret_encrypted && Buffer.from(row.secret_encrypted), phone_e164_encrypted: row.phone_e164_encrypted && Buffer.from(row.phone_e164_encrypted) }).execute();
    },
    async updateMethod(id, patch) {
      await db.updateTable('two_step_methods').set(patch).where('id', '=', id).execute();
    },
    async removeAllMethods(accountId, at) {
      return count(await db.updateTable('two_step_methods').set({ removed_at: at }).where('account_id', '=', accountId).where('removed_at', 'is', null).executeTakeFirst());
    },
    async replaceRecoveryCodes(accountId, rows) {
      await db.deleteFrom('recovery_codes').where('account_id', '=', accountId).execute();
      if (rows.length) await db.insertInto('recovery_codes').values(rows).execute();
    },
    async useRecoveryCode(accountId, codeHash, at) {
      const r = await db
        .updateTable('recovery_codes')
        .set({ used_at: at })
        .where('account_id', '=', accountId)
        .where('code_hash', '=', codeHash)
        .where('used_at', 'is', null)
        .executeTakeFirst();
      return count(r) > 0;
    },
    async remainingRecoveryCodes(ids) {
      const out = new Map<string, number>();
      if (!ids.length) return out;
      const rows = await db
        .selectFrom('recovery_codes')
        .select(['account_id', (eb) => eb.fn.countAll<number>().as('n')])
        .where('account_id', 'in', [...ids])
        .where('used_at', 'is', null)
        .groupBy('account_id')
        .execute();
      for (const r of rows) out.set(r.account_id, Number(r.n));
      return out;
    },
    async deleteRecoveryCodes(accountId) {
      await db.deleteFrom('recovery_codes').where('account_id', '=', accountId).execute();
    },

    /* ---------------------------------------------------------------- challenges */
    async insertChallenge(row) {
      await db.insertInto('challenges').values({ ...row, payload: JSON.stringify(row.payload ?? {}) as never, target_phone_encrypted: row.target_phone_encrypted && Buffer.from(row.target_phone_encrypted) }).execute();
    },
    async getChallenge(id, o) {
      let q = db.selectFrom('challenges').selectAll().where('id', '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async updateChallenge(id, patch) {
      const p = 'payload' in patch ? { ...patch, payload: JSON.stringify(patch.payload ?? {}) as never } : patch;
      return db.updateTable('challenges').set(p).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async supersedeChallenges(accountId, purpose, exceptId) {
      let q = db.updateTable('challenges').set({ status: 'expired' }).where('account_id', '=', accountId).where('purpose', '=', purpose).where('status', '=', 'pending');
      if (exceptId) q = q.where('id', '!=', exceptId);
      await q.execute();
    },
    async pendingEmailChanges(ids, now) {
      const out = new Map<string, string>();
      if (!ids.length) return out;
      const rows = await db
        .selectFrom('challenges')
        .select(['account_id', 'target_email'])
        .where('account_id', 'in', [...ids])
        .where('purpose', '=', 'email_change')
        .where('status', '=', 'pending')
        .where('expires_at', '>', now)
        .orderBy('created_at', 'asc')
        .execute();
      for (const r of rows) if (r.account_id && r.target_email) out.set(r.account_id, r.target_email);
      return out;
    },

    /* ---------------------------------------------------------------- password resets */
    async insertReset(row) {
      await db.insertInto('password_resets').values(row).execute();
    },
    async findResetByHash(hash, o) {
      let q = db.selectFrom('password_resets').selectAll().where('token_hash', '=', hash);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async updateReset(id, patch) {
      await db.updateTable('password_resets').set(patch).where('id', '=', id).execute();
    },
    async invalidateResets(accountId, at) {
      await db.updateTable('password_resets').set({ expires_at: at }).where('account_id', '=', accountId).where('used_at', 'is', null).where('expires_at', '>', at).execute();
    },
    async latestReset(accountId) {
      return db.selectFrom('password_resets').selectAll().where('account_id', '=', accountId).orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    },

    /* ---------------------------------------------------------------- devices */
    async findDeviceByInstallation(accountId, installationId) {
      return db.selectFrom('devices').selectAll().where('account_id', '=', accountId).where('installation_id', '=', installationId).executeTakeFirst();
    },
    async findWebDevice(accountId, userAgent) {
      return db
        .selectFrom('devices')
        .selectAll()
        .where('account_id', '=', accountId)
        .where('kind', '=', 'web')
        .where('installation_id', 'is', null)
        .where(userAgent === null ? sql<boolean>`user_agent is null` : sql<boolean>`user_agent = ${userAgent}`)
        .orderBy('last_active_at', 'desc')
        .limit(1)
        .executeTakeFirst();
    },
    async countDevices(accountId) {
      const r = await db.selectFrom('devices').select((eb) => eb.fn.countAll<number>().as('n')).where('account_id', '=', accountId).executeTakeFirst();
      return Number(r?.n ?? 0);
    },
    async insertDevice(row) {
      await db.insertInto('devices').values(row).execute();
    },
    async updateDevice(id, patch) {
      await db.updateTable('devices').set(patch).where('id', '=', id).execute();
    },
    async getDevice(id) {
      return db.selectFrom('devices').selectAll().where('id', '=', id).executeTakeFirst();
    },
    async devicesOf(ids, now) {
      const out = new Map<string, DeviceWithSessions[]>();
      if (!ids.length) return out;
      const rows = await db
        .selectFrom('devices as d')
        .innerJoin('sessions as s', 's.device_id', 'd.id')
        .selectAll('d')
        .select([sql<string[]>`json_agg(distinct s.audience)`.as('audiences'), sql<string[]>`json_agg(s.id)`.as('session_ids')])
        .where('d.account_id', 'in', [...ids])
        .where('s.revoked_at', 'is', null)
        .where('s.expires_at', '>', now)
        .where('s.absolute_expires_at', '>', now)
        .groupBy('d.id')
        .orderBy('d.last_active_at', 'desc')
        .execute();
      for (const r of rows) {
        const { audiences, session_ids, ...device } = r as typeof r & { audiences: unknown; session_ids: unknown };
        const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as string[];
        const d: DeviceWithSessions = { ...device, audiences: parse(audiences).sort() as DeviceWithSessions['audiences'], sessionIds: parse(session_ids) };
        out.set(d.account_id, [...(out.get(d.account_id) ?? []), d]);
      }
      return out;
    },
    async clearDeviceTrust(accountId) {
      await db.updateTable('devices').set({ two_step_trusted_until: null }).where('account_id', '=', accountId).execute();
    },

    /* ---------------------------------------------------------------- sessions */
    async insertSession(row) {
      await db.insertInto('sessions').values(row).execute();
    },
    async getSession(id, o) {
      let q = db.selectFrom('sessions').selectAll().where('id', '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async findSessionByRefreshHash(hash, o) {
      let q = db
        .selectFrom('sessions')
        .selectAll()
        .where((eb) => eb.or([eb('refresh_token_hash', '=', hash), eb('previous_token_hash', '=', hash)]));
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async updateSession(id, patch) {
      await db.updateTable('sessions').set(patch).where('id', '=', id).execute();
    },
    async liveSessions(accountId, now, audience) {
      let q = db.selectFrom('sessions').selectAll().where('account_id', '=', accountId).where(live(now));
      if (audience) q = q.where('audience', '=', audience);
      return q.orderBy('last_refreshed_at', 'asc').orderBy('id', 'asc').execute();
    },
    async revokeSessions(sel, reason, at) {
      let q = db.updateTable('sessions').set({ revoked_at: at, revoke_reason: reason }).where('account_id', '=', sel.accountId).where(live(at));
      if (sel.audience) q = q.where('audience', '=', sel.audience);
      if (sel.deviceId) q = q.where('device_id', '=', sel.deviceId);
      if (sel.sellerId) q = q.where('seller_id', '=', sel.sellerId);
      if (sel.exceptSessionId) q = q.where('id', '!=', sel.exceptSessionId);
      if (sel.sessionIds) {
        if (!sel.sessionIds.length) return [];
        q = q.where('id', 'in', sel.sessionIds);
      }
      return (await q.returning('id').execute()).map((r) => r.id);
    },

    /* ---------------------------------------------------------------- seller access */
    async activeSellerAccess(accountId) {
      return db.selectFrom('seller_access').selectAll().where('account_id', '=', accountId).where('revoked_at', 'is', null).orderBy('seller_name', 'asc').execute();
    },
    async getSellerAccess(accountId, sellerId) {
      return db.selectFrom('seller_access').selectAll().where('account_id', '=', accountId).where('seller_id', '=', sellerId).executeTakeFirst();
    },
    async upsertSellerAccess(row) {
      await db
        .insertInto('seller_access')
        .values(row)
        .onConflict((oc) =>
          oc.columns(['account_id', 'seller_id']).doUpdateSet({
            seller_member_id: row.seller_member_id,
            seller_name: row.seller_name,
            role_label: row.role_label,
            is_owner: row.is_owner,
            granted_at: row.granted_at,
            revoked_at: null,
          }),
        )
        .execute();
    },
    async updateSellerAccess(accountId, sellerId, patch) {
      await db.updateTable('seller_access').set(patch).where('account_id', '=', accountId).where('seller_id', '=', sellerId).execute();
    },
    async sellerCounts(ids) {
      const out = new Map<string, number>();
      if (!ids.length) return out;
      const rows = await db
        .selectFrom('seller_access')
        .select(['account_id', (eb) => eb.fn.countAll<number>().as('n')])
        .where('account_id', 'in', [...ids])
        .where('revoked_at', 'is', null)
        .groupBy('account_id')
        .execute();
      for (const r of rows) out.set(r.account_id, Number(r.n));
      return out;
    },
    async activeSellerAccessOf(ids) {
      if (!ids.length) return new Map<string, SellerAccessRow[]>();
      const rows = await db.selectFrom('seller_access').selectAll().where('account_id', 'in', [...ids]).where('revoked_at', 'is', null).orderBy('seller_name', 'asc').execute();
      return group(rows, (r) => r.account_id);
    },

    /* ---------------------------------------------------------------- invitations */
    async insertInvitation(row) {
      await db.insertInto('invitations').values(row).execute();
    },
    async getInvitation(id, o) {
      let q = db.selectFrom('invitations').selectAll().where('id', '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async findInvitationByHash(hash, o) {
      let q = db.selectFrom('invitations').selectAll().where('token_hash', '=', hash);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async updateInvitation(id, patch) {
      return db.updateTable('invitations').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async listInvitations(f, page) {
      let q = db.selectFrom('invitations').selectAll().where('purpose', '=', f.purpose);
      if (f.status) q = q.where('status', '=', f.status);
      return paginate(q, page, { column: 'sent_at', direction: 'desc' });
    },
    async revokePendingInvitations(sel, reason, at) {
      let q = db.updateTable('invitations').set({ status: 'revoked', revoked_at: at, revoke_reason: reason }).where('email', '=', sel.email).where('purpose', '=', sel.purpose).where('status', '=', 'pending');
      q = sel.contextRef === null ? q.where('context_ref', 'is', null) : q.where('context_ref', '=', sel.contextRef);
      await q.execute();
    },
    async latestInvitations(ids) {
      const out = new Map<string, InvitationRow>();
      if (!ids.length) return out;
      const rows = await db.selectFrom('invitations').selectAll().where('account_id', 'in', [...ids]).orderBy('sent_at', 'asc').execute();
      for (const r of rows) if (r.account_id) out.set(r.account_id, r);
      return out;
    },

    /* ---------------------------------------------------------------- visitor sessions */
    async insertGuestSession(row) {
      await db.insertInto('guest_sessions').values(row).execute();
    },
    async getGuestSession(id, o) {
      let q = db.selectFrom('guest_sessions').selectAll().where('id', '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async findGuestSessionByRefreshHash(hash, o) {
      let q = db
        .selectFrom('guest_sessions')
        .selectAll()
        .where((eb) => eb.or([eb('refresh_token_hash', '=', hash), eb('previous_token_hash', '=', hash)]));
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async updateGuestSession(id, patch) {
      await db.updateTable('guest_sessions').set(patch).where('id', '=', id).execute();
    },
    async upsertGrant(row) {
      await db
        .insertInto('guest_order_grants')
        .values(row)
        .onConflict((oc) => oc.columns(['guest_session_id', 'order_id']).doUpdateSet({ email_normalized: row.email_normalized, via: row.via, granted_at: row.granted_at, expires_at: row.expires_at }))
        .execute();
    },
    async liveGrantOrderIds(guestSessionId, now) {
      const rows = await db.selectFrom('guest_order_grants').select('order_id').where('guest_session_id', '=', guestSessionId).where('expires_at', '>', now).orderBy('granted_at', 'asc').execute();
      return rows.map((r) => r.order_id);
    },
    async hasLiveGrant(guestSessionId, orderId, now) {
      const r = await db
        .selectFrom('guest_order_grants')
        .select('order_id')
        .where('guest_session_id', '=', guestSessionId)
        .where('order_id', '=', orderId)
        .where('expires_at', '>', now)
        .executeTakeFirst();
      return Boolean(r);
    },

    /* ---------------------------------------------------------------- order links */
    async insertOrderLink(row) {
      await db.insertInto('order_links').values(row).execute();
    },
    async findOrderLinkByHash(hash, o) {
      let q = db.selectFrom('order_links').selectAll().where('token_hash', '=', hash);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async updateOrderLink(id, patch) {
      await db.updateTable('order_links').set(patch).where('id', '=', id).execute();
    },

    /* ---------------------------------------------------------------- security activity */
    async insertSecurityEvent(row) {
      await db.insertInto('security_events').values({ ...row, detail: JSON.stringify(row.detail ?? {}) as never }).execute();
    },
    async listSecurityEvents(accountId, f, page) {
      let q = db.selectFrom('security_events').selectAll().where('account_id', '=', accountId);
      if (f.since) q = q.where('at', '>=', f.since);
      if (f.until) q = q.where('at', '<', f.until);
      if (f.result) q = q.where('result', '=', f.result);
      if (f.kind) q = q.where('kind', '=', f.kind);
      return paginate(q, page, { column: 'at', direction: 'desc' });
    },
    async recentSecurityEvents(ids, limit, since) {
      if (!ids.length) return new Map<string, SecurityEventRow[]>();
      const ranked = db
        .selectFrom('security_events')
        .selectAll()
        .select(sql<number>`row_number() over (partition by account_id order by at desc, id desc)`.as('rn'))
        .where('account_id', 'in', [...ids])
        .$if(Boolean(since), (q) => q.where('at', '>=', since!));
      const rows = await db.selectFrom(ranked.as('x')).selectAll().where('rn', '<=', limit).orderBy('at', 'desc').orderBy('id', 'desc').execute();
      return group(
        rows.map(({ rn: _rn, ...r }) => r as SecurityEventRow),
        (r) => r.account_id,
      );
    },

    /* ---------------------------------------------------------------- sign-in attempts */
    async insertSignInAttempt(row) {
      await db.insertInto('sign_in_attempts').values(row).execute();
    },
    async failedAttemptsSince(email, since) {
      const rows = await db.selectFrom('sign_in_attempts').select('at').where('email_normalized', '=', email).where('succeeded', '=', false).where('at', '>=', since).orderBy('at', 'asc').execute();
      return rows.map((r) => r.at);
    },

    /* ---------------------------------------------------------------- re-auth tokens */
    async insertReauthToken(row) {
      await db.insertInto('reauth_tokens').values(row).execute();
    },
    async getReauthToken(hash) {
      return db.selectFrom('reauth_tokens').selectAll().where('token_hash', '=', hash).executeTakeFirst();
    },
    async markReauthUsed(hash, at) {
      const r = await db.updateTable('reauth_tokens').set({ used_at: at }).where('token_hash', '=', hash).where('used_at', 'is', null).executeTakeFirst();
      return r.numUpdatedRows > 0n;
    },
    async clearReauthUsed(hash) {
      await db.updateTable('reauth_tokens').set({ used_at: null }).where('token_hash', '=', hash).execute();
    },

    /* ---------------------------------------------------------------- revocation feed */
    async revokedSessionsSince(since) {
      const rows = await db.selectFrom('sessions').select(['id', 'revoked_at']).where('revoked_at', '>', since).execute();
      return rows.map((r) => ({ id: r.id, at: r.revoked_at! }));
    },
    async claimedGuestSessionsSince(since) {
      const rows = await db.selectFrom('guest_sessions').select(['id', 'claimed_at']).where('claimed_at', '>', since).execute();
      return rows.map((r) => ({ id: r.id, at: r.claimed_at! }));
    },
    async accountRevocationsSince(since) {
      const rows = await db.selectFrom('accounts').select(['id', 'tokens_valid_after']).where('tokens_valid_after', '>', since).execute();
      return rows.map((r) => ({ id: r.id, at: r.tokens_valid_after! }));
    },

    /* ---------------------------------------------------------------- jobs */
    async deleteExpiredChallenges(now, limit) {
      const ids = db.selectFrom('challenges').select('id').where('expires_at', '<', now).limit(limit);
      return count(await db.deleteFrom('challenges').where('id', 'in', ids).executeTakeFirst());
    },
    async deleteExpiredResets(now, limit) {
      const ids = db.selectFrom('password_resets').select('id').where('expires_at', '<', now).limit(limit);
      return count(await db.deleteFrom('password_resets').where('id', 'in', ids).executeTakeFirst());
    },
    async deleteExpiredReauthTokens(now, limit) {
      const ids = db.selectFrom('reauth_tokens').select('token_hash').where('expires_at', '<', now).limit(limit);
      return count(await db.deleteFrom('reauth_tokens').where('token_hash', 'in', ids).executeTakeFirst());
    },
    async deleteExpiredOrderLinks(now, limit) {
      const ids = db.selectFrom('order_links').select('id').where('expires_at', '<', now).limit(limit);
      return count(await db.deleteFrom('order_links').where('id', 'in', ids).executeTakeFirst());
    },
    async deleteExpiredGrants(now, limit) {
      const keys = await db.selectFrom('guest_order_grants').select(['guest_session_id', 'order_id']).where('expires_at', '<', now).limit(limit).execute();
      let n = 0;
      for (const k of keys) {
        n += count(await db.deleteFrom('guest_order_grants').where('guest_session_id', '=', k.guest_session_id).where('order_id', '=', k.order_id).executeTakeFirst());
      }
      return n;
    },
    async deleteExpiredGuestSessions(now, limit) {
      const ids = db
        .selectFrom('guest_sessions as g')
        .select('g.id')
        .where('g.expires_at', '<', now)
        .where((eb) => eb.not(eb.exists(eb.selectFrom('guest_order_grants as o').select('o.order_id').whereRef('o.guest_session_id', '=', 'g.id').where('o.expires_at', '>=', now))))
        .limit(limit);
      const doomed = (await ids.execute()).map((r) => r.id);
      if (!doomed.length) return 0;
      await db.deleteFrom('guest_order_grants').where('guest_session_id', 'in', doomed).execute();
      return count(await db.deleteFrom('guest_sessions').where('id', 'in', doomed).executeTakeFirst());
    },
    async expirePendingInvitations(now, limit) {
      const ids = db.selectFrom('invitations').select('id').where('status', '=', 'pending').where('expires_at', '<', now).limit(limit);
      return count(await db.updateTable('invitations').set({ status: 'expired' }).where('id', 'in', ids).executeTakeFirst());
    },
    async expireSessions(now, staffIdleBefore, limit) {
      const ids = db
        .selectFrom('sessions')
        .select('id')
        .where('revoked_at', 'is', null)
        .where((eb) =>
          eb.or([eb('expires_at', '<=', now), eb('absolute_expires_at', '<=', now), eb.and([eb('audience', '=', 'admin'), eb('last_active_at', '<', staffIdleBefore)])]),
        )
        .limit(limit);
      const r = await db
        .updateTable('sessions')
        .set({ revoked_at: sql`least(expires_at, absolute_expires_at, ${now}::timestamptz)`, revoke_reason: 'expired' } as never)
        .where('id', 'in', ids)
        .executeTakeFirst();
      return count(r);
    },
    async pruneRevokedSessions(before, limit) {
      const doomed = (await db.selectFrom('sessions').select('id').where('revoked_at', '<', before).limit(limit).execute()).map((r) => r.id);
      if (!doomed.length) return 0;
      await db.deleteFrom('reauth_tokens').where('session_id', 'in', doomed).execute();
      return count(await db.deleteFrom('sessions').where('id', 'in', doomed).executeTakeFirst());
    },
    async deleteSecurityEventsBefore(before, limit) {
      const ids = db.selectFrom('security_events').select('id').where('at', '<', before).limit(limit);
      return count(await db.deleteFrom('security_events').where('id', 'in', ids).executeTakeFirst());
    },
    async deleteSignInAttemptsBefore(before, limit) {
      const ids = db.selectFrom('sign_in_attempts').select('id').where('at', '<', before).limit(limit);
      return count(await db.deleteFrom('sign_in_attempts').where('id', 'in', ids).executeTakeFirst());
    },
  };
  return repo;
}
