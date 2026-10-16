/**
 * Seller-owned stock held by Marketly: the ownership ledger per SKU, totals and the seller overview (stock,
 * open inbound, fees this and last month, alerts), daily storage snapshots with age buckets, the weekly
 * aged-stock notice and the low-stock notice for Marketly-held items.
 */
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { SellerServiceOverview } from '../../../spec/fulfillment-service.js';
import { ageBuckets, cubicFeet, onHandBlocks, physicalUnits, plural, previousMonth, round4, sumStock, unitsOlderThan } from '../domain/rules.js';
import type { SkuRec } from '../ports.js';
import { notFound, Part } from './core.js';

/** SKU enrollments per batch of the storage snapshot job */
const SNAPSHOT_BATCH = 500;

export class StockPart extends Part {
  async movements(sellerId: string, skuId: string, page: PageRequest) {
    await this.parts.skus.ownSku(sellerId, skuId);
    const res = await this.repo.page('ownership_ledger', { sku_enrollment_id: skuId, seller_id: sellerId }, page, { order: { column: 'at', direction: 'desc' } });
    return {
      ...res,
      items: res.items.map((m) => ({ movement: m.movement, quantity: m.quantity, fromGroup: m.from_group, toGroup: m.to_group, reference: m.reference, reason: m.reason, at: m.at.toISOString() })),
    };
  }

  /** Units of a seller physically in our warehouse */
  async unitsHeld(sellerId: string): Promise<number> {
    const skus = await this.repo.find('sku_enrollments', { seller_id: sellerId });
    const balances = await this.repo.balances(skus.map((s) => s.id));
    return skus.reduce((n, s) => n + physicalUnits(balances, s.id), 0);
  }

  async overview(sellerId: string): Promise<SellerServiceOverview> {
    const row = await this.parts.enrollment.own(sellerId);
    if (!row) throw notFound('Enrollment');
    const skus = await this.repo.find('sku_enrollments', { seller_id: sellerId });
    const stock = await this.parts.views.stock(skus);
    const month = this.core.month();
    const [enrollment, openInbound, thisMonth, lastMonth, longTermDays] = await Promise.all([
      this.parts.views.enrollment(row),
      this.parts.inbound.open(sellerId),
      this.parts.fees.totalFor(sellerId, month),
      this.parts.fees.totalFor(sellerId, previousMonth(month)),
      this.core.setting('longTermStorageDays', 365),
    ]);
    const alerts = await this.alerts(sellerId, skus, longTermDays);
    if (row.state === 'suspended') alerts.unshift(`The service is suspended: no new inbound shipments or service sales. ${row.reason ?? ''}`.trim());
    if (row.state === 'offboarding') alerts.unshift('You are leaving the service: remove or dispose of the stock still in our warehouse');
    const discrepancies = openInbound.filter((i) => i.discrepancy?.sellerResponse === 'pending');
    for (const i of discrepancies) alerts.push(`Receiving discrepancy on ${i.ref}: accept it or claim it`);
    const totals = sumStock([...stock.values()]);
    const max = enrollment.capacity.maxCubicFeet;
    if (max > 0 && totals.volumeCubicFeet / max >= 0.9) alerts.push(`${Math.round((totals.volumeCubicFeet / max) * 100)}% of your storage allowance is used`);
    return {
      enrollment,
      stockTotals: totals,
      openInbound,
      feesThisMonth: this.core.money(thisMonth.amount, thisMonth.currency),
      feesLastMonth: this.core.money(lastMonth.amount, lastMonth.currency),
      alerts,
    };
  }

