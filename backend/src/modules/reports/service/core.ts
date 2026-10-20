/** Shared plumbing of the reports use cases: settings, time, callers, permissions, staff names, audit. */
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type { Actor } from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type { StaffRef } from '../../../spec/reports.js';
import { GROUPS, UNASSIGNED_OWNER } from '../domain/catalogue.js';
import type { Issue } from '../domain/rules.js';
import type { ReportsRepository } from '../repository.js';

export interface ReportsServiceDeps {
  repo: ReportsRepository;
  ctx: ModuleContext<'reports'>;
}

/** Who is acting: the verified caller, the actor for audit and events, and the permission check of the request */
export interface Caller {
  principal: identity.Principal & { name?: string | null };
  actor: Actor;
  requestId?: string;
  /** The request's permission check (dev-token permissions included); in-process callers have none */
  can?: (permission: string) => Promise<boolean>;
}

export interface Settings {
  currency: string;
  timeZone: string;
  defaultBasis: 'placement' | 'payment' | 'shipment' | 'completion';
  taxIncluded: boolean;
  maxRangeDays: number;
  exportLinkHours: number;
  maxExportRows: number;
  readModelMaxLagMinutes: number;
  launchMetrics: string[];
  exportDatasets: { key: string; owner: string; permission: string; audience: 'staff' | 'seller'; screens: string[]; phase: number }[];
}

export type OptionalDep = Parameters<ModuleContext<'reports'>['tryUse']>[0];

export const invalid = (issues: Issue[], message = issues[0]?.message ?? 'Check the highlighted fields') => new AppError('VALIDATION_FAILED', message, { issues });
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);

export class ReportsCore {
  constructor(readonly deps: ReportsServiceDeps) {}

  get ctx() {
    return this.deps.ctx;
  }
  get repo() {
    return this.deps.repo;
  }
  now(): Date {
    return this.ctx.clock.now();
  }

  async cfg(): Promise<Settings> {
    const s = this.ctx.settings;
    const [defaultBasis, taxIncluded, maxRangeDays, exportLinkHours, maxExportRows, readModelMaxLagMinutes, launchMetrics, exportDatasets] = await Promise.all([
      s.get('defaultDateBasis'),
      s.get('taxIncluded'),
      s.get('maxRangeDays'),
      s.get('exportLinkHours'),
      s.get('maxExportRows'),
      s.get('readModelMaxLagMinutes'),
      s.get('launchMetrics'),
      s.get('exportDatasets'),
    ]);
    const basis = ['placement', 'payment', 'shipment', 'completion'].includes(defaultBasis) ? (defaultBasis as Settings['defaultBasis']) : 'placement';
    return {
      // the market's, from the server environment like every module (MARKET_CURRENCY, MARKET_TIME_ZONE)
      currency: this.ctx.config.market.currency,
      timeZone: this.ctx.config.market.timeZone,
      defaultBasis: basis,
      taxIncluded: Boolean(taxIncluded),
      maxRangeDays: Number(maxRangeDays) || 400,
      exportLinkHours: Number(exportLinkHours) || 24,
      maxExportRows: Number(maxExportRows) || 500_000,
      readModelMaxLagMinutes: Number(readModelMaxLagMinutes) || 15,
      launchMetrics: Array.isArray(launchMetrics) ? (launchMetrics as string[]) : [],
      exportDatasets: (Array.isArray(exportDatasets) ? exportDatasets : []) as Settings['exportDatasets'],
    };
  }

  /** Today in market time */
  async today(): Promise<string> {
    return dateInZone(this.now(), (await this.cfg()).timeZone);
  }

  /** A module's public API when it runs in this process */
  api<D extends OptionalDep>(m: D) {
    return this.ctx.tryUse(m);
  }

  /** Whether a module runs in this process */
  running(m: string): boolean {
    return (this.ctx.modules as readonly string[]).includes(m);
  }

  /** Calls another module where a missing answer only removes a figure: undefined when it is off, unbuilt or failing */
  async soft<T>(what: string, fn: () => Promise<T> | undefined): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err }, `reports: ${what} unavailable`);
      return undefined;
    }
  }

  /**
   * A permission of a caller: this request's own check when reports serves the request, else ctx.can for a
   * principal handed over in-process (another module's export endpoint): the same answer that caller's
   * request got. Fails closed.
   */
  async principalCan(principal: identity.Principal, permission: string, can?: (p: string) => Promise<boolean>): Promise<boolean> {
    if (can) return can(permission);
    try {
      // spec Principal and the kernel's differ only in the audience the kernel adds
      return await this.ctx.can(principal as Parameters<ModuleContext<'reports'>['can']>[0], permission);
    } catch (err) {
      this.ctx.log.warn({ err, permission }, 'reports: permission check failed');
      return false;
    }
  }

  /** Staff names and role labels for owner, suggester and decider columns (access.getStaffRef), batched per call */
  async staffRefs(ids: (string | null | undefined)[], roleFor: (id: string) => string = () => 'Reports Analyst'): Promise<Map<string, StaffRef>> {
    const out = new Map<string, StaffRef>();
    const access = this.api('access');
    await Promise.all(
      [...new Set(ids.filter((x): x is string => Boolean(x)))].map(async (id) => {
        if (id === UNASSIGNED_OWNER) {
          const role = roleFor(id);
          out.set(id, { staffId: id, name: `${role} (no person named yet)`, role });
          return;
        }
        const ref = access ? await this.soft('access.getStaffRef', () => access.getStaffRef(id)) : undefined;
        out.set(id, { staffId: id, name: ref?.name ?? 'Staff member', role: ref?.roleLabel ?? (ref ? 'Staff' : 'Staff') });
      }),
    );
    return out;
  }

  groupRole(group: string): string {
    return GROUPS.find((g) => g.key === group)?.ownerRole ?? 'Reports Analyst';
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: { actor: Actor; requestId?: string | null }) {
    const api = this.api('audit');
    if (!api) return;
    try {
      await api.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      // the change is committed; a missing audit entry is logged, never turned into a failed request
      this.ctx.log[isNotImplemented(err) ? 'debug' : 'error']({ err, action: entry.action }, 'audit entry not recorded');
    }
  }
}

export const SYSTEM: Actor = { kind: 'system' };
