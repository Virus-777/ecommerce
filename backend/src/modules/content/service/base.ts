/**
 * Shared plumbing of the content service: context, time, audit, the publication log, owners,
 * media usages, settings and small validation helpers. The use cases build on it
 * (base → tiles → pages → homepage → help → policies → service).
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { SYSTEM_ACTOR } from '../../../kernel/auth/index.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type { LinkRef, OwnerRef, Schedule, Version } from '../../../spec/content.js';
import type { UsageInput } from '../../../spec/media.js';
import { isSafeUrl, isValidTimeZone, scheduleLabel } from '../domain/rules.js';
import type { VersionRow } from '../ports.js';
import type { ContentRepository } from '../repository.js';

export interface ContentServiceDeps {
  repo: ContentRepository;
  ctx: ModuleContext<'content'>;
}

/** Who acts: for events, audit entries, the publication log and approvals */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
}

export const SYSTEM: By = { actor: SYSTEM_ACTOR };

/** Business validation (the kernel's own schema message is 'Some fields are missing or invalid') */
export const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }] });
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const requireText = (value: string | null | undefined, path: string, message = 'This field is required') => {
  const v = value?.trim();
  if (!v) throw invalid(path, message);
  return v;
};

export const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
export const dateOrNull = (s: string | null | undefined): Date | null => (s ? new Date(s) : null);
export const unique = <T>(list: readonly T[]) => [...new Set(list)];

/** "staff:<id>" — how updated_by / created_by columns record an actor */
export const actorKey = (a: common.Actor) => `${a.kind}:${a.id ?? ''}`;
export const actorFromKey = (key: string | null | undefined): common.Actor => {
  const [kind, id] = String(key ?? 'system:').split(':') as [common.Actor['kind'], string | undefined];
  return { kind: kind || 'system', id: id || null };
};

/** Snapshot meta for a draft under review when the item itself is already live */
export interface DraftReview {
  state: 'in_review' | 'approved';
  by?: common.Actor | null;
  at?: string | null;
}

export type SettingsShape = { page: boolean; section: boolean; article: boolean };

/** Homepage cache: resolved homepages per device, rebuilt by content.cache-warm and dropped on any change */
export interface HomeCache {
  entries: Map<string, { builtAt: number; validUntil: number; value: unknown }>;
}

export class ContentBase {
  protected readonly homeCache: HomeCache = { entries: new Map() };

  constructor(protected readonly deps: ContentServiceDeps) {}

  protected get repo() {
    return this.deps.repo;
  }
  protected get ctx() {
    return this.deps.ctx;
  }
  protected now() {
    return this.ctx.clock.now();
  }

  /* ---------------------------------------------------------------- audit and log */

