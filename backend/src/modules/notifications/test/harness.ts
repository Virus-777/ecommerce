/**
 * Test harness: notifications with its neighbours (access, customers, sellers, audit, identity)
 * booted as scaffolds and their public APIs stubbed with small in-memory fixtures.
 */
import type { FastifyInstance } from 'fastify';
import { devClaims } from '../../../kernel/auth/dev.js';
import { fixedClock } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { BuildOptions } from '../../../app.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type * as customers from '../../../spec/customers.js';
import type * as identity from '../../../spec/identity.js';
import type { StoreTable } from '../../../kernel/store/index.js';
import { auth, buildTestApp, token } from '../../../testing/app.js';
import type { NotificationsDb } from '../../../spec/notifications.js';
import { devOutbox } from '../providers/dev-outbox.js';
import type { NotificationsService } from '../service.js';

export interface Person {
  accountId: string;
  email: string;
  name: string;
  realm: 'member' | 'staff';
}

export interface CustomerFixture extends Person {
  customerId: string;
  phone?: string | null;
  status?: customers.CustomerSnapshot['accountStatus'];
  consent?: Partial<customers.MarketingPreferences>;
}

export interface MemberFixture extends Person {
  sellerId: string;
  memberId: string;
  isOwner: boolean;
  permissions: string[];
  role: string;
}

let n = 0;
const uniq = () => `${Date.now().toString(36)}${(++n).toString(36)}`;

export class World {
  readonly accounts = new Map<string, Person>();
  readonly customers = new Map<string, CustomerFixture>();
  readonly members = new Map<string, MemberFixture>();
  readonly roles = new Map<string, access.RecipientResolution>();
  readonly coverage: access.RoleCoverage[] = [];
  readonly audits: audit.RecordInput[] = [];
  readonly sellersList: string[] = [];
  /** identity.issueOrderLink calls (guest order links) */
  readonly orderLinks: { orderId: string; email: string; orderRef?: string }[] = [];

  customer(o: Partial<CustomerFixture> = {}): CustomerFixture {
    const id = uniq();
    const c: CustomerFixture = { accountId: newId(), customerId: newId(), email: `cust-${id}@example.com`, name: `Jordan ${id}`, realm: 'member', status: 'active', ...o };
    this.customers.set(c.customerId, c);
    this.accounts.set(c.accountId, c);
    return c;
  }

  staff(o: Partial<Person> = {}): Person {
    const id = uniq();
    const p: Person = { accountId: newId(), email: `staff-${id}@marketly.example`, name: `Staff ${id}`, realm: 'staff', ...o };
    this.accounts.set(p.accountId, p);
    return p;
  }

  member(sellerId: string, o: Partial<MemberFixture> = {}): MemberFixture {
    const id = uniq();
    const accountId = o.accountId ?? newId();
    const m: MemberFixture = { accountId, memberId: accountId, sellerId, email: `member-${id}@example.com`, name: `Member ${id}`, realm: 'member', isOwner: false, permissions: [], role: 'Staff', ...o };
    this.members.set(`${sellerId}:${accountId}`, m);
    this.accounts.set(accountId, m);
    if (!this.sellersList.includes(sellerId)) this.sellersList.push(sellerId);
    return m;
  }

  role(roleKey: string, r: Partial<access.RecipientResolution>) {
    this.roles.set(roleKey, { roleKey, accountIds: [], ccAccountIds: [], viaBackup: false, ...r });
  }

  /** A seller's store name, for sellers.getSeller (staff notices name the store) */
  readonly storeNames = new Map<string, string>();
  store(sellerId: string, storeName: string) {
    this.storeNames.set(sellerId, storeName);
  }

  summary(p: Person): identity.AccountSummary {
    return { id: p.accountId, realm: p.realm, email: p.email, displayName: p.name, status: 'active', emailVerified: true, twoStepEnabled: false };
  }

  snapshot(c: CustomerFixture): customers.CustomerSnapshot {
    return { id: c.customerId, userId: c.accountId, ref: `CU-${c.customerId.slice(0, 6)}`, displayName: c.name, email: c.email, phone: c.phone ?? null, accountStatus: c.status ?? 'active', canOrder: true, canMessage: true };
  }

  consentOf(c: CustomerFixture): customers.MarketingPreferences {
    return {
      emailPromotions: false,
      smsPromotions: false,
      pushPromotions: false,
      wishlistAlerts: false,
      personalizedRecommendations: true,
      recentSearches: true,
      essentialAlwaysOn: true,
      smsNumber: null,
      updatedAt: new Date().toISOString(),
      ...c.consent,
    };
  }

