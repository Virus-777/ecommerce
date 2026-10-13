import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { call, useApi, useSessionState, type SessionTokens } from '@marketly/web-shared/api';
import { BackOfficeIdentityProvider, type BackOfficeIdentity } from '@marketly/web-shared/layouts';
import { initials } from '@marketly/web-shared/lib/format';
import { Dialog, Icon } from '@marketly/web-shared/ui';
import { SignIn } from './SignIn';

// The Seller Center session, backed by the API: a seller-audience session (identity) acting for one seller
// (seller context), the seller account (sellers), the member's name (identity security overview), and the
// counts the sidebar and bell show (orders, inventory, returns, messaging, notifications).

export interface SellerContextItem {
  sellerId: string;
  sellerName: string;
  memberId: string;
  roleLabel: string;
  isOwner: boolean;
}

interface SellerSession {
  sellerId: string;
  storeName: string;
  memberName: string;
  roleLabel: string;
  isOwner: boolean;
  /** The member's permission keys (owner: all). */
  permissions: string[];
  can: (permission: string) => boolean;
  /** Seller status: applied | information_required | under_review | approved | restricted | suspended | closed */
  status: string;
  adopt: (tokens: SessionTokens) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SellerSession | null>(null);

const STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'info' | 'muted' }> = {
  approved: { label: 'Approved · selling', tone: 'success' },
  restricted: { label: 'Restricted', tone: 'warning' },
  suspended: { label: 'Suspended', tone: 'danger' },
  under_review: { label: 'Under review', tone: 'info' },
  information_required: { label: 'Information required', tone: 'warning' },
  applied: { label: 'Applied', tone: 'info' },
  closed: { label: 'Closed', tone: 'muted' },
};

