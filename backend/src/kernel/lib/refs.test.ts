/**
 * Human reference numbers (MK-260504-00001), from MongoDB (`kernel.ref_counters`) and from MySQL
 * (`kernel_ref_counters`). One contract for both: the numbering starts at 1, counts up, is padded to the
 * asked-for width, restarts every market day unless the caller says otherwise, and never hands the same
 * number to two callers at once — which is the whole reason these live in the database and not in a variable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testMongo } from '../../testing/mongo.js';
import { testMysql } from '../../testing/mysql.js';
import type { MongoStore } from '../mongo/index.js';
import { migrateMongo } from '../mongo/schema.js';
import type { MysqlStore } from '../mysql/index.js';
import { mongoRefGenerator, mysqlRefGenerator, type RefGenerator } from './refs.js';

const ZONE = 'America/Los_Angeles';
// 10:00 UTC is 03:00 in the market, so the market day is the 4th and the reference carries 260504
let now = Date.parse('2026-05-04T10:00:00Z');
const clock = { now: () => new Date(now) };

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
  ['mongo', () => mongoRefGenerator(mongo, clock, ZONE)],
  ['mysql', () => mysqlRefGenerator(mysql, clock, ZONE)],
])('%s reference numbers', (_name, make) => {
  let refs: RefGenerator;
  beforeAll(() => {
    now = Date.parse('2026-05-04T10:00:00Z');
    refs = make();
  });

  it('numbers from one, with the market day and five digits', async () => {
    expect(await refs.next('MK')).toBe('MK-260504-00001');
    expect(await refs.next('MK')).toBe('MK-260504-00002');
  });

  it('counts each prefix on its own', async () => {
    expect(await refs.next('RT')).toBe('RT-260504-00001');
    expect(await refs.next('MK')).toBe('MK-260504-00003');
  });

  it('restarts the numbering on the next market day', async () => {
    now = Date.parse('2026-05-05T10:00:00Z');
    expect(await refs.next('MK')).toBe('MK-260505-00001');
    // and the day before keeps its own count: a reference is never handed out twice
    now = Date.parse('2026-05-04T10:00:00Z');
    expect(await refs.next('MK')).toBe('MK-260504-00004');
  });

  it('counts a day-less prefix across days, to the asked-for width', async () => {
    expect(await refs.next('PRD', { daily: false })).toBe('PRD-00001');
    now = Date.parse('2026-05-06T10:00:00Z');
    expect(await refs.next('PRD', { daily: false })).toBe('PRD-00002');
    expect(await refs.next('CU', { daily: false, digits: 6 })).toBe('CU-000001');
  });

  it('hands the same number to nobody twice, however many ask at once', async () => {
    const taken = await Promise.all(Array.from({ length: 25 }, () => refs.next('PO')));
    expect(new Set(taken).size).toBe(25);
    expect([...taken].sort()).toEqual(Array.from({ length: 25 }, (_, i) => `PO-260506-${String(i + 1).padStart(5, '0')}`));
  });
});
