import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002Pass3 } from './0002_pass3.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002Pass3];
