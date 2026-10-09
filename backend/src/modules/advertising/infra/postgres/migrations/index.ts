import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002PlacementsAndLookups } from './0002_placements_and_lookups.js';
import { m0003ChargeLedgerEntry } from './0003_charge_ledger_entry.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002PlacementsAndLookups, m0003ChargeLedgerEntry];
