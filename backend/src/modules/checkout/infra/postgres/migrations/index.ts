import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002SessionColumns } from './0002_session_columns.js';
import { m0003FulfilledBy } from './0003_fulfilled_by.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002SessionColumns, m0003FulfilledBy];
