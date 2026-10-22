/**
 * Owning apps: free apps on Get, purchases of an app or a pack paid with a card through payments purchase intents
 * (authorize, then capture at once), the bank challenge and retries, the asynchronous outcomes payments publishes,
 * the library with licence keys, downloads (any signed-in customer), staff grants, the owners list and licence
 * reissues, and the customer's data export.
 *
 * Money safety: the purchase is one row per Idempotency-Key; payments allows one live intent per purchase and
 * answers the same key with the first result; entitlements are unique per (customer, app), so a redelivered event
 * or a second settle never grants twice. Settling happens under the purchase lock and only moves forward.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { Page, PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { DownloadLink } from '../../../spec/media.js';
import type { AuthorizeResult, MethodSelection, PaymentOptions, PurchasePaymentStatus } from '../../../spec/payments.js';
import type { Entitlement, EntitlementAdmin, GrantInput, LibraryApp, PurchaseAdmin, PurchaseInput, ReissueLicenceInput, SoftwarePurchase } from '../../../spec/software.js';
import { ABANDON_AFTER_MS, PURCHASE_STATUS_LABEL, currentAmount, keyTail, makeRef, normaliseLicenceKey, type PurchaseStatus } from '../domain/rules.js';
import { softwarePurchaseMachine } from '../domain/state-machines.js';
import type { AppRow, EntitlementRow, PurchaseRow } from '../ports.js';
import { actorKey, fileOf, filesOf, invalid, notFound, requireText, stringsOf, unique, type By } from './base.js';
import { SoftwareCatalog } from './catalog.js';

/** purchases.items as stored: the PurchaseItem of the API with the icon's asset id */
type StoredItem = {
  appId: string;
  slug: string;
  title: string;
  iconId: string | null;
};
const itemsOf = (v: unknown): StoredItem[] => (Array.isArray(v) ? (v as StoredItem[]).filter((i) => i && typeof i.appId === 'string').map((i) => ({ appId: i.appId, slug: String(i.slug ?? ''), title: String(i.title ?? ''), iconId: i.iconId ?? null })) : []);
const itemOf = (a: AppRow): StoredItem => ({ appId: a.id, slug: a.slug, title: a.title, iconId: a.icon_id });
const SYSTEM: common.Actor = { kind: 'system', id: null, name: 'Marketly' };
/** Statuses a payment outcome can still change */
const OPEN: readonly PurchaseStatus[] = ['pending_payment', 'requires_action'];

export class SoftwarePurchases extends SoftwareCatalog {
  /* ---------------------------------------------------------------- views */

  private async paymentOf(p: PurchaseRow): Promise<PurchasePaymentStatus | null> {
    if (!p.intent_id) return null;
    return this.payments.getPurchaseStatus(p.intent_id).catch((err) => {
      this.ctx.log.warn({ err, purchaseId: p.id }, 'software: payment status unavailable');
      return null;
    });
  }

  protected async purchaseOut(p: PurchaseRow, payment?: PurchasePaymentStatus | null): Promise<SoftwarePurchase> {
    const items = itemsOf(p.items);
    const refs = await this.refsMap(items.map((i) => i.iconId), 'thumb');
    return {
      id: p.id,
      ref: p.ref,
      status: p.status,
      statusLabel: PURCHASE_STATUS_LABEL[p.status],
      title: p.title,
      packId: p.pack_id,
      items: items.map((i) => ({ appId: i.appId, slug: i.slug, title: i.title, icon: i.iconId ? (refs.get(i.iconId) ?? null) : null })),
      amount: { amount: Number(p.amount), currency: p.currency },
      payment: payment === undefined ? await this.paymentOf(p) : payment,
      createdAt: p.created_at.toISOString(),
      paidAt: p.paid_at ? p.paid_at.toISOString() : null,
    };
  }

  private entitlementOut(e: EntitlementRow, a: Pick<AppRow, 'id' | 'slug' | 'title' | 'free'>): Entitlement {
    return { appId: a.id, slug: a.slug, title: a.title, source: e.source, ownedAt: e.created_at.toISOString(), licenceKey: a.free ? null : e.licence_key };
  }

  /** The customer's own purchase; another customer's is NOT_FOUND */
  private async ownPurchase(customerId: string, id: string): Promise<PurchaseRow> {
    const p = await this.repo.getPurchase(id);
    if (!p || p.customer_id !== customerId) throw notFound('Purchase');
    return p;
  }

