import { gqlEnum, type GraphQLContext, type ModuleResolvers } from '../../../kernel/graphql/index.js';
import type * as cart from '../../../spec/cart.js';
import type * as payments from '../../../spec/payments.js';
import type * as shipping from '../../../spec/shipping.js';
import type { ChangeSet, CheckoutLine, CheckoutView, ConfirmationView, CouponResult, QuoteTotals } from '../../../spec/checkout.js';
import type { CheckoutService } from '../service.js';

const seller = (s: cart.SellerLabel) => ({ id: s.id ?? null, name: s.name, slug: s.slug, official: s.official, verified: s.verified, logo: s.logo ?? null });

const line = (l: CheckoutLine) => ({
  ...l,
  status: gqlEnum(l.status),
  unitPrice: l.unitPrice ?? null,
  lineTotal: l.lineTotal ?? null,
  discounts: l.discounts.map((d) => ({ ...d, amount: d.amount ?? null, fundedBy: gqlEnum(d.fundedBy) })),
});

const option = (o: shipping.DeliveryOption | null | undefined) =>
  o ? { ...o, price: o.price ?? null, fundedBy: gqlEnum(o.fundedBy), arrivalFrom: o.arrival.from, arrivalTo: o.arrival.to, notices: o.notices ?? [] } : null;

const coupon = (c: CouponResult) => ({
  ...c,
  status: gqlEnum(c.status),
  fundedBy: gqlEnum(c.fundedBy ?? null),
  amount: c.amount ?? null,
  coverage: c.coverage.map((x) => ({ ...x, amount: x.amount ?? null })),
});

const totals = (t: QuoteTotals) => ({
  ...t,
  items: t.items ?? null,
  discounts: t.discounts.map((d) => ({ ...d, amount: d.amount ?? null, fundedBy: gqlEnum(d.fundedBy) })),
  discountTotal: t.discountTotal ?? null,
  shippingByPackage: t.shippingByPackage.map((s) => ({ ...s, amount: s.amount ?? null })),
  shippingTotal: t.shippingTotal ?? null,
  tax: t.tax.map((x) => ({ ...x, amount: x.amount ?? null })),
  taxTotal: t.taxTotal ?? null,
  creditApplied: t.creditApplied ?? null,
  total: t.total ?? null,
});

const paymentOptions = (o: payments.PaymentOptions) => ({
  ...o,
  savedMethods: o.savedMethods.map((s) => ({ ...s, kind: gqlEnum(s.kind) })),
  walletKinds: o.walletKinds.map((k) => k.toUpperCase()),
});

const paymentStatus = (p: payments.PaymentStatusView | null | undefined) =>
  p ? { ...p, state: gqlEnum(p.state), amount: p.amount ?? null, decline: p.decline ? { ...p.decline, category: gqlEnum(p.decline.category) } : null } : null;

export const gqlChangeSet = (c: ChangeSet) => ({
  ...c,
  status: gqlEnum(c.status),
  previousTotal: c.previousTotal ?? null,
  newTotal: c.newTotal ?? null,
  deltas: c.deltas.map((d) => ({ ...d, amount: d.amount ?? null })),
  changes: c.changes.map((x) => ({
    ...x,
    kind: gqlEnum(x.kind),
    previousAmount: x.previousAmount ?? null,
    currentAmount: x.currentAmount ?? null,
    effectOnTotal: x.effectOnTotal ?? null,
    choices: x.choices.map((k) => k.toUpperCase()),
    defaultChoice: gqlEnum(x.defaultChoice),
    alternatives: x.alternatives.map((a) => ({ ...a, seller: seller(a.seller), price: a.price ?? null, shipping: a.shipping ?? null })),
  })),
});

export const gqlConfirmation = (c: ConfirmationView | null) =>
  c
    ? {
        ...c,
        charged: c.charged ?? null,
        totals: totals(c.totals),
        packages: c.packages.map((p) => ({ ...p, seller: seller(p.seller), items: p.items.map((i) => ({ ...i, price: i.price ?? null })) })),
      }
    : null;

type Owner = { customerId?: string; guestSessionId?: string };

const gqlSession = (v: CheckoutView, extras: { hidePricesOnSlip: boolean; openChangeSet: () => Promise<ChangeSet | null> }) => ({
  ...v,
  status: gqlEnum(v.status),
  source: gqlEnum(v.source),
  steps: v.steps.map((s) => ({ ...s, key: gqlEnum(s.key), status: gqlEnum(s.status) })),
  account: v.account ? { ...v.account, kind: gqlEnum(v.account.kind) } : null,
  address: v.address ? { ...v.address, lines: v.address.lines.map((l) => ({ ...l, reason: gqlEnum(l.reason ?? null) })) } : null,
  packages: v.packages.map((p) => {
    const options = p.options.map(option);
    return { ...p, seller: seller(p.seller), lines: p.lines.map(line), options, selectedOption: options.find((o) => o?.id === p.selectedOptionId) ?? null, totals: { items: p.totals.items ?? null, discounts: p.totals.discounts ?? null, shipping: p.totals.shipping ?? null, tax: p.totals.tax ?? null, total: p.totals.total ?? null } };
  }),
  excludedLines: v.excludedLines.map(line),
  coupons: v.coupons.map(coupon),
  credit: v.credit ? { ...v.credit, available: v.credit.available ?? null, applied: v.credit.applied ?? null } : null,
  payment: { selected: v.payment.selected ? { ...v.payment.selected, kind: gqlEnum(v.payment.selected.kind) } : null, chargeNote: v.payment.chargeNote },
  paymentOptions: paymentOptions(v.payment.options),
  lastPayment: paymentStatus(v.lastPayment),
  totals: totals(v.totals),
  legal: { ...v.legal, policyVersions: v.legal.policyVersions.map((p) => ({ ...p, policyKey: gqlEnum(p.policyKey) })) },
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
