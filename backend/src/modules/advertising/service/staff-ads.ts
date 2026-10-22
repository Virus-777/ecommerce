/**
 * The simple staff Advertisements page (owner decision 2026-10-23): one own campaign per ad, with one placement, a
 * phone image (plus an optional website image for the opening ad), a picked destination resolved to a store path, a
 * schedule, a carousel position and an optional linked deal. It runs on the campaign model: the same lifecycle,
 * review steps, jobs, serving and stats.
 *
 * Editing a scheduled, live or paused ad saves a pending change (campaigns.pending_change) that goes through the same
 * two reviews; its review steps use negative submission numbers (-1, -2…) so the campaign's own review (positive
 * submissions, read by the wizard endpoints as "the latest") is never mixed up with them. The live version keeps
 * serving until the last approval applies the change. End date and position apply at once.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { RotationRule, AdDestination, AdDestinationInput, AdDestinationOption, AdImage, AdReview, AdReviewStep, AdWaitingRef, StaffAd, StaffAdChange, StaffAdInput, StaffAdPatch, StaffAdsOrderInput, StaffAdsPage } from '../../../spec/advertising.js';
import type * as common from '../../../spec/common.js';
import { OFFICIAL_STORE_ID, OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import { formatIssues, frequencyLabel, isPageType, slotRotationLabel, stepFor, type ReviewRole } from '../domain/rules.js';
import { byPosition, DEALS_TAB, DEPARTMENTS, inferDestination, slugPath, isDestinationKind, isStaffSlot, KIND_LABEL, KIND_MODULE, STAFF_AD_SLOTS, staffStatus, statusRank, submitIssues, urlIssue, type DestinationKind } from '../domain/staff-ads.js';
import type { CampaignRec, CreativeRec, PlacementRec, StepRec } from '../ports.js';
import type { AdvertisingRepository } from '../repository.js';
import type { CampaignValues } from './campaigns.js';
import { decodeActor, encodeActor, invalid, notFound, Part, type By } from './core.js';

/** The destination as stored on campaigns.destination (url = the resolved store path) */
interface StoredDest {
  kind: string;
  targetId: string | null;
  url: string;
  /** A URL slug still to look up (destinations read from store paths by the 2026-10-23 migration) */
  slug?: string | null;
  label?: string | null;
  meta?: string | null;
}

/** campaigns.pending_change */
interface StoredChange {
  state: 'draft' | 'in_review' | 'changes_requested';
  name: string;
  alt: string | null;
  categoryId: string | null;
  imageCreativeId: string | null;
  webImageCreativeId: string | null;
  destination: StoredDest | null;
  startsAt: string | null;
  dealId: string | null;
  stopWithDeal: boolean;
  changedFields: string[];
  /** Negative review submission number once submitted */
  submission: number | null;
  createdBy: string;
  createdAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
}

/** Who is looking: what they may review (the HTTP layer knows the permission, access the roles) */
export interface StaffViewer {
  by: By;
  mayReview: boolean;
  roles: Set<ReviewRole>;
}

/** The ad's version as values (the live campaign, or a pending change) */
interface Version {
  name: string;
  alt: string | null;
  categoryId: string | null;
  imageCreativeId: string | null;
  webImageCreativeId: string | null;
  destination: StoredDest | null;
  startsAt: string | null;
  dealId: string | null;
  stopWithDeal: boolean;
}

/** Everything the views of a page of ads need, loaded in a few batched reads */
interface Loaded {
  creatives: Map<string, CreativeRec>;
  media: Map<string, common.MediaRef>;
  links: Map<string, { creative_id: string; device: string }[]>;
  steps: Map<string, StepRec[]>;
  submits: Map<string, { at: Date; by: string }>;
  dests: Map<string, AdDestination>;
  deals: Map<string, string>;
  totals: Map<string, { displays: number; clicks: number }>;
  named: Map<string, common.Actor>;
}

const VIEW_PERMISSIONS = ['advertising.campaigns.view', 'advertising.campaigns.manage', 'advertising.campaigns.review'];
const RUNNING = ['scheduled', 'live', 'paused'];
/** One stored destination's key in the resolved map */
const storedKey = (d: StoredDest) => `${d.kind}|${d.targetId ?? ''}|${d.slug ?? ''}|${d.url}`;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const sameTime = (a: string | null, b: string | null) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);
const PICKED = (k: string) => k !== 'url' && isDestinationKind(k);

export class StaffAdsPart extends Part {
  /* ================================================================ access */

  /** The view endpoints take any of view, manage or review (Content Managers review without the view key) */
  async assertCanView(can: (permission: string) => Promise<boolean>): Promise<void> {
    for (const p of VIEW_PERMISSIONS) if (await can(p)) return;
    throw new AppError('FORBIDDEN', 'You need advertising.campaigns.view, .manage or .review', { permission: VIEW_PERMISSIONS[0] });
  }

  async viewer(by: By, can?: (permission: string) => Promise<boolean>): Promise<StaffViewer> {
    const mayReview = can ? await can('advertising.campaigns.review') : true;
    return { by, mayReview, roles: mayReview ? await this.core.reviewRolesOf(by) : new Set() };
  }

  /* ================================================================ reads */

  private async placementsOf(keys: readonly string[]): Promise<PlacementRec[]> {
    const rows = await this.core.placementRows();
    return keys.map((k) => rows.find((p) => p.key === k)).filter((p): p is PlacementRec => Boolean(p));
  }

  /** Staff ads of the given placements: every campaign staff made there (own, Official Store and brand ads) */
  private async rowsOf(placements: readonly PlacementRec[]): Promise<CampaignRec[]> {
    if (!placements.length) return [];
    const rows = await this.repo.find('campaigns', { placement_id: placements.map((p) => p.id), origin: 'staff' }, { orderBy: [['created_at', 'desc']], limit: 2000 });
    return rows;
  }

  private async rowByIdOrRef(idOrRef: string): Promise<CampaignRec> {
    const key = idOrRef.trim();
    const row = isUuid(key) ? await this.repo.get('campaigns', key) : /^AD-/i.test(key) ? await this.repo.findOne('campaigns', { ref: String(key).toUpperCase() }) : undefined;
    if (!row) throw notFound('Ad');
    return row;
  }

  async get(idOrRef: string, viewer: StaffViewer): Promise<StaffAd> {
    const row = await this.rowByIdOrRef(idOrRef);
    return (await this.views([row], viewer))[0]!;
  }

  async list(q: { placement?: string | null; status?: string | null }, viewer: StaffViewer): Promise<StaffAdsPage> {
    const asked = q.placement?.trim() ? q.placement.split(',').map((s) => s.trim()).filter(isStaffSlot) : [...STAFF_AD_SLOTS];
    const statuses = q.status?.trim() ? q.status.split(',').map((s) => s.trim()) : null;
    const all = await this.rowsOf(await this.placementsOf(STAFF_AD_SLOTS));
    const placements = await this.core.placementRows();
    const keyOf = new Map(placements.map((p) => [p.id, p.key]));
    const ads = await this.views(all, viewer);
    const counts: Record<string, number> = Object.fromEntries(STAFF_AD_SLOTS.map((k) => [k, 0]));
    for (const a of ads) if (a.status !== 'ended' && a.status !== 'rejected') counts[a.placementKey] = (counts[a.placementKey] ?? 0) + 1;
    const inAsked = ads.filter((a) => asked.includes(a.placementKey));
    const statusCounts: Record<string, number> = {};
    for (const a of inAsked) statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;
    const rowById = new Map(all.map((r) => [r.id, r]));
    const items = inAsked
      .filter((a) => !statuses || statuses.includes(a.status))
      .sort((a, b) => {
        const d = statusRank(a.status) - statusRank(b.status);
        if (d) return d;
        if (statusRank(a.status) === 0) return byPosition(rowById.get(a.id)!, rowById.get(b.id)!);
        return b.createdAt.localeCompare(a.createdAt);
      });
    const waiting: AdWaitingRef[] = ads.filter((a) => a.allowedActions.includes('review')).map((a) => ({ id: a.id, name: a.name, placementKey: keyOf.get(rowById.get(a.id)!.placement_id) ?? a.placementKey, isChange: a.pendingChange?.state === 'in_review' }));
    const slots: StaffAdsPage['slots'] = {};
    const live = await this.liveCounts();
    for (const p of placements.filter((x) => isStaffSlot(x.key))) {
      const rot = p.rotation as unknown as RotationRule;
      const carousel = rot.mode === 'carousel';
      slots[p.key] = { name: p.name, enabled: p.enabled, live: live.get(p.id) ?? 0, maxLive: carousel ? p.max_per_page : null, carouselSeconds: carousel ? (rot.carouselSeconds ?? 6) : null, rotationLabel: slotRotationLabel(p.key, rot) };
    }
    return { items, counts, statusCounts, waitingForMe: waiting.length, waitingForMeAds: waiting, slots };
  }

