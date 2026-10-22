/**
 * Shared plumbing of the software service: context, time, audit, optional data, who the signed-in customer is,
 * pictures (icons and screenshots: content_image uploads) and files (packages and databases: software_package
 * uploads), and validation helpers. The parts build on it (base → catalog → purchases → service).
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type { MediaAsset } from '../../../spec/media.js';
import type { AppFile } from '../../../spec/software.js';
import { sizeLabel } from '../domain/rules.js';
import type { StoredFile } from '../ports.js';
import type { SoftwareRepository } from '../repository.js';

export interface SoftwareServiceDeps {
  repo: SoftwareRepository;
  ctx: ModuleContext<'software'>;
}

/** Who acts: for audit entries and events */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
}

export const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const requireText = (value: string | null | undefined, path: string, max: number, message = 'This field is required') => {
  const v = value?.trim();
  if (!v) throw invalid(path, message);
  if (v.length > max) throw invalid(path, `Use at most ${max} characters`);
  return v;
};
/** Optional text: trimmed, null when blank, at most `max` characters */
export const optionalText = (value: string | null | undefined, path: string, max: number) => {
  const v = value?.trim();
  if (!v) return null;
  if (v.length > max) throw invalid(path, `Use at most ${max} characters`);
  return v;
};
/** A list of short texts: trimmed, blanks dropped, at most `count` of at most `max` characters */
export const textList = (list: readonly string[] | null | undefined, path: string, count: number, max: number): string[] => {
  const out = (list ?? []).map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
  if (out.length > count) throw invalid(path, `Use at most ${count} items`);
  out.forEach((s, i) => {
    if (s.length > max) throw invalid(`${path}[${i}]`, `Use at most ${max} characters`);
  });
  return out;
};

export const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
export const unique = <T>(list: readonly T[]) => [...new Set(list)];
export const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** "staff:<id>": how updated_by and granted_by record an actor */
export const actorKey = (a: common.Actor) => `${a.kind}:${a.id ?? ''}`;

/** A stored file (apps.package, apps.databases) */
export const fileOf = (v: unknown): StoredFile | null => {
  const f = v as StoredFile | null;
  return f && typeof f === 'object' && typeof f.id === 'string' ? { id: f.id, kind: f.kind === 'database' ? 'database' : 'package', name: String(f.name ?? ''), sizeBytes: Number(f.sizeBytes ?? 0), uploadedAt: f.uploadedAt ?? null } : null;
};
export const filesOf = (v: unknown): StoredFile[] => (Array.isArray(v) ? v.map(fileOf).filter((f): f is StoredFile => Boolean(f)) : []);
export const appFileOut = (f: StoredFile): AppFile => ({ id: f.id, kind: f.kind, name: f.name, sizeBytes: f.sizeBytes, sizeLabel: sizeLabel(f.sizeBytes), uploadedAt: f.uploadedAt });

const PLATFORM_OWNER = { kind: 'platform' as const };

export class SoftwareBase {
  constructor(protected readonly deps: SoftwareServiceDeps) {}

  protected get repo() {
    return this.deps.repo;
  }
  protected get ctx() {
    return this.deps.ctx;
  }
  protected get media() {
    return this.ctx.use('media');
  }
  protected get payments() {
    return this.ctx.use('payments');
  }
  protected now() {
    return this.ctx.clock.now();
  }
  /** The market's time zone (config) */
  protected get tz(): string {
    return this.ctx.config.market.timeZone || 'America/Los_Angeles';
  }
  protected get currency(): string {
    return this.ctx.config.market.currency || 'USD';
  }