  /* ---------------------------------------------------------------- free apps */

  /** Owns a free app (source free); the same answer when already owned */
  async getFreeApp(customerId: string, slug: string): Promise<Entitlement> {
    const a = await this.publishedApp(slug);
    if (!a.free) throw this.ctx.error('NOT_FREE', 'This app is paid; buy it instead.');
    const row = await this.repo.insertEntitlement({ id: newId(), customer_id: customerId, app_id: a.id, source: 'free', purchase_id: null, granted_by: null, licence_key: null, licence_issued_at: null, licence_reissues: null, created_at: this.now() });
    if (row) await this.repo.bump(a.id, { owners: 1 });
    return this.entitlementOut(row ?? (await this.repo.entitlement(customerId, a.id))!, a);
  }

  /* ---------------------------------------------------------------- what is for sale */

  /**
   * An app or a pack the customer can buy now, with its price and the apps it grants: published paid apps;
   * visible packs (NOT_FOR_SALE otherwise); ALREADY_OWNED when the customer owns the app, or every app of the pack.
   */
  private async forSale(customerId: string, input: { appId?: string | null; packId?: string | null }): Promise<{ title: string; amount: number; currency: string; items: StoredItem[]; appId: string | null; packId: string | null }> {
    if (Boolean(input.appId) === Boolean(input.packId)) throw invalid(input.appId ? 'packId' : 'appId', 'Choose an app or a pack');
    if (input.appId) {
      const a = await this.repo.getApp(input.appId);
      if (!a) throw notFound('App');
      const amount = a.status === 'published' ? currentAmount(a, this.now()) : null;
      if (amount == null) throw this.ctx.error('NOT_FOR_SALE', a.free && a.status === 'published' ? 'This app is free; get it instead.' : "This app can't be bought right now.");
      if (await this.repo.entitlement(customerId, a.id)) throw this.ctx.error('ALREADY_OWNED', 'You already own this app.');
      return { title: a.title, amount, currency: a.currency, items: [itemOf(a)], appId: a.id, packId: null };
    }
    const p = await this.repo.getPack(input.packId!);
    if (!p) throw notFound('Pack');
    const ids = stringsOf(p.app_ids);
    const byId = new Map((await this.repo.appsByIds(ids)).map((a) => [a.id, a]));
    const apps = ids.map((id) => byId.get(id)).filter((a): a is AppRow => Boolean(a));
    if (!p.visible || !apps.length || apps.some((a) => a.status !== 'published')) throw this.ctx.error('NOT_FOR_SALE', "This pack can't be bought right now.");
    const owned = await this.repo.ownedAppIds(customerId, ids);
    if (apps.every((a) => owned.has(a.id))) throw this.ctx.error('ALREADY_OWNED', 'You already own every app in this pack.');
    return { title: p.name, amount: Number(p.price), currency: p.currency, items: apps.map(itemOf), appId: null, packId: p.id };
  }

  /** The customer's cards for buying an app or a pack (priced); without either, the cards alone (amount 0) */
  async getPaymentOptions(customerId: string, q: { appId?: string; packId?: string }): Promise<PaymentOptions> {
    // payments' chargeNote describes checkout orders; a software purchase is charged at once
    const withNote = (o: PaymentOptions): PaymentOptions => ({ ...o, chargeNote: 'Your card is charged now, and the app is yours as soon as the payment goes through.' });
    if (!q.appId && !q.packId) return withNote(await this.payments.listOptions({ customerId }, { amount: 0, currency: this.currency }));
    const sale = await this.forSale(customerId, q);
    return withNote(await this.payments.listOptions({ customerId }, { amount: sale.amount, currency: sale.currency }));
  }

  /* ---------------------------------------------------------------- buying */

  private async newRef(): Promise<string> {
    for (let i = 0; i < 20; i++) {
      const ref = makeRef();
      if (!(await this.repo.purchaseRefTaken(ref))) return ref;
    }
    throw new Error('software: no free purchase reference');
  }

