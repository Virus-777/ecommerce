import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import { address, ADMIN, boot, STORE, type Kit } from './helpers.js';

/** Answers of modules not built yet (orders, support, trust, messaging) and controlled answers of built ones */
const world = {
  inProgress: 0,
  approval: null as access.ApprovalRequest | null,
  decision: 'approval_required' as access.AuthorityCheck['decision'],
};
const audits: audit.RecordInput[] = [];
const identityCalls = { reset: vi.fn(async () => {}), revoke: vi.fn(async () => 2), close: vi.fn(async () => {}) };
const requestApproval = vi.fn(async (input: access.RequestApprovalInput) => {
  world.approval = { id: newId(), status: 'pending', action: { key: input.action }, eligibleApprovers: [{ accountId: newId(), name: 'Dana Support Manager', away: false }] } as never;
  return world.approval!;
});

let kit: Kit;
beforeAll(async () => {
  kit = await boot({
    only: ['audit', 'access', 'orders', 'support', 'trust', 'messaging'],
    apiStubs: {
      audit: { record: async (e) => (audits.push(e), newId()) },
      access: {
        check: async (_p, action) => ({ decision: world.decision, action, reason: 'Always needs a second person', requiresSecondReviewer: true, approvalsNeeded: 1, eligibleApproverRoles: [], eligibleApprovers: [] }),
        requestApproval,
        approvalForTargets: async (_p, _t, ids) => new Map(ids.map((id) => [id, world.approval])),
        getApproval: async (id) => (world.approval?.id === id ? world.approval : null),
      },
      orders: {
        countInProgress: async () => ({ inProgress: world.inProgress, delayedPackages: 0 }),
        listRecentForCustomer: async () => [],
        getOrder: async () => ({ contact: { kind: 'guest', name: 'Gus Guest', email: 'gus@example.com' } }) as never,
        getOrderAdmin: async () => null,
      },
      support: { listOpenCasesForCustomer: async () => ({ items: [], total: 0 }) },
      trust: { reportsAbout: async () => ({ filedBy: 1, against: 2, open: 1, reportIds: [newId(), newId()] }) },
      messaging: { customerConversationSummaries: async (ids) => Object.fromEntries(ids.map((id) => [id, { conversationCount: 3, openCount: 1, reportedCount: 0, lastMessageAt: null, counterparties: [{ name: 'Casa Verde Home' }] }])) },
      identity: {
        sendPasswordReset: identityCalls.reset,
        revokeSessions: identityCalls.revoke,
        closeAccount: identityCalls.close,
        accountSecurityOf: async (ids) => new Map(ids.map((id) => [id, { signInSummary: 'Password only', twoStep: { enabled: false }, lastSignInAt: null }])),
      },
    },
  });
});
afterAll(() => kit.app.close());
beforeEach(() => {
  world.inProgress = 0;
  world.approval = null;
  world.decision = 'approval_required';
});

const act = (id: string, body: Record<string, unknown>, token = kit.staff()) =>
  kit.call('POST', `${ADMIN}/customers/${id}/actions`, { token, body: { reasonCode: 'policy_violation', details: 'Checked the reports and the messages', ...body } });

