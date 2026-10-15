/**
 * Test kit for trust: boots trust with audit, workqueues, media, offers, catalog, sellers, customers and reports
 * (their answers stubbed so tests control them; their own trust consumers still run), access stubbed for
 * authority, staff names and approvals. Captures events, audit entries, work items and calls.
 */
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { devClaims } from '../../../kernel/auth/dev.js';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import { auth, buildTestApp, movingClock, token } from '../../../testing/app.js';
import type { TrustService } from '../service.js';

export const STORE = '/api/store/trust';
export const SELLER = '/api/seller/trust';
export const ADMIN = '/api/admin/trust';
export const PUBLIC = '/api/public/trust';

export type Decision = 'allowed' | 'approval_required' | 'denied';

export interface Kit {
  app: FastifyInstance;
  svc: TrustService;
  clock: ReturnType<typeof movingClock>;
  events: EventEnvelope[];
  audits: audit.RecordInput[];
  work: { queueKey: string; kind: string; dedupeKey: string; title: string }[];
  calls: { fn: string; args: unknown[] }[];
  /** access.check answer per action key (default allowed), with the caller's authority */
  authority: Map<string, { decision: Decision; authority?: string }>;
  /** access approval request status by id (default pending) */
  approvalStatus: Map<string, string>;
  offers: Map<string, { sellerId: string | null; sellerName: string; productId: string; price: number; status?: string }>;
  products: Map<string, { title: string; ownerSellerId?: string | null; brandId?: string; publication?: string }>;
  sellers: Map<string, { storeName: string; status?: string }>;
  stats: Map<string, { lowest: number; highest: number }>;
  customers: Map<string, { displayName: string; userId?: string }>;
  of(name: string): any[];
  last(name: string): any;
  callsOf(fn: string): unknown[][];
  call(method: string, url: string, token: string, body?: unknown): Promise<{ status: number; body: any }>;
  /** Publish another module's event and wait for the consumers */
  emit(source: string, name: string, payload: unknown, actor?: { kind: string; id?: string | null }): Promise<void>;
  job(name: string): Promise<void>;
  close(): Promise<void>;
}

