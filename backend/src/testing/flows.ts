/**
 * Real end-to-end flows for integration tests: nothing stubbed, no development tokens. Identity issues
 * every token; access, sellers and customers answer the middleware.
 */
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import type { EventEnvelope } from '../kernel/events/index.js';
import type { AccessService } from '../modules/access/service.js';
import { auth } from './app.js';
import { totp } from './totp.js';

export interface Flows {
  app: FastifyInstance;
  call(method: string, url: string, o?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any }>;
  /** Payloads of an event published so far */
  events(name: string): any[];
  device(): { kind: 'android'; name: string; appVersion: string; installationId: string };
  visitor(audience?: 'store' | 'seller' | 'admin'): Promise<string>;
  /** First Business Owner (also Platform Administrator) through the bootstrap, signed in */
  bootstrapOwner(email?: string, name?: string): Promise<Staff>;
  /** Accepts the emailed staff invitation (password + authenticator) and returns the real admin session */
  acceptStaffInvitation(email: string): Promise<Staff>;
  /** Invites a staff member with roles (the inviter confirms with an authenticator code) and signs them in */
  staffWithRoles(inviter: Staff, email: string, name: string, roleKeys: string[]): Promise<Staff>;
  /** A fresh authenticator code for a staff member (each code works once) */
  code(s: Staff): string;
  /** Registers and confirms a customer; returns the store session */
  customer(email: string): Promise<{ accountId: string; accessToken: string; email: string; password: string }>;
  /** Password sign-in to an app (seller: optionally for a seller) */
  signIn(body: { email: string; password: string; audience: 'store' | 'seller' | 'admin'; sellerId?: string }): Promise<{ status: number; body: any }>;
  /** The client's side of an upload: start, PUT the bytes to the signed storage URL, complete, process. Returns the asset id. */
  upload(area: 'store' | 'seller', token: string, file: { purpose: string; fileName: string; contentType: string; body: Buffer }): Promise<string>;
  /**
   * A customer applies to sell (invited by the Seller Manager), is approved and signs in to Seller
   * Center. Returns the seller id and the real seller session.
   */
  approvedSeller(o: { applicant: { email: string; password: string; accessToken: string }; sellerManager: Staff; categoryId: string; storeName: string }): Promise<{ sellerId: string; sellerToken: string }>;
  /** The seller passes the launch review (after its first product submission), so it may sell */
  passLaunchReview(o: { sellerId: string; sellerToken: string; sellerManager: Staff }): Promise<void>;
  /**
   * The whole way to a live listing: staff with roles (Business Owner → Seller Manager, Catalog Manager),
   * a category and brand, a customer approved as a seller, a product the Catalog Manager approves, the
   * launch review, and an active offer with stock. For tests that start where shopping starts.
   */
  liveListing(o?: { price?: number; quantity?: number }): Promise<Listing>;
  /** The seller's shipping settings and a default profile (standard by weight, expedited flat); returns the profile id */
  shippingProfile(sellerToken: string): Promise<string>;
}

export interface Listing {
  owner: Staff;
  sellerManager: Staff;
  catalogManager: Staff;
  sellerId: string;
  sellerToken: string;
  /** The seller's owner account (a customer who applied to sell) */
  sellerOwner: { email: string; password: string; accessToken: string; accountId: string };
  categoryId: string;
  productId: string;
  variantId: string;
  offerId: string;
}

export interface Staff {
  accountId: string;
  key: string;
  accessToken: string;
}

const PASSWORD = 'Blue-Orchid-2026-Key';

/** A PNG header of the given size (what the dev media processor reads), for product images */
export function pngHeader(width: number, height: number): Buffer {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])]);
  const chunk = (type: string, data: Buffer) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.alloc(64, 7)), chunk('IEND', Buffer.alloc(0))]);
}

/** A one-page PDF (verification documents) */
export const onePagePdf = () =>
  Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF\n', 'latin1');

