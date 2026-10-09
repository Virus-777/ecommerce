/**
 * Admission: the Sell with us programme, the six-step application, documents, submission with agreements,
 * verification checks (provider + webhook), Trust and Risk referral, information requests, the review
 * decision, appeals on rejection, and invitations to apply during the invite-only launch.
 */
import { createHash, createHmac } from 'node:crypto';
import type { Principal } from '../../../kernel/auth/index.js';
import { AppError } from '../../../kernel/errors/index.js';
import type { EventPayload } from '../../../kernel/events/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import { secretFor } from '../../../kernel/lib/secrets.js';
import type * as common from '../../../spec/common.js';
import type {
  Appeal,
  AppealInput,
  ApplicationAccountInput,
  ApplicationAdmin,
  ApplicationBusinessInput,
  ApplicationDocument,
  ApplicationRow,
  ApplicationVerificationInput,
  InfoRequestItem,
  PayoutDetailsInput,
  RequiredDocument,
  RestrictionInput,
  ReturnAddressInput,
  RiskReview,
  SellerApplication,
  SellerInvitation,
  SellerNote,
  SellerProgram,
  VerificationCheck,
} from '../../../spec/sellers.js';
import { PROGRAM } from '../domain/catalogue.js';
import {
  addBusinessDays,
  addDays,
  completedSteps,
  DATA_STEPS,
  deadline,
  holderMatches,
  isoDate,
  missingFields,
  nextStep,
  percentComplete,
  reapplyFrom,
  riskCategoriesIn,
  slugify,
  taxIdDigits,
  validTaxId,
  type ApplicationSections,
  type StoredOwner,
  type StoredPayout,
  type StoredReturnAddress,
  type StoredVerification,
} from '../domain/rules.js';
import { sellerAccountStatusMachine, sellerApplicationMachine, sellerInvitationMachine } from '../domain/state-machines.js';
import * as map from '../mappers.js';
import type { ApplicationRec, CheckKind, CheckRec, CheckResult, CheckSubject, InfoRequestRec, SellerRec, SellersRepository } from '../ports.js';
import { invalid, notFound, Part, SYSTEM, type By } from './core.js';

const OPEN_STATES = ['draft', 'submitted', 'under_review', 'information_required'];
const REVIEW_STATES = ['submitted', 'under_review', 'information_required'];
const EDITABLE = ['draft', 'information_required'];

type UpdateBody = {
  step: 'account' | 'business' | 'verification' | 'payout' | 'return_address';
  account?: ApplicationAccountInput | null;
  business?: ApplicationBusinessInput | null;
  verification?: ApplicationVerificationInput | null;
  payout?: PayoutDetailsInput | null;
  returnAddress?: ReturnAddressInput | null;
};

export class ApplicationsPart extends Part {
  /* ---------------------------------------------------------------- helpers */

  sections(a: ApplicationRec): ApplicationSections {
    const obj = (v: unknown) => (v && typeof v === 'object' && Object.keys(v).length ? v : null);
    return {
      account: obj(a.account) as ApplicationSections['account'],
      business: obj(a.business) as ApplicationSections['business'],
      verification: obj(a.verification) as StoredVerification | null,
      payout: obj(a.payout) as StoredPayout | null,
      returnAddress: obj(a.return_address) as StoredReturnAddress | null,
    };
  }

  private async own(accountId: string | null | undefined, id: string, repo: SellersRepository = this.repo, forUpdate = false): Promise<ApplicationRec> {
    const a = isUuid(id) ? await repo.get('applications', id, { forUpdate }) : undefined;
    if (!a || !accountId || a.applicant_account_id !== accountId) throw notFound('Application');
    return a;
  }

  private async byId(id: string, repo: SellersRepository = this.repo, forUpdate = false): Promise<ApplicationRec> {
    const a = isUuid(id) ? await repo.get('applications', id, { forUpdate }) : undefined;
    if (!a) throw notFound('Application');
    return a;
  }

  private illegal(a: ApplicationRec, event: string, message = 'The application cannot be changed in its current state') {
    return new AppError('ILLEGAL_TRANSITION', message, { from: a.state, event });
  }

  private storeNameOf(a: ApplicationRec) {
    const s = this.sections(a);
    return s.business?.storeName ?? s.account?.storeName ?? '';
  }

  /* ---------------------------------------------------------------- programme */

  private async invitedEmail(principal: Principal | null): Promise<string | null> {
    if (!principal?.accountId || principal.kind !== 'customer') return null;
    try {
      return (await this.ctx.use('identity').getAccount(principal.accountId))?.email ?? null;
    } catch {
      return null;
    }
  }

  async getSellerProgram(principal: Principal | null): Promise<SellerProgram> {
    const risky = (await this.core.setting('riskReviewCategories')) as readonly string[];
    const categories = await this.core.optional('catalog', 'categories', null, (c) => c.listCategories({}));
    const launchCategories = (categories ?? []).map((c) => ({ id: c.id, name: c.name, icon: c.slug, needsExtraApproval: riskCategoriesIn(c.name, risky).length > 0 }));
    const feeExamples: unknown[] = [];
    for (const ex of PROGRAM.exampleFees) {
      const cat = (categories ?? []).find((c) => c.name.toLowerCase() === ex.categoryName.toLowerCase());
      const fee = await this.core.optional('finance', 'fees', null, (f) => f.calculateFee({ categoryId: cat?.id ?? null, itemPrice: { amount: 10000, currency: this.ctx.config.market.currency } }));
      feeExamples.push({ categoryName: ex.categoryName, ratePct: fee ? fee.rateBps / 100 : ex.ratePct, basis: 'Item price after seller-funded discounts, excluding shipping', isExample: true });
    }
    let open = Boolean(await this.core.setting('applicationsOpen'));
    if (!open) {
      const email = await this.invitedEmail(principal);
      if (email) open = Boolean(await this.repo.findOne('seller_invitations', { email: email.toLowerCase(), state: 'sent', expires_at: { op: '>', value: this.now() } }));
    }
    return {
      launchCategories,
      notAllowed: PROGRAM.notAllowed,
      requirements: PROGRAM.requirements,
      feeExamples,
      feeNotes: PROGRAM.feeNotes,
      payoutTiming: PROGRAM.payoutTiming,
      fulfillmentModels: PROGRAM.fulfillmentModels,
      serviceTargets: Object.values(await this.parts.performance.targetsInForce()),
      agreements: await this.core.currentAgreements(),
      steps: PROGRAM.steps,
      verificationLabels: PROGRAM.verificationLabels,
      faq: PROGRAM.faq,
      contact: PROGRAM.contact,
      estimatedMinutes: PROGRAM.estimatedMinutes,
      applicationsOpen: open,
    };
  }

  /* ---------------------------------------------------------------- views */

  private verificationView(v: StoredVerification | null) {
    if (!v) return null;
    return { owners: v.owners ?? [], registrationDocumentIds: v.registrationDocumentIds ?? [], taxIdType: v.taxIdType ?? null, taxIdLast4: v.taxIdLast4 ?? null, w9Method: v.w9Method ?? null, w9DocumentId: v.w9DocumentId ?? null };
  }

  async documents(a: ApplicationRec): Promise<ApplicationDocument[]> {
    const rows = await this.repo.find('application_documents', { application_id: a.id }, { orderBy: [['uploaded_at', 'asc']] });
    const refs = await this.core.mediaRefs(rows.map((d) => d.media_id));
    return rows.map((d) => map.document(d, refs, this.core.fallbackUrl));
  }

  private async latestRequest(appId: string): Promise<InfoRequestRec | undefined> {
    return this.repo.findOne('information_requests', { application_id: appId }, { orderBy: [['requested_at', 'desc']] });
  }

  async view(a: ApplicationRec): Promise<SellerApplication> {
    const now = this.now();
    const sec = this.sections(a);
    const missing = missingFields(sec);
    const done = map.strings(a.completed_steps);
    const accepted = await this.repo.find('agreement_acceptances', { application_id: a.id }, { orderBy: [['accepted_at', 'asc']] });
    const seller = a.seller_id ? await this.repo.get('sellers', a.seller_id) : undefined;
    const request = await this.latestRequest(a.id);
    const appeal = await this.repo.findOne('appeals', { subject: 'application_rejection', subject_id: a.id }, { orderBy: [['level', 'desc']] });
    const events = seller ? await this.repo.find('account_events', { seller_id: seller.id, visibility: 'seller' }, { orderBy: [['at', 'asc']], limit: 100 }) : [];
    const payout = sec.payout?.current ?? sec.payout?.pendingChange ?? null;
    const agreementDone = a.state !== 'draft';
    let setupSummary: SellerApplication['setupSummary'] = null;
    if (a.state === 'approved' && seller) {
      const x = await this.parts.accounts.setupSteps(seller, []);
      setupSummary = {
        accountStatus: this.parts.accounts.statusLine(seller, await this.parts.accounts.restrictionSummaries(seller.id)),
        productApproval: x.pa,
        payoutReadiness: x.readiness,
        steps: x.steps,
        completed: x.completed,
        total: x.total,
      };
    }
    return {
      id: a.id,
      ref: a.ref,
      sellerId: a.seller_id,
      state: a.state as SellerApplication['state'],
      sellerStatus: (seller?.status as SellerApplication['sellerStatus']) ?? null,
      currentStep: a.current_step as SellerApplication['currentStep'],
      completedSteps: agreementDone ? [...done, 'agreement'] : done,
      percentComplete: percentComplete(done, agreementDone),
      missing,
      account: sec.account,
      business: sec.business,
      verification: this.verificationView(sec.verification),
      payout: payout ? { accountHolderName: payout.accountHolderName, accountType: payout.accountType, label: payout.label, providerDestinationId: payout.providerDestinationId } : null,
      returnAddress: sec.returnAddress,
      agreementsRequired: await this.core.currentAgreements(),
      agreementsAccepted: accepted.map(map.acceptance),
      documents: await this.documents(a),
      informationRequest: request ? map.infoRequest(request, now) : null,
      decision: (a.decision as SellerApplication['decision']) ?? null,
      appealId: appeal?.id ?? null,
      timeline: [{ at: map.isoReq(a.created_at), label: 'Application started', detail: null, actor: null }, ...events.map(map.timelineEvent)],
      draftSavedAt: map.isoReq(a.draft_saved_at),
      submittedAt: map.iso(a.submitted_at),
      decisionTargetAt: map.iso(a.decision_target_at),
      setupSummary,
    };
  }

