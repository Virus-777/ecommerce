/**
 * Signing people in the way the apps do: app sessions for visitors, registration with the emailed code,
 * accepting a staff invitation from its email (password + authenticator), staff sign-in with a 2-step code,
 * seller sign-in after an approved application.
 *
 * What a person reads in their mailbox comes from the development outbox (notifications/providers/dev-outbox.ts):
 * the development email provider records what it would have sent, and the codes and links in those emails are
 * stored nowhere else. Authenticator codes come from the key the person typed into their authenticator app
 * (testing/totp.ts does what the app does).
 */
import type { FastifyInstance } from 'fastify';
import { devOutbox } from '../../src/modules/notifications/providers/dev-outbox.js';
import { totp } from '../../src/testing/totp.js';
import type { AppName, Client, Session, SessionTokens } from './http.js';
import type { Runner } from './runner.js';

export interface Person {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone: string;
}

/** A staff member with their authenticator */
export interface Staff extends Person {
  accountId: string;
  /** The authenticator key from the 2-step setup (manual entry key) */
  totpKey: string;
  /** Last 30-second step used for a code: the server refuses a step at or before it */
  lastStep: number | null;
  session: Session;
  roles: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function device(client: 'web' | 'android') {
  return client === 'android' ? { kind: 'android' as const, name: 'Marketly app on Pixel 8', appVersion: '1.4.2', installationId: `inst-${crypto.randomUUID()}` } : { kind: 'web' as const };
}

export class People {
  constructor(
    private readonly app: FastifyInstance,
    private readonly api: Client,
    private readonly runner: Runner,
  ) {}

  /** The token an app gets when it opens (POST /app-sessions with the app proof; "dev" outside production) */
  async visitor(app: AppName, client: 'web' | 'android' = 'web', label = `visitor (${app})`): Promise<Session> {
    const r = await this.api.request({ app, client }, 'POST', '/api/public/identity/app-sessions', { audience: app, device: device(client) }, { headers: { 'x-app-proof': 'dev' } });
    return this.api.session(label, app, client, r.body as SessionTokens, r.headers);
  }

  /**
   * The newest email to an address whose text matches `pattern`, as the person would open it. Emails are sent by
   * notifications' consumers; when nothing has arrived yet the delivery job runs once (development servers run no
   * scheduled jobs: app.kernel.jobs.runNow stands in for the scheduler).
   */
  async fromMailbox(address: string, pattern: RegExp, what: string): Promise<string> {
    const found = await this.peekMailbox(address, pattern);
    if (found === undefined) {
      const subjects = devOutbox.emailsTo(address).map((m) => m.message.subject);
      this.runner.fail({ step: `email: ${what}`, message: `no email with ${what} reached ${address}`, body: subjects });
    }
    this.runner.pass();
    return found;
  }

  /** Like fromMailbox, without judging: undefined when no such email arrived */
  async peekMailbox(address: string, pattern: RegExp): Promise<string | undefined> {
    const find = () => {
      const mails = devOutbox.emailsTo(address);
      for (let i = mails.length - 1; i >= 0; i--) {
        const m = mails[i]!.message;
        const hit = `${m.subject}\n${m.text}`.match(pattern);
        if (hit) return hit[1] ?? hit[0];
      }
      return undefined;
    };
    let found = find();
    if (found === undefined) {
      await this.app.kernel.jobs.runNow('notifications.dispatch');
      await this.app.kernel.events.drain();
      found = find();
    }
    return found;
  }

  /**
   * A fresh authenticator code. The server accepts the current 30-second step or the next one, each only once and
   * never one at or before the last used, so a staff member gets two codes at once and then one per step: wait
   * when needed, like a person waiting for their app to show the next code.
   */
  async code(s: Staff): Promise<string> {
    for (;;) {
      const now = Math.floor(Date.now() / 30_000);
      const step = Math.max(now, (s.lastStep ?? now - 1) + 1);
      if (step <= now + 1) {
        s.lastStep = step;
        return totp(s.totpKey, new Date(step * 30_000 + 1_000));
      }
      const wait = (step - 1) * 30_000 - Date.now() + 500;
      console.log(`    (waiting ${Math.ceil(wait / 1000)}s for ${s.firstName}'s next authenticator code)`);
      await sleep(wait);
    }
  }

