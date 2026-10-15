/**
 * Customer administration (Admin Center): the customer list and search, the customer detail, notes, the action
 * history, the customers export dataset, and the GraphQL reads of the customer 360.
 */
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import { zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { format as formatMoney } from '../../../kernel/lib/money.js';
import { toPageRequest, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { AdminCustomerDetail, AdminCustomerRow, CustomerNote, CustomerSnapshot } from '../../../spec/customers.js';
import type * as identity from '../../../spec/identity.js';
import type * as reports from '../../../spec/reports.js';
import { displayName, verificationOf } from '../domain/rules.js';
import * as map from '../mappers.js';
import type { AddressRow, CustomerRow, CustomerStanding } from '../ports.js';
import { type Core, type StaffBy, DATASET, invalid, notFound, addDays } from './core.js';
import type { Marketing } from './marketing.js';
import type { Profiles } from './profiles.js';

export class Admin {
  constructor(
    readonly core: Core,
    readonly marketing: Marketing,
    readonly profiles: Profiles,
  ) {}

  #datasetRegistered?: Promise<void>;

  dateFrom(d?: string) {
    return d ? zonedTimeToUtc(d, '00:00', this.core.tz) : undefined;
  }

  dateTo(d?: string) {
    return d ? zonedTimeToUtc(addDays(d, 1), '00:00', this.core.tz) : undefined;
  }

  /** Customer ids an order reference resolves to (orders) */
  private async idsForQuery(q: string | undefined): Promise<string[]> {
    const ref = q?.trim();
    if (!ref || !/^MK-/i.test(ref)) return [];
    const orders = this.core.ctx.tryUse('orders');
    const order = await this.core.soft('order lookup', orders && (() => orders.getOrderAdmin(ref.toUpperCase())));
    const id = order?.order?.contact?.customerId;
    return id ? [id] : [];
  }

  async listCustomersAdmin(
    query: { q?: string; status?: string; verification?: string; hasOpenCases?: boolean; hasAbuseReports?: boolean; joinedFrom?: string; joinedTo?: string; sort?: 'newest' | 'spend' | 'orders' | 'name' },
    page: PageRequest,
  ): Promise<common.Page<AdminCustomerRow>> {
    // open cases and abuse reports live in support and trust: their id sets filter the query before paging
    const { onlyIds, excludeIds } = await this.crossModuleFilter(query);
    const p = await this.core.repo.searchCustomers(
      {
        q: query.q,
        extraIds: await this.idsForQuery(query.q),
        onlyIds,
        excludeIds,
        statuses: query.status ? [query.status] : undefined,
        verification: query.verification,
        joinedFrom: this.dateFrom(query.joinedFrom),
        joinedTo: this.dateTo(query.joinedTo),
        sort: query.sort,
      },
      page,
    );
    return { ...p, items: await this.adminRows(p.items) };
  }

  /**
   * hasOpenCases / hasAbuseReports as id sets from support and trust (true: only those customers, false: all but them).
   * A filter whose source module is off is refused rather than ignored.
   */
  private async crossModuleFilter(query: { hasOpenCases?: boolean; hasAbuseReports?: boolean }): Promise<{ onlyIds?: string[]; excludeIds?: string[] }> {
    const wanted: { key: 'hasOpenCases' | 'hasAbuseReports'; value: boolean; ids: () => Promise<string[]> | undefined; source: string }[] = [];
    const support = this.core.ctx.tryUse('support');
    const trust = this.core.ctx.tryUse('trust');
    if (query.hasOpenCases !== undefined) wanted.push({ key: 'hasOpenCases', value: query.hasOpenCases, source: 'support', ids: () => support?.customerIdsWithOpenCases({}) });
    if (query.hasAbuseReports !== undefined) wanted.push({ key: 'hasAbuseReports', value: query.hasAbuseReports, source: 'trust', ids: () => trust?.subjectIdsWithReports('customer', { role: 'against' }) });
    const unavailable = wanted.filter((w) => (w.source === 'support' ? !support : !trust));
    if (unavailable.length) {
      const message = `This filter is not available right now (${unavailable.map((w) => w.source).join(', ')} is off)`;
      throw new AppError('VALIDATION_FAILED', message, { issues: unavailable.map((w) => ({ path: w.key, message })), unavailable: unavailable.map((w) => w.source) });
    }
    let onlyIds: string[] | undefined;
    const excludeIds: string[] = [];
    for (const w of wanted) {
      const ids = (await w.ids()) ?? [];
      if (!w.value) excludeIds.push(...ids);
      else onlyIds = onlyIds ? onlyIds.filter((id) => ids.includes(id)) : [...new Set(ids)];
    }
    return { onlyIds, excludeIds: excludeIds.length ? [...new Set(excludeIds)] : undefined };
  }

  private async adminRows(rows: CustomerRow[]): Promise<AdminCustomerRow[]> {
    const support = this.core.ctx.tryUse('support');
    const trust = this.core.ctx.tryUse('trust');
    const ids = rows.map((r) => r.id);
    const [defaults, cases, reportsAbout] = await Promise.all([
      this.core.repo.defaultAddresses(ids),
      Promise.all(rows.map((r) => this.core.soft('open cases', support && (() => support.listOpenCasesForCustomer(r.id, 1))))),
      Promise.all(rows.map((r) => this.core.soft('trust reports', trust && (() => trust.reportsAbout('customer', r.id))))),
    ]);
    const byCustomer = new Map(defaults.map((a) => [a.customer_id, a]));
    return rows.map((r, i) => ({
      id: r.id,
      ref: r.ref,
      name: displayName(r.first_name, r.last_name),
      email: r.email,
      location: map.location(byCustomer.get(r.id)),
      orderCount: r.order_count,
      totalSpend: { amount: Number(r.total_spend_minor), currency: r.currency },
      openCases: cases[i]?.total ?? 0,
      accountStatus: map.status(r),
      verification: verificationOf(r.email_verified_at, r.phone_verified_at),
      abuseReports: reportsAbout[i]?.against ?? 0,
      joinedAt: map.iso(r.created_at),
    }));
  }

  /** Admin customer list with the same filters as GET /api/admin/customers/customers */
  async searchCustomers(
    filter: { search?: string; statuses?: string[]; verification?: string; joinedFrom?: string; joinedTo?: string },
    page: common.PageInput,
  ): Promise<common.Page<CustomerSnapshot>> {
    const p = await this.searchStandings(filter, page);
    return { ...p, items: p.items.map(map.snapshot) };
  }

  async searchStandings(
    filter: { search?: string; statuses?: string[]; verification?: string; joinedFrom?: string; joinedTo?: string } | null | undefined,
    page: common.PageInput | null | undefined,
  ): Promise<common.Page<CustomerStanding>> {
    const f = filter ?? {};
    const p = await this.core.repo.searchCustomers(
      {
        q: f.search,
        extraIds: await this.idsForQuery(f.search),
        statuses: f.statuses?.map((s) => s.toLowerCase()),
        verification: f.verification?.toLowerCase(),
        joinedFrom: this.dateFrom(f.joinedFrom),
        joinedTo: this.dateTo(f.joinedTo),
      },
      toPageRequest(page ?? undefined),
    );
    const standings = new Map((await this.core.repo.standings(p.items.map((r) => r.id), this.core.now())).map((s) => [s.row.id, s]));
    return { ...p, items: p.items.map((r) => standings.get(r.id)).filter((s): s is CustomerStanding => !!s) };
  }

  /** Export rows for reports dataset customers.admin.accounts (the filtered customer list) */
  async exportRows(dataset: string, filters: unknown, _principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    if (dataset !== DATASET) throw new AppError('VALIDATION_FAILED', `Unknown dataset ${dataset}`, { issues: [{ path: 'dataset', message: 'not a customers dataset' }] });
    const f = (filters && typeof filters === 'object' ? filters : {}) as Record<string, unknown>;
    const str = (k: string) => (typeof f[k] === 'string' && f[k] ? (f[k] as string) : undefined);
    const sort = str('sort');
    const p = await this.core.repo.searchCustomers(
      {
        q: str('q'),
        extraIds: await this.idsForQuery(str('q')),
        statuses: str('status') ? [str('status')!] : undefined,
        verification: str('verification'),
        joinedFrom: this.dateFrom(str('joinedFrom')),
        joinedTo: this.dateTo(str('joinedTo')),
        sort: sort === 'spend' || sort === 'orders' || sort === 'name' ? sort : 'newest',
      },
      { mode: 'cursor', cursor: cursor ?? null, limit: 100 },
    );
    const rows = await this.adminRows(p.items);
    const phones = new Map(p.items.map((r) => [r.id, r.phone]));
    return {
      rows: rows.map((r) => ({
        ref: r.ref,
        name: r.name,
        email: r.email,
        phone: phones.get(r.id) ?? null,
        location: r.location ?? null,
        accountStatus: r.accountStatus,
        verification: r.verification,
        orderCount: r.orderCount,
        totalSpend: formatMoney(r.totalSpend),
        openCases: r.openCases,
        abuseReports: r.abuseReports,
        joinedAt: r.joinedAt,
      })),
      ...(p.nextCursor ? { nextCursor: p.nextCursor } : {}),
    };
  }

  /** reports reads the rows through exportRows; the dataset is registered once per process */
  registerDataset(): Promise<void> | undefined {
    const api = this.core.ctx.tryUse('reports');
    if (!api) return undefined;
    this.#datasetRegistered ??= api
      .registerDataset({
        key: DATASET,
        owner: 'customers',
        title: 'Customer accounts',
        permission: 'customers.accounts.export',
        audience: 'staff',
        screens: ['admin/customers'],
        available: true,
        phase: 1,
        columns: [
          { key: 'ref', label: 'Customer' },
          { key: 'name', label: 'Name' },
          { key: 'email', label: 'Email', permission: 'customers.accounts.export' },
          { key: 'phone', label: 'Phone', permission: 'customers.accounts.export' },
          { key: 'location', label: 'Location' },
          { key: 'accountStatus', label: 'Status' },
          { key: 'verification', label: 'Verification' },
          { key: 'orderCount', label: 'Orders' },
          { key: 'totalSpend', label: 'Spend' },
          { key: 'openCases', label: 'Open cases' },
          { key: 'abuseReports', label: 'Abuse reports' },
          { key: 'joinedAt', label: 'Joined' },
        ],
      })
      .catch((err) => {
        this.#datasetRegistered = undefined;
        if (!isNotImplemented(err)) throw err; // reports not built yet: requestExport answers for it
      });
    return this.#datasetRegistered;
  }

  async exportCustomers(body: { filters?: unknown; format?: 'csv' | 'xlsx' | null }, by: StaffBy): Promise<reports.ExportJob> {
    const api = this.core.ctx.tryUse('reports');
    if (!api) throw new AppError('SERVICE_UNAVAILABLE', 'Exports are unavailable right now');
    await this.registerDataset();
    const filters = body.filters ?? {};
    await this.core.audit(
      {
        action: 'customers.accounts.export',
        actionLabel: 'Exported the customer list',
        category: 'customers',
        target: { type: 'export', id: DATASET, label: `Customer accounts (${(body.format ?? 'csv').toUpperCase()})`, screen: 'admin/customers' },
        after: { filters, format: body.format ?? 'csv' },
      },
      by,
    );
    return api.requestExport({ dataset: DATASET, filters, format: body.format ?? 'csv', principal: by.principal as identity.Principal });
  }

  async getCustomerAdmin(id: string, by: StaffBy): Promise<AdminCustomerDetail> {
    const c = await this.core.repo.getCustomer(id);
    if (!c) throw notFound('Customer');
    const missing: string[] = [];
    const budget = Math.max(await this.core.ctx.settings.get('overviewSourceTimeoutMs'), 1000);
    const identityApi = this.core.ctx.use('identity');
    const orders = this.core.ctx.tryUse('orders');
    const support = this.core.ctx.tryUse('support');
    const messaging = this.core.ctx.tryUse('messaging');
    const trust = this.core.ctx.tryUse('trust');
    const [addresses, prefs, restrictions, notes, actions, requests, security, recent, cases, conversations, abuse] = await Promise.all([
      this.core.repo.listAddresses(c.id),
      this.marketing.prefsOf(c),
      this.core.repo.listRestrictions(c.id),
      this.core.repo.listNotes(c.id),
      this.core.repo.recentActions(c.id, 20),
      this.core.repo.listDataRequests(c.id),
      this.profiles.gather('sign_in', missing, budget, () => identityApi.accountSecurityOf([c.user_id], { activityLimit: 1 })),
      this.profiles.gather('orders', missing, budget, orders && (() => orders.listRecentForCustomer(c.id, 3))),
      this.profiles.gather('open_cases', missing, budget, support && (() => support.listOpenCasesForCustomer(c.id, 10))),
      this.profiles.gather('messages', missing, budget, messaging && (() => messaging.customerConversationSummaries([c.id]))),
      this.profiles.gather('abuse_reports', missing, budget, trust && (() => trust.reportsAbout('customer', c.id))),
    ]);
    const sec = security?.get(c.user_id) as { signInSummary?: string; twoStep?: { enabled?: boolean }; lastSignInAt?: string | null } | undefined;
    const conv = conversations?.[c.id];
    const counterparty = (conv?.counterparties?.[0] ?? null) as { name?: string } | null;
    const now = this.core.now();
    await this.core.audit({ action: 'customers.customer.view', actionLabel: 'Viewed customer account', category: 'customers', target: this.core.target(c) }, by);
    return {
      profile: map.profile(c, restrictions.filter((r) => map.inForce(r, now)), this.core.tz),
      defaultAddress: addresses.find((a) => a.is_default) ? map.savedAddress(addresses.find((a) => a.is_default)!) : null,
      addresses: addresses.map(map.savedAddress),
      signIn: sec ? { method: sec.signInSummary ?? null, twoStepEnabled: sec.twoStep?.enabled ?? false, lastSignInAt: sec.lastSignInAt ?? null } : null,
      marketing: map.preferences(prefs, c.phone),
      orders: {
        count: c.order_count,
        totalSpend: { amount: Number(c.total_spend_minor), currency: c.currency },
        recent: (recent ?? []).map((o) => ({ orderId: o.id, ref: o.ref, placedAt: o.placedAt, total: o.total, statusLabel: o.statusLabel, packageCount: o.packageCount, thumbnails: o.thumbnails ?? [], itemStates: o.itemStates ?? {} })),
      },
      openCases: (cases?.items ?? []).map((k) => ({
        caseId: k.id,
        ref: k.ref,
        subject: k.subject,
        statusLabel: k.statusLabel,
        handledBy: k.handledBy?.name ?? null,
        nextUpdateBy: k.nextAction?.due?.dueAt ?? null,
        orderRef: k.orderRef ?? null,
        sellerName: k.handledBy?.kind === 'seller' ? k.handledBy.name : null,
      })),
      messages: { conversationCount: conv?.conversationCount ?? 0, lastMessageAt: conv?.lastMessageAt ?? null, lastCounterparty: counterparty?.name ?? null },
      abuseReports: { filedBy: abuse?.filedBy ?? 0, against: abuse?.against ?? 0, reportIds: abuse?.reportIds ?? [] },
      notes: notes.map(map.note),
      restrictions: restrictions.map(map.restriction),
      recentActions: actions.map(map.action),
      dataRequests: requests.map((r) => map.dataRequest(r)),
      unavailable: [...new Set(missing)],
    };
  }

  async addNote(customerId: string, body: { body: string }, by: StaffBy): Promise<CustomerNote> {
    const c = await this.core.repo.getCustomer(customerId);
    if (!c) throw notFound('Customer');
    const text = body.body?.trim();
    if (!text) throw invalid('body', 'Write the note');
    if (text.length > 5000) throw invalid('body', 'Use at most 5,000 characters');
    const authorId = by.actor.id ?? 'unknown';
    const author =
      by.actor.name ?? (isUuid(authorId) ? (await this.core.soft('author name', () => this.core.ctx.use('identity').getAccount(authorId)))?.displayName : undefined) ?? 'Staff';
    const row = await this.core.repo.insertNote({ id: newId(), customer_id: c.id, body: text, author_id: authorId, author_name: author, created_at: this.core.now() });
    await this.core.audit({ action: 'customers.note.add', actionLabel: 'Added an internal note', category: 'customers', target: this.core.target(c), afterText: text.slice(0, 200) }, by);
    return map.note(row);
  }

  async listAccountActions(customerId: string, page: PageRequest): Promise<common.Page<import('../../../spec/customers.js').AccountActionRecord>> {
    if (!(await this.core.repo.getCustomer(customerId))) throw notFound('Customer');
    const p = await this.core.repo.listActions(customerId, page);
    return { ...p, items: p.items.map(map.action) };
  }

  async standing(customerId: string): Promise<CustomerStanding | undefined> {
    return isUuid(customerId) ? this.core.repo.standingById(customerId, this.core.now()) : undefined;
  }

  async standingOfUser(userId: string): Promise<CustomerStanding | undefined> {
    if (!isUuid(userId)) return undefined;
    const s = await this.core.repo.standingByUserId(userId, this.core.now());
    if (s) return s;
    return (await this.profiles.ensureCustomer(userId)) ? this.core.repo.standingByUserId(userId, this.core.now()) : undefined;
  }

  async customerIdOfAccount(accountId: string): Promise<string | undefined> {
    return (await this.standingOfUser(accountId))?.row.id;
  }

  async restrictionsOf(customerId: string, includeEnded: boolean) {
    return (await this.core.repo.listRestrictions(customerId, includeEnded ? undefined : { activeAt: this.core.now() })).map(map.restriction);
  }

  async addressesOf(customerId: string) {
    return (await this.core.repo.listAddresses(customerId)).map(map.savedAddress);
  }

  async defaultAddressesOf(customerIds: string[]): Promise<Map<string, AddressRow>> {
    return new Map((await this.core.repo.defaultAddresses(customerIds)).map((a) => [a.customer_id, a]));
  }

  async preferencesOf(c: CustomerRow) {
    return map.preferences(await this.marketing.prefsOf(c), c.phone);
  }

  async notesOf(customerId: string) {
    return (await this.core.repo.listNotes(customerId)).map(map.note);
  }

  async actionsOf(customerId: string, limit: number) {
    return (await this.core.repo.recentActions(customerId, Math.min(Math.max(limit, 1), 100))).map(map.action);
  }

  get marketTimeZone() {
    return this.core.tz;
  }
}