/** Store picker for members of several sellers (sign-in and the top-bar store switcher). */
export function StorePicker({ contexts, current, onPick, busy }: { contexts: SellerContextItem[]; current?: string; onPick: (sellerId: string) => void; busy?: string | null }) {
  return (
    <ul className="stack gap-2">
      {contexts.map((c) => (
        <li key={c.sellerId}>
          <button type="button" className="opt-card btn-bare ta-left" style={{ width: '100%' }} onClick={() => onPick(c.sellerId)} disabled={!!busy} aria-current={c.sellerId === current ? 'true' : undefined}>
            <span className="logo-tile sm tint-2" aria-hidden="true">
              {initials(c.sellerName)}
            </span>
            <span className="stack gap-0 grow">
              <span className="strong">{c.sellerName}</span>
              <span className="xs muted">{c.roleLabel}</span>
            </span>
            {busy === c.sellerId ? <span className="spinner" aria-hidden="true" /> : c.sellerId === current ? <Icon name="check" className="ic-sm" /> : <Icon name="chevron-right" className="ic-sm" />}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Signed-in area: loads the account and counts and provides the layout identity. */
function SignedIn({ sellerId, children }: { sellerId: string; children: ReactNode }) {
  const { api, session } = useApi();
  const qc = useQueryClient();
  const [switching, setSwitching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const account = useQuery({ queryKey: ['sellers', 'account', sellerId], queryFn: () => call(api.GET('/api/seller/sellers/account')) });
  const security = useQuery({ queryKey: ['identity', 'security'], queryFn: () => call(api.GET('/api/store/identity/security')) });
  const contexts = useQuery({ queryKey: ['identity', 'sellers'], queryFn: () => call(api.GET('/api/seller/identity/session/sellers')) as Promise<SellerContextItem[]> });
  const orders = useQuery({ queryKey: ['orders', 'counts', sellerId], queryFn: () => call(api.GET('/api/seller/orders/orders/counts')), refetchInterval: 60_000 });
  const stock = useQuery({ queryKey: ['inventory', 'summary', sellerId], queryFn: () => call(api.GET('/api/seller/inventory/summary')) });
  const returns = useQuery({ queryKey: ['returns', 'counts', sellerId], queryFn: () => call(api.GET('/api/seller/returns/requests/counts')) });
  const messages = useQuery({ queryKey: ['messaging', 'stats', sellerId], queryFn: () => call(api.GET('/api/seller/messaging/response-stats')) });
  const inbox = useQuery({ queryKey: ['notifications', 'summary', sellerId], queryFn: () => call(api.GET('/api/seller/notifications/inbox/summary')), refetchInterval: 60_000 });

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
  const pick = async (id: string) => {
    if (id === sellerId) return setSwitching(false);
    setBusy(id);
    try {
      const tokens = await call(api.POST('/api/seller/identity/session/seller-context', { body: { sellerId: id }, credentials: 'include' }));
      adopt(tokens as SessionTokens);
      setSwitching(false);
    } finally {
      setBusy(null);
    }
  };

  const acc = account.data;
  const me = (acc?.me ?? {}) as { role?: string; permissions?: string[]; isOwner?: boolean };
  const ctx = contexts.data?.find((c) => c.sellerId === sellerId);
  const storeName = acc?.storeName ?? ctx?.sellerName ?? '';
  const memberName = security.data?.account.displayName ?? '';
  const roleLabel = ctx?.roleLabel ?? (me.isOwner ? 'Owner' : (me.role ?? ''));
  const permissions = me.permissions ?? [];
  const isOwner = ctx?.isOwner ?? me.isOwner ?? false;
  const status = acc?.status ?? 'approved';

  const value = useMemo<SellerSession>(
    () => ({
      sellerId,
      storeName,
      memberName,
      roleLabel,
      isOwner,
      permissions,
      can: (p: string) => isOwner || permissions.includes(p) || permissions.includes('*'),
      status,
      adopt,
      signOut,
    }),
    [sellerId, storeName, memberName, roleLabel, isOwner, permissions, status, adopt, signOut],
  );

  const o = orders.data;
  const r = returns.data;
  const st = STATUS[status] ?? { label: status, tone: 'muted' as const };
  const identity: BackOfficeIdentity = {
    user: { name: memberName || ' ', role: [roleLabel, storeName].filter(Boolean).join(' · ') },
    store: { name: storeName || ' ', initials: storeName ? initials(storeName) : '', statusLabel: st.label, statusTone: st.tone },
    notifications: inbox.data?.unread ?? 0,
    counts: {
      orders: o ? { n: o.new + o.overdue, hot: o.overdue > 0, sr: o.overdue ? `(${o.overdue} overdue, ${o.new} new)` : `(${o.new} new)`, title: o.overdue ? `${o.overdue} overdue + ${o.new} new` : undefined } : undefined,
      inventory: stock.data ? { n: stock.data.lowStockSkus + stock.data.outOfStockSkus, sr: 'low or out of stock' } : undefined,
      returns: r ? { n: r.awaitingResponse + r.toInspect + r.disputesNeedingEvidence, hot: r.responseOverdue > 0, sr: r.responseOverdue ? `(${r.responseOverdue} overdue)` : undefined } : undefined,
      customers: messages.data ? { n: messages.data.awaitingReply, hot: messages.data.overdue > 0, sr: messages.data.overdue ? `(${messages.data.overdue} overdue)` : 'awaiting reply' } : undefined,
      notifications: inbox.data ? { n: inbox.data.unread, sr: 'unread' } : undefined,
    },
    onSwitchStore: (contexts.data?.length ?? 0) > 1 ? () => setSwitching(true) : undefined,
    onSignOut: () => void signOut(),
  };

  return (
    <Ctx.Provider value={value}>
      <BackOfficeIdentityProvider value={identity}>
        {children}
        <Dialog open={switching} onClose={() => setSwitching(false)} title="Switch store">
          <p className="small sub">You can act for one store at a time. Pages reload for the store you choose.</p>
          <StorePicker contexts={contexts.data ?? []} current={sellerId} onPick={(id) => void pick(id)} busy={busy} />
        </Dialog>
      </BackOfficeIdentityProvider>
    </Ctx.Provider>
  );
}

/**
 * Wraps every Seller Center route: shows sign-in until the session acts for a seller, then the app.
 * The session resumes from the Seller Center refresh cookie on reload.
 */
export function SellerSessionProvider({ children }: { children: ReactNode }) {
  const { session } = useApi();
  const state = useSessionState();
  // Start (or resume) the session on first render: refresh cookie → seller session, else a visitor session.
  useQuery({ queryKey: ['session', 'start'], queryFn: () => session.token().then(() => true), staleTime: Infinity, retry: false });
  const sellerId = state.kind === 'seller' ? (state.claims?.sellerId as string | undefined) : undefined;
  if (state.status !== 'ready' && !state.claims) {
    return state.status === 'error' ? <SignIn /> : <div className="route-loading" role="status" aria-label="Loading" />;
  }
  if (!sellerId) return <SignIn />;
  return <SignedIn sellerId={sellerId}>{children}</SignedIn>;
}

export function useSellerSession(): SellerSession {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSellerSession outside SellerSessionProvider');
  return s;
}

