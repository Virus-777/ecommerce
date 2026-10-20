/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/identity.js';

/** Account status: AccountSummary.status. Staff accounts start as invited (initial state for that realm); member accounts start pending_verification and cannot sign in until the email code is confirmed (sign-in returns EMAIL_NOT_VERIFIED with a fresh challenge). Automatic locks (failed sign-ins) expire after lockoutMinutes; staff locks have an optional end date. Every move writes a security_events row; staff-initiated moves are also audited. Unverified accounts older than 7 days are deleted by identity.purge-expired. */
export const accountStatusMachine = createStateMachine("Account status", spec.stateMachines["Account status"]);

/** Invitation: Invitation.status. Links are valid 7 days. Resend issues a new token and invalidates the old one. */
export const invitationMachine = createStateMachine("Invitation", spec.stateMachines["Invitation"]);
