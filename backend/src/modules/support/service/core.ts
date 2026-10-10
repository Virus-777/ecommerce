/**
 * Shared plumbing of the support use cases: time, settings, business calendar, events, audit, optional
 * modules, categories, the case aggregate, record scope, timelines and messages.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isAppError } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type { CaseCategory } from '../../../spec/support.js';
import { DEFAULT_CATEGORIES, isOpen, nextActionOf, OFFICIAL_STORE_NAME, SUPPORT_NAME, UNRESOLVED_REMEDY, type NextFacts } from '../domain/rules.js';
import type { AppealRec, CaseFacts, CaseRec, CategoryRec, EventRec, EvidenceRec, ItemRec, MessageRec, OfferRec, RemedyRec, SupportRepository } from '../ports.js';

export interface SupportServiceDeps {
  repo: SupportRepository;
  ctx: ModuleContext<'support'>;
}

/** Who acts, as the HTTP layer (or an event) knows it */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
  can?: (permission: string) => Promise<boolean>;
}

/** One case with everything a view needs */
export interface Agg {
  c: CaseRec;
  items: ItemRec[];
  messages: MessageRec[];
  evidence: EvidenceRec[];
  offers: OfferRec[];
  remedies: RemedyRec[];
  appeals: AppealRec[];
  events: EventRec[];
}

/** Who is looking: the store shopper (customer or guest session), a seller, or staff */
export type Visibility = { area: 'admin' } | { area: 'seller'; sellerId: string } | { area: 'store'; customerId?: string | null; guestSessionId?: string | null };

type OwnEvent = keyof EventMap & `support.${string}`;
type Optional = Parameters<ModuleContext<'support'>['tryUse']>[0];

/** Events collected inside a transaction and published after the commit */
export class Batch {
  readonly events: { name: OwnEvent; payload: unknown }[] = [];
  constructor(readonly by: By) {}
  push<N extends OwnEvent>(name: N, payload: EventMap[N]) {
    this.events.push({ name, payload });
  }
}

export interface TimelineEntry {
  kind: string;
  label: string;
  detail?: string | null;
  visibility: EventRec['visibility'];
  actor?: common.Actor;
  reason?: string | null;
}

export interface NewMessage {
  author: common.Actor;
  authorLabel: string;
  role: 'customer' | 'seller' | 'marketly_staff' | 'internal_note' | 'system';
  audience: 'all' | 'customer' | 'seller' | 'internal';
  body: string;
  mediaIds?: string[];
}

export const SYSTEM: common.Actor = { kind: 'system', id: null };
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const invalid = (issues: { path: string; message: string }[], message = issues[0]?.message ?? 'Check the details and try again') => new AppError('VALIDATION_FAILED', message, { issues });
export const invalidField = (path: string, message: string) => invalid([{ path, message }], message);
export const notFound = (what = 'Case') => new AppError('NOT_FOUND', `${what} not found`);
export const illegal = (message: string, details?: Record<string, unknown>) => new AppError('ILLEGAL_TRANSITION', message, details);

/** Actors kept in text columns (opened_by, added_by, created_by) */
export const actorText = (a: common.Actor) => JSON.stringify({ kind: a.kind, id: a.id ?? null, ...(a.name ? { name: a.name } : {}) });
export function actorFrom(text: string | null | undefined): common.Actor {
  if (!text) return SYSTEM;
  try {
    const v = JSON.parse(text) as common.Actor;
    if (v && typeof v.kind === 'string') return { kind: v.kind, id: v.id ?? null, ...(v.name ? { name: v.name } : {}) };
  } catch {
    /* older rows: kind:id */
  }
  const [kind, id] = text.split(':');
  return { kind: (kind as common.Actor['kind']) || 'system', id: id ?? null };
}

export class Core {
  readonly repo: SupportRepository;
  readonly ctx: ModuleContext<'support'>;
  #categories: Promise<Map<string, CategoryRec>> | null = null;
  #seeded: Promise<void> | null = null;

  constructor(deps: SupportServiceDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
  }

