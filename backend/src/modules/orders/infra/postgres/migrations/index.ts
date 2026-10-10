import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002ReservationAndCategory } from './0002_reservation_and_category.js';
import { m0003AttemptsAndSearch } from './0003_attempts_and_search.js';
import { m0004OrderFacts } from './0004_order_facts.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002ReservationAndCategory, m0003AttemptsAndSearch, m0004OrderFacts];
