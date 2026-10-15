/**
 * Shared plumbing of the orders use cases: time, settings, events, audit, the order aggregate, item
 * transitions (with the state log and orders.item.state_changed), line splits, timelines and the derived
 * statuses and flags recomputed after every change. The use cases live in the part classes.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import { orderItemMachine, orderLifecycleMachine } from '../domain/state-machines.js';
import { displayStatus, groupStatus, is, OPEN_GROUP, paidOf, splitMoney, MINUTE, WAREHOUSE_STAGE_ENTRY, type ItemState, type Lifecycle } from '../domain/rules.js';
import type { CancellationRec, DocumentRec, FactRec, FlagData, GroupRec, ItemRec, OrderRec, ShipmentRec, TimelineRec } from '../ports.js';
import type { OrdersRepository } from '../repository.js';

export interface OrdersServiceDeps {
  repo: OrdersRepository;
  ctx: ModuleContext<'orders'>;
}

/** Who acts, as the HTTP layer (or an event) knows it */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
}

/** Settings read before a transaction (settings use their own connection) */
export interface Cfg {
  dueSoonMinutes: number;
  sellerAddressVisibleDays: number;
  sellerCancellationResponse: string;
  officialCancelUntil: string;
  orderRefPrefix: string;
}

/** One order with everything a view needs */
export interface Agg {
  order: OrderRec;
  groups: GroupRec[];
  items: ItemRec[];
  cancellations: CancellationRec[];
  shipments: ShipmentRec[];
  documents: DocumentRec[];
  /** orders.order_facts rows (oldest first) and the views' reading of them */
  factRows: FactRec[];
  facts: FlagData;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The views' reading of an order's facts (orders.order_facts) */
export function factsOf(rows: readonly FactRec[]): FlagData {
  const f: FlagData = {};
  const of = (kind: FactRec['kind']) => rows.filter((r) => r.kind === kind);
  const captures = of('capture');
  if (captures.length) f.captures = captures.map((r) => ({ captureId: r.source_id, amount: r.amount ?? 0, at: r.at.toISOString() }));
  const chargebacks = of('chargeback');
  if (chargebacks.length) f.chargebacks = chargebacks.map((r) => ({ disputeId: r.source_id, kind: r.subkind ?? '', groupId: r.group_id, at: r.at.toISOString() }));
  const cases = of('case');
  if (cases.length) f.cases = cases.map((r) => ({ caseId: r.source_id, ref: r.ref ?? '', itemIds: r.item_ids ?? [], status: r.status ?? 'open', nextUpdateBy: iso(r.due_at) }));
  const issues = of('delivery_issue').filter((r) => r.status !== 'resolved'); // shipping.exception.resolved marks them
  if (issues.length) f.deliveryIssues = issues.map((r) => ({ exceptionId: r.source_id, kind: r.subkind ?? '', groupId: r.group_id ?? '', shipmentId: r.shipment_id, dueAt: iso(r.due_at) ?? r.at.toISOString(), customerAction: r.customer_action, at: r.at.toISOString() }));
  const restricted = of('seller_restricted');
  if (restricted.length) f.restrictedGroups = restricted.map((r) => r.group_id ?? r.source_id);
  const sent = of('refund_sent');
  if (sent.length) f.refundsSent = sent.map((r) => r.source_id);
  const approvals = of('refund_approval').filter((r) => r.status !== 'sent');
  if (approvals.length) f.refundApprovals = approvals.map((r) => ({ id: r.source_id, returnRef: r.ref, amount: r.amount ?? 0, itemIds: r.item_ids ?? [] }));
  const resent = of('confirmation_resent').length;
  if (resent) f.confirmationsResent = resent;
  return f;
}

/** A fact to record: kind and source, the rest optional */
export type NewFact = Pick<FactRec, 'kind' | 'source_id'> & Partial<Omit<FactRec, 'id' | 'order_id' | 'kind' | 'source_id'>>;

type OwnEvent = keyof EventMap & `orders.${string}`;
type Optional = Parameters<ModuleContext<'orders'>['tryUse']>[0];

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
export const notFound = (what = 'Order') => new AppError('NOT_FOUND', `${what} not found`);
export const unavailable = (what: string) => new AppError('SERVICE_UNAVAILABLE', `${what} is unavailable right now`, undefined, 503);

export class Core {
  readonly repo: OrdersRepository;
  readonly ctx: ModuleContext<'orders'>;