export async function boot(): Promise<Kit> {
  const clock = movingClock();
  const audits: audit.RecordInput[] = [];
  const work: Kit['work'] = [];
  const calls: Kit['calls'] = [];
  const authority: Kit['authority'] = new Map();
  const approvalStatus = new Map<string, string>();
  const requested = new Map<string, access.RequestApprovalInput>();
  const offers: Kit['offers'] = new Map();
  const products: Kit['products'] = new Map();
  const sellers: Kit['sellers'] = new Map();
  const stats: Kit['stats'] = new Map();
  const customers: Kit['customers'] = new Map();
  const rec = (fn: string, ...args: unknown[]) => void calls.push({ fn, args });
  const offerOf = (id: string) => {
    const o = offers.get(id);
    return o ? ({ id, ownerType: o.sellerId ? 'seller' : 'official', sellerId: o.sellerId, sellerName: o.sellerName, productId: o.productId, variantId: newId(), price: { amount: o.price, currency: 'USD' }, status: o.status ?? 'active' } as any) : null;
  };
  const productOf = (id: string) => {
    const p = products.get(id);
    return p ? ({ id, ref: `PRD-${id.slice(-5)}`, title: p.title, brand: p.brandId ? { id: p.brandId, name: 'Brightline' } : null } as any) : null;
  };
  const app = await buildTestApp({
    modules: withDependencies(['trust', 'audit', 'workqueues', 'media', 'offers', 'catalog', 'sellers', 'customers', 'reports', 'identity', 'notifications']),
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      access: {
        check: async (_p: any, action: string) => {
          const a = authority.get(action) ?? { decision: 'allowed' as Decision };
          rec('access.check', action);
          return { decision: a.decision, action, reason: a.decision === 'allowed' ? 'Within your authority' : a.decision === 'denied' ? 'Your role has no authority' : 'Above your limit: Business Owner approval', callerLimit: { authority: a.authority ?? (a.decision === 'denied' ? 'not_permitted' : 'permitted'), secondReviewerRoleKeys: [] }, requiresSecondReviewer: a.decision === 'approval_required', approvalsNeeded: a.decision === 'approval_required' ? 1 : 0, eligibleApproverRoles: [], eligibleApprovers: [] } as any;
        },
        requestApproval: async (input: access.RequestApprovalInput) => {
          const id = newId();
          rec('access.requestApproval', input);
          requested.set(id, input);
          return { id, ref: 'AP-1', status: 'pending', target: input.target } as any;
        },
        // the approval as access shows it: pending requests made through requestApproval above
        approvalInfo: async (id: string) =>
          requested.has(id) && (approvalStatus.get(id) ?? 'pending') === 'pending'
            ? { required: true, reason: 'Above your limit: Business Owner approval', approvalRequestId: id, approvers: ['Business Owner'] }
            : { required: false, reason: 'Approval request not found', approvalRequestId: id, approvers: [] },
        getApproval: async (id: string) => {
          const input = requested.get(id);
          return { id, status: approvalStatus.get(id) ?? 'pending', reason: input?.reason ?? '', details: input?.details ?? null, requestedBy: { kind: 'staff', id: input?.requestedBy.accountId ?? null } } as any;
        },
        getStaffRef: async (id: string) => ({ accountId: id, name: `Staff ${id.slice(-4)}`, away: false, roleLabel: 'Trust and Risk Manager' }),
        hasPermission: async () => true,
        membersOfRole: async () => [],
      },
      audit: {
        record: async (entry: audit.RecordInput) => {
          audits.push(entry);
          return newId();
        },
      },
      workqueues: {
        raise: async (input: any) => {
          work.push(input);
          return { id: newId() } as any;
        },
        resolveBySource: async (key: string) => {
          rec('workqueues.resolveBySource', key);
          return 1;
        },
      },
      media: {
        attach: async (...args: unknown[]) => rec('media.attach', ...args),
        refs: async (ids: string[]) => ids.map((id) => ({ id, url: `https://media.example.com/${id}` })),
      },
      offers: {
        getOfferAdmin: async (id: string) => offerOf(id),
        getOffer: async (id: string) => offerOf(id),
        listActiveOffersForProduct: async (productId: string) => [...offers.keys()].filter((id) => offers.get(id)!.productId === productId && (offers.get(id)!.status ?? 'active') === 'active').map(offerOf),
        getOfferStats: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, stats.has(id) ? { count: 2, lowest: { amount: stats.get(id)!.lowest, currency: 'USD' }, highest: { amount: stats.get(id)!.highest, currency: 'USD' }, lowestOfferId: newId(), lowestSellerName: 'x' } : null])) as any,
      },
      catalog: {
        getProduct: async (id: string) => productOf(id),
        getProductAdmin: async (id: string) => {
          const p = products.get(id);
          return p ? ({ product: productOf(id), owner: p.ownerSellerId ? 'seller' : 'official', ownerSellerId: p.ownerSellerId ?? null, publication: p.publication ?? 'active' } as any) : null;
        },
      },
      sellers: {
        getSeller: async (id: string) => (sellers.has(id) ? ({ id, ref: `SL-${id.slice(-5)}`, slug: 's', storeName: sellers.get(id)!.storeName, status: sellers.get(id)!.status ?? 'approved' } as any) : null),
        getSellers: async (ids: string[]) => ids.filter((id) => sellers.has(id)).map((id) => ({ id, ref: `SL-${id.slice(-5)}`, slug: `store-${id.slice(-5)}`, storeName: sellers.get(id)!.storeName, status: sellers.get(id)!.status ?? 'approved' }) as any),
      },
      customers: {
        getCustomer: async (id: string) => (customers.has(id) ? ({ id, userId: customers.get(id)!.userId ?? newId(), ref: `CU-${id.slice(-6)}`, displayName: customers.get(id)!.displayName, email: 'c@example.com', accountStatus: 'active', canOrder: true, canMessage: true } as any) : null),
        getCustomerByUserId: async (userId: string) => {
          const [id, c] = [...customers].find(([, x]) => x.userId === userId) ?? [];
          return id && c ? ({ id, userId, ref: `CU-${id.slice(-6)}`, displayName: c.displayName, email: 'c@example.com', accountStatus: 'active', canOrder: true, canMessage: true } as any) : null;
        },
      },
      notifications: {
        resolve: async (key: string) => {
          rec('notifications.resolve', key);
          return 1;
        },
      },
      identity: {
        getAccount: async (id: string) => ({ id, realm: 'member', email: `Account.${id.slice(-6)}@Example.com`, displayName: 'Account', status: 'active', emailVerified: true, twoStepEnabled: false }) as any,
      },
      reports: {
        registerDataset: async (d: any) => rec('reports.registerDataset', d),
        requestExport: async (input: any) => {
          rec('reports.requestExport', input);
          return { id: newId(), ref: 'EX-1', dataset: input.dataset, format: input.format, filters: input.filters, requestedBy: { kind: 'staff', id: input.principal?.accountId ?? null }, state: 'queued', columnsExcluded: [], createdAt: new Date().toISOString() } as any;
        },
      },
    },
  });
  const svc = app.kernel.boot.apis.get('trust') as unknown as TrustService;
  const events: EventEnvelope[] = [];
  for (const name of Object.keys((await import('../../../spec/trust.js')).spec.events.publishes)) app.kernel.events.subscribe('test', name, (e) => void events.push(e));
  const kit: Kit = {
    app,
    svc,
    clock,
    events,
    audits,
    work,
    calls,
    authority,
    approvalStatus,
    offers,
    products,
    sellers,
    stats,
    customers,
    of: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
    last: (name) => kit.of(name).at(-1),
    callsOf: (fn) => calls.filter((c) => c.fn === fn).map((c) => c.args),
    async call(method, url, t, body) {
      const res = await app.inject({ method: method as never, url, headers: auth(t), ...(body !== undefined ? { payload: body as object } : {}) });
      await app.kernel.events.drain();
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    },
    async emit(source, name, payload, actor) {
      app.kernel.events.publish(source, name, payload, actor ? { actor: actor as never } : {});
      await app.kernel.events.drain();
    },
    async job(name) {
      await app.kernel.jobs.runNow(name);
      await app.kernel.events.drain();
    },
    close: () => app.close(),
  };
  return kit;
}

