/**
 * Staff: invitation link + pass code → password → first session (a real admin token used on admin endpoints),
 * password-only sign-in and password step-ups (owner decision 2026-10-14: staff use no authenticator app), and the
 * staff account tools (lock, unlock, force reset, reset 2-step, sign out, disable).
 * access and audit are other tranches: access.hasPermission and audit.record are stubbed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as audit from '../../../spec/audit.js';
import type { IdentityPublicApi } from '../../../spec/identity.js';
import { newId } from '../../../kernel/lib/ids.js';
import { callers } from '../../../testing/app.js';
import { staffWithoutTwoStep } from '../migrations.js';
import type { IdentityService } from '../service.js';
import { ADMIN, android, boot, customer, enableTotp, identityTable, PUBLIC, signIn, STORE, uniqueEmail, visitor, type TestKit } from './helpers.js';

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
/** Dev staff tokens: the kernel's development re-auth proof for staff account actions */
const devReauth = 'dev-reauth.staff-account';
const PASSWORD = 'Blue-Orchid-2026-Key';
const tokenOf = (acceptUrl: string) => new URL(acceptUrl).hash.replace('#token=', '');
const service = () => kit.app.kernel.boot.apis.get('identity') as IdentityService;
/** The server operator's caller (npm run staff-link) */
const operator = { principal: null, actor: { kind: 'system' as const, id: null, name: 'Server operator' }, client: { ip: null, userAgent: 'test' } };

async function accept(token: string, passCode: string | undefined, password = PASSWORD) {
  const v = await visitor(kit, 'admin');
  return kit.call('POST', `${PUBLIC}/invitations/accept`, { token: v.accessToken, body: { token, passCode, password, device: android() } });
}

/** Invites and accepts with the link and the pass code; returns the staff member's real admin tokens */
async function staffMember(name = 'Sam Staff') {
  const email = uniqueEmail('staff');
  const issued = await identity.inviteStaff({ email, name, invitedBy: inviter });
  await kit.app.kernel.events.drain();
  const res = await accept(tokenOf(issued.acceptUrl), issued.passCode);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { email, password: PASSWORD, accountId: res.body.account.id as string, invitationId: issued.invitation.id, tokens: res.body.tokens };
}

