/**
 * Staff: invitation → password → authenticator → first session (a real admin token used on admin
 * endpoints), and the staff account tools (lock, unlock, force reset, reset 2-step, sign out, disable).
 * access and audit are other tranches: access.hasPermission and audit.record are stubbed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as audit from '../../../spec/audit.js';
import type { IdentityPublicApi } from '../../../spec/identity.js';
import { callers } from '../../../testing/app.js';
import { ADMIN, android, boot, customer, enableTotp, identityTable, PUBLIC, signIn, STORE, totp, uniqueEmail, visitor, type TestKit } from './helpers.js';

const recorded: audit.RecordInput[] = [];
/** Staff permissions the stubbed access module grants to real (non-dev) staff tokens */
let granted = new Set(['identity.accounts.view', 'identity.accounts.manage', 'identity.staff-accounts.manage']);

let kit: TestKit;
let identity: IdentityPublicApi;
beforeAll(async () => {
  kit = await boot({
    only: ['identity', 'audit'],
    apiStubs: {
      audit: { record: vi.fn(async (e: audit.RecordInput) => (recorded.push(e), 'entry-id')) },
      access: { hasPermission: async (_p, key) => granted.has(key) },
    },
  });
  identity = kit.app.kernel.boot.apis.get('identity') as IdentityPublicApi;
});
afterAll(async () => {
  await kit.app.close();
});

const inviter = { kind: 'staff' as const, id: '01900000-0000-7000-8000-000000000001', name: 'Platform Admin' };
const lastAudit = () => recorded.at(-1)!;
const staffToken = () => callers.staff();
const code = { 'x-step-up-code': '000000' }; // dev staff tokens: the kernel's development step-up code

/** Invites, accepts and confirms 2-step; returns the staff member's real admin tokens */
async function staffMember(name = 'Sam Staff') {
  const email = uniqueEmail('staff');
  const invitation = await identity.inviteStaff({ email, name, invitedBy: inviter });
  await kit.app.kernel.events.drain();
  const created = kit.of('identity.invitation.created').find((e) => e.invitationId === invitation.id);
  const token = new URL(created.acceptUrl).hash.replace('#token=', '');
  const v = await visitor(kit, 'admin');
  const accept = await kit.call('POST', `${PUBLIC}/invitations/accept`, { token: v.accessToken, body: { token, password: 'Blue-Orchid-2026-Key', device: android() } });
  expect(accept.status, JSON.stringify(accept.body)).toBe(200);
  const key = accept.body.twoStepSetup.manualEntryKey as string;
  const confirm = await kit.call('POST', `${PUBLIC}/invitations/two-step`, {
    token: v.accessToken,
    body: { token, setupId: accept.body.twoStepSetup.setupId, code: totp(key, kit.clock.now()), device: android() },
  });
  expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
  kit.clock.advance(30_000);
  return { email, password: 'Blue-Orchid-2026-Key', key, accountId: accept.body.account.id as string, invitationId: invitation.id, tokens: confirm.body.tokens, recoveryCodes: confirm.body.recoveryCodes.codes as string[] };
}

