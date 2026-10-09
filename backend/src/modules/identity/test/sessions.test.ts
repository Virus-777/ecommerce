/**
 * Visitor sessions, registration, sign-in, refresh rotation and sign-out, with the tokens identity
 * issues itself (not dev tokens): every token is checked by the kernel middleware on real endpoints.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { android, boot, cookieOf, customer, PUBLIC, signIn, STORE, STRONG, uniqueEmail, visitor, web, type TestKit } from './helpers.js';

let kit: TestKit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(async () => {
  await kit.app.close();
});

describe('app sessions (visitor tokens)', () => {
  it('issues a visitor token the middleware accepts on public endpoints', async () => {
    const v = await visitor(kit, 'store');
    expect(v.refreshToken).toMatch(/^v\./);
    const res = await kit.call('GET', `${PUBLIC}/password-policy?realm=staff`, { token: v.accessToken });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ minLength: 12, requireNumber: true, requireUppercase: true });
  });

  it('refuses the bootstrap without an app proof', async () => {
    const res = await kit.call('POST', `${PUBLIC}/app-sessions`, { body: { audience: 'store', device: web } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('APP_PROOF_INVALID');
  });

  it('gives websites the refresh token in an HttpOnly cookie, not in the body', async () => {
    const res = await kit.call('POST', `${PUBLIC}/app-sessions`, { headers: { 'x-app-proof': 'dev' }, body: { audience: 'store', device: web } });
    expect(res.status).toBe(201);
    expect(res.body.refreshToken).toBe('');
    const c = cookieOf(res.headers)!;
    expect(c.value).toMatch(/^v\./);
    expect(c.line).toMatch(/HttpOnly/);
    expect(c.line).toMatch(/Secure/);
    expect(c.line).toMatch(/SameSite=Strict/);
    expect(c.line).toMatch(/^__Secure-mk_refresh=/);
    expect(c.line).toMatch(/Path=\/api\/public\/identity\/sessions(;|$)/);
    expect(c.line).not.toMatch(/Domain=/);

    // the cookie refreshes the visitor session and rotates
    const r = await kit.call('POST', `${PUBLIC}/sessions/refresh`, { headers: { cookie: `__Secure-mk_refresh=${c.value}` }, body: {} });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sessionId).toBe(res.body.sessionId);
    expect(r.body.refreshToken).toBe('');
    expect(cookieOf(r.headers)!.value).not.toBe(c.value);
  });

  it('rotates visitor refresh tokens (Android, body)', async () => {
    const v = await visitor(kit);
    const r1 = await kit.call('POST', `${PUBLIC}/sessions/refresh`, { body: { refreshToken: v.refreshToken } });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(v.refreshToken);
    const ok = await kit.call('GET', `${PUBLIC}/password-policy`, { token: r1.body.accessToken });
    expect(ok.status).toBe(200);
  });
});

describe('registration and email verification', () => {
  it('creates an account, sends a code, and signs in on confirmation (claiming the visitor session)', async () => {
    const email = uniqueEmail('reg');
    const v = await visitor(kit);
    const reg = await kit.call('POST', `${PUBLIC}/registrations`, {
      token: v.accessToken,
      body: { email, password: STRONG, firstName: 'Ana', lastName: 'Lopez', marketingOptIn: true, acceptedTermsVersion: '2026-01', device: android() },
    });
    expect(reg.status).toBe(202);
    expect(reg.body).toMatchObject({ purpose: 'email_verification', codeLength: 6, attemptsLeft: 5 });
    expect(reg.body.emailMasked).toMatch(/^r•+@example\.com$/);
    const registered = kit.last('identity.user.registered');
    expect(registered).toMatchObject({ email, firstName: 'Ana', lastName: 'Lopez', marketingOptIn: true, acceptedTermsVersion: '2026-01', guestSessionId: v.sessionId });
    const issued = kit.of('identity.verification.code_issued').find((e) => e.challengeId === reg.body.id);
    expect(issued).toMatchObject({ purpose: 'email_verification', channel: 'email', to: email, existingAccount: false });

    // the account can't sign in before confirming: EMAIL_NOT_VERIFIED with a fresh challenge
    const early = await kit.call('POST', `${PUBLIC}/sessions`, { token: v.accessToken, body: { email, password: STRONG, audience: 'store', keepSignedIn: false, device: android() } });
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(early.body.error.details.challenge.id).toBeDefined();
    const fresh = kit.of('identity.verification.code_issued').find((e) => e.challengeId === early.body.error.details.challenge.id);

    // a wrong code counts; the superseded first challenge no longer works
    const wrong = await kit.call('POST', `${PUBLIC}/verifications/${early.body.error.details.challenge.id}/confirm`, { token: v.accessToken, body: { code: fresh.code === '000000' ? '111111' : '000000' } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatchObject({ code: 'CODE_INVALID', details: { attemptsLeft: 4 } });
    const old = await kit.call('POST', `${PUBLIC}/verifications/${reg.body.id}/confirm`, { token: v.accessToken, body: { code: issued.code } });
    expect(old.status).toBe(410);

    const ok = await kit.call('POST', `${PUBLIC}/verifications/${early.body.error.details.challenge.id}/confirm`, { token: v.accessToken, body: { code: fresh.code, device: android() } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ verified: true, account: { email, status: 'active', emailVerified: true, realm: 'member' } });
    expect(kit.last('identity.user.verified')).toMatchObject({ accountId: ok.body.account.id, channel: 'email', email });
    expect(kit.last('identity.guest_session.claimed')).toEqual({ guestSessionId: v.sessionId, accountId: ok.body.account.id });

    // the issued customer token works on account endpoints
    const sec = await kit.call('GET', `${STORE}/security`, { token: ok.body.tokens.accessToken });
    expect(sec.status, JSON.stringify(sec.body)).toBe(200);
    expect(sec.body.account.id).toBe(ok.body.account.id);
    expect(sec.body.warnings.map((w: any) => w.code)).toContain('two_step_off');
    expect(sec.body.devices).toHaveLength(1);
    expect(sec.body.devices[0].current).toBe(true);

    // the claimed visitor session is over: its token is revoked once servers sync
    await kit.syncRevocations();
    const gone = await kit.call('GET', `${PUBLIC}/password-policy`, { token: v.accessToken });
    expect(gone.status).toBe(401);
  });

  it('answers the same for an email that already has an account, and that code never verifies', async () => {
    const c = await customer(kit);
    const v = await visitor(kit);
    const before = kit.of('identity.user.registered').length;
    const reg = await kit.call('POST', `${PUBLIC}/registrations`, {
      token: v.accessToken,
      body: { email: c.email, password: 'Another-Pass-99', firstName: 'Eve', lastName: 'Mallory', marketingOptIn: false, acceptedTermsVersion: '2026-01', device: web },
    });
    expect(reg.status).toBe(202);
    expect(kit.of('identity.user.registered').length).toBe(before);
    const issued = kit.of('identity.verification.code_issued').find((e) => e.challengeId === reg.body.id);
    expect(issued.existingAccount).toBe(true);
    const conf = await kit.call('POST', `${PUBLIC}/verifications/${reg.body.id}/confirm`, { token: v.accessToken, body: { code: issued.code } });
    expect(conf.status).toBe(400);
    expect(conf.body.error.code).toBe('CODE_INVALID');
    // the existing password still works, the new one does not
    expect((await signIn(kit, { email: c.email, password: c.password })).status).toBe(200);
  });

  it('checks the password rules', async () => {
    const v = await visitor(kit);
    const res = await kit.call('POST', `${PUBLIC}/registrations`, {
      token: v.accessToken,
      body: { email: uniqueEmail(), password: 'lopez', firstName: 'Ana', lastName: 'Lopez', marketingOptIn: false, acceptedTermsVersion: '1', device: web },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
    expect(res.body.error.details.failed).toEqual(expect.arrayContaining(['min_length', 'number', 'uppercase', 'personal_info']));
  });

  it('resends a code only after the resend timer', async () => {
    const v = await visitor(kit);
    const reg = await kit.call('POST', `${PUBLIC}/registrations`, {
      token: v.accessToken,
      body: { email: uniqueEmail(), password: STRONG, firstName: 'Ana', lastName: 'Lopez', marketingOptIn: false, acceptedTermsVersion: '1', device: web },
    });
    const soon = await kit.call('POST', `${PUBLIC}/verifications/${reg.body.id}/resend`, { token: v.accessToken });
    expect(soon.status).toBe(429);
    expect(soon.body.error.code).toBe('RESEND_TOO_SOON');
    kit.clock.advance(61_000);
    const again = await kit.call('POST', `${PUBLIC}/verifications/${reg.body.id}/resend`, { token: v.accessToken });
    expect(again.status).toBe(200);
    const codes = kit.of('identity.verification.code_issued').filter((e) => e.challengeId === reg.body.id);
    expect(codes).toHaveLength(2);
  });

  it('locks a challenge after too many wrong codes', async () => {
    const v = await visitor(kit);
    const reg = await kit.call('POST', `${PUBLIC}/registrations`, {
      token: v.accessToken,
      body: { email: uniqueEmail(), password: STRONG, firstName: 'Ana', lastName: 'Lopez', marketingOptIn: false, acceptedTermsVersion: '1', device: web },
    });
    const code = kit.of('identity.verification.code_issued').find((e) => e.challengeId === reg.body.id).code;
    const bad = code === '123456' ? '654321' : '123456';
    let last: any;
    for (let i = 0; i < 5; i++) last = await kit.call('POST', `${PUBLIC}/verifications/${reg.body.id}/confirm`, { token: v.accessToken, body: { code: bad } });
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('CHALLENGE_LOCKED');
    const after = await kit.call('POST', `${PUBLIC}/verifications/${reg.body.id}/confirm`, { token: v.accessToken, body: { code } });
    expect(after.body.error.code).toBe('CHALLENGE_LOCKED');
  });
});

describe('sign-in', () => {
  it('signs in and the token works; a new device triggers the alert event', async () => {
    const c = await customer(kit);
    const res = await signIn(kit, { email: c.email, password: c.password, device: android('second-phone') });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('signed_in');
    expect(res.body.tokens.refreshToken).toMatch(/^s\./);
    expect(kit.last('identity.session.new_device')).toMatchObject({ accountId: c.accountId, realm: 'member', deviceLabel: 'Marketly app on Pixel 8' });
    const devices = await kit.call('GET', `${STORE}/devices`, { token: res.body.tokens.accessToken });
    expect(devices.status).toBe(200);
    expect(devices.body).toHaveLength(2);
    expect(devices.body.filter((d: any) => d.current)).toHaveLength(1);
  });

  it('counts wrong passwords, then locks for lockoutMinutes (unknown emails answer the same)', async () => {
    const c = await customer(kit);
    for (let i = 4; i >= 1; i--) {
      const r = await signIn(kit, { email: c.email, password: 'Wrong-Pass-1' });
      expect(r.status).toBe(401);
      expect(r.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', details: { attemptsLeft: i } });
    }
    const locked = await signIn(kit, { email: c.email, password: 'Wrong-Pass-1' });
    expect(locked.status).toBe(423);
    expect(locked.body.error).toMatchObject({ code: 'ACCOUNT_LOCKED', details: { cause: 'failed_sign_ins' } });
    expect(kit.last('identity.account.locked')).toMatchObject({ accountId: c.accountId, cause: 'failed_sign_ins' });
    // even the right password waits for the lock to end; existing sessions keep working
    expect((await signIn(kit, { email: c.email, password: c.password })).status).toBe(423);
    expect((await kit.call('GET', `${STORE}/security`, { token: c.tokens.accessToken })).status).toBe(200);

    const ghost = uniqueEmail('ghost');
    for (let i = 4; i >= 1; i--) {
      const r = await signIn(kit, { email: ghost, password: 'Wrong-Pass-1' });
      expect(r.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', details: { attemptsLeft: i } });
    }
    expect((await signIn(kit, { email: ghost, password: 'Wrong-Pass-1' })).body.error.code).toBe('ACCOUNT_LOCKED');

    kit.clock.advance(15 * 60_000 + 1000);
    const back = await signIn(kit, { email: c.email, password: c.password });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const activity = await kit.call('GET', `${STORE}/security-activity?result=failed`, { token: back.body.tokens.accessToken });
    expect(activity.status).toBe(200);
    expect(activity.body.items.length).toBeGreaterThanOrEqual(5);
    expect(activity.body.items[0].label).toMatch(/Wrong password/);
  });

  it('refuses a customer token on the seller and admin areas', async () => {
    const c = await customer(kit);
    const res = await kit.call('GET', `${SELLER_SESSION}`, { token: c.tokens.accessToken });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('WRONG_AUDIENCE');
  });

  it('uses the staff realm for the admin audience (a member email is unknown there)', async () => {
    const c = await customer(kit);
    const res = await signIn(kit, { email: c.email, password: c.password, audience: 'admin' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('answers NO_SELLER_ACCESS for a member without sellers', async () => {
    const c = await customer(kit);
    const res = await signIn(kit, { email: c.email, password: c.password, audience: 'seller' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_SELLER_ACCESS');
  });
});

const SELLER_SESSION = '/api/seller/identity/session/sellers';

describe('refresh and sign-out', () => {
  it('rotates, accepts a parallel refresh in the grace window, and revokes the session on reuse', async () => {
    const c = await customer(kit);
    const t0 = c.tokens.refreshToken as string;
    const r1 = await kit.call('POST', `${PUBLIC}/sessions/refresh`, { body: { refreshToken: t0 } });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    const t1 = r1.body.refreshToken as string;
    expect(t1).not.toBe(t0);
    expect((await kit.call('GET', `${STORE}/security`, { token: r1.body.accessToken })).status).toBe(200);

    // two requests refreshing at once: the old token within 20 s returns the same new refresh token
    const parallel = await kit.call('POST', `${PUBLIC}/sessions/refresh`, { body: { refreshToken: t0 } });
    expect(parallel.status).toBe(200);
    expect(parallel.body.refreshToken).toBe(t1);

    // later, the old token again is a theft signal: the session ends
    kit.clock.advance(21_000);
    const reused = await kit.call('POST', `${PUBLIC}/sessions/refresh`, { body: { refreshToken: t0 } });
    expect(reused.status).toBe(401);
    expect((await kit.call('POST', `${PUBLIC}/sessions/refresh`, { body: { refreshToken: t1 } })).status).toBe(401);
    await kit.syncRevocations();
    expect((await kit.call('GET', `${STORE}/security`, { token: r1.body.accessToken })).status).toBe(401);
    // reuse is recorded, the account is not locked
    const again = await signIn(kit, { email: c.email, password: c.password });
    expect(again.status).toBe(200);
    const activity = await kit.call('GET', `${STORE}/security-activity`, { token: again.body.tokens.accessToken });
    expect(activity.body.items.map((e: any) => e.kind)).toContain('refresh_token_reused');
  });

  it('signs out this device (idempotent) and clears the website cookie', async () => {
    const c = await customer(kit);
    const s = await signIn(kit, { email: c.email, password: c.password, device: web });
    expect(s.body.tokens.refreshToken).toBe('');
    const cookie = cookieOf(s.headers)!.value;
    const out = await kit.call('POST', `${PUBLIC}/sessions/sign-out`, { headers: { cookie: `__Secure-mk_refresh=${cookie}` }, body: {} });
    expect(out.status).toBe(204);
    expect(cookieOf(out.headers)!.line).toMatch(/Max-Age=0/);
    // cleared with the same Path it was set with, or the browser keeps it
    expect(cookieOf(out.headers)!.line).toMatch(/Path=\/api\/public\/identity\/sessions(;|$)/);
    await kit.syncRevocations();
    expect((await kit.call('GET', `${STORE}/security`, { token: s.body.tokens.accessToken })).status).toBe(401);
    // the refresh token no longer works, so the middleware refuses a second sign-out
    expect((await kit.call('POST', `${PUBLIC}/sessions/sign-out`, { headers: { cookie: `__Secure-mk_refresh=${cookie}` }, body: {} })).status).toBe(401);
  });

  it('keep me signed in gives a 30-day refresh token, otherwise 24 hours', async () => {
    const c = await customer(kit);
    const short = await signIn(kit, { email: c.email, password: c.password, keepSignedIn: false });
    const long = await signIn(kit, { email: c.email, password: c.password, keepSignedIn: true });
    const now = kit.clock.now().getTime();
    expect(Date.parse(short.body.tokens.refreshTokenExpiresAt) - now).toBe(24 * 3600_000);
    expect(Date.parse(long.body.tokens.refreshTokenExpiresAt) - now).toBe(30 * 24 * 3600_000);
    expect(Date.parse(long.body.tokens.accessTokenExpiresAt) - now).toBeLessThanOrEqual(15 * 60_000);
  });
});

describe('devices and sign-out everywhere', () => {
  it('signs out one device, then everywhere but this device', async () => {
    const c = await customer(kit);
    const b = await signIn(kit, { email: c.email, password: c.password, device: android('device-b') });
    const d = await signIn(kit, { email: c.email, password: c.password, device: android('device-d') });
    const devices = await kit.call('GET', `${STORE}/devices`, { token: c.tokens.accessToken });
    expect(devices.body).toHaveLength(3);
    const deviceB = devices.body.find((x: any) => !x.current && x.lastActiveAt === devices.body.find((y: any) => !y.current).lastActiveAt);
    expect(deviceB).toBeDefined();

    const other = await customer(kit);
    expect((await kit.call('POST', `${STORE}/devices/${deviceB.id}/sign-out`, { token: other.tokens.accessToken })).status).toBe(404);

    expect((await kit.call('POST', `${STORE}/devices/${deviceB.id}/sign-out`, { token: c.tokens.accessToken })).status).toBe(204);
    expect((await kit.call('GET', `${STORE}/devices`, { token: c.tokens.accessToken })).body).toHaveLength(2);

    const all = await kit.call('POST', `${STORE}/devices/sign-out-all`, { token: c.tokens.accessToken, body: { keepThisDevice: true } });
    expect(all.status).toBe(200);
    expect(all.body.sessionsRevoked).toBe(1);
    await kit.syncRevocations();
    expect((await kit.call('GET', `${STORE}/security`, { token: c.tokens.accessToken })).status).toBe(200);
    expect((await kit.call('GET', `${STORE}/security`, { token: d.body.tokens.accessToken })).status).toBe(401);
    expect((await kit.call('GET', `${STORE}/security`, { token: b.body.tokens.accessToken })).status).toBe(401);
  });
});

describe('passwords', () => {
  it('changes the password (current password checked, history kept) and signs out other devices', async () => {
    const c = await customer(kit);
    const other = await signIn(kit, { email: c.email, password: c.password, device: android('other') });
    const wrong = await kit.call('PUT', `${STORE}/password`, { token: c.tokens.accessToken, body: { currentPassword: 'Nope-12345', newPassword: 'Brand-New-Pass-7', signOutOtherDevices: true } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('CURRENT_PASSWORD_WRONG');
    const same = await kit.call('PUT', `${STORE}/password`, { token: c.tokens.accessToken, body: { currentPassword: c.password, newPassword: c.password, signOutOtherDevices: false } });
    expect(same.body.error.code).toBe('PASSWORD_REUSED');
    const ok = await kit.call('PUT', `${STORE}/password`, { token: c.tokens.accessToken, body: { currentPassword: c.password, newPassword: 'Brand-New-Pass-7', signOutOtherDevices: true } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(204);
    expect(kit.last('identity.password.changed')).toMatchObject({ accountId: c.accountId, via: 'change', otherSessionsRevoked: true, realm: 'member' });
    await kit.syncRevocations();
    expect((await kit.call('GET', `${STORE}/security`, { token: other.body.tokens.accessToken })).status).toBe(401);
    expect((await kit.call('GET', `${STORE}/security`, { token: c.tokens.accessToken })).status).toBe(200);
    expect((await signIn(kit, { email: c.email, password: 'Brand-New-Pass-7' })).status).toBe(200);
  });

  it('resets a forgotten password with an emailed link (never revealing whether the account exists)', async () => {
    const c = await customer(kit);
    const v = await visitor(kit);
    const unknown = await kit.call('POST', `${PUBLIC}/password-resets`, { token: v.accessToken, body: { email: uniqueEmail('nobody') } });
    expect(unknown.status).toBe(202);
    const known = await kit.call('POST', `${PUBLIC}/password-resets`, { token: v.accessToken, body: { email: c.email } });
    expect(known.status).toBe(202);
    expect(Object.keys(known.body).sort()).toEqual(Object.keys(unknown.body).sort());
    expect(known.body.expiresInMinutes).toBe(30);
    const sent = kit.last('identity.password_reset.requested');
    expect(sent).toMatchObject({ accountId: c.accountId, email: c.email, forcedBy: null });
    const token = new URL(sent.resetUrl).hash.replace('#token=', '');
    expect(sent.resetUrl).not.toContain('?');

    const look = await kit.call('POST', `${PUBLIC}/password-resets/lookups`, { token: v.accessToken, body: { token } });
    expect(look.body).toMatchObject({ valid: true, forced: false, policy: { minLength: 10 } });
    const weak = await kit.call('POST', `${PUBLIC}/password-resets/complete`, { token: v.accessToken, body: { token, newPassword: 'short', signOutOtherDevices: true } });
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');
    const done = await kit.call('POST', `${PUBLIC}/password-resets/complete`, { token: v.accessToken, body: { token, newPassword: 'Reset-Pass-2026', signOutOtherDevices: true } });
    expect(done.status, JSON.stringify(done.body)).toBe(204);
    expect(kit.last('identity.password.changed')).toMatchObject({ accountId: c.accountId, via: 'reset', otherSessionsRevoked: true });
    const twice = await kit.call('POST', `${PUBLIC}/password-resets/complete`, { token: v.accessToken, body: { token, newPassword: 'Reset-Pass-2027', signOutOtherDevices: true } });
    expect(twice.status).toBe(410);
    expect(twice.body.error.code).toBe('RESET_LINK_INVALID');
    expect((await kit.call('POST', `${PUBLIC}/password-resets/lookups`, { token: v.accessToken, body: { token } })).body.valid).toBe(false);
    await kit.syncRevocations();
    expect((await kit.call('GET', `${STORE}/security`, { token: c.tokens.accessToken })).status).toBe(401);
    expect((await signIn(kit, { email: c.email, password: 'Reset-Pass-2026' })).status).toBe(200);
  });
});

describe('email change and re-auth', () => {
  it('needs a re-auth token, sends a code to the new address and switches on confirmation', async () => {
    const c = await customer(kit);
    const newEmail = uniqueEmail('moved');
    const noProof = await kit.call('POST', `${STORE}/email-changes`, { token: c.tokens.accessToken, body: { newEmail, reauthToken: 'nope' } });
    expect(noProof.status).toBe(403);
    expect(noProof.body.error.code).toBe('STEP_UP_REQUIRED');

    // a token issued for another purpose is refused
    const other = await kit.call('POST', `${STORE}/reauth`, { token: c.tokens.accessToken, body: { purpose: 'account-closure', password: c.password } });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    const wrongPurpose = await kit.call('POST', `${STORE}/email-changes`, { token: c.tokens.accessToken, body: { newEmail, reauthToken: other.body.reauthToken } });
    expect(wrongPurpose.status).toBe(403);
    expect(wrongPurpose.body.error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { kind: 'reauth', purpose: 'email-change' } });

    const reauth = await kit.call('POST', `${STORE}/reauth`, { token: c.tokens.accessToken, body: { purpose: 'email-change', password: c.password } });
    expect(reauth.status, JSON.stringify(reauth.body)).toBe(200);
    const change = await kit.call('POST', `${STORE}/email-changes`, { token: c.tokens.accessToken, body: { newEmail, reauthToken: reauth.body.reauthToken } });
    expect(change.status, JSON.stringify(change.body)).toBe(202);
    // single use
    const again = await kit.call('POST', `${STORE}/email-changes`, { token: c.tokens.accessToken, body: { newEmail, reauthToken: reauth.body.reauthToken } });
    expect(again.body.error.code).toBe('STEP_UP_REQUIRED');

    const sec = await kit.call('GET', `${STORE}/security`, { token: c.tokens.accessToken });
    expect(sec.body.email).toMatchObject({ address: c.email, pendingChangeTo: newEmail });
    const code = kit.of('identity.verification.code_issued').find((e) => e.challengeId === change.body.id);
    expect(code).toMatchObject({ purpose: 'email_change', to: newEmail });
    const ok = await kit.call('POST', `${PUBLIC}/verifications/${change.body.id}/confirm`, { token: c.tokens.accessToken, body: { code: code.code } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.account.email).toBe(newEmail);
    expect(ok.body.tokens ?? null).toBeNull();
    expect(kit.last('identity.email.changed')).toEqual({ accountId: c.accountId, oldEmail: c.email, newEmail });
    expect((await signIn(kit, { email: newEmail, password: c.password })).status).toBe(200);
  });

  it('refuses an email another account uses', async () => {
    const a = await customer(kit);
    const b = await customer(kit);
    const reauth = await kit.call('POST', `${STORE}/reauth`, { token: a.tokens.accessToken, body: { purpose: 'email-change', password: a.password } });
    const res = await kit.call('POST', `${STORE}/email-changes`, { token: a.tokens.accessToken, body: { newEmail: b.email, reauthToken: reauth.body.reauthToken } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_IN_USE');
  });

  it('binds re-auth tokens to the session that asked for them', async () => {
    const c = await customer(kit);
    const other = await signIn(kit, { email: c.email, password: c.password });
    const reauth = await kit.call('POST', `${STORE}/reauth`, { token: c.tokens.accessToken, body: { purpose: 'email-change', password: c.password } });
    const res = await kit.call('POST', `${STORE}/email-changes`, { token: other.body.tokens.accessToken, body: { newEmail: uniqueEmail(), reauthToken: reauth.body.reauthToken } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('STEP_UP_REQUIRED');
  });

  it('counts wrong re-auth answers on the shared counter', async () => {
    const c = await customer(kit);
    const bad = await kit.call('POST', `${STORE}/reauth`, { token: c.tokens.accessToken, body: { purpose: 'email-change', password: 'Wrong-Pass-1' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: 'CURRENT_PASSWORD_WRONG', details: { attemptsLeft: 4 } });
    for (let i = 0; i < 4; i++) await kit.call('POST', `${STORE}/reauth`, { token: c.tokens.accessToken, body: { purpose: 'email-change', password: 'Wrong-Pass-1' } });
    const locked = await kit.call('POST', `${STORE}/reauth`, { token: c.tokens.accessToken, body: { purpose: 'email-change', password: c.password } });
    expect(locked.status).toBe(429);
    expect((await signIn(kit, { email: c.email, password: c.password })).status).toBe(423);
  });
});
