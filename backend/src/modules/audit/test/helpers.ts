/** Shared helpers for the audit behaviour tests. */
import type { FastifyInstance } from 'fastify';
import { newId } from '../../../kernel/lib/ids.js';
import type { Table } from '../../../kernel/mongo/index.js';
import { spec, type AuditDb, type AuditPublicApi, type RecordInput } from '../../../spec/audit.js';
import { schemas } from '../schema.js';

export const auditApi = (app: FastifyInstance) => app.kernel.boot.apis.get('audit') as AuditPublicApi;

export const staffActor = (name = 'Priya Nair', id = newId()) => ({ kind: 'staff' as const, id, name });

/** A minimal valid entry; override what the test cares about. */
export function entry(over: Partial<RecordInput> = {}): RecordInput {
  return {
    actor: staffActor(),
    action: 'finance.hold.released',
    actionLabel: 'Released payout hold',
    module: 'finance',
    category: 'financial',
    target: { type: 'hold', id: newId(), ref: 'HLD-261009-0001', label: 'Casa Verde Home' },
    reason: 'Delivery confirmed',
    ...over,
  };
}

/**
 * A collection of the module as its repository reads it (rows in spec shape). Writing through it changes rows behind
 * the app's back, as someone with database access would.
 */
export function auditTable<T extends keyof AuditDb & string>(app: FastifyInstance, name: T): Table<AuditDb[T]> {
  return app.kernel.mongo.module('audit', spec.collections, schemas).table<AuditDb[T]>(name);
}

export async function waitForEvents(app: FastifyInstance) {
  await app.kernel.events.drain();
}
