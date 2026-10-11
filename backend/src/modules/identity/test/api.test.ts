/**
 * Seller context, guest sessions and order links, the in-process API other modules and the kernel
 * call, the consumed event, the jobs and the GraphQL resolver.
 * sellers is another tranche: sellers.getMemberAccess is stubbed from the grants made here.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GraphQLContext } from '../../../kernel/graphql/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { IdentityPublicApi } from '../../../spec/identity.js';
import { resolvers } from '../graphql/resolvers.js';
import type { IdentityService } from '../service.js';
import { android, boot, customer, PUBLIC, SELLER, signIn, STORE, STRONG, uniqueEmail, visitor, web, type TestKit } from './helpers.js';

/** sellerId:accountId → memberId, as the sellers module would answer */
const members = new Map<string, string>();

let kit: TestKit;
let identity: IdentityPublicApi & IdentityService;
beforeAll(async () => {
  kit = await boot({
    apiStubs: {
      sellers: { getMemberAccess: async (sellerId, accountId) => (members.has(`${sellerId}:${accountId}`) ? { memberId: members.get(`${sellerId}:${accountId}`)!, role: 'owner', permissions: [], isOwner: true } : null) },
    },
  });
  identity = kit.app.kernel.boot.apis.get('identity') as never;
});
afterAll(async () => {
  await kit.app.close();
});

async function grant(accountId: string, sellerName: string) {
  const sellerId = newId();
  const memberId = newId();
  members.set(`${sellerId}:${accountId}`, memberId);
  await identity.grantSellerContext({ accountId, sellerId, memberId, sellerName, roleLabel: 'Owner', isOwner: true });
  return { sellerId, memberId };
}

const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());

