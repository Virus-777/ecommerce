import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002OfficialStoreId } from './0002_official_store_id.js';
import { m0003ConversationKeyNullsNotDistinct } from './0003_conversation_key_nulls_not_distinct.js';
import { m0004Pass3KeysGuestsAliases } from './0004_pass3_keys_guests_aliases.js';
import { m0005Pass4SellerReplyStats } from './0005_pass4_seller_reply_stats.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002OfficialStoreId, m0003ConversationKeyNullsNotDistinct, m0004Pass3KeysGuestsAliases, m0005Pass4SellerReplyStats];
