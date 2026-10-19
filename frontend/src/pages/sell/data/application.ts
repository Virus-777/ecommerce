import { useQuery } from '@tanstack/react-query';
import { ApiError, call, useApi, type components } from '@marketly/web-shared/api';
import { useSession } from '@/app/session';

// The signed-in customer's seller application (GET /api/store/sellers/applications/current; 404 = none yet).
// Its account/business/verification/returnAddress sections are json in the OpenAPI schema: the fields the
// screens read are typed here (docs/api/modules/sellers.md, SellerApplication).

export type SellerApplication = components['schemas']['sellers.SellerApplication'];

export interface AppAccount {
  accountMode?: string;
  contactName?: string;
  contactPhone?: string;
  workEmail?: string;
  storeName?: string;
  sellerType?: 'business' | 'individual';
  tipsOptIn?: boolean;
}
export interface AppAddress {
  name?: string;
  line1?: string;
  line2?: string | null;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}
export interface AppBusiness {
  kind?: 'registered_business' | 'individual';
  legalName?: string;
  storeName?: string;
  businessType?: 'llc' | 'corporation' | 'partnership' | 'sole_proprietor';
  stateOfRegistration?: string;
  address?: AppAddress;
  phone?: string;
  website?: string | null;
  categoryIds?: string[];
  plannedProductCount?: '1_20' | '21_100' | '101_500' | 'over_500';
}
export interface AppVerification {
  owners?: Array<{ id: string; name: string; ownershipPct: number; isPrimary: boolean; verificationState?: string }>;
  registrationDocumentIds?: string[];
  taxIdType?: 'ein' | 'ssn';
  taxIdLast4?: string;
  w9Method?: 'online' | 'uploaded';
}
export interface AppReturnAddress {
  sameAsBusiness?: boolean;
  contactName?: string;
  phone?: string;
  address?: AppAddress | null;
}

export const sections = (a: SellerApplication | null | undefined) => ({
  account: (a?.account ?? null) as AppAccount | null,
  business: (a?.business ?? null) as AppBusiness | null,
  verification: (a?.verification ?? null) as AppVerification | null,
  returnAddress: (a?.returnAddress ?? null) as AppReturnAddress | null,
});

export const APPLICATION_KEY = ['sellers', 'application', 'current'] as const;

/** The current application, or null when the customer has none (404). */
export function useApplication() {
  const { api } = useApi();
  const { signedIn } = useSession();
  return useQuery({
    queryKey: APPLICATION_KEY,
    queryFn: async () => {
      try {
        return await call(api.GET('/api/store/sellers/applications/current'));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    enabled: signedIn,
  });
}

export const US_STATES: Array<[string, string]> = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
  ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
  ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
  ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];
export const stateName = (code?: string | null) => US_STATES.find(([c]) => c === code)?.[1] ?? code ?? '';

/** "410 Pine St, Portland, OR 97204" */
export const formatAddress = (a?: AppAddress | null) => (a ? [a.line1, a.line2, a.city, [a.region, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '');

/** A US phone as E.164 (+15035550172) when it has 10 digits (or 11 starting with 1); otherwise as typed. */
export function e164(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return phone.trim();
}
/** +15035550172 → (503) 555-0172 */
export function displayPhone(phone?: string | null): string {
  const d = (phone ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (phone ?? '');
}
