/** Today's work (REST summary and OpsQueues), scan resolution, and the at-risk and auto-wave jobs. */
import { isUuid } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import type { Fulfillment, ScanResult, WarehouseSummary } from '../../../spec/warehouse.js';
import { addDays, inBusinessHours, itemMatches, looksLikeReturnRef, NIL_UUID, normalizeCode, SYSTEM, UNPACKED_STATUSES } from '../domain/rules.js';
import type { Where } from '../../../kernel/mongo/index.js';
import type { FulfillmentRec } from '../ports.js';
import type { Bins } from './bins.js';
import type { Core } from './core.js';
import type { Fulfillments } from './fulfillments.js';
import type { Views } from './views.js';

export type TodaySummary = WarehouseSummary & { date: string; toShip: number; shipToday: number; dispatchedToday: number; late: number; shipByCutoff: string | null; pickupsToday: string[]; urgent: Fulfillment[] };

const URGENT = 10;

export class Summary {
  constructor(
    private readonly core: Core,
    private readonly views: Views,
    private readonly bins: Bins,
    private readonly fulfillments: Fulfillments,
  ) {}

  private get repo() {
    return this.core.repo;
  }

  async today(locationId?: string | null): Promise<TodaySummary> {
    const cfg = await this.core.cfg();
    const now = this.core.now();
    const date = this.core.today(now);
    const start = this.core.dayStart(date);
    const end = this.core.dayStart(addDays(date, 1));
    const location = locationId ?? (await this.core.defaultLocation());
    const at: Where<FulfillmentRec> = locationId ? { location_id: locationId } : {};
    const [active, dispatchedToday, packedToday, putawayOpen, expected, toHandOver] = await Promise.all([
      this.repo.find('fulfillments', { ...at, status: ['awaiting_pick', 'picking', 'picked', 'packing', 'packed', 'on_hold'] }, { orderBy: [['ship_by', 'asc']] }),
      this.repo.find('fulfillments', { ...at, status: 'dispatched', updated_at: { op: '>=', value: start } }),
      this.repo.find('packages', { status: ['packed', 'dispatched'], packed_at: { op: '>=', value: start } }),
      this.repo.count('putaway_tasks', { status: 'open', ...(locationId ? { location_id: locationId } : {}) }),
      this.repo.count('return_parcels', { status: 'expected', ...(locationId ? { location_id: locationId } : {}) }),
      this.repo.count('return_parcels', { status: 'received', ...(locationId ? { location_id: locationId } : {}) }),
    ]);
    const ids = new Set([...active, ...dispatchedToday].map((f) => f.id));
    const scopedPacked = locationId ? packedToday.filter((p) => ids.has(p.fulfillment_id)) : packedToday;
    const windowEnd = now.getTime() + cfg.atRiskMinutes * 60_000;
    const unpacked = active.filter((f) => UNPACKED_STATUSES.includes(f.status));
    const isLate = (f: FulfillmentRec) => f.ship_by.getTime() <= now.getTime();
    const isAtRisk = (f: FulfillmentRec) => UNPACKED_STATUSES.includes(f.status) && !isLate(f) && f.ship_by.getTime() <= windowEnd;
    const dueToday = (f: FulfillmentRec) => f.ship_by.getTime() >= start.getTime() && f.ship_by.getTime() < end.getTime();
    const pickups = this.core.pickups(cfg, now);
    const urgentRecs = [...active]
      .filter((f) => f.status !== 'packed')
      .sort((a, b) => Number(isLate(b)) - Number(isLate(a)) || Number(isAtRisk(b)) - Number(isAtRisk(a)) || a.ship_by.getTime() - b.ship_by.getTime())
      .slice(0, URGENT);
    return {
      locationId: location ?? NIL_UUID,
      date,
      toPick: active.filter((f) => f.status === 'awaiting_pick').length,
      picking: active.filter((f) => f.status === 'picking').length,
      toPack: active.filter((f) => f.status === 'picked' || f.status === 'packing').length,
      toShip: active.filter((f) => f.status === 'packed').length,
      packedToday: scopedPacked.length,
      dispatchedToday: dispatchedToday.length,
      onHold: active.filter((f) => f.status === 'on_hold').length,
      atRisk: unpacked.filter(isAtRisk).length,
      late: active.filter(isLate).length,
      nextCarrierPickupAt: pickups.next?.toISOString() ?? null,
      shipByCutoff: pickups.today[0]?.toISOString() ?? null,
      pickupsToday: pickups.today.map((d) => d.toISOString()),
      openShortages: active.reduce((n, f) => n + f.discrepancy_ids.filter((d) => d.open && d.kind === 'pick_shortage').length, 0),
      putawayOpen,
      returnParcelsExpected: expected,
      returnParcelsToHandOver: toHandOver,
      shipToday: active.filter(dueToday).length + dispatchedToday.filter(dueToday).length,
      urgent: await this.views.fulfillments(urgentRecs, { labels: false }),
    };
  }

