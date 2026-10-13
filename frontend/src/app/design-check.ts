import { useMemo } from 'react';
import { call, useApi } from '@marketly/web-shared/api';
import type { DesignCheckSessions } from '@marketly/web-shared/routes';
import { deviceInfo, WITH_COOKIE } from '@/pages/auth/data/parts';
import { useSession } from './session';

/**
 * Development only (/design/check): the store's session switches for the design samples.
 *   visitor  – sign out through the store session (clears the refresh cookie and the query cache); the next
 *              request starts a fresh visitor session with an empty guest cart.
 *   customer – sign out first (so no guest cart is claimed into the customer's cart), then the dev Google
 *              sign-in (`dev:<email>:<first>:<last>`, audience store) and adopt the tokens, like "Continue with
 *              Google" does in development.
 */
export function useDesignCheckSessions(): DesignCheckSessions {
  const { api } = useApi();
  const { signOut, adopt } = useSession();
  return useMemo(
    () => ({
      visitor: () => signOut(),
      customer: async ({ email, first, last }) => {
        await signOut();
        const r = await call(
          api.POST('/api/public/identity/external-sign-ins', {
            body: { provider: 'google', idToken: `dev:${email}:${first}:${last}`, audience: 'store', device: deviceInfo(), marketingOptIn: false },
            ...WITH_COOKIE,
          }),
        );
        if (r.status !== 'signed_in' || !r.tokens) throw new Error(`Dev sign-in as ${email} answered ${r.status}`);
        adopt(r.tokens);
      },
    }),
    [api, signOut, adopt],
  );
}