  constructor(deps: OrdersServiceDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
  }

  now = () => this.ctx.clock.now();
  get tz() {
    return this.ctx.config.market.timeZone;
  }
  today = (at: Date = this.now()) => dateInZone(at, this.tz);
  error = (code: string, message?: string, details?: unknown) => this.ctx.error(code, message, details);

  /** Seller actions on a Fulfilled by Marketly group: 409 FULFILLED_BY_MARKETLY (decision D6) */
  refuseMarketly(g: { fulfilled_by: string }, action: string) {
    if (g.fulfilled_by === 'marketly_service') {
      throw this.error('FULFILLED_BY_MARKETLY', `Marketly ships this package; you can't ${action}. The Order Manager handles its cancellations.`);
    }
  }

  async cfg(): Promise<Cfg> {
    const s = this.ctx.settings;
    const [dueSoonMinutes, sellerAddressVisibleDays, sellerCancellationResponse, officialCancelUntil, orderRefPrefix] = await Promise.all([
      s.get('dueSoonMinutes'),
      s.get('sellerAddressVisibleDays'),
      s.get('sellerCancellationResponse'),
      s.get('officialCancelUntil'),
      s.get('orderRefPrefix'),
    ]);
    return {
      dueSoonMinutes: Number(dueSoonMinutes ?? 120),
      sellerAddressVisibleDays: Number(sellerAddressVisibleDays ?? 30),
      sellerCancellationResponse: String(sellerCancellationResponse ?? 'next_business_day_17:00'),
      officialCancelUntil: String(officialCancelUntil ?? 'picking_started'),
      orderRefPrefix: String(orderRefPrefix ?? 'MK'),
    };
  }

  publish<N extends OwnEvent>(name: N, payload: EventMap[N], by: { actor?: common.Actor; requestId?: string } = {}) {
    this.ctx.events.publish(name as never, payload as never, { actor: by.actor ?? SYSTEM, ...(by.requestId ? { requestId: by.requestId } : {}) });
  }

  /** Whether a principal handed over in-process (export, admin read) holds a permission: the answer their request got */
  can(principal: { kind: string; accountId?: string | null } | null | undefined, permission: string): Promise<boolean> {
    return this.ctx.can(principal as Principal | null | undefined, permission);
  }

  /** Who a customer-facing event is for: the customers-module id (null for guests) and the order contact email */
  recipient(order: Pick<OrderRec, 'customer_id' | 'contact_email'>): { customerId: string | null; contactEmail: string } {
    return { customerId: order.customer_id, contactEmail: order.contact_email };
  }

  /** Publishes what a transaction collected (after the commit) */
  flush(batch: Batch) {
    for (const e of batch.events) this.publish(e.name, e.payload as never, batch.by);
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: By) {
    await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
  }

  /** An optional module's answer; off, not built or failing → undefined (the caller degrades) */
  async soft<M extends Optional, R>(module: M, what: string, fn: (api: PublicApiMap[M & keyof PublicApiMap]) => Promise<R>): Promise<R | undefined> {
    const api = this.ctx.tryUse(module) as PublicApiMap[M & keyof PublicApiMap] | undefined;
    if (!api) return undefined;
    try {
      return await fn(api);
    } catch (err) {
      if (!isAppError(err)) this.ctx.log.warn({ err, module, what }, 'orders: optional call failed');
      return undefined;
    }
  }

