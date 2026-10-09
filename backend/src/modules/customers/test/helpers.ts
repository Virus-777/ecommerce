/** Test helpers for customers: boot, capture events, register customers through identity's event, call over HTTP. */
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import type { BuildOptions } from '../../../app.js';
import { devClaims, type DevKind, type DevOptions } from '../../../kernel/auth/dev.js';
import { devSigner, signAccessToken } from '../../../kernel/auth/tokens.js';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import { fixedClock } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import { spec } from '../../../spec/customers.js';
import { auth, buildTestApp, ISSUER, TEST_JWK } from '../../../testing/app.js';
import type { CustomersService } from '../service.js';

export type Clock = ReturnType<typeof fixedClock>;

export const STORE = '/api/store/customers';
export const ADMIN = '/api/admin/customers';
export const PUBLIC = '/api/public/customers';

export interface Res {
  status: number;
  body: any;
}

export interface TestCustomer {
  accountId: string;
  customerId: string;
  email: string;
  /** A store token signed at the test clock's current time */
  readonly token: string;
}

export interface Kit {
  app: FastifyInstance;
  clock: Clock;
  events: EventEnvelope[];
  of(name: string): any[];
  service: CustomersService;
  call(method: string, url: string, o?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<Res>;
  /** Publish another module's event and wait for the consumers */
  publish(source: string, name: string, payload: unknown, actor?: unknown): Promise<void>;
  /** A registered customer (identity.user.registered) */
  customer(o?: { firstName?: string; lastName?: string; email?: string; marketingOptIn?: boolean }): Promise<TestCustomer>;
  /** Dev tokens signed at the test clock's time (the clock moves in tests) */
  token(kind: DevKind, o?: DevOptions, over?: Record<string, unknown>): string;
  staff(permissions?: string[]): string;
  visitor(sid?: string): { sid: string; token: string };
  /** Wait for event deliveries started by direct service calls */
  drain(): Promise<void>;
}

let n = 0;
export const uniqueEmail = (p = 'shopper') => `${p}.${Date.now().toString(36)}${(n++).toString(36)}@example.com`;

export const address = (o: Record<string, unknown> = {}) => ({
  name: 'Ana Lopez',
  line1: '123 Main Street',
  line2: null,
  city: 'Portland',
  region: 'OR',
  postalCode: '97201',
  country: 'US',
  phone: null,
  ...o,
});

const signer = devSigner({ jwk: TEST_JWK });

export async function boot(opts: BuildOptions & { only?: string[] } = {}): Promise<Kit> {
  const clock = fixedClock(new Date());
  const app = await buildTestApp({ clock, ...opts, only: ['customers', ...(opts.only ?? [])], config: { rateLimits: false, ...opts.config } });
  const events: EventEnvelope[] = [];
  const bus = app.kernel.events;
  for (const name of Object.keys(spec.events.publishes)) bus.subscribe('test', name, (e) => void events.push(e));
  const token = (kind: DevKind, o: DevOptions = {}, over: Record<string, unknown> = {}) => {
    const claims = { ...devClaims(kind, o), ...over };
    if ('authAt' in claims) claims.authAt = Math.floor(clock.now().getTime() / 1000);
    if ('twoStepAt' in claims) claims.twoStepAt = Math.floor(clock.now().getTime() / 1000);
    return signAccessToken(signer, claims, { issuer: ISSUER, now: clock.now() });
  };
  const kit: Kit = {
    app,
    clock,
    events,
    of: (name) => events.filter((e) => e.name === name).map((e) => e.payload),
    service: app.kernel.boot.apis.get('customers') as CustomersService,
    async call(method, url, o = {}) {
      const res = await app.inject({ method: method as never, url, headers: { ...(o.token ? auth(o.token) : {}), ...o.headers }, ...(o.body !== undefined ? { payload: o.body as never } : {}) });
      await bus.drain();
      let body: any = res.body;
      try {
        body = res.body ? JSON.parse(res.body) : null;
      } catch {
        /* not JSON */
      }
      return { status: res.statusCode, body };
    },
    async publish(source, name, payload, actor) {
      bus.publish(source, name, payload, actor ? { actor: actor as never } : {});
      await bus.drain();
    },
    async customer(o = {}) {
      const accountId = newId();
      const email = o.email ?? uniqueEmail();
      await kit.publish('identity', 'identity.user.registered', {
        accountId,
        email,
        firstName: o.firstName ?? 'Ana',
        lastName: o.lastName ?? 'Lopez',
        marketingOptIn: o.marketingOptIn ?? false,
        acceptedTermsVersion: '2026-01',
        guestSessionId: null,
        at: clock.now().toISOString(),
      });
      const snap = await kit.service.getCustomerByUserId(accountId);
      expect(snap, 'customer created from identity.user.registered').toBeTruthy();
      return {
        accountId,
        customerId: snap!.id,
        email,
        get token() {
          return token('customer', { accountId });
        },
      };
    },
    token,
    staff: (permissions) => token('staff', { permissions }),
    visitor(sid = newId()) {
      return { sid, token: token('visitor', {}, { sid }) };
    },
    drain: () => bus.drain(),
  };
  return kit;
}