  /**
   * POST /purchases: exactly one of appId and packId; PRICE_CHANGED (details.amount) when the price the customer saw
   * differs. The purchase is stored first (one per Idempotency-Key), then paid: a retry of a request whose payment
   * call failed pays the stored purchase.
   */
  async createPurchase(customerId: string, input: PurchaseInput, idempotencyKey: string | undefined, by: By): Promise<SoftwarePurchase> {
    const key = idempotencyKey?.trim() || newId();
    const known = await this.repo.purchaseByKey(key);
    if (known) {
      if (known.customer_id !== customerId) throw new AppError('CONFLICT', 'This request key was already used');
      if (!known.intent_id && known.status === 'pending_payment') return this.pay(known, input.method, input.returnUrl, key, by);
      return this.purchaseOut(known);
    }
    const sale = await this.forSale(customerId, input);
    const expected = input.expectedAmount;
    if (!expected || expected.amount !== sale.amount || (expected.currency && expected.currency !== sale.currency)) {
      throw this.ctx.error('PRICE_CHANGED', `The price changed to ${(sale.amount / 100).toFixed(2)} ${sale.currency}.`, { amount: { amount: sale.amount, currency: sale.currency } });
    }
    requireText(input.returnUrl, 'returnUrl', 2000);
    const now = this.now();
    const row: PurchaseRow = {
      id: newId(),
      ref: await this.newRef(),
      customer_id: customerId,
      app_id: sale.appId,
      pack_id: sale.packId,
      title: sale.title,
      items: sale.items,
      amount: sale.amount,
      currency: sale.currency,
      status: softwarePurchaseMachine.initial as PurchaseStatus,
      intent_id: null,
      attempts: 1,
      method_label: null,
      decline_message: null,
      idempotency_key: key,
      created_at: now,
      updated_at: now,
      paid_at: null,
    };
    const inserted = await this.repo.insertPurchase(row);
    if (!inserted) {
      // the same key won a race (or the reference was drawn twice: very unlikely, the customer simply tries again)
      const winner = await this.repo.purchaseByKey(key);
      if (winner && winner.customer_id === customerId) return this.purchaseOut(winner);
      throw new AppError('CONFLICT', 'Your purchase is being processed; try again.');
    }
    return this.pay(inserted, input.method, input.returnUrl, key, by);
  }

  /** Authorizes the purchase's amount on the card, records the intent and settles what payments answered */
  private async pay(p: PurchaseRow, method: MethodSelection, returnUrl: string, key: string, by: By): Promise<SoftwarePurchase> {
    const result = await this.payments.authorizePurchase(
      { module: 'software', refId: p.id, ref: p.ref, customerId: p.customer_id, amount: { amount: Number(p.amount), currency: p.currency }, method, description: p.title, returnUrl },
      `software:${p.id}:${key}`,
    );
    await this.repo.updatePurchase(p.id, { intent_id: result.intentId, method_label: result.methodLabel, updated_at: this.now() });
    return this.settle(p.id, result.intentId, result.state === 'pending_check' ? 'pending' : result.state, by);
  }

  /**
   * Moves a purchase after a payment outcome: accepted → captured at once → paid (entitlements); captured → paid;
   * requires_action → waiting for the bank challenge; failed → failed; pending → stays pending_payment. Outcomes of
   * an older intent (a retried purchase) are ignored.
   */
  protected async settle(purchaseId: string, intentId: string, state: AuthorizeResult['state'] | PurchasePaymentStatus['state'], by: By): Promise<SoftwarePurchase> {
    const p = await this.repo.getPurchase(purchaseId);
    if (!p) throw notFound('Purchase');
    if (p.intent_id !== intentId || !OPEN.includes(p.status)) return this.purchaseOut(p);
    switch (state) {
      case 'accepted':
        try {
          await this.payments.capturePurchase(intentId);
        } catch (err) {
          // not captured yet (the provider did not answer): still pending; a refresh or the next event tries again
          this.ctx.log.warn({ err, purchaseId }, 'software: payment not captured yet');
          return this.purchaseOut(p);
        }
        return this.purchaseOut(await this.markPaid(purchaseId, intentId, by));
      case 'captured':
        return this.purchaseOut(await this.markPaid(purchaseId, intentId, by));
      case 'requires_action':
        return this.purchaseOut(await this.move(purchaseId, intentId, 'challenge'));
      case 'failed':
      case 'voided':
        return this.purchaseOut(await this.markFailed(purchaseId, intentId, by));
      default:
        return this.purchaseOut(p);
    }
  }

