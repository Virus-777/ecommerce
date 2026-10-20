import { describe, expect, it } from 'vitest';
import { addWeekdays, BusinessDays, type CalendarSource } from './business-days.js';

const TZ = 'America/Los_Angeles';
// Friday 2026-11-20, 10:00 Pacific
const FRI = new Date('2026-11-20T18:00:00.000Z');

/** A market calendar: Monday–Saturday open, Thanksgiving (Thu 2026-11-26) closed */
const calendar: CalendarSource = {
  addBusinessDays(from, days) {
    let t = new Date(from);
    let left = days;
    while (left > 0) {
      t = new Date(t.getTime() + 86_400_000);
      const day = new Date(t.getTime() - 8 * 3_600_000);
      if (day.getUTCDay() !== 0 && day.toISOString().slice(0, 10) !== '2026-11-26') left--;
    }
    return t.toISOString();
  },
};

describe('business days', () => {
  it('weekdays in the market time zone, same time of day', () => {
    expect(addWeekdays(FRI, 1, TZ).toISOString()).toBe('2026-11-23T18:00:00.000Z'); // Monday
    expect(addWeekdays(FRI, 0, TZ).toISOString()).toBe(FRI.toISOString());
  });

  it("use the market's calendar once loaded: its open days, skipping closures", async () => {
    const days = new BusinessDays({ load: async () => calendar, timeZone: () => TZ, now: () => FRI });
    await days.refresh();
    expect(days.add(FRI, 1).toISOString()).toBe('2026-11-21T18:00:00.000Z'); // Saturday is open in this market
    expect(days.add(new Date('2026-11-25T18:00:00.000Z'), 1).toISOString()).toBe('2026-11-27T18:00:00.000Z'); // over Thanksgiving
  });

  it('count weekdays before the calendar is loaded, without the settings module, and when no business hours are set', async () => {
    const before = new BusinessDays({ load: async () => calendar, timeZone: () => TZ, now: () => FRI });
    expect(before.add(FRI, 1).toISOString()).toBe('2026-11-23T18:00:00.000Z');
    const off = new BusinessDays({ load: async () => undefined, timeZone: () => TZ, now: () => FRI });
    await off.refresh();
    expect(off.add(FRI, 1).toISOString()).toBe('2026-11-23T18:00:00.000Z');
    // no business hours: the settings calendar adds nothing
    const noHours = new BusinessDays({ load: async () => ({ addBusinessDays: (from) => from }), timeZone: () => TZ, now: () => FRI });
    await noHours.refresh();
    expect(noHours.add(FRI, 2).toISOString()).toBe('2026-11-24T18:00:00.000Z');
  });

  it('read the calendar again after the window, never more often', async () => {
    let now = FRI;
    let loads = 0;
    const days = new BusinessDays({ load: async () => (loads++, calendar), timeZone: () => TZ, now: () => now, ttlMs: 60_000 });
    await days.refresh();
    await days.refresh();
    expect(loads).toBe(1);
    now = new Date(FRI.getTime() + 61_000);
    await days.refresh();
    expect(loads).toBe(2);
  });
});
