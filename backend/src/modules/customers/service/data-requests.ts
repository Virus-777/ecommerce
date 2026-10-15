/**
 * Data requests: data exports (built in the background, downloadable for a while) and account closure (with the
 * obligations that hold it back), for the customer and for staff.
 */
import { SYSTEM_ACTOR, type Principal } from '../../../kernel/auth/index.js';
import type { Scope } from '../../../kernel/auth/scope.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import { format as formatMoney } from '../../../kernel/lib/money.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { ClosureBlocker, ClosureEligibility, DataRequest } from '../../../spec/customers.js';
import type * as identity from '../../../spec/identity.js';
import { blocker, displayName, isPendingRefund, RETAINED_RECORDS, type AccountStatus } from '../domain/rules.js';
import { customerAccountStatusMachine, dataRequestMachine } from '../domain/state-machines.js';
import { zip } from '../domain/zip.js';
import * as map from '../mappers.js';
import type { ActionRow, ConsentRow, CustomerRow, DataRequestRow } from '../ports.js';
import {
  type Core,
  type By,
  type StaffBy,
  HOUR,
  DAY,
  EXPORTS_PER_DAY,
  BATCH,
  type PrefKey,
  PREFS,
  EXPORT_HOOK_MODULES,
  SKIPPED_ATTACHMENT,
  safeName,
  notFound,
  addDays,
} from './core.js';
import type { Profiles } from './profiles.js';
import type { Marketing } from './marketing.js';

export class DataRequests {
  constructor(
    readonly core: Core,
    readonly profiles: Profiles,
    readonly marketing: Marketing,
  ) {}

  /** Open orders, returns, pending refunds, cases and store credit. A module that does not answer fails the check (closing is irreversible). */
  async obligations(customerId: string): Promise<ClosureBlocker[]> {
    const orders = this.core.ctx.tryUse('orders');
    const returns = this.core.ctx.tryUse('returns');
    const support = this.core.ctx.tryUse('support');
    const wallet = this.core.ctx.tryUse('wallet');
    const [o, r, s, w] = await Promise.all([
      orders?.countInProgress(customerId),
      returns?.listOpenForCustomer(customerId, 50),
      support?.listOpenCasesForCustomer(customerId, 1),
      wallet?.getBalance(customerId),
    ]);
    const out: ClosureBlocker[] = [];
    if (o && o.inProgress > 0) out.push(blocker('open_orders', o.inProgress));
    if (r && r.total > 0) out.push(blocker('open_returns', r.total));
    const pending = (r?.items ?? []).filter((x) => isPendingRefund(x.refundStatus)).length;
    if (pending > 0) out.push(blocker('pending_refunds', pending));
    if (s && s.total > 0) out.push(blocker('open_cases', s.total));
    if (w && w.available.amount > 0) out.push(blocker('store_credit_balance', 1, `${formatMoney(w.available)} store credit left on the account`));
    return out;
  }

  async getClosureEligibility(scope: Scope): Promise<ClosureEligibility> {
    const c = await this.profiles.ownCustomer(scope);
    const blockers = await this.obligations(c.id);
    return { eligible: blockers.length === 0 && c.account_status !== 'closed', blockers, retainedRecords: RETAINED_RECORDS };
  }

  async requestDataExport(scope: Scope, by: By): Promise<DataRequest> {
    const c = await this.profiles.ownCustomer(scope);
    const now = this.core.now();
    const sla = await this.core.ctx.settings.get('dataExportSlaHours');
    const row = await this.core.repo.transaction(async (repo) => {
      await repo.getCustomer(c.id, { forUpdate: true });
      if (await repo.openDataRequest(c.id, 'export')) throw new AppError('DATA_REQUEST_IN_PROGRESS', 'A copy of your data is already being prepared');
      if ((await repo.countExportsSince(c.id, new Date(now.getTime() - DAY))) >= EXPORTS_PER_DAY) {
        throw new AppError('RATE_LIMITED', `You can request your data ${EXPORTS_PER_DAY} times a day; try again tomorrow`);
      }
      return repo.insertDataRequest(this.newRequest(c.id, 'export', now, new Date(now.getTime() + sla * HOUR)));
    });
    this.core.ctx.events.publish('customers.data_export.requested', { customerId: c.id, requestId: row.id }, this.core.meta(by));
    return map.dataRequest(row);
  }

