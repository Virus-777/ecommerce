import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002Pass4Columns } from './0002_pass4_columns.js';
import { m0003FulfilledByMarketly } from './0003_fulfilled_by_marketly.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002Pass4Columns, m0003FulfilledByMarketly];
