/**
 * The seller account: snapshots for other modules, account / setup / launch review, business details,
 * payout account and readiness, agreements, closure, the Verified label and the admin seller views.
 */
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError, isAppError, isNotImplemented } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import { pageOf, toPageRequest, type PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type * as identity from '../../../spec/identity.js';
import type * as reports from '../../../spec/reports.js';
import type {
  AgreementAcceptance,
  AgreementDocument,
  BusinessDetails,
  GoLiveItem,
  LaunchReview,
  MemberAccess,
  PayoutDetails,
  PayoutDetailsInput,
  PayoutReadiness,
  ProductApprovalSummary,
  SellerAccount,
  SellerAdminDetail,
  SellerPayoutsView,
  SellerRow,
  SellerSnapshot,
  SellerStats,
  SetupChecklist,
  SetupStep,
  VerificationLabel,
} from '../../../spec/sellers.js';
import { AGREEMENT_KEYS, type AgreementKey } from '../domain/catalogue.js';
import { addDays, holderMatches, locationOf, payoutLabel, payoutProblems, type StoredPayout, type StoredPayoutDetails, type StoredVerification } from '../domain/rules.js';
import { launchReadinessReviewMachine, payoutReadinessMachine, sellerAccountStatusMachine, verifiedSellerLabelMachine } from '../domain/state-machines.js';
import * as map from '../mappers.js';
import type { ApplicationRec, SellerListFilter, SellerRec } from '../ports.js';
import type { SellersRepository } from '../repository.js';
import { invalid, mapLimit, notFound, Part, SYSTEM, type By } from './core.js';

const SELLING = ['approved', 'restricted', 'suspended'];
const DATASET = 'sellers.admin.accounts';
const LABEL_CHECKS = ['identity', 'business_registration', 'payout_account', 'return_address'];

export type ListSellersQuery = {
  q?: string;
  status?: SellerAccount['status'];
  verified?: boolean;
  onTimeBelow?: number;
  categoryId?: string;
  balance?: 'has_held' | 'negative';
  sort?: 'name' | 'newest' | 'on_time' | 'cases' | 'balance';
};

export class AccountsPart extends Part {
  #datasetRegistered?: Promise<void>;

  /* ---------------------------------------------------------------- snapshots (public API) */

  launchReady = (s: SellerRec) => map.storedLaunch(s).state === 'passed';
  canSellNew = (s: SellerRec) => (s.status === 'approved' || s.status === 'restricted') && this.launchReady(s);

  async snapshots(rows: SellerRec[]): Promise<SellerSnapshot[]> {
    if (!rows.length) return [];
    const active = new Map<string, string[]>();
    for (const r of await this.repo.find('restrictions', { seller_id: rows.map((r) => r.id), state: 'active' })) {
      if (active.has(r.seller_id)) active.get(r.seller_id)!.push(r.id);
      else active.set(r.seller_id, [r.id]);
    }
    return rows.map((s) => ({
      id: s.id,
      ref: s.ref,
      slug: s.slug,
      storeName: s.store_name,
      status: s.status as SellerSnapshot['status'],
      verified: s.verification_state === 'verified',
      canSellNew: this.canSellNew(s),
      activeRestrictionIds: active.get(s.id) ?? [],
      launchReady: this.launchReady(s),
    }));
  }

  async getSeller(sellerId: string) {
    if (!isUuid(sellerId)) return null;
    const s = await this.repo.get('sellers', sellerId);
    return s ? (await this.snapshots([s]))[0]! : null;
  }

  async getSellers(ids: string[]) {
    const rows = await this.repo.getMany('sellers', ids.filter(isUuid));
    const byId = new Map((await this.snapshots(rows)).map((s) => [s.id, s]));
    return ids.map((id) => byId.get(id)).filter((s): s is SellerSnapshot => Boolean(s));
  }

  async searchSellers(f: { search?: string; statuses?: string[]; verified?: boolean; dispatchBelowPct?: number; mainCategoryId?: string }, page: common.PageInput): Promise<common.Page<SellerSnapshot>> {
    const p = await this.repo.listSellers(
      { q: f.search, statuses: f.statuses?.map((s) => s.toLowerCase()), verified: f.verified, onTimeBelow: f.dispatchBelowPct, categoryId: f.mainCategoryId },
      toPageRequest(page),
    );
    return { ...p, items: await this.snapshots(p.items) };
  }

  /* ---------------------------------------------------------------- account */

  async productApproval(sellerId: string, unavailable: string[]): Promise<ProductApprovalSummary | null> {
    const counts = await this.core.optional('catalog', 'productApproval', unavailable, async (c) => (await c.countProductsForSellers([sellerId]))[sellerId]);
    if (!counts) return null;
    const offers = await this.core.optional('offers', 'offers', unavailable, async (o) => {
      const active = await o.listOffersAdmin({ sellerId, status: ['active'] }, { page: 1, limit: 1 });
      const hidden = await o.listOffersAdmin({ sellerId, status: ['paused', 'ineligible', 'out_of_stock'] }, { page: 1, limit: 1 });
      return { active: active.total ?? active.items.length, hidden: hidden.total ?? hidden.items.length };
    });
    return {
      approved: counts.approved,
      inReview: counts.inReview,
      changesRequested: counts.changesRequested,
      rejected: counts.rejected,
      drafts: counts.drafts,
      activeOffers: offers?.active ?? 0,
      hiddenOffers: offers?.hidden ?? 0,
      submissionsBlocked: counts.submissionsBlocked,
    };
  }

  async restrictionSummaries(sellerId: string) {
    return (await this.parts.enforcement.activeRestrictions(sellerId)).map((r) => {
      const route = r.appeal_route as { deadline?: string };
      return { id: r.id, ref: r.ref, title: r.title, since: map.isoReq(r.started_at ?? new Date()), appealDeadline: route?.deadline ?? null, reviewDate: r.review_date };
    });
  }

  async accountManager(s: SellerRec) {
    if (!s.account_manager_id) return null;
    const name = await this.core.staffName(s.account_manager_id);
    return { id: s.account_manager_id, name: name ?? 'Your account manager', replyTarget: 'Replies within 1 business day' };
  }

  /** The account view; staff views also show a closure waiting for a second reviewer and its approval */
  async account(s: SellerRec, me: MemberAccess | null, unavailable: string[] = [], o: { staff?: boolean } = {}): Promise<SellerAccount> {
    const app = await this.core.applicationOf(s);
    const closure = o.staff ? (await this.core.pendingChangesFor('closure', [s.id])).get(s.id) : undefined;
    return {
      id: s.id,
      ref: s.ref,
      storeName: s.store_name,
      legalName: s.legal_name,
      slug: s.slug,
      status: s.status as SellerAccount['status'],
      statusSince: map.isoReq(s.status_since),
      sellerSince: s.approved_at ? this.core.today(s.approved_at) : null,
      verification: map.verificationLabel(s),
      productApproval: SELLING.includes(s.status) || s.status === 'closed' ? await this.productApproval(s.id, unavailable) : null,
      payoutReadiness: map.payoutReadiness(s, await this.core.payoutState(s)),
      activeRestrictions: await this.restrictionSummaries(s.id),
      launchReview: map.launchReview(s),
      pendingAgreements: (await this.pendingAgreements(s.id)).length,
      accountManager: await this.accountManager(s),
      me: me ?? null,
      approval: closure ? await this.core.approvalInfo(closure.approval_request_id) : null,
      pendingChange: closure ? map.pendingStaffChange(closure) : null,
    };
  }

  async getAccount(sellerId: string, me: MemberAccess | null): Promise<SellerAccount> {
    return this.account(await this.core.seller(sellerId), me);
  }

  /* ---------------------------------------------------------------- setup and launch review */

  private firstSubmissionDone(s: SellerRec, pa: ProductApprovalSummary | null) {
    return Boolean(map.storedLaunch(s).firstSubmittedAt) || Boolean(pa && pa.inReview + pa.approved + pa.changesRequested + pa.rejected > 0);
  }

  async setupSteps(s: SellerRec, unavailable: string[]) {
    const app = await this.core.applicationOf(s);
    const profile = await this.repo.getProfile(s.id);
    const pa = await this.productApproval(s.id, unavailable);
    const readiness = map.payoutReadiness(s, await this.core.payoutState(s));
    const coverage = await this.core.optional('shipping', 'shipping_coverage', unavailable, (sh) => sh.hasCoverage(s.id));
    const terms = await this.core.optional('returns', 'return_address', unavailable, async (r) => (await r.sellerReturnTermsFor([s.id]))[s.id]);
    const payoutDone = readiness.state === 'verified' || readiness.state === 'change_under_review';
    const first = this.firstSubmissionDone(s, pa);
    const lr = map.storedLaunch(s);
    const steps: SetupStep[] = [
      {
        key: 'store_profile',
        title: 'Store profile',
        detail: 'Add a logo and a short introduction for your storefront',
        state: profile?.logo_media_id && profile.introduction ? 'done' : 'action_needed',
        source: 'sellers',
        cta: { label: 'Edit storefront', screen: 'seller/store' },
      },
      {
        key: 'shipping_coverage',
        title: 'Shipping coverage',
        detail: 'Choose where you ship, your dispatch time and rates',
        state: coverage === undefined ? 'pending' : coverage ? 'done' : 'action_needed',
        source: 'shipping',
        cta: { label: 'Set up shipping', screen: 'seller/shipping-settings' },
      },
      {
        key: 'return_address',
        title: 'Return address and terms',
        detail: 'Returns sets up your return address from the application',
        state: terms === undefined ? 'pending' : terms ? 'done' : 'action_needed',
        source: 'returns',
        cta: { label: 'Review return terms', screen: 'seller/returns-settings' },
      },
      {
        key: 'payout_verification',
        title: 'Payout account',
        detail: readiness.note,
        state: payoutDone ? 'done' : readiness.state === 'verification_pending' ? 'pending' : 'action_needed',
        source: 'finance',
        cta: { label: 'Open finance', screen: 'seller/finance' },
      },
      {
        key: 'first_submission',
        title: 'First product or offer',
        detail: 'Submit at least one product or offer for review',
        state: first ? 'done' : 'action_needed',
        source: 'catalog',
        cta: { label: 'Add a product', screen: 'seller/products' },
      },
      {
        key: 'launch_review',
        title: 'Launch readiness review',
        detail: 'Your Seller Manager checks everything before your offers go live',
        state: lr.state === 'passed' ? 'done' : lr.state === 'requested' ? 'pending' : !payoutDone || !first ? 'locked' : lr.state === 'changes_needed' ? 'action_needed' : 'not_started',
        source: 'sellers',
        cta: lr.state === 'passed' ? null : { label: 'Ask for the review', screen: 'seller/setup' },
      },
    ];
    const completed = steps.filter((x) => x.state === 'done').length;
    return { steps, completed, total: steps.length, pa, readiness, payoutDone, first };
  }

  statusLine(s: SellerRec, restrictions: { title: string }[]) {
    const base = s.status.replace(/_/g, ' ');
    const label = base.charAt(0).toUpperCase() + base.slice(1);
    return restrictions.length ? `${label} · ${restrictions.map((r) => r.title).join('; ')}` : label;
  }

  async getSetup(sellerId: string): Promise<SetupChecklist> {
    const s = await this.core.seller(sellerId);
    const unavailable: string[] = [];
    const x = await this.setupSteps(s, unavailable);
    return {
      accountStatus: this.statusLine(s, await this.restrictionSummaries(s.id)),
      approvedAt: map.iso(s.approved_at),
      productApproval: x.pa,
      payoutReadiness: x.readiness,
      steps: x.steps,
      completed: x.completed,
      total: x.total,
      launchReview: map.launchReview(s),
      goLivePreview: await this.goLivePreview(s, unavailable),
      accountManager: await this.accountManager(s),
      unavailable,
    };
  }

  private async goLivePreview(s: SellerRec, unavailable: string[]): Promise<GoLiveItem[]> {
    const offers = await this.core.optional('offers', 'goLivePreview', unavailable, async (o) => (await o.listOffersAdmin({ sellerId: s.id }, { page: 1, limit: 20 })).items);
    if (!offers?.length) return [];
    // one row per product: each variant is its own offer, and the product goes live when any of them does
    const byProduct = new Map<string, typeof offers>();
    for (const offer of offers) byProduct.set(offer.productId, [...(byProduct.get(offer.productId) ?? []), offer]);
    const out: GoLiveItem[] = [];
    for (const [productId, productOffers] of byProduct) {
      // catalog answers { product: ProductAdmin, ownsSubmission }; the title is on ProductAdmin.product
      const p = await this.core.optional('catalog', 'goLivePreview', unavailable, (c) => c.getProductForSeller(s.id, productId));
      const reviewState = String(p?.product.reviewState ?? 'approved');
      const goesLive = productOffers.some((o) => o.status === 'draft' || o.status === 'paused' || o.status === 'active');
      const outcome = reviewState !== 'approved' ? 'waits_for_approval' : goesLive ? 'will_go_live' : 'stays_unpublished';
      out.push({ productId, title: p?.product.product.title ?? productOffers[0]!.sellerSku, reviewState, outcome });
    }
    return out;
  }

  async requestLaunchReview(sellerId: string, note: string | null | undefined, by: By): Promise<LaunchReview> {
    const s = await this.core.seller(sellerId);
    if (s.status !== 'approved' && s.status !== 'restricted') throw new AppError('ILLEGAL_TRANSITION', 'Only approved sellers can ask for the launch review', { from: s.status, event: 'request' });
    const x = await this.setupSteps(s, []);
    const missing: string[] = [];
    if (!x.payoutDone) missing.push('payout_verification');
    if (!x.first) missing.push('first_submission');
    if (missing.length) throw new AppError('LAUNCH_REVIEW_NOT_READY', 'Payout verification and a first submission are needed first', { missing });
    const lr = map.storedLaunch(s);
    const state = this.core.step(launchReadinessReviewMachine, lr.state, 'request');
    const after = await this.repo.update('sellers', s.id, { launch_review: { ...lr, state, requestedAt: this.now().toISOString(), note: note?.trim() || null, issues: [] } as never, updated_at: this.now() });
    await this.core.timeline(this.repo, s.id, { kind: 'launch_review_requested', title: 'Launch readiness review requested', detail: note ?? null, actor: by.actor });
    this.core.publish('sellers.launch_review.requested', { sellerId: s.id }, by);
    return map.launchReview(after);
  }

  async decideLaunchReview(sellerId: string, body: { outcome: 'pass' | 'changes_needed'; issues?: string[] | null; note?: string | null }, by: By): Promise<LaunchReview> {
    const s = await this.core.seller(sellerId);
    if (body.outcome === 'changes_needed' && !body.issues?.filter((i) => i.trim()).length) throw invalid([{ path: 'issues', message: 'List what the seller must change' }]);
    const lr = map.storedLaunch(s);
    const state = this.core.step(launchReadinessReviewMachine, lr.state, body.outcome === 'pass' ? 'pass' : 'requestChanges');
    const now = this.now();
    const after = await this.repo.update('sellers', s.id, {
      launch_review: { ...lr, state, decidedAt: now.toISOString(), decidedBy: by.actor, issues: body.issues?.map((i) => i.trim()).filter(Boolean) ?? [], note: body.note?.trim() || null } as never,
      updated_at: now,
    });
    await this.core.timeline(this.repo, s.id, { kind: 'launch_review_decided', title: body.outcome === 'pass' ? 'Launch readiness review passed' : 'Launch review: changes needed', detail: body.note ?? body.issues?.join('; ') ?? null, actor: by.actor });
    this.core.publish('sellers.launch_review.decided', { sellerId: s.id, outcome: state as 'passed' | 'changes_needed', decidedAt: now.toISOString() }, by);
    await this.core.audit(
      {
        action: 'sellers.launch_review.decide',
        actionLabel: body.outcome === 'pass' ? 'Passed the launch readiness review' : 'Asked for launch changes',
        category: 'seller_enforcement',
        target: { type: 'seller', id: s.id, ref: s.ref, label: s.store_name, sellerId: s.id, screen: 'admin/seller' },
        reason: body.note ?? null,
        before: { state: lr.state },
        after: { state, issues: body.issues ?? [] },
        visibleToSeller: true,
      },
      by,
    );
    return map.launchReview(after);
  }

  /** catalog.product.* events: remember the first submission (setup step); counts are read from catalog */
  async onProductEvent(sellerId: string | null | undefined, submitted: boolean) {
    if (!sellerId || !isUuid(sellerId)) return;
    const s = await this.repo.get('sellers', sellerId);
    if (!s) return;
    const lr = map.storedLaunch(s);
    const now = this.now().toISOString();
    await this.repo.update('sellers', s.id, { launch_review: { ...lr, lastProductEventAt: now, ...(submitted && !lr.firstSubmittedAt ? { firstSubmittedAt: now } : {}) } as never });
  }

  /* ---------------------------------------------------------------- business */

  async businessDetails(s: SellerRec): Promise<BusinessDetails> {
    const app = await this.core.applicationOf(s);
    const v = (app?.verification ?? {}) as unknown as StoredVerification;
    return {
      legalName: s.legal_name,
      businessType: s.business_type,
      stateOfRegistration: s.state_of_registration,
      registryNumber: s.registry_number,
      address: s.business_address as unknown as common.Address,
      phone: s.phone,
      website: s.website,
      taxIdType: s.tax_id_type,
      taxIdLast4: s.tax_id_last4,
      owners: (v.owners ?? []).map((o) => ({ id: o.id, name: o.name, ownershipPct: o.ownershipPct, isPrimary: o.isPrimary, idDocumentIds: o.idDocumentIds ?? [], verificationState: o.verificationState })),
      contact: map.businessContact(s.contact),
    };
  }

  /** GET /sellers/{id} (admin): the seller id or its storefront slug (G69a) */
  async sellerIdOf(idOrSlug: string): Promise<string> {
    const slug: string = idOrSlug.trim().toLowerCase();
    if (isUuid(idOrSlug)) return idOrSlug;
    const s = await this.repo.sellerBySlug(slug);
    if (!s) throw notFound('Seller');
    return s.id;
  }

  async getBusinessDetails(sellerId: string) {
    return this.businessDetails(await this.core.seller(sellerId));
  }

  async updateBusinessContact(sellerId: string, body: { name?: string | null; email?: string | null; phone?: string | null; supportHours?: string | null }, by: By) {
    const s = await this.core.seller(sellerId);
    const before = (s.contact ?? {}) as Record<string, unknown>;
    const contact = {
      ...before,
      ...(body.name?.trim() ? { name: body.name.trim() } : {}),
      ...(body.email?.trim() ? { email: body.email.trim().toLowerCase() } : {}),
      ...(body.phone?.trim() ? { phone: body.phone.trim() } : {}),
      ...(body.supportHours !== undefined ? { supportHours: body.supportHours?.trim() || null } : {}),
    };
    const after = await this.repo.update('sellers', s.id, { contact: contact as never, updated_at: this.now() });
    await this.core.timeline(this.repo, s.id, { kind: 'contact_updated', title: 'Contact details updated', actor: by.actor });
    await this.core.audit(
      { action: 'sellers.business.contact', actionLabel: 'Updated seller contact details', category: 'other', target: { type: 'seller', id: s.id, ref: s.ref, label: s.store_name, sellerId: s.id, screen: 'seller/business' }, before, after: contact, visibleToSeller: true },
      by,
    );
    return this.businessDetails(after);
  }

  /* ---------------------------------------------------------------- payout account */

  /** Validate and tokenise bank details (raw numbers never leave this call) */
  async tokenizePayout(d: PayoutDetailsInput, nameCheck?: { legalName?: string; owners: { name: string }[] }): Promise<StoredPayoutDetails> {
    const issues = payoutProblems(d);
    if (nameCheck && !holderMatches(d.accountHolderName, nameCheck.legalName, nameCheck.owners)) {
      issues.push({ path: 'accountHolderName', message: 'The account holder must be the legal business name or an owner' });
    }
    if (issues.length) throw new AppError('PAYOUT_DETAILS_INVALID', issues[0]!.message, { issues });
    const t = await this.core.providers.payouts.tokenize({ accountHolderName: d.accountHolderName.trim(), accountType: d.accountType, routingNumber: d.routingNumber, accountNumber: d.accountNumber });
    if (!t.ok) throw new AppError('PAYOUT_DETAILS_INVALID', t.reason, { issues: [{ path: 'accountNumber', message: t.reason }] });
    return { accountHolderName: d.accountHolderName.trim(), accountType: d.accountType, label: payoutLabel(d.accountType, d.accountNumber), providerDestinationId: t.providerDestinationId };
  }

  private details = (p: StoredPayoutDetails | null | undefined): PayoutDetails | null =>
    p ? { accountHolderName: p.accountHolderName, accountType: p.accountType, label: p.label, providerDestinationId: p.providerDestinationId } : null;

  async getPayoutAccount(sellerId: string) {
    const s = await this.core.seller(sellerId);
    const payout = await this.core.payoutState(s);
    return { current: this.details(payout.current), pendingChange: this.details(payout.pendingChange), readiness: map.payoutReadiness(s, payout) };
  }

  /** Hand a destination to finance: initial (approval) or a change by the owner */
  async submitDestination(tx: SellersRepository, s: SellerRec, details: StoredPayoutDetails, by: By) {
    const payout = await this.core.payoutState(s, tx);
    const isInitial = s.payout_readiness === 'not_added';
    const event = isInitial ? 'submitDestination' : 'requestChange';
    if (!payoutReadinessMachine.can(s.payout_readiness as never, event as never)) {
      throw new AppError('CONFLICT', s.payout_readiness === 'blocked' ? 'Payouts are blocked; contact your Seller Manager' : 'A payout account change is already being verified', { readiness: s.payout_readiness });
    }
    const changeId = newId();
    const requestedAt = this.now();
    await tx.insert('payout_changes', {
      id: changeId,
      seller_id: s.id,
      kind: isInitial ? 'initial' : 'change',
      account_holder_name: details.accountHolderName,
      account_type: details.accountType,
      label: details.label,
      provider_destination_id: details.providerDestinationId,
      previous_label: payout.current?.label ?? null,
      state: 'pending',
      rejection_reason: null,
      review_id: null,
      requested_by: by.actor as never,
      requested_at: requestedAt,
      decided_at: null,
    });
    const next: StoredPayout = { ...payout, pendingChange: { ...details, changeId, requestedAt: requestedAt.toISOString() }, ...(isInitial ? { current: null } : {}) };
    const after = await tx.update('sellers', s.id, { payout_readiness: this.core.step(payoutReadinessMachine, s.payout_readiness, event), ...(isInitial ? { payout_destination_label: details.label } : {}), updated_at: this.now() });
    const evt = {
      sellerId: s.id,
      changeId,
      providerDestinationId: details.providerDestinationId,
      label: details.label,
      accountHolderName: details.accountHolderName,
      accountType: details.accountType,
      previousLabel: payout.current?.label ?? null,
      isInitial,
      requestedBy: by.actor,
    };
    return { after, next, evt };
  }

  async changePayoutAccount(sellerId: string, body: { details: PayoutDetailsInput }, by: By) {
    const s = await this.core.seller(sellerId);
    if (s.status === 'closed' || !SELLING.includes(s.status)) throw new AppError('CONFLICT', 'The payout account can only be changed for an approved account', { status: s.status });
    const business = await this.businessDetails(s);
    const details = await this.tokenizePayout(body.details, { legalName: s.legal_name, owners: business.owners });
    const res = await this.repo.transaction(async (tx) => {
      const locked = await this.core.seller(sellerId, { repo: tx, forUpdate: true });
      const r = await this.submitDestination(tx, locked, details, by);
      await this.core.timeline(tx, s.id, { kind: 'payout_account_changed', title: `Payout account change to ${details.label} submitted`, detail: 'Your current account keeps receiving payouts until the new one is verified', actor: by.actor });
      return r;
    });
    this.core.publish('sellers.payout_account.changed', res.evt, by);
    await this.core.audit(
      {
        action: 'sellers.payout_account.change',
        actionLabel: 'Changed the payout account',
        category: 'financial',
        target: { type: 'seller', id: s.id, ref: s.ref, label: s.store_name, sellerId: s.id, screen: 'seller/finance' },
        before: { label: res.evt.previousLabel, readiness: s.payout_readiness },
        after: { label: details.label, readiness: res.after.payout_readiness },
        visibleToSeller: true,
      },
      by,
    );
    return { pendingChange: this.details(res.next.pendingChange)!, readiness: map.payoutReadiness(res.after, res.next) as PayoutReadiness };
  }

  async onDestinationVerified(e: EventPayload<'finance.destination.verified'>) {
    if (!isUuid(e.sellerId)) return;
    await this.repo.transaction(async (tx) => {
      const s = await tx.get('sellers', e.sellerId, { forUpdate: true });
      if (!s || (s.payout_readiness !== 'verification_pending' && s.payout_readiness !== 'change_under_review')) return;
      const payout = await this.core.payoutState(s, tx);
      const current = payout.pendingChange ? { accountHolderName: payout.pendingChange.accountHolderName, accountType: payout.pendingChange.accountType, label: payout.pendingChange.label, providerDestinationId: payout.pendingChange.providerDestinationId } : payout.current;
      if (payout.pendingChange) {
        // the destination it replaces stops being current
        for (const old of await tx.find('payout_changes', { seller_id: s.id, state: 'verified' })) await tx.update('payout_changes', old.id, { state: 'replaced' });
        await tx.update('payout_changes', payout.pendingChange.changeId, { state: 'verified', review_id: e.reviewId, decided_at: this.now() });
      }
      await tx.update('sellers', s.id, { payout_readiness: this.core.step(payoutReadinessMachine, s.payout_readiness, 'verified'), payout_destination_label: current?.label ?? s.payout_destination_label, updated_at: this.now() });
      await this.core.timeline(tx, s.id, { kind: 'payout_verified', title: `Payout account ${current?.label ?? ''} verified`.trim(), ref: e.reviewId });
    });
  }

  async onDestinationRejected(e: EventPayload<'finance.destination.rejected'>) {
    if (!isUuid(e.sellerId)) return;
    await this.repo.transaction(async (tx) => {
      const s = await tx.get('sellers', e.sellerId, { forUpdate: true });
      if (!s || (s.payout_readiness !== 'verification_pending' && s.payout_readiness !== 'change_under_review')) return;
      const payout = await this.core.payoutState(s, tx);
      const wasChange = s.payout_readiness === 'change_under_review';
      if (payout.pendingChange) await tx.update('payout_changes', payout.pendingChange.changeId, { state: 'rejected', rejection_reason: e.reason, review_id: e.reviewId, decided_at: this.now() });
      await tx.update('sellers', s.id, {
        payout_readiness: this.core.step(payoutReadinessMachine, s.payout_readiness, 'rejected'),
        payout_destination_label: wasChange ? (payout.current?.label ?? s.payout_destination_label) : null,
        updated_at: this.now(),
      });
      await this.core.timeline(tx, s.id, {
        kind: 'payout_rejected',
        title: wasChange ? 'Payout account change rejected; payouts keep going to your current account' : 'Payout account rejected; add another account',
        detail: e.reason,
        ref: e.reviewId,
      });
    });
  }

  /* ---------------------------------------------------------------- agreements */

  async acceptances(sellerId: string) {
    return this.repo.find('agreement_acceptances', { seller_id: sellerId }, { orderBy: [['accepted_at', 'desc']] });
  }

  async pendingAgreements(sellerId: string): Promise<AgreementDocument[]> {
    const accepted = await this.acceptances(sellerId);
    return (await this.core.currentAgreements()).filter((d) => !accepted.some((a) => a.policy_key === d.key && a.version_label === d.versionLabel));
  }

  async listAgreements(sellerId: string): Promise<{ accepted: AgreementAcceptance[]; pending: AgreementDocument[] }> {
    await this.core.seller(sellerId);
    return { accepted: (await this.acceptances(sellerId)).map(map.acceptance), pending: await this.pendingAgreements(sellerId) };
  }

  async acceptAgreement(sellerId: string, key: AgreementKey, body: { versionLabel: string; policyVersionId?: string | null; signedName: string }, by: By): Promise<AgreementAcceptance> {
    const s = await this.core.seller(sellerId);
    if (!body.signedName?.trim()) throw invalid([{ path: 'signedName', message: 'Type your name to sign' }]);
    const doc = (await this.core.currentAgreements()).find((d) => d.key === key)!;
    if (doc.versionLabel !== body.versionLabel || (doc.policyVersionId && body.policyVersionId && doc.policyVersionId !== body.policyVersionId)) {
      throw new AppError('AGREEMENT_VERSION_OUTDATED', `${doc.title} ${doc.versionLabel} is now in force; reload and accept it`, { key, versionLabel: doc.versionLabel });
    }
    const existing = await this.repo.findOne('agreement_acceptances', { seller_id: sellerId, policy_key: key, version_label: doc.versionLabel });
    if (existing) return map.acceptance(existing);
    const row = await this.repo.insert('agreement_acceptances', {
      id: newId(),
      seller_id: sellerId,
      application_id: s.application_id,
      policy_key: key,
      version_label: doc.versionLabel,
      policy_version_id: doc.policyVersionId ?? null,
      signed_name: body.signedName.trim(),
      accepted_by: map.actorText(by.actor),
      ip: null,
      accepted_at: this.now(),
    });
    await this.core.timeline(this.repo, sellerId, { kind: 'agreement_accepted', title: `${doc.title} ${doc.versionLabel} accepted`, actor: by.actor });
    this.core.publish('sellers.agreement.accepted', { sellerId, applicationId: s.application_id, key, versionLabel: doc.versionLabel }, by);
    await this.core.audit(
      { action: 'sellers.agreement.accept', actionLabel: 'Accepted an agreement version', category: 'other', target: { type: 'seller', id: s.id, ref: s.ref, label: s.store_name, sellerId: s.id, screen: 'seller/agreements' }, after: { key, versionLabel: doc.versionLabel, signedName: row.signed_name }, visibleToSeller: true },
      by,
    );
    return map.acceptance(row);
  }

  /** content.policy.effective: a new seller agreement version waits for every owner's acceptance */
  async onPolicyEffective(e: EventPayload<'content.policy.effective'>) {
    if (!(AGREEMENT_KEYS as readonly string[]).includes(e.policyKey)) return;
    const sellers = await this.repo.find('sellers', { status: SELLING }, { limit: 10000 });
    const title = e.policyKey.replace(/_/g, ' ');
    for (const s of sellers) {
      if (await this.repo.findOne('account_events', { seller_id: s.id, kind: 'agreement_pending', ref: e.policyVersionId })) continue;
      await this.core.timeline(this.repo, s.id, { kind: 'agreement_pending', title: `New ${title} ${e.version} waiting for the owner's acceptance`, ref: e.policyVersionId });
    }
  }

  /* ---------------------------------------------------------------- closure */

  async requestSellerClosure(sellerId: string, reason: string, by: By) {
    if (!reason?.trim()) throw invalid([{ path: 'reason', message: 'Tell us why you are closing the account' }]);
    const after = await this.closeNow(sellerId, { reason: reason.trim(), reasonCode: 'seller_request' }, by);
    return this.account(after, null);
  }

  async closeSeller(sellerId: string, body: { reason: string; reasonCode: 'seller_request' | 'policy' | 'inactive' | 'fraud' | 'other' }, by: By) {
    if (!body.reason?.trim()) throw invalid([{ path: 'reason', message: 'Give the reason for closing' }]);
    const s = await this.core.seller(sellerId);
    if (!sellerAccountStatusMachine.can(s.status as never, 'close' as never)) throw new AppError('ILLEGAL_TRANSITION', `A ${s.status.replace(/_/g, ' ')} seller cannot be closed`, { from: s.status, event: 'close' });
    if (body.reasonCode !== 'seller_request') {
      const access = this.ctx.use('access');
      const check = await access.check(this.core.principalOf(by), 'sellers.sellers.close');
      if (check.decision === 'denied') throw new AppError('FORBIDDEN', check.reason, { action: 'sellers.sellers.close' });
      const req = await access.requestApproval({
        action: 'sellers.sellers.close',
        target: { type: 'seller', id: s.id, ref: s.ref, label: s.store_name, sellerId: s.id, screen: 'admin/seller' },
        summary: `Close the seller account of ${s.store_name}`,
        details: { reason: body.reason.trim(), reasonCode: body.reasonCode },
        reason: body.reason.trim(),
        requestedBy: this.core.principalOf(by),
      });
      const pending = await this.core.savePendingChange({ kind: 'closure', sellerId: s.id, targetId: s.id, approvalRequestId: req.id, payload: { reason: body.reason.trim(), reasonCode: body.reasonCode }, reason: body.reason.trim(), actor: by.actor });
      await this.core.timeline(this.repo, s.id, { kind: 'closure_requested', title: 'Closure proposed, waiting for a second reviewer', detail: body.reason, visibility: 'staff', actor: by.actor });
      await this.core.audit(
        {
          action: 'sellers.seller.close_request',
          actionLabel: 'Proposed closing a seller account',
          category: 'seller_enforcement',
          target: { type: 'seller', id: s.id, ref: s.ref, label: s.store_name, sellerId: s.id, screen: 'admin/seller' },
          reason: body.reason,
          after: { reasonCode: body.reasonCode },
          approvalRequestId: req.id,
        },
        by,
      );
      // saved, pending approval: the account unchanged with the closure and its approval (FORMAT.md, Approval responses)
      const view = await this.account(s, null, [], { staff: true });
      return { ...view, pendingChange: view.pendingChange ?? map.pendingStaffChange(pending), approval: view.approval ?? (await this.core.approvalInfo(req.id)) };
    }
    return this.account(await this.closeNow(sellerId, { reason: body.reason.trim(), reasonCode: body.reasonCode }, by), null, [], { staff: true });
  }

  /** Close the account: new sales stop, open obligations stay accessible to members and staff */
  async closeNow(sellerId: string, body: { reason: string; reasonCode: string }, by: By, approvalRequestId?: string): Promise<SellerRec> {
    const res = await this.repo.transaction(async (tx) => {
      const s = await this.core.seller(sellerId, { repo: tx, forUpdate: true });
      if (s.status === 'closed') return { s, before: s.status, changed: false };
      const now = this.now();
      const after = await tx.update('sellers', s.id, { status: this.core.step(sellerAccountStatusMachine, s.status, 'close'), status_since: now, closed_reason: body.reasonCode, updated_at: now });
      await this.parts.enforcement.cancelOpenSuspensions(tx, s.id, 'Account closed');
      await this.core.timeline(tx, s.id, { kind: 'closed', title: body.reasonCode === 'seller_request' ? 'Account closed at your request' : 'Account closed by Marketly', detail: body.reason, actor: by.actor });
      return { s: after, before: s.status, changed: true };
    });
    if (!res.changed) return res.s;
    await this.parts.members.closeOut(sellerId);
    this.core.publish('sellers.seller.closed', { sellerId, reasonCode: body.reasonCode, closedBy: by.actor }, by);
    await this.core.audit(
      {
        action: 'sellers.seller.close',
        actionLabel: 'Closed a seller account',
        category: 'seller_enforcement',
        target: { type: 'seller', id: sellerId, ref: res.s.ref, label: res.s.store_name, sellerId, screen: 'admin/seller' },
        reason: body.reason,
        before: { status: res.before },
        after: { status: 'closed', reasonCode: body.reasonCode },
        approvalRequestId: approvalRequestId ?? null,
        visibleToSeller: true,
      },
      by,
    );
    return res.s;
  }

  /* ---------------------------------------------------------------- Verified label */

  /** Plain-language list of what was checked, and the checks that still block the label */
  async labelChecks(s: SellerRec, repo: SellersRepository = this.repo) {
    const app = await this.core.applicationOf(s, repo);
    const checks = app ? await repo.find('verification_checks', { application_id: app.id }) : [];
    const business = (app?.business ?? {}) as { kind?: string };
    const needed = LABEL_CHECKS.filter((k) => k !== 'business_registration' || business.kind !== 'individual');
    const blocking = needed.filter((k) => {
      const c = checks.filter((x) => x.kind === k).sort((a, b) => (b.checked_at?.getTime() ?? 0) - (a.checked_at?.getTime() ?? 0))[0];
      return !c || !(c.result === 'passed' || (c.result === 'needs_attention' && c.accepted_note));
    });
    const v = (app?.verification ?? {}) as unknown as StoredVerification;
    const addr = s.business_address as unknown as common.Address;
    const checked = [
      `Business identity: ${s.legal_name}${s.state_of_registration ? `, registered in ${s.state_of_registration}` : ''}`,
      ...(v.owners?.length ? [`Owner identity: ${v.owners.map((o) => o.name).join(', ')}`] : []),
      'Payout account in the business or owner name',
      `Return address: ${locationOf(((app?.return_address ?? {}) as { address?: common.Address }).address ?? addr) ?? 'checked'}`,
    ];
    return { blocking, checked };
  }

  /** How long a granted label lasts (setting verifiedLabelValidDays); read before a transaction */
  async labelValidDays(): Promise<number> {
    return Number(await this.core.setting('verifiedLabelValidDays')) || 365;
  }

  /** Grant the Verified label for `validDays` (read with labelValidDays() before the transaction) */
  async grantLabel(tx: SellersRepository, s: SellerRec, by: By, validDays: number, reason?: string): Promise<SellerRec> {
    const { checked } = await this.labelChecks(s, tx);
    const now = this.now();
    return tx.update('sellers', s.id, {
      verification_state: this.core.step(verifiedSellerLabelMachine, s.verification_state, 'grant'),
      verification_checked: { checked, reason: reason ?? null } as never,
      verified_at: now,
      verification_expires_at: addDays(now, validDays),
      updated_at: now,
    });
  }

  async setVerificationLabel(sellerId: string, body: { action: 'grant' | 'revoke'; reason: string }, by: By): Promise<VerificationLabel> {
    if (!body.reason?.trim()) throw invalid([{ path: 'reason', message: 'Give the reason' }]);
    const s = await this.core.seller(sellerId);
    let after: SellerRec;
    if (body.action === 'grant') {
      const { blocking } = await this.labelChecks(s);
      if (blocking.length) throw new AppError('CHECKS_UNRESOLVED', 'These checks must pass before the label is granted', { checks: blocking });
      const days = await this.labelValidDays();
      after = await this.repo.transaction((tx) => this.grantLabel(tx, s, by, days));
    } else {
      after = await this.repo.update('sellers', s.id, {
        verification_state: this.core.step(verifiedSellerLabelMachine, s.verification_state, 'revoke'),
        verification_checked: { ...((s.verification_checked ?? {}) as object), reason: body.reason.trim() } as never,
        updated_at: this.now(),
      });
    }
    await this.core.timeline(this.repo, s.id, { kind: 'verification', title: body.action === 'grant' ? 'Verified seller label granted' : 'Verified seller label removed', detail: body.reason, actor: by.actor });
    this.core.publish('sellers.verification.changed', { sellerId: s.id, state: after.verification_state }, by);
    await this.core.audit(
      {
        action: `sellers.verification.${body.action}`,
        actionLabel: body.action === 'grant' ? 'Granted the Verified seller label' : 'Revoked the Verified seller label',
        category: 'seller_enforcement',
        target: { type: 'seller', id: s.id, ref: s.ref, label: s.store_name, sellerId: s.id, screen: 'admin/seller' },
        reason: body.reason,
        before: { state: s.verification_state },
        after: { state: after.verification_state },
        visibleToSeller: true,
      },
      by,
    );
    return map.verificationLabel(after);
  }

  /** Lapse the label (a checked document expired or a provider result changed) */
  async lapseLabel(s: SellerRec, reason: string) {
    if (s.verification_state !== 'verified') return;
    const after = await this.repo.update('sellers', s.id, {
      verification_state: this.core.step(verifiedSellerLabelMachine, s.verification_state, 'lapse'),
      verification_checked: { ...((s.verification_checked ?? {}) as object), reason } as never,
      updated_at: this.now(),
    });
    await this.core.timeline(this.repo, s.id, { kind: 'verification', title: 'Verified seller label lapsed', detail: reason });
    this.core.publish('sellers.verification.changed', { sellerId: s.id, state: after.verification_state });
  }

  /** sellers.verification-lapse */
  async verificationLapse() {
    const rows = await this.repo.find('sellers', { verification_state: 'verified', verification_expires_at: { op: '<', value: this.now() } }, { limit: 500 });
    for (const s of rows) await this.lapseLabel(s, 'The Verified label reached its renewal date: renew your business registration and owner ID checks to get it back');
  }

  /* ---------------------------------------------------------------- admin */

  private filterOf(q: ListSellersQuery): SellerListFilter {
    return { q: q.q, statuses: q.status ? [q.status] : undefined, verified: q.verified, onTimeBelow: q.onTimeBelow, categoryId: q.categoryId, sort: q.sort === 'name' || q.sort === 'newest' || q.sort === 'on_time' ? q.sort : undefined };
  }

  async sellerRows(rows: SellerRec[], viewer: { canSeeBalances: boolean }): Promise<SellerRow[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [profileRows, dispatch, restrictions, warnings, appRows, categories] = await Promise.all([
      this.repo.getProfiles(ids),
      this.parts.performance.dispatchPct(ids),
      this.repo.find('restrictions', { seller_id: ids, state: 'active' }),
      this.repo.find('warnings', { seller_id: ids, state: 'open' }, { orderBy: [['issued_at', 'desc']] }),
      this.repo.getMany('applications', rows.map((r) => r.application_id).filter((x): x is string => Boolean(x))),
      this.core.optional('catalog', 'categories', null, (c) => c.listCategories({ includeHidden: true })),
    ]);
    const profiles = new Map(profileRows.map((p) => [p.seller_id, p]));
    const refs = await this.core.mediaRefs(profileRows.map((p) => p.logo_media_id));
    const apps = new Map(appRows.map((a) => [a.id, a]));
    const restrictionsOf = new Map<string, string[]>();
    for (const r of restrictions) restrictionsOf.set(r.seller_id, [...(restrictionsOf.get(r.seller_id) ?? []), r.title]);
    // newest open warning per seller (the list is newest first)
    const warningOf = new Map<string, string>();
    for (const w of warnings) if (!warningOf.has(w.seller_id)) warningOf.set(w.seller_id, w.title);
    const catName = new Map<string, string>();
    const walk = (list: { id: string; name: string; children?: unknown[] }[]) => {
      for (const c of list) {
        catName.set(c.id, c.name);
        walk((c.children ?? []) as never);
      }
    };
    walk((categories ?? []) as never);
    const caseRange = { from: this.core.today(addDays(this.now(), -365)), to: this.core.today() };
    // other modules answer per seller (no batch API): a few sellers at a time instead of one after another
    return mapLimit(rows, 8, async (s): Promise<SellerRow> => {
      const p = profiles.get(s.id);
      const [feedback, cases, bal] = await Promise.all([
        this.core.optional('reviews', 'feedback', null, (r) => r.getSellerFeedbackSummary(s.id)),
        this.core.optional('support', 'cases', null, (x) => x.sellerCaseStats(s.id, caseRange)),
        viewer.canSeeBalances ? this.core.optional('finance', 'balances', null, (f) => f.getSellerBalances(s.id)) : undefined,
      ]);
      const rs = restrictionsOf.get(s.id) ?? [];
      const cat = ((apps.get(s.application_id ?? '')?.business ?? {}) as { categoryIds?: string[] }).categoryIds?.[0];
      return {
        id: s.id,
        ref: s.ref,
        slug: s.slug,
        storeName: s.store_name,
        logo: refs(p?.logo_media_id),
        location: p?.location ?? locationOf(s.business_address as unknown as common.Address),
        status: s.status,
        verified: s.verification_state === 'verified',
        feedback: feedback ? { positivePct: feedback.positivePct ?? null, ratingCount: feedback.count } : null,
        onTimeDispatchPct: dispatch.get(s.id) ?? null,
        openCases: cases?.open ?? 0,
        balance: bal ? bal.available : null,
        held: bal ? bal.held : null,
        negativeBalance: Boolean(bal?.negative),
        restrictionSummary: s.status === 'suspended' ? 'Suspended' : rs.length ? rs.join(' · ') : null,
        warningNote: warningOf.get(s.id) ?? null,
        mainCategory: cat ? (catName.get(cat) ?? null) : null,
      };
    });
  }

  async listSellers(q: ListSellersQuery, page: PageRequest, viewer: { canSeeBalances: boolean }): Promise<common.Page<SellerRow>> {
    const filter = this.filterOf(q);
    const inMemory = Boolean(q.balance) || q.sort === 'cases' || q.sort === 'balance' || q.sort === 'on_time';
    if (!inMemory) {
      const p = await this.repo.listSellers(filter, page);
      return { ...p, items: await this.sellerRows(p.items, viewer) };
    }
    // filters and sorts on other modules' figures: bounded list, figures per seller, then paged in memory
    let rows = await this.sellerRows(await this.repo.allSellerIds(filter, 1000), { canSeeBalances: viewer.canSeeBalances || Boolean(q.balance) || q.sort === 'balance' });
    if (q.balance === 'has_held') rows = rows.filter((r) => (r.held?.amount ?? 0) > 0);
    if (q.balance === 'negative') rows = rows.filter((r) => r.negativeBalance);
    if (q.sort === 'cases') rows.sort((a, b) => b.openCases - a.openCases);
    if (q.sort === 'balance') rows.sort((a, b) => (b.balance?.amount ?? 0) - (a.balance?.amount ?? 0));
    if (q.sort === 'on_time') rows.sort((a, b) => (a.onTimeDispatchPct ?? 101) - (b.onTimeDispatchPct ?? 101));
    if (!viewer.canSeeBalances) rows = rows.map((r) => ({ ...r, balance: null, held: null, negativeBalance: false }));
    return pageOf(rows, page);
  }

  async getSellerStats(viewer: { canSeeBalances: boolean }): Promise<SellerStats> {
    const now = this.now();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    // independent counts side by side; finance's figures only for staff who may see seller balances (like the list's balance columns)
    const [byStatus, balances, addedThisMonth, belowDispatchTarget, appealsUnderReview, applicationsWaiting] = await Promise.all([
      this.repo.countSellersByStatus(),
      viewer.canSeeBalances ? this.core.optional('finance', 'balances', null, (f) => f.sellerBalanceTotals()).then((b) => b ?? null) : null,
      this.repo.countSellersCreatedSince(monthStart),
      this.repo.countBelowDispatch(),
      this.repo.count('appeals', { state: ['submitted', 'under_review'] }),
      this.repo.count('applications', { state: ['submitted', 'under_review', 'information_required'] }),
    ]);
    return {
      sellingNow: (byStatus.approved ?? 0) + (byStatus.restricted ?? 0),
      addedThisMonth,
      belowDispatchTarget,
      restrictedOrSuspended: (byStatus.restricted ?? 0) + (byStatus.suspended ?? 0),
      appealsUnderReview,
      balances,
      byStatus,
      applicationsWaiting,
    };
  }

  async getSellerAdmin(sellerId: string, viewer: { canSeeBalances: boolean }): Promise<SellerAdminDetail> {
    const s = await this.core.seller(sellerId);
    const unavailable: string[] = [];
    const owner = await this.parts.members.ownerOf(s.id);
    const contact = (s.contact ?? {}) as { name?: string; email?: string; phone?: string };
    const orders = await this.core.optional('orders', 'obligations', unavailable, async (o) => {
      const counts = (await o.countOrdersForSellers([s.id]))[s.id];
      const overdue = await o.listOrdersForSeller(s.id, { overdueOnly: true }, { limit: 20 });
      return { counts, overdue: overdue.items };
    });
    const returns = await this.core.optional('returns', 'obligations', unavailable, (r) => r.listForSeller(s.id, { state: 'open' }, { limit: 20 }));
    const cases = await this.core.optional('support', 'obligations', unavailable, (x) => x.listCasesForSeller(s.id, { open: true }, { limit: 20 }));
    let payouts: SellerPayoutsView | null = null;
    if (viewer.canSeeBalances) {
      const b = await this.core.optional('finance', 'payouts', unavailable, (f) => f.getSellerBalances(s.id));
      if (b) payouts = { pending: b.pending, available: b.available, held: b.held, holds: b.holds, nextPayout: b.nextPayout ?? null };
    } else unavailable.push('payouts');
    const changeRows = await this.repo.find('change_requests', { seller_id: s.id }, { orderBy: [['submitted_at', 'desc']], limit: 50 });
    const crRefs = await this.core.mediaRefs(changeRows.flatMap((c) => map.strings(c.evidence_media_ids)));
    const notes = await this.repo.find('seller_notes', { seller_id: s.id }, { orderBy: [['created_at', 'desc']] });
    return {
      account: await this.account(s, null, unavailable, { staff: true }),
      business: await this.businessDetails(s),
      owner: { name: owner?.name ?? contact.name ?? '', email: owner?.email ?? contact.email ?? null, phone: contact.phone ?? null },
      restrictions: await this.parts.enforcement.restrictionsFor(s.id),
      performance: await this.parts.performance.getPerformance(s.id),
      obligations:
        orders || returns || cases
          ? {
              openOrders: orders?.counts?.open ?? 0,
              overdueOrders: (orders?.overdue ?? []).map((x) => ({ orderId: x.order.id, orderRef: x.order.ref })),
              openReturns: (returns?.items ?? []).map((r) => ({ id: (r as { id?: string }).id, ref: (r as { ref?: string }).ref })),
              openCases: (cases?.items ?? []).map((c) => ({ id: (c as { id?: string }).id, ref: (c as { ref?: string }).ref })),
            }
          : null,
      appeals: await this.parts.enforcement.appealsFor(s.id),
      payouts,
      changeRequests: changeRows.map((c) => map.changeRequest(c, { storeName: s.store_name, refs: crRefs })),
      notes: notes.map(map.note),
      history: await this.parts.performance.history(s.id, true),
      unavailable,
    };
  }

  async addNote(target: { sellerId?: string | null; applicationId?: string | null }, body: string, by: By) {
    if (!body?.trim()) throw invalid([{ path: 'body', message: 'Write the note' }]);
    const row = await this.repo.insert('seller_notes', {
      id: newId(),
      seller_id: target.sellerId ?? null,
      application_id: target.applicationId ?? null,
      body: body.trim(),
      author_id: map.actorText(by.actor),
      author_name: by.actor.name ?? (await this.core.staffName(by.actor.id)) ?? 'Staff member',
      created_at: this.now(),
    });
    return map.note(row);
  }

  async addSellerNote(sellerId: string, body: string, by: By) {
    const s = await this.core.seller(sellerId);
    const n = await this.addNote({ sellerId }, body, by);
    await this.core.audit({ action: 'sellers.note.add', actionLabel: 'Added a staff note', category: 'other', target: { type: 'seller', id: s.id, ref: s.ref, label: s.store_name, sellerId: s.id, screen: 'admin/seller' }, after: { noteId: n.id } }, by);
    return n;
  }

  async assignAccountManager(sellerId: string, staffId: string, by: By) {
    const s = await this.core.seller(sellerId);
    const after = await this.repo.update('sellers', s.id, { account_manager_id: staffId, updated_at: this.now() });
    await this.core.timeline(this.repo, s.id, { kind: 'account_manager', title: 'Account manager assigned', actor: by.actor });
    await this.core.audit(
      { action: 'sellers.account_manager.assign', actionLabel: 'Assigned an account manager', category: 'other', target: { type: 'seller', id: s.id, ref: s.ref, label: s.store_name, sellerId: s.id, screen: 'admin/seller' }, before: { staffId: s.account_manager_id }, after: { staffId } },
      by,
    );
    return this.account(after, null, [], { staff: true });
  }

  /* ---------------------------------------------------------------- exports */

  private registerDataset(api: reports.ReportsPublicApi) {
    this.#datasetRegistered ??= api
      .registerDataset({
        key: DATASET,
        owner: 'sellers',
        title: 'Sellers',
        permission: 'sellers.accounts.export',
        audience: 'staff',
        screens: ['admin/sellers'],
        available: true,
        phase: 1,
        columns: [
          { key: 'ref', label: 'Seller' },
          { key: 'storeName', label: 'Store name' },
          { key: 'status', label: 'Status' },
          { key: 'verified', label: 'Verified' },
          { key: 'location', label: 'Location' },
          { key: 'onTimeDispatchPct', label: 'On-time dispatch %' },
          { key: 'openCases', label: 'Open cases' },
          { key: 'restrictionSummary', label: 'Restrictions' },
          { key: 'warningNote', label: 'Open warning' },
          { key: 'balance', label: 'Balance', permission: 'finance.ledger.view' },
          { key: 'held', label: 'Held', permission: 'finance.ledger.view' },
        ],
      })
      .catch((err) => {
        this.#datasetRegistered = undefined;
        if (!isNotImplemented(err)) throw err;
      });
    return this.#datasetRegistered;
  }

  async exportSellers(body: { filters: unknown; format?: 'csv' | 'xlsx' | null }, principal: Principal, by: By): Promise<reports.ExportJob> {
    const api = this.ctx.tryUse('reports');
    if (!api) throw new AppError('SERVICE_UNAVAILABLE', 'Exports are unavailable right now');
    await this.registerDataset(api);
    const job = await api.requestExport({ dataset: DATASET, filters: body.filters ?? {}, format: body.format ?? 'csv', principal: principal as identity.Principal });
    await this.core.audit({ action: 'sellers.export', actionLabel: 'Exported the seller list', category: 'other', target: { type: 'export', id: job.id, ref: job.ref, label: 'Seller list export', screen: 'admin/sellers' }, after: { filters: body.filters ?? {}, format: body.format ?? 'csv' } }, by);
    return job;
  }

  async exportRows(dataset: string, filters: unknown, principal: identity.Principal, cursor?: string) {
    if (dataset !== DATASET) throw new AppError('NOT_FOUND', `Unknown dataset ${dataset}`);
    const q = (filters ?? {}) as ListSellersQuery;
    const access = this.ctx.use('access');
    const canSeeBalances = principal.kind === 'staff' && (await access.hasPermission(principal, 'finance.ledger.view').catch(() => false));
    const page = await this.listSellers(q, { mode: 'cursor', cursor: cursor ?? null, limit: 100 }, { canSeeBalances });
    const rows = page.items.map((r) => ({
      ref: r.ref,
      storeName: r.storeName,
      status: r.status,
      verified: r.verified,
      location: r.location ?? null,
      onTimeDispatchPct: r.onTimeDispatchPct ?? null,
      openCases: r.openCases,
      restrictionSummary: r.restrictionSummary ?? null,
      warningNote: r.warningNote ?? null,
      ...(canSeeBalances ? { balance: r.balance ?? null, held: r.held ?? null } : {}),
    }));
    return { rows, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
}