  protected async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ category: 'content', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      this.ctx.log.warn({ err, action: entry.action }, 'software: audit entry not recorded');
    }
  }

  /** An optional module's answer, or `fallback` when it is off or fails */
  protected async soft<T>(what: string, call: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
    if (!call) return fallback;
    try {
      return await call();
    } catch (err) {
      this.ctx.log.debug({ err, what }, 'software: optional data unavailable');
      return fallback;
    }
  }

  /**
   * The customers-module id of the signed-in customer on a visitor endpoint (owned, canReview): customers'
   * getCustomerByUserId, the account id while customers is off; null for visitors.
   */
  async viewerOf(principal: Principal | null | undefined): Promise<string | null> {
    if (principal?.kind !== 'customer' || !principal.accountId) return null;
    const customers = this.ctx.tryUse('customers');
    if (!customers) return principal.accountId;
    const c = await this.soft('customers.getCustomerByUserId', () => customers.getCustomerByUserId(principal.accountId!), null);
    return c?.id ?? null;
  }

  /** "Dana R." for a review: customers' name (first name and last initial), else Customer */
  protected async customerName(customerId: string): Promise<string | null> {
    const customers = this.ctx.tryUse('customers');
    const c = customers ? await this.soft('customers.getCustomer', () => customers.getCustomer(customerId), null) : null;
    return c?.displayName ?? null;
  }

  /* ---------------------------------------------------------------- pictures */

  /** MediaRefs by asset id (missing files are left out) */
  protected async refsMap(ids: (string | null | undefined)[], size: 'large' | 'medium' | 'thumb' = 'large'): Promise<Map<string, common.MediaRef>> {
    const list = unique(ids.filter((i): i is string => Boolean(i)));
    if (!list.length) return new Map();
    const refs = await this.soft('media.refs', () => this.media.refs(list, size), [] as common.MediaRef[]);
    return new Map(refs.map((r) => [r.id, r]));
  }

  /**
   * Saves a write with its files: attaches the new ones (pictures as content_block, packages and databases as
   * software_file), runs `save`, then detaches the files no longer used (or undoes the attachments when it fails).
   */
  protected async withFiles<T>(refId: string, refLabel: string, before: { id: string; usage: 'content_block' | 'software_file' }[], after: { id: string; usage: 'content_block' | 'software_file'; path: string }[], save: () => Promise<T>): Promise<T> {
    const usageOf = (kind: 'content_block' | 'software_file') => ({ module: 'software', kind, refId });
    const key = (f: { id: string; usage: string }) => `${f.usage}:${f.id}`;
    const prev = new Set(before.map(key));
    const attached: { id: string; usage: 'content_block' | 'software_file' }[] = [];
    const undo = async () => {
      for (const f of attached) await this.media.detach(f.id, usageOf(f.usage)).catch(() => {});
    };
    try {
      for (const f of after) {
        if (prev.has(key(f)) || attached.some((a) => key(a) === key(f))) continue;
        try {
          await this.media.attach(f.id, { ...usageOf(f.usage), refLabel }, PLATFORM_OWNER);
        } catch (err) {
          if (isAppError(err) && err.code === 'NOT_FOUND') throw invalid(f.path, 'File not found; upload it again');
          if (isAppError(err) && err.code === 'ASSET_NOT_OWNED') throw invalid(f.path, 'Use a file uploaded in the Admin Center');
          if (isAppError(err) && (err.code === 'VALIDATION_FAILED' || err.code === 'ILLEGAL_TRANSITION')) throw this.ctx.error('FILE_NOT_READY', f.usage === 'software_file' ? 'Upload the file again as a software package and wait until it is ready.' : 'Upload the picture again as a content image and wait until it is ready.', { path: f.path, assetId: f.id });
          throw err;
        }
        attached.push({ id: f.id, usage: f.usage });
      }
    } catch (err) {
      await undo();
      throw err;
    }
    let out: T;
    try {
      out = await save();
    } catch (err) {
      await undo();
      throw err;
    }
    const next = new Set(after.map(key));
    for (const f of before) {
      if (next.has(key(f))) continue;
      await this.media.detach(f.id, usageOf(f.usage)).catch((err) => this.ctx.log.warn({ err, assetId: f.id }, 'software: could not detach a file'));
    }
    return out;
  }

  protected async detachAll(refId: string, files: { id: string; usage: 'content_block' | 'software_file' }[]) {
    for (const f of files) await this.media.detach(f.id, { module: 'software', kind: f.usage, refId }).catch((err) => this.ctx.log.warn({ err, assetId: f.id }, 'software: could not detach a file'));
  }

  /**
   * A software_package upload as an app file: it must exist and have the purpose (FILE_NOT_READY otherwise); its
   * name and size come from media. A file still processing is attached (media waits for it) before it is used.
   */
  protected async packageFile(assetId: string, kind: 'package' | 'database', path: string): Promise<StoredFile> {
    const asset: MediaAsset | null = await this.media.getAsset(assetId);
    if (!asset || ['deleted', 'expired', 'removed'].includes(asset.status)) throw invalid(path, 'File not found; upload it again');
    if (asset.purpose !== 'software_package' || asset.status === 'rejected' || asset.status === 'pending_upload') {
      throw this.ctx.error('FILE_NOT_READY', asset.purpose !== 'software_package' ? 'Upload app files as software packages.' : asset.status === 'rejected' ? `The file was rejected: ${asset.rejectionReason ?? 'it could not be processed'}.` : 'The file has not finished uploading.', { path, assetId });
    }
    return { id: asset.id, kind, name: asset.fileName, sizeBytes: asset.sizeBytes, uploadedAt: asset.readyAt ?? asset.createdAt };
  }
}