  /* ---------------------------------------------------------------- store: the application */

  private codeFor(invitationId: string) {
    const mac = createHmac('sha256', secretFor(this.ctx.config, 'sellers.seller-invitation')).update(invitationId).digest('hex');
    return mac.slice(0, 12).toUpperCase();
  }
  private codeHash = (code: string) => createHash('sha256').update(code.trim().toUpperCase()).digest('hex');

  /** The invitation code to send to the business (derived from the invitation, never stored in clear) */
  invitationCode(invitationId: string) {
    return this.codeFor(invitationId);
  }

  async startApplication(accountId: string, body: ApplicationAccountInput, by: By): Promise<SellerApplication> {
    const issues: { path: string; message: string }[] = [];
    if (!body.contactName.trim()) issues.push({ path: 'contactName', message: 'Enter your name' });
    if (!body.storeName.trim()) issues.push({ path: 'storeName', message: 'Enter a store name' });
    if (body.market.trim().toUpperCase() !== 'US') issues.push({ path: 'market', message: 'Marketly accepts US sellers only at launch' });
    if (issues.length) throw invalid(issues);
    const latest = await this.repo.latestApplicationOf(accountId);
    if (latest && OPEN_STATES.includes(latest.state)) throw new AppError('APPLICATION_EXISTS', 'You already have an open application', { applicationId: latest.id });
    if (latest?.state === 'rejected') {
      const d = (latest.decision ?? {}) as { notEligibleToReapply?: boolean };
      if (d.notEligibleToReapply) throw new AppError('REAPPLY_NOT_YET', 'This account is not eligible to apply again', { canReapplyFrom: null, notEligible: true });
      if (latest.can_reapply_from && latest.can_reapply_from > this.core.today()) throw new AppError('REAPPLY_NOT_YET', `You can apply again from ${latest.can_reapply_from}`, { canReapplyFrom: latest.can_reapply_from });
    }
    let invitation = body.invitationCode ? await this.repo.findOne('seller_invitations', { code_hash: this.codeHash(body.invitationCode) }) : undefined;
    if (invitation && (invitation.state !== 'sent' || invitation.expires_at.getTime() < this.now().getTime())) invitation = undefined;
    if (!(await this.core.setting('applicationsOpen')) && !invitation) {
      throw new AppError('INVITATION_REQUIRED', body.invitationCode ? 'This invitation code is not valid any more' : 'Applications are invite-only right now; enter your invitation code');
    }
    const now = this.now();
    const { invitationCode: _code, ...account } = body;
    const sec: ApplicationSections = { account: { ...account, workEmail: account.workEmail.trim().toLowerCase(), market: 'US' }, business: null, verification: null, payout: null, returnAddress: null };
    const done = completedSteps(missingFields(sec));
    // refs and settings use their own connection: read them before the transaction
    const ref = await this.ctx.refs.next('SA', { digits: 4 });
    const row = await this.repo.transaction(async (tx) => {
      const a = await tx.insert('applications', {
        id: newId(),
        ref,
        applicant_account_id: accountId,
        seller_id: null,
        invitation_id: invitation?.id ?? null,
        state: sellerApplicationMachine.initial,
        current_step: nextStep(done, 'account'),
        completed_steps: done as never,
        account: sec.account as never,
        business: {} as never,
        verification: {} as never,
        payout: {} as never,
        return_address: {} as never,
        decision: null,
        reviewer_id: null,
        submitted_at: null,
        decision_target_at: null,
        can_reapply_from: null,
        draft_saved_at: now,
        created_at: now,
      });
      if (invitation) await tx.update('seller_invitations', invitation.id, { state: this.core.step(sellerInvitationMachine, invitation.state, 'apply'), application_id: a.id });
      return a;
    });
    return this.view(row);
  }

  async getMyApplication(accountId: string): Promise<SellerApplication> {
    const a = await this.repo.latestApplicationOf(accountId);
    if (!a) throw notFound('Application');
    return this.view(a);
  }

