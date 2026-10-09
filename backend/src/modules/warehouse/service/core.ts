/**
 * Shared plumbing of the warehouse use cases: time, settings, events, audit, optional modules, stock item names,
 * the warehouse site, carrier pickups and printable files.
 */
import type { Principal } from '../../../spec/identity.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { dateInZone, zonedTimeToUtc } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type { FileLink } from '../../../spec/warehouse.js';
import { addDays, SYSTEM, upcoming } from '../domain/rules.js';
import type { WarehouseRepository } from '../ports.js';

export interface WarehouseServiceDeps {
  repo: WarehouseRepository;
  ctx: ModuleContext<'warehouse'>;
}

/** Who acts, as the HTTP layer (or an event) knows it */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
  can?: (permission: string) => Promise<boolean>;
}

export interface Cfg {
  requireBinScan: boolean;
  requireItemScan: boolean;
  autoWaveEnabled: boolean;
  carrierPickupTimes: string[];
  atRiskMinutes: number;
  weightUnit: 'lb' | 'kg';
  packingSlipShowsPrices: boolean;
}

export interface StockInfo {
  sku: string;
  label: string;
  image: common.MediaRef | null;
}

type OwnEvent = keyof EventMap & `warehouse.${string}`;
type Optional = Parameters<ModuleContext<'warehouse'>['tryUse']>[0];

/** Events collected inside a transaction and published after the commit */
export class Batch {
  readonly events: { name: OwnEvent; payload: unknown }[] = [];
  constructor(readonly by: { actor: common.Actor; requestId?: string }) {}
  push<N extends OwnEvent>(name: N, payload: EventMap[N]) {
    this.events.push({ name, payload });
  }
}

