// Dates and times as all three apps show them: Pacific Time (the market's time zone). A calendar date the API sends as
// YYYY-MM-DD is shown as that day, never shifted by the time zone; an instant is shown in Pacific Time.

/** Market time: every screen shows times in Pacific Time. */
export const TZ = 'America/Los_Angeles';

const fmt = (iso: string | Date, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('en-US', { timeZone: TZ, ...o });
/** A calendar date (YYYY-MM-DD) without a time zone shift. */
const fmtPlain = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
/** A YYYY-MM-DD value is a calendar date; anything longer is an instant */
const either = (iso: string, o: Intl.DateTimeFormatOptions) => (iso.length === 10 ? fmtPlain(iso, o) : fmt(iso, o));

/** Oct 8, 2026 */
export const date = (iso: string) => either(iso, { month: 'short', day: 'numeric', year: 'numeric' });
/** Oct 8 */
export const shortDate = (iso: string) => either(iso, { month: 'short', day: 'numeric' });
/** Tue, Oct 13 */
export const weekdayDate = (iso: string) => either(iso, { weekday: 'short', month: 'short', day: 'numeric' });
/** Thursday, Oct 8, 2026 */
export const longDate = (iso: string) => either(iso, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
/** 10:05 AM */
export const time = (iso: string) => fmt(iso, { hour: 'numeric', minute: '2-digit' });
/** Oct 8, 6:48 PM */
export const dateTime = (iso: string) => `${shortDate(iso)}, ${time(iso)}`;
/** Jul 2026 */
export const monthYear = (iso: string) => either(iso, { month: 'short', year: 'numeric' });

/** The Pacific calendar day of an instant, as YYYY-MM-DD (a calendar date is already its own day). */
export const dayKey = (iso: string | Date) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ }));

export type DeadlineTone = 'ok' | 'warning' | 'danger';

/** API deadline states (on_time | due_soon | overdue; GraphQL spells them in capitals). */
export const deadlineTone = (state?: string | null): DeadlineTone => {
  const s = (state ?? '').toLowerCase();
  return s === 'overdue' ? 'danger' : s === 'due_soon' ? 'warning' : 'ok';
};

/** "Overdue 3 h", "Due today 5:00 PM", "Due tomorrow 5:00 PM", "Due Oct 16, 5:00 PM". */
export function deadlineLabel(dueAt: string, prefix = 'Due', now = new Date()): string {
  const due = new Date(dueAt);
  const ms = due.getTime() - now.getTime();
  if (ms < 0) {
    const h = Math.round(-ms / 3_600_000);
    return h < 1 ? 'Overdue' : h < 48 ? `Overdue ${h} h` : `Overdue ${Math.round(h / 24)} days`;
  }
  const today = dayKey(now);
  const tomorrow = dayKey(new Date(now.getTime() + 86_400_000));
  const d = dayKey(due);
  if (d === today) return `${prefix} today ${time(dueAt)}`;
  if (d === tomorrow) return `${prefix} tomorrow ${time(dueAt)}`;
  return `${prefix} ${dateTime(dueAt)}`;
}

const wallParts = (at: Date, timeZone: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );

/** A datetime-input value (YYYY-MM-DDTHH:mm) showing an instant as wall time in a time zone (Pacific by default). */
export function zonedInput(iso: string | null | undefined, timeZone = TZ): string {
  if (!iso) return '';
  const p = wallParts(new Date(iso), timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** A datetime-input value read as wall time in a time zone → ISO instant; null when it isn't one. */
export function fromZonedInput(v: string, timeZone = TZ): string | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  // the zone's offset at that moment; two passes settle wall times next to a daylight-saving change
  const offset = (t: number) => {
    const p = wallParts(new Date(t), timeZone);
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - t;
  };
  let t = asUtc - offset(asUtc);
  t = asUtc - offset(t);
  return new Date(t).toISOString();
}
