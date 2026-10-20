import { describe, expect, it } from 'vitest';
import { addCalendarDays, addMonths, isIsoDate, isTimeZone } from './dates.js';

describe('dates', () => {
  it('accept real calendar dates only', () => {
    expect(isIsoDate('2026-10-20')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-10-2', '20261020', '', null, 20261020]) expect(isIsoDate(bad)).toBe(false);
  });

  it('add calendar days across months and years', () => {
    expect(addCalendarDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('add months, keeping the day or clamping it to a shorter month', () => {
    expect(addMonths(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonths(new Date('2028-01-31T10:00:00Z'), 1).toISOString()).toBe('2028-02-29T10:00:00.000Z');
    expect(addMonths(new Date('2026-10-15T00:00:00Z'), 13).toISOString()).toBe('2027-11-15T00:00:00.000Z');
    expect(addMonths(new Date('2026-03-31T00:00:00Z'), -1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });

  it('accept IANA zone names and UTC, not abbreviations or offsets', () => {
    expect(isTimeZone('America/Los_Angeles')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    for (const bad of ['EST', 'GMT', '+05:00', 'Mars/Olympus', '', null]) expect(isTimeZone(bad)).toBe(false);
  });
});
