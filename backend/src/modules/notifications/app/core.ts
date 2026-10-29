/**
 * Shared context of the notifications use cases: the repository and providers, settings, caches (topic channels, live
 * templates, marketing consent) and the lookups into other modules' public APIs.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { isNotImplemented } from '../../../kernel/errors/index.js';
import { secretFor } from '../../../kernel/lib/secrets.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { ModuleContext } from '../../../kernel/module-system/index.js';
import type { Actor } from '../../../spec/common.js';
import type * as audit from '../../../spec/audit.js';
import type * as customers from '../../../spec/customers.js';
import type * as identity from '../../../spec/identity.js';
import type * as access from '../../../spec/access.js';
import type { NoticeLink, TemplateContent } from '../../../spec/notifications.js';
import { defaultContent, templateChannels, TOPICS, topicDef, topicVariables, type Audience, type Channel, type TopicDef } from '../domain/catalog.js';
import { templateVersionMachine } from '../domain/state-machines.js';
import { channelLive, defaultGroups, defaultMemberChannel, parseReplyToken, replyToken, signToken, verifyToken, type ChannelMap, type MemberAccessLike } from '../domain/rules.js';
import type { MemberPrefRow, Providers, TemplateRow, TopicRow, VersionRow } from '../ports.js';
import type { NotificationsRepository } from '../repository.js';

export const LANGUAGE = 'en-US';
export const SYSTEM: Actor = { kind: 'system' };


const TTL_MS = 30_000;

/** Template content equality regardless of key order (jsonb reorders keys) */
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
const sameContent = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Items by key, in their order */
export function groupBy<T, K>(items: Iterable<T>, key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const x of items) {
    const k = key(x);
    const list = out.get(k);
    if (list) list.push(x);
    else out.set(k, [x]);
  }
  return out;
}

export const actorText = (a: Actor) => JSON.stringify({ kind: a.kind, ...(a.id ? { id: a.id } : {}), ...(a.name ? { name: a.name } : {}) });
export function actorOfText(s: string | null | undefined): Actor {
  if (!s) return SYSTEM;
  try {
    const a = JSON.parse(s) as Actor;
    if (a && typeof a.kind === 'string') return a;
  } catch {
    /* plain text */
  }
  return { kind: 'staff', name: s };
}

export interface NotificationsCoreDeps {
  repo: NotificationsRepository;
  ctx: ModuleContext<'notifications'>;
  providers: Providers;
}

export class Core {
  readonly repo: NotificationsRepository;
  readonly ctx: ModuleContext<'notifications'>;
  readonly providers: Providers;
  #seeding: Promise<void> | undefined;
  #channels: { at: number; map: Map<string, Partial<ChannelMap>> } | undefined;
  #live: { at: number; map: Map<string, VersionRow> } | undefined;
  #consent = new Map<string, { at: number; prefs: customers.MarketingPreferences }>();
  #secret: string;

  constructor(deps: NotificationsCoreDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
    this.providers = deps.providers;
    this.#secret = secretFor(deps.ctx.config, 'notifications.tokens');
  }

  now = () => this.ctx.clock.now();
  /** Public app address for links in emails when a notice has no url (STORE_URL, SELLER_URL, ADMIN_URL) */
  appUrl(audience: Audience): string {
    const u = this.ctx.config.publicUrls;
    // external contacts (suppliers, rights owners) can only open public store pages
    return audience === 'customer' || audience === 'external' ? u.store : audience === 'seller' ? u.seller : u.admin;
  }
  get launchPhase() {
    return this.ctx.config.launchPhase;
  }
  get timeZone() {
    return this.ctx.config.market.timeZone;
  }
  get log() {
    return this.ctx.log;
  }

  /* ---------------------------------------------------------------- settings */
  setting = <K extends Parameters<ModuleContext<'notifications'>['settings']['get']>[0]>(key: K) => this.ctx.settings.get(key);

  /* ---------------------------------------------------------------- topic catalogue */

  topic(key: string): TopicDef | undefined {
    return topicDef(key);
  }