describe('staff invitations', () => {
  it('invites, shows, accepts with a password and an authenticator, and signs in to Admin Center', async () => {
    const email = uniqueEmail('newstaff');
    const invitation = await identity.inviteStaff({ email, name: 'Nina Staff', invitedBy: inviter });
    await kit.app.kernel.events.drain();
    expect(invitation).toMatchObject({ realm: 'staff', purpose: 'staff', status: 'pending', email, invitedBy: { kind: 'staff', id: inviter.id } });
    const created = kit.last('identity.invitation.created');
    expect(created).toMatchObject({ invitationId: invitation.id, purpose: 'staff', email, name: 'Nina Staff' });
    expect(created.acceptUrl).toMatch(/^http:\/\/localhost:3002\/invitation#token=/); // ADMIN_URL (development default)
    const token = new URL(created.acceptUrl).hash.replace('#token=', '');
    expect((await identity.findAccountByEmail(email, 'staff'))!.status).toBe('invited');
    await expect(identity.inviteStaff({ email, name: 'Nina Staff', invitedBy: inviter })).resolves.toMatchObject({ status: 'pending' });
    await kit.app.kernel.events.drain();
    // the second invitation replaced the first link
    const replaced = kit.last('identity.invitation.created');
    const v = await visitor(kit, 'admin');
    expect((await kit.call('POST', `${PUBLIC}/invitations/lookups`, { token: v.accessToken, body: { token } })).body.error.code).toBe('INVITATION_INVALID');
    const token2 = new URL(replaced.acceptUrl).hash.replace('#token=', '');
    const view = await kit.call('POST', `${PUBLIC}/invitations/lookups`, { token: v.accessToken, body: { token: token2 } });
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ purpose: 'staff', name: 'Nina Staff', existingAccount: false, requiresTwoStepSetup: true, policy: { minLength: 12 } });

    const weak = await kit.call('POST', `${PUBLIC}/invitations/accept`, { token: v.accessToken, body: { token: token2, password: 'Short-1', device: android() } });
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');
    const accept = await kit.call('POST', `${PUBLIC}/invitations/accept`, { token: v.accessToken, body: { token: token2, password: 'Blue-Orchid-2026-Key', device: android() } });
    expect(accept.body.status).toBe('two_step_setup_required');
    expect(accept.body.tokens ?? null).toBeNull();
    const key = accept.body.twoStepSetup.manualEntryKey;
    const bad = await kit.call('POST', `${PUBLIC}/invitations/two-step`, { token: v.accessToken, body: { token: token2, setupId: accept.body.twoStepSetup.setupId, code: 'x1x1x1', device: android() } });
    expect(bad.body.error.code).toBe('CODE_INVALID');
    const done = await kit.call('POST', `${PUBLIC}/invitations/two-step`, { token: v.accessToken, body: { token: token2, setupId: accept.body.twoStepSetup.setupId, code: totp(key, kit.clock.now()), device: android() } });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.recoveryCodes.codes).toHaveLength(10);
    expect(done.body.tokens.audience).toBe('admin');
    expect(kit.last('identity.invitation.accepted')).toMatchObject({ invitationId: invitation.id === replaced.invitationId ? invitation.id : replaced.invitationId, purpose: 'staff' });
    // the real admin token works on an admin endpoint (permissions from the stubbed access module)
    const list = await kit.call('GET', `${ADMIN}/accounts?realm=member`, { token: done.body.tokens.accessToken });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    // the link is spent
    expect((await kit.call('POST', `${PUBLIC}/invitations/lookups`, { token: v.accessToken, body: { token: token2 } })).status).toBe(410);
    kit.clock.advance(30_000);
  });

  it('staff always sign in with 2-step', async () => {
    const s = await staffMember();
    const v = await visitor(kit, 'admin');
    const res = await kit.call('POST', `${PUBLIC}/sessions`, { token: v.accessToken, body: { email: s.email, password: s.password, audience: 'admin', keepSignedIn: true, device: android() } });
    expect(res.body.status).toBe('second_factor_required');
    const ok = await kit.call('POST', `${PUBLIC}/sign-in-challenges/${res.body.challenge.id}/verify`, { token: v.accessToken, body: { method: 'totp', code: totp(s.key, kit.clock.now()), rememberDevice: true } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // staff sessions last at most 12 hours, whatever keep-me-signed-in says
    expect(Date.parse(ok.body.tokens.refreshTokenExpiresAt) - kit.clock.now().getTime()).toBe(12 * 3600_000);
    expect((await kit.call('GET', `${ADMIN}/accounts/${s.accountId}`, { token: ok.body.tokens.accessToken })).status).toBe(200);
    kit.clock.advance(30_000);
  });

  it('after a staff 2-step reset, staff re-enrol an authenticator before Admin Center works again', async () => {
    const s = await staffMember('Riley Reset');
    const reset = await kit.call('POST', `${ADMIN}/accounts/${s.accountId}/reset-two-step`, { token: staffToken(), body: { reason: 'Lost phone', identityCheck: 'Video call' } });
    expect(reset.status).toBe(200);
    const v = await visitor(kit, 'admin');
    const signedIn = await kit.call('POST', `${PUBLIC}/sessions`, { token: v.accessToken, body: { email: s.email, password: s.password, audience: 'admin', keepSignedIn: false, device: android() } });
    expect(signedIn.body.status).toBe('signed_in');
    const t = signedIn.body.tokens;
    const refused = await kit.call('GET', `${ADMIN}/accounts?realm=member`, { token: t.accessToken });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { kind: 'two-step-sign-in' } });
    // the store-area security endpoints take any signed-in session
    const setup = await kit.call('POST', `${STORE}/two-step/setups`, { token: t.accessToken, body: { method: 'totp', currentPassword: s.password } });
    expect(setup.status, JSON.stringify(setup.body)).toBe(201);
    const confirm = await kit.call('POST', `${STORE}/two-step/setups/${setup.body.setupId}/confirm`, { token: t.accessToken, body: { code: totp(setup.body.manualEntryKey, kit.clock.now()) } });
    expect(confirm.status).toBe(200);
    const refreshed = await kit.call('POST', `${PUBLIC}/sessions/refresh`, { body: { refreshToken: t.refreshToken } });
    expect(refreshed.status).toBe(200);
    expect((await kit.call('GET', `${ADMIN}/accounts?realm=member`, { token: refreshed.body.accessToken })).status).toBe(200);
    // staff can't remove their last method
    const methods = (await kit.call('GET', `${STORE}/security`, { token: refreshed.body.accessToken })).body.twoStep.methods;
    const storeReauth = await kit.call('POST', `${STORE}/reauth`, { token: refreshed.body.accessToken, body: { purpose: 'two-step-removal', password: s.password } });
    expect(storeReauth.status).toBe(403); // store /reauth is for customers; staff use POST /api/admin/identity/reauth
    expect(storeReauth.body.error.code).toBe('WRONG_AUDIENCE');
    // the development re-auth proof only works for dev tokens
    const dev = await kit.call('POST', `${STORE}/two-step/methods/${methods[0].id}/remove`, { token: refreshed.body.accessToken, body: { reauthToken: 'dev-reauth.two-step-removal', code: '123456' } });
    expect(dev.status).toBe(403);
    expect(dev.body.error.code).toBe('STEP_UP_REQUIRED');
    // a real staff re-auth token passes the step-up; the business rule then keeps the last method
    const reauth = await kit.call('POST', `${ADMIN}/reauth`, { token: refreshed.body.accessToken, body: { purpose: 'two-step-removal', password: s.password } });
    expect(reauth.status, JSON.stringify(reauth.body)).toBe(200);
    const last = await kit.call('POST', `${STORE}/two-step/methods/${methods[0].id}/remove`, { token: refreshed.body.accessToken, body: { reauthToken: reauth.body.reauthToken, code: totp(setup.body.manualEntryKey, kit.clock.now()) } });
    expect(last.body.error.code).toBe('TWO_STEP_REQUIRED');
    kit.clock.advance(30_000);
  });

  it('staff re-auth: a single-use token for one purpose, bound to the staff session (audited)', async () => {
    const s = await staffMember('Rae Reauth');
    const t = s.tokens.accessToken;
    const wrong = await kit.call('POST', `${ADMIN}/reauth`, { token: t, body: { purpose: 'recovery-codes', password: 'Not-The-Password-1' } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('CURRENT_PASSWORD_WRONG');
    const res = await kit.call('POST', `${ADMIN}/reauth`, { token: t, body: { purpose: 'recovery-codes', code: totp(s.key, kit.clock.now()) } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Date.parse(res.body.expiresAt) - kit.clock.now().getTime()).toBe(5 * 60_000);
    expect(lastAudit()).toMatchObject({ action: 'identity.reauth.staff', module: 'identity', target: { type: 'account', id: s.accountId }, afterText: 'For: recovery-codes', actor: { kind: 'staff', id: s.accountId } });
    const principal = { kind: 'staff' as const, accountId: s.accountId, sessionId: s.tokens.sessionId, sellerId: null };
    expect(await identity.verifyReauthToken(principal, res.body.reauthToken, 'recovery-codes')).toBe(true);
    expect(await identity.verifyReauthToken(principal, res.body.reauthToken, 'two-step-removal')).toBe(false);

    // used on a step-up endpoint of another purpose: refused and not spent
    const methods = (await kit.call('GET', `${STORE}/security`, { token: t })).body.twoStep.methods;
    const other = await kit.call('POST', `${STORE}/two-step/methods/${methods[0].id}/remove`, { token: t, body: { reauthToken: res.body.reauthToken, code: s.recoveryCodes[0] } });
    expect(other.status).toBe(403);
    expect(other.body.error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { purpose: 'two-step-removal' } });
    // on its own purpose: works once
    const regen = await kit.call('POST', `${STORE}/two-step/recovery-codes`, { token: t, body: { reauthToken: res.body.reauthToken } });
    expect(regen.status, JSON.stringify(regen.body)).toBe(200);
    expect(regen.body.codes).toHaveLength(10);
    const again = await kit.call('POST', `${STORE}/two-step/recovery-codes`, { token: t, body: { reauthToken: res.body.reauthToken } });
    expect(again.body.error.code).toBe('STEP_UP_REQUIRED');
    kit.clock.advance(30_000);
  });

  it('lists, resends and revokes staff invitations (audited)', async () => {
    const email = uniqueEmail('pending');
    const inv = await identity.inviteStaff({ email, name: 'Pat Pending', invitedBy: inviter });
    const list = await kit.call('GET', `${ADMIN}/invitations?status=pending`, { token: staffToken() });
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: any) => i.id)).toContain(inv.id);

    const resent = await kit.call('POST', `${ADMIN}/invitations/${inv.id}/resend`, { token: staffToken(), headers: code });
    expect(resent.status, JSON.stringify(resent.body)).toBe(200);
    expect(Date.parse(resent.body.expiresAt) - kit.clock.now().getTime()).toBe(7 * 24 * 3600_000);
    expect(lastAudit()).toMatchObject({ action: 'identity.invitation.resend', module: 'identity', category: 'security' });

    const revoked = await kit.call('POST', `${ADMIN}/invitations/${inv.id}/revoke`, { token: staffToken(), headers: code, body: { reason: 'Hired elsewhere' } });
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('revoked');
    expect(kit.last('identity.invitation.revoked')).toMatchObject({ invitationId: inv.id, purpose: 'staff' });
    expect((await identity.findAccountByEmail(email, 'staff'))!.status).toBe('closed');
    const again = await kit.call('POST', `${ADMIN}/invitations/${inv.id}/revoke`, { token: staffToken(), headers: code, body: { reason: 'again' } });
    // already revoked: answered unchanged (identity.revokeInvitation is idempotent)
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('revoked');
    expect((await kit.call('POST', `${ADMIN}/invitations/${'01900000-0000-7000-8000-00000000abcd'}/resend`, { token: staffToken(), headers: code })).status).toBe(404);
  });
});

