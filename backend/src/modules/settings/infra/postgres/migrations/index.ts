import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002RemovedFinanceThresholds } from './0002_removed_finance_thresholds.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002RemovedFinanceThresholds];
