import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002OfficialStoreId } from './0002_official_store_id.js';
import { m0003Pass3 } from './0003_pass3.js';
import { m0004Pass4 } from './0004_pass4.js';
import { m0005FulfilledBy } from './0005_fulfilled_by.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002OfficialStoreId, m0003Pass3, m0004Pass4, m0005FulfilledBy];
