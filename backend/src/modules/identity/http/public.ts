import { AppError } from '../../../kernel/errors/index.js';
import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/identity.js';
import type { IdentityService } from '../service.js';
import { caller, refreshTokenOf, send } from './client.js';

/**
 * Public API: /api/public/identity/…  (docs/api/modules/identity.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const publicRoutes = (service: IdentityService) =>
  routes(endpoints, 'public', {
    /** POST /registrations: Create a customer account and send an email code */
    register: async (input) => service.register(input.body, caller(input)),
    /** POST /verifications/{id}/confirm: Confirm an email or phone code (registration, email change, phone change) */
    confirmVerification: async (input) => send(input.reply, await service.confirmVerification(input.params.id, input.body, caller(input))),
    /** POST /verifications/{id}/resend: Send a new code */
    resendVerification: async ({ params }) => service.resendVerification(params.id),
    /** POST /sessions: Sign in with email and password */
    signIn: async (input) => send(input.reply, await service.signIn(input.body, caller(input))),
    /** POST /sign-in-challenges/{id}/verify: Complete sign-in with a 2-step code or recovery code */
    verifySecondFactor: async (input) => send(input.reply, await service.verifySecondFactor(input.params.id, input.body, caller(input))),
    /** POST /sign-in-challenges/{id}/send-sms: Text the 2-step code to the saved phone */
    sendSignInSms: async (input) => service.sendSignInSms(input.params.id, caller(input)),
    /** POST /sessions/refresh: Exchange a refresh token for new tokens */
    refreshSession: async (input) => {
      const presented = refreshTokenOf(input.request, input.body);
      if (!presented) throw new AppError('REFRESH_TOKEN_INVALID', 'Sign in again');
      return send(input.reply, await service.refreshSession(presented.token, presented.via, caller(input)));
    },
    /** POST /sessions/sign-out: Sign out this device */
    signOut: async (input) => {
      const presented = refreshTokenOf(input.request, input.body);
      if (presented) send(input.reply, await service.signOut(presented.token, presented.via, caller(input)), presented.via === 'cookie' ? presented.audience : undefined);
    },
    /** POST /password-resets: Email a password reset link */
    requestPasswordReset: async (input) => service.requestPasswordReset(input.body.email, caller(input)),
    /** POST /password-resets/lookups: Check a reset link before showing the new-password form */
    getPasswordReset: async ({ body }) => service.getPasswordReset(body.token),
    /** POST /password-resets/complete: Set a new password from a reset link */
    completePasswordReset: async (input) => service.completePasswordReset(input.body, caller(input)),
    /** GET /password-policy: Password rules for the live checklist */
    getPasswordPolicy: async ({ query }) => service.getPasswordPolicy(query.realm),
    /** POST /app-sessions: Start an app session: the visitor token every request needs */
    startAppSession: async (input) => send(input.reply, await service.startAppSession(input.body)),
    /** POST /order-links/redeem: Open an order from an emailed link */
    redeemOrderLink: async (input) => service.redeemOrderLink(input.body.token, caller(input)),
    /** POST /invitations/lookups: Show an invitation (staff or seller member) */
    getInvitation: async ({ body }) => service.getInvitation(body.token),
    /** POST /invitations/accept: Accept an invitation and set a password */
    acceptInvitation: async (input) => send(input.reply, await service.acceptInvitation(input.body, caller(input))),
    /** POST /invitations/two-step: Staff: confirm the authenticator code and start the first session */
    confirmInvitationTwoStep: async (input) => send(input.reply, await service.confirmInvitationTwoStep(input.body, caller(input))),
    /** POST /external-sign-ins: Continue with Google or Apple */
    externalSignIn: async (input) => send(input.reply, await service.externalSignIn(input.body, caller(input))),
  });
