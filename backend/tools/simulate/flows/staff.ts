/**
 * Flow 1, staff: the Business Owner and a deputy, then the team every later flow works with, each invited from
 * the Admin Center with a fresh authenticator code and signed in through their own invitation.
 *
 * The first run creates the owner and the deputy with the bootstrap (an operator command, not an API: the same
 * call tools/bootstrap-owner.ts makes) and keeps their sign-in details in .data/simulate-owner.json (gitignored).
 * Later runs sign in as them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccessService } from '../../../src/modules/access/service.js';
import type { Person, Staff } from '../people.js';
import type { Sim, World } from '../sim.js';

export const OWNER_FILE = fileURLToPath(new URL('../../../.data/simulate-owner.json', import.meta.url));

type Saved = Omit<Staff, 'session'>;

/** The team: who does what in the later flows, and the roles access seeds for it (access/domain/seed.ts) */
const TEAM: { key: keyof World['staff']; first: string; last: string; roles: string[] }[] = [
  { key: 'seller', first: 'Sam', last: 'Okafor', roles: ['seller_manager'] },
  { key: 'catalog', first: 'Cara', last: 'Lindqvist', roles: ['catalog_manager'] },
  { key: 'orders', first: 'Omar', last: 'Haddad', roles: ['order_manager', 'shipping_manager', 'returns_manager'] },
  { key: 'support', first: 'Avery', last: 'Brooks', roles: ['support_agent'] },
  { key: 'marketing', first: 'Mia', last: 'Moreno', roles: ['marketing_manager'] },
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

/** Writes the owner's and deputy's sign-in details (never printed); keeps the last authenticator step used */
export function saveOwners(w: World): void {
  if (!w.owner || !w.deputy) return;
  write({ owner: strip(w.owner), deputy: strip(w.deputy) });
}

/**
 * The owners of an earlier run that stopped between the bootstrap and accepting the invitations: the invitation
 * emails went with that run's process, and nobody can sign in yet to send them again. Only here a development
 * token is used (DEV_TOKENS, development only; its step-up code is the fixed 000000), standing in for a Platform
 * Administrator: it resends each invitation. When no email arrives, it revokes the stuck invitations and role
 * assignments so the bootstrap can run again with new owners. Returns what it did.
 */
async function recoverOwners(sim: Sim, file: OwnerFile): Promise<'resent' | 'reset'> {
  const { api, run, people } = sim;
  const dev = sim.devToken('staff', 'resend the invitations of owners whose invitation emails were lost when an earlier run stopped before accepting them');
  const invitations: { id: string; email: string; accountId: string | null }[] = [];
  for (const status of ['pending', 'expired']) invitations.push(...(await api.call(dev, 'GET', `/api/admin/identity/invitations?status=${status}&limit=100`)).items);
  const stuck = [file.owner, file.deputy].map((p) => ({ p, inv: invitations.find((i) => i.email.toLowerCase() === p.email.toLowerCase()) }));
  const missing = stuck.find((s) => !s.inv);
  if (missing) run.fail({ step: 'recover owner invitations', message: `${missing.p.email} has no open invitation and ${OWNER_FILE} has no sign-in for them; delete the file only if no Business Owner exists` });
  let emailed = true;
  for (const { p, inv } of stuck) {
    await api.call(dev, 'POST', `/api/admin/identity/invitations/${inv!.id}/resend`, undefined, { headers: { 'x-step-up-code': '000000' } });
    if ((await people.peekMailbox(p.email, /#token=([\w.~-]+)/)) === undefined) emailed = false;
  }
  if (emailed) return 'resent';
  // the resend sent nothing (notifications skips it as a duplicate of the first invitation email: see the report)
  console.log('  the resent invitations were not emailed; revoking them so the bootstrap can run again');
  sim.devTokenPlaces.push(`${run.current.name}: staff dev token to revoke the stuck owner invitations and role assignments, because a resent invitation is not emailed`);
  for (const { inv } of stuck) {
    await api.call(dev, 'POST', `/api/admin/identity/invitations/${inv!.id}/revoke`, { reason: 'Simulator: invitation email lost; owners bootstrapped again' }, { headers: { 'x-step-up-code': '000000' } });
    if (!inv!.accountId) continue;
    const member = await api.call(dev, 'GET', `/api/admin/access/members/${inv!.accountId}`);
    for (const a of member.assignments as { id: string; status: string }[]) {
      if (a.status === 'pending_acceptance' || a.status === 'pending_approval') await api.call(dev, 'POST', `/api/admin/access/role-assignments/${a.id}/revoke`, { reason: 'Simulator: invitation email lost; owners bootstrapped again' });
    }
  }
  return 'reset';
}

export async function staffFlow(sim: Sim): Promise<void> {
  const { api, people, world: w, run } = sim;
  let file = load();
  if (file && (!file.owner.accepted || !file.deputy.accepted)) {
    if (file.owner.accepted || file.deputy.accepted) run.fail({ step: 'owners', message: `Only one of the two Business Owners in ${OWNER_FILE} accepted the invitation; finish the other by hand` });
    if ((await recoverOwners(sim, file)) === 'reset') file = null;
  }
  if (!file) {
    const person = (firstName: string, lastName: string): Saved & { accepted: boolean } => ({
      firstName,
      lastName,
      email: `${firstName}.${lastName}.${sim.runId}@marketly.test`.toLowerCase(),
      password: `Mt-Hood-${crypto.randomUUID().slice(0, 12)}-Summit!`,
      phone: sim.phone(),
      accountId: '',
      totpKey: '',
      lastStep: null,
      roles: OWNER_ROLES,
      accepted: false,
    });
    file = { owner: person('Olivia', 'Hart'), deputy: person('Daniel', 'Reyes') };
    // in process: the bootstrap is an operator command with no API (the call tools/bootstrap-owner.ts makes)
    const access = sim.app.kernel.boot.apis.get('access') as AccessService;
    try {
      await access.bootstrapBusinessOwner({ email: file.owner.email, name: 'Olivia Hart', deputy: { email: file.deputy.email, name: 'Daniel Reyes' } });
    } catch (err) {
      run.fail({ step: 'bootstrap Business Owner', message: `${(err as Error).message}. A Business Owner exists that the simulator has no sign-in for (${OWNER_FILE} is missing).` });
    }
    // written at once: if this run stops before the invitations are accepted, the next run knows who the owners
    // are and asks for their invitations again
    write(file);
    await sim.app.kernel.events.drain();
    run.pass();
  }
  const signInOrAccept = async (saved: Saved & { accepted: boolean }): Promise<Staff> => {
    if (saved.accepted) {
      // later runs: password + authenticator
      const s: Staff = { ...saved, session: undefined as never };
      await people.staffSignIn(s);
      return s;
    }
    // the invitation emails of the bootstrap (or of the recovery) are in this run's mailbox
    return people.acceptStaffInvitation(saved, OWNER_ROLES);
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
    // owner and deputy take turns: each Business Owner gets one authenticator code per 30 seconds
    const [inviter, other] = i % 2 === 0 ? [owner, deputy] : [deputy, owner];
    const person = sim.person('marketly.test', t.first, t.last);
    const roleIds = t.roles.map((k) => {
      const r = roles.find((x) => x.key === k);
      if (!r) run.fail({ step: 'roles', message: `role ${k} is not seeded` });
      return r!.id;
    });
    await api.call(inviter.session, 'POST', '/api/admin/access/staff-invitations', { email: person.email, name: `${t.first} ${t.last}`, roleIds, reason: `Simulated hire ${sim.runId}` }, { headers: { 'x-step-up-code': await people.code(inviter) } });
    // a sensitive grant waits for the other Business Owner. Only the grant for this person: other requests waiting
    // for a decision are not the simulator's to approve
    const pending = await api.call(other.session, 'GET', '/api/admin/access/approval-requests?view=to_decide');
    for (const r of pending.items as { id: string; status: string; action: { key: string }; target: { label?: string } }[]) {
      if (r.action.key !== 'access.roles.sensitive-grant' || !JSON.stringify(r.target).includes(`${t.first} ${t.last}`)) continue;
      if (r.status !== 'pending' && r.status !== 'partially_approved') continue;
      await api.call(other.session, 'POST', `/api/admin/access/approval-requests/${r.id}/approve`, { note: 'Agreed: role for the new hire' });
    }
    w.staff[t.key] = await people.acceptStaffInvitation(person, t.roles);
  }
  // each new member reaches their own area (the middleware asks access for the permission)
  const finance = w.staff.finance!;
  const today = new Date().toISOString().slice(0, 10);
  const overview = await api.call(finance.session, 'GET', `/api/admin/finance/overview?from=${today.slice(0, 8)}01&to=${today}`);
  run.check('finance sees the finance overview', overview !== null, overview);
  saveOwners(w);
}