describe('customer list and detail', () => {
  it('lists customers with filters and finds them by name, email and CU reference', async () => {
    const c = await kit.customer({ firstName: 'Zelda', lastName: 'Quartz' });
    await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { address: address({ city: 'Bend' }) } });
    const ref = (await kit.service.getCustomer(c.customerId))!.ref;
    for (const q of ['zelda qu', c.email, ref]) {
      const res = await kit.call('GET', `${ADMIN}/customers?q=${encodeURIComponent(q)}`, { token: kit.staff(['customers.accounts.view']) });
      expect(res.status).toBe(200);
      expect(res.body.items.map((x: any) => x.id), q).toEqual([c.customerId]);
    }
    const row = (await kit.call('GET', `${ADMIN}/customers?q=${ref}`, { token: kit.staff() })).body.items[0];
    expect(row).toMatchObject({ ref, name: 'Zelda Quartz', location: 'Bend, OR', orderCount: 0, totalSpend: { amount: 0, currency: 'USD' }, accountStatus: 'active', verification: 'not_verified', abuseReports: 2, openCases: 0 });
    const none = await kit.call('GET', `${ADMIN}/customers?q=${ref}&status=suspended`, { token: kit.staff() });
    expect(none.body.items).toEqual([]);
    const paged = await kit.call('GET', `${ADMIN}/customers?page=1&limit=2&sort=name`, { token: kit.staff() });
    expect(paged.body).toMatchObject({ page: 1 });
    expect(paged.body.total).toBeGreaterThan(0);
  });

  it('the detail aggregates other modules, lists unavailable ones and is audited', async () => {
    const c = await kit.customer();
    const res = await kit.call('GET', `${ADMIN}/customers/${c.customerId}`, { token: kit.staff(['customers.accounts.view']) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      profile: { id: c.customerId },
      signIn: { method: 'Password only', twoStepEnabled: false },
      messages: { conversationCount: 3, lastCounterparty: 'Casa Verde Home' },
      abuseReports: { filedBy: 1, against: 2 },
      orders: { count: 0 },
      unavailable: [],
    });
    expect(audits.at(-1)).toMatchObject({ action: 'customers.customer.view', module: 'customers', target: { type: 'customer', id: c.customerId } });
    expect((await kit.call('GET', `${ADMIN}/customers/${newId()}`, { token: kit.staff() })).status).toBe(404);
  });

  it('adds internal notes (never shown to the customer)', async () => {
    const c = await kit.customer();
    const res = await kit.call('POST', `${ADMIN}/customers/${c.customerId}/notes`, { token: kit.token('staff', { permissions: ['customers.notes.write'] }, {}), body: { body: 'Called about late order' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ body: 'Called about late order', author: { kind: 'staff' } });
    expect((await kit.call('POST', `${ADMIN}/customers/${c.customerId}/notes`, { token: kit.staff(), body: { body: ' ' } })).status).toBe(400);
    expect(audits.at(-1)).toMatchObject({ action: 'customers.note.add' });
  });
});

