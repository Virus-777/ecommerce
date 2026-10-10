/**
 * Test kit for the fulfillment service: the module with its real dependencies (inventory, warehouse, finance and
 * theirs), media for labels, returns, and the optional modules it calls (shipping, notifications, workqueues,
 * audit, reports). Controlled by the test (apiStubs): access decisions, finance's seller ledger calls, the
 * orders and returns lookups, shipping's Official default profile, the notices, work items, audit entries and
 * datasets, and inventory's Fulfilled by Marketly functions (K7, built in parallel in inventory) over an
 * in-memory model of the seller units at the service location.
 */
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import type * as access from '../../../spec/access.js';
import type { FulfillmentServicePublicApi } from '../../../spec/fulfillment-service.js';
import type { InventoryPublicApi, StockQuantities } from '../../../spec/inventory.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';

export type Decision = 'allowed' | 'approval_required' | 'denied';

export interface FinanceEntry {
  id: string;
  type: 'service_fee' | 'charge_credit' | 'seller_credit';
  sellerId: string;
  amount: { amount: number; currency: string };
  idempotencyKey: string;
  kind?: string;
  reference?: { kind: string; id: string; ref?: string | null };
  description?: string;
  originalEntryId?: string;
  reason?: string;
}

/** A seller credit made through the finance.creditSeller stub */
export interface FinanceCredit {
  id: string;
  sellerId: string;
  amount: { amount: number; currency: string };
  reason: string;
  reference: { kind: string; id: string; ref?: string | null };
  idempotencyKey: string;
  status: 'posted' | 'pending_approval' | 'rejected' | 'withdrawn';
  entryId: string | null;
}

/** finance.creditSeller posts at once up to this (creditSecondReviewerThreshold default, $500) */
export const CREDIT_THRESHOLD = 50_000;

/**
 * finance.recordServiceFee / creditSellerCharge / creditSeller / getSellerCredit / withdrawSellerCredit as
 * src/spec/finance.ts describes them, over an in-memory ledger. creditSeller above CREDIT_THRESHOLD waits as
 * pending_approval; decideCredit plays Finance's decision.
 */
