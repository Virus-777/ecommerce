/**
 * Test kit for the fulfillment service: the module with its real dependencies (inventory, warehouse, finance and
 * theirs), media for labels and returns for service returns. Access decisions and the returns lookups are
 * controlled by the test (apiStubs); everything else is real.
 */
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import type * as access from '../../../spec/access.js';
import type { FulfillmentServicePublicApi } from '../../../spec/fulfillment-service.js';
import type { InventoryPublicApi } from '../../../spec/inventory.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';

export type Decision = 'allowed' | 'approval_required' | 'denied';

export interface SellerKit {
  sellerId: string;
  token: string;
  /** An offer of this seller with its inventory stock item */
  offer(o?: { sku?: string; available?: number }): Promise<{ offerId: string; stockItemId: string; sku: string }>;
}

export interface Kit {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  staff: string;
  call(method: string, url: string, o?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any }>;
  /** Payloads of an event published so far */
  events(name: string): any[];
  publish(source: string, name: string, payload: unknown): Promise<void>;
  api: FulfillmentServicePublicApi & { parts: any };
  inventory: InventoryPublicApi;
  seller(): Promise<SellerKit>;
  /** Decision access answers per action key (default allowed) */
  authority: Map<string, Decision>;
  approvals: access.RequestApprovalInput[];
  /** returns lookups: return id → { ref, items: orderItemId → quantity } */
  returns: Map<string, { ref: string; sellerId: string; items: Map<string, number> }>;
  /** orders.getFulfillmentTask answers per seller group (others: NOT_FOUND) */
  tasks: Map<string, { orderRef: string; dueAt: string; lines: { orderItemId: string; offerId: string; stockItemId: string; quantity: number }[] }>;
  /** Enrolled, approved seller with one approved SKU */
  enrolledSeller(o?: { capacity?: { maxCubicFeet: number; maxSkus: number } }): Promise<SellerKit & { skuId: string; offerId: string; stockItemId: string; sku: string }>;
}

