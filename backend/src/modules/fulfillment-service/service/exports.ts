/**
 * Report datasets (K16): registered with reports at boot when reports is on, rows served by exportRows.
 * Seller datasets return the principal's own rows only; staff datasets are staff-only (reports checks the dataset permission).
 */
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import { isUuid } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { Principal } from '../../../spec/identity.js';
import type { ExportDataset } from '../../../spec/reports.js';
import { CHARGE_LABEL } from '../domain/rules.js';
import type { ChargeRec, SkuRec } from '../ports.js';
import { notFound, Part } from './core.js';

export const DATASETS = {
  sellerFees: 'fulfillment-service.seller.fees',
  sellerStock: 'fulfillment-service.seller.stock',
  stockByOwner: 'fulfillment-service.admin.stock_by_owner',
  adminFees: 'fulfillment-service.admin.fees',
} as const;

const BATCH = 200;
const col = (pairs: [string, string][]) => pairs.map(([key, label]) => ({ key, label }));
const FEE_COLUMNS: [string, string][] = [['type', 'Fee'], ['period', 'Period'], ['reference', 'Reference'], ['units', 'Units'], ['rate', 'Rate'], ['amount', 'Amount'], ['currency', 'Currency'], ['state', 'State'], ['postedAt', 'Posted'], ['reason', 'Reason']];
const STOCK_COLUMNS: [string, string][] = [['sku', 'SKU'], ['title', 'Item'], ['state', 'Service state'], ['sizeTier', 'Size tier'], ['available', 'Available'], ['reserved', 'Reserved'], ['inbound', 'Inbound'], ['receiving', 'Receiving'], ['unsellable', 'Unsellable'], ['returned', 'Returned'], ['removalPending', 'Removal pending'], ['volumeCubicFeet', 'Cubic feet']];

export class ExportsPart extends Part {
  #registered?: Promise<void>;

  /** At boot (afterBoot): reports lists the four datasets */
  registerDatasets(): Promise<void> {
    const reports = this.ctx.tryUse('reports');
    if (!reports) return Promise.resolve();
    const base = { owner: this.ctx.name, available: true, phase: 4 };
    const sets: ExportDataset[] = [
      { ...base, key: DATASETS.sellerFees, title: 'Fulfilled by Marketly fees', permission: 'fulfillment-service.fees.view', audience: 'seller', screens: ['seller/finance'], columns: col(FEE_COLUMNS) },
      { ...base, key: DATASETS.sellerStock, title: 'Stock held by Marketly', permission: 'fulfillment-service.inbound.manage', audience: 'seller', screens: ['seller/inventory'], columns: col(STOCK_COLUMNS) },
      { ...base, key: DATASETS.stockByOwner, title: 'Seller stock held by Marketly', permission: 'fulfillment-service.operations.view', audience: 'staff', screens: ['ops/inventory'], columns: col([['sellerId', 'Seller id'], ['seller', 'Seller'], ...STOCK_COLUMNS]) },
      { ...base, key: DATASETS.adminFees, title: 'Fulfillment service fees', permission: 'fulfillment-service.fees.manage', audience: 'staff', screens: ['admin/finance'], columns: col([['sellerId', 'Seller id'], ['seller', 'Seller'], ...FEE_COLUMNS]) },
    ];
    this.#registered ??= Promise.all(sets.map((d) => reports.registerDataset(d)))
      .then(() => undefined)
      .catch((err) => {
        this.#registered = undefined;
        if (!isNotImplemented(err)) this.ctx.log.warn({ err }, 'fulfillment-service: export datasets not registered');
      });
    return this.#registered;
  }