describe('account actions', () => {
  it('restricting messaging: restricted status, restriction with appeal route, events, audit; lift returns to active', async () => {
    const c = await kit.customer();
    const res = await act(c.customerId, { action: 'restrict_messaging', reasonCode: 'abusive_messages', endsAt: new Date(kit.clock.now().getTime() + 7 * 86_400_000).toISOString() });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ accountStatus: 'restricted', record: { action: 'restrict', fromStatus: 'active', toStatus: 'restricted' }, restriction: { scope: 'messaging', state: 'active' } });
    expect(res.body.effects).toContain('Existing orders, returns, refunds and cases stay open');
    const rid = res.body.restriction.id;
    expect(kit.of('customers.account.status_changed')).toContainEqual({ customerId: c.customerId, from: 'active', to: 'restricted', reasonCode: 'abusive_messages' });
    expect(kit.of('customers.account.restricted').at(-1)).toMatchObject({ customerId: c.customerId, restrictionId: rid, scope: 'messaging' });
    expect(await kit.service.canSendMessages(c.customerId)).toMatchObject({ allowed: false, until: expect.any(String) });
    expect(await kit.service.canPlaceOrders(c.customerId)).toEqual({ allowed: true });
    expect(audits.at(-1)).toMatchObject({ action: 'customers.account.restrict', before: { accountStatus: 'active' }, after: { accountStatus: 'restricted' } });
    // the customer sees it with the appeal route
    const profile = (await kit.call('GET', `${STORE}/profile`, { token: c.token })).body;
    expect(profile.restrictions[0]).toMatchObject({ id: rid, appealRoute: expect.stringContaining('support case') });

    const lift = await kit.call('POST', `${ADMIN}/customers/${c.customerId}/restrictions/${rid}/lift`, { token: kit.staff(), body: { reason: 'Apologised' } });
    expect(lift.body).toMatchObject({ accountStatus: 'active', restriction: { state: 'lifted' }, record: { action: 'lift_restriction' } });
    expect(kit.of('customers.account.restriction_lifted').at(-1)).toEqual({ customerId: c.customerId, restrictionId: rid, scope: 'messaging', trustEnforcementId: null });
    const again = await kit.call('POST', `${ADMIN}/customers/${c.customerId}/restrictions/${rid}/lift`, { token: kit.staff(), body: { reason: 'again' } });
    expect(again.status).toBe(409);
    // another customer's restriction is not found
    const other = await kit.customer();
    expect((await kit.call('POST', `${ADMIN}/customers/${other.customerId}/restrictions/${rid}/lift`, { token: kit.staff(), body: { reason: 'x' } })).status).toBe(404);
    const history = (await kit.call('GET', `${ADMIN}/customers/${c.customerId}/actions`, { token: kit.staff() })).body;
    expect(history.items.map((x: any) => x.action)).toEqual(['lift_restriction', 'restrict']);
  });

  it('suspend stops orders and messages; reinstate keeps restrictions in force (restricted)', async () => {
    const c = await kit.customer();
    await act(c.customerId, { action: 'restrict_reviews' });
    const s = await act(c.customerId, { action: 'suspend' });
    expect(s.body.accountStatus).toBe('suspended');
    expect(await kit.service.canPlaceOrders(c.customerId)).toMatchObject({ allowed: false });
    expect(await kit.service.canSendMessages(c.customerId)).toMatchObject({ allowed: false });
    const r = await act(c.customerId, { action: 'reinstate' });
    expect(r.body.accountStatus).toBe('restricted');
    expect(kit.of('customers.account.status_changed').filter((e) => e.customerId === c.customerId).map((e) => `${e.from}>${e.to}`)).toEqual(['active>restricted', 'restricted>suspended', 'suspended>active', 'active>restricted']);
  });

  it('review: mark and clear; illegal moves answer 409; details are required', async () => {
    const c = await kit.customer();
    expect((await act(c.customerId, { action: 'clear_review' })).status).toBe(409);
    expect((await act(c.customerId, { action: 'mark_under_review' })).body.accountStatus).toBe('under_review');
    expect((await act(c.customerId, { action: 'close' })).status).toBe(409); // under review cannot close
    expect((await act(c.customerId, { action: 'clear_review' })).body.accountStatus).toBe('active');
    const noDetails = await act(c.customerId, { action: 'suspend', details: '   ' });
    expect(noDetails.status).toBe(400);
    const past = await act(c.customerId, { action: 'restrict_ordering', endsAt: new Date(kit.clock.now().getTime() - 1000).toISOString() });
    expect(past.status).toBe(400);
  });

  it('password reset and sign-out need customers.accounts.security and call identity', async () => {
    const c = await kit.customer();
    const denied = await act(c.customerId, { action: 'send_password_reset', reasonCode: 'suspected_takeover' }, kit.staff(['customers.accounts.act']));
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.permission).toBe('customers.accounts.security');
    const ok = await act(c.customerId, { action: 'send_password_reset', reasonCode: 'suspected_takeover' }, kit.staff(['customers.accounts.act', 'customers.accounts.security']));
    expect(ok.status).toBe(200);
    expect(identityCalls.reset).toHaveBeenCalledWith(c.accountId, expect.objectContaining({ reason: 'Checked the reports and the messages', revokeSessions: false }));
    await act(c.customerId, { action: 'sign_out_everywhere', reasonCode: 'suspected_takeover' });
    expect(identityCalls.revoke).toHaveBeenCalledWith(c.accountId, expect.any(String));
    expect(ok.body).toMatchObject({ accountStatus: 'active', record: { action: 'send_password_reset' } });
  });

  it('closing with open obligations needs a second reviewer; the account closes when the request is approved', async () => {
    const c = await kit.customer();
    world.inProgress = 1;
    const first = await act(c.customerId, { action: 'close' });
    expect(first.status).toBe(409);
    expect(first.body.error).toMatchObject({ code: 'APPROVAL_REQUIRED', details: { approvalRequestId: world.approval!.id, approvers: ['Dana Support Manager'], blockers: [{ kind: 'open_orders' }] } });
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ action: 'customers.accounts.close-with-obligations', target: expect.objectContaining({ type: 'customer', id: c.customerId }) }));
    // still pending: the same request is reused
    const calls = requestApproval.mock.calls.length;
    expect((await act(c.customerId, { action: 'close' })).body.error.details.approvalRequestId).toBe(world.approval!.id);
    expect(requestApproval.mock.calls.length).toBe(calls);

    const requesterId = newId();
    const decided = (requestId: string, outcome: 'approved' | 'rejected' | 'expired') => ({
      requestId,
      ref: 'AP-261009-0002',
      actionKey: 'customers.accounts.close-with-obligations',
      module: 'customers',
      target: { type: 'customer', id: c.customerId },
      outcome,
      approverIds: [],
      requestedById: requesterId,
    });
    // rejected: the pending closure is dropped, the account stays open
    await kit.publish('access', 'access.approval.decided', decided(world.approval!.id, 'rejected'));
    expect((await kit.service.getCustomer(c.customerId))!.accountStatus).toBe('active');
    expect(identityCalls.close).not.toHaveBeenCalled();

    // a new request, approved (the decision delivered twice): closed once, as the requester, with their reason
    const approved = {
      id: newId(),
      status: 'approved',
      action: { key: 'customers.accounts.close-with-obligations' },
      reason: 'Fraud ring confirmed by the payments team',
      details: { reasonCode: 'policy_violation', details: 'Fraud ring confirmed by the payments team' },
      requestedBy: { kind: 'staff', id: requesterId, name: 'Sam Agent' },
    } as unknown as access.ApprovalRequest;
    world.approval = approved;
    audits.length = 0;
    await kit.publish('access', 'access.approval.decided', decided(approved.id, 'approved'));
    await kit.publish('access', 'access.approval.decided', decided(approved.id, 'approved'));
    expect((await kit.service.getCustomer(c.customerId))!.accountStatus).toBe('closed');
    expect(identityCalls.close).toHaveBeenCalledTimes(1);
    expect(identityCalls.close).toHaveBeenCalledWith(c.accountId, 'policy_violation: Fraud ring confirmed by the payments team');
    expect(kit.of('customers.account.closed').filter((e) => e.customerId === c.customerId)).toEqual([{ customerId: c.customerId, userId: c.accountId }]);
    const closes = audits.filter((a) => a.action === 'customers.account.close');
    expect(closes).toEqual([expect.objectContaining({ approvalRequestId: approved.id, actor: { kind: 'staff', id: requesterId, name: 'Sam Agent' } })]);
    const history = await kit.call('GET', `${ADMIN}/customers/${c.customerId}/actions`, { token: kit.staff() });
    expect(history.body.items[0]).toMatchObject({ action: 'close', reasonCode: 'policy_violation', toStatus: 'closed' });
  });

  it('closing for suspected fraud skips the obligation check; a denied authority is FORBIDDEN', async () => {
    const c = await kit.customer();
    world.inProgress = 3;
    world.decision = 'denied';
    const denied = await act(c.customerId, { action: 'close' });
    expect(denied.status).toBe(403);
    const fraud = await act(c.customerId, { action: 'close', reasonCode: 'payment_fraud_review' });
    expect(fraud.body.accountStatus).toBe('closed');
    expect(await kit.service.getMarketingConsent(c.customerId)).toMatchObject({ emailPromotions: false });
  });

  it('the expire job ends restrictions past endsAt and returns the account to active', async () => {
    const c = await kit.customer();
    await act(c.customerId, { action: 'restrict_ordering', endsAt: new Date(kit.clock.now().getTime() + 3_600_000).toISOString() });
    expect(await kit.service.canPlaceOrders(c.customerId)).toMatchObject({ allowed: false });
    kit.clock.advance(2 * 3_600_000);
    expect(await kit.service.canPlaceOrders(c.customerId)).toEqual({ allowed: true }); // ended even before the job runs
    await kit.app.kernel.jobs.runNow('customers.expire-restrictions');
    await kit.drain();
    expect((await kit.service.getCustomer(c.customerId))!.accountStatus).toBe('active');
    expect(kit.of('customers.account.restriction_lifted').at(-1)).toMatchObject({ customerId: c.customerId, scope: 'ordering' });
  });
});