  /** Seeds topics and default templates (idempotent; staff changes to channels and templates are kept) */
  ensureSeeded(): Promise<void> {
    this.#seeding ??= this.#seed().catch((err) => {
      this.#seeding = undefined;
      throw err;
    });
    return this.#seeding;
  }

  async #seed() {
    const now = this.now();
    const rows: TopicRow[] = TOPICS.map((t) => ({
      key: t.key,
      audience: t.audience,
      category: t.category,
      group_key: t.group,
      label: t.label,
      description: t.description,
      triggers: t.triggers,
      opens: t.opens,
      channels: t.channels,
      action_required: t.actionRequired,
      staff_role_keys: t.staffRoleKeys,
      seller_permission: t.sellerPermission,
      owner_only: t.ownerOnly,
      frequency_label: t.frequencyLabel,
      variables: topicVariables(t) as never,
      phase: t.phase,
      updated_by: null,
      updated_at: null,
    }));
    await this.repo.upsertTopics(rows);
    const senders = (await this.setting('senders')) as Record<string, string>;
    const by = actorText(SYSTEM);
    const items = TOPICS.flatMap((t) =>
      templateChannels(t).map((channel) => {
        const template: TemplateRow = { id: newId(), topic_key: t.key, channel, language: LANGUAGE, live_version_id: null, updated_at: now };
        const version: VersionRow = {
          id: newId(),
          template_id: template.id,
          version: 1,
          status: 'published',
          content: defaultContent(t, channel, senders) as never,
          note: 'Default template',
          created_by: by,
          created_at: now,
          published_by: by,
          published_at: now,
        };
        return { template, version };
      }),
    );
    await this.repo.seedTemplates(items);
    await this.refreshDefaultTemplates();
  }

  /**
   * Templates nobody edited (every version written by the system) follow the current default content: when
   * the default changed since they were seeded (e.g. the purchase order email's "Deliver to" line on installs
   * seeded before it), a new published system version replaces the live one and the old one is superseded.
   * A template with any staff version (draft, published or discarded) is left alone. Runs with the boot seed,
   * idempotent: the defaults live in code and the senders setting, which a data migration cannot see.
   */
  async refreshDefaultTemplates(): Promise<number> {
    const senders = (await this.setting('senders')) as Record<string, string>;
    const by = actorText(SYSTEM);
    const templates = (await this.repo.listTemplates()).filter((t) => t.language === LANGUAGE && t.live_version_id);
    const versions = await this.repo.versionsOf(templates.map((t) => t.id));
    const byTemplate = new Map<string, VersionRow[]>();
    for (const v of versions) byTemplate.set(v.template_id, [...(byTemplate.get(v.template_id) ?? []), v]);
    let refreshed = 0;
    for (const t of templates) {
      const def = topicDef(t.topic_key);
      if (!def || !templateChannels(def).includes(t.channel as Channel)) continue;
      const own = byTemplate.get(t.id) ?? [];
      if (!own.length || own.some((v) => v.created_by !== by || (v.published_by != null && v.published_by !== by))) continue;
      const live = own.find((v) => v.id === t.live_version_id);
      const content = defaultContent(def, t.channel as Channel, senders);
      if (!live || sameContent(live.content, content)) continue;
      const done = await this.repo.transaction(async (tx) => {
        const now = this.now();
        // the template is locked before it is written, and before its versions: that is this module's lock
        // order, and publish() takes the two the same way round (docs/10 §11.2 rules 1 and 3)
        const current = await tx.getTemplate(t.id, { forUpdate: true });
        if (current?.live_version_id !== live.id) return false; // changed meanwhile
        const prev = await tx.getVersion(live.id, { forUpdate: true });
        if (prev?.status === 'published') await tx.updateVersion(live.id, { status: templateVersionMachine.next('published', 'supersede') });
        const version: VersionRow = {
          id: newId(),
          template_id: t.id,
          version: Math.max(...own.map((v) => v.version)) + 1,
          status: 'published',
          content: content as never,
          note: 'Default template updated',
          created_by: by,
          created_at: now,
          published_by: by,
          published_at: now,
        };
        await tx.insertVersion(version);
        await tx.updateTemplate(t.id, { live_version_id: version.id, updated_at: now });
        return true;
      });
      if (done) refreshed++;
    }
    if (refreshed) {
      this.invalidateTemplates();
      this.log.info({ refreshed }, 'notifications: never-edited templates moved to the current default content');
    }
    return refreshed;
  }

  /** Channel switches per topic (cached briefly) */
  async channelMap(): Promise<Map<string, Partial<ChannelMap>>> {
    await this.ensureSeeded();
    const c = this.#channels;
    if (c && Date.now() - c.at < TTL_MS) return c.map;
    const rows = await this.repo.listTopics();
    const map = new Map(rows.map((r) => [r.key, (r.channels ?? {}) as Partial<ChannelMap>]));
    this.#channels = { at: Date.now(), map };
    return map;
  }

  async channelsOf(key: string): Promise<Partial<ChannelMap>> {
    return (await this.channelMap()).get(key) ?? {};
  }

  invalidateTopics() {
    this.#channels = undefined;
  }

  async live(t: TopicDef, channel: Channel): Promise<boolean> {
    return channelLive(t, await this.channelsOf(t.key), channel, this.launchPhase);
  }

  /** Live template version of a topic and channel (falls back to the seeded default content) */
  async liveTemplate(t: TopicDef, channel: Channel): Promise<{ versionId: string | null; content: TemplateContent }> {
    await this.ensureSeeded();
    let c = this.#live;
    if (!c || Date.now() - c.at >= TTL_MS) {
      const rows = await this.repo.liveVersions();
      c = { at: Date.now(), map: new Map(rows.map((r) => [`${r.topic_key}|${r.channel}`, r.version])) };
      this.#live = c;
    }
    const v = c.map.get(`${t.key}|${channel}`);
    if (v) return { versionId: v.id, content: v.content as unknown as TemplateContent };
    return { versionId: null, content: defaultContent(t, channel, (await this.setting('senders')) as Record<string, string>) };
  }

  invalidateTemplates() {
    this.#live = undefined;
  }

  /* ---------------------------------------------------------------- links and tokens */

  linkUrl(audience: Audience, link: NoticeLink): string {
    if (link.url) return link.url;
    return `${this.appUrl(audience)}/${link.screen.replace(/^\/+/, '')}/${encodeURIComponent(link.id)}`;
  }

  sign(payload: Record<string, unknown>) {
    return signToken(this.#secret, payload);
  }

  verify<T>(token: string): T | null {
    return verifyToken<T>(this.#secret, token);
  }

  replyToken(module: 'support' | 'messaging', refId: string, email: string): string {
    return replyToken(this.#secret, module, refId, email, new Date(this.now().getTime() + 90 * 86_400_000));
  }

  parseReply(token: string, fromEmail: string) {
    return parseReplyToken(this.#secret, token, fromEmail, this.now());
  }

  encryptToken(token: string): Uint8Array {
    const key = createHash('sha256').update(`${this.#secret}:push`).digest();
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([c.update(token, 'utf8'), c.final()]);
    return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), body]));
  }

  decryptToken(data: Uint8Array): string | null {
    try {
      const buf = Buffer.from(data);
      const key = createHash('sha256').update(`${this.#secret}:push`).digest();
      const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------------- other modules */

  get identity(): identity.IdentityPublicApi {
    return this.ctx.use('identity');
  }

  /** Accounts by id; empty when identity cannot answer yet (names and addresses are then unknown) */
  async accounts(ids: (string | null | undefined)[]): Promise<Map<string, identity.AccountSummary>> {
    const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    if (!unique.length) return new Map();
    try {
      const list = await this.identity.getAccounts(unique);
      return new Map(list.map((a) => [a.id, a]));
    } catch (err) {
      if (!isNotImplemented(err)) throw err;
      this.log.debug({ err }, 'identity.getAccounts is not available; names and addresses unknown');
      return new Map();
    }
  }

  async account(id: string): Promise<identity.AccountSummary | null> {
    return (await this.accounts([id])).get(id) ?? null;
  }

  get customers() {
    return this.ctx.tryUse('customers');
  }

  get sellers() {
    return this.ctx.tryUse('sellers');
  }

  /**
   * Every active seller (approved or restricted), walked page by page through sellers.searchSellers: the "all
   * sellers" target of routing (platform changes) and announcements. Empty when sellers is off.
   */
  async activeSellerIds(): Promise<string[]> {
    const api = this.sellers;
    if (!api) return [];
    const out: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 200; i++) {
      const page = await api.searchSellers({ statuses: ['approved', 'restricted'] }, { limit: 100, ...(cursor ? { cursor } : {}) });
      out.push(...page.items.map((s) => s.id));
      if (!page.nextCursor || !page.items.length) break;
      cursor = page.nextCursor;
    }
    return [...new Set(out)];
  }

  get access() {
    return this.ctx.tryUse('access');
  }

  async customer(customerId: string): Promise<customers.CustomerSnapshot | null> {
    return (await this.customers?.getCustomer(customerId)) ?? null;
  }

  async customerByAccount(accountId: string): Promise<customers.CustomerSnapshot | null> {
    const api = this.customers;
    if (!api) return null;
    try {
      return await api.getCustomerByUserId(accountId);
    } catch (err) {
      if (isNotImplemented(err)) return null;
      throw err;
    }
  }

  /** Promotional consent (cached; refreshed by customers.marketing_preferences.changed) */
  async consent(customerId: string): Promise<customers.MarketingPreferences | null> {
    const hit = this.#consent.get(customerId);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.prefs;
    const api = this.customers;
    if (!api) return null;
    const prefs = await api.getMarketingConsent(customerId);
    this.rememberConsent(customerId, prefs);
    return prefs;
  }

  /** Caches a customer's consent; the oldest entry goes past 50,000 (a broadcast reads every customer's) */
  rememberConsent(customerId: string, prefs: customers.MarketingPreferences) {
    this.#consent.delete(customerId); // re-inserted last: the eviction order follows the latest read
    this.#consent.set(customerId, { at: Date.now(), prefs });
    if (this.#consent.size > 50_000) this.#consent.delete(this.#consent.keys().next().value!);
  }

  forgetConsent(customerId: string) {
    this.#consent.delete(customerId);
  }

  /**
   * Members of a seller for fan-out: stored preference rows plus the active members sellers knows of who never
   * opened Seller Center (default preferences), so an owner gets essential email from day one. Owner-only topics
   * ask sellers.ownerOf; everything else sellers.listMembers. When sellers cannot answer, the stored rows only.
   */
  async sellerMembers(sellerId: string, ownerOnly = false): Promise<MemberPrefRow[]> {
    const stored = await this.repo.memberPreferences(sellerId);
    const api = this.sellers;
    if (!api) return stored;
    let active: { memberId: string; accountId: string; isOwner: boolean }[];
    try {
      if (ownerOnly) {
        const owner = await api.ownerOf(sellerId);
        active = owner ? [{ ...owner, isOwner: true }] : [];
      } else active = await api.listMembers(sellerId);
    } catch (err) {
      if (!isNotImplemented(err)) throw err;
      this.log.debug({ err, sellerId }, 'sellers.listMembers is not available; members known from their visits only');
      return stored;
    }
    const known = new Set(stored.map((r) => r.account_id));
    const out = ownerOnly ? stored.filter((r) => active.some((a) => a.accountId === r.account_id)) : [...stored];
    for (const m of active) {
      if (known.has(m.accountId)) continue;
      out.push({ seller_id: sellerId, member_id: m.memberId, account_id: m.accountId, groups: defaultGroups(m.isOwner) as never, channel: defaultMemberChannel(m.isOwner), updated_by: actorText(SYSTEM), updated_at: this.now() });
    }
    return out;
  }

  async memberAccess(sellerId: string, accountId: string): Promise<MemberAccessLike | null> {
    const api = this.sellers;
    if (!api) return null;
    return (await api.getMemberAccess(sellerId, accountId)) ?? null;
  }

  /** A seller's store name for templates (null when sellers is off or the seller is unknown) */
  async sellerName(sellerId: string): Promise<string | null> {
    const api = this.sellers;
    if (!api) return null;
    try {
      return (await api.getSeller(sellerId))?.storeName ?? null;
    } catch (err) {
      if (!isNotImplemented(err)) throw err;
      return null;
    }
  }

  async resolveRole(roleKey: string): Promise<access.RecipientResolution | null> {
    const api = this.access;
    if (!api) return null;
    return api.resolveRecipients(roleKey);
  }

  /* ---------------------------------------------------------------- audit */

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: { actor: Actor; requestId?: string }) {
    try {
      await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId });
    } catch (err) {
      // the change is committed; a missing audit entry is logged, never turned into a failed request
      this.ctx.log[isNotImplemented(err) ? 'debug' : 'error']({ err, action: entry.action }, 'audit entry not recorded');
    }
  }
}
