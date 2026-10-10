/**
 * Gift cards: batches issued by staff (within approval limits), balance check and redemption into store credit,
 * void and expiry. Codes are random (80 bits) and stored on the cards only as keyed hashes
 * (HMAC-SHA256 with secretFor(config, 'wallet.giftcards')); lookups are rate-limited per caller.
 *
 * The plain codes of a batch exist only sealed on its gift_card_batches row (AES-256-GCM,
 * secretFor(config, 'wallet.gift-card-codes')) until the issuer downloads them once
 * (GET /gift-cards/batches/{id}/codes) or giftCardCodesTtlHours pass; with media enabled they are also written
 * as a private media document (purpose gift_card_codes) returned as codesFileId. Nothing keeps codes in memory.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import { secretFor } from '../../../kernel/lib/secrets.js';
import type * as common from '../../../spec/common.js';
import type { GiftCard, GiftCardBatchInput, WalletOverview } from '../../../spec/wallet.js';
import { giftCardMachine } from '../domain/state-machines.js';
import { openCodes, sealCodes } from '../domain/sealed-codes.js';
import { actorFrom, actorText, detId, hashCode, last4Of, m, newGiftCardCode, normalizeCode, SYSTEM } from '../domain/rules.js';
import { toGiftCard } from '../mappers.js';
import type { GiftCardBatchRow, GiftCardRow } from '../ports.js';
import { conflict, invalid, notFound, Outbox, type By, type Issue, type WalletCore } from './core.js';
import type { Ledger } from './ledger.js';

export const ISSUE_ACTION = 'wallet.gift-cards.issue';
const MAX_BATCH = 1_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Wrong or unusable codes per caller before lookups pause, and for how long */
export const GIFT_CARD_FAILURES = { limit: 5, windowMs: 15 * MIN };
/** Lookups per caller (right or wrong) */
export const GIFT_CARD_LOOKUPS = { limit: 30, windowMs: 60 * MIN };

/** What a batch waiting for approval carries in the approval request (the batch row holds the same) */
interface PendingBatch {
  input: GiftCardBatchInput;
  requestedBy: common.Actor;
  key: string;
}

export interface IssuedBatch {
  batchId: string;
  count: number;
  total: common.Money;
  status: 'issued' | 'pending_approval';
  codesFileId: string | null;
  codesAvailableUntil: string | null;
}

export interface BatchCodes {
  batchId: string;
  codes: string[];
  count: number;
  deliveredAt: string;
}

const paused = (retryAfterMs: number) => new AppError('RATE_LIMITED', 'Too many gift card attempts. Try again later.', { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) });

export class GiftCards {
  constructor(
    private readonly core: WalletCore,
    private readonly ledger: Ledger,
  ) {}

  /** Counts a wrong or unusable code for the caller (kernel rate limits, shared by every server instance) */
  private async countFailure(caller: string) {
    await this.core.ctx.rateLimit(`gift-card-fail:${caller}`, GIFT_CARD_FAILURES);
  }

  private get repo() {
    return this.core.repo;
  }