  private newRequest(customerId: string, kind: 'export' | 'closure', now: Date, dueBy: Date, scheduledFor: Date | null = null): DataRequestRow {
    return {
      id: newId(),
      customer_id: customerId,
      kind,
      state: dataRequestMachine.initial,
      requested_at: now,
      due_by: dueBy,
      file_media_id: null,
      ready_at: null,
      expires_at: null,
      scheduled_for: scheduledFor,
      completed_at: null,
      cancelled_at: null,
      failure: null,
    };
  }

  /** The customer's requests; ready exports carry a fresh signed link */
  async listDataRequests(scope: Scope, principal: Principal | null, o: { includeCancelled?: boolean } = {}): Promise<DataRequest[]> {
    const c = await this.profiles.ownCustomer(scope);
    return this.dataRequestsOf(c.id, principal, o);
  }

  /**
   * Data requests newest first; `principal` (the customer) gets download links for ready exports. Cancelled data
   * exports are left out unless includeCancelled (G33e: kept for the audit trail, not shown by default).
   */
  async dataRequestsOf(customerId: string, principal: Principal | null, o: { includeCancelled?: boolean } = {}): Promise<DataRequest[]> {
    const rows = (await this.core.repo.listDataRequests(customerId)).filter((r) => o.includeCancelled || !(r.kind === 'export' && r.state === 'cancelled'));
    const media = principal ? this.core.ctx.tryUse('media') : undefined;
    return Promise.all(
      rows.map(async (r) => {
        const url =
          r.state === 'ready' && r.file_media_id && media && principal
            ? (await this.core.soft('export link', () => media.signedDownload(r.file_media_id!, principal as identity.Principal, 'Personal data export')))?.url
            : null;
        return map.dataRequest(r, url ?? null);
      }),
    );
  }

  async requestClosure(scope: Scope, body: { reason?: string | null }, by: By): Promise<DataRequest> {
    const c = await this.profiles.ownCustomer(scope);
    if (c.account_status === 'closed') throw new AppError('ILLEGAL_TRANSITION', 'This account is already closed', { from: 'closed', event: 'close' });
    if (await this.core.repo.openDataRequest(c.id, 'closure')) throw new AppError('DATA_REQUEST_IN_PROGRESS', 'Your account is already scheduled to close');
    const blockers = await this.obligations(c.id);
    if (blockers.length) throw new AppError('CLOSURE_BLOCKED', 'Finish your open orders, returns and cases before closing your account', { blockers });
    const days = await this.core.ctx.settings.get('closureCoolingOffDays');
    const now = this.core.now();
    const scheduled = new Date(now.getTime() + days * DAY);
    const row = await this.core.repo.transaction(async (repo) => {
      await repo.getCustomer(c.id, { forUpdate: true });
      if (await repo.openDataRequest(c.id, 'closure')) throw new AppError('DATA_REQUEST_IN_PROGRESS', 'Your account is already scheduled to close');
      return repo.insertDataRequest(this.newRequest(c.id, 'closure', now, scheduled, scheduled));
    });
    this.core.ctx.events.publish('customers.closure.requested', { customerId: c.id, requestId: row.id, scheduledFor: map.iso(scheduled) }, this.core.meta(by));
    await this.core.audit(
      {
        action: 'customers.closure.request',
        actionLabel: 'Requested account closure',
        category: 'customers',
        target: this.core.target(c),
        reason: body.reason?.trim() || null,
        after: { requestId: row.id, scheduledFor: map.iso(scheduled) },
      },
      by,
    );
    return map.dataRequest(row);
  }

  async cancelDataRequest(scope: Scope, id: string, by: By): Promise<DataRequest> {
    const c = await this.profiles.ownCustomer(scope);
    const row = await this.core.repo.transaction(async (repo) => {
      const r = await repo.getDataRequest(id, { customerId: c.id, forUpdate: true });
      if (!r) throw notFound('Request');
      const state = dataRequestMachine.next(r.state as never, 'cancel');
      return repo.updateDataRequest(r.id, { state, cancelled_at: this.core.now() });
    });
    if (row.kind === 'closure') {
      await this.core.audit({ action: 'customers.closure.cancel', actionLabel: 'Cancelled account closure', category: 'customers', target: this.core.target(c), after: { requestId: row.id } }, by);
    }
    return map.dataRequest(row);
  }

