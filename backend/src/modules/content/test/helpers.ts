/**
 * Test harness for content: an app with content, real media (uploads through media's HTTP API) and real
 * catalog (categories), with the modules not built yet (search, promotions) and the ones whose answers a
 * test controls stubbed:
 *   search.getProductCards → cards from `h.cards` (missing ids are unavailable); search.searchProducts → `h.ruleCards`;
 *   promotions.getPublicCampaign / isCampaignActive / liveDeals → from `h.campaigns`;
 *   sellers.getStorefrontCard / getSellers → from `h.sellers`;
 *   access.check → `h.decision` (approval_required by default), requestApproval → a new request id (recorded),
 *   approvalInfo → compact info, cancelApproval → recorded, getStaffRef → 'Dana Content' (Content Manager);
 *   audit.record → recorded; notifications.notify → recorded.
 */
import type { FastifyInstance } from 'fastify';
import { newId } from '../../../kernel/lib/ids.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type * as search from '../../../spec/search.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';
import type { ContentService } from '../service.js';

export { auth, callers, newId };

export interface Harness {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  service: ContentService;
  cards: Map<string, search.ProductCard>;
  ruleCards: search.ProductCard[];
  searchQueries: unknown[];
  campaigns: Map<string, { name: string; startsAt: string; endsAt: string; active: boolean; status: string }>;
  sellers: Map<string, { name: string; status: string }>;
  decision: access.AuthorityCheck['decision'];
  approvals: access.RequestApprovalInput[];
  cancelled: string[];
  audits: audit.RecordInput[];
  notices: unknown[];
  events: { name: string; payload: any }[];
  eventsNamed(name: string): any[];
  /** Staff token for an account id (all permissions unless given) */
  staff(id?: string, permissions?: string[]): Record<string, string>;
  staffId: string;
  call(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown, headers?: Record<string, string>): Promise<Awaited<ReturnType<FastifyInstance['inject']>>>;
  admin(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, payload?: unknown, headers?: Record<string, string>): ReturnType<Harness['call']>;
  store(method: 'GET' | 'POST', path: string, payload?: unknown, headers?: Record<string, string>): ReturnType<Harness['call']>;
  decide(requestId: string, actionKey: string, target: { id: string }, outcome: 'approved' | 'rejected' | 'cancelled' | 'expired'): Promise<void>;
  card(over?: Partial<search.ProductCard>): search.ProductCard;
}

const PUBLISHED = ['content.page.published', 'content.page.unpublished', 'content.page.removed', 'content.article.published', 'content.policy.submitted', 'content.policy.scheduled', 'content.policy.effective'];

