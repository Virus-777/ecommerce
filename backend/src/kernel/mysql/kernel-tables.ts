/**
 * The kernel's own tables (docs/10-mysql-migration.md §12), the MySQL counterpart of kernel/mongo/schemas.ts.
 * Eleven tables, named `kernel_*`, created before any module's.
 *
 * Two things here are not just a translation of the MongoDB version:
 *
 * - **TTL indexes become a purge job.** MongoDB expired rows itself; MySQL has no such thing, so every table
 *   that used to expire carries an indexed timestamp and `kernel.purge-expired` deletes in batches (§12).
 * - **The job queue's two partial uniques** become functional keys, the same translation as everywhere else:
 *   one row may be queued and one running per job name, and rows in any other state are not compared.
 */

/** Every kernel table, in creation order */
export const KERNEL_TABLES = [
  'kernel_migrations',
  'kernel_counters',
  'kernel_ref_counters',
  'kernel_locks',
  'kernel_processed_events',
  'kernel_idempotency_keys',
  'kernel_webhook_events',
  'kernel_rate_limits',
  'kernel_jobs',
  'kernel_job_schedules',
  'kernel_job_boots',
] as const;

export type KernelTable = (typeof KERNEL_TABLES)[number];

const ID = 'VARCHAR(190) NOT NULL';
const UUID = 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL';
const SUFFIX = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';

/**
 * `CREATE TABLE` for each kernel table. Written out rather than generated from a spec, because these belong to
 * the kernel and not to any module: nothing in docs/api/spec describes them.
 */