describe('events from other modules', () => {
  it('trust enforcement restricts the customer once, with the trust appeal route', async () => {
    const c = await kit.customer();
    const enforcement = { enforcementId: newId(), reportId: newId(), action: 'restrict_customer_messaging', ownerTeam: 'customers', targets: [{ type: 'customer', id: c.customerId, label: 'Ana' }], reason: 'Harassing sellers', params: {}, appealDeadline: new Date(kit.clock.now().getTime() + 14 * 86_400_000).toISOString(), alreadyApplied: false };
    await kit.publish('trust', 'trust.enforcement.recorded', enforcement, { kind: 'staff', id: newId() });
    await kit.publish('trust', 'trust.enforcement.recorded', enforcement);
    const rs = await kit.service.restrictionsOf(c.customerId, true);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ scope: 'messaging', reason: 'Harassing sellers', trustEnforcementId: enforcement.enforcementId, trustReportId: enforcement.reportId, appealRoute: expect.stringContaining('Trust actions'), setBy: { kind: 'staff' } });
    expect(kit.of('customers.account.restricted').at(-1)).toMatchObject({ trustEnforcementId: enforcement.enforcementId });
    // other actions and other targets are ignored
    await kit.publish('trust', 'trust.enforcement.recorded', { ...enforcement, enforcementId: newId(), action: 'suspend_offer' });
    expect(await kit.service.restrictionsOf(c.customerId, true)).toHaveLength(1);
  });

  it('orders.order.placed keeps the guest buyer list and the customer read model', async () => {
    const email = `guest.${Date.now()}@example.com`;
    const placed = (o: Record<string, unknown>) => ({
      orderId: newId(),
      ref: `MK-261009-${String(Math.floor(Math.random() * 99999)).padStart(5, '0')}`,
      checkoutSessionId: newId(),
      customerId: null,
      guestEmail: email,
      paymentIntentId: newId(),
      paymentState: 'accepted',
      total: { amount: 2500, currency: 'USD' },
      couponCodes: [],
      groups: [],
      placedAt: kit.clock.now().toISOString(),
      ...o,
    });
    const first = placed({});
    await kit.publish('orders', 'orders.order.placed', first);
    await kit.publish('orders', 'orders.order.placed', first); // delivered twice
    await kit.publish('orders', 'orders.order.placed', placed({ total: { amount: 1000, currency: 'USD' } }));
    const list = await kit.call('GET', `${ADMIN}/guest-buyers?q=${encodeURIComponent(email)}`, { token: kit.staff(['customers.accounts.view']) });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ email, name: 'Gus Guest', orderCount: 2, totalSpend: { amount: 3500, currency: 'USD' }, openCases: null });

    // the email registers: the guest moves to the customer list
    const c = await kit.customer({ email });
    expect((await kit.call('GET', `${ADMIN}/guest-buyers?q=${encodeURIComponent(email)}`, { token: kit.staff() })).body.items).toEqual([]);
    const member = placed({ customerId: c.customerId, guestEmail: null, total: { amount: 4200, currency: 'USD' } });
    await kit.publish('orders', 'orders.order.placed', member);
    await kit.publish('orders', 'orders.order.placed', member); // delivered twice: counted once
    const row = (await kit.call('GET', `${ADMIN}/customers?q=${encodeURIComponent(email)}`, { token: kit.staff() })).body.items[0];
    expect(row).toMatchObject({ orderCount: 1, totalSpend: { amount: 4200, currency: 'USD' } });
  });

  it('identity.account.closed closes the customer and stops promotions', async () => {
    const c = await kit.customer({ marketingOptIn: true });
    await kit.publish('identity', 'identity.account.closed', { accountId: c.accountId, at: kit.clock.now().toISOString() });
    expect((await kit.service.getCustomer(c.customerId))!.accountStatus).toBe('closed');
    expect(await kit.service.getMarketingConsent(c.customerId)).toMatchObject({ emailPromotions: false });
    expect(kit.of('customers.account.closed')).toContainEqual({ customerId: c.customerId, userId: c.accountId });
  });
});