/* ---------------------------------------------------------------- callers */

const TTL = 60 * 86_400;
export const staff = (id = newId(), permissions: string[] = ['*']) => token({ ...devClaims('staff', { permissions }), sub: id }, TTL);
export const customer = (accountId = newId()) => token(devClaims('customer', { accountId }), TTL);
export const seller = (sellerId: string, permissions?: string[]) => token(devClaims('seller', { sellerId, ...(permissions ? { permissions } : {}) }), TTL);
export const visitor = () => token(devClaims('visitor', { audience: 'store' }), TTL);

/** Trust staff (investigate and decide) and an owner team member, as separate people */
export const TRUST_PERMS = ['trust.reports.view', 'trust.reports.investigate', 'trust.reports.decide', 'trust.enforcements.reverse', 'trust.appeals.decide', 'trust.rules.manage', 'trust.reports.export'];

/* ---------------------------------------------------------------- flows */

/** A seller offer of a product (stubbed in offers and catalog) */
export function listing(kit: Kit, o: { price?: number; storeName?: string } = {}) {
  const sellerId = newId();
  const productId = newId();
  const offerId = newId();
  kit.sellers.set(sellerId, { storeName: o.storeName ?? 'Gadget Grove' });
  kit.products.set(productId, { title: 'Brightline S2 Robot Vacuum' });
  kit.offers.set(offerId, { sellerId, sellerName: o.storeName ?? 'Gadget Grove', productId, price: o.price ?? 19900 });
  return { sellerId, productId, offerId };
}

/** A customer report on an offer; returns the report id */
export async function customerReport(kit: Kit, offerId: string, who = customer()) {
  const res = await kit.call('POST', `${STORE}/reports`, who, { type: 'counterfeit', subject: { type: 'offer', id: offerId }, reason: 'may_be_counterfeit', details: 'The serial number does not match the box' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

/** A staff report about the given subjects */
export async function staffReport(kit: Kit, subjects: { type: string; id: string; label?: string }[], o: { type?: string; by?: string; evidence?: unknown[] } = {}) {
  const res = await kit.call('POST', `${ADMIN}/reports`, staff(o.by), { type: o.type ?? 'counterfeit', title: 'Suspected counterfeit units', description: 'Brand registry mismatch on 4 units', subjects: subjects.map((s) => ({ label: s.type, ...s })), evidence: o.evidence ?? [] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** Draft and route a recommendation (by one trust staff member); returns the recommendation */
export async function routed(kit: Kit, reportId: string, body: Record<string, unknown>, trustStaff = newId()) {
  const add = await kit.call('POST', `${ADMIN}/reports/${reportId}/recommendations`, staff(trustStaff), { rationale: 'Confirmed by the brand owner', label: 'Act on it', ...body });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  const route = await kit.call('POST', `${ADMIN}/recommendations/${add.body.id}/route`, staff(trustStaff));
  expect(route.status, JSON.stringify(route.body)).toBe(200);
  return { ...route.body, trustStaff };
}
