/**
 * Live topics (2026-10-20): the notices the Seller Center and Admin Center were missing. Sellers hear about refunds,
 * new reviews, store feedback, customer questions and announcements from Marketly; the Official Store's counterparts
 * go to the Official Store Manager role; a seller's support request goes to its team's role. Plus the announcement
 * endpoints (POST and GET /api/admin/notifications/announcements).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OFFICIAL_STORE_ID } from '../../../spec/common.js';
import { buildTestApp } from '../../../testing/app.js';
import { as, emailsTo, MODULES, money, newId, publish, World, type Person } from './harness.js';

let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  world = new World();
  const stubs = world.stubs();
  // the announcement endpoint checks the chosen sellers through sellers.getSellers (the harness does not stub it)
  const snapshot = (id: string) => ({ id, ref: 'SL-1', slug: id, storeName: 'Store', status: 'approved' as const, verified: true, canSellNew: true, activeRestrictionIds: [], launchReady: true });
  stubs.sellers = { ...stubs.sellers, getSellers: async (ids: string[]) => ids.filter((id) => world.sellersList.includes(id)).map(snapshot) };
  app = await buildTestApp({ modules: MODULES, config: { launchPhase: 4, rateLimits: false }, apiStubs: stubs });
});
afterAll(async () => {
  await app?.close();
});

const inbox = async (headers: Record<string, string>, area: 'seller' | 'admin', query = '') => {
  const res = await app.inject({ method: 'GET', url: `/api/${area}/notifications/inbox${query}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as any[];
};
const topics = async (headers: Record<string, string>, area: 'seller' | 'admin') => (await inbox(headers, area)).map((n) => n.topicKey);
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

/** A seller with an owner and a member holding only the given permissions */
function sellerWith(memberPermissions: string[] = []) {
  const sellerId = newId();
  const owner = world.member(sellerId, { isOwner: true, role: 'Owner' });
  const member = world.member(sellerId, { permissions: memberPermissions });
  return { sellerId, owner, member };
}

/** The Official Store Manager role, led by a new staff member (each test gets its own) */
function officialStoreManager(): Person {
  const lead = world.staff();
  world.role('official_store_manager', { leadAccountId: lead.accountId, accountIds: [lead.accountId] });
  return lead;
}

const refundApproved = (o: Record<string, unknown>) => ({
  refundRequestId: newId(),
  returnId: null,
  caseId: null,
  orderId: newId(),
  orderRef: 'MK-261020-40001',
  returnRef: null,
  caseRef: null,
  customerId: null,
  contactEmail: 'guest@example.com',
  orderItemIds: [],
  items: [],
  ownerType: 'seller',
  sellerId: null,
  source: 'return',
  trustReportId: null,
  total: money(4900),
  breakdown: { itemAmount: money(4900), discountShare: money(0), shippingRefund: money(0), returnShippingDeduction: money(0), deductions: [], total: money(4900), maxRefundable: money(4900), destination: 'original_method', isEstimate: false },
  fundedBy: 'seller',
  sellerShare: money(4900),
  platformShare: null,
  approvedBy: { kind: 'staff', id: newId() },
  ...o,
});

