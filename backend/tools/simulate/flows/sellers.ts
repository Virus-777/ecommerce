/**
 * Flow 2, sellers: the Catalog Manager keeps the category tree; the Seller Manager invites each business; the
 * owner (a store customer) applies with documents, payout account and return address; the Seller Manager reviews
 * and approves; the owner signs in to Seller Center, confirms the payout test deposits and sets up shipping.
 * The launch review comes in the catalog flow, after the first product submission (sellers' rule).
 */
import { createDevPayoutProvider } from '../../../src/modules/finance/providers/payouts.js';
import { BUSINESS_ADDRESSES, CATEGORIES, STORES } from '../data.js';
import type { Sim, SellerWorld } from '../sim.js';

const usd = (amount: number) => ({ amount, currency: 'USD' });

/** The category tree: reused when it exists (categories are shared by every run), created when missing */
export async function ensureCategories(sim: Sim): Promise<void> {
  const { api, world: w } = sim;
  const cm = w.staff.catalog!.session;
  type Node = { id: string; name: string; parentId: string | null; children?: Node[] };
  // the admin answer is a tree: walk it (the first category of a name under its parent, as the store shows it)
  const flat = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
  const existing = flat(await api.call(cm, 'GET', '/api/admin/catalog/categories'));
  for (const top of CATEGORIES) {
    let parent = existing.find((c) => c.name === top.name && !c.parentId);
    if (!parent) parent = await api.call(cm, 'POST', '/api/admin/catalog/categories', { name: top.name, parentId: null });
    w.categories.set(top.name, parent!.id);
    for (const child of top.children) {
      let c = existing.find((x) => x.name === child && x.parentId === parent!.id);
      if (!c) c = await api.call(cm, 'POST', '/api/admin/catalog/categories', { name: child, parentId: parent!.id });
      w.categories.set(child, c!.id);
    }
  }
}

export async function sellersFlow(sim: Sim): Promise<void> {
  const { run } = sim;
  await ensureCategories(sim);
  const count = sim.n(3);
  for (let i = 0; i < count; i++) {
    const store = STORES[i % STORES.length]!;
    const name = `${store.name} ${sim.runId.toUpperCase()}${i >= STORES.length ? `-${Math.floor(i / STORES.length) + 1}` : ''}`;
    await run.attempt(`seller ${name}`, () => onboard(sim, store.code, name, store.products.map((p) => p.category), i));
  }
  run.check('every seller was onboarded', sim.world.sellers.length === count, sim.world.sellers.map((s) => s.name));
}

