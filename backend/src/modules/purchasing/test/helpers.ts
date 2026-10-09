/**
 * Shared set-up for the purchasing behaviour tests.
 *
 * Stubbed APIs:
 *   inventory: a small in-memory company/seller stock list behind getStockItems (StockItemRef) and getAvailability
 *     ({ available, lowStockThreshold }); expectIncoming / cancelIncoming / submitInbound are recorded.
 *   access: check → allowed up to $25,000, approval_required above, denied for a token named "Intern";
 *     requestApproval → a new request; approvalInfo → "Over $25,000: needs Morgan Hale".
 *   audit.record, media (getAsset / attach / detach / refs) and notifications.notify → recorded calls.
 */
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import { fixedClock } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import { devClaims } from '../../../kernel/auth/dev.js';
import { devSigner, signAccessToken } from '../../../kernel/auth/tokens.js';
import type { StockItemRef } from '../../../spec/inventory.js';
import { auth, buildTestApp, ISSUER, TEST_JWK } from '../../../testing/app.js';

export const NOW = '2026-10-09T17:00:00.000Z'; // 10:00 in Los Angeles
export const LOCATION = newId();
const SELLER = newId();
const PRODUCT = newId();
const VARIANT = newId();

export interface StockFixture {
  sku: string;
  label: string;
  ownerType: 'official' | 'seller';
  available: number;
  threshold: number | null;
}

export function makeStubs() {
  const stock = new Map<string, StockFixture>();
  const addStock = (s: Partial<StockFixture> & { sku: string }) => {
    const id = newId();
    stock.set(id, { label: `${s.sku} item`, ownerType: 'official', available: 50, threshold: 10, ...s });
    return id;
  };
  const inventory = {
    getStockItems: vi.fn(async (ids: string[]): Promise<StockItemRef[]> =>
      ids
        .filter((id) => stock.has(id))
        .map((id) => {
          const s = stock.get(id)!;
          return { id, sku: s.sku, label: s.label, ownerType: s.ownerType, sellerId: s.ownerType === 'seller' ? SELLER : null, offerId: null, productId: PRODUCT, variantId: VARIANT, condition: 'new', locationId: LOCATION, locationCode: 'WH1', binCode: null };
        }),
    ),
    getAvailability: vi.fn(async (ids: string[]) =>
      Object.fromEntries(ids.filter((id) => stock.has(id)).map((id) => [id, { available: stock.get(id)!.available, state: 'in_stock', lowStockThreshold: stock.get(id)!.threshold, nextIncoming: null }])),
    ),
    expectIncoming: vi.fn(async (..._args: unknown[]) => {}),
    cancelIncoming: vi.fn(async (..._args: unknown[]) => {}),
    submitInbound: vi.fn(async (r: { receiptId: string }) => ({ id: newId(), receiptId: r.receiptId }) as never),
    getStockSummary: vi.fn(async () => ({ ownerType: 'official' as const, skuCount: stock.size, groups: [], lowStockCount: 2, outOfStockCount: 1 })),
  };
  const access = {
    check: vi.fn(async (_p: unknown, action: string, amount?: { money?: { amount: number } | null }) => {
      const over = (amount?.money?.amount ?? 0) > 2_500_000;
      return {
        decision: (over ? 'approval_required' : 'allowed') as 'allowed' | 'approval_required' | 'denied',
        action,
        reason: over ? 'Above your $25,000.00 limit: Business Owner approval' : 'Within your $25,000.00 purchase limit',
        requiresSecondReviewer: over,
        approvalsNeeded: over ? 1 : 0,
        eligibleApproverRoles: [],
        eligibleApprovers: [],
      };
    }),
    requestApproval: vi.fn(async (_input: unknown) => ({ id: newId() }) as never),
    approvalInfo: vi.fn(async (id: string) => ({ required: true, reason: 'Over $25,000: needs Morgan Hale', approvalRequestId: id, approvers: ['Morgan Hale'] })),
    cancelApproval: vi.fn(async () => {}),
    getApproval: vi.fn(async () => ({ details: { emailSupplier: true, message: 'Please confirm' } }) as never),
    getStaffRef: vi.fn(async (id: string) => ({ accountId: id, name: 'Ken Watanabe', away: false })),
    rolesOf: vi.fn(async () => []),
  };
  const audit = { record: vi.fn(async (_e: unknown) => newId()) };
  const media = {
    getAsset: vi.fn(async (id: string) => ({ id, status: 'ready', purpose: 'inspection_photo', owner: { kind: 'staff', id: 'someone' } }) as never),
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    refs: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, url: `https://files.example/${id}.jpg`, alt: null }))),
  };
  const notifications = { notify: vi.fn(async () => ({ noticeIds: [], deliveryIds: [] })) };
  return { stock, addStock, inventory, access, audit, media, notifications };
}

export type Stubs = ReturnType<typeof makeStubs>;

export async function purchasingApp(stubs: Stubs) {
  const clock = fixedClock(NOW);
  const app = await buildTestApp({
    only: ['purchasing', 'access', 'audit', 'media', 'notifications'],
    clock,
    apiStubs: { inventory: stubs.inventory, access: stubs.access, audit: stubs.audit, media: stubs.media, notifications: stubs.notifications } as never,
  });
  return { app, clock };
}

export const ken = { id: newId(), name: 'Ken Watanabe' };
const signer = devSigner({ jwk: TEST_JWK });
/** Staff token signed at the test clock's time (the app verifies tokens against that clock), valid for 60 days */
export const staffAuth = (who = ken, permissions = ['*']) =>
  auth(
    signAccessToken(signer, { ...devClaims('staff', { permissions }), sub: who.id, dev: { permissions, name: who.name } } as never, {
      issuer: ISSUER,
      ttlSeconds: 60 * 86_400,
      now: new Date(new Date(NOW).getTime() - 60_000),
    }),
  );

export function api(app: FastifyInstance, headers = staffAuth()) {
  return (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown, h = headers) =>
    app.inject({ method, url: `/api/admin/purchasing${url}`, headers: h, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

/** Events published while the test runs, by name */
export function recordEvents(app: FastifyInstance, names: string[]) {
  const seen: Record<string, any[]> = Object.fromEntries(names.map((n) => [n, []]));
  for (const n of names) app.kernel.events.subscribe('test', n, (e) => void seen[n]!.push(e.payload));
  return seen;
}

export const usd = (amount: number) => ({ amount, currency: 'USD' });

export const auditActions = (stubs: Stubs) => stubs.audit.record.mock.calls.map((c) => (c[0] as { action: string }).action);