  now = () => this.ctx.clock.now();
  get tz() {
    return this.ctx.config.market.timeZone;
  }
  get currency() {
    return this.ctx.config.market.currency || 'USD';
  }
  error = (code: string, message?: string, details?: unknown) => this.ctx.error(code, message, details);

  publish<N extends OwnEvent>(name: N, payload: EventMap[N], by: { actor?: common.Actor; requestId?: string } = {}) {
    this.ctx.events.publish(name as never, payload as never, { actor: by.actor ?? SYSTEM, ...(by.requestId ? { requestId: by.requestId } : {}) });
  }

  flush(batch: Batch) {
    for (const e of batch.events) this.publish(e.name, e.payload as never, batch.by);
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId' | 'category'> & { category?: audit.RecordInput['category'] }, by: By) {
    await this.soft('audit', 'audit entry', (a) => a.record({ category: 'support', ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null }));
  }

  /** An optional module's answer; off, not built or failing → undefined (the caller degrades) */
  async soft<M extends Optional, R>(module: M, what: string, fn: (api: PublicApiMap[M & keyof PublicApiMap]) => Promise<R>): Promise<R | undefined> {
    const api = this.ctx.tryUse(module) as PublicApiMap[M & keyof PublicApiMap] | undefined;
    if (!api) return undefined;
    try {
      return await fn(api);
    } catch (err) {
      if (!isAppError(err)) this.ctx.log.warn({ err, module, what }, 'support: optional call failed');
      return undefined;
    }
  }

