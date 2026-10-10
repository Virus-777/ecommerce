import { sql, type ExpressionBuilder, type Kysely } from 'kysely';
import type { Inbox } from '../../../../kernel/events/inbox.js';
import { paginate } from '../../../../kernel/lib/pagination.js';
import type { CustomersDb } from '../../../../spec/customers.js';
import type { CustomerRow, CustomersRepository, CustomerStanding, ViewOwner } from '../../ports.js';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const count = (r: { numDeletedRows?: bigint; numUpdatedRows?: bigint } | undefined) => Number(r?.numDeletedRows ?? r?.numUpdatedRows ?? 0);

type StandingRow = CustomerRow & { order_block: boolean; message_block: boolean; message_until: Date | null };

/** Postgres adapter for CustomersRepository. `db` is scoped to the `customers` schema. */
export function createPostgresCustomersRepository(db: Kysely<CustomersDb>, inbox: Inbox): CustomersRepository {
  /** Customer row plus its active blocks, in one statement (the kernel resolves customers on every own-customer request) */
  const standingQuery = (now: Date) => {
    const active = (eb: ExpressionBuilder<CustomersDb & { c: CustomersDb['customers'] }, 'c'>, scopes: string[]) =>
      eb
        .selectFrom('account_restrictions as r')
        .whereRef('r.customer_id', '=', 'c.id')
        .where('r.state', '=', 'active')
        .where('r.scope', 'in', scopes)
        .where((w) => w.or([w('r.ends_at', 'is', null), w('r.ends_at', '>', now)]));
    return db
      .selectFrom('customers as c')
      .selectAll('c')
      .select((eb) => [
        eb.exists(active(eb, ['ordering', 'account']).select('r.id')).as('order_block'),
        eb.exists(active(eb, ['messaging', 'account']).select('r.id')).as('message_block'),
        active(eb, ['messaging', 'account'])
          .select(sql<Date | null>`case when bool_or(r.ends_at is null) then null else max(r.ends_at) end`.as('u'))
          .as('message_until'),
      ]);
  };
  const toStanding = (r: StandingRow | undefined): CustomerStanding | undefined => {
    if (!r) return undefined;
    const { order_block, message_block, message_until, ...row } = r;
    return { row: row as CustomerRow, orderBlock: Boolean(order_block), messageBlock: Boolean(message_block), messageBlockUntil: message_until ? new Date(message_until) : null };
  };
  const owned = (owner: ViewOwner) => db.selectFrom('recently_viewed').where('owner_kind', '=', owner.kind).where('owner_id', '=', owner.id);

  const repo: CustomersRepository = {
    async transaction(fn) {
      if (db.isTransaction) return fn(repo);
      return db.transaction().execute((trx) => fn(createPostgresCustomersRepository(trx, inbox)));
    },
    claim(key) {
      return inbox.claim(db, key);
    },

    /* ---------------------------------------------------------------- customers */
    async getCustomer(id, o) {
      let q = db.selectFrom('customers').selectAll().where('id', '=', id);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async getCustomerByUserId(userId, o) {
      let q = db.selectFrom('customers').selectAll().where('user_id', '=', userId);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async getCustomers(ids) {
      if (!ids.length) return [];
      return db.selectFrom('customers').selectAll().where('id', 'in', [...new Set(ids)]).execute();
    },
    async findCustomerByEmail(email) {
      return db.selectFrom('customers').selectAll().where('email', '=', email).where('account_status', '!=', 'closed').orderBy('created_at').executeTakeFirst();
    },
    async standingById(id, now) {
      return toStanding((await standingQuery(now).where('c.id', '=', id).executeTakeFirst()) as StandingRow | undefined);
    },
    async standingByUserId(userId, now) {
      return toStanding((await standingQuery(now).where('c.user_id', '=', userId).executeTakeFirst()) as StandingRow | undefined);
    },
    async standings(ids, now) {
      if (!ids.length) return [];
      const rows = (await standingQuery(now).where('c.id', 'in', [...new Set(ids)]).execute()) as StandingRow[];
      return rows.map((r) => toStanding(r)!);
    },
    async insertCustomer(row) {
      const r = await db.insertInto('customers').values(row).onConflict((oc) => oc.column('user_id').doNothing()).executeTakeFirst();
      return Number(r.numInsertedOrUpdatedRows ?? 0) > 0;
    },
    async updateCustomer(id, patch) {
      return db.updateTable('customers').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async searchCustomers(f, page) {
      let q = db.selectFrom('customers').selectAll();
      const term = f.q?.trim();
      if (term) {
        const t = like(term.toLowerCase());
        const digits = term.replace(/[^\d]/g, '');
        q = q.where((eb) =>
          eb.or([
            eb(sql`lower(first_name || ' ' || last_name)`, 'like', t),
            eb('email', 'like', t),
            eb(sql`lower(ref)`, '=', term.toLowerCase()),
            ...(digits.length >= 4 ? [eb(sql`regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')`, 'like', `%${digits}%`)] : []),
            ...(f.extraIds?.length ? [eb('id', 'in', f.extraIds)] : []),
          ]),
        );
      }
      if (f.onlyIds) q = f.onlyIds.length ? q.where('id', 'in', f.onlyIds) : q.where(sql<boolean>`false`);
      if (f.excludeIds?.length) q = q.where('id', 'not in', f.excludeIds);
      if (f.statuses?.length) q = q.where('account_status', 'in', f.statuses);
      if (f.verification === 'not_verified') q = q.where('email_verified_at', 'is', null);
      if (f.verification === 'email_only') q = q.where('email_verified_at', 'is not', null).where('phone_verified_at', 'is', null);
      if (f.verification === 'email_and_phone') q = q.where('email_verified_at', 'is not', null).where('phone_verified_at', 'is not', null);
      if (f.joinedFrom) q = q.where('created_at', '>=', f.joinedFrom);
      if (f.joinedTo) q = q.where('created_at', '<', f.joinedTo);
      switch (f.sort) {
        case 'spend':
          return paginate(q, page, { column: 'total_spend_minor', direction: 'desc' });
        case 'orders':
          return paginate(q, page, { column: 'order_count', direction: 'desc' });
        case 'name':
          return paginate(q, page, { column: 'last_name', direction: 'asc' });
        default:
          return paginate(q, page, { column: 'created_at', direction: 'desc' });
      }
    },

    /* ---------------------------------------------------------------- addresses */
    async listAddresses(customerId) {
      return db
        .selectFrom('addresses')
        .selectAll()
        .where('customer_id', '=', customerId)
        .where('deleted_at', 'is', null)
        .orderBy('is_default', 'desc')
        .orderBy(sql`last_used_at desc nulls last`)
        .orderBy('created_at', 'desc')
        .execute();
    },
    async getAddress(customerId, id, o) {
      let q = db.selectFrom('addresses').selectAll().where('id', '=', id).where('customer_id', '=', customerId).where('deleted_at', 'is', null);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async countAddresses(customerId) {
      const r = await db.selectFrom('addresses').select(sql<number>`count(*)::int`.as('n')).where('customer_id', '=', customerId).where('deleted_at', 'is', null).executeTakeFirst();
      return r?.n ?? 0;
    },
    async insertAddress(row) {
      return db.insertInto('addresses').values(row).returningAll().executeTakeFirstOrThrow();
    },
    async updateAddress(id, patch) {
      return db.updateTable('addresses').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async clearDefaultAddress(customerId, now) {
      await db.updateTable('addresses').set({ is_default: false, updated_at: now }).where('customer_id', '=', customerId).where('is_default', '=', true).execute();
    },
    async defaultAddresses(customerIds) {
      if (!customerIds.length) return [];
      return db.selectFrom('addresses').selectAll().where('customer_id', 'in', [...new Set(customerIds)]).where('is_default', '=', true).where('deleted_at', 'is', null).execute();
    },
    async anonymiseAddresses(customerId, now) {
      await db
        .updateTable('addresses')
        .set({ label: null, name: 'Removed', line1: 'Removed', line2: null, city: 'Removed', postal_code: '00000', phone: null, delivery_instructions: null, is_default: false, deleted_at: now, updated_at: now })
        .where('customer_id', '=', customerId)
        .execute();
    },

    /* ---------------------------------------------------------------- marketing consent */
    async getPreferences(customerId) {
      return db.selectFrom('marketing_preferences').selectAll().where('customer_id', '=', customerId).executeTakeFirst();
    },
    async upsertPreferences(row) {
      const { customer_id, ...rest } = row;
      return db
        .insertInto('marketing_preferences')
        .values(row)
        .onConflict((oc) => oc.column('customer_id').doUpdateSet(rest))
        .returningAll()
        .executeTakeFirstOrThrow();
    },
    async insertConsent(rows) {
      if (rows.length) await db.insertInto('consent_log').values(rows).execute();
    },
    async consentLog(customerId) {
      return db.selectFrom('consent_log').selectAll().where('customer_id', '=', customerId).orderBy('at', 'desc').orderBy('id', 'desc').execute();
    },

    /* ---------------------------------------------------------------- recently viewed */
    async upsertView(row) {
      await db
        .insertInto('recently_viewed')
        .values(row)
        .onConflict((oc) =>
          oc.columns(['owner_kind', 'owner_id', 'product_id']).doUpdateSet((eb) => ({
            viewed_at: sql`greatest(recently_viewed.viewed_at, ${eb.ref('excluded.viewed_at')})`,
            variant_id: sql`case when ${eb.ref('excluded.viewed_at')} >= recently_viewed.viewed_at then ${eb.ref('excluded.variant_id')} else recently_viewed.variant_id end`,
            title: sql`case when ${eb.ref('excluded.viewed_at')} >= recently_viewed.viewed_at then ${eb.ref('excluded.title')} else recently_viewed.title end`,
            image_media_id: sql`case when ${eb.ref('excluded.viewed_at')} >= recently_viewed.viewed_at then ${eb.ref('excluded.image_media_id')} else recently_viewed.image_media_id end`,
          })),
        )
        .execute();
    },
    async listViews(owner, limit) {
      return owned(owner).selectAll().orderBy('viewed_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
    },
    async trimViews(owner, keep) {
      const keepIds = owned(owner).select('id').orderBy('viewed_at', 'desc').orderBy('id', 'desc').limit(keep);
      const r = await db
        .deleteFrom('recently_viewed')
        .where('owner_kind', '=', owner.kind)
        .where('owner_id', '=', owner.id)
        .where('id', 'not in', keepIds)
        .executeTakeFirst();
      return count(r);
    },
    async deleteViews(owner, productId) {
      let q = db.deleteFrom('recently_viewed').where('owner_kind', '=', owner.kind).where('owner_id', '=', owner.id);
      if (productId) q = q.where('product_id', '=', productId);
      return count(await q.executeTakeFirst());
    },
    async repointProduct(from, to, variantId) {
      let moved = 0;
      for (;;) {
        const dups = await db.selectFrom('recently_viewed').selectAll().where('product_id', '=', from).limit(500).execute();
        if (!dups.length) return moved;
        const owners = [...new Set(dups.map((d) => d.owner_id))];
        const kept = await db.selectFrom('recently_viewed').selectAll().where('product_id', '=', to).where('owner_id', 'in', owners).execute();
        const keptBy = new Map(kept.map((k) => [`${k.owner_kind}:${k.owner_id}`, k]));
        for (const d of dups) {
          const k = keptBy.get(`${d.owner_kind}:${d.owner_id}`);
          if (k) {
            // the owner viewed both: one row stays, with the newest view
            if (d.viewed_at > k.viewed_at) await db.updateTable('recently_viewed').set({ viewed_at: d.viewed_at }).where('id', '=', k.id).execute();
            await db.deleteFrom('recently_viewed').where('id', '=', d.id).execute();
          } else {
            await db.updateTable('recently_viewed').set({ product_id: to, variant_id: variantId }).where('id', '=', d.id).execute();
          }
          moved++;
        }
      }
    },
    async pruneViews(before, guestBefore) {
      const r = await db
        .deleteFrom('recently_viewed')
        .where((eb) => eb.or([eb('viewed_at', '<', before), eb.and([eb('owner_kind', '=', 'guest'), eb('viewed_at', '<', guestBefore)])]))
        .executeTakeFirst();
      return count(r);
    },

    /* ---------------------------------------------------------------- restrictions */
    async listRestrictions(customerId, o) {
      let q = db.selectFrom('account_restrictions').selectAll().where('customer_id', '=', customerId);
      if (o?.activeAt) {
        const now = o.activeAt;
        q = q.where('state', '=', 'active').where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', now)]));
      }
      return q.orderBy('starts_at', 'desc').orderBy('id', 'desc').execute();
    },
    async getRestriction(customerId, id, o) {
      let q = db.selectFrom('account_restrictions').selectAll().where('id', '=', id).where('customer_id', '=', customerId);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async findRestrictionByEnforcement(customerId, enforcementId) {
      return db.selectFrom('account_restrictions').selectAll().where('customer_id', '=', customerId).where('trust_enforcement_id', '=', enforcementId).executeTakeFirst();
    },
    async activeRestrictionsByEnforcement(enforcementId) {
      return db.selectFrom('account_restrictions').selectAll().where('trust_enforcement_id', '=', enforcementId).where('state', '=', 'active').execute();
    },
    async insertRestriction(row) {
      return db
        .insertInto('account_restrictions')
        .values({ ...row, still_works: JSON.stringify(row.still_works) as never })
        .returningAll()
        .executeTakeFirstOrThrow();
    },
    async updateRestriction(id, patch) {
      const p = 'still_works' in patch ? { ...patch, still_works: JSON.stringify(patch.still_works) as never } : patch;
      return db.updateTable('account_restrictions').set(p).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async dueRestrictions(now, limit) {
      return db
        .selectFrom('account_restrictions')
        .selectAll()
        .where('state', '=', 'active')
        .where('ends_at', 'is not', null)
        .where('ends_at', '<=', now)
        .orderBy('ends_at')
        .limit(limit)
        .execute();
    },
    async countActiveRestrictions(customerId, now) {
      const r = await db
        .selectFrom('account_restrictions')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('customer_id', '=', customerId)
        .where('state', '=', 'active')
        .where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', now)]))
        .executeTakeFirst();
      return r?.n ?? 0;
    },

    /* ---------------------------------------------------------------- actions and notes */
    async insertAction(row) {
      return db.insertInto('account_actions').values(row).returningAll().executeTakeFirstOrThrow();
    },
    async listActions(customerId, page) {
      return paginate(db.selectFrom('account_actions').selectAll().where('customer_id', '=', customerId), page, { column: 'at', direction: 'desc' });
    },
    async recentActions(customerId, limit) {
      return db.selectFrom('account_actions').selectAll().where('customer_id', '=', customerId).orderBy('at', 'desc').orderBy('id', 'desc').limit(limit).execute();
    },
    async insertNote(row) {
      return db.insertInto('customer_notes').values(row).returningAll().executeTakeFirstOrThrow();
    },
    async listNotes(customerId) {
      return db.selectFrom('customer_notes').selectAll().where('customer_id', '=', customerId).orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
    },

    /* ---------------------------------------------------------------- guest buyers */
    async getGuestBuyer(emailNormalized, o) {
      let q = db.selectFrom('guest_buyers').selectAll().where('email_normalized', '=', emailNormalized);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async insertGuestBuyer(row) {
      await db.insertInto('guest_buyers').values(row).execute();
    },
    async updateGuestBuyer(id, patch) {
      await db.updateTable('guest_buyers').set(patch).where('id', '=', id).execute();
    },
    async deleteGuestBuyer(emailNormalized) {
      return count(await db.deleteFrom('guest_buyers').where('email_normalized', '=', emailNormalized).executeTakeFirst());
    },
    async listGuestBuyers(f, page) {
      let q = db.selectFrom('guest_buyers').selectAll();
      const term = f.q?.trim();
      if (term) {
        const t = like(term.toLowerCase());
        q = q.where((eb) => eb.or([eb('email_normalized', 'like', t), eb(sql`lower(name)`, 'like', t), eb(sql`lower(last_order_ref)`, '=', term.toLowerCase())]));
      }
      if (f.orderedFrom) q = q.where('last_order_at', '>=', f.orderedFrom);
      if (f.orderedTo) q = q.where('last_order_at', '<', f.orderedTo);
      return paginate(q, page, { column: 'last_order_at', direction: 'desc' });
    },

    /* ---------------------------------------------------------------- data requests */
    async insertDataRequest(row) {
      return db.insertInto('data_requests').values(row).returningAll().executeTakeFirstOrThrow();
    },
    async getDataRequest(id, o) {
      let q = db.selectFrom('data_requests').selectAll().where('id', '=', id);
      if (o?.customerId) q = q.where('customer_id', '=', o.customerId);
      if (o?.forUpdate) q = q.forUpdate();
      return q.executeTakeFirst();
    },
    async updateDataRequest(id, patch) {
      return db.updateTable('data_requests').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    },
    async listDataRequests(customerId) {
      return db.selectFrom('data_requests').selectAll().where('customer_id', '=', customerId).orderBy('requested_at', 'desc').orderBy('id', 'desc').execute();
    },
    async openDataRequest(customerId, kind) {
      const states = kind === 'export' ? ['requested', 'processing', 'failed'] : ['requested'];
      return db.selectFrom('data_requests').selectAll().where('customer_id', '=', customerId).where('kind', '=', kind).where('state', 'in', states).executeTakeFirst();
    },
    async countExportsSince(customerId, since) {
      const r = await db
        .selectFrom('data_requests')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('customer_id', '=', customerId)
        .where('kind', '=', 'export')
        .where('state', '!=', 'cancelled')
        .where('requested_at', '>=', since)
        .executeTakeFirst();
      return r?.n ?? 0;
    },
    async exportsToBuild(limit) {
      return db
        .selectFrom('data_requests')
        .selectAll()
        .where('kind', '=', 'export')
        .where('state', 'in', ['requested', 'processing'])
        .orderBy('requested_at')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
    },
    async readyExportsExpiring(now, limit) {
      return db.selectFrom('data_requests').selectAll().where('kind', '=', 'export').where('state', '=', 'ready').where('expires_at', '<=', now).orderBy('expires_at').limit(limit).execute();
    },
    async closuresDue(now, limit) {
      return db.selectFrom('data_requests').selectAll().where('kind', '=', 'closure').where('state', '=', 'requested').where('scheduled_for', '<=', now).orderBy('scheduled_for').limit(limit).execute();
    },
    async searchDataRequests(f, page) {
      let q = db
        .selectFrom('data_requests as dr')
        .innerJoin('customers as c', 'c.id', 'dr.customer_id')
        .selectAll('dr')
        .select(['c.first_name as customer_first_name', 'c.last_name as customer_last_name']);
      if (f.kind) q = q.where('dr.kind', '=', f.kind);
      if (f.state) q = q.where('dr.state', '=', f.state);
      if (f.overdueAt) q = q.where('dr.due_by', '<', f.overdueAt).where('dr.state', 'in', ['requested', 'processing', 'failed']);
      return paginate(q, page, { column: 'dr.due_by', direction: 'asc', id: 'dr.id' });
    },

    /* ---------------------------------------------------------------- guest order lookups */
    async insertLookupAttempt(row) {
      await db.insertInto('guest_lookup_attempts').values(row).execute();
    },
    async countLookupAttempts(by, since) {
      let q = db.selectFrom('guest_lookup_attempts').select(sql<number>`count(*)::int`.as('n')).where('at', '>=', since);
      if (by.emailHash) q = q.where('email_hash', '=', by.emailHash);
      if (by.ip) q = q.where('ip', '=', by.ip);
      return (await q.executeTakeFirst())?.n ?? 0;
    },
  };
  return repo;
}
