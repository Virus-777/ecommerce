/**
 * Mongoose schema helpers for the generated module schemas (src/modules/<m>/infra/mongo/schema.ts, docs/04 §3) and
 * the kernel's own collections.
 *
 * Meaning kept from PostgreSQL: NOT NULL is "not null" (an empty string is a value: Mongoose's required would refuse
 * it), so `required` only checks for null; custom validators let null through (nullable columns).
 */
import { Schema, type SchemaOptions } from 'mongoose';

Schema.Types.String.checkRequired((v: unknown) => v !== null && v !== undefined);

/** Options every collection schema shares: the spec decides the fields, the kernel creates collections and indexes */
export function collectionOptions(collection: string, o: { generatedId?: boolean } = {}): SchemaOptions {
  return {
    collection,
    versionKey: false,
    // unknown fields are a bug: refuse them in writes and in filters
    strict: 'throw',
    strictQuery: 'throw',
    autoIndex: false,
    autoCreate: false,
    id: false,
    // empty objects in json fields stay
    minimize: false,
    _id: o.generatedId ?? false,
  };
}

/** int / bigint columns: whole numbers */
export const integer = { validator: (v: unknown) => v === null || v === undefined || Number.isInteger(v), message: '{PATH} must be a whole number' };
/** check > 0 */
export const positive = { validator: (v: unknown) => v === null || v === undefined || (typeof v === 'number' && v > 0), message: '{PATH} must be above 0' };
/** date columns: YYYY-MM-DD */
export const DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------------------------------------------------------------- kernel collections (kernel.*) */

const kernel = (name: string, fields: Record<string, unknown>, indexes: [Record<string, 1 | -1>, Record<string, unknown>][] = []) => {
  const s = new Schema(fields, collectionOptions(`kernel.${name}`));
  for (const [key, options] of indexes) s.index(key, options);
  return s;
};

export const kernelSchemas = {
  /** Applied schema hashes and data migrations */
  migrations: kernel('migrations', { _id: { type: String, required: true }, hash: String, at: { type: Date, required: true } }),
  /** Named counters (identity columns, sequences) */
  counters: kernel('counters', { _id: { type: String, required: true }, value: { type: Number, required: true } }),
  /** Named locks (ModuleStore.lock) */
  locks: kernel('locks', { _id: { type: String, required: true }, n: { type: Number, required: true } }),
  /** Inbox: what each module already handled (ctx.mongo.claim) */
  processed_events: kernel('processed_events', { _id: { type: String, required: true }, module: { type: String, required: true }, key: { type: String, required: true }, at: { type: Date, required: true } }, [
    [{ at: 1 }, { name: 'at' }],
  ]),
  /** Human references MK-YYMMDD-NNNNN … */
  ref_counters: kernel('ref_counters', { _id: { type: String, required: true }, prefix: { type: String, required: true }, period: { type: String, required: true }, value: { type: Number, required: true } }),
  /** Idempotency-Key replay store, kept 24 hours */
  idempotency_keys: kernel(
    'idempotency_keys',
    {
      _id: { type: String, required: true },
      scope: { type: String, required: true },
      key: { type: String, required: true },
      request_hash: { type: String, required: true },
      status: { type: String, required: true, enum: ['in_progress', 'completed'] },
      response_status: Number,
      response_body: String,
      created_at: { type: Date, required: true },
      completed_at: Date,
    },
    [[{ created_at: 1 }, { name: 'created_at_ttl', expireAfterSeconds: 24 * 3600 }]],
  ),
  /** Provider events already processed, kept 90 days */
  webhook_events: kernel('webhook_events', { _id: { type: String, required: true }, provider: { type: String, required: true }, event_id: { type: String, required: true }, received_at: { type: Date, required: true } }, [
    [{ received_at: 1 }, { name: 'received_at_ttl', expireAfterSeconds: 90 * 86_400 }],
  ]),
  /** Rate-limit windows, removed when they end */
  rate_limits: kernel(
    'rate_limits',
    { _id: { type: String, required: true }, scope: { type: String, required: true }, key: { type: String, required: true }, window_start: { type: Date, required: true }, window_end: { type: Date, required: true }, count: { type: Number, required: true } },
    [[{ window_end: 1 }, { name: 'window_end_ttl', expireAfterSeconds: 0 }]],
  ),
  /** The job queue (kernel/jobs/mongo.ts): at most one waiting and one running run per job */
  jobs: kernel(
    'jobs',
    {
      _id: { type: String, required: true },
      name: { type: String, required: true },
      state: { type: String, required: true, enum: ['queued', 'active', 'completed', 'failed'] },
      run_at: { type: Date, required: true },
      attempts: { type: Number, required: true },
      max_attempts: { type: Number, required: true },
      lease_until: Date,
      started_at: Date,
      finished_at: Date,
      error: String,
      created_at: { type: Date, required: true },
    },
    [
      [{ name: 1 }, { name: 'one_queued', unique: true, partialFilterExpression: { state: 'queued' } }],
      [{ name: 1 }, { name: 'one_active', unique: true, partialFilterExpression: { state: 'active' } }],
      [{ state: 1, run_at: 1 }, { name: 'due' }],
      [{ finished_at: 1 }, { name: 'finished_ttl', expireAfterSeconds: 7 * 86_400 }],
    ],
  ),
  /** Next tick of each scheduled job */
  job_schedules: kernel('job_schedules', { _id: { type: String, required: true }, schedule: { type: String, required: true }, next_run_at: { type: Date, required: true } }),
  /** "on boot" jobs already sent for a deploy */
  job_boots: kernel('job_boots', { _id: { type: String, required: true }, at: { type: Date, required: true } }, [[{ at: 1 }, { name: 'at_ttl', expireAfterSeconds: 90 * 86_400 }]]),
};

export type KernelCollection = keyof typeof kernelSchemas;