export function financeStubs(ledger: FinanceEntry[], credits: FinanceCredit[] = [], calls: { creditSeller: number } = { creditSeller: 0 }) {
  const entry = (e: FinanceEntry) => ({ id: e.id, at: new Date().toISOString(), type: e.type, typeLabel: e.type, reference: e.reference ?? { kind: 'seller', id: e.sellerId }, description: e.description ?? e.reason ?? '', amount: e.type === 'service_fee' ? { ...e.amount, amount: -e.amount.amount } : e.amount }) as any;
  const view = (credit: FinanceCredit) => {
    const posted = credit.entryId ? ledger.find((e) => e.id === credit.entryId) : undefined;
    return {
      id: credit.id,
      sellerId: credit.sellerId,
      amount: credit.amount,
      reason: credit.reason,
      reference: credit.reference,
      status: credit.status,
      ledgerEntry: posted ? entry(posted) : null,
      approvalRequestId: credit.amount.amount <= CREDIT_THRESHOLD ? null : credit.id,
      requestedBy: { kind: 'system', id: null, name: 'fulfillment-service' },
      createdAt: new Date().toISOString(),
      decidedAt: credit.status === 'pending_approval' ? null : new Date().toISOString(),
    } as any;
  };
  return {
    recordServiceFee: async (input: { sellerId: string; amount: { amount: number; currency: string }; kind: string; reference: { kind: string; id: string; ref?: string | null }; description: string; idempotencyKey: string }) => {
      const first = ledger.find((e) => e.idempotencyKey === input.idempotencyKey);
      if (first) return entry(first);
      const e: FinanceEntry = { id: newId(), type: 'service_fee', ...input };
      ledger.push(e);
      return entry(e);
    },
    creditSellerCharge: async (input: { sellerId: string; amount: { amount: number; currency: string }; originalEntryId: string; reason: string; idempotencyKey: string }) => {
      const first = ledger.find((e) => e.idempotencyKey === input.idempotencyKey);
      if (first) return entry(first);
      const original = ledger.find((e) => e.id === input.originalEntryId && e.type === 'service_fee' && e.sellerId === input.sellerId);
      if (!original) throw new AppError('NOT_FOUND', 'Ledger entry not found');
      const credited = ledger.filter((e) => e.originalEntryId === original.id).reduce((n, e) => n + e.amount.amount, 0);
      if (credited + input.amount.amount > original.amount.amount) throw new AppError('VALIDATION_FAILED', 'More than the charge minus earlier credits', { issues: [{ path: 'amount', message: 'More than the charge minus earlier credits' }] });
      const e: FinanceEntry = { id: newId(), type: 'charge_credit', ...input };
      ledger.push(e);
      return entry(e);
    },
    creditSeller: async (input: { sellerId: string; amount: { amount: number; currency: string }; reason: string; reference: { kind: string; id: string; ref?: string | null }; idempotencyKey: string }) => {
      calls.creditSeller += 1;
      let credit = credits.find((c) => c.idempotencyKey === input.idempotencyKey);
      if (!credit) {
        credit = { id: newId(), ...input, status: 'pending_approval', entryId: null };
        credits.push(credit);
        if (input.amount.amount <= CREDIT_THRESHOLD) decideCredit(ledger, credit, 'posted');
      }
      return view(credit);
    },
    getSellerCredit: async (by: { creditId?: string; idempotencyKey?: string }) => {
      const credit = credits.find((c) => (by.creditId && c.id === by.creditId) || (by.idempotencyKey && c.idempotencyKey === by.idempotencyKey));
      return credit ? view(credit) : null;
    },
    withdrawSellerCredit: async (input: { creditId?: string; idempotencyKey?: string; reason: string }) => {
      const credit = credits.find((c) => (input.creditId && c.id === input.creditId) || (input.idempotencyKey && c.idempotencyKey === input.idempotencyKey));
      if (!credit) throw new AppError('NOT_FOUND', 'Credit not found');
      if (credit.status !== 'pending_approval') throw new AppError('ILLEGAL_TRANSITION', 'Only a credit waiting for approval can be withdrawn');
      credit.status = 'withdrawn';
      return view(credit);
    },
  };
}

/** Finance's decision on a seller credit that waits for approval (what finance does on access.approval.decided) */
export function decideCredit(ledger: FinanceEntry[], credit: FinanceCredit, outcome: 'posted' | 'rejected') {
  if (credit.status !== 'pending_approval') return;
  if (outcome === 'rejected') {
    credit.status = 'rejected';
    return;
  }
  const e: FinanceEntry = { id: newId(), type: 'seller_credit', sellerId: credit.sellerId, amount: credit.amount, idempotencyKey: credit.idempotencyKey, reference: credit.reference, reason: credit.reason };
  ledger.push(e);
  credit.status = 'posted';
  credit.entryId = e.id;
}

type Group = 'available' | 'reserved' | 'incoming' | 'damaged_held' | 'returned';
const FIELD: Record<Group, keyof StockQuantities> = { available: 'available', reserved: 'reserved', incoming: 'incoming', damaged_held: 'damagedHeld', returned: 'returned' };

/**
 * inventory's Fulfilled by Marketly functions (src/spec/inventory.ts K7) over an in-memory model of seller items at
 * the service location: setServiceLocation, moveServiceStock (idempotent per key, refuses negative groups and items
 * not designated to the location), expectServiceInbound / cancelServiceInbound (Incoming), submitServiceReceipt
 * (counted units stay Incoming) and getLevels. confirm() plays the Inventory Manager confirming a service receipt:
 * Incoming → Available / Damaged or held, and inventory.receipt.confirmed with the contract payload.
 */
