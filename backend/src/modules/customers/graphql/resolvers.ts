import { gqlActor, type GraphQLContext, type ModuleResolvers } from '../../../kernel/graphql/index.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { format as formatMoney } from '../../../kernel/lib/money.js';
import type * as common from '../../../spec/common.js';
import type { AccountActionRecord, AccountRestriction, DataRequest, RecentlyViewedItem, SavedAddress } from '../../../spec/customers.js';
import { displayName, verificationOf } from '../domain/rules.js';
import * as map from '../mappers.js';
import type { CustomerStanding } from '../ports.js';
import type { CustomersService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "customers", …)` in graphql/schema.ts).
 *   Query.me → service.getCustomerByUserId (the signed-in customer)
 *   Query.recentlyViewed → service.listRecentlyViewedItems (customer or visitor session)
 *   Query.customer → service.getCustomer (admin)
 *   Query.customers → service.searchCustomers (admin)
 * Customer's own fields without @source resolve from the object built here (functions for the lazy ones).
 * GraphQL enums are upper case; REST values are lower case.
 */
const upper = <T extends string | null | undefined>(s: T) => (s ? s.toUpperCase() : s);
const gqlMoney = (m: common.Money) => ({ ...m, formatted: formatMoney(m) });

const gqlRestriction = (r: AccountRestriction) => ({ ...r, scope: upper(r.scope), reasonCode: upper(r.reasonCode), state: upper(r.state), setBy: gqlActor(r.setBy) });
const gqlRequest = (r: DataRequest) => ({ ...r, kind: upper(r.kind), state: upper(r.state) });
const gqlAction = (a: AccountActionRecord) => ({ ...a, action: upper(a.action), fromStatus: upper(a.fromStatus), toStatus: upper(a.toStatus), actor: gqlActor(a.actor) });
const gqlAddress = (a: SavedAddress) => a;

export const resolvers = (service: CustomersService): ModuleResolvers => {
  /** The Customer object for one standing; `location` is preloaded for lists */
  const customerView = (s: CustomerStanding, ctx: GraphQLContext, location?: string | null) => {
    const r = s.row;
    const snap = map.snapshot(s);
    return {
      ...snap,
      userId: r.user_id,
      accountStatus: upper(snap.accountStatus),
      firstName: r.first_name,
      lastName: r.last_name,
      displayName: displayName(r.first_name, r.last_name),
      emailVerified: r.email_verified_at !== null,
      phoneVerified: r.phone !== null && r.phone_verified_at !== null,
      memberSince: dateInZone(r.created_at, service.admin.marketTimeZone),
      restrictions: async (args: { includeEnded?: boolean }) => (await service.admin.restrictionsOf(r.id, Boolean(args?.includeEnded))).map(gqlRestriction),
      defaultAddress: async () => (await service.admin.addressesOf(r.id)).map(gqlAddress).find((a) => a.isDefault) ?? null,
      addresses: async () => (await service.admin.addressesOf(r.id)).map(gqlAddress),
      marketingPreferences: () => service.admin.preferencesOf(r),
      // download links only for the customer, in the store
      dataRequests: async (args: { includeCancelled?: boolean | null }) =>
        (await service.dataRequests.dataRequestsOf(r.id, ctx.area === 'store' ? ctx.principal : null, { includeCancelled: args?.includeCancelled === true })).map(gqlRequest),
      // the account overview's alerts (store): delays, failed or checked payments, returns and cases waiting on the customer
      overviewAlerts: async () => (await service.profiles.overviewAlerts(r.id)).map((a) => ({ ...a, kind: upper(a.kind), orderId: a.orderId ?? null, orderRef: a.orderRef ?? null, caseRef: a.caseRef ?? null, returnRef: a.returnRef ?? null })),
      location: location !== undefined ? location : async () => map.location((await service.admin.defaultAddressesOf([r.id])).get(r.id)),
      orderCount: r.order_count,
      totalSpend: gqlMoney({ amount: Number(r.total_spend_minor), currency: r.currency }),
      verification: upper(verificationOf(r.email_verified_at, r.phone_verified_at)),
      notes: async () => (await service.admin.notesOf(r.id)).map((n) => ({ ...n, author: gqlActor(n.author) })),
      accountActions: async (args: { limit?: number }) => (await service.admin.actionsOf(r.id, args?.limit ?? 20)).map(gqlAction),
    };
  };

  const viewItem = (i: RecentlyViewedItem) => ({
    ...i,
    price: i.price ? gqlMoney(i.price) : null,
    wasPrice: i.wasPrice ? gqlMoney(i.wasPrice) : null,
    product: () => (i.available ? service.recentlyViewed.productOf(i.productId) : null),
  });

  return {
    Query: {
      me: async (_root, _args, ctx: GraphQLContext) => {
        const accountId = ctx.principal?.kind === 'customer' ? ctx.principal.accountId : null;
        const s = accountId ? await service.admin.standingOfUser(accountId) : undefined;
        return s ? customerView(s, ctx) : null;
      },
      recentlyViewed: async (_root, args: { limit?: number }, ctx: GraphQLContext) => {
        const p = ctx.principal;
        let owner: { customerId?: string; guestSessionId?: string } | null = null;
        if (p?.kind === 'customer' && p.accountId) {
          const id = await service.admin.customerIdOfAccount(p.accountId);
          owner = id ? { customerId: id } : null;
        } else if (p?.kind === 'visitor') owner = { guestSessionId: p.sessionId };
        if (!owner) return [];
        return (await service.listRecentlyViewedItems(owner, Math.min(args?.limit ?? 12, 50))).map(viewItem);
      },
      customer: async (_root, args: { id: string }, ctx: GraphQLContext) => {
        const s = await service.admin.standing(args.id);
        return s ? customerView(s, ctx) : null;
      },
      customers: async (_root, args: { filter?: { search?: string; statuses?: string[]; verification?: string; joinedFrom?: string; joinedTo?: string } | null; paging?: common.PageInput | null }, ctx: GraphQLContext) => {
        const page = await service.admin.searchStandings(args.filter, args.paging);
        const defaults = await service.admin.defaultAddressesOf(page.items.map((s) => s.row.id));
        return { ...page, items: page.items.map((s) => customerView(s, ctx, map.location(defaults.get(s.row.id)))) };
      },
    },
  };
};
