/**
 * Shared plumbing of the catalog service: context, time, audit, the category tree, media helpers and
 * small validation helpers. The use cases build on it (views → taxonomy → products → admin → service).
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type { MediaOwner, UsageInput } from '../../../spec/media.js';
import type { CatalogRepository, CategoryRow } from '../ports.js';

export interface CatalogServiceDeps {
  repo: CatalogRepository;
  ctx: ModuleContext<'catalog'>;
}

/** Who acts: for events, audit entries, review logs and approvals */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
}

export type Viewer = { kind: 'staff'; staffId: string | null } | { kind: 'seller'; sellerId: string } | { kind: 'system' };

export const invalid = (path: string, message: string, extra: Record<string, unknown> = {}) => new AppError('VALIDATION_FAILED', message, { issues: [{ path, message }], ...extra });
export const notFound = (what = 'Product') => new AppError('NOT_FOUND', `${what} not found`);
export const requireReason = (reason: string | null | undefined, what = 'reason') => {
  const r = reason?.trim();
  if (!r) throw invalid(what, 'A reason is required');
  return r;
};

/** The category tree in memory (the table is small) */
export interface Taxonomy {
  rows: CategoryRow[];
  byId: Map<string, CategoryRow>;
  children(parentId: string | null): CategoryRow[];
  /** Root → category */
  path(id: string | null | undefined): CategoryRow[];
  /** The category and all its descendants */
  subtree(id: string): string[];
  /** Top-level ancestor (the category itself when top-level) */
  top(id: string): string | null;
  /** Visible to shoppers: it and every ancestor visible */
  visible(id: string): boolean;
}

export function buildTaxonomy(rows: CategoryRow[]): Taxonomy {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kids = new Map<string | null, CategoryRow[]>();
  for (const r of rows) {
    const k = r.parent_id && byId.has(r.parent_id) ? r.parent_id : null;
    kids.set(k, [...(kids.get(k) ?? []), r]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const path = (id: string | null | undefined) => {
    const out: CategoryRow[] = [];
    const seen = new Set<string>();
    let cur = id ? byId.get(id) : undefined;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.unshift(cur);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return out;
  };
  const subtree = (id: string) => {
    const out: string[] = [];
    const walk = (cid: string) => {
      if (out.includes(cid)) return;
      out.push(cid);
      for (const c of kids.get(cid) ?? []) walk(c.id);
    };
    if (byId.has(id)) walk(id);
    return out;
  };
  return {
    rows,
    byId,
    children: (p) => kids.get(p) ?? [],
    path,
    subtree,
    top: (id) => path(id)[0]?.id ?? null,
    visible: (id) => {
      const p = path(id);
      return p.length > 0 && p.every((c) => c.visible);
    },
  };
}

export class CatalogBase {
  constructor(protected readonly deps: CatalogServiceDeps) {}

  protected get repo() {
    return this.deps.repo;
  }
  protected get ctx() {
    return this.deps.ctx;
  }
  protected now() {
    return this.ctx.clock.now();
  }

  protected async taxonomy(): Promise<Taxonomy> {
    return buildTaxonomy(await this.repo.allCategories());
  }

  protected async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: By) {
    await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
  }

  /* ---------------------------------------------------------------- media */

  protected get media() {
    return this.ctx.use('media');
  }

  /** MediaRefs by id (files that are not ready are left out) */
  protected async refsMap(ids: (string | null | undefined)[], size: 'thumb' | 'small' | 'medium' | 'large' | 'zoom' = 'medium'): Promise<Map<string, common.MediaRef>> {
    const unique = [...new Set(ids.filter((i): i is string => Boolean(i)))];
    if (!unique.length) return new Map();
    const refs = await this.media.refs(unique, size);
    return new Map(refs.map((r) => [r.id, r]));
  }

  /**
   * Attaches the files a record now uses and returns an undo. Unknown files are a validation problem of the
   * form (not a 404 of the record being saved).
   */
  protected async attachAll(items: { assetId: string; kind: UsageInput['kind']; path: string }[], usage: { refId: string; refLabel: string }, owner: MediaOwner): Promise<() => Promise<void>> {
    const done: { assetId: string; kind: string }[] = [];
    const undo = async () => {
      for (const d of done) await this.media.detach(d.assetId, { module: 'catalog', kind: d.kind, refId: usage.refId }).catch(() => {});
    };
    try {
      for (const it of items) {
        try {
          await this.media.attach(it.assetId, { module: 'catalog', kind: it.kind, refId: usage.refId, refLabel: usage.refLabel }, owner);
        } catch (err) {
          if (isAppError(err) && err.code === 'NOT_FOUND') throw invalid(it.path, 'File not found; upload it again');
          throw err;
        }
        done.push({ assetId: it.assetId, kind: it.kind });
      }
    } catch (err) {
      await undo();
      throw err;
    }
    return undo;
  }

  protected async detachAll(items: { assetId: string; kind: string }[], refId: string) {
    for (const it of items) {
      await this.media.detach(it.assetId, { module: 'catalog', kind: it.kind, refId }).catch((err) => this.ctx.log.warn({ err, assetId: it.assetId }, 'catalog: could not detach a file'));
    }
  }

  /** Review target in business days (setting reviewTargetBusinessDays); read before a transaction */
  protected async reviewTargetDays(): Promise<number> {
    const v = Number(await this.ctx.settings.get('reviewTargetBusinessDays'));
    return Number.isFinite(v) && v >= 1 ? Math.round(v) : 1;
  }

  /**
   * Attach new ids and detach dropped ids of one usage kind. `legacyKinds`: kinds the same files were attached
   * under before (e.g. content_block for brand banners and category images), also detached when a file is dropped.
   */
  protected async swapMedia(
    before: (string | null)[],
    after: (string | null)[],
    kind: UsageInput['kind'],
    path: string,
    usage: { refId: string; refLabel: string },
    owner: MediaOwner,
    legacyKinds: string[] = [],
  ) {
    const prev = new Set(before.filter((x): x is string => Boolean(x)));
    const next = after.filter((x): x is string => Boolean(x));
    const undo = await this.attachAll(
      next.filter((id) => !prev.has(id)).map((assetId) => ({ assetId, kind, path })),
      usage,
      owner,
    );
    return {
      undo,
      commit: () =>
        this.detachAll(
          [...prev].filter((id) => !next.includes(id)).flatMap((assetId) => [kind, ...legacyKinds].map((k) => ({ assetId, kind: k }))),
          usage.refId,
        ),
    };
  }
}
