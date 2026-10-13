/**
 * Sign-in: email and password with failed-attempt locks, the 2-step challenge (code, text message, recovery
 * code) and Continue with Google / Apple.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type {
  DeviceInfo,
  SecondFactorRequest,
  SignInChallenge,
  SignInRequest,
  SignInResult,
} from '../../../spec/identity.js';
import { hashPassword, needsRehash, safeEqual, sixDigitCode, verifyTotp } from '../domain/crypto.js';
import { lockInForce, normalizeEmail, registerFailure, type Realm } from '../domain/policy.js';
import { accountStatusMachine } from '../domain/state-machines.js';
import * as map from '../mappers.js';
import type { AccountRow, Audience, ChallengeRow, TwoStepMethodRow } from '../ports.js';
import type { IdentityRepository } from '../repository.js';
import { type Core, type ClientInfo, type Caller, type WithCookie, MIN, DAY, audienceOk } from './core.js';

export class Authentication {
  constructor(readonly core: Core) {}

  /** Unknown emails get the same answers as real ones (lock included), from sign_in_attempts */
  private async unknownAccountFailure(email: string, s: Awaited<ReturnType<Core['cfg']>>, now: Date): Promise<never> {
    // replay the attempts through the same counter a real account keeps: a window of lockoutMinutes,
    // a lock at maxFailedSignIns, attempts during a lock not counted, a fresh count after it ends
    const windowMs = s.lockoutMinutes * MIN;
    const fails = await this.core.repo.failedAttemptsSince(email, new Date(now.getTime() - 3 * windowMs));
    let counter: { failed_sign_ins: number; failed_window_started_at: Date | null } = { failed_sign_ins: 0, failed_window_started_at: null };
    let lockedUntil: Date | null = null;
    let attemptsLeft = s.maxFailedSignIns;
    for (const at of fails) {
      if (lockedUntil && at < lockedUntil) continue;
      if (lockedUntil) {
        lockedUntil = null;
        counter = { failed_sign_ins: 0, failed_window_started_at: null };
      }
      const f = registerFailure(counter, at, s);
      counter = f;
      attemptsLeft = f.attemptsLeft;
      if (f.lock) lockedUntil = new Date(at.getTime() + windowMs);
    }
    if (lockedUntil && lockedUntil > now) throw new AppError('ACCOUNT_LOCKED', 'Sign-in is paused for this account', { lockedUntil: map.iso(lockedUntil), cause: 'failed_sign_ins' });
    throw new AppError('INVALID_CREDENTIALS', "Email and password don't match", { attemptsLeft });
  }

  lockedError(a: AccountRow) {
    return new AppError('ACCOUNT_LOCKED', 'Sign-in is paused for this account', { lockedUntil: map.isoOrNull(a.locked_until), cause: a.locked_by ? 'staff_action' : 'failed_sign_ins' });
  }

  /** A lock whose end has passed is lifted (lockExpires) before the account is used */
  async liftExpiredLock(repo: IdentityRepository, a: AccountRow, now: Date): Promise<AccountRow> {
    if (a.status !== 'locked' || lockInForce(a, now)) return a;
    const status = accountStatusMachine.next('locked', 'lockExpires');
    const lifted = await repo.updateAccount(a.id, { status, locked_until: null, lock_reason: null, locked_by: null, failed_sign_ins: 0, failed_window_started_at: null });
    await this.core.securityEvent(repo, a.id, 'account_unlocked', 'completed', { detail: { cause: 'expired' } });
    return lifted;
  }

  /**
   * A wrong password or step-up answer, counted on the account's shared counter. Locks the account
   * for lockoutMinutes at the limit. Returns what to publish and how many attempts are left.
   */
  async countFailure(
    repo: IdentityRepository,
    a: AccountRow,
    s: Awaited<ReturnType<Core['cfg']>>,
    now: Date,
    o: { client?: ClientInfo; audience?: Audience | null; reason: 'password' | 'step_up' | 'second_factor' },
  ) {
    const f = registerFailure(a, now, s);
    const lock = f.lock && a.status === 'active';
    const lockedUntil = new Date(now.getTime() + s.lockoutMinutes * MIN);
    const status = lock ? accountStatusMachine.next('active', 'tooManyFailedSignIns') : a.status;
    const updated = await repo.updateAccount(a.id, {
      failed_sign_ins: f.failed_sign_ins,
      failed_window_started_at: f.failed_window_started_at,
      ...(lock ? { status, locked_until: lockedUntil, lock_reason: 'Too many wrong passwords', locked_by: null } : {}),
    });
    await this.core.securityEvent(repo, a.id, 'sign_in_failed', 'failed', { client: o.client, audience: o.audience, detail: { reason: o.reason, attemptsLeft: f.attemptsLeft } });
    if (lock) await this.core.securityEvent(repo, a.id, 'account_locked', 'blocked', { client: o.client, audience: o.audience, detail: { cause: 'failed_sign_ins', failures: f.failed_sign_ins, minutes: s.lockoutMinutes } });
    return {
      account: updated,
      attemptsLeft: f.attemptsLeft,
      locked: lock,
      lockedUntil,
      after: () => {
        if (lock) this.core.publish('identity.account.locked', { accountId: a.id, realm: a.realm, cause: 'failed_sign_ins', until: map.iso(lockedUntil), by: null, reason: null });
      },
    };
  }

  /** POST /sessions: email and password */
  async signIn(body: SignInRequest, caller: Caller): Promise<WithCookie<SignInResult>> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const email = normalizeEmail(body.email);
    const realm: Realm = body.audience === 'admin' ? 'staff' : 'member';
    const found = await this.core.repo.findAccount(realm, email);
    const ok = await this.core.checkPassword(found?.status === 'invited' ? undefined : found, body.password);
    await this.core.repo.insertSignInAttempt({ email_normalized: email, ip: caller.client.ip ?? '0.0.0.0', succeeded: ok, at: now });
    if (!found || !found.password_hash || found.status === 'invited') return this.unknownAccountFailure(email, s, now);

    const visitorSessionId = caller.principal?.kind === 'visitor' ? caller.principal.sessionId : null;
    let after = () => {};
    const outcome = await this.core.repo.transaction(async (repo): Promise<{ error: AppError } | { result: SignInResult; web: boolean }> => {
      let a = (await repo.getAccount(found.id, { forUpdate: true }))!;
      a = await this.liftExpiredLock(repo, a, now);
      if (lockInForce(a, now)) {
        await this.core.securityEvent(repo, a.id, 'sign_in_blocked', 'blocked', { client: caller.client, audience: body.audience, detail: { cause: 'locked' } });
        return { error: this.lockedError(a) };
      }
      if (!ok) {
        const f = await this.countFailure(repo, a, s, now, { client: caller.client, audience: body.audience, reason: 'password' });
        after = f.after;
        return { error: f.locked ? this.lockedError(f.account) : new AppError('INVALID_CREDENTIALS', "Email and password don't match", { attemptsLeft: f.attemptsLeft }) };
      }
      if (a.status === 'disabled' || (a.status === 'closed' && (body.audience !== 'seller' || !(await repo.activeSellerAccess(a.id)).length))) {
        await this.core.securityEvent(repo, a.id, 'sign_in_blocked', 'blocked', { client: caller.client, audience: body.audience, detail: { cause: 'disabled' } });
        return { error: new AppError('ACCOUNT_DISABLED', 'This account is disabled') };
      }
      if (a.status === 'pending_verification') {
        await repo.supersedeChallenges(a.id, 'email_verification');
        const { row, code } = await this.core.newEmailCode(repo, { accountId: a.id, purpose: 'email_verification', email: a.email, payload: { visitorSessionId, device: body.device } }, s, now);
        after = () => this.core.codeIssued(row, code, 'email', a.email);
        return { error: new AppError('EMAIL_NOT_VERIFIED', 'Confirm your email first; we sent you a new code', { challenge: map.verificationChallenge(row) }) };
      }
      if (needsRehash(a.password_hash!)) a = await repo.updateAccount(a.id, { password_hash: await hashPassword(body.password) });
      const next = await this.afterFirstFactor(
        repo,
        a,
        { audience: body.audience, device: body.device, client: caller.client, keepSignedIn: body.keepSignedIn, sellerId: body.sellerId ?? null, visitorSessionId, callerSessionId: caller.principal?.sessionId ?? null, method: 'password' },
        s,
        now,
      );
      after = next.after;
      return { result: next.result, web: body.device.kind === 'web' };
    });
    after();
    if ('error' in outcome) throw outcome.error;
    return this.core.deliver(outcome.result, outcome.web, now);
  }

  /** After the password (or provider): a 2-step challenge when the account needs one, else the session */
  private async afterFirstFactor(
    repo: IdentityRepository,
    a: AccountRow,
    o: { audience: Audience; device: DeviceInfo; client: ClientInfo; keepSignedIn: boolean; sellerId: string | null; visitorSessionId: string | null; callerSessionId: string | null; method: 'password' | 'code' },
    s: Awaited<ReturnType<Core['cfg']>>,
    now: Date,
  ): Promise<{ result: SignInResult; after: () => void }> {
    const methods = await repo.activeMethods([a.id]);
    const needsSecondFactor = methods.length > 0 && (a.realm === 'staff' || !(await this.core.trustedDevice(repo, a.id, o.device, now)));
    if (needsSecondFactor) {
      await repo.updateAccount(a.id, { failed_sign_ins: 0, failed_window_started_at: null });
      const challenge = await this.newSignInChallenge(
        repo,
        a,
        methods,
        { audience: o.audience, keepSignedIn: o.keepSignedIn, device: o.device, sellerId: o.sellerId, visitorSessionId: o.visitorSessionId, callerSessionId: o.callerSessionId },
        s,
        now,
      );
      return { result: { status: 'second_factor_required', account: null, tokens: null, challenge, sellerContexts: [], passwordResetToken: null }, after: () => {} };
    }
    // staff without a method (after a staff reset) sign in without twoStepAt: admin areas refuse
    // with STEP_UP_REQUIRED until they add a method through /api/store/identity/two-step/setups
    return this.core.completeSignIn(
      repo,
      a,
      { audience: o.audience, device: o.device, client: o.client, keepSignedIn: o.keepSignedIn, twoStepVerified: false, sellerId: o.sellerId, visitorSessionId: o.visitorSessionId, method: o.method },
      s,
      now,
    );
  }

  private async newSignInChallenge(
    repo: IdentityRepository,
    a: AccountRow,
    methods: TwoStepMethodRow[],
    payload: Record<string, unknown>,
    s: Awaited<ReturnType<Core['cfg']>>,
    now: Date,
  ): Promise<SignInChallenge> {
    const recovery = (await repo.remainingRecoveryCodes([a.id])).get(a.id) ?? 0;
    const sms = methods.find((m) => m.method === 'sms');
    const row: ChallengeRow = {
      id: newId(),
      account_id: a.id,
      purpose: 'sign_in_second_factor',
      target_email: null,
      code_hash: null,
      payload: payload as never,
      attempts: 0,
      max_attempts: s.maxCodeAttempts,
      status: 'pending',
      expires_at: new Date(now.getTime() + s.verificationCodeTtlMinutes * MIN),
      resend_available_at: now,
      created_at: now,
      completed_at: null,
      target_phone_encrypted: null,
    };
    await repo.insertChallenge(row);
    return this.signInChallenge(row, methods, recovery, sms);
  }

  private signInChallenge(row: ChallengeRow, methods: TwoStepMethodRow[], recovery: number, sms?: TwoStepMethodRow): SignInChallenge {
    const kinds: SignInChallenge['methods'] = [];
    if (methods.some((m) => m.method === 'totp')) kinds.push('totp');
    if (sms) kinds.push('sms');
    if (recovery > 0) kinds.push('recovery_code');
    return { id: row.id, methods: kinds, smsPhoneMasked: sms?.phone_masked ?? null, expiresAt: map.iso(row.expires_at) };
  }

  /** A sign-in challenge of the caller's own sign-in (bound to the visitor session that started it) */
  private signInChallengeFor(c: ChallengeRow | undefined, caller: Caller, now: Date) {
    const payload = (c?.payload ?? {}) as Record<string, unknown>;
    if (c && payload.callerSessionId && payload.callerSessionId !== caller.principal?.sessionId) throw new AppError('NOT_FOUND', 'Sign-in request not found');
    return this.core.openChallenge(c, ['sign_in_second_factor'], now);
  }

  /** Checks a 2-step code (TOTP, SMS or recovery code) for an account; marks what it used. */
  async checkSecondFactor(repo: IdentityRepository, a: AccountRow, method: 'totp' | 'sms' | 'recovery_code', code: string, now: Date, smsChallenge?: ChallengeRow): Promise<TwoStepMethodRow | 'recovery' | null> {
    if (method === 'recovery_code') return (await repo.useRecoveryCode(a.id, this.core.recoveryHash(a.id, code), now)) ? 'recovery' : null;
    const methods = await repo.activeMethods([a.id]);
    if (method === 'sms') {
      const m = methods.find((x) => x.method === 'sms');
      if (!m || !smsChallenge?.code_hash || !safeEqual(smsChallenge.code_hash, this.core.codeHash(smsChallenge.id, code))) return null;
      await repo.updateMethod(m.id, { last_used_at: now });
      return m;
    }
    for (const m of methods.filter((x) => x.method === 'totp')) {
      const step = m.secret_encrypted ? verifyTotp(this.core.keys.decrypt(m.secret_encrypted), code, now, m.last_used_step) : null;
      if (step !== null) {
        await repo.updateMethod(m.id, { last_used_at: now, last_used_step: step });
        return m;
      }
    }
    return null;
  }

  /** POST /sign-in-challenges/{id}/verify */
  async verifySecondFactor(id: string, body: SecondFactorRequest, caller: Caller): Promise<WithCookie<SignInResult>> {
    const s = await this.core.cfg();
    const now = this.core.now();
    let after = () => {};
    const outcome = await this.core.repo.transaction(async (repo): Promise<{ error: AppError } | { result: SignInResult; web: boolean }> => {
      const c = this.signInChallengeFor(await repo.getChallenge(id, { forUpdate: true }), caller, now);
      let a = c.account_id ? await repo.getAccount(c.account_id, { forUpdate: true }) : undefined;
      if (!a) throw new AppError('NOT_FOUND', 'Sign-in request not found');
      const used = await this.checkSecondFactor(repo, a, body.method, body.code, now, c);
      if (!used) {
        await this.core.securityEvent(repo, a.id, 'sign_in_failed', 'failed', { client: caller.client, detail: { reason: 'second_factor' } });
        return { error: await this.core.wrongCode(repo, c) };
      }
      await repo.updateChallenge(c.id, { status: 'completed', completed_at: now });
      a = await this.liftExpiredLock(repo, a, now);
      if (lockInForce(a, now)) return { error: this.lockedError(a) };
      if (a.status === 'disabled' || a.status === 'closed') return { error: new AppError('ACCOUNT_DISABLED', 'This account is disabled') };
      const p = (c.payload ?? {}) as Record<string, unknown>;
      const audience = audienceOk(p.audience) ? p.audience : 'store';
      const device = (p.device ?? { kind: 'web' }) as DeviceInfo;
      const done = await this.core.completeSignIn(
        repo,
        a,
        {
          audience,
          device,
          client: caller.client,
          keepSignedIn: p.keepSignedIn === true,
          twoStepVerified: true,
          sellerId: (p.sellerId as string | null) ?? null,
          visitorSessionId: (p.visitorSessionId as string | null) ?? null,
          method: 'two_step',
        },
        s,
        now,
      );
      // members may skip 2-step on this device for trustedDeviceDays (only devices with an installation id are recognised)
      if (body.rememberDevice && a.realm === 'member' && device.installationId && done.result.tokens) {
        const d = await repo.findDeviceByInstallation(a.id, device.installationId);
        if (d) await repo.updateDevice(d.id, { two_step_trusted_until: new Date(now.getTime() + s.trustedDeviceDays * DAY) });
      }
      after = done.after;
      return { result: done.result, web: device.kind === 'web' };
    });
    after();
    if ('error' in outcome) throw outcome.error;
    return this.core.deliver(outcome.result, outcome.web, now);
  }

  /** POST /sign-in-challenges/{id}/send-sms (phase 2) */
  async sendSignInSms(id: string, caller: Caller): Promise<SignInChallenge> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const out = await this.core.repo.transaction(async (repo) => {
      const c = await repo.getChallenge(id, { forUpdate: true });
      const payload = (c?.payload ?? {}) as Record<string, unknown>;
      if (!c || c.purpose !== 'sign_in_second_factor' || (payload.callerSessionId && payload.callerSessionId !== caller.principal?.sessionId)) throw new AppError('NOT_FOUND', 'Sign-in request not found');
      if (c.status !== 'pending' || c.expires_at <= now) throw new AppError('CODE_EXPIRED', 'This sign-in has expired; sign in again');
      const methods = c.account_id ? await repo.activeMethods([c.account_id]) : [];
      const sms = methods.find((m) => m.method === 'sms');
      if (!sms?.phone_e164_encrypted) throw new AppError('METHOD_NOT_AVAILABLE', 'Text messages are not set up for this account');
      if (c.code_hash && c.resend_available_at && c.resend_available_at > now) throw new AppError('RESEND_TOO_SOON', 'Wait a moment before asking for a new code', { resendAvailableAt: map.iso(c.resend_available_at) });
      const code = sixDigitCode();
      const row = await repo.updateChallenge(c.id, { code_hash: this.core.codeHash(c.id, code), resend_available_at: new Date(now.getTime() + s.codeResendSeconds * 1000) });
      const recovery = (await repo.remainingRecoveryCodes([c.account_id!])).get(c.account_id!) ?? 0;
      return { row, code, phone: this.core.keys.decrypt(sms.phone_e164_encrypted).toString('utf8'), challenge: this.signInChallenge(row, methods, recovery, sms) };
    });
    this.core.codeIssued(out.row, out.code, 'sms', out.phone);
    return out.challenge;
  }

  /**
   * POST /external-sign-ins (phase 2): members only. An existing account is used only when the
   * provider vouches for the same email; otherwise a verified member account is created.
   */
  async externalSignIn(
    body: { provider: 'google' | 'apple'; idToken: string; audience: 'store' | 'seller'; device: DeviceInfo; marketingOptIn?: boolean | null },
    caller: Caller,
  ): Promise<WithCookie<SignInResult>> {
    const verifier = this.core.deps.externalIds;
    if (!verifier) throw new AppError('NOT_IMPLEMENTED', 'Sign-in with Google or Apple is not configured on this server', { reason: 'provider_not_configured', provider: body.provider });
    const ext = await verifier.verify(body.provider, body.idToken);
    if (!ext || !ext.emailVerified) throw new AppError('INVALID_CREDENTIALS', `${body.provider === 'google' ? 'Google' : 'Apple'} could not confirm your email; sign in with your password`);
    const s = await this.core.cfg();
    const now = this.core.now();
    const email = normalizeEmail(ext.email);
    const visitorSessionId = caller.principal?.kind === 'visitor' ? caller.principal.sessionId : null;
    let after = () => {};
    let registered: AccountRow | null = null;
    const outcome = await this.core.repo.transaction(async (repo): Promise<{ error: AppError } | { result: SignInResult }> => {
      let a = await repo.findAccount('member', email, { forUpdate: true });
      if (a) {
        a = await this.liftExpiredLock(repo, a, now);
        if (lockInForce(a, now)) return { error: this.lockedError(a) };
        if (a.status === 'disabled' || (a.status === 'closed' && (body.audience !== 'seller' || !(await repo.activeSellerAccess(a.id)).length))) return { error: new AppError('ACCOUNT_DISABLED', 'This account is disabled') };
        if (a.status === 'pending_verification') {
          // the provider proves the email; a password chosen by an unconfirmed registration is dropped
          a = await repo.updateAccount(a.id, { status: accountStatusMachine.next('pending_verification', 'verifyEmail'), email_verified_at: now, password_hash: null });
          await this.core.securityEvent(repo, a.id, 'email_verified', 'completed', { client: caller.client, detail: { via: body.provider } });
        }
      } else {
        const local = ext.email.split('@')[0]!;
        const firstName = ext.firstName?.trim() || local;
        const lastName = ext.lastName?.trim() || '';
        a = {
          id: newId(),
          realm: 'member',
          email: ext.email.trim(),
          email_normalized: email,
          email_verified_at: now,
          display_name: `${firstName} ${lastName}`.trim(),
          status: accountStatusMachine.next(accountStatusMachine.initial, 'verifyEmail'),
          password_hash: null,
          password_changed_at: null,
          must_reset_password: false,
          failed_sign_ins: 0,
          failed_window_started_at: null,
          locked_until: null,
          lock_reason: null,
          locked_by: null,
          closed_at: null,
          accepted_terms_version: null,
          created_at: now,
          last_sign_in_at: null,
          last_active_at: null,
          version: 1,
          tokens_valid_after: null,
        };
        await repo.insertAccount(a);
        registered = a;
      }
      const next = await this.afterFirstFactor(
        repo,
        a,
        // the request has no keep-me-signed-in choice: the app stays signed in, the website gets the short lifetime
        { audience: body.audience, device: body.device, client: caller.client, keepSignedIn: body.device.kind === 'android', sellerId: null, visitorSessionId, callerSessionId: caller.principal?.sessionId ?? null, method: 'code' },
        s,
        now,
      );
      after = next.after;
      return { result: next.result };
    });
    if (registered) {
      const r: AccountRow = registered;
      const [firstName, ...rest] = r.display_name.split(' ');
      this.core.publish('identity.user.registered', { accountId: r.id, email: r.email, firstName: firstName ?? '', lastName: rest.join(' '), marketingOptIn: body.marketingOptIn ?? false, acceptedTermsVersion: '', guestSessionId: visitorSessionId, at: map.iso(now) }, caller);
    }
    after();
    if ('error' in outcome) throw outcome.error;
    return this.core.deliver(outcome.result, body.device.kind === 'web', now);
  }
}