  /** pending_payment → requires_action (the bank challenge) */
  private async move(purchaseId: string, intentId: string, event: 'challenge'): Promise<PurchaseRow> {
    return this.repo.transaction(async (tx) => {
      const p = (await tx.getPurchase(purchaseId, { forUpdate: true }))!;
      if (p.intent_id !== intentId || p.status !== 'pending_payment') return p;
      return (await tx.updatePurchase(p.id, { status: softwarePurchaseMachine.next(p.status, event) as PurchaseStatus, updated_at: this.now() }))!;
    });
  }

  /**
   * Paid: the apps the customer doesn't own yet are theirs (source purchase, or pack for a pack), owners and the
   * pack's sold count go up, and software.purchase.paid is published. Once per purchase (under its lock).
   */
  private async markPaid(purchaseId: string, intentId: string, by: By): Promise<PurchaseRow> {
    const status = await this.payments.getPurchaseStatus(intentId).catch(() => null);
    const done = await this.repo.transaction(async (tx) => {
      const p = (await tx.getPurchase(purchaseId, { forUpdate: true }))!;
      if (p.intent_id !== intentId || !OPEN.includes(p.status)) return { p, granted: null };
      const now = this.now();
      const granted: string[] = [];
      const items = itemsOf(p.items);
      const apps = new Map((await tx.appsByIds(items.map((i) => i.appId))).map((a) => [a.id, a]));
      for (const item of items) {
        if (await tx.entitlement(p.customer_id, item.appId)) continue; // owned already (a pack buyer keeps what they had)
        // a bought app is paid: its licence key comes with it (an app deleted meanwhile still gets one)
        const licence = await this.licenceFor(apps.get(item.appId) ?? { free: false }, now, tx);
        const row = await tx.insertEntitlement({ id: newId(), customer_id: p.customer_id, app_id: item.appId, source: p.pack_id ? 'pack' : 'purchase', purchase_id: p.id, granted_by: null, ...licence, created_at: now });
        if (!row) continue; // owned already (a pack buyer keeps what they had)
        granted.push(item.appId);
        await tx.bump(item.appId, { owners: 1 });
      }
      if (p.pack_id) await tx.bumpPackSold(p.pack_id);
      const after = (await tx.updatePurchase(p.id, { status: softwarePurchaseMachine.next(p.status, 'pay') as PurchaseStatus, paid_at: now, updated_at: now, decline_message: null, ...(status?.methodLabel ? { method_label: status.methodLabel } : {}) }))!;
      return { p: after, granted };
    });
    if (done.granted) {
      const p = done.p;
      this.ctx.events.publish('software.purchase.paid', { purchaseId: p.id, ref: p.ref, customerId: p.customer_id, title: p.title, amount: { amount: Number(p.amount), currency: p.currency }, appIds: itemsOf(p.items).map((i) => i.appId) }, { actor: by.actor, ...(by.requestId ? { requestId: by.requestId } : {}) });
    }
    return done.p;
  }

  /** Failed: the decline is kept for the customer; software.purchase.failed once */
  private async markFailed(purchaseId: string, intentId: string, by: By): Promise<PurchaseRow> {
    const status = await this.payments.getPurchaseStatus(intentId).catch(() => null);
    const done = await this.repo.transaction(async (tx) => {
      const p = (await tx.getPurchase(purchaseId, { forUpdate: true }))!;
      if (p.intent_id !== intentId || !OPEN.includes(p.status)) return { p, changed: false };
      const after = (await tx.updatePurchase(p.id, { status: softwarePurchaseMachine.next(p.status, 'fail') as PurchaseStatus, decline_message: status?.decline?.message ?? status?.message ?? 'The payment was not accepted.', updated_at: this.now() }))!;
      return { p: after, changed: true };
    });
    if (done.changed) {
      const p = done.p;
      this.ctx.events.publish('software.purchase.failed', { purchaseId: p.id, ref: p.ref, customerId: p.customer_id, title: p.title }, { actor: by.actor, ...(by.requestId ? { requestId: by.requestId } : {}) });
    }
    return done.p;
  }

