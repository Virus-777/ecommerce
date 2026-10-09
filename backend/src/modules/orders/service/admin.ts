/**
 * Staff tools and documents: internal notes, confirmation resends, saved filters, exports through reports
 * (datasets orders.admin.orders and orders.seller.orders, rows from exportRows with contact masking),
 * receipts, invoices, credit notes and packing slips rendered from the frozen order.
 */
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as identity from '../../../spec/identity.js';
import type * as reports from '../../../spec/reports.js';
import type { DocumentLink, InternalNote, SavedFilter } from '../../../spec/orders.js';
import { renderPdf, type PdfPage } from '../domain/pdf.js';
import { buyerName, fmt, maskEmail, maskPhone, shortDate, variantLabelOf } from '../domain/rules.js';
import type { DocumentRec, GroupRec } from '../ports.js';
import { invalid, notFound, unavailable, type Agg, type By, type Core } from './core.js';
import type { AdminListQuery, Reads, SellerListQuery } from './reads.js';
import type { Views } from './views.js';

export const ADMIN_DATASET = 'orders.admin.orders';
export const SELLER_DATASET = 'orders.seller.orders';
/** Customer email and phone are masked in admin reads and exports without it */
export const CONTACT_PERMISSION = 'orders.customers.view-contact';
/** Formerly set on export filters; never trusted, dropped when a request carries it */
const LEGACY_CONTACT_KEY = '__ordersContactVisible';

