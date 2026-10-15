/**
 * Flow 1, staff: the Business Owner and a deputy, then the team every later flow works with, each invited from
 * the Admin Center (the inviter confirms with the password) and signed in through their own invitation: the link
 * and pass code the server operator prints with npm run staff-link (staff use no authenticator app).
 *
 * The first run creates the owner and the deputy with the bootstrap (an operator command, not an API: the same
 * call tools/bootstrap-owner.ts makes, which returns each link and pass code) and keeps their sign-in details in
 * .data/simulate-owner.json (gitignored). Later runs sign in as them with email and password.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccessService } from '../../../src/modules/access/service.js';
import { staffLink } from '../../lib/staff-link.js';
import type { Staff, StaffInvite } from '../people.js';
import type { Sim, World } from '../sim.js';

export const OWNER_FILE = fileURLToPath(new URL('../../../.data/simulate-owner.json', import.meta.url));

type Saved = Omit<Staff, 'session'>;

/** What the operator does for an invited person (npm run staff-link): a new link and pass code to hand over */
async function operatorLink(sim: Sim, email: string): Promise<StaffInvite> {
  const r = await staffLink(sim.app, { email });
  if (!r.link || !r.passCode) sim.run.fail({ step: 'npm run staff-link', message: `no invitation link and pass code for ${email}: ${r.done}` });
  return { link: r.link!, passCode: r.passCode! };
}

/** The team: who does what in the later flows, and the roles access seeds for it (access/domain/seed.ts) */
const TEAM: { key: keyof World['staff']; first: string; last: string; roles: string[] }[] = [
  { key: 'seller', first: 'Sam', last: 'Okafor', roles: ['seller_manager'] },
  { key: 'catalog', first: 'Cara', last: 'Lindqvist', roles: ['catalog_manager'] },
  { key: 'orders', first: 'Omar', last: 'Haddad', roles: ['order_manager', 'shipping_manager', 'returns_manager'] },
  { key: 'support', first: 'Avery', last: 'Brooks', roles: ['support_agent'] },
  { key: 'marketing', first: 'Mia', last: 'Moreno', roles: ['marketing_manager'] },
  // confirms the funding of campaigns Mia creates (nobody confirms their own campaign's funding)
  { key: 'marketingReviewer', first: 'Max', last: 'Ortega', roles: ['marketing_manager'] },
  { key: 'operations', first: 'Ian', last: 'Iverson', roles: ['inventory_manager', 'warehouse_manager', 'purchasing_manager', 'official_store_manager'] },
  { key: 'trust', first: 'Tia', last: 'Tanaka', roles: ['trust_and_risk_manager'] },
  // a sensitive grant: the other Business Owner approves it before the invitation can be accepted
  { key: 'finance', first: 'Fay', last: 'Foster', roles: ['finance_manager'] },
  // prepares payout runs that the Finance Manager approves (nobody approves their own run)
  { key: 'financeStaff', first: 'Felix', last: 'Jensen', roles: ['finance_staff'] },
];

/** The owner file: the two Business Owners, and whether each has accepted their invitation yet */
interface OwnerFile {
  owner: Saved & { accepted: boolean };
  deputy: Saved & { accepted: boolean };
}

const OWNER_ROLES = ['business_owner', 'platform_administrator'];

function load(): OwnerFile | null {
  if (!existsSync(OWNER_FILE)) return null;
  return JSON.parse(readFileSync(OWNER_FILE, 'utf8'));
}

function write(f: OwnerFile) {
  mkdirSync(dirname(OWNER_FILE), { recursive: true });
  writeFileSync(OWNER_FILE, JSON.stringify(f, null, 2));
}

const strip = ({ session: _s, ...rest }: Staff) => ({ ...rest, accepted: true });

/** Writes the owner's and deputy's sign-in details (never printed) */
export function saveOwners(w: World): void {
  if (!w.owner || !w.deputy) return;
  write({ owner: strip(w.owner), deputy: strip(w.deputy) });
}

