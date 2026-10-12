import { generatePath } from 'react-router';
import { APP_URLS, CURRENT_APP } from './apps';
import { SCREEN_BY_ID, type ScreenId } from './catalogue';

/**
 * URL of a screen, optionally in one of its views (design states).
 * Path params default to the screen's sample values, so `href('store/product')` is a working link.
 * Screens of the current app get a relative path; screens of another app get an absolute URL
 * (react-router's <Link> then does a normal page navigation).
 *
 *   href('store/product')                       -> /p/halden-aurora-anc
 *   href('seller/orders', 'shipped')            -> /orders?view=shipped              (in the Seller Center)
 *   href('seller/dashboard')                    -> http://127.0.0.1:3001/           (from the store)
 *   href('account/order', '', { ref: 'MK-1' })  -> /account/orders/MK-1
 */
export function href(id: ScreenId, view?: string, params?: Record<string, string>, query?: Record<string, string>): string {
  const s = SCREEN_BY_ID[id];
  const path = generatePath(s.path, { ...(s.sample ?? {}), ...(params ?? {}) });
  const q = new URLSearchParams(query);
  if (view) q.set('view', view);
  const qs = q.toString();
  const rel = qs ? `${path}?${qs}` : path;
  return s.app === CURRENT_APP ? rel : APP_URLS[s.app].replace(/\/$/, '') + rel;
}