describe('seller context', () => {
  it('signs a member with one seller straight into that seller', async () => {
    const c = await customer(kit);
    const s = await grant(c.accountId, 'Casa Verde Home');
    const res = await signIn(kit, { email: c.email, password: c.password, audience: 'seller' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'signed_in', tokens: { audience: 'seller', sellerId: s.sellerId }, sellerContexts: [{ sellerId: s.sellerId, sellerName: 'Casa Verde Home', memberId: s.memberId, isOwner: true }] });
    expect(claims(res.body.tokens.accessToken)).toMatchObject({ aud: 'seller', kind: 'seller', sellerId: s.sellerId, memberId: s.memberId, sub: c.accountId });
    const list = await kit.call('GET', `${SELLER}/session/sellers`, { token: res.body.tokens.accessToken });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body).toHaveLength(1);
    // the store-area security endpoints take the seller session too
    expect((await kit.call('GET', `${STORE}/security`, { token: res.body.tokens.accessToken })).status).toBe(200);
  });

  it('asks a member of several sellers to choose, then re-issues tokens for the chosen one', async () => {
    const c = await customer(kit);
    const a = await grant(c.accountId, 'Alpha Goods');
    const b = await grant(c.accountId, 'Beta Supply');
    const res = await signIn(kit, { email: c.email, password: c.password, audience: 'seller' });
    expect(res.body.status).toBe('seller_context_required');
    expect(res.body.sellerContexts.map((x: any) => x.sellerName)).toEqual(['Alpha Goods', 'Beta Supply']);
    expect(res.body.tokens.sellerId ?? null).toBeNull();
    const t = res.body.tokens.accessToken;
    expect((await kit.call('GET', `${SELLER}/session/sellers`, { token: t })).body).toHaveLength(2);

    // seller re-auth works before a seller is chosen; the token is bound to "no seller"
    const early = await kit.call('POST', `${SELLER}/reauth`, { token: t, body: { purpose: 'seller-closure', password: c.password } });
    expect(early.status, JSON.stringify(early.body)).toBe(200);
    const unchosen = { kind: 'seller' as const, accountId: c.accountId, sessionId: res.body.tokens.sessionId, sellerId: null };
    expect(await identity.verifyReauthToken(unchosen, early.body.reauthToken, 'seller-closure')).toBe(true);
    expect(await identity.verifyReauthToken({ ...unchosen, sellerId: a.sellerId }, early.body.reauthToken, 'seller-closure')).toBe(false);

    const nope = await kit.call('POST', `${SELLER}/session/seller-context`, { token: t, body: { sellerId: newId() } });
    expect(nope.status).toBe(403);
    expect(nope.body.error.code).toBe('NO_SELLER_ACCESS');
    const pick = await kit.call('POST', `${SELLER}/session/seller-context`, { token: t, body: { sellerId: b.sellerId } });
    expect(pick.status, JSON.stringify(pick.body)).toBe(200);
    expect(pick.body).toMatchObject({ sessionId: res.body.tokens.sessionId, sellerId: b.sellerId });
    expect(claims(pick.body.accessToken)).toMatchObject({ sellerId: b.sellerId, memberId: members.get(`${b.sellerId}:${c.accountId}`) });

    // a preferred seller at sign-in is honoured
    const pref = await signIn(kit, { email: c.email, password: c.password, audience: 'seller', sellerId: a.sellerId });
    expect(pref.body).toMatchObject({ status: 'signed_in', tokens: { sellerId: a.sellerId } });

    // seller re-auth tokens are bound to the session, the seller and the purpose
    const reauth = await kit.call('POST', `${SELLER}/reauth`, { token: pick.body.accessToken, body: { purpose: 'payout-account', password: c.password } });
    expect(reauth.status, JSON.stringify(reauth.body)).toBe(200);
    const principal = { kind: 'seller' as const, accountId: c.accountId, sessionId: res.body.tokens.sessionId, sellerId: b.sellerId };
    expect(await identity.verifyReauthToken(principal, reauth.body.reauthToken, 'payout-account')).toBe(true);
    expect(await identity.verifyReauthToken(principal, reauth.body.reauthToken, 'business-change')).toBe(false);
    expect(await identity.verifyReauthToken({ ...principal, sellerId: a.sellerId }, reauth.body.reauthToken, 'payout-account')).toBe(false);
    expect(await identity.verifyReauthToken({ ...principal, sessionId: newId() }, reauth.body.reauthToken, 'payout-account')).toBe(false);
    // the token from before the seller was chosen does not follow the session into a seller
    expect(await identity.verifyReauthToken(principal, early.body.reauthToken, 'seller-closure')).toBe(false);
    // single use: the first claim wins and a second is refused; a failed request puts the token back
    expect(await identity.consumeReauthToken(reauth.body.reauthToken)).toBe(true);
    expect(await identity.consumeReauthToken(reauth.body.reauthToken)).toBe(false);
    await identity.releaseReauthToken(reauth.body.reauthToken);
    expect(await identity.verifyReauthToken(principal, reauth.body.reauthToken, 'payout-account')).toBe(true);
    expect(await identity.consumeReauthToken(reauth.body.reauthToken)).toBe(true);
    expect(await identity.verifyReauthToken(principal, reauth.body.reauthToken, 'payout-account')).toBe(false);
    const noPurpose = await kit.call('POST', `${SELLER}/reauth`, { token: pick.body.accessToken, body: { purpose: '  ', password: c.password } });
    expect(noPurpose.status).toBe(400);
    expect(noPurpose.body.error.details.issues[0].path).toBe('body.purpose');
    // only the declared reauth step-up purposes (code step-ups such as role-grant never take a token)
    for (const purpose of ['anything-else', 'role-grant']) {
      const unknown = await kit.call('POST', `${SELLER}/reauth`, { token: pick.body.accessToken, body: { purpose, password: c.password } });
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.details.issues[0].path).toBe('body.purpose');
    }

    // a store re-auth token never works for a seller session
    const store = await kit.call('POST', `${STORE}/reauth`, { token: c.tokens.accessToken, body: { purpose: 'payout-account', password: c.password } });
    expect(store.status, JSON.stringify(store.body)).toBe(200);
    expect(await identity.verifyReauthToken(principal, store.body.reauthToken, 'payout-account')).toBe(false);

    // revoking access ends the sessions bound to that seller
    await identity.revokeSellerContext(c.accountId, b.sellerId, 'Removed by owner');
    const refresh = await kit.call('POST', `${PUBLIC}/sessions/refresh`, { body: { refreshToken: pick.body.refreshToken } });
    expect(refresh.status).toBe(401);
    await kit.syncRevocations();
    expect((await kit.call('GET', `${SELLER}/session/sellers`, { token: pick.body.accessToken })).status).toBe(401);
    expect((await kit.call('GET', `${SELLER}/session/sellers`, { token: pref.body.accessToken ?? pref.body.tokens.accessToken })).status).toBe(200);
  });
});

