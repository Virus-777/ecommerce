// Shared parts of the Admin and Operations Center screens: Pacific-time date formatting, deadline labels,
// the load-error alert, skeletons and links built from the API's screen ids.
import { ApiError, errorMessage } from '@marketly/web-shared/api';
import { href, SCREEN_BY_ID, type ScreenId } from '@marketly/web-shared/routes';
import { Alert, Button, iconFor } from '@marketly/web-shared/ui';

/** Admin and Operations Center times are shown in Pacific Time (market time). */
export const TZ = 'America/Los_Angeles';

const fmt = (iso: string | Date, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('en-US', { timeZone: TZ, ...o });
/** A calendar date (YYYY-MM-DD) without a time zone shift. */
const fmtPlain = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });

/** Oct 8, 2026 */
export const date = (iso: string) => (iso.length === 10 ? fmtPlain(iso, { month: 'short', day: 'numeric', year: 'numeric' }) : fmt(iso, { month: 'short', day: 'numeric', year: 'numeric' }));
/** Oct 8 */
export const shortDate = (iso: string) => (iso.length === 10 ? fmtPlain(iso, { month: 'short', day: 'numeric' }) : fmt(iso, { month: 'short', day: 'numeric' }));
/** Tue, Oct 13 */
export const weekdayDate = (iso: string) => (iso.length === 10 ? fmtPlain(iso, { weekday: 'short', month: 'short', day: 'numeric' }) : fmt(iso, { weekday: 'short', month: 'short', day: 'numeric' }));
/** Thursday, Oct 8, 2026 */
export const longDate = (iso: string) => fmt(iso, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
/** 10:05 AM */
export const time = (iso: string) => fmt(iso, { hour: 'numeric', minute: '2-digit' });
/** Oct 8, 6:48 PM */
export const dateTime = (iso: string) => `${shortDate(iso)}, ${time(iso)}`;
/** Jul 2026 */
export const monthYear = (iso: string) => fmt(iso, { month: 'short', year: 'numeric' });

/** The Pacific calendar day of an instant, as YYYY-MM-DD. */
export const dayKey = (iso: string | Date) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });

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

/** A screen id the API sends (e.g. seller/orders, state "overdue") as a link in this app; undefined if unknown. */
export function screenHref(screen?: string | null, state?: string | null, params?: Record<string, string>): string | undefined {
  if (!screen) return undefined;
  const id = screen as ScreenId;
  const s = SCREEN_BY_ID[id];
  if (!s) return undefined;
  // A detail screen needs its record; without it, link nowhere rather than to the sample record.
  const needs = [...s.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
  if (needs.some((p) => !params?.[p])) return undefined;
  const views = s.views.map((v) => v.slug);
  const view = state && views.includes(state) ? state : undefined;
  return href(id, view ?? '', params);
}

/** True when the API refused the read because the staff member's roles lack the permission (403 FORBIDDEN). */
export const isForbidden = (e: unknown): boolean => e instanceof ApiError && (e.status === 403 || e.code === 'FORBIDDEN') && e.code !== 'STEP_UP_REQUIRED';

/**
 * A failed read: the error and a Try again button (API.md rule 4). A permission refusal is not an error to
 * retry: it says the role doesn't include this, and who can change that.
 */
export function LoadError({ error, onRetry, title = 'We couldn’t load this' }: { error: unknown; onRetry: () => void; title?: string }) {
  if (isForbidden(error)) {
    return (
      <Alert tone="info" title="Not available for your role">
        Your roles don’t include access to this. A Platform Administrator can change your roles in Staff and permissions.
      </Alert>
    );
  }
  return (
    <Alert tone="danger" title={title}>
      {errorMessage(error)}{' '}
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </Alert>
  );
}

/** Skeleton lines for a card body while it loads. */
export function SkeletonLines({ rows = 3 }: { rows?: number }) {
  return (
    <div className="sk-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk-row">
          <span className="sk-lines">
            <span className="sk sk-line" />
            <span className="sk sk-line short" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** @deprecated Use iconFor from @marketly/web-shared/ui (maps the API's old icon names; unknown names fall back). */
export const iconOf = iconFor;
