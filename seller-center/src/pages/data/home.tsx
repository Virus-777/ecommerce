// Shared parts of the Seller Center home screens (Setup, Dashboard, Performance, Notifications, Help):
// Pacific-time date formatting, deadline labels, the load-error alert, skeletons, links built from the
// API's screen ids, and the icon names the API may send.
import type { QueryKey } from '@tanstack/react-query';
import type { components } from '@marketly/web-shared/api';
import { LoadError as SharedLoadError, SkeletonLines } from '@marketly/web-shared/ui';
import { href, SCREEN_BY_ID, type ScreenId } from '@marketly/web-shared/routes';

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
  // views are kebab-case slugs; the API sends snake_case states (information_required → information-required)
  const slug = state?.toLowerCase().replace(/_/g, '-');
  const view = id === 'seller/orders' ? ORDER_VIEWS[state ?? ''] : slug && views.includes(slug) ? slug : undefined;
  return href(id, view ?? '', params);
}

type Notice = components['schemas']['notifications.Notice'];

/** Where the publishing module shows the record; the list screen when the link lacks what the detail screen needs. */
const FALLBACK: Partial<Record<string, ScreenId>> = {
  'seller/order': 'seller/orders',
  'seller/return': 'seller/returns',
  'seller/statement': 'seller/finance',
  'seller/help-article': 'seller/help',
};

/** Where a notice opens: the Notifications page rows and the live toasts (app/session.tsx) use the same link. */
export function noticeHref(n: Notice): string | undefined {
  const l = n.link;
  // Statement routes also take the statement id, so a statement notice without a ref opens the statement.
  const ref = l.ref ?? (l.screen === 'seller/statement' ? l.id : null);
  return screenHref(l.screen, null, ref ? { ref } : undefined) ?? (FALLBACK[l.screen] ? href(FALLBACK[l.screen]!) : undefined);
}

/**
 * Query families a live notice may change besides ['notifications'], by the topic's subject
 * (seller.<subject>.<event>, e.g. seller.order.new): the sidebar counts in app/session.tsx and the open lists.
 */
const LIVE_KEYS: Record<string, string[]> = {
  order: ['orders'],
  dispatch: ['orders'],
  return: ['returns'],
  case: ['returns', 'support'],
  message: ['messaging'],
  product: ['catalog', 'offers'],
  offer: ['offers'],
  fulfillment: ['inventory'],
  review_report: ['reviews'],
  payout: ['finance'],
  statement: ['finance'],
  hold: ['finance'],
  balance: ['finance'],
};
export const liveQueryKeys = (n: Notice): QueryKey[] => (LIVE_KEYS[n.topicKey.split('.')[1] ?? ''] ?? []).map((k) => [k]);

/** A failed read: the error and a Try again button (API.md rule 4). */
export const LoadError = (p: { error: unknown; onRetry: () => void; title?: string }) => (
  <SharedLoadError {...p} forbiddenHint="Your permissions don’t include this. The store owner can change them in Staff." />
);

export { SkeletonLines };