  /** Live campaigns per placement id (every origin: the same count as Placement.liveCampaigns) */
  private async liveCounts(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const r of await this.repo.find('campaigns', { status: 'live' })) out.set(r.placement_id, (out.get(r.placement_id) ?? 0) + 1);
    return out;
  }

  /* ---------------------------------------------------------------- views */

  private changeOf(row: CampaignRec): StoredChange | null {
    return (row.pending_change ?? null) as unknown as StoredChange | null;
  }

  /** The stored destination; a draft without one keeps an empty link (destination is required on the row) */
  private destOf(row: CampaignRec): StoredDest | null {
    const d = (row.destination ?? null) as unknown as StoredDest | null;
    return d && (d.url || d.targetId) ? d : null;
  }

  /** The live version's values */
  private versionOf(row: CampaignRec, links: { creative_id: string; device: string }[], creatives: Map<string, CreativeRec>): Version {
    const visual = links.filter((l) => creatives.get(l.creative_id)?.kind !== 'text');
    const phone = visual.find((l) => l.device === 'phone') ?? visual.find((l) => l.device === 'any');
    const web = visual.find((l) => l.device === 'desktop');
    return {
      name: row.name,
      alt: row.alt ?? null,
      categoryId: ((row.page_category_ids ?? []) as string[])[0] ?? null,
      imageCreativeId: phone?.creative_id ?? null,
      webImageCreativeId: web?.creative_id ?? null,
      destination: this.destOf(row),
      startsAt: iso(row.starts_at),
      dealId: row.linked_promotion_id,
      stopWithDeal: row.stop_with_promotion,
    };
  }

  private async load(rows: readonly CampaignRec[]): Promise<Loaded> {
    const ids = rows.map((r) => r.id);
    const [linkRows, stepRows, submits, totals] = await Promise.all([
      ids.length ? this.repo.find('campaign_creatives', { campaign_id: ids }) : Promise.resolve([]),
      ids.length ? this.repo.find('approval_steps', { campaign_id: ids }) : Promise.resolve([]),
      this.repo.lastLogs(ids, ['submit']),
      this.repo.totals(ids),
    ]);
    const links = new Map<string, { creative_id: string; device: string }[]>();
    for (const l of linkRows) links.set(l.campaign_id, [...(links.get(l.campaign_id) ?? []), { creative_id: l.creative_id, device: l.device }]);
    const steps = new Map<string, StepRec[]>();
    for (const s of stepRows) steps.set(s.campaign_id, [...(steps.get(s.campaign_id) ?? []), s]);
    const changes = rows.map((r) => this.changeOf(r)).filter((c): c is StoredChange => Boolean(c));
    const creativeIds = [...linkRows.map((l) => l.creative_id), ...changes.flatMap((c) => [c.imageCreativeId, c.webImageCreativeId])].filter((x): x is string => Boolean(x));
    const creativeRows = creativeIds.length ? await this.repo.getMany('creatives', creativeIds) : [];
    const creatives = new Map(creativeRows.map((c) => [c.id, c]));
    const mediaIds = creativeRows.map((c) => c.media_id).filter((x): x is string => Boolean(x));
    const refs = mediaIds.length ? await this.core.optionalMedia((m) => m.refs([...new Set(mediaIds)], 'large')) : undefined;
    const media = new Map((refs ?? []).map((r) => [r.id, r]));
    const destList = [...rows.map((r) => this.destOf(r)), ...changes.map((c) => c.destination)].filter((d): d is StoredDest => Boolean(d));
    const dests = await this.resolveStored(destList);
    const dealIds = [...new Set([...rows.map((r) => r.linked_promotion_id), ...changes.map((c) => c.dealId)].filter((x): x is string => Boolean(x)))];
    const deals = new Map<string, string>();
    await Promise.all(dealIds.map(async (id) => {
      const p = await this.core.optional('promotions', (api) => api.getPublicCampaign(id));
      if (p) deals.set(id, p.name);
    }));
    const actorKeys = [...rows.map((r) => r.created_by), ...stepRows.map((s) => s.reviewer_id), ...[...submits.values()].map((l) => (l.actor_id ? `${l.actor_kind}:${l.actor_id}` : l.actor_kind)), ...changes.flatMap((c) => [c.createdBy, c.submittedBy])].filter((x): x is string => Boolean(x));
    const uniqueKeys = [...new Set(actorKeys)];
    const actors = await this.core.named(uniqueKeys.map((k) => decodeActor(k)));
    const named = new Map(uniqueKeys.map((k, i) => [k, actors[i] ?? { kind: 'system' as const, id: null }]));
    const submitsOut = new Map([...submits].map(([id, l]) => [id, { at: l.at, by: l.actor_id ? `${l.actor_kind}:${l.actor_id}` : l.actor_kind }]));
    return { creatives, media, links, steps, submits: submitsOut, dests, deals, totals, named };
  }

  private image(creativeId: string | null, d: Loaded): AdImage | null {
    const c = creativeId ? d.creatives.get(creativeId) : undefined;
    const ref = c?.media_id ? d.media.get(c.media_id) : undefined;
    if (!c?.media_id || !ref) return null;
    return { id: c.media_id, url: ref.url, width: c.width ?? ref.width ?? null, height: c.height ?? ref.height ?? null };
  }

  private actor(key: string | null | undefined, d: Loaded): common.Actor | null {
    return key ? (d.named.get(key) ?? decodeActor(key)) : null;
  }

  /** One review (the steps of one submission) as the caller sees it */
  private reviewOf(steps: StepRec[], open: boolean, authorKey: string, v: StaffViewer, submitted: { by: string | null; at: string | null }, d: Loaded): AdReview {
    const slotOf = (role: string) => (role === 'advertising' ? 'advertising' : 'content');
    const sorted = [...steps].sort((a, b) => (slotOf(a.role) === 'advertising' ? -1 : 1) - (slotOf(b.role) === 'advertising' ? -1 : 1));
    const out: AdReviewStep[] = sorted.map((s) => ({ step: slotOf(s.role) as AdReviewStep['step'], state: s.state as AdReviewStep['state'], by: this.actor(s.reviewer_id, d), at: iso(s.decided_at), note: s.note }));
    const me = encodeActor(v.by.actor);
    const mySlots = new Set([...v.roles].map((r) => stepFor(r, 'platform')).filter(Boolean));
    const canReview =
      open &&
      v.mayReview &&
      authorKey !== me &&
      !steps.some((s) => s.state === 'approved' && s.reviewer_id === me) &&
      steps.some((s) => s.state === 'waiting' && mySlots.has(slotOf(s.role) as 'advertising' | 'content'));
    return { steps: out, canReview, submittedBy: this.actor(submitted.by, d), submittedAt: submitted.at };
  }

  async views(rows: readonly CampaignRec[], v: StaffViewer): Promise<StaffAd[]> {
    if (!rows.length) return [];
    const d = await this.load(rows);
    const placements = await this.core.placementRows();
    // scheduled ads past their start wait for room in a full carousel
    const waiting = rows.some((r) => r.status === 'scheduled' && r.starts_at && r.starts_at.getTime() <= this.now().getTime());
    const liveBySlot = waiting ? await this.liveCounts() : new Map<string, number>();
    const out: StaffAd[] = [];
    for (const r of rows) {
      const placement = placements.find((p) => p.id === r.placement_id);
      const steps = d.steps.get(r.id) ?? [];
      const initial = steps.filter((s) => s.submission > 0);
      const latest = Math.max(0, ...initial.map((s) => s.submission));
      const current = initial.filter((s) => s.submission === latest);
      const status = staffStatus(r.status, current.map((s) => s.state));
      const live = this.versionOf(r, d.links.get(r.id) ?? [], d.creatives);
      const submit = d.submits.get(r.id);
      const review = this.reviewOf(current, r.status === 'in_review', r.created_by, v, { by: submit?.by ?? null, at: iso(submit?.at) }, d);
      const ch = this.changeOf(r);
      let pendingChange: StaffAdChange | null = null;
      if (ch) {
        const chSteps = ch.submission ? steps.filter((s) => s.submission === ch.submission) : [];
        pendingChange = {
          state: ch.state,
          name: ch.name,
          image: this.image(ch.imageCreativeId, d),
          webImage: this.image(ch.webImageCreativeId, d),
          alt: ch.alt,
          destination: ch.destination ? (d.dests.get(storedKey(ch.destination)) ?? null) : null,
          startsAt: ch.startsAt,
          dealId: ch.dealId,
          dealName: ch.dealId ? (d.deals.get(ch.dealId) ?? null) : null,
          stopWithDeal: ch.stopWithDeal,
          changedFields: ch.changedFields,
          review: this.reviewOf(chSteps, ch.state === 'in_review', ch.createdBy, v, { by: ch.submittedBy, at: ch.submittedAt }, d),
          createdBy: this.actor(ch.createdBy, d) ?? { kind: 'system', id: null },
          createdAt: ch.createdAt,
        };
      }
      const actions: string[] = [];
      if (status === 'draft' || status === 'changes_requested') actions.push('edit', 'submit', 'delete');
      if (status === 'in_review' && review.canReview) actions.push('review');
      if (RUNNING.includes(status)) {
        if (!ch || ch.state !== 'in_review') actions.push('edit');
        if (ch && ch.state !== 'in_review') actions.push('submit');
        if (ch?.state === 'in_review' && pendingChange?.review.canReview) actions.push('review');
        actions.push(status === 'paused' ? 'resume' : 'pause', 'end');
      }
      actions.push('duplicate');
      const t = d.totals.get(r.id);
      out.push({
        id: r.id,
        ref: r.ref,
        name: r.name,
        placementKey: placement?.key ?? 'unknown',
        placementName: placement?.name ?? 'Placement',
        categoryId: placement?.key === 'category_banner' ? live.categoryId : null,
        status,
        image: this.image(live.imageCreativeId, d),
        webImage: this.image(live.webImageCreativeId, d),
        alt: live.alt,
        destination: live.destination ? (d.dests.get(storedKey(live.destination)) ?? null) : null,
        startsAt: live.startsAt,
        endsAt: iso(r.ends_at),
        dealId: live.dealId,
        dealName: live.dealId ? (d.deals.get(live.dealId) ?? null) : null,
        stopWithDeal: live.stopWithDeal,
        position: r.position ?? 0,
        review,
        pendingChange,
        stats: { views: t?.displays ?? 0, taps: t?.clicks ?? 0 },
        allowedActions: actions,
        statusNote: this.statusNote(r, status, current, ch, placement && r.status === 'scheduled' && r.starts_at && r.starts_at.getTime() <= this.now().getTime() ? { name: placement.name, live: liveBySlot.get(placement.id) ?? 0 } : null),
        createdBy: this.actor(r.created_by, d) ?? { kind: 'system', id: null },
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        version: r.version,
      });
    }
    return out;
  }

  private statusNote(r: CampaignRec, status: StaffAd['status'], steps: StepRec[], ch: StoredChange | null, waitingIn: { name: string; live: number } | null = null): string | null {
    const names = (xs: StepRec[]) => xs.map((s) => (s.role === 'advertising' ? 'Advertising' : 'Content')).join(' and ');
    if (status === 'in_review') {
      const waiting = steps.filter((s) => s.state === 'waiting');
      return waiting.length ? `Needs ${names(waiting)} review` : null;
    }
    if (status === 'changes_requested') {
      const s = steps.find((x) => x.state === 'changes_requested');
      return s?.note ? `Changes requested: ${s.note}` : 'Changes requested';
    }
    if (status === 'rejected') return r.rejected_reason;
    if (ch?.state === 'in_review') return 'A change is waiting for review; the current version keeps running';
    if (ch?.state === 'changes_requested') return 'Changes requested on the pending change';
    if (ch?.state === 'draft') return 'A change is saved but not sent for review';
    if (status === 'paused') return r.paused_reason;
    if (waitingIn) return `${waitingIn.name} is full (${waitingIn.live} live) — it starts when one ends`;
    return null;
  }

  /* ================================================================ destinations */

  /** Fixed targets: the ten department pages, the Deals tab and the Official Store */
  private statics(kind: string): common.LinkTarget[] {
    if (kind === 'department') return DEPARTMENTS.map((x) => ({ id: x.key, label: x.label, meta: 'Department page', path: x.path, image: null, available: true }));
    if (kind === 'deal') return [{ id: DEALS_TAB, label: 'Deals tab', meta: 'Deals', path: '/deals', image: null, available: true }];
    if (kind === 'seller_store') return [{ id: OFFICIAL_STORE_ID, label: OFFICIAL_STORE_NAME, meta: 'Official Store', path: '/official', image: null, available: true }];
    return [];
  }

  /**
   * Targets of a kind by q, ids or URL slugs: the fixed ones, then the owning module's link targets. undefined when
   * the module is off (or can't answer) and no fixed target matched.
   */
  private async targets(kind: string, o: { q?: string; ids?: string[]; slugs?: string[]; limit?: number }): Promise<common.LinkTarget[] | undefined> {
    const statics = this.statics(kind);
    const q = o.q?.trim().toLowerCase();
    const fixed = o.ids ? statics.filter((x) => o.ids!.includes(x.id)) : o.slugs ? [] : statics.filter((x) => !q || x.label.toLowerCase().includes(q) || x.id.includes(q));
    const module = KIND_MODULE[kind];
    const ids = o.ids?.filter((id) => !statics.some((x) => x.id === id));
    if (!module || (ids && !ids.length)) return fixed;
    const input = { kind, ...(o.q ? { q: o.q } : {}), ...(ids ? { ids } : {}), ...(o.slugs ? { slugs: o.slugs } : {}), limit: o.limit ?? 20 } as never;
    const res = await this.core.optional(module, (api) => (api as { linkTargets(i: unknown): Promise<common.LinkTarget[]> }).linkTargets(input));
    return res ? [...fixed, ...res] : fixed.length ? fixed : undefined;
  }

  /**
   * Stored destinations with current label, path and availability, keyed by storedKey. Links (kind url, and the
   * wizard's kinds) are read as the picked kind their store path names (inferDestination): /p/…, /c/…, /deals,
   * department paths… A store path nothing names stays a link ("Store page"); an https address is a web address.
   */
  private async resolveStored(list: readonly StoredDest[]): Promise<Map<string, AdDestination>> {
    type Req = { kind: string; targetId: string | null; slug: string | null; path: string; label: string | null; meta: string | null; fromLink: boolean };
    const reqOf = (x: StoredDest): Req => {
      if (PICKED(x.kind) && (x.targetId || x.slug)) return { kind: x.kind, targetId: x.targetId, slug: x.slug ?? null, path: x.url, label: x.label ?? null, meta: x.meta ?? null, fromLink: false };
      const inf = inferDestination(x.url);
      return { kind: inf.kind, targetId: inf.targetId, slug: inf.slug, path: inf.path, label: null, meta: null, fromLink: true };
    };
    const reqs = list.map((x) => [x, reqOf(x)] as const);
    const ids = new Map<string, Set<string>>();
    const slugs = new Map<string, Set<string>>();
    for (const [, r] of reqs) {
      if (r.kind === 'url') continue;
      if (r.targetId) ids.set(r.kind, (ids.get(r.kind) ?? new Set()).add(r.targetId));
      else if (r.slug) slugs.set(r.kind, (slugs.get(r.kind) ?? new Set()).add(r.slug));
    }
    const byId = new Map<string, common.LinkTarget>();
    const byPath = new Map<string, common.LinkTarget>();
    const answered = new Set<string>();
    await Promise.all([
      ...[...ids].map(async ([kind, set]) => {
        const res = await this.targets(kind, { ids: [...set] });
        if (res) answered.add(kind);
        for (const t of res ?? []) byId.set(`${kind}:${t.id}`, t);
      }),
      ...[...slugs].map(async ([kind, set]) => {
        const res = await this.targets(kind, { slugs: [...set] });
        if (res) answered.add(kind);
        for (const t of res ?? []) byPath.set(`${kind}:${t.path}`, t);
      }),
    ]);
    const out = new Map<string, AdDestination>();
    for (const [x, r] of reqs) {
      if (r.kind === 'url') {
        const store = r.path.startsWith('/') && !r.path.startsWith('//');
        out.set(
          storedKey(x),
          store
            ? { kind: 'url', targetId: null, label: `Store page ${r.path}`, meta: 'Store page', path: r.path, available: true }
            : { kind: 'url', targetId: null, label: r.path || 'No link', meta: 'Web address', path: r.path, available: Boolean(r.path) && !urlIssue(r.path) },
        );
        continue;
      }
      const t = r.targetId ? byId.get(`${r.kind}:${r.targetId}`) : r.slug ? byPath.get(`${r.kind}:${slugPath(r.kind, r.slug)}`) : undefined;
      out.set(storedKey(x), {
        kind: r.kind as DestinationKind,
        targetId: t?.id ?? r.targetId,
        label: t?.label ?? r.label ?? r.path,
        meta: t?.meta ?? r.meta ?? KIND_LABEL[r.kind] ?? null,
        // a product link keeps its offer (?offer=) and slug as written
        path: r.fromLink && r.kind === 'product' ? r.path : (t?.path ?? r.path),
        // a target that is gone, or a module that is off (or can't answer), can't be opened
        available: Boolean(t?.available) && answered.has(r.kind),
      });
    }
    return out;
  }

  /** A picked or typed destination resolved for saving (VALIDATION_FAILED when a picked target can't be found) */
  private async resolveInput(input: AdDestinationInput, path: string): Promise<StoredDest> {
    if (!isDestinationKind(input.kind)) throw invalid([{ path: `${path}.kind`, message: 'Unknown destination kind' }]);
    if (input.kind === 'url') {
      const issue = urlIssue(input.url);
      if (issue) throw invalid([{ path: `${path}.url`, message: issue }]);
      const url = input.url!.trim();
      // a typed store path that names a target is saved as that target
      const inf = inferDestination(url);
      if (inf.kind !== 'url') {
        const res = await this.targets(inf.kind, inf.targetId ? { ids: [inf.targetId] } : { slugs: [inf.slug!] });
        const t = res?.find((x) => (inf.targetId ? x.id === inf.targetId : x.path === slugPath(inf.kind, inf.slug!)));
        if (t) return { kind: inf.kind, targetId: t.id, url: inf.kind === 'product' ? inf.path : t.path, label: t.label, meta: t.meta ?? null };
      }
      return { kind: 'url', targetId: null, url, label: null, meta: null };
    }
    const id = input.targetId?.trim() || (input.kind === 'deal' ? DEALS_TAB : '');
    const fixed = this.statics(input.kind).some((x) => x.id === id);
    if (!id || (!fixed && !isUuid(id))) throw invalid([{ path: `${path}.targetId`, message: `Choose the ${KIND_LABEL[input.kind]?.toLowerCase() ?? 'target'}` }]);
    const res = await this.targets(input.kind, { ids: [id] });
    if (!res) throw invalid([{ path: `${path}.targetId`, message: `${KIND_LABEL[input.kind]} links can't be checked now (the module is off)` }]);
    const t = res.find((x) => x.id === id);
    if (!t) throw invalid([{ path: `${path}.targetId`, message: `${KIND_LABEL[input.kind]} not found` }]);
    return { kind: input.kind, targetId: id, url: t.path, label: t.label, meta: t.meta ?? null };
  }

  /** GET /ads/destinations: one search for every picker kind */
  async searchDestinations(q: { kind: string; q?: string | null; limit?: number | null }): Promise<{ items: AdDestinationOption[] }> {
    if (!isDestinationKind(q.kind)) throw invalid([{ path: 'kind', message: 'Unknown destination kind' }]);
    if (q.kind === 'url') return { items: [] };
    const limit = Math.min(Math.max(Math.floor(q.limit ?? 20), 1), 50);
    const res = (await this.targets(q.kind, { ...(q.q?.trim() ? { q: q.q.trim() } : {}), limit })) ?? [];
    return { items: res.filter((t) => t.available).slice(0, limit).map((t) => ({ kind: q.kind as DestinationKind, targetId: t.id, label: t.label, meta: t.meta ?? null, image: t.image ?? null, path: t.path })) };
  }

  /* ================================================================ create and edit */

  private async staffPlacement(key: string, path = 'placementKey'): Promise<PlacementRec> {
    if (!isStaffSlot(key)) throw invalid([{ path, message: `${key} is not managed on the Advertisements page` }]);
    const p = await this.core.placementByKey(key);
    if (!p) throw invalid([{ path, message: `Unknown placement ${key}` }]);
    return p;
  }

  /** A phone (or website) image creative for the placement, made from an uploaded media asset */
  private async imageCreative(mediaId: string, device: 'phone' | 'desktop', placement: PlacementRec, by: By, path: string): Promise<string> {
    if (!isUuid(mediaId)) throw invalid([{ path, message: 'Upload the image through media first' }]);
    if (device === 'desktop' && placement.key !== 'opening_fullscreen') throw invalid([{ path, message: 'Only the full-screen ad has a website image' }]);
    try {
      const c = await this.parts.creatives.create({ kind: 'image', device, placementKey: placement.key, mediaId }, by);
      return c.id;
    } catch (err) {
      // name the field of this form, not the creative library's
      if (err instanceof AppError && (err.code === 'CREATIVE_FORMAT_INVALID' || err.code === 'VALIDATION_FAILED')) throw new AppError(err.code, err.message, { ...(err.details as object), issues: [{ path, message: err.message }] });
      throw err;
    }
  }

  private async checkDeal(dealId: string | null | undefined, stopWithDeal: boolean | null | undefined): Promise<void> {
    if (stopWithDeal && !dealId) throw invalid([{ path: 'stopWithDeal', message: 'Link a deal first' }]);
    if (!dealId) return;
    if (!isUuid(dealId)) throw invalid([{ path: 'dealId', message: 'Not a deal' }]);
    const p = await this.core.optional('promotions', (api) => api.getPublicCampaign(dealId));
    if (p === null) throw invalid([{ path: 'dealId', message: 'Deal not found' }]);
  }

  private parseDate(s: string | null | undefined, path: string): Date | null {
    if (!s) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw invalid([{ path, message: 'Not a valid date' }]);
    return d;
  }

  private checkName(name: string | null | undefined): string {
    const n = name?.trim();
    if (!n) throw invalid([{ path: 'name', message: 'Name the ad' }]);
    if (n.length > 120) throw invalid([{ path: 'name', message: '120 characters at most' }]);
    return n;
  }

  private async pagesFor(placement: PlacementRec): Promise<string[]> {
    const rules = await this.core.rules();
    return ((placement.eligible_pages ?? []) as string[]).filter((p) => isPageType(p) && !rules.blockedPages.includes(p));
  }

  async create(input: StaffAdInput, by: By, viewer: StaffViewer): Promise<StaffAd> {
    const placement = await this.staffPlacement(input.placementKey);
    if (!placement.enabled) throw this.ctx.error('PLACEMENT_DISABLED', `${placement.name} is turned off.`);
    const name = this.checkName(input.name);
    const destination = input.destination ? await this.resolveInput(input.destination, 'destination') : null;
    const startsAt = this.parseDate(input.startsAt, 'startsAt');
    const endsAt = this.parseDate(input.endsAt, 'endsAt');
    await this.checkDeal(input.dealId, input.stopWithDeal);
    const categoryId = placement.key === 'category_banner' && input.categoryId ? input.categoryId : null;
    if (categoryId && !isUuid(categoryId)) throw invalid([{ path: 'categoryId', message: 'Not a category' }]);
    const creatives: { creative_id: string; device: string }[] = [];
    if (input.imageId) creatives.push({ creative_id: await this.imageCreative(input.imageId, 'phone', placement, by, 'imageId'), device: 'phone' });
    if (input.webImageId) creatives.push({ creative_id: await this.imageCreative(input.webImageId, 'desktop', placement, by, 'webImageId'), device: 'desktop' });
    const cap = (placement.frequency_cap ?? null) as { label?: string } | null;
    const v: CampaignValues = {
      placement,
      items: [],
      creatives,
      row: {
        name,
        origin: 'staff',
        advertiser_kind: 'platform',
        seller_id: null,
        brand_id: null,
        goal: 'company_promotion',
        owner_staff_id: by.actor.kind === 'staff' ? (by.actor.id ?? null) : null,
        linked_promotion_id: input.dealId ?? null,
        placement_id: placement.id,
        pages: (placement.key === 'category_banner' ? ['category'] : await this.pagesFor(placement)) as never,
        page_category_ids: (categoryId ? [categoryId] : []) as never,
        audience: { mode: 'all', regions: [], visitors: 'all', signIn: 'everyone', categoryIds: [] } as never,
        destination: (destination ?? { kind: 'url', targetId: null, url: '' }) as never,
        starts_at: startsAt,
        ends_at: endsAt,
        time_zone: this.core.tz(),
        frequency_cap: (cap ? { ...cap, label: cap.label || frequencyLabel(cap as never) } : { label: 'No cap' }) as never,
        dismissal: placement.dismissal as never,
        priority: 2,
        billing: 'none',
        rate: null,
        daily_limit: null,
        total_limit: null,
        delivery_cap: null,
        currency: this.core.currency(),
        stop_with_promotion: Boolean(input.stopWithDeal && input.dealId),
        after_approval: 'schedule',
        note_to_reviewers: null,
      },
    };
    const row = await this.parts.campaigns.insertDraft(v, by, 'create', null, { alt: input.alt?.trim() || null });
    await this.core.audit({ action: 'advertising.ad.create', actionLabel: `Created ad ${row.ref}`, target: this.parts.campaigns.target(row), after: { name, placement: placement.key, destination: destination?.url ?? null, startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null } }, by);
    return this.get(row.id, viewer);
  }

  /** PATCH /ads/{id}: a draft is edited; a running ad gets a pending change (end date applies at once) */
  async update(id: string, patch: StaffAdPatch, by: By, viewer: StaffViewer): Promise<StaffAd> {
    if (!isUuid(id)) throw notFound('Ad');
    const row = await this.repo.get('campaigns', id);
    if (!row) throw notFound('Ad');
    if (row.version !== patch.version) throw new AppError('CONFLICT', 'The ad changed since you opened it; reload and try again', { version: row.version });
    const placement = (await this.core.placementById(row.placement_id))!;
    if (row.status === 'draft') return this.updateDraft(row, placement, patch, by, viewer);
    if (RUNNING.includes(row.status)) return this.updateRunning(row, placement, patch, by, viewer);
    throw new AppError('ILLEGAL_TRANSITION', row.status === 'in_review' || row.status === 'approved' ? 'The ad is in review; wait for the review (or ask for changes) before editing' : 'An ended or rejected ad can\'t be edited; duplicate it instead', { from: row.status, event: 'edit' });
  }

  /** New values of the editable fields: the patch over a base version (undefined keeps, null clears) */
  private async merge(base: Version, patch: StaffAdPatch, placement: PlacementRec, by: By): Promise<Version> {
    const next: Version = { ...base };
    if (patch.name !== undefined) next.name = this.checkName(patch.name);
    if (patch.alt !== undefined) next.alt = patch.alt?.trim() || null;
    if (patch.categoryId !== undefined) {
      if (patch.categoryId && !isUuid(patch.categoryId)) throw invalid([{ path: 'categoryId', message: 'Not a category' }]);
      next.categoryId = placement.key === 'category_banner' ? (patch.categoryId ?? null) : null;
    }
    if (patch.destination !== undefined) next.destination = patch.destination ? await this.resolveInput(patch.destination, 'destination') : null;
    if (patch.startsAt !== undefined) next.startsAt = this.parseDate(patch.startsAt, 'startsAt') ? new Date(patch.startsAt!).toISOString() : null;
    if (patch.dealId !== undefined) next.dealId = patch.dealId ?? null;
    if (patch.stopWithDeal !== undefined) next.stopWithDeal = Boolean(patch.stopWithDeal);
    if (!next.dealId) next.stopWithDeal = false;
    if (patch.dealId !== undefined || patch.stopWithDeal !== undefined) await this.checkDeal(next.dealId, next.stopWithDeal);
    const media = async (creativeId: string | null) => (creativeId ? ((await this.repo.get('creatives', creativeId))?.media_id ?? null) : null);
    if (patch.imageId !== undefined) {
      if (!patch.imageId) next.imageCreativeId = null;
      else if (patch.imageId !== (await media(base.imageCreativeId))) next.imageCreativeId = await this.imageCreative(patch.imageId, 'phone', placement, by, 'imageId');
    }
    if (patch.webImageId !== undefined) {
      if (!patch.webImageId) next.webImageCreativeId = null;
      else if (patch.webImageId !== (await media(base.webImageCreativeId))) next.webImageCreativeId = await this.imageCreative(patch.webImageId, 'desktop', placement, by, 'webImageId');
    }
    return next;
  }

  private changedFields(live: Version, next: Version): string[] {
    const out: string[] = [];
    if (next.name !== live.name) out.push('name');
    if (next.imageCreativeId !== live.imageCreativeId) out.push('image');
    if (next.webImageCreativeId !== live.webImageCreativeId) out.push('webImage');
    if ((next.alt ?? '') !== (live.alt ?? '')) out.push('alt');
    if (next.categoryId !== live.categoryId) out.push('category');
    const d = (x: StoredDest | null) => (x ? `${x.kind}|${x.targetId ?? ''}|${x.slug ?? ''}|${x.kind === 'url' || !x.targetId ? x.url : ''}` : '');
    if (d(next.destination) !== d(live.destination)) out.push('destination');
    if (!sameTime(next.startsAt, live.startsAt)) out.push('startsAt');
    if (next.dealId !== live.dealId || next.stopWithDeal !== live.stopWithDeal) out.push('deal');
    return out;
  }

  private async replaceLinks(tx: AdvertisingRepository, id: string, live: Version, next: Version) {
    for (const [device, before, after] of [['phone', live.imageCreativeId, next.imageCreativeId], ['desktop', live.webImageCreativeId, next.webImageCreativeId]] as const) {
      if (before === after) continue;
      if (before) await tx.removeWhere('campaign_creatives', { campaign_id: id, creative_id: before });
      if (device === 'phone') await tx.removeWhere('campaign_creatives', { campaign_id: id, device: 'any' });
      if (after) await tx.insertIfAbsent('campaign_creatives', { campaign_id: id, creative_id: after, device });
    }
  }

  private async updateDraft(row: CampaignRec, placement: PlacementRec, patch: StaffAdPatch, by: By, viewer: StaffViewer): Promise<StaffAd> {
    const links = await this.repo.find('campaign_creatives', { campaign_id: row.id });
    const creatives = new Map((await this.repo.getMany('creatives', links.map((l) => l.creative_id))).map((c) => [c.id, c]));
    const live = this.versionOf(row, links, creatives);
    const next = await this.merge(live, patch, placement, by);
    const endsAt = patch.endsAt !== undefined ? this.parseDate(patch.endsAt, 'endsAt') : row.ends_at;
    await this.repo.transaction(async (tx) => {
      const locked = await tx.get('campaigns', row.id, { forUpdate: true });
      if (!locked || locked.version !== patch.version || locked.status !== 'draft') throw new AppError('CONFLICT', 'The ad changed since you opened it; reload and try again', { version: locked?.version ?? null });
      await tx.update('campaigns', row.id, {
        name: next.name,
        alt: next.alt,
        page_category_ids: (next.categoryId ? [next.categoryId] : []) as never,
        destination: (next.destination ?? { kind: 'url', targetId: null, url: '' }) as never,
        starts_at: next.startsAt ? new Date(next.startsAt) : null,
        ends_at: endsAt,
        linked_promotion_id: next.dealId,
        stop_with_promotion: next.stopWithDeal,
        updated_at: this.now(),
        version: locked.version + 1,
      });
      await this.replaceLinks(tx, row.id, live, next);
      await this.core.log(tx, row.id, 'edit', by);
    });
    await this.core.audit({ action: 'advertising.ad.update', actionLabel: `Edited ad ${row.ref}`, target: this.parts.campaigns.target(row), before: { name: row.name, endsAt: row.ends_at }, after: { name: next.name, endsAt, changed: this.changedFields(live, next) } }, by);
    return this.get(row.id, viewer);
  }

  private async updateRunning(row: CampaignRec, placement: PlacementRec, patch: StaffAdPatch, by: By, viewer: StaffViewer): Promise<StaffAd> {
    const before = this.changeOf(row);
    if (before?.state === 'in_review') throw new AppError('ILLEGAL_TRANSITION', 'A change of this ad is in review; wait for the review before editing again', { from: row.status, event: 'edit' });
    const links = await this.repo.find('campaign_creatives', { campaign_id: row.id });
    const creatives = new Map((await this.repo.getMany('creatives', links.map((l) => l.creative_id))).map((c) => [c.id, c]));
    const live = this.versionOf(row, links, creatives);
    const base: Version = before ? { name: before.name, alt: before.alt, categoryId: before.categoryId, imageCreativeId: before.imageCreativeId, webImageCreativeId: before.webImageCreativeId, destination: before.destination, startsAt: before.startsAt, dealId: before.dealId, stopWithDeal: before.stopWithDeal } : live;
    const next = await this.merge(base, patch, placement, by);
    const changed = this.changedFields(live, next);
    // a running ad has started: its start is history
    if (changed.includes('startsAt') && row.status === 'live') throw invalid([{ path: 'startsAt', message: 'The ad is already running; its start can no longer change' }]);
    // the end date applies at once, without review
    let endsAt = row.ends_at;
    if (patch.endsAt !== undefined) {
      const e = this.parseDate(patch.endsAt, 'endsAt');
      if (!e) throw invalid([{ path: 'endsAt', message: 'A running ad needs an end date' }]);
      if (e.getTime() <= this.now().getTime() || (row.starts_at && e.getTime() <= row.starts_at.getTime())) throw invalid([{ path: 'endsAt', message: 'The new end must be after the start and in the future' }]);
      endsAt = e;
    }
    const endChanged = endsAt?.getTime() !== row.ends_at?.getTime();
    const now = this.now();
    const change: StoredChange | null = changed.length
      ? {
          state: before?.state === 'changes_requested' ? 'changes_requested' : 'draft',
          ...next,
          changedFields: changed,
          submission: null,
          createdBy: before?.createdBy ?? encodeActor(by.actor),
          createdAt: before?.createdAt ?? now.toISOString(),
          submittedBy: null,
          submittedAt: null,
        }
      : null;
    if (!endChanged && JSON.stringify(change) === JSON.stringify(before)) return this.get(row.id, viewer);
    await this.repo.transaction(async (tx) => {
      const locked = await tx.get('campaigns', row.id, { forUpdate: true });
      if (!locked || locked.version !== patch.version) throw new AppError('CONFLICT', 'The ad changed since you opened it; reload and try again', { version: locked?.version ?? null });
      await tx.update('campaigns', row.id, { ends_at: endsAt, pending_change: change as never, updated_at: now, version: locked.version + 1 });
      if (endChanged) await this.core.log(tx, row.id, 'edit', by, { reason: `End date changed to ${endsAt!.toISOString()}` });
      if (change || before) await this.core.log(tx, row.id, change ? 'change_saved' : 'change_dropped', by, { reason: change ? `Changed ${change.changedFields.join(', ')}` : 'The edit matches the live version' });
    });
    this.parts.serving.invalidate();
    await this.core.audit({ action: 'advertising.ad.update', actionLabel: change ? `Saved a change of ad ${row.ref} for review` : `Edited ad ${row.ref}`, target: this.parts.campaigns.target(row), before: { endsAt: row.ends_at }, after: { endsAt, pendingChange: change?.changedFields ?? null } }, by);
    return this.get(row.id, viewer);
  }

  /* ================================================================ submit and review */

  private async imageIssue(creativeId: string | null, placement: PlacementRec, device: 'phone' | 'desktop'): Promise<string | null> {
    if (!creativeId) return null;
    const c = await this.repo.get('creatives', creativeId);
    if (!c) return 'The image is missing; upload it again';
    if (c.status === 'rejected') return 'The image was rejected; upload another one';
    const issues = formatIssues({ kind: 'image', device, width: c.width, height: c.height }, (placement.formats ?? []) as never, { maxImageBytes: Number.MAX_SAFE_INTEGER, headlineMax: 1000 });
    return issues[0]?.message ?? null;
  }

  private async checkVersion(v: Version, endsAt: Date | null, placement: PlacementRec): Promise<void> {
    const dests = v.destination ? await this.resolveStored([v.destination]) : new Map();
    const dest = v.destination ? dests.get(storedKey(v.destination)) : undefined;
    const issues = submitIssues(
      {
        hasImage: Boolean(v.imageCreativeId),
        imageIssue: await this.imageIssue(v.imageCreativeId, placement, 'phone'),
        webImageIssue: await this.imageIssue(v.webImageCreativeId, placement, 'desktop'),
        alt: v.alt,
        destination: dest ? { available: dest.available, label: dest.label } : null,
        startsAt: v.startsAt ? new Date(v.startsAt) : null,
        endsAt,
        placementEnabled: placement.enabled,
        placementName: placement.name,
      },
      this.now(),
    );
    if (issues.length) throw this.ctx.error('CHECKS_FAILED', `Fix ${issues.length} thing${issues.length === 1 ? '' : 's'} before sending it for review: ${issues.map((i) => i.label).join(', ')}.`, { checks: issues.map((i) => ({ state: 'fail', label: i.label, detail: i.detail })) });
  }

  async submit(id: string, by: By, viewer: StaffViewer): Promise<StaffAd> {
    if (!isUuid(id)) throw notFound('Ad');
    const row = await this.repo.get('campaigns', id);
    if (!row) throw notFound('Ad');
    const placement = (await this.core.placementById(row.placement_id))!;
    const links = await this.repo.find('campaign_creatives', { campaign_id: id });
    const creatives = new Map((await this.repo.getMany('creatives', links.map((l) => l.creative_id))).map((c) => [c.id, c]));
    if (row.status === 'draft') {
      const live = this.versionOf(row, links, creatives);
      await this.checkVersion(live, row.ends_at, placement);
      // as soon as approved: no start, or a start already past
      const activate = !row.starts_at || row.starts_at.getTime() <= this.now().getTime();
      await this.parts.campaigns.transition(id, 'submit', by, {
        patch: { after_approval: activate ? 'activate' : 'schedule' },
        guard: (r) => {
          if (r.version !== row.version) throw new AppError('CONFLICT', 'The ad changed while it was being submitted');
        },
      });
      const submission = Math.max(0, ...(await this.repo.find('approval_steps', { campaign_id: id })).map((s) => s.submission)) + 1;
      await this.repo.transaction(async (tx) => {
        for (const role of ['advertising', 'content']) await tx.insert('approval_steps', { id: newId(), campaign_id: id, submission, role, reviewer_id: null, state: 'waiting', note: null, decided_at: null });
        await tx.updateWhere('creatives', { id: links.map((l) => l.creative_id), status: ['draft', 'changes_requested'] }, { status: 'in_review' });
      });
      await this.core.audit({ action: 'advertising.ad.submit', actionLabel: `Sent ad ${row.ref} for review`, target: this.parts.campaigns.target(row) }, by);
      return this.get(id, viewer);
    }
    const ch = this.changeOf(row);
    if (!RUNNING.includes(row.status) || !ch || ch.state === 'in_review') throw new AppError('ILLEGAL_TRANSITION', ch?.state === 'in_review' ? 'The change is already in review' : `Nothing to send for review on a ${row.status.replace('_', ' ')} ad`, { from: row.status, event: 'submit' });
    await this.checkVersion(ch, row.ends_at, placement);
    const steps = await this.repo.find('approval_steps', { campaign_id: id });
    const submission = Math.min(0, ...steps.map((s) => s.submission)) - 1;
    const now = this.now();
    await this.repo.transaction(async (tx) => {
      const locked = await tx.get('campaigns', id, { forUpdate: true });
      if (!locked || JSON.stringify(locked.pending_change) !== JSON.stringify(row.pending_change)) throw new AppError('CONFLICT', 'The change was edited while it was being submitted');
      const next: StoredChange = { ...ch, state: 'in_review', submission, submittedBy: encodeActor(by.actor), submittedAt: now.toISOString() };
      await tx.update('campaigns', id, { pending_change: next as never, updated_at: now, version: locked.version + 1 });
      for (const role of ['advertising', 'content']) await tx.insert('approval_steps', { id: newId(), campaign_id: id, submission, role, reviewer_id: null, state: 'waiting', note: null, decided_at: null });
      const ids = [ch.imageCreativeId, ch.webImageCreativeId].filter((x): x is string => Boolean(x));
      if (ids.length) await tx.updateWhere('creatives', { id: ids, status: ['draft', 'changes_requested'] }, { status: 'in_review' });
      await this.core.log(tx, id, 'change_submitted', by, { reason: `Changed ${ch.changedFields.join(', ')}` });
    });
    await this.core.audit({ action: 'advertising.ad.change-submit', actionLabel: `Sent a change of ad ${row.ref} for review`, target: this.parts.campaigns.target(row), after: { changedFields: ch.changedFields } }, by);
    return this.get(id, viewer);
  }

  /** The role to act with: a requested step picks among the caller's roles (content: Content, else Marketing) */
  private async roleFor(step: 'advertising' | 'content' | null | undefined, by: By): Promise<ReviewRole | undefined> {
    if (!step) return undefined;
    if (step === 'advertising') return 'advertising';
    const roles = await this.core.reviewRolesOf(by);
    return roles.has('content') || !roles.has('marketing') ? 'content' : 'marketing';
  }

  async review(id: string, body: { decision: 'approve' | 'request_changes' | 'reject'; note?: string | null; step?: 'advertising' | 'content' | null }, by: By, viewer: StaffViewer): Promise<StaffAd> {
    if (!isUuid(id)) throw notFound('Ad');
    const row = await this.repo.get('campaigns', id);
    if (!row) throw notFound('Ad');
    const note = body.note?.trim() || null;
    if (body.decision !== 'approve' && !note) throw invalid([{ path: 'note', message: body.decision === 'reject' ? 'Say why it is rejected' : 'Say what needs to change' }]);
    const me = encodeActor(by.actor);
    const ch = this.changeOf(row);
    const role = body.step ? await this.roleFor(body.step, by) : await this.nextRole(row, row.status === 'in_review' ? null : (ch?.submission ?? null), by);
    if (row.status === 'in_review') {
      // the person who made the ad reviews no step of it
      if (row.created_by === me) throw this.ctx.error('SAME_REVIEWER', 'You created this ad; two other people review it.');
      if (body.decision === 'approve') {
        await this.parts.campaigns.approve(id, { role: role ?? null, note }, by);
        await this.startWithoutDate(id);
      } else if (body.decision === 'request_changes') await this.parts.campaigns.requestChanges(id, { role: role ?? null, reason: note! }, by);
      else {
        await this.reviewRoleOn(row, role, by, null);
        await this.parts.campaigns.reject(id, note!, by);
      }
      return this.get(id, viewer);
    }
    if (!ch || ch.state !== 'in_review' || !ch.submission) throw new AppError('ILLEGAL_TRANSITION', 'Nothing of this ad is waiting for review', { from: row.status, event: 'review' });
    if (ch.createdBy === me) throw this.ctx.error('SAME_REVIEWER', 'You made this change; two other people review it.');
    const reviewRole = await this.reviewRoleOn(row, role, by, ch.submission);
    const slot = stepFor(reviewRole, row.advertiser_kind)!;
    const applied = await this.repo.transaction(async (tx) => {
      const locked = await tx.get('campaigns', id, { forUpdate: true });
      const lockedChange = locked ? this.changeOf(locked) : null;
      if (!locked || !lockedChange || lockedChange.submission !== ch.submission || lockedChange.state !== 'in_review') throw new AppError('CONFLICT', 'The change was reviewed or edited meanwhile; reload');
      const steps = await tx.find('approval_steps', { campaign_id: id, submission: ch.submission! });
      const step = steps.find((s) => (slot === 'advertising' ? s.role === 'advertising' : s.role !== 'advertising'));
      if (!step || step.state !== 'waiting') throw new AppError('ILLEGAL_TRANSITION', `The ${slot} step is not waiting`, { from: 'in_review', event: body.decision });
      if (steps.some((s) => s.id !== step.id && s.state === 'approved' && s.reviewer_id === me)) throw this.ctx.error('SAME_REVIEWER', 'You already approved the other step of this change; a second person must approve this one.');
      const decided = { reviewer_id: me, note, decided_at: this.now(), ...(reviewRole === 'marketing' ? { role: 'marketing' } : {}) };
      if (body.decision === 'approve') {
        await tx.update('approval_steps', step.id, { ...decided, state: 'approved' });
        if (!steps.every((s) => s.id === step.id || s.state === 'approved')) {
          await this.core.log(tx, id, 'change_step_approved', by, { reason: `${slot} approved the change${note ? `: ${note}` : ''}` });
          return false;
        }
        await this.applyChange(tx, locked, lockedChange, by);
        return true;
      }
      if (body.decision === 'request_changes') {
        await tx.update('approval_steps', step.id, { ...decided, state: 'changes_requested' });
        await tx.update('campaigns', id, { pending_change: { ...lockedChange, state: 'changes_requested' } as never, updated_at: this.now(), version: locked.version + 1 });
        await this.core.log(tx, id, 'change_changes_requested', by, { reason: note });
        return false;
      }
      for (const s of steps.filter((x) => x.state === 'waiting')) await tx.update('approval_steps', s.id, { ...(s.id === step.id ? decided : { reviewer_id: me, note, decided_at: this.now() }), state: 'rejected' });
      await tx.update('campaigns', id, { pending_change: null, updated_at: this.now(), version: locked.version + 1 });
      await this.core.log(tx, id, 'change_rejected', by, { reason: note });
      return false;
    });
    if (applied) {
      this.parts.serving.invalidate();
      const after = await this.repo.get('campaigns', id);
      if (after?.status === 'scheduled' && after.starts_at && after.starts_at.getTime() <= this.now().getTime()) await this.parts.ops.startDue([id]);
    }
    const label = body.decision === 'approve' ? (applied ? `Approved the change of ad ${row.ref}; it is live` : `Approved the ${slot} step of the change of ad ${row.ref}`) : body.decision === 'reject' ? `Rejected the change of ad ${row.ref}` : `Requested changes to the change of ad ${row.ref}`;
    await this.core.audit({ action: `advertising.ad.change-${body.decision.replace('_', '-')}`, actionLabel: label, target: this.parts.campaigns.target(row), reason: note, after: { step: slot, changedFields: ch.changedFields } }, by);
    return this.get(id, viewer);
  }

  /**
   * Without a requested step: the caller's next open step on the review (advertising first, then content), so a
   * reviewer holding both roles is never asked to choose; one person still never takes both steps of a review.
   */
  private async nextRole(row: CampaignRec, submission: number | null, by: By): Promise<ReviewRole | undefined> {
    const roles = await this.core.reviewRolesOf(by);
    const steps = await this.repo.find('approval_steps', { campaign_id: row.id });
    const latest = submission ?? Math.max(0, ...steps.map((x) => x.submission));
    const current = steps.filter((x) => x.submission === latest);
    const waiting = (slot: string) => current.some((x) => x.state === 'waiting' && (slot === 'advertising' ? x.role === 'advertising' : x.role !== 'advertising'));
    if (roles.has('advertising') && waiting('advertising')) return 'advertising';
    if (waiting('content')) return roles.has('content') ? 'content' : roles.has('marketing') ? 'marketing' : undefined;
    return undefined;
  }

  /** The caller's review role on the ad's open review (initial: positive submission; change: its own) */
  private async reviewRoleOn(row: CampaignRec, requested: ReviewRole | undefined, by: By, submission: number | null): Promise<ReviewRole> {
    const steps = await this.repo.find('approval_steps', { campaign_id: row.id });
    const latest = submission ?? Math.max(0, ...steps.map((s) => s.submission));
    const current = steps.filter((s) => s.submission === latest);
    const waiting = (r: ReviewRole) => {
      const slot = stepFor(r, row.advertiser_kind);
      return current.some((s) => s.state === 'waiting' && (slot === 'advertising' ? s.role === 'advertising' : s.role !== 'advertising'));
    };
    return this.core.reviewRoleFor(by, requested, { applicable: (r) => stepFor(r, row.advertiser_kind) !== null, waiting });
  }

  /** "As soon as approved" with a deal that starts later falls back to schedule: start with the deal (or now) */
  private async startWithoutDate(id: string): Promise<void> {
    const r = await this.repo.get('campaigns', id);
    if (!r || r.starts_at || (r.status !== 'scheduled' && r.status !== 'live')) return;
    const promo = r.linked_promotion_id ? await this.core.optional('promotions', (p) => p.getPublicCampaign(r.linked_promotion_id!)) : null;
    const start = promo?.period?.startsAt ? new Date(promo.period.startsAt) : this.now();
    await this.repo.update('campaigns', id, { starts_at: start.getTime() > this.now().getTime() ? start : this.now() });
    if (r.status === 'scheduled' && start.getTime() <= this.now().getTime()) await this.parts.ops.startDue([id]);
    this.parts.serving.invalidate();
  }

  /** The last approval: the change replaces the live version (inside the review transaction) */
  private async applyChange(tx: AdvertisingRepository, row: CampaignRec, ch: StoredChange, by: By): Promise<void> {
    const links = await tx.find('campaign_creatives', { campaign_id: row.id });
    const creatives = new Map((await tx.getMany('creatives', links.map((l) => l.creative_id))).map((c) => [c.id, c]));
    const live = this.versionOf(row, links, creatives);
    const now = this.now();
    const startsAt = ch.startsAt ? new Date(ch.startsAt) : null;
    await tx.update('campaigns', row.id, {
      name: ch.name,
      alt: ch.alt,
      page_category_ids: (ch.categoryId ? [ch.categoryId] : []) as never,
      destination: (ch.destination ?? { kind: 'url', targetId: null, url: '' }) as never,
      // a running ad keeps its start; a scheduled one moves to the new start (now when cleared)
      ...(row.status === 'live' ? {} : { starts_at: startsAt ?? now }),
      linked_promotion_id: ch.dealId,
      stop_with_promotion: ch.stopWithDeal,
      pending_change: null,
      updated_at: now,
      version: row.version + 1,
    });
    await this.replaceLinks(tx, row.id, live, ch);
    const ids = [ch.imageCreativeId, ch.webImageCreativeId].filter((x): x is string => Boolean(x));
    if (ids.length) await tx.updateWhere('creatives', { id: ids, status: ['draft', 'in_review', 'changes_requested'] }, { status: 'approved' });
    await this.core.log(tx, row.id, 'change_applied', by, { reason: `Changed ${ch.changedFields.join(', ')}` });
  }

  /* ================================================================ lifecycle */

  async pause(id: string, reason: string | null | undefined, by: By, viewer: StaffViewer): Promise<StaffAd> {
    await this.parts.campaigns.pause(id, reason?.trim() || 'Paused by the Advertising team', by, { audit: true });
    return this.get(id, viewer);
  }

  async resume(id: string, reason: string | null | undefined, by: By, viewer: StaffViewer): Promise<StaffAd> {
    await this.parts.campaigns.resume(id, reason?.trim() || null, by, { audit: true });
    return this.get(id, viewer);
  }

  /** End now; a pending change goes with it */
  async end(id: string, reason: string | null | undefined, by: By, viewer: StaffViewer): Promise<StaffAd> {
    await this.parts.campaigns.finish(id, 'stopped_early', reason?.trim() || 'Ended by the Advertising team', by, { audit: true });
    await this.repo.updateWhere('campaigns', { id }, { pending_change: null });
    return this.get(id, viewer);
  }

  async duplicate(id: string, by: By, viewer: StaffViewer): Promise<StaffAd> {
    if (!isUuid(id)) throw notFound('Ad');
    const m = await this.parts.views.model(id);
    const r = m.row;
    if (!isStaffSlot(m.placement.key)) throw invalid([{ path: 'id', message: 'Only ads of the Advertisements page can be duplicated here' }]);
    const links = m.creatives.filter((c) => c.device === 'phone' || c.device === 'desktop' || c.device === 'any');
    const { id: _id, ref: _ref, status: _s, spent: _sp, created_by: _cb, created_at: _ca, updated_at: _ua, version: _v, paused_reason: _pr, paused_by: _pb, paused_at: _pa, pause_cause: _pc, rejected_reason: _rr, finished_reason: _fr, position: _po, pending_change: _pch, alt, ...rest } = r;
    const name = `${r.name} (copy)`.slice(0, 120);
    const row = await this.parts.campaigns.insertDraft({ placement: m.placement, items: [], creatives: links, row: { ...rest, name, starts_at: null, ends_at: null, after_approval: 'schedule', note_to_reviewers: null } }, by, 'create', `Copied from ${r.ref}`, { alt: alt ?? null });
    await this.core.audit({ action: 'advertising.ad.duplicate', actionLabel: `Copied ad ${r.ref} as ${row.ref}`, target: this.parts.campaigns.target(row), relatedTargets: [this.parts.campaigns.target(r)] }, by);
    return this.get(row.id, viewer);
  }

  async remove(id: string, by: By): Promise<void> {
    await this.parts.campaigns.deleteDraft(id, by);
  }

  /** PUT /ads/order: the placement's live and scheduled ads in the new order (1…n); the others follow */
  async reorder(input: StaffAdsOrderInput, by: By, viewer: StaffViewer): Promise<StaffAdsPage> {
    const placement = await this.staffPlacement(input.placementKey);
    const rows = await this.rowsOf([placement]);
    const running = rows.filter((r) => r.status === 'live' || r.status === 'scheduled');
    const ids = input.ids ?? [];
    const set = new Set(ids);
    if (set.size !== ids.length || set.size !== running.length || running.some((r) => !set.has(r.id))) throw invalid([{ path: 'ids', message: `Send every live and scheduled ad of ${placement.name} once (${running.length})` }]);
    const rest = rows.filter((r) => !set.has(r.id)).sort(byPosition);
    const order = [...ids, ...rest.map((r) => r.id)];
    const before = Object.fromEntries(running.map((r) => [r.ref, r.position]));
    await this.repo.transaction(async (tx) => {
      for (const [i, id] of order.entries()) await tx.updateWhere('campaigns', { id }, { position: i + 1 });
    });
    this.parts.serving.invalidate();
    const byId = new Map(rows.map((r) => [r.id, r]));
    await this.core.audit({ action: 'advertising.ad.reorder', actionLabel: `Reordered the ${placement.name}`, target: { type: 'ad_placement', id: placement.id, ref: placement.key, label: placement.name, screen: 'admin/ads' }, before: { order: before }, after: { order: ids.map((id) => byId.get(id)!.ref) } }, by);
    return this.list({ placement: placement.key }, viewer);
  }
}
