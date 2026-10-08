import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type { IdentityPublicApi, Principal, AccountSummary, VerificationChallenge, GuestSession, Invitation, AccountAdmin } from '../../spec/identity.js';
import type { IdentityRepository } from './ports.js';

export interface IdentityServiceDeps {
  repo: IdentityRepository;
  ctx: ModuleContext<'identity'>;
}

/**
 * Identity use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/identity.json.
 */
export class IdentityService implements IdentityPublicApi {
  constructor(protected readonly deps: IdentityServiceDeps) {}

  /* ---------------- public API (in-process) */

  /** Verify an access token and return who is calling. Used by the kernel HTTP layer for every area; seller principals carry the chosen sellerId and memberId. */
  async authenticate(accessToken: string): Promise<Principal | null> {
    throw notImplemented("identity.authenticate");
  }

  /** Validate the X-Guest-Session header and touch its expiry */
  async verifyGuestSession(guestSessionId: string): Promise<GuestSession | null> {
    throw notImplemented("identity.verifyGuestSession");
  }

  /** Email, display name, status, 2-step state */
  async getAccount(accountId: string): Promise<AccountSummary | null> {
    throw notImplemented("identity.getAccount");
  }

  /** Batch lookup for lists (staff directory, seller members, audit names) */
  async getAccounts(accountIds: string[]): Promise<AccountSummary[]> {
    throw notImplemented("identity.getAccounts");
  }

  /** Used when inviting someone who may already have an account */
  async findAccountByEmail(email: string, realm: 'member' | 'staff'): Promise<AccountSummary | null> {
    throw notImplemented("identity.findAccountByEmail");
  }

  /** Create an invited staff account and send the accept link (event identity.invitation.created). access assigns the roles. */
  async inviteStaff(input: { email: string, name: string, invitedBy: common.Actor }): Promise<Invitation> {
    throw notImplemented("identity.inviteStaff");
  }

  /** Invite a person to act for a seller. Reuses an existing member account when the email has one. */
  async inviteSellerMember(input: { email: string, name: string, sellerId: string, sellerName: string, invitedBy: common.Actor }): Promise<Invitation> {
    throw notImplemented("identity.inviteSellerMember");
  }

  /** Allow an account to sign in to Seller Center for this seller. Called again to refresh the label. */
  async grantSellerContext(input: { accountId: string, sellerId: string, memberId: string, sellerName: string, roleLabel: string, isOwner: boolean }): Promise<void> {
    throw notImplemented("identity.grantSellerContext");
  }

  /** Remove seller access and revoke sessions bound to that seller */
  async revokeSellerContext(accountId: string, sellerId: string, reason: string): Promise<void> {
    throw notImplemented("identity.revokeSellerContext");
  }

  /** Sign an account out everywhere (or in one area). Returns the number of sessions revoked. */
  async revokeSessions(accountId: string, reason: string, audience?: 'store' | 'seller' | 'admin'): Promise<number> {
    throw notImplemented("identity.revokeSessions");
  }

  /** Re-check the password or a 2-step code before a sensitive action (payout destination change, approval of a large payout) */
  async verifyStepUp(accountId: string, proof: { password?: string, code?: string }): Promise<boolean> {
    throw notImplemented("identity.verifyStepUp");
  }

  /** Let a guest session open one order (after guest checkout, a successful lookup in customers, or an emailed link) */
  async grantGuestOrderAccess(guestSessionId: string, orderId: string, email: string, via: 'checkout' | 'lookup' | 'link'): Promise<GuestSession> {
    throw notImplemented("identity.grantGuestOrderAccess");
  }

  /** Gate guest access to order detail, tracking, returns and help */
  async hasGuestOrderAccess(guestSessionId: string, orderId: string): Promise<boolean> {
    throw notImplemented("identity.hasGuestOrderAccess");
  }

  /** Signed link for confirmation and 'email me my order links' emails; redeemed at POST /api/public/identity/order-links/{token}/redeem */
  async issueOrderLink(orderId: string, email: string): Promise<{ url: string, expiresAt: string }> {
    throw notImplemented("identity.issueOrderLink");
  }

