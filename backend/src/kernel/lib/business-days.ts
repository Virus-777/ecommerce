/**
 * Business days of the market for deadlines that must be computed without waiting (view mappers, transactions):
 * the market's business calendar — business hours and closures, from the settings module — kept for a few minutes
 * and used synchronously. Until it is loaded, without the settings module, or when no business hours are set (the
 * calendar then adds nothing), Monday to Friday in the market time zone. Every result keeps the local time of day.
 */
import { zoneOffsetMs } from './clock.js';

const DAY = 86_400_000;

/** The calendar part this needs (settings.businessCalendar()) */
export interface CalendarSource {
  addBusinessDays(from: string, days: number): string;
}

/** n weekdays (Monday–Friday in the time zone) after `from`, same time of day */
export function addWeekdays(from: Date, n: number, timeZone: string): Date {
  let t = new Date(from.getTime());
  let left = Math.max(0, Math.round(n));
  while (left > 0) {
    t = new Date(t.getTime() + DAY);
    const wd = new Date(t.getTime() + zoneOffsetMs(t, timeZone)).getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return t;
}

export class BusinessDays {
  #calendar: CalendarSource | undefined;
  #loadedAt = Number.NEGATIVE_INFINITY;
  #loading: Promise<void> | undefined;

  constructor(
    private readonly o: {
      /** the settings module's calendar, undefined when the module is off */
      load: () => Promise<CalendarSource | undefined>;
      timeZone: () => string;
      now: () => Date;
      /** how long a loaded calendar is used before it is read again (closures change rarely) */
      ttlMs?: number;
      onError?: (err: unknown) => void;
    },
  ) {}

  /** Loads the calendar when it is missing or stale (await it where a fresh calendar matters, e.g. after a start) */
  refresh(): Promise<void> {
    if (this.o.now().getTime() - this.#loadedAt < (this.o.ttlMs ?? 5 * 60_000)) return Promise.resolve();
    this.#loading ??= this.o
      .load()
      .then((cal) => {
        this.#calendar = cal;
        this.#loadedAt = this.o.now().getTime();
      })
      .catch((err) => this.o.onError?.(err))
      .finally(() => {
        this.#loading = undefined;
      });
    return this.#loading;
  }

  /** n business days after `from`; a stale calendar is refreshed in the background for the next call */
  add(from: Date, n: number): Date {
    void this.refresh();
    const days = Math.max(0, Math.round(n));
    if (this.#calendar && days > 0) {
      try {
        const at = new Date(this.#calendar.addBusinessDays(from.toISOString(), days));
        // no business hours set: the calendar adds nothing; weekdays instead
        if (at.getTime() > from.getTime()) return at;
      } catch (err) {
        this.o.onError?.(err);
      }
    }
    return addWeekdays(from, days, this.o.timeZone());
  }
}