describe('seller-member invitations', () => {
  it('creates a member account from an invitation and signs it in to Seller Center', async () => {
    const sellerId = newId();
    const email = uniqueEmail('member');
    const inv = await identity.inviteSellerMember({ email, name: 'Mo Member', sellerId, sellerName: 'Gamma Tools', invitedBy: { kind: 'seller', id: newId() } });
    await kit.app.kernel.events.drain();
    expect(inv).toMatchObject({ purpose: 'seller_member', realm: 'member', contextRef: sellerId, contextLabel: 'Gamma Tools', accountId: null });
    const token = new URL(kit.last('identity.invitation.created').acceptUrl).hash.replace('#token=', '');
    expect(kit.last('identity.invitation.created').acceptUrl).toMatch(/^http:\/\/localhost:3001\//); // SELLER_URL (development default)
    const v = await visitor(kit, 'seller');
    const view = await kit.call('POST', `${PUBLIC}/invitations/lookups`, { token: v.accessToken, body: { token } });
    expect(view.body).toMatchObject({ purpose: 'seller_member', existingAccount: false, requiresTwoStepSetup: false, contextLabel: 'Gamma Tools' });
    const accept = await kit.call('POST', `${PUBLIC}/invitations/accept`, { token: v.accessToken, body: { token, password: STRONG, device: web } });
    expect(accept.status, JSON.stringify(accept.body)).toBe(200);
    expect(accept.body).toMatchObject({ status: 'signed_in', account: { email, status: 'active', emailVerified: true }, tokens: { audience: 'seller', refreshToken: '' } });
    expect(kit.last('identity.invitation.accepted')).toMatchObject({ invitationId: inv.id, purpose: 'seller_member', contextRef: sellerId });
  });

  it('asks an existing member for the current password', async () => {
    const c = await customer(kit);
    const sellerId = newId();
    await identity.inviteSellerMember({ email: c.email.toUpperCase(), name: 'Ana Lopez', sellerId, sellerName: 'Delta', invitedBy: { kind: 'seller', id: newId() } });
    await kit.app.kernel.events.drain();
    const token = new URL(kit.last('identity.invitation.created').acceptUrl).hash.replace('#token=', '');
    const v = await visitor(kit, 'seller');
    expect((await kit.call('POST', `${PUBLIC}/invitations/lookups`, { token: v.accessToken, body: { token } })).body.existingAccount).toBe(true);
    const wrong = await kit.call('POST', `${PUBLIC}/invitations/accept`, { token: v.accessToken, body: { token, currentPassword: 'Wrong-Pass-11', device: android() } });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const ok = await kit.call('POST', `${PUBLIC}/invitations/accept`, { token: v.accessToken, body: { token, currentPassword: c.password, device: android() } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.account.id).toBe(c.accountId);
  });
});

describe('revokeInvitation (public API)', () => {
  it("cancels only its own context's pending invitation, is idempotent, and refuses accepted or expired ones", async () => {
    const sellerId = newId();
    const by = { kind: 'seller' as const, id: newId() };
    const inv = await identity.inviteSellerMember({ email: uniqueEmail('revoke'), name: 'Rae Revoke', sellerId, sellerName: 'Epsilon', invitedBy: by });
    await kit.app.kernel.events.drain();
    const token = new URL(kit.last('identity.invitation.created').acceptUrl).hash.replace('#token=', '');
    // another seller's id: not found (never confirms the invitation exists)
    await expect(identity.revokeInvitation(inv.id, { reason: 'no', by, contextRef: newId() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(identity.revokeInvitation(newId(), { reason: 'no', by })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const before = kit.of('identity.invitation.revoked').length;
    const revoked = await identity.revokeInvitation(inv.id, { reason: 'Hired elsewhere', by, contextRef: sellerId });
    expect(revoked).toMatchObject({ id: inv.id, status: 'revoked' });
    await kit.app.kernel.events.drain();
    expect(kit.last('identity.invitation.revoked')).toMatchObject({ invitationId: inv.id, purpose: 'seller_member', contextRef: sellerId });
    // the link stops working at once
    const v = await visitor(kit, 'seller');
    expect((await kit.call('POST', `${PUBLIC}/invitations/lookups`, { token: v.accessToken, body: { token } })).body.error.code).toBe('INVITATION_INVALID');
    // again: unchanged, no second event
    expect(await identity.revokeInvitation(inv.id, { reason: 'again', by, contextRef: sellerId })).toMatchObject({ status: 'revoked' });
    await kit.app.kernel.events.drain();
    expect(kit.of('identity.invitation.revoked').length).toBe(before + 1);

    // accepted
    const acc = await identity.inviteSellerMember({ email: uniqueEmail('accepted'), name: 'Ace Accepted', sellerId, sellerName: 'Epsilon', invitedBy: by });
    await kit.app.kernel.events.drain();
    const t2 = new URL(kit.last('identity.invitation.created').acceptUrl).hash.replace('#token=', '');
    const v2 = await visitor(kit, 'seller');
    expect((await kit.call('POST', `${PUBLIC}/invitations/accept`, { token: v2.accessToken, body: { token: t2, password: STRONG, device: web } })).status).toBe(200);
    await expect(identity.revokeInvitation(acc.id, { reason: 'late', by, contextRef: sellerId })).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });

    // expired (past the link's end, before the hourly job marks it)
    const old = await identity.inviteSellerMember({ email: uniqueEmail('expired'), name: 'Old Link', sellerId, sellerName: 'Epsilon', invitedBy: by });
    kit.clock.advance(8 * 24 * 3600_000);
    await expect(identity.revokeInvitation(old.id, { reason: 'late', by, contextRef: sellerId })).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
  });
});

describe('guest sessions and order links', () => {
  it('grants a visitor session access to an order and redeems emailed links', async () => {
    const v = await visitor(kit);
    const orderId = newId();
    const g = await identity.grantGuestOrderAccess(v.sessionId, orderId, 'Guest@Example.com', 'checkout');
    expect(g).toMatchObject({ id: v.sessionId, orderIds: [orderId] });
    expect(await identity.hasGuestOrderAccess(v.sessionId, orderId)).toBe(true);
    expect(await identity.hasGuestOrderAccess(v.sessionId, newId())).toBe(false);
    await expect(identity.grantGuestOrderAccess(newId(), orderId, 'x@example.com', 'lookup')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const link = await identity.issueOrderLink(orderId, 'guest@example.com');
    expect(link.url).toMatch(/^http:\/\/localhost:3000\/orders\/open#token=/); // STORE_URL (development default)
    const token = new URL(link.url).hash.replace('#token=', '');
    const other = await visitor(kit);
    const redeemed = await kit.call('POST', `${PUBLIC}/order-links/redeem`, { token: other.accessToken, body: { token } });
    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(200);
    expect(redeemed.body).toMatchObject({ orderId, guestSession: { id: other.sessionId, orderIds: [orderId] } });
    expect(redeemed.body.emailMasked).toBe('g••••@example.com');
    expect(await identity.hasGuestOrderAccess(other.sessionId, orderId)).toBe(true);
    const bad = await kit.call('POST', `${PUBLIC}/order-links/redeem`, { token: other.accessToken, body: { token: 'not-a-real-order-link-token' } });
    expect(bad.status).toBe(410);
    expect(bad.body.error.code).toBe('ORDER_LINK_INVALID');
    kit.clock.advance(181 * 24 * 3600_000);
    expect((await kit.call('POST', `${PUBLIC}/order-links/redeem`, { token: (await visitor(kit)).accessToken, body: { token } })).status).toBe(410);
    kit.clock.set(new Date());
  });

  it('a claimed visitor session loses its grants', async () => {
    const v = await visitor(kit);
    const orderId = newId();
    await identity.grantGuestOrderAccess(v.sessionId, orderId, 'buyer@example.com', 'checkout');
    const c = await customer(kit);
    const s = await kit.call('POST', `${PUBLIC}/sessions`, { token: v.accessToken, body: { email: c.email, password: c.password, audience: 'store', keepSignedIn: false, device: android() } });
    expect(s.body.status).toBe('signed_in');
    expect(kit.last('identity.guest_session.claimed')).toEqual({ guestSessionId: v.sessionId, accountId: c.accountId });
    expect(await identity.hasGuestOrderAccess(v.sessionId, orderId)).toBe(false);
    await expect(identity.grantGuestOrderAccess(v.sessionId, newId(), 'buyer@example.com', 'checkout')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('identity.guest_session.claimed always names the visitor session (registration claims it too)', async () => {
    const v = await visitor(kit);
    const email = uniqueEmail('claim');
    const reg = await kit.call('POST', `${PUBLIC}/registrations`, {
      token: v.accessToken,
      body: { email, password: STRONG, firstName: 'Cleo', lastName: 'Claim', marketingOptIn: false, acceptedTermsVersion: '2026-01', device: android() },
    });
    expect(reg.status, JSON.stringify(reg.body)).toBe(202);
    const code = kit.of('identity.verification.code_issued').filter((e) => e.challengeId === reg.body.id).at(-1).code as string;
    const conf = await kit.call('POST', `${PUBLIC}/verifications/${reg.body.id}/confirm`, { token: v.accessToken, body: { code, device: android() } });
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    const claimed = kit.of('identity.guest_session.claimed').filter((e) => e.accountId === conf.body.account.id);
    expect(claimed).toEqual([{ guestSessionId: v.sessionId, accountId: conf.body.account.id }]);
    for (const e of kit.of('identity.guest_session.claimed')) expect(e.guestSessionId).toEqual(expect.any(String));
  });
});

describe('in-process API', () => {
  it('looks accounts up', async () => {
    const c = await customer(kit);
    expect(await identity.getAccount(c.accountId)).toMatchObject({ id: c.accountId, realm: 'member', status: 'active', emailVerified: true, twoStepEnabled: false });
    expect(await identity.getAccount(newId())).toBeNull();
    const many = await identity.getAccounts([c.accountId, newId(), 'not-a-uuid']);
    expect(many.map((a) => a.id)).toEqual([c.accountId]);
    expect((await identity.findAccountByEmail(`  ${c.email.toUpperCase()} `, 'member'))!.id).toBe(c.accountId);
    expect(await identity.findAccountByEmail(c.email, 'staff')).toBeNull();
  });

  it('revokes sessions in-process; the middleware then refuses their tokens', async () => {
    const c = await customer(kit);
    expect((await kit.call('GET', `${STORE}/security`, { token: c.tokens.accessToken })).status).toBe(200);
    expect(await identity.revokeSessions(c.accountId, 'Trust action', 'store')).toBe(1);
    await kit.syncRevocations();
    expect((await kit.call('GET', `${STORE}/security`, { token: c.tokens.accessToken })).status).toBe(401);
  });

  it('publishes revocations for the middleware, with a cursor', async () => {
    const first = await identity.revocationsSince();
    const c = await customer(kit);
    kit.clock.advance(1000);
    const n = await identity.revokeSessions(c.accountId, 'Security review');
    expect(n).toBe(1);
    const next = await identity.revocationsSince(first.cursor);
    expect(next.sessions.map((s) => s.sessionId)).toContain(c.tokens.sessionId);
    expect(next.accounts.map((a) => a.accountId)).toContain(c.accountId);
    // claimed visitor sessions are revoked too
    expect(next.sessions.map((s) => s.sessionId)).toContain(c.visitor.sessionId);
  });

  it('verifies refresh tokens for the middleware', async () => {
    const c = await customer(kit);
    expect(await identity.verifyRefreshToken(c.tokens.refreshToken)).toEqual({ sessionId: c.tokens.sessionId, accountId: c.accountId, audience: 'store', kind: 'customer' });
    const v = await visitor(kit, 'seller');
    expect(await identity.verifyRefreshToken(v.refreshToken)).toEqual({ sessionId: v.sessionId, audience: 'seller', kind: 'visitor' });
    expect(await identity.verifyRefreshToken('s.unknown-token-of-sufficient-length')).toBeNull();
  });

  it('closes a member credential (idempotent), keeping Seller Center sign-in for sellers', async () => {
    const c = await customer(kit);
    await identity.closeAccount(c.accountId, 'Customer asked');
    await identity.closeAccount(c.accountId, 'Customer asked');
    await kit.app.kernel.events.drain();
    expect(kit.of('identity.account.closed').filter((e) => e.accountId === c.accountId)).toHaveLength(1);
    expect((await identity.getAccount(c.accountId))!.status).toBe('closed');
    const res = await signIn(kit, { email: c.email, password: c.password });
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');

    const seller = await customer(kit);
    await grant(seller.accountId, 'Epsilon');
    await identity.closeAccount(seller.accountId, 'Customer asked');
    expect((await signIn(kit, { email: seller.email, password: seller.password })).body.error.code).toBe('ACCOUNT_DISABLED');
    expect((await signIn(kit, { email: seller.email, password: seller.password, audience: 'seller' })).body.status).toBe('signed_in');
  });

  it('closes on customers.account.closed (backstop) and ignores unknown accounts', async () => {
    const c = await customer(kit);
    kit.app.kernel.events.publish('customers', 'customers.account.closed', { customerId: newId(), userId: c.accountId });
    kit.app.kernel.events.publish('customers', 'customers.account.closed', { customerId: newId(), userId: newId() });
    await kit.app.kernel.events.drain();
    expect((await identity.getAccount(c.accountId))!.status).toBe('closed');
    await kit.syncRevocations();
    expect((await kit.call('GET', `${STORE}/security`, { token: c.tokens.accessToken })).status).toBe(401);
  });

  it('sends a staff-initiated reset link and verifies a new phone number', async () => {
    const c = await customer(kit);
    await identity.sendPasswordReset(c.accountId, { reason: 'Customer called', by: { kind: 'staff', id: newId() }, revokeSessions: true });
    await kit.app.kernel.events.drain();
    expect(kit.last('identity.password_reset.requested')).toMatchObject({ accountId: c.accountId, forcedBy: { kind: 'staff' } });

    const ch = await identity.startPhoneVerification(c.accountId, '+15035550148');
    await kit.app.kernel.events.drain();
    expect(ch).toMatchObject({ purpose: 'phone_verification', emailMasked: '(503) •••-0148' });
    const sms = kit.last('identity.verification.code_issued');
    expect(sms).toMatchObject({ challengeId: ch.id, channel: 'sms', to: '+15035550148', purpose: 'phone_verification' });
    const v = await visitor(kit);
    const ok = await kit.call('POST', `${PUBLIC}/verifications/${ch.id}/confirm`, { token: v.accessToken, body: { code: sms.code } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(kit.last('identity.user.verified')).toMatchObject({ accountId: c.accountId, channel: 'phone', phone: '+15035550148', email: c.email });
    await expect(identity.startPhoneVerification(c.accountId, '5035550148')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('signs in with a provider-verified email (development verifier)', async () => {
    const email = uniqueEmail('google');
    const v = await visitor(kit);
    const res = await kit.call('POST', `${PUBLIC}/external-sign-ins`, { token: v.accessToken, body: { provider: 'google', idToken: `dev:${email}:Gia:Green`, audience: 'store', device: web, marketingOptIn: true } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'signed_in', account: { email, emailVerified: true, displayName: 'Gia Green' } });
    expect(kit.last('identity.user.registered')).toMatchObject({ email, firstName: 'Gia', lastName: 'Green', marketingOptIn: true });
    const again = await kit.call('POST', `${PUBLIC}/external-sign-ins`, { token: (await visitor(kit)).accessToken, body: { provider: 'apple', idToken: `dev:${email}`, audience: 'store', device: android() } });
    expect(again.body.account.id).toBe(res.body.account.id);
    // a fresh visitor session: the first sign-in claimed (and revoked) `v`
    const unverified = await kit.call('POST', `${PUBLIC}/external-sign-ins`, { token: (await visitor(kit)).accessToken, body: { provider: 'google', idToken: `dev-unverified:${email}`, audience: 'store', device: web } });
    expect(unverified.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('jobs', () => {
  it('expires invitations, ends idle sessions, purges unverified accounts and old activity', async () => {
    const k = await boot();
    try {
      const api = k.app.kernel.boot.apis.get('identity') as IdentityPublicApi;
      const inv = await api.inviteStaff({ email: uniqueEmail('late'), name: 'Late Larry', invitedBy: { kind: 'staff', id: newId() } });
      const c = await customer(k);
      const v = await visitor(k);
      await k.call('POST', `${PUBLIC}/registrations`, {
        token: v.accessToken,
        body: { email: uniqueEmail('never'), password: STRONG, firstName: 'Nev', lastName: 'Er', marketingOptIn: false, acceptedTermsVersion: '1', device: web },
      });
      const db = k.app.kernel.database.kysely;
      const count = async (q: string) => Number((await sql.raw<{ n: number }>(q).execute(db)).rows[0]!.n);
      expect(await count(`select count(*)::int as n from identity.accounts where status = 'pending_verification'`)).toBe(1);

      k.clock.advance(8 * 24 * 3600_000);
      await k.app.kernel.jobs.runNow('identity.expire-invitations');
      // (dev staff tokens are signed at the real time, which is 8 days behind this clock: ask the service)
      const list = await (api as unknown as IdentityService).listInvitations('expired', { mode: 'cursor', cursor: null, limit: 50 });
      expect(list.items.map((i) => i.id)).toContain(inv.id);

      await k.app.kernel.jobs.runNow('identity.expire-sessions');
      expect(await count(`select count(*)::int as n from identity.sessions where revoked_at is null`)).toBe(0);
      expect((await k.call('POST', `${PUBLIC}/sessions/refresh`, { body: { refreshToken: c.tokens.refreshToken } })).status).toBe(401);

      await k.app.kernel.jobs.runNow('identity.purge-expired');
      expect(await count(`select count(*)::int as n from identity.accounts where status = 'pending_verification'`)).toBe(0);
      expect(await count(`select count(*)::int as n from identity.challenges`)).toBe(0);

      k.clock.advance(401 * 24 * 3600_000);
      await k.app.kernel.jobs.runNow('identity.prune-security-events');
      expect(await count(`select count(*)::int as n from identity.security_events`)).toBe(0);
      expect(await count(`select count(*)::int as n from identity.sign_in_attempts`)).toBe(0);
      await k.app.kernel.jobs.runNow('identity.expire-sessions');
      expect(await count(`select count(*)::int as n from identity.sessions`)).toBe(0);
    } finally {
      await k.app.close();
    }
  });
});

describe('GraphQL Customer.security', () => {
  it('resolves every customer of a response with one batched call', async () => {
    const a = await customer(kit);
    const b = await customer(kit);
    let calls = 0;
    const svc = new Proxy(identity, {
      get: (t, k) => (k === 'accountSecurityOf' ? (...args: [string[]]) => (calls++, t.accountSecurityOf(...args)) : Reflect.get(t, k, t)),
    });
    const field = resolvers(svc as IdentityService).Customer!.security!;
    const ctx = { area: 'admin', principal: null, requestId: 'r', permissions: new Map() } as unknown as GraphQLContext;
    const [ra, rb, none] = (await Promise.all([field({ userId: a.accountId }, {}, ctx, {} as never), field({ userId: b.accountId }, {}, ctx, {} as never), field({ userId: newId() }, {}, ctx, {} as never)])) as any[];
    expect(calls).toBe(1);
    expect(ra).toMatchObject({ accountId: a.accountId, status: 'ACTIVE', email: a.email, emailVerified: true, signInSummary: 'Password only', twoStep: { enabled: false, required: false } });
    expect(rb.accountId).toBe(b.accountId);
    expect(none).toBeNull();
    const activity = ra.recentActivity({ limit: 1 });
    expect(activity).toHaveLength(1);
    expect(activity[0].result).toBe('COMPLETED');
    expect(ra.warnings.map((w: any) => w.code)).toContain('two_step_off');
  });
});