  /**
   * Current product slugs for product links (/p/{slug}/{id}), read from catalog in batches of 200. Products catalog
   * does not return (or a catalog failure) are left out: their links fall back to the id.
   */
  async productSlugs(productIds: Iterable<string>): Promise<Map<string, string>> {
    const ids = [...new Set(productIds)];
    const out = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 200) {
      try {
        for (const r of await this.ctx.use('catalog').getProducts(ids.slice(i, i + 200))) out.set(r.product.id, r.product.slug);
      } catch (err) {
        if (!isAppError(err)) this.ctx.log.warn({ err }, 'orders: product slugs unavailable');
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- loading */

  async loadMany(orderIds: readonly string[], repo: OrdersRepository = this.repo): Promise<Map<string, Agg>> {
    const ids = [...new Set(orderIds)];
    const out = new Map<string, Agg>();
    if (!ids.length) return out;
    // one read after another: inside a transaction (lockAndLoad) the session runs one operation at a time
    const orders = await repo.find('orders', { id: ids });
    const groups = await repo.find('seller_groups', { order_id: ids }, { orderBy: [['position', 'asc']] });
    const items = await repo.find('order_items', { order_id: ids }, { orderBy: [['id', 'asc']] });
    const cancellations = await repo.find('cancellations', { order_id: ids }, { orderBy: [['created_at', 'asc']] });
    const shipments = await repo.find('shipment_refs', { order_id: ids }, { orderBy: [['shipment_id', 'asc']] });
    const documents = await repo.find('documents', { order_id: ids }, { orderBy: [['issued_at', 'asc']] });
    const facts = await repo.find('order_facts', { order_id: ids }, { orderBy: [['at', 'asc'], ['id', 'asc']] });
    for (const o of orders) out.set(o.id, { order: o, groups: [], items: [], cancellations: [], shipments: [], documents: [], factRows: [], facts: {} });
    for (const g of groups) out.get(g.order_id)?.groups.push(g);
    for (const i of items) out.get(i.order_id)?.items.push(i);
    for (const c of cancellations) out.get(c.order_id)?.cancellations.push(c);
    for (const s of shipments) out.get(s.order_id)?.shipments.push(s);
    for (const d of documents) out.get(d.order_id)?.documents.push(d);
    for (const f of facts) out.get(f.order_id)?.factRows.push(f);
    for (const agg of out.values()) agg.facts = factsOf(agg.factRows);
    return out;
  }

  async load(orderId: string, repo: OrdersRepository = this.repo): Promise<Agg | undefined> {
    return (await this.loadMany([orderId], repo)).get(orderId);
  }

  /** Loads under a row lock on the order (writes serialize per order) */
  async lockAndLoad(tx: OrdersRepository, orderId: string): Promise<Agg> {
    const locked = await tx.get('orders', orderId, { forUpdate: true });
    if (!locked) throw notFound();
    return (await this.load(orderId, tx))!;
  }

  async timelineOf(orderId: string, visibility?: string[]): Promise<TimelineRec[]> {
    return this.repo.find('timeline', { order_id: orderId, ...(visibility ? { visibility: visibility as TimelineRec['visibility'][] } : {}) }, { orderBy: [['at', 'asc'], ['id', 'asc']] });
  }

  /** The latest Marketly warehouse stage label per Fulfilled by Marketly group of the orders (seller timeline entries) */
  async warehouseStages(orderIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!orderIds.length) return out;
    const rows = await this.repo.find('timeline', { order_id: [...new Set(orderIds)], visibility: 'seller', label: WAREHOUSE_STAGE_ENTRY }, { orderBy: [['at', 'asc'], ['id', 'asc']] });
    for (const r of rows) if (r.group_id && r.detail) out.set(r.group_id, r.detail);
    return out;
  }

  /* ---------------------------------------------------------------- writes (inside a transaction) */

  /** One item transition: row, state log and orders.item.state_changed */
  async move(tx: OrdersRepository, batch: Batch, item: ItemRec, event: string, o: { to?: string; reason?: string | null; patch?: Partial<ItemRec> } = {}): Promise<ItemRec> {
    const to = orderItemMachine.next(item.state as never, event as never, o.to as never);
    const at = this.now();
    const updated = await tx.update('order_items', item.id, { ...o.patch, state: to });
    await tx.insert('item_state_log', {
      id: newId(),
      item_id: item.id,
      from_state: item.state,
      to_state: to,
      event,
      reason: o.reason ?? null,
      actor_kind: batch.by.actor.kind,
      actor_id: batch.by.actor.id ?? null,
      at,
    });
    batch.push('orders.item.state_changed', { orderId: item.order_id, groupId: item.group_id, itemId: item.id, from: item.state, to, actor: batch.by.actor, at: at.toISOString() });
    return updated;
  }

  /**
   * Splits `part` units off a line: the part acted on keeps the line id (other modules refer to it), the rest
   * becomes a new line with splitFromItemId. Shares are re-allocated by largest remainder in cents.
   * Publishes orders.item.split (in the batch, before the events of the action that split the line) so inventory
   * and promotions split their per-item rows: itemId keeps `part` units (remainingQuantity), newItemId takes the rest.
   */
  async split(
    tx: OrdersRepository,
    batch: Batch,
    item: ItemRec,
    part: number,
    currency: string,
    reason: 'cancellation' | 'shipment' | 'return' | 'replacement',
  ): Promise<{ part: ItemRec; rest: ItemRec | null }> {
    if (part >= item.quantity) return { part: item, rest: null };
    const [a, b] = splitMoney(item, part, currency);
    const updated = await tx.update('order_items', item.id, { ...a, paid_amount: paidOf({ ...a, unit_price: item.unit_price }) });
    const rest = await tx.insert('order_items', { ...item, ...b, id: newId(), paid_amount: paidOf({ ...b, unit_price: item.unit_price }), split_from_item_id: item.id });
    batch.push('orders.item.split', {
      orderId: item.order_id,
      groupId: item.group_id,
      itemId: item.id,
      newItemId: rest.id,
      rootItemId: await this.rootOf(tx, item),
      offerId: item.offer_id,
      stockItemId: item.stock_item_id,
      quantity: rest.quantity,
      remainingQuantity: updated.quantity,
      reason,
      at: this.now().toISOString(),
    });
    return { part: updated, rest };
  }

  /** First line of a split chain (the line itself unless it was split off another) */
  private async rootOf(tx: OrdersRepository, item: ItemRec): Promise<string> {
    let current = item;
    for (let depth = 0; current.split_from_item_id && depth < 100; depth++) {
      const parent = await tx.get('order_items', current.split_from_item_id);
      if (!parent) break;
      current = parent;
    }
    return current.id;
  }

  async timeline(
    tx: OrdersRepository,
    orderId: string,
    entries: { group_id?: string | null; item_id?: string | null; visibility: TimelineRec['visibility']; label: string; detail?: string | null; reason?: string | null; actor?: common.Actor }[],
  ) {
    const at = this.now();
    await tx.insertMany(
      'timeline',
      entries.map((e, i) => ({
        id: newId(),
        order_id: orderId,
        group_id: e.group_id ?? null,
        item_id: e.item_id ?? null,
        visibility: e.visibility,
        label: e.label,
        detail: e.detail ?? null,
        reason: e.reason ?? null,
        actor_kind: e.actor?.kind ?? 'system',
        actor_id: e.actor?.id ?? null,
        actor_name: e.actor?.name ?? null,
        at: new Date(at.getTime() + i),
      })),
    );
  }

  /** OrderFlag kinds in force for an order */
  flagKinds(agg: Agg, now: Date, dueSoonMinutes: number): string[] {
    const { order, groups, items, cancellations } = agg;
    const f = agg.facts;
    const kinds: string[] = [];
    const open = order.lifecycle === 'open';
    const openGroups = groups.filter((g) => is(OPEN_GROUP, g.status));
    if (order.payment_state === 'failed') kinds.push('payment_failed');
    if (order.payment_state === 'pending_check' && order.lifecycle === 'payment_pending') kinds.push('payment_checking');
    if (open && openGroups.some((g) => g.dispatch_by.getTime() < now.getTime())) kinds.push('overdue_dispatch');
    else if (open && openGroups.some((g) => g.dispatch_by.getTime() - now.getTime() <= dueSoonMinutes * MINUTE)) kinds.push('due_soon');
    if (cancellations.some((c) => c.status === 'requested')) kinds.push('cancellation_requested');
    if (items.some((i) => i.state === 'return_requested')) kinds.push('return_requested');
    if ((f.cases ?? []).some((c) => !/resolved|closed/i.test(c.status))) kinds.push('case_open');
    if ((f.restrictedGroups ?? []).some((id) => groups.some((g) => g.id === id && !['delivered', 'cancelled', 'partly_cancelled'].includes(g.status)))) kinds.push('seller_restricted');
    if (f.chargebacks?.length) kinds.push('chargeback');
    if ((f.deliveryIssues ?? []).some((d) => groups.some((g) => g.id === d.groupId && !['delivered', 'cancelled', 'partly_cancelled'].includes(g.status)))) kinds.push('delivery_issue');
    return kinds;
  }

  /**
   * Recomputes group statuses, the overall display status and the flags of an order (inside the transaction),
   * and closes the order when every item is cancelled (publishing orders.order.cancelled).
   */
  async refreshDerived(tx: OrdersRepository, orderId: string, batch: Batch | null, cfg: Pick<Cfg, 'dueSoonMinutes'>): Promise<Agg> {
    const agg = (await this.load(orderId, tx))!;
    const now = this.now();
    for (const g of agg.groups) {
      const own = agg.items.filter((i) => i.group_id === g.id);
      const status = groupStatus(own);
      const shipped = own.filter((i) => i.state !== 'cancelled').every((i) => !['pending_payment', 'confirmed', 'preparing', 'delayed', 'cancellation_requested'].includes(i.state));
      const patch: Partial<GroupRec> = {};
      if (status !== g.status) patch.status = status;
      if (['delivered', 'partly_cancelled'].includes(status) && !g.delivered_at) patch.delivered_at = now;
      if (status === 'cancelled' && g.delivered_at) patch.delivered_at = null;
      if (shipped && status !== 'cancelled' && !g.shipped_at && own.some((i) => i.state !== 'cancelled')) patch.shipped_at = now;
      if (Object.keys(patch).length) Object.assign(g, await tx.update('seller_groups', g.id, patch));
    }
    const order = agg.order;
    let lifecycle = order.lifecycle as Lifecycle;
    const patch: Partial<OrderRec> = {};
    if (lifecycle === 'open' && agg.items.length && agg.items.every((i) => i.state === 'cancelled')) {
      lifecycle = orderLifecycleMachine.next('open', 'cancel_all_items') as Lifecycle;
      patch.lifecycle = lifecycle;
      batch?.push('orders.order.cancelled', { orderId, ref: order.ref, reason: 'all_items_cancelled', checkoutSessionId: order.checkout_session_id });
    }
    const status = displayStatus(lifecycle, agg.items);
    if (status !== order.display_status) patch.display_status = status;
    const kinds = this.flagKinds({ ...agg, order: { ...order, lifecycle } }, now, cfg.dueSoonMinutes);
    if (JSON.stringify(kinds) !== JSON.stringify(order.flag_kinds ?? [])) patch.flag_kinds = kinds;
    if (Object.keys(patch).length) agg.order = await tx.update('orders', orderId, patch);
    return agg;
  }

  /** Records an event-fed fact of an order (inside the transaction); false when that source was already recorded */
  async addFact(tx: OrdersRepository, orderId: string, fact: NewFact): Promise<boolean> {
    const row = await tx.insertFactIfNew({
      id: newId(),
      order_id: orderId,
      group_id: null,
      shipment_id: null,
      ref: null,
      status: null,
      subkind: null,
      customer_action: null,
      amount: null,
      item_ids: null,
      due_at: null,
      at: this.now(),
      ...fact,
    });
    return Boolean(row);
  }

  /** Changes a recorded fact (inside the transaction) */
  async updateFact(tx: OrdersRepository, agg: Agg, kind: FactRec['kind'], sourceId: string, patch: Partial<Pick<FactRec, 'status' | 'item_ids' | 'ref' | 'due_at'>>): Promise<void> {
    const row = agg.factRows.find((r) => r.kind === kind && r.source_id === sourceId);
    if (row) await tx.update('order_facts', row.id, patch);
  }

  /** Whether a fact of that kind and source is recorded on the order (pre-checks outside a transaction) */
  async hasFact(orderId: string, kind: FactRec['kind'], sourceId: string): Promise<boolean> {
    return (await this.repo.count('order_facts', { order_id: orderId, kind, source_id: sourceId })) > 0;
  }

  /** Runs a write on one order: lock, change, refresh derived values, commit, then publish */
  async write<T>(orderId: string, by: By, fn: (tx: OrdersRepository, agg: Agg, batch: Batch, cfg: Cfg) => Promise<T>, cfg?: Cfg): Promise<T> {
    const c = cfg ?? (await this.cfg());
    const batch = new Batch(by);
    const result = await this.repo.transaction(async (tx) => {
      const agg = await this.lockAndLoad(tx, orderId);
      const r = await fn(tx, agg, batch, c);
      await this.refreshDerived(tx, orderId, batch, c);
      return r;
    });
    this.flush(batch);
    return result;
  }

  stateOf = (i: ItemRec) => i.state as ItemState;
}
