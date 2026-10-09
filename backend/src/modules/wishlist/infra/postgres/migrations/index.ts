import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002ItemKeyNullsNotDistinct } from './0002_item_key_nulls_not_distinct.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002ItemKeyNullsNotDistinct];
