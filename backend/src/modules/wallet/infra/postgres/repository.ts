import type { Kysely } from 'kysely';
import type { WalletDb } from '../../../../spec/wallet.js';
import type { WalletRepository } from '../../ports.js';

/** Postgres adapter for WalletRepository. `db` is scoped to the `wallet` schema. */
export function createPostgresWalletRepository(db: Kysely<WalletDb>): WalletRepository {
  void db;
  return {};
}
