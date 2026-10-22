/**
 * Daily rewards rules (pure, no I/O): the check-in schedule and streak, the week strip, task states, keys and the
 * limits of the admin inputs.
 */
import type { CheckInDay, RewardTask } from '../../../spec/rewards.js';

/** Default schedule: points for days 1 to 7; day 7 is the bonus */
export const DEFAULT_SCHEDULE: readonly number[] = [10, 10, 15, 15, 20, 20, 100];
export const WEEK = 7;
export const MAX_DAY_POINTS = 10_000;
/** Tasks the app reports itself (POST /tasks/{key}/progress); the others count from events */
export const REPORTABLE: readonly string[] = ['visit_store', 'share_product'];
export const TASK_KINDS = ['visit_store', 'share_product', 'write_review', 'place_order'] as const;
export const TINTS = ['deal', 'brand', 'info', 'neutral'] as const;

/** The calendar day before or after a YYYY-MM-DD day */
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Seven whole points (0 to 10,000), or null when the list isn't one */
export function scheduleOf(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length !== WEEK) return null;
  return v.every((n) => Number.isInteger(n) && n >= 0 && n <= MAX_DAY_POINTS) ? (v as number[]) : null;
}

/** A customer's streak as it stands today: the days in a row checked in (0 when the streak broke) */
export function currentStreak(a: { streak: number; lastCheckIn: string | null }, today: string): number {
  return a.lastCheckIn === today || a.lastCheckIn === addDays(today, -1) ? a.streak : 0;
}

/**
 * The day of the 7-day cycle today's check-in is (or was): the day after yesterday's continues the streak (after day 7
 * comes day 1 again); a missed day starts again at day 1.
 */
export function cycleDay(a: { streak: number; lastCheckIn: string | null }, today: string): number {
  if (a.lastCheckIn === today) return Math.max(1, a.streak);
  if (a.lastCheckIn === addDays(today, -1)) return (a.streak % WEEK) + 1;
  return 1;
}

/** The week strip: days before today's position done, today's done once checked in, the rest open */
export function weekOf(schedule: readonly number[], position: number, checkedInToday: boolean): CheckInDay[] {
  return schedule.map((points, i) => {
    const day = i + 1;
    const state: CheckInDay['state'] = day < position || (day === position && checkedInToday) ? 'done' : day === position ? 'today' : 'open';
    return { day, label: day === position ? 'Today' : `Day ${day}`, points, state, bonus: day === WEEK };
  });
}

/** e.g. 3 more days to the 100-point bonus on day 7; null once the bonus is in (or there is none) */
export function bonusLabel(schedule: readonly number[], position: number, checkedInToday: boolean): string | null {
  const bonus = schedule[WEEK - 1] ?? 0;
  if (bonus <= 0) return null;
  const left = WEEK - position + (checkedInToday ? 0 : 1);
  if (left <= 0) return null;
  if (left === 1 && !checkedInToday) return `Check in today for the ${bonus.toLocaleString('en-US')}-point bonus`;
  return `${left} more ${left === 1 ? 'day' : 'days'} to the ${bonus.toLocaleString('en-US')}-point bonus on day ${WEEK}`;
}

/** A task's state on a day from its progress */
export function taskState(count: number, target: number, claimed: boolean): RewardTask['state'] {
  if (claimed) return 'claimed';
  return count >= target ? 'ready' : 'todo';
}

/** A task key from the given key or the title: lowercase words joined by hyphens */
export const keyOf = (given: string | null | undefined, title: string) =>
  (given?.trim() || title)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
export const isValidKey = (key: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) && key.length <= 60;

/** Title of a check-in ledger entry */
export const checkInTitle = (day: number) => (day === WEEK ? `Day ${day} check-in bonus` : `Day ${day} check-in`);