export function serviceInventory(publish: (name: string, payload: unknown) => Promise<void>) {
  const levels = new Map<string, StockQuantities>();
  const designated = new Map<string, string | null>();
  const setCalls: { stockItemId: string; locationId: string | null }[] = [];
  const moves = new Map<string, any>();
  const open = new Map<string, Map<string, number>>(); // inboundId → stockItemId → open Incoming
  const receipts = new Map<string, { id: string; input: any; awaiting: Map<string, number>; confirmed: boolean }>();
  const level = (id: string) => {
    let q = levels.get(id);
    if (!q) levels.set(id, (q = { available: 0, reserved: 0, incoming: 0, damagedHeld: 0, returned: 0 }));
    return q;
  };
  const stubs: Partial<InventoryPublicApi> = {
    setServiceLocation: async (stockItemId, locationId) => {
      setCalls.push({ stockItemId, locationId });
      designated.set(stockItemId, locationId);
      return { id: stockItemId, serviceLocationId: locationId } as any;
    },
    moveServiceStock: async (input) => {
      const first = moves.get(input.key);
      if (first) return first.result;
      if (designated.get(input.stockItemId) !== input.locationId) throw new AppError('VALIDATION_FAILED', 'The item does not sell from this location', { issues: [{ path: 'locationId', message: 'Not the service location' }] });
      const q = { ...level(input.stockItemId) };
      if (input.from) q[FIELD[input.from]] -= input.quantity;
      if (input.to) q[FIELD[input.to]] += input.quantity;
      if (Object.values(q).some((v) => v < 0)) throw new AppError('INSUFFICIENT_STOCK', 'Not enough units', { lines: [{ stockItemId: input.stockItemId, requested: input.quantity }] }, 409);
      levels.set(input.stockItemId, q);
      const result = { movementId: newId(), levels: q };
      moves.set(input.key, { input, result });
      return result;
    },
    expectServiceInbound: async (input) => {
      const before = open.get(input.inboundId) ?? new Map();
      for (const [id, n] of before) level(id).incoming -= n;
      const next = new Map<string, number>();
      for (const l of input.lines) {
        next.set(l.stockItemId, (next.get(l.stockItemId) ?? 0) + l.quantity);
        level(l.stockItemId).incoming += l.quantity;
      }
      open.set(input.inboundId, next);
    },
    cancelServiceInbound: async (inboundId) => {
      for (const [id, n] of open.get(inboundId) ?? []) level(id).incoming -= n;
      open.set(inboundId, new Map());
    },
    submitServiceReceipt: async (input) => {
      const known = receipts.get(input.receiptId);
      if (known) return { id: known.id, receiptId: input.receiptId } as any;
      const id = newId();
      const awaiting = new Map<string, number>();
      const o = open.get(input.inboundId) ?? new Map<string, number>();
      for (const l of input.lines) {
        // counted units stay Incoming until confirmed; units beyond the open Incoming are added at confirmation
        const fromOpen = Math.min(l.received, o.get(l.stockItemId) ?? 0);
        o.set(l.stockItemId, (o.get(l.stockItemId) ?? 0) - fromOpen);
        awaiting.set(l.stockItemId, fromOpen);
      }
      open.set(input.inboundId, o);
      receipts.set(input.receiptId, { id, input, awaiting, confirmed: false });
      return { id, receiptId: input.receiptId, receiptRef: input.receiptRef, state: 'awaiting_confirmation' } as any;
    },
    getLevels: async (ids) => Object.fromEntries(ids.map((id) => [id, { ...level(id) }])),
  };
  return {
    stubs,
    levels,
    level,
    setCalls,
    moves: () => [...moves.values()].map((m) => m.input),
    receipts,
    /** The Inventory Manager confirms a service receipt (default: every line as counted) */
    async confirm(receiptId: string, decide: Record<string, { sellable: number; damaged: number }> = {}, by = { kind: 'staff', id: newId(), name: 'Inventory Manager' }) {
      const r = receipts.get(receiptId);
      if (!r || r.confirmed) throw new Error(`no receipt ${receiptId} waiting`);
      r.confirmed = true;
      const lines = r.input.lines.map((l: any) => {
        const d = decide[l.stockItemId] ?? { sellable: l.received - l.damaged, damaged: l.damaged };
        const q = level(l.stockItemId);
        q.incoming -= r.awaiting.get(l.stockItemId) ?? 0;
        q.available += d.sellable;
        q.damagedHeld += d.damaged;
        return { stockItemId: l.stockItemId, sku: 'SKU', label: 'Item', expected: l.expected, received: l.received, damaged: d.damaged, shortage: Math.max(0, l.expected - l.received), binCode: null, unitCost: null, sellable: d.sellable, outOfStockNow: false };
      });
      await publish('inventory.receipt.confirmed', {
        inboundId: r.id,
        receiptId,
        source: { kind: 'service_inbound', id: r.input.inboundId, ref: r.input.inboundRef },
        ownerType: 'seller',
        sellerId: r.input.sellerId,
        purchaseOrderId: null,
        locationId: r.input.locationId,
        lines,
        confirmedBy: by,
      });
    },
    /** Confirms every receipt of an inbound shipment still waiting */
    async confirmAll(inboundId: string) {
      for (const [id, r] of receipts) if (!r.confirmed && r.input.inboundId === inboundId) await this.confirm(id);
    },
  };
}