  #key?: string;
  private hash(normalized: string) {
    this.#key ??= secretFor(this.core.ctx.config, 'wallet.giftcards');
    return hashCode(this.#key, normalized);
  }

  #codesKey?: string;
  private get codesKey() {
    return (this.#codesKey ??= secretFor(this.core.ctx.config, 'wallet.gift-card-codes'));
  }

  private async codesTtlHours(): Promise<number> {
    const v = Number(await this.core.ctx.settings.get('giftCardCodesTtlHours'));
    return Number.isFinite(v) && v > 0 ? v : 24;
  }

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
    const existing = await this.repo.getBatch(batchId);
    if (existing) return this.answer(existing);
    const total = m(input.count * input.amount.amount, input.amount.currency);
    const decision = await this.core.authority(by, ISSUE_ACTION, total);
    if (decision.decision === 'approval_required') {
      // saved pending approval: 201 with status pending_approval (FORMAT.md, Approval responses); no codes until approved
      const pending: PendingBatch = { input, requestedBy: by.actor, key };
      const req = await this.core.requestApproval(by, {
        action: ISSUE_ACTION,
        target: { type: 'gift_card_batch', id: batchId, label: `${input.count} gift cards of ${this.core.fmt(input.amount.amount)}`, screen: 'admin/finance' },
        amount: total,
        summary: `Gift card batch: ${input.count} Ã— ${this.core.fmt(input.amount.amount)} (${input.purpose.replace('_', ' ')})`,
        details: pending,
        reason: input.reason.trim(),
      });
      const saved = await this.repo.insertBatch({ ...this.batchRow(batchId, input, by, key), status: 'pending_approval', approval_request_id: req.id });
      await this.core.audit(
        { action: 'wallet.gift_cards.request_issue', actionLabel: 'Sent a gift card batch for approval', category: 'financial', target: { type: 'gift_card_batch', id: batchId, label: `${input.count} gift cards` }, reason: input.reason.trim(), after: { count: input.count, amount: input.amount, total, purpose: input.purpose, costCenter: input.costCenter ?? null }, approvalRequestId: req.id },
        by,
      );
      return this.answer(saved);
    }
    const issued = await this.create(batchId, input, by, key);
    await this.core.audit(
      { action: 'wallet.gift_cards.issue', actionLabel: 'Issued gift cards', category: 'financial', target: { type: 'gift_card_batch', id: batchId, label: `${input.count} gift cards` }, reason: input.reason.trim(), after: { batchId, count: issued.count, total: issued.total, purpose: input.purpose, costCenter: input.costCenter ?? null }, approvalNote: decision.reason },
      by,
    );
    return issued;
  }

  private batchRow(batchId: string, input: GiftCardBatchInput, by: By, key: string): GiftCardBatchRow {
    return {
      id: batchId,
      count: input.count,
      amount: input.amount.amount,
      currency: input.amount.currency,
      purpose: input.purpose,
      expires_at: input.expiresAt ? new Date(input.expiresAt) : null,
      reason: input.reason.trim(),
      cost_center: input.costCenter ?? null,
      status: 'issued',
      approval_request_id: null,
      codes_ciphertext: null,
      codes_file_id: null,
      codes_delivered_at: null,
      codes_expire_at: null,
      created_by: actorText(by.actor),
      idempotency_key: key,
      created_at: this.core.now(),
    };
  }

  /**
   * Creates the cards (issued â†’ active: they work once handed out) and seals the codes on the batch for one
   * download within giftCardCodesTtlHours. A batch saved pending approval is completed here when approved.
   */
  private async create(batchId: string, input: GiftCardBatchInput, by: By, key: string): Promise<IssuedBatch> {
    const now = this.core.now();
    const ttlHours = await this.codesTtlHours();
    const codes = new Map<string, string>();
    while (codes.size < input.count) {
      const code = newGiftCardCode();
      codes.set(this.hash(normalizeCode(code)!), code);
    }
    const plain = [...codes.values()];
    const sealed = sealCodes(this.codesKey, batchId, plain);
    const codesExpireAt = new Date(now.getTime() + ttlHours * HOUR);
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
    const { batch, created } = await this.repo.transaction(async (tx) => {
      const before = await tx.getBatch(batchId, { forUpdate: true });
      if (before && before.status !== 'pending_approval') return { batch: before, created: false };
      const patch = { status: 'issued' as const, codes_ciphertext: sealed, codes_expire_at: codesExpireAt };
      const b = before ? await tx.updateBatch(batchId, patch) : await tx.insertBatch({ ...this.batchRow(batchId, input, by, key), ...patch });
      if (b.codes_ciphertext !== sealed) return { batch: b, created: false }; // a concurrent call created it
      await tx.insertGiftCards(rows);
      return { batch: b, created: true };
    });
    if (!created) return this.answer(batch);
    let result = batch;
    const media = this.core.ctx.tryUse('media');
    if (media) {
      try {
        const csv = ['code', ...plain].join('\n') + '\n';
        const asset = await media.storeGeneratedFile({
          owner: { kind: 'staff', id: by.actor.kind === 'staff' ? (by.actor.id ?? null) : null, label: by.actor.name ?? null },
          fileName: `gift-cards-${batchId}.csv`,
          contentType: 'text/csv',
          body: new Blob([csv]).stream() as never,
          ttlHours,
          purpose: 'gift_card_codes',
        });
        result = await this.repo.updateBatch(batchId, { codes_file_id: asset.id });
      } catch (err) {
        // the codes stay downloadable from the batch (GET /gift-cards/batches/{id}/codes)
        this.core.ctx.log.warn({ err, batchId }, 'wallet: gift card codes document not stored');
      }
    }
    this.core.ctx.events.publish('wallet.gift_card.issued', { batchId, count: rows.length, total: m(rows.length * input.amount.amount, input.amount.currency), purpose: input.purpose }, { actor: by.actor, requestId: by.requestId });
    return this.answer(result);
  }

  private answer(b: GiftCardBatchRow): IssuedBatch {
    if (b.status === 'rejected') throw conflict('This gift card batch was rejected; issue a new one', { batchId: b.id });
    const issued = b.status === 'issued';
    const open = issued && b.codes_ciphertext && b.codes_expire_at && b.codes_expire_at.getTime() > this.core.now().getTime();
    return {
      batchId: b.id,
      count: b.count,
      total: m(b.count * b.amount, b.currency),
      status: issued ? 'issued' : 'pending_approval',
      codesFileId: issued ? b.codes_file_id : null,
      codesAvailableUntil: open ? b.codes_expire_at!.toISOString() : null,
    };
  }

  /** Only the staff member who issued the batch (for an approved batch: who asked for it) */
  private isIssuer(b: GiftCardBatchRow, by: By): boolean {
    const issuer = actorFrom(b.created_by);
    return by.actor.kind === 'staff' && Boolean(by.actor.id) && issuer?.kind === 'staff' && issuer.id === by.actor.id;
  }

  /**
   * GET /gift-cards/batches/{id}/codes: the plain codes once. The sealed copy is deleted in the same
   * transaction, so a second call (or one after giftCardCodesTtlHours, or before approval) is
   * GIFT_CARD_CODES_UNAVAILABLE. The audit entry names the batch and count only, never a code.
   */
  async codes(batchId: string, by: By): Promise<BatchCodes> {
    const b = await this.repo.getBatch(batchId);
    if (!b) throw notFound('Gift card batch');
    if (!this.isIssuer(b, by)) throw new AppError('FORBIDDEN', 'Only the staff member who issued this batch can download its codes');
    const now = this.core.now();
    const codes = await this.repo.transaction(async (tx) => {
      const x = (await tx.getBatch(batchId, { forUpdate: true }))!;
      if (x.status !== 'issued' || !x.codes_ciphertext || !x.codes_expire_at || x.codes_expire_at.getTime() <= now.getTime()) return null;
      let plain: string[] | null = null;
      try {
        plain = openCodes(this.codesKey, x.id, x.codes_ciphertext);
      } catch (err) {
        this.core.ctx.log.error({ err, batchId }, 'wallet: sealed gift card codes could not be opened');
      }
      await tx.updateBatch(x.id, { codes_ciphertext: null, codes_delivered_at: plain ? now : null });
      return plain;
    });
    if (!codes) throw this.core.ctx.error('GIFT_CARD_CODES_UNAVAILABLE', "This batch's codes were already downloaded, have expired or are not issued yet. Void the batch and issue a new one if the codes were lost.");
    await this.core.audit(
      { action: 'wallet.gift_cards.download_codes', actionLabel: 'Downloaded gift card codes', category: 'financial', target: { type: 'gift_card_batch', id: batchId, label: `${codes.length} gift cards` }, after: { batchId, count: codes.length } },
      by,
    );
    return { batchId, codes, count: codes.length, deliveredAt: now.toISOString() };
  }

  /** Part of wallet.release-stale-holds: undelivered codes past giftCardCodesTtlHours are deleted */
  async clearExpiredCodes(): Promise<number> {
    return this.repo.clearExpiredBatchCodes(this.core.now());
  }

  async onApprovalDecided(e: EventPayload<'access.approval.decided'>) {
    if (e.actionKey !== ISSUE_ACTION) return;
    const batch = e.target?.id ? await this.repo.getBatch(e.target.id) : undefined;
    if (e.outcome !== 'approved') {
      if (batch?.status === 'pending_approval') await this.repo.updateBatch(batch.id, { status: 'rejected' });
      return void this.core.ctx.log.info({ requestId: e.requestId, outcome: e.outcome }, 'wallet: gift card batch not approved');
    }
    if (batch && batch.status !== 'pending_approval') return;
    let p: PendingBatch | undefined;
    if (batch) {
      p = {
        key: batch.idempotency_key,
        requestedBy: actorFrom(batch.created_by) ?? SYSTEM,
        input: { count: batch.count, amount: m(batch.amount, batch.currency), purpose: batch.purpose as GiftCardBatchInput['purpose'], expiresAt: batch.expires_at?.toISOString() ?? null, reason: batch.reason, costCenter: batch.cost_center },
      };
    } else {
      // asked for before batches were recorded: the request carries the batch
      const req = await this.core.ctx.tryUse('access')?.getApproval(e.requestId);
      p = req?.details as PendingBatch | undefined;
    }
    if (!p?.input || !p.key) return void this.core.ctx.log.warn({ requestId: e.requestId }, 'wallet: approved gift card batch without its details');
    const by: By = { actor: p.requestedBy ?? SYSTEM };
    const batchId = detId(`wallet:gift-card-batch:${p.key}`);
    if ((await this.repo.giftCardsOfBatch(batchId)).length) return;
    const issued = await this.create(batchId, p.input, by, p.key);
    await this.core.audit(
      { action: 'wallet.gift_cards.issue', actionLabel: 'Issued gift cards after approval', category: 'financial', target: { type: 'gift_card_batch', id: batchId, label: `${issued.count} gift cards` }, reason: p.input.reason, after: { batchId, count: issued.count, total: issued.total, purpose: p.input.purpose, approvedBy: e.decidedBy ?? null }, approvalRequestId: e.requestId },
      by,
    );
  }

  /* ================================================================ check and redeem */

  /** The card for a code, counting wrong codes per caller; RATE_LIMITED after too many */
  private async lookup(code: string, caller: string): Promise<GiftCardRow> {
    if (!(await this.core.ctx.settings.get('giftCardsEnabled'))) throw this.core.error('GIFT_CARD_INVALID', "Gift cards can't be used yet");
    // too many wrong codes pause every lookup; a paused lookup doesn't count against the lookup limit
    const failures = await this.core.ctx.rateLimit(`gift-card-fail:${caller}`, { ...GIFT_CARD_FAILURES, peek: true });
    if (!failures.allowed) throw paused(failures.retryAfterMs);
    const lookups = await this.core.ctx.rateLimit(`gift-card-lookup:${caller}`, GIFT_CARD_LOOKUPS);
    if (!lookups.allowed) throw paused(lookups.retryAfterMs);
    const normalized = normalizeCode(code ?? '');
    const card = normalized ? await this.repo.giftCardByHash(this.hash(normalized)) : undefined;
    if (!card) {
      await this.countFailure(caller);
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

  /** active â†’ redeemed: the full remaining value becomes a store credit lot (source gift_card) */
  async redeem(code: string, customerId: string, by: By): Promise<WalletOverview> {
    const card = await this.lookup(code, `customer:${customerId}`);
    const out = new Outbox();
    const result = await this.repo.transaction(async (tx) => {
      const c = (await tx.getGiftCard(card.id, { forUpdate: true }))!;
      if (c.state === 'redeemed' && c.redeemed_by === customerId) return 'already' as const; // the same customer again
      if (this.stateOf(c) !== 'active' || c.remaining <= 0) return 'invalid' as const;
      const acct = await tx.lockOrCreateAccount(customerId, c.currency, this.core.now());
      if (acct.currency !== c.currency) return 'invalid' as const;
      const r = await this.ledger.addCredit(tx, acct, { kind: 'gift_card_redeemed', source: 'gift_card', amount: c.remaining, expiresAt: c.expires_at, reference: `gift card â€¢â€¢â€¢â€¢${c.code_last4}`, key: `gift-card:${c.id}`, actor: by.actor });
      await tx.updateGiftCard(c.id, { state: giftCardMachine.next('active', 'redeem'), remaining: 0, redeemed_by: customerId, redeemed_at: this.core.now() });
      out.push('wallet.gift_card.redeemed', { giftCardId: c.id, customerId, amount: m(c.remaining, c.currency) });
      out.push('wallet.credit.granted', { customerId, entryId: r.entry.id, kind: 'gift_card_redeemed', amount: m(c.remaining, c.currency), chargedTo: null, sellerId: null, caseId: null, orderId: null });
      return 'redeemed' as const;
    });
    if (result === 'invalid') {
      await this.countFailure(`customer:${customerId}`);
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
      await this.core.audit({ action: 'wallet.gift_cards.void', actionLabel: 'Voided a gift card', category: 'financial', target: { type: 'gift_card', id, label: `Gift card â€¢â€¢â€¢â€¢${after.code_last4}` }, reason: reason.trim(), before: { state: before.state, remaining: m(before.remaining, before.currency) }, after: { state: after.state } }, by);
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
