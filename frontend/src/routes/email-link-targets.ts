// Where each link in a customer email or push notice opens.
//
// When a notice has no explicit url, the backend builds its link as
//   ${STORE_URL}/<link.screen>/<link.id>          (backend notifications/app/core.ts, linkUrl)
// where screen is a catalogue screen id (account/order, account/return, help/case, …) and id is the record's
// uuid, not the ref the store's routes use. Each entry below turns that pair into a real store path.
// The screens and ids come from the backend's notice links: notifications/domain/routing.ts (L(...) calls),
// notifications/app/consumers.ts, notifications/app/webhooks.ts, notifications/app/sender.ts,
// customers/service/guest-orders.ts, returns/service/requests.ts, shipping/service/exceptions.ts and
// promotions/service/storefront.ts. Add a row here when the backend starts linking a new customer screen.
//
// `resolve` loads the record (the uuid → its ref) and returns the path; it throws ApiError when the record
// isn't there or isn't the caller's (the resolver page then sends a visitor to sign-in, or tells a signed-in
// customer and offers `fallback`). Rows without `resolve` open the screen straight away.
import { ApiError, call, type Api } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import type { IconName } from '@marketly/web-shared/ui';

export interface LinkTarget {
  /** The backend's link.screen (also the first two path segments of the emailed URL). */
  screen: string;
  /** Path to open without a lookup (screens whose link id isn't needed). */
  to?: (id: string) => string;
  /** Loads the record and returns its store path. */
  resolve?: (api: Api, id: string, signedIn: boolean) => Promise<string>;
  /** Shown when the record can't be opened for this customer. */
  fallback?: { title: string; body: string; label: string; to: string; icon: IconName };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (id: string) => UUID.test(id);
/** Treated like the API's NOT_FOUND by the resolver page. */
const notFound = () => new ApiError(404, 'NOT_FOUND', 'Not found');
/** True when the API said the record isn't there or isn't visible to this caller. */
export const isMissing = (e: unknown) => e instanceof ApiError && [400, 401, 403, 404].includes(e.status);

const ORDERS_FALLBACK = { title: 'We couldn’t open that order', body: 'It may belong to another account, or the link is out of date. Your orders are listed in your account.', label: 'Go to your orders', to: href('account/orders'), icon: 'package' as const };

async function order(api: Api, id: string) {
  if (id.startsWith('MK-')) return href('account/order', '', { ref: id });
  if (!isUuid(id)) throw notFound();
  const o = await call(api.GET('/api/store/orders/orders/{id}', { params: { path: { id } } }));
  return href('account/order', '', { ref: o.ref });
}

/** A support case, or (for trust links that open help/case) a report, an evidence request or an appeal. */
async function caseOrTrust(api: Api, id: string, signedIn: boolean) {
  // webhooks.ts links "help/case/messages" (a reply to a support email whose files were refused)
  if (!isUuid(id) && !id.startsWith('CS-')) return href('help/cases');
  try {
    const c = await call(api.GET('/api/store/support/cases/{id}', { params: { path: { id } } }));
    return href('help/case', '', { ref: c.ref });
  } catch (e) {
    // Trust and Risk notices (report resolved, information needed, appeal decided) also link help/case with
    // the trust record's id; those live on Account › Reports and appeals (customer-only endpoints).
    if (!signedIn || !isMissing(e) || !isUuid(id)) throw e;
    const report = await api.GET('/api/store/trust/reports/{id}', { params: { path: { id } } });
    if (report.data) return href('account/reports');
    const requests = await call(api.GET('/api/store/trust/evidence-requests'));
    if (requests.some((r) => r.id === id)) return href('account/reports', 'requests');
    const appeals = await call(api.GET('/api/store/trust/appeals'));
    if (appeals.some((a) => a.id === id)) return href('account/reports', 'actions');
    throw e;
  }
}

export const LINK_TARGETS: LinkTarget[] = [
  { screen: 'account/order', resolve: order, fallback: ORDERS_FALLBACK },
  {
    screen: 'account/tracking',
    // id is the shipment; its tracking names the order, and the Track package screen picks the package by ?shipment=
    resolve: async (api, id) => {
      if (id.startsWith('MK-')) return href('account/tracking', '', { ref: id });
      if (!isUuid(id)) throw notFound();
      const t = await call(api.GET('/api/store/shipping/shipments/{id}/tracking', { params: { path: { id } } }));
      return href('account/tracking', '', { ref: t.orderRef }, { shipment: id });
    },
    fallback: { ...ORDERS_FALLBACK, title: 'We couldn’t find that package' },
  },
  {
    screen: 'account/return',
    // the return detail op takes the id or the RT- ref
    resolve: async (api, id) => {
      if (!isUuid(id) && !id.startsWith('RT-')) throw notFound();
      const r = await call(api.GET('/api/store/returns/requests/{id}', { params: { path: { id } } }));
      return href('account/return', '', { ref: r.ref });
    },
    fallback: { title: 'We couldn’t open that return', body: 'It may belong to another account, or the link is out of date. Your returns are listed in your account.', label: 'Go to your returns', to: href('account/returns'), icon: 'undo-2' },
  },
  {
    screen: 'help/case',
    resolve: caseOrTrust,
    fallback: { title: 'We couldn’t open that case', body: 'It may belong to another account, or the link is out of date. Your support cases and reports are listed in your account.', label: 'Go to your support cases', to: href('help/cases'), icon: 'life-buoy' },
  },
  {
    screen: 'account/review',
    // "Write a review" invitations carry the product id: open the pending review of that product
    resolve: async (api, id) => {
      const pending = await call(api.GET('/api/store/reviews/me/pending'));
      const item = pending.products.find((p) => p.productId === id);
      return item ? href('account/review', '', undefined, { item: item.orderItemId }) : href('account/reviews');
    },
  },
  {
    screen: 'store/product',
    resolve: async (api, id) => {
      if (!isUuid(id)) throw notFound();
      const p = await call(api.GET('/api/store/catalog/products/{id}', { params: { path: { id } } }));
      return href('store/product', '', { slug: p.slug, id: p.id });
    },
    fallback: { title: 'This product isn’t available', body: 'It may have been removed from the store. Try searching for something similar.', label: 'Search the store', to: href('store/search'), icon: 'search-x' },
  },
  // Screens that don't need the id: messages open the conversation by ?conversation=
  { screen: 'account/messages', to: (id) => (isUuid(id) ? href('account/messages', '', undefined, { conversation: id }) : href('account/messages')) },
  { screen: 'help/article', to: (slug) => href('help/article', '', { slug }) },
  { screen: 'account/notifications', to: () => href('account/notifications') },
  { screen: 'account/overview', to: () => href('account/overview') },
  { screen: 'account/profile', to: () => href('account/profile') },
  { screen: 'account/security', to: () => href('account/security') },
  { screen: 'account/reviews', to: () => href('account/reviews') },
  { screen: 'account/coupons', to: () => href('account/coupons') },
  { screen: 'store/deals', to: () => href('store/deals') },
  // verification-code emails ("Enter code"): the code is typed where the customer started
  { screen: 'auth/sign-in', to: () => href('auth/sign-in') },
  { screen: 'auth/register', to: () => href('auth/register') },
];
