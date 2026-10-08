import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/identity.js';
import type { IdentityService } from '../service.js';

/**
 * Public API: /api/public/identity/…  (docs/api/modules/identity.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const publicRoutes = (service: IdentityService) => {
  void service;
  return routes(endpoints, 'public', {
    /** POST /registrations: Create a customer account and send an email code */
    register: notImplemented,
    /** POST /verifications/{id}/confirm: Confirm an email or phone code (registration, email change, phone change) */
    confirmVerification: notImplemented,
    /** POST /verifications/{id}/resend: Send a new code */
    resendVerification: notImplemented,
    /** POST /sessions: Sign in with email and password */
    signIn: notImplemented,
    /** POST /sign-in-challenges/{id}/verify: Complete sign-in with a 2-step code or recovery code */
    verifySecondFactor: notImplemented,
    /** POST /sign-in-challenges/{id}/send-sms: Text the 2-step code to the saved phone */
    sendSignInSms: notImplemented,
    /** POST /sessions/refresh: Exchange a refresh token for new tokens */
    refreshSession: notImplemented,
    /** POST /sessions/sign-out: Sign out this device */
    signOut: notImplemented,
    /** POST /password-resets: Email a password reset link */
    requestPasswordReset: notImplemented,
    /** GET /password-resets/{token}: Check a reset link before showing the new-password form */
    getPasswordReset: notImplemented,
    /** POST /password-resets/{token}/complete: Set a new password from a reset link */
    completePasswordReset: notImplemented,
    /** GET /password-policy: Password rules for the live checklist */
    getPasswordPolicy: notImplemented,
    /** POST /guest-sessions: Start a guest session (cart, guest checkout) */
    createGuestSession: notImplemented,
    /** POST /order-links/{token}/redeem: Open an order from an emailed link */
    redeemOrderLink: notImplemented,
    /** GET /invitations/{token}: Show an invitation (staff or seller member) */
    getInvitation: notImplemented,
    /** POST /invitations/{token}/accept: Accept an invitation and set a password */
    acceptInvitation: notImplemented,
    /** POST /invitations/{token}/two-step: Staff: confirm the authenticator code and start the first session */
    confirmInvitationTwoStep: notImplemented,
    /** POST /external-sign-ins: Continue with Google or Apple */
    externalSignIn: notImplemented,
  });
};
