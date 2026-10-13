import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { call, useApi, useSessionState, type SessionTokens } from '@marketly/web-shared/api';

// The store session, backed by the API: the visitor or customer session (identity), the signed-in
// customer's profile (customers), the cart badge (cart) and unread notifications (notifications).

export interface StoreCustomer {
  id: string;
  /** Display name, e.g. "Jordan Lee". */
  name: string;
  first: string;
  last: string;
  email: string;
  phone: string | null;
  /** "Aug 2026" */
  since: string;
}

interface StoreSession {
  /** False until the visitor or customer session has started. */
  ready: boolean;
  signedIn: boolean;
  /** The signed-in customer; null for visitors (and while the profile loads). */
  customer: StoreCustomer | null;
  cartCount: number;
  /** Cart lines whose price, stock or eligibility changed. */
  cartAttention: number;
  unreadNotifications: number;
  /** Takes the tokens from sign-in, registration or verification and reloads the session data. */
  adopt: (tokens: SessionTokens) => void;
  signOut: () => Promise<void>;
  /** Re-reads the cart badge (after cart changes). */
  refreshCart: () => void;
  /** @deprecated The cart count comes from the API; call refreshCart() after changing the cart. */
  setCartCount: (n: number) => void;
  /** @deprecated Sign-in state comes from the session; this is a no-op kept until every page is wired. */
  setSignedIn: (v: boolean) => void;
}

const Ctx = createContext<StoreSession | null>(null);

const monthYear = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export function SessionProvider({ children }: { children: ReactNode }) {
  const { api, session } = useApi();
  const state = useSessionState();
  const qc = useQueryClient();
  const signedIn = state.kind === 'customer';

  const profile = useQuery({
    queryKey: ['customers', 'profile'],
    queryFn: () => call(api.GET('/api/store/customers/profile')),
    enabled: signedIn,
  });
  const badge = useQuery({
    queryKey: ['cart', 'badge'],
    queryFn: () => call(api.GET('/api/store/cart/cart/badge')),
  });
  const inbox = useQuery({
    queryKey: ['notifications', 'summary'],
    queryFn: () => call(api.GET('/api/store/notifications/inbox/summary')),
    enabled: signedIn,
  });

  const adopt = useCallback(
    (tokens: SessionTokens) => {
      session.adopt(tokens);
      void qc.invalidateQueries();
    },
    [session, qc],
  );
  const signOut = useCallback(async () => {
    await session.signOut();
    qc.clear();
  }, [session, qc]);
  const refreshCart = useCallback(() => void qc.invalidateQueries({ queryKey: ['cart'] }), [qc]);
  const setCartCount = useCallback(
    (n: number) => qc.setQueryData(['cart', 'badge'], (old: { itemCount: number; attentionCount: number } | undefined) => ({ attentionCount: old?.attentionCount ?? 0, itemCount: n })),
    [qc],
  );

  const p = profile.data;
  const value = useMemo<StoreSession>(
    () => ({
      ready: state.status === 'ready',
      signedIn,
      customer:
        signedIn && p
          ? { id: p.id, name: p.displayName, first: p.firstName, last: p.lastName, email: p.email, phone: p.phone ?? null, since: monthYear(p.memberSince) }
          : null,
      cartCount: badge.data?.itemCount ?? 0,
      cartAttention: badge.data?.attentionCount ?? 0,
      unreadNotifications: signedIn ? (inbox.data?.unread ?? 0) : 0,
      adopt,
      signOut,
      refreshCart,
      setCartCount,
      setSignedIn: () => undefined,
    }),
    [state.status, signedIn, p, badge.data, inbox.data, adopt, signOut, refreshCart, setCartCount],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): StoreSession {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
