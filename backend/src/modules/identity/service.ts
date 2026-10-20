import { AppError } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import { isUuid } from '../../kernel/lib/ids.js';
import type * as common from '../../spec/common.js';
import type {
  AccountSummary,
  GuestSession,
  IdentityPublicApi,
  Invitation,
  Principal,
  StaffInvitationIssued,
  VerificationChallenge,
} from '../../spec/identity.js';
import { normalizeEmail } from './domain/policy.js';
import * as map from './mappers.js';
import { Core, type IdentityServiceDeps, MIN, DAY, BATCH, UNVERIFIED_ACCOUNT_DAYS } from './service/core.js';
import { Registration } from './service/registration.js';
import { Authentication } from './service/authentication.js';
import { Sessions } from './service/sessions.js';
import { Passwords } from './service/passwords.js';
import { Security } from './service/security.js';
import { Invitations } from './service/invitations.js';
import { Guests } from './service/guests.js';
import { Accounts } from './service/accounts.js';

export type { Caller, ClientInfo, WithCookie, IdentityServiceDeps, AccountSecurity } from './service/core.js';
export { clientInfo } from './service/core.js';

/**
 * Identity use cases. Depends only on its repository, the event bus, the clock and other modules' public APIs.
 * The work is split by feature (service/*.ts; endpoints call service.<feature>.<method>); this class is the module's
 * public API, its event consumers and jobs (docs/api/spec/modules/identity.json).
 */
export class IdentityService implements IdentityPublicApi {
  readonly core: Core;
  readonly registration: Registration;
  readonly authentication: Authentication;
  readonly sessions: Sessions;
  readonly passwords: Passwords;
  readonly security: Security;
  readonly invitations: Invitations;
  readonly guests: Guests;
  readonly accounts: Accounts;

  constructor(deps: IdentityServiceDeps) {
    this.core = new Core(deps);
    this.registration = new Registration(this.core);
    this.authentication = new Authentication(this.core);
    this.sessions = new Sessions(this.core, this.authentication);
    this.passwords = new Passwords(this.core);
    this.security = new Security(this.core, this.authentication);
    this.invitations = new Invitations(this.core, this.authentication);
    this.guests = new Guests(this.core);
    this.accounts = new Accounts(this.core, this.security, this.authentication, this.passwords, this.invitations);
  }

  /** Public API: invite a staff member (access assigns the roles); the pass code comes back only here */
  inviteStaff(input: { email: string; name: string; invitedBy: common.Actor }): Promise<StaffInvitationIssued> {
    return this.invitations.inviteStaff(input);
  }

  /** Public API: invite a person to act for a seller (reuses their member account) */
  inviteSellerMember(input: { email: string; name: string; sellerId: string; sellerName: string; invitedBy: common.Actor }): Promise<Invitation> {
    return this.invitations.inviteSellerMember(input);
  }

  /**
   * Public API: cancel a pending invitation (sellers passes its sellerId as contextRef). Another context's
   * invitation is NOT_FOUND; an already revoked one comes back unchanged; accepted or expired ones are
   * ILLEGAL_TRANSITION.
   */
  revokeInvitation(invitationId: string, input: { reason: string; by: common.Actor; contextRef?: string }): Promise<Invitation> {
    return this.invitations.revokeInvitation(invitationId, input);
  }

  /** Allow an account to sign in to Seller Center for this seller (called again to refresh the label) */
  grantSellerContext(input: { accountId: string; sellerId: string; memberId: string; sellerName: string; roleLabel: string; isOwner: boolean }): Promise<void> {
    return this.sessions.grantSellerContext(input);
  }

  /** Remove seller access and revoke sessions bound to that seller */
  revokeSellerContext(accountId: string, sellerId: string, reason: string): Promise<void> {
    return this.sessions.revokeSellerContext(accountId, sellerId, reason);
  }

  /** Sign an account out everywhere (or in one area) */
  revokeSessions(accountId: string, reason: string, audience?: 'store' | 'seller' | 'admin'): Promise<number> {
    return this.sessions.revokeSessions(accountId, reason, audience);
  }

