/**
 * Tranche 2 wired to tranche 1, with no stubs and no development tokens:
 *
 *   staff with real roles (Business Owner → Seller Manager, Catalog Manager)
 *   → a customer registers; customers creates their record from identity's event and keeps it private
 *   → the customer applies to sell (documents uploaded through media), the Seller Manager approves
 *   → the new owner signs in to Seller Center with a seller token identity issues, and the middleware
 *     checks the membership through sellers
 *   → the seller drafts a catalog product with an uploaded image, which the Catalog Manager sees.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withDependencies } from '../kernel/module-system/loader.js';
import { pdf, png } from '../modules/media/test/helpers.js';
import { buildTestApp, movingClock } from '../testing/app.js';
import { flows, type Flows, type Staff } from '../testing/flows.js';

const clock = movingClock();
let app: FastifyInstance;
let f: Flows;
let owner: Staff;
let sellerManager: Staff;
let catalogManager: Staff;
let categoryId: string;

beforeAll(async () => {
  app = await buildTestApp({
    only: withDependencies(['identity', 'access', 'audit', 'media', 'notifications', 'settings', 'customers', 'sellers', 'catalog', 'inventory', 'purchasing', 'workqueues']),
    clock,
    config: { rateLimits: false },
  });
  f = flows(app, clock);
  owner = await f.bootstrapOwner();
  sellerManager = await f.staffWithRoles(owner, 'sam@marketly.test', 'Sam Sellers', ['seller_manager']);
  catalogManager = await f.staffWithRoles(owner, 'cat@marketly.test', 'Cara Catalog', ['catalog_manager']);
  const category = await f.call('POST', '/api/admin/catalog/categories', { token: catalogManager.accessToken, body: { name: 'Headphones', parentId: null } });
  expect(category.status, JSON.stringify(category.body)).toBe(201);
  categoryId = category.body.id;
});
afterAll(async () => {
  await app?.close();
});

/** The client's side of an upload: start, PUT the bytes to the signed storage URL, complete, process */
async function upload(area: 'store' | 'seller', token: string, file: { purpose: string; fileName: string; contentType: string; body: Buffer }) {
  const start = await f.call('POST', `/api/${area}/media/uploads`, { token, body: { purpose: file.purpose, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.body.length } });
  expect(start.status, JSON.stringify(start.body)).toBe(201);
  // stands in for the browser's PUT to object storage (the dev storage adapter checks the signature)
  const storage = (app.kernel.boot.apis.get('media') as any).providers.storage;
  await storage.acceptSignedPut(start.body.url, file.body, start.body.headers['content-type']);
  const done = await f.call('POST', `/api/${area}/media/uploads/${start.body.uploadId}/complete`, { token });
  expect(done.status, JSON.stringify(done.body)).toBe(202);
  await app.kernel.jobs.runNow('media.process');
  await app.kernel.events.drain();
  return start.body.assetId as string;
}

