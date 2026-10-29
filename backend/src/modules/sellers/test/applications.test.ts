import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { marketDate, signWebhook } from '../../../testing/app.js';
import { accountInput, ADMIN, approvedSeller, boot, customer, invitation, mediaGone, payoutInput, staff, STORE, submitted, type Kit } from './helpers.js';
import { agreementDocument } from '../domain/catalogue.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(async () => kit?.close());

describe('Sell with us programme', () => {
  it('shows requirements, example fees, targets and the agreements, invite-only by default', async () => {
    const res = await kit.call('GET', `${STORE}/program`, customer());
    expect(res.status).toBe(200);
    expect(res.body.applicationsOpen).toBe(false);
    expect(res.body.agreements.map((a: any) => a.key)).toEqual(['seller_agreement', 'product_rules', 'fee_schedule', 'service_standards']);
    expect(res.body.serviceTargets.find((t: any) => t.metric === 'dispatch_reliability')).toMatchObject({ threshold: 95, isExample: true, display: 'At least 95%' });
    expect(res.body.feeExamples.every((f: any) => f.isExample)).toBe(true);
    // content is off here: no published policy to link
    expect(res.body.agreements.map((a: any) => a.url)).toEqual([null, null, null, null]);
  });

  it('links a published agreement under the content policy key', () => {
    const published = agreementDocument('seller_agreement', { versionLabel: 'v1.4', policyVersionId: newId(), effectiveFrom: '2026-10-01' }, 'https://marketly.example/');
    expect(published.url).toBe('https://marketly.example/policies/seller_agreement');
    expect(agreementDocument('service_standards', { versionLabel: 'v1.0', policyVersionId: null, effectiveFrom: '2026-01-01' }, 'https://marketly.example').url).toBeNull();
  });
});

