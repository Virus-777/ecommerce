/** Data export through every enabled module's exportCustomerData hook (FORMAT.md, Customer data export hook), and filters whose source module is off. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type * as common from '../../../spec/common.js';
import { unzip } from '../domain/zip.js';
import { ADMIN, boot, STORE, type Kit } from './helpers.js';

const PHOTO = newId();
const GONE = newId();
const world = {
  reviewsBroken: false,
  hookCalls: [] as { module: string; input: unknown }[],
  stored: [] as Buffer[],
};

async function bytesOf(stream: ReadableStream): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

let kit: Kit;
beforeAll(async () => {
  kit = await boot({
    only: ['media', 'messaging', 'reviews'],
    apiStubs: {
      media: {
        storeGeneratedFile: async (input) => {
          world.stored.push(await bytesOf(input.body));
          return { id: newId(), fileName: input.fileName } as never;
        },
        readFile: async (id, owner) => {
          if (id !== PHOTO) throw new AppError('NOT_FOUND', 'File not found');
          if (owner?.kind !== 'customer') throw new Error('expected the customer as owner');
          return { fileName: 'Broken lamp.JPG', contentType: 'image/jpeg', sizeBytes: 4, body: new Uint8Array([1, 2, 3, 4]) };
        },
      },
      messaging: {
        exportCustomerData: async (input) => {
          world.hookCalls.push({ module: 'messaging', input });
          return [{ key: 'messages', title: 'Messages', module: 'messaging', records: [{ conversation: 'Casa Verde Home', body: 'Is it in stock?' }], attachmentIds: [PHOTO, GONE] }] satisfies common.CustomerDataSection[];
        },
      },
      reviews: {
        exportCustomerData: async (input) => {
          world.hookCalls.push({ module: 'reviews', input });
          if (world.reviewsBroken) throw new Error('reviews database unavailable');
          return [{ key: 'reviews', title: 'Reviews', module: 'reviews', records: [{ rating: 5, body: 'Lovely lamp' }] }];
        },
      },
    },
  });
});
afterAll(() => kit.app.close());

describe('data export hooks', () => {
  it('writes each enabled module section and the customer attachments into the ZIP', async () => {
    const c = await kit.customer();
    await kit.call('POST', `${STORE}/data-requests/exports`, { token: c.token });
    world.stored = [];
    world.hookCalls = [];
    expect(await kit.service.buildDataExports()).toMatchObject({ built: 1, failed: 0 });
    expect(world.hookCalls).toEqual([
      { module: 'messaging', input: { customerId: c.customerId, accountId: c.accountId } },
      { module: 'reviews', input: { customerId: c.customerId, accountId: c.accountId } },
    ]);
    const files = new Map(unzip(world.stored[0]!).map((e) => [e.name, e.data]));
    expect(JSON.parse(files.get('messages.json')!.toString())).toEqual([{ conversation: 'Casa Verde Home', body: 'Is it in stock?' }]);
    expect(JSON.parse(files.get('reviews.json')!.toString())).toEqual([{ rating: 5, body: 'Lovely lamp' }]);
    const photo = [...files.keys()].find((n) => n.startsWith('attachments/messages/'));
    expect(photo).toMatch(/broken-lamp\.JPG$/);
    expect([...files.get(photo!)!]).toEqual([1, 2, 3, 4]);
    // the consent log covers the personalisation switches too (ConsentRecord.channel)
    const consent = JSON.parse(files.get('consent-log.json')!.toString()) as { channel: string }[];
    expect(consent.map((x) => x.channel)).toEqual(expect.arrayContaining(['email', 'personalization', 'recent_searches']));
    const readme = JSON.parse(files.get('README.json')!.toString());
    expect(readme.sections).toEqual([
      { file: 'orders.json', title: 'Orders', module: 'orders' }, // orders declares the export hook (pass 4)
      { file: 'messages.json', title: 'Messages', module: 'messaging' },
      { file: 'reviews.json', title: 'Reviews', module: 'reviews' },
    ]);
    expect(readme.files).toEqual(expect.arrayContaining(['messages.json', 'reviews.json', photo]));
    // modules declaring the hook that are off, and attachments no longer there, are listed
    expect(readme.notIncluded).toEqual(expect.arrayContaining(['wishlist', expect.stringContaining(GONE)]));
  });

  it('a module whose hook throws fails the export (retried), never silently left out', async () => {
    const c = await kit.customer();
    const r = (await kit.call('POST', `${STORE}/data-requests/exports`, { token: c.token })).body;
    world.reviewsBroken = true;
    expect(await kit.service.buildDataExports()).toMatchObject({ built: 0, failed: 1 });
    world.reviewsBroken = false;
    const failed = (await kit.service.dataRequestsOf(c.customerId, null)).find((x) => x.id === r.id);
    expect(failed).toMatchObject({ state: 'failed' });
  });
});

describe('customer list filters with their source module off', () => {
  it('hasOpenCases / hasAbuseReports are refused (VALIDATION_FAILED, details.unavailable) rather than ignored', async () => {
    const res = await kit.call('GET', `${ADMIN}/customers?hasOpenCases=true&hasAbuseReports=false`, { token: kit.staff(['customers.accounts.view']) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { unavailable: ['support', 'trust'] } });
    expect((await kit.call('GET', `${ADMIN}/customers`, { token: kit.staff(['customers.accounts.view']) })).status).toBe(200);
  });
});