  /** GET /purchases/{id}: refresh asks payments (and the provider) about an open payment and settles it */
  async getPurchase(customerId: string, id: string, refresh: boolean, by: By): Promise<SoftwarePurchase> {
    const p = await this.ownPurchase(customerId, id);
    if (!refresh || !p.intent_id || !OPEN.includes(p.status)) return this.purchaseOut(p);
    const status = await this.payments.getPurchaseStatus(p.intent_id, true);
    return this.settle(p.id, p.intent_id, status.state, by);
  }

  /** Finishes the bank challenge through payments.completeAction, then settles like a purchase */
  async completePurchaseAction(customerId: string, id: string, resultToken: string, idempotencyKey: string | undefined, by: By): Promise<SoftwarePurchase> {
    const p = await this.ownPurchase(customerId, id);
    if (p.status !== 'requires_action' || !p.intent_id) throw new AppError('ILLEGAL_TRANSITION', 'This purchase has no bank challenge to finish.', { machine: 'Software purchase', from: p.status, event: 'complete_action' });
    const token = requireText(resultToken, 'resultToken', 2000);
    const r = await this.payments.completeAction(p.intent_id, token, idempotencyKey?.trim() || newId());
    return this.settle(p.id, p.intent_id, r.state === 'pending_check' ? 'pending' : r.state, by);
  }

  /** Pays a failed purchase again: a new intent (attempt n+1) for the same purchase and amount */
  async retryPurchase(customerId: string, id: string, input: { method: MethodSelection; returnUrl: string }, idempotencyKey: string | undefined, by: By): Promise<SoftwarePurchase> {
    const p = await this.ownPurchase(customerId, id);
    const next = softwarePurchaseMachine.next(p.status, 'retry') as PurchaseStatus; // ILLEGAL_TRANSITION unless failed
    const items = itemsOf(p.items);
    const owned = await this.repo.ownedAppIds(customerId, items.map((i) => i.appId));
    if (items.every((i) => owned.has(i.appId))) throw this.ctx.error('ALREADY_OWNED', p.pack_id ? 'You already own every app in this pack.' : 'You already own this app.');
    requireText(input.returnUrl, 'returnUrl', 2000);
    const key = idempotencyKey?.trim() || newId();
    const after = await this.repo.transaction(async (tx) => {
      const x = (await tx.getPurchase(p.id, { forUpdate: true }))!;
      if (x.status !== 'failed') softwarePurchaseMachine.next(x.status, 'retry');
      return (await tx.updatePurchase(x.id, { status: next, intent_id: null, decline_message: null, attempts: x.attempts + 1, updated_at: this.now() }))!;
    });
    return this.pay(after, input.method, input.returnUrl, `retry:${after.attempts}:${key}`, by);
  }

  async listMyPurchases(customerId: string, page: PageRequest): Promise<Page<SoftwarePurchase>> {
    const paged = await this.repo.pageCustomerPurchases(customerId, page);
    return { ...paged, items: await Promise.all(paged.items.map((p) => this.purchaseOut(p))) };
  }

  async listLibrary(customerId: string, page: PageRequest): Promise<Page<LibraryApp>> {
    const paged = await this.repo.pageCustomerEntitlements(customerId, page);
    const apps = new Map((await this.repo.appsByIds(paged.items.map((e) => e.app_id))).map((a) => [a.id, a]));
    const rows = await Promise.all(paged.items.filter((e) => apps.has(e.app_id)).map((e) => this.ensureLicence(e, apps.get(e.app_id)!)));
    const cards = await this.appCards(rows.map((e) => apps.get(e.app_id)!), customerId);
    return { ...paged, items: rows.map((e, i) => ({ app: cards[i]!, source: e.source, ownedAt: e.created_at.toISOString(), licence: this.licenceOut(e, apps.get(e.app_id)!) })) };
  }

  /* ---------------------------------------------------------------- downloads */

  /**
   * A signed link (media.signedDownload, downloadUrlTtlMinutes) to the package, or to a database by its file id, for
   * any signed-in customer: owning the app is not needed (owner decision 2026-10-22; a paid app is unlocked by its
   * licence key). A hidden app is downloaded by its owners only. Counts a download for the package.
   */
  async createDownload(customerId: string, slug: string, input: { fileId?: string | null }, principal: Principal): Promise<DownloadLink> {
    const a = await this.repo.appBySlug(slug);
    if (!a || a.status === 'draft' || a.status === 'in_review') throw notFound('App');
    if (a.status !== 'published' && !(await this.repo.entitlement(customerId, a.id))) throw notFound('App');
    const file = input.fileId ? filesOf(a.databases).find((f) => f.id === input.fileId) : fileOf(a.package);
    if (!file) throw this.ctx.error('FILE_MISSING', "That file isn't available yet.");
    let link: DownloadLink;
    try {
      link = await this.media.signedDownload(file.id, principal, 'software download');
    } catch (err) {
      if (isAppError(err) && err.status < 500) throw this.ctx.error('FILE_MISSING', "That file isn't available yet.");
      throw err;
    }
    if (file.kind === 'package') await this.repo.bump(a.id, { downloads: 1 });
    return link;
  }