  /** Public API: let a guest session open one order */
  grantGuestOrderAccess(guestSessionId: string, orderId: string, email: string, via: 'checkout' | 'lookup' | 'link'): Promise<GuestSession> {
    return this.guests.grantGuestOrderAccess(guestSessionId, orderId, email, via);
  }

  /** Public API: whether a guest session may open an order */
  hasGuestOrderAccess(guestSessionId: string, orderId: string): Promise<boolean> {
    return this.guests.hasGuestOrderAccess(guestSessionId, orderId);
  }

  /** Public API: emailed order link (token in the fragment; redeemed in the body) */
  issueOrderLink(orderId: string, email: string, orderRef?: string): Promise<{ url: string; expiresAt: string }> {
    return this.guests.issueOrderLink(orderId, email, orderRef);
  }

  /** Close the member credential after customers completes a closure (idempotent) */
  closeAccount(accountId: string, reason: string): Promise<void> {
    return this.accounts.closeAccount(accountId, reason);
  }

  /** Staff-initiated reset link from another module's screen */
  sendPasswordReset(accountId: string, input: { reason: string; by: common.Actor; revokeSessions: boolean }): Promise<void> {
    return this.passwords.sendPasswordReset(accountId, input);
  }

  /** Text a code to a new mobile number (identity.user.verified with channel phone when confirmed) */
  startPhoneVerification(accountId: string, phone: string): Promise<VerificationChallenge> {
    return this.registration.startPhoneVerification(accountId, phone);
  }

  /** Public API (middleware): is this re-auth token valid for this principal and this purpose? Does not consume it. */
  verifyReauthToken(principal: Principal, token: string, purpose: string): Promise<boolean> {
    return this.security.verifyReauthToken(principal, token, purpose);
  }

  /** Batched staff view for the customer 360 (GraphQL Customer.security) */
  accountSecurityOf(accountIds: string[], opts?: { activityLimit?: number }): Promise<Map<string, unknown>> {
    return this.security.accountSecurityOf(accountIds, opts);
  }

  /** Public API (kernel, before the handler): claims the token for one request; false when another request already has */
  consumeReauthToken(token: string): Promise<boolean> {
    return this.security.consumeReauthToken(token);
  }

  /** Public API (kernel): the request that claimed the token failed, so it can be used again */
  releaseReauthToken(token: string): Promise<void> {
    return this.security.releaseReauthToken(token);
  }

  /**
   * Revoked sessions and account-wide revocations since a cursor. Without a cursor: the last
   * access-token lifetime. Polled by every server every few seconds.
   */
  revocationsSince(cursor?: string): Promise<{ sessions: { sessionId: string; at: string }[]; accounts: { accountId: string; validAfter: string }[]; cursor: string }> {
    return this.sessions.revocationsSince(cursor);
  }

  /**
   * Middleware check for refresh and sign-out (kernel/auth/authorities.ts). The previous token
   * still counts during the grace window (parallel refresh); outside it, reuse revokes the session.
   */
  verifyRefreshToken(refreshToken: string): Promise<{ sessionId: string; accountId?: string; audience: string; kind: string } | null> {
    return this.sessions.verifyRefreshToken(refreshToken);
  }

  /**
   * Middleware check on every admin request (kernel/auth/chain.ts, cached 5 s per server): the session is
   * live, and the request is activity that keeps it from going idle. The write happens at most once a
   * minute per session, so a busy staff member costs one indexed read per few seconds.
   */
  touchStaffSession(sessionId: string): Promise<{ live: boolean; reason?: 'revoked' | 'expired' | 'idle' | 'unknown' }> {
    return this.sessions.touchStaffSession(sessionId);
  }

  /** The same answer without recording activity: open live notification streams check it every heartbeat (kernel/auth/chain.ts) */
  staffSessionState(sessionId: string): Promise<{ live: boolean; reason?: 'revoked' | 'expired' | 'idle' | 'unknown' }> {
    return this.sessions.staffSessionState(sessionId);
  }

