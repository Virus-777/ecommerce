// Reviews sellers start in the Seller Center reach the staff who decide them: one action notice per review in the
// Admin Center inbox, naming the store, linking to where it is decided, resolved when it is decided. A role nobody
// can receive passes the notice to its escalation role.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, bootWorld, newId, publish, type World } from './harness.js';

let app: FastifyInstance;
let world: World;

beforeAll(async () => {
  ({ app, world } = await bootWorld());
});
afterAll(async () => {
  await app?.close();
});

const inbox = async (headers: Record<string, string>, query = '') => {
  const res = await app.inject({ method: 'GET', url: `/api/admin/notifications/inbox${query}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as any[];
};
const todo = (headers: Record<string, string>) => inbox(headers, '?view=needs_my_action');

describe('seller reviews reach the Seller Manager', () => {
  it('store changes: named for the store, linked to the seller page or the Brands tab, resolved on decision', async () => {
    const manager = world.staff({ name: 'Sam Reyes' });
    world.role('seller_manager', { leadAccountId: manager.accountId, accountIds: [manager.accountId] });
    const sellerId = newId();
    world.store(sellerId, 'Virus Store');

    const nameChange = newId();
    await publish(app, 'sellers.change_request.submitted', { changeRequestId: nameChange, sellerId, kind: 'store_name' });
    const [n] = await todo(as.staff(manager));
    expect(n).toMatchObject({
      topicKey: 'staff.seller.change_requested',
      group: 'Sellers',
      actionRequired: true,
      title: 'Store name change to review: Virus Store',
      link: { kind: 'seller', id: sellerId, screen: 'admin/seller' },
      routedTo: { roleKey: 'seller_manager' },
    });

    const brand = newId();
    await publish(app, 'sellers.change_request.submitted', { changeRequestId: brand, sellerId, kind: 'brand_request' });
    const brandNotice = (await todo(as.staff(manager))).find((x) => x.title.startsWith('Brand request'));
    expect(brandNotice).toMatchObject({ link: { kind: 'brand', screen: 'admin/categories' } });

    await publish(app, 'sellers.change_request.decided', { changeRequestId: nameChange, sellerId, kind: 'store_name', approved: true, brandRequest: null });
    expect((await todo(as.staff(manager))).map((x) => x.title)).toEqual([brandNotice.title]);
  });

  it('launch review, appeal, restriction evidence and application answers each notify, and decisions resolve them', async () => {
    const manager = world.staff();
    world.role('seller_manager', { leadAccountId: manager.accountId, accountIds: [manager.accountId] });
    const sellerId = newId();
    world.store(sellerId, 'Northwind Audio');

    await publish(app, 'sellers.launch_review.requested', { sellerId });
    const appealId = newId();
    await publish(app, 'sellers.appeal.submitted', { appealId, sellerId, subject: 'restriction', subjectId: newId(), level: 1, decideBy: new Date(Date.now() + 5 * 86_400_000).toISOString(), trustReportId: null });
    const restrictionId = newId();
    await publish(app, 'sellers.restriction.evidence_submitted', { sellerId, restrictionId });
    await publish(app, 'sellers.application.information_provided', { applicationId: newId(), sellerId });

    const open = await todo(as.staff(manager));
    expect(open.map((x) => x.topicKey).sort()).toEqual([
      'staff.seller.appeal_submitted',
      'staff.seller.application_information_provided',
      'staff.seller.launch_review_requested',
      'staff.seller.restriction_evidence',
    ]);
    expect(open.every((x) => x.title.includes('Northwind Audio'))).toBe(true);
    expect(open.find((x) => x.topicKey === 'staff.seller.appeal_submitted').deadline).toBeTruthy();

    await publish(app, 'sellers.launch_review.decided', { sellerId, outcome: 'passed', decidedAt: new Date().toISOString() });
    await publish(app, 'sellers.appeal.decided', { appealId, sellerId, outcome: 'upheld', subject: 'restriction', subjectId: newId(), trustReportId: null });
    await publish(app, 'sellers.restriction.lifted', { sellerId, restrictionId, reason: 'Documents accepted', trustEnforcementId: null });
    expect((await todo(as.staff(manager))).map((x) => x.topicKey)).toEqual(['staff.seller.application_information_provided']);
  });
});

describe('catalog reviews reach the Catalog Manager', () => {
  it('product submissions, brand requests and corrections notify; approval, brand status and decisions resolve them', async () => {
    const catalog = world.staff();
    world.role('catalog_manager', { leadAccountId: catalog.accountId, accountIds: [catalog.accountId] });
    const sellerId = newId();
    world.store(sellerId, 'Casa Verde Home');

    const productId = newId();
    const reviewDueAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await publish(app, 'catalog.product.submitted', { productId, ownerSellerId: sellerId, submissionId: newId(), ref: 'SUB-261020-0001', kind: 'new', title: 'Linen duvet cover', reviewDueAt });
    const brandId = newId();
    await publish(app, 'catalog.brand.requested', { brandId, name: 'Moss & Oak', sellerId, productId });
    const suggestionId = newId();
    await publish(app, 'catalog.correction.suggested', { suggestionId, productId });

    const open = await todo(as.staff(catalog));
    const product = open.find((x) => x.topicKey === 'staff.catalog.product_submitted');
    expect(product).toMatchObject({ group: 'Catalog', title: 'New product: Linen duvet cover', link: { screen: 'admin/product-review', id: productId, ref: 'SUB-261020-0001' } });
    expect(product.body).toContain('Casa Verde Home');
    expect(product.deadline).toBeTruthy();
    expect(open.find((x) => x.topicKey === 'staff.catalog.brand_requested')).toMatchObject({ title: 'New brand to review: Moss & Oak', link: { kind: 'brand', screen: 'admin/categories' } });
    expect(open.some((x) => x.topicKey === 'staff.catalog.correction_suggested')).toBe(true);

    // brand edits that are not a status decision leave the request open
    await publish(app, 'catalog.brand.changed', { brandId, change: 'updated', status: 'under_review', sellingPolicy: 'open' });
    expect((await todo(as.staff(catalog))).some((x) => x.topicKey === 'staff.catalog.brand_requested')).toBe(true);

    await publish(app, 'catalog.product.approved', { productId, ownerSellerId: sellerId });
    await publish(app, 'catalog.brand.changed', { brandId, change: 'status', status: 'active', sellingPolicy: 'open' });
    await publish(app, 'catalog.correction.decided', { suggestionId, accepted: true });
    expect(await todo(as.staff(catalog))).toHaveLength(0);
  });
});

describe('a role nobody can receive', () => {
  it('passes the notice to its escalation role (the Business Owner)', async () => {
    const owner = world.staff({ name: 'Xvirus Man' });
    world.role('trust_and_risk_manager', { accountIds: [], escalationRoleKey: 'business_owner' });
    world.role('business_owner', { accountIds: [owner.accountId] });
    const appealId = newId();
    await publish(app, 'trust.appeal.submitted', { appealId, enforcementId: newId(), decideBy: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    const [n] = await todo(as.staff(owner));
    expect(n).toMatchObject({ topicKey: 'staff.trust.appeal_submitted', routedTo: { roleKey: 'business_owner', roleName: 'Business Owner' } });
    await publish(app, 'trust.appeal.decided', { appealId, ref: 'AP-1', enforcementId: newId(), outcome: 'upheld', explanation: 'The evidence supports the action.', customerId: null, sellerId: null });
    expect(await todo(as.staff(owner))).toHaveLength(0);
  });

  it('sends nothing to staff for a first payout account (its test deposits verify it), but a change goes to Finance', async () => {
    const finance = world.staff();
    world.role('finance_manager', { accountIds: [finance.accountId] });
    const sellerId = newId();
    world.store(sellerId, 'Gadget Grove');
    const base = { sellerId, providerDestinationId: 'dest_1', accountHolderName: 'Gadget Grove LLC', accountType: 'checking', requestedBy: { kind: 'seller', id: newId() } };
    await publish(app, 'sellers.payout_account.changed', { ...base, changeId: newId(), label: 'Checking •••• 1111', previousLabel: null, isInitial: true });
    expect(await todo(as.staff(finance))).toHaveLength(0);
    await publish(app, 'sellers.payout_account.changed', { ...base, changeId: newId(), label: 'Checking •••• 2222', previousLabel: 'Checking •••• 1111', isInitial: false });
    const [n] = await todo(as.staff(finance));
    expect(n).toMatchObject({ topicKey: 'staff.finance.payout_account_review', title: 'Payout account change: Gadget Grove' });
    expect(n.body).toContain('Checking •••• 1111');
    await publish(app, 'finance.destination.verified', { sellerId, reviewId: newId() });
    expect(await todo(as.staff(finance))).toHaveLength(0);
  });
});