  /* ---------------------------------------------------------------- admin */

  async listPurchasesAdmin(q: { status?: string; appId?: string; q?: string }, page: PageRequest): Promise<Page<PurchaseAdmin>> {
    const term = q.q?.trim();
    let customerIds: string[] | undefined;
    if (term && term.includes('@')) {
      const customers = this.ctx.tryUse('customers');
      const found = customers ? await this.soft('customers.searchCustomers', () => customers.searchCustomers({ search: term }, { limit: 50 }), null) : null;
      customerIds = found?.items.map((c) => c.id) ?? [];
    }
    const paged = await this.repo.pageAdminPurchases({ status: q.status, appId: q.appId, ...(term ? { q: term, customerIds } : {}) }, page);
    const people = new Map<string, Promise<{ name: string | null; email: string | null }>>();
    const person = (id: string) => {
      let p = people.get(id);
      if (!p) {
        const customers = this.ctx.tryUse('customers');
        p = customers ? this.soft('customers.getCustomer', () => customers.getCustomer(id), null).then((c) => ({ name: c?.displayName ?? null, email: c?.email ?? null })) : Promise.resolve({ name: null, email: null });
        people.set(id, p);
      }
      return p;
    };
    const items = await Promise.all(
      paged.items.map(async (p): Promise<PurchaseAdmin> => {
        const view = await this.purchaseOut(p, null);
        const who = await person(p.customer_id);
        return { id: p.id, ref: p.ref, status: p.status, title: p.title, packId: p.pack_id, items: view.items, amount: view.amount, customer: { id: p.customer_id, name: who.name, email: who.email }, methodLabel: p.method_label, intentId: p.intent_id, declineMessage: p.decline_message, createdAt: view.createdAt, paidAt: view.paidAt };
      }),
    );
    return { ...paged, items };
  }

  /** Gives a customer an app (source staff): support goodwill or a payment settled elsewhere. Audited. */
  async grantApp(input: GrantInput, by: By): Promise<Entitlement> {
    const reason = requireText(input.reason, 'reason', 500, 'Give a reason');
    const a = await this.repo.getApp(input.appId);
    if (!a) throw notFound('App');
    const customers = this.ctx.tryUse('customers');
    if (customers && !(await this.soft('customers.getCustomer', () => customers.getCustomer(input.customerId), null))) throw notFound('Customer');
    if (await this.repo.entitlement(input.customerId, a.id)) throw this.ctx.error('ALREADY_OWNED', 'The customer already owns this app.');
    const now = this.now();
    const row = await this.repo.insertEntitlement({ id: newId(), customer_id: input.customerId, app_id: a.id, source: 'staff', purchase_id: null, granted_by: actorKey(by.actor), ...(await this.licenceFor(a, now)), created_at: now });
    if (!row) throw this.ctx.error('ALREADY_OWNED', 'The customer already owns this app.');
    await this.repo.bump(a.id, { owners: 1 });
    await this.audit({ action: 'software.entitlement.grant', actionLabel: 'Gave a customer an app', category: 'customers', target: { type: 'customer', id: input.customerId, label: a.title }, reason, after: { appId: a.id, source: 'staff', licenceKey: keyTail(row.licence_key) } }, by);
    return this.entitlementOut(row, a);
  }