export async function harness(): Promise<Harness> {
  const clock = movingClock();
  // tests move the clock by hours and days: tokens are signed at the app's time
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 3600;
  const h = {
    clock,
    cards: new Map<string, search.ProductCard>(),
    ruleCards: [] as search.ProductCard[],
    searchQueries: [] as unknown[],
    campaigns: new Map<string, { name: string; startsAt: string; endsAt: string; active: boolean; status: string }>(),
    sellers: new Map<string, { name: string; status: string }>(),
    decision: 'approval_required' as access.AuthorityCheck['decision'],
    approvals: [] as access.RequestApprovalInput[],
    cancelled: [] as string[],
    audits: [] as audit.RecordInput[],
    notices: [] as unknown[],
    events: [] as { name: string; payload: any }[],
  };
  const app = await buildTestApp({
    only: ['content', 'catalog', 'search', 'promotions', 'sellers', 'audit', 'notifications'],
    clock,
    config: { rateLimits: false },
    apiStubs: {
      search: {
        getProductCards: async (ids: string[]) => ids.map((id) => h.cards.get(id)).filter((c): c is search.ProductCard => Boolean(c)),
        searchProducts: async (q: unknown) => {
          h.searchQueries.push(q);
          return { items: h.ruleCards, total: h.ruleCards.length, nextCursor: null };
        },
      },
      promotions: {
        getPublicCampaign: async (id: string) => {
          const c = h.campaigns.get(id);
          return c ? ({ id, name: c.name, status: c.status, period: { startsAt: c.startsAt, endsAt: c.endsAt, timeZone: 'America/Los_Angeles', display: '' } } as never) : null;
        },
        isCampaignActive: async (id: string) => ({ active: h.campaigns.get(id)?.active ?? false }),
        liveDeals: async () => [{ campaignId: newId(), name: 'Flash Friday', state: 'live', secondsLeft: 3600 }] as never,
      },
      sellers: {
        getStorefrontCard: async (ids: string[]) => ids.filter((id) => h.sellers.has(id)).map((id) => ({ id, slug: `store-${id.slice(0, 4)}`, storeName: h.sellers.get(id)!.name, logo: null, verified: true, location: 'Portland, OR', positivePct: 98, ratingCount: 120, dispatchLabel: 'Ships in 1 business day' })),
        getSellers: async (ids: string[]) => ids.filter((id) => h.sellers.has(id)).map((id) => ({ id, ref: 'SL-1', slug: 's', storeName: h.sellers.get(id)!.name, status: h.sellers.get(id)!.status, verified: true, canSellNew: true, activeRestrictionIds: [], launchReady: true }) as never),
      },
      access: {
        check: async (_p, action) => ({ decision: h.decision, action, reason: h.decision === 'allowed' ? 'Business Owner authority' : 'Needs the Business Owner', requiresSecondReviewer: true, approvalsNeeded: h.decision === 'allowed' ? 0 : 1, eligibleApproverRoles: [], eligibleApprovers: [] }),
        requestApproval: async (input) => {
          h.approvals.push(input);
          return { id: newId(), ref: 'AP-261009-0001', status: 'pending' } as never;
        },
        approvalInfo: async (id) => ({ required: true, reason: 'Waiting for the Business Owner', approvalRequestId: id, approvers: ['Business Owner'] }),
        cancelApproval: async (id) => {
          h.cancelled.push(id);
        },
        getStaffRef: async (id) => ({ accountId: id, name: 'Dana Content', away: false, roleLabel: 'Content Manager' }),
      },
      audit: {
        record: async (entry) => {
          h.audits.push(entry);
          return newId();
        },
      },
      notifications: {
        notify: async (input) => {
          h.notices.push(input);
          return { noticeIds: [], deliveryIds: [] };
        },
      },
    },
  });
  for (const name of PUBLISHED) app.kernel.events.subscribe('test', name, (e) => void h.events.push({ name, payload: e.payload }));
  const staffId = newId();
  const staff = (id = staffId, permissions?: string[]) => auth(callers.staff(permissions, { sub: id } as never));
  const call: Harness['call'] = async (method, url, payload, headers) => {
    const res = await app.inject({ method, url, headers: headers ?? staff(), ...(payload !== undefined ? { payload: payload as never } : {}) });
    await app.kernel.events.drain();
    return res;
  };
  let seq = 0;
  return Object.assign(h, {
    app,
    service: app.kernel.boot.apis.get('content') as ContentService,
    eventsNamed: (name) => h.events.filter((e) => e.name === name).map((e) => e.payload),
    staff,
    staffId,
    call,
    admin: (method, path, payload, headers) => call(method, `/api/admin/content${path}`, payload, headers ?? staff()),
    store: (method, path, payload, headers) => call(method, `/api/store/content${path}`, payload, headers ?? auth(callers.visitor())),
    decide: async (requestId, actionKey, target, outcome) => {
      app.kernel.events.publish('access', 'access.approval.decided', {
        requestId,
        ref: 'AP-261009-0001',
        actionKey,
        module: 'content',
        target: { type: 'policy_version', id: target.id },
        outcome,
        decidedBy: { kind: 'staff', id: newId(), name: 'Bea Owner' },
        reason: outcome === 'approved' ? null : 'Not now',
        approverIds: [],
        requestedById: newId(),
      });
      await app.kernel.events.drain();
    },
    card: (over = {}) => {
      seq++;
      return {
        productId: newId(),
        slug: `product-${seq}`,
        title: `Lamp ${seq}`,
        image: null,
        rating: 4.5,
        ratingCount: 10,
        price: { amount: 2999, currency: 'USD' },
        priceIsFrom: false,
        offerId: newId(),
        sellerName: 'Official Store',
        sellerId: null,
        official: true,
        condition: 'new',
        wasPrice: null,
        discountPct: null,
        freeDelivery: true,
        availability: 'in_stock',
        offerCount: 1,
        badges: [],
        ...over,
      } as search.ProductCard;
    },
  } satisfies Omit<Harness, keyof typeof h>) as Harness;
}

/* ------------------------------------------------------------------ media */

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const chunk = (type: string, data: Buffer) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
const png = (w: number, hgt: number, seed: string) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.concat([u32(w), u32(hgt), Buffer.from([8, 2, 0, 0, 0])])), chunk('IDAT', Buffer.from(seed, 'latin1')), chunk('IEND', Buffer.alloc(0))]);

/** A ready content image uploaded by staff through media's HTTP API (platform-owned); returns a MediaRef */
export async function uploadImage(h: Harness): Promise<{ id: string; url: string }> {
  const body = png(1600, 900, newId());
  const req = { purpose: 'content_image', fileName: 'banner.png', contentType: 'image/png', sizeBytes: body.length };
  const res = await h.app.inject({ method: 'POST', url: '/api/admin/media/uploads', headers: h.staff(), payload: { upload: req } });
  if (res.statusCode !== 201) throw new Error(`upload failed: ${res.statusCode} ${res.body}`);
  const ticket = res.json() as { uploadId: string; assetId: string; url: string; headers: Record<string, string> };
  const media = h.app.kernel.boot.apis.get('media') as unknown as { providers: { storage: { acceptSignedPut(url: string, body: Uint8Array, type?: string): Promise<unknown> } } };
  await media.providers.storage.acceptSignedPut(ticket.url, body, ticket.headers['content-type']);
  const done = await h.app.inject({ method: 'POST', url: `/api/admin/media/uploads/${ticket.uploadId}/complete`, headers: h.staff() });
  if (done.statusCode !== 202) throw new Error(`complete failed: ${done.statusCode} ${done.body}`);
  await h.app.kernel.jobs.runNow('media.process');
  await h.app.kernel.events.drain();
  return { id: ticket.assetId, url: 'https://cdn.example.com/placeholder.png' };
}

export const MIN = 60_000;
export const DAY = 86_400_000;
export const inMs = (h: Harness, ms: number) => new Date(h.clock.now().getTime() + ms).toISOString();