async function onboard(sim: Sim, code: string, storeName: string, categories: string[], index: number): Promise<void> {
  const { api, people, world: w, run } = sim;
  const sm = w.staff.seller!.session;
  const owner = sim.person();
  const contactName = `${owner.firstName} ${owner.lastName}`;
  // the owner is a store customer first (applications are made from a signed-in account)
  const customer = await people.registerCustomer(owner, index % 2 ? 'android' : 'web', false);

  // applications are invite-only at launch: the Seller Manager invites the business, which gets a code by email
  const slug = storeName.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const workEmail = `${owner.firstName.toLowerCase()}@${slug}.example.com`;
  const legalName = `${storeName} LLC`;
  await api.call(sm, 'POST', '/api/admin/sellers/seller-invitations', { email: workEmail, businessName: legalName, message: 'We would love to have you on Marketly.' });
  const invitationCode = await people.fromMailbox(workEmail, /\b([A-F0-9]{12})\b/, 'the seller invitation code');

  const STORE = '/api/store/sellers';
  const app = await api.call(customer, 'POST', `${STORE}/applications`, { accountMode: 'existing_member', contactName, contactPhone: owner.phone, workEmail, storeName, sellerType: 'business', market: 'US', invitationCode });
  const id = app.id as string;
  const patch = (body: object) => api.call(customer, 'PATCH', `${STORE}/applications/${id}`, body);
  const biz = BUSINESS_ADDRESSES[index % BUSINESS_ADDRESSES.length]!;
  const address = { name: legalName, line1: biz.line1, city: biz.city, region: 'OR', postalCode: biz.postalCode, country: 'US' };
  const categoryIds = [...new Set(categories.map((c) => w.categories.get(c)!))];
  await patch({
    step: 'business',
    business: {
      kind: 'registered_business',
      legalName,
      storeName,
      businessType: 'llc',
      stateOfRegistration: 'OR',
      registryNumber: `OR-${sim.int(1000000, 9999999)}`,
      address,
      phone: owner.phone,
      website: `https://${slug}.example.com`,
      categoryIds,
      plannedProductCount: '21_100',
      plannedProducts: 'What we make and sell in our Portland shop',
      shippingPlan: 'We ship from our own shop with UPS, same day before noon',
      supportHours: 'Mon–Fri 9–5 Pacific',
    },
  });
  const v = await patch({ step: 'verification', verification: { owners: [{ name: contactName, ownershipPct: 100, isPrimary: true, idDocumentIds: [] }], taxIdType: 'ein', taxId: `93-${sim.int(1000000, 9999999)}`, w9Method: 'online' } });
  const ownerId = v.verification.owners[0].id as string;
  for (const [kind, extra] of [['owner_id', { ownerId }], ['business_registration', {}]] as const) {
    const mediaId = await sim.upload(customer, 'store', { purpose: 'verification_document', fileName: `${kind}.pdf`, contentType: 'application/pdf', body: sim.pdf(`${storeName} ${kind}`) });
    await api.call(customer, 'POST', `${STORE}/applications/${id}/documents`, { mediaId, kind, ...extra });
  }
  const account = String(sim.int(100000000, 999999999)) + String(sim.int(100, 999));
  const payout = await patch({ step: 'payout', payout: { accountHolderName: legalName, accountType: 'business_checking', routingNumber: '123000220', accountNumber: account, confirmAccountNumber: account } });
  await patch({ step: 'return_address', returnAddress: { sameAsBusiness: true, contactName, phone: owner.phone } });
  const draft = await api.call(customer, 'GET', `${STORE}/applications/current`);
  run.check('nothing missing before submitting', Object.keys(draft.missing ?? {}).length === 0, { missing: draft.missing, percent: draft.percentComplete });
  const acceptances = draft.agreementsRequired.map((a: { key: string; versionLabel: string }) => ({ key: a.key, versionLabel: a.versionLabel }));
  const submitted = await api.call(customer, 'POST', `${STORE}/applications/${id}/submit`, { acceptances, signedName: contactName });
  const sellerId = submitted.sellerId as string;
  run.check('submitted application names its seller', Boolean(sellerId), submitted);

  // the Seller Manager reviews and approves
  const ADMIN = '/api/admin/sellers';
  await api.call(sm, 'POST', `${ADMIN}/applications/${id}/start-review`);
  await api.call(sm, 'POST', `${ADMIN}/applications/${id}/approve`, { note: 'Documents check out. Welcome to Marketly!' });

  // the owner signs in to Seller Center for the new seller
  const seller = await people.signIn(owner, 'seller', 'web', sellerId);
  seller.label = `seller ${storeName}`;
  const setup = await api.call(seller, 'GET', '/api/seller/sellers/setup');
  run.check('Seller Center shows the setup checklist', setup !== null, setup);

  // payout account: the bank shows two small test deposits; the owner types them in. The amounts are what the
  // development payout provider sends to this account (out of band: a person reads them on the bank statement)
  const destination = await api.call(seller, 'GET', '/api/seller/finance/payout-destination');
  const providerDestinationId = (payout.payout?.providerDestinationId ?? submitted.payout?.providerDestinationId) as string | undefined;
  run.check('the payout account waits for the test deposits', destination.destination?.status === 'verification_pending' && Boolean(providerDestinationId), { destination, providerDestinationId });
  const [a, b] = createDevPayoutProvider({ now: () => new Date() }).testDepositsFor(providerDestinationId!);
  const confirmed = await api.call(seller, 'POST', '/api/seller/finance/payout-destination/confirm-deposits', { amounts: [usd(a), usd(b)] });
  run.check('payout account verified', confirmed.destination?.status === 'verified', confirmed);

  // shipping: where and when the seller ships, and a default profile (standard by weight, expedited flat)
  await api.call(seller, 'PUT', '/api/seller/shipping/settings', {
    coverage: { area: 'contiguous_48_dc', zoneIds: [], excluded: ['po_box'] },
    dispatch: { handlingDays: 1, sameDayCutoff: '12:00', businessDays: ['mon', 'tue', 'wed', 'thu', 'fri'] },
    buyLabelsInSellerCenter: true,
    shipsFrom: 'Portland, OR',
    effectiveFrom: null,
  });
  const methods = (await api.call(seller, 'GET', '/api/seller/shipping/methods')) as { id: string; code: string }[];
  const method = (c: string) => methods.find((m) => m.code === c)?.id;
  const profile = await api.call(seller, 'POST', '/api/seller/shipping/profiles', {
    name: 'Standard Portland shipping',
    isDefault: true,
    methods: [
      { methodId: method('standard'), enabled: true, rateType: 'by_weight', tiers: [{ upToGrams: 2000, price: usd(599) }, { upToGrams: 20000, price: usd(1299) }], maxWeightGrams: 20000 },
      { methodId: method('expedited'), enabled: true, rateType: 'flat_per_package', tiers: [{ price: usd(1499) }] },
    ],
    freeShippingThreshold: usd(7500),
    freeShippingMethodCode: 'standard',
    effectiveFrom: null,
  });
  const sw: SellerWorld = { name: storeName, code: `${code}${index}`, owner, ownerCustomer: customer, sellerId, session: seller, shippingProfileId: (profile.id ?? profile.profile?.id) as string, categoryIds, offers: [] };
  w.sellers.push(sw);
}
