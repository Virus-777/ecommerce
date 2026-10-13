/**
 * The conversation key: `unique nulls not distinct (kind, customer_id, seller_id, application_id, order_id,
 * order_item_id, return_id) where kind <> 'support'` (a partial index on kind in (order, staff_seller), the other
 * kinds), and `(kind, customer_id, order_id, case_id) where kind = 'support'`. MongoDB treats nulls in a unique
 * index as equal, which is what nulls not distinct means.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { buildTestApp } from '../../../testing/app.js';
import { spec } from '../../../spec/messaging.js';
import { schemas } from '../schema.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildTestApp({ only: ['messaging'] });
});
afterAll(async () => {
  await app?.close();
});

const conversations = () => app.kernel.mongo.module('messaging', spec.collections, schemas).table<any>('conversations');
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes));

function conversation(over: Record<string, unknown>) {
  return {
    id: newId(),
    kind: 'staff_seller',
    customer_id: null,
    guest_session_id: null,
    seller_id: null,
    order_id: null,
    order_item_id: null,
    return_id: null,
    case_id: null,
    application_id: null,
    started_by_staff_id: null,
    subject: { kind: 'seller_account', title: 'Account' },
    status: 'open',
    locked_reason: null,
    locked_by_enforcement_id: null,
    reply_state: 'none',
    reply_due_at: null,
    awaiting_since: null,
    created_at: at(0),
    last_message_at: at(0),
    archive_after: null,
    ...over,
  };
}

const insert = (over: Record<string, unknown>) => conversations().insert(conversation(over));
const refused = async (over: Record<string, unknown>) => {
  const err = await insert(over).catch((e: unknown) => e);
  expect(err, 'a duplicate key').toBeInstanceOf(Error);
  expect((err as { code?: number }).code).toBe(11000);
};

describe('conversation key', () => {
  it('refuses a second conversation with the same key, null key columns included', async () => {
    const sellerId = newId();
    await insert({ seller_id: sellerId });
    await refused({ seller_id: sellerId });
    // another kind or application is another conversation
    await insert({ seller_id: sellerId, application_id: newId() });
    // pass 3: the case is a link, not part of the key, except for support conversations
    await refused({ seller_id: sellerId, case_id: newId() });
    const customerId = newId();
    const orderId = newId();
    await insert({ kind: 'order', customer_id: customerId, seller_id: sellerId, order_id: orderId });
    await refused({ kind: 'order', customer_id: customerId, seller_id: sellerId, order_id: orderId, case_id: newId() });
    await insert({ kind: 'support', customer_id: customerId, order_id: orderId, case_id: newId() });
    await insert({ kind: 'support', customer_id: customerId, order_id: orderId, case_id: newId() });
    const caseId = newId();
    await insert({ kind: 'support', customer_id: customerId, order_id: orderId, case_id: caseId });
    await refused({ kind: 'support', customer_id: customerId, order_id: orderId, case_id: caseId });
  });

  it('refuses a kind outside the value list (the partial key index covers every other kind)', async () => {
    const err = await insert({ kind: 'broadcast', seller_id: newId() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });
});