describe('application', () => {
  it('needs an invitation during the invite-only launch', async () => {
    const res = await kit.call('POST', `${STORE}/applications`, customer(), accountInput());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVITATION_REQUIRED');
  });

  it('starts with an invitation code, one open application per account', async () => {
    const accountId = newId();
    const { id: invitationId, code } = await invitation(kit);
    const res = await kit.call('POST', `${STORE}/applications`, customer(accountId), accountInput('Bright Lamps', code));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ state: 'draft', currentStep: 'business', completedSteps: ['account'] });
    expect(res.body.missing.business).toContain('legalName');
    const again = await kit.call('POST', `${STORE}/applications`, customer(accountId), accountInput('Bright Lamps', code));
    expect(again.body.error.code).toBe('APPLICATION_EXISTS');
    const inv = await kit.call('GET', `${ADMIN}/seller-invitations?state=applied`, staff());
    expect(inv.body.items.some((i: any) => i.id === invitationId && i.applicationId === res.body.id)).toBe(true);
  });

  it('another applicant cannot see or change the application (404)', async () => {
    const s = await submitted(kit);
    const other = customer();
    expect((await kit.call('PATCH', `${STORE}/applications/${s.id}`, other, { step: 'account', account: accountInput() })).status).toBe(404);
    expect((await kit.call('POST', `${STORE}/applications/${s.id}/withdraw`, other, {})).status).toBe(404);
  });

  it('refuses invalid bank details and never stores the numbers', async () => {
    const accountId = newId();
    const { code } = await invitation(kit);
    const start = await kit.call('POST', `${STORE}/applications`, customer(accountId), accountInput('Pay Test', code));
    const bad = await kit.call('PATCH', `${STORE}/applications/${start.body.id}`, customer(accountId), { step: 'payout', payout: { ...payoutInput(), routingNumber: '123456789' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('PAYOUT_DETAILS_INVALID');
    const refused = await kit.call('PATCH', `${STORE}/applications/${start.body.id}`, customer(accountId), { step: 'payout', payout: payoutInput('000123450002') });
    expect(refused.body.error.code).toBe('PAYOUT_DETAILS_INVALID');
    const ok = await kit.call('PATCH', `${STORE}/applications/${start.body.id}`, customer(accountId), { step: 'payout', payout: payoutInput() });
    expect(ok.status).toBe(200);
    expect(ok.body.payout).toMatchObject({ label: 'Checking •••• 7731', accountHolderName: 'Northwind Audio LLC' });
    expect(JSON.stringify(ok.body)).not.toContain('000123457731');
  });

  it('keeps the stored tax id when a later save of the verification step leaves it out', async () => {
    const accountId = newId();
    const { code } = await invitation(kit);
    const start = await kit.call('POST', `${STORE}/applications`, customer(accountId), accountInput('Tax Test', code));
    const verification = { owners: [{ name: 'Ana Lopez', ownershipPct: 100, isPrimary: true, idDocumentIds: [] }], taxIdType: 'ein', w9Method: 'online' };
    const first = await kit.call('PATCH', `${STORE}/applications/${start.body.id}`, customer(accountId), { step: 'verification', verification: { ...verification, taxId: '12-3456789' } });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await kit.call('PATCH', `${STORE}/applications/${start.body.id}`, customer(accountId), { step: 'verification', verification: { ...verification, owners: [{ ...verification.owners[0], name: 'Ana M. Lopez' }] } });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.verification).toMatchObject({ taxIdType: 'ein', taxIdLast4: '6789', owners: [{ name: 'Ana M. Lopez' }] });
  });

  it('blocks submit until every step is complete (APPLICATION_INCOMPLETE)', async () => {
    const accountId = newId();
    const { code } = await invitation(kit);
    const start = await kit.call('POST', `${STORE}/applications`, customer(accountId), accountInput('Half Done', code));
    const res = await kit.call('POST', `${STORE}/applications/${start.body.id}/submit`, customer(accountId), { acceptances: [], signedName: 'Ana' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('APPLICATION_INCOMPLETE');
    expect(Object.keys(res.body.error.details.missing)).toEqual(expect.arrayContaining(['business', 'verification', 'payout', 'return_address', 'agreement']));
  });

  it('refuses an outdated agreement version', async () => {
    const accountId = newId();
    const { code } = await invitation(kit);
    const start = await kit.call('POST', `${STORE}/applications`, customer(accountId), accountInput('Old Terms', code));
    const res = await kit.call('POST', `${STORE}/applications/${start.body.id}/submit`, customer(accountId), { acceptances: [{ key: 'seller_agreement', versionLabel: 'v0.9' }], signedName: 'Ana' });
    expect(res.body.error.code).toBe('AGREEMENT_VERSION_OUTDATED');
  });

  it('submits: seller row applied, agreements recorded, checks run, events published', async () => {
    const s = await submitted(kit);
    expect(s.application).toMatchObject({ state: 'submitted', sellerStatus: 'applied', percentComplete: 100 });
    expect(s.application.agreementsAccepted).toHaveLength(4);
    expect(s.application.verification.taxIdLast4).toBe('6789');
    expect(JSON.stringify(s.application)).not.toContain('123456789');
    expect(kit.of('sellers.application.submitted').find((e) => e.applicationId === s.id)).toMatchObject({ sellerId: s.sellerId, invited: true, sellerType: 'business' });
    expect(kit.of('sellers.agreement.accepted').filter((e) => e.applicationId === s.id)).toHaveLength(4);
    const admin = await kit.call('GET', `${ADMIN}/applications/${s.id}`, staff());
    expect(admin.status).toBe(200);
    expect(admin.body.checks.map((c: any) => c.result)).toEqual(expect.arrayContaining(['passed']));
    expect(admin.body.checks.every((c: any) => c.result === 'passed')).toBe(true);
    expect(admin.body.approveBlockedBy).toEqual([]);
    expect(admin.body.requiredDocuments.find((d: any) => d.kind === 'owner_id').uploaded).toBe(true);
    expect(admin.body.application.verification.owners[0].verificationState).toBe('verified');
  });

  it('shows a document whose file is gone without a link, never an invented URL', async () => {
    const s = await submitted(kit);
    const [doc] = s.application.documents;
    expect(doc.file.url).toBe(`https://media.example.com/${doc.file.id}`);
    mediaGone.add(doc.file.id);
    const admin = await kit.call('GET', `${ADMIN}/applications/${s.id}`, staff());
    expect(admin.status).toBe(200);
    expect(admin.body.application.documents.find((d: any) => d.id === doc.id)).toMatchObject({ file: null, fileName: doc.fileName });
  });

  it('refers product plans in risk categories to Trust and Risk and stores the assessment', async () => {
    const s = await submitted(kit, { plannedProducts: 'lights, locks, e-bike batteries' });
    await kit.svc.runVerificationChecks();
    const referral = kit.callsOf('trust.requestAssessment').find((c) => (c[0] as any).subjectId === s.id);
    expect(referral).toBeDefined();
    const reportId = newId();
    await kit.emit('trust', 'trust.assessment.completed', { reportId, subjectType: 'seller_application', subjectId: s.id, level: 'medium', flags: [{ severity: 'medium', text: 'Battery certificates not shown' }], recommendation: 'Approve with batteries excluded' });
    const admin = await kit.call('GET', `${ADMIN}/applications/${s.id}`, staff());
    expect(admin.body.riskReview).toMatchObject({ state: 'completed', level: 'medium', trustReportId: reportId });
    expect(admin.body.requiredDocuments.some((d: any) => d.kind === 'category_certificate' && !d.uploaded)).toBe(true);
  });

  it('information request: status, respond, back under review; expires without a reply', async () => {
    const s = await submitted(kit);
    const reviewer = staff();
    await kit.call('POST', `${ADMIN}/applications/${s.id}/start-review`, reviewer);
    const dueAt = new Date(kit.clock.now().getTime() + 5 * 86_400_000).toISOString();
    const req = await kit.call('POST', `${ADMIN}/applications/${s.id}/request-information`, reviewer, {
      items: [{ title: 'Utility bill', detail: 'For the business address', neededFor: 'business', documentKind: 'proof_of_address' }],
      message: 'Please send a recent utility bill',
      dueAt,
      reminder: 'three_days_before',
    });
    expect(req.status).toBe(200);
    expect(req.body.application).toMatchObject({ state: 'information_required', sellerStatus: 'information_required' });
    expect(kit.last('sellers.application.information_requested')).toMatchObject({ applicationId: s.id, itemCount: 1 });
    const itemId = req.body.application.informationRequest.items[0].id;
    const empty = await kit.call('POST', `${STORE}/applications/${s.id}/respond`, s.token, { items: [] });
    expect(empty.body.error.code).toBe('VALIDATION_FAILED');
    const notAllowed = await kit.call('PATCH', `${STORE}/applications/${s.id}`, s.token, { step: 'payout', payout: payoutInput() });
    expect(notAllowed.body.error.code).toBe('VALIDATION_FAILED');
    const doc = await kit.call('POST', `${STORE}/applications/${s.id}/documents`, s.token, { mediaId: newId(), kind: 'proof_of_address', infoRequestItemId: itemId });
    expect(doc.status).toBe(201);
    const res = await kit.call('POST', `${STORE}/applications/${s.id}/respond`, s.token, { items: [{ itemId, documentIds: [doc.body.id] }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'under_review', sellerStatus: 'under_review' });
    expect(kit.last('sellers.application.information_provided')).toMatchObject({ applicationId: s.id });

    const s2 = await submitted(kit);
    await kit.call('POST', `${ADMIN}/applications/${s2.id}/request-information`, reviewer, { items: [{ title: 'Bank letter', neededFor: 'payout', documentKind: 'bank_letter' }], message: 'Send a bank letter', dueAt, reminder: 'none' });
    kit.clock.advance(6 * 86_400_000);
    await kit.svc.applicationDeadlines();
    await kit.app.kernel.events.drain();
    const after = await kit.call('GET', `${STORE}/applications/current`, s2.token);
    expect(after.body).toMatchObject({ state: 'expired', sellerStatus: 'closed' });
    expect(kit.of('sellers.application.expired').some((e) => e.applicationId === s2.id)).toBe(true);
    kit.clock.advance(-6 * 86_400_000);
  });

  it('information request without a deadline gets the default reply window (infoRequestDefaultDays)', async () => {
    const s = await submitted(kit);
    const reviewer = staff();
    await kit.call('POST', `${ADMIN}/applications/${s.id}/start-review`, reviewer);
    const req = await kit.call('POST', `${ADMIN}/applications/${s.id}/request-information`, reviewer, { items: [{ title: 'Utility bill', neededFor: 'business' }], message: 'Please send a recent utility bill', reminder: 'none' });
    expect(req.status, JSON.stringify(req.body)).toBe(200);
    const due = new Date(kit.last('sellers.application.information_requested').dueAt).getTime();
    expect(due - kit.clock.now().getTime()).toBe(14 * 86_400_000);
  });

  it('approval is blocked by unresolved checks until a note accepts them', async () => {
    const s = await submitted(kit, { legalName: 'Attention Traders LLC' });
    const reviewer = staff();
    await kit.call('POST', `${ADMIN}/applications/${s.id}/start-review`, reviewer);
    const blocked = await kit.call('POST', `${ADMIN}/applications/${s.id}/approve`, reviewer, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CHECKS_UNRESOLVED');
    const admin = await kit.call('GET', `${ADMIN}/applications/${s.id}`, reviewer);
    for (const c of admin.body.checks.filter((x: any) => x.result === 'needs_attention')) {
      const r = await kit.call('POST', `${ADMIN}/applications/${s.id}/checks/${c.id}/result`, reviewer, { result: 'needs_attention', note: 'Registry name differs by punctuation only', acceptForApproval: true });
      expect(r.body.acceptedWithNote).toBe('Registry name differs by punctuation only');
    }
    const ok = await kit.call('POST', `${ADMIN}/applications/${s.id}/approve`, reviewer, {});
    expect(ok.status).toBe(200);
    // accepted notes allow approval but the Verified label needs checks that passed
    const seller = await kit.svc.getSeller(s.sellerId);
    expect(seller).toMatchObject({ status: 'approved', verified: false, launchReady: false, canSellNew: false });
  });

  it('approves: owner member and seller context, payout handed to finance, conditions restrict, events', async () => {
    const s = await submitted(kit);
    const reviewer = staff();
    await kit.call('POST', `${ADMIN}/applications/${s.id}/start-review`, reviewer);
    const res = await kit.call('POST', `${ADMIN}/applications/${s.id}/approve`, reviewer, {
      note: 'Welcome aboard',
      recommendedHoldDays: 14,
      conditions: [{ title: 'Batteries excluded', reasonCode: 'approval_condition', reason: 'Certificates not checked yet', affectedActivities: ['new_listings', 'new_offers'], scope: { categoryIds: [newId()] }, toResolve: 'Upload UL 2271 certificates', reviewDate: new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10) }],
    });
    expect(res.status).toBe(200);
    expect(res.body.application).toMatchObject({ state: 'approved', sellerStatus: 'restricted' });
    expect(res.body.application.decision.conditions).toHaveLength(1);
    expect(res.body.application.setupSummary.payoutReadiness.state).toBe('verification_pending');
    expect(kit.last('sellers.seller.approved')).toMatchObject({ sellerId: s.sellerId, ownerAccountId: s.accountId, recommendedHoldDays: 14, returnContact: 'Ana Lopez' });
    expect(kit.last('sellers.seller.approved').returnAddress.line1).toBe('410 Pine St');
    expect(kit.last('sellers.application.decided')).toMatchObject({ applicationId: s.id, outcome: 'approved' });
    expect(kit.last('sellers.payout_account.changed')).toMatchObject({ sellerId: s.sellerId, isInitial: true, label: 'Checking •••• 7731' });
    expect(kit.last('sellers.seller.restricted')).toMatchObject({ sellerId: s.sellerId, reasonCode: 'approval_condition' });
    expect(kit.last('sellers.verification.changed')).toMatchObject({ sellerId: s.sellerId, state: 'verified' });
    expect(kit.callsOf('grantSellerContext').some((c) => (c[0] as any).sellerId === s.sellerId && (c[0] as any).isOwner)).toBe(true);
    const access = await kit.svc.getMemberAccess(s.sellerId, s.accountId);
    expect(access).toMatchObject({ role: 'owner', isOwner: true });
    expect(access!.permissions).toContain('sellers.staff.manage');
    expect(await kit.svc.getMemberAccess(s.sellerId, newId())).toBeNull();
    expect(kit.audits.some((a) => a.action === 'sellers.application.approve' && a.target.id === s.id)).toBe(true);
  });

  it('rejects with a reapply rule; the appeal is decided by someone else and overturning reopens it', async () => {
    const s = await submitted(kit);
    const reviewerId = newId();
    const reviewer = staff(reviewerId);
    await kit.call('POST', `${ADMIN}/applications/${s.id}/start-review`, reviewer);
    const empty = await kit.call('POST', `${ADMIN}/applications/${s.id}/reject`, reviewer, { reasonCode: 'outside_assortment', explanation: ' ', reapply: 'after_30_days' });
    expect(empty.body.error.code).toBe('VALIDATION_FAILED');
    const rej = await kit.call('POST', `${ADMIN}/applications/${s.id}/reject`, reviewer, { reasonCode: 'outside_assortment', explanation: 'We do not list refurbished phones at launch', reapply: 'after_30_days' });
    expect(rej.body.application).toMatchObject({ state: 'rejected', sellerStatus: 'closed' });
    // the market day 30 days out, not the UTC one: the two differ for the eight hours a day the market is
    // behind UTC, and this test then failed for the hour it was run at (2026-10-28)
    const reapply = marketDate(kit.clock.now(), 30);
    expect(rej.body.application.decision).toMatchObject({ canReapplyFrom: reapply, notEligibleToReapply: false });
    const { code } = await invitation(kit);
    const again = await kit.call('POST', `${STORE}/applications`, s.token, accountInput('Retry', code));
    expect(again.body.error).toMatchObject({ code: 'REAPPLY_NOT_YET', details: { canReapplyFrom: reapply } });

    const appeal = await kit.call('POST', `${STORE}/applications/${s.id}/appeal`, s.token, { argument: 'Our phones are certified refurbished by the maker' });
    expect(appeal.status).toBe(201);
    expect(appeal.body).toMatchObject({ subject: 'application_rejection', level: 1, state: 'submitted' });
    expect((await kit.call('POST', `${STORE}/applications/${s.id}/appeal`, s.token, { argument: 'again' })).body.error.code).toBe('APPEAL_ALREADY_OPEN');
    const same = await kit.call('POST', `${ADMIN}/appeals/${appeal.body.id}/assign`, staff(), { reviewerId });
    expect(same.body.error.code).toBe('SAME_REVIEWER_NOT_ALLOWED');
    const byDecider = await kit.call('POST', `${ADMIN}/appeals/${appeal.body.id}/decide`, reviewer, { outcome: 'overturn', explanation: 'x' });
    expect(byDecider.body.error.code).toBe('SAME_REVIEWER_NOT_ALLOWED');
    const decided = await kit.call('POST', `${ADMIN}/appeals/${appeal.body.id}/decide`, staff(), { outcome: 'overturn', explanation: 'The maker certifies the phones; reviewing again' });
    expect(decided.status).toBe(200);
    expect(decided.body.state).toBe('overturned');
    expect(kit.last('sellers.appeal.decided')).toMatchObject({ appealId: appeal.body.id, outcome: 'overturned', subject: 'application_rejection' });
    const app = await kit.call('GET', `${STORE}/applications/current`, s.token);
    expect(app.body).toMatchObject({ state: 'under_review', sellerStatus: 'under_review' });
  });

  it('appeals after the deadline are refused', async () => {
    const s = await submitted(kit);
    const reviewer = staff();
    await kit.call('POST', `${ADMIN}/applications/${s.id}/start-review`, reviewer);
    await kit.call('POST', `${ADMIN}/applications/${s.id}/reject`, reviewer, { reasonCode: 'duplicate_account', explanation: 'Same bank account as another seller', reapply: 'not_eligible' });
    kit.clock.advance(15 * 86_400_000);
    const res = await kit.call('POST', `${STORE}/applications/${s.id}/appeal`, s.token, { argument: 'late' });
    expect(res.body.error.code).toBe('APPEAL_WINDOW_CLOSED');
    kit.clock.advance(-15 * 86_400_000);
  });

  it('withdraws: application withdrawn and the seller row closed', async () => {
    const s = await submitted(kit);
    const res = await kit.call('POST', `${STORE}/applications/${s.id}/withdraw`, s.token, { reason: 'Not ready yet' });
    expect(res.body).toMatchObject({ state: 'withdrawn', sellerStatus: 'closed' });
    expect(kit.last('sellers.application.withdrawn')).toMatchObject({ applicationId: s.id, sellerId: s.sellerId });
    expect((await kit.call('POST', `${STORE}/applications/${s.id}/withdraw`, s.token, {})).status).toBe(409);
  });

  it('admin queue lists submitted applications oldest decision target first, with check counts', async () => {
    const s = await submitted(kit);
    const res = await kit.call('GET', `${ADMIN}/applications?state=submitted&limit=100`, staff());
    expect(res.status).toBe(200);
    const row = res.body.items.find((r: any) => r.id === s.id);
    expect(row).toMatchObject({ invited: true, applicantName: 'Ana Lopez', checks: { passed: 6, failed: 0 } });
    const targets = res.body.items.map((r: any) => r.deadline.dueAt);
    expect([...targets].sort()).toEqual(targets);
    // the search box reaches account.storeName, a path inside a JSON document, and ignores case
    const account = (await kit.svc.core.repo.get('applications', s.id))!.account as { storeName: string };
    const byName = await kit.call('GET', `${ADMIN}/applications?q=${encodeURIComponent(account.storeName.toLowerCase())}&limit=100`, staff());
    expect(byName.body.items.map((r: any) => r.id)).toEqual([s.id]);
    // overdue and not overdue are the two halves of the queue, and this one's target is business days away
    expect((await kit.call('GET', `${ADMIN}/applications?overdue=false&limit=100`, staff())).body.items.map((r: any) => r.id)).toContain(s.id);
    expect((await kit.call('GET', `${ADMIN}/applications?overdue=true&limit=100`, staff())).body.items.map((r: any) => r.id)).not.toContain(s.id);
  });

  it('webhook results update the check by provider reference and lapse the label of an approved seller', async () => {
    const s = await approvedSeller(kit);
    const admin = await kit.call('GET', `${ADMIN}/applications/${s.id}`, staff());
    const identityCheck = admin.body.checks.find((c: any) => c.kind === 'identity');
    const row = await kit.svc.core.repo.get('verification_checks', identityCheck.id);
    const body = JSON.stringify({ eventId: `evt-${newId()}`, providerRef: row!.provider_ref, kind: 'identity', result: 'failed', details: { summary: 'ID document expired' } });
    const res = await kit.app.inject({ method: 'POST', url: '/webhooks/sellers/verification-results', headers: { 'content-type': 'application/json', ...signWebhook('dev-webhook-secret', body) }, payload: body });
    expect(res.statusCode).toBe(204);
    await kit.app.kernel.events.drain();
    expect((await kit.svc.core.repo.get('verification_checks', identityCheck.id))!.result).toBe('failed');
    expect(kit.last('sellers.verification.changed')).toMatchObject({ sellerId: s.sellerId, state: 'lapsed' });
  });

  it('rerun and staff notes on an application', async () => {
    const s = await submitted(kit);
    const admin = await kit.call('GET', `${ADMIN}/applications/${s.id}`, staff());
    const rerun = await kit.call('POST', `${ADMIN}/applications/${s.id}/checks/${admin.body.checks[0].id}/rerun`, staff());
    expect(rerun.status).toBe(202);
    expect(rerun.body.result).toBe('passed');
    const note = await kit.call('POST', `${ADMIN}/applications/${s.id}/notes`, staff(), { body: 'Called the owner' });
    expect(note.status).toBe(201);
    const assign = await kit.call('POST', `${ADMIN}/applications/${s.id}/assign`, staff(), { reviewerId: newId() });
    expect(assign.body.notes[0].body).toBe('Called the owner');
    const trust = await kit.call('POST', `${ADMIN}/applications/${s.id}/trust-review`, staff(), { question: 'Is the bank account linked to a closed seller?' });
    expect(trust.status).toBe(202);
    expect(trust.body.state).toBe('requested');
  });
});