export const S = (path: string) => `/api/seller/fulfillment-service${path}`;
export const A = (path: string) => `/api/admin/fulfillment-service${path}`;
export const ADDRESS = { name: 'Casa Verde Home', line1: '410 Market St', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US' };
export const DIMS = { length: 30, width: 20, height: 10 };
const EVENTS = [
  'fulfillment-service.enrollment.submitted',
  'fulfillment-service.enrollment.decided',
  'fulfillment-service.inbound.submitted',
  'fulfillment-service.inbound.received',
  'fulfillment-service.return.inspected',
  'fulfillment-service.removal.completed',
  'fulfillment-service.fee.charged',
  'fulfillment-service.fee.reversed',
];

export async function boot(): Promise<Kit> {
  const clock = movingClock();
  tokenClock.now = () => clock.now();
  // tests move the clock more than a year ahead (long-term storage): tokens stay valid at the app's time
  tokenClock.ttlSeconds = 1000 * 86_400;
  const authority = new Map<string, Decision>();
  const approvals: access.RequestApprovalInput[] = [];
  const returns = new Map<string, { ref: string; sellerId: string; items: Map<string, number> }>();
  const tasks: Kit['tasks'] = new Map();
  const app = await buildTestApp({
    modules: withDependencies(['fulfillment-service', 'media', 'returns']),
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      access: {
        check: async (_p: unknown, action: string) => ({ decision: authority.get(action) ?? 'allowed', action, reason: authority.get(action) === 'approval_required' ? 'Above your limit' : '', requiresSecondReviewer: false, approvalsNeeded: 0, eligibleApproverRoles: [], eligibleApprovers: [] }) as any,
        requestApproval: async (input: access.RequestApprovalInput) => {
          approvals.push(input);
          return { id: newId(), ref: 'AP-1', ...input } as any;
        },
        getApproval: async () => ({ reason: 'Approved by Finance' }) as any,
      },
      orders: {
        getFulfillmentTask: async (groupId: string) => {
          const t = tasks.get(groupId);
          if (!t) throw new AppError('NOT_FOUND', 'Seller group not found');
          return { groupId, orderId: newId(), orderRef: t.orderRef, dispatchDeadline: { dueAt: t.dueAt, state: 'on_time' }, openLines: t.lines.map((l) => ({ ...l, title: 'Linen throw', variantLabel: 'Natural', sellerSku: null, quantityToShip: l.quantity })) } as any;
        },
      },
      returns: {
        returnStateForItems: async (ids: string[]) =>
          ids.map((orderItemId) => {
            const hit = [...returns.entries()].find(([, r]) => r.items.has(orderItemId));
            return { orderItemId, returnId: hit?.[0] ?? null, ref: hit?.[1].ref ?? null, status: hit ? 'received' : null, refundStatus: null };
          }),
        getReturnForSeller: async (sellerId: string, ref: string) => {
          const hit = [...returns.entries()].find(([, r]) => r.ref === ref && r.sellerId === sellerId);
          return hit ? ({ detail: { id: hit[0], ref, items: [...hit[1].items].map(([orderItemId, quantity]) => ({ orderItemId, quantity })) } } as any) : null;
        },
      },
    },
  });
  const seen = new Map<string, any[]>();
  for (const name of EVENTS) app.kernel.events.subscribe('test', name, (e) => void seen.set(name, [...(seen.get(name) ?? []), e.payload]));
  const staff = callers.staff();
  const call: Kit['call'] = async (method, url, o = {}) => {
    const res = await app.inject({ method: method as never, url, headers: { ...auth(o.token ?? staff), ...(o.headers ?? {}) }, ...(o.body !== undefined ? { payload: o.body as never } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const api = app.kernel.boot.apis.get('fulfillment-service') as Kit['api'];
  const inventory = app.kernel.boot.apis.get('inventory') as InventoryPublicApi;
  const seller: Kit['seller'] = async () => {
    const sellerId = newId();
    const token = callers.seller({ sellerId });
    return {
      sellerId,
      token,
      async offer(o = {}) {
        const offerId = newId();
        const sku = o.sku ?? `SKU-${offerId.slice(-6).toUpperCase()}`;
        const item = await inventory.createStockItem({ ownerType: 'seller', sellerId, offerId, sku, productId: newId(), variantId: newId(), condition: 'new', label: `Linen throw ${sku}`, initialAvailable: o.available ?? 0 });
        return { offerId, stockItemId: item.id, sku };
      },
    };
  };
  const kit: Kit = {
    app,
    clock,
    staff,
    call,
    events: (name) => seen.get(name) ?? [],
    async publish(source, name, payload) {
      app.kernel.events.publish(source, name, payload, { actor: { kind: 'system' } });
      await app.kernel.events.drain();
    },
    api,
    inventory,
    seller,
    authority,
    approvals,
    returns,
    tasks,
    async enrolledSeller(o = {}) {
      const s = await seller();
      const schedule = await call('GET', S('/fee-schedule'), { token: s.token });
      const applied = await call('POST', S('/enrollment'), { token: s.token, body: { expectedSkus: 5, expectedMonthlyUnits: 200, categories: [], termsVersion: 'FS-TERMS-1', feeScheduleVersion: schedule.body.current.version, acceptTerms: true } });
      expect(applied.status, JSON.stringify(applied.body)).toBe(201);
      const approved = await call('POST', A(`/enrollments/${applied.body.id}/decide`), { body: { decision: 'approve', reason: 'Welcome', capacity: { maxCubicFeet: 100, maxSkus: 10, usedCubicFeet: 0, usedSkus: 0, ...o.capacity } } });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      const offer = await s.offer();
      const enrolled = await call('POST', S('/skus'), { token: s.token, body: { offerId: offer.offerId, dimensionsCm: DIMS, weightGrams: 800, hazmat: false } });
      expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
      const reviewed = await call('POST', A(`/skus/${enrolled.body.id}/review`), { body: { approve: true } });
      expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
      return { ...s, ...offer, skuId: enrolled.body.id as string };
    },
  };
  return kit;
}

/** Plans, submits, ships and records the arrival of an inbound shipment; returns its id */
export async function arrivedInbound(k: Kit, s: { token: string; skuId: string }, quantity: number): Promise<string> {
  const created = await k.call('POST', S('/inbound'), { token: s.token, body: { shipFrom: ADDRESS, lines: [{ skuEnrollmentId: s.skuId, quantity }], boxes: 1 } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id as string;
  expect((await k.call('POST', S(`/inbound/${id}/submit`), { token: s.token })).status).toBe(200);
  expect((await k.call('POST', A(`/inbound/${id}/arrive`), { body: { boxesArrived: 1 } })).status).toBe(200);
  return id;
}

/** Receives everything (complete, nothing damaged) */
export async function receiveAll(k: Kit, inboundId: string, skuId: string, quantity: number) {
  const r = await k.call('POST', A(`/inbound/${inboundId}/receive`), { body: { lines: [{ skuEnrollmentId: skuId, received: quantity, damaged: 0 }], complete: true }, headers: { 'idempotency-key': newId() } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