export interface SellerKit {
  sellerId: string;
  token: string;
  /** An offer of this seller with its inventory stock item */
  offer(o?: { sku?: string; available?: number }): Promise<{ offerId: string; stockItemId: string; sku: string }>;
}

export interface Notice {
  topic: string;
  recipients: any[];
  context: any;
  link: any;
  dedupeKey: string;
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
  /** inventory's Fulfilled by Marketly functions, modelled in memory */
  inv: ReturnType<typeof serviceInventory>;
  /** The company warehouse (inventory's default location) */
  locationId: string;
  seller(): Promise<SellerKit>;
  /** Decision access answers per action key (default allowed) */
  authority: Map<string, Decision>;
  approvals: access.RequestApprovalInput[];
  /** orders.getFulfillmentTask answers per seller group (others: NOT_FOUND) */
  tasks: Map<string, { orderRef: string; dueAt: string; lines: { orderItemId: string; offerId: string; stockItemId: string; quantity: number }[] }>;
  financeLedger: FinanceEntry[];
  financeCredits: FinanceCredit[];
  financeCalls: { creditSeller: number };
  /** notifications.notify calls */
  notices: Notice[];
  /** workqueues.raise inputs and resolveBySource keys */
  work: any[];
  resolved: string[];
  /** audit.record entries */
  audits: any[];
  /** reports.registerDataset calls (recorded at boot) */
  datasets: any[];
  /** Enrolled, approved seller with one approved SKU */
  enrolledSeller(o?: { capacity?: { maxCubicFeet: number; maxSkus: number } }): Promise<SellerKit & { skuId: string; offerId: string; stockItemId: string; sku: string }>;
}

