/**
 * Shared plumbing of the departments service: context, time, audit, optional data, media usages, slugs and small
 * validation helpers. The areas build on it (base → phones → blogs → companies → play → service).
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import { isValidSlug, replyAuthorName, slugOf } from '../domain/rules.js';
import type { DepartmentsRepository, SlugTable } from '../repository.js';

export interface DepartmentsServiceDeps {
  repo: DepartmentsRepository;
  ctx: ModuleContext<'departments'>;
}

/** Who acts: for audit entries */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
}

/** Business validation (the kernel's own schema message is 'Some fields are missing or invalid') */
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

export const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
export const unique = <T>(list: readonly T[]) => [...new Set(list)];
/** "staff:<id>": how updated_by / decided_by columns record an actor */
export const actorKey = (a: common.Actor) => `${a.kind}:${a.id ?? ''}`;

/** A picture as stored in a jsonb column: its media asset id */
export type StoredMedia = { id: string };
export const mediaOf = (v: unknown): StoredMedia | null => (v && typeof v === 'object' && typeof (v as StoredMedia).id === 'string' ? { id: (v as StoredMedia).id } : null);
export const mediaList = (v: unknown): StoredMedia[] => (Array.isArray(v) ? v.map(mediaOf).filter((m): m is StoredMedia => Boolean(m)) : []);

export class DepartmentsBase {
  constructor(protected readonly deps: DepartmentsServiceDeps) {}

  protected get repo() {
    return this.deps.repo;
  }
  protected get ctx() {
    return this.deps.ctx;
  }
  protected get media() {
    return this.ctx.use('media');
  }
  protected now() {
    return this.ctx.clock.now();
  }

  protected async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ category: 'content', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      this.ctx.log.warn({ err, action: entry.action }, 'departments: audit entry not recorded');
    }
  }

  /** An optional module's answer, or `fallback` when it is off or fails (the page still renders) */
  protected async soft<T>(what: string, call: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
    if (!call) return fallback;
    try {
      return await call();
    } catch (err) {
      this.ctx.log.debug({ err, what }, 'departments: optional data unavailable');
      return fallback;
    }
  }

  /**
   * How a customer is shown on reviews and rankings: first name and last initial ("Mina P."), else Customer. By the
   * customers-module id, falling back to the account id (the store principal's customerId is null without a record).
   */
  protected async customerName(customerId: string, accountId?: string | null): Promise<string> {
    const customers = this.ctx.tryUse('customers');
    if (!customers) return replyAuthorName(null);
    const byId = await this.soft('customers.getCustomer', typeof customers.getCustomer === 'function' ? () => customers.getCustomer(customerId) : undefined, null);
    const c = byId ?? (await this.soft('customers.getCustomerByUserId', () => customers.getCustomerByUserId(accountId ?? customerId), null));
    return replyAuthorName(c?.displayName);
  }

  /* ---------------------------------------------------------------- slugs */

  /** The slug a record is saved under: given or made from its name; SLUG_TAKEN when another record has it */
  protected async slugFor(table: SlugTable, given: string | null | undefined, from: string, exceptId?: string): Promise<string> {
    const slug = slugOf(given, from);
    if (!slug || !isValidSlug(slug)) throw invalid('slug', 'Use lowercase letters, digits and hyphens');
    if (await this.repo.slugTaken(table, slug, exceptId)) throw this.ctx.error('SLUG_TAKEN', `Another record already uses the slug ${slug}`);
    return slug;
  }

  /* ---------------------------------------------------------------- media */

  /** MediaRefs by asset id (refs from media; missing files are left out) */
  protected async refsMap(ids: (string | null | undefined)[], size: 'large' | 'thumb' = 'large'): Promise<Map<string, common.MediaRef>> {
    const list = unique(ids.filter((i): i is string => Boolean(i)));
    if (!list.length) return new Map();
    const refs = await this.soft('media.refs', () => this.media.refs(list, size), [] as common.MediaRef[]);
    return new Map(refs.map((r) => [r.id, r]));
  }

  /**
   * Makes the media usages of a record match the pictures it now shows: attaches new ones (platform-owned content
   * images), and after the save detaches the ones it no longer uses. Unknown files are a validation problem.
   */
  protected async syncMedia(refId: string, refLabel: string, before: StoredMedia[], after: { id: string; path: string }[]) {
    const usage = { module: 'departments', kind: 'content_block' as const, refId };
    const prev = new Set(before.map((m) => m.id));
    const attached: string[] = [];
    try {
      for (const f of after) {
        if (prev.has(f.id) || attached.includes(f.id)) continue;
        try {
          await this.media.attach(f.id, { ...usage, refLabel }, { kind: 'platform' });
        } catch (err) {
          if (isAppError(err) && err.code === 'NOT_FOUND') throw invalid(f.path, 'File not found; upload it again');
          if (isAppError(err) && err.code === 'ASSET_NOT_OWNED') throw invalid(f.path, 'Use a picture uploaded for store content');
          throw err;
        }
        attached.push(f.id);
      }
    } catch (err) {
      for (const id of attached) await this.media.detach(id, usage).catch(() => {});
      throw err;
    }
    const next = new Set(after.map((f) => f.id));
    return {
      /** after the record is saved: detach pictures it no longer uses */
      commit: async () => {
        for (const id of prev) {
          if (next.has(id)) continue;
          await this.media.detach(id, usage).catch((err) => this.ctx.log.warn({ err, assetId: id }, 'departments: could not detach a file'));
        }
      },
      /** the save failed: drop what was attached */
      undo: async () => {
        for (const id of attached) await this.media.detach(id, usage).catch(() => {});
      },
    };
  }

  /** Detaches every picture of a deleted record */
  protected async detachAll(refId: string, files: StoredMedia[]) {
    for (const f of files) await this.media.detach(f.id, { module: 'departments', kind: 'content_block', refId }).catch((err) => this.ctx.log.warn({ err, assetId: f.id }, 'departments: could not detach a file'));
  }

  /** Saves a write with its pictures: attach first, run `save`, then detach what is gone (or undo on failure) */
  protected async withMedia<T>(refId: string, refLabel: string, before: StoredMedia[], after: { id: string; path: string }[], save: () => Promise<T>): Promise<T> {
    const media = await this.syncMedia(refId, refLabel, before, after);
    let out: T;
    try {
      out = await save();
    } catch (err) {
      await media.undo();
      throw err;
    }
    await media.commit();
    return out;
  }
}
