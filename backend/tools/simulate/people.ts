/**
 * Signing people in the way the apps do: app sessions for visitors, registration with the emailed code,
 * accepting a staff invitation with its link and pass code (handed over by the server operator), staff sign-in with
 * email and password, staff confirming sensitive actions with the password again, seller sign-in after an approved
 * application.
 *
 * What a person reads in their mailbox comes from the development outbox (notifications/providers/dev-outbox.ts):
 * the development email provider records what it would have sent, and the codes and links in those emails are
 * stored nowhere else. Staff use no authenticator app (owner decision 2026-10-14).
 */
import type { FastifyInstance } from 'fastify';
import { devOutbox } from '../../src/modules/notifications/providers/dev-outbox.js';
import type { AppName, Client, Session, SessionTokens } from './http.js';
import type { Runner } from './runner.js';

export interface Person {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone: string;
}

/** A staff member (email and password; the password again for sensitive actions) */
export interface Staff extends Person {
  accountId: string;
  session: Session;
  roles: string[];
}

/** What the server operator hands a new staff member (npm run bootstrap-owner or npm run staff-link) */
export interface StaffInvite {
  link: string;
  passCode: string;
}

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
   * A re-auth token for a sensitive Admin Center action: the staff member types the password again (purpose of the
   * endpoint: role-grant, staff-account, payout-destination, or approval above access stepUpAbove). Single use.
   */
  async reauth(s: Staff, purpose: 'role-grant' | 'staff-account' | 'payout-destination' | 'approval'): Promise<string> {
    const r = await this.api.call(s.session, 'POST', '/api/admin/identity/reauth', { purpose, password: s.password });
    return r.reauthToken as string;
  }

  /** Accepts a staff invitation with the link and pass code the server operator handed over, and a new password */
  async acceptStaffInvitation(p: Person, roles: string[], invite: StaffInvite): Promise<Staff> {
    const token = new URL(invite.link).hash.replace('#token=', '');
    const v = await this.visitor('admin');
    const lookup = await this.api.call(v, 'POST', '/api/public/identity/invitations/lookups', { token });
    this.runner.check('the invitation names this person and asks for the pass code', lookup.name === `${p.firstName} ${p.lastName}` && lookup.requiresPassCode === true, lookup);
    const accepted = await this.api.request(v, 'POST', '/api/public/identity/invitations/accept', { token, passCode: invite.passCode, password: p.password, name: `${p.firstName} ${p.lastName}`, device: device('web') });
    this.runner.check('the invitation signs the staff member in at once', accepted.body.status === 'signed_in' && accepted.body.tokens, accepted.body);
    const staff: Staff = { ...p, accountId: accepted.body.account.id, session: v, roles };
    staff.session = this.api.session(`staff ${p.firstName} ${p.lastName}`, 'admin', 'web', accepted.body.tokens, accepted.headers, staff.accountId);
    return staff;
  }

  /** Staff sign-in to the Admin Center: email and password */
  async staffSignIn(s: Staff): Promise<void> {
    const v = await this.visitor('admin');
    const done = await this.api.request(v, 'POST', '/api/public/identity/sessions', { email: s.email, password: s.password, audience: 'admin', keepSignedIn: false, device: device('web') });
    this.runner.check('staff sign in with email and password', done.body.status === 'signed_in', done.body);
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
