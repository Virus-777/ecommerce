import { useQuery } from '@tanstack/react-query';
import { call, useApi, type components } from '@marketly/web-shared/api';

// sellers.SellerProgram (GET /api/store/sellers/program): what the seller-entry screens show (categories, fees,
// payout timing, agreements, FAQ, contact). Typed by the OpenAPI schema (docs/api/modules/sellers.md).

export type SellerProgram = components['schemas']['sellers.SellerProgram'];

export function useSellerProgram() {
  const { api } = useApi();
  return useQuery({
    queryKey: ['sellers', 'program'],
    queryFn: () => call(api.GET('/api/store/sellers/program')),
    staleTime: 300_000,
  });
}

/** "sellers@marketly.example · +1 800 555 0140, Mon–Fri 9:00–17:00 PT" */
export const contactLine = (c: SellerProgram['contact'] | null | undefined) => (c ? [c.email, [c.phone, c.hours].filter(Boolean).join(', ')].filter(Boolean).join(' · ') : '');