  async exportRows(dataset: string, filters: unknown, principal: Principal, cursor?: string): Promise<{ rows: unknown[]; nextCursor?: string }> {
    const f = (filters && typeof filters === 'object' && !Array.isArray(filters) ? filters : {}) as Record<string, unknown>;
    const str = (k: string) => (typeof f[k] === 'string' && (f[k] as string).trim() ? (f[k] as string).trim() : undefined);
    const page: PageRequest = { mode: 'cursor', cursor: cursor ?? null, limit: BATCH };
    let sellerId: string | undefined;
    if (dataset === DATASETS.sellerFees || dataset === DATASETS.sellerStock) {
      if (principal?.kind !== 'seller' || !principal.sellerId) throw new AppError('FORBIDDEN', 'This export is for sellers');
      sellerId = principal.sellerId;
    } else if (dataset === DATASETS.stockByOwner || dataset === DATASETS.adminFees) {
      if (principal?.kind !== 'staff') throw new AppError('FORBIDDEN', 'This export is for staff');
      const s = str('sellerId');
      if (s && isUuid(s)) sellerId = s;
    } else throw notFound('Dataset');

    if (dataset === DATASETS.sellerFees || dataset === DATASETS.adminFees) {
      const where: Record<string, unknown> = {};
      if (sellerId) where.seller_id = sellerId;
      if (str('type')) where.type = str('type');
      if (str('state')) where.state = str('state');
      if (str('period')) where.period = str('period');
      else if (str('from') || str('to')) where.period = str('from') && str('to') ? { op: 'between', value: [str('from')!.slice(0, 7), str('to')!.slice(0, 7)] } : str('from') ? { op: '>=', value: str('from')!.slice(0, 7) } : { op: '<=', value: str('to')!.slice(0, 7) };
      const res = await this.repo.page('fee_charges', where, page, { order: { column: 'id', direction: 'desc' } });
      const names = dataset === DATASETS.adminFees ? await this.core.sellerNames(res.items.map((c) => c.seller_id)) : new Map<string, string>();
      const rows = res.items.map((c) => ({ ...(dataset === DATASETS.adminFees ? { sellerId: c.seller_id, seller: names.get(c.seller_id) ?? '' } : {}), ...feeRow(c) }));
      return { rows, ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}) };
    }
    const where: Record<string, unknown> = {};
    if (sellerId) where.seller_id = sellerId;
    if (str('state')) where.state = str('state');
    const res = await this.repo.page('sku_enrollments', where, page, { order: { column: 'id', direction: 'desc' } });
    const [stock, info, names] = await Promise.all([this.parts.views.stock(res.items), this.core.stockItems(res.items.map((s) => s.offer_id)), dataset === DATASETS.stockByOwner ? this.core.sellerNames(res.items.map((s) => s.seller_id)) : Promise.resolve(new Map<string, string>())]);
    const rows = res.items.map((s: SkuRec) => {
      const q = stock.get(s.id);
      return {
        ...(dataset === DATASETS.stockByOwner ? { sellerId: s.seller_id, seller: names.get(s.seller_id) ?? '' } : {}),
        sku: s.sku,
        title: info.get(s.offer_id)?.label ?? s.sku,
        state: s.state,
        sizeTier: s.size_tier,
        available: q?.available ?? 0,
        reserved: q?.reserved ?? 0,
        inbound: q?.inbound ?? 0,
        receiving: q?.receiving ?? 0,
        unsellable: q?.unsellable ?? 0,
        returned: q?.returned ?? 0,
        removalPending: q?.removalPending ?? 0,
        volumeCubicFeet: q?.volumeCubicFeet ?? 0,
      };
    });
    return { rows, ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}) };
  }
}

function feeRow(c: ChargeRec) {
  return {
    type: CHARGE_LABEL[c.type] ?? c.type,
    period: c.period ?? '',
    reference: c.reference ?? '',
    units: Number(c.units),
    rate: (c.rate / 100).toFixed(2),
    amount: (c.amount / 100).toFixed(2),
    currency: c.currency,
    state: c.state,
    postedAt: c.posted_at ? c.posted_at.toISOString() : '',
    reason: c.reason ?? '',
  };
}
