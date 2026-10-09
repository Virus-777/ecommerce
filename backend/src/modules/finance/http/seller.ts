import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/finance.js';
import type { FinanceService } from '../service.js';
import { byOf } from './by.js';

/**
 * Seller API: /api/seller/finance/…  (docs/api/modules/finance.md)
 * Every read is the session's own seller (sellerId from the session; another seller's record → 404).
 */
export const sellerRoutes = (service: FinanceService) =>
  routes(endpoints, 'seller', {
    /** GET /balances */
    getBalances: async ({ sellerId }) => service.ledger.balances(sellerId),
    /** GET /ledger */
    listLedger: async ({ sellerId, query, page }) => service.ledger.listLedger(sellerId, query, page),
    /** POST /ledger/exports */
    exportLedger: async (i) => service.reports.exportLedger(i.sellerId, i.body, i.principal, byOf(i)),
    /** GET /ledger/exports/{id} */
    getLedgerExport: async ({ sellerId, params, principal }) => service.reports.getLedgerExport(sellerId, params.id, principal),
    /** GET /payouts */
    listSellerPayouts: async ({ sellerId, query, page }) => service.payouts.payoutsForSeller(sellerId, query.status, page),
    /** GET /payouts/{id} */
    getSellerPayout: async ({ sellerId, params }) => service.payouts.sellerPayout(sellerId, params.id),
    /** GET /statements */
    listSellerStatements: async ({ sellerId, page }) => service.statements.list(sellerId, page),
    /** GET /statements/{id} */
    getSellerStatement: async ({ sellerId, params }) => service.statements.get(params.id, sellerId),
    /** GET /statements/{id}/download */
    downloadSellerStatement: async ({ sellerId, params, query, principal }) => service.statements.download(sellerId, params.id, query.format, principal),
    /** GET /fee-schedule */
    getSellerFeeSchedule: async () => service.fees.schedule(),
    /** POST /payout-destination/confirm-deposits */
    confirmDeposits: async (i) => service.destinations.confirmDeposits(i.sellerId, i.body.amounts, byOf(i)),
    /** GET /payout-destination */
    getPayoutDestination: async ({ sellerId }) => service.destinations.forSeller(sellerId),
  });
