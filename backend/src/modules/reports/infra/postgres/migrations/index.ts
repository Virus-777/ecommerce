import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002OfficialStoreIdAndInbox } from './0002_official_store_id_and_inbox.js';
import { m0003Pass3OwnersSchedulesRefunds } from './0003_pass3_owners_schedules_refunds.js';
import { m0004Pass4LookupsOwnerHistoryOrderFacts } from './0004_pass4_lookups_owner_history_order_facts.js';
import { m0005FulfilledByMarketly } from './0005_fulfilled_by_marketly.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002OfficialStoreIdAndInbox, m0003Pass3OwnersSchedulesRefunds, m0004Pass4LookupsOwnerHistoryOrderFacts, m0005FulfilledByMarketly];
