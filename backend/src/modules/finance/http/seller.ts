import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/finance.js';
import type { FinanceService } from '../service.js';

/**
 * Seller API: /api/seller/finance/…  (docs/api/modules/finance.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const sellerRoutes = (service: FinanceService) =>
  routes(endpoints, 'seller', {
    /** GET /balances: Sales proceeds, pending, available, held (with reasons and review dates), negative balance and next payout */
    getBalances: notImplemented,
    /** GET /ledger: Transactions with running balance */
    listLedger: notImplemented,
    /** POST /ledger/exports: Export the ledger for a date range */
    exportLedger: notImplemented,
    /** GET /ledger/exports/{id}: Ledger export status and download link (requesting member only) */
    getLedgerExport: notImplemented,
    /** GET /payouts: Payouts with status and result (failed payouts explain the reason) */
    listSellerPayouts: notImplemented,
    /** GET /payouts/{id}: One payout */
    getSellerPayout: notImplemented,
    /** GET /statements: Statements by period */
    listSellerStatements: notImplemented,
    /** GET /statements/{id}: Itemised statement: sales, fees with basis, refunds (incl. after payout), holds, adjustments with reasons, ad charges, reconciliation to the payout */
    getSellerStatement: notImplemented,
    /** GET /statements/{id}/download: PDF or CSV of a statement */
    downloadSellerStatement: notImplemented,
    /** GET /fee-schedule: Fee rules for the seller's categories with example calculations */
    getSellerFeeSchedule: notImplemented,
    /** POST /payout-destination/confirm-deposits: Confirm the two test-deposit amounts to verify the payout account (owner only) */
    confirmDeposits: notImplemented,
    /** GET /payout-destination: Verification status of the payout account and any change under review */
    getPayoutDestination: notImplemented,
  });