  /** EntitlementAdmin rows: the app, the customer (customers when on), the purchase reference */
  private async entitlementsAdmin(rows: EntitlementRow[]): Promise<EntitlementAdmin[]> {
    const [apps, purchases] = await Promise.all([this.repo.appsByIds(unique(rows.map((e) => e.app_id))), this.repo.purchasesByIds(unique(rows.map((e) => e.purchase_id).filter((id): id is string => Boolean(id))))]);
    const appById = new Map(apps.map((a) => [a.id, a]));
    const refById = new Map(purchases.map((p) => [p.id, p.ref]));
    const icons = await this.refsMap(apps.map((a) => a.icon_id), 'thumb');
    const customers = this.ctx.tryUse('customers');
    const people = new Map(
      await Promise.all(
        unique(rows.map((e) => e.customer_id)).map(async (id) => {
          const c = customers ? await this.soft('customers.getCustomer', () => customers.getCustomer(id), null) : null;
          return [id, { name: c?.displayName ?? null, email: c?.email ?? null }] as const;
        }),
      ),
    );
    return rows.map((e) => {
      const a = appById.get(e.app_id);
      const free = a?.free ?? false;
      return {
        id: e.id,
        app: { id: e.app_id, slug: a?.slug ?? '', title: a?.title ?? 'Deleted app', icon: a?.icon_id ? (icons.get(a.icon_id) ?? null) : null },
        free,
        customer: { id: e.customer_id, ...(people.get(e.customer_id) ?? { name: null, email: null }) },
        source: e.source,
        ownedAt: e.created_at.toISOString(),
        purchaseId: e.purchase_id,
        purchaseRef: e.purchase_id ? (refById.get(e.purchase_id) ?? null) : null,
        grantedBy: e.granted_by,
        licenceKey: free ? null : e.licence_key,
        licenceIssuedAt: !free && e.licence_issued_at ? e.licence_issued_at.toISOString() : null,
        licenceReissues: e.licence_reissues ?? 0,
      };
    });
  }

  /**
   * GET /admin/software/entitlements: an app's owners, a customer's apps, or a search (q) by licence key (typed with
   * or without dashes), SW- purchase reference, or the customer's email or name (customers' search).
   */
  async listEntitlementsAdmin(q: { appId?: string; customerId?: string; q?: string }, page: PageRequest): Promise<Page<EntitlementAdmin>> {
    const term = q.q?.trim();
    const f: Parameters<typeof this.repo.pageAdminEntitlements>[0] = { appId: q.appId, customerId: q.customerId };
    if (term) {
      const key = normaliseLicenceKey(term);
      if (key) f.licenceKey = key;
      else if (/^SW-/i.test(term)) f.purchaseIds = (await this.repo.purchasesByRef(term.toUpperCase())).map((p) => p.id);
      else {
        const customers = this.ctx.tryUse('customers');
        const found = customers ? await this.soft('customers.searchCustomers', () => customers.searchCustomers({ search: term }, { limit: 50 }), null) : null;
        f.customerIds = found?.items.map((c) => c.id) ?? [];
      }
    }
    const paged = await this.repo.pageAdminEntitlements(f, page);
    return { ...paged, items: await this.entitlementsAdmin(paged.items) };
  }

  /**
   * Replaces an owner's licence key (a leaked or mistyped key): a new key, the old one stops working. Audited with
   * the reason and the keys' last five characters; the customer is told (software.licence.reissued).
   */
  async reissueLicence(id: string, input: ReissueLicenceInput, by: By): Promise<EntitlementAdmin> {
    const reason = requireText(input?.reason, 'reason', 500, 'Give a reason');
    const e = await this.repo.getEntitlement(id);
    if (!e) throw notFound('Entitlement');
    const a = await this.repo.getApp(e.app_id);
    if (!a) throw notFound('App');
    if (a.free) throw this.ctx.error('NO_LICENCE', 'The app is free, so there is no licence key to replace.');
    const key = await this.newLicenceKey();
    const { before, after } = await this.repo.transaction(async (tx) => {
      const x = (await tx.getEntitlement(id, { forUpdate: true }))!;
      const row = (await tx.updateEntitlement(x.id, { licence_key: key, licence_issued_at: this.now(), licence_reissues: (x.licence_reissues ?? 0) + 1 }))!;
      return { before: x, after: row };
    });
    await this.audit(
      { action: 'software.licence.reissue', actionLabel: 'Replaced a licence key', category: 'customers', target: { type: 'customer', id: after.customer_id, label: a.title }, reason, before: { licenceKey: keyTail(before.licence_key) }, after: { licenceKey: keyTail(after.licence_key), reissues: after.licence_reissues } },
      by,
    );
    this.ctx.events.publish('software.licence.reissued', { entitlementId: after.id, customerId: after.customer_id, appId: a.id, slug: a.slug, title: a.title }, { actor: by.actor, ...(by.requestId ? { requestId: by.requestId } : {}) });
    return (await this.entitlementsAdmin([after]))[0]!;
  }

