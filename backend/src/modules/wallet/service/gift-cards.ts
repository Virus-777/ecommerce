/**
 * Gift cards: batches issued by staff (within approval limits), balance check and redemption into store credit,
 * void and expiry. Codes are random (80 bits), shown once and stored only as keyed hashes
 * (HMAC-SHA256 with secretFor(config, 'wallet.giftcards')); lookups are rate-limited per caller.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import { secretFor } from '../../../kernel/lib/secrets.js';
import type * as common from '../../../spec/common.js';
import type { GiftCard, GiftCardBatchInput, WalletOverview } from '../../../spec/wallet.js';
import { giftCardMachine } from '../domain/state-machines.js';
import { actorText, detId, hashCode, last4Of, m, newGiftCardCode, normalizeCode, SYSTEM } from '../domain/rules.js';
import { toGiftCard } from '../mappers.js';
import type { GiftCardRow } from '../ports.js';
import { invalid, notFound, Outbox, type By, type Issue, type WalletCore } from './core.js';
import type { Ledger } from './ledger.js';

export const ISSUE_ACTION = 'wallet.gift-cards.issue';
const MAX_BATCH = 1_000;
const MIN = 60_000;
/** Wrong or unusable codes per caller before lookups pause, and for how long */
export const GIFT_CARD_FAILURES = { limit: 5, windowMs: 15 * MIN };
/** Lookups per caller (right or wrong) */
export const GIFT_CARD_LOOKUPS = { limit: 30, windowMs: 60 * MIN };
/** How long a batch's codes wait to be downloaded (once) */
const CODES_TTL_MS = 24 * 60 * MIN;

interface PendingBatch {
  input: GiftCardBatchInput;
  requestedBy: common.Actor;
  key: string;
}

export interface IssuedBatch {
  batchId: string;
  count: number;
  total: common.Money;
  codesFileId: string;
}

/** Fixed windows in memory, per process (like the kernel's rate limits) */
class Limiter {
  #w = new Map<string, { start: number; count: number }>();
  constructor(private readonly now: () => number) {}
  private window(key: string, windowMs: number) {
    const now = this.now();
    let w = this.#w.get(key);
    if (!w || now - w.start >= windowMs) {
      w = { start: now, count: 0 };
      this.#w.set(key, w);
      if (this.#w.size > 50_000) for (const [k, v] of this.#w) if (now - v.start >= windowMs) this.#w.delete(k);
    }
    return w;
  }
  blocked(key: string, l: { limit: number; windowMs: number }) {
    const w = this.window(key, l.windowMs);
    return w.count >= l.limit ? Math.ceil((w.start + l.windowMs - this.now()) / 1000) : 0;
  }
  hit(key: string, l: { limit: number; windowMs: number }) {
    this.window(key, l.windowMs).count++;
  }
}

export class GiftCards {
  readonly #limiter: Limiter;
  /** codesFileId → codes, kept until downloaded once or CODES_TTL_MS (media is not a wallet dependency) */
  readonly #codeFiles = new Map<string, { batchId: string; codes: string[]; until: number }>();

  constructor(
    private readonly core: WalletCore,
    private readonly ledger: Ledger,
  ) {
    this.#limiter = new Limiter(() => this.core.now().getTime());
  }

  private get repo() {
    return this.core.repo;
  }

