/**
 * Test harness for software: the module with real media (memory storage, development processor) and real payments
 * (the development card processor), and the answers a test controls stubbed: customers (the customer id equals the
 * account id; names from `k.names`), audit.record → recorded. Files are uploaded through the media admin API.
 */
import type { FastifyInstance } from 'fastify';
import { newId } from '../../../kernel/lib/ids.js';
import type * as audit from '../../../spec/audit.js';
import { auth, buildTestApp, callers, movingClock, tokenClock } from '../../../testing/app.js';
import { pngIcon, zipFile } from '../../../../tools/simulate/software-data.js';

export { auth, callers, newId };

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export interface Kit {
  app: FastifyInstance;
  clock: ReturnType<typeof movingClock>;
  names: Map<string, string>;
  audits: audit.RecordInput[];
  events: { name: string; payload: any }[];
  staff(permissions?: string[]): Record<string, string>;
  customer(accountId: string): Record<string, string>;
  call(method: Method, url: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  admin(method: Method, path: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  store(method: Method, path: string, payload?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  /** Uploads a file as staff and runs media processing; answers the asset id */
  upload(purpose: 'content_image' | 'software_package', fileName: string, contentType: string, body: Buffer): Promise<string>;
  icon(): Promise<string>;
  pkg(name?: string): Promise<string>;
  /** A published app with an icon and a package */
  makeApp(over?: Record<string, unknown>): Promise<any>;
  category(name?: string): Promise<any>;
  run(job: string): Promise<void>;
  named(name: string): any[];
}

export const usd = (amount: number) => ({ amount, currency: 'USD' });

export async function boot(): Promise<Kit> {
  const clock = movingClock();
  tokenClock.now = () => clock.now();
  tokenClock.ttlSeconds = 3600;
  const k = { clock, names: new Map<string, string>(), audits: [] as audit.RecordInput[], events: [] as { name: string; payload: any }[] };
  const customer = (id: string) => ({ id, userId: id, ref: 'CU-1', displayName: k.names.get(id) ?? 'Sam Rivera', email: `${id.slice(0, 8)}@example.com`, accountStatus: 'active', canOrder: true, canMessage: true }) as never;
  const app = await buildTestApp({
    only: ['software', 'media', 'payments'],
    clock,
    config: { launchPhase: 4 },
    apiStubs: {
      customers: {
        getCustomerByUserId: async (id: string) => customer(id),
        getCustomer: async (id: string) => customer(id),
        searchCustomers: async (f: { search?: string }) => ({ items: [...k.names.keys()].filter((id) => f.search && `${id.slice(0, 8)}@example.com` === f.search).map(customer), nextCursor: null }) as never,
      },
      audit: {
        record: async (entry) => {
          k.audits.push(entry);
          return newId();
        },
      },
    },
  });
  for (const name of ['software.purchase.paid', 'software.purchase.failed', 'payments.purchase.authorized', 'payments.purchase.failed', 'payments.purchase.captured', 'payments.purchase.voided']) {
    app.kernel.events.subscribe('test', name, (e) => void k.events.push({ name: e.name, payload: e.payload }));
  }
  const staffId = newId();
  const staff = (permissions?: string[]) => auth(callers.staff(permissions, { sub: staffId } as never));
  const call: Kit['call'] = async (method, url, payload, headers) => {
    const res = await app.inject({ method, url, headers: { 'idempotency-key': newId(), ...(headers ?? staff()) }, ...(payload !== undefined ? { payload: payload as never } : {}) });
    await app.kernel.events.drain();
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  const admin: Kit['admin'] = (method, path, payload, headers) => call(method, `/api/admin/software${path}`, payload, headers ?? staff());
  const upload: Kit['upload'] = async (purpose, fileName, contentType, body) => {
    const t = await call('POST', '/api/admin/media/uploads', { upload: { purpose, fileName, contentType, sizeBytes: body.length }, ownerKind: 'platform' });
    if (t.status !== 201) throw new Error(`upload: ${t.status} ${JSON.stringify(t.body)}`);
    const put = await app.inject({ method: 'PUT', url: new URL(t.body.url).pathname, headers: { ...staff(), 'content-type': contentType }, payload: body });
    if (put.statusCode !== 204) throw new Error(`upload content: ${put.statusCode} ${put.body}`);
    const done = await call('POST', `/api/admin/media/uploads/${t.body.uploadId}/complete`);
    if (done.status !== 202) throw new Error(`complete: ${done.status} ${JSON.stringify(done.body)}`);
    await app.kernel.jobs.runNow('media.process');
    return t.body.assetId as string;
  };
  let seq = 0;
  let defaultCategory: any = null;
  const kit: Kit = Object.assign(k, {
    app,
    staff,
    customer: (accountId: string) => auth(callers.customer({ accountId })),
    call,
    admin,
    store: (method: Method, path: string, payload?: unknown, headers?: Record<string, string>) => call(method, `/api/store/software${path}`, payload, headers ?? auth(callers.visitor())),
    upload,
    icon: () => upload('content_image', `icon-${++seq}.png`, 'image/png', pngIcon(seq, 512)),
    pkg: (name?: string) => upload('software_package', name ?? `App-${++seq}.zip`, 'application/zip', zipFile('Test app', name ?? 'app.zip')),
    async category(name?: string) {
      const res = await admin('POST', '/categories', { name: name ?? `Category ${++seq}`, icon: 'wrench' });
      if (res.status !== 201) throw new Error(`category: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    },
    async makeApp(over: Record<string, unknown> = {}) {
      defaultCategory ??= await kit.category('Utilities');
      const res = await admin('POST', '/apps', {
        title: `App ${++seq}`,
        company: { name: 'Northlight Labs' },
        categoryId: defaultCategory.id,
        brief: 'Does one thing well',
        description: 'A sample app.',
        free: true,
        platforms: ['windows', 'android'],
        iconId: await kit.icon(),
        packageId: await kit.pkg(),
        status: 'published',
        ...over,
      });
      if (res.status !== 201) throw new Error(`app: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    },
    async run(job: string) {
      await app.kernel.jobs.runNow(job);
      await app.kernel.events.drain();
    },
    named: (name: string) => k.events.filter((e) => e.name === name).map((e) => e.payload),
  });
  return kit;
}
