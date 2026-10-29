/**
 * Test kit for sellers: boots sellers with identity, access and media (partly stubbed so tests control
 * answers), audit, trust and workqueues stubbed; captures events, audit entries, work items and calls.
 */
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { fixedClock } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import { devClaims } from '../../../kernel/auth/dev.js';
import type { StoreTable } from '../../../kernel/store/index.js';
import { auth, buildTestApp, token } from '../../../testing/app.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type { SellersDb } from '../../../spec/sellers.js';
import type { SellersService } from '../service.js';

/**
 * One of the module's tables as its repository reads it (rows in spec shape), **through the store the app
 * chose** — MongoDB or MySQL, whichever `MYSQL_MODULES` put this module's data in. A helper that built a
 * MongoDB store of its own would read a database the module no longer writes to: the rows are simply not
 * there, and nothing in the log says why (docs/10 §10.5c).
 */
export function sellersTable<T extends keyof SellersDb & string>(app: FastifyInstance, name: T): StoreTable<SellersDb[T]> {
  return app.kernel.boot.stores.get('sellers')!.table<SellersDb[T]>(name);
}

export const STORE = '/api/store/sellers';
export const SELLER = '/api/seller/sellers';
export const ADMIN = '/api/admin/sellers';

/** Set on to make the audit API fail (an audit store outage) */
export const auditOutage = { on: false };
/** Files media no longer knows (deleted): refs leaves them out */
export const mediaGone = new Set<string>();

export type Decision = 'allowed' | 'approval_required' | 'denied';

