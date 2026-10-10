/** Reviewer decisions, review drafts, check dismissals, publication (with the override approval) and its impact preview. */
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { AffectedSeller, ProductAdmin, PublicationImpact, ReviewDraft } from '../../../spec/catalog.js';
import { OFFICIAL_STORE_NAME } from '../../../spec/common.js';
import { productReviewMachine, publicationMachine } from '../domain/state-machines.js';
import { evidenceOf, stringMap, toReviewDraft } from '../mappers.js';
import type { BrandRow, OfferIndexRow, ProductRow } from '../ports.js';
import { invalid, notFound, requireReason, type By } from './base.js';
import { CatalogProducts } from './products.js';

export const OVERRIDE_ACTION = 'catalog.products.publication-override';
type Publication = 'active' | 'hidden' | 'suspended';
type Decision = 'approve' | 'requestChanges' | 'reject';

const PUBLICATION_EVENT: Record<Publication, 'activate' | 'hide' | 'suspend'> = { active: 'activate', hidden: 'hide', suspended: 'suspend' };
const DECISION_LOG: Record<Decision, string> = { approve: 'approved', requestChanges: 'changes_requested', reject: 'rejected' };
const DECISION_LABEL: Record<Decision, string> = { approve: 'Approved product', requestChanges: 'Requested product changes', reject: 'Rejected product' };

export class CatalogReview extends CatalogProducts {
  protected productTarget(p: ProductRow) {
    return { type: 'product', id: p.id, ref: p.ref, label: p.title, sellerId: p.owner_seller_id, screen: 'admin/catalog' };
  }

  protected async product(id: string): Promise<ProductRow> {
    const row = await this.repo.getProduct(id);
    if (!row) throw notFound();
    return row;
  }

  /* ================================================================ decisions */

  async approve(id: string, note: string | null | undefined, by: By): Promise<ProductAdmin> {
    const row = await this.product(id);
    productReviewMachine.next(row.review_state as never, 'approve');
    if (row.brand_id) {
      const brand = await this.repo.getBrand(row.brand_id);
      if (brand && brand.status !== 'active') {
        throw new AppError('BRAND_NOT_ACTIVE', `${brand.name} is ${brand.status === 'blocked' ? 'blocked' : 'under review'}; decide the brand first.`, { brandId: brand.id, status: brand.status });
      }
    }
    return this.decide(id, 'approve', { reason: note?.trim() || null, fields: {} }, by);
  }

  async requestChanges(id: string, body: { reason: string; fields: Record<string, string> }, by: By): Promise<ProductAdmin> {
    const reason = requireReason(body.reason);
    const fields = Object.fromEntries(Object.entries(body.fields ?? {}).filter(([k, v]) => k.trim() && String(v ?? '').trim()));
    return this.decide(id, 'requestChanges', { reason, fields }, by);
  }

  async reject(id: string, reason: string, by: By): Promise<ProductAdmin> {
    return this.decide(id, 'reject', { reason: requireReason(reason), fields: {} }, by);
  }

  private async decide(id: string, decision: Decision, input: { reason: string | null; fields: Record<string, string> }, by: By): Promise<ProductAdmin> {
    const { before, after } = await this.decideTx(id, decision, input, by);
    const meta = { actor: by.actor, requestId: by.requestId };
    const ownerSellerId = after.owner_seller_id;
    if (decision === 'approve') this.ctx.events.publish('catalog.product.approved', { productId: id, ownerSellerId }, meta);
    if (decision === 'requestChanges') this.ctx.events.publish('catalog.product.changes_requested', { productId: id, ownerSellerId, reason: input.reason!, fields: input.fields }, meta);
    if (decision === 'reject') this.ctx.events.publish('catalog.product.rejected', { productId: id, ownerSellerId, reason: input.reason! }, meta);
    await this.audit(
      {
        action: `catalog.product.${DECISION_LOG[decision]}`,
        actionLabel: DECISION_LABEL[decision],
        category: 'catalog',
        target: this.productTarget(after),
        reason: input.reason,
        before: { reviewState: before.review_state },
        after: { reviewState: after.review_state, ...(Object.keys(input.fields).length ? { fields: input.fields } : {}) },
        visibleToSeller: Boolean(ownerSellerId),
      },
      by,
    );
    return this.adminView(after, this.staffViewer(by));
  }

