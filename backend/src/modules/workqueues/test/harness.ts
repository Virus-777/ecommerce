/**
 * Test harness: workqueues booted with access, identity, audit, settings, notifications and reports.
 * access is the real module with its staff answers stubbed from a small in-memory directory (who
 * holds which role, leads, backups, away), so tests control routing; audit.record, notifications.notify
 * and reports (not built yet) requestExport/registerDataset are stubbed to capture calls.
 * Events of modules that are not built are published on the bus with payloads matching their spec.
 */
import type { FastifyInstance } from 'fastify';
import { devClaims } from '../../../kernel/auth/dev.js';
import { fixedClock } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import { withDependencies } from '../../../kernel/module-system/loader.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type * as notifications from '../../../spec/notifications.js';
import type * as reports from '../../../spec/reports.js';
import { ExportJob } from '../../../spec/reports.js';
import { validSample } from '../../../testing/samples.js';
import { auth, buildTestApp, token } from '../../../testing/app.js';
import type { WorkqueuesService } from '../service.js';

export interface Person {
  id: string;
  name: string;
  roles: string[];
  away: boolean;
  label: string | null;
  permissions: string[];
}

let n = 0;
const uniq = () => `${(++n).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class World {
  readonly people = new Map<string, Person>();
  readonly leads = new Map<string, string>();
  readonly backups = new Map<string, string[]>();
  readonly audits: audit.RecordInput[] = [];
  readonly notices: notifications.NotifyInput[] = [];
  readonly exports: { dataset: string; filters: unknown; format: string }[] = [];
  readonly datasets: reports.ExportDataset[] = [];

  /** A staff member holding roles (permissions for in-process checks: default every permission but view-all) */
  person(name: string, roles: string[] = [], o: Partial<Person> = {}): Person {
    const p: Person = { id: newId(), name: `${name} ${uniq()}`, roles, away: false, label: roles[0] ? roles[0].replace(/_/g, ' ') : null, permissions: ['*'], ...o };
    this.people.set(p.id, p);
    return p;
  }

  /** Seat a lead and backups for a role */
  cover(role: string, lead: Person, ...backups: Person[]) {
    for (const p of [lead, ...backups]) if (!p.roles.includes(role)) p.roles.push(role);
    this.leads.set(role, lead.id);
    this.backups.set(role, backups.map((b) => b.id));
  }

  ref(p: Person): access.StaffRef {
    return { accountId: p.id, name: p.name, email: null, away: p.away, roleLabel: p.label };
  }

  resolve(roleKey: string): access.RecipientResolution {
    const lead = this.leads.get(roleKey);
    const leadP = lead ? this.people.get(lead) : undefined;
    if (leadP && !leadP.away) return { roleKey, leadAccountId: lead, accountIds: [lead!], ccAccountIds: [], viaBackup: false };
    const backups = (this.backups.get(roleKey) ?? []).filter((b) => !this.people.get(b)?.away);
    if (backups.length) return { roleKey, leadAccountId: lead ?? null, accountIds: backups, ccAccountIds: lead ? [lead] : [], viaBackup: true };
    const holders = [...this.people.values()].filter((p) => p.roles.includes(roleKey) && !p.away).map((p) => p.id);
    return { roleKey, leadAccountId: lead ?? null, accountIds: holders, ccAccountIds: [], viaBackup: false };
  }

  coverage(): access.RoleCoverage[] {
    return [...this.leads.keys()].map((key) => {
      const lead = this.people.get(this.leads.get(key)!)!;
      const backups = (this.backups.get(key) ?? []).map((b) => this.people.get(b)!);
      const r = this.resolve(key);
      return {
        role: { id: newId(), key, name: key.replace(/_/g, ' ') },
        workArea: 'operations',
        lead: this.ref(lead),
        backups: backups.map((b) => this.ref(b)),
        receivingNow: r.accountIds.map((id) => this.ref(this.people.get(id)!)),
        viaBackup: r.viaBackup,
        leadAwayUntil: null,
        escalationRole: null,
      };
    });
  }

  stubs() {
    return {
      access: {
        getStaffRef: async (id: string) => (this.people.get(id) ? this.ref(this.people.get(id)!) : null),
        rolesOf: async (id: string) => (this.people.get(id)?.roles ?? []).map((key) => ({ id: newId(), key, name: key })),
        membersOfRole: async (key: string) => [...this.people.values()].filter((p) => p.roles.includes(key)).map((p) => this.ref(p)),
        resolveRecipients: async (key: string) => this.resolve(key),
        coverageNow: async () => this.coverage(),
        hasPermission: async (p: { accountId?: string | null }, perm: string) => {
          const who = p.accountId ? this.people.get(p.accountId) : undefined;
          return Boolean(who && (who.permissions.includes(perm) || (who.permissions.includes('*') && perm !== 'workqueues.items.view-all')));
        },
      },
      audit: {
        record: async (e: audit.RecordInput) => {
          this.audits.push(e);
          return newId();
        },
      },
      notifications: {
        notify: async (input: notifications.NotifyInput) => {
          this.notices.push(input);
          return { noticeIds: [], deliveryIds: [] };
        },
      },
      reports: {
        registerDataset: async (d: reports.ExportDataset) => {
          this.datasets.push(d);
        },
        requestExport: async (input: { dataset: string; filters: unknown; format: string }) => {
          this.exports.push({ dataset: input.dataset, filters: input.filters, format: input.format });
          return { ...(validSample(ExportJob).value as reports.ExportJob), id: newId(), dataset: input.dataset, filters: input.filters ?? {} };
        },
      },
    };
  }
}

export const MODULES = withDependencies(['workqueues', 'access', 'identity', 'audit', 'settings', 'notifications', 'reports']);

export async function boot(opts: { clock?: ReturnType<typeof fixedClock> } = {}) {
  const world = new World();
  const clock = opts.clock ?? fixedClock(new Date());
  const app: FastifyInstance = await buildTestApp({ modules: MODULES, clock, config: { launchPhase: 4, rateLimits: false }, apiStubs: world.stubs() as never });
  const service = app.kernel.boot.apis.get('workqueues') as WorkqueuesService;
  return { app, world, clock, service };
}

/** Long-lived dev tokens (tests move the clock forward) */
const TTL = 30 * 86_400;
export const as = {
  staff: (p: { id: string }, permissions?: string[]) => auth(token(devClaims('staff', { accountId: p.id, permissions }), TTL)),
  seller: (sellerId: string) => auth(token(devClaims('seller', { sellerId }), TTL)),
};

export function capture(app: FastifyInstance, ...names: string[]) {
  const seen: { name: string; payload: any }[] = [];
  for (const name of names) app.kernel.events.subscribe('test', name, (e) => void seen.push({ name: e.name, payload: e.payload }));
  return seen;
}

export async function publish(app: FastifyInstance, name: string, payload: unknown) {
  app.kernel.events.publish(name.split('.')[0]!, name, payload);
  await app.kernel.events.drain();
}

export const money = (amount: number) => ({ amount, currency: 'USD' });
export const H = 3_600_000;
export const MIN = 60_000;
export { newId };