  async summary(locationId?: string | null): Promise<WarehouseSummary> {
    const { date: _d, toShip: _t, dispatchedToday: _x, late: _l, shipByCutoff: _c, pickupsToday: _p, urgent: _u, ...rest } = await this.today(locationId);
    return rest;
  }

  /** What a scanned code is: a bin, a stock item, an order, a package or a return label (checked against the context) */
  async scan(q: { code: string; context?: 'pick' | 'pack' | 'putaway' | 'returns'; contextId?: string }, actor: common.Actor): Promise<ScanResult> {
    const raw = q.code?.trim() ?? '';
    const code = normalizeCode(raw);
    const result = await this.resolve(raw, code, q);
    await this.core.logScan({ context: q.context ?? 'lookup', contextId: q.contextId ?? null, code: raw, result: result.message ? `${result.kind}: ${result.message}` : result.kind, actor });
    return result;
  }

  private async resolve(raw: string, code: string, q: { context?: string; contextId?: string }): Promise<ScanResult> {
    const base: ScanResult = { code: raw, kind: 'unknown' };
    if (!code) return { ...base, message: 'Nothing scanned' };
    const ctx = q.contextId ? await this.context(q.context, q.contextId) : null;

    const bin = await this.bins.byScan(raw, ctx?.locationId ?? null);
    if (bin) {
      const view = await this.bins.view(bin);
      let message: string | null = bin.active ? null : 'This bin is not active';
      if (!message && ctx?.binCodes && !ctx.binCodes.includes(bin.code)) message = ctx.binCodes.length ? `Not on this pick list: go to ${ctx.binCodes[0]}` : 'Not on this pick list';
      if (!message && q.context === 'putaway' && ctx?.suggested && ctx.suggested !== bin.code) message = `Suggested bin is ${ctx.suggested}`;
      return { ...base, kind: 'bin', bin: view, message };
    }

    // a stock item this context knows (pick list, package) by SKU label or GTIN, else any company SKU
    let known = ctx?.items.find((i) => itemMatches(raw, i));
    if (!known && ctx?.items.length) {
      const gtins = await this.core.gtins(ctx.items.map((i) => i.stockItemId));
      known = ctx.items.find((i) => itemMatches(raw, { ...i, extraCodes: [gtins.get(i.stockItemId)] }));
    }
    if (known) return { ...base, kind: 'item', stockItemId: known.stockItemId, sku: known.sku, label: known.label, fulfillmentId: ctx?.fulfillmentId ?? null, packageId: ctx?.packageId ?? null, message: null };
    const bySku = await this.core
      .ctx.use('inventory')
      .findBySku('official', [raw])
      .catch(() => []);
    if (bySku[0]) {
      const message = ctx && (q.context === 'pick' || q.context === 'pack') ? (q.context === 'pick' ? 'Not on this pick list' : 'Not in this package') : null;
      return { ...base, kind: 'item', stockItemId: bySku[0].id, sku: bySku[0].sku, label: bySku[0].label, message };
    }

    const order = (await this.repo.find('fulfillments', { order_ref: code }, { orderBy: [['created_at', 'desc']], limit: 1 }))[0];
    if (order) return { ...base, kind: 'order', fulfillmentId: order.id, message: order.status === 'on_hold' ? order.hold_reason : null };

    const pkg = (await this.repo.find('packages', { tracking_number: [raw, code] }, { limit: 1 }))[0] ?? (isUuid(raw) ? await this.repo.get('packages', raw) : undefined);
    if (pkg) return { ...base, kind: 'package', packageId: pkg.id, fulfillmentId: pkg.fulfillment_id, message: pkg.status === 'voided' ? 'This package was voided' : null };

    const parcel = (await this.repo.find('return_parcels', { return_ref: code }, { limit: 1 }))[0] ?? (await this.repo.find('return_parcels', { tracking_number: [raw, code] }, { limit: 1 }))[0];
    if (parcel) return { ...base, kind: 'return_label', returnParcelId: parcel.id, message: parcel.status === 'expected' ? null : `Already ${parcel.status.replace('_', ' ')}` };
    if (looksLikeReturnRef(raw)) return { ...base, kind: 'return_label', message: 'Not expected: receive it as an unexpected parcel if no return matches' };

    return { ...base, message: ctx ? (q.context === 'pack' ? 'Not in this package' : 'Not on this pick list') : 'Unknown code' };
  }

