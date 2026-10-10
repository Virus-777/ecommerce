import type { GraphQLContext, ModuleResolvers } from '../../../kernel/graphql/index.js';
import { format as formatMoney } from '../../../kernel/lib/money.js';
import type { Money } from '../../../spec/common.js';
import type { KpiValue, MetricDefinition, Series } from '../../../spec/reports.js';
import { metricSeed } from '../domain/catalogue.js';
import { display } from '../domain/rules.js';
import type { AdminDashboardData, Period, SellerDashboardData } from '../service/queries.js';
import type { ReportsService } from '../service.js';

/* ---------------------------------------------------------------- REST shapes → GraphQL shapes (enums in capitals, Money.formatted) */

const up = (s: string | null | undefined) => (s ? s.toUpperCase() : s);
const money = (m: Money | null | undefined) => (m ? { ...m, formatted: formatMoney(m) } : null);
const periodOf = (p: string | null | undefined): Period => (p ? (p.toLowerCase() as Period) : 'last_7_days');

function definition(d: MetricDefinition, area: GraphQLContext['area']) {
  return {
    key: d.key,
    name: d.name,
    group: up(d.group),
    definition: d.definition,
    unit: up(d.unit),
    includes: d.includes,
    excludes: d.excludes,
    defaultDateBasis: up(d.defaultDateBasis),
    currencyRule: d.currencyRule,
    timeZone: d.timeZone,
    relatedKeys: d.relatedKeys,
    version: d.version,
    effectiveFrom: d.effectiveFrom,
    ownerName: area === 'admin' ? (d.owner?.name ?? null) : null,
  };
}

type Delta = { value: number; unit: string; direction: string; good: boolean };

function metricValue(k: KpiValue & { unit: MetricDefinition['unit'] }, defs: MetricDefinition[], area: GraphQLContext['area']) {
  const delta = k.delta as Delta | null | undefined;
  const def = defs.find((d) => d.key === k.metricKey);
  return {
    metricKey: k.metricKey,
    label: k.label,
    value: k.value,
    money: money(k.money),
    display: k.display,
    unit: up(k.unit),
    delta: delta ? { value: delta.value, unit: up(delta.unit), direction: up(delta.direction), good: delta.good } : null,
    note: k.note ?? null,
    definition: def ? definition(def, area) : null,
  };
}

function series(s: Series, metricKey: string, currency: string, defs: MetricDefinition[], area: GraphQLContext['area']) {
  const unit = metricSeed(metricKey)?.unit ?? 'money';
  const points = (s.points as { x: string; y: number; label?: string }[]).map((p) => ({ date: p.x, label: p.label ?? p.x, value: p.y, money: unit === 'money' ? money({ amount: p.y, currency }) : null }));
  const sum = points.reduce((n, p) => n + p.value, 0);
  return {
    key: s.key,
    label: s.label,
    metricKey,
    unit: up(unit),
    granularity: 'day',
    points,
    total: metricValue({ metricKey, label: `${s.label}, total`, value: sum, money: unit === 'money' ? { amount: sum, currency } : null, display: display(sum, unit, currency), unit }, defs, area),
  };
}

function common(d: AdminDashboardData | SellerDashboardData, scope: 'PLATFORM' | 'SELLER') {
  return {
    scope,
    period: up(d.period),
    from: d.range.from,
    to: d.range.to,
    compareFrom: d.compare.from,
    compareTo: d.compare.to,
    asOf: d.asOf,
    dateBasis: 'PLACEMENT',
    currency: d.currency,
    timeZone: d.timeZone,
    taxIncluded: d.taxIncluded,
    mayStillChange: true,
    unavailable: d.unavailable,
  };
}

/**
 * Resolvers for the GraphQL fields this module owns (`@source(module: "reports", …)` in graphql/schema.ts).
 *   Query.adminDashboard → service.getAdminDashboard (whole marketplace; @auth checks reports.dashboard.view)
 *   Query.sellerDashboard → service.getSellerDashboard (the caller's own seller only; anyone else gets null)
 */
export const resolvers = (service: ReportsService): ModuleResolvers => ({
  Query: {
    adminDashboard: async (_root: unknown, args: { period?: string | null }, ctx: GraphQLContext) => {
      if (ctx.principal?.kind !== 'staff') return null;
      const d = await service.queries.adminDashboard(periodOf(args.period));
      return {
        ...common(d, 'PLATFORM'),
        basisLabel: d.dateBasis,
        kpis: d.kpis.map((k) => metricValue(k, d.definitions, ctx.area)),
        series: d.series.map((s) => series(s, 'commerce.gross_sales', d.currency, d.definitions, ctx.area)),
        split: d.split.map((s) => ({ key: s.key, label: s.label, amount: money(s.amount), sharePct: s.sharePct })),
        workToday: null,
        definitions: d.definitions.map((x) => definition(x, ctx.area)),
      };
    },
    sellerDashboard: async (_root: unknown, args: { period?: string | null }, ctx: GraphQLContext) => {
      const sellerId = ctx.principal?.kind === 'seller' ? ctx.principal.sellerId : null;
      if (!sellerId) return null;
      const d = await service.queries.sellerDashboard(sellerId, args.period ? periodOf(args.period) : 'last_14_days', { canViewFinance: await ctx.can('finance.balances.view') });
      return {
        ...common(d, 'SELLER'),
        basisLabel: 'Item sales before fees, by order date',
        kpis: d.sales.kpis.map((k) => metricValue(k, d.definitions, ctx.area)),
        series: d.sales.series.map((s) => series(s, 'commerce.gross_sales', d.currency, d.definitions, ctx.area)),
        split: [],
        workToday: d.workToday.map((t) => ({ ...t, key: up(t.key), tone: up(t.tone), screenState: t.screenState ?? null })),
        definitions: d.definitions.map((x) => definition(x, ctx.area)),
      };
    },
  },
});
