import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002LookupIndexes } from './0002_lookup_indexes.js';
import { m0003ReauthPurpose } from './0003_reauth_purpose.js';
import { m0004SessionActivity } from './0004_session_activity.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002LookupIndexes, m0003ReauthPurpose, m0004SessionActivity];
