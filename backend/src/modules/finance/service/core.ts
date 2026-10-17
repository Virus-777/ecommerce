/**
 * Shared plumbing of the finance use cases: time, settings, events, audit, optional modules, seller
 * lookups, approvals and the seller ledger itself (posting entries under a row lock on the seller account,
 * moving earnings lots between pending and available). The use cases live in the part classes.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isNotImplemented } from '../../../kernel/errors/index.js';
import type { EventMap } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { StateMachine } from '../../../kernel/lib/state-machine.js';
import type { ModuleContext, PublicApiMap } from '../../../kernel/module-system/index.js';
import type * as access from '../../../spec/access.js';
import type * as audit from '../../../spec/audit.js';
import type * as common from '../../../spec/common.js';
import type { DestinationStatus, FeeTreatment, Reference } from '../../../spec/finance.js';
import { DEFAULT_TREATMENT, detId, encodeActor, m, marketDate, SYSTEM, type EntryType, type RuleModel } from '../domain/rules.js';
import { earningsLotMachine } from '../domain/state-machines.js';
import type { AccountRec, DestinationRec, EntryRec, LotRec, PayoutProvider, ReviewRec, RuleSetRec } from '../ports.js';
import type { FinanceRepository } from '../repository.js';

export interface FinanceServiceDeps {
  repo: FinanceRepository;
  ctx: ModuleContext<'finance'>;
  provider: PayoutProvider;
}

/** Who acts, as the HTTP layer (or an event) knows it */
export interface By {
  actor: common.Actor;
  requestId?: string;
  principal?: Principal | null;
  can?: (permission: string) => Promise<boolean>;
}

type OwnEvent = keyof EventMap & `finance.${string}`;
type Optional = Parameters<ModuleContext<'finance'>['tryUse']>[0];
type SettingKey = Parameters<ModuleContext<'finance'>['settings']['get']>[0];

export const invalid = (issues: { path: string; message: string }[], message = 'Some details need fixing') => new AppError('VALIDATION_FAILED', message, { issues });
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);

/** Events to publish once the transaction has committed */
export class Outbox {
  readonly items: { name: OwnEvent; payload: unknown }[] = [];
  push<N extends OwnEvent>(name: N, payload: EventMap[N]) {
    this.items.push({ name, payload });
  }
}

export type Bucket = 'pending' | 'available' | 'held';

export interface NewEntry {
  /** Idempotency key (source_event_id): the same fact never posts twice */
  key: string;
  type: EntryType;
  amount: number;
  bucket: Bucket;
  ref: { kind: Reference['kind']; id: string; label?: string | null };
  description: string;
  lotId?: string | null;
  recordedBy?: common.Actor | null;
  statementId?: string | null;
}

export interface Parts {
  ledger: import('./ledger.js').LedgerPart;
  fees: import('./fees.js').FeesPart;
  holds: import('./holds.js').HoldsPart;
  payouts: import('./payouts.js').PayoutsPart;
  statements: import('./statements.js').StatementsPart;
  destinations: import('./destinations.js').DestinationsPart;
  reports: import('./reports.js').ReportsPart;
  recon: import('./recon.js').ReconPart;
  credits: import('./credits.js').CreditsPart;
}

export class Core {
  readonly repo: FinanceRepository;
  readonly ctx: ModuleContext<'finance'>;
  readonly provider: PayoutProvider;
  parts!: Parts;
  #rulesReady?: Promise<void>;

  constructor(deps: FinanceServiceDeps) {
    this.repo = deps.repo;
    this.ctx = deps.ctx;
    this.provider = deps.provider;
  }

  now = () => this.ctx.clock.now();
  currency = () => this.ctx.config.market.currency || 'USD';
  tz = () => this.ctx.config.market.timeZone || 'America/Los_Angeles';
  /** Market date YYYY-MM-DD */
  today = (at: Date = this.now()) => marketDate(at, this.tz());
  money = (amount: number) => m(amount, this.currency());
  setting = <K extends SettingKey>(key: K) => this.ctx.settings.get(key);

