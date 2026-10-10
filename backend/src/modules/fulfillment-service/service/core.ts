/**
 * Shared plumbing of the fulfillment-service use cases: time, settings, errors, events, optional modules,
 * seller names, stock item details from inventory, the service location, inventory's service-stock calls,
 * notices, work items, audit entries, the ownership ledger and fee accrual.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type { FeeRate } from '../../../spec/fulfillment-service.js';
import type { Principal } from '../../../spec/identity.js';
import type { MovementRef, StockItem } from '../../../spec/inventory.js';
import type { RaiseInput } from '../../../spec/workqueues.js';
import { CHARGE_TYPE, EXAMPLE_SCHEDULE, feeAmount, monthOf, rateFor, shipsFromOf, SYSTEM } from '../domain/rules.js';
import type { ChargeRec, FulfillmentServiceRepository, ScheduleRec, SkuRec, StockGroup } from '../ports.js';

export interface FulfillmentServiceServiceDeps {
  repo: FulfillmentServiceRepository;
  ctx: ModuleContext<'fulfillment-service'>;
}

/** Who acts, as the HTTP layer (or an event) knows it */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
  idempotencyKey?: string;
}

export const SYSTEM_BY: By = { actor: SYSTEM };

type OwnEvent = keyof EventMap & `fulfillment-service.${string}`;
type Optional = Parameters<ModuleContext<'fulfillment-service'>['tryUse']>[0];

/** Inventory's stock groups at the service location (null = outside stock) */
export type InventoryGroup = 'available' | 'reserved' | 'incoming' | 'damaged_held' | 'returned';
export type ServiceReason =
  | 'service_return_received'
  | 'service_return_restocked'
  | 'service_return_unsellable'
  | 'service_return_disposed'
  | 'service_removal_reserved'
  | 'service_removal_completed'
  | 'service_found'
  | 'service_reconcile';

/** The company warehouse that holds and ships seller stock */
export interface ServiceLocation {
  locationId: string;
  address: common.Address;
  shipsFrom: string;
}

/** Events collected inside a transaction and published after the commit */
export class Batch {
  readonly events: { name: OwnEvent; payload: unknown }[] = [];
  push<N extends OwnEvent>(name: N, payload: EventMap[N]) {
    this.events.push({ name, payload });
  }
}

