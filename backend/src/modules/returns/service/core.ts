/**
 * Shared plumbing of the returns use cases: time, settings, events, audit, optional modules, the return
 * aggregate, timelines and the baseline in force. The use cases live in the part classes.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isAppError, isNotImplemented } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { BusinessDays } from '../../../kernel/lib/business-days.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type { ShippingResponsibility } from '../../../spec/returns.js';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import { DEFAULT_POLICY_ID, defaultResponsibilities, OFFICIAL_RETURN_ADDRESS } from '../domain/rules.js';
import type { DraftRec, EventRec, EvidenceRec, InspectionRec, ItemRec, PolicyRec, RefundRec, ReplacementRec, ReturnRec, ShipmentRec, TermsRec } from '../ports.js';
import type { ReturnsRepository } from '../repository.js';

export interface ReturnsServiceDeps {
  repo: ReturnsRepository;
  ctx: ModuleContext<'returns'>;
}

/** Who acts, as the HTTP layer (or an event) knows it */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
  /** Whether the caller holds a permission (REST handlers) */
  can?: (permission: string) => Promise<boolean>;
}

/** One return with everything a view needs */
export interface Agg {
  ret: ReturnRec;
  items: ItemRec[];
  shipments: ShipmentRec[];
  refunds: RefundRec[];
  replacements: ReplacementRec[];
  inspections: InspectionRec[];
  draft: DraftRec | null;
  evidence: EvidenceRec[];
  events: EventRec[];
}

/** The platform baseline as the rules use it */
export interface Baseline {
  id: string;
  version: string;
  status: string;
  windowDays: number;
  sellerResponseBusinessDays: number;
  infoReplyDays: number;
  dropOffDays: number;
  inspectionTargetBusinessDays: number;
  refundTargetBusinessDays: number;
  responsibilities: ShippingResponsibility[];
  effectiveFrom: Date | null;
  rec: PolicyRec | null;
}

type OwnEvent = keyof EventMap & `returns.${string}`;
type Optional = Parameters<ModuleContext<'returns'>['tryUse']>[0];

/** Events collected inside a transaction and published after the commit */
export class Batch {
  readonly events: { name: OwnEvent; payload: unknown }[] = [];
  constructor(readonly by: By) {}
  push<N extends OwnEvent>(name: N, payload: EventMap[N]) {
    this.events.push({ name, payload });
  }
}

export const SYSTEM: common.Actor = { kind: 'system', id: null };

export const invalid = (issues: { path: string; message: string }[], message = 'Some details need fixing') => new AppError('VALIDATION_FAILED', message, { issues });
export const invalidField = (path: string, message: string) => invalid([{ path, message }], message);
export const notFound = (what = 'Return') => new AppError('NOT_FOUND', `${what} not found`);
export const unavailable = (what: string) => new AppError('SERVICE_UNAVAILABLE', `${what} is unavailable right now`, undefined, 503);
export const illegal = (message: string, details?: Record<string, unknown>) => new AppError('ILLEGAL_TRANSITION', message, details);

/** Who is looking: the store shopper (customer or guest session), a seller, or staff */
export type Visibility = { area: 'admin' } | { area: 'seller'; sellerId: string } | { area: 'store'; customerId?: string | null; guestSessionId?: string | null };

export interface TimelineEntry {
  kind: string;
  label: string;
  detail?: string | null;
  visibility: EventRec['visibility'];
  actor?: common.Actor;
}

export class Core {
  readonly repo: ReturnsRepository;
  readonly ctx: ModuleContext<'returns'>;

  constructor(deps: ReturnsServiceDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
  }

  now = () => this.ctx.clock.now();
  get tz() {
    return this.ctx.config.market.timeZone;
  }