describe('staff session idle timeout (checked on every admin request)', () => {
  const sessions = () => identityTable(kit.app, 'sessions');
  const activeAt = async (sessionId: string) => (await sessions().get(sessionId))!.last_active_at.getTime();
  const lastActive = (sessionId: string, msAgo: number) => sessions().update(sessionId, { last_active_at: new Date(kit.clock.now().getTime() - msAgo) });
  /** past the kernel's 5 s liveness cache */
  const later = () => kit.clock.advance(6_000);

  it('keeps an active staff session, records the activity at most once a minute, and ends an idle one with 401', async () => {
    const s = await staffMember('Ida Idle');
    const t = s.tokens;
    const url = `${ADMIN}/accounts/${s.accountId}`;
    expect((await kit.call('GET', url, { token: t.accessToken })).status).toBe(200);

    // 29 minutes without a request: still live, and this request is new activity
    await lastActive(t.sessionId, 29 * 60_000);
    later();
    expect((await kit.call('GET', url, { token: t.accessToken })).status).toBe(200);
    expect(await activeAt(t.sessionId)).toBe(kit.clock.now().getTime());
    // the next request within the minute writes nothing
    later();
    expect((await kit.call('GET', url, { token: t.accessToken })).status).toBe(200);
    expect(await activeAt(t.sessionId)).toBe(kit.clock.now().getTime() - 6_000);

    // 31 minutes without a request: idle, though the access token is still valid
    await lastActive(t.sessionId, 31 * 60_000);
    later();
    const idle = await kit.call('GET', url, { token: t.accessToken });
    expect(idle.status).toBe(401);
    expect(idle.body.error).toMatchObject({ code: 'UNAUTHORIZED', details: { reason: 'session_idle' } });
    expect(idle.headers['www-authenticate']).toBe('Bearer'); // a refresh can't help: sign in again
    expect((await kit.call('POST', `${PUBLIC}/sessions/refresh`, { body: { refreshToken: t.refreshToken } })).status).toBe(401);
  });

  it('refuses a session ended between revocation polls', async () => {
    const s = await staffMember('Rex Revoked');
    const url = `${ADMIN}/accounts/${s.accountId}`;
    expect((await kit.call('GET', url, { token: s.tokens.accessToken })).status).toBe(200);
    await sessions().update(s.tokens.sessionId, { revoked_at: kit.clock.now(), revoke_reason: 'test' });
    later();
    const res = await kit.call('GET', url, { token: s.tokens.accessToken });
    expect(res.status).toBe(401);
    expect(res.body.error.details.reason).toBe('token_revoked');
  });
});

