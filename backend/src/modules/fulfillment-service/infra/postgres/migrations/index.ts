import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002ExampleSchedule } from './0002_example_schedule.js';
import { m0003ChargeLedgerEntry } from './0003_charge_ledger_entry.js';
import { m0004FulfilledByMarketly } from './0004_fulfilled_by_marketly.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002ExampleSchedule, m0003ChargeLedgerEntry, m0004FulfilledByMarketly];
