/**
 * Shared plumbing of the offers use cases: time, settings, events, audit, optional modules, catalog and
 * seller lookups, the offer status transition (with its status log) and featured-offer bookkeeping.
 * The use cases live in the part classes, which all get one Core.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isAppError, isNotImplemented } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as catalog from '../../../spec/catalog.js';
import type * as common from '../../../spec/common.js';
import type { IneligibilityReason, Offer, StatusReason } from '../../../spec/offers.js';
import type * as sellers from '../../../spec/sellers.js';
import { reason, type IneligibilityCode, type OfferStatus } from '../domain/rules.js';
import { offerStatusMachine } from '../domain/state-machines.js';
import { OFFICIAL_NAME, SERVICE_INELIGIBLE, isoReq, money, offerTitle, ownFulfilment, serviceFulfilment, toOffer, type Fulfilment } from '../mappers.js';
import type { BulkFileReader, EligibilityRec, OfferRec } from '../ports.js';
import { DuplicateKeyError, type OffersRepository } from '../repository.js';
import type { BulkPart } from './bulk.js';
import type { EnforcementPart } from './enforcement.js';
import type { FeaturedPart } from './featured.js';
import type { ManagePart } from './manage.js';
import type { PricingPart } from './pricing.js';
import type { StorefrontPart } from './storefront.js';
import type { ViewsPart } from './views.js';

export interface OffersServiceDeps {
  repo: OffersRepository;
  ctx: ModuleContext<'offers'>;
  files: BulkFileReader;
}

/** Who acts, as the HTTP layer (or an event) knows it */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
}

export interface Parts {
  manage: ManagePart;
  pricing: PricingPart;
  storefront: StorefrontPart;
  featured: FeaturedPart;
  enforcement: EnforcementPart;
  views: ViewsPart;
  bulk: BulkPart;
}

type OwnEvent = keyof EventMap & `offers.${string}`;
type Optional = Parameters<ModuleContext<'offers'>['tryUse']>[0];
export type OfferEvent = 'publish' | 'pause' | 'resume' | 'stockDepleted' | 'stockRestored' | 'makeIneligible' | 'restoreEligibility' | 'remove' | 'reinstate';

export const SYSTEM: common.Actor = { kind: 'system', id: null };

export const invalid = (issues: { path: string; message: string }[], message = 'Some details need fixing') => new AppError('VALIDATION_FAILED', message, { issues });
export const invalidField = (path: string, message: string) => invalid([{ path, message }], message);
export const notFound = (what = 'Offer') => new AppError('NOT_FOUND', `${what} not found`);

export interface TransitionSpec {
  event: OfferEvent;
  by: By;
  /** Checks inside the transaction, on the locked row */
  guard?: (r: OfferRec) => void;
  /** New status reason; undefined keeps it, null clears it */
  reason?: StatusReason | null;
  log?: { reasonCode?: string | null; reason?: string | null; affectedActivity?: string | null; appealRoute?: string | null; reviewDate?: string | null; trustEnforcementId?: string | null };
  patch?: Partial<OfferRec>;
  /** Sellable quantity read before the transaction: publish / resume / restore land on out_of_stock when 0 */
  available?: number;
  /** makeIneligible: where the hold comes from */
  source?: { kind: 'restriction' | 'suspension' | 'product' | 'staff' | 'enforcement' | 'fulfillment_service' | 'brand'; id: string | null };
}

export interface Step {
  from: string;
  to: string;
  event: string;
}

export interface Transitioned {
  before: OfferRec;
  after: OfferRec;
  steps: Step[];
}

/** Per-call cache of catalog products */
export type ProductCache = Map<string, Promise<catalog.ProductAdmin | null>>;

/** A seller's standing for featured eligibility (sellerStanding) */
export interface Standing {
  onTimePct: number | null;
  reasons: IneligibilityReason[];
  restrictionRef: string | null;
}

/** Eligibility reasons that come from the seller's standing (carried over when no fresh standing is given) */
const SELLER_CODES: IneligibilityCode[] = ['seller_restricted', 'seller_suspended', 'delivery_performance_under_review', 'on_time_dispatch_below_standard'];

export class Core {
  readonly repo: OffersRepository;
  readonly ctx: ModuleContext<'offers'>;
  readonly files: BulkFileReader;
  parts!: Parts;

  constructor(deps: OffersServiceDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
    this.files = deps.files;
  }