export function flows(app: FastifyInstance, clock: { now(): Date; advance(ms: number): void }): Flows {
  const seen: EventEnvelope[] = [];
  for (const name of ['identity.invitation.created', 'identity.verification.code_issued', 'identity.user.registered']) {
    app.kernel.events.subscribe('flows', name, (e) => void seen.push(e));
  }
  const call: Flows['call'] = async (method, url, o = {}) => {
    const res = await app.inject({ method: method as never, url, headers: { ...(o.token ? auth(o.token) : {}), ...o.headers }, ...(o.body !== undefined ? { payload: o.body as never } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const events = (name: string) => seen.filter((e) => e.name === name).map((e) => e.payload as any);
  const device = () => ({ kind: 'android' as const, name: 'Pixel 8', appVersion: '1.4.2', installationId: `inst-${Math.random().toString(36).slice(2)}` });
  const visitor = async (audience: 'store' | 'seller' | 'admin' = 'store') => {
    const v = await call('POST', '/api/public/identity/app-sessions', { headers: { 'x-app-proof': 'dev' }, body: { audience, device: device() } });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    return v.body.accessToken as string;
  };
  const code = (s: Staff) => {
    const c = totp(s.key, clock.now());
    clock.advance(30_000); // one code per 30-second step
    return c;
  };

  const self: Flows = {
    app,
    call,
    events,
    device,
    visitor,
    code,
    async acceptStaffInvitation(email) {
      const created = events('identity.invitation.created').findLast((p) => p.email === email);
      expect(created, `invitation for ${email}`).toBeDefined();
      const token = new URL(created.acceptUrl).hash.replace('#token=', '');
      const v = await visitor('admin');
      const d = device();
      const accepted = await call('POST', '/api/public/identity/invitations/accept', { token: v, body: { token, password: PASSWORD, device: d } });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      const key = accepted.body.twoStepSetup.manualEntryKey as string;
      const confirmed = await call('POST', '/api/public/identity/invitations/two-step', { token: v, body: { token, setupId: accepted.body.twoStepSetup.setupId, code: totp(key, clock.now()), device: d } });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      clock.advance(30_000);
      return { accountId: accepted.body.account.id, key, accessToken: confirmed.body.tokens.accessToken };
    },
    async bootstrapOwner(email = 'owner@marketly.test', name = 'Olivia Owner') {
      await (app.kernel.boot.apis.get('access') as AccessService).bootstrapBusinessOwner({ email, name });
      await app.kernel.events.drain();
      return self.acceptStaffInvitation(email);
    },
    async staffWithRoles(inviter, email, name, roleKeys) {
      const roles = (await call('GET', '/api/admin/access/roles', { token: inviter.accessToken })).body as { id: string; key: string }[];
      const roleIds = roleKeys.map((k) => roles.find((r) => r.key === k)!.id);
      const invited = await call('POST', '/api/admin/access/staff-invitations', {
        token: inviter.accessToken,
        body: { email, name, roleIds, reason: 'New hire' },
        headers: { 'x-step-up-code': code(inviter) },
      });
      expect(invited.status, JSON.stringify(invited.body)).toBe(201);
      return self.acceptStaffInvitation(email);
    },
    async customer(email) {
      const v = await visitor();
      const reg = await call('POST', '/api/public/identity/registrations', {
        token: v,
        body: { email, password: PASSWORD, firstName: 'Ana', lastName: 'Lopez', marketingOptIn: false, acceptedTermsVersion: '2026-01', device: device() },
      });
      expect(reg.status, JSON.stringify(reg.body)).toBe(202);
      const issued = events('identity.verification.code_issued').findLast((e) => e.challengeId === reg.body.id);
      const conf = await call('POST', `/api/public/identity/verifications/${reg.body.id}/confirm`, { token: v, body: { code: issued.code, device: device() } });
      expect(conf.status, JSON.stringify(conf.body)).toBe(200);
      return { accountId: conf.body.account.id, accessToken: conf.body.tokens.accessToken, email, password: PASSWORD };
    },
    async signIn(body) {
      const v = await visitor(body.audience);
      return call('POST', '/api/public/identity/sessions', { token: v, body: { keepSignedIn: false, device: device(), ...body } });
    },
    async upload(area, token, file) {
      const start = await call('POST', `/api/${area}/media/uploads`, { token, body: { purpose: file.purpose, fileName: file.fileName, contentType: file.contentType, sizeBytes: file.body.length } });
      expect(start.status, JSON.stringify(start.body)).toBe(201);
      // stands in for the browser's PUT to object storage (the dev storage adapter checks the signature)
      const storage = (app.kernel.boot.apis.get('media') as any).providers.storage;
      await storage.acceptSignedPut(start.body.url, file.body, start.body.headers['content-type']);
      const done = await call('POST', `/api/${area}/media/uploads/${start.body.uploadId}/complete`, { token });
      expect(done.status, JSON.stringify(done.body)).toBe(202);
      await app.kernel.jobs.runNow('media.process');
      await app.kernel.events.drain();
      return start.body.assetId as string;
    },
    async approvedSeller({ applicant, sellerManager, categoryId, storeName }) {
      const STORE = '/api/store/sellers';
      const ADMIN = '/api/admin/sellers';
      const workEmail = `owner@${storeName.toLowerCase().replace(/[^a-z]+/g, '')}.example.com`;
      const invited = await call('POST', `${ADMIN}/seller-invitations`, { token: sellerManager.accessToken, body: { email: workEmail, businessName: `${storeName} LLC` } });
      expect(invited.status, JSON.stringify(invited.body)).toBe(201);
      // the emailed code (spec gap: the code is in no event or response yet, so read it as the email would carry it)
      const invitationCode = (app.kernel.boot.apis.get('sellers') as any).applications.invitationCode(invited.body.id) as string;
      const t = applicant.accessToken;
      const start = await call('POST', `${STORE}/applications`, {
        token: t,
        body: { accountMode: 'existing_member', contactName: 'Ana Lopez', contactPhone: '+15035550101', workEmail, storeName, sellerType: 'business', market: 'US', invitationCode },
      });
      expect(start.status, JSON.stringify(start.body)).toBe(201);
      const id = start.body.id as string;
      const patch = async (body: object) => {
        const r = await call('PATCH', `${STORE}/applications/${id}`, { token: t, body });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        return r.body;
      };
      const businessAddress = { name: `${storeName} LLC`, line1: '410 Pine St', city: 'Portland', region: 'OR', postalCode: '97204', country: 'US' };
      await patch({
        step: 'business',
        business: {
          kind: 'registered_business',
          legalName: `${storeName} LLC`,
          storeName,
          businessType: 'llc',
          stateOfRegistration: 'OR',
          registryNumber: 'OR-123456',
          address: businessAddress,
          phone: '+15035550100',
          website: 'https://shop.example.com',
          categoryIds: [categoryId],
          plannedProductCount: '21_100',
          plannedProducts: 'headphones, speakers',
          supportHours: 'Mon-Fri 9-5',
        },
      });
      const v = await patch({ step: 'verification', verification: { owners: [{ name: 'Ana Lopez', ownershipPct: 100, isPrimary: true, idDocumentIds: [] }], taxIdType: 'ein', taxId: '12-3456789', w9Method: 'online' } });
      const ownerId = v.verification.owners[0].id;
      for (const [kind, extra] of [['owner_id', { ownerId }], ['business_registration', {}]] as const) {
        const mediaId = await self.upload('store', t, { purpose: 'verification_document', fileName: `${kind}.pdf`, contentType: 'application/pdf', body: onePagePdf() });
        const d = await call('POST', `${STORE}/applications/${id}/documents`, { token: t, body: { mediaId, kind, ...extra } });
        expect(d.status, JSON.stringify(d.body)).toBe(201);
      }
      const account = '000123457731';
      await patch({ step: 'payout', payout: { accountHolderName: `${storeName} LLC`, accountType: 'business_checking', routingNumber: '011000015', accountNumber: account, confirmAccountNumber: account } });
      await patch({ step: 'return_address', returnAddress: { sameAsBusiness: true, contactName: 'Ana Lopez', phone: '+15035550101' } });
      const draft = (await call('GET', `${STORE}/applications/current`, { token: t })).body;
      const acceptances = draft.agreementsRequired.map((a: { key: string; versionLabel: string }) => ({ key: a.key, versionLabel: a.versionLabel }));
      const submitted = await call('POST', `${STORE}/applications/${id}/submit`, { token: t, body: { acceptances, signedName: 'Ana Lopez' } });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      const sellerId = submitted.body.sellerId as string;
      expect((await call('POST', `${ADMIN}/applications/${id}/start-review`, { token: sellerManager.accessToken })).status).toBe(200);
      const approved = await call('POST', `${ADMIN}/applications/${id}/approve`, { token: sellerManager.accessToken, body: { note: 'Welcome' } });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      const signedIn = await self.signIn({ email: applicant.email, password: applicant.password, audience: 'seller', sellerId });
      expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
      return { sellerId, sellerToken: signedIn.body.tokens.accessToken as string };
    },
    async liveListing({ price = 18900, quantity = 5 } = {}) {
      const owner = await self.bootstrapOwner();
      const sellerManager = await self.staffWithRoles(owner, 'sam@marketly.test', 'Sam Sellers', ['seller_manager']);
      const catalogManager = await self.staffWithRoles(owner, 'cat@marketly.test', 'Cara Catalog', ['catalog_manager']);
      const category = await call('POST', '/api/admin/catalog/categories', { token: catalogManager.accessToken, body: { name: 'Headphones', parentId: null } });
      expect(category.status, JSON.stringify(category.body)).toBe(201);
      const brand = await call('POST', '/api/admin/catalog/brands', { token: catalogManager.accessToken, body: { name: 'Aurora Sound' } });
      expect(brand.status, JSON.stringify(brand.body)).toBe(201);
      const sellerOwner = await self.customer('ana@example.com');
      const seller = await self.approvedSeller({ applicant: sellerOwner, sellerManager, categoryId: category.body.id, storeName: 'Northwind Audio' });
      const { sellerToken } = seller;
      const imageId = await self.upload('seller', sellerToken, { purpose: 'product_image', fileName: 'front.png', contentType: 'image/png', body: pngHeader(1600, 1600) });
      const draft = await call('POST', '/api/seller/catalog/products', {
        token: sellerToken,
        body: {
          title: 'Aurora wireless headphones',
          brandId: brand.body.brand.id,
          categoryId: category.body.id,
          description: 'Over-ear headphones with active noise cancelling and a 40 hour battery that charges over USB-C.',
          keyFeatures: ['Active noise cancelling', '40 h battery', 'USB-C charging'],
          specs: { 'Battery life': '40 h' },
          includedItems: ['Headphones', 'USB-C cable'],
          imageIds: [imageId],
          modelNumber: 'AU-100',
          variants: [{ options: { Color: 'Black' }, gtin: '4006381333931' }],
        },
      });
      expect(draft.status, JSON.stringify(draft.body)).toBe(201);
      const productId = draft.body.product.id as string;
      const variantId = draft.body.product.variants[0].id as string;
      expect((await call('POST', `/api/seller/catalog/products/${productId}/submit`, { token: sellerToken, body: { note: 'First submission' } })).status).toBe(200);
      await self.passLaunchReview({ ...seller, sellerManager });
      const approved = await call('POST', `/api/admin/catalog/products/${productId}/approve`, { token: catalogManager.accessToken, body: {} });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      const shippingProfileId = await self.shippingProfile(sellerToken);
      const offer = await call('POST', '/api/seller/offers/offers', {
        token: sellerToken,
        body: {
          productId,
          variantId,
          condition: 'new',
          price: { amount: price, currency: 'USD' },
          sellerSku: 'NW-AU-100',
          quantity,
          dispatchBusinessDays: 1,
          shippingProfileId,
          returnTerms: { kind: 'baseline' },
          warranty: { kind: 'manufacturer', months: 24 },
          publish: true,
        },
      });
      expect(offer.status, JSON.stringify(offer.body)).toBe(201);
      await app.kernel.events.drain();
      return {
        owner,
        sellerManager,
        catalogManager,
        sellerId: seller.sellerId,
        sellerToken,
        sellerOwner,
        categoryId: category.body.id,
        productId,
        variantId,
        offerId: offer.body.offer.id,
      };
    },
    async shippingProfile(sellerToken) {
      if (!app.kernel.modules.includes('shipping')) return crypto.randomUUID(); // shipping off: offers accept the id as given
      const settings = await call('PUT', '/api/seller/shipping/settings', {
        token: sellerToken,
        body: {
          coverage: { area: 'contiguous_48_dc', zoneIds: [], excluded: ['po_box'] },
          dispatch: { handlingDays: 1, sameDayCutoff: '12:00', businessDays: ['mon', 'tue', 'wed', 'thu', 'fri'] },
          buyLabelsInSellerCenter: true,
          effectiveFrom: null,
        },
      });
      expect(settings.status, JSON.stringify(settings.body)).toBe(200);
      const methods = (await call('GET', '/api/seller/shipping/methods', { token: sellerToken })).body as { id: string; code: string }[];
      const id = (code: string) => methods.find((m) => m.code === code)!.id;
      const usd = (amount: number) => ({ amount, currency: 'USD' });
      const profile = await call('POST', '/api/seller/shipping/profiles', {
        token: sellerToken,
        body: {
          name: 'Default',
          methods: [
            { methodId: id('standard'), enabled: true, rateType: 'by_weight', tiers: [{ upToGrams: 2000, price: usd(599) }, { upToGrams: 20000, price: usd(1299) }], maxWeightGrams: 20000 },
            { methodId: id('expedited'), enabled: true, rateType: 'flat_per_package', tiers: [{ price: usd(1499) }] },
          ],
          freeShippingThreshold: usd(4900),
          freeShippingMethodCode: 'standard',
          effectiveFrom: null,
        },
      });
      expect(profile.status, JSON.stringify(profile.body)).toBe(201);
      return (profile.body.id ?? profile.body.profile?.id) as string;
    },
    async passLaunchReview({ sellerId, sellerToken, sellerManager }) {
      // finance is not built yet: its payout-destination verification arrives as the event it will publish
      app.kernel.events.publish('finance', 'finance.destination.verified' as never, { sellerId, reviewId: crypto.randomUUID() } as never);
      await app.kernel.events.drain();
      const requested = await call('POST', '/api/seller/sellers/setup/launch-review', { token: sellerToken, body: {} });
      expect(requested.status, JSON.stringify(requested.body)).toBe(200);
      const passed = await call('POST', `/api/admin/sellers/sellers/${sellerId}/launch-review/decide`, { token: sellerManager.accessToken, body: { outcome: 'pass' } });
      expect(passed.status, JSON.stringify(passed.body)).toBe(200);
    },
  };
  return self;
}