export interface Kit {
  app: FastifyInstance;
  svc: SellersService;
  clock: ReturnType<typeof fixedClock>;
  events: EventEnvelope[];
  audits: audit.RecordInput[];
  work: { queueKey: string; kind: string; dedupeKey: string }[];
  calls: { fn: string; args: unknown[] }[];
  /** access.check answer per action key (default allowed) */
  authority: Map<string, Decision>;
  approvals: Map<string, access.RequestApprovalInput>;
  of(name: string): any[];
  last(name: string): any;
  callsOf(fn: string): unknown[][];
  call(method: string, url: string, token: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  /** Publish another module's event and wait for the consumers */
  emit(source: string, name: string, payload: unknown, actor?: { kind: string; id?: string | null }): Promise<void>;
  /** Decide an approval request the way access would announce it */
  decide(requestId: string, outcome: 'approved' | 'rejected', by?: string): Promise<void>;
  close(): Promise<void>;
}

/** `apiStubs`: more modules to answer (optional dependencies that are not booted, e.g. reviews, support, finance) */
export async function boot(o: { apiStubs?: NonNullable<Parameters<typeof buildTestApp>[0]>['apiStubs'] } = {}): Promise<Kit> {
  const clock = fixedClock(new Date());
  const audits: audit.RecordInput[] = [];
  const work: Kit['work'] = [];
  const calls: Kit['calls'] = [];
  const authority = new Map<string, Decision>();
  const approvals = new Map<string, access.RequestApprovalInput>();
  const rec = (fn: string, ...args: unknown[]) => void calls.push({ fn, args });
  const app = await buildTestApp({
    modules: withDependencies(['sellers', 'audit', 'trust', 'workqueues']),
    clock,
    config: { rateLimits: false, launchPhase: 4 },
    apiStubs: {
      identity: {
        getAccount: async (id: string) => ({ id, realm: 'member', email: `${id.slice(0, 8)}@example.com`, displayName: 'Ana', status: 'active', emailVerified: true, twoStepEnabled: false }),
        inviteSellerMember: async (input: any) => {
          rec('inviteSellerMember', input);
          const now = clock.now();
          return { id: newId(), realm: 'member', purpose: 'seller_member', email: input.email, name: input.name, status: 'pending', contextRef: input.sellerId, invitedBy: input.invitedBy, sentAt: now.toISOString(), expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(), accountId: null } as any;
        },
        grantSellerContext: async (input: any) => rec('grantSellerContext', input),
        revokeSellerContext: async (...args: unknown[]) => rec('revokeSellerContext', ...args),
        // identity.revokeInvitation is new in pass 3 (built in parallel): stubbed
        revokeInvitation: async (invitationId: string, input: any) => {
          rec('revokeInvitation', invitationId, input);
          return { id: invitationId, status: 'revoked', contextRef: input.contextRef ?? null } as any;
        },
      },
      media: {
        getAsset: async (id: string) => ({ id, kind: 'document', purpose: 'verification_document', status: 'ready', fileName: `${id.slice(0, 6)}.pdf`, contentType: 'application/pdf', sizeBytes: 2048, owner: { kind: 'customer' }, visibility: 'private', renditions: [], inUse: false, usageCount: 0, createdAt: clock.now().toISOString() }) as any,
        attach: async (...args: unknown[]) => rec('media.attach', ...args),
        detach: async (...args: unknown[]) => rec('media.detach', ...args),
        refs: async (ids: string[]) => ids.filter((id) => !mediaGone.has(id)).map((id) => ({ id, url: `https://media.example.com/${id}` })),
      },
      access: {
        check: async (_p: any, action: string) => {
          const decision = authority.get(action) ?? (action === 'sellers.sellers.suspend' || action === 'sellers.sellers.close' ? 'approval_required' : 'allowed');
          return { decision, action, reason: decision === 'allowed' ? 'Within your authority' : decision === 'denied' ? 'Your role cannot do this' : 'Needs a second reviewer', requiresSecondReviewer: decision === 'approval_required', approvalsNeeded: decision === 'approval_required' ? 1 : 0, eligibleApproverRoles: [], eligibleApprovers: [] } as any;
        },
        requestApproval: async (input: access.RequestApprovalInput) => {
          const id = newId();
          approvals.set(id, input);
          rec('requestApproval', input);
          return { id, ref: 'AP-1', status: 'pending', target: input.target, details: input.details, reason: input.reason } as any;
        },
        approvalInfo: async (id: string) => ({ required: true, reason: 'Second reviewer', approvalRequestId: id, approvers: ['Seller Manager'] }),
        getApproval: async (id: string) => {
          const a = approvals.get(id);
          return a ? ({ id, details: a.details, reason: a.reason, target: a.target } as any) : null;
        },
        getStaffRef: async (id: string) => ({ accountId: id, name: 'Sam Staff', away: false }),
        hasPermission: async () => true,
      },
      audit: {
        record: async (entry: audit.RecordInput) => {
          if (auditOutage.on) throw new Error('audit store unavailable');
          audits.push(entry);
          return newId();
        },
      },
      trust: {
        requestAssessment: async (input: any) => {
          rec('trust.requestAssessment', input);
          return { reportId: newId(), ref: 'TR-1' };
        },
        raiseSignal: async (input: any) => {
          rec('trust.raiseSignal', input);
          return { id: newId(), ref: 'TR-2' } as any;
        },
      },
      workqueues: {
        raise: async (input: any) => {
          work.push(input);
          return { id: newId() } as any;
        },
        resolveBySource: async () => 1,
      },
      ...o.apiStubs,
    },
  });
  // the boot can take a while: the app's time must not stay behind the test tokens, signed at the real time
  clock.set(new Date());
  const svc = app.kernel.boot.apis.get('sellers') as unknown as SellersService;
  const events: EventEnvelope[] = [];
  for (const name of Object.keys((await import('../../../spec/sellers.js')).spec.events.publishes)) app.kernel.events.subscribe('test', name, (e) => void events.push(e));
  const kit: Kit = {
    app,
    svc,
    clock,
    events,
    audits,
    work,
    calls,
    authority,
    approvals,
    of: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
    last: (name) => kit.of(name).at(-1),
    callsOf: (fn) => calls.filter((c) => c.fn === fn).map((c) => c.args),
    async call(method, url, token, body, headers = {}) {
      const res = await app.inject({ method: method as never, url, headers: { ...auth(token), ...headers }, ...(body !== undefined ? { payload: body as object } : {}) });
      await app.kernel.events.drain();
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    },
    async emit(source, name, payload, actor) {
      app.kernel.events.publish(source, name, payload, actor ? { actor: actor as never } : {});
      await app.kernel.events.drain();
    },
    async decide(requestId, outcome, by = newId()) {
      const a = approvals.get(requestId)!;
      await kit.emit('access', 'access.approval.decided', {
        requestId,
        ref: 'AP-1',
        actionKey: a.action,
        module: 'sellers',
        target: a.target,
        outcome,
        decidedBy: { kind: 'staff', id: by },
        reason: outcome === 'approved' ? null : 'Not enough evidence',
        approverIds: [by],
        requestedById: a.requestedBy.accountId ?? '',
      });
    },
    close: () => app.close(),
  };
  return kit;
}

/* ---------------------------------------------------------------- callers */

export const staffId = () => newId();
/** Dev tokens valid for 60 days, so tests can move the clock forward */
const TTL = 60 * 86_400;
export const staff = (id = newId()) => token({ ...devClaims('staff', { permissions: ['*'] }), sub: id }, TTL);
export const customer = (accountId = newId()) => token(devClaims('customer', { accountId }), TTL);
export const owner = (sellerId: string, accountId = newId()) => token(devClaims('seller', { sellerId, accountId }), TTL);
export const member = (sellerId: string, permissions: string[]) => token(devClaims('seller', { sellerId, permissions }), TTL);

/* ---------------------------------------------------------------- flows */

export const address = { name: 'Northwind Audio LLC', line1: '410 Pine St', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US' };

export const businessInput = (legalName = 'Northwind Audio LLC', storeName = 'Northwind Audio') => ({
  kind: 'registered_business',
  legalName,
  storeName,
  businessType: 'llc',
  stateOfRegistration: 'OR',
  registryNumber: 'OR-123456',
  address,
  phone: '+15035550100',
  website: 'https://northwind.example.com',
  categoryIds: [newId()],
  plannedProductCount: '21_100',
  plannedProducts: 'headphones, speakers',
  supportHours: 'Mon–Fri 9–5',
});

export const accountInput = (storeName = 'Northwind Audio', invitationCode?: string) => ({
  accountMode: 'existing_member',
  contactName: 'Ana Lopez',
  contactPhone: '+15035550101',
  workEmail: `ana.${newId().slice(-6)}@northwind.example.com`,
  storeName,
  sellerType: 'business',
  market: 'US',
  ...(invitationCode ? { invitationCode } : {}),
});

export const payoutInput = (accountNumber = '000123457731', holder = 'Northwind Audio LLC') => ({ accountHolderName: holder, accountType: 'business_checking', routingNumber: '011000015', accountNumber, confirmAccountNumber: accountNumber });

/** A business invited to apply, with its code */
export async function invitation(kit: Kit, email = `shop.${newId().slice(-6)}@example.com`) {
  const res = await kit.call('POST', `${ADMIN}/seller-invitations`, staff(), { email, businessName: 'Northwind Audio LLC' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.invitation.id as string, code: res.body.code as string };
}

/**
 * Starts and completes every step, then submits. Returns the application and the applicant.
 *
 * `workEmail`, `taxId`, `payoutAccount` and `address` are the four details the duplicate check at submission
 * compares (`repository.applicationsMatching`), so a test can make two applications share exactly one of them.
 */
export async function submitted(
  kit: Kit,
  o: { legalName?: string; storeName?: string; accountId?: string; plannedProducts?: string; workEmail?: string; taxId?: string; payoutAccount?: string; address?: typeof address } = {},
) {
  const accountId = o.accountId ?? newId();
  const token = customer(accountId);
  const { code } = await invitation(kit);
  const storeName = o.storeName ?? `Northwind ${newId().slice(-5)}`;
  const start = await kit.call('POST', `${STORE}/applications`, token, { ...accountInput(storeName, code), ...(o.workEmail ? { workEmail: o.workEmail } : {}) });
  expect(start.status, JSON.stringify(start.body)).toBe(201);
  const id = start.body.id as string;
  const patch = async (body: object) => {
    const r = await kit.call('PATCH', `${STORE}/applications/${id}`, token, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };
  await patch({ step: 'business', business: { ...businessInput(o.legalName, storeName), ...(o.address ? { address: o.address } : {}), ...(o.plannedProducts ? { plannedProducts: o.plannedProducts } : {}) } });
  const v = await patch({ step: 'verification', verification: { owners: [{ name: 'Ana Lopez', ownershipPct: 100, isPrimary: true, idDocumentIds: [] }], taxIdType: 'ein', taxId: o.taxId ?? '12-3456789', w9Method: 'online' } });
  const ownerId = v.verification.owners[0].id;
  for (const [kind, extra] of [['owner_id', { ownerId }], ['business_registration', {}]] as const) {
    const d = await kit.call('POST', `${STORE}/applications/${id}/documents`, token, { mediaId: newId(), kind, ...extra });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
  }
  await patch({ step: 'payout', payout: payoutInput(o.payoutAccount) });
  await patch({ step: 'return_address', returnAddress: { sameAsBusiness: true, contactName: 'Ana Lopez', phone: '+15035550101' } });
  const draft = (await kit.call('GET', `${STORE}/applications/current`, token)).body;
  const acceptances = draft.agreementsRequired.map((a: any) => ({ key: a.key, versionLabel: a.versionLabel }));
  const sub = await kit.call('POST', `${STORE}/applications/${id}/submit`, token, { acceptances, signedName: 'Ana Lopez' });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  return { id, token, accountId, application: sub.body, sellerId: sub.body.sellerId as string };
}

/** An approved seller (optionally launch-ready: payout verified, first submission, review passed) */
export async function approvedSeller(kit: Kit, o: { launch?: boolean; legalName?: string } = {}) {
  const s = await submitted(kit, o);
  const reviewer = staff();
  expect((await kit.call('POST', `${ADMIN}/applications/${s.id}/start-review`, reviewer)).status).toBe(200);
  const ok = await kit.call('POST', `${ADMIN}/applications/${s.id}/approve`, reviewer, { note: 'Welcome' });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  const sellerToken = owner(s.sellerId, s.accountId);
  if (o.launch) {
    await kit.emit('finance', 'finance.destination.verified', { sellerId: s.sellerId, reviewId: newId() });
    await kit.emit('catalog', 'catalog.product.submitted', { productId: newId(), ownerSellerId: s.sellerId, submissionId: newId(), ref: 'SUB-261010-0001', kind: 'new', title: 'Headphones', reviewDueAt: kit.clock.now().toISOString() });
    expect((await kit.call('POST', `${SELLER}/setup/launch-review`, sellerToken, {})).status).toBe(200);
    expect((await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/launch-review/decide`, staff(), { outcome: 'pass' })).status).toBe(200);
  }
  return { ...s, sellerToken };
}

export const restrictionInput = (o: object = {}) => ({
  title: 'New listings in Cameras paused',
  reasonCode: 'brand_claim',
  reason: 'Brand authorisation for Halden cameras is missing (rule P-4.2).',
  affectedActivities: ['new_listings', 'new_offers'],
  scope: { categoryIds: [newId()] },
  toResolve: 'Upload the authorisation letter from Halden.',
  reviewDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
  ...o,
});
