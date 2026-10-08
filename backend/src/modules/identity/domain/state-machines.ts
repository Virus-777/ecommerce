/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/identity.js';

/** Account status: AccountSummary.status. Staff accounts start as invited (initial state for that realm); member accounts start pending_verification and cannot sign in until the email code is confirmed (sign-in returns EMAIL_NOT_VERIFIED with a fresh challenge). Automatic locks (failed sign-ins) expire after lockoutMinutes; staff locks have an optional end date. Every move writes a security_events row; staff-initiated moves are also audited. Unverified accounts older than 7 days are deleted by identity.purge-expired. */
export const accountStatusMachine = createStateMachine("Account status", spec.stateMachines["Account status"]);

/** Session: SessionTokens.sessionId (sessions.revoked_at / expires_at). refresh rotates the refresh token; presenting the previous token again (reuse) revokes the session and records refresh_token_reused. passwordChanged revokes other sessions only when signOutOtherDevices is chosen (always for forced resets). Staff sessions have an absolute limit of 12 hours. */
export const sessionMachine = createStateMachine("Session", spec.stateMachines["Session"]);

/** Verification challenge: challenges.status. Codes are 6 digits, stored hashed, valid 10 minutes, 5 attempts. Resend issues a new code on the same challenge after resendAvailableAt (60 s). A new email change supersedes the previous one. */
export const verificationChallengeMachine = createStateMachine("Verification challenge", spec.stateMachines["Verification challenge"]);

/** Invitation: Invitation.status. Links are valid 7 days. Resend issues a new token and invalidates the old one. */
export const invitationMachine = createStateMachine("Invitation", spec.stateMachines["Invitation"]);