  /** A required module's answer where a view can do without it */
  async quiet<R>(what: string, fn: () => Promise<R>): Promise<R | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (!isAppError(err)) this.ctx.log.warn({ err, what }, 'support: call failed');
      return undefined;
    }
  }

  async setting(key: Parameters<ModuleContext<'support'>['settings']['get']>[0], fallback: number): Promise<number> {
    const v = Number(await this.ctx.settings.get(key).catch(() => fallback));
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  }

  caseRef(): Promise<string> {
    return this.ctx.refs.next('CS', { digits: 4 });
  }

  /* ---------------------------------------------------------------- business calendar */

  async #calendar() {
    const settings = this.ctx.tryUse('settings');
    if (!settings) return null;
    try {
      const [cal, market] = await Promise.all([settings.businessCalendar(), settings.market()]);
      const perDay = new Map<string, number>();
      for (const h of market.businessHours ?? []) {
        const [oh = 0, om = 0] = h.opens.split(':').map(Number);
        const [ch = 0, cm = 0] = h.closes.split(':').map(Number);
        perDay.set(h.weekday, (perDay.get(h.weekday) ?? 0) + Math.max(0, ch * 60 + cm - (oh * 60 + om)));
      }
      const days = [...perDay.values()].filter((m) => m > 0);
      const dayMinutes = days.length ? Math.round(days.reduce((s, m) => s + m, 0) / days.length) : 720;
      return { cal, dayMinutes };
    } catch (err) {
      if (!isAppError(err)) this.ctx.log.warn({ err }, 'support: business calendar unavailable');
      return null;
    }
  }

  /** from + business hours (market hours from settings; plain hours without it) */
  async addBusinessHours(from: Date, hours: number): Promise<Date> {
    const c = await this.#calendar();
    if (!c) return new Date(from.getTime() + hours * HOUR);
    return new Date(c.cal.addBusinessMinutes(from.toISOString(), Math.round(hours * 60)));
  }

  /** from + business days (one business day = the average open hours of an open day) */
  async addBusinessDays(from: Date, days: number): Promise<Date> {
    const c = await this.#calendar();
    if (!c) {
      let t = from.getTime();
      for (let left = days; left > 0; ) {
        t += DAY;
        if (new Date(t).getUTCDay() !== 0) left--;
      }
      return new Date(t);
    }
    return new Date(c.cal.addBusinessMinutes(from.toISOString(), Math.round(days * c.dayMinutes)));
  }

  /* ---------------------------------------------------------------- categories */

  seedCategories(): Promise<void> {
    this.#seeded ??= (async () => {
      const at = this.now();
      await this.repo.seedCategories(
        DEFAULT_CATEGORIES.map((c) => ({
          key: c.key,
          label: c.label,
          audience: c.audience,
          group_key: c.group,
          default_priority: c.defaultPriority,
          team: c.team,
          seller_handles_first: c.sellerHandlesFirst,
          first_response_business_hours: c.firstResponseBusinessHours,
          next_response_business_hours: c.nextResponseBusinessHours,
          resolution_business_days: c.resolutionBusinessDays,
          active: true,
          updated_by: actorText(SYSTEM),
          updated_at: at,
        })),
      );
    })().catch((err) => {
      this.#seeded = null;
      throw err;
    });
    return this.#seeded;
  }

  async categories(): Promise<Map<string, CategoryRec>> {
    this.#categories ??= (async () => {
      await this.seedCategories();
      const rows = await this.repo.find('case_categories', {}, { orderBy: [['key', 'asc']] });
      return new Map(rows.map((r) => [r.key, r]));
    })().catch((err) => {
      this.#categories = null;
      throw err;
    });
    return this.#categories;
  }

  invalidateCategories() {
    this.#categories = null;
  }

  async category(key: string): Promise<CategoryRec | undefined> {
    return (await this.categories()).get(key);
  }

  categoryView(r: CategoryRec): CaseCategory {
    return {
      key: r.key,
      label: r.label,
      audience: r.audience as CaseCategory['audience'],
      group: r.group_key as CaseCategory['group'],
      defaultPriority: r.default_priority as CaseCategory['defaultPriority'],
      team: r.team as CaseCategory['team'],
      sellerHandlesFirst: r.seller_handles_first,
      firstResponseBusinessHours: r.first_response_business_hours,
      nextResponseBusinessHours: r.next_response_business_hours,
      resolutionBusinessDays: r.resolution_business_days,
      active: r.active,
    };
  }

  /* ---------------------------------------------------------------- loading */

  async loadMany(caseIds: readonly string[], repo: SupportRepository = this.repo): Promise<Map<string, Agg>> {
    const ids = [...new Set(caseIds)].filter(isUuid);
    const out = new Map<string, Agg>();
    if (!ids.length) return out;
    const [cases, items, messages, evidence, offers, remedies, appeals, events] = await Promise.all([
      repo.find('cases', { id: ids }),
      repo.find('case_items', { case_id: ids }),
      repo.find('case_messages', { case_id: ids }, { orderBy: [['at', 'asc'], ['id', 'asc']] }),
      repo.find('case_evidence', { case_id: ids }, { orderBy: [['at', 'asc'], ['id', 'asc']] }),
      repo.find('case_offers', { case_id: ids }, { orderBy: [['created_at', 'asc'], ['id', 'asc']] }),
      repo.find('case_remedies', { case_id: ids }, { orderBy: [['created_at', 'asc'], ['id', 'asc']] }),
      repo.find('case_appeals', { case_id: ids }, { orderBy: [['submitted_at', 'asc'], ['id', 'asc']] }),
      repo.find('case_events', { case_id: ids }, { orderBy: [['at', 'asc'], ['id', 'asc']] }),
    ]);
    for (const c of cases) out.set(c.id, { c, items: [], messages: [], evidence: [], offers: [], remedies: [], appeals: [], events: [] });
    for (const x of items) out.get(x.case_id)?.items.push(x);
    for (const x of messages) out.get(x.case_id)?.messages.push(x);
    for (const x of evidence) out.get(x.case_id)?.evidence.push(x);
    for (const x of offers) out.get(x.case_id)?.offers.push(x);
    for (const x of remedies) out.get(x.case_id)?.remedies.push(x);
    for (const x of appeals) out.get(x.case_id)?.appeals.push(x);
    for (const x of events) out.get(x.case_id)?.events.push(x);
    return out;
  }

  async load(caseId: string, repo: SupportRepository = this.repo): Promise<Agg | undefined> {
    return (await this.loadMany([caseId], repo)).get(caseId);
  }

  async byRef(ref: string): Promise<Agg | undefined> {
    const row = (await this.repo.find('cases', { ref: ref.trim().toUpperCase() }))[0] ?? (await this.repo.find('cases', { ref: ref.trim() }))[0];
    return row ? this.load(row.id) : undefined;
  }

  /**
   * A case the caller may reach, or NOT_FOUND: customers their own cases, guest sessions the cases of
   * orders identity granted them, sellers only cases about their own orders (and their own requests), staff any.
   */
  async visible(caseId: string, v: Visibility): Promise<Agg> {
    const agg = isUuid(caseId) ? await this.load(caseId) : undefined;
    if (!agg || !(await this.canSee(agg.c, v))) throw notFound();
    return agg;
  }

  async canSee(c: CaseRec, v: Visibility): Promise<boolean> {
    if (v.area === 'admin') return true;
    if (v.area === 'seller') return !!c.seller_id && c.seller_id === v.sellerId;
    if (c.kind === 'seller_request') return false;
    if (v.customerId && c.customer_id === v.customerId) return true;
    if (v.guestSessionId) {
      if (c.guest_session_id === v.guestSessionId) return true;
      if (!c.order_id || c.customer_id) return false;
      return Boolean(await this.soft('identity', 'guest order access', (i) => i.hasGuestOrderAccess(v.guestSessionId!, c.order_id!)));
    }
    return false;
  }

  /** Runs a write on one case: lock, change, commit, then publish */
  async write<T>(caseId: string, by: By, fn: (tx: SupportRepository, agg: Agg, batch: Batch) => Promise<T>): Promise<T> {
    const batch = new Batch(by);
    const result = await this.repo.transaction(async (tx) => {
      const locked = await tx.get('cases', caseId, { forUpdate: true });
      if (!locked) throw notFound();
      const agg = (await this.load(caseId, tx))!;
      return fn(tx, agg, batch);
    });
    this.flush(batch);
    return result;
  }

  /** Timeline / history entries (inside the transaction) */
  async timeline(tx: SupportRepository, caseId: string, entries: TimelineEntry[]) {
    if (!entries.length) return;
    const at = this.now();
    await tx.insertMany(
      'case_events',
      entries.map((e, i) => ({
        id: newId(),
        case_id: caseId,
        kind: e.kind,
        label: e.label,
        detail: e.detail ?? null,
        visibility: e.visibility,
        actor_kind: e.actor?.kind ?? 'system',
        actor_id: e.actor?.id ?? null,
        reason: e.reason ?? null,
        at: new Date(at.getTime() + i),
      })),
    );
  }

  async message(tx: SupportRepository, caseId: string, m: NewMessage, at: Date = this.now()): Promise<MessageRec> {
    return tx.insert('case_messages', {
      id: newId(),
      case_id: caseId,
      author_kind: m.author.kind,
      author_id: m.author.id ?? null,
      author_label: m.authorLabel,
      role: m.role,
      audience: m.audience,
      body: m.body,
      media_ids: [...new Set(m.mediaIds ?? [])],
      at,
    });
  }

  /** Updates the case row and the stored next action (inside the transaction) */
  async save(tx: SupportRepository, agg: Agg, patch: Partial<CaseRec>, facts?: Partial<CaseFacts>): Promise<CaseRec> {
    const merged = { ...agg.c, ...patch };
    const f = { ...agg.c.next_action.facts, ...(patch.next_action?.facts ?? {}), ...(facts ?? {}) };
    const next = nextActionOf(this.nextFacts({ ...agg, c: { ...merged, next_action: { ...merged.next_action, facts: f } } }), this.now());
    const updated = await tx.update('cases', agg.c.id, { ...patch, next_action: { label: next.label, whoMustAct: next.whoMustAct, note: next.note ?? null, facts: f }, updated_at: this.now() });
    agg.c = updated;
    return updated;
  }

  /** What the next-action rule needs from a case */
  nextFacts(agg: Agg): NextFacts {
    const c = agg.c;
    const f = c.next_action.facts ?? {};
    const now = this.now();
    const openOffer = agg.offers.find((o) => o.status === 'open' && (!o.respond_by || o.respond_by.getTime() > now.getTime()));
    const pending = agg.remedies.find((r) => r.status === 'failed') ?? agg.remedies.find((r) => (UNRESOLVED_REMEDY as readonly string[]).includes(r.status));
    return {
      status: c.status,
      kind: c.kind,
      handler: c.handler_kind,
      handlerName: this.handlerName(c),
      sellerName: f.sellerName ?? (f.ownerType === 'official' ? OFFICIAL_STORE_NAME : 'The seller'),
      dueAt: c.next_response_due_at,
      infoFrom: f.infoRequest?.from ?? null,
      openOffer: openOffer ? { respondBy: openOffer.respond_by } : null,
      pendingRemedy: pending ? { kind: pending.kind, status: pending.status } : null,
      appealDeadline: c.appeal_deadline,
      decisionFinal: c.decision?.final ?? false,
      appealed: agg.appeals.length > 0,
      sellerReplied: !!f.sellerRepliedAt,
      reopenUntil: c.reopen_until,
    };
  }

  handlerName(c: CaseRec): string {
    const f = c.next_action.facts ?? {};
    if (c.handler_kind === 'seller') return f.sellerName ?? 'The seller';
    if (c.handler_kind === 'official_store') return OFFICIAL_STORE_NAME;
    return SUPPORT_NAME;
  }

  isOpen(c: CaseRec) {
    return isOpen(c.status);
  }

  /** Who customer-facing case events reach: the customer, or the contact email for guests */
  recipient(c: CaseRec): { customerId: string | null; contactEmail: string | null } {
    return { customerId: c.customer_id && isUuid(c.customer_id) ? c.customer_id : null, contactEmail: c.next_action.facts?.contactEmail ?? null };
  }

  /** support.case.message_added: the parties a visible message is for */
  messageAdded(c: CaseRec, messageId: string, audience: string, authorRole: string): EventMap['support.case.message_added'] {
    return { caseId: c.id, messageId, ...this.recipient(c), sellerId: c.seller_id, audience, authorRole };
  }

  /* ---------------------------------------------------------------- people and files */

  /** Staff display names, batched (access.getStaffRef) */
  async staffNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unique = [...new Set(ids.filter((x): x is string => !!x && isUuid(x)))];
    await Promise.all(
      unique.map(async (id) => {
        const ref = await this.quiet('staff name', () => this.ctx.use('access').getStaffRef(id));
        if (ref?.name) out.set(id, ref.name);
      }),
    );
    return out;
  }

  /** Records that the case uses files (media usage); media off → the ids are kept as given */
  async attach(ids: string[], refId: string, refLabel: string, owner: { kind: 'seller' | 'staff' | 'customer' | 'guest' | 'platform'; id?: string | null }) {
    const media = this.ctx.tryUse('media');
    if (!media || !ids.length) return;
    const maxMb = await this.setting('maxAttachmentMb', 10);
    for (const id of [...new Set(ids)]) {
      const asset = await media.getAsset(id).catch(() => null);
      if (asset && asset.sizeBytes > maxMb * 1024 * 1024) throw invalidField('mediaIds', `Files can be up to ${maxMb} MB`);
      await media.attach(id, { module: 'support', kind: 'case_evidence', refId, refLabel }, owner);
    }
  }

  async checkAttachments(ids: string[] | null | undefined, path = 'mediaIds') {
    const list = ids ?? [];
    const max = await this.setting('maxAttachments', 5);
    if (list.length > max) throw invalidField(path, `Attach up to ${max} files`);
    const bad = list.find((id) => !isUuid(id));
    if (bad) throw invalidField(path, 'One of the files is not an uploaded file');
  }

  /** MediaRefs for files (media off → a link built from the store address) */
  async mediaRefs(ids: string[]): Promise<Map<string, common.MediaRef>> {
    const unique = [...new Set(ids)].filter(isUuid);
    const out = new Map<string, common.MediaRef>();
    if (!unique.length) return out;
    const refs = await this.soft('media', 'file links', (m) => m.refs(unique, 'medium'));
    for (const r of refs ?? []) out.set(r.id, r);
    const base = (this.ctx.config.publicUrls?.store ?? 'https://store.marketly.test').replace(/\/$/, '');
    for (const id of unique) if (!out.has(id)) out.set(id, { id, url: `${base}/media/${id}` });
    return out;
  }
}
