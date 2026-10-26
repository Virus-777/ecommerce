// "Create a new seller login" on Sell › Apply (Seller account step). A shopper who wants a separate business login
// for Seller Center registers it here instead of signing out first (sellers.ApplicationAccountInput: with
// accountMode new_seller_login "the app registers through identity first; this call is then made with that session"):
//   1. POST /api/public/identity/registrations { email, password, firstName, lastName, acceptedTermsVersion, … }
//      creates the login and signs it in (with the refresh cookie); an email that already has an account is
//      refused with EMAIL_IN_USE, and that shopper signs in with it and chooses "Use my Marketly account"
//   2. the page adopts those tokens and creates the application with accountMode new_seller_login.
// The same identity call as auth/register (pages/auth/Register.tsx); the building blocks come from auth/data/parts.
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { call, useApi } from '@marketly/web-shared/api';
import { WITH_COOKIE, deviceInfo } from '../../auth/data/parts';

/** "Jordan Lee" → first "Jordan", last "Lee" (identity needs both; the contact person is one field on this form). */
export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

/** The purchase terms version recorded with a new account (acceptedTermsVersion), as on auth/register. */
export function usePurchaseTerms(enabled: boolean) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['content', 'policy', 'purchase_terms'],
    queryFn: () => call(api.GET('/api/store/content/policies/{key}', { params: { path: { key: 'purchase_terms' } } })),
    staleTime: 10 * 60_000,
    enabled,
  });
}

/** The identity call behind step 1: register the new login, which signs it in. */
export function useNewLoginApi() {
  const { api } = useApi();
  return useMemo(
    () => ({
      // keepSignedIn: the seller login stays signed in like a normal sign-in with "Keep me signed in".
      register: (v: { email: string; password: string; firstName: string; lastName: string; termsVersion: string }) =>
        call(
          api.POST('/api/public/identity/registrations', {
            body: {
              email: v.email,
              password: v.password,
              firstName: v.firstName,
              lastName: v.lastName,
              marketingOptIn: false,
              acceptedTermsVersion: v.termsVersion,
              keepSignedIn: true,
              device: deviceInfo(),
            },
            ...WITH_COOKIE,
          }),
        ),
    }),
    [api],
  );
}