/** A re-auth token made with the staff member's password */
async function reauth(accessToken: string, purpose: string, password = PASSWORD) {
  const res = await kit.call('POST', `${ADMIN}/reauth`, { token: accessToken, body: { purpose, password } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.reauthToken as string;
}

describe('staff invitations', () => {
  it('invites with a link and a pass code, and accepting with both signs in to Admin Center at once', async () => {
    const email = uniqueEmail('newstaff');
    const first = await identity.inviteStaff({ email, name: 'Nina Staff', invitedBy: inviter });
    await kit.app.kernel.events.drain();
    expect(first.invitation).toMatchObject({ realm: 'staff', purpose: 'staff', status: 'pending', email, invitedBy: { kind: 'staff', id: inviter.id } });
    expect(first.passCode).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/); // no 0/O, 1/I/L
    const created = kit.last('identity.invitation.created');
    expect(created).toMatchObject({ invitationId: first.invitation.id, purpose: 'staff', email, name: 'Nina Staff', acceptUrl: first.acceptUrl });
    expect(created.acceptUrl).toMatch(/^http:\/\/localhost:3002\/invitation#token=/); // ADMIN_URL (development default)
    // the emailed event never carries the pass code, in any form; only its hash is stored
    const passCodeForms = [first.passCode, first.passCode.replace('-', '')];
    for (const form of passCodeForms) expect(JSON.stringify(created)).not.toContain(form);
    const stored = (await identityTable(kit.app, 'invitations').get(first.invitation.id))!;
    expect(stored.pass_code_hash).toMatch(/^[0-9a-f]{64}$/);
    for (const form of passCodeForms) expect(JSON.stringify(stored)).not.toContain(form);
    expect((await identity.findAccountByEmail(email, 'staff'))!.status).toBe('invited');

    // a second invitation replaces the first link and its pass code
    const issued = await identity.inviteStaff({ email, name: 'Nina Staff', invitedBy: inviter });
    await kit.app.kernel.events.drain();
    expect(issued.passCode).not.toBe(first.passCode);
    const v = await visitor(kit, 'admin');
    expect((await kit.call('POST', `${PUBLIC}/invitations/lookups`, { token: v.accessToken, body: { token: tokenOf(first.acceptUrl) } })).body.error.code).toBe('INVITATION_INVALID');
    const token = tokenOf(issued.acceptUrl);
    const view = await kit.call('POST', `${PUBLIC}/invitations/lookups`, { token: v.accessToken, body: { token } });
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ purpose: 'staff', name: 'Nina Staff', existingAccount: false, requiresPassCode: true, policy: { minLength: 12 } });
    expect(view.body.requiresTwoStepSetup).toBeUndefined();

    // no pass code: a form problem, not counted
    const missing = await accept(token, undefined);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ code: 'PASS_CODE_INVALID', details: { attemptsLeft: 5 } });
    // the first invitation's pass code does not open the new link
    const old = await accept(token, first.passCode);
    expect(old.body.error).toMatchObject({ code: 'PASS_CODE_INVALID', details: { attemptsLeft: 4 } });
    const weak = await accept(token, issued.passCode, 'Short-1');
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');

    // any case, without the dash, with spaces: the same pass code
    const typed = ` ${issued.passCode.replace('-', '').toLowerCase().slice(0, 4)} ${issued.passCode.replace('-', '').toLowerCase().slice(4)} `;
    const done = await accept(token, typed);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: 'signed_in', account: { email, status: 'active' }, tokens: { audience: 'admin' } });
    expect(done.body.twoStepSetup).toBeUndefined(); // no authenticator set-up, no recovery codes
    expect(kit.last('identity.invitation.accepted')).toMatchObject({ invitationId: issued.invitation.id, purpose: 'staff' });
    // the real admin token works on an admin endpoint (permissions from the stubbed access module)
    const list = await kit.call('GET', `${ADMIN}/accounts?realm=member`, { token: done.body.tokens.accessToken });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    // the link is spent
    expect((await kit.call('POST', `${PUBLIC}/invitations/lookups`, { token: v.accessToken, body: { token } })).status).toBe(410);
  });

  it('counts wrong pass codes; the 5th revokes the link, and a new link from the operator works', async () => {
    const email = uniqueEmail('guess');
    const issued = await identity.inviteStaff({ email, name: 'Gale Guess', invitedBy: inviter });
    await kit.app.kernel.events.drain();
    const token = tokenOf(issued.acceptUrl);
    const wrong = issued.passCode.startsWith('A') ? 'BBBB-BBBB' : 'AAAA-AAAA';
    for (const left of [4, 3, 2, 1]) {
      const res = await accept(token, wrong);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'PASS_CODE_INVALID', details: { attemptsLeft: left } });
    }
    const fifth = await accept(token, wrong);
    expect(fifth.body.error).toMatchObject({ code: 'PASS_CODE_INVALID', details: { attemptsLeft: 0 } });
    // the right pass code no longer helps: the link is revoked
    const late = await accept(token, issued.passCode);
    expect(late.status).toBe(410);
    expect(late.body.error.code).toBe('INVITATION_INVALID');
    expect((await identityTable(kit.app, 'invitations').get(issued.invitation.id))).toMatchObject({ status: 'revoked', revoke_reason: 'Too many wrong pass codes', pass_code_attempts: 5 });
    // the account still waits (its roles too: no identity.invitation.revoked), and the attempts are in its history
    const account = (await identity.findAccountByEmail(email, 'staff'))!;
    expect(account.status).toBe('invited');
    expect(kit.of('identity.invitation.revoked').some((e) => e.invitationId === issued.invitation.id)).toBe(false);
    const failures = (await identityTable(kit.app, 'security_events').find({ account_id: account.id, kind: 'sign_in_failed' })).map((e) => e.detail);
    expect(failures).toHaveLength(5);
    expect(failures.at(-1)).toMatchObject({ reason: 'invitation_pass_code', revoked: true });

    // npm run staff-link: a new link and pass code for the same invitation
    const again = await service().invitations.resendInvitation(issued.invitation.id, operator);
    await kit.app.kernel.events.drain();
    expect(again.invitation.status).toBe('pending');
    expect(again.passCode).not.toBe(issued.passCode);
    const ok = await accept(tokenOf(again.acceptUrl), again.passCode);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('signed_in');
  });

  it('cancelling a link ended by wrong pass codes closes the waiting account', async () => {
    const email = uniqueEmail('cancel');
    const issued = await identity.inviteStaff({ email, name: 'Cal Cancel', invitedBy: inviter });
    await kit.app.kernel.events.drain();
    for (let i = 0; i < 5; i++) await accept(tokenOf(issued.acceptUrl), 'ZZZZ-ZZZZ');
    expect((await identity.findAccountByEmail(email, 'staff'))!.status).toBe('invited');
    const revoked = await identity.revokeInvitation(issued.invitation.id, { reason: 'Mistyped email', by: inviter });
    expect(revoked.status).toBe('revoked');
    expect((await identity.findAccountByEmail(email, 'staff'))!.status).toBe('closed');
    expect(kit.last('identity.invitation.revoked')).toMatchObject({ invitationId: issued.invitation.id, purpose: 'staff' });
    // a cancelled invitation cannot be resent
    await expect(service().invitations.resendInvitation(issued.invitation.id, operator)).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
  });

  it('staff sign in with email and password only, even with an authenticator left from before', async () => {
    const s = await staffMember();
    // a method from before the change (the migration removes these; sign-in ignores them for staff anyway)
    await identityTable(kit.app, 'two_step_methods').insert({ id: newId(), account_id: s.accountId, method: 'totp', secret_encrypted: Buffer.alloc(20), phone_e164_encrypted: null, phone_masked: null, confirmed_at: kit.clock.now(), last_used_at: null, last_used_step: null, removed_at: null });
    const v = await visitor(kit, 'admin');
    const res = await kit.call('POST', `${PUBLIC}/sessions`, { token: v.accessToken, body: { email: s.email, password: s.password, audience: 'admin', keepSignedIn: true, device: android() } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('signed_in');
    // staff sessions last at most 12 hours, whatever keep-me-signed-in says
    expect(Date.parse(res.body.tokens.refreshTokenExpiresAt) - kit.clock.now().getTime()).toBe(12 * 3600_000);
    // no 2-step stamp, and the Admin Center works
    expect((await kit.call('GET', `${ADMIN}/accounts/${s.accountId}`, { token: res.body.tokens.accessToken })).status).toBe(200);
  });

  it('staff cannot add a 2-step method, and are not asked to', async () => {
    const s = await staffMember('Tess Totp');
    const t = s.tokens.accessToken;
    const setup = await kit.call('POST', `${STORE}/two-step/setups`, { token: t, body: { method: 'totp', currentPassword: s.password } });
    expect(setup.status).toBe(403);
    expect(setup.body.error.code).toBe('TWO_STEP_NOT_FOR_STAFF');
    const confirm = await kit.call('POST', `${STORE}/two-step/setups/${newId()}/confirm`, { token: t, body: { code: '123456' } });
    expect(confirm.body.error.code).toBe('TWO_STEP_NOT_FOR_STAFF');
    const security = await kit.call('GET', `${STORE}/security`, { token: t });
    expect(security.body.twoStep).toMatchObject({ enabled: false, required: false, methods: [] });
    expect(security.body.warnings.map((w: { code: string }) => w.code)).not.toContain('two_step_off');
  });

  it('staff re-auth: the password again, a single-use token for one purpose, bound to the staff session (audited)', async () => {
    const s = await staffMember('Rae Reauth');
    const t = s.tokens.accessToken;
    const wrong = await kit.call('POST', `${ADMIN}/reauth`, { token: t, body: { purpose: 'staff-account', password: 'Not-The-Password-1' } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('CURRENT_PASSWORD_WRONG');
    // staff have no 2-step: a code is not a way to confirm
    const byCode = await kit.call('POST', `${ADMIN}/reauth`, { token: t, body: { purpose: 'staff-account', code: '123456' } });
    expect(byCode.status).toBe(400);
    expect(byCode.body.error.code).toBe('VALIDATION_FAILED');
    const res = await kit.call('POST', `${ADMIN}/reauth`, { token: t, body: { purpose: 'staff-account', password: s.password } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Date.parse(res.body.expiresAt) - kit.clock.now().getTime()).toBe(5 * 60_000);
    expect(lastAudit()).toMatchObject({ action: 'identity.reauth.staff', module: 'identity', target: { type: 'account', id: s.accountId }, afterText: 'For: staff-account', actor: { kind: 'staff', id: s.accountId } });
    const principal = { kind: 'staff' as const, accountId: s.accountId, sessionId: s.tokens.sessionId, sellerId: null };
    expect(await identity.verifyReauthToken(principal, res.body.reauthToken, 'staff-account')).toBe(true);
    expect(await identity.verifyReauthToken(principal, res.body.reauthToken, 'role-grant')).toBe(false);

    const pending = await identity.inviteStaff({ email: uniqueEmail('resend'), name: 'Ray Resend', invitedBy: inviter });
    const url = `${ADMIN}/invitations/${pending.invitation.id}/resend`;
    // no token, the retired code header, or a token for another purpose: refused (and a token of another purpose is not spent)
    const none = await kit.call('POST', url, { token: t, headers: { 'x-step-up-code': '000000' }, body: {} });
    expect(none.status).toBe(403);
    expect(none.body.error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { kind: 'reauth', purpose: 'staff-account' } });
    const grant = await reauth(t, 'role-grant');
    expect((await kit.call('POST', url, { token: t, body: { reauthToken: grant } })).status).toBe(403);
    expect(await identity.verifyReauthToken(principal, grant, 'role-grant')).toBe(true);
    // on its own purpose: works once
    const ok = await kit.call('POST', url, { token: t, body: { reauthToken: res.body.reauthToken } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await kit.call('POST', url, { token: t, body: { reauthToken: res.body.reauthToken } })).body.error.code).toBe('STEP_UP_REQUIRED');
  });

  it('lists, resends and revokes staff invitations (audited); the resend returns the new link and pass code', async () => {
    const email = uniqueEmail('pending');
    const { invitation: inv } = await identity.inviteStaff({ email, name: 'Pat Pending', invitedBy: inviter });
    const list = await kit.call('GET', `${ADMIN}/invitations?status=pending`, { token: staffToken() });
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: any) => i.id)).toContain(inv.id);

    const resent = await kit.call('POST', `${ADMIN}/invitations/${inv.id}/resend`, { token: staffToken(), body: { reauthToken: devReauth } });
    expect(resent.status, JSON.stringify(resent.body)).toBe(200);
    expect(resent.body.passCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(resent.body.acceptUrl).toContain('/invitation#token=');
    expect(Date.parse(resent.body.invitation.expiresAt) - kit.clock.now().getTime()).toBe(7 * 24 * 3600_000);
    expect(JSON.stringify(lastAudit())).not.toContain(resent.body.passCode);
    expect(lastAudit()).toMatchObject({ action: 'identity.invitation.resend', module: 'identity', category: 'security' });

    const revoked = await kit.call('POST', `${ADMIN}/invitations/${inv.id}/revoke`, { token: staffToken(), body: { reason: 'Hired elsewhere', reauthToken: devReauth } });
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('revoked');
    expect(kit.last('identity.invitation.revoked')).toMatchObject({ invitationId: inv.id, purpose: 'staff' });
    expect((await identity.findAccountByEmail(email, 'staff'))!.status).toBe('closed');
    const again = await kit.call('POST', `${ADMIN}/invitations/${inv.id}/revoke`, { token: staffToken(), body: { reason: 'again', reauthToken: devReauth } });
    // already revoked: answered unchanged (identity.revokeInvitation is idempotent)
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('revoked');
    expect((await kit.call('POST', `${ADMIN}/invitations/${'01900000-0000-7000-8000-00000000abcd'}/resend`, { token: staffToken(), body: { reauthToken: devReauth } })).status).toBe(404);
  });

  it('the 2026-10-14 migration removes the 2-step of staff accounts only, and can run again', async () => {
    const s = await staffMember('Mia Migrated');
    const c = await customer(kit);
    await enableTotp(kit, c.tokens.accessToken, c.password);
    const methods = identityTable(kit.app, 'two_step_methods');
    const now = kit.clock.now();
    await methods.insert({ id: newId(), account_id: s.accountId, method: 'totp', secret_encrypted: Buffer.alloc(20), phone_e164_encrypted: null, phone_masked: null, confirmed_at: now, last_used_at: null, last_used_step: null, removed_at: null });
    await identityTable(kit.app, 'recovery_codes').insert({ id: newId(), account_id: s.accountId, code_hash: 'x', batch_id: newId(), used_at: null });
    const challenge = newId();
    await identityTable(kit.app, 'challenges').insert({ id: challenge, account_id: s.accountId, purpose: 'sign_in_second_factor', target_email: null, code_hash: null, payload: {} as never, attempts: 0, max_attempts: 5, status: 'pending', expires_at: new Date(now.getTime() + 600_000), resend_available_at: null, created_at: now, completed_at: null, target_phone_encrypted: null });
    await identityTable(kit.app, 'devices').updateMany({ account_id: s.accountId }, { two_step_trusted_until: new Date(now.getTime() + 86_400_000) });

    for (let run = 0; run < 2; run++) await staffWithoutTwoStep.up(kit.app.kernel.mongo.db);

    expect((await methods.find({ account_id: s.accountId })).every((m) => m.removed_at !== null)).toBe(true);
    expect(await identityTable(kit.app, 'recovery_codes').find({ account_id: s.accountId })).toHaveLength(0);
    expect((await identityTable(kit.app, 'challenges').get(challenge))!.status).toBe('expired');
    expect((await identityTable(kit.app, 'devices').find({ account_id: s.accountId })).every((d) => d.two_step_trusted_until === null)).toBe(true);
    // the customer keeps their authenticator and recovery codes
    expect((await methods.find({ account_id: c.accountId })).filter((m) => m.removed_at === null)).toHaveLength(1);
    expect(await identityTable(kit.app, 'recovery_codes').find({ account_id: c.accountId })).toHaveLength(10);
    const security = await kit.call('GET', `${STORE}/security`, { token: c.tokens.accessToken });
    expect(security.body.twoStep).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });
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

  it('staffSessionState gives the same answer without recording activity (live notification streams)', async () => {
    const s = await staffMember('Sam Stream');
    const id = s.tokens.sessionId;
    await lastActive(id, 10 * 60_000);
    const before = await activeAt(id);
    expect(await identity.staffSessionState(id)).toEqual({ live: true });
    expect(await activeAt(id), 'never writes last_active_at').toBe(before);
    // idle after staffIdleMinutes (30) without a request, whatever the stream asks
    await lastActive(id, 31 * 60_000);
    expect(await identity.staffSessionState(id)).toEqual({ live: false, reason: 'idle' });
    expect(await identity.touchStaffSession(id)).toEqual({ live: false, reason: 'idle' });
    await sessions().update(id, { revoked_at: kit.clock.now(), revoke_reason: 'test' });
    expect(await identity.staffSessionState(id)).toEqual({ live: false, reason: 'revoked' });
    expect(await identity.staffSessionState(newId())).toEqual({ live: false, reason: 'unknown' });
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
    const member = await kit.call('POST', `${ADMIN}/accounts/${c.accountId}/disable`, { token: staffToken(), body: { reason: 'x', reauthToken: devReauth } });
    expect(member.status).toBe(400);

    const limited = callers.staff(['identity.accounts.view', 'identity.accounts.manage']);
    const forbidden = await kit.call('POST', `${ADMIN}/accounts/${s.accountId}/lock`, { token: limited, body: { reason: 'x' } });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toMatchObject({ code: 'FORBIDDEN', details: { permission: 'identity.staff-accounts.manage' } });
    expect((await kit.call('GET', `${ADMIN}/accounts?realm=staff`, { token: limited })).status).toBe(403);

    const self = await kit.call('POST', `${ADMIN}/accounts/${s.accountId}/disable`, { token: callers.staff(undefined, { sub: s.accountId }), body: { reason: 'x', reauthToken: devReauth } });
    expect(self.body.error.code).toBe('SELF_ACTION_NOT_ALLOWED');

    // a real staff session confirms with its own password (a re-auth token); the development proof does not work for it
    const admin = await staffMember('Alex Admin');
    const devProof = await kit.call('POST', `${ADMIN}/accounts/${s.accountId}/disable`, { token: admin.tokens.accessToken, body: { reason: 'Left the company', reauthToken: devReauth } });
    expect(devProof.status).toBe(403);
    expect(devProof.body.error.code).toBe('STEP_UP_REQUIRED');
    const disabled = await kit.call('POST', `${ADMIN}/accounts/${s.accountId}/disable`, {
      token: admin.tokens.accessToken,
      body: { reason: 'Left the company', reauthToken: await reauth(admin.tokens.accessToken, 'staff-account') },
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

    const enabled = await kit.call('POST', `${ADMIN}/accounts/${s.accountId}/enable`, { token: staffToken(), body: { reason: 'Rehired', reauthToken: devReauth } });
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
    expect(detail.body.recentActivity.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['signed_in']));
    expect((await kit.call('GET', `${ADMIN}/accounts/01900000-0000-7000-8000-00000000ffff`, { token: staffToken() })).status).toBe(404);
  });
});
