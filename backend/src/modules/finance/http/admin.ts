import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/finance.js';
import type { FinanceService } from '../service.js';
import { byOf } from './by.js';

/**
 * Admin API: /api/admin/finance/…  (docs/api/modules/finance.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: FinanceService) =>
  routes(endpoints, 'admin', {
    getOverview: async ({ query }) => service.reports.overview(query),
    getMarketplaceIncome: async ({ query }) => service.reports.marketplaceIncome(query),
    listTradingTargets: async ({ query, page }) => service.reports.listTargets(query, page),
    setTradingTarget: async (i) => service.reports.setTarget(i.params.period, i.body, byOf(i)),
    getTrading: async ({ query }) => service.reports.trading(query),
    getFeeRules: async () => service.fees.admin(),
    proposeFeeRules: async (i) => service.fees.propose(i.body, byOf(i)),
    withdrawFeeRules: async (i) => service.fees.withdraw(i.params.id, i.body.reason, byOf(i)),
    calculateFee: async ({ body }) => service.fees.calculate(body.input, body.ruleSetId),
    listSellerFinance: async ({ query, page }) => service.reports.sellerRows(query, page),
    getSellerFinance: async ({ params }) => service.getSellerAccount(params.sellerId),
    listSellerLedgerAdmin: async ({ params, query, page }) => {
      service.ledger.requireSeller(params.sellerId);
      return service.ledger.listLedger(params.sellerId, query, page);
    },
    listSellerStatementsAdmin: async ({ params, page }) => {
      service.ledger.requireSeller(params.sellerId);
      return service.statements.list(params.sellerId, page);
    },
    getStatementAdmin: async ({ params }) => service.statements.get(params.id),
    listHolds: async ({ query, page }) => service.holds.listHolds(query, page),
    placeHold: async (i) => service.holds.place(i.body, byOf(i)),
    releaseHold: async (i) => service.holds.decide(i.params.id, 'release', i.body, byOf(i)),
    extendHold: async (i) => service.holds.extend(i.params.id, i.body, byOf(i)),
    applyHold: async (i) => service.holds.decide(i.params.id, 'apply', i.body, byOf(i)),
    listAdjustments: async ({ query, page }) => service.holds.listAdjustments(query, page),
    recordAdjustment: async (i) => service.holds.record(i.body, byOf(i), i.idempotencyKey),
    listAmountsOwed: async ({ query, page }) => service.holds.listOwed(query, page),
    settleAmountOwed: async (i) => service.holds.settle(i.params.id, i.body, byOf(i)),
    listPayoutRuns: async (i) => service.payouts.listRuns(i.query, i.page, byOf(i)),
    createPayoutRun: async (i) => service.payouts.createRun(i.body, byOf(i)),
    getPayoutRun: async (i) => service.payouts.runView(await service.payouts.run(i.params.id), byOf(i)),
    listRunStatements: async ({ params, query, page }) => service.payouts.listRunStatements(params.id, query, page),
    listRunPayouts: async ({ params, query, page }) => service.payouts.listRunPayouts(params.id, query, page),
    recalculatePayoutRun: async (i) => service.payouts.recalculate(i.params.id, byOf(i)),
    submitPayoutRun: async (i) => service.payouts.submit(i.params.id, byOf(i)),
    approvePayoutRun: async (i) => service.payouts.approve(i.params.id, i.body, byOf(i)),
    sendBackPayoutRun: async (i) => service.payouts.sendBack(i.params.id, i.body.reason, byOf(i)),
    releasePayoutRun: async (i) => service.payouts.release(i.params.id, byOf(i)),
    listPayouts: async ({ query, page }) => service.payouts.listPayouts(query, page),
    retryPayout: async (i) => service.payouts.retry(i.params.id, i.body, byOf(i)),
    listDestinationReviews: async ({ query, page }) => service.destinations.list(query, page),
    approveDestination: async (i) => service.destinations.approve(i.params.id, i.body, byOf(i)),
    rejectDestination: async (i) => service.destinations.reject(i.params.id, i.body.reason, byOf(i)),
    getReconDay: async ({ params }) => service.recon.day(params.date),
    listReconItems: async ({ query, page }) => service.recon.list(query, page),
    assignReconItem: async (i) => service.recon.assign(i.params.id, i.body.ownerId, byOf(i)),
    explainReconItem: async (i) => service.recon.explain(i.params.id, i.body, byOf(i)),
    correctReconItem: async (i) => service.recon.correct(i.params.id, i.body, byOf(i)),
    completeReconDay: async (i) => service.recon.complete(i.params.date, i.body.note, byOf(i)),
  });