export const invalid = (issues: { path: string; message: string }[], message = issues[0]?.message ?? 'Some details need fixing') => new AppError('VALIDATION_FAILED', message, { issues });
export const invalidField = (path: string, message: string) => invalid([{ path, message }], message);
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const unavailable = (what: string) => new AppError('SERVICE_UNAVAILABLE', `${what} is unavailable right now`, undefined, 503);
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const STAFF_PRINCIPAL: Principal = { kind: 'staff', accountId: null };

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export class Core {
  readonly repo: WarehouseRepository;
  readonly ctx: ModuleContext<'warehouse'>;

  constructor(deps: WarehouseServiceDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
  }

  now = () => this.ctx.clock.now();
  get tz() {
    return this.ctx.config.market.timeZone;
  }
  today = (at: Date = this.now()) => dateInZone(at, this.tz);
  /** Start of a market day as an instant */
  dayStart = (date: string = this.today()) => zonedTimeToUtc(date, '00:00', this.tz);
  error = (code: string, message?: string, details?: unknown) => this.ctx.error(code, message, details);

  async cfg(): Promise<Cfg> {
    const s = this.ctx.settings;
    const [a, b, c, d, e, f, g] = await Promise.all([
      s.get('requireBinScan'),
      s.get('requireItemScan'),
      s.get('autoWaveEnabled'),
      s.get('carrierPickupTimes'),
      s.get('atRiskMinutes'),
      s.get('weightUnit'),
      s.get('packingSlipShowsPrices'),
    ]);
    return {
      requireBinScan: bool(a, true),
      requireItemScan: bool(b, true),
      autoWaveEnabled: bool(c, false),
      carrierPickupTimes: Array.isArray(d) && d.length ? (d as unknown[]).filter((x): x is string => typeof x === 'string') : ['16:00'],
      atRiskMinutes: num(e, 60),
      weightUnit: f === 'kg' ? 'kg' : 'lb',
      packingSlipShowsPrices: bool(g, false),
    };
  }

  /** Remaining carrier pickups today and the next one (today or the next day) */
  pickups(cfg: Cfg, now: Date = this.now()): { today: Date[]; next: Date | null } {
    const today = this.today(now);
    const todays = upcoming(cfg.carrierPickupTimes, (t) => zonedTimeToUtc(today, t, this.tz), now);
    if (todays.length) return { today: todays, next: todays[0]! };
    const tomorrow = upcoming(cfg.carrierPickupTimes, (t) => zonedTimeToUtc(addDays(today, 1), t, this.tz), now);
    return { today: [], next: tomorrow[0] ?? null };
  }

  publish<N extends OwnEvent>(name: N, payload: EventMap[N], by: { actor?: common.Actor; requestId?: string } = {}) {
    this.ctx.events.publish(name as never, payload as never, { actor: by.actor ?? SYSTEM, ...(by.requestId ? { requestId: by.requestId } : {}) });
  }

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
      if (!isAppError(err)) this.ctx.log.warn({ err, module, what }, 'warehouse: optional call failed');
      else this.ctx.log.info({ code: err.code, module, what }, 'warehouse: optional call refused');
      return undefined;
    }
  }

  /** Every scan at pick, pack, put-away and returns (troubleshooting and productivity) */
  async logScan(e: { context: string; contextId: string | null; code: string; result: string; actor: common.Actor; station?: string | null }, tx: WarehouseRepository = this.repo) {
    await tx.insert('scan_log', { id: newId(), context: e.context, context_id: e.contextId, code: e.code.slice(0, 200), result: e.result, actor_id: e.actor.id ?? e.actor.kind, station: e.station ?? null, at: this.now() });
  }

  /**
   * SKU, label and image of stock items. Inventory's public API has no lookup by stock item id, so the ids go
   * through its staff export (ids → SKUs) and findBySku (SKUs → items); what warehouse copied onto pick lines
   * fills the gaps when inventory does not answer.
   */
  async stockInfo(ids: readonly string[]): Promise<Map<string, StockInfo>> {
    const unique = [...new Set(ids.filter(Boolean))];
    const out = new Map<string, StockInfo>();
    if (!unique.length) return out;
    const inventory = this.ctx.use('inventory');
    try {
      const skus = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await inventory.exportRows('inventory.admin.stock', { stockItemIds: unique }, STAFF_PRINCIPAL, cursor);
        for (const r of page.rows as { sku?: string }[]) if (r.sku) skus.add(r.sku);
        cursor = page.nextCursor;
      } while (cursor);
      if (skus.size) {
        const wanted = new Set(unique);
        // Official Store stock only at launch (seller-owned stock comes with the fulfillment service)
        for (const i of await inventory.findBySku('official', [...skus])) if (wanted.has(i.id)) out.set(i.id, { sku: i.sku, label: i.label, image: i.image ?? null });
      }
    } catch (err) {
      this.ctx.log.warn({ err }, 'warehouse: stock item lookup failed');
    }
    const missing = unique.filter((id) => !out.has(id));
    if (missing.length) {
      const lines = await this.repo.find('fulfillment_lines', { stock_item_id: missing }, { limit: 500 });
      for (const l of lines) if (!out.has(l.stock_item_id)) out.set(l.stock_item_id, { sku: l.sku, label: l.label, image: null });
    }
    return out;
  }

  /** The main Official Store site: the location with the most active bins, else the site of the latest fulfillment */
  async defaultLocation(): Promise<string | null> {
    const busiest = await this.repo.busiestLocation();
    if (busiest) return busiest;
    const last = await this.repo.find('fulfillments', {}, { orderBy: [['created_at', 'desc']], limit: 1 });
    return last[0]?.location_id ?? null;
  }

  /** A generated file (packing slip, put-away labels) stored privately and signed for the caller */
  async fileLink(o: { fileName: string; contentType: string; bytes: Uint8Array; principal?: Principal | null; reason: string }): Promise<FileLink> {
    const media = this.ctx.tryUse('media');
    if (!media) throw unavailable('Printing');
    const asset = await media.storeGeneratedFile({ owner: { kind: 'platform', label: 'Warehouse' }, fileName: o.fileName, contentType: o.contentType, body: new Blob([Buffer.from(o.bytes)]).stream(), ttlHours: 1, purpose: 'label' });
    const link = await media.signedDownload(asset.id, o.principal ?? STAFF_PRINCIPAL, o.reason);
    return { url: link.url, fileName: link.fileName, expiresAt: link.expiresAt };
  }

  /** MediaRefs of photos (media off → none) */
  async photos(ids: string[]): Promise<common.MediaRef[]> {
    if (!ids.length) return [];
    return (await this.soft('media', 'photo refs', (m) => m.refs(ids, 'small'))) ?? [];
  }
}
