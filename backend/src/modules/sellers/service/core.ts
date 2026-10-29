/**
 * Shared plumbing of the sellers use cases: time, settings, events, audit, the seller timeline,
 * optional modules, media references and small lookups. The use cases live in the part classes
 * (applications, accounts, storefront, members, enforcement, performance), which all get one Core.
 */
import { createHash, createHmac } from 'node:crypto';
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { BusinessDays } from '../../../kernel/lib/business-days.js';
import { dateInZone } from '../../../kernel/lib/clock.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { secretFor } from '../../../kernel/lib/secrets.js';
import type { StateMachine } from '../../../kernel/lib/state-machine.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type * as workqueues from '../../../spec/workqueues.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type { AgreementDocument } from '../../../spec/sellers.js';
import { AGREEMENT_KEYS, agreementDocument, DEFAULT_AGREEMENT_VERSION, type AgreementKey } from '../domain/catalogue.js';
import type { StoredPayout } from '../domain/rules.js';
import { taxIdCipher, type TaxIdCipher } from '../crypto.js';
import { actorText, type Refs } from '../mappers.js';
import type { AccountEventRec, ApplicationRec, PayoutChangeRec, PendingChangeRec, SellerRec, SellersProviders } from '../ports.js';
import type { SellersRepository } from '../repository.js';
import type { AccountsPart } from './accounts.js';
import type { ApplicationsPart } from './applications.js';
import type { EnforcementPart } from './enforcement.js';
import type { MembersPart } from './members.js';
import type { PerformancePart } from './performance.js';
import type { StorefrontPart } from './storefront.js';

export interface SellersServiceDeps {
  repo: SellersRepository;
  ctx: ModuleContext<'sellers'>;
  providers: SellersProviders;
}

/** Who acts, as the HTTP layer (or an event) knows it */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
}

export interface Parts {
  applications: ApplicationsPart;
  accounts: AccountsPart;
  storefront: StorefrontPart;
  members: MembersPart;
  enforcement: EnforcementPart;
  performance: PerformancePart;
}

type OwnEvent = keyof EventMap & `sellers.${string}`;
type Optional = Parameters<ModuleContext<'sellers'>['tryUse']>[0];

export const SYSTEM: common.Actor = { kind: 'system', id: null };
export const TRUST_TEAM: common.Actor = { kind: 'system', id: null, name: 'Trust and Risk' };

export const invalid = (issues: { path: string; message: string }[], message = 'Some details need fixing') => new AppError('VALIDATION_FAILED', message, { issues });
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);

export class Core {
  readonly repo: SellersRepository;
  readonly ctx: ModuleContext<'sellers'>;
  readonly providers: SellersProviders;
  parts!: Parts;
  #cipher?: TaxIdCipher;

  constructor(deps: SellersServiceDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
    this.providers = deps.providers;
  }

  get cipher(): TaxIdCipher {
    return (this.#cipher ??= taxIdCipher(secretFor(this.ctx.config, 'sellers.tax-id')));
  }

  now = () => this.ctx.clock.now();
  /** Market date YYYY-MM-DD */
  today = (at: Date = this.now()) => dateInZone(at, this.ctx.config.market.timeZone);
  get tz() {
    return this.ctx.config.market.timeZone;
  }

  /** Business days for review and decision targets: the market's calendar (business hours, closures) */
  readonly businessDays = new BusinessDays({
    load: async () => this.ctx.tryUse('settings')?.businessCalendar(),
    timeZone: () => this.tz,
    now: () => this.now(),
    onError: (err) => this.ctx.log.warn({ err }, 'sellers: business calendar unavailable, counting weekdays'),
  });
  addBusinessDays = (from: Date, days: number) => this.businessDays.add(from, days);
  setting = <K extends Parameters<ModuleContext<'sellers'>['settings']['get']>[0]>(key: K) => this.ctx.settings.get(key);

  publish<N extends OwnEvent>(name: N, payload: EventMap[N], by: { actor?: common.Actor; requestId?: string } = {}) {
    this.ctx.events.publish(name as never, payload as never, { actor: by.actor ?? SYSTEM, ...(by.requestId ? { requestId: by.requestId } : {}) });
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      // the change is committed; a missing audit entry is logged, never turned into a failed request
      this.ctx.log[isNotImplemented(err) ? 'debug' : 'error']({ err, action: entry.action }, 'audit entry not recorded');
    }
  }

