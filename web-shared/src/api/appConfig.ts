import { useQuery } from '@tanstack/react-query';
import { call } from './client';
import { ApiError } from './errors';
import type { components } from './openapi';
import { useApi } from './provider';

// Website configuration: GET /api/public/settings/app-config (market, support hours, guest checkout, public
// feature flags, maintenance notice). One cached response per app, shared by every screen under the query key
// APP_CONFIG_KEY (screens that call the endpoint themselves should use the same key).

export type PublicMarket = components['schemas']['settings.PublicMarket'];
/** Where prices and delivery dates are estimated before a visitor gives an address ("Deliver to …"). */
export type DeliveryLocation = components['schemas']['settings.DeliveryLocation'];

export const APP_CONFIG_KEY = ['settings', 'app-config'] as const;

/** The whole app-config, cached for 5 minutes. */
export function useAppConfig() {
  const { api } = useApi();
  return useQuery({ queryKey: APP_CONFIG_KEY, queryFn: () => call(api.GET('/api/public/settings/app-config')), staleTime: 300_000 });
}

/**
 * The market from app-config (`storeInfo.market` in GraphQL has the same fields), with its default delivery
 * location (G21: `defaultDeliveryLocation { postalCode, label }`, e.g. 97205 / "Portland, OR 97205").
 *   const { market, deliveryLocation } = useMarket();  →  Deliver to {deliveryLocation?.label}
 */
export function useMarket(): { market: PublicMarket | null; deliveryLocation: DeliveryLocation | null; loading: boolean; error: ApiError | null } {
  const q = useAppConfig();
  const market = q.data?.market ?? null;
  return { market, deliveryLocation: market?.defaultDeliveryLocation ?? null, loading: q.isPending, error: q.error instanceof ApiError ? q.error : null };
}