  protected async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ category: 'content', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      this.ctx.log.warn({ err, action: entry.action }, 'content: audit entry not recorded');
    }
  }

  /** Publication, schedule, unpublish, correction and removal actions with reasons (content_log) */
  protected async logAction(entity: string, entityId: string, action: string, by: By, reason?: string | null, repo: ContentRepository = this.repo) {
    await repo.log({ id: newId(), entity, entity_id: entityId, action, reason: reason ?? null, actor_kind: by.actor.kind, actor_id: by.actor.id ?? null, at: this.now() });
  }

  /** Drops the resolved homepages (content changed, or a product, offer or stock event arrived) */
  protected invalidateHome() {
    this.homeCache.entries.clear();
  }

  /* ---------------------------------------------------------------- settings */

  protected async marketTimeZone(): Promise<string> {
    const tz = await this.ctx.settings.get('marketTimeZone');
    return isValidTimeZone(tz) ? tz : 'America/Los_Angeles';
  }

  protected async reviewRequired(): Promise<SettingsShape> {
    const v = (await this.ctx.settings.get('reviewRequired')) as Partial<SettingsShape> | null;
    return { page: Boolean(v?.page), section: Boolean(v?.section), article: v?.article === undefined ? true : Boolean(v.article) };
  }

  protected async timeZoneOr(tz: string | null | undefined, path = 'timeZone'): Promise<string> {
    if (tz == null || tz === '') return this.marketTimeZone();
    if (!isValidTimeZone(tz)) throw invalid(path, 'Use an IANA time zone, e.g. America/Los_Angeles');
    return tz;
  }

  protected schedule(publishAt: Date | null, unpublishAt: Date | null, timeZone: string, followsCampaign = false): Schedule {
    return { publishAt: iso(publishAt), unpublishAt: iso(unpublishAt), timeZone, label: scheduleLabel(publishAt, unpublishAt, timeZone, { followsCampaign }) };
  }

  /* ---------------------------------------------------------------- calling optional modules */

  /** An optional module's answer, or the fallback when it is off or cannot answer (enrichment only, never a business decision) */
  protected async soft<T>(what: string, call: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
    if (!call) return fallback;
    try {
      return await call();
    } catch (err) {
      this.ctx.log.debug({ err, what }, 'content: optional data unavailable');
      return fallback;
    }
  }

  /* ---------------------------------------------------------------- owners */

  /** Owner names by staff id (access.getStaffRef), one call per distinct id */
  protected async owners(entries: { staffId: string | null | undefined; role?: string | null }[]): Promise<OwnerRef[]> {
    const ids = unique(entries.map((e) => e.staffId).filter((x): x is string => Boolean(x)));
    const refs = new Map<string, { name: string; roleLabel?: string | null } | null>();
    await Promise.all(
      ids.map(async (id) => {
        refs.set(id, await this.soft('access.getStaffRef', () => this.ctx.use('access').getStaffRef(id), null));
      }),
    );
    return entries.map((e) => {
      const ref = e.staffId ? refs.get(e.staffId) : null;
      return { staffId: e.staffId ?? null, name: ref?.name ?? (e.staffId ? 'Staff member' : 'Content team'), role: e.role ?? ref?.roleLabel ?? 'Content' };
    });
  }

  protected async owner(staffId: string | null | undefined, role?: string | null): Promise<OwnerRef> {
    return (await this.owners([{ staffId, role }]))[0]!;
  }

  /** The acting staff member (owner default for new items) */
  protected staffIdOf(by: By): string | null {
    return by.actor.kind === 'staff' && by.actor.id ? by.actor.id : null;
  }

  /* ---------------------------------------------------------------- versions */

  protected versionOut(v: VersionRow): Version {
    return {
      id: v.id,
      entity: v.entity,
      entityId: v.entity_id,
      number: v.number,
      state: v.state as Version['state'],
      summary: v.summary ?? '',
      author: { kind: (v.author_kind as common.Actor['kind']) ?? 'system', id: v.author_id },
      createdAt: v.created_at.toISOString(),
      publishedAt: iso(v.published_at),
      restoredFrom: v.restored_from,
    };
  }

  protected newVersionRow(entity: VersionRow['entity'], entityId: string, number: number, snapshot: unknown, by: By, extra: Partial<VersionRow> = {}): VersionRow {
    return {
      id: newId(),
      entity,
      entity_id: entityId,
      number,
      state: 'draft',
      snapshot: snapshot as never,
      summary: null,
      author_kind: by.actor.kind,
      author_id: by.actor.id ?? null,
      restored_from: null,
      review_state: null,
      submitted_by: null,
      submitted_at: null,
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
      created_at: this.now(),
      published_at: null,
      ...extra,
    };
  }

  /* ---------------------------------------------------------------- links */

  protected checkLink(link: LinkRef | null | undefined, path: string) {
    if (!link) return;
    requireText(link.label, `${path}.label`, 'A link needs a label');
    if (!isSafeUrl(link.url)) throw invalid(`${path}.url`, 'Use a store path (/deals) or an http(s), mailto or tel link');
  }

  /* ---------------------------------------------------------------- media */

  protected get media() {
    return this.ctx.use('media');
  }

  /** MediaRefs by id (files that are not ready are left out) */
  protected async refsMap(ids: (string | null | undefined)[]): Promise<Map<string, common.MediaRef>> {
    const list = unique(ids.filter((i): i is string => Boolean(i)));
    if (!list.length) return new Map();
    const refs = await this.soft('media.refs', () => this.media.refs(list, 'large'), [] as common.MediaRef[]);
    return new Map(refs.map((r) => [r.id, r]));
  }

  /**
   * Makes the media usages of a record match the files it now uses: attaches new files (platform-owned
   * content images), detaches files no version uses any more. Unknown files are a validation problem of the form.
   */
  protected async syncMedia(kind: Extract<UsageInput['kind'], 'content_block' | 'help_article'>, refId: string, refLabel: string, before: string[], after: { id: string; path: string }[]) {
    const prev = new Set(before);
    const attached: string[] = [];
    try {
      for (const f of after) {
        if (prev.has(f.id) || attached.includes(f.id)) continue;
        try {
          await this.media.attach(f.id, { module: 'content', kind, refId, refLabel }, { kind: 'platform' });
        } catch (err) {
          if (isAppError(err) && err.code === 'NOT_FOUND') throw invalid(f.path, 'File not found; upload it again');
          if (isAppError(err) && err.code === 'ASSET_NOT_OWNED') throw invalid(f.path, 'Use an image uploaded for store content');
          throw err;
        }
        attached.push(f.id);
      }
    } catch (err) {
      for (const id of attached) await this.media.detach(id, { module: 'content', kind, refId }).catch(() => {});
      throw err;
    }
    const next = new Set(after.map((f) => f.id));
    return {
      /** after the record is saved: detach files that are no longer used */
      commit: async () => {
        for (const id of prev) {
          if (next.has(id)) continue;
          await this.media.detach(id, { module: 'content', kind, refId }).catch((err) => this.ctx.log.warn({ err, assetId: id }, 'content: could not detach a file'));
        }
      },
      /** the save failed: drop what was attached */
      undo: async () => {
        for (const id of attached) await this.media.detach(id, { module: 'content', kind, refId }).catch(() => {});
      },
    };
  }
}
