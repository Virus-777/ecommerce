/**
 * What the finance service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: finance.seller_accounts, finance.ledger_entries, finance.earnings_lots, finance.fee_rule_sets, finance.fee_category_rates, finance.fee_charges, finance.refund_allocations, finance.holds, finance.adjustments, finance.amounts_owed, finance.payout_destinations, finance.destination_reviews, finance.payout_runs, finance.payouts, finance.statements, finance.trading_entries, finance.trading_targets, finance.recon_days, finance.recon_items. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FinanceRepository {}
