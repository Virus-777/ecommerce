// Shared parts of the Admin and Operations Center screens: Pacific-time date formatting, deadline labels,
// the load-error alert, skeletons and links built from the API's screen ids.
import { ApiError, errorMessage } from '@marketly/web-shared/api';
import { href, SCREEN_BY_ID, type ScreenId } from '@marketly/web-shared/routes';
import { Alert, Button } from '@marketly/web-shared/ui';

/** Pacific-time dates and deadline labels: the same helpers in all three apps */
export { TZ, date, dateTime, dayKey, deadlineLabel, deadlineTone, longDate, monthYear, shortDate, time, weekdayDate, type DeadlineTone } from '@marketly/web-shared/lib/dates';

/**
 * Screen ids the API sends that aren't screens of their own in this app: the work happens on another list.
 * (Seller applications and appeals are tabs of the Sellers list.)
 */
const SCREEN_ALIAS: Record<string, ScreenId> = {
  'admin/applications': 'admin/sellers',
  'admin/appeals': 'admin/sellers',
};

/**
 * API screen filters (snake_case, e.g. the work queue screenFilter "missing_tracking") that name a view with a
 * different slug. Filters that match a view once "_" becomes "-" need no entry here.
 */
const FILTER_VIEW: Partial<Record<ScreenId, Record<string, string>>> = {
  'admin/finance': { disputes: 'disputes-and-chargebacks', chargebacks: 'disputes-and-chargebacks' },
  'admin/orders': { overdue: 'overdue-dispatch' },
};

/** List screens that read the API's screen filter from `?filter=` as is (they have tabs, not catalogue views). */
const FILTER_PARAM = new Set<ScreenId>(['admin/sellers']);

/** The view slug of a screen for an API state or filter; undefined when the screen has no such view. */
function viewFor(id: ScreenId, state?: string | null): string | undefined {
  if (!state) return undefined;
  const views = SCREEN_BY_ID[id].views.map((v) => v.slug).filter(Boolean);
  const alias = FILTER_VIEW[id]?.[state];
  if (alias && views.includes(alias)) return alias;
  const slug = state.toLowerCase().replace(/_/g, '-');
  return views.includes(slug) ? slug : undefined;
}

/**
 * The list screen above a detail screen of this app (/sellers/applications/:ref → /sellers, /orders/:ref → /orders):
 * the nearest catalogue path that is a parent of the detail path. Undefined when there is none (never the dashboard).
 */
function listScreenOf(id: ScreenId): ScreenId | undefined {
  const s = SCREEN_BY_ID[id];
  if (s.app !== 'admin') return undefined;
  const parts = s.path.split('/').filter(Boolean);
  const cut = parts.findIndex((p) => p.startsWith(':'));
  for (let n = cut < 0 ? parts.length - 1 : cut; n > 0; n--) {
    const path = `/${parts.slice(0, n).join('/')}`;
    const list = Object.values(SCREEN_BY_ID).find((x) => x.app === 'admin' && x.path === path);
    if (list) return list.id as ScreenId;
  }
  return undefined;
}

/**
 * A screen id the API sends (e.g. ops/dispatch with the state or screen filter "missing_tracking") as a link in this
 * app; undefined if unknown.
 * - The state opens the matching view (snake_case API values match the hyphenated view slugs). Other states go to
 *   `?filter=` on the screens in FILTER_PARAM and are dropped elsewhere.
 * - A detail screen (a path with :ref, :slug…) needs its record. Called without params it links to its list screen
 *   instead (the Seller applications queue opens the Sellers list). Called with params that don't cover the route it
 *   returns undefined, so the caller's own fallback (e.g. a search link) applies.
 */
export function screenHref(screen?: string | null, state?: string | null, params?: Record<string, string>): string | undefined {
  if (!screen) return undefined;
  const id = (SCREEN_ALIAS[screen] ?? screen) as ScreenId;
  const s = SCREEN_BY_ID[id];
  if (!s) return undefined;
  const needs = [...s.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
  if (needs.some((p) => !params?.[p])) {
    if (params) return undefined;
    const list = listScreenOf(id);
    return list ? linkTo(list, state) : undefined;
  }
  return linkTo(id, state, params);
}

/** href for a screen with the API state as its view, or as ?filter= on the screens in FILTER_PARAM. */
function linkTo(id: ScreenId, state?: string | null, params?: Record<string, string>): string {
  const view = viewFor(id, state);
  const query = !view && state && FILTER_PARAM.has(id) ? { filter: state } : undefined;
  return href(id, view ?? '', params, query);
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