  /** One row of the seller timeline (seller-visible unless staff-only) */
  async timeline(
    repo: SellersRepository,
    sellerId: string,
    e: { kind: string; title: string; detail?: string | null; visibility?: 'seller' | 'staff'; actor?: common.Actor | null; ref?: string | null },
  ): Promise<AccountEventRec> {
    const actor = e.actor ?? SYSTEM;
    return repo.insert('account_events', {
      id: newId(),
      seller_id: sellerId,
      kind: e.kind,
      title: e.title,
      detail: e.detail ?? null,
      visibility: e.visibility ?? 'seller',
      actor_kind: actor.kind,
      actor_id: actor.id ?? null,
      ref: e.ref ?? null,
      at: this.now(),
    });
  }

  /**
   * Calls an optional module for a read section. Off, not built yet or failing → `unavailable` gets the
   * section name and the result is undefined (the response still answers).
   */
  async optional<M extends Optional, R>(module: M, section: string, unavailable: string[] | null, fn: (api: PublicApiMap[M & keyof PublicApiMap]) => Promise<R>): Promise<R | undefined> {
    const api = this.ctx.tryUse(module) as PublicApiMap[M & keyof PublicApiMap] | undefined;
    if (!api) {
      if (unavailable && !unavailable.includes(section)) unavailable.push(section);
      return undefined;
    }
    try {
      return await fn(api);
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, module, section }, `sellers: ${module} could not answer for ${section}`);
      if (unavailable && !unavailable.includes(section)) unavailable.push(section);
      return undefined;
    }
  }

  /** MediaRefs for files, looked up in one call; files media does not know (or media down) are null */
  async mediaRefs(ids: readonly (string | null | undefined)[]): Promise<Refs> {
    const wanted = [...new Set(ids.filter((i): i is string => isUuid(i)))];
    const map = new Map<string, common.MediaRef>();
    if (wanted.length) {
      try {
        for (const r of await this.ctx.use('media').refs(wanted)) map.set(r.id, r);
      } catch (err) {
        if (!isNotImplemented(err)) this.ctx.log.warn({ err }, 'sellers: media refs failed');
      }
    }
    return (id) => (id ? (map.get(id) ?? null) : null);
  }

  /** Staff display name (access), or null */
  async staffName(id: string | null | undefined): Promise<string | null> {
    if (!id || !isUuid(id)) return null;
    try {
      return (await this.ctx.use('access').getStaffRef(id))?.name ?? null;
    } catch {
      return null;
    }
  }

  async seller(id: string, o: { repo?: SellersRepository; forUpdate?: boolean } = {}): Promise<SellerRec> {
    const s = isUuid(id) ? await (o.repo ?? this.repo).get('sellers', id, { forUpdate: o.forUpdate }) : undefined;
    if (!s) throw notFound('Seller');
    return s;
  }

  async applicationOf(s: SellerRec, repo: SellersRepository = this.repo): Promise<ApplicationRec | undefined> {
    return s.application_id ? repo.get('applications', s.application_id) : undefined;
  }

  /** Keeps a staff change that waits for a second reviewer (pending_changes); applied on access.approval.decided */
  async savePendingChange(input: { kind: PendingChangeRec['kind']; sellerId?: string | null; targetId?: string | null; approvalRequestId: string; payload: unknown; reason: string; actor: common.Actor }): Promise<PendingChangeRec> {
    return this.repo.insert('pending_changes', {
      id: newId(),
      kind: input.kind,
      seller_id: input.sellerId ?? null,
      target_id: input.targetId ?? null,
      approval_request_id: input.approvalRequestId,
      payload: input.payload as never,
      reason: input.reason,
      requested_by: input.actor as never,
      state: 'pending',
      requested_at: this.now(),
      decided_at: null,
    });
  }

  /** Changes of a kind still waiting for a second reviewer, by target (seller id for closures, restriction id for restriction changes) */
  async pendingChangesFor(kind: PendingChangeRec['kind'], targetIds: string[]): Promise<Map<string, PendingChangeRec>> {
    const out = new Map<string, PendingChangeRec>();
    if (!targetIds.length) return out;
    const rows = await this.repo.find('pending_changes', { kind, state: 'pending', target_id: targetIds }, { orderBy: [['requested_at', 'asc']] });
    for (const r of rows) if (r.target_id) out.set(r.target_id, r); // the latest wins
    return out;
  }

  /** ApprovalInfo of an access approval request (null when access cannot answer) */
  async approvalInfo(id: string | null | undefined): Promise<common.ApprovalInfo | null> {
    if (!id) return null;
    try {
      return await this.ctx.use('access').approvalInfo(id);
    } catch (err) {
      this.ctx.log.warn({ err, id }, 'sellers: approval info unavailable');
      return null;
    }
  }

  /**
   * The pending change of an approval request, marked applied or declined (once: null when already decided).
   * undefined when there is no row (requests made before pending_changes existed keep their payload in access).
   */
  async decidePendingChange(approvalRequestId: string, approved: boolean): Promise<PendingChangeRec | null | undefined> {
    return this.repo.transaction(async (tx) => {
      const row = await tx.findOne('pending_changes', { approval_request_id: approvalRequestId }, { forUpdate: true });
      if (!row) return undefined;
      if (row.state !== 'pending') return null;
      return tx.update('pending_changes', row.id, { state: approved ? 'applied' : 'declined', decided_at: this.now() });
    });
  }

  /**
   * The seller's payout destinations (payout_changes: the verified one is current, the pending one) and
   * blocked reasons. `forUpdate` locks the rows read, for the callers that decide one of them in the same
   * transaction (§11.2 rule 1): they all lock the seller's own row first, so the lock order is the same for
   * every one of them.
   */
  async payoutState(s: SellerRec, repo: SellersRepository = this.repo, o: { forUpdate?: boolean } = {}): Promise<StoredPayout> {
    const rows = await repo.find('payout_changes', { seller_id: s.id }, { orderBy: [['requested_at', 'desc']], forUpdate: o.forUpdate });
    const details = (r: PayoutChangeRec) => ({ accountHolderName: r.account_holder_name, accountType: r.account_type, label: r.label, providerDestinationId: r.provider_destination_id });
    const current = rows.find((r) => r.state === 'verified');
    const pending = rows.find((r) => r.state === 'pending');
    return {
      current: current ? details(current) : null,
      pendingChange: pending ? { ...details(pending), changeId: pending.id, requestedAt: pending.requested_at.toISOString() } : null,
      blockedReasons: Array.isArray(s.payout_blocked_reasons) ? (s.payout_blocked_reasons as unknown[]).map(String) : [],
    };
  }

  /** The state after `event` (ILLEGAL_TRANSITION otherwise) */
  step<S extends string = string>(machine: StateMachine<string, string>, from: string, event: string): S {
    return machine.next(from as never, event as never) as S;
  }

  actorText = actorText;

  /** A staff principal for in-process callers that pass an Actor (trust → requestRestriction) */
  principalOf(by: By): Principal {
    if (by.principal) return by.principal;
    return { kind: 'staff', audience: 'admin', accountId: by.actor.id ?? null, sessionId: `sellers:${by.actor.kind}`, name: by.actor.name ?? null };
  }

  /** Agreement versions in force: content policies when content is on, else the built-in versions */
  async currentAgreements(): Promise<AgreementDocument[]> {
    const base = this.ctx.config.publicUrls.store;
    const fromContent = await this.optional('content', 'agreements', null, (c) => c.currentPolicyVersions([...AGREEMENT_KEYS]));
    return AGREEMENT_KEYS.map((key: AgreementKey) => {
      const v = fromContent?.find((p) => p.policyKey === key);
      return agreementDocument(key, v ? { versionLabel: v.version, policyVersionId: v.versionId, effectiveFrom: v.effectiveAt.slice(0, 10) } : DEFAULT_AGREEMENT_VERSION, base);
    });
  }

  /** Raise a work item when workqueues is on (never fails the caller); sellers names itself as the source */
  async raise(input: Omit<workqueues.RaiseInput, 'sourceModule'>) {
    await this.optional('workqueues', 'workqueues', null, (w) => w.raise({ ...input, sourceModule: 'sellers' }));
  }

  /** Keyed hash (HMAC-SHA256, platform key: purpose platform.tax-id-hash) of a normalised tax id: duplicate checks never see the tax id */
  taxIdHash(digits: string): string {
    return createHmac('sha256', secretFor(this.ctx.config, 'platform.tax-id-hash')).update(`tax:${digits.replace(/\D/g, '')}`).digest('hex');
  }

  /** Plain hash of a value shared with trust (payout token, address key) */
  hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  async resolveWork(dedupeKey: string, note: string, by: common.Actor) {
    await this.optional('workqueues', 'workqueues', null, (w) => w.resolveBySource(dedupeKey, { note, by }));
  }
}

/** Base class of the use-case parts */
export abstract class Part {
  constructor(protected readonly core: Core) {}
  protected get repo() {
    return this.core.repo;
  }
  protected get ctx() {
    return this.core.ctx;
  }
  protected get parts() {
    return this.core.parts;
  }
  protected now() {
    return this.core.now();
  }
}
