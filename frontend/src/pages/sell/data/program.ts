import { useQuery } from '@tanstack/react-query';
import { call, useApi } from '@marketly/web-shared/api';

// sellers.SellerProgram (GET /api/store/sellers/program). The OpenAPI schema types most of its lists as
// json[], so the fields the seller-entry screens read are typed here (docs/api/modules/sellers.md).

export interface SellerProgram {
  launchCategories: Array<{ id: string; name: string; icon: string; needsExtraApproval: boolean }>;
  notAllowed: string[];
  requirements: Array<{ title: string; detail: string }>;
  feeExamples: Array<{ categoryName: string; ratePct: number; basis: string; isExample?: boolean }>;
  feeNotes: string[];
  payoutTiming: { holdDaysAfterDelivery: number; schedule: string; arrival: string; isExample?: boolean } | null;
  fulfillmentModels: Array<{ name: string; availability: string; detail: string }>;
  serviceTargets: Array<{ metric: string; display: string; windowDays: number; isExample?: boolean }>;
  agreements: Array<{ key: string; title: string; versionLabel: string; summary: string; url: string | null; effectiveFrom: string | null; isExample?: boolean }>;
  steps: string[];
  verificationLabels: Array<{ label: string; means: string; doesNotMean: string }>;
  faq: Array<{ q: string; a: string }>;
  contact: { email: string; phone?: string | null; hours?: string | null } | null;
  estimatedMinutes: number;
  applicationsOpen: boolean;
}

export function useSellerProgram() {
  const { api } = useApi();
  return useQuery({
    queryKey: ['sellers', 'program'],
    queryFn: async () => (await call(api.GET('/api/store/sellers/program'))) as unknown as SellerProgram,
    staleTime: 300_000,
  });
}

/** "sellers@marketly.example · +1 800 555 0140, Mon–Fri 9:00–17:00 PT" */
export const contactLine = (c: SellerProgram['contact']) => (c ? [c.email, [c.phone, c.hours].filter(Boolean).join(', ')].filter(Boolean).join(' · ') : '');
