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
import type { ReportsRepository } from '../ports.js';

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
    const [currency, timeZone, defaultBasis, taxIncluded, maxRangeDays, exportLinkHours, maxExportRows, readModelMaxLagMinutes, launchMetrics, exportDatasets] = await Promise.all([
      s.get('reportingCurrency'),
      s.get('reportingTimeZone'),
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
      currency: currency || this.ctx.config.market.currency,
      timeZone: timeZone || this.ctx.config.market.timeZone,
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

  /** A permission of a caller outside a request: the request check when given, else access (staff) or member access (sellers). Fails closed. */
  async principalCan(principal: identity.Principal, permission: string, can?: (p: string) => Promise<boolean>): Promise<boolean> {
    if (can) return can(permission);
    if (principal.kind === 'staff') {
      const access = this.api('access');
      if (!access) return false;
      return (await this.soft('access.hasPermission', () => access.hasPermission(principal, permission))) ?? false;
    }
    if (principal.kind === 'seller' && principal.sellerId && principal.accountId) {
      const sellers = this.api('sellers');
      if (!sellers) return false;
      const m = await this.soft('sellers.getMemberAccess', () => sellers.getMemberAccess(principal.sellerId!, principal.accountId!));
      return Boolean(m && (m.isOwner || m.permissions.includes(permission)));
    }
    return false;
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
      if (!isNotImplemented(err)) throw err;
    }
  }
}

export const SYSTEM: Actor = { kind: 'system' };