describe('account tools', () => {
  it('locks (revoking sessions) and unlocks a member account', async () => {
    const c = await customer(kit);
    const res = await kit.call('POST', `${ADMIN}/accounts/${c.accountId}/lock`, { token: staffToken(), body: { reason: 'Suspected compromise' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ account: { status: 'locked' }, lockedUntil: null, lockReason: 'Suspected compromise' });
    expect(kit.last('identity.account.locked')).toMatchObject({ accountId: c.accountId, cause: 'staff_action', until: null, reason: 'Suspected compromise' });
    expect(lastAudit()).toMatchObject({ action: 'identity.account.lock', reason: 'Suspected compromise', target: { id: c.accountId } });
    await kit.syncRevocations();
    expect((await kit.call('GET', `${STORE}/security`, { token: c.tokens.accessToken })).status).toBe(401);
    const blocked = await signIn(kit, { email: c.email, password: c.password });
    expect(blocked.body.error).toMatchObject({ code: 'ACCOUNT_LOCKED', details: { cause: 'staff_action', lockedUntil: null } });
    expect((await kit.call('POST', `${ADMIN}/accounts/${c.accountId}/lock`, { token: staffToken(), body: { reason: 'again' } })).body.error.code).toBe('ILLEGAL_TRANSITION');

    const un = await kit.call('POST', `${ADMIN}/accounts/${c.accountId}/unlock`, { token: staffToken(), body: { reason: 'Verified by phone' } });
    expect(un.body.account.status).toBe('active');
    expect(kit.last('identity.account.unlocked')).toMatchObject({ accountId: c.accountId });
    expect((await signIn(kit, { email: c.email, password: c.password })).status).toBe(200);
    expect((await kit.call('POST', `${ADMIN}/accounts/${c.accountId}/unlock`, { token: staffToken(), body: { reason: 'x' } })).status).toBe(409);

    const activity = await kit.call('GET', `${ADMIN}/accounts/${c.accountId}/security-activity?kind=account_locked`, { token: staffToken() });
    expect(activity.body.items).toHaveLength(1);
    expect(activity.body.items[0]).toMatchObject({ kind: 'account_locked', reason: 'Suspected compromise', actor: { kind: 'staff' } });
  });

  it('forces a password reset: sessions end, sign-in asks for a new password', async () => {
    const c = await customer(kit);
    const res = await kit.call('POST', `${ADMIN}/accounts/${c.accountId}/force-password-reset`, { token: staffToken(), body: { reason: 'Leaked password', sendLink: true } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.mustResetPassword).toBe(true);
    expect(kit.last('identity.password_reset.requested')).toMatchObject({ accountId: c.accountId, forcedBy: { kind: 'staff' } });
    await kit.syncRevocations();
    expect((await kit.call('GET', `${STORE}/security`, { token: c.tokens.accessToken })).status).toBe(401);
    const s = await signIn(kit, { email: c.email, password: c.password });
    expect(s.body).toMatchObject({ status: 'password_reset_required' });
    const v = await visitor(kit);
    const look = await kit.call('POST', `${PUBLIC}/password-resets/lookups`, { token: v.accessToken, body: { token: s.body.passwordResetToken } });
    expect(look.body).toMatchObject({ valid: true, forced: true });
    const done = await kit.call('POST', `${PUBLIC}/password-resets/complete`, { token: v.accessToken, body: { token: s.body.passwordResetToken, newPassword: 'Fresh-Start-2026', signOutOtherDevices: false } });
    expect(done.status).toBe(204);
    expect(kit.last('identity.password.changed')).toMatchObject({ accountId: c.accountId, via: 'forced_reset', otherSessionsRevoked: true });
    expect((await signIn(kit, { email: c.email, password: 'Fresh-Start-2026' })).body.status).toBe('signed_in');
  });

  it('resets 2-step after an identity check and signs an account out everywhere', async () => {
    const c = await customer(kit);
    await enableTotp(kit, c.tokens.accessToken, c.password);
    const res = await kit.call('POST', `${ADMIN}/accounts/${c.accountId}/reset-two-step`, { token: staffToken(), body: { reason: 'Lost phone', identityCheck: 'Video call with ID' } });
    expect(res.status).toBe(200);
    expect(res.body.twoStep).toMatchObject({ enabled: false, methods: [] });
    expect(kit.last('identity.two_step.changed')).toMatchObject({ accountId: c.accountId, enabled: false, by: { kind: 'staff' } });
    expect(lastAudit().afterText).toMatch(/Video call with ID/);
    expect((await signIn(kit, { email: c.email, password: c.password })).body.status).toBe('signed_in');

    const out = await kit.call('POST', `${ADMIN}/accounts/${c.accountId}/sign-out-all`, { token: staffToken(), body: { reason: 'Customer request' } });
    expect(out.status).toBe(200);
    expect(out.body.sessionsRevoked).toBe(2);
  });

  it("disables and enables staff accounts only, never one's own, and needs the staff permission for staff targets", async () => {
    const s = await staffMember('Dana Departing');
    const c = await customer(kit);
    const member = await kit.call('POST', `${ADMIN}/accounts/${c.accountId}/disable`, { token: staffToken(), headers: code, body: { reason: 'x' } });
    expect(member.status).toBe(400);

    const limited = callers.staff(['identity.accounts.view', 'identity.accounts.manage']);
    const forbidden = await kit.call('POST', `${ADMIN}/accounts/${s.accountId}/lock`, { token: limited, body: { reason: 'x' } });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toMatchObject({ code: 'FORBIDDEN', details: { permission: 'identity.staff-accounts.manage' } });
    expect((await kit.call('GET', `${ADMIN}/accounts?realm=staff`, { token: limited })).status).toBe(403);

    const self = await kit.call('POST', `${ADMIN}/accounts/${s.accountId}/disable`, { token: callers.staff(undefined, { sub: s.accountId }), headers: code, body: { reason: 'x' } });
    expect(self.body.error.code).toBe('SELF_ACTION_NOT_ALLOWED');

    // a real staff session, with its own authenticator code as the step-up proof
    const admin = await staffMember('Alex Admin');
    const noCode = await kit.call('POST', `${ADMIN}/accounts/${s.accountId}/disable`, { token: admin.tokens.accessToken, headers: { 'x-step-up-code': '999999' }, body: { reason: 'Left the company' } });
    expect(noCode.status).toBe(403);
    expect(noCode.body.error.code).toBe('STEP_UP_REQUIRED');
    const disabled = await kit.call('POST', `${ADMIN}/accounts/${s.accountId}/disable`, {
      token: admin.tokens.accessToken,
      headers: { 'x-step-up-code': totp(admin.key, kit.clock.now()) },
      body: { reason: 'Left the company' },
    });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    expect(disabled.body.account.status).toBe('disabled');
    expect(kit.last('identity.account.disabled')).toMatchObject({ accountId: s.accountId, realm: 'staff', reason: 'Left the company', by: { kind: 'staff', id: admin.accountId } });
    await kit.syncRevocations();
    expect((await kit.call('GET', `${ADMIN}/accounts?realm=member`, { token: s.tokens.accessToken })).status).toBe(401);
    const v = await visitor(kit, 'admin');
    const blocked = await kit.call('POST', `${PUBLIC}/sessions`, { token: v.accessToken, body: { email: s.email, password: s.password, audience: 'admin', keepSignedIn: false, device: android() } });
    expect(blocked.body.error.code).toBe('ACCOUNT_DISABLED');
    kit.clock.advance(30_000);

    const enabled = await kit.call('POST', `${ADMIN}/accounts/${s.accountId}/enable`, { token: staffToken(), headers: code, body: { reason: 'Rehired' } });
    expect(enabled.body.account.status).toBe('active');
    expect(kit.last('identity.account.enabled')).toMatchObject({ accountId: s.accountId });
    expect(lastAudit()).toMatchObject({ action: 'identity.account.enable', reason: 'Rehired' });
  });

  it('finds accounts and shows the security detail', async () => {
    const c = await customer(kit, { email: uniqueEmail('findme') });
    const res = await kit.call('GET', `${ADMIN}/accounts?realm=member&q=findme&page=1&limit=50`, { token: staffToken() });
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.account.id)).toContain(c.accountId);
    expect(res.body.items[0]).toMatchObject({ mustResetPassword: false, sellerCount: 0 });
    const twoStep = await kit.call('GET', `${ADMIN}/accounts?realm=member&q=findme&twoStepEnabled=true`, { token: staffToken() });
    expect(twoStep.body.items.map((i: any) => i.account.id)).not.toContain(c.accountId);
    const detail = await kit.call('GET', `${ADMIN}/accounts/${c.accountId}`, { token: staffToken() });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ account: { id: c.accountId, email: c.email }, failedSignInsInWindow: 0, sellerContexts: [], invitation: null });
    expect(detail.body.devices).toHaveLength(1);
    expect(detail.body.recentActivity.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['signed_in', 'email_verified']));
    expect((await kit.call('GET', `${ADMIN}/accounts/01900000-0000-7000-8000-00000000ffff`, { token: staffToken() })).status).toBe(404);
  });
});
