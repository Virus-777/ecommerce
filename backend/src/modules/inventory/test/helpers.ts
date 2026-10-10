/**
 * Shared setup for the inventory behaviour tests: the app with inventory, access, audit, reports,
 * work queues and finance running, a movable clock, and recorded events, audit entries and calls.
 *
 * Stubbed APIs (modules not built yet, or answers the tests control):
 *   access.check → h.access.decision (allowed unless a test says otherwise); requestApproval → new request id;
 *     cancelApproval / approvalInfo → recorded / "Waiting for Dana Ortiz".
 *   audit.record → recorded in h.audits.
 *   reports.registerDataset / requestExport / getExport → recorded calls and ExportJobs.
 *   workqueues.raise → recorded in h.raised.
 *   finance.recordCompanyCost → recorded in h.costs.
 *   catalog.getProduct → products registered in h.products; catalog.getVariants → their variants (gtin when registered).
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { devClaims, type DevOptions } from '../../../kernel/auth/dev.js';
import { fixedClock } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type { InventoryPublicApi, StockItem } from '../../../spec/inventory.js';
import type * as reports from '../../../spec/reports.js';
import { auth, buildTestApp, token } from '../../../testing/app.js';

export const INVENTORY_EVENTS = [
  'inventory.stock.changed',
  'inventory.stock.low',
  'inventory.stock.low_digest',
  'inventory.reservation.allocated',
  'inventory.reservation.released',
  'inventory.adjustment.recorded',
  'inventory.receipt.confirmed',
  'inventory.return_outcome.recorded',
  'inventory.discrepancy.reported',
  'inventory.discrepancy.resolved',
  'inventory.hold.review_due',
  'inventory.transfer.received',
] as const;

export interface Harness {
  app: FastifyInstance;
  clock: ReturnType<typeof fixedClock>;
  api: InventoryPublicApi;
  access: { decision: access.AuthorityCheck['decision']; requests: access.RequestApprovalInput[]; cancelled: { requestId: string; reason: string }[]; lastRequestId: string | null };
  audits: audit.RecordInput[];
  events: { name: string; payload: any }[];
  exports: { requested: unknown[]; registered: string[] };
  raised: unknown[];
  costs: unknown[];
  /** catalog.getProduct answers from here */
  products: Map<string, { id: string; title: string; categoryId?: string | null; variants: { id: string; options: Record<string, string>; images: []; gtin?: string | null }[] }>;
}