  /** What a scan is checked against: a fulfillment or wave (pick), a package (pack) or a put-away task */
  private async context(kind: string | undefined, id: string) {
    type Item = { sku: string; stockItemId: string; label: string };
    if (kind === 'putaway') {
      const t = await this.repo.get('putaway_tasks', id);
      if (!t) return null;
      const info = (await this.core.stockInfo([t.stock_item_id])).get(t.stock_item_id);
      return { locationId: t.location_id, items: info ? [{ sku: info.sku, stockItemId: t.stock_item_id, label: info.label }] : ([] as Item[]), suggested: t.suggested_bin_code, binCodes: null as string[] | null, fulfillmentId: null as string | null, packageId: null as string | null };
    }
    if (kind === 'pack') {
      const p = await this.repo.get('packages', id);
      if (!p) return null;
      const f = await this.repo.get('fulfillments', p.fulfillment_id);
      const [items, lines] = await Promise.all([this.repo.find('package_items', { package_id: id }), this.repo.find('fulfillment_lines', { fulfillment_id: p.fulfillment_id })]);
      return {
        locationId: f?.location_id ?? null,
        items: items.map((i) => {
          const l = lines.find((x) => x.order_item_id === i.order_item_id);
          return { sku: l?.sku ?? '', stockItemId: i.stock_item_id, label: l?.label ?? '' };
        }),
        suggested: null,
        binCodes: null,
        fulfillmentId: p.fulfillment_id,
        packageId: id,
      };
    }
    // pick: a fulfillment or a wave
    const f = await this.repo.get('fulfillments', id);
    const fs = f ? [f] : await this.repo.find('fulfillments', { wave_id: id });
    if (!fs.length) return null;
    const lines = (await this.repo.find('fulfillment_lines', { fulfillment_id: fs.map((x) => x.id) })).filter((l) => l.state !== 'cancelled');
    const pending = lines.filter((l) => l.state === 'pending');
    return {
      locationId: fs[0]!.location_id,
      items: lines.map((l) => ({ sku: l.sku, stockItemId: l.stock_item_id, label: l.label })),
      suggested: null,
      binCodes: [...new Set((pending.length ? pending : lines).map((l) => l.bin_code).filter((x): x is string => Boolean(x)))],
      fulfillmentId: f?.id ?? null,
      packageId: null,
    };
  }

  /* ---------------------------------------------------------------- jobs */

  /** Job: not packed within atRiskMinutes of ship-by → warehouse.fulfillment.at_risk (once) and the pick-and-pack queue */
  async flagAtRisk(): Promise<number> {
    const cfg = await this.core.cfg();
    const now = this.core.now();
    const due = new Date(now.getTime() + cfg.atRiskMinutes * 60_000);
    const rows = await this.repo.find('fulfillments', { status: [...UNPACKED_STATUSES], ship_by: { op: '<=', value: due } }, { orderBy: [['ship_by', 'asc']], limit: 500 });
    let flagged = 0;
    for (const f of rows) {
      const first = await this.repo.transaction(async (tx) => {
        if (!(await tx.claim(`at-risk:${f.id}`))) return false;
        await this.core.logScan({ context: 'at_risk', contextId: f.id, code: f.order_ref, result: f.status, actor: SYSTEM }, tx);
        return true;
      });
      if (!first) continue;
      this.core.publish('warehouse.fulfillment.at_risk', { fulfillmentId: f.id, orderId: f.order_id, shipBy: f.ship_by.toISOString(), status: f.status });
      await this.core.soft('workqueues', 'at-risk pick and pack', (w) =>
        w.raise({
          sourceModule: 'warehouse',
          queueKey: 'warehouse.pick_pack',
          kind: 'pick_pack',
          title: `Pack ${f.order_ref} before ${f.ship_by.toISOString().slice(11, 16)} UTC`,
          summary: f.status === 'on_hold' ? (f.hold_reason ?? 'On hold') : `Not packed yet (${f.status.replace('_', ' ')}); ship-by is close`,
          subject: { type: 'order', id: f.order_id, ref: f.order_ref },
          dueAt: f.ship_by.toISOString(),
          priority: f.ship_by.getTime() <= now.getTime() ? 'urgent' : 'high',
          dedupeKey: `pick_pack:${f.id}`,
        }),
      );
      flagged++;
    }
    return flagged;
  }

  /** Job (when enabled, during business hours): a wave per location from orders awaiting pick due by the next carrier pickup */
  async autoWave(): Promise<number> {
    const cfg = await this.core.cfg();
    if (!cfg.autoWaveEnabled) return 0;
    if (!inBusinessHours(await this.core.soft('settings', 'business hours', (s) => s.businessCalendar()), this.core.now())) return 0;
    const next = this.core.pickups(cfg).next;
    if (!next) return 0;
    const waiting = await this.repo.find('fulfillments', { status: 'awaiting_pick', wave_id: null, ship_by: { op: '<=', value: next } });
    let created = 0;
    for (const locationId of [...new Set(waiting.map((f) => f.location_id))]) {
      await this.fulfillments.createWave({ locationId, carrierPickupAt: next.toISOString() }, { actor: SYSTEM });
      created++;
    }
    return created;
  }
}
