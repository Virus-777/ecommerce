import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/identity.js';
import type { IdentityService } from '../service.js';
import { caller } from './client.js';

/**
 * Admin API: /api/admin/identity/…  (docs/api/modules/identity.md)
 * Staff-realm targets also need identity.staff-accounts.manage (checked in the service, which knows the realm).
 */
export const adminRoutes = (service: IdentityService) =>
  routes(endpoints, 'admin', {
    /** POST /reauth: Confirm it is you before a sensitive Admin Center action (single-use token for one purpose) */
    reauthenticateStaff: async (input) => service.security.reauthenticate(input.body, caller(input)),
    /** GET /accounts: Find accounts (staff or members) */
    listAccounts: async ({ query, page, can }) => service.accounts.listAccounts(query, page, can),
    /** GET /accounts/{id}: Account security detail (devices, lockout, recent activity) */
    getAccount: async ({ params, can }) => service.accounts.getAccountAdmin(params.id, can),
    /** POST /accounts/{id}/lock: Lock an account (suspected compromise, offboarding) */
    lockAccount: async (input) => service.accounts.lockAccount(input.params.id, input.body, caller(input), input.can),
    /** POST /accounts/{id}/unlock: Unlock an account */
    unlockAccount: async (input) => service.accounts.unlockAccount(input.params.id, input.body.reason, caller(input), input.can),
    /** POST /accounts/{id}/force-password-reset: Require a new password at next sign-in */
    forcePasswordReset: async (input) => service.accounts.forcePasswordReset(input.params.id, input.body, caller(input), input.can),
    /** POST /accounts/{id}/reset-two-step: Remove 2-step methods after an identity check (lost phone) */
    resetTwoStep: async (input) => service.accounts.resetTwoStep(input.params.id, input.body, caller(input), input.can),
    /** POST /accounts/{id}/sign-out-all: Sign an account out everywhere */
    signOutAccount: async (input) => service.accounts.signOutAccount(input.params.id, input.body.reason, caller(input), input.can),
    /** POST /accounts/{id}/disable: Disable a staff account (offboarding) */
    disableAccount: async (input) => service.accounts.disableAccount(input.params.id, input.body.reason, caller(input), input.can),
    /** POST /accounts/{id}/enable: Re-enable a disabled staff account */
    enableAccount: async (input) => service.accounts.enableAccount(input.params.id, input.body.reason, caller(input), input.can),
    /** GET /accounts/{id}/security-activity: Security activity of one account */
    listAccountActivity: async ({ params, query, page, can }) => service.accounts.listAccountActivity(params.id, query, page, can),
    /** GET /invitations: Staff invitations */
    listInvitations: async ({ query, page }) => service.invitations.listInvitations(query.status, page),
    /** POST /invitations/{id}/resend: Resend a staff invitation (new 7-day link) */
    // only the invitation: the new pass code is printed by npm run staff-link, never sent over HTTP
    resendInvitation: async (input) => (await service.invitations.resendInvitation(input.params.id, caller(input))).invitation,
    /** POST /invitations/{id}/revoke: Cancel a staff invitation */
    revokeInvitation: async (input) => service.invitations.revokeStaffInvitation(input.params.id, input.body.reason, caller(input)),
  });