const address = { name: 'Ana Lopez', line1: '410 Pine St', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US', phone: '+15035550101' };

describe('the marketplace, end to end', () => {
  let ana: Awaited<ReturnType<Flows['customer']>>;
  let sellerId: string;
  let sellerToken: string;

  it('creates the customer record from identity and keeps it private', async () => {
    ana = await f.customer('ana@example.com');
    const profile = await f.call('GET', '/api/store/customers/profile', { token: ana.accessToken });
    expect(profile.status, JSON.stringify(profile.body)).toBe(200);
    const saved = await f.call('POST', '/api/store/customers/addresses', { token: ana.accessToken, body: { label: 'Home', address } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);

    const ben = await f.customer('ben@example.com');
    expect((await f.call('GET', '/api/store/customers/addresses', { token: ben.accessToken })).body).toEqual([]);
    const theirs = await f.call('PATCH', `/api/store/customers/addresses/${saved.body.id}`, { token: ben.accessToken, body: { label: 'Mine now', address } });
    expect(theirs.status).toBe(404); // another customer's record does not exist for Ben
  });

  it('takes a seller application from the customer to approval by the Seller Manager', async () => {
    const STORE = '/api/store/sellers';
    const t = ana.accessToken;
    const storeName = 'Northwind Audio';
    // applications are invite-only: the Seller Manager invites Northwind
    const invited = await f.call('POST', '/api/admin/sellers/seller-invitations', { token: sellerManager.accessToken, body: { email: 'ana@northwind.example.com', businessName: 'Northwind Audio LLC' } });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    // the emailed code (spec gap: the code is in no event or response yet, so read it as the email would carry it)
    const invitationCode = (app.kernel.boot.apis.get('sellers') as any).applications.invitationCode(invited.body.id) as string;
    const start = await f.call('POST', `${STORE}/applications`, {
      token: t,
      body: { accountMode: 'existing_member', contactName: 'Ana Lopez', contactPhone: '+15035550101', workEmail: 'ana@northwind.example.com', storeName, sellerType: 'business', market: 'US', invitationCode },
    });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const id = start.body.id as string;
    const patch = async (body: object) => {
      const r = await f.call('PATCH', `${STORE}/applications/${id}`, { token: t, body });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body;
    };
    await patch({
      step: 'business',
      business: {
        kind: 'registered_business',
        legalName: 'Northwind Audio LLC',
        storeName,
        businessType: 'llc',
        stateOfRegistration: 'OR',
        registryNumber: 'OR-123456',
        address: { name: 'Northwind Audio LLC', line1: '410 Pine St', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US' },
        phone: '+15035550100',
        website: 'https://northwind.example.com',
        categoryIds: [categoryId],
        plannedProductCount: '21_100',
        plannedProducts: 'headphones, speakers',
        supportHours: 'Mon–Fri 9–5',
      },
    });
    const v = await patch({ step: 'verification', verification: { owners: [{ name: 'Ana Lopez', ownershipPct: 100, isPrimary: true, idDocumentIds: [] }], taxIdType: 'ein', taxId: '12-3456789', w9Method: 'online' } });
    const ownerId = v.verification.owners[0].id;
    for (const [kind, extra] of [['owner_id', { ownerId }], ['business_registration', {}]] as const) {
      const mediaId = await upload('store', t, { purpose: 'verification_document', fileName: `${kind}.pdf`, contentType: 'application/pdf', body: pdf(1) });
      const d = await f.call('POST', `${STORE}/applications/${id}/documents`, { token: t, body: { mediaId, kind, ...extra } });
      expect(d.status, JSON.stringify(d.body)).toBe(201);
    }
    const account = '000123457731';
    await patch({ step: 'payout', payout: { accountHolderName: 'Northwind Audio LLC', accountType: 'business_checking', routingNumber: '011000015', accountNumber: account, confirmAccountNumber: account } });
    await patch({ step: 'return_address', returnAddress: { sameAsBusiness: true, contactName: 'Ana Lopez', phone: '+15035550101' } });
    const draft = (await f.call('GET', `${STORE}/applications/current`, { token: t })).body;
    const acceptances = draft.agreementsRequired.map((a: { key: string; versionLabel: string }) => ({ key: a.key, versionLabel: a.versionLabel }));
    const submitted = await f.call('POST', `${STORE}/applications/${id}/submit`, { token: t, body: { acceptances, signedName: 'Ana Lopez' } });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    sellerId = submitted.body.sellerId;

    const ADMIN = '/api/admin/sellers';
    // the Business Owner can look but not decide
    const byOwner = await f.call('POST', `${ADMIN}/applications/${id}/start-review`, { token: owner.accessToken });
    expect(byOwner.status).toBe(403);
    expect((await f.call('POST', `${ADMIN}/applications/${id}/start-review`, { token: sellerManager.accessToken })).status).toBe(200);
    const approved = await f.call('POST', `${ADMIN}/applications/${id}/approve`, { token: sellerManager.accessToken, body: { note: 'Welcome' } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  });

  it('signs the new owner in to Seller Center; the middleware checks membership through sellers', async () => {
    const signedIn = await f.signIn({ email: ana.email, password: ana.password, audience: 'seller', sellerId });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    expect(signedIn.body.status).toBe('signed_in');
    sellerToken = signedIn.body.tokens.accessToken;
    const setup = await f.call('GET', '/api/seller/sellers/setup', { token: sellerToken });
    expect(setup.status, JSON.stringify(setup.body)).toBe(200);
    // her customer token is not a Seller Center token
    expect((await f.call('GET', '/api/seller/sellers/setup', { token: ana.accessToken })).body.error.code).toBe('WRONG_AUDIENCE');
  });

  it('lets the seller draft a product in a category the Catalog Manager created, which staff see through their catalog role', async () => {
    const imageId = await upload('seller', sellerToken, { purpose: 'product_image', fileName: 'front.png', contentType: 'image/png', body: png(1600, 1600) });
    const created = await f.call('POST', '/api/seller/catalog/products', {
      token: sellerToken,
      body: {
        title: 'Aurora wireless headphones',
        requestedBrand: { name: 'Aurora Sound', note: 'Authorized reseller' },
        categoryId,
        description: 'Over-ear headphones with active noise cancelling and a 40 hour battery that charges over USB-C.',
        keyFeatures: ['Active noise cancelling', '40 h battery', 'USB-C charging'],
        specs: { 'Battery life': '40 h' },
        includedItems: ['Headphones', 'USB-C cable'],
        imageIds: [imageId],
        modelNumber: 'AU-100',
        variants: [{ options: { Color: 'Black' }, gtin: '4006381333931' }],
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const productId = created.body.product.id as string;
    expect(created.body).toMatchObject({ owner: 'seller', ownerSellerId: sellerId, reviewState: 'draft' });
    const mine = await f.call('GET', '/api/seller/catalog/products', { token: sellerToken });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(JSON.stringify(mine.body)).toContain(productId);
    // staff see it through the admin area with their catalog role; the Seller Manager's role doesn't reach catalog editing
    const staffView = await f.call('GET', `/api/admin/catalog/products/${productId}`, { token: catalogManager.accessToken });
    expect(staffView.status, JSON.stringify(staffView.body)).toBe(200);
  });
});
