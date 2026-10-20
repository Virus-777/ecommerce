// Shared parts of the Seller Center home screens (Setup, Dashboard, Performance, Notifications, Help):
// Pacific-time date formatting, deadline labels, the load-error alert, skeletons, links built from the
// API's screen ids, and the icon names the API may send.
import { errorMessage } from '@marketly/web-shared/api';
import { href, SCREEN_BY_ID, type ScreenId } from '@marketly/web-shared/routes';
import { Alert, Button } from '@marketly/web-shared/ui';

/** Pacific-time dates and deadline labels: the same helpers in all three apps */
export { TZ, date, dateTime, dayKey, deadlineLabel, deadlineTone, longDate, monthYear, shortDate, time, weekdayDate, type DeadlineTone } from '@marketly/web-shared/lib/dates';

/** The API names a few screens differently from the Seller Center catalogue. */
const SCREEN_ALIAS: Record<string, ScreenId> = {
  'seller/messages': 'seller/customers',
  'seller/shipping-settings': 'seller/shipping',
  'seller/returns-settings': 'seller/shipping',
  'seller/statements': 'seller/finance',
  'seller/restrictions': 'seller/performance',
  'seller/account-health': 'seller/performance',
};

/** Views of seller/orders the API's screen states map to. */
const ORDER_VIEWS: Record<string, string> = { overdue: 'preparing', preparing: 'preparing', shipped: 'shipped', completed: 'completed', cancellation_requests: 'cancellation-requests' };

/** A screen id the API sends (e.g. seller/orders, state "overdue") as a link in this app; undefined if unknown. */
export function screenHref(screen?: string | null, state?: string | null, params?: Record<string, string>): string | undefined {
  if (!screen) return undefined;
  const id = (SCREEN_ALIAS[screen] ?? screen) as ScreenId;
  const s = SCREEN_BY_ID[id];
  if (!s) return undefined;
  // A detail screen needs its record; without it, link nowhere rather than to the sample record.
  const needs = [...s.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
  if (needs.some((p) => !params?.[p])) return undefined;
  const views = s.views.map((v) => v.slug);
  const view = id === 'seller/orders' ? ORDER_VIEWS[state ?? ''] : state && views.includes(state) ? state : undefined;
  return href(id, view ?? '', params);
}

/** A failed read: the error and a Try again button (API.md rule 4). */
export function LoadError({ error, onRetry, title = 'We couldn’t load this' }: { error: unknown; onRetry: () => void; title?: string }) {
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
