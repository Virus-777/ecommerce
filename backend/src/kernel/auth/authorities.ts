/**
 * The answers the middleware needs, from the modules that own them (public APIs from the spec).
 * A disabled module, or one whose function is not built yet (NOT_IMPLEMENTED), answers "no":
 * no permissions, no member access, no valid refresh or step-up proof. Fail closed.
 */
import { isNotImplemented } from '../errors/index.js';
import type { PublicApiMap } from '../module-system/public-apis.js';
import type { Principal, SellerMemberAccess } from './index.js';
import type { AccessClaims } from './tokens.js';

export interface Revocations {
  sessions: { sessionId: string; at: string }[];
  accounts: { accountId: string; validAfter: string }[];
  cursor: string;
}

export interface Authorities {
  hasPermission(p: Principal, permission: string): Promise<boolean>;
  getMemberAccess(sellerId: string, accountId: string): Promise<SellerMemberAccess | null>;
  verifyRefreshToken(token: string): Promise<{ sessionId: string; accountId?: string | null; audience: string; kind: string } | null>;
  verifyReauthToken(p: Principal, token: string, purpose: string): Promise<boolean>;
  consumeReauthToken(token: string): Promise<void>;
  verifyStepUpCode(p: Principal, code: string): Promise<boolean>;
  revocationsSince(cursor?: string): Promise<Revocations | null>;
  customerIdOf(accountId: string): Promise<string | null>;
  /** Admin requests: whether the staff session is live (and record the activity); null when identity can't answer */
  touchStaffSession(sessionId: string): Promise<{ live: boolean; reason?: string } | null>;
  /** The oldest Android version code still served (settings apps.android.*); null when settings can't answer */
  androidMinimum(): Promise<{ minVersionCode: number; updateUrl: string | null } | null>;
}

type Modules = 'identity' | 'access' | 'sellers' | 'customers' | 'settings';
/** A module's public API if the module is enabled. */
export type Lookup = <M extends Modules>(module: M) => PublicApiMap[M] | undefined;

/** The module's answer, or `no` when the module is off or the function is not built yet */
async function ask<T>(no: T, call: () => Promise<T | null | undefined> | undefined): Promise<T> {
  try {
    return (await call()) ?? no;
  } catch (err) {
    if (isNotImplemented(err)) return no;
    throw err;
  }
}

export function moduleAuthorities(lookup: Lookup): Authorities {
  return {
    hasPermission: (p, key) => ask(false, () => lookup('access')?.hasPermission(p as never, key)),
    getMemberAccess: (sellerId, accountId) => ask(null, () => lookup('sellers')?.getMemberAccess(sellerId, accountId)),
    verifyRefreshToken: (token) => ask(null, () => lookup('identity')?.verifyRefreshToken(token)),
    verifyReauthToken: (p, token, purpose) => ask(false, () => lookup('identity')?.verifyReauthToken(p as never, token, purpose)),
    consumeReauthToken: (token) => ask(undefined, () => lookup('identity')?.consumeReauthToken(token)),
    verifyStepUpCode: (p, code) => ask(false, () => (p.accountId ? lookup('identity')?.verifyStepUp(p.accountId, { code }) : undefined)),
    revocationsSince: (cursor) =>
      ask(null, async () => {
        const r = await lookup('identity')?.revocationsSince(cursor);
        return r && { sessions: r.sessions, accounts: r.accounts, cursor: r.cursor };
      }),
    customerIdOf: (accountId) => ask(null, async () => (await lookup('customers')?.getCustomerByUserId(accountId))?.id),
    touchStaffSession: (sessionId) => ask(null, () => lookup('identity')?.touchStaffSession(sessionId)),
    // version gating is not authorization: any failure means "don't gate", never a refused request
    androidMinimum: async () => {
      const settings = lookup('settings');
      if (!settings) return null;
      try {
        const [min, updateUrl] = await Promise.all([settings.get<number>('apps.android.minVersionCode'), settings.get<string | null>('apps.android.updateUrl')]);
        return typeof min === 'number' ? { minVersionCode: min, updateUrl: updateUrl ?? null } : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Development and tests only: dev-key tokens carry their own permissions and owner flag, and the
 * fixed proofs `dev-reauth.<purpose>` and step-up code `000000` are accepted. Everything else goes to `next`.
 */
export function devAuthorities(next: Authorities, claimsOf: (p: Principal) => AccessClaims | undefined): Authorities {
  return {
    ...next,
    async hasPermission(p, key) {
      const dev = claimsOf(p)?.dev;
      return dev ? Boolean(dev.permissions?.includes(key) || dev.permissions?.includes('*')) : next.hasPermission(p, key);
    },
    async verifyReauthToken(p, token, purpose) {
      return (claimsOf(p)?.dev !== undefined && token === `dev-reauth.${purpose}`) || next.verifyReauthToken(p, token, purpose); // dev-key tokens only
    },
    async consumeReauthToken(token) {
      if (!token.startsWith('dev-reauth.')) await next.consumeReauthToken(token);
    },
    async verifyStepUpCode(p, code) {
      return (claimsOf(p)?.dev !== undefined && code === '000000') || next.verifyStepUpCode(p, code); // dev-key tokens only
    },
  };
}

/** Seller access from a dev-key token (development and tests). */
export function devSellerAccess(claims: AccessClaims | undefined): SellerMemberAccess | undefined {
  if (!claims?.dev || claims.kind !== 'seller' || !claims.sub) return undefined;
  return { memberId: claims.memberId ?? claims.sub, role: claims.dev.isOwner ? 'owner' : 'member', permissions: claims.dev.permissions ?? [], isOwner: Boolean(claims.dev.isOwner) };
}