  /** Business days for response, inspection and refund deadlines: the market's calendar (business hours, closures) */
  readonly businessDays = new BusinessDays({
    load: async () => this.ctx.tryUse('settings')?.businessCalendar(),
    timeZone: () => this.tz,
    now: () => this.now(),
    onError: (err) => this.ctx.log.warn({ err }, 'returns: business calendar unavailable, counting weekdays'),
  });
  addBusinessDays = (from: Date, days: number) => this.businessDays.add(from, days);
  get currency() {
    return this.ctx.config.market.currency || 'USD';
  }
  error = (code: string, message?: string, details?: unknown) => this.ctx.error(code, message, details);

  publish<N extends OwnEvent>(name: N, payload: EventMap[N], by: { actor?: common.Actor; requestId?: string } = {}) {
    this.ctx.events.publish(name as never, payload as never, { actor: by.actor ?? SYSTEM, ...(by.requestId ? { requestId: by.requestId } : {}) });
  }

  /** Publishes what a transaction collected (after the commit) */
  flush(batch: Batch) {
    for (const e of batch.events) this.publish(e.name, e.payload as never, batch.by);
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ category: 'returns', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      // the change is committed; a missing audit entry is logged, never turned into a failed request
      this.ctx.log[isNotImplemented(err) ? 'debug' : 'error']({ err, action: entry.action }, 'audit entry not recorded');
    }
  }

  /** An optional module's answer; off, not built or failing → undefined (the caller degrades) */
  async soft<M extends Optional, R>(module: M, what: string, fn: (api: PublicApiMap[M & keyof PublicApiMap]) => Promise<R>): Promise<R | undefined> {
    const api = this.ctx.tryUse(module) as PublicApiMap[M & keyof PublicApiMap] | undefined;
    if (!api) return undefined;
    try {
      return await fn(api);
    } catch (err) {
      if (!isAppError(err)) this.ctx.log.warn({ err, module, what }, 'returns: optional call failed');
      return undefined;
    }
  }

  /** A required module's answer where a view can do without it (estimates, payment panels) */
  async quiet<R>(what: string, fn: () => Promise<R>): Promise<R | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (!isAppError(err)) this.ctx.log.warn({ err, what }, 'returns: call failed');
      return undefined;
    }
  }

  walletOn(): boolean {
    return this.ctx.modules.includes('wallet');
  }

  async returnRef(): Promise<string> {
    return this.ctx.refs.next('RT', { digits: 4 });
  }

  async refundRef(): Promise<string> {
    const prefix = String((await this.ctx.settings.get('refundRefPrefix')) ?? 'RF-').replace(/-+$/, '') || 'RF';
    return this.ctx.refs.next(prefix, { digits: 4 });
  }

  async fee(): Promise<common.Money> {
    const f = (await this.ctx.settings.get('changeOfMindReturnFee')) as common.Money | null;
    return f && typeof f.amount === 'number' ? { amount: f.amount, currency: f.currency ?? this.currency } : { amount: 799, currency: this.currency };
  }

  /* ---------------------------------------------------------------- baseline and seller terms */

  async defaultBaseline(): Promise<Baseline> {
    const s = this.ctx.settings;
    const [windowDays, response] = await Promise.all([s.get('baselineWindowDays'), s.get('sellerResponseBusinessDays')]);
    return {
      id: DEFAULT_POLICY_ID,
      version: 'default',
      status: 'active',
      windowDays: Number(windowDays ?? 30),
      sellerResponseBusinessDays: Number(response ?? 2),
      infoReplyDays: 3,
      dropOffDays: 7,
      inspectionTargetBusinessDays: 2,
      refundTargetBusinessDays: 2,
      responsibilities: defaultResponsibilities(await this.fee()),
      effectiveFrom: null,
      rec: null,
    };
  }

  baselineOf(p: PolicyRec): Baseline {
    return {
      id: p.id,
      version: p.version,
      status: p.status,
      windowDays: p.window_days,
      sellerResponseBusinessDays: p.seller_response_business_days,
      infoReplyDays: p.info_reply_days,
      dropOffDays: p.drop_off_days,
      inspectionTargetBusinessDays: p.inspection_target_business_days,
      refundTargetBusinessDays: p.refund_target_business_days,
      responsibilities: p.responsibilities,
      effectiveFrom: p.effective_from,
      rec: p,
    };
  }

  /** The baseline in force now (settings fallback while no version is active) */
  async baseline(): Promise<Baseline> {
    const active = await this.repo.find('policy_versions', { status: 'active' }, { orderBy: [['effective_from', 'desc']], limit: 1 });
    return active[0] ? this.baselineOf(active[0]) : this.defaultBaseline();
  }

  /** The baseline that was in force at a time (orders keep what they accepted) */
  async baselineAt(at: Date): Promise<Baseline> {
    const rows = await this.repo.find('policy_versions', { status: ['active', 'superseded'], effective_from: { op: '<=', value: at } }, { orderBy: [['effective_from', 'desc']], limit: 1 });
    return rows[0] ? this.baselineOf(rows[0]) : this.baseline();
  }

  /** The seller's terms in force now, or at a time (the Official Store has none) */
  async sellerTerms(sellerId: string, at?: Date): Promise<TermsRec | null> {
    if (sellerId === OFFICIAL_STORE_ID) return null;
    if (!at) return (await this.repo.find('seller_terms', { seller_id: sellerId, superseded_at: null }, { orderBy: [['version', 'desc']], limit: 1 }))[0] ?? null;
    const rows = await this.repo.find('seller_terms', { seller_id: sellerId, effective_from: { op: '<=', value: at } }, { orderBy: [['version', 'desc']] });
    return rows.find((t) => !t.superseded_at || t.superseded_at.getTime() > at.getTime()) ?? (await this.sellerTerms(sellerId));
  }

  /* ---------------------------------------------------------------- loading */

  async loadMany(returnIds: readonly string[], repo: ReturnsRepository = this.repo): Promise<Map<string, Agg>> {
    const ids = [...new Set(returnIds)];
    const out = new Map<string, Agg>();
    if (!ids.length) return out;
    const [rets, items, shipments, refunds, replacements, inspections, drafts, evidence, events] = await repo.reads(
      () => repo.find('returns', { id: ids }),
      () => repo.find('return_items', { return_id: ids }, { orderBy: [['id', 'asc']] }),
      () => repo.find('return_shipments', { return_id: ids }, { orderBy: [['created_at', 'asc']] }),
      () => repo.find('refund_requests', { return_id: ids }, { orderBy: [['created_at', 'asc']] }),
      () => repo.find('replacements', { return_id: ids }, { orderBy: [['created_at', 'asc']] }),
      () => repo.find('inspections', { return_id: ids }, { orderBy: [['inspected_at', 'asc']] }),
      () => repo.find('inspection_drafts', { return_id: ids }),
      () => repo.find('return_evidence', { return_id: ids }, { orderBy: [['added_at', 'asc']] }),
      () => repo.find('return_events', { return_id: ids }, { orderBy: [['at', 'asc'], ['id', 'asc']] }),
    );
    for (const r of rets) out.set(r.id, { ret: r, items: [], shipments: [], refunds: [], replacements: [], inspections: [], draft: null, evidence: [], events: [] });
    for (const x of items) out.get(x.return_id)?.items.push(x);
    for (const x of shipments) out.get(x.return_id)?.shipments.push(x);
    for (const x of refunds) if (x.return_id) out.get(x.return_id)?.refunds.push(x);
    for (const x of replacements) if (x.return_id) out.get(x.return_id)?.replacements.push(x);
    for (const x of inspections) out.get(x.return_id)?.inspections.push(x);
    for (const x of drafts) {
      const a = out.get(x.return_id);
      if (a) a.draft = x;
    }
    for (const x of evidence) out.get(x.return_id)?.evidence.push(x);
    for (const x of events) out.get(x.return_id)?.events.push(x);
    return out;
  }

  async load(returnId: string, repo: ReturnsRepository = this.repo): Promise<Agg | undefined> {
    return (await this.loadMany([returnId], repo)).get(returnId);
  }

  /** Loads under a row lock on the return (writes serialize per return) */
  async lockAndLoad(tx: ReturnsRepository, returnId: string): Promise<Agg> {
    const locked = await tx.get('returns', returnId, { forUpdate: true });
    if (!locked) throw notFound();
    return (await this.load(returnId, tx))!;
  }

  /**
   * A return the caller may reach, or NOT_FOUND: customers their own returns, guest sessions the returns of
   * orders identity granted them, sellers only their own returns, staff any.
   */
  async visible(returnId: string, v: Visibility): Promise<Agg> {
    // REST takes the return id or its RT- reference (G69b)
    const agg = isUuid(returnId) ? await this.load(returnId) : /^RT-/i.test(String(returnId).trim()) ? await this.loadByRef(returnId) : undefined;
    if (!agg || !(await this.canSee(agg.ret, v))) throw notFound();
    return agg;
  }

  /** A return by its RT- reference */
  async loadByRef(ref: string): Promise<Agg | undefined> {
    const row = (await this.repo.find('returns', { ref: String(ref).trim().toUpperCase() }))[0];
    return row ? this.load(row.id) : undefined;
  }

  async canSee(ret: ReturnRec, v: Visibility): Promise<boolean> {
    if (v.area === 'admin') return true;
    if (v.area === 'seller') return ret.owner_type === 'seller' && ret.seller_id === v.sellerId;
    if (v.customerId && ret.customer_id === v.customerId) return true;
    if (v.guestSessionId) {
      if (ret.guest_session_id === v.guestSessionId) return true;
      return Boolean(await this.soft('identity', 'guest order access', (i) => i.hasGuestOrderAccess(v.guestSessionId!, ret.order_id)));
    }
    return false;
  }

  /** Runs a write on one return: lock, change, commit, then publish */
  async write<T>(returnId: string, by: By, fn: (tx: ReturnsRepository, agg: Agg, batch: Batch) => Promise<T>): Promise<T> {
    const batch = new Batch(by);
    const result = await this.repo.transaction(async (tx) => {
      const agg = await this.lockAndLoad(tx, returnId);
      return fn(tx, agg, batch);
    });
    this.flush(batch);
    return result;
  }

  /** Adds timeline entries to a return (inside the transaction) */
  async timeline(tx: ReturnsRepository, returnId: string, entries: TimelineEntry[]) {
    const at = this.now();
    await tx.insertMany(
      'return_events',
      entries.map((e, i) => ({
        id: newId(),
        return_id: returnId,
        kind: e.kind,
        label: e.label,
        detail: e.detail ?? null,
        visibility: e.visibility,
        actor_kind: e.actor?.kind ?? 'system',
        actor_id: e.actor?.id ?? null,
        at: new Date(at.getTime() + i),
      })),
    );
  }

  /** The newest live shipment of a return */
  shipmentOf(agg: Agg): ShipmentRec | null {
    return agg.shipments.at(-1) ?? null;
  }

  /** The refund request that represents the return's money (latest not cancelled) */
  refundOf(agg: Agg): RefundRec | null {
    return [...agg.refunds].reverse().find((r) => r.status !== 'cancelled') ?? agg.refunds.at(-1) ?? null;
  }

  replacementOf(agg: Agg): ReplacementRec | null {
    return agg.replacements.at(-1) ?? null;
  }

  inspectionOf(agg: Agg): InspectionRec | null {
    return agg.inspections.at(-1) ?? null;
  }

  /* ---------------------------------------------------------------- event payload parts */

  /** Who customer-facing events reach: the customer, or the order's contact email for guests */
  recipient(ret: ReturnRec): { customerId: string | null; contactEmail: string | null } {
    return { customerId: ret.customer_id, contactEmail: ret.terms_snapshot.meta.contactEmail ?? null };
  }

  /** The recipient of a refund request: its return's, what the request stored, or the order's contact */
  async refundRecipient(rr: RefundRec, ret?: ReturnRec | null): Promise<{ customerId: string | null; contactEmail: string | null }> {
    if (ret) return this.recipient(ret);
    if (rr.customer_id || rr.contact_email) return { customerId: rr.customer_id, contactEmail: rr.contact_email };
    const order = await this.quiet('order contact', () => this.ctx.use('orders').getOrder(rr.order_id));
    return { customerId: order?.contact.customerId ?? null, contactEmail: order?.contact.email ?? null };
  }

  /** ref, orderId and orderRef carried by every returns.return.* event */
  refs(r: ReturnRec): { ref: string; orderId: string; orderRef: string } {
    return { ref: r.ref, orderId: r.order_id, orderRef: r.order_ref };
  }

  /** owner and fulfilment carried by the returns.return.* events that name the seller */
  owner(r: ReturnRec): { ownerType: ReturnRec['owner_type']; sellerId: string | null; fulfilledBy: ReturnRec['fulfilled_by'] } {
    return { ownerType: r.owner_type, sellerId: r.seller_id, fulfilledBy: r.fulfilled_by };
  }

  /**
   * A Fulfilled by Marketly return (decision D7): Marketly handles it from the request (platform handling), it
   * comes back to the Marketly returns dock and Marketly inspects it; the seller funds the refund and follows it read-only.
   */
  isService(r: ReturnRec): boolean {
    return r.fulfilled_by === 'marketly_service';
  }

  /** Sellers never act on a Fulfilled by Marketly return */
  sellerMayAct(r: ReturnRec): void {
    if (this.isService(r)) throw illegal('Marketly handles returns of items it fulfils; you can follow this return here', { from: r.status, allowed: [] });
  }

  /** Where Official Store and Fulfilled by Marketly returns go (officialReturnAddress setting, Business Owner approval; decision D-RT1) */
  async officialReturnAddress(): Promise<common.Address> {
    const a = (await this.ctx.settings.get('officialReturnAddress').catch(() => null)) as common.Address | null;
    return a && typeof a === 'object' && a.line1 ? { ...a, name: a.name || OFFICIAL_RETURN_ADDRESS.name } : OFFICIAL_RETURN_ADDRESS;
  }

  /** returns.return.approved for a return (items and the label's tracking number included) */
  approvedEvent(a: Agg, o: { withoutReturn: boolean; platformDecision: boolean; shipment?: ShipmentRec | null }): EventMap['returns.return.approved'] {
    const r = a.ret;
    return {
      returnId: r.id,
      ...this.refs(r),
      ...this.recipient(r),
      ...this.owner(r),
      items: a.items.map((i) => ({ orderItemId: i.order_item_id, quantity: i.quantity })),
      withoutReturn: o.withoutReturn,
      platformDecision: o.platformDecision,
      dropOffBy: o.shipment?.drop_off_by?.toISOString() ?? null,
      trackingNumber: o.shipment?.tracking_number ?? null,
    };
  }

  /** The returned units with their variant and stock item (inventory and fulfillment restock from them) */
  returnedItems(a: Agg): EventMap['returns.return.received']['items'] {
    const stock = a.ret.terms_snapshot.meta.stockItems ?? {};
    return a.items.map((i) => ({ orderItemId: i.order_item_id, quantity: i.quantity, variantId: i.variant_id, stockItemId: stock[i.order_item_id] ?? null }));
  }

  /** When the parcel reached the destination: the recorded receipt time, else the carrier's delivery */
  receivedAt(agg: Agg): Date | null {
    return agg.ret.received_at ?? this.shipmentOf(agg)?.delivered_at ?? null;
  }
}
