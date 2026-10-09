/** Shared setup for the settings behaviour tests: an app with access and audit stubbed and a movable clock. */
import type { FastifyInstance } from 'fastify';
import { fixedClock } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type { SettingsPublicApi } from '../../../spec/settings.js';
import { auth, buildTestApp, callers } from '../../../testing/app.js';

export interface Harness {
  app: FastifyInstance;
  clock: ReturnType<typeof fixedClock>;
  /** What access.check answers next */
  access: { decision: access.AuthorityCheck['decision']; requests: access.RequestApprovalInput[]; cancelled: { requestId: string; reason: string }[]; lastRequestId: string | null };
  audits: audit.RecordInput[];
  events: { name: string; payload: any }[];
  api: SettingsPublicApi;
}

const PUBLISHED = ['settings.change.submitted', 'settings.change.scheduled', 'settings.change.cancelled', 'settings.setting.changed', 'settings.feature_flag.changed'];

export async function harness(): Promise<Harness> {
  const clock = fixedClock(new Date());
  const h = {
    clock,
    access: { decision: 'approval_required' as access.AuthorityCheck['decision'], requests: [] as access.RequestApprovalInput[], cancelled: [] as { requestId: string; reason: string }[], lastRequestId: null as string | null },
    audits: [] as audit.RecordInput[],
    events: [] as { name: string; payload: any }[],
  };
  const app = await buildTestApp({
    // modules whose settings these tests change must be running (settings of other modules are unavailable)
    only: ['settings', 'audit', 'identity', 'catalog', 'returns', 'orders', 'shipping', 'notifications', 'checkout', 'support', 'promotions', 'finance'],
    clock,
    config: { rateLimits: false },
    apiStubs: {
      access: {
        check: async (_p, action) => ({
          decision: h.access.decision,
          action,
          reason: h.access.decision === 'allowed' ? 'You hold this authority' : h.access.decision === 'denied' ? 'Your role cannot apply setting changes' : 'Needs approval',
          requiresSecondReviewer: false,
          approvalsNeeded: h.access.decision === 'allowed' ? 0 : 1,
          eligibleApproverRoles: [],
          eligibleApprovers: [],
        }),
        requestApproval: async (input) => {
          h.access.requests.push(input);
          const id = newId();
          h.access.lastRequestId = id;
          return { id, ref: 'AP-261009-0001', target: input.target, summary: input.summary, status: 'pending' } as unknown as access.ApprovalRequest;
        },
        cancelApproval: async (requestId, _by, reason) => {
          h.access.cancelled.push({ requestId, reason });
        },
      },
      audit: {
        record: async (entry) => {
          h.audits.push(entry);
          return newId();
        },
      },
    },
  });
  for (const name of PUBLISHED) app.kernel.events.subscribe('test', name, (e) => void h.events.push({ name, payload: e.payload }));
  return { ...h, app, api: app.kernel.boot.apis.get('settings') as SettingsPublicApi };
}

export const staff = (permissions?: string[]) => auth(callers.staff(permissions));

/** ISO time `minutes` from the harness clock */
export const inMinutes = (h: Harness, minutes: number) => new Date(h.clock.now().getTime() + minutes * 60_000).toISOString();
export const inDays = (h: Harness, days: number) => inMinutes(h, days * 1440);

export async function draft(h: Harness, payload: { items: { key: string; value: unknown }[]; effectiveAt: string; applyScope?: string; reason?: string }) {
  const res = await h.app.inject({ method: 'POST', url: '/api/admin/settings/changes', headers: staff(), payload: { applyScope: 'new_only', reason: 'Test change', ...payload } });
  return res;
}

export async function submit(h: Harness, id: string) {
  const res = await h.app.inject({ method: 'POST', url: `/api/admin/settings/changes/${id}/submit`, headers: staff() });
  await h.app.kernel.events.drain();
  return res;
}

export const decided = (h: Harness, change: { id: string; ref: string }, outcome: 'approved' | 'rejected' | 'cancelled' | 'expired', requestId = h.access.lastRequestId!) =>
  h.app.kernel.events.publish('access', 'access.approval.decided', {
    requestId,
    ref: 'AP-261009-0001',
    actionKey: 'settings.changes.apply',
    module: 'settings',
    target: { type: 'setting_change', id: change.id, ref: change.ref },
    outcome,
    decidedBy: { kind: 'staff', id: newId(), name: 'Bea Owner' },
    reason: outcome === 'approved' ? null : 'Not now',
    approverIds: [],
    requestedById: newId(),
  });
