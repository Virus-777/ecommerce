import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/index.js';
import { parseSchedule } from '../jobs/index.js';
import { dateInZone, zonedDayRange, zonedTimeToUtc } from './clock.js';
import { isUuid, newId } from './ids.js';
import { allocate, format, money, multiply } from './money.js';
import { decodeCursor, encodeCursor, pageOf, toPageRequest } from './pagination.js';
import { createStateMachine } from './state-machine.js';

describe('state machines', () => {
  const m = createStateMachine('Ad campaign', {
    field: 'Campaign.status',
    initial: 'draft',
    transitions: [
      ['draft', 'submit', 'in_review'],
      ['in_review', 'approve', 'scheduled'],
      ['scheduled', 'start', 'live'],
      ['live', 'pause', 'paused'],
      ['paused', 'resume', 'live'],
      ['paused', 'resume', 'scheduled'],
    ],
  });

  it('moves along declared transitions', () => {
    expect(m.next('draft', 'submit')).toBe('in_review');
    expect(m.eventsFrom('live')).toEqual(['pause']);
  });

  it('rejects illegal moves with ILLEGAL_TRANSITION and the allowed events', () => {
    expect(() => m.next('draft', 'pause')).toThrow(
      expect.objectContaining({ code: 'ILLEGAL_TRANSITION', status: 409, details: expect.objectContaining({ from: 'draft', event: 'pause', allowed: ['submit'] }) }),
    );
  });

  it('makes the service choose the target of a guarded transition', () => {
    expect(m.targets('paused', 'resume')).toEqual(['live', 'scheduled']);
    expect(() => m.next('paused', 'resume')).toThrow(/guarded/);
    expect(m.next('paused', 'resume', 'scheduled')).toBe('scheduled');
    expect(() => m.next('paused', 'resume', 'draft')).toThrow(AppError);
  });
});

describe('money', () => {
  it('is integer minor units', () => {
    expect(() => money(1.5)).toThrow(AppError);
    expect(format(money(18900))).toBe('$189.00');
    expect(multiply(money(999), 0.125)).toEqual(money(125));
  });

  it('allocates without losing a cent', () => {
    const parts = allocate(money(1000), [1, 1, 1]);
    expect(parts.map((p) => p.amount)).toEqual([334, 333, 333]);
    expect(parts.reduce((a, p) => a + p.amount, 0)).toBe(1000);
  });
});

describe('ids', () => {
  it('are sortable UUIDv7 strings', () => {
    const a = newId(1_700_000_000_000);
    const b = newId(1_700_000_000_001);
    expect(isUuid(a)).toBe(true);
    expect(a[14]).toBe('7');
    expect(a < b).toBe(true);
  });
});

describe('market time', () => {
  it('converts market wall-clock times across daylight saving', () => {
    expect(zonedTimeToUtc('2026-01-15', '23:59', 'America/Los_Angeles').toISOString()).toBe('2026-01-16T07:59:00.000Z');
    expect(zonedTimeToUtc('2026-07-15', '02:00', 'America/Los_Angeles').toISOString()).toBe('2026-07-15T09:00:00.000Z');
    expect(dateInZone(new Date('2026-03-01T05:00:00Z'), 'America/Los_Angeles')).toBe('2026-02-28');
  });

  it('turns a range of market days into instants (a filter "today" includes the market evening, not UTC midnight)', () => {
    const tz = 'America/Los_Angeles';
    const today = zonedDayRange({ from: '2026-10-10', to: '2026-10-10' }, tz);
    expect(today.start!.toISOString()).toBe('2026-10-10T07:00:00.000Z');
    expect(today.end!.toISOString()).toBe('2026-10-11T07:00:00.000Z');
    const evening = new Date('2026-10-11T05:09:00Z'); // 22:09 on the 10th in Los Angeles, already the 11th in UTC
    expect(evening >= today.start! && evening < today.end!).toBe(true);
    // the day the clocks go back is 25 hours long
    const fallBack = zonedDayRange({ from: '2026-11-01', to: '2026-11-01' }, tz);
    expect(fallBack.end!.getTime() - fallBack.start!.getTime()).toBe(25 * 3_600_000);
    expect(zonedDayRange({}, tz)).toEqual({});
  });
});

describe('pagination', () => {
  it('pages by cursor (app) and by page number (website)', () => {
    const all = Array.from({ length: 30 }, (_, i) => i);
    const first = pageOf(all, toPageRequest({ limit: 10 }));
    expect(first.items).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const second = pageOf(all, toPageRequest({ cursor: first.nextCursor!, limit: 10 }));
    expect(second.items[0]).toBe(10);
    const page3 = pageOf(all, toPageRequest({ page: 3, limit: 10 }));
    expect(page3).toMatchObject({ page: 3, totalPages: 3, total: 30, nextCursor: null });
  });

  it('defaults to 24 and caps at 100', () => {
    expect(toPageRequest(undefined)).toEqual({ mode: 'cursor', cursor: null, limit: 24 });
    expect(toPageRequest({ limit: 500 }).limit).toBe(100);
    expect(() => toPageRequest({ cursor: 'x', page: 2 })).toThrow(AppError);
  });

  it('rejects cursors it did not issue', () => {
    expect(decodeCursor(encodeCursor(['2026-01-01', 'id']))).toEqual(['2026-01-01', 'id']);
    expect(() => decodeCursor('not-a-cursor')).toThrow(AppError);
  });
});

describe('job schedules from the spec', () => {
  it.each([
    ['every 10 min', { kind: 'interval', ms: 600_000 }],
    ['every 30 s', { kind: 'interval', ms: 30_000 }],
    ['hourly', { kind: 'interval', ms: 3_600_000 }],
    ['daily 02:00 market time', { kind: 'daily', time: '02:00' }],
    ['nightly 03:30 market time', { kind: 'daily', time: '03:30' }],
    ['monthly, 1st 03:00 market time', { kind: 'monthly', time: '03:00' }],
    ['on boot', { kind: 'boot' }],
    ['every 30 min during business hours (when enabled)', { kind: 'interval', ms: 1_800_000, window: 'business-hours' }],
  ])('%s', (text, expected) => {
    expect(parseSchedule(text)).toEqual(expected);
  });

  it('refuses phrases it cannot time, so no job silently never runs', () => {
    expect(() => parseSchedule('per payoutSchedule at cutoff (e.g. Thu 23:59 PT)')).toThrow(/not one the scheduler can time/);
    expect(() => parseSchedule('queue worker')).toThrow(/not one the scheduler can time/);
  });
});