describe('seller: refunds', () => {
  it('a refund on the seller\'s return reaches members who issue refunds, says it was approved (not that it arrived) and links to the return', async () => {
    const s = sellerWith(['returns.refunds.issue']);
    const other = sellerWith();
    const plain = world.member(s.sellerId, { permissions: ['orders.fulfillment.view'] });
    const returnId = newId();
    await publish(app, 'returns.refund.approved', refundApproved({ sellerId: s.sellerId, returnId, returnRef: 'RT-261020-0001' }));
    const [n] = await inbox(as.seller(s.member), 'seller');
    expect(n).toMatchObject({ topicKey: 'seller.refund.approved', group: 'returns_cases', link: { kind: 'return', id: returnId, screen: 'seller/return', ref: 'RT-261020-0001' } });
    expect(n.title).toBe('Refund approved on MK-261020-40001');
    expect(n.body).toContain('$49.00');
    expect(n.body).toContain('handed to payments');
    expect(n.body).not.toMatch(/received|arrived|in your account/i);
    expect(await topics(as.seller(s.owner), 'seller')).toEqual(['seller.refund.approved']);
    expect(await inbox(as.seller(plain), 'seller')).toHaveLength(0); // no returns.refunds.issue
    expect(await inbox(as.seller(other.owner), 'seller')).toHaveLength(0);
    expect(emailsTo(s.owner.email).some((m) => m.message.subject === 'Refund approved on MK-261020-40001')).toBe(true);
  });

  it('a refund a seller member approved themselves is not announced back; an order refund links to the order list', async () => {
    const s = sellerWith();
    await publish(app, 'returns.refund.approved', refundApproved({ sellerId: s.sellerId, approvedBy: { kind: 'seller', id: s.owner.accountId }, source: 'seller' }));
    expect(await inbox(as.seller(s.owner), 'seller')).toHaveLength(0);
    const orderId = newId();
    await publish(app, 'returns.refund.approved', refundApproved({ sellerId: s.sellerId, orderId, source: 'exception' }));
    const [n] = await inbox(as.seller(s.owner), 'seller');
    expect(n.link).toMatchObject({ kind: 'order', id: orderId, screen: 'seller/orders', ref: 'MK-261020-40001' });
  });
});

describe('seller: reviews, feedback and questions', () => {
  it('a new product review reaches members who respond to reviews, once per review (an edit sends nothing again)', async () => {
    const s = sellerWith(['reviews.responses.post']);
    const plain = world.member(s.sellerId, { permissions: ['orders.fulfillment.view'] });
    const reviewId = newId();
    const review = { reviewId, productId: newId(), sellerId: s.sellerId, rating: 4, verified: true };
    await publish(app, 'reviews.review.published', review);
    await publish(app, 'reviews.review.published', { ...review, rating: 2 }); // edited
    const notices = await inbox(as.seller(s.member), 'seller');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ topicKey: 'seller.review.new', group: 'products', title: 'New 4-star review', link: { kind: 'review', id: reviewId, screen: 'seller/customers' } });
    expect(notices[0].body).toContain('verified purchase');
    expect(await inbox(as.seller(plain), 'seller')).toHaveLength(0);
    expect(emailsTo(s.owner.email).filter((m) => m.message.subject === 'New 4-star review of your product')).toHaveLength(1);
    expect(emailsTo(s.owner.email).some((m) => m.message.subject === 'New 2-star review of your product')).toBe(false);
  });

  it('new store feedback, once per feedback', async () => {
    const s = sellerWith();
    const feedback = { feedbackId: newId(), sellerId: s.sellerId, orderId: newId(), sentiment: 'positive' };
    await publish(app, 'reviews.feedback.published', feedback);
    await publish(app, 'reviews.feedback.published', feedback);
    const notices = await inbox(as.seller(s.owner), 'seller');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ topicKey: 'seller.feedback.new', group: 'products', title: 'New positive store feedback', link: { kind: 'feedback', id: feedback.feedbackId, screen: 'seller/customers' } });
  });

  it('a question goes to each seller with an offer, action required until that seller answers; a customer answer leaves it open', async () => {
    const a = sellerWith();
    const b = sellerWith();
    const questionId = newId();
    const productId = newId();
    await publish(app, 'reviews.question.asked', { questionId, productId, customerId: newId(), sellerIds: [a.sellerId, b.sellerId], officialStore: false });
    for (const s of [a, b]) {
      const [n] = await inbox(as.seller(s.owner), 'seller', '?actionRequired=true');
      expect(n, 'seller').toMatchObject({ topicKey: 'seller.question.asked', group: 'products', actionRequired: true, state: 'open', link: { kind: 'question', id: questionId, screen: 'seller/customers' } });
    }
    const answer = (o: Record<string, unknown>) => ({ answerId: newId(), questionId, productId, askerCustomerId: newId(), ...o });
    await publish(app, 'reviews.answer.published', answer({ label: 'customer', sellerId: null }));
    expect((await inbox(as.seller(a.owner), 'seller'))[0].state).toBe('open');
    await publish(app, 'reviews.answer.published', answer({ label: 'seller', sellerId: a.sellerId }));
    expect((await inbox(as.seller(a.owner), 'seller'))[0].state).toBe('resolved');
    expect((await inbox(as.seller(b.owner), 'seller'))[0].state).toBe('open'); // b has not answered
  });
});

