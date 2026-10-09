/** 2-step verification: set-up, sign-in challenges, recovery codes, trusted devices, removal and step-up. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IdentityPublicApi } from '../../../spec/identity.js';
import { android, boot, customer, enableTotp, PUBLIC, signIn, STORE, totp, visitor, type TestKit } from './helpers.js';

let kit: TestKit;
let identity: IdentityPublicApi;
beforeAll(async () => {
  kit = await boot();
  identity = kit.app.kernel.boot.apis.get('identity') as IdentityPublicApi;
});
afterAll(async () => {
  await kit.app.close();
});

describe('authenticator set-up', () => {
  it('needs the current password, confirms the first code and returns 10 recovery codes once', async () => {
    const c = await customer(kit);
    const wrong = await kit.call('POST', `${STORE}/two-step/setups`, { token: c.tokens.accessToken, body: { method: 'totp', currentPassword: 'Nope-1234567' } });
    expect(wrong.body.error.code).toBe('CURRENT_PASSWORD_WRONG');
    const setup = await kit.call('POST', `${STORE}/two-step/setups`, { token: c.tokens.accessToken, body: { method: 'totp', currentPassword: c.password } });
    expect(setup.status).toBe(201);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/Marketly%3A.*secret=[A-Z2-7]+&issuer=Marketly/);
    expect(setup.body.manualEntryKey).toMatch(/^([A-Z2-7]{4} )+[A-Z2-7]{1,4}$/);
    const bad = await kit.call('POST', `${STORE}/two-step/setups/${setup.body.setupId}/confirm`, { token: c.tokens.accessToken, body: { code: '000000' === totp(setup.body.manualEntryKey, kit.clock.now()) ? '111111' : '000000' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('CODE_INVALID');
    const ok = await kit.call('POST', `${STORE}/two-step/setups/${setup.body.setupId}/confirm`, { token: c.tokens.accessToken, body: { code: totp(setup.body.manualEntryKey, kit.clock.now()) } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.codes).toHaveLength(10);
    expect(new Set(ok.body.codes).size).toBe(10);
    expect(kit.last('identity.two_step.changed')).toMatchObject({ accountId: c.accountId, enabled: true, method: 'totp', by: { kind: 'customer', id: c.accountId } });
    const sec = await kit.call('GET', `${STORE}/security`, { token: c.tokens.accessToken });
    expect(sec.body.twoStep).toMatchObject({ enabled: true, required: false, recoveryCodesRemaining: 10, methods: [{ method: 'totp', label: 'Authenticator app' }] });
    expect(sec.body.warnings.map((w: any) => w.code)).not.toContain('two_step_off');
    // another account can't confirm this set-up
    const other = await customer(kit);
    expect((await kit.call('POST', `${STORE}/two-step/setups/${setup.body.setupId}/confirm`, { token: other.tokens.accessToken, body: { code: '123456' } })).status).toBe(404);
    kit.clock.advance(30_000);
  });

  it('answers METHOD_NOT_AVAILABLE for text messages before phase 2', async () => {
    const k1 = await boot({ config: { launchPhase: 1 } });
    try {
      const c = await customer(k1);
      const res = await k1.call('POST', `${STORE}/two-step/setups`, { token: c.tokens.accessToken, body: { method: 'sms', phone: '+15035550148', currentPassword: c.password } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('METHOD_NOT_AVAILABLE');
    } finally {
      await k1.app.close();
    }
  });
});

describe('sign-in with 2-step', () => {
  it('asks for a code, accepts the authenticator code, refuses a replayed one', async () => {
    const c = await customer(kit);
    const { key } = await enableTotp(kit, c.tokens.accessToken, c.password);
    const v = await visitor(kit);
    const first = await kit.call('POST', `${PUBLIC}/sessions`, { token: v.accessToken, body: { email: c.email, password: c.password, audience: 'store', keepSignedIn: false, device: android('phone-2fa') } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'second_factor_required', challenge: { methods: ['totp', 'recovery_code'] } });
    expect(first.body.tokens ?? null).toBeNull();

    // the challenge belongs to the visitor session that started the sign-in
    const stranger = await visitor(kit);
    const stolen = await kit.call('POST', `${PUBLIC}/sign-in-challenges/${first.body.challenge.id}/verify`, { token: stranger.accessToken, body: { method: 'totp', code: totp(key, kit.clock.now()), rememberDevice: false } });
    expect(stolen.status).toBe(404);

    const code = totp(key, kit.clock.now());
    const ok = await kit.call('POST', `${PUBLIC}/sign-in-challenges/${first.body.challenge.id}/verify`, { token: v.accessToken, body: { method: 'totp', code, rememberDevice: false } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('signed_in');
    const payload = JSON.parse(Buffer.from(ok.body.tokens.accessToken.split('.')[1], 'base64url').toString());
    expect(payload).toMatchObject({ aud: 'store', kind: 'customer', sub: c.accountId, iss: 'marketly-identity' });
    expect(typeof payload.twoStepAt).toBe('number');
    expect(payload.dev).toBeUndefined();
    expect((await kit.call('GET', `${STORE}/security`, { token: ok.body.tokens.accessToken })).status).toBe(200);

    // the same code can't be used twice
    const again = await signIn(kit, { email: c.email, password: c.password });
    const replay = await kit.call('POST', `${PUBLIC}/sign-in-challenges/${again.body.challenge.id}/verify`, { token: (await visitor(kit)).accessToken, body: { method: 'totp', code, rememberDevice: false } });
    expect([400, 404]).toContain(replay.status);
    kit.clock.advance(30_000);
  });

  it('accepts each recovery code once', async () => {
    const c = await customer(kit);
    const { recoveryCodes } = await enableTotp(kit, c.tokens.accessToken, c.password);
    // each sign-in starts from a fresh visitor session: a successful sign-in claims (and revokes) the one it used
    const start = (token: string) => kit.call('POST', `${PUBLIC}/sessions`, { token, body: { email: c.email, password: c.password, audience: 'store', keepSignedIn: false, device: android() } });
    const v1 = await visitor(kit);
    const s1 = await start(v1.accessToken);
    const ok = await kit.call('POST', `${PUBLIC}/sign-in-challenges/${s1.body.challenge.id}/verify`, { token: v1.accessToken, body: { method: 'recovery_code', code: recoveryCodes[0]!.toUpperCase(), rememberDevice: false } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const v2 = await visitor(kit);
    const s2 = await start(v2.accessToken);
    const used = await kit.call('POST', `${PUBLIC}/sign-in-challenges/${s2.body.challenge.id}/verify`, { token: v2.accessToken, body: { method: 'recovery_code', code: recoveryCodes[0]!, rememberDevice: false } });
    expect(used.status).toBe(400);
    expect(used.body.error).toMatchObject({ code: 'CODE_INVALID', details: { attemptsLeft: 4 } });
    const sec = await kit.call('GET', `${STORE}/security`, { token: ok.body.tokens.accessToken });
    expect(sec.body.twoStep.recoveryCodesRemaining).toBe(9);
  });

  it('skips 2-step on a remembered member device (same installation) for 30 days', async () => {
    const c = await customer(kit);
    const { key } = await enableTotp(kit, c.tokens.accessToken, c.password);
    const device = android('remembered-phone');
    const s1 = await signIn(kit, { email: c.email, password: c.password, device });
    const v1 = await kit.call('POST', `${PUBLIC}/sign-in-challenges/${s1.body.challenge.id}/verify`, {
      token: (await visitor(kit)).accessToken,
      body: { method: 'totp', code: totp(key, kit.clock.now()), rememberDevice: true },
    });
    // the challenge is bound to the visitor that started it
    expect(v1.status).toBe(404);
    const v = await visitor(kit);
    const s2 = await kit.call('POST', `${PUBLIC}/sessions`, { token: v.accessToken, body: { email: c.email, password: c.password, audience: 'store', keepSignedIn: false, device } });
    const ok = await kit.call('POST', `${PUBLIC}/sign-in-challenges/${s2.body.challenge.id}/verify`, { token: v.accessToken, body: { method: 'totp', code: totp(key, kit.clock.now()), rememberDevice: true } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const trusted = await signIn(kit, { email: c.email, password: c.password, device });
    expect(trusted.body.status).toBe('signed_in');
    const elsewhere = await signIn(kit, { email: c.email, password: c.password, device: android('other-phone') });
    expect(elsewhere.body.status).toBe('second_factor_required');
    kit.clock.advance(30_000);
  });

  it('locks the challenge after five wrong codes', async () => {
    const c = await customer(kit);
    await enableTotp(kit, c.tokens.accessToken, c.password);
    const v = await visitor(kit);
    const s = await kit.call('POST', `${PUBLIC}/sessions`, { token: v.accessToken, body: { email: c.email, password: c.password, audience: 'store', keepSignedIn: false, device: android() } });
    let last: any;
    for (let i = 0; i < 5; i++) last = await kit.call('POST', `${PUBLIC}/sign-in-challenges/${s.body.challenge.id}/verify`, { token: v.accessToken, body: { method: 'totp', code: 'abcdef', rememberDevice: false } });
    expect(last.body.error.code).toBe('CHALLENGE_LOCKED');
  });
});

describe('text message codes (phase 2)', () => {
  it('sets up a phone, then texts the sign-in code on request', async () => {
    const c = await customer(kit);
    const setup = await kit.call('POST', `${STORE}/two-step/setups`, { token: c.tokens.accessToken, body: { method: 'sms', phone: '+15035550148', currentPassword: c.password } });
    expect(setup.status, JSON.stringify(setup.body)).toBe(201);
    expect(setup.body).toMatchObject({ method: 'sms', phoneMasked: '(503) •••-0148', otpauthUri: null });
    const sent = kit.last('identity.verification.code_issued');
    expect(sent).toMatchObject({ channel: 'sms', to: '+15035550148', purpose: 'phone_verification', accountId: c.accountId });
    const ok = await kit.call('POST', `${STORE}/two-step/setups/${setup.body.setupId}/confirm`, { token: c.tokens.accessToken, body: { code: sent.code } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(kit.last('identity.two_step.changed')).toMatchObject({ enabled: true, method: 'sms' });

    const v = await visitor(kit);
    const s = await kit.call('POST', `${PUBLIC}/sessions`, { token: v.accessToken, body: { email: c.email, password: c.password, audience: 'store', keepSignedIn: false, device: android() } });
    expect(s.body.challenge).toMatchObject({ methods: ['sms', 'recovery_code'], smsPhoneMasked: '(503) •••-0148' });
    const text = await kit.call('POST', `${PUBLIC}/sign-in-challenges/${s.body.challenge.id}/send-sms`, { token: v.accessToken });
    expect(text.status, JSON.stringify(text.body)).toBe(200);
    const code = kit.last('identity.verification.code_issued');
    expect(code).toMatchObject({ channel: 'sms', purpose: 'sign_in_second_factor', to: '+15035550148' });
    const soon = await kit.call('POST', `${PUBLIC}/sign-in-challenges/${s.body.challenge.id}/send-sms`, { token: v.accessToken });
    expect(soon.body.error.code).toBe('RESEND_TOO_SOON');
    const done = await kit.call('POST', `${PUBLIC}/sign-in-challenges/${s.body.challenge.id}/verify`, { token: v.accessToken, body: { method: 'sms', code: code.code, rememberDevice: false } });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe('signed_in');
  });
});

describe('re-auth, recovery codes and removal', () => {
  it('re-auths with a 2-step code, regenerates codes, and removes the method with a re-auth token', async () => {
    const c = await customer(kit);
    const { key, recoveryCodes } = await enableTotp(kit, c.tokens.accessToken, c.password);
    const noProof = await kit.call('POST', `${STORE}/two-step/recovery-codes`, { token: c.tokens.accessToken, body: { reauthToken: 'x' } });
    expect(noProof.body.error.code).toBe('STEP_UP_REQUIRED');
    const r1 = await kit.call('POST', `${STORE}/reauth`, { token: c.tokens.accessToken, body: { code: totp(key, kit.clock.now()) } });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    const regen = await kit.call('POST', `${STORE}/two-step/recovery-codes`, { token: c.tokens.accessToken, body: { reauthToken: r1.body.reauthToken } });
    expect(regen.status, JSON.stringify(regen.body)).toBe(200);
    expect(regen.body.codes).toHaveLength(10);
    expect(regen.body.codes).not.toContain(recoveryCodes[0]);
    kit.clock.advance(30_000);

    const sec = await kit.call('GET', `${STORE}/security`, { token: c.tokens.accessToken });
    const methodId = sec.body.twoStep.methods[0].id;
    const r2 = await kit.call('POST', `${STORE}/reauth`, { token: c.tokens.accessToken, body: { password: c.password } });
    const bad = await kit.call('POST', `${STORE}/two-step/methods/${methodId}/remove`, { token: c.tokens.accessToken, body: { reauthToken: r2.body.reauthToken, code: '000000' === totp(key, kit.clock.now()) ? '111111' : '000000' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('CODE_INVALID');
    // a failed request does not spend the re-auth token
    const removed = await kit.call('POST', `${STORE}/two-step/methods/${methodId}/remove`, { token: c.tokens.accessToken, body: { reauthToken: r2.body.reauthToken, code: regen.body.codes[0] } });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ enabled: false, methods: [], recoveryCodesRemaining: 0 });
    expect(kit.last('identity.two_step.changed')).toMatchObject({ accountId: c.accountId, enabled: false, method: 'totp' });
    expect((await signIn(kit, { email: c.email, password: c.password })).body.status).toBe('signed_in');
  });

  it('verifyStepUp checks a password or a current code (public API)', async () => {
    const c = await customer(kit);
    const { key } = await enableTotp(kit, c.tokens.accessToken, c.password);
    expect(await identity.verifyStepUp(c.accountId, { password: c.password })).toBe(true);
    expect(await identity.verifyStepUp(c.accountId, { password: 'Wrong-Pass-9' })).toBe(false);
    expect(await identity.verifyStepUp(c.accountId, { code: totp(key, kit.clock.now()) })).toBe(true);
    expect(await identity.verifyStepUp(c.accountId, { code: totp(key, kit.clock.now()) })).toBe(false); // replay
    expect(await identity.verifyStepUp(c.accountId, {})).toBe(false);
    kit.clock.advance(30_000);
  });
});
