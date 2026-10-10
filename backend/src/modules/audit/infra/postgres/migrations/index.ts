import type { Migration } from '../../../../../kernel/migrations/index.js';
import { m0001Init } from './0001_init.js';
import { m0002AppendOnly } from './0002_append_only.js';
import { m0003Checkpoints } from './0003_checkpoints.js';
import { m0004MonthlyPartitions } from './0004_monthly_partitions.js';

/** In order. Never edit an applied migration: add the next file and bump the module version. */
export const migrations: Migration[] = [m0001Init, m0002AppendOnly, m0003Checkpoints, m0004MonthlyPartitions];