  #key?: string;
  private hash(normalized: string) {
    this.#key ??= secretFor(this.core.ctx.config, 'wallet.giftcards');
    return hashCode(this.#key, normalized);
  }

  private codesFileId = (batchId: string) => detId(`wallet:gift-card-codes:${batchId}`);

  /* ================================================================ issue */

  async issue(input: GiftCardBatchInput, by: By, key: string): Promise<IssuedBatch> {
    const issues: Issue[] = [...this.core.checkMoney(input.amount, 'amount')];
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_BATCH) issues.push({ path: 'count', message: `Between 1 and ${MAX_BATCH} cards` });
    if (!['promotional', 'customer_service', 'sold'].includes(input.purpose)) issues.push({ path: 'purpose', message: 'Choose a purpose' });
    if (input.expiresAt && new Date(input.expiresAt).getTime() <= this.core.now().getTime()) issues.push({ path: 'expiresAt', message: 'Choose a date in the future' });
    if (!input.reason?.trim()) issues.push({ path: 'reason', message: 'Give a reason' });
    if (!issues.length && !Number.isSafeInteger(input.count * input.amount.amount)) issues.push({ path: 'amount', message: 'The batch total is too large' });
    if (issues.length) throw invalid(issues);
    const batchId = detId(`wallet:gift-card-batch:${key}`);
    const existing = await this.repo.giftCardsOfBatch(batchId);
    if (existing.length) return this.result(existing);
    const total = m(input.count * input.amount.amount, input.amount.currency);
    const decision = await this.core.authority(by, ISSUE_ACTION, total);
    if (decision.decision === 'approval_required') {
      const pending: PendingBatch = { input, requestedBy: by.actor, key };
      const req = await this.core.requestApproval(by, {
        action: ISSUE_ACTION,
        target: { type: 'gift_card_batch', id: batchId, label: `${input.count} gift cards of ${this.core.fmt(input.amount.amount)}`, screen: 'admin/finance' },
        amount: total,
        summary: `Gift card batch: ${input.count} × ${this.core.fmt(input.amount.amount)} (${input.purpose.replace('_', ' ')})`,
        details: pending,
        reason: input.reason.trim(),
      });
      await this.core.audit(
        { action: 'wallet.gift_cards.request_issue', actionLabel: 'Sent a gift card batch for approval', category: 'financial', target: { type: 'gift_card_batch', id: batchId, label: `${input.count} gift cards` }, reason: input.reason.trim(), after: { count: input.count, amount: input.amount, total, purpose: input.purpose, costCenter: input.costCenter ?? null }, approvalRequestId: req.id },
        by,
      );
      throw this.core.approvalRequired(req, { batchId }, 'Above your limit: Finance must approve this gift card batch');
    }
    const issued = await this.create(batchId, input, by);
    await this.core.audit(
      { action: 'wallet.gift_cards.issue', actionLabel: 'Issued gift cards', category: 'financial', target: { type: 'gift_card_batch', id: batchId, label: `${input.count} gift cards` }, reason: input.reason.trim(), after: { ...issued, purpose: input.purpose, costCenter: input.costCenter ?? null }, approvalNote: decision.reason },
      by,
    );
    return issued;
  }

  /** Creates the cards (issued → active: they work once handed out) and keeps the codes for one download */
  private async create(batchId: string, input: GiftCardBatchInput, by: By): Promise<IssuedBatch> {
    const now = this.core.now();
    const codes = new Map<string, string>();
    while (codes.size < input.count) {
      const code = newGiftCardCode();
      codes.set(this.hash(normalizeCode(code)!), code);
    }
    const state = giftCardMachine.next(giftCardMachine.initial, 'activate');
    const rows: GiftCardRow[] = [...codes].map(([hash, code]) => ({
      id: newId(),
      code_hash: hash,
      code_last4: last4Of(normalizeCode(code)!),
      batch_id: batchId,
      initial: input.amount.amount,
      remaining: input.amount.amount,
      currency: input.amount.currency,
      state,
      purpose: input.purpose,
      expires_at: input.expiresAt ? new Date(input.expiresAt) : null,
      redeemed_by: null,
      redeemed_at: null,
      created_by: actorText(by.actor),
      created_at: now,
    }));
    const created = await this.repo.transaction(async (tx) => {
      const again = await tx.giftCardsOfBatch(batchId);
      if (again.length) return false;
      await tx.insertGiftCards(rows);
      return true;
    });
    const result = this.result(created ? rows : await this.repo.giftCardsOfBatch(batchId));
    if (created) {
      this.#codeFiles.set(result.codesFileId, { batchId, codes: [...codes.values()], until: now.getTime() + CODES_TTL_MS });
      this.core.ctx.events.publish('wallet.gift_card.issued', { batchId, count: result.count, total: result.total, purpose: input.purpose }, { actor: by.actor, requestId: by.requestId });
    }
    return result;
  }