  async listDataRequestsAdmin(query: { kind?: 'export' | 'closure'; state?: string; overdue?: boolean }, page: PageRequest) {
    const p = await this.core.repo.searchDataRequests({ kind: query.kind, state: query.state, overdueAt: query.overdue ? this.core.now() : undefined }, page);
    return {
      ...p,
      items: p.items.map((r) => ({ request: map.dataRequest(r), customerId: r.customer_id, customerName: displayName(r.customer_first_name, r.customer_last_name) })),
    };
  }

  async retryDataRequest(id: string, by: StaffBy): Promise<DataRequest> {
    const row = await this.core.repo.transaction(async (repo) => {
      const r = await repo.getDataRequest(id, { forUpdate: true });
      if (!r) throw notFound('Request');
      const state = dataRequestMachine.next(r.state as never, 'retry');
      return repo.updateDataRequest(r.id, { state, failure: null });
    });
    const c = await this.core.repo.getCustomer(row.customer_id);
    await this.core.audit(
      { action: 'customers.data_request.retry', actionLabel: 'Retried a data export', category: 'customers', target: c ? this.core.target(c) : { type: 'customer', id: row.customer_id }, after: { requestId: row.id } },
      by,
    );
    return map.dataRequest(row);
  }

  /** Moves a customer to closed in one transaction: promotional consent off, an open closure request completed, optional anonymisation */
  async closeAccountTx(
    customerId: string,
    o: { source: string; actor: common.Actor; reasonCode: string; details: string; anonymise: boolean; force?: boolean; requestId?: string; claim?: string },
  ): Promise<{ from: AccountStatus; action?: ActionRow; changed: boolean }> {
    const now = this.core.now();
    return this.core.repo.transaction(async (repo) => {
      const c = await repo.getCustomer(customerId, { forUpdate: true });
      if (!c) throw notFound('Customer');
      const from = map.status(c);
      if (o.claim && !(await repo.claim(o.claim))) return { from, changed: false }; // event already handled
      if (from === 'closed') return { from, changed: false };
      const to = o.force ? 'closed' : customerAccountStatusMachine.next(from, 'close');
      const patch: Partial<CustomerRow> = { account_status: to, closed_at: now, updated_at: now };
      if (o.anonymise) {
        Object.assign(patch, {
          first_name: 'Closed',
          last_name: 'account',
          email: `closed.${c.ref.toLowerCase()}@deleted.marketly.invalid`,
          email_verified_at: null,
          phone: null,
          phone_verified_at: null,
          default_address_id: null,
        });
      }
      await repo.updateCustomer(c.id, patch);
      if (o.anonymise) await repo.anonymiseAddresses(c.id, now);
      await repo.deleteViews({ kind: 'customer', id: c.id });
      // promotional consent stops with the account (essential notices for open obligations stay with notifications)
      const prefs = (await repo.getPreferences(c.id)) ?? this.marketing.defaultPrefs(c.id, now);
      const consent: ConsentRow[] = [];
      for (const k of Object.keys(PREFS) as PrefKey[]) {
        const [col, channel] = PREFS[k];
        if (prefs[col]) consent.push({ id: newId(), customer_id: c.id, channel, granted: false, source: o.source, actor_kind: o.actor.kind, actor_id: o.actor.id ?? null, ip: null, at: now });
      }
      await repo.upsertPreferences({ ...prefs, email_promotions: false, sms_promotions: false, push_promotions: false, wishlist_alerts: false, personalized_recommendations: false, recent_searches: false, updated_at: now });
      await repo.insertConsent(consent);
      const open = await repo.openDataRequest(c.id, 'closure');
      if (open) {
        await repo.updateDataRequest(open.id, { state: dataRequestMachine.next(open.state as never, 'completeClosure'), completed_at: now, failure: null });
      }
      const action = o.actor.kind === 'staff' ? await repo.insertAction(this.core.actionRow(c, { action: 'close', reasonCode: o.reasonCode, details: o.details, from, to, actor: o.actor, at: now })) : undefined;
      return { from, action, changed: true };
    });
  }