describe('seller: announcements from Marketly', () => {
  const send = (headers: Record<string, string>, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/admin/notifications/announcements', headers, payload });
  let sender: Person;
  beforeAll(() => {
    sender = world.staff();
  });

  it('to chosen sellers: one notice per workspace for every member, emailed to the owner, linking where staff chose', async () => {
    const a = sellerWith();
    const b = sellerWith();
    const left = sellerWith();
    const res = await send(as.staff(sender, ['notifications.announcements.send']), {
      title: 'Carrier pickups move to 6 PM',
      body: 'From Nov 1, carriers collect at 6 PM.\n\nDispatch deadlines stay the same.',
      sellerIds: [a.sellerId, b.sellerId, a.sellerId],
      link: { screen: 'seller/help', id: 'carrier-pickups', label: 'Read the details' },
    });
    expect(res.statusCode, res.body).toBe(202);
    const { announcement } = res.json();
    expect(announcement).toMatchObject({ title: 'Carrier pickups move to 6 PM', audience: 'chosen', sellerCount: 2, link: { screen: 'seller/help', id: 'carrier-pickups', label: 'Read the details' }, sentBy: { kind: 'staff', id: sender.accountId } });
    for (const m of [a.owner, a.member, b.owner]) {
      const [n] = await inbox(as.seller(m), 'seller');
      expect(n).toMatchObject({ topicKey: 'seller.announcement', category: 'essential', group: 'account_finance', title: 'Carrier pickups move to 6 PM', link: { screen: 'seller/help', id: 'carrier-pickups', label: 'Read the details' } });
      expect(n.body).toContain('Dispatch deadlines stay the same.');
    }
    expect(await inbox(as.seller(left.owner), 'seller')).toHaveLength(0);
    expect(emailsTo(a.owner.email).some((m) => m.message.subject === 'Marketly: Carrier pickups move to 6 PM')).toBe(true);
    expect(world.audits.some((e) => e.action === 'notifications.announcement.send' && e.target.id === announcement.id)).toBe(true);
  });

  it('to every active seller when no sellers are chosen, linking to the notifications page; listed newest first', async () => {
    const s = sellerWith();
    const res = await send(as.staff(sender, ['notifications.announcements.send']), { title: 'Holiday hours', body: 'Support answers until 2 PM on Dec 24.' });
    expect(res.statusCode, res.body).toBe(202);
    const { announcement } = res.json();
    expect(announcement).toMatchObject({ audience: 'all', sellerCount: world.sellersList.length });
    const n = (await inbox(as.seller(s.owner), 'seller')).find((x) => x.topicKey === 'seller.announcement');
    expect(n.link).toMatchObject({ kind: 'announcement', id: announcement.id, screen: 'seller/notifications' });

    const list = await app.inject({ method: 'GET', url: '/api/admin/notifications/announcements?limit=10', headers: as.staff(sender, ['notifications.announcements.send']) });
    expect(list.statusCode, list.body).toBe(200);
    const items = list.json().items;
    expect(items[0]).toMatchObject({ id: announcement.id, title: 'Holiday hours', audience: 'all' });
    expect(items[1]).toMatchObject({ title: 'Carrier pickups move to 6 PM', audience: 'chosen', sellerCount: 2 });
  });

  it('refuses without the permission, unknown sellers, empty text and links outside Seller Center', async () => {
    const s = sellerWith();
    expect((await send(as.staff(sender, ['notifications.broadcasts.manage']), { title: 'x', body: 'y', sellerIds: [s.sellerId] })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/notifications/announcements', headers: as.staff(sender, ['notifications.templates.view']) })).statusCode).toBe(403);
    const allowed = as.staff(sender, ['notifications.announcements.send']);
    const unknown = await send(allowed, { title: 'Hello', body: 'Text', sellerIds: [s.sellerId, newId()] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.details.issues[0].path).toBe('sellerIds[1]');
    expect((await send(allowed, { title: '   ', body: 'Text', sellerIds: [s.sellerId] })).json().error.details.issues[0].path).toBe('title');
    expect((await send(allowed, { title: 'x'.repeat(121), body: 'Text', sellerIds: [s.sellerId] })).statusCode).toBe(400);
    expect((await send(allowed, { title: 'Hello', body: 'y'.repeat(2001), sellerIds: [s.sellerId] })).statusCode).toBe(400);
    expect((await send(allowed, { title: 'Hello', body: 'Text', sellerIds: [] })).statusCode).toBe(400);
    expect((await send(allowed, { title: 'Hello', body: 'Text', sellerIds: [s.sellerId], link: { screen: 'admin/orders', id: '1' } })).json().error.details.issues[0].path).toBe('link.screen');
    expect(await inbox(as.seller(s.owner), 'seller')).toHaveLength(0); // nothing was sent
  });
});

describe('Official Store counterparts (Official Store Manager role)', () => {
  it('new order and return request (action required until approved); no seller workspace is addressed', async () => {
    const lead = officialStoreManager();
    const orderId = newId();
    const groupId = newId();
    await publish(app, 'orders.order.accepted', {
      orderId, ref: 'MK-261020-50001', customerId: null, contactEmail: 'guest@example.com', total: money(18900),
      groups: [{ groupId, ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', dispatchBy: inDays(1), itemIds: [newId()], total: money(18900) }],
      items: [], acceptedAt: new Date().toISOString(),
    });
    let [n] = await inbox(as.staff(lead), 'admin');
    expect(n).toMatchObject({ topicKey: 'staff.official_store.order_new', group: 'Operations', title: 'New Official Store order MK-261020-50001', link: { kind: 'order', id: orderId, screen: 'admin/order' } });
    expect(n.routedTo).toMatchObject({ roleKey: 'official_store_manager' });

    const returnId = newId();
    await publish(app, 'returns.return.requested', { returnId, ref: 'RT-261020-0002', orderId, orderRef: 'MK-261020-50001', ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', orderItemIds: [newId()], reason: 'arrived_damaged', responseDueAt: inDays(2) });
    [n] = await inbox(as.staff(lead), 'admin', '?view=needs_my_action');
    expect(n).toMatchObject({ topicKey: 'staff.official_store.return_requested', group: 'Returns', actionRequired: true, state: 'open', link: { kind: 'return', id: returnId, screen: 'admin/returns' } });
    expect(n.body).toContain('arrived damaged');
    await publish(app, 'returns.return.approved', { returnId, ref: 'RT-261020-0002', orderId, orderRef: 'MK-261020-50001', customerId: null, contactEmail: 'guest@example.com', ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', items: [], withoutReturn: false, platformDecision: true, dropOffBy: inDays(7), trackingNumber: null });
    expect(await inbox(as.staff(lead), 'admin', '?view=needs_my_action')).toHaveLength(0);
  });

  it('refund, review, feedback and question (resolved when Marketly staff answer)', async () => {
    const lead = officialStoreManager();
    const seller = sellerWith();
    const returnId = newId();
    await publish(app, 'returns.refund.approved', refundApproved({ ownerType: 'official', sellerId: null, returnId, returnRef: 'RT-261020-0003', fundedBy: 'platform', sellerShare: null }));
    await publish(app, 'reviews.review.published', { reviewId: newId(), productId: newId(), sellerId: OFFICIAL_STORE_ID, rating: 5, verified: false });
    await publish(app, 'reviews.feedback.published', { feedbackId: newId(), sellerId: OFFICIAL_STORE_ID, orderId: newId(), sentiment: 'negative' });
    const questionId = newId();
    const productId = newId();
    await publish(app, 'reviews.question.asked', { questionId, productId, customerId: newId(), sellerIds: [seller.sellerId], officialStore: true });
    const notices = await inbox(as.staff(lead), 'admin');
    expect(notices.map((n) => n.topicKey).sort()).toEqual(['staff.official_store.feedback_new', 'staff.official_store.question_asked', 'staff.official_store.refund_approved', 'staff.official_store.review_new']);
    const by = (k: string) => notices.find((n) => n.topicKey === k);
    expect(by('staff.official_store.refund_approved')).toMatchObject({ group: 'Returns', link: { kind: 'return', id: returnId, screen: 'admin/returns', ref: 'RT-261020-0003' } });
    expect(by('staff.official_store.review_new')).toMatchObject({ title: 'New 5-star Official Store review', link: { screen: 'admin/official' } });
    expect(by('staff.official_store.feedback_new').title).toBe('New negative Official Store feedback');
    expect(by('staff.official_store.question_asked')).toMatchObject({ actionRequired: true, state: 'open', link: { kind: 'question', id: questionId, screen: 'admin/official' } });
    // the seller with an offer gets its own question notice; Marketly staff answering resolves only the staff one
    await publish(app, 'reviews.answer.published', { answerId: newId(), questionId, productId, label: 'marketly_staff', askerCustomerId: newId(), sellerId: null });
    expect((await inbox(as.staff(lead), 'admin')).find((n) => n.topicKey === 'staff.official_store.question_asked').state).toBe('resolved');
    expect((await inbox(as.seller(seller.owner), 'seller'))[0]).toMatchObject({ topicKey: 'seller.question.asked', state: 'open' });
    // no seller workspace was addressed for the Official Store's review
    expect(await inbox(as.seller(seller.member), 'seller')).toHaveLength(0);
  });
});

describe('seller support requests', () => {
  const opened = (o: Record<string, unknown>) => ({
    caseId: newId(), ref: 'CS-261020-0001', kind: 'seller_request', category: 'fees_payouts', priority: 'medium', customerId: null, contactEmail: null,
    sellerId: newId(), orderId: null, orderItemIds: [], handler: 'marketplace_support', ownerStaffId: null, trustReportId: null, team: 'seller_management', nextResponseDueAt: inDays(1), ...o,
  });

  it("go to the team's role (Seller Manager), action required until a staff owner is assigned", async () => {
    const lead = world.staff();
    world.role('seller_manager', { leadAccountId: lead.accountId, accountIds: [lead.accountId] });
    const support = world.staff();
    world.role('customer_support_manager', { leadAccountId: support.accountId, accountIds: [support.accountId] });
    const s = sellerWith();
    const p = opened({ sellerId: s.sellerId });
    await publish(app, 'support.case.opened', p);
    const [n] = await inbox(as.staff(lead), 'admin', '?view=needs_my_action');
    expect(n).toMatchObject({ topicKey: 'staff.seller.support_request', group: 'Sellers', actionRequired: true, state: 'open', link: { kind: 'case', id: p.caseId, screen: 'admin/case', ref: 'CS-261020-0001' } });
    expect(n.body).toContain('fees payouts');
    expect(await inbox(as.staff(support), 'admin')).toHaveLength(0);
    // the seller's own request is not announced back to the seller
    expect(await inbox(as.seller(s.owner), 'seller')).toHaveLength(0);
    await publish(app, 'support.case.assigned', { caseId: p.caseId, ownerId: lead.accountId, team: 'seller_management' });
    expect((await inbox(as.staff(lead), 'admin'))[0].state).toBe('resolved');
  });

  it('another team (finance) gets it; a decision resolves it; customer cases send nothing to staff', async () => {
    const finance = world.staff();
    world.role('finance_manager', { leadAccountId: finance.accountId, accountIds: [finance.accountId] });
    const p = opened({ team: 'finance' });
    await publish(app, 'support.case.opened', p);
    expect((await inbox(as.staff(finance), 'admin'))[0]).toMatchObject({ topicKey: 'staff.seller.support_request', group: 'Finance', state: 'open' });
    await publish(app, 'support.case.decided', { caseId: p.caseId, ref: p.ref, outcome: 'answered', orderId: null, customerId: null, contactEmail: null, returnId: null, sellerId: p.sellerId, remedies: [], appealDeadline: null, final: true, notified: false });
    expect((await inbox(as.staff(finance), 'admin'))[0].state).toBe('resolved');
    await publish(app, 'support.case.opened', opened({ kind: 'customer_help', team: 'finance', customerId: newId(), sellerId: null }));
    expect(await inbox(as.staff(finance), 'admin')).toHaveLength(1);
  });
});

