import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002OfficialStoreId } from './0002_official_store_id.js';
import { m0003ConversationKeyNullsNotDistinct } from './0003_conversation_key_nulls_not_distinct.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002OfficialStoreId, m0003ConversationKeyNullsNotDistinct];
