/** Publication (hide, suspend, reactivate with the trust override approval), impact preview and the trust consumer. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, brand, catalogApp, category, newId, sellerProduct, type CatalogTestApp } from './helpers.js';

let t: CatalogTestApp;
let a: ReturnType<typeof api>;
let cat: { id: string };
let brandId: string;
beforeAll(async () => {
  t = await catalogApp();
  a = api(t);
  cat = await category(t, 'Speakers');
  brandId = (await brand(t, 'Tidewater')).id;
});
afterAll(async () => {
  await t?.app.close();
});
beforeEach(() => {
  t.events.length = 0;
  t.stubs.audit.record.mockClear();
  t.stubs.access.check.mockClear();
  t.stubs.access.requestApproval.mockClear();
});

const offer = async (productId: string, variantId: string, sellerId: string | null, status = 'active') => {
  const offerId = newId();
  const base = { offerId, productId, variantId, ownerType: sellerId ? 'seller' : 'official', sellerId };
  t.app.kernel.events.publish('offers', 'offers.offer.created', { ...base, condition: 'new', stockItemId: newId() });
  t.app.kernel.events.publish('offers', 'offers.offer.status_changed', { ...base, from: 'draft', to: status, stockItemId: newId() });
  t.app.kernel.events.publish('inventory', 'inventory.stock.changed', { stockItemId: newId(), offerId, ownerType: base.ownerType, sellerId, variantId, available: 5, reserved: 0, previousAvailable: 0, state: 'in_stock', cause: 'receipt', productId, archived: false });
  await t.app.kernel.events.drain();
  return offerId;
};

describe('publication', () => {
  it('hide → suspend → activate with reasons; events, review log, audit; store and purchasability follow', async () => {
    const sellerId = newId();
    const { id } = await sellerProduct(t, sellerId, { brandId, categoryId: cat.id, approve: true });
    const hide = await a.admin('POST', `/products/${id}/publication`, { publication: 'hidden', reason: 'Recall check' });
    expect(hide.statusCode, hide.body).toBe(200);
    expect(hide.json()).toMatchObject({ publication: 'hidden', reviewState: 'approved' });
    expect(await t.catalog.isPurchasable(id)).toBe(false);
    expect((await a.store(`/products/${id}`)).statusCode).toBe(404);
    expect((await a.admin('POST', `/products/${id}/publication`, { publication: 'hidden', reason: 'again' })).statusCode).toBe(409);
    await a.admin('POST', `/products/${id}/publication`, { publication: 'suspended', reason: 'Safety review' });
    const back = await a.admin('POST', `/products/${id}/publication`, { publication: 'active', reason: 'Cleared' });
    expect(back.statusCode, back.body).toBe(200); // no trust report: no second reviewer needed
    expect(t.stubs.access.check).not.toHaveBeenCalled();
    expect(t.eventsNamed('catalog.product.publication_changed').map((e) => e.payload)).toEqual([
      { productId: id, from: 'active', to: 'hidden', reason: 'Recall check', trustReportId: null, trustEnforcementId: null },
      { productId: id, from: 'hidden', to: 'suspended', reason: 'Safety review', trustReportId: null, trustEnforcementId: null },
      { productId: id, from: 'suspended', to: 'active', reason: 'Cleared', trustReportId: null, trustEnforcementId: null },
    ]);
    expect(back.json().reviewLog.filter((l: { action: string }) => l.action === 'publication_changed')).toHaveLength(3);
    expect(t.stubs.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'catalog.product.hide', reason: 'Recall check', visibleToSeller: true }));
  });

  it('impact preview: offers that stop showing, their sellers, carts and open orders; disabled modules are null', async () => {
    const sellerId = newId();
    const { id } = await sellerProduct(t, sellerId, { brandId, categoryId: cat.id, approve: true });
    const variantId = (await t.catalog.getProduct(id))!.variants[0]!.id;
    const o1 = await offer(id, variantId, sellerId);
    const o2 = await offer(id, variantId, null);
    // offers is the source of which offers are active now
    const summary = (offerId: string, ownerType: string) => ({ id: offerId, productId: id, variantId, productTitle: 'x', variantLabel: 'Black', ownerType, condition: 'new', sellerSku: 'S', price: { amount: 100, currency: 'USD' }, status: 'active', featured: false, featuredEligible: true });
    t.stubs.offers.listActiveOffersForProduct.mockResolvedValueOnce([summary(o1, 'seller'), summary(o2, 'official')] as never);
    const res = await a.admin('GET', `/products/${id}/publication-impact?publication=suspended`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      productId: id,
      from: 'active',
      to: 'suspended',
      activeOffers: 2,
      cartsAffected: 4,
      openOrders: 3,
      openReturns: null,
      openCases: null,
      approvalNeeded: false,
      sellersAffected: expect.arrayContaining([{ sellerId, name: 'Gadget Grove', offers: 1 }, { sellerId: null, name: 'Marketly Official Store', offers: 1 }]),
    });
    expect(res.json().effects).toEqual(expect.arrayContaining(['2 offers stop showing', '3 open orders continue with their purchase snapshots']));
  });

  it('trust enforcement suspends; reactivating needs a second reviewer (APPROVAL_REQUIRED, reactivated when approved)', async () => {
    const { id } = await sellerProduct(t, newId(), { brandId, categoryId: cat.id, approve: true });
    const reportId = newId();
    const enforcement = { enforcementId: newId(), reportId, action: 'suspend_product', ownerTeam: 'catalog', targets: [{ type: 'product', id, label: 'x' }, { type: 'product', id: newId(), label: 'unknown' }], reason: 'Counterfeit confirmed', params: {}, alreadyApplied: false };
    t.app.kernel.events.publish('trust', 'trust.enforcement.recorded', enforcement);
    t.app.kernel.events.publish('trust', 'trust.enforcement.recorded', enforcement); // twice: no second change
    t.app.kernel.events.publish('trust', 'trust.enforcement.recorded', { ...enforcement, enforcementId: newId(), alreadyApplied: true });
    await t.app.kernel.events.drain();
    const changes = t.eventsNamed('catalog.product.publication_changed');
    expect(changes.map((e) => e.payload)).toEqual([
      { productId: id, from: 'active', to: 'suspended', reason: 'Trust and Risk enforcement: Counterfeit confirmed', trustReportId: reportId, trustEnforcementId: enforcement.enforcementId },
    ]);
    expect(changes[0]!.actor).toEqual({ kind: 'system' });

    expect((await a.admin('GET', `/products/${id}/publication-impact?publication=active`)).json().approvalNeeded).toBe(true);
    const first = await a.admin('POST', `/products/${id}/publication`, { publication: 'active', reason: 'Seller proved authenticity' });
    expect(first.statusCode).toBe(409);
    expect(first.json().error.code).toBe('APPROVAL_REQUIRED');
    expect(first.json().error.details.approvalRequestId).toEqual(expect.any(String));
    expect(t.stubs.access.check).toHaveBeenCalledWith(expect.objectContaining({ kind: 'staff' }), 'catalog.products.publication-override');
    expect(t.stubs.access.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ action: 'catalog.products.publication-override', target: expect.objectContaining({ type: 'product', id }) }));

    // denied outright
    t.stubs.access.check.mockResolvedValueOnce({ decision: 'denied', action: 'x', reason: 'Your role can recommend only', requiresSecondReviewer: true, approvalsNeeded: 1, eligibleApproverRoles: [], eligibleApprovers: [] });
    expect((await a.admin('POST', `/products/${id}/publication`, { publication: 'active', reason: 'try' })).statusCode).toBe(403);

    // rejected: the pending override is dropped, the product stays suspended
    const requesterId = newId();
    const decided = (requestId: string, outcome: 'approved' | 'rejected') => ({
      requestId,
      ref: 'AP-261009-0001',
      actionKey: 'catalog.products.publication-override',
      module: 'catalog',
      target: { type: 'product', id, label: 'x' },
      outcome,
      decidedBy: { kind: 'staff' as const, id: newId(), name: 'Mara Ellis' },
      approverIds: [],
      requestedById: requesterId,
    });
    t.app.kernel.events.publish('access', 'access.approval.decided', decided(first.json().error.details.approvalRequestId, 'rejected'));
    await t.app.kernel.events.drain();
    expect((await a.admin('GET', `/products/${id}`)).json().publication).toBe('suspended');

    // approved by the second reviewer: catalog reactivates it, once (the event delivered twice)
    const approvalId = newId();
    // both deliveries may run at once (each asks for the approval), so the stub answers every call for it
    const approval = { id: approvalId, reason: 'Seller proved authenticity', requestedBy: { kind: 'staff', id: requesterId, name: 'Riley Chen' } };
    t.stubs.access.getApproval.mockImplementation(async (id: string) => (id === approvalId ? approval : null) as never);
    t.stubs.audit.record.mockClear();
    t.app.kernel.events.publish('access', 'access.approval.decided', decided(approvalId, 'approved'));
    t.app.kernel.events.publish('access', 'access.approval.decided', decided(approvalId, 'approved'));
    await t.app.kernel.events.drain();
    expect((await a.admin('GET', `/products/${id}`)).json().publication).toBe('active');
    const reactivated = t.eventsNamed('catalog.product.publication_changed').filter((e) => (e.payload as { to: string }).to === 'active');
    expect(reactivated.map((e) => e.payload)).toEqual([{ productId: id, from: 'suspended', to: 'active', reason: 'Seller proved authenticity', trustReportId: null, trustEnforcementId: null }]);
    expect(reactivated[0]!.actor).toEqual({ kind: 'staff', id: requesterId, name: 'Riley Chen' });
    const audits = t.stubs.audit.record.mock.calls.map((c) => c[0]).filter((e) => e.action === 'catalog.product.activate');
    expect(audits).toEqual([expect.objectContaining({ approvalRequestId: approvalId, approvalNote: 'Second reviewer approved the reactivation' })]);
  });
});
