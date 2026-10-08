/**
 * Test fixture for the access module: access + identity (stubbed: an in-memory staff directory) +
 * audit (stubbed: records entries), a movable clock, captured events and helpers that seat staff
 * members in roles directly in the database.
 */
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Clock } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import { auth, buildTestApp, callers } from '../../../testing/app.js';
import type { AccessDb } from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type * as identity from '../../../spec/identity.js';
import type { AccessService } from '../service.js';

export interface Fixture {
  app: FastifyInstance;
  svc: AccessService;
  db: Kysely<AccessDb>;
  clock: Clock & { advance(ms: number): void; reset(): void };
  accounts: Map<string, identity.AccountSummary>;
  invitations: { email: string; name: string }[];
  audits: audit.RecordInput[];
  events: { name: string; payload: any }[];
  /** Seats a new staff member in these system roles (active assignments) */
  staff(name: string, roleKeys: string[], status?: identity.AccountSummary['status']): Promise<string>;
  principal(accountId: string): identity.Principal;
  /** Dev token for the staff member (default: every permission at the middleware) */
  token(accountId: string, permissions?: string[]): string;
  call(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, token: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  roleId(key: string): Promise<string>;
  eventsNamed(name: string): any[];
  drain(): Promise<void>;
  close(): Promise<void>;
}

const ACCESS_EVENTS = [
  'access.approval.requested',
  'access.approval.partially_approved',
  'access.approval.returned',
  'access.approval.decided',
  'access.approval.reminder_sent',
  'access.role.changed',
  'access.limits.changed',
  'access.coverage.changed',
  'access.away.started',
  'access.away.ended',
];

export const STEP_UP_CODE = '123456';

export async function accessFixture(): Promise<Fixture> {
  let offset = 0;
  const clock = {
    now: () => new Date(Date.now() + offset),
    advance: (ms: number) => {
      offset += ms;
    },
    reset: () => {
      offset = 0;
    },
  };
  const accounts = new Map<string, identity.AccountSummary>();
  const invitations: { email: string; name: string }[] = [];
  const audits: audit.RecordInput[] = [];
  const app = await buildTestApp({
    modules: ['access', 'identity', 'audit'],
    clock,
    config: { rateLimits: false },
    apiStubs: {
      identity: {
        getAccount: async (id: string) => accounts.get(id) ?? null,
        getAccounts: async (ids: string[]) => ids.map((id) => accounts.get(id)).filter((a): a is identity.AccountSummary => Boolean(a)),
        findAccountByEmail: async (email: string, realm: 'member' | 'staff') => [...accounts.values()].find((a) => a.email === email && a.realm === realm) ?? null,
        inviteStaff: async (input: { email: string; name: string; invitedBy: any }) => {
          const id = newId();
          accounts.set(id, { id, realm: 'staff', email: input.email, displayName: input.name, status: 'invited', emailVerified: false, twoStepEnabled: false });
          invitations.push({ email: input.email, name: input.name });
          const now = clock.now().toISOString();
          return { id: newId(), realm: 'staff', purpose: 'staff', email: input.email, name: input.name, status: 'pending', invitedBy: input.invitedBy, sentAt: now, expiresAt: now, accountId: id } as identity.Invitation;
        },
        verifyStepUp: async (_id: string, proof: { code?: string }) => proof.code === STEP_UP_CODE,
      },
      audit: {
        record: async (entry: audit.RecordInput) => {
          audits.push(entry);
          return newId();
        },
      },
    },
  });
  const svc = app.kernel.boot.apis.get('access') as AccessService;
  const db = app.kernel.database.kysely.withSchema('access') as Kysely<AccessDb>;
  const events: { name: string; payload: any }[] = [];
  for (const name of ACCESS_EVENTS) app.kernel.events.subscribe('test', name, (e) => void events.push({ name, payload: e.payload }));

  const roleId = async (key: string) => {
    await svc.syncRegistry();
    return (await db.selectFrom('roles').select('id').where('key', '=', key).executeTakeFirstOrThrow()).id;
  };
  let n = 0;
  const f: Fixture = {
    app,
    svc,
    db,
    clock,
    accounts,
    invitations,
    audits,
    events,
    async staff(name, roleKeys, status = 'active') {
      const id = newId();
      accounts.set(id, { id, realm: 'staff', email: `staff${++n}.${id.slice(-6)}@marketly.test`, displayName: name, status, emailVerified: true, twoStepEnabled: true });
      for (const key of roleKeys) {
        await db
          .insertInto('role_assignments')
          .values({ id: newId(), account_id: id, role_id: await roleId(key), status: 'active', granted_by_kind: 'system', granted_by_id: 'test', reason: 'test', granted_at: new Date(clock.now().getTime() - 1000), expires_at: null, revoked_at: null, revoked_by: null, revoke_reason: null, approval_request_id: null })
          .execute();
      }
      return id;
    },
    principal: (accountId) => ({ kind: 'staff', accountId, sessionId: newId(), twoStepVerifiedAt: new Date().toISOString() }),
    token: (accountId, permissions) => callers.staff(permissions ?? ['*'], { sub: accountId }),
    async call(method, url, token, payload, headers = {}) {
      // endpoints with stepUp: code take the development step-up code at the middleware
      const stepUp = /^\/(role-assignments|staff-invitations|roles\/[^/]+\/permissions)$/.test(url) ? { 'x-step-up-code': '000000' } : {};
      const res = await app.inject({ method, url: `/api/admin/access${url}`, headers: { ...auth(token), ...stepUp, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
      return { status: res.statusCode, body: res.body ? res.json() : null };
    },
    roleId,
    eventsNamed: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
    drain: () => app.kernel.events.drain(),
    close: () => app.close(),
  };
  await svc.syncRegistry();
  return f;
}

export const usd = (dollars: number) => ({ amount: Math.round(dollars * 100), currency: 'USD' });
