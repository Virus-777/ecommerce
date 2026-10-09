import type { GraphQLContext, ModuleResolvers } from '../../../kernel/graphql/index.js';
import { format as formatMoney } from '../../../kernel/lib/money.js';
import type * as cart from '../../../spec/cart.js';
import type * as common from '../../../spec/common.js';
import type * as payments from '../../../spec/payments.js';
import type * as shipping from '../../../spec/shipping.js';
import type { ChangeSet, CheckoutLine, CheckoutView, ConfirmationView, CouponResult, QuoteTotals } from '../../../spec/checkout.js';
import type { CheckoutService } from '../service.js';

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "checkout", …)` in graphql/schema.ts).
 *   Query.checkoutSession → service.getSessionView (the viewer's own session; null otherwise)
 *   CheckoutSession.confirmation → service.getConfirmation (null until the payment is accepted)
 * The CheckoutSession object is built here: GraphQL enums are upper case and Money carries `formatted`.
 */
const upper = <T extends string | null | undefined>(s: T) => (s ? s.toUpperCase() : s);
const money = (x: common.Money | null | undefined) => (x ? { ...x, formatted: formatMoney(x) } : null);
const seller = (s: cart.SellerLabel) => ({ id: s.id ?? null, name: s.name, slug: s.slug, official: s.official, verified: s.verified, logo: s.logo ?? null });

const line = (l: CheckoutLine) => ({
  ...l,
  status: upper(l.status),
  unitPrice: money(l.unitPrice),
  lineTotal: money(l.lineTotal),
  discounts: l.discounts.map((d) => ({ ...d, amount: money(d.amount), fundedBy: upper(d.fundedBy) })),
});

const option = (o: shipping.DeliveryOption | null | undefined) =>
  o ? { ...o, price: money(o.price), fundedBy: upper(o.fundedBy), arrivalFrom: o.arrival.from, arrivalTo: o.arrival.to, notices: o.notices ?? [] } : null;

const coupon = (c: CouponResult) => ({
  ...c,
  status: upper(c.status),
  fundedBy: upper(c.fundedBy ?? null),
  amount: money(c.amount),
  coverage: c.coverage.map((x) => ({ ...x, amount: money(x.amount) })),
});

const totals = (t: QuoteTotals) => ({
  ...t,
  items: money(t.items),
  discounts: t.discounts.map((d) => ({ ...d, amount: money(d.amount), fundedBy: upper(d.fundedBy) })),
  discountTotal: money(t.discountTotal),
  shippingByPackage: t.shippingByPackage.map((s) => ({ ...s, amount: money(s.amount) })),
  shippingTotal: money(t.shippingTotal),
  tax: t.tax.map((x) => ({ ...x, amount: money(x.amount) })),
  taxTotal: money(t.taxTotal),
  creditApplied: money(t.creditApplied),
  total: money(t.total),
});

const paymentOptions = (o: payments.PaymentOptions) => ({
  ...o,
  savedMethods: o.savedMethods.map((s) => ({ ...s, kind: upper(s.kind) })),
  walletKinds: o.walletKinds.map((k) => k.toUpperCase()),
});

const paymentStatus = (p: payments.PaymentStatusView | null | undefined) =>
  p ? { ...p, state: upper(p.state), amount: money(p.amount), decline: p.decline ? { ...p.decline, category: upper(p.decline.category) } : null } : null;

export const gqlChangeSet = (c: ChangeSet) => ({
  ...c,
  status: upper(c.status),
  previousTotal: money(c.previousTotal),
  newTotal: money(c.newTotal),
  deltas: c.deltas.map((d) => ({ ...d, amount: money(d.amount) })),
  changes: c.changes.map((x) => ({
    ...x,
    kind: upper(x.kind),
    previousAmount: money(x.previousAmount),
    currentAmount: money(x.currentAmount),
    effectOnTotal: money(x.effectOnTotal),
    choices: x.choices.map((k) => k.toUpperCase()),
    defaultChoice: upper(x.defaultChoice),
    alternatives: x.alternatives.map((a) => ({ ...a, seller: seller(a.seller), price: money(a.price), shipping: money(a.shipping) })),
  })),
});

export const gqlConfirmation = (c: ConfirmationView | null) =>
  c
    ? {
        ...c,
        charged: money(c.charged),
        totals: totals(c.totals),
        packages: c.packages.map((p) => ({ ...p, seller: seller(p.seller), items: p.items.map((i) => ({ ...i, price: money(i.price) })) })),
      }
    : null;

type Owner = { customerId?: string; guestSessionId?: string };

export const gqlSession = (v: CheckoutView, extras: { hidePricesOnSlip: boolean; openChangeSet: () => Promise<ChangeSet | null> }) => ({
  ...v,
  status: upper(v.status),
  source: upper(v.source),
  steps: v.steps.map((s) => ({ ...s, key: upper(s.key), status: upper(s.status) })),
  account: v.account ? { ...v.account, kind: upper(v.account.kind) } : null,
  address: v.address ? { ...v.address, lines: v.address.lines.map((l) => ({ ...l, reason: upper(l.reason ?? null) })) } : null,
  packages: v.packages.map((p) => {
    const options = p.options.map(option);
    return { ...p, seller: seller(p.seller), lines: p.lines.map(line), options, selectedOption: options.find((o) => o?.id === p.selectedOptionId) ?? null, totals: { items: money(p.totals.items), discounts: money(p.totals.discounts), shipping: money(p.totals.shipping), tax: money(p.totals.tax), total: money(p.totals.total) } };
  }),
  excludedLines: v.excludedLines.map(line),
  coupons: v.coupons.map(coupon),
  credit: v.credit ? { ...v.credit, available: money(v.credit.available), applied: money(v.credit.applied) } : null,
  payment: { selected: v.payment.selected ? { ...v.payment.selected, kind: upper(v.payment.selected.kind) } : null, chargeNote: v.payment.chargeNote },
  paymentOptions: paymentOptions(v.payment.options),
  lastPayment: paymentStatus(v.lastPayment),
  totals: totals(v.totals),
  legal: { ...v.legal, policyVersions: v.legal.policyVersions.map((p) => ({ ...p, policyKey: upper(p.policyKey) })) },
  hidePricesOnSlip: extras.hidePricesOnSlip,
  openChangeSet: async () => {
    const c = await extras.openChangeSet();
    return c ? gqlChangeSet(c) : null;
  },
});

/** The shopper behind a GraphQL request: the signed-in customer or the visitor (guest) session */
async function ownerOf(ctx: GraphQLContext): Promise<Owner | null> {
  const p = ctx.principal;
  if (p?.kind === 'visitor') return { guestSessionId: p.guestSessionId ?? p.sessionId };
  if (p?.kind === 'customer') {
    const customerId = await ctx.customerId();
    return customerId ? { customerId } : null;
  }
  return null;
}

export const resolvers = (service: CheckoutService): ModuleResolvers => ({
  Query: {
    checkoutSession: async (_parent: unknown, args: { id: string }, ctx: GraphQLContext) => {
      const owner = await ownerOf(ctx);
      if (!owner) return null;
      const view = await service.getSessionView(owner, args.id);
      if (!view) return null;
      return { ...gqlSession(view, { hidePricesOnSlip: await service.hidePricesOnSlip(owner, args.id), openChangeSet: () => service.openChangeSetOf(owner, args.id) }), __owner: owner };
    },
  },
  CheckoutSession: {
    confirmation: async (parent: { id: string; __owner?: Owner }, _args: unknown, ctx: GraphQLContext) => {
      const owner = parent.__owner ?? (await ownerOf(ctx));
      return owner ? gqlConfirmation(await service.getConfirmation(owner, parent.id)) : null;
    },
  },
});