describe('GraphQL', () => {
  it('me (store) and customers / customer (admin)', async () => {
    const c = await kit.customer({ firstName: 'Gwen' });
    await kit.call('POST', `${STORE}/addresses`, { token: c.token, body: { address: address() } });
    await act(c.customerId, { action: 'restrict_reviews' });
    const me = await kit.app.inject({
      method: 'POST',
      url: '/graphql/store',
      headers: { authorization: `Bearer ${c.token}` },
      payload: { query: '{ me { id firstName accountStatus canOrder restrictions { scope state } addresses { isDefault address { city } } marketingPreferences { emailPromotions essentialAlwaysOn } dataRequests { id } } }' },
    });
    const body = me.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.me).toMatchObject({ id: c.customerId, firstName: 'Gwen', accountStatus: 'RESTRICTED', canOrder: true, restrictions: [{ scope: 'REVIEWS', state: 'ACTIVE' }], addresses: [{ isDefault: true, address: { city: 'Portland' } }], marketingPreferences: { essentialAlwaysOn: true } });

    const admin = await kit.app.inject({
      method: 'POST',
      url: '/graphql/admin',
      headers: { authorization: `Bearer ${kit.staff()}` },
      payload: {
        query: `{ customers(filter: { search: "${c.email}", statuses: [RESTRICTED] }) { total items { id location verification totalSpend { formatted } notes { id } accountActions(limit: 5) { action actor { kind } } } }
                  customer(id: "${c.customerId}") { ref restrictions(includeEnded: true) { setBy { kind } } } }`,
      },
    });
    const a = admin.json();
    expect(a.errors).toBeUndefined();
    expect(a.data.customers.items).toEqual([{ id: c.customerId, location: 'Portland, OR', verification: 'NOT_VERIFIED', totalSpend: { formatted: '$0.00' }, notes: [], accountActions: [{ action: 'RESTRICT', actor: { kind: 'STAFF' } }] }]);
    expect(a.data.customer.restrictions).toEqual([{ setBy: { kind: 'STAFF' } }]);
  });
});