  stubs(): NonNullable<BuildOptions['apiStubs']> {
    return {
      identity: {
        getAccount: async (id) => {
          const p = this.accounts.get(id);
          return p ? this.summary(p) : null;
        },
        getAccounts: async (ids) => ids.flatMap((id) => (this.accounts.get(id) ? [this.summary(this.accounts.get(id)!)] : [])),
        issueOrderLink: async (orderId, email, orderRef) => {
          this.orderLinks.push({ orderId, email, orderRef });
          return { url: `https://marketly.example/orders/link/${orderId}-token`, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
        },
      },
      customers: {
        getCustomer: async (id) => (this.customers.get(id) ? this.snapshot(this.customers.get(id)!) : null),
        getCustomerByUserId: async (userId) => {
          const c = [...this.customers.values()].find((x) => x.accountId === userId);
          return c ? this.snapshot(c) : null;
        },
        getMarketingConsent: async (id) => this.consentOf(this.customers.get(id)!),
        searchCustomers: async () => ({ items: [...this.customers.values()].filter((c) => (c.status ?? 'active') === 'active').map((c) => this.snapshot(c)), nextCursor: null }),
      },
      sellers: {
        getMemberAccess: async (sellerId, accountId) => {
          const m = this.members.get(`${sellerId}:${accountId}`);
          return m ? { memberId: m.memberId, role: m.role, permissions: m.permissions, isOwner: m.isOwner } : null;
        },
        listMembers: async (sellerId) =>
          [...this.members.values()].filter((m) => m.sellerId === sellerId).map((m) => ({ memberId: m.memberId, accountId: m.accountId, role: m.role, isOwner: m.isOwner })),
        ownerOf: async (sellerId) => {
          const o = [...this.members.values()].find((m) => m.sellerId === sellerId && m.isOwner);
          return o ? { accountId: o.accountId, memberId: o.memberId } : null;
        },
        getSeller: async (id) => {
          const storeName = this.storeNames.get(id);
          return storeName ? { id, ref: 'SL-1', slug: id, storeName, status: 'approved' as const, verified: true, canSellNew: true, activeRestrictionIds: [], launchReady: true } : null;
        },
        searchSellers: async () => ({ items: this.sellersList.map((id) => ({ id, ref: 'SL-1', slug: id, storeName: 'Store', status: 'approved' as const, verified: true, canSellNew: true, activeRestrictionIds: [], launchReady: true })), nextCursor: null }),
      },
      access: {
        resolveRecipients: async (roleKey) => this.roles.get(roleKey) ?? { roleKey, accountIds: [], ccAccountIds: [], viaBackup: false },
        coverageNow: async () => this.coverage,
        rolesOf: async () => [],
      },
      audit: {
        record: async (e) => {
          this.audits.push(e);
          return newId();
        },
      },
    };
  }
}

export const MODULES = ['identity', 'notifications', 'access', 'customers', 'sellers', 'audit', 'media'];

export async function bootWorld(opts: { launchPhase?: number; clock?: ReturnType<typeof fixedClock> } = {}) {
  const world = new World();
  const app: FastifyInstance = await buildTestApp({
    modules: MODULES,
    config: { launchPhase: opts.launchPhase ?? 4, rateLimits: false },
    ...(opts.clock ? { clock: opts.clock } : {}),
    apiStubs: world.stubs(),
  });
  // a fixed clock starts at the time it was made: move it to now, after the boot (tokens are signed at the real time)
  opts.clock?.set(new Date());
  const service = app.kernel.boot.apis.get('notifications') as NotificationsService;
  return { app, world, service };
}

/** Long-lived dev tokens (tests move the clock forward) */
const TTL = 7 * 86_400;
export const as = {
  customer: (c: { accountId: string }) => auth(token(devClaims('customer', { accountId: c.accountId }), TTL)),
  seller: (m: MemberFixture) => auth(token(devClaims('seller', { sellerId: m.sellerId, accountId: m.accountId, ...(m.isOwner ? {} : { permissions: m.permissions }) }), TTL)),
  staff: (p: { accountId: string }, permissions?: string[]) => auth(token(devClaims('staff', { accountId: p.accountId, permissions }), TTL)),
};

export function capture(app: FastifyInstance, ...names: string[]) {
  const seen: { name: string; payload: any }[] = [];
  for (const name of names) app.kernel.events.subscribe('test', name, (e) => void seen.push({ name: e.name, payload: e.payload }));
  return seen;
}

export async function publish(app: FastifyInstance, name: string, payload: unknown) {
  app.kernel.events.publish(name.split('.')[0]!, name, payload);
  await app.kernel.events.drain();
}

export const emailsTo = (address: string) => devOutbox.emailsTo(address);
export const money = (amount: number) => ({ amount, currency: 'USD' });
export { devOutbox, newId };

/**
 * This module's tables, read and written the way the repository does — **through the store the app chose**,
 * MongoDB or MySQL, whichever `MYSQL_MODULES` put this module's data in. A helper that built a MongoDB store
 * of its own would read an empty database the day the module moved, with nothing in the log to say why
 * (docs/10 §10.5c: that is how twenty-two of access's tests failed at once).
 */
export const tables = (app: FastifyInstance) => {
  const store = app.kernel.boot.stores.get('notifications')!;
  return { table: <T extends keyof NotificationsDb & string>(name: T): StoreTable<NotificationsDb[T]> => store.table<NotificationsDb[T]>(name) };
};