export const S = (path: string) => `/api/seller/fulfillment-service${path}`;
export const A = (path: string) => `/api/admin/fulfillment-service${path}`;
export const ADDRESS = { name: 'Casa Verde Home', line1: '410 Market St', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US' };
export const WAREHOUSE = { name: 'Marketly Reno', line1: '1 Logistics Way', city: 'Reno', region: 'NV', postalCode: '89502', country: 'US' };
export const DIMS = { length: 30, width: 20, height: 10 };
export const PROFILE = { profileId: '01890000-0000-7000-8000-0000000000a1', handlingDays: 1, sameDayCutoff: '14:00' };
const EVENTS = [
  'fulfillment-service.enrollment.submitted',
  'fulfillment-service.enrollment.decided',
  'fulfillment-service.inbound.submitted',
  'fulfillment-service.inbound.received',
  'fulfillment-service.offer.service_changed',
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
  const tasks: Kit['tasks'] = new Map();
  const financeLedger: FinanceEntry[] = [];
  const financeCredits: FinanceCredit[] = [];
  const financeCalls = { creditSeller: 0 };
  const notices: Notice[] = [];
  const work: any[] = [];
  const resolved: string[] = [];
  const audits: any[] = [];
  const datasets: any[] = [];
  let publishFn: (name: string, payload: unknown) => Promise<void> = async () => undefined;
  const inv = serviceInventory((name, payload) => publishFn(name, payload));
  const accessStubs = {
    check: async (_p: unknown, action: string) => ({ decision: authority.get(action) ?? 'allowed', action, reason: authority.get(action) === 'approval_required' ? 'Above your limit' : '', requiresSecondReviewer: false, approvalsNeeded: 0, eligibleApproverRoles: [], eligibleApprovers: [] }) as any,
    requestApproval: async (input: access.RequestApprovalInput) => {
      approvals.push(input);
      return { id: newId(), ref: 'AP-1', ...input } as any;
    },
    getApproval: async () => ({ reason: 'Approved by Finance' }) as any,
  };
  const app = await buildTestApp({
    modules: withDependencies(['fulfillment-service', 'media', 'returns', 'shipping', 'notifications', 'workqueues', 'audit', 'reports', 'orders', 'sellers']),
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      inventory: inv.stubs,
      access: accessStubs,
      finance: financeStubs(financeLedger, financeCredits, financeCalls),
      shipping: { getOfficialDefaultProfile: async () => PROFILE },
      notifications: {
        notify: async (input: any) => {
          notices.push(input);
          return { noticeIds: [newId()], deliveryIds: [] };
        },
      },
      workqueues: {
        raise: async (input: any) => {
          work.push(input);
          return { id: newId(), ...input } as any;
        },
        resolveBySource: async (key: string) => {
          resolved.push(key);
          return 1;
        },
      },
      audit: {
        record: async (entry: any) => {
          audits.push(entry);
          return newId();
        },
      },
      reports: {
        registerDataset: async (d: any) => {
          datasets.push(d);
        },
      },
      orders: {
        getFulfillmentTask: async (groupId: string) => {
          const t = tasks.get(groupId);
          if (!t) throw new AppError('NOT_FOUND', 'Seller group not found');
          return { groupId, orderId: newId(), orderRef: t.orderRef, dispatchDeadline: { dueAt: t.dueAt, state: 'on_time' }, openLines: t.lines.map((l) => ({ ...l, title: 'Linen throw', variantLabel: 'Natural', sellerSku: null, quantityToShip: l.quantity })) } as any;
        },
      },
    },
  });
  publishFn = async (name, payload) => {
    app.kernel.events.publish(name.split('.')[0]!, name, payload, { actor: { kind: 'system' } });
    await app.kernel.events.drain();
  };
  const seen = new Map<string, any[]>();
  for (const name of EVENTS) app.kernel.events.subscribe('test', name, (e) => void seen.set(name, [...(seen.get(name) ?? []), e.payload]));
  const staff = callers.staff();
  const call: Kit['call'] = async (method, url, o = {}) => {
    const res = await app.inject({ method: method as never, url, headers: { ...auth(o.token ?? staff), ...(o.headers ?? {}) }, ...(o.body !== undefined ? { payload: o.body as never } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  // the company warehouse that holds seller stock (inventory's default location)
  const location = await call('POST', '/api/admin/inventory/locations', { body: { code: 'RNO1', name: 'Reno, NV warehouse', address: WAREHOUSE, timeZone: 'America/Los_Angeles' } });
  expect(location.status, JSON.stringify(location.body)).toBe(201);
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
    publish: async (source, name, payload) => {
      app.kernel.events.publish(source, name, payload, { actor: { kind: 'system' } });
      await app.kernel.events.drain();
    },
    api,
    inventory,
    inv,
    locationId: location.body.id,
    seller,
    authority,
    approvals,
    tasks,
    financeLedger,
    financeCredits,
    financeCalls,
    notices,
    work,
    resolved,
    audits,
    datasets,
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

/** Receives everything (complete, nothing damaged) and, unless told not to, the Inventory Manager confirms it */
export async function receiveAll(k: Kit, inboundId: string, skuId: string, quantity: number, o: { confirm?: boolean } = {}) {
  const r = await k.call('POST', A(`/inbound/${inboundId}/receive`), { body: { lines: [{ skuEnrollmentId: skuId, received: quantity, damaged: 0 }], complete: true }, headers: { 'idempotency-key': newId() } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  if (o.confirm !== false) await k.inv.confirmAll(inboundId);
  return r.body;
}

/** An enrolled seller with `units` confirmed at our warehouse */
export async function stocked(k: Kit, units: number) {
  const s = await k.enrolledSeller();
  const id = await arrivedInbound(k, s, units);
  await receiveAll(k, id, s.skuId, units);
  return { ...s, inboundId: id };
}
