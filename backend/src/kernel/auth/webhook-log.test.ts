/**
 * The webhook replay log: the same contract in MongoDB (kernel.webhook_events) and MySQL
 * (`kernel_webhook_events`). A provider that sends an event twice must change nothing the second time, so
 * what this has to get right is that recording an event already recorded is the ordinary case and not an
 * error — on MySQL that is a duplicate key, deliberately caught.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testMongo } from '../../testing/mongo.js';
import { testMysql } from '../../testing/mysql.js';
import type { MongoStore } from '../mongo/index.js';
import { migrateMongo } from '../mongo/schema.js';
import type { MysqlStore } from '../mysql/index.js';
import { mongoWebhookEventLog, mysqlWebhookEventLog, type WebhookEventLog } from './chain.js';

let mongo: MongoStore;
let mysql: MysqlStore;

beforeAll(async () => {
  mongo = await testMongo();
  await migrateMongo(mongo, []);
  mysql = await testMysql();
});
afterAll(async () => {
  await mongo?.close();
  await mysql?.close();
});

describe.each([
  ['mongo', () => mongoWebhookEventLog(mongo)],
  ['mysql', () => mysqlWebhookEventLog(mysql)],
])('%s webhook log', (_name, make) => {
  let log: WebhookEventLog;
  beforeAll(() => {
    log = make();
  });

  it('has not seen an event until it is recorded', async () => {
    expect(await log.seen('stripe', 'evt_1')).toBe(false);
    await log.record('stripe', 'evt_1');
    expect(await log.seen('stripe', 'evt_1')).toBe(true);
  });

  it('records the same event twice without complaining', async () => {
    await log.record('stripe', 'evt_2');
    await expect(log.record('stripe', 'evt_2')).resolves.toBeUndefined();
    expect(await log.seen('stripe', 'evt_2')).toBe(true);
  });

  it('keeps providers apart: the same event id from two providers is two events', async () => {
    await log.record('stripe', 'shared');
    expect(await log.seen('paypal', 'shared')).toBe(false);
    await log.record('paypal', 'shared');
    expect(await log.seen('stripe', 'shared')).toBe(true);
    expect(await log.seen('paypal', 'shared')).toBe(true);
  });

  it('records several at once, as a provider replaying a batch would', async () => {
    await Promise.all(Array.from({ length: 8 }, () => log.record('stripe', 'evt_burst')));
    expect(await log.seen('stripe', 'evt_burst')).toBe(true);
  });
});
