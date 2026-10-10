import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002Pass3SeedPermissions } from './0002_pass3_seed_permissions.js';
import { m0003Pass4SeedAuditView } from './0003_pass4_seed_audit_view.js';
import { m0004FsSeedPermissions } from './0004_fs_seed_permissions.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002Pass3SeedPermissions, m0003Pass4SeedAuditView, m0004FsSeedPermissions];