  /* ---------------------------------------------------------------- events from payments */

  /** payments.purchase.authorized (module software): capture and mark paid (a payment that was pending, or a challenge finished elsewhere) */
  async onPurchaseAuthorizedFromPayments(e: EventPayload<'payments.purchase.authorized'>): Promise<void> {
    if (e.module !== 'software') return;
    const p = await this.repo.getPurchase(e.refId);
    if (!p) return void this.ctx.log.info({ purchaseId: e.refId }, 'software: authorized payment for an unknown purchase');
    if (p.intent_id !== e.intentId || !OPEN.includes(p.status)) return; // settled already, or an older attempt
    await this.settle(p.id, e.intentId, 'accepted', { actor: SYSTEM });
  }

  /** payments.purchase.failed (module software): mark the purchase failed */
  async onPurchaseFailedFromPayments(e: EventPayload<'payments.purchase.failed'>): Promise<void> {
    if (e.module !== 'software') return;
    const p = await this.repo.getPurchase(e.refId);
    if (!p) return void this.ctx.log.info({ purchaseId: e.refId }, 'software: failed payment for an unknown purchase');
    if (p.intent_id !== e.intentId || !OPEN.includes(p.status)) return;
    await this.markFailed(p.id, e.intentId, { actor: SYSTEM });
  }

  /* ---------------------------------------------------------------- jobs */

  /** software.abandon-stale: purchases left in requires_action for 30 minutes are cancelled and their intents voided */
  async abandonStale(): Promise<void> {
    const before = new Date(this.now().getTime() - ABANDON_AFTER_MS);
    for (let round = 0; round < 20; round++) {
      const stale = await this.repo.staleChallenges(before, 100);
      if (!stale.length) return;
      for (const p of stale) {
        try {
          if (p.intent_id) await this.payments.voidIntent(p.intent_id, 'Bank confirmation not finished within 30 minutes');
          await this.repo.transaction(async (tx) => {
            const x = (await tx.getPurchase(p.id, { forUpdate: true }))!;
            if (x.status !== 'requires_action') return;
            await tx.updatePurchase(x.id, { status: softwarePurchaseMachine.next(x.status, 'abandon') as PurchaseStatus, updated_at: this.now() });
          });
        } catch (err) {
          this.ctx.log.warn({ err, purchaseId: p.id }, 'software: stale purchase not abandoned');
        }
      }
      if (stale.length < 100) return;
    }
  }

  /* ---------------------------------------------------------------- data export */

  /** The customer's software purchases, owned apps and reviews for the personal data export */
  async exportCustomerData(input: { customerId: string; accountId: string }): Promise<common.CustomerDataSection[]> {
    const [purchases, owned, reviews] = await Promise.all([this.repo.customerPurchases(input.customerId), this.repo.customerEntitlements(input.customerId), this.repo.customerReviews(input.customerId)]);
    const apps = new Map((await this.repo.appsByIds(unique([...owned.map((e) => e.app_id), ...reviews.map((r) => r.app_id)]))).map((a) => [a.id, a]));
    return [
      {
        key: 'software_purchases',
        title: 'Software purchases',
        module: 'software',
        records: purchases.map((p) => ({ ref: p.ref, title: p.title, apps: itemsOf(p.items).map((i) => i.title), amount: { amount: Number(p.amount), currency: p.currency }, status: p.status, method: p.method_label, createdAt: p.created_at.toISOString(), paidAt: p.paid_at?.toISOString() ?? null })),
      },
      { key: 'software_apps', title: 'Apps you own', module: 'software', records: owned.map((e) => ({ app: apps.get(e.app_id)?.title ?? 'Deleted app', source: e.source, ownedAt: e.created_at.toISOString(), licenceKey: e.licence_key })) },
      { key: 'software_reviews', title: 'App reviews', module: 'software', records: reviews.map((r) => ({ app: apps.get(r.app_id)?.title ?? 'Deleted app', stars: r.stars, text: r.text, hidden: r.hidden, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() })) },
    ];
  }

}