  /** Accepts an emailed staff invitation: password, then the authenticator (2-step is required for staff) */
  async acceptStaffInvitation(p: Person, roles: string[]): Promise<Staff> {
    const token = await this.fromMailbox(p.email, /#token=([\w.~-]+)/, 'the invitation link');
    const v = await this.visitor('admin');
    const lookup = await this.api.call(v, 'POST', '/api/public/identity/invitations/lookups', { token });
    this.runner.check('the invitation names this person', lookup.name === `${p.firstName} ${p.lastName}` && lookup.requiresTwoStepSetup === true, lookup);
    const d = device('web');
    const accepted = await this.api.call(v, 'POST', '/api/public/identity/invitations/accept', { token, password: p.password, name: `${p.firstName} ${p.lastName}`, device: d });
    this.runner.check('staff must set up 2-step', accepted.status === 'two_step_setup_required' && accepted.twoStepSetup, accepted);
    const staff: Staff = { ...p, accountId: accepted.account.id, totpKey: accepted.twoStepSetup.manualEntryKey, lastStep: null, session: v, roles };
    const confirmed = await this.api.request(v, 'POST', '/api/public/identity/invitations/two-step', { token, setupId: accepted.twoStepSetup.setupId, code: await this.code(staff), device: d });
    staff.session = this.api.session(`staff ${p.firstName} ${p.lastName}`, 'admin', 'web', confirmed.body.tokens, confirmed.headers, staff.accountId);
    return staff;
  }

  /** Staff sign-in to the Admin Center: password, then a code from the authenticator */
  async staffSignIn(s: Staff): Promise<void> {
    const v = await this.visitor('admin');
    const first = await this.api.call(v, 'POST', '/api/public/identity/sessions', { email: s.email, password: s.password, audience: 'admin', keepSignedIn: false, device: device('web') });
    this.runner.check('staff sign-in asks for the second factor', first.status === 'second_factor_required' && first.challenge?.id, first);
    const done = await this.api.request(v, 'POST', `/api/public/identity/sign-in-challenges/${first.challenge.id}/verify`, { method: 'totp', code: await this.code(s), rememberDevice: false });
    this.runner.check('signed in', done.body.status === 'signed_in', done.body);
    s.session = this.api.session(`staff ${s.firstName} ${s.lastName}`, 'admin', 'web', done.body.tokens, done.headers, s.accountId);
  }

  /** Registration in the store: the form, then the 6-digit code from the email; signs the customer in */
  async registerCustomer(p: Person, client: 'web' | 'android', marketingOptIn: boolean): Promise<Session> {
    const v = await this.visitor('store', client);
    const reg = await this.api.call(v, 'POST', '/api/public/identity/registrations', {
      email: p.email,
      password: p.password,
      firstName: p.firstName,
      lastName: p.lastName,
      marketingOptIn,
      acceptedTermsVersion: '2026-01',
      device: device(client),
    });
    const code = await this.fromMailbox(p.email, /\b(\d{6})\b/, 'the verification code');
    const r = await this.api.request(v, 'POST', `/api/public/identity/verifications/${reg.id}/confirm`, { code, keepSignedIn: true, device: device(client) });
    this.runner.check('registration verified and signed in', r.body.verified === true && r.body.tokens, r.body);
    return this.api.session(`customer ${p.email}`, 'store', client, r.body.tokens, r.headers, r.body.account.id);
  }

  /** Password sign-in to the store or Seller Center (no second factor for members without one) */
  async signIn(p: Person, app: 'store' | 'seller', client: 'web' | 'android', sellerId?: string): Promise<Session> {
    const v = await this.visitor(app, client);
    const r = await this.api.request(v, 'POST', '/api/public/identity/sessions', { email: p.email, password: p.password, audience: app, keepSignedIn: false, device: device(client), ...(sellerId ? { sellerId } : {}) });
    this.runner.check(`signed in to ${app}`, r.body.status === 'signed_in' && r.body.tokens, r.body);
    return this.api.session(`${app === 'seller' ? 'seller' : 'customer'} ${p.email}`, app, client, r.body.tokens, r.headers, r.body.account?.id);
  }
}