  /** identity disables sign-in (and also consumes customers.account.closed as a backstop); notifications and media react to the event */
  async afterClosure(c: CustomerRow, done: { from: AccountStatus; changed: boolean }, reasonCode: string, by: By, reason: string, approvalRequestId: string | null = null, callIdentity = true) {
    if (!done.changed) return;
    if (callIdentity) {
      try {
        await this.core.ctx.use('identity').closeAccount(c.user_id, reason);
      } catch (err) {
        this.core.ctx.log.warn({ err, customerId: c.id }, 'customers: identity.closeAccount failed; customers.account.closed is the backstop');
      }
    }
    this.core.statusChanged(c, done.from, 'closed', reasonCode, by);
    this.core.ctx.events.publish('customers.account.closed', { customerId: c.id, userId: c.user_id }, this.core.meta(by));
    await this.core.audit(
      {
        action: 'customers.account.close',
        actionLabel: 'Closed customer account',
        category: 'customers',
        target: this.core.target(c),
        reason,
        before: { accountStatus: done.from },
        after: { accountStatus: 'closed' },
        approvalRequestId,
      },
      by,
    );
  }

  /** identity.account.closed: identity closed the account directly (staff tool): the customer is closed and promotions stop */
  async onAccountClosedFromIdentity(event: EventPayload<'identity.account.closed'>): Promise<void> {
    const c = await this.core.repo.getCustomerByUserId(event.accountId);
    if (!c || c.account_status === 'closed') return;
    // identity owns the credential: the customer follows whatever its status was
    const done = await this.closeAccountTx(c.id, { source: 'staff', actor: SYSTEM_ACTOR, reasonCode: 'other', details: 'Closed in identity', anonymise: false, force: true });
    await this.afterClosure(c, done, 'other', { actor: SYSTEM_ACTOR }, 'Account closed in identity', null, false);
  }

  /** customers.build-data-exports: requested (and retried) exports become a ZIP in media, then ready */
  async buildDataExports(): Promise<{ built: number; failed: number }> {
    const claimed = await this.core.repo.transaction(async (repo) => {
      const rows = await repo.exportsToBuild(10);
      const out: DataRequestRow[] = [];
      for (const r of rows) out.push(r.state === 'requested' ? await repo.updateDataRequest(r.id, { state: dataRequestMachine.next('requested', 'startExport') }) : r);
      return out;
    });
    let built = 0;
    let failed = 0;
    for (const r of claimed) {
      try {
        await this.buildExport(r);
        built++;
      } catch (err) {
        failed++;
        this.core.ctx.log.warn({ err, requestId: r.id }, 'customers: data export failed');
        const failure = (isAppError(err) ? err.message : (err as Error)?.message) || 'Export failed';
        await this.core.repo.updateDataRequest(r.id, { state: dataRequestMachine.next('processing', 'fail'), failure: failure.slice(0, 500) });
      }
    }
    return { built, failed };
  }

