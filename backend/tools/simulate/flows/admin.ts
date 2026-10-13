/**
 * Flow 8, what the Admin Center reads: the order 360, the customer 360, the seller 360, the dashboards and
 * reports. Flow 9 opens every app screen that has a persisted GraphQL query (store, Seller Center, Admin Center),
 * the way the apps load them; each screen is its own step, so one broken screen does not hide the others.
 */
import type { Session } from '../http.js';
import type { Sim } from '../sim.js';

export async function adminReadsFlow(sim: Sim): Promise<void> {
  const { api, run, world: w } = sim;
  const om = w.staff.orders!.session;
  const o = w.orders.find((x) => x.delivered) ?? w.orders[0]!;
  // order 360: REST and the screen's GraphQL query
  const order = await api.call(om, 'GET', `/api/admin/orders/orders/${o.orderId}`);
  run.check('order 360 shows the order', order.order?.ref === o.ref, order.order?.ref);
  await api.call(om, 'GET', `/api/admin/orders/orders/${o.orderId}/history`);
  const list = await api.call(om, 'GET', `/api/admin/orders/orders?q=${encodeURIComponent(o.ref)}`);
  run.check('order search finds it', JSON.stringify(list.items).includes(o.orderId), undefined);

  // customer 360 (support agent's view)
  const agent = w.staff.support!.session;
  const c = o.customer ?? w.customers[0]!;
  // the agent finds the customer by email (the customer record has its own id, not the account id)
  const found = await api.call(agent, 'GET', `/api/admin/customers/customers?q=${encodeURIComponent(c.person.email)}`);
  const row = (found.items as { id: string; email: string }[]).find((x) => x.email.toLowerCase() === c.person.email);
  run.check('the customer list finds the customer by email', Boolean(row), found.items);
  const customer = await api.call(agent, 'GET', `/api/admin/customers/customers/${row!.id}`);
  run.check('customer 360 shows the customer', JSON.stringify(customer).includes(c.person.lastName), undefined);

  // seller 360 and the seller's own dashboard
  const s = w.sellers[0]!;
  const sm = w.staff.seller!.session;
  await api.call(sm, 'GET', `/api/admin/sellers/sellers/${s.sellerId}`);
  await api.call(s.session, 'GET', '/api/seller/reports/dashboard');

  // dashboards and reports the Business Owner opens
  const owner = w.owner!.session;
  await api.call(owner, 'GET', '/api/admin/reports/dashboard');
  await api.call(owner, 'GET', '/api/admin/reports/catalogue');
  const audit = await api.call(owner, 'GET', '/api/admin/audit/entries?limit=100');
  run.check('the action history has entries', (audit.items as unknown[]).length > 0, undefined);
  await api.call(w.staff.operations!.session, 'GET', '/api/admin/warehouse/summary');
  await api.call(w.staff.operations!.session, 'GET', '/api/admin/inventory/summary');

  // the order 360 screen loads through its GraphQL query (last: a failure here does not hide the REST reads above)
  const g = await api.graphql(om, 'AdminOrder', { ref: o.ref });
  run.check('AdminOrder answers the order', g.orderAdmin?.ref === o.ref, g.orderAdmin?.ref);
}

/** Every persisted screen query, with the variables its screen passes */
export async function screensFlow(sim: Sim): Promise<void> {
  const { api, run, world: w } = sim;
  const o = w.orders.find((x) => x.delivered && x.customer) ?? w.orders.find((x) => x.customer)!;
  const c = o.customer!;
  const offer = w.sellers[0]!.offers[0]!;
  const seller = w.sellers.find((s) => o.groups.some((g) => g.sellerId === s.sellerId)) ?? w.sellers[0]!;
  const visitor = await sim.people.visitor('store', 'android', 'visitor (screens)');
  const categories = (await api.call(visitor, 'GET', '/api/store/catalog/categories')) as { slug: string }[];
  const offerView = await api.call(visitor, 'GET', `/api/store/offers/offers/${seller.offers[0]!.offerId}`);
  const myReturns = await api.call(c.session, 'GET', '/api/store/returns/requests?limit=5');
  const myCases = await api.call(c.session, 'GET', '/api/store/support/cases?limit=5');
  const sellerReturns = await api.call(seller.session, 'GET', '/api/seller/returns/requests?limit=5');
  const statements = await api.call(seller.session, 'GET', '/api/seller/finance/statements?limit=5');
  const runs = await api.call(w.staff.finance!.session, 'GET', '/api/admin/finance/payout-runs?limit=5');
  const customerRow = (await api.call(w.staff.support!.session, 'GET', `/api/admin/customers/customers?q=${encodeURIComponent(c.person.email)}`)).items[0];
  const screens: [string, Session, Record<string, unknown>][] = [
    ['HomePage', visitor, { postalCode: '97205' }],
    ['SearchResults', visitor, { query: offer.title.split(' ').slice(0, 2).join(' '), postalCode: '97205' }],
    ['CategoryPage', visitor, { slug: categories[0]?.slug ?? 'electronics', postalCode: '97205' }],
    ['ProductPage', visitor, { id: offer.productId, postalCode: '97205' }],
    ['OffersPage', visitor, { id: offer.productId, postalCode: '97205' }],
    ['SellerStorefront', visitor, { slug: offerView.seller?.slug }],
    ['CartPage', c.session, { postalCode: '97205' }],
    ['AccountOverview', c.session, {}],
    ['OrderList', c.session, {}],
    ['OrderDetail', c.session, { ref: o.ref }],
    ...((myReturns.items?.[0] ? [['ReturnDetail', c.session, { ref: myReturns.items[0].ref }]] : []) as [string, Session, Record<string, unknown>][]),
    ...((myCases.items?.[0] ? [['CaseDetail', c.session, { ref: myCases.items[0].ref }]] : []) as [string, Session, Record<string, unknown>][]),
    ['SellerDashboard', seller.session, {}],
    ['SellerFinanceOverview', seller.session, {}],
    ['SellerOrderDetail', seller.session, { ref: o.ref }],
    ['SellerPerformance', seller.session, {}],
    ['SellerProductDetail', seller.session, { id: seller.offers[0]!.productId }],
    ...((sellerReturns.items?.[0] ? [['SellerReturnDetail', seller.session, { ref: sellerReturns.items[0].ref }]] : []) as [string, Session, Record<string, unknown>][]),
    ...((statements.items?.[0] ? [['SellerStatement', seller.session, { ref: statements.items[0].ref }]] : []) as [string, Session, Record<string, unknown>][]),
    ['AdminDashboard', w.owner!.session, {}],
    ['AdminOrder', w.staff.orders!.session, { ref: o.ref }],
    ['AdminCustomer', w.staff.support!.session, { id: customerRow?.id }],
    ['AdminSeller', w.staff.seller!.session, { id: seller.sellerId }],
    ['AdminProductReview', w.staff.catalog!.session, { productId: offer.productId }],
    ...((runs.items?.[0] ? [['AdminPayoutRun', w.staff.finance!.session, { ref: runs.items[0].ref }]] : []) as [string, Session, Record<string, unknown>][]),
    ['OpsQueues', w.staff.operations!.session, {}],
  ];
  for (const [name, session, variables] of screens) await run.attempt(`screen ${name}`, () => api.graphql(session, name, variables));
}