  private result(rows: readonly GiftCardRow[]): IssuedBatch {
    const batchId = rows[0]!.batch_id!;
    return { batchId, count: rows.length, total: m(rows.reduce((s, r) => s + r.initial, 0), rows[0]!.currency), codesFileId: this.codesFileId(batchId) };
  }

  /**
   * The batch's codes, once (the "codes file" of the issue response). Kept in memory until downloaded or for
   * 24 hours: media is not a wallet dependency, so there is no stored document yet (spec gap).
   */
  takeCodes(codesFileId: string): { batchId: string; codes: string[] } | null {
    const f = this.#codeFiles.get(codesFileId);
    this.#codeFiles.delete(codesFileId);
    if (!f || f.until < this.core.now().getTime()) return null;
    return { batchId: f.batchId, codes: f.codes };
  }

  async onApprovalDecided(e: EventPayload<'access.approval.decided'>) {
    if (e.actionKey !== ISSUE_ACTION) return;
    if (e.outcome !== 'approved') return void this.core.ctx.log.info({ requestId: e.requestId, outcome: e.outcome }, 'wallet: gift card batch not approved');
    const req = await this.core.ctx.tryUse('access')?.getApproval(e.requestId);
    const p = req?.details as PendingBatch | undefined;
    if (!p?.input || !p.key) return void this.core.ctx.log.warn({ requestId: e.requestId }, 'wallet: approved gift card batch without its details');
    const by: By = { actor: p.requestedBy ?? SYSTEM };
    const batchId = detId(`wallet:gift-card-batch:${p.key}`);
    if ((await this.repo.giftCardsOfBatch(batchId)).length) return;
    const issued = await this.create(batchId, p.input, by);
    await this.core.audit(
      { action: 'wallet.gift_cards.issue', actionLabel: 'Issued gift cards after approval', category: 'financial', target: { type: 'gift_card_batch', id: batchId, label: `${issued.count} gift cards` }, reason: p.input.reason, after: { ...issued, purpose: p.input.purpose, approvedBy: e.decidedBy ?? null }, approvalRequestId: e.requestId },
      by,
    );
  }

  /* ================================================================ check and redeem */