export const kernelTableDdl: Record<KernelTable, string> = {
  // schema hashes and data-migration ids, as today
  kernel_migrations: `CREATE TABLE \`kernel_migrations\` (
  \`id\` ${ID},
  \`hash\` VARCHAR(64) NULL,
  \`at\` DATETIME(3) NOT NULL,
  PRIMARY KEY (\`id\`)
) ${SUFFIX}`,

  // identity columns and sequences; never rolled back, so a number taken by an aborted transaction is skipped
  kernel_counters: `CREATE TABLE \`kernel_counters\` (
  \`name\` ${ID},
  \`value\` BIGINT NOT NULL,
  PRIMARY KEY (\`name\`)
) ${SUFFIX}`,

  // MK-YYMMDD-NNNNN and the like: one counter per prefix and period
  kernel_ref_counters: `CREATE TABLE \`kernel_ref_counters\` (
  \`prefix\` VARCHAR(32) NOT NULL,
  \`period\` VARCHAR(16) NOT NULL,
  \`value\` BIGINT NOT NULL,
  PRIMARY KEY (\`prefix\`, \`period\`)
) ${SUFFIX}`,

  // §11.2 rule 5: lock(name) is an upsert whose row lock is held until the transaction commits
  kernel_locks: `CREATE TABLE \`kernel_locks\` (
  \`name\` ${ID},
  \`n\` BIGINT NOT NULL,
  PRIMARY KEY (\`name\`)
) ${SUFFIX}`,

  // claim() = INSERT; a duplicate means already claimed, and only the statement fails (§25). Purged after 90 days (D6)
  kernel_processed_events: `CREATE TABLE \`kernel_processed_events\` (
  \`module\` VARCHAR(64) NOT NULL,
  \`key\` VARCHAR(190) NOT NULL,
  \`at\` DATETIME(3) NOT NULL,
  PRIMARY KEY (\`module\`, \`key\`),
  KEY \`ix_kernel_processed_events_at\` (\`at\`)
) ${SUFFIX}`,

  // begin = INSERT, or on a duplicate a locked read and a compare, as today. Purged after 24 h
  kernel_idempotency_keys: `CREATE TABLE \`kernel_idempotency_keys\` (
  \`scope\` VARCHAR(64) NOT NULL,
  \`key\` VARCHAR(190) NOT NULL,
  \`request_hash\` VARCHAR(64) NOT NULL,
  \`status\` VARCHAR(16) NOT NULL,
  \`response_status\` SMALLINT NULL,
  \`response_body\` MEDIUMTEXT NULL,
  \`created_at\` DATETIME(3) NOT NULL,
  \`completed_at\` DATETIME(3) NULL,
  PRIMARY KEY (\`scope\`, \`key\`),
  KEY \`ix_kernel_idempotency_keys_created_at\` (\`created_at\`)
) ${SUFFIX}`,

  // a provider event is applied once. Purged after 90 days
  kernel_webhook_events: `CREATE TABLE \`kernel_webhook_events\` (
  \`provider\` VARCHAR(32) NOT NULL,
  \`event_id\` VARCHAR(190) NOT NULL,
  \`received_at\` DATETIME(3) NOT NULL,
  PRIMARY KEY (\`provider\`, \`event_id\`),
  KEY \`ix_kernel_webhook_events_received_at\` (\`received_at\`)
) ${SUFFIX}`,

  // one statement both counts and says "refused" (§12); the purge job deletes ended windows
  kernel_rate_limits: `CREATE TABLE \`kernel_rate_limits\` (
  \`scope\` VARCHAR(64) NOT NULL,
  \`key\` VARCHAR(190) NOT NULL,
  \`window_start\` DATETIME(3) NOT NULL,
  \`window_end\` DATETIME(3) NOT NULL,
  \`count\` BIGINT NOT NULL,
  PRIMARY KEY (\`scope\`, \`key\`, \`window_start\`),
  KEY \`ix_kernel_rate_limits_window_end\` (\`window_end\`)
) ${SUFFIX}`,

  // the two partial uniques keep the rule of one waiting and one running per job name
  kernel_jobs: `CREATE TABLE \`kernel_jobs\` (
  \`id\` ${UUID},
  \`name\` VARCHAR(190) NOT NULL,
  \`state\` VARCHAR(16) NOT NULL,
  \`run_at\` DATETIME(3) NOT NULL,
  \`attempts\` INT NOT NULL DEFAULT 0,
  \`max_attempts\` INT NOT NULL DEFAULT 1,
  \`lease_until\` DATETIME(3) NULL,
  \`started_at\` DATETIME(3) NULL,
  \`finished_at\` DATETIME(3) NULL,
  \`error\` TEXT NULL,
  \`created_at\` DATETIME(3) NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_kernel_jobs_queued\` ((IF(\`state\` = 'queued', \`name\`, NULL))),
  UNIQUE KEY \`uq_kernel_jobs_active\` ((IF(\`state\` = 'active', \`name\`, NULL))),
  KEY \`ix_kernel_jobs_due\` (\`state\`, \`run_at\`),
  KEY \`ix_kernel_jobs_finished_at\` (\`finished_at\`),
  CONSTRAINT \`ck_kernel_jobs_state\` CHECK (\`state\` IN ('queued', 'active', 'completed', 'failed'))
) ${SUFFIX}`,

  // "once across instances": only the instance whose UPDATE matched a row enqueues. `schedule` holds the
  // phrase from the spec ("every 10 min"), so an edited schedule is noticed and the next run recomputed.
  kernel_job_schedules: `CREATE TABLE \`kernel_job_schedules\` (
  \`job\` ${ID},
  \`schedule\` VARCHAR(190) NOT NULL,
  \`next_run_at\` DATETIME(3) NOT NULL,
  PRIMARY KEY (\`job\`)
) ${SUFFIX}`,

  // boot jobs run once per deploy. Purged after 90 days
  kernel_job_boots: `CREATE TABLE \`kernel_job_boots\` (
  \`job_deploy\` ${ID},
  \`at\` DATETIME(3) NOT NULL,
  PRIMARY KEY (\`job_deploy\`),
  KEY \`ix_kernel_job_boots_at\` (\`at\`)
) ${SUFFIX}`,
};

/** Every kernel CREATE TABLE, in order */
export const kernelDdl = (): string[] => KERNEL_TABLES.map((t) => kernelTableDdl[t]);

/**
 * What `kernel.purge-expired` deletes, and after how long (§12). MongoDB's TTL monitor did this; here one job
 * deletes in batches so the locks stay short.
 */
export const PURGE_RULES: { table: KernelTable; column: string; afterHours: number }[] = [
  { table: 'kernel_idempotency_keys', column: 'created_at', afterHours: 24 },
  { table: 'kernel_webhook_events', column: 'received_at', afterHours: 90 * 24 },
  { table: 'kernel_jobs', column: 'finished_at', afterHours: 7 * 24 },
  { table: 'kernel_job_boots', column: 'at', afterHours: 90 * 24 },
  // D6: events are in-process with no redelivery, so a key older than any retry window can never be used again
  { table: 'kernel_processed_events', column: 'at', afterHours: 90 * 24 },
];