  private async buildExport(r: DataRequestRow) {
    const media = this.core.ctx.tryUse('media');
    if (!media) throw new Error('File storage (media) is not available');
    const c = await this.core.repo.getCustomer(r.customer_id);
    if (!c) throw new Error('Customer not found');
    const now = this.core.now();
    const [restrictions, addresses, prefs, consent, views, requests] = await Promise.all([
      this.core.repo.listRestrictions(c.id),
      this.core.repo.listAddresses(c.id),
      this.marketing.prefsOf(c),
      this.core.repo.consentLog(c.id),
      this.core.repo.listViews({ kind: 'customer', id: c.id }, 1000),
      this.core.repo.listDataRequests(c.id),
    ]);
    // every enabled module that declares the export hook (FORMAT.md, Customer data export hook); one that throws fails the export (retried).
    // A module that declares it but is off has nothing to export here and is listed under notIncluded.
    const sections = await this.exportSections({ customerId: c.id, accountId: c.user_id });
    const unavailable: string[] = EXPORT_HOOK_MODULES.filter((m) => !this.core.ctx.modules.includes(m));
    const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
    const used = new Set(['readme', 'profile', 'addresses', 'marketing-preferences', 'consent-log', 'recently-viewed', 'restrictions', 'data-requests']);
    const sectionFiles: { name: string; data: string; title: string; module: string }[] = [];
    for (const s of sections) {
      let key = safeName(s.key) || safeName(s.module) || 'section';
      if (used.has(key)) key = `${safeName(s.module)}-${key}`;
      for (let i = 2; used.has(key); i++) key = `${safeName(s.key)}-${i}`;
      used.add(key);
      sectionFiles.push({ name: `${key}.json`, data: json(s.records), title: s.title, module: s.module });
    }
    const attachments = await this.exportAttachments(sections, c.user_id, unavailable);
    const entries = [
      {
        name: 'README.json',
        data: json({
          generatedAt: map.iso(now),
          customer: c.ref,
          files: [
            'profile.json',
            'addresses.json',
            'marketing-preferences.json',
            'consent-log.json',
            'recently-viewed.json',
            'restrictions.json',
            'data-requests.json',
            ...sectionFiles.map((f) => f.name),
            ...attachments.map((a) => a.name),
          ],
          sections: sectionFiles.map((f) => ({ file: f.name, title: f.title, module: f.module })),
          notIncluded: unavailable,
        }),
      },
      { name: 'profile.json', data: json(map.profile(c, restrictions.filter((x) => map.inForce(x, now)), this.core.tz)) },
      { name: 'addresses.json', data: json(addresses.map(map.savedAddress)) },
      { name: 'marketing-preferences.json', data: json(map.preferences(prefs, c.phone)) },
      { name: 'consent-log.json', data: json(consent.map((x) => ({ channel: x.channel, granted: x.granted, source: x.source, at: map.iso(x.at) }))) },
      { name: 'recently-viewed.json', data: json(views.map((v) => ({ productId: v.product_id, variantId: v.variant_id, title: v.title, viewedAt: map.iso(v.viewed_at) }))) },
      { name: 'restrictions.json', data: json(restrictions.map(map.restriction)) },
      { name: 'data-requests.json', data: json(requests.map((x) => map.dataRequest(x))) },
      ...sectionFiles.map(({ name, data }) => ({ name, data })),
      ...attachments,
    ];
    const file = zip(entries, now);
    const days = await this.core.ctx.settings.get('exportLinkValidDays');
    const asset = await media.storeGeneratedFile({
      owner: { kind: 'customer', id: c.user_id, label: c.ref },
      fileName: `marketly-data-${c.ref}-${dateInZone(now, this.core.tz)}.zip`,
      contentType: 'application/zip',
      body: new Blob([new Uint8Array(file)]).stream(),
      ttlHours: days * 24,
      purpose: 'data_export',
    });
    const expiresAt = new Date(now.getTime() + days * DAY);
    const row = await this.core.repo.updateDataRequest(r.id, {
      state: dataRequestMachine.next('processing', 'finishExport'),
      file_media_id: asset.id,
      ready_at: now,
      expires_at: expiresAt,
      failure: null,
    });
    this.core.ctx.events.publish('customers.data_export.ready', { customerId: c.id, requestId: row.id, expiresAt: map.iso(expiresAt) }, this.core.meta({ actor: SYSTEM_ACTOR }));
  }

  /** exportCustomerData of every enabled module that declares it; any failure fails the export (retried, never left out) */
  private async exportSections(input: { customerId: string; accountId: string }): Promise<common.CustomerDataSection[]> {
    const out: common.CustomerDataSection[] = [];
    for (const m of EXPORT_HOOK_MODULES) {
      const api = this.core.ctx.tryUse(m) as unknown as { exportCustomerData(i: typeof input): Promise<common.CustomerDataSection[]> } | undefined;
      if (!api) continue;
      let sections: common.CustomerDataSection[];
      try {
        sections = await api.exportCustomerData(input);
      } catch (err) {
        throw new Error(`${m} could not export its part (${(err as Error)?.message ?? 'unknown error'})`, { cause: err });
      }
      for (const s of sections ?? []) out.push({ ...s, module: s.module || m, records: Array.isArray(s.records) ? s.records : [] });
    }
    return out;
  }

