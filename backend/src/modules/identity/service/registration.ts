/**
 * Registration: app sessions for the store and Seller Center apps, customer sign-up and the email or phone codes
 * that confirm it (and later email and phone changes).
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type {
  DeviceInfo,
  RegistrationRequest,
  SessionTokens,
  VerificationChallenge,
  VerifyCodeRequest,
  VerifyResult,
} from '../../../spec/identity.js';
import { hashPassword, randomToken, safeEqual, sixDigitCode, tokenHash } from '../domain/crypto.js';
import { normalizeEmail } from '../domain/policy.js';
import { accountStatusMachine } from '../domain/state-machines.js';
import { isE164, maskEmail, maskPhone } from '../domain/text.js';
import * as map from '../mappers.js';
import type { AccountRow, Audience, ChallengeRow, GuestSessionRow } from '../ports.js';
import { type Core, type Caller, type WithCookie, MIN, DAY, issue } from './core.js';

export class Registration {
  constructor(readonly core: Core) {}

  /** POST /app-sessions: a visitor token (and refresh token) for the app named in audience */
  async startAppSession(input: { audience: Audience; device: DeviceInfo }): Promise<WithCookie<SessionTokens>> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const refreshToken = randomToken('v.');
    const g: GuestSessionRow = {
      id: newId(),
      device_kind: input.device.kind,
      created_at: now,
      last_seen_at: now,
      expires_at: new Date(now.getTime() + s.visitorRefreshDays * DAY),
      claimed_by_account_id: null,
      claimed_at: null,
      audience: input.audience,
      refresh_token_hash: tokenHash(refreshToken),
      previous_token_hash: null,
      rotated_at: null,
    };
    await this.core.repo.insertGuestSession(g);
    const out = this.core.deliver({ tokens: this.core.visitorTokens(g, refreshToken, s) }, input.device.kind === 'web', now);
    return { result: out.result.tokens!, cookie: out.cookie };
  }

  /** POST /registrations: always 202 with a challenge, whether or not the email has an account */
  async register(body: RegistrationRequest, caller: Caller): Promise<VerificationChallenge> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const email = normalizeEmail(body.email);
    const firstName = body.firstName.trim();
    const lastName = body.lastName.trim();
    if (!firstName || !lastName) throw new AppError('VALIDATION_FAILED', 'Enter your first and last name', issue(firstName ? 'body.lastName' : 'body.firstName', 'required'));
    this.core.assertStrong(body.password, 'member', [email, firstName, lastName], s);
    const hash = await hashPassword(body.password);
    const visitorSessionId = caller.principal?.kind === 'visitor' && caller.principal.audience === 'store' ? caller.principal.sessionId : null;
    const displayName = `${firstName} ${lastName}`;

    const out = await this.core.repo.transaction(async (repo) => {
      const existing = await repo.findAccount('member', email, { forUpdate: true });
      if (existing && existing.status !== 'pending_verification') {
        // the email says "you already have an account"; this code will never verify
        const { row, code } = await this.core.newEmailCode(repo, { accountId: existing.id, purpose: 'email_verification', email: existing.email, payload: { existingAccount: true } }, s, now);
        return { row, code, registered: null };
      }
      let account: AccountRow;
      if (existing) {
        // a registration that was never confirmed: the newest attempt replaces it (the code proves the email)
        await repo.supersedeChallenges(existing.id, 'email_verification');
        account = await this.core.storePassword(repo, existing.id, hash, now, { display_name: displayName, email: body.email.trim(), accepted_terms_version: body.acceptedTermsVersion });
      } else {
        account = {
          id: newId(),
          realm: 'member',
          email: body.email.trim(),
          email_normalized: email,
          email_verified_at: null,
          display_name: displayName,
          status: accountStatusMachine.initial,
          password_hash: hash,
          password_changed_at: now,
          must_reset_password: false,
          failed_sign_ins: 0,
          failed_window_started_at: null,
          locked_until: null,
          lock_reason: null,
          locked_by: null,
          closed_at: null,
          accepted_terms_version: body.acceptedTermsVersion,
          created_at: now,
          last_sign_in_at: null,
          last_active_at: null,
          version: 1,
          tokens_valid_after: null,
        };
        await repo.insertAccount(account);
        await repo.addPasswordHistory({ id: newId(), account_id: account.id, password_hash: hash, created_at: now });
      }
      const { row, code } = await this.core.newEmailCode(
        repo,
        { accountId: account.id, purpose: 'email_verification', email: account.email, payload: { visitorSessionId, device: body.device, marketingOptIn: body.marketingOptIn } },
        s,
        now,
      );
      return { row, code, registered: account };
    });

    if (out.registered) {
      this.core.publish(
        'identity.user.registered',
        {
          accountId: out.registered.id,
          email: out.registered.email,
          firstName,
          lastName,
          marketingOptIn: body.marketingOptIn,
          acceptedTermsVersion: body.acceptedTermsVersion,
          guestSessionId: visitorSessionId,
          at: map.iso(now),
        },
        caller,
      );
    }
    this.core.codeIssued(out.row, out.code, 'email', out.row.target_email!);
    return map.verificationChallenge(out.row);
  }

  /** POST /verifications/{id}/confirm: registration, email change or phone code */
  async confirmVerification(id: string, body: VerifyCodeRequest, caller: Caller): Promise<WithCookie<VerifyResult>> {
    const s = await this.core.cfg();
    const now = this.core.now();
    let after = () => {};
    let web = false;
    const outcome = await this.core.repo.transaction(async (repo) => {
      const c = this.core.openChallenge(await repo.getChallenge(id, { forUpdate: true }), ['email_verification', 'email_change', 'phone_verification'], now);
      const payload = (c.payload ?? {}) as Record<string, unknown>;
      if (payload.existingAccount === true || !c.code_hash || !safeEqual(c.code_hash, this.core.codeHash(c.id, body.code))) return { error: await this.core.wrongCode(repo, c) };
      await repo.updateChallenge(c.id, { status: 'completed', completed_at: now });
      const account = c.account_id ? await repo.getAccount(c.account_id, { forUpdate: true }) : undefined;
      if (!account) throw new AppError('NOT_FOUND', 'Account not found');

      if (c.purpose === 'email_verification') {
        if (account.status !== 'pending_verification') return { error: new AppError('CODE_EXPIRED', 'This code is no longer valid') };
        const status = accountStatusMachine.next('pending_verification', 'verifyEmail');
        const verified = await repo.updateAccount(account.id, { status, email_verified_at: now });
        await this.core.securityEvent(repo, account.id, 'email_verified', 'completed', { client: caller.client });
        const device = (body.device ?? (payload.device as DeviceInfo | undefined) ?? { kind: 'web' }) as DeviceInfo;
        web = device.kind === 'web';
        const visitorSessionId = (payload.visitorSessionId as string | null | undefined) ?? (caller.principal?.kind === 'visitor' ? caller.principal.sessionId : null);
        const opened = await this.core.openSession(repo, verified, { audience: 'store', device, client: caller.client, keepSignedIn: body.keepSignedIn ?? false, twoStepVerified: false, visitorSessionId, method: 'code' }, s, now);
        const fresh = (await repo.getAccount(account.id))!;
        after = () => {
          this.core.publish('identity.user.verified', { accountId: account.id, channel: 'email', email: verified.email, phone: null, guestSessionId: opened.claimed ?? visitorSessionId ?? null, at: map.iso(now) }, caller);
          opened.after();
        };
        return { result: { verified: true, account: await this.core.summaryOf(fresh, repo), tokens: this.core.sessionTokens(opened.session, fresh, opened.refreshToken, s) } };
      }

      if (c.purpose === 'email_change') {
        const newEmail = c.target_email!;
        const taken = await repo.findAccount(account.realm, normalizeEmail(newEmail));
        if (taken && taken.id !== account.id) return { error: new AppError('EMAIL_IN_USE', 'Another account uses that email') };
        const oldEmail = account.email;
        const changed = await repo.updateAccount(account.id, { email: newEmail, email_normalized: normalizeEmail(newEmail), email_verified_at: now });
        await this.core.securityEvent(repo, account.id, 'email_changed', 'completed', { client: caller.client, detail: { from: maskEmail(oldEmail), to: maskEmail(newEmail) } });
        after = () => this.core.publish('identity.email.changed', { accountId: account.id, oldEmail, newEmail }, caller);
        return { result: { verified: true, account: await this.core.summaryOf(changed, repo), tokens: null } };
      }

      // phone_verification
      const phone = c.target_phone_encrypted ? this.core.keys.decrypt(c.target_phone_encrypted).toString('utf8') : null;
      after = () => this.core.publish('identity.user.verified', { accountId: account.id, channel: 'phone', email: account.email, phone, guestSessionId: null, at: map.iso(now) }, caller);
      return { result: { verified: true, account: await this.core.summaryOf(account, repo), tokens: null } };
    });
    if ('error' in outcome) throw outcome.error;
    after();
    return this.core.deliver(outcome.result, web, now);
  }

  /** POST /verifications/{id}/resend: a new code on the same challenge after the resend timer */
  async resendVerification(id: string): Promise<VerificationChallenge> {
    const s = await this.core.cfg();
    const now = this.core.now();
    const out = await this.core.repo.transaction(async (repo) => {
      const c = await repo.getChallenge(id, { forUpdate: true });
      if (!c || !['email_verification', 'email_change', 'phone_verification'].includes(c.purpose)) throw new AppError('NOT_FOUND', 'Code request not found');
      if (c.status !== 'pending') throw new AppError('CODE_EXPIRED', 'This request has ended; start again');
      if (c.resend_available_at && c.resend_available_at > now) throw new AppError('RESEND_TOO_SOON', 'Wait a moment before asking for a new code', { resendAvailableAt: map.iso(c.resend_available_at) });
      const code = sixDigitCode();
      const row = await repo.updateChallenge(c.id, {
        code_hash: this.core.codeHash(c.id, code),
        attempts: 0,
        expires_at: new Date(now.getTime() + s.verificationCodeTtlMinutes * MIN),
        resend_available_at: new Date(now.getTime() + s.codeResendSeconds * 1000),
      });
      return { row, code };
    });
    const { row, code } = out;
    if (row.purpose === 'phone_verification') {
      const phone = row.target_phone_encrypted ? this.core.keys.decrypt(row.target_phone_encrypted).toString('utf8') : '';
      this.core.codeIssued(row, code, 'sms', phone);
    } else this.core.codeIssued(row, code, 'email', row.target_email!);
    return map.verificationChallenge(row);
  }

  /** Text a code to a new mobile number (identity.user.verified with channel phone when confirmed) */
  async startPhoneVerification(accountId: string, phone: string): Promise<VerificationChallenge> {
    const s = await this.core.cfg();
    const now = this.core.now();
    if (this.core.ctx.config.launchPhase < 2) throw new AppError('METHOD_NOT_AVAILABLE', 'Text message codes are not available yet');
    if (!isE164(phone)) throw new AppError('VALIDATION_FAILED', 'Enter a mobile number in international format', issue('phone', 'E.164 number required'));
    const out = await this.core.repo.transaction(async (repo) => {
      const a = isUuid(accountId) ? await repo.getAccount(accountId) : undefined;
      if (!a) throw new AppError('NOT_FOUND', 'Account not found');
      await repo.supersedeChallenges(a.id, 'phone_verification');
      const id = newId();
      const code = sixDigitCode();
      const row: ChallengeRow = {
        id,
        account_id: a.id,
        purpose: 'phone_verification',
        target_email: null,
        code_hash: this.core.codeHash(id, code),
        payload: { phoneMasked: maskPhone(phone) } as never,
        attempts: 0,
        max_attempts: s.maxCodeAttempts,
        status: 'pending',
        expires_at: new Date(now.getTime() + s.verificationCodeTtlMinutes * MIN),
        resend_available_at: new Date(now.getTime() + s.codeResendSeconds * 1000),
        created_at: now,
        completed_at: null,
        target_phone_encrypted: this.core.keys.encrypt(Buffer.from(phone, 'utf8')),
      };
      await repo.insertChallenge(row);
      return { row, code };
    });
    this.core.codeIssued(out.row, out.code, 'sms', phone);
    return map.verificationChallenge(out.row);
  }
}
