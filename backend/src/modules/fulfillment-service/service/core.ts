/**
 * Shared plumbing of the fulfillment-service use cases: time, settings, errors, events, optional modules,
 * seller names, stock item details from inventory, the ownership ledger, seller-owned quantities in inventory
 * and fee accrual.
 */
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type * as common from '../../../spec/common.js';
import type { FeeRate } from '../../../spec/fulfillment-service.js';
import type { Principal } from '../../../spec/identity.js';
import type { StockItem } from '../../../spec/inventory.js';
import { CHARGE_TYPE, EXAMPLE_SCHEDULE, feeAmount, monthOf, rateFor, SYSTEM, warehouseAddress } from '../domain/rules.js';
import type { ChargeRec, FulfillmentServiceRepository, ScheduleRec, StockGroup } from '../ports.js';

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

  async destination(): Promise<common.Address> {
    return warehouseAddress(await this.ctx.settings.get('warehouseAddress'));
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
  async notifySeller(sellerId: string, topic: string, context: Record<string, unknown>, link: { kind: string; id: string; ref?: string | null; label: string; screen: string }, dedupeKey: string) {
    await this.soft('notifications', topic, (n) => n.notify({ topic, recipients: [{ kind: 'seller', sellerId }], context, link, dedupeKey, sellerId }));
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

  /**
   * Seller-owned units at our warehouse in inventory: the seller's stock item of the offer gains or loses
   * Available units. Inventory's public API sets a seller item's Available through applyBulkQuantities (recorded
   * as a 'Bulk update' movement); it has no receipt into a seller item at a company location.
   */
  async adjustInventory(sellerId: string, stockItemId: string | null, delta: number, jobId: string, actor: common.Actor): Promise<{ ok: boolean; error?: string }> {
    if (!stockItemId || !delta) return { ok: true };
    const inventory = this.ctx.use('inventory');
    const current = (await inventory.getAvailability([stockItemId]))[stockItemId]?.available ?? 0;
    const target = Math.max(0, current + delta);
    const [res] = await inventory.applyBulkQuantities(sellerId, [{ stockItemId, newAvailable: target }], jobId, actor);
    if (!res?.ok) this.ctx.log.warn({ sellerId, stockItemId, delta, error: res?.error }, 'fulfillment-service: inventory did not take the seller-owned quantity');
    return { ok: Boolean(res?.ok), ...(res?.error ? { error: res.error } : {}) };
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
      reason: null,
      idempotency_key: a.key,
    };
    return (await tx.insertIfNew('fee_charges', row)) ? row : null;
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
}