  /** The card for a code, counting wrong codes per caller; RATE_LIMITED after too many */
  private async lookup(code: string, caller: string): Promise<GiftCardRow> {
    if (!(await this.core.ctx.settings.get('giftCardsEnabled'))) throw this.core.error('GIFT_CARD_INVALID', "Gift cards can't be used yet");
    const wait = Math.max(this.#limiter.blocked(`fail:${caller}`, GIFT_CARD_FAILURES), this.#limiter.blocked(`all:${caller}`, GIFT_CARD_LOOKUPS));
    if (wait) throw new AppError('RATE_LIMITED', 'Too many gift card attempts. Try again later.', { retryAfterSeconds: wait });
    this.#limiter.hit(`all:${caller}`, GIFT_CARD_LOOKUPS);
    const normalized = normalizeCode(code ?? '');
    const card = normalized ? await this.repo.giftCardByHash(this.hash(normalized)) : undefined;
    if (!card) {
      this.#limiter.hit(`fail:${caller}`, GIFT_CARD_FAILURES);
      throw this.core.error('GIFT_CARD_INVALID', 'Check the gift card code');
    }
    return card;
  }

  private stateOf(c: GiftCardRow): GiftCard['state'] {
    return c.state === 'active' && c.expires_at && c.expires_at.getTime() <= this.core.now().getTime() ? 'expired' : (c.state as GiftCard['state']);
  }

  async check(code: string, caller: string): Promise<{ remaining: common.Money; expiresAt?: string | null; state: string }> {
    const card = await this.lookup(code, caller);
    const state = this.stateOf(card);
    return { remaining: m(state === 'active' ? card.remaining : 0, card.currency), expiresAt: card.expires_at?.toISOString() ?? null, state };
  }

  /** active → redeemed: the full remaining value becomes a store credit lot (source gift_card) */
  async redeem(code: string, customerId: string, by: By): Promise<WalletOverview> {
    const card = await this.lookup(code, `customer:${customerId}`);
    const out = new Outbox();
    const result = await this.repo.transaction(async (tx) => {
      const c = (await tx.getGiftCard(card.id, { forUpdate: true }))!;
      if (c.state === 'redeemed' && c.redeemed_by === customerId) return 'already' as const; // the same customer again
      if (this.stateOf(c) !== 'active' || c.remaining <= 0) return 'invalid' as const;
      const acct = await tx.lockOrCreateAccount(customerId, c.currency, this.core.now());
      if (acct.currency !== c.currency) return 'invalid' as const;
      const r = await this.ledger.addCredit(tx, acct, { kind: 'gift_card_redeemed', source: 'gift_card', amount: c.remaining, expiresAt: c.expires_at, reference: `gift card ••••${c.code_last4}`, key: `gift-card:${c.id}`, actor: by.actor });
      await tx.updateGiftCard(c.id, { state: giftCardMachine.next('active', 'redeem'), remaining: 0, redeemed_by: customerId, redeemed_at: this.core.now() });
      out.push('wallet.gift_card.redeemed', { giftCardId: c.id, customerId, amount: m(c.remaining, c.currency) });
      out.push('wallet.credit.granted', { customerId, entryId: r.entry.id, kind: 'gift_card_redeemed', amount: m(c.remaining, c.currency), chargedTo: null, sellerId: null, caseId: null, orderId: null });
      return 'redeemed' as const;
    });
    if (result === 'invalid') {
      this.#limiter.hit(`fail:customer:${customerId}`, GIFT_CARD_FAILURES);
      throw this.core.error('GIFT_CARD_INVALID', 'This gift card was already used, voided or has expired');
    }
    this.core.flush(out, by);
    return this.ledger.overview(customerId);
  }

  /* ================================================================ staff */

  async void(id: string, reason: string, by: By): Promise<GiftCard> {
    if (!reason?.trim()) throw invalid([{ path: 'reason', message: 'Give a reason' }]);
    const before = await this.repo.getGiftCard(id);
    if (!before) throw notFound('Gift card');
    const after = await this.repo.transaction(async (tx) => {
      const c = (await tx.getGiftCard(id, { forUpdate: true }))!;
      if (c.state === 'voided') return c;
      return tx.updateGiftCard(id, { state: giftCardMachine.next(c.state as 'active', 'void') });
    });
    if (before.state !== 'voided') {
      await this.core.audit({ action: 'wallet.gift_cards.void', actionLabel: 'Voided a gift card', category: 'financial', target: { type: 'gift_card', id, label: `Gift card ••••${after.code_last4}` }, reason: reason.trim(), before: { state: before.state, remaining: m(before.remaining, before.currency) }, after: { state: after.state } }, by);
    }
    return toGiftCard(after);
  }

  async list(f: { last4?: string; batchId?: string; state?: string }, page: PageRequest): Promise<common.Page<GiftCard>> {
    const p = await this.repo.giftCardsPage(f, page);
    return { ...p, items: p.items.map(toGiftCard) };
  }

  /** Part of wallet.expire-lots: active cards past their expiry become expired */
  async expireDue(): Promise<number> {
    let expired = 0;
    for (const c of await this.repo.dueGiftCards(this.core.now(), 500)) {
      await this.repo.transaction(async (tx) => {
        const x = await tx.getGiftCard(c.id, { forUpdate: true });
        if (x?.state !== 'active' || !x.expires_at || x.expires_at.getTime() > this.core.now().getTime()) return;
        await tx.updateGiftCard(x.id, { state: giftCardMachine.next('active', 'expire') });
        expired++;
      });
    }
    return expired;
  }
}
