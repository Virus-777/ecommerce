import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router';
import { createContext, useCallback, useContext, useEffect, useRef, useMemo, type ReactNode } from 'react';
import { call, useApi, useSessionState, type SessionTokens } from '@marketly/web-shared/api';
import { BackOfficeIdentityProvider, type BackOfficeIdentity, type NavCount } from '@marketly/web-shared/layouts';
import { announce } from '@marketly/web-shared/ui';
import { SignIn } from './SignIn';

// The Admin and Operations Center session, backed by the API: a staff session (identity, audience admin),
// the staff member's roles and permissions (access/me), and the counts the sidebar and bell show (work
// queues with live counts, staff notice inbox). One session serves both areas (Admin at /, Operations at /ops).

interface StaffSession {
  accountId: string;
  name: string;
  email: string;
  /** Role names, e.g. ["Business Owner", "Platform Administrator"]. */
  roles: string[];
  roleKeys: string[];
  /** The staff member's permission keys. */
  permissions: string[];
  can: (permission: string) => boolean;
  /** Approval requests waiting for this staff member's decision. */
  approvalsToDecide: number;
  adopt: (tokens: SessionTokens) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<StaffSession | null>(null);

/** Which sidebar entry shows a queue's count: queues name the screen they are worked on. */
const NAV_BY_SCREEN: Record<string, { admin?: string; ops?: string }> = {
  'admin/returns': { admin: 'returns' },
  'admin/product-review': { admin: 'review' },
  'admin/reviews': { admin: 'reviews' },
  'admin/seller-application': { admin: 'applications' },
  'admin/payouts': { admin: 'payouts' },
  'admin/cases': { admin: 'cases' },
  'admin/trust': { admin: 'trust' },
  'ops/receiving': { ops: 'receiving' },
  'ops/pick-pack': { ops: 'pick-pack' },
  'ops/dispatch': { ops: 'dispatch' },
  'ops/return-inspection': { ops: 'return-inspection' },
  'ops/finance-checks': { ops: 'finance-checks' },
};

interface QueueCount {
  key: string;
  screen: string;
  open: number;
  overdue: number;
  mine: boolean;
}

function navCounts(queues: QueueCount[], unread: number): Partial<Record<string, NavCount>> {
  const sums: Record<string, { n: number; overdue: number }> = {};
  const add = (key: string, q: QueueCount) => {
    const s = (sums[key] ??= { n: 0, overdue: 0 });
    s.n += q.open;
    s.overdue += q.overdue;
  };
  for (const q of queues) {
    const nav = NAV_BY_SCREEN[q.screen];
    if (nav?.admin) add(nav.admin, q);
    if (nav?.ops) add(nav.ops, q);
    // "Work queues" (Admin sidebar) and "My work queues" (Operations): the queues this person works.
    if (q.mine && q.screen.startsWith('ops/')) {
      add('ops', q);
      add('queues', q);
    }
  }
  const counts: Partial<Record<string, NavCount>> = {};
  for (const [key, s] of Object.entries(sums)) {
    if (!s.n) continue;
    counts[key] = { n: s.n, hot: s.overdue > 0, sr: s.overdue ? `(${s.overdue} overdue)` : 'open', title: s.overdue ? `${s.overdue} overdue of ${s.n}` : undefined };
  }
  if (unread) counts.inbox = { n: unread, sr: 'unread' };
  return counts;
}

/** Signed-in area: loads the staff member's access and the counts, and provides the layout identity. */
function SignedIn({ accountId, children }: { accountId: string; children: ReactNode }) {
  const { api, session } = useApi();
  const qc = useQueryClient();

  const me = useQuery({ queryKey: ['access', 'me', accountId], queryFn: () => call(api.GET('/api/admin/access/me')) });
  const queues = useQuery({ queryKey: ['workqueues', 'queues'], queryFn: () => call(api.GET('/api/admin/workqueues/queues')) as Promise<QueueCount[]>, refetchInterval: 60_000, retry: false });
  const inbox = useQuery({ queryKey: ['notifications', 'summary', 'staff'], queryFn: () => call(api.GET('/api/admin/notifications/inbox/summary')), refetchInterval: 60_000 });

  const signOut = useCallback(async () => {
    await session.signOut();
    qc.clear();
  }, [session, qc]);
  const adopt = useCallback(
    (tokens: SessionTokens) => {
      session.adopt(tokens);
      void qc.invalidateQueries();
    },
    [session, qc],
  );

  const m = me.data;
  const permissions = useMemo(() => m?.permissions ?? [], [m]);
  const roles = useMemo(() => (m?.roles ?? []).map((r) => r.name), [m]);
  const roleKeys = useMemo(() => (m?.roles ?? []).map((r) => r.key), [m]);
  const name = m?.account.displayName ?? '';

  const value = useMemo<StaffSession>(
    () => ({
      accountId,
      name,
      email: m?.account.email ?? '',
      roles,
      roleKeys,
      permissions,
      can: (p: string) => permissions.includes(p) || permissions.includes('*'),
      approvalsToDecide: m?.approvalsToDecide ?? 0,
      adopt,
      signOut,
    }),
    [accountId, name, m, roles, roleKeys, permissions, adopt, signOut],
  );

  const unread = inbox.data?.unread ?? 0;
  const identity: BackOfficeIdentity = {
    user: { name: name || ' ', role: roles[0] ?? '' },
    notifications: unread,
    counts: queues.data || inbox.data ? navCounts(queues.data ?? [], unread) : undefined,
    onSignOut: () => void signOut(),
  };

  return (
    <Ctx.Provider value={value}>
      <BackOfficeIdentityProvider value={identity}>{children}</BackOfficeIdentityProvider>
    </Ctx.Provider>
  );
}

/**
 * Wraps every Admin and Operations route: shows the staff sign-in until the session is a staff session,
 * then the app. The session resumes from the Admin Center refresh cookie on reload.
 */
export function StaffSessionProvider({ children }: { children: ReactNode }) {
  const { session } = useApi();
  const state = useSessionState();
  const { pathname } = useLocation();
  const start = useQuery({ queryKey: ['session', 'start'], queryFn: () => session.token().then(() => true), staleTime: Infinity, retry: false });
  const accountId = state.kind === 'staff' ? (state.claims?.sub as string | undefined) : undefined;
  // After sign-out the session is idle again: that is signed out (sign-in), not starting (loading).
  const started = useRef(false);
  if (state.status === 'ready' || state.status === 'error') started.current = true;
  // The session ended by itself (idle too long, revoked, account disabled; web-shared session.ts): drop the staff
  // data the panels loaded, so the next person to sign in on this PC doesn't see it.
  const qc = useQueryClient();
  useEffect(() => {
    if (state.ended) qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
  }, [state.ended, qc]);
  useEffect(() => {
    if (state.ended) announce(endedText(state.ended));
  }, [state.ended]);
  // The invitation and reset pages are for people who can't sign in yet: no sign-in gate, no staff layout.
  if (PUBLIC_PATHS.has(pathname)) return <>{children}</>;
  if (!state.claims && (state.status === 'starting' || (state.status === 'idle' && !started.current))) {
    return <div className="route-loading" role="status" aria-label="Loading" />;
  }
  if (!accountId) {
    return <SignIn startError={start.error} notice={state.ended ? endedText(state.ended) : undefined} />;
  }
  return <SignedIn accountId={accountId}>{children}</SignedIn>;
}

/** The sign-in screen's line after the session ended without the person signing out. */
function endedText(reason: string): string {
  if (reason === 'session_idle') return 'Signed out after a period without activity. Sign in again to continue.';
  return 'You were signed out. Sign in again to continue.';
}

/** Public staff pages (links from `bootstrap-owner` / `staff-link`), served without signing in. */
export const PUBLIC_PATHS = new Set(['/invitation', '/reset-password']);

export function useStaffSession(): StaffSession {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStaffSession outside StaffSessionProvider');
  return s;
}
