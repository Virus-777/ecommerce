import { generatePath } from 'react-router';
import { SCREEN_BY_ID, type ScreenId } from './catalogue';

/**
 * URL of a screen, optionally in one of its views (design states).
 * Path params default to the screen's sample values, so `href('store/product')` is a working link.
 *
 *   href('store/product')                       -> /p/halden-aurora-anc
 *   href('seller/orders', 'shipped')            -> /seller/orders?view=shipped
 *   href('account/order', '', { ref: 'MK-1' })  -> /account/orders/MK-1
 */
export function href(id: ScreenId, view?: string, params?: Record<string, string>, query?: Record<string, string>): string {
  const s = SCREEN_BY_ID[id];
  const path = generatePath(s.path, { ...(s.sample ?? {}), ...(params ?? {}) });
  const q = new URLSearchParams(query);
  if (view) q.set('view', view);
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}
