import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002Pass3 } from './0002_pass3.js';
import { m0003Pass4 } from './0003_pass4.js';
import { m0004TemplateGrants } from './0004_template_grants.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002Pass3, m0003Pass4, m0004TemplateGrants];