  private ownersFrom(input: unknown[], before: StoredOwner[]): { owners: StoredOwner[]; issues: { path: string; message: string }[] } {
    const issues: { path: string; message: string }[] = [];
    const owners: StoredOwner[] = [];
    input.forEach((raw, i) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      const pct = Number(o.ownershipPct);
      if (!name) issues.push({ path: `verification.owners.${i}.name`, message: 'Enter the owner’s name' });
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) issues.push({ path: `verification.owners.${i}.ownershipPct`, message: 'Between 1 and 100' });
      const docs = Array.isArray(o.idDocumentIds) ? o.idDocumentIds.filter(isUuid) : [];
      const prior = before.find((b) => b.name.toLowerCase() === name.toLowerCase());
      owners.push({ id: prior?.id ?? newId(), name, ownershipPct: pct, isPrimary: Boolean(o.isPrimary), idDocumentIds: docs.length ? docs : (prior?.idDocumentIds ?? []), verificationState: prior?.verificationState ?? 'not_started' });
    });
    if (owners.filter((o) => o.isPrimary).length > 1) issues.push({ path: 'verification.owners', message: 'Only one owner can be the primary owner' });
    if (owners.reduce((t, o) => t + (o.ownershipPct || 0), 0) > 100) issues.push({ path: 'verification.owners', message: 'Ownership cannot add up to more than 100%' });
    return { owners, issues };
  }

  async updateApplication(accountId: string, id: string, body: UpdateBody, by: By): Promise<SellerApplication> {
    const a = await this.own(accountId, id);
    if (!EDITABLE.includes(a.state)) throw this.illegal(a, 'update');
    const given: string[] = [];
    if (body.account) given.push('account');
    if (body.business) given.push('business');
    if (body.verification) given.push('verification');
    if (body.payout) given.push('payout');
    if (body.returnAddress) given.push('return_address');
    if (a.state === 'information_required') {
      const req = await this.repo.findOne('information_requests', { application_id: a.id, state: 'open' });
      const allowed = new Set(((req?.items ?? []) as unknown as InfoRequestItem[]).map((i) => i.neededFor));
      const refused = given.filter((s) => !allowed.has(s as InfoRequestItem['neededFor']));
      if (refused.length) throw invalid(refused.map((s) => ({ path: s, message: 'Only the sections named in the information request can change now' })));
    }
    const sec = this.sections(a);
    const issues: { path: string; message: string }[] = [];
    if (body.account) {
      const { invitationCode: _c, ...acc } = body.account;
      sec.account = { ...acc, workEmail: acc.workEmail.trim().toLowerCase() };
    }
    if (body.business) {
      if (!body.business.categoryIds.length) issues.push({ path: 'business.categoryIds', message: 'Choose at least one category' });
      sec.business = body.business;
    }
    if (body.verification) {
      const v = body.verification;
      const { owners, issues: ownerIssues } = this.ownersFrom(v.owners, sec.verification?.owners ?? []);
      issues.push(...ownerIssues);
      let tax: Partial<StoredVerification> = { taxIdType: sec.verification?.taxIdType, taxIdLast4: sec.verification?.taxIdLast4, taxIdEncrypted: sec.verification?.taxIdEncrypted };
      if (v.taxId) {
        if (!validTaxId(v.taxIdType, v.taxId)) issues.push({ path: 'verification.taxId', message: v.taxIdType === 'ein' ? 'Enter the 9-digit EIN' : 'Enter a valid 9-digit SSN' });
        else {
          const digits = taxIdDigits(v.taxId);
          tax = { taxIdType: v.taxIdType, taxIdLast4: digits.slice(-4), taxIdEncrypted: this.core.cipher.encrypt(digits).toString('base64') };
        }
      }
      if (v.w9Method === 'uploaded' && v.w9DocumentId && !isUuid(v.w9DocumentId)) issues.push({ path: 'verification.w9DocumentId', message: 'Attach the W-9 first' });
      sec.verification = { owners, registrationDocumentIds: v.registrationDocumentIds ?? sec.verification?.registrationDocumentIds ?? [], ...tax, w9Method: v.w9Method, w9DocumentId: v.w9DocumentId ?? sec.verification?.w9DocumentId ?? null };
    }
    if (body.payout) {
      const details = await this.parts.accounts.tokenizePayout(body.payout);
      sec.payout = { ...(sec.payout ?? {}), current: details, pendingChange: null };
    }
    if (body.returnAddress) {
      const r = body.returnAddress;
      if (!r.sameAsBusiness && !r.address) issues.push({ path: 'returnAddress.address', message: 'Enter the return address' });
      sec.returnAddress = { sameAsBusiness: r.sameAsBusiness, contactName: r.contactName, phone: r.phone, address: r.sameAsBusiness ? (sec.business?.address ?? null) : (r.address ?? null) };
    } else if (body.business && sec.returnAddress?.sameAsBusiness) {
      sec.returnAddress = { ...sec.returnAddress, address: sec.business?.address ?? null };
    }
    if (issues.length) throw invalid(issues);
    const done = completedSteps(missingFields(sec));
    const after = await this.repo.update('applications', a.id, {
      account: (sec.account ?? {}) as never,
      business: (sec.business ?? {}) as never,
      verification: (sec.verification ?? {}) as never,
      payout: (sec.payout ?? {}) as never,
      return_address: (sec.returnAddress ?? {}) as never,
      completed_steps: done as never,
      current_step: nextStep(done, body.step),
      draft_saved_at: this.now(),
    });
    return this.view(after);
  }

  async addApplicationDocument(accountId: string, id: string, body: { mediaId: string; kind: ApplicationDocument['kind']; ownerId?: string | null; infoRequestItemId?: string | null }, by: By): Promise<ApplicationDocument> {
    const a = await this.own(accountId, id);
    if (!EDITABLE.includes(a.state)) throw this.illegal(a, 'addDocument', 'Documents can be added to a draft or for an open information request');
    const sec = this.sections(a);
    const v: StoredVerification = sec.verification ?? { owners: [], registrationDocumentIds: [] };
    if (body.ownerId && !v.owners.some((o) => o.id === body.ownerId)) throw invalid([{ path: 'ownerId', message: 'Unknown owner; save the verification step first' }]);
    const request = body.infoRequestItemId ? await this.repo.findOne('information_requests', { application_id: a.id, state: 'open' }) : undefined;
    const items = ((request?.items ?? []) as unknown as InfoRequestItem[]).map((i) => ({ ...i }));
    if (body.infoRequestItemId && !items.some((i) => i.id === body.infoRequestItemId)) throw invalid([{ path: 'infoRequestItemId', message: 'Not an item of the open information request' }]);
    const media = this.ctx.use('media');
    const asset = await media.getAsset(body.mediaId);
    if (!asset) throw invalid([{ path: 'mediaId', message: 'Upload the file first' }]);
    await media.attach(body.mediaId, { module: 'sellers', kind: 'verification_document', refId: a.id, refLabel: `Application ${a.ref}` }, { kind: 'customer', id: accountId });
    const doc = await this.repo.transaction(async (tx) => {
      const d = await tx.insert('application_documents', {
        id: newId(),
        application_id: a.id,
        seller_id: a.seller_id,
        kind: body.kind,
        media_id: body.mediaId,
        file_name: asset.fileName,
        size_bytes: asset.sizeBytes,
        status: 'uploaded',
        note: null,
        delete_after: null,
        uploaded_at: this.now(),
      });
      let changed = false;
      if (body.ownerId) {
        v.owners = v.owners.map((o) => (o.id === body.ownerId ? { ...o, idDocumentIds: [...new Set([...(o.idDocumentIds ?? []), d.id])] } : o));
        changed = true;
      }
      if (body.kind === 'business_registration') {
        v.registrationDocumentIds = [...new Set([...(v.registrationDocumentIds ?? []), d.id])];
        changed = true;
      }
      if (body.kind === 'tax_form') {
        v.w9DocumentId = d.id;
        changed = true;
      }
      if (changed) {
        const done = completedSteps(missingFields({ ...sec, verification: v }));
        await tx.update('applications', a.id, { verification: v as never, completed_steps: done as never, draft_saved_at: this.now() });
      }
      if (request && body.infoRequestItemId) {
        const next = items.map((i) => (i.id === body.infoRequestItemId ? { ...i, response: { ...((i.response ?? {}) as object), documentIds: [...new Set([...(((i.response ?? {}) as { documentIds?: string[] }).documentIds ?? []), d.id])] } } : i));
        await tx.update('information_requests', request.id, { items: next as never });
      }
      return d;
    });
    const refs = await this.core.mediaRefs([doc.media_id]);
    return map.document(doc, refs, this.core.fallbackUrl);
  }

  async removeApplicationDocument(accountId: string, id: string, documentId: string, by: By) {
    const a = await this.own(accountId, id);
    const d = isUuid(documentId) ? await this.repo.get('application_documents', documentId) : undefined;
    if (!d || d.application_id !== a.id) throw notFound('Document');
    if (!EDITABLE.includes(a.state)) throw this.illegal(a, 'removeDocument', 'Documents can be removed from a draft or during an information request');
    const sec = this.sections(a);
    const v = sec.verification;
    await this.repo.transaction(async (tx) => {
      await tx.remove('application_documents', d.id);
      if (v) {
        const next: StoredVerification = {
          ...v,
          owners: v.owners.map((o) => ({ ...o, idDocumentIds: (o.idDocumentIds ?? []).filter((x) => x !== d.id) })),
          registrationDocumentIds: (v.registrationDocumentIds ?? []).filter((x) => x !== d.id),
          w9DocumentId: v.w9DocumentId === d.id ? null : (v.w9DocumentId ?? null),
        };
        await tx.update('applications', a.id, { verification: next as never, completed_steps: completedSteps(missingFields({ ...sec, verification: next })) as never });
      }
    });
    await this.ctx.use('media').detach(d.media_id, { module: 'sellers', kind: 'verification_document', refId: a.id });
  }

  private async uniqueSlug(name: string, repo: SellersRepository) {
    const base = slugify(name);
    if (!(await repo.slugTaken(base))) return base;
    for (let i = 2; i < 50; i++) if (!(await repo.slugTaken(`${base}-${i}`))) return `${base}-${i}`;
    return `${base}-${newId().slice(-6)}`;
  }

  async submitApplication(accountId: string, id: string, body: { acceptances: unknown[]; signedName: string }, by: By): Promise<SellerApplication> {
    const a = await this.own(accountId, id);
    if (!sellerApplicationMachine.can(a.state as never, 'submit' as never)) throw this.illegal(a, 'submit');
    const sec = this.sections(a);
    const missing = missingFields(sec);
    const docs = await this.repo.find('application_documents', { application_id: a.id });
    const docIds = new Set(docs.map((d) => d.id));
    const owners = sec.verification?.owners ?? [];
    if (owners.some((o) => !(o.idDocumentIds ?? []).some((x) => docIds.has(x)))) (missing.verification ??= []).push('owners.idDocumentIds');
    const required = await this.core.currentAgreements();
    const acceptances = (body.acceptances ?? []) as { key?: string; versionLabel?: string; policyVersionId?: string | null }[];
    const notAccepted: string[] = [];
    for (const doc of required) {
      const acc = acceptances.find((x) => x?.key === doc.key);
      if (!acc) notAccepted.push(doc.key);
      else if (acc.versionLabel !== doc.versionLabel || (doc.policyVersionId && acc.policyVersionId && acc.policyVersionId !== doc.policyVersionId)) {
        throw new AppError('AGREEMENT_VERSION_OUTDATED', `${doc.title} ${doc.versionLabel} is now in force; reload and accept it`, { key: doc.key, versionLabel: doc.versionLabel });
      }
    }
    if (!body.signedName?.trim()) notAccepted.push('signedName');
    if (notAccepted.length) missing.agreement = notAccepted;
    for (const k of Object.keys(missing)) if (!missing[k]!.length) delete missing[k];
    if (Object.keys(missing).length) throw new AppError('APPLICATION_INCOMPLETE', 'Some steps are missing information', { missing });

    const now = this.now();
    const b = sec.business!;
    const acc = sec.account!;
    const v = sec.verification!;
    const risky = riskCategoriesIn(`${b.plannedProducts ?? ''} ${b.shippingPlan ?? ''}`, (await this.core.setting('riskReviewCategories')) as readonly string[]);
    const target = addBusinessDays(now, await this.core.setting('decisionTargetBusinessDays'));
    const sellerRef = await this.ctx.refs.next('SL', { daily: false });
    const res = await this.repo.transaction(async (tx) => {
      const locked = await this.own(accountId, id, tx, true);
      if (locked.state !== 'draft') throw this.illegal(locked, 'submit');
      const seller = await tx.insert('sellers', {
        id: newId(),
        ref: sellerRef,
        slug: await this.uniqueSlug(b.storeName || acc.storeName || 'store', tx),
        store_name: (b.storeName || acc.storeName || '').trim(),
        legal_name: b.legalName!.trim(),
        seller_type: acc.sellerType ?? (b.kind === 'individual' ? 'individual' : 'business'),
        business_type: b.businessType!,
        state_of_registration: b.stateOfRegistration || null,
        registry_number: b.registryNumber ?? null,
        tax_id_type: v.taxIdType!,
        tax_id_encrypted: Buffer.from(v.taxIdEncrypted ?? '', 'base64'),
        tax_id_last4: v.taxIdLast4!,
        business_address: b.address as never,
        phone: b.phone!,
        website: b.website ?? null,
        contact: { name: acc.contactName, email: acc.workEmail, phone: acc.contactPhone, supportHours: b.supportHours ?? null } as never,
        market: acc.market ?? 'US',
        status: sellerAccountStatusMachine.initial,
        status_since: now,
        closed_reason: null,
        verification_state: 'not_verified',
        verification_checked: { checked: [], reason: null } as never,
        verified_at: null,
        verification_expires_at: null,
        launch_review: { state: 'not_started', issues: [] } as never,
        payout_readiness: 'not_added',
        payout_destination_label: null,
        account_manager_id: null,
        application_id: locked.id,
        approved_at: null,
        created_at: now,
        updated_at: now,
      });
      const ownersPending = v.owners.map((o) => ({ ...o, verificationState: 'pending' as const }));
      const after = await tx.update('applications', locked.id, {
        state: this.core.step(sellerApplicationMachine, locked.state, 'submit'),
        seller_id: seller.id,
        submitted_at: now,
        decision_target_at: target,
        current_step: 'agreement',
        verification: { ...v, owners: ownersPending } as never,
      });
      for (const d of docs) await tx.update('application_documents', d.id, { seller_id: seller.id });
      for (const doc of required) {
        await tx.insert('agreement_acceptances', {
          id: newId(),
          seller_id: seller.id,
          application_id: locked.id,
          policy_key: doc.key,
          version_label: doc.versionLabel,
          policy_version_id: doc.policyVersionId ?? null,
          signed_name: body.signedName.trim(),
          accepted_by: map.actorText(by.actor),
          ip: null,
          accepted_at: now,
        });
      }
      const kinds: CheckKind[] = ['identity', ...(b.kind === 'registered_business' ? (['business_registration'] as const) : []), 'tax_id', 'payout_account', 'return_address', 'sanctions'];
      for (const kind of kinds) {
        await tx.insert('verification_checks', { id: newId(), application_id: locked.id, seller_id: seller.id, kind, result: 'pending', summary: 'Waiting for the automated check', source: 'automated', provider: null, provider_ref: null, accepted_note: null, checked_by: null, checked_at: null });
      }
      await tx.insert('risk_reviews', {
        id: newId(),
        application_id: locked.id,
        trust_report_id: null,
        state: risky.length ? 'requested' : 'not_needed',
        level: null,
        flags: (risky.length ? [{ severity: 'medium', text: `Product plan includes ${risky.join(', ')} (referred to Trust and Risk)` }] : []) as never,
        recommendation: null,
        reviewed_by: null,
        reviewed_at: null,
      });
      await this.core.timeline(tx, seller.id, { kind: 'applied', title: 'Application submitted', detail: `Decision target ${isoDate(target)}`, actor: by.actor, ref: locked.ref });
      return { after, seller };
    });
    this.core.publish('sellers.application.submitted', { applicationId: a.id, sellerId: res.seller.id, categoryIds: b.categoryIds ?? [], sellerType: res.seller.seller_type, invited: Boolean(a.invitation_id) }, by);
    for (const doc of required) this.core.publish('sellers.agreement.accepted', { sellerId: res.seller.id, applicationId: a.id, key: doc.key, versionLabel: doc.versionLabel }, by);
    try {
      await this.runChecks({ applicationId: a.id });
    } catch (err) {
      this.ctx.log.warn({ err, applicationId: a.id }, 'sellers: verification checks will be retried by the job');
    }
    return this.view(await this.byId(a.id));
  }

  async respondToInformationRequest(accountId: string, id: string, body: { items: unknown[] }, by: By): Promise<SellerApplication> {
    const a = await this.own(accountId, id);
    if (a.state !== 'information_required') throw this.illegal(a, 'respond');
    const req = await this.repo.findOne('information_requests', { application_id: a.id, state: 'open' });
    if (!req) throw this.illegal(a, 'respond');
    const docs = new Set((await this.repo.find('application_documents', { application_id: a.id })).map((d) => d.id));
    const answers = (body.items ?? []) as { itemId?: string; documentIds?: string[]; note?: string }[];
    const items = (req.items as unknown as InfoRequestItem[]).map((i) => ({ ...i }));
    const issues: { path: string; message: string }[] = [];
    const sectionUpdated = a.draft_saved_at.getTime() > req.requested_at.getTime();
    for (const item of items.filter((i) => i.status === 'open')) {
      const ans = answers.find((x) => x?.itemId === item.id);
      const prior = (item.response ?? {}) as { documentIds?: string[] };
      const docIds = [...new Set([...(ans?.documentIds ?? []), ...(prior.documentIds ?? [])])];
      if (docIds.some((d) => !docs.has(d))) issues.push({ path: `items.${item.id}.documentIds`, message: 'Attach the documents to the application first' });
      const ok = item.documentKind ? docIds.length > 0 : docIds.length > 0 || Boolean(ans?.note?.trim()) || sectionUpdated;
      if (!ok) issues.push({ path: `items.${item.id}`, message: item.documentKind ? `Add the ${item.title}` : `Answer: ${item.title}` });
      else {
        item.status = 'provided';
        item.response = { documentIds: docIds, note: ans?.note?.trim() || null };
      }
    }
    if (issues.length) throw invalid(issues);
    const now = this.now();
    await this.repo.transaction(async (tx) => {
      await tx.update('information_requests', req.id, { items: items as never, state: 'answered', responded_at: now });
      await tx.update('applications', a.id, { state: this.core.step(sellerApplicationMachine, a.state, 'respond') });
      if (a.seller_id) {
        const s = await this.core.seller(a.seller_id, { repo: tx, forUpdate: true });
        if (s.status === 'information_required') await tx.update('sellers', s.id, { status: this.core.step(sellerAccountStatusMachine, s.status, 'provideInformation'), status_since: now, updated_at: now });
        await this.core.timeline(tx, s.id, { kind: 'information_provided', title: 'Requested information sent', actor: by.actor, ref: a.ref });
      }
    });
    this.core.publish('sellers.application.information_provided', { applicationId: a.id, sellerId: a.seller_id! }, by);
    return this.view(await this.byId(a.id));
  }

  async withdrawApplication(accountId: string, id: string, reason: string | null | undefined, by: By): Promise<SellerApplication> {
    const a = await this.own(accountId, id);
    const state = this.core.step(sellerApplicationMachine, a.state, 'withdraw');
    const now = this.now();
    await this.repo.transaction(async (tx) => {
      await tx.update('applications', a.id, { state });
      for (const r of await tx.find('information_requests', { application_id: a.id, state: 'open' })) await tx.update('information_requests', r.id, { state: 'expired' });
      if (a.seller_id) {
        const s = await this.core.seller(a.seller_id, { repo: tx, forUpdate: true });
        if (sellerAccountStatusMachine.can(s.status as never, 'withdraw' as never)) {
          await tx.update('sellers', s.id, { status: this.core.step(sellerAccountStatusMachine, s.status, 'withdraw'), status_since: now, closed_reason: 'application_withdrawn', updated_at: now });
        }
        await this.core.timeline(tx, s.id, { kind: 'withdrawn', title: 'Application withdrawn', detail: reason ?? null, actor: by.actor, ref: a.ref });
      }
    });
    this.core.publish('sellers.application.withdrawn', { applicationId: a.id, sellerId: a.seller_id }, by);
    await this.core.resolveWork(`application_overdue:${a.id}`, 'Application withdrawn', by.actor);
    return this.view(await this.byId(a.id));
  }

  async appealApplicationDecision(accountId: string, id: string, input: AppealInput, by: By): Promise<Appeal> {
    const a = await this.own(accountId, id);
    if (a.state !== 'rejected' || !a.seller_id) throw this.illegal(a, 'appeal', 'Only a rejected application can be appealed');
    const d = (a.decision ?? {}) as { appealDeadline?: string; decidedBy?: common.Actor };
    return this.parts.enforcement.fileAppeal(
      {
        sellerId: a.seller_id,
        subject: 'application_rejection',
        subjectId: a.id,
        deadline: d.appealDeadline ?? this.now().toISOString(),
        originalDeciderId: d.decidedBy?.id ?? 'system',
        argument: input.argument,
        evidenceIds: input.evidenceIds,
        owner: { kind: 'customer', id: accountId },
      },
      by,
    );
  }

  /** An overturned rejection reopens the application under review */
  async reopenOnAppeal(applicationId: string, by: By) {
    const now = this.now();
    const target = addBusinessDays(now, await this.core.setting('decisionTargetBusinessDays'));
    await this.repo.transaction(async (tx) => {
      const a = await this.byId(applicationId, tx, true);
      if (a.state !== 'rejected') return;
      await tx.update('applications', a.id, { state: this.core.step(sellerApplicationMachine, a.state, 'reopenOnAppeal'), decision: null, can_reapply_from: null, decision_target_at: target });
      for (const d of await tx.find('application_documents', { application_id: a.id })) await tx.update('application_documents', d.id, { delete_after: null });
      if (a.seller_id) {
        const s = await this.core.seller(a.seller_id, { repo: tx, forUpdate: true });
        if (s.status === 'closed' && s.closed_reason === 'application_rejected') {
          await tx.update('sellers', s.id, { status: this.core.step(sellerAccountStatusMachine, s.status, 'reopenOnAppeal'), status_since: now, closed_reason: null, updated_at: now });
        }
        await this.core.timeline(tx, s.id, { kind: 'reopened', title: 'Application reopened after your appeal', actor: by.actor, ref: a.ref });
      }
    });
  }

  /* ---------------------------------------------------------------- admin: queue and detail */

  private async checksOf(appId: string) {
    return this.repo.find('verification_checks', { application_id: appId }, { orderBy: [['kind', 'asc']] });
  }

  /** The latest check of each kind */
  private latestChecks(rows: CheckRec[]): CheckRec[] {
    const by = new Map<string, CheckRec>();
    for (const c of rows) {
      const prev = by.get(c.kind);
      if (!prev || (c.checked_at?.getTime() ?? Number.MAX_SAFE_INTEGER) >= (prev.checked_at?.getTime() ?? Number.MAX_SAFE_INTEGER)) by.set(c.kind, c);
    }
    return [...by.values()];
  }

  blockingChecks(rows: CheckRec[]): string[] {
    return this.latestChecks(rows)
      .filter((c) => c.result === 'failed' || (c.result === 'needs_attention' && !c.accepted_note))
      .map((c) => c.kind);
  }

  async listApplications(q: { state?: string; reviewerId?: string; riskLevel?: string; overdue?: boolean; q?: string }, page: PageRequest): Promise<common.Page<ApplicationRow>> {
    const now = this.now();
    const p = await this.repo.listApplications({ ...q, now }, page);
    const ids = p.items.map((a) => a.id);
    const checks = await this.repo.find('verification_checks', { application_id: ids });
    const risks = await this.repo.find('risk_reviews', { application_id: ids });
    const names = new Map<string, string | null>();
    for (const r of new Set(p.items.map((a) => a.reviewer_id).filter((x): x is string => Boolean(x)))) names.set(r, await this.core.staffName(r));
    const cats = await this.categoryNames();
    const items: ApplicationRow[] = p.items.map((a) => {
      const sec = this.sections(a);
      const mine = this.latestChecks(checks.filter((c) => c.application_id === a.id));
      const count = (r: string) => mine.filter((c) => c.result === r).length;
      return {
        id: a.id,
        ref: a.ref,
        applicantName: sec.account?.contactName ?? '',
        storeName: this.storeNameOf(a),
        legalName: sec.business?.legalName ?? null,
        state: a.state,
        submittedAt: map.iso(a.submitted_at),
        deadline: a.decision_target_at && REVIEW_STATES.includes(a.state) ? deadline(a.decision_target_at, now) : null,
        reviewer: a.reviewer_id ? { kind: 'staff', id: a.reviewer_id, ...(names.get(a.reviewer_id) ? { name: names.get(a.reviewer_id)! } : {}) } : null,
        checks: { passed: count('passed'), needsAttention: count('needs_attention'), failed: count('failed'), pending: count('pending') },
        riskLevel: risks.find((r) => r.application_id === a.id)?.level ?? null,
        categories: (sec.business?.categoryIds ?? []).map((id) => cats.get(id) ?? id),
        invited: Boolean(a.invitation_id),
      };
    });
    return { ...p, items };
  }

  private async categoryNames() {
    const names = new Map<string, string>();
    const tree = await this.core.optional('catalog', 'categories', null, (c) => c.listCategories({ includeHidden: true }));
    const walk = (list: { id: string; name: string; children?: unknown[] }[]) => list.forEach((c) => (names.set(c.id, c.name), walk((c.children ?? []) as never)));
    walk((tree ?? []) as never);
    return names;
  }

  private async requiredDocuments(a: ApplicationRec): Promise<RequiredDocument[]> {
    const sec = this.sections(a);
    const docs = await this.repo.find('application_documents', { application_id: a.id });
    const ofKind = (k: string) => docs.filter((d) => d.kind === k).map((d) => d.id);
    const out: RequiredDocument[] = [];
    for (const o of sec.verification?.owners ?? []) {
      const ids = (o.idDocumentIds ?? []).filter((id) => docs.some((d) => d.id === id));
      out.push({ kind: 'owner_id', label: `Photo ID: ${o.name}`, reason: `Owner with ${o.ownershipPct}%`, requiredFor: 'identity', uploaded: ids.length > 0, documentIds: ids });
    }
    if (sec.business?.kind === 'registered_business') {
      const ids = ofKind('business_registration');
      out.push({ kind: 'business_registration', label: 'Business registration', reason: 'Registered business', requiredFor: 'business_registration', uploaded: ids.length > 0, documentIds: ids });
    }
    if (sec.verification?.w9Method === 'uploaded') {
      const ids = ofKind('tax_form');
      out.push({ kind: 'tax_form', label: 'Signed W-9', reason: 'W-9 uploaded instead of completed online', requiredFor: 'tax_id', uploaded: ids.length > 0, documentIds: ids });
    }
    const payout = sec.payout?.current;
    if (payout && !holderMatches(payout.accountHolderName, sec.business?.legalName, sec.verification?.owners ?? [])) {
      const ids = ofKind('bank_letter');
      out.push({ kind: 'bank_letter', label: 'Bank letter', reason: 'The account holder does not match the legal name or an owner', requiredFor: 'payout_account', uploaded: ids.length > 0, documentIds: ids });
    }
    for (const c of riskCategoriesIn(`${sec.business?.plannedProducts ?? ''}`, (await this.core.setting('riskReviewCategories')) as readonly string[])) {
      const ids = ofKind('category_certificate');
      out.push({ kind: 'category_certificate', label: `Certificates for ${c}`, reason: `Product plan includes ${c} (restricted category)`, requiredFor: c, uploaded: ids.length > 0, documentIds: ids });
    }
    return out;
  }

  private async duplicateSignals(a: ApplicationRec): Promise<string[]> {
    const sec = this.sections(a);
    const tokens = [sec.payout?.current?.providerDestinationId, sec.payout?.pendingChange?.providerDestinationId].filter((x): x is string => Boolean(x));
    const addr = sec.business?.address;
    const matches = await this.repo.applicationsMatching(
      { emails: sec.account?.workEmail ? [sec.account.workEmail] : [], tokens, addresses: addr ? [{ line1: addr.line1, postalCode: addr.postalCode }] : [] },
      a.id,
    );
    const out: string[] = [];
    for (const m of matches) {
      const ms = this.sections(m);
      const why: string[] = [];
      if (ms.account?.workEmail && ms.account.workEmail === sec.account?.workEmail) why.push('work email');
      const mt = [ms.payout?.current?.providerDestinationId, ms.payout?.pendingChange?.providerDestinationId];
      if (tokens.some((t) => mt.includes(t))) why.push('bank account');
      if (addr && ms.business?.address && ms.business.address.line1.toLowerCase() === addr.line1.toLowerCase() && ms.business.address.postalCode === addr.postalCode) why.push('business address');
      const seller = m.seller_id ? await this.repo.get('sellers', m.seller_id) : undefined;
      out.push(`Same ${why.join(', ')} as ${m.ref} (${seller ? `${seller.store_name}, ${seller.status}` : m.state})`);
    }
    return out;
  }

  async adminView(a: ApplicationRec): Promise<ApplicationAdmin> {
    const checks = await this.checksOf(a.id);
    const risk = await this.repo.findOne('risk_reviews', { application_id: a.id });
    const notes = await this.repo.find('seller_notes', { application_id: a.id }, { orderBy: [['created_at', 'desc']] });
    const reviewerName = await this.core.staffName(a.reviewer_id);
    return {
      application: await this.view(a),
      checks: checks.map(map.check),
      riskReview: map.riskReview(risk),
      reviewer: a.reviewer_id ? { kind: 'staff', id: a.reviewer_id, ...(reviewerName ? { name: reviewerName } : {}) } : null,
      notes: notes.map(map.note),
      duplicateSignals: await this.duplicateSignals(a),
      approveBlockedBy: this.blockingChecks(checks),
      requiredDocuments: await this.requiredDocuments(a),
      deadline: a.decision_target_at && REVIEW_STATES.includes(a.state) ? deadline(a.decision_target_at, this.now()) : null,
    };
  }

  async getApplicationAdmin(id: string) {
    return this.adminView(await this.byId(id));
  }

  private appTarget(a: ApplicationRec) {
    return { type: 'application', id: a.id, ref: a.ref, label: this.storeNameOf(a), sellerId: a.seller_id, screen: 'admin/applications' };
  }

  async assignApplication(id: string, reviewerId: string, by: By) {
    const a = await this.byId(id);
    if (a.state === 'draft') throw this.illegal(a, 'assign', 'Draft applications cannot be assigned');
    const after = await this.repo.update('applications', a.id, { reviewer_id: reviewerId });
    await this.core.audit({ action: 'sellers.application.assign', actionLabel: 'Assigned an application reviewer', category: 'other', target: this.appTarget(a), before: { reviewerId: a.reviewer_id }, after: { reviewerId } }, by);
    return this.adminView(after);
  }

  async startApplicationReview(id: string, by: By) {
    const now = this.now();
    const after = await this.repo.transaction(async (tx) => {
      const a = await this.byId(id, tx, true);
      const state = this.core.step(sellerApplicationMachine, a.state, 'startReview');
      const row = await tx.update('applications', a.id, { state, reviewer_id: a.reviewer_id ?? by.actor.id ?? null });
      if (a.seller_id) {
        const s = await this.core.seller(a.seller_id, { repo: tx, forUpdate: true });
        if (s.status === 'applied') await tx.update('sellers', s.id, { status: this.core.step(sellerAccountStatusMachine, s.status, 'startReview'), status_since: now, updated_at: now });
        await this.core.timeline(tx, s.id, { kind: 'under_review', title: 'Application under review', actor: by.actor, ref: a.ref });
      }
      return row;
    });
    await this.core.audit({ action: 'sellers.application.start_review', actionLabel: 'Started an application review', category: 'other', target: this.appTarget(after), before: { state: 'submitted' }, after: { state: after.state } }, by);
    return this.adminView(after);
  }

  private async checkOf(appId: string, checkId: string) {
    const c = isUuid(checkId) ? await this.repo.get('verification_checks', checkId) : undefined;
    if (!c || c.application_id !== appId) throw notFound('Check');
    return c;
  }

  async rerunCheck(id: string, checkId: string, by: By): Promise<VerificationCheck> {
    const a = await this.byId(id);
    const c = await this.checkOf(a.id, checkId);
    await this.repo.update('verification_checks', c.id, { result: 'pending', summary: 'Running the check again', source: 'automated', provider: null, provider_ref: null, accepted_note: null, checked_by: null, checked_at: null });
    await this.runChecks({ applicationId: a.id, checkId: c.id });
    return map.check((await this.repo.get('verification_checks', c.id))!);
  }

  async recordCheckResult(id: string, checkId: string, body: { result: 'passed' | 'needs_attention' | 'failed'; note: string; acceptForApproval?: boolean | null }, by: By): Promise<VerificationCheck> {
    if (!body.note?.trim()) throw invalid([{ path: 'note', message: 'Record what you checked' }]);
    const a = await this.byId(id);
    const c = await this.checkOf(a.id, checkId);
    const accepted = body.result === 'needs_attention' && body.acceptForApproval ? body.note.trim() : null;
    const after = await this.repo.update('verification_checks', c.id, {
      result: body.result,
      summary: body.note.trim(),
      source: 'manual',
      accepted_note: accepted,
      checked_by: map.actorText(by.actor),
      checked_at: this.now(),
    });
    if (c.kind === 'identity') await this.setOwnersState(a.id, body.result);
    await this.core.audit({ action: 'sellers.check.record', actionLabel: 'Recorded a verification check result', category: 'other', target: this.appTarget(a), before: { kind: c.kind, result: c.result }, after: { kind: c.kind, result: body.result, acceptedWithNote: accepted } }, by);
    return map.check(after);
  }

  async requestTrustReview(id: string, question: string, by: By): Promise<RiskReview> {
    if (!question?.trim()) throw invalid([{ path: 'question', message: 'What should Trust and Risk look at?' }]);
    const a = await this.byId(id);
    if (!REVIEW_STATES.includes(a.state)) throw this.illegal(a, 'trustReview', 'Only applications in review can be referred');
    const trust = this.ctx.tryUse('trust');
    if (!trust) throw new AppError('SERVICE_UNAVAILABLE', 'Trust and Risk reviews are unavailable right now');
    const r = await trust.requestAssessment({ subjectType: 'seller_application', subjectId: a.id, ...(a.seller_id ? { sellerId: a.seller_id } : {}), question: question.trim(), requestedBy: by.actor });
    const existing = await this.repo.findOne('risk_reviews', { application_id: a.id });
    const row = existing
      ? await this.repo.update('risk_reviews', existing.id, { state: 'requested', trust_report_id: r.reportId })
      : await this.repo.insert('risk_reviews', { id: newId(), application_id: a.id, trust_report_id: r.reportId, state: 'requested', level: null, flags: [] as never, recommendation: null, reviewed_by: null, reviewed_at: null });
    await this.core.audit({ action: 'sellers.application.trust_review', actionLabel: 'Referred an application to Trust and Risk', category: 'other', target: this.appTarget(a), reason: question, after: { trustReportId: r.reportId } }, by);
    return map.riskReview(row);
  }

  async requestApplicationInformation(id: string, body: { items: unknown[]; message: string; dueAt: string; reminder: 'three_days_before' | 'none' }, by: By) {
    const raw = (body.items ?? []) as { title?: string; detail?: string; neededFor?: string; documentKind?: string | null }[];
    const kinds = ['account', 'business', 'verification', 'payout', 'return_address', 'agreement', 'category'];
    const issues: { path: string; message: string }[] = [];
    if (!raw.length) issues.push({ path: 'items', message: 'List at least one item' });
    raw.forEach((i, n) => {
      if (!i?.title?.trim()) issues.push({ path: `items.${n}.title`, message: 'Name the item' });
      if (!i?.neededFor || !kinds.includes(i.neededFor)) issues.push({ path: `items.${n}.neededFor`, message: `One of ${kinds.join(', ')}` });
    });
    if (!body.message?.trim()) issues.push({ path: 'message', message: 'Write the message the applicant reads' });
    if (new Date(body.dueAt).getTime() <= this.now().getTime()) issues.push({ path: 'dueAt', message: 'The deadline must be in the future' });
    if (issues.length) throw invalid(issues);
    const items: InfoRequestItem[] = raw.map((i) => ({ id: newId(), title: i.title!.trim(), detail: i.detail?.trim() ?? '', neededFor: i.neededFor as InfoRequestItem['neededFor'], documentKind: i.documentKind ?? null, status: 'open', response: null }));
    const now = this.now();
    const after = await this.repo.transaction(async (tx) => {
      const a = await this.byId(id, tx, true);
      const state = this.core.step(sellerApplicationMachine, a.state, 'requestInformation');
      for (const r of await tx.find('information_requests', { application_id: a.id, state: 'open' })) await tx.update('information_requests', r.id, { state: 'expired' });
      await tx.insert('information_requests', {
        id: newId(),
        application_id: a.id,
        items: items as never,
        message: body.message.trim(),
        due_at: new Date(body.dueAt),
        reminder: body.reminder,
        reminded_at: null,
        requested_by: map.actorText(by.actor),
        requested_at: now,
        responded_at: null,
        state: 'open',
      });
      const row = await tx.update('applications', a.id, { state });
      if (a.seller_id) {
        const s = await this.core.seller(a.seller_id, { repo: tx, forUpdate: true });
        if (sellerAccountStatusMachine.can(s.status as never, 'requestInformation' as never)) {
          await tx.update('sellers', s.id, { status: this.core.step(sellerAccountStatusMachine, s.status, 'requestInformation'), status_since: now, updated_at: now });
        }
        await this.core.timeline(tx, s.id, { kind: 'information_requested', title: 'More information requested', detail: body.message.trim(), actor: by.actor, ref: a.ref });
      }
      return row;
    });
    this.core.publish('sellers.application.information_requested', { applicationId: after.id, sellerId: after.seller_id!, dueAt: new Date(body.dueAt).toISOString(), itemCount: items.length }, by);
    await this.core.audit({ action: 'sellers.application.request_information', actionLabel: 'Asked an applicant for information', category: 'other', target: this.appTarget(after), reason: body.message, after: { items: items.map((i) => i.title), dueAt: body.dueAt } }, by);
    return this.adminView(after);
  }

  /* ---------------------------------------------------------------- decisions */

  async approveApplication(id: string, body: { note?: string | null; conditions?: RestrictionInput[] | null; recommendedHoldDays?: number | null }, by: By) {
    const a0 = await this.byId(id);
    if (!sellerApplicationMachine.can(a0.state as never, 'approve' as never)) throw this.illegal(a0, 'approve');
    const blocking = this.blockingChecks(await this.checksOf(a0.id));
    if (blocking.length) throw new AppError('CHECKS_UNRESOLVED', 'Verification checks are failed or need attention without an accepted note', { checks: blocking });
    const retention = await this.core.setting('documentRetentionDays');
    const now = this.now();
    const decision = { outcome: 'approved', reasonCode: null, explanation: body.note?.trim() || 'Your application was approved.', ruleRef: null, canReapplyFrom: null, notEligibleToReapply: false, appealDeadline: null, conditions: [] as unknown[], decidedBy: by.actor, decidedAt: now.toISOString() };
    const res = await this.repo.transaction(async (tx) => {
      const a = await this.byId(id, tx, true);
      const state = this.core.step(sellerApplicationMachine, a.state, 'approve');
      let seller = await this.core.seller(a.seller_id!, { repo: tx, forUpdate: true });
      seller = await tx.update('sellers', seller.id, { status: this.core.step(sellerAccountStatusMachine, seller.status, 'approve'), status_since: now, approved_at: now, updated_at: now });
      const { blocking: labelBlocking } = await this.parts.accounts.labelChecks(seller, tx);
      const strict = this.latestChecks(await tx.find('verification_checks', { application_id: a.id })).every((c) => !['identity', 'business_registration', 'payout_account', 'return_address'].includes(c.kind) || c.result === 'passed');
      let granted = false;
      if (!labelBlocking.length && strict) {
        seller = await this.parts.accounts.grantLabel(tx, seller, by);
        granted = true;
      }
      const sec = this.sections(a);
      const owner = await this.parts.members.createOwner(tx, seller, { accountId: a.applicant_account_id, name: sec.account?.contactName ?? seller.legal_name, email: sec.account?.workEmail ?? '' });
      await this.parts.storefront.createProfile(tx, seller);
      for (const d of await tx.find('application_documents', { application_id: a.id, kind: 'owner_id' })) await tx.update('application_documents', d.id, { delete_after: isoDate(addDays(now, retention)) });
      const app = await tx.update('applications', a.id, { state, decision: decision as never, reviewer_id: a.reviewer_id ?? by.actor.id ?? null });
      let payout: Awaited<ReturnType<typeof this.parts.accounts.submitDestination>> | undefined;
      const details = sec.payout?.current;
      if (details) {
        payout = await this.parts.accounts.submitDestination(tx, seller, app, details, by);
        seller = payout.after;
      }
      await this.core.timeline(tx, seller.id, { kind: 'approved', title: 'Seller account approved', detail: body.note ?? null, actor: by.actor, ref: a.ref });
      return { app, seller, owner, granted, sec, payout };
    });
    const { seller, owner, sec } = res;
    const conditions: unknown[] = [];
    for (const c of body.conditions ?? []) {
      const r = await this.parts.enforcement.createRestriction(seller.id, { ...c, reasonCode: c.reasonCode ?? 'approval_condition' }, by, { skipAuthority: true });
      conditions.push({ id: r.id, ref: r.ref, title: r.title, since: r.startedAt ?? now.toISOString(), appealDeadline: r.appealRoute.deadline, reviewDate: r.reviewDate });
    }
    if (conditions.length) await this.repo.update('applications', res.app.id, { decision: { ...decision, conditions } as never });
    try {
      await this.parts.members.grant(seller, owner);
    } catch (err) {
      this.ctx.log.warn({ err, sellerId: seller.id }, 'sellers: could not grant the owner seller context yet');
    }
    const ret = sec.returnAddress;
    const address = (ret?.address ?? sec.business?.address) as common.Address;
    this.core.publish('sellers.application.decided', { applicationId: res.app.id, sellerId: seller.id, outcome: 'approved', reasonCode: null, decidedBy: by.actor.id ?? by.actor.kind }, by);
    this.core.publish(
      'sellers.seller.approved',
      {
        sellerId: seller.id,
        applicationId: res.app.id,
        storeName: seller.store_name,
        ownerAccountId: res.app.applicant_account_id,
        categoryIds: sec.business?.categoryIds ?? [],
        returnAddress: { ...address, name: ret?.contactName ?? address.name, phone: ret?.phone ?? address.phone ?? null },
        returnContact: ret?.contactName ?? sec.account?.contactName ?? '',
        recommendedHoldDays: body.recommendedHoldDays ?? null,
      },
      by,
    );
    if (res.payout) this.core.publish('sellers.payout_account.changed', res.payout.evt, by);
    if (res.granted) this.core.publish('sellers.verification.changed', { sellerId: seller.id, state: 'verified' }, by);
    await this.core.audit(
      { action: 'sellers.application.approve', actionLabel: 'Approved a seller application', category: 'seller_enforcement', target: this.appTarget(res.app), reason: body.note ?? null, before: { state: 'under_review' }, after: { state: 'approved', conditions, recommendedHoldDays: body.recommendedHoldDays ?? null } },
      by,
    );
    return this.adminView(await this.byId(res.app.id));
  }

  async rejectApplication(
    id: string,
    body: { reasonCode: 'unverified_identity_or_business' | 'outside_assortment' | 'risk_review_failed' | 'duplicate_account' | 'incomplete' | 'other'; explanation: string; ruleRef?: string | null; reapply: 'immediately' | 'after_30_days' | 'after_90_days' | 'not_eligible' },
    by: By,
  ) {
    if (!body.explanation?.trim()) throw invalid([{ path: 'explanation', message: 'Explain the decision to the applicant' }]);
    const now = this.now();
    const retention = await this.core.setting('documentRetentionDays');
    const window = await this.core.setting('appealWindowDays');
    const canReapplyFrom = reapplyFrom(body.reapply, now);
    const decision = {
      outcome: 'rejected',
      reasonCode: body.reasonCode,
      explanation: body.explanation.trim(),
      ruleRef: body.ruleRef ?? null,
      canReapplyFrom,
      notEligibleToReapply: body.reapply === 'not_eligible',
      appealDeadline: addDays(now, window).toISOString(),
      conditions: [],
      decidedBy: by.actor,
      decidedAt: now.toISOString(),
    };
    const app = await this.repo.transaction(async (tx) => {
      const a = await this.byId(id, tx, true);
      const state = this.core.step(sellerApplicationMachine, a.state, 'reject');
      const row = await tx.update('applications', a.id, { state, decision: decision as never, can_reapply_from: canReapplyFrom, reviewer_id: a.reviewer_id ?? by.actor.id ?? null });
      for (const d of await tx.find('application_documents', { application_id: a.id })) await tx.update('application_documents', d.id, { delete_after: isoDate(addDays(now, retention)) });
      if (a.seller_id) {
        const s = await this.core.seller(a.seller_id, { repo: tx, forUpdate: true });
        await tx.update('sellers', s.id, { status: this.core.step(sellerAccountStatusMachine, s.status, 'reject'), status_since: now, closed_reason: 'application_rejected', updated_at: now });
        await this.core.timeline(tx, s.id, { kind: 'rejected', title: 'Application not approved', detail: body.explanation.trim(), actor: by.actor, ref: a.ref });
      }
      return row;
    });
    this.core.publish('sellers.application.decided', { applicationId: app.id, sellerId: app.seller_id!, outcome: 'rejected', reasonCode: body.reasonCode, decidedBy: by.actor.id ?? by.actor.kind }, by);
    await this.core.audit({ action: 'sellers.application.reject', actionLabel: 'Rejected a seller application', category: 'seller_enforcement', target: this.appTarget(app), reason: body.explanation, after: { state: 'rejected', reasonCode: body.reasonCode, reapply: body.reapply } }, by);
    return this.adminView(app);
  }

  async addApplicationNote(id: string, body: string, by: By): Promise<SellerNote> {
    const a = await this.byId(id);
    return this.parts.accounts.addNote({ applicationId: a.id, sellerId: a.seller_id }, body, by);
  }

  /* ---------------------------------------------------------------- verification checks */

  private subjectOf(a: ApplicationRec, docs: number[]): CheckSubject {
    const sec = this.sections(a);
    const v = sec.verification;
    const payout = sec.payout?.current ?? sec.payout?.pendingChange ?? null;
    return {
      applicationId: a.id,
      legalName: sec.business?.legalName ?? null,
      storeName: this.storeNameOf(a),
      owners: (v?.owners ?? []).map((o, i) => ({ name: o.name, documentCount: docs[i] ?? 0 })),
      registryNumber: sec.business?.registryNumber ?? null,
      stateOfRegistration: sec.business?.stateOfRegistration ?? null,
      taxIdType: v?.taxIdType ?? null,
      taxIdLast4: v?.taxIdLast4 ?? null,
      payoutHolder: payout?.accountHolderName ?? null,
      payoutHolderMatches: payout ? holderMatches(payout.accountHolderName, sec.business?.legalName, v?.owners ?? []) : null,
      returnAddress: sec.returnAddress?.address ?? null,
    };
  }

  private async setOwnersState(applicationId: string, result: CheckResult) {
    const a = await this.repo.get('applications', applicationId);
    if (!a) return;
    const v = (a.verification ?? {}) as unknown as StoredVerification;
    if (!v.owners?.length) return;
    const state = result === 'passed' ? 'verified' : result === 'failed' ? 'failed' : 'pending';
    await this.repo.update('applications', a.id, { verification: { ...v, owners: v.owners.map((o) => ({ ...o, verificationState: state })) } as never });
  }

  /** Send pending checks to the providers (one application, one check, or a bounded batch) */
  async runChecks(o: { applicationId?: string; checkId?: string } = {}) {
    const where = o.checkId ? { id: o.checkId } : o.applicationId ? { application_id: o.applicationId, result: 'pending', provider_ref: null } : { result: 'pending', provider_ref: null };
    const checks = await this.repo.find('verification_checks', where as never, { limit: 100 });
    const apps = new Map<string, ApplicationRec>();
    for (const c of checks) {
      if (!c.application_id) continue;
      const a = apps.get(c.application_id) ?? (await this.repo.get('applications', c.application_id));
      if (!a || !REVIEW_STATES.includes(a.state)) continue;
      apps.set(a.id, a);
      const docs = await this.repo.find('application_documents', { application_id: a.id, kind: 'owner_id' });
      const subject = this.subjectOf(
        a,
        ((a.verification ?? {}) as unknown as StoredVerification).owners?.map((ow) => (ow.idDocumentIds ?? []).filter((id) => docs.some((d) => d.id === id)).length) ?? [],
      );
      let r: { providerRef: string; result: CheckResult; summary: string; provider: string };
      if (c.kind === 'return_address') {
        const addr = subject.returnAddress;
        const v = addr ? await this.core.providers.addresses.verify(addr) : { result: 'needs_attention' as const, summary: 'No return address given' };
        r = { ...v, providerRef: `address-${c.id}`, provider: 'address' };
      } else {
        const v = await this.core.providers.verification.submit(c.kind as CheckKind, subject);
        r = { ...v, provider: this.core.providers.verification.name };
      }
      await this.repo.update('verification_checks', c.id, { provider: r.provider, provider_ref: r.providerRef, result: r.result, summary: r.summary, checked_at: r.result === 'pending' ? null : this.now(), checked_by: r.result === 'pending' ? null : map.actorText({ kind: 'provider', id: null, name: r.provider }) });
      if (c.kind === 'identity' && r.result !== 'pending') await this.setOwnersState(a.id, r.result);
    }
  }

  /** sellers.run-verification-checks: pending checks, then automatic Trust and Risk referrals */
  async runVerificationChecks() {
    await this.runChecks();
    const trust = this.ctx.tryUse('trust');
    if (!trust) return;
    for (const r of await this.repo.find('risk_reviews', { state: 'requested', trust_report_id: null }, { limit: 50 })) {
      const a = await this.repo.get('applications', r.application_id);
      if (!a || !REVIEW_STATES.includes(a.state)) continue;
      try {
        const res = await trust.requestAssessment({
          subjectType: 'seller_application',
          subjectId: a.id,
          ...(a.seller_id ? { sellerId: a.seller_id } : {}),
          question: ((r.flags as { text?: string }[])[0]?.text ?? 'Product plan includes a category referred to Trust and Risk') as string,
          requestedBy: SYSTEM,
        });
        await this.repo.update('risk_reviews', r.id, { trust_report_id: res.reportId });
      } catch (err) {
        this.ctx.log.warn({ err, applicationId: a.id }, 'sellers: automatic Trust and Risk referral failed (will retry)');
      }
    }
  }

  /** Webhook: a provider's result for a check (idempotent by provider event id at the kernel, by result here) */
  async verificationProviderResult(body: { eventId: string; providerRef: string; kind: string; result: string; details: unknown }) {
    const c = await this.repo.findOne('verification_checks', { provider_ref: body.providerRef });
    if (!c) {
      this.ctx.log.info({ providerRef: body.providerRef }, 'sellers: verification result for an unknown check (ignored)');
      return;
    }
    const r = body.result.toLowerCase();
    const result: CheckResult = ['passed', 'pass', 'clear', 'approved', 'verified', 'match'].includes(r)
      ? 'passed'
      : ['failed', 'fail', 'rejected', 'declined', 'no_match'].includes(r)
        ? 'failed'
        : ['needs_attention', 'review', 'consider', 'partial_match'].includes(r)
          ? 'needs_attention'
          : 'pending';
    if (c.result === result && c.source === 'automated') return;
    const d = (body.details ?? {}) as { summary?: string };
    await this.repo.update('verification_checks', c.id, { result, summary: d.summary ?? `${body.kind}: ${body.result}`, source: 'automated', checked_at: this.now(), accepted_note: null });
    if (c.kind === 'identity' && c.application_id) await this.setOwnersState(c.application_id, result);
    if (result !== 'passed' && result !== 'pending' && c.seller_id) {
      const s = await this.repo.get('sellers', c.seller_id);
      if (s && s.verification_state === 'verified' && LABEL_KINDS.includes(c.kind)) await this.parts.accounts.lapseLabel(s, `The ${c.kind.replace(/_/g, ' ')} check changed: ${d.summary ?? body.result}`);
    }
  }

  /** trust.assessment.completed: risk level, flags and recommendation on the application's risk review */
  async onAssessmentCompleted(e: EventPayload<'trust.assessment.completed'>) {
    if (e.subjectType !== 'seller_application' || !isUuid(e.subjectId)) return;
    const a = await this.repo.get('applications', e.subjectId);
    if (!a) return;
    const level = ['low', 'medium', 'high'].includes(e.level) ? e.level : null;
    const r = (await this.repo.findOne('risk_reviews', { trust_report_id: e.reportId })) ?? (await this.repo.findOne('risk_reviews', { application_id: a.id }));
    const patch = { state: 'completed', trust_report_id: e.reportId, level, flags: (e.flags ?? []) as never, recommendation: e.recommendation, reviewed_by: map.actorText({ kind: 'system', id: null, name: 'Trust and Risk' }), reviewed_at: this.now() };
    if (r) await this.repo.update('risk_reviews', r.id, patch);
    else await this.repo.insert('risk_reviews', { id: newId(), application_id: a.id, ...patch });
  }

  /* ---------------------------------------------------------------- jobs */

  /** sellers.application-deadlines */
  async applicationDeadlines() {
    const now = this.now();
    const remindDays = await this.core.setting('infoReminderDaysBefore');
    for (const r of await this.repo.find('information_requests', { state: 'open', reminder: 'three_days_before', reminded_at: null, due_at: { op: '<=', value: addDays(now, remindDays) } }, { limit: 200 })) {
      if (r.due_at.getTime() <= now.getTime()) continue;
      await this.repo.update('information_requests', r.id, { reminded_at: now });
      const a = await this.repo.get('applications', r.application_id);
      if (a?.seller_id) await this.core.timeline(this.repo, a.seller_id, { kind: 'information_reminder', title: `Reminder: send the requested information by ${isoDate(r.due_at)}`, ref: a.ref });
    }
    for (const r of await this.repo.find('information_requests', { state: 'open', due_at: { op: '<', value: now } }, { limit: 200 })) {
      const expired = await this.repo.transaction(async (tx) => {
        await tx.update('information_requests', r.id, { state: 'expired' });
        const a = await tx.get('applications', r.application_id, { forUpdate: true });
        if (!a || a.state !== 'information_required') return undefined;
        await tx.update('applications', a.id, { state: this.core.step(sellerApplicationMachine, a.state, 'expire') });
        if (a.seller_id) {
          const s = await tx.get('sellers', a.seller_id, { forUpdate: true });
          if (s && sellerAccountStatusMachine.can(s.status as never, 'expire' as never)) {
            await tx.update('sellers', s.id, { status: this.core.step(sellerAccountStatusMachine, s.status, 'expire'), status_since: now, closed_reason: 'application_expired', updated_at: now });
          }
          await this.core.timeline(tx, a.seller_id, { kind: 'expired', title: 'Application closed: no reply by the deadline', ref: a.ref });
        }
        return a;
      });
      if (expired?.seller_id) this.core.publish('sellers.application.expired', { applicationId: expired.id, sellerId: expired.seller_id });
    }
    for (const a of await this.repo.find('applications', { state: ['submitted', 'under_review'], decision_target_at: { op: '<', value: now } }, { limit: 500 })) {
      await this.core.raise({
        queueKey: 'sellers.applications',
        kind: 'application_overdue',
        title: `Application ${a.ref} is past its decision target`,
        summary: this.storeNameOf(a),
        subject: { type: 'application', id: a.id, ref: a.ref, label: this.storeNameOf(a) },
        sellerId: a.seller_id,
        sellerName: this.storeNameOf(a),
        priority: 'high',
        dueAt: a.decision_target_at?.toISOString() ?? null,
        dedupeKey: `application_overdue:${a.id}`,
      });
    }
  }

  /** Part of sellers.expire-invitations: invitations to apply past their expiry */
  async expireSellerInvitations(now: Date) {
    const rows = await this.repo.find('seller_invitations', { state: 'sent', expires_at: { op: '<', value: now } }, { limit: 500 });
    for (const i of rows) await this.repo.update('seller_invitations', i.id, { state: this.core.step(sellerInvitationMachine, i.state, 'expire') });
    return rows.length;
  }

  /** sellers.purge-documents: ID documents and rejected-application documents past retention */
  async purgeDocuments() {
    const media = this.ctx.use('media');
    for (let round = 0; round < 10; round++) {
      const rows = await this.repo.deleteDocumentsDue(this.core.today(), 200);
      for (const d of rows) {
        try {
          await media.detach(d.media_id, { module: 'sellers', kind: 'verification_document', refId: d.application_id });
        } catch (err) {
          this.ctx.log.warn({ err, documentId: d.id }, 'sellers: could not detach a purged document');
        }
      }
      if (rows.length < 200) break;
    }
  }

  /* ---------------------------------------------------------------- invitations to apply */

  async inviteSeller(body: { email: string; businessName: string; message?: string | null }, by: By): Promise<SellerInvitation> {
    if (!body.businessName?.trim()) throw invalid([{ path: 'businessName', message: 'Enter the business name' }]);
    const now = this.now();
    const id = newId();
    const code = this.codeFor(id);
    const row = await this.repo.insert('seller_invitations', {
      id,
      email: body.email.trim().toLowerCase(),
      business_name: body.businessName.trim(),
      message: body.message?.trim() || null,
      code_hash: this.codeHash(code),
      invited_by: map.actorText(by.actor),
      sent_at: now,
      expires_at: addDays(now, await this.core.setting('sellerInvitationValidDays')),
      state: sellerInvitationMachine.initial,
      application_id: null,
    });
    this.core.publish('sellers.invitation.sent', { invitationId: row.id, email: row.email }, by);
    await this.core.audit({ action: 'sellers.invitation.send', actionLabel: 'Invited a business to apply', category: 'other', target: { type: 'seller_invitation', id: row.id, label: row.business_name, screen: 'admin/seller-invitations' }, after: { email: row.email } }, by);
    return map.invitation(row);
  }

  async listSellerInvitations(state: SellerInvitation['state'] | undefined, page: PageRequest): Promise<common.Page<SellerInvitation>> {
    const p = await this.repo.page('seller_invitations', state ? { state } : {}, page, { column: 'sent_at', direction: 'desc' });
    return { ...p, items: p.items.map(map.invitation) };
  }

  async revokeSellerInvitation(id: string, by: By): Promise<SellerInvitation> {
    const i = isUuid(id) ? await this.repo.get('seller_invitations', id) : undefined;
    if (!i) throw notFound('Invitation');
    const after = await this.repo.update('seller_invitations', i.id, { state: this.core.step(sellerInvitationMachine, i.state, 'revoke') });
    await this.core.audit({ action: 'sellers.invitation.revoke', actionLabel: 'Revoked an invitation to apply', category: 'other', target: { type: 'seller_invitation', id: i.id, label: i.business_name, screen: 'admin/seller-invitations' }, before: { state: i.state }, after: { state: after.state } }, by);
    return map.invitation(after);
  }

  /** Approved seller of this application (used by the seller-area status page) */
  sellerOf(a: ApplicationRec): Promise<SellerRec | undefined> {
    return a.seller_id ? this.repo.get('sellers', a.seller_id) : Promise.resolve(undefined);
  }
}

const LABEL_KINDS = ['identity', 'business_registration', 'payout_account', 'return_address'];