export class Admin {
  #registered?: Promise<void>;

  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly reads: Reads,
  ) {}

  /* ---------------------------------------------------------------- notes and confirmations */

  async addNote(orderId: string, text: string, by: By): Promise<InternalNote> {
    if (!text?.trim()) throw invalid([{ path: 'text', message: 'Write the note' }]);
    const agg = await this.reads.adminOrder(orderId);
    const row = await this.core.repo.insert('notes', { id: newId(), order_id: orderId, text: text.trim(), author_id: by.actor.id ?? by.principal?.accountId ?? newId(), author_name: by.actor.name ?? 'Staff', at: this.core.now() });
    await this.core.audit({ action: 'orders.note.add', actionLabel: 'Added an internal note', category: 'orders', target: { type: 'order', id: orderId, ref: agg.order.ref, label: `Order ${agg.order.ref}`, screen: 'admin/order' }, after: { text: row.text } }, by);
    return this.views.note(row);
  }

  async resendConfirmation(orderId: string, email: string | null | undefined, by: By): Promise<void> {
    const agg = await this.reads.adminOrder(orderId);
    if (agg.order.lifecycle === 'payment_pending' || agg.order.lifecycle === 'cancelled') throw new AppError('ILLEGAL_TRANSITION', 'Only confirmed orders have a confirmation to resend.', { from: agg.order.lifecycle });
    const to = email?.trim() || agg.order.contact_email;
    await this.core.repo.transaction(async (tx) => {
      await this.core.setFlags(tx, agg.order, (f) => ({ ...f, confirmationsResent: (f.confirmationsResent ?? 0) + 1 }));
      await this.core.timeline(tx, orderId, [{ visibility: 'staff', label: 'Confirmation resent', detail: to === agg.order.contact_email ? 'To the checkout email' : `To ${to}`, actor: by.actor }]);
    });
    this.core.publish('orders.confirmation.requested', { orderId, email: to }, by);
    await this.core.audit({ action: 'orders.confirmation.resend', actionLabel: 'Resent the order confirmation', category: 'orders', target: { type: 'order', id: orderId, ref: agg.order.ref, label: `Order ${agg.order.ref}`, screen: 'admin/order' }, after: { email: to } }, by);
  }

  /* ---------------------------------------------------------------- saved filters */

  private async savedFilter(row: Awaited<ReturnType<Core['repo']['get']>> & object, count: boolean): Promise<SavedFilter> {
    const r = row as unknown as { id: string; name: string; query: Record<string, unknown>; shared: boolean; owner_staff_id: string; cached_count: number | null; created_at: Date };
    let n = r.cached_count;
    if (count && n === null) {
      n = await this.countFor(r.query);
      await this.core.repo.update('saved_filters', r.id, { cached_count: n, counted_at: this.core.now() });
    }
    return { id: r.id, name: r.name, query: r.query, shared: r.shared, owner: { kind: 'staff', id: r.owner_staff_id }, count: n, createdAt: r.created_at.toISOString() };
  }

  private async countFor(query: Record<string, unknown>) {
    const f = await this.reads.adminFilter({ ...(query as AdminListQuery), savedFilterId: undefined }, null);
    return this.core.repo.adminCount(f, this.core.now());
  }

  async listSavedFilters(staffId: string): Promise<SavedFilter[]> {
    const rows = await this.core.repo.savedFiltersFor(staffId);
    const out: SavedFilter[] = [];
    for (const r of rows) out.push(await this.savedFilter(r as never, true));
    return out;
  }

  async createSavedFilter(staffId: string, body: { name: string; query: unknown; shared?: boolean | null }): Promise<SavedFilter> {
    const issues: { path: string; message: string }[] = [];
    if (!body.name?.trim()) issues.push({ path: 'name', message: 'Name the filter' });
    if (body.query === null || typeof body.query !== 'object' || Array.isArray(body.query)) issues.push({ path: 'query', message: 'The filter must be an object of list filters' });
    if (issues.length) throw invalid(issues);
    const now = this.core.now();
    const query = body.query as Record<string, unknown>;
    const row = await this.core.repo.insert('saved_filters', { id: newId(), owner_staff_id: staffId, name: body.name.trim(), query, shared: Boolean(body.shared), cached_count: null, counted_at: null, created_at: now });
    return this.savedFilter(row as never, true);
  }

  async deleteSavedFilter(staffId: string, id: string, canManage: boolean): Promise<void> {
    const row = await this.core.repo.get('saved_filters', id);
    if (!row || (!row.shared && row.owner_staff_id !== staffId)) throw notFound('Saved filter');
    if (row.owner_staff_id !== staffId && !canManage) throw new AppError('FORBIDDEN', 'Only its owner or an orders manager can delete a shared filter.');
    await this.core.repo.remove('saved_filters', id);
  }

  /** Refreshes saved filter counts (orders.refresh-flags) */
  async countSavedFilters() {
    const rows = await this.core.repo.find('saved_filters', {});
    for (const r of rows) await this.core.repo.update('saved_filters', r.id, { cached_count: await this.countFor(r.query ?? {}), counted_at: this.core.now() });
  }

  /* ---------------------------------------------------------------- exports */

  registerDatasets(): Promise<void> {
    const api = this.core.ctx.tryUse('reports');
    if (!api) return Promise.resolve();
    const common = [
      { key: 'ref', label: 'Order' },
      { key: 'placedAt', label: 'Placed' },
    ];
    this.#registered ??= Promise.all([
      api.registerDataset({
        key: ADMIN_DATASET,
        owner: 'orders',
        title: 'Orders',
        permission: 'orders.orders.export',
        audience: 'staff',
        screens: ['admin/orders'],
        available: true,
        phase: 1,
        columns: [
          ...common,
          { key: 'customerName', label: 'Customer' },
          { key: 'customerEmail', label: 'Email' },
          { key: 'customerPhone', label: 'Phone' },
          { key: 'city', label: 'City' },
          { key: 'guest', label: 'Guest' },
          { key: 'sellers', label: 'Sellers' },
          { key: 'itemCount', label: 'Items' },
          { key: 'total', label: 'Total' },
          { key: 'paymentState', label: 'Payment' },
          { key: 'fulfillmentStatus', label: 'Fulfillment' },
          { key: 'lateBy', label: 'Late by' },
          { key: 'flags', label: 'Flags' },
        ],
      }),
      api.registerDataset({
        key: SELLER_DATASET,
        owner: 'orders',
        title: 'My orders',
        permission: 'orders.fulfillment.export',
        audience: 'seller',
        screens: ['seller/orders'],
        available: true,
        phase: 1,
        columns: [
          ...common,
          { key: 'buyerName', label: 'Buyer' },
          { key: 'items', label: 'Items' },
          { key: 'units', label: 'Units' },
          { key: 'total', label: 'Total' },
          { key: 'status', label: 'Status' },
          { key: 'dispatchBy', label: 'Dispatch by' },
          { key: 'deadline', label: 'Deadline' },
        ],
      }),
    ])
      .then(() => undefined)
      .catch((err) => {
        this.#registered = undefined;
        if (!isNotImplemented(err)) this.core.ctx.log.warn({ err }, 'orders: export datasets not registered');
      });
    return this.#registered;
  }

  private reportsApi() {
    const api = this.core.ctx.tryUse('reports');
    if (!api) throw unavailable('Exports');
    return api;
  }

  async requestExport(dataset: string, body: { filters: unknown; columns?: string[] | null; format: 'csv' }, principal: identity.Principal, by: By, o: { sellerId?: string } = {}): Promise<reports.ExportJob> {
    const api = this.reportsApi();
    await this.registerDatasets();
    const raw = body.filters && typeof body.filters === 'object' && !Array.isArray(body.filters) ? { ...(body.filters as Record<string, unknown>) } : {};
    delete raw[LEGACY_CONTACT_KEY];
    const filters = { ...raw, ...(body.columns?.length ? { columns: body.columns } : {}) };
    const job = await api.requestExport({ dataset, filters, format: body.format, principal, ...(o.sellerId ? { sellerId: o.sellerId } : {}) });
    const label = dataset === ADMIN_DATASET ? 'Exported the order list' : 'Exported own orders';
    await this.core.audit({ action: 'orders.export', actionLabel: label, category: 'orders', target: { type: 'export', id: job.id, ref: job.ref, label, screen: dataset === ADMIN_DATASET ? 'admin/orders' : 'seller/orders' }, after: { dataset, filters: raw, format: body.format, sellerId: o.sellerId ?? null } }, by);
    return job;
  }

  async getExport(id: string, principal: identity.Principal, dataset: string, sellerId?: string): Promise<reports.ExportJob> {
    const job = await this.reportsApi().getExport(id, principal);
    if (!job || job.dataset !== dataset || (sellerId && job.sellerId && job.sellerId !== sellerId)) throw notFound('Export');
    return job;
  }

  /** Rows for reports (seller rows are the seller's own groups; contact masked unless the requester may see it) */
  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    const f = (filters && typeof filters === 'object' ? filters : {}) as Record<string, unknown>;
    const page = { mode: 'cursor' as const, cursor: cursor ?? null, limit: 100 };
    if (dataset === ADMIN_DATASET) {
      if (principal.kind !== 'staff') throw new AppError('FORBIDDEN', 'Staff only');
      // the requester's own answer (the kernel resolves it as their request did), never a flag in the filters
      const contact = await this.core.can(principal, CONTACT_PERMISSION);
      const rows = await this.core.repo.adminOrders(await this.reads.adminFilter(f as AdminListQuery, principal.accountId ?? null), page, this.core.now());
      const aggs = await this.core.loadMany(rows.items.map((r) => r.id));
      return {
        rows: rows.items.map((r) => {
          const agg = aggs.get(r.id)!;
          const row = this.views.adminRow(agg);
          return {
            ref: row.ref,
            placedAt: row.placedAt,
            customerName: row.customerName,
            customerEmail: contact ? agg.order.contact_email : maskEmail(agg.order.contact_email),
            customerPhone: contact ? agg.order.contact_phone : maskPhone(agg.order.contact_phone),
            city: row.customerCity,
            guest: row.guest,
            sellers: row.sellers.map((s) => s.name).join(', '),
            itemCount: row.itemCount,
            total: fmt(row.total.amount, row.total.currency),
            paymentState: row.paymentState,
            fulfillmentStatus: row.fulfillmentStatus,
            lateBy: row.lateBy ?? '',
            flags: row.flags.map((x) => x.label).join(', '),
          };
        }),
        ...(rows.nextCursor ? { nextCursor: rows.nextCursor } : {}),
      };
    }
    if (dataset === SELLER_DATASET) {
      const sellerId = principal.sellerId;
      if (!sellerId) throw new AppError('FORBIDDEN', 'Seller only');
      const rows = await this.core.repo.sellerGroups(sellerId, this.reads.sellerFilter(f as SellerListQuery), page, this.core.now());
      const aggs = await this.core.loadMany(rows.items.map((g) => g.order_id));
      const cfg = await this.core.cfg();
      return {
        rows: rows.items.map((g) => {
          const agg = aggs.get(g.order_id)!;
          const row = this.views.sellerRow(agg, agg.groups.find((x) => x.id === g.id)!, cfg);
          return { ref: row.ref, placedAt: row.placedAt, buyerName: row.buyerName, items: row.itemsSummary, units: row.units, total: fmt(row.total.amount, row.total.currency), status: row.statusLabel, dispatchBy: row.dispatchDeadline.dueAt, deadline: row.deadlineLabel };
        }),
        ...(rows.nextCursor ? { nextCursor: rows.nextCursor } : {}),
      };
    }
    throw notFound(`Dataset ${dataset}`);
  }

  /* ---------------------------------------------------------------- documents */

  private lineRows(agg: Agg, g: GroupRec, prices: boolean): PdfPage['lines'] {
    const out: PdfPage['lines'] = [];
    for (const i of agg.items.filter((x) => x.group_id === g.id)) {
      const label = `${i.quantity} × ${i.product_snapshot.title}${variantLabelOf(i.product_snapshot.options) ? ` (${variantLabelOf(i.product_snapshot.options)})` : ''}`;
      const state = i.state === 'cancelled' ? ' [cancelled]' : '';
      out.push({ text: prices ? `${label}${state}  ${fmt(i.unit_price * i.quantity, agg.order.currency)}` : `${label}${state}` });
      if (i.offer_snapshot.condition && i.offer_snapshot.condition !== 'new') out.push({ text: `   Condition: ${i.offer_snapshot.conditionLabel ?? i.offer_snapshot.condition}`, size: 8 });
    }
    return out;
  }

  private documentPages(agg: Agg, d: DocumentRec): PdfPage[] {
    const o = agg.order;
    const c = o.currency;
    const a = o.delivery_address;
    const head: PdfPage['lines'] = [
      { text: 'Marketly', bold: true, size: 16 },
      { text: d.kind === 'receipt' ? 'Order receipt' : d.kind === 'invoice' ? 'Invoice' : 'Credit note', bold: true, size: 13, gap: 6 },
      { text: `Number ${d.number} · Order ${o.ref} · Placed ${shortDate(o.placed_at, this.core.tz)}` },
      { text: `Bill to ${o.contact_name}, ${a.line1}${a.line2 ? `, ${a.line2}` : ''}, ${a.city}, ${a.region} ${a.postalCode}` },
    ];
    const groups = d.group_id ? agg.groups.filter((g) => g.id === d.group_id) : agg.groups;
    const body: PdfPage['lines'] = [];
    for (const g of groups) {
      body.push({ text: `Sold by ${this.views.sellerLabel(g).name}`, bold: true, gap: 8 });
      body.push(...this.lineRows(agg, g, true));
      body.push({ text: `Items ${fmt(g.items_total, c)} · Discounts -${fmt(g.discount_total, c)} · Shipping ${fmt(g.shipping_total, c)} · Tax ${fmt(g.tax_total, c)} · Total ${fmt(g.total, c)}` });
    }
    if (d.kind === 'receipt') body.push({ text: `Order total ${fmt(o.total, c)} paid with ${o.payment_method_label}`, bold: true, gap: 8 });
    if (d.kind === 'credit_note') {
      const credited = agg.cancellations.filter((x) => x.group_id === d.group_id && x.status === 'accepted');
      body.push({ text: 'Credited', bold: true, gap: 8 });
      for (const x of credited) for (const l of x.refund_preview.lines) body.push({ text: `${l.quantity} × ${l.title}  ${fmt(l.refund.amount, c)}` });
    }
    for (const p of o.policy_versions ?? []) body.push({ text: `Accepted ${p.policyKey.replace('_', ' ')} policy version ${p.version}`, size: 8 });
    return [{ lines: [...head, ...body] }];
  }

  private async link(owner: { kind: 'seller' | 'staff' | 'customer' | 'guest' | 'platform'; id?: string | null; label?: string | null }, fileName: string, pdf: Uint8Array, principal: identity.Principal): Promise<DocumentLink> {
    const media = this.core.ctx.tryUse('media');
    if (!media) throw unavailable('Documents');
    const asset = await media.storeGeneratedFile({ owner, fileName, contentType: 'application/pdf', body: new Blob([Buffer.from(pdf)]).stream(), ttlHours: 1, purpose: 'statement' });
    const link = await media.signedDownload(asset.id, principal, 'Order document');
    return { url: link.url, fileName: link.fileName, expiresAt: link.expiresAt };
  }

  ownerOf(principal: identity.Principal) {
    if (principal.kind === 'customer') return { kind: 'customer' as const, id: principal.accountId ?? null };
    if (principal.kind === 'visitor') return { kind: 'guest' as const, id: principal.guestSessionId ?? principal.sessionId };
    if (principal.kind === 'seller') return { kind: 'seller' as const, id: principal.sellerId ?? null };
    return { kind: 'staff' as const, id: principal.accountId ?? null };
  }

  async downloadDocument(agg: Agg, documentId: string, principal: identity.Principal): Promise<DocumentLink> {
    const d = agg.documents.find((x) => x.id === documentId);
    if (!d) throw notFound('Document');
    return this.link(this.ownerOf(principal), `${d.number}.pdf`, renderPdf(this.documentPages(agg, d)), principal);
  }

  private slip(agg: Agg, g: GroupRec, hidePrices: boolean): PdfPage {
    const a = agg.order.delivery_address;
    return {
      lines: [
        { text: 'Packing slip', bold: true, size: 14 },
        { text: `Order ${agg.order.ref} · Package ${g.position} of ${agg.groups.length}` },
        { text: `Ship to ${a.name}, ${a.line1}${a.line2 ? `, ${a.line2}` : ''}, ${a.city}, ${a.region} ${a.postalCode}, ${a.country}` },
        { text: `Buyer ${buyerName(agg.order.contact_name)}` },
        ...(agg.order.gift_note ? [{ text: `Gift note: ${agg.order.gift_note}` }] : []),
        { text: 'Items', bold: true, gap: 8 },
        ...this.lineRows(
          { ...agg, items: agg.items.filter((i) => i.state !== 'cancelled') },
          g,
          !hidePrices,
        ),
      ],
    };
  }

  async packingSlip(sellerId: string, groupId: string, hidePrices: boolean | undefined, principal: identity.Principal): Promise<DocumentLink> {
    const { agg, group } = await this.reads.sellerGroup(sellerId, groupId);
    return this.link({ kind: 'seller', id: sellerId }, `packing-slip-${agg.order.ref}-${group.position}.pdf`, renderPdf([this.slip(agg, group, hidePrices ?? agg.order.hide_prices)]), principal);
  }

  async packingSlips(sellerId: string, ids: string[], hidePrices: boolean | null | undefined, principal: identity.Principal, tasks: Map<string, GroupRec[]>): Promise<DocumentLink> {
    if (!ids.length) throw invalid([{ path: 'orderIds', message: 'Choose at least one order' }]);
    const groups = ids.flatMap((id) => tasks.get(id) ?? []);
    if (!groups.length) throw notFound();
    const aggs = await this.core.loadMany(groups.map((g) => g.order_id));
    const pages = groups.map((g) => {
      const agg = aggs.get(g.order_id)!;
      return this.slip(agg, agg.groups.find((x) => x.id === g.id)!, hidePrices ?? agg.order.hide_prices);
    });
    return this.link({ kind: 'seller', id: sellerId }, `packing-slips-${this.core.today()}.pdf`, renderPdf(pages), principal);
  }
}