export const invalid = (issues: { path: string; message: string }[], message = issues[0]?.message ?? 'Some details need fixing') => new AppError('VALIDATION_FAILED', message, { issues });
export const invalidField = (path: string, message: string) => invalid([{ path, message }], message);
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const illegal = (machine: string, from: string, event: string, message: string) => new AppError('ILLEGAL_TRANSITION', message, { machine, from, event });
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const num = (v: string | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

const STAFF_PRINCIPAL: Principal = { kind: 'staff', accountId: null };

export interface LedgerMove {
  sellerId: string;
  skuEnrollmentId: string;
  movement: string;
  quantity: number;
  from: StockGroup | null;
  to: StockGroup | null;
  reference?: string | null;
  reason?: string | null;
  actor: common.Actor;
  /** A known id (a service return's receipt uses the service return id) */
  id?: string;
}

export interface Accrual {
  sellerId: string;
  rateType: FeeRate['type'];
  sizeTier: string;
  units: number;
  reference: string | null;
  /** Unique per fact (idempotency_key) */
  key: string;
  /** YYYY-MM the fee belongs to (defaults to this market month) */
  period?: string;
}

/** One inventory.moveServiceStock call */
export interface ServiceMove {
  key: string;
  sku: Pick<SkuRec, 'id' | 'inventory_item_id'>;
  from: InventoryGroup | null;
  to: InventoryGroup | null;
  quantity: number;
  reasonCode: ServiceReason;
  ref: MovementRef;
  actor: common.Actor;
}

export interface WorkItem {
  queueKey: 'fulfillment.receiving' | 'fulfillment.reconciliation' | 'fulfillment.requests' | 'fulfillment.enrollments';
  kind: RaiseInput['kind'];
  title: string;
  summary?: string | null;
  subject: RaiseInput['subject'];
  sellerId?: string | null;
  dedupeKey: string;
  dueAt?: string | null;
  priority?: RaiseInput['priority'];
  amount?: common.Money | null;
}

export class Core {
  readonly repo: FulfillmentServiceRepository;
  readonly ctx: ModuleContext<'fulfillment-service'>;

  constructor(deps: FulfillmentServiceServiceDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
  }

  now = () => this.ctx.clock.now();
  get tz() {
    return this.ctx.config.market.timeZone;
  }
  today = (at: Date = this.now()) => dateInZone(at, this.tz);
  month = (at: Date = this.now()) => monthOf(this.today(at));
  /** Start of a market day as an instant */
  dayStart = (date: string) => zonedTimeToUtc(date, '00:00', this.tz);
  error = (code: string, message?: string, details?: unknown) => this.ctx.error(code, message, details);
  money = (amount: number, currency = 'USD'): common.Money => ({ amount, currency });

  /* ---------------------------------------------------------------- settings */

  async setting(key: 'longTermStorageDays' | 'discrepancyResponseDays' | 'sellerNoticeDays' | 'unsellableDisposalDays', fallback: number): Promise<number> {
    const v = Number(await this.ctx.settings.get(key));
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  }

  /** The four service settings (read once per call of getServiceTerms) */
  async serviceSettings(): Promise<{ locationId: string | null; profileId: string | null; businessDays: number | null; sameDayCutoff: string | null }> {
    const [locationId, profileId, businessDays, cutoff] = await Promise.all([
      this.ctx.settings.get('serviceLocationId') as Promise<unknown>,
      this.ctx.settings.get('serviceShippingProfileId') as Promise<unknown>,
      this.ctx.settings.get('serviceDispatchBusinessDays') as Promise<unknown>,
      this.ctx.settings.get('serviceSameDayCutoff') as Promise<unknown>,
    ]);
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const days = businessDays === null || businessDays === undefined || businessDays === '' ? NaN : Number(businessDays);
    return { locationId: text(locationId), profileId: text(profileId), businessDays: Number.isInteger(days) && days >= 0 ? days : null, sameDayCutoff: text(cutoff) };
  }

  /**
   * The service location: setting serviceLocationId (an active company warehouse), else inventory's default
   * location (decision D2). Null when no company location exists. Its address is the inbound destination (D12).
   */
  async serviceLocation(locationId?: string | null): Promise<ServiceLocation | null> {
    const id = locationId === undefined ? (await this.serviceSettings()).locationId : locationId;
    const inventory = this.ctx.use('inventory');
    let loc = id ? (await inventory.getLocations({ ownerType: 'official', activeOnly: true })).find((l) => l.id === id) : undefined;
    if (!loc) loc = (await inventory.getDefaultLocation()) ?? undefined;
    if (!loc) return null;
    const address: common.Address = loc.address ?? { name: loc.name, line1: loc.name, city: '', region: '', postalCode: '', country: 'US' };
    return { locationId: loc.id, address, shipsFrom: shipsFromOf(address, loc.name) };
  }

  /** The service location, or SERVICE_UNAVAILABLE when no company warehouse exists */
  async requireLocation(): Promise<ServiceLocation> {
    const loc = await this.serviceLocation();
    if (!loc) throw new AppError('SERVICE_UNAVAILABLE', 'Marketly has no warehouse set up for the fulfillment service yet');
    return loc;
  }

  /* ---------------------------------------------------------------- events and optional modules */

  publish<N extends OwnEvent>(name: N, payload: EventMap[N], by: { actor?: common.Actor; requestId?: string } = {}) {
    this.ctx.events.publish(name as never, payload as never, { actor: by.actor ?? SYSTEM, ...(by.requestId ? { requestId: by.requestId } : {}) });
  }

  flush(batch: Batch, by: { actor?: common.Actor; requestId?: string } = {}) {
    for (const e of batch.events) this.publish(e.name, e.payload as never, by);
  }

  /** An optional module's answer; off, not built or failing → undefined (the caller degrades) */
  async soft<M extends Optional, R>(module: M, what: string, fn: (api: PublicApiMap[M & keyof PublicApiMap]) => Promise<R>): Promise<R | undefined> {
    const api = this.ctx.tryUse(module) as PublicApiMap[M & keyof PublicApiMap] | undefined;
    if (!api) return undefined;
    try {
      return await fn(api);
    } catch (err) {
      if (!isAppError(err)) this.ctx.log.warn({ err, module, what }, 'fulfillment-service: optional call failed');
      else this.ctx.log.info({ code: err.code, module, what }, 'fulfillment-service: optional call refused');
      return undefined;
    }
  }

  /** A seller notice (notifications off or refusing → logged and skipped) */
  async notifySeller(sellerId: string, topic: `seller.fulfillment.${string}`, context: Record<string, unknown>, link: { kind: string; id: string; ref?: string | null; label: string; screen: string }, dedupeKey: string) {
    await this.soft('notifications', topic, (n) => n.notify({ topic, recipients: [{ kind: 'seller', sellerId }], context, link, dedupeKey, sellerId }));
  }

  /** A staff notice to the lead of a role (or the covering backup) */
  async notifyStaff(roleKey: 'seller_manager' | 'warehouse_manager', topic: `staff.fulfillment.${string}`, context: Record<string, unknown>, link: { kind: string; id: string; ref?: string | null; label: string; screen: string }, dedupeKey: string) {
    await this.soft('notifications', topic, (n) => n.notify({ topic, recipients: [{ kind: 'staff_role', roleKey }], context, link, dedupeKey }));
  }

  /** A work item in one of the fulfillment.* queues (workqueues off → skipped) */
  async raise(item: WorkItem) {
    await this.soft('workqueues', item.dedupeKey, (w) => w.raise({ ...item, sourceModule: this.ctx.name, visibleToSeller: false }));
  }

  /** Closes the open work items of a dedupe key */
  async resolveWork(dedupeKey: string, note: string, actor: common.Actor = SYSTEM) {
    await this.soft('workqueues', dedupeKey, (w) => w.resolveBySource(dedupeKey, { note, by: actor }));
  }

  /** One audit entry for an audited endpoint (audit off or failing → logged) */
  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: By) {
    await this.soft('audit', entry.action, (a) => a.record({ ...entry, actor: by.actor, module: this.ctx.name, ...(by.requestId ? { requestId: by.requestId } : {}) }));
  }

  principalOf(by: By): Principal {
    return by.principal ?? (by.actor.kind === 'staff' ? { kind: 'staff', accountId: by.actor.id ?? null } : STAFF_PRINCIPAL);
  }

  /* ---------------------------------------------------------------- other modules' records */

  /** Store names by seller id (sellers off → a generic label) */
  async sellerNames(ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, string>();
    if (!unique.length) return out;
    const rows = (await this.soft('sellers', 'seller names', (s) => s.getSellers(unique))) ?? [];
    for (const r of rows) out.set(r.id, r.storeName);
    return out;
  }

  /** Inventory stock items of offers (title, image, seller SKU, quantities) */
  async stockItems(offerIds: readonly string[]): Promise<Map<string, StockItem>> {
    const unique = [...new Set(offerIds)];
    const out = new Map<string, StockItem>();
    if (!unique.length) return out;
    try {
      const rows = await this.ctx.use('inventory').getStockForOffers(unique, {});
      for (const [offerId, item] of Object.entries(rows)) if (item) out.set(offerId, item);
    } catch (err) {
      this.ctx.log.warn({ err }, 'fulfillment-service: stock item lookup failed');
    }
    return out;
  }

  /* ---------------------------------------------------------------- inventory: seller stock at the service location */

  /**
   * One movement of seller-owned units at the service location (inventory.moveServiceStock, idempotent per key).
   * strict: the caller's action fails with inventory's error (staff actions run it before their own transaction);
   * otherwise a refusal is logged and the daily reconciliation shows the difference.
   */
  async moveStock(m: ServiceMove, o: { strict: boolean; location?: ServiceLocation | null }): Promise<boolean> {
    if (!(m.quantity > 0) || !m.sku.inventory_item_id || m.from === m.to) return true;
    try {
      const location = o.location === undefined ? await this.serviceLocation() : o.location;
      if (!location) throw new AppError('SERVICE_UNAVAILABLE', 'Marketly has no warehouse set up for the fulfillment service yet');
      await this.ctx.use('inventory').moveServiceStock({ key: m.key, stockItemId: m.sku.inventory_item_id, locationId: location.locationId, from: m.from, to: m.to, quantity: m.quantity, reasonCode: m.reasonCode, ref: m.ref, actor: m.actor });
      return true;
    } catch (err) {
      if (o.strict) throw err;
      this.ctx.log.warn({ err, key: m.key, skuEnrollmentId: m.sku.id }, 'fulfillment-service: inventory did not take a service stock movement');
      return false;
    }
  }

  /** inventory.setServiceLocation: the seller item sells from the service location (or, with null, from the seller's own) */
  async setServiceLocation(sku: Pick<SkuRec, 'id' | 'inventory_item_id'>, locationId: string | null, actor: common.Actor, o: { strict: boolean }): Promise<boolean> {
    if (!sku.inventory_item_id) return false;
    try {
      await this.ctx.use('inventory').setServiceLocation(sku.inventory_item_id, locationId, actor);
      return true;
    } catch (err) {
      if (o.strict) throw err;
      this.ctx.log.error({ err, skuEnrollmentId: sku.id, locationId }, 'fulfillment-service: inventory did not take the service location');
      return false;
    }
  }

  /** fulfillment-service.offer.service_changed for SKUs whose service fulfilment or sellability changed */
  serviceChanged(skus: readonly SkuRec[], change: { fulfilledBy: 'marketly_service' | 'seller'; sellable: boolean; reason: EventMap['fulfillment-service.offer.service_changed']['reason'] }, by: { actor?: common.Actor; requestId?: string }) {
    const at = this.now().toISOString();
    for (const s of skus) {
      if (!s.inventory_item_id) continue;
      this.publish('fulfillment-service.offer.service_changed', { offerId: s.offer_id, sellerId: s.seller_id, skuEnrollmentId: s.id, stockItemId: s.inventory_item_id, fulfilledBy: change.fulfilledBy, sellable: change.sellable, reason: change.reason, at }, by);
    }
  }

  /* ---------------------------------------------------------------- the ownership ledger */

  async move(tx: FulfillmentServiceRepository, m: LedgerMove): Promise<void> {
    if (!(m.quantity > 0)) return;
    await tx.insert('ownership_ledger', {
      id: m.id ?? newId(),
      seller_id: m.sellerId,
      sku_enrollment_id: m.skuEnrollmentId,
      movement: m.movement,
      quantity: m.quantity,
      from_group: m.from,
      to_group: m.to,
      reference: m.reference ?? null,
      actor_kind: m.actor.kind,
      actor_id: m.actor.id ?? null,
      reason: m.reason ?? null,
      at: this.now(),
    });
  }

  /* ---------------------------------------------------------------- fee schedules and accrual */

  /** Scheduled schedules whose date has come become current; the one they replace is superseded */
  async syncSchedules(): Promise<void> {
    const now = this.now();
    const due = await this.repo.find('fee_schedules', { state: ['scheduled', 'current'], effective_at: { op: '<=', value: now } }, { orderBy: [['effective_at', 'desc']] });
    const [latest, ...older] = due;
    if (!latest) return;
    if (latest.state !== 'current') await this.repo.update('fee_schedules', latest.id, { state: 'current' });
    for (const o of older) if (o.state === 'current') await this.repo.update('fee_schedules', o.id, { state: 'superseded' });
  }

  /** The schedule in force now (the example schedule when none was published) */
  async currentSchedule(tx: FulfillmentServiceRepository = this.repo): Promise<ScheduleRec> {
    const now = this.now();
    const row = await tx.findOne('fee_schedules', { state: ['scheduled', 'current'], effective_at: { op: '<=', value: now } }, { orderBy: [['effective_at', 'desc']] });
    return (
      row ?? {
        id: EXAMPLE_SCHEDULE.id,
        version: EXAMPLE_SCHEDULE.version,
        effective_at: new Date(EXAMPLE_SCHEDULE.effectiveAt),
        rates: EXAMPLE_SCHEDULE.rates,
        state: 'current',
        approval_request_id: null,
      }
    );
  }

  /**
   * Accrues one fee charge from the current schedule (idempotent per key; nothing when the schedule has no rate
   * or the amount is 0). Runs inside the caller's transaction (own tables only).
   */
  async accrue(tx: FulfillmentServiceRepository, a: Accrual, rates?: readonly FeeRate[]): Promise<ChargeRec | null> {
    if (!(a.units > 0)) return null;
    const schedule = rates ?? (await this.currentSchedule(tx)).rates;
    const rate = rateFor(schedule, a.rateType, a.sizeTier);
    if (!rate || rate.amount <= 0) return null;
    const amount = feeAmount(a.units, rate.amount);
    if (amount <= 0) return null;
    const row: ChargeRec = {
      id: newId(),
      seller_id: a.sellerId,
      type: CHARGE_TYPE[a.rateType],
      period: a.period ?? this.month(),
      reference: a.reference,
      units: String(a.units),
      rate: rate.amount,
      amount,
      currency: rate.currency,
      state: 'accrued',
      posted_at: null,
      ledger_entry_id: null,
      reason: null,
      idempotency_key: a.key,
    };
    return (await tx.insertIfNew('fee_charges', row)) ? row : null;
  }

  /** A reimbursement to the seller (a negative charge, posted as a seller credit); idempotent per key */
  async accrueReimbursement(tx: FulfillmentServiceRepository, r: { sellerId: string; amount: common.Money; reference: string | null; reason: string; key: string }): Promise<boolean> {
    return tx.insertIfNew('fee_charges', {
      id: newId(),
      seller_id: r.sellerId,
      type: 'reimbursement',
      period: this.month(),
      reference: r.reference,
      units: '1',
      rate: -r.amount.amount,
      amount: -r.amount.amount,
      currency: r.amount.currency,
      state: 'accrued',
      posted_at: null,
      ledger_entry_id: null,
      reason: r.reason,
      idempotency_key: r.key,
    });
  }
}

/** Base of the use-case groups */
export abstract class Part {
  constructor(
    protected readonly core: Core,
    protected readonly parts: Parts,
  ) {}
  protected get repo() {
    return this.core.repo;
  }
  protected get ctx() {
    return this.core.ctx;
  }
  protected now() {
    return this.core.now();
  }
}

/** The use-case groups, for calls between them */
export interface Parts {
  views: import('./views.js').Views;
  stock: import('./stock.js').StockPart;
  enrollment: import('./enrollment.js').EnrollmentPart;
  skus: import('./skus.js').SkusPart;
  inbound: import('./inbound.js').InboundPart;
  requests: import('./requests.js').RequestsPart;
  returns: import('./returns.js').ReturnsPart;
  removals: import('./removals.js').RemovalsPart;
  fees: import('./fees.js').FeesPart;
  differences: import('./differences.js').DifferencesPart;
  exports: import('./exports.js').ExportsPart;
}