  async getAccount(accountId: string): Promise<AccountSummary | null> {
    if (!isUuid(accountId)) return null;
    const a = await this.core.repo.getAccount(accountId);
    return a ? this.core.summaryOf(a) : null;
  }

  async getAccounts(accountIds: string[]): Promise<AccountSummary[]> {
    const ids = [...new Set(accountIds.filter(isUuid))];
    const [rows, twoStep] = await Promise.all([this.core.repo.getAccounts(ids), this.core.repo.withTwoStep(ids)]);
    const now = this.core.now();
    const byId = new Map(rows.map((a) => [a.id, map.accountSummary(a, twoStep.has(a.id), now)]));
    return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  }

  async findAccountByEmail(email: string, realm: 'member' | 'staff'): Promise<AccountSummary | null> {
    const a = await this.core.repo.findAccount(realm, normalizeEmail(email));
    return a ? this.core.summaryOf(a) : null;
  }

  /** customers.account.closed: backstop for closeAccount (idempotent; unknown accounts are ignored) */
  async onAccountClosedFromCustomers(event: EventPayload<'customers.account.closed'>): Promise<void> {
    try {
      await this.accounts.closeAccount(event.userId, 'Customer account closed');
    } catch (err) {
      if (err instanceof AppError && (err.code === 'NOT_FOUND' || err.code === 'ILLEGAL_TRANSITION')) {
        this.core.ctx.log.warn({ userId: event.userId, code: err.code }, 'identity: customers.account.closed for an account that cannot be closed here; ignored');
        return;
      }
      throw err;
    }
  }

  /** identity.purge-expired (hourly) */
  async purgeExpired(): Promise<void> {
    const now = this.core.now();
    const drain = async (step: () => Promise<number>) => {
      for (let i = 0; i < 100 && (await step()) >= BATCH; i++);
    };
    await drain(() => this.core.repo.deleteExpiredChallenges(now, BATCH));
    await drain(() => this.core.repo.deleteExpiredResets(now, BATCH));
    await drain(() => this.core.repo.deleteExpiredReauthTokens(now, BATCH));
    await drain(() => this.core.repo.deleteExpiredOrderLinks(now, BATCH));
    await drain(() => this.core.repo.deleteExpiredGrants(now, BATCH));
    await drain(() => this.core.repo.deleteExpiredGuestSessions(now, BATCH));
    await drain(() => this.core.repo.transaction((repo) => repo.deleteUnverifiedAccounts(new Date(now.getTime() - UNVERIFIED_ACCOUNT_DAYS * DAY), 100)).then((n) => (n >= 100 ? BATCH : n)));
  }

  /** identity.expire-invitations (hourly) */
  async expireInvitations(): Promise<void> {
    const now = this.core.now();
    for (let i = 0; i < 100 && (await this.core.repo.expirePendingInvitations(now, BATCH)) >= BATCH; i++);
  }

  /** identity.expire-sessions (every 15 min) */
  async expireSessions(): Promise<void> {
    const staffIdle = await this.core.ctx.settings.get('staffIdleMinutes');
    const now = this.core.now();
    const idleBefore = new Date(now.getTime() - staffIdle * MIN);
    for (let i = 0; i < 100 && (await this.core.repo.expireSessions(now, idleBefore, BATCH)) >= BATCH; i++);
    const before = new Date(now.getTime() - 90 * DAY);
    for (let i = 0; i < 100 && (await this.core.repo.pruneRevokedSessions(before, BATCH)) >= BATCH; i++);
  }

  /** identity.prune-security-events (daily) */
  async pruneSecurityEvents(): Promise<void> {
    const days = await this.core.ctx.settings.get('securityEventRetentionDays');
    const now = this.core.now();
    const eventsBefore = new Date(now.getTime() - days * DAY);
    const attemptsBefore = new Date(now.getTime() - 30 * DAY);
    for (let i = 0; i < 100 && (await this.core.repo.deleteSecurityEventsBefore(eventsBefore, BATCH)) >= BATCH; i++);
    for (let i = 0; i < 100 && (await this.core.repo.deleteSignInAttemptsBefore(attemptsBefore, BATCH)) >= BATCH; i++);
  }
}
