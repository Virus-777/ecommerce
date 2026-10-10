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
  /** Variant GTIN (inventory.getStockItems from catalog), so item barcodes match too */
  gtin?: string | null;
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
   * SKU and label of stock items (inventory.getStockItems); for an id inventory no longer knows, what warehouse
   * copied onto pick lines.
   */
  async stockInfo(ids: readonly string[]): Promise<Map<string, StockInfo>> {
    const unique = [...new Set(ids.filter(Boolean))];
    const out = new Map<string, StockInfo>();
    if (!unique.length) return out;
    for (const i of await this.ctx.use('inventory').getStockItems(unique)) out.set(i.id, { sku: i.sku, label: i.label, gtin: i.gtin ?? null });
    const missing = unique.filter((id) => !out.has(id));
    if (missing.length) {
      const lines = await this.repo.find('fulfillment_lines', { stock_item_id: missing }, { limit: 500 });
      for (const l of lines) if (!out.has(l.stock_item_id)) out.set(l.stock_item_id, { sku: l.sku, label: l.label });
    }
    return out;
  }

  /** GTINs of stock items (variant barcodes; inventory.getStockItems), for scans that read the item barcode instead of the SKU label */
  async gtins(ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    const out = new Map<string, string>();
    if (!unique.length) return out;
    for (const i of await this.ctx.use('inventory').getStockItems(unique)) if (i.gtin) out.set(i.id, i.gtin);
    return out;
  }

  /** The main Official Store site: the location with the most active bins, else the site of the latest fulfillment */
  async defaultLocation(): Promise<string | null> {
    const busiest = await this.repo.busiestLocation();
    if (busiest) return busiest;
    const last = await this.repo.find('fulfillments', {}, { orderBy: [['created_at', 'desc']], limit: 1 });
    return last[0]?.location_id ?? null;
  }

  /** Fulfilled by Marketly: where service stock lives (fulfillment-service.getServiceLocation), else inventory's default company location */
  async serviceLocationId(): Promise<string | null> {
    const svc = await this.soft('fulfillment-service', 'service location', (fs) => fs.getServiceLocation());
    if (svc?.locationId) return svc.locationId;
    const inv = await this.ctx
      .use('inventory')
      .getDefaultLocation()
      .catch((err) => {
        if (!isAppError(err)) throw err;
        return null;
      });
    return inv?.id ?? null;
  }

  /**
   * The ship-from address of a fulfillment's labels: a Fulfilled by Marketly package leaves from the service
   * location's address (decision D1); null for Official Store packages (shipping uses its own origin).
   */
  async labelOrigin(f: { fulfilled_by: string; location_id: string }): Promise<common.Address | null> {
    if (f.fulfilled_by !== 'marketly_service') return null;
    const svc = await this.soft('fulfillment-service', 'service location', (fs) => fs.getServiceLocation());
    if (svc && svc.locationId === f.location_id && svc.address) return svc.address;
    const locations = await this.ctx
      .use('inventory')
      .getLocations({ ownerType: 'official' })
      .catch((err) => {
        if (!isAppError(err)) throw err;
        return [];
      });
    return locations.find((l) => l.id === f.location_id)?.address ?? svc?.address ?? null;
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
