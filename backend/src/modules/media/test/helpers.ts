/** Test helpers for the media module: an app with media (and a stubbed audit), file fixtures, an upload helper. */
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { fixedClock } from '../../../kernel/lib/clock.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { EventEnvelope } from '../../../kernel/events/index.js';
import type * as audit from '../../../spec/audit.js';
import type { MediaAsset, UploadRequest, UploadTicket } from '../../../spec/media.js';
import { auth, buildTestApp, callers } from '../../../testing/app.js';
import type { DevProcessor } from '../infra/processing/dev.js';
import type { MemoryStorage } from '../infra/storage/memory.js';
import type { MediaService } from '../service.js';

export { auth, callers };

export interface MediaTestApp {
  app: FastifyInstance;
  media: MediaService;
  storage: MemoryStorage;
  processor: DevProcessor;
  clock: ReturnType<typeof fixedClock>;
  audits: audit.RecordInput[];
  events: EventEnvelope[];
  eventsNamed(name: string): EventEnvelope[];
}

/** media plus audit, whose record/historyOf are stubbed (audit is built in another tranche) */
export async function mediaApp(): Promise<MediaTestApp> {
  const clock = fixedClock(new Date());
  const audits: audit.RecordInput[] = [];
  const app = await buildTestApp({
    only: ['media', 'audit'],
    clock,
    config: { rateLimits: false },
    apiStubs: {
      audit: {
        record: async (entry) => {
          audits.push(entry);
          return newId();
        },
        historyOf: async (targetType, targetId) =>
          audits
            .filter((a) => a.target.type === targetType && a.target.id === targetId)
            .map((a, i) => ({
              id: newId(),
              seq: i + 1,
              at: clock.now().toISOString(),
              actor: a.actor,
              actorRoles: [],
              action: a.action,
              actionLabel: a.actionLabel,
              module: a.module,
              category: a.category,
              target: a.target,
              relatedTargets: [],
              reason: a.reason ?? null,
              change: {} as never,
              evidence: [],
              approval: {} as never,
              visibleToSeller: Boolean(a.visibleToSeller),
            })),
      },
    },
  });
  const media = app.kernel.boot.apis.get('media') as MediaService;
  const events: EventEnvelope[] = [];
  for (const name of ['media.asset.ready', 'media.asset.rejected', 'media.asset.removed', 'media.asset.restored', 'media.asset.deleted']) {
    app.kernel.events.subscribe('test', name, (e) => void events.push(e));
  }
  return {
    app,
    media,
    storage: media.providers.storage as MemoryStorage,
    processor: media.providers.processor as DevProcessor,
    clock,
    audits,
    events,
    eventsNamed: (name) => events.filter((e) => e.name === name),
  };
}

/* ------------------------------------------------------------------ fixtures */

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const chunk = (type: string, data: Buffer) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);

/** A PNG header with the given size (and a text chunk that metadata stripping removes) */
export function png(width: number, height: number, opts: { alpha?: boolean; seed?: string } = {}): Buffer {
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, opts.alpha ? 6 : 2, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`Comment\0secret-location ${opts.seed ?? ''}`, 'latin1')),
    chunk('IDAT', Buffer.from(opts.seed ?? 'pixels', 'latin1')),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A JPEG with an EXIF segment (orientation and a GPS marker) and a frame header */
export function jpeg(width: number, height: number, opts: { orientation?: number } = {}): Buffer {
  const tiff = Buffer.concat([
    Buffer.from('MM\0*', 'latin1'),
    u32(8),
    Buffer.from([0, 1]), // one IFD entry
    Buffer.from([0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0, opts.orientation ?? 1, 0, 0]),
    u32(0),
    Buffer.from('GPSLatitude 47.6062 N', 'latin1'),
  ]);
  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(app1Body.length + 2) >> 8, (app1Body.length + 2) & 0xff]), app1Body]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0x56, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, sos]);
}

/** An MP4 header with a movie duration */
export function mp4(seconds: number): Buffer {
  const ftyp = Buffer.concat([u32(20), Buffer.from('ftypisom', 'latin1'), u32(0x200), Buffer.from('isom', 'latin1')]);
  const mvhdBody = Buffer.concat([Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(1000), u32(seconds * 1000), Buffer.alloc(80)]);
  const mvhd = Buffer.concat([u32(mvhdBody.length + 8), Buffer.from('mvhd', 'latin1'), mvhdBody]);
  const moov = Buffer.concat([u32(mvhd.length + 8), Buffer.from('moov', 'latin1'), mvhd]);
  return Buffer.concat([ftyp, moov]);
}

export function pdf(pages: number): Buffer {
  const objs = Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join('\n');
  return Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count ${pages} >> endobj\n${objs}\n%%EOF\n`, 'latin1');
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/* ------------------------------------------------------------------ uploading */

export type Area = 'store' | 'seller' | 'admin';

export async function startUpload(t: MediaTestApp, area: Area, token: string, req: Partial<UploadRequest> & { purpose: UploadRequest['purpose'] }, extra: Record<string, unknown> = {}) {
  const body = { fileName: 'photo.png', contentType: 'image/png', sizeBytes: 100, ...req };
  return t.app.inject({ method: 'POST', url: `/api/${area}/media/uploads`, headers: auth(token), payload: area === 'admin' ? { upload: body, ...extra } : body });
}

/**
 * What a client does with a development ticket: PUT the bytes to ticket.url (this API's
 * /api/{area}/media/uploads/{id}/content) with the ticket's headers and the caller's own token.
 */
export function putContent(t: MediaTestApp, ticket: Pick<UploadTicket, 'url' | 'headers'>, token: string, body: Buffer, headers: Record<string, string> = {}) {
  const u = new URL(ticket.url);
  return t.app.inject({ method: 'PUT', url: u.pathname + u.search, headers: { ...ticket.headers, ...auth(token), ...headers }, payload: body });
}

/**
 * The whole client flow: start, PUT the bytes to the ticket URL, complete, and (by default) run the
 * processing worker. Returns the ticket and the asset as the owner sees it afterwards.
 */
export async function uploadFile(
  t: MediaTestApp,
  area: Area,
  token: string,
  file: { purpose: UploadRequest['purpose']; fileName?: string; contentType?: string; body: Buffer; sha256?: string; alt?: string },
  opts: { process?: boolean; ownerKind?: 'platform' | 'staff' } = {},
): Promise<{ ticket: UploadTicket; asset: MediaAsset }> {
  const contentType = file.contentType ?? 'image/png';
  const res = await startUpload(
    t,
    area,
    token,
    { purpose: file.purpose, fileName: file.fileName ?? 'photo.png', contentType, sizeBytes: file.body.length, sha256: file.sha256, alt: file.alt },
    opts.ownerKind ? { ownerKind: opts.ownerKind } : {},
  );
  if (res.statusCode !== 201) throw new Error(`upload start failed: ${res.statusCode} ${res.body}`);
  const ticket = res.json() as UploadTicket;
  const put = await putContent(t, ticket, token, file.body);
  if (put.statusCode !== 204) throw new Error(`upload content failed: ${put.statusCode} ${put.body}`);
  const done = await t.app.inject({ method: 'POST', url: `/api/${area}/media/uploads/${ticket.uploadId}/complete`, headers: auth(token) });
  if (done.statusCode !== 202) throw new Error(`complete failed: ${done.statusCode} ${done.body}`);
  if (opts.process !== false) await t.app.kernel.jobs.runNow('media.process');
  await t.app.kernel.events.drain();
  return { ticket, asset: (await t.media.getAsset(ticket.assetId))! };
}