  private async decideTx(id: string, decision: Decision, input: { reason: string | null; fields: Record<string, string> }, by: By) {
    const now = this.now();
    return this.repo.transaction(async (tx) => {
      const before = await tx.getProduct(id, { forUpdate: true });
      if (!before) throw notFound();
      const state = productReviewMachine.next(before.review_state as never, decision);
      const sub = await tx.openSubmission(id, { forUpdate: true });
      if (sub) {
        const staff = by.actor.kind === 'staff' && by.actor.id;
        await tx.updateSubmission(sub.id, {
          state: 'decided',
          decided_at: now,
          ...(staff && !sub.assignee_staff_id ? { assignee_staff_id: by.actor.id!, assignee_name: by.actor.name ?? null } : {}),
        });
        await tx.deleteDrafts(sub.id);
      }
      const after = await tx.updateProduct(id, { review_state: state, updated_at: now, ...(decision === 'approve' && !before.listed_at ? { listed_at: now } : {}) });
      await tx.insertLog({ id: newId(), product_id: id, action: DECISION_LOG[decision], reason: input.reason, fields: input.fields as never, actor_kind: by.actor.kind, actor_id: by.actor.id ?? null, at: now });
      return { before, after };
    });
  }

  /** Blocking a requested brand returns its waiting submissions to the seller with changes requested */
  protected override async returnSubmissionsForBlockedBrand(brand: BrandRow, reason: string, by: By) {
    const waiting = (await this.repo.productsOfBrand(brand.id, ['submitted'])).filter((p) => p.requested_brand || brand.requested_for_product_id === p.id);
    for (const p of waiting) {
      await this.decide(p.id, 'requestChanges', { reason: `${brand.name} was not accepted as a brand: ${reason}`, fields: { brandId: 'Choose a listed brand or request another one' } }, by);
    }
  }

  /* ================================================================ review drafts and check dismissals */

  async saveReviewDraft(id: string, body: { decision?: ReviewDraft['decision']; reason?: string | null; fields?: Record<string, string> | null }, by: By): Promise<ReviewDraft> {
    await this.product(id);
    const staffId = by.principal?.accountId ?? by.actor.id;
    if (!staffId) throw new AppError('FORBIDDEN', 'Only a signed-in reviewer can save a review draft');
    const sub = await this.repo.openSubmission(id);
    if (!sub) throw new AppError('ILLEGAL_TRANSITION', 'There is no open submission to review', { from: (await this.product(id)).review_state, event: 'saveReviewDraft' });
    const row = await this.repo.saveDraft({ submission_id: sub.id, staff_id: staffId, decision: body.decision ?? null, reason: body.reason?.trim() || null, fields: (body.fields ?? {}) as never, saved_at: this.now() });
    if (!sub.assignee_staff_id) await this.repo.updateSubmission(sub.id, { assignee_staff_id: staffId, assignee_name: by.actor.name ?? null });
    return toReviewDraft(row, by.actor);
  }

  async dismissCheck(id: string, kind: string, body: { reason: string; matchedProductId?: string | null }, by: By): Promise<ProductAdmin> {
    const reason = requireReason(body.reason);
    const product = await this.product(id);
    const sub = (await this.repo.latestSubmissions([id]))[0];
    const check = sub ? (await this.repo.checksOf([sub.id])).find((c) => c.kind === kind) : undefined;
    if (!sub || !check) throw new AppError('NOT_FOUND', 'No such check on the latest submission');
    const now = this.now();
    const evidence = evidenceOf(check.evidence);
    let matched: string | null = null;
    if (body.matchedProductId) {
      const hit = evidence.filter((e) => e.matchedProductId === body.matchedProductId);
      if (!hit.length) throw new AppError('NOT_FOUND', 'That product is not one of the check findings');
      for (const e of hit) e.dismissedAt = now.toISOString();
      // once every candidate is dismissed, the whole finding is
      matched = evidence.some((e) => e.matchedProductId && !e.dismissedAt) ? body.matchedProductId : null;
    } else {
      for (const e of evidence) if (e.matchedProductId && !e.dismissedAt) e.dismissedAt = now.toISOString();
    }
    await this.repo.transaction(async (tx) => {
      await tx.updateCheck(check.id, { evidence: evidence as never, dismissed_at: now, dismissed_by: by.actor as never, dismiss_reason: reason, dismissed_matched_product_id: matched });
      await tx.insertLog({
        id: newId(),
        product_id: id,
        action: 'check_dismissed',
        reason,
        fields: { check: kind, ...(body.matchedProductId ? { matchedProductId: body.matchedProductId } : {}) } as never,
        actor_kind: by.actor.kind,
        actor_id: by.actor.id ?? null,
        at: now,
      });
    });
    await this.audit(
      {
        action: 'catalog.product.check_dismiss',
        actionLabel: kind === 'duplicate' ? 'Marked not a duplicate' : 'Dismissed a submission check',
        category: 'catalog',
        target: this.productTarget(product),
        reason,
        before: { kind, result: check.result, dismissed: Boolean(check.dismissed_at) },
        after: { kind, matchedProductId: body.matchedProductId ?? null },
      },
      by,
    );
    return this.adminView((await this.repo.getProduct(id))!, this.staffViewer(by));
  }

