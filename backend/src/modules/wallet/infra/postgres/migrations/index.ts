import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002LedgerGuards } from './0002_ledger_guards.js';
import { m0003GiftCardBatches } from './0003_gift_card_batches.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002LedgerGuards, m0003GiftCardBatches];