  async num(key: SettingKey, fallback: number): Promise<number> {
    const v = await this.setting(key);
    const n = typeof v === 'object' && v !== null && 'amount' in (v as object) ? Number((v as common.Money).amount) : Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  publish<N extends OwnEvent>(name: N, payload: EventMap[N], by: { actor?: common.Actor; requestId?: string } = {}) {
    this.ctx.events.publish(name as never, payload as never, { actor: by.actor ?? SYSTEM, ...(by.requestId ? { requestId: by.requestId } : {}) });
  }

  flush(out: Outbox, by: { actor?: common.Actor; requestId?: string } = {}) {
    for (const e of out.items.splice(0)) this.publish(e.name, e.payload as never, by);
  }

  async audit(entry: Omit<audit.RecordInput, 'actor' | 'module' | 'requestId'>, by: By) {
    try {
      await this.ctx.tryUse('audit')?.record({ ...entry, actor: by.actor, module: this.ctx.name, requestId: by.requestId ?? null });
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, action: entry.action }, 'finance: audit entry not written');
    }
  }

  /** Calls an optional module; off, not built or failing → undefined (reads degrade, the response still answers) */
  async optional<M extends Optional, R>(module: M, fn: (api: PublicApiMap[M & keyof PublicApiMap]) => Promise<R>): Promise<R | undefined> {
    const api = this.ctx.tryUse(module) as PublicApiMap[M & keyof PublicApiMap] | undefined;
    if (!api) return undefined;
    try {
      return await fn(api);
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err, module }, `finance: ${module} could not answer`);
      return undefined;
    }
  }

  step<S extends string = string>(machine: StateMachine<string, string>, from: string, event: string, to?: string): S {
    return machine.next(from as never, event as never, to as never) as S;
  }

  principalOf(by: By): Principal {
    if (by.principal) return by.principal;
    return { kind: 'staff', audience: 'admin', accountId: by.actor.id ?? null, sessionId: `finance:${by.actor.kind}`, name: by.actor.name ?? null };
  }

  /* ---------------------------------------------------------------- lookups */

  /** Store names and seller codes (SL-20714) of sellers, batched */
  async sellerInfo(ids: readonly (string | null | undefined)[]): Promise<Map<string, { name: string; code: string; status: string }>> {
    const wanted = [...new Set(ids.filter((i): i is string => typeof i === 'string' && i.length > 0))];
    const out = new Map<string, { name: string; code: string; status: string }>();
    if (!wanted.length) return out;
    try {
      for (const s of await this.ctx.use('sellers').getSellers(wanted)) out.set(s.id, { name: s.storeName, code: s.ref, status: s.status });
    } catch (err) {
      if (!isNotImplemented(err)) this.ctx.log.warn({ err }, 'finance: seller names unavailable');
    }
    for (const id of wanted) if (!out.has(id)) out.set(id, { name: 'Seller', code: `SL-${id.slice(0, 5).toUpperCase()}`, status: 'unknown' });
    return out;
  }

  async sellerName(id: string): Promise<string> {
    return (await this.sellerInfo([id])).get(id)!.name;
  }

  /** Staff name and role label (access) */
  async staffRef(id: string | null | undefined): Promise<access.StaffRef | null> {
    if (!id) return null;
    return (await this.optionalDep(() => this.ctx.use('access').getStaffRef(id))) ?? null;
  }

  /** A call to a dependency that may still be unbuilt in some setups: NOT_IMPLEMENTED → undefined */
  async optionalDep<R>(fn: () => Promise<R>): Promise<R | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (isNotImplemented(err)) return undefined;
      throw err;
    }
  }

  /* ---------------------------------------------------------------- approvals */

  async approvalInfo(id: string | null | undefined): Promise<common.ApprovalInfo | null> {
    if (!id) return null;
    return (await this.optionalDep(() => this.ctx.use('access').approvalInfo(id))) ?? { required: true, approvalRequestId: id, approvers: [] };
  }

  async approvalInfos(ids: readonly (string | null | undefined)[]): Promise<Map<string, common.ApprovalInfo>> {
    const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    const infos = await Promise.all(unique.map((id) => this.approvalInfo(id)));
    return new Map(unique.map((id, i) => [id, infos[i]!]));
  }

  /** access.check: the only source of "allowed" (granting access never grants financial authority) */
  async authority(by: By, action: string, amount?: number): Promise<access.AuthorityCheck> {
    const check = await this.ctx.use('access').check(this.principalOf(by), action, amount === undefined ? undefined : { money: this.money(amount) });
    if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'Your role has no authority for this', { action });
    return check;
  }

  async requestApproval(by: By, input: Omit<access.RequestApprovalInput, 'requestedBy'>): Promise<access.ApprovalRequest> {
    return this.ctx.use('access').requestApproval({ ...input, requestedBy: this.principalOf(by) });
  }

  /**
   * Above access stepUpAbove whoever acts on money confirms with their password again (owner decision 2026-10-14:
   * staff have no 2-step): a re-auth token for purpose approval issued to this session, from POST
   * /api/admin/identity/reauth. Claimed here (single use); STEP_UP_REQUIRED otherwise. Give it back with
   * releaseReauth when the action then fails, so the retry can use it again.
   */
  async claimApprovalReauth(by: By, token: string | null | undefined, message: string): Promise<string> {
    const refuse = () => new AppError('STEP_UP_REQUIRED', message, { kind: 'reauth', purpose: 'approval' });
    const identity = this.ctx.tryUse('identity');
    if (!token || !identity || !by.principal) throw refuse();
    if (!(await identity.verifyReauthToken(by.principal, token, 'approval'))) throw refuse();
    if (!(await identity.consumeReauthToken(token))) throw refuse();
    return token;
  }

  async releaseReauth(token: string | null): Promise<void> {
    // best effort: an unreleased token only means the person enters the password once more
    if (token) await this.ctx.tryUse('identity')?.releaseReauthToken(token).catch(() => undefined);
  }

  approvalRequired(request: { id: string; ref?: string | null }, details: Record<string, unknown>, message = 'Above your limit: this needs approval') {
    return new AppError('APPROVAL_REQUIRED', message, { approvalRequestId: request.id, ...(request.ref ? { approvalRef: request.ref } : {}), ...details });
  }

  /* ---------------------------------------------------------------- fee rules */

  /** The default rule set (10% after seller discounts, shipping excluded) exists from the start */
  async ensureRules(): Promise<void> {
    this.#rulesReady ??= (async () => {
      if (await this.repo.count('fee_rule_sets', { status: 'active' })) return;
      await this.repo.insertIfAbsent('fee_rule_sets', {
        id: detId('finance:fee_rule_set:default'),
        version: 'v1',
        status: 'active',
        basis: 'after_seller_discounts',
        include_shipping: false,
        platform_discounts_reduce_fee: false,
        default_rate_bps: 1000,
        treatment: DEFAULT_TREATMENT as never,
        agreement_version: '2026-01',
        effective_from: new Date('2026-01-01T00:00:00Z'),
        reason: 'Launch fee rules',
        approval_request_id: null,
        created_by: encodeActor(SYSTEM)!,
        created_at: new Date('2026-01-01T00:00:00Z'),
      });
    })().catch((err) => {
      this.#rulesReady = undefined;
      throw err;
    });
    return this.#rulesReady;
  }

  async ruleModel(row: RuleSetRec, repo: FinanceRepository = this.repo): Promise<RuleModel> {
    const rates = await repo.find('fee_category_rates', { rule_set_id: row.id });
    const treatment = (row.treatment ?? {}) as unknown as FeeTreatment;
    return {
      id: row.id,
      version: row.version,
      basis: row.basis as RuleModel['basis'],
      includeShipping: row.include_shipping,
      platformDiscountsReduceFee: row.platform_discounts_reduce_fee,
      defaultRateBps: row.default_rate_bps,
      categoryRates: new Map(rates.map((r) => [r.category_id, r.rate_bps])),
      treatment: { ...DEFAULT_TREATMENT, ...treatment },
    };
  }

  /** The rule set in force at an instant (the active one; superseded ones by effective date for the past) */
  async ruleAt(at: Date, overrideSetId?: string | null): Promise<RuleSetRec> {
    await this.ensureRules();
    if (overrideSetId) {
      const o = await this.repo.get('fee_rule_sets', overrideSetId);
      if (o) return o;
    }
    const candidates = await this.repo.find('fee_rule_sets', { status: ['active', 'superseded'], effective_from: { op: '<=', value: at } }, { orderBy: [['effective_from', 'desc'], ['created_at', 'desc']], limit: 1 });
    return candidates[0] ?? (await this.repo.findOne('fee_rule_sets', { status: 'active' }))!;
  }

  async activeRule(): Promise<RuleSetRec> {
    await this.ensureRules();
    return (await this.repo.findOne('fee_rule_sets', { status: 'active' }, { orderBy: [['effective_from', 'desc']] }))!;
  }

  /* ---------------------------------------------------------------- the ledger */

  /**
   * Posts entries to a seller's ledger inside a transaction. Locks the seller account row, skips entries
   * whose key was already posted (event redelivery), keeps the bucket balances and the running balance,
   * flags a negative available balance and offsets amounts owed when earnings come in.
   */
  async post(tx: FinanceRepository, sellerId: string, entries: NewEntry[], out: Outbox): Promise<EntryRec[]> {
    const now = this.now();
    const acct = await tx.lockAccount(sellerId, this.currency(), now);
    let { pending, available, held } = acct;
    const posted: EntryRec[] = [];
    const lotNet = new Map<string, number>();
    for (const e of entries) {
      if (!Number.isSafeInteger(e.amount)) throw new AppError('VALIDATION_FAILED', 'Ledger amounts are whole minor units');
      if (e.amount === 0) continue;
      // an entry whose key was posted before is skipped by the upsert on source_event_id (one round trip, no read first)
      if (e.bucket === 'pending') pending += e.amount;
      else if (e.bucket === 'held') held += e.amount;
      else available += e.amount;
      const row: EntryRec = {
        id: newId(),
        seller_id: sellerId,
        at: now,
        type: e.type,
        ref_kind: e.ref.kind,
        ref_id: e.ref.id,
        ref_label: e.ref.label ?? null,
        description: e.description,
        amount: e.amount,
        currency: this.currency(),
        bucket: e.bucket,
        balance_after: pending + available + held,
        lot_id: e.lotId ?? null,
        statement_id: e.statementId ?? null,
        recorded_by: encodeActor(e.recordedBy ?? null),
        source_event_id: e.key,
      };
      if (!(await tx.insertIfAbsent('ledger_entries', row, ['source_event_id']))) {
        // already posted (a redelivered event, or a concurrent posting of the same fact): undo the bucket change
        if (e.bucket === 'pending') pending -= e.amount;
        else if (e.bucket === 'held') held -= e.amount;
        else available -= e.amount;
        continue;
      }
      posted.push(row);
      if (e.lotId) lotNet.set(e.lotId, (lotNet.get(e.lotId) ?? 0) + e.amount);
    }
    for (const [lotId, delta] of lotNet) {
      const lot = await tx.get('earnings_lots', lotId, { forUpdate: true });
      if (lot) await tx.update('earnings_lots', lotId, { net: lot.net + delta });
    }
    await this.saveAccount(tx, acct, { pending, available, held }, out, posted.at(-1));
    return posted;
  }

  /** Writes new bucket balances, tracks negative available balances and offsets amounts owed */
  async saveAccount(tx: FinanceRepository, before: AccountRec, next: { pending: number; available: number; held: number }, out: Outbox, cause?: EntryRec) {
    const now = this.now();
    let negativeSince = before.negative_since;
    if (next.available < 0 && !negativeSince) {
      negativeSince = now;
      out.push('finance.balance.negative', { sellerId: before.seller_id, available: this.money(next.available), cause: cause ? { kind: cause.ref_kind as Reference['kind'], id: cause.ref_id, ref: cause.ref_label ?? null } : { kind: 'seller', id: before.seller_id, ref: null } });
    } else if (next.available >= 0) negativeSince = null;
    await tx.updateWhere('seller_accounts', { seller_id: before.seller_id }, { pending: next.pending, available: next.available, held: next.held, negative_since: negativeSince, updated_at: now });
    if (next.available > before.available) {
      // new earnings offset amounts owed first: what is still owed is at most the negative balance
      const owed = await tx.find('amounts_owed', { seller_id: before.seller_id, status: 'open' }, { orderBy: [['since', 'asc']] });
      let stillOwed = Math.max(0, -next.available);
      for (const o of owed.slice().reverse()) {
        const remaining = Math.min(o.remaining, stillOwed);
        stillOwed -= remaining;
        if (remaining !== o.remaining) await tx.update('amounts_owed', o.id, { remaining, status: remaining === 0 ? 'settled' : 'open', note: remaining === 0 ? 'Covered by later earnings' : o.note });
      }
    }
  }

  /** A lot leaves pending (available or reversed): its net moves from pending to available */
  async moveLot(tx: FinanceRepository, lot: LotRec, event: 'makeAvailable' | 'reverse' | 'addToPayout' | 'markPaid' | 'returnToAvailable', out: Outbox, patch: Partial<LotRec> = {}): Promise<LotRec> {
    const state = this.step(earningsLotMachine, lot.state, event);
    if (lot.state === 'pending' && state !== 'pending' && lot.net !== 0) {
      const acct = await tx.lockAccount(lot.seller_id, this.currency(), this.now());
      await this.saveAccount(tx, acct, { pending: acct.pending - lot.net, available: acct.available + lot.net, held: acct.held }, out);
    }
    return tx.update('earnings_lots', lot.id, { state, ...patch });
  }

  /**
   * moveLot for many lots: pending lots one by one (their net moves between balances), the others with one update
   * per state they leave (every transition is still checked against the lot machine)
   */
  async moveLots(tx: FinanceRepository, lots: readonly LotRec[], event: Parameters<Core['moveLot']>[2], out: Outbox, patch: Partial<LotRec> = {}): Promise<void> {
    const byState = new Map<string, string[]>();
    for (const l of lots) {
      if (l.state === 'pending') await this.moveLot(tx, l, event, out, patch);
      else if (byState.has(l.state)) byState.get(l.state)!.push(l.id);
      else byState.set(l.state, [l.id]);
    }
    for (const [from, ids] of byState) await tx.updateWhere('earnings_lots', { id: ids }, { state: this.step(earningsLotMachine, from, event), ...patch });
  }

  /* ---------------------------------------------------------------- payout destinations */

  async destinationOf(sellerId: string, repo: FinanceRepository = this.repo): Promise<Destination> {
    const rows = await repo.find('payout_destinations', { seller_id: sellerId }, { orderBy: [['deposits_sent_at', 'desc']] });
    const review = await repo.findOne('destination_reviews', { seller_id: sellerId, status: 'under_review' }, { orderBy: [['requested_at', 'desc']] });
    return this.destinationFrom(rows, review, await this.num('depositConfirmAttempts', 3));
  }

  /** Destination statuses of several sellers: two reads for all of them */
  async destinationStatuses(sellerIds: readonly string[]): Promise<Map<string, DestinationStatus>> {
    return new Map([...(await this.destinations(sellerIds))].map(([id, d]) => [id, d.status]));
  }

  /** destinationOf for several sellers: two reads for all of them */
  async destinations(sellerIds: readonly string[]): Promise<Map<string, Destination>> {
    const ids = [...new Set(sellerIds)];
    const out = new Map<string, Destination>();
    if (!ids.length) return out;
    const rows = await this.repo.find('payout_destinations', { seller_id: ids }, { orderBy: [['deposits_sent_at', 'desc']] });
    const reviews = await this.repo.find('destination_reviews', { seller_id: ids, status: 'under_review' }, { orderBy: [['requested_at', 'desc']] });
    const attempts = await this.num('depositConfirmAttempts', 3);
    const rowsOf = new Map<string, DestinationRec[]>();
    for (const r of rows) {
      const list = rowsOf.get(r.seller_id);
      if (list) list.push(r);
      else rowsOf.set(r.seller_id, [r]);
    }
    const reviewOf = new Map<string, ReviewRec>();
    for (const r of reviews) if (!reviewOf.has(r.seller_id)) reviewOf.set(r.seller_id, r);
    for (const id of ids) out.set(id, this.destinationFrom(rowsOf.get(id) ?? [], reviewOf.get(id), attempts));
    return out;
  }

  /** A seller's destination rows (newest deposits first) and open review as the status shown everywhere */
  destinationFrom(rows: readonly DestinationRec[], review: ReviewRec | undefined, attempts: number): Destination {
    const active = rows.find((r) => r.active && r.status === 'verified');
    if (active) {
      const status: DestinationStatus = {
        label: active.label,
        status: review ? 'change_under_review' : 'verified',
        verifiedAt: active.verified_at?.toISOString() ?? null,
        pendingChange: review ? { label: review.to_label, requestedAt: review.requested_at.toISOString(), reviewId: review.id, paysCurrentUntilApproved: true } : null,
      };
      const pendingRow = review ? rows.find((r) => r.id === review.destination_id) : undefined;
      if (pendingRow?.deposits_sent_at) {
        status.depositsSentAt = pendingRow.deposits_sent_at.toISOString();
        status.depositAttemptsLeft = Math.max(0, attempts - pendingRow.deposit_attempts);
      }
      return { status, active, latest: pendingRow ?? active, review: review ?? undefined };
    }
    const latest = rows.filter((r) => r.status !== 'replaced')[0] ?? rows[0];
    if (!latest) return { status: { label: 'No payout account', status: 'missing', verifiedAt: null, pendingChange: null } };
    const pendingCheck = latest.status === 'verification_pending';
    return {
      status: {
        label: latest.label,
        status: latest.status === 'rejected' ? 'rejected' : latest.status === 'verified' ? 'verified' : 'verification_pending',
        verifiedAt: latest.verified_at?.toISOString() ?? null,
        pendingChange: null,
        ...(pendingCheck && latest.deposits_sent_at ? { depositsSentAt: latest.deposits_sent_at.toISOString(), depositAttemptsLeft: Math.max(0, attempts - latest.deposit_attempts) } : {}),
      },
      latest,
      review: review ?? undefined,
    };
  }
}

/** A seller's payout destination as finance shows it: the status, the active (verified) one, the latest and an open review */
export interface Destination {
  status: DestinationStatus;
  active?: DestinationRec;
  latest?: DestinationRec;
  review?: ReviewRec;
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
  protected money(amount: number) {
    return this.core.money(amount);
  }
}
