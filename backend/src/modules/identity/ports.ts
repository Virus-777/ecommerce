/**
 * What the identity service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: identity.accounts, identity.password_history, identity.two_step_methods, identity.recovery_codes, identity.challenges, identity.password_resets, identity.devices, identity.sessions, identity.seller_access, identity.invitations, identity.guest_sessions, identity.guest_order_grants, identity.order_links, identity.security_events, identity.sign_in_attempts, identity.reauth_tokens. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IdentityRepository {}
