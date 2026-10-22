/**
 * Shared plumbing of the services service: context, time and the market zone, audit, optional data, media usages,
 * slugs and validation helpers. The parts build on it (base → catalog → requests → service).
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import { isValidSlug, slugOf } from '../domain/rules.js';
import type { ServicesRepository } from '../repository.js';

export interface ServicesServiceDeps {
  repo: ServicesRepository;
  ctx: ModuleContext<'services'>;
}

/** Who acts: for audit entries, history and events */
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
/** "staff:<id>": how history and updated_by record an actor */
export const actorKey = (a: common.Actor) => `${a.kind}:${a.id ?? ''}`;

/** A picture as stored in a jsonb column: its media asset id */
export type StoredMedia = { id: string };
export const mediaOf = (v: unknown): StoredMedia | null => (v && typeof v === 'object' && typeof (v as StoredMedia).id === 'string' ? { id: (v as StoredMedia).id } : null);
export const mediaList = (v: unknown): StoredMedia[] => (Array.isArray(v) ? v.map(mediaOf).filter((m): m is StoredMedia => Boolean(m)) : []);
export const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export class ServicesBase {
  constructor(protected readonly deps: ServicesServiceDeps) {}

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
  /** The market's time zone (config) */
  protected get tz(): string {
    return this.ctx.config.market.timeZone || 'America/Los_Angeles';
  }
  protected get currency(): string {
    return this.ctx.config.market.currency || 'USD';
  }
  /** Today's calendar day in a zone (the market's by default) */
  protected today(tz = this.tz): string {
    return dateInZone(this.now(), tz);
  }

  protected async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ category: 'content', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      this.ctx.log.warn({ err, action: entry.action }, 'services: audit entry not recorded');
    }
  }

  /** An optional module's answer, or `fallback` when it is off or fails */
  protected async soft<T>(what: string, call: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
    if (!call) return fallback;
    try {
      return await call();
    } catch (err) {
      this.ctx.log.debug({ err, what }, 'services: optional data unavailable');
      return fallback;
    }
  }

  /** The slug a provider or service is saved under; SLUG_TAKEN when another record has it */
  protected async slugFor(table: 'providers' | 'services', given: string | null | undefined, from: string, exceptId?: string): Promise<string> {
    const slug = slugOf(given, from);
    if (!slug || !isValidSlug(slug)) throw invalid('slug', 'Use lowercase letters, digits and hyphens');
    if (await this.repo.slugTaken(table, slug, exceptId)) throw this.ctx.error('SLUG_TAKEN', `Another record already uses the slug ${slug}`);
    return slug;
  }

  /* ---------------------------------------------------------------- media */

  /** MediaRefs by asset id (missing files are left out) */
  protected async refsMap(ids: (string | null | undefined)[], size: 'large' | 'thumb' = 'large'): Promise<Map<string, common.MediaRef>> {
    const list = unique(ids.filter((i): i is string => Boolean(i)));
    if (!list.length) return new Map();
    const refs = await this.soft('media.refs', () => this.media.refs(list, size), [] as common.MediaRef[]);
    return new Map(refs.map((r) => [r.id, r]));
  }

  /** Saves a write with its pictures: attaches new ones, runs `save`, then detaches the ones no longer used (or undoes) */
  protected async withMedia<T>(refId: string, refLabel: string, before: StoredMedia[], after: { id: string; path: string }[], save: () => Promise<T>): Promise<T> {
    const usage = { module: 'services', kind: 'content_block' as const, refId };
    const prev = new Set(before.map((m) => m.id));
    const attached: string[] = [];
    const undo = async () => {
      for (const id of attached) await this.media.detach(id, usage).catch(() => {});
    };
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
    const next = new Set(after.map((f) => f.id));
    for (const id of prev) {
      if (next.has(id)) continue;
      await this.media.detach(id, usage).catch((err) => this.ctx.log.warn({ err, assetId: id }, 'services: could not detach a file'));
    }
    return out;
  }

  protected async detachAll(refId: string, files: StoredMedia[]) {
    for (const f of files) await this.media.detach(f.id, { module: 'services', kind: 'content_block', refId }).catch((err) => this.ctx.log.warn({ err, assetId: f.id }, 'services: could not detach a file'));
  }
}
