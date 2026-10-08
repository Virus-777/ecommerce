/**
 * What the wallet service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: wallet.accounts, wallet.lots, wallet.ledger, wallet.holds, wallet.goodwill_grants, wallet.gift_cards, wallet.loyalty_entries. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WalletRepository {}