  /* ================================================================ publication */

  /** The trust report behind the current suspension, if any */
  protected async suspensionReport(p: ProductRow): Promise<{ reportId: string; at: Date } | null> {
    if (p.publication !== 'suspended') return null;
    const log = await this.repo.latestLog(p.id, 'publication_changed');
    const f = stringMap(log?.fields);
    return log && f.to === 'suspended' && f.trustReportId ? { reportId: f.trustReportId, at: log.at } : null;
  }

  async setPublication(id: string, body: { publication: Publication; reason: string; trustReportId?: string | null }, by: By): Promise<ProductAdmin> {
    const after = await this.changePublication(id, { to: body.publication, reason: requireReason(body.reason), trustReportId: body.trustReportId ?? null }, by);
    return this.adminView(after, this.staffViewer(by));
  }

  /**
   * Active / hidden / suspended with a reason. Reactivating a product suspended after a trust report needs a
   * second reviewer (approval action catalog.products.publication-override): the call asks for approval
   * (APPROVAL_REQUIRED with details.approvalRequestId) and the product is reactivated when the request is
   * approved (onApprovalDecidedFromAccess).
   * `opts.claim`: inbox key of the event being handled, claimed with the change (a second delivery changes nothing).
   */
  protected async changePublication(
    id: string,
    input: { to: Publication; reason: string; trustReportId: string | null; trustEnforcementId?: string | null },
    by: By,
    opts: { system?: boolean; claim?: string; approvalRequestId?: string; approvalNote?: string } = {},
  ): Promise<ProductRow> {
    const before = await this.product(id);
    publicationMachine.next(before.publication as Publication, PUBLICATION_EVENT[input.to]);
    let approvalRequestId: string | null = opts.approvalRequestId ?? null;
    let approvalNote: string | null = opts.approvalNote ?? null;
    const report = input.to === 'active' ? await this.suspensionReport(before) : null;
    if (report && !opts.system) ({ approvalRequestId, approvalNote } = await this.overrideApproval(before, report, input.reason, by));

    const now = this.now();
    const after = await this.repo.transaction(async (tx) => {
      if (opts.claim && !(await tx.claim(opts.claim))) return null; // already handled
      const locked = await tx.getProduct(id, { forUpdate: true });
      if (!locked) throw notFound();
      const to = publicationMachine.next(locked.publication as Publication, PUBLICATION_EVENT[input.to]);
      const row = await tx.updateProduct(id, { publication: to, updated_at: now });
      const fields: Record<string, string> = { from: locked.publication, to };
      if (input.trustReportId) fields.trustReportId = input.trustReportId;
      if (input.trustEnforcementId) fields.enforcementId = input.trustEnforcementId;
      if (approvalRequestId) fields.approvalRequestId = approvalRequestId;
      await tx.insertLog({ id: newId(), product_id: id, action: 'publication_changed', reason: input.reason, fields: fields as never, actor_kind: by.actor.kind, actor_id: by.actor.id ?? null, at: now });
      return row;
    });
    if (!after) return before;
    this.ctx.events.publish(
      'catalog.product.publication_changed',
      { productId: id, from: before.publication, to: after.publication, reason: input.reason, trustReportId: input.trustReportId, trustEnforcementId: input.trustEnforcementId ?? null },
      { actor: by.actor, requestId: by.requestId },
    );
    await this.audit(
      {
        action: `catalog.product.${PUBLICATION_EVENT[input.to]}`,
        actionLabel: input.to === 'active' ? 'Reactivated product' : input.to === 'hidden' ? 'Hid product' : 'Suspended product',
        category: 'catalog',
        target: this.productTarget(after),
        reason: input.reason,
        before: { publication: before.publication },
        after: { publication: after.publication, trustReportId: input.trustReportId, ...(input.trustEnforcementId ? { trustEnforcementId: input.trustEnforcementId } : {}) },
        approvalRequestId,
        approvalNote,
        visibleToSeller: Boolean(after.owner_seller_id),
      },
      by,
    );
    return after;
  }

