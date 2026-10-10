/**
 * Pass 2 topics: external recipients (suppliers, rights owners, scheduled-report addresses), store credit,
 * the day-end summary, campaign and article reminders, moderation and trust outcomes, and the guest
 * order/payment dedupe. Payloads follow src/spec/*.ts.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, bootWorld, emailsTo, money, newId, publish, type World } from './harness.js';
import type { NotificationsService } from '../service.js';

let app: FastifyInstance;
let world: World;
let service: NotificationsService;

beforeAll(async () => {
  ({ app, world, service } = await bootWorld());
});
afterAll(async () => {
  await app?.close();
});

const inbox = async (headers: Record<string, string>, area: 'store' | 'seller' | 'admin', query = '') => {
  const res = await app.inject({ method: 'GET', url: `/api/${area}/notifications/inbox${query}`, headers });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as any[];
};

const deliveries = async (query: string) => {
  const res = await app.inject({ method: 'GET', url: `/api/admin/notifications/deliveries?${query}`, headers: as.staff(world.staff()) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as any[];
};

const addr = (who: string) => `${who}-${newId().slice(-12)}@example.com`; // the random end (ids start with the time)
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

function purchaseOrder(o: { supplierEmail?: string | null; emailSupplier: boolean; message?: string | null }) {
  const line = (sku: string, label: string, qty: number) => ({
    id: newId(),
    stockItemId: newId(),
    sku,
    label,
    image: null,
    quantityOrdered: qty,
    quantityReceived: 0,
    quantityDamaged: 0,
    quantityClosed: 0,
    quantityOpen: qty,
    unitCost: money(6300),
    lineTotal: money(6300 * qty),
    expectedDate: null,
    note: null,
  });
  return {
    purchaseOrderId: newId(),
    ref: `PO-261010-${Math.floor(Math.random() * 9000 + 1000)}`,
    supplierId: newId(),
    supplierName: 'Northwind Supply Co.',
    supplierEmail: o.supplierEmail ?? null,
    emailSupplier: o.emailSupplier,
    message: o.message ?? null,
    locationId: newId(),
    shipTo: { locationId: newId(), code: 'RNO1', name: 'Reno, NV warehouse', address: { name: 'Marketly Receiving', line1: '100 Industrial Way', line2: null, city: 'Reno', region: 'NV', postalCode: '89502', country: 'US', phone: null }, timeZone: 'America/Los_Angeles' },
    total: money(226800),
    lines: [line('LAMP-BLK', 'Aurora Desk Lamp, black', 24), line('LAMP-WHT', 'Aurora Desk Lamp, white', 12)],
  };
}

describe('external recipients', () => {
  it('emails the purchase order to the supplier (no inbox notice) with an in-app copy to the Purchasing Manager role', async () => {
    const buyer = world.staff();
    world.role('purchasing_manager', { leadAccountId: buyer.accountId, accountIds: [buyer.accountId] });
    const supplierEmail = addr('supplier');
    const po = purchaseOrder({ supplierEmail, emailSupplier: true, message: 'Please confirm the delivery date by Friday.' });
    await publish(app, 'purchasing.purchase_order.sent', po);

    const mail = emailsTo(supplierEmail);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.message.subject).toBe(`Purchase order ${po.ref} from Marketly`);
    expect(mail[0]!.message.text).toContain('Aurora Desk Lamp, black (LAMP-BLK) × 24; Aurora Desk Lamp, white (LAMP-WHT) × 12');
    expect(mail[0]!.message.text).toContain('$2,268.00');
    expect(mail[0]!.message.text).toContain('Message from your buyer: Please confirm the delivery date by Friday.');
    // the delivery address comes from the payload's shipTo (location name and address)
    expect(mail[0]!.message.text).toContain('Deliver to: Reno, NV warehouse, 100 Industrial Way, Reno, NV 89502, US');
    const log = await deliveries(`topicKey=supplier.purchase_order.sent&address=${encodeURIComponent(supplierEmail)}`);
    expect(log).toMatchObject([{ status: 'delivered', noticeId: null, accountId: null, linkedRef: po.ref }]);
    const row = await service.core.repo.getDelivery(log[0].id);
    expect(row?.recipient_kind).toBe('external_email');

    const copy = await inbox(as.staff(buyer), 'admin');
    expect(copy.map((n) => n.topicKey)).toEqual(['staff.purchasing.po_sent']);
    expect(copy[0].body).toContain('Northwind Supply Co.');
    expect(emailsTo(buyer.email)).toHaveLength(0); // in-app copy only
  });

  it('does not email the supplier when the buyer did not ask, or when the supplier has no address', async () => {
    const supplierEmail = addr('supplier');
    await publish(app, 'purchasing.purchase_order.sent', purchaseOrder({ supplierEmail, emailSupplier: false }));
    expect(emailsTo(supplierEmail)).toHaveLength(0);
    const po = purchaseOrder({ supplierEmail: null, emailSupplier: true });
    await publish(app, 'purchasing.purchase_order.sent', po);
    expect(await deliveries(`linkedRef=${po.ref}`)).toHaveLength(0);
  });

  it('is idempotent per event: the same envelope twice sends one email and records nothing new', async () => {
    const supplierEmail = addr('supplier');
    const po = purchaseOrder({ supplierEmail, emailSupplier: true });
    const eventId = newId();
    await service.onPurchaseOrderSentFromPurchasing(po as never, eventId);
    await service.onPurchaseOrderSentFromPurchasing(po as never, eventId);
    expect(emailsTo(supplierEmail)).toHaveLength(1);
    expect(await deliveries(`topicKey=supplier.purchase_order.sent&address=${encodeURIComponent(supplierEmail)}`)).toHaveLength(1);
  });

  it('confirms a rights report to the rights owner with the TR reference', async () => {
    const contactEmail = addr('rights');
    const reportId = newId();
    await publish(app, 'trust.rights_report.received', { reportId, ref: 'TR-261010-004', brandName: 'Northwind Audio', contactName: 'Dana Whitfield', contactEmail });
    const mail = emailsTo(contactEmail);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.message.subject).toBe('We received your report TR-261010-004');
    expect(mail[0]!.message.text).toContain('Hello Dana');
    expect(mail[0]!.message.text).toContain('Northwind Audio');
    expect(mail[0]!.message.text).toContain('How we handle reports: '); // public store help page
    expect(mail[0]!.message.text).toContain('/help/article/rights-owner-reports');
    expect(await deliveries(`topicKey=rights_owner.report.received&address=${encodeURIComponent(contactEmail)}`)).toMatchObject([{ noticeId: null, linkedRef: 'TR-261010-004' }]);
  });

  it('tells each staff recipient of a scheduled report (phase 2) with a link to their own export; never outside addresses', async () => {
    const a = world.staff();
    const b = world.staff();
    const [exportA, exportB] = [newId(), newId()];
    await publish(app, 'reports.scheduled_report.ready', {
      scheduleId: newId(),
      reportKey: 'sales_summary',
      reportTitle: 'Weekly sales',
      format: 'csv',
      periodLabel: 'Week of Oct 5, 2026',
      deliveries: [
        { staffId: a.accountId, exportId: exportA },
        { staffId: b.accountId, exportId: exportB },
      ],
      skippedStaffIds: [],
      expiresAt: inDays(7),
    });
    for (const [p, exportId] of [[a, exportA], [b, exportB]] as const) {
      const [n] = await inbox(as.staff(p), 'admin');
      expect(n).toMatchObject({ topicKey: 'staff.report.scheduled', group: 'Reports', link: { kind: 'export', id: exportId, screen: 'admin/reports' } });
      const mail = emailsTo(p.email);
      expect(mail).toHaveLength(1);
      expect(mail[0]!.message.subject).toBe('Weekly sales: Week of Oct 5, 2026');
      expect(mail[0]!.message.text).toContain('(CSV)');
      expect(mail[0]!.message.text).toContain(`/admin/reports/${exportId}`);
    }
    const log = await deliveries('topicKey=staff.report.scheduled');
    expect(log.every((d) => d.recipientKind === 'staff_member')).toBe(true);
  });

  it('accepts external_email recipients on essential topics only (public API)', async () => {
    const to = addr('outside');
    const link = { kind: 'help', id: 'rights-owner-reports', screen: 'help/article' };
    await expect(service.notify({ topic: 'customer.review.invite', recipients: [{ kind: 'external_email', email: to }], link })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.notify({ topic: 'customer.promotions.newsletter', recipients: [{ kind: 'external_email', email: to }], link })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.notify({ topic: 'rights_owner.report.received', recipients: [{ kind: 'external_email' }], link })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const res = await service.notify({ topic: 'rights_owner.report.received', recipients: [{ kind: 'external_email', email: to }], link, context: { report: { ref: 'TR-1' } } });
    expect(res.noticeIds).toEqual([]);
    expect(res.deliveryIds).toHaveLength(1);
    expect(emailsTo(to)).toHaveLength(1);
  });
});

describe('customers and staff', () => {
  it('tells a customer that store credit is about to expire', async () => {
    const c = world.customer();
    const lotId = newId();
    await publish(app, 'wallet.credit.expiring', { customerId: c.customerId, lotId, amount: money(1500), expiresAt: inDays(7), daysLeft: 7 });
    const [n] = await inbox(as.customer(c), 'store');
    expect(n).toMatchObject({ topicKey: 'customer.credit.expiring', group: 'account', link: { kind: 'store_credit', id: lotId } });
    expect(n.title).toContain('$15.00');
    expect(emailsTo(c.email)[0]!.message.text).toContain('7 days left');
  });

  it('sends the day-end summary to the listed roles through access', async () => {
    const shipping = world.staff();
    const inventory = world.staff();
    world.role('shipping_manager', { leadAccountId: shipping.accountId, accountIds: [shipping.accountId] });
    world.role('inventory_manager', { leadAccountId: inventory.accountId, accountIds: [inventory.accountId] });
    const reviewId = newId();
    await publish(app, 'workqueues.day_end.prepared', { reviewId, date: '2026-10-09', dueAt: inDays(0.25), openItems: 14, overdueItems: 3, roleKeys: ['shipping_manager', 'inventory_manager'] });
    for (const p of [shipping, inventory]) {
      const mine = (await inbox(as.staff(p), 'admin')).filter((n) => n.topicKey === 'staff.day_end.summary');
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ actionRequired: true, group: 'Operations', link: { kind: 'day_end', id: reviewId } });
      expect(mine[0].title).toContain('Oct 9');
      expect(mine[0].body).toContain('14 open and 3 overdue');
    }
  });

  it('reminds the owner staff member, or the role, about campaigns ending soon and articles due for review', async () => {
    const owner = world.staff();
    const adLead = world.staff();
    const contentLead = world.staff();
    world.role('advertising_manager', { leadAccountId: adLead.accountId, accountIds: [adLead.accountId] });
    world.role('content_manager', { leadAccountId: contentLead.accountId, accountIds: [contentLead.accountId] });
    const campaign = (o: Record<string, unknown>) => ({ campaignId: newId(), ref: 'AD-261010-01', name: 'Home Week', endsAt: inDays(3), daysLeft: 3, ...o });

    await publish(app, 'advertising.campaign.ending_soon', campaign({ advertiserKind: 'own', ownerStaffId: owner.accountId, sellerId: null }));
    await publish(app, 'advertising.campaign.ending_soon', campaign({ advertiserKind: 'brand', ownerStaffId: null, sellerId: null, name: 'Brand Days' }));
    expect((await inbox(as.staff(owner), 'admin')).map((n) => n.title)).toEqual([expect.stringContaining('Home Week')]);
    expect((await inbox(as.staff(adLead), 'admin')).filter((n) => n.topicKey === 'staff.campaign.ending_soon').map((n) => n.title)).toEqual([expect.stringContaining('Brand Days')]);

    const articleId = newId();
    await publish(app, 'content.article.review_due', { articleId, slug: 'how-returns-work', title: 'How returns work', ownerStaffId: null, lastReviewedAt: null, dueSince: new Date().toISOString() });
    const [due] = await inbox(as.staff(contentLead), 'admin', '?view=needs_my_action');
    expect(due).toMatchObject({ topicKey: 'staff.article.review_due', group: 'Content', link: { kind: 'article', id: articleId } });
  });

  it('tells seller members with advertising permission about their campaign ending soon', async () => {
    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true });
    const marketer = world.member(sellerId, { permissions: ['advertising.requests.manage'] });
    const packer = world.member(sellerId, { permissions: ['orders.fulfillment.view'] });
    await publish(app, 'advertising.campaign.ending_soon', { campaignId: newId(), ref: 'AD-261010-02', name: 'Lamp promo', advertiserKind: 'seller', sellerId, ownerStaffId: null, endsAt: inDays(2), daysLeft: 2 });
    expect((await inbox(as.seller(owner), 'seller')).map((n) => n.topicKey)).toEqual(['seller.campaign.ending_soon']);
    expect((await inbox(as.seller(marketer), 'seller')).map((n) => n.topicKey)).toEqual(['seller.campaign.ending_soon']);
    expect(await inbox(as.seller(packer), 'seller')).toHaveLength(0);
  });
});

describe('moderation and trust outcomes', () => {
  it('tells reporters the outcome and the author the decision with the appeal date', async () => {
    const reporter = world.customer();
    const author = world.customer();
    const sellerId = newId();
    const sellerOwner = world.member(sellerId, { isOwner: true });
    const contentId = newId();
    await publish(app, 'reviews.moderation.decided', {
      moderationItemId: newId(),
      contentType: 'product_review',
      contentId,
      decision: 'remove',
      reasonCode: 'personal_information',
      author: { kind: 'customer', id: author.customerId },
      reporters: [
        { kind: 'customer', id: reporter.customerId },
        { kind: 'seller', id: sellerId },
      ],
      reporterOutcome: 'We removed the review after checking your report.',
      appealUntil: inDays(14),
    });
    const [r] = await inbox(as.customer(reporter), 'store');
    expect(r).toMatchObject({ topicKey: 'customer.review_report.decided', group: 'cases' });
    expect(r.body).toContain('We removed the review after checking your report.');
    expect((await inbox(as.seller(sellerOwner), 'seller')).map((n) => n.topicKey)).toEqual(['seller.review_report.decided']);
    const [a] = await inbox(as.customer(author), 'store');
    expect(a).toMatchObject({ topicKey: 'customer.review.moderated', title: 'Your review was removed' });
    expect(a.body).toContain('personal information');
    expect(a.body).toMatch(/You can appeal until [A-Z][a-z]{2} \d+\./);
  });

  it('tells a seller whose answer was kept, without an appeal line', async () => {
    const sellerId = newId();
    const owner = world.member(sellerId, { isOwner: true });
    await publish(app, 'reviews.moderation.decided', { moderationItemId: newId(), contentType: 'answer', contentId: newId(), decision: 'keep', reasonCode: 'no_violation', author: { kind: 'seller', id: sellerId }, reporters: [], reporterOutcome: null, appealUntil: null });
    const [n] = await inbox(as.seller(owner), 'seller');
    expect(n).toMatchObject({ topicKey: 'seller.content.moderated', title: 'Your answer was kept' });
    expect(n.body).not.toContain('appeal');
  });

  it('tells each reporter of a trust report the outcome (rights owners by email only) and resolves the staff notice', async () => {
    const trustLead = world.staff();
    world.role('trust_and_risk_manager', { leadAccountId: trustLead.accountId, accountIds: [trustLead.accountId] });
    const reportId = newId();
    await publish(app, 'trust.report.created', { reportId, ref: 'TR-261010-009', type: 'counterfeit', source: 'customer', riskScore: 70, subjects: [] });
    expect((await inbox(as.staff(trustLead), 'admin', '?view=needs_my_action')).map((n) => n.topicKey)).toContain('staff.trust.report');
    const customer = world.customer();
    const guest = addr('guest-reporter');
    const rightsOwner = addr('rights');
    const sellerId = newId();
    const sellerOwner = world.member(sellerId, { isOwner: true });
    await publish(app, 'trust.report.resolved', {
      reportId,
      ref: 'TR-261010-009',
      outcome: 'enforced',
      reporterOutcome: 'We took action on the listing you reported.',
      reporters: [
        { kind: 'customer', customerId: customer.customerId },
        { kind: 'customer', customerId: null, contactEmail: guest },
        { kind: 'rights_owner', contactName: 'Dana Whitfield', contactEmail: rightsOwner },
        { kind: 'seller', sellerId },
      ],
    });
    const [c] = await inbox(as.customer(customer), 'store');
    expect(c).toMatchObject({ topicKey: 'trust.report.resolved', link: { ref: 'TR-261010-009' } });
    expect(c.body).toContain('We took action on the listing you reported.');
    expect(emailsTo(customer.email)).toHaveLength(1);
    expect(emailsTo(guest)).toHaveLength(1);
    expect(emailsTo(rightsOwner)).toHaveLength(1);
    expect(emailsTo(rightsOwner)[0]!.message.subject).toBe('Update on your report TR-261010-009');
    expect(await deliveries(`topicKey=trust.report.resolved&address=${encodeURIComponent(rightsOwner)}`)).toMatchObject([{ noticeId: null }]);
    expect((await inbox(as.seller(sellerOwner), 'seller')).map((n) => n.topicKey)).toEqual(['seller.trust_report.resolved']);
    const staffSide = (await inbox(as.staff(trustLead), 'admin')).find((n) => n.topicKey === 'staff.trust.report');
    expect(staffSide.resolvedAt).toBeTruthy();
  });
});

describe('guest order emails', () => {
  it('sends a guest one email when the payment is captured right after the order acceptance', async () => {
    const email = addr('guest');
    const orderId = newId();
    await publish(app, 'orders.order.accepted', {
      orderId,
      ref: 'MK-261010-55501',
      customerId: null,
      contactEmail: email,
      total: money(18900),
      groups: [{ groupId: newId(), ownerType: 'official', sellerId: null, fulfilledBy: 'official_warehouse', dispatchBy: inDays(1), itemIds: [newId()], total: money(18900) }],
      items: [], acceptedAt: new Date().toISOString(),
    });
    await publish(app, 'payments.payment.captured', { intentId: newId(), captureId: newId(), orderId, customerId: null, contactEmail: email, groupId: null, amount: money(18900), creditAmount: null, allocations: [], providerRef: null, capturedAt: new Date().toISOString() });
    const mail = emailsTo(email);
    expect(mail.map((m) => m.message.subject)).toEqual(['Your order MK-261010-55501 is confirmed']);

    // without a recent acceptance email the payment email goes out
    const other = addr('guest');
    await publish(app, 'payments.payment.captured', { intentId: newId(), captureId: newId(), orderId: newId(), customerId: null, contactEmail: other, groupId: null, amount: money(500), creditAmount: null, allocations: [], providerRef: null, capturedAt: new Date().toISOString() });
    expect(emailsTo(other)).toHaveLength(1);
  });
});