  /** e.g. '12 units aged over 365 days will incur long-term storage on Nov 15' */
  private async alerts(sellerId: string, skus: readonly SkuRec[], longTermDays: number): Promise<string[]> {
    const soon = await this.approachingLongTerm(skus, longTermDays);
    if (!soon.units) return [];
    const when = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: this.core.tz }).format(soon.firstAt!);
    void sellerId;
    return [`${plural(soon.units, 'unit')} aged over ${longTermDays} days will incur long-term storage from ${when}`];
  }

  /** Units reaching longTermStorageDays within 30 days, and the first date one does */
  private async approachingLongTerm(skus: readonly SkuRec[], longTermDays: number): Promise<{ units: number; firstAt: Date | null }> {
    const ids = skus.map((s) => s.id);
    if (!ids.length) return { units: 0, firstAt: null };
    const [balances, inflows] = await Promise.all([this.repo.balances(ids), this.repo.inflows(ids)]);
    const now = this.now();
    let units = 0;
    let firstAt: Date | null = null;
    for (const s of skus) {
      const blocks = onHandBlocks(
        physicalUnits(balances, s.id),
        inflows.get(s.id) ?? [],
      );
      for (const b of blocks) {
        const reaches = new Date(b.at.getTime() + longTermDays * 86_400_000);
        if (reaches > now && reaches.getTime() - now.getTime() <= 30 * 86_400_000) {
          units += b.units;
          if (!firstAt || reaches < firstAt) firstAt = reaches;
        }
      }
    }
    return { units, firstAt };
  }

  /* ---------------------------------------------------------------- jobs */

  /** Job fulfillment-service.storage-snapshot: units and volume per seller SKU with age buckets (idempotent per day) */
  async snapshot(day: string = this.core.today()): Promise<{ skus: number }> {
    const longTermDays = await this.core.setting('longTermStorageDays', 365);
    const now = this.now();
    let n = 0;
    // every SKU enrollment by id, 500 at a time, one write per batch
    for (let after: string | null = null; ; ) {
      const batch: SkuRec[] = await this.repo.find('sku_enrollments', after ? { id: { op: '>', value: after } } : {}, { orderBy: [['id', 'asc']], limit: SNAPSHOT_BATCH });
      if (!batch.length) break;
      const ids = batch.map((s) => s.id);
      const [balances, inflows] = await Promise.all([this.repo.balances(ids), this.repo.inflows(ids)]);
      const rows = batch.flatMap((s) => {
        const units = physicalUnits(balances, s.id);
        if (!units) return [];
        const blocks = onHandBlocks(units, inflows.get(s.id) ?? []);
        return [{ day, seller_id: s.seller_id, sku_enrollment_id: s.id, units, cubic_feet: String(round4(units * cubicFeet(s.dimensions))), aged_units: { ...ageBuckets(blocks, now), longTerm: unitsOlderThan(blocks, now, longTermDays) } }];
      });
      await this.repo.upsertSnapshots(rows);
      n += rows.length;
      if (batch.length < SNAPSHOT_BATCH) break;
      after = batch.at(-1)!.id;
    }
    return { skus: n };
  }

  /** Job fulfillment-service.aged-stock-notice: sellers with units reaching long-term storage within 30 days */
  async agedNotice(): Promise<{ sellers: number; disposals: number }> {
    const longTermDays = await this.core.setting('longTermStorageDays', 365);
    const skus = await this.repo.find('sku_enrollments', {}, { limit: 50_000 });
    const bySeller = new Map<string, SkuRec[]>();
    for (const s of skus) {
      const list = bySeller.get(s.seller_id);
      if (list) list.push(s);
      else bySeller.set(s.seller_id, [s]);
    }
    let sellers = 0;
    const week = Math.floor(this.now().getTime() / (7 * 86_400_000));
    for (const [sellerId, list] of bySeller) {
      const soon = await this.approachingLongTerm(list, longTermDays);
      if (!soon.units) continue;
      sellers += 1;
      const when = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: this.core.tz }).format(soon.firstAt!);
      await this.core.notifySeller(sellerId, 'seller.fulfillment.stock_aged', { units: soon.units, effective: when, days: longTermDays }, { kind: 'queue', id: sellerId, label: 'View stock', screen: 'seller/inventory' }, `fs:aged:${sellerId}:${week}`);
    }
    const disposals = await this.parts.removals.disposeAbandoned();
    return { sellers, disposals };
  }

  /** inventory.stock.low for a Marketly-held item (serviceManaged): the seller is asked to send more */
  async onStockLow(e: EventPayload<'inventory.stock.low'>): Promise<void> {
    if (!e.serviceManaged || e.ownerType !== 'seller' || !e.sellerId || !isUuid(e.stockItemId)) return;
    const sku = await this.repo.findOne('sku_enrollments', { inventory_item_id: e.stockItemId, state: 'active' });
    if (!sku || sku.seller_id !== e.sellerId) return;
    await this.core.notifySeller(sku.seller_id, 'seller.fulfillment.stock_low', { stock: { label: e.label, sku: sku.sku }, available: e.available }, { kind: 'queue', id: sku.id, ref: sku.sku, label: 'Plan an inbound shipment', screen: 'seller/inventory' }, `fs:low:${sku.id}:${this.core.today()}`);
  }
}