export async function staffFlow(sim: Sim): Promise<void> {
  const { api, people, world: w, run } = sim;
  let file = load();
  // the links and pass codes the operator hands over, by email (pass codes are printed once, never stored)
  const invites = new Map<string, StaffInvite>();
  if (file && (!file.owner.accepted || !file.deputy.accepted)) {
    if (file.owner.accepted || file.deputy.accepted) run.fail({ step: 'owners', message: `Only one of the two Business Owners in ${OWNER_FILE} accepted the invitation; finish the other by hand` });
    // an earlier run stopped between the bootstrap and accepting: its pass codes went with that run, so the operator
    // prints new links and pass codes (npm run staff-link)
    for (const p of [file.owner, file.deputy]) invites.set(p.email, await operatorLink(sim, p.email));
  }
  if (!file) {
    const person = (firstName: string, lastName: string): Saved & { accepted: boolean } => ({
      firstName,
      lastName,
      email: `${firstName}.${lastName}.${sim.runId}@marketly.test`.toLowerCase(),
      password: `Mt-Hood-${crypto.randomUUID().slice(0, 12)}-Summit!`,
      phone: sim.phone(),
      accountId: '',
      roles: OWNER_ROLES,
      accepted: false,
    });
    file = { owner: person('Olivia', 'Hart'), deputy: person('Daniel', 'Reyes') };
    // in process: the bootstrap is an operator command with no API (the call tools/bootstrap-owner.ts makes; it
    // returns each person's link and pass code)
    const access = sim.app.kernel.boot.apis.get('access') as AccessService;
    try {
      const result = await access.bootstrapBusinessOwner({ email: file.owner.email, name: 'Olivia Hart', deputy: { email: file.deputy.email, name: 'Daniel Reyes' } });
      invites.set(file.owner.email, { link: result.acceptUrl, passCode: result.passCode });
      invites.set(file.deputy.email, { link: result.deputy!.acceptUrl, passCode: result.deputy!.passCode });
    } catch (err) {
      run.fail({ step: 'bootstrap Business Owner', message: `${(err as Error).message}. A Business Owner exists that the simulator has no sign-in for (${OWNER_FILE} is missing).` });
    }
    // written at once: if this run stops before the invitations are accepted, the next run knows who the owners
    // are and asks the operator for new links
    write(file);
    await sim.app.kernel.events.drain();
    run.pass();
  }
  const signInOrAccept = async (saved: Saved & { accepted: boolean }): Promise<Staff> => {
    if (saved.accepted) {
      // later runs: email and password
      const s: Staff = { firstName: saved.firstName, lastName: saved.lastName, email: saved.email, password: saved.password, phone: saved.phone, accountId: saved.accountId, roles: saved.roles, session: undefined as never };
      await people.staffSignIn(s);
      return s;
    }
    return people.acceptStaffInvitation(saved, OWNER_ROLES, invites.get(saved.email)!);
  };
  w.owner = await signInOrAccept(file.owner);
  write({ owner: { ...file.owner, ...strip(w.owner), accepted: true }, deputy: file.deputy });
  w.deputy = await signInOrAccept(file.deputy);
  saveOwners(w);
  const owner = w.owner;
  const deputy = w.deputy;
  const me = await api.call(owner.session, 'GET', '/api/admin/access/me');
  run.check('the owner holds the Business Owner role', JSON.stringify(me).includes('business_owner'), me);

  const roles = (await api.call(owner.session, 'GET', '/api/admin/access/roles')) as { id: string; key: string }[];
  for (const [i, t] of TEAM.entries()) {
    // owner and deputy take turns inviting; the other approves the sensitive grants
    const [inviter, other] = i % 2 === 0 ? [owner, deputy] : [deputy, owner];
    const person = sim.person('marketly.test', t.first, t.last);
    const roleIds = t.roles.map((k) => {
      const r = roles.find((x) => x.key === k);
      if (!r) run.fail({ step: 'roles', message: `role ${k} is not seeded` });
      return r!.id;
    });
    // granting roles is a sensitive action: the inviter confirms with the password (a re-auth token)
    const reauthToken = await people.reauth(inviter, 'role-grant');
    await api.call(inviter.session, 'POST', '/api/admin/access/staff-invitations', { email: person.email, name: `${t.first} ${t.last}`, roleIds, reason: `Simulated hire ${sim.runId}`, reauthToken });
    // a sensitive grant waits for the other Business Owner. Only the grant for this person: other requests waiting
    // for a decision are not the simulator's to approve
    const pending = await api.call(other.session, 'GET', '/api/admin/access/approval-requests?view=to_decide');
    for (const r of pending.items as { id: string; status: string; action: { key: string }; target: { label?: string } }[]) {
      if (r.action.key !== 'access.roles.sensitive-grant' || !JSON.stringify(r.target).includes(`${t.first} ${t.last}`)) continue;
      if (r.status !== 'pending' && r.status !== 'partially_approved') continue;
      await api.call(other.session, 'POST', `/api/admin/access/approval-requests/${r.id}/approve`, { note: 'Agreed: role for the new hire' });
    }
    // the Admin Center never shows the pass code: the operator prints a link and pass code for the new hire
    w.staff[t.key] = await people.acceptStaffInvitation(person, t.roles, await operatorLink(sim, person.email));
  }
  // each new member reaches their own area (the middleware asks access for the permission)
  const finance = w.staff.finance!;
  const today = new Date().toISOString().slice(0, 10);
  const overview = await api.call(finance.session, 'GET', `/api/admin/finance/overview?from=${today.slice(0, 8)}01&to=${today}`);
  run.check('finance sees the finance overview', overview !== null, overview);
  saveOwners(w);
}