export async function harness(opts: { launchPhase?: number } = {}): Promise<Harness> {
  const clock = fixedClock(new Date());
  const h = {
    clock,
    access: { decision: 'allowed' as access.AuthorityCheck['decision'], requests: [] as access.RequestApprovalInput[], cancelled: [] as { requestId: string; reason: string }[], lastRequestId: null as string | null },
    audits: [] as audit.RecordInput[],
    events: [] as { name: string; payload: any }[],
    exports: { requested: [] as unknown[], registered: [] as string[] },
    raised: [] as unknown[],
    costs: [] as unknown[],
    products: new Map() as Harness['products'],
  };
  const job = (over: Partial<reports.ExportJob> = {}): reports.ExportJob => ({
    id: newId(),
    ref: 'EX-261009-0001',
    dataset: 'inventory.seller.stock',
    format: 'csv',
    filters: {},
    requestedBy: { kind: 'seller', id: newId(), name: 'Avery Stone' },
    state: 'queued',
    columnsExcluded: [],
    createdAt: clock.now().toISOString(),
    ...over,
  });
  const app = await buildTestApp({
    only: ['inventory', 'access', 'audit', 'reports', 'workqueues', 'finance'],
    clock,
    config: { rateLimits: false, launchPhase: opts.launchPhase ?? 4 },
    apiStubs: {
      access: {
        check: async (_p, action) => ({
          decision: h.access.decision,
          action,
          reason: h.access.decision === 'allowed' ? 'Within your 50 units limit' : h.access.decision === 'denied' ? 'Your role cannot adjust company stock' : 'Above your limit: Inventory Manager approval',
          requiresSecondReviewer: h.access.decision === 'approval_required',
          approvalsNeeded: h.access.decision === 'approval_required' ? 1 : 0,
          eligibleApproverRoles: [],
          eligibleApprovers: [],
          stepUpRequired: false,
        }),
        requestApproval: async (input) => {
          h.access.requests.push(input);
          const id = newId();
          h.access.lastRequestId = id;
          return { id, ref: 'AP-261009-0001', target: input.target, summary: input.summary, status: 'pending' } as unknown as access.ApprovalRequest;
        },
        cancelApproval: async (requestId, _by, reason) => {
          h.access.cancelled.push({ requestId, reason });
        },
        approvalInfo: async (id) => ({ required: true, reason: 'Waiting for Dana Ortiz', approvalRequestId: id, approvers: ['Dana Ortiz'] }),
      },
      audit: {
        record: async (entry) => {
          h.audits.push(entry);
          return newId();
        },
      },
      reports: {
        registerDataset: async (d) => {
          h.exports.registered.push(d.key);
        },
        requestExport: async (input) => {
          h.exports.requested.push(input);
          return job({ format: input.format, filters: input.filters, sellerId: input.sellerId ?? null, requestedBy: { kind: 'seller', id: input.principal.accountId ?? null, name: 'Avery Stone' } });
        },
        getExport: async (id) => job({ id, state: 'ready', downloadUrl: 'https://files.example/stock.csv?sig=1', sellerId: lastSeller.sellerId, requestedBy: { kind: 'seller', id: lastSeller.accountId } }),
      },
      workqueues: {
        raise: async (input) => {
          h.raised.push(input);
          return { id: newId() } as never;
        },
      },
      catalog: {
        getProduct: async (id) => (h.products.get(id) as never) ?? null,
        getVariants: async (ids) =>
          [...h.products.values()].flatMap((p) => p.variants.filter((v) => ids.includes(v.id)).map((v) => ({ id: v.id, productId: p.id, productTitle: p.title, options: v.options, gtin: v.gtin ?? null }))),
      },
      finance: {
        recordCompanyCost: async (input) => {
          h.costs.push(input);
        },
      },
    },
  });
  for (const name of INVENTORY_EVENTS) app.kernel.events.subscribe('test', name, (e) => void h.events.push({ name, payload: e.payload }));
  return { ...h, app, api: app.kernel.boot.apis.get('inventory') as InventoryPublicApi };
}

/** getExport stub answers for this seller member */
export const lastSeller = { sellerId: '', accountId: '' };

/** Long-lived dev tokens, so tests can move the clock */
export const staffHeaders = (permissions?: string[], name = 'Priya Nair') => auth(token({ ...devClaims('staff', { permissions }), dev: { permissions: permissions ?? ['*'], name } }, 400 * 86_400));
export const sellerHeaders = (o: DevOptions & { name?: string } = {}) => {
  const c = devClaims('seller', o);
  return auth(token({ ...c, dev: { ...c.dev, name: o.name ?? 'Avery Stone' } }, 400 * 86_400));
};

export async function call(h: Harness, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, headers: Record<string, string>, payload?: unknown) {
  const res = await h.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  await h.app.kernel.events.drain();
  return res;
}

export const admin = (h: Harness, method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, payload?: unknown, headers = staffHeaders()) => call(h, method, `/api/admin/inventory${path}`, headers, payload);
export const seller = (h: Harness, sellerId: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, payload?: unknown, o: DevOptions = {}) => call(h, method, `/api/seller/inventory${path}`, sellerHeaders({ sellerId, ...o }), payload);

export const ADDRESS = { name: 'Marketly Reno', line1: '100 Logistics Way', city: 'Reno', region: 'NV', postalCode: '89502', country: 'US' };

