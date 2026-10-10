import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002GuestSavedUnique } from './0002_guest_saved_unique.js';
import { m0003ItemCondition } from './0003_item_condition.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002GuestSavedUnique, m0003ItemCondition];