  private async overrideApproval(p: ProductRow, report: { reportId: string; at: Date }, reason: string, by: By): Promise<{ approvalRequestId: string | null; approvalNote: string | null }> {
    const access = this.ctx.tryUse('access');
    if (!access || !by.principal) throw new AppError('APPROVAL_REQUIRED', 'Reactivating a product suspended after a trust report needs a second reviewer, and approvals are unavailable right now', { action: OVERRIDE_ACTION });
    const check = await access.check(by.principal, OVERRIDE_ACTION);
    if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason || 'You cannot reactivate this product', { action: OVERRIDE_ACTION });
    if (check.decision === 'allowed') return { approvalRequestId: null, approvalNote: check.reason || null };
    // an open request for this product is reused; the product is reactivated when it is approved
    const current = (await access.approvalForTargets(by.principal, 'product', [p.id])).get(p.id);
    const request =
      current && ['pending', 'partially_approved'].includes(current.status)
        ? current
        : await access.requestApproval({
            action: OVERRIDE_ACTION,
            target: { type: 'product', id: p.id, ref: p.ref, label: p.title, sellerId: p.owner_seller_id, screen: 'admin/catalog' },
            summary: `Reactivate ${p.ref} ${p.title} (suspended after trust report)`,
            details: { from: 'suspended', to: 'active', trustReportId: report.reportId },
            reason,
            requestedBy: by.principal,
          });
    throw new AppError('APPROVAL_REQUIRED', 'Reactivating a product suspended after a trust report needs a second reviewer. It is reactivated once approved.', {
      approvalRequestId: request.id,
      action: OVERRIDE_ACTION,
    });
  }

  /** What hiding, suspending or reactivating would do (offers, carts, open orders, returns and cases) */
  async publicationImpact(id: string, to: Publication): Promise<PublicationImpact> {
    const p = await this.product(id);
    const from = p.publication as Publication;
    const offers = await this.repo.offersOf([id]);
    let live: OfferIndexRow[] = offers.filter((o) => o.eligible);
    const offersApi = this.ctx.tryUse('offers');
    if (offersApi) {
      const active = await offersApi.listActiveOffersForProduct(id);
      const known = new Map(offers.map((o) => [o.offer_id, o]));
      live = active.map(
        (a) =>
          known.get(a.id) ?? { offer_id: a.id, product_id: id, variant_id: a.variantId, owner_type: a.ownerType, seller_id: null, seller_name: null, condition: a.condition, status: a.status, eligible: true, in_stock: true, price: a.price as never, updated_at: this.now() },
      );
    }
    const stopping = to === 'active' ? [] : from === 'active' ? live : [];
    const sellers = new Map<string, AffectedSeller>();
    for (const o of to === 'active' ? offers.filter((x) => x.status === 'active') : stopping) {
      const key = o.seller_id ?? 'official';
      const cur = sellers.get(key) ?? { sellerId: o.seller_id, name: o.seller_id ? (o.seller_name ?? 'Seller') : OFFICIAL_STORE_NAME, offers: 0 };
      cur.offers++;
      sellers.set(key, cur);
    }
    const cart = this.ctx.tryUse('cart');
    const cartsAffected = cart ? (await Promise.all(stopping.map((o) => cart.countOfferInCarts(o.offer_id)))).reduce((a, b) => a + b, 0) : null;
    const orders = this.ctx.tryUse('orders');
    const openOrders = orders ? ((await orders.countOrderItemsForProducts([id]))[id]?.open ?? 0) : null;
    const returnsApi = this.ctx.tryUse('returns');
    const openReturns = returnsApi ? ((await returnsApi.countOpenReturnsForProducts([id]))[id] ?? 0) : null;
    const support = this.ctx.tryUse('support');
    const openCases = support ? ((await support.countOpenCasesForProducts([id]))[id] ?? 0) : null;
    const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
    const effects: string[] = [];
    if (to === 'active') effects.push(`${plural(offers.filter((o) => o.status === 'active').length, 'offer')} can show again`);
    else effects.push(`${plural(stopping.length, 'offer')} stop showing`);
    if (cartsAffected) effects.push(`${plural(cartsAffected, 'cart')} show the item as unavailable`);
    if (openOrders) effects.push(`${plural(openOrders, 'open order')} continue with their purchase snapshots`);
    if (openReturns) effects.push(`${plural(openReturns, 'open return')} continue`);
    if (openCases) effects.push(`${plural(openCases, 'open case')} continue`);
    const approvalNeeded = to === 'active' && Boolean(await this.suspensionReport(p));
    if (approvalNeeded) effects.push('Needs a second reviewer (suspended after a trust report)');
    return { productId: id, from, to, activeOffers: stopping.length, sellersAffected: [...sellers.values()], cartsAffected, openOrders, openReturns, openCases, effects, approvalNeeded };
  }

  protected invalidPublication(to: string) {
    return invalid('publication', `Unknown publication ${to}`);
  }
}