  /** The customer's own uploads the sections name (attachments/<section>/<file>); files gone or not theirs are listed as not included */
  private async exportAttachments(sections: common.CustomerDataSection[], accountId: string, notIncluded: string[]): Promise<{ name: string; data: Buffer }[]> {
    const wanted = sections.flatMap((s) => (s.attachmentIds ?? []).map((id) => ({ id, folder: safeName(s.key) || 'files' })));
    if (!wanted.length) return [];
    const media = this.core.ctx.tryUse('media');
    if (!media) throw new Error('File storage (media) is not available');
    const out: { name: string; data: Buffer }[] = [];
    const seen = new Set<string>();
    for (const w of wanted) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      try {
        const f = await media.readFile(w.id, { kind: 'customer', id: accountId });
        out.push({ name: `attachments/${w.folder}/${w.id.slice(0, 8)}-${safeName(f.fileName.replace(/\.[^.]*$/, '')) || 'file'}${/\.[A-Za-z0-9]{1,8}$/.exec(f.fileName)?.[0] ?? ''}`, data: Buffer.from(f.body) });
      } catch (err) {
        if (!isAppError(err) || !SKIPPED_ATTACHMENT.has(err.code)) throw err;
        notIncluded.push(`attachment ${w.id} (${err.code === 'FILE_TOO_LARGE' ? 'too large' : 'no longer available'})`);
      }
    }
    return out;
  }

  /** customers.expire-export-links: ready exports past their link lifetime expire and the file is deleted */
  async expireExportLinks(): Promise<{ expired: number }> {
    const media = this.core.ctx.tryUse('media');
    let expired = 0;
    for (let round = 0; round < 20; round++) {
      const rows = await this.core.repo.readyExportsExpiring(this.core.now(), BATCH);
      if (!rows.length) break;
      for (const r of rows) {
        await this.core.repo.updateDataRequest(r.id, { state: dataRequestMachine.next('ready', 'expireLink') });
        expired++;
        if (r.file_media_id && media) await this.core.soft('remove export file', () => media.remove(r.file_media_id!, { reason: 'Data export link expired', by: SYSTEM_ACTOR }));
      }
      if (rows.length < BATCH) break;
    }
    return { expired };
  }

  /** customers.complete-closures: closures past the cooling-off date re-check obligations, then close and anonymise */
  async completeClosures(): Promise<{ completed: number; waiting: number }> {
    let completed = 0;
    let waiting = 0;
    for (const r of await this.core.repo.closuresDue(this.core.now(), 200)) {
      const c = await this.core.repo.getCustomer(r.customer_id);
      if (!c) continue;
      let blockers: ClosureBlocker[];
      try {
        blockers = await this.obligations(c.id);
      } catch (err) {
        this.core.ctx.log.warn({ err, requestId: r.id }, 'customers: closure obligations could not be checked; retried at the next run');
        waiting++;
        continue;
      }
      const why = blockers.length ? `Waiting: ${blockers.map((b) => b.detail).join(', ')}` : c.account_status === 'under_review' ? 'Waiting: the account is under review' : null;
      if (why) {
        // new obligations appeared: the request keeps waiting (shown in the privacy queue)
        if (r.failure !== why) await this.core.repo.updateDataRequest(r.id, { failure: why });
        if (blockers.length) await this.closureDelayed(c, r, blockers);
        waiting++;
        continue;
      }
      const done = await this.closeAccountTx(c.id, { source: 'profile', actor: SYSTEM_ACTOR, reasonCode: 'customer_request', details: 'Customer requested closure', anonymise: true });
      await this.afterClosure(c, done, 'customer_request', { actor: SYSTEM_ACTOR }, 'Customer requested closure');
      completed++;
    }
    return { completed, waiting };
  }

  /** customers.closure.delayed, once per new set of blockers (the set of blocker kinds, claimed in the inbox per request) */
  private async closureDelayed(c: CustomerRow, r: DataRequestRow, blockers: ClosureBlocker[]) {
    const kinds = [...new Set(blockers.map((b) => b.kind))].sort().join(',');
    const fresh = await this.core.repo.transaction((repo) => repo.claim(`closure-delayed:${r.id}:${kinds}`));
    if (!fresh) return;
    this.core.ctx.events.publish(
      'customers.closure.delayed',
      { customerId: c.id, userId: c.user_id, requestId: r.id, blockers, nextCheckAt: this.nextClosureCheck().toISOString() },
      this.core.meta({ actor: SYSTEM_ACTOR }),
    );
  }

  /** The next run of customers.complete-closures (daily 02:00 market time) */
  private nextClosureCheck(): Date {
    const now = this.core.now();
    const today = dateInZone(now, this.core.tz);
    const at = zonedTimeToUtc(today, '02:00', this.core.tz);
    return at > now ? at : zonedTimeToUtc(addDays(today, 1), '02:00', this.core.tz);
  }
}