  /** Close the member credential after customers completes a closure. Revokes all sessions; keeps Seller Center access if the account still belongs to a seller. */
  async closeAccount(accountId: string, reason: string): Promise<void> {
    throw notImplemented("identity.closeAccount");
  }

  /** Staff-initiated reset from another module's screen (customers account actions) */
  async sendPasswordReset(accountId: string, input: { reason: string, by: common.Actor, revokeSessions: boolean }): Promise<void> {
    throw notImplemented("identity.sendPasswordReset");
  }

  /** Text a 6-digit code to a new mobile number (needs SMS, phase 2; until then the number stays unverified). Confirmed at POST /api/public/identity/verifications/{id}/confirm; publishes identity.user.verified with channel phone. */
  async startPhoneVerification(accountId: string, phone: string): Promise<VerificationChallenge> {
    throw notImplemented("identity.startPhoneVerification");
  }

  /** True when the re-auth token was issued to this account, session, audience and seller for this purpose, is unused and unexpired. Does not consume it. */
  async verifyReauthToken(principal: Principal, token: string, purpose: string): Promise<boolean> {
    throw notImplemented("identity.verifyReauthToken");
  }

  /** Batched staff view of sign-in security for customer 360 views: AccountAdmin (lock, forced reset, 2-step, devices, recent security activity) plus email status, warnings and a one-line sign-in summary. Callers pass identity account ids (Customer.userId). */
  async accountSecurityOf(accountIds: string[], opts?: { activityLimit?: number }): Promise<Map<string, unknown>> {
    throw notImplemented("identity.accountSecurityOf");
  }

  /** Marks a verified re-auth token used; called by the kernel after the request succeeded. */
  async consumeReauthToken(token: string): Promise<void> {
    throw notImplemented("identity.consumeReauthToken");
  }

  /** Revoked sessions and account-wide revocations (tokens issued before validAfter) since a cursor; every server polls this every few seconds and loads the last access-token lifetime on startup. */
  async revocationsSince(cursor?: string): Promise<{ sessions: { sessionId: string, at: string }[], accounts: { accountId: string, validAfter: string }[], cursor: string }> {
    throw notImplemented("identity.revocationsSince");
  }

  /** Middleware check for refresh and sign-out: the session the refresh token belongs to (also during the reuse grace window), or null when it is unknown, expired, revoked or reused. */
  async verifyRefreshToken(refreshToken: string): Promise<{ sessionId: string, accountId?: string, audience: string, kind: string } | null> {
    throw notImplemented("identity.verifyRefreshToken");
  }

  /* ---------------- events consumed */

  /** customers.account.closed: Backstop for closeAccount (idempotent): make sure the member credential is closed and sessions revoked */
  async onAccountClosedFromCustomers(event: EventPayload<"customers.account.closed">): Promise<void> {
    throw notImplemented("identity consumer of customers.account.closed");
  }

  /* ---------------- jobs */

  /** Job identity.purge-expired (hourly): Delete expired challenges, reset tokens, re-auth tokens, order links and guest sessions past their TTL (keeping grants for orders still open), and member accounts never verified after 7 days */
  async purgeExpired(): Promise<void> {
    throw notImplemented("job identity.purge-expired");
  }

  /** Job identity.expire-invitations (hourly): Move pending invitations past expires_at to expired */
  async expireInvitations(): Promise<void> {
    throw notImplemented("job identity.expire-invitations");
  }

  /** Job identity.expire-sessions (every 15 min): Mark sessions past expires_at or absolute_expires_at as expired; prune revoked sessions older than 90 days */
  async expireSessions(): Promise<void> {
    throw notImplemented("job identity.expire-sessions");
  }

  /** Job identity.prune-security-events (daily): Delete security events older than securityEventRetentionDays and sign-in attempts older than 30 days */
  async pruneSecurityEvents(): Promise<void> {
    throw notImplemented("job identity.prune-security-events");
  }
}
