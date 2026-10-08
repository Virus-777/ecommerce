import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/identity.js';
import type { IdentityService } from '../service.js';

/**
 * Admin API: /api/admin/identity/…  (docs/api/modules/identity.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const adminRoutes = (service: IdentityService) =>
  routes(endpoints, 'admin', {
    /** GET /accounts: Find accounts (staff or members) */
    listAccounts: notImplemented,
    /** GET /accounts/{id}: Account security detail (devices, lockout, recent activity) */
    getAccount: notImplemented,
    /** POST /accounts/{id}/lock: Lock an account (suspected compromise, offboarding) */
    lockAccount: notImplemented,
    /** POST /accounts/{id}/unlock: Unlock an account */
    unlockAccount: notImplemented,
    /** POST /accounts/{id}/force-password-reset: Require a new password at next sign-in */
    forcePasswordReset: notImplemented,
    /** POST /accounts/{id}/reset-two-step: Remove 2-step methods after an identity check (lost phone) */
    resetTwoStep: notImplemented,
    /** POST /accounts/{id}/sign-out-all: Sign an account out everywhere */
    signOutAccount: notImplemented,
    /** POST /accounts/{id}/disable: Disable a staff account (offboarding) */
    disableAccount: notImplemented,
    /** POST /accounts/{id}/enable: Re-enable a disabled staff account */
    enableAccount: notImplemented,
    /** GET /accounts/{id}/security-activity: Security activity of one account */
    listAccountActivity: notImplemented,
    /** GET /invitations: Staff invitations */
    listInvitations: notImplemented,
    /** POST /invitations/{id}/resend: Resend a staff invitation (new 7-day link) */
    resendInvitation: notImplemented,
    /** POST /invitations/{id}/revoke: Cancel a staff invitation */
    revokeInvitation: notImplemented,
  });