/** A company warehouse (the first one becomes the default) */
export async function warehouse(h: Harness, code = `W${Math.floor(Math.random() * 1e6)}`, over: Record<string, unknown> = {}) {
  const res = await admin(h, 'POST', '/locations', { code, name: `${code} warehouse`, address: ADDRESS, timeZone: 'America/Los_Angeles', ...over });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json() as { id: string; code: string; isDefault: boolean };
}

let skuSeq = 0;
export const sku = (prefix = 'SKU') => `${prefix}-${++skuSeq}-${Math.floor(Math.random() * 1e6)}`;

export async function sellerItem(h: Harness, sellerId: string, initialAvailable: number, over: Partial<Parameters<InventoryPublicApi['createStockItem']>[0]> = {}): Promise<StockItem> {
  const item = await h.api.createStockItem({ ownerType: 'seller', sellerId, offerId: newId(), sku: sku('SEL'), productId: newId(), variantId: newId(), condition: 'new', label: 'Halden Aurora ANC Headphones, Black', initialAvailable, ...over });
  await h.app.kernel.events.drain();
  return item;
}

export async function officialItem(h: Harness, locationId: string, initialAvailable: number, over: Partial<Parameters<InventoryPublicApi['createStockItem']>[0]> = {}): Promise<StockItem> {
  const item = await h.api.createStockItem({ ownerType: 'official', offerId: newId(), sku: sku('HAL'), productId: newId(), variantId: newId(), condition: 'new', label: 'Halden Aurora ANC Headphones, Silver', initialAvailable, locationId, ...over });
  await h.app.kernel.events.drain();
  return item;
}

export const quantities = async (h: Harness, id: string) => (await admin(h, 'GET', `/stock-items/${id}`)).json().item.quantities as { available: number; reserved: number; incoming: number; damagedHeld: number; returned: number };

export const eventsNamed = (h: Harness, name: string) => h.events.filter((e) => e.name === name).map((e) => e.payload);

/**
 * The ledger proves the quantities: for every item and location, each group equals the units moved
 * into it minus the units moved out of it.
 */
export async function ledgerMismatches(h: Harness): Promise<unknown[]> {
  const rows = await sql<{ stock_item_id: string; location_id: string; group: string; level: number; ledger: number }>`
    with moves as (
      select stock_item_id, location_id, to_group as grp, quantity as q from inventory.stock_movements where to_group <> 'outside'
      union all
      select stock_item_id, location_id, from_group as grp, -quantity as q from inventory.stock_movements where from_group <> 'outside'
    ),
    ledger as (select stock_item_id, location_id, grp, sum(q)::int as n from moves group by 1, 2, 3),
    levels as (
      select stock_item_id, location_id, g.grp, case g.grp when 'available' then available when 'reserved' then reserved when 'incoming' then incoming when 'damaged_held' then damaged_held else returned end as n
      from inventory.stock_levels cross join (values ('available'), ('reserved'), ('incoming'), ('damaged_held'), ('returned')) as g(grp)
    )
    select l.stock_item_id, l.location_id, l.grp as group, l.n as level, coalesce(m.n, 0) as ledger
    from levels l left join ledger m on m.stock_item_id = l.stock_item_id and m.location_id = l.location_id and m.grp = l.grp
    where l.n <> coalesce(m.n, 0)`.execute(h.app.kernel.database.kysely);
  return rows.rows;
}

/** Open reservation lines account for every Reserved unit */
export async function reservedMismatches(h: Harness): Promise<unknown[]> {
  const rows = await sql`
    select l.stock_item_id, l.location_id, l.reserved, coalesce(sum(r.quantity - r.fulfilled_qty - r.released_qty), 0)::int as open
    from inventory.stock_levels l
    left join inventory.reservation_lines r on r.stock_item_id = l.stock_item_id and r.location_id = l.location_id and r.state in ('held', 'allocated')
    group by l.stock_item_id, l.location_id, l.reserved
    having l.reserved <> coalesce(sum(r.quantity - r.fulfilled_qty - r.released_qty), 0)`.execute(h.app.kernel.database.kysely);
  return rows.rows;
}