  now = () => this.ctx.clock.now();
  /** Market date YYYY-MM-DD */
  today = (at: Date = this.now()) => dateInZone(at, this.ctx.config.market.timeZone);
  get currency() {
    return this.ctx.config.market.currency;
  }
  money = (amount: number) => money(amount, this.currency);
  setting = <K extends Parameters<ModuleContext<'offers'>['settings']['get']>[0]>(key: K) => this.ctx.settings.get(key);
  error = (code: string, message?: string, details?: unknown) => this.ctx.error(code, message, details);

  async lookbackDays(): Promise<number> {
    const v = Number(await this.setting('wasPriceLookbackDays'));
    return Number.isFinite(v) && v > 0 ? v : 30;
  }

  publish<N extends OwnEvent>(name: N, payload: EventMap[N], by: { actor?: common.Actor; requestId?: string } = {}) {
    this.ctx.events.publish(name as never, payload as never, { actor: by.actor ?? SYSTEM, ...(by.requestId ? { requestId: by.requestId } : {}) });
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, action: entry.action }, 'offers: audit entry not written');
    }
  }

  /** Calls an optional module; off, not built yet or failing → undefined (the caller degrades) */
  async optional<M extends Optional, R>(module: M, what: string, fn: (api: PublicApiMap[M & keyof PublicApiMap]) => Promise<R>): Promise<R | undefined> {
    const api = this.ctx.tryUse(module) as PublicApiMap[M & keyof PublicApiMap] | undefined;
    if (!api) return undefined;
    try {
      return await fn(api);
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, module, what }, `offers: ${module} could not answer for ${what}`);
      return undefined;
    }
  }

  /** Calls a dependency for a read; failures other than bad input are logged and answered with undefined */
  async soft<R>(what: string, fn: () => Promise<R>): Promise<R | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (!isNotImplemented(err) && !(isAppError(err) && err.status < 500)) this.ctx.log.warn({ err, what }, `offers: ${what} failed`);
      return undefined;
    }
  }

  /* ---------------------------------------------------------------- catalog */

  productAdmin(id: string, cache?: ProductCache): Promise<catalog.ProductAdmin | null> {
    if (!isUuid(id)) return Promise.resolve(null);
    const load = () => this.ctx.use('catalog').getProductAdmin(id).catch((err) => {
      if (isAppError(err) && err.status === 404) return null;
      throw err;
    });
    if (!cache) return load();
    let p = cache.get(id);
    if (!p) cache.set(id, (p = load()));
    return p;
  }

  async products(ids: readonly string[], cache: ProductCache = new Map()): Promise<Map<string, catalog.ProductAdmin>> {
    const uniq = [...new Set(ids)];
    const list = await Promise.all(uniq.map((id) => this.productAdmin(id, cache).catch(() => null)));
    const out = new Map<string, catalog.ProductAdmin>();
    uniq.forEach((id, i) => list[i] && out.set(id, list[i]!));
    return out;
  }

  /** The offer's title; rows created before titles existed get theirs from catalog now (and keep it) */
  async ensureTitle(r: OfferRec, cache?: ProductCache): Promise<string> {
    if (r.title) return r.title;
    const p = await this.productAdmin(r.product_id, cache).catch(() => null);
    if (!p) return '';
    const title = offerTitle(p.product.title, p.product.variants.find((v) => v.id === r.variant_id)?.options);
    await this.repo.update('offers', r.id, { title });
    return title;
  }

  /* ---------------------------------------------------------------- sellers */

  async sellerSnapshots(ids: readonly (string | null | undefined)[]): Promise<Map<string, sellers.SellerSnapshot>> {
    const uniq = [...new Set(ids.filter((i): i is string => isUuid(i)))];
    if (!uniq.length) return new Map();
    const list = (await this.soft('sellers.getSellers', () => this.ctx.use('sellers').getSellers(uniq))) ?? [];
    return new Map(list.map((s) => [s.id, s]));
  }

  async sellerNames(rows: readonly OfferRec[]): Promise<Map<string, string>> {
    const snaps = await this.sellerSnapshots(rows.map((r) => r.seller_id));
    return new Map([...snaps].map(([id, s]) => [id, s.storeName]));
  }

  nameOf(r: OfferRec, names: Map<string, string>) {
    return r.owner_type === 'official' ? OFFICIAL_NAME : (names.get(r.seller_id ?? '') ?? 'Seller');
  }

  /* ---------------------------------------------------------------- offers */

  async offerRow(id: string, o: { forUpdate?: boolean; repo?: OffersRepository } = {}): Promise<OfferRec> {
    const r = isUuid(id) ? await (o.repo ?? this.repo).get('offers', id, { forUpdate: o.forUpdate }) : undefined;
    if (!r) throw notFound();
    return r;
  }

  /** The seller's own offer; another seller's (or an Official Store) offer is not found */
  async ownRow(sellerId: string, id: string, repo?: OffersRepository, forUpdate = false): Promise<OfferRec> {
    const r = await this.offerRow(id, { repo, forUpdate });
    if (r.owner_type !== 'seller' || r.seller_id !== sellerId) throw notFound();
    return r;
  }

  async officialRow(id: string, repo?: OffersRepository, forUpdate = false): Promise<OfferRec> {
    const r = await this.offerRow(id, { repo, forUpdate });
    if (r.owner_type !== 'official') throw notFound();
    return r;
  }

  async toOffers(rows: readonly OfferRec[]): Promise<Offer[]> {
    if (!rows.length) return [];
    const [names, elig, lookback, fulfilment] = await Promise.all([this.sellerNames(rows), this.repo.getEligibility(rows.map((r) => r.id)), this.lookbackDays(), this.fulfilment(rows)]);
    const e = new Map(elig.map((x) => [x.offer_id, x]));
    const now = this.now();
    return rows.map((r) => toOffer(r, { sellerName: this.nameOf(r, names), eligibility: e.get(r.id), lookbackDays: lookback, fulfilment: fulfilment.get(r.id), now }));
  }

  /**
   * Effective customer-facing fulfilment per offer (Offer.shipping): own terms for seller and Official Store offers;
   * for marketly_service offers Marketly's terms from one batched fulfillment-service.getServiceTerms call. The service
   * off, failing or answering null makes those offers not sellable, never seller-shipped (decision D5).
   */
  async fulfilment(rows: readonly OfferRec[]): Promise<Map<string, Fulfilment>> {
    const service = rows.filter((r) => r.fulfilled_by === 'marketly_service');
    const terms = service.length ? ((await this.optional('fulfillment-service', 'getServiceTerms', (fs) => fs.getServiceTerms([...new Set(service.map((r) => r.id))]))) ?? {}) : {};
    return new Map(rows.map((r) => [r.id, r.fulfilled_by === 'marketly_service' ? serviceFulfilment(r, terms[r.id]) : ownFulfilment(r)]));
  }

  async toOffer(r: OfferRec): Promise<Offer> {
    return (await this.toOffers([r]))[0]!;
  }

  /** Sellable quantity per stock item (inventory) */
  async available(stockItemIds: readonly string[]): Promise<Map<string, number>> {
    const ids = [...new Set(stockItemIds.filter(isUuid))];
    if (!ids.length) return new Map();
    const a = (await this.soft('inventory.getAvailability', () => this.ctx.use('inventory').getAvailability(ids))) ?? {};
    return new Map(ids.map((id) => [id, a[id]?.available ?? 0]));
  }

  /* ---------------------------------------------------------------- status transitions */

  /**
   * Moves an offer through the status machine in one transaction: locks the row, checks the move,
   * writes the status log and lands on out_of_stock when nothing is available. Events, eligibility and
   * featured bookkeeping run after the commit (afterTransition).
   */
  async transition(offerId: string, spec: TransitionSpec, repo: OffersRepository = this.repo): Promise<Transitioned> {
    // a reinstated offer can collide with a live offer that took its stock item or New-variant slot meanwhile
    return this.unique(() => this.transitionTx(offerId, spec, repo));
  }

  /**
   * Runs a write; a write refused by a unique index of offers (SKU per owner, one live New offer per owner and
   * variant, one live offer per stock item; the Official Store's null seller_id counts as one owner) is DUPLICATE_OFFER.
   */
  async unique<R>(fn: () => Promise<R>, details: Record<string, unknown> = {}): Promise<R> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof DuplicateKeyError)) throw err;
      const reason = err.index.includes('stock_item') ? 'stock_item_in_use' : err.index.includes('sku') ? 'sku_in_use' : err.index.includes('variant') ? 'new_offer_exists' : 'duplicate';
      const message =
        reason === 'stock_item_in_use'
          ? 'Another live offer already sells this stock item'
          : reason === 'sku_in_use'
            ? 'This SKU is already used by another offer'
            : reason === 'new_offer_exists'
              ? 'There is already a live New offer for this variant'
              : 'An offer with this SKU or variant already exists';
      throw this.error('DUPLICATE_OFFER', message, { reason, ...details });
    }
  }

  private async transitionTx(offerId: string, spec: TransitionSpec, repo: OffersRepository): Promise<Transitioned> {
    return repo.transaction(async (tx) => {
      const before = await this.offerRow(offerId, { repo: tx, forUpdate: true });
      spec.guard?.(before);
      const from = before.status as OfferStatus;
      let to = offerStatusMachine.next(from as never, spec.event as never) as OfferStatus;
      const now = this.now();
      const patch: Partial<OfferRec> = { ...spec.patch, updated_at: now };
      const steps: Step[] = [];

      if (spec.event === 'restoreEligibility') {
        const back = (before.status_before_ineligible as OfferStatus | null) ?? 'active';
        to = back === 'paused' ? 'paused' : 'active';
        patch.status_before_ineligible = null;
        patch.ineligible_source = null;
      }
      if (spec.event === 'makeIneligible') {
        patch.status_before_ineligible = from;
        patch.ineligible_source = (spec.source ?? { kind: 'staff', id: null }) as never;
      }
      if (spec.event === 'publish' && !before.published_at) patch.published_at = now;
      if (spec.event === 'remove') patch.removed_at = now;
      if (spec.event === 'reinstate') patch.removed_at = null;
      steps.push({ from, to, event: spec.event });

      // publish, resume and restoreEligibility land on out_of_stock straight away when nothing is available
      if (to === 'active' && spec.available !== undefined && spec.available <= 0 && ['publish', 'resume', 'restoreEligibility'].includes(spec.event)) {
        steps.push({ from: 'active', to: 'out_of_stock', event: 'stockDepleted' });
        to = 'out_of_stock';
      }
      patch.status = to;
      if (spec.reason !== undefined) patch.status_reason = spec.reason as never;

      const after = await tx.update('offers', before.id, patch);
      const actor = spec.by.actor;
      for (const [i, s] of steps.entries()) {
        const l = i === 0 ? spec.log : undefined;
        await tx.insert('offer_status_log', {
          id: newId(),
          offer_id: before.id,
          from_status: s.from,
          to_status: s.to,
          event: s.event,
          reason_code: l?.reasonCode ?? null,
          reason: l?.reason ?? null,
          affected_activity: l?.affectedActivity ?? null,
          appeal_route: l?.appealRoute ?? null,
          review_date: l?.reviewDate ?? null,
          actor_kind: i === 0 ? actor.kind : 'system',
          actor_id: i === 0 ? (actor.id ?? null) : null,
          at: now,
        });
      }
      return { before, after, steps };
    });
  }

  /** Events, eligibility and featured bookkeeping after a committed transition */
  async afterTransition(t: Transitioned, by: By, log?: TransitionSpec['log']) {
    for (const [i, s] of t.steps.entries()) {
      this.publish(
        'offers.offer.status_changed',
        {
          offerId: t.after.id,
          productId: t.after.product_id,
          variantId: t.after.variant_id,
          sellerId: t.after.seller_id,
          ownerType: t.after.owner_type,
          from: s.from,
          to: s.to,
          reasonCode: i === 0 ? (log?.reasonCode ?? null) : null,
          reason: i === 0 ? (log?.reason ?? null) : null,
          stockItemId: t.after.stock_item_id,
          trustEnforcementId: log?.trustEnforcementId ?? null,
        },
        by,
      );
    }
    await this.refreshEligibility([t.after]);
    await this.markDirty([t.after.variant_id]);
  }

  /** transition + afterTransition */
  async move(offerId: string, spec: TransitionSpec): Promise<Transitioned> {
    const t = await this.transition(offerId, spec);
    await this.afterTransition(t, spec.by, spec.log);
    return t;
  }

  statusReason(code: StatusReason['code'], text: string, by: By, extra: Partial<StatusReason> = {}): StatusReason {
    return { code, text, affectedActivity: null, appealRoute: null, reviewDate: null, actor: by.actor, at: isoReq(this.now()), ...extra };
  }

  /* ---------------------------------------------------------------- eligibility */

  /** Reasons that follow from the offer's own status */
  statusReasons(r: OfferRec): IneligibilityReason[] {
    switch (r.status as OfferStatus) {
      case 'active':
        return [];
      case 'out_of_stock':
        return [reason('out_of_stock')];
      case 'ineligible': {
        const src = (r.ineligible_source ?? {}) as { kind?: string };
        if (src.kind === 'fulfillment_service') return [SERVICE_INELIGIBLE];
        const code: IneligibilityCode =
          src.kind === 'restriction' ? 'seller_restricted' : src.kind === 'suspension' ? 'seller_suspended' : src.kind === 'product' ? 'product_not_purchasable' : src.kind === 'staff' || src.kind === 'enforcement' ? 'staff_hold' : 'offer_not_active';
        return [reason(code)];
      }
      default:
        return [reason('offer_not_active')];
    }
  }

  /**
   * Recomputes the location-independent eligibility of offers. Seller standing (open restriction,
   * on-time dispatch, delivery review) comes from `standing` when given (hourly job, create), else it is
   * carried over from the last evaluation. Publishes offers.offer.eligibility_changed on a change.
   */
  async refreshEligibility(rows: readonly OfferRec[], standing?: Map<string, Standing>) {
    if (!rows.length) return;
    const existing = new Map((await this.repo.getEligibility(rows.map((r) => r.id))).map((e) => [e.offer_id, e]));
    const now = this.now();
    const evaluated: EligibilityRec[] = [];
    const changed: { r: OfferRec; eligible: boolean; codes: string[] }[] = [];
    for (const r of rows) {
      const prev = existing.get(r.id);
      const prevReasons = (Array.isArray(prev?.reasons) ? prev!.reasons : []) as unknown as IneligibilityReason[];
      const s = r.seller_id ? standing?.get(r.seller_id) : undefined;
      const sellerReasons = s ? s.reasons : prevReasons.filter((x) => SELLER_CODES.includes(x.code));
      const reasons: IneligibilityReason[] = [];
      for (const x of [...this.statusReasons(r), ...sellerReasons]) if (!reasons.some((y) => y.code === x.code)) reasons.push(x);
      const row: EligibilityRec = {
        offer_id: r.id,
        eligible: reasons.length === 0,
        reasons: reasons as never,
        seller_on_time_pct: s ? (s.onTimePct === null ? null : s.onTimePct.toFixed(2)) : (prev?.seller_on_time_pct ?? null),
        seller_restriction_ref: s ? s.restrictionRef : (prev?.seller_restriction_ref ?? null),
        evaluated_at: now,
      };
      evaluated.push(row);
      const codes = reasons.map((x) => x.code).sort();
      const before = prevReasons.map((x) => x.code).sort();
      // a new draft changes nothing for anyone yet
      if (prev ? prev.eligible !== row.eligible || codes.join() !== before.join() : r.status !== 'draft') changed.push({ r, eligible: row.eligible, codes });
    }
    await this.repo.upsertEligibility(evaluated);
    for (const { r, eligible, codes } of changed) this.publish('offers.offer.eligibility_changed', { offerId: r.id, sellerId: r.seller_id, eligible, reasons: codes });
    await this.markDirty([...new Set(changed.map((c) => c.r.variant_id))]);
  }

  /** Featured decisions for these variants need recomputing */
  async markDirty(variantIds: readonly string[]) {
    if (variantIds.length) await this.repo.markFeaturedDirty({ variantIds });
  }

  /** Seller standing for featured eligibility: open restriction, suspension, on-time dispatch, delivery review */
  async sellerStanding(sellerIds: readonly string[], minOnTimePct: number): Promise<Map<string, Standing>> {
    const out = new Map<string, Standing>();
    const ids = [...new Set(sellerIds.filter(isUuid))];
    if (!ids.length) return out;
    // sellers has no batch read of performance: one call per seller, side by side
    const [snaps, perfs] = await Promise.all([this.sellerSnapshots(ids), Promise.all(ids.map((id) => this.soft('sellers.getPerformance', () => this.ctx.use('sellers').getPerformance(id))))]);
    for (const [i, id] of ids.entries()) {
      const snap = snaps.get(id);
      const reasons: IneligibilityReason[] = [];
      if (snap?.status === 'suspended') reasons.push(reason('seller_suspended'));
      if (snap && (snap.status === 'restricted' || snap.activeRestrictionIds.length)) reasons.push(reason('seller_restricted'));
      const perf = perfs[i];
      let onTime: number | null = null;
      if (perf && perf.orderCount > 0) {
        const dispatch = perf.metrics.find((m) => m.key === 'dispatch_reliability');
        if (dispatch && (dispatch.denominator ?? 1) > 0) {
          onTime = dispatch.value;
          if (dispatch.value < minOnTimePct) reasons.push(reason('on_time_dispatch_below_standard'));
        }
        if (perf.metrics.some((m) => (m.key === 'dispatch_reliability' || m.key === 'valid_tracking') && m.status === 'action_needed')) reasons.push(reason('delivery_performance_under_review'));
      }
      out.set(id, { onTimePct: onTime, reasons, restrictionRef: snap?.activeRestrictionIds[0] ?? null });
    }
    return out;
  }
}

/** Base class of the use-case parts */
export abstract class Part {
  constructor(protected readonly core: Core) {}
  protected get repo() {
    return this.core.repo;
  }
  protected get ctx() {
    return this.core.ctx;
  }
  protected get parts() {
    return this.core.parts;
  }
  protected now() {
    return this.core.now();
  }
}
