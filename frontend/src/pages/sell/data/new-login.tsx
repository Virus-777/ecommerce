// "Create a new seller login" on Sell › Apply (Seller account step). A shopper who wants a separate business login
// for Seller Center registers it here instead of signing out first (sellers.ApplicationAccountInput: with
// accountMode new_seller_login "the app registers through identity first; this call is then made with that session"):
//   1. POST /api/public/identity/registrations { email, password, firstName, lastName, acceptedTermsVersion, … }
//      always answers with a code challenge (the code goes to the business email; an email that already has an
//      account gets a "you already have an account" email instead, and its code never verifies)
//   2. POST /api/public/identity/verifications/{id}/confirm { code } (with the refresh cookie) signs the new login in
//   3. the page adopts those tokens and creates the application with accountMode new_seller_login.
// The same identity calls as auth/register (pages/auth/Register.tsx); the building blocks come from auth/data/parts.
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { call, useApi } from '@marketly/web-shared/api';
import { Button, Icon } from '@marketly/web-shared/ui';
import { CodeInput, DevOutboxHint, WITH_COOKIE, deviceInfo, minutesUntil, mss, useSecondsUntil, type VerificationChallenge } from '../../auth/data/parts';

export type { VerificationChallenge };

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

/** The identity calls: register the new login (step 1), confirm its email code (step 2), send a new code. */
export function useNewLoginApi() {
  const { api } = useApi();
  return useMemo(
    () => ({
      register: (v: { email: string; password: string; firstName: string; lastName: string; termsVersion: string }) =>
        call(
          api.POST('/api/public/identity/registrations', {
            body: { email: v.email, password: v.password, firstName: v.firstName, lastName: v.lastName, marketingOptIn: false, acceptedTermsVersion: v.termsVersion, device: deviceInfo() },
          }),
        ),
      // keepSignedIn: the seller login stays signed in like a normal sign-in with "Keep me signed in".
      confirm: (challengeId: string, code: string) =>
        call(api.POST('/api/public/identity/verifications/{id}/confirm', { params: { path: { id: challengeId } }, body: { code, keepSignedIn: true, device: deviceInfo() }, ...WITH_COOKIE })),
      resend: (challengeId: string) => call(api.POST('/api/public/identity/verifications/{id}/resend', { params: { path: { id: challengeId } } })),
    }),
    [api],
  );
}

/** The email code panel shown in the Seller account step after the login is registered. */
export function CodePanel({
  challenge, code, setCode, error, onResend, resending, onRestart,
}: {
  challenge: VerificationChallenge;
  code: string[];
  setCode: (v: string[]) => void;
  error?: string;
  onResend: () => void;
  resending: boolean;
  /** Back to the form, e.g. to fix the email (a new registration replaces this one). */
  onRestart: () => void;
}) {
  const resendLeft = useSecondsUntil(challenge.resendAvailableAt);
  return (
    <div className="panel stack gap-3" role="group" aria-labelledby="ap-code-h">
      <span className="row gap-2">
        <Icon name="mail-check" />
        <span className="small strong" id="ap-code-h">
          Check your business email
        </span>
      </span>
      <p className="small sub">
        Enter the {code.length}-digit code we sent to <b>{challenge.emailMasked}</b>. It expires in {minutesUntil(challenge.expiresAt)} minutes.
      </p>
      <CodeInput idPrefix="ap-code" legend="Verification code" value={code} onChange={setCode} />
      {error && (
        <span className="error-text" role="alert">
          <Icon name="circle-alert" className="ic-sm" />
          {error}
        </span>
      )}
      <div className="row between small gap-2">
        {resendLeft > 0 || resending ? (
          <span className="muted">
            <Icon name="clock" className="ic-sm" /> Resend code in {mss(resendLeft)}
          </span>
        ) : (
          <Button variant="ghost" size="sm" onClick={onResend}>
            Resend code
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onRestart}>
          Change email
        </Button>
      </div>
      <p className="xs muted">
        Can’t find it? Check your spam folder. If this email already has a Marketly account, we emailed it a note instead of a code: choose “Use my Marketly account” after signing in
        with it, or use another email.
      </p>
      <DevOutboxHint what="code" />
    </div>
  );
}
