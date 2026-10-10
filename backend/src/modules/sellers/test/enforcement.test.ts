import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, approvedSeller, boot, owner, restrictionInput, SELLER, staff, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(async () => kit?.close());

const futureDate = (days: number) => new Date(kit.clock.now().getTime() + days * 86_400_000).toISOString().slice(0, 10);

describe('restrictions', () => {
  it('within authority: active at once, account restricted, event with scope; lifting the last one reinstates', async () => {
    const s = await approvedSeller(kit, { launch: true });
    const setterId = newId();
    const input = restrictionInput();
    const res = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/restrictions`, staff(setterId), input);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ state: 'active', title: input.title, affectedSummary: expect.stringContaining('1 category') });
    expect(res.body.ref).toMatch(/^RS-\d{6}-\d{4}$/);
    expect(kit.last('sellers.seller.restricted')).toMatchObject({ sellerId: s.sellerId, restrictionId: res.body.id, affectedActivities: ['new_listings', 'new_offers'], categoryIds: input.scope.categoryIds });
    expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('restricted');

    // canSell answers per activity and scope; existing work is untouched
    const cat = input.scope.categoryIds[0]!;
    expect(await kit.svc.canSell(s.sellerId, { activity: 'new_offers', categoryId: cat })).toMatchObject({ allowed: false, restrictionId: res.body.id });
    expect(await kit.svc.canSell(s.sellerId, { activity: 'new_offers', categoryId: newId() })).toEqual({ allowed: true });
    expect(await kit.svc.canSell(s.sellerId, { activity: 'sales', categoryId: cat })).toEqual({ allowed: true });

    // the seller sees it; another seller does not (404)
    const own = await kit.call('GET', `${SELLER}/restrictions/${res.body.id}`, s.sellerToken);
    expect(own.status).toBe(200);
    expect(own.body.appealRoute.reviewer).toContain('did not make this decision');
    expect((await kit.call('GET', `${SELLER}/restrictions/${res.body.id}`, owner(newId()))).status).toBe(404);

    const edit = await kit.call('PATCH', `${ADMIN}/restrictions/${res.body.id}`, staff(), { affectedActivities: ['new_listings'], reviewDate: futureDate(10), changeReason: 'Offers may continue' });
    expect(edit.status).toBe(200);
    expect(kit.last('sellers.restriction.updated')).toMatchObject({ restrictionId: res.body.id, affectedActivities: ['new_listings'], reviewDate: futureDate(10) });

    const lift = await kit.call('POST', `${ADMIN}/restrictions/${res.body.id}/lift`, staff(), { reason: 'Authorisation letter received' });
    expect(lift.body.state).toBe('lifted');
    expect(kit.last('sellers.restriction.lifted')).toMatchObject({ restrictionId: res.body.id, reason: 'Authorisation letter received' });
    expect(kit.last('sellers.seller.reinstated')).toMatchObject({ sellerId: s.sellerId, from: 'restricted', to: 'approved', liftedRestrictionId: res.body.id, remainingRestrictionIds: [] });
    expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('approved');
    expect((await kit.call('POST', `${ADMIN}/restrictions/${res.body.id}/lift`, staff(), { reason: 'again' })).status).toBe(409);
    expect(kit.audits.filter((a) => a.target.id === res.body.id).map((a) => a.action)).toEqual(expect.arrayContaining(['sellers.restriction.create', 'sellers.restriction.update', 'sellers.restriction.lift']));
  });

  it('above authority: saved pending approval (201 with approval, FORMAT.md Approval responses), activated or cancelled by the decision', async () => {
    const s = await approvedSeller(kit);
    kit.authority.set('sellers.sellers.restrict', 'approval_required');
    try {
      const res = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/restrictions`, staff(), restrictionInput());
      // before pass 3: 409 APPROVAL_REQUIRED although the pending restriction was saved
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ state: 'pending_approval', approval: { required: true, approvalRequestId: expect.any(String) } });
      const { approvalRequestId } = res.body.approval;
      const restrictionId = res.body.id;
      expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('approved');
      await kit.decide(approvalRequestId, 'approved');
      expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('restricted');
      expect(kit.last('sellers.seller.restricted').restrictionId).toBe(restrictionId);

      const second = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/restrictions`, staff(), restrictionInput({ title: 'Promotions paused', affectedActivities: ['promotions'] }));
      await kit.decide(second.body.approval.approvalRequestId, 'rejected');
      const list = await kit.call('GET', `${ADMIN}/sellers/${s.sellerId}`, staff());
      expect(list.body.restrictions.find((r: any) => r.id === second.body.id).state).toBe('cancelled');
    } finally {
      kit.authority.delete('sellers.sellers.restrict');
    }
  });

  it('refuses callers without authority and invalid input', async () => {
    const s = await approvedSeller(kit);
    kit.authority.set('sellers.sellers.restrict', 'denied');
    try {
      expect((await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/restrictions`, staff(), restrictionInput())).status).toBe(403);
    } finally {
      kit.authority.delete('sellers.sellers.restrict');
    }
    const bad = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/restrictions`, staff(), restrictionInput({ affectedActivities: [], reviewDate: '2020-01-01' }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues.map((i: any) => i.path)).toEqual(expect.arrayContaining(['affectedActivities', 'reviewDate']));
  });

  it('expires restrictions past their end and raises review work items', async () => {
    const s = await approvedSeller(kit);
    const res = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/restrictions`, staff(), restrictionInput({ endsAt: new Date(kit.clock.now().getTime() + 86_400_000).toISOString(), reviewDate: futureDate(0) }));
    kit.clock.advance(2 * 86_400_000);
    await kit.svc.restrictionReviews();
    await kit.app.kernel.events.drain();
    kit.clock.advance(-2 * 86_400_000);
    expect(kit.last('sellers.restriction.lifted')).toMatchObject({ restrictionId: res.body.id });
    expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('approved');
  });

  it('resolution evidence and appeals: one open appeal per decision, decided by someone else, overturn lifts', async () => {
    const s = await approvedSeller(kit);
    const setterId = newId();
    const r = (await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/restrictions`, staff(setterId), restrictionInput())).body;
    const ev = await kit.call('POST', `${SELLER}/restrictions/${r.id}/evidence`, s.sellerToken, { evidenceIds: [newId()], note: 'Letter from Halden' });
    expect(ev.status).toBe(200);
    expect(ev.body.resolutionEvidence).toHaveLength(1);
    expect(kit.last('sellers.restriction.evidence_submitted')).toEqual({ sellerId: s.sellerId, restrictionId: r.id });

    const ap = await kit.call('POST', `${SELLER}/restrictions/${r.id}/appeals`, s.sellerToken, { argument: 'We are an authorised Halden retailer', evidenceIds: [newId()] });
    expect(ap.status).toBe(201);
    expect(ap.body).toMatchObject({ subject: 'restriction', subjectRef: r.ref, level: 1, state: 'submitted', originalDecider: { id: setterId } });
    expect(kit.last('sellers.appeal.submitted')).toMatchObject({ appealId: ap.body.id, level: 1, subject: 'restriction' });
    expect((await kit.call('POST', `${SELLER}/restrictions/${r.id}/appeals`, s.sellerToken, { argument: 'again' })).body.error.code).toBe('APPEAL_ALREADY_OPEN');
    const listed = await kit.call('GET', `${ADMIN}/appeals?subject=restriction&limit=100`, staff());
    expect(listed.body.items.some((a: any) => a.id === ap.body.id)).toBe(true);
    expect((await kit.call('POST', `${ADMIN}/appeals/${ap.body.id}/decide`, staff(setterId), { outcome: 'overturn', explanation: 'x' })).body.error.code).toBe('SAME_REVIEWER_NOT_ALLOWED');
    const reviewerId = newId();
    const assigned = await kit.call('POST', `${ADMIN}/appeals/${ap.body.id}/assign`, staff(), { reviewerId });
    expect(assigned.body).toMatchObject({ state: 'under_review', reviewer: { id: reviewerId } });
    const decided = await kit.call('POST', `${ADMIN}/appeals/${ap.body.id}/decide`, staff(reviewerId), { outcome: 'overturn', explanation: 'The letter is valid' });
    expect(decided.body).toMatchObject({ state: 'overturned', decision: { outcome: 'overturned', changes: [`Restriction ${r.ref} lifted`] } });
    expect(kit.last('sellers.restriction.lifted').restrictionId).toBe(r.id);
    expect(kit.last('sellers.appeal.decided')).toMatchObject({ appealId: ap.body.id, outcome: 'overturned' });
  });

  it('upheld appeals allow one second-level appeal; partly overturned narrows the restriction', async () => {
    const s = await approvedSeller(kit);
    const r = (await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/restrictions`, staff(), restrictionInput({ affectedActivities: ['new_listings', 'promotions'] }))).body;
    const first = (await kit.call('POST', `${SELLER}/restrictions/${r.id}/appeals`, s.sellerToken, { argument: 'Please reconsider' })).body;
    const firstReviewer = newId();
    await kit.call('POST', `${ADMIN}/appeals/${first.id}/decide`, staff(firstReviewer), { outcome: 'uphold', explanation: 'The rule applies' });
    const second = await kit.call('POST', `${SELLER}/restrictions/${r.id}/appeals`, s.sellerToken, { argument: 'Second appeal' });
    expect(second.status).toBe(201);
    expect(second.body.level).toBe(2);
    expect((await kit.call('POST', `${ADMIN}/appeals/${second.body.id}/decide`, staff(firstReviewer), { outcome: 'uphold', explanation: 'x' })).body.error.code).toBe('SAME_REVIEWER_NOT_ALLOWED');
    const partly = await kit.call('POST', `${ADMIN}/appeals/${second.body.id}/decide`, staff(), { outcome: 'partly_overturn', explanation: 'Promotions may continue', changes: { affectedActivities: ['new_listings'] } });
    expect(partly.body.state).toBe('partly_overturned');
    expect(kit.last('sellers.restriction.updated')).toMatchObject({ restrictionId: r.id, affectedActivities: ['new_listings'] });
    expect((await kit.call('POST', `${SELLER}/restrictions/${r.id}/appeals`, s.sellerToken, { argument: 'third' })).body.error.code).toBe('APPEAL_ALREADY_OPEN');
  });

  it('appeals can be withdrawn by the seller', async () => {
    const s = await approvedSeller(kit);
    const r = (await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/restrictions`, staff(), restrictionInput())).body;
    const ap = (await kit.call('POST', `${SELLER}/restrictions/${r.id}/appeals`, s.sellerToken, { argument: 'Please' })).body;
    const own = await kit.call('GET', `${SELLER}/appeals`, s.sellerToken);
    expect(own.body.items.map((a: any) => a.id)).toContain(ap.id);
    expect((await kit.call('POST', `${SELLER}/appeals/${ap.id}/withdraw`, owner(newId()))).status).toBe(404);
    const w = await kit.call('POST', `${SELLER}/appeals/${ap.id}/withdraw`, s.sellerToken);
    expect(w.body.state).toBe('withdrawn');
  });
});

describe('suspensions', () => {
  it('always needs a second reviewer; takes effect on approval; reinstate keeps chosen restrictions', async () => {
    const s = await approvedSeller(kit, { launch: true });
    const requesterId = newId();
    const keep = (await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/restrictions`, staff(), restrictionInput())).body;
    const drop = (await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/restrictions`, staff(), restrictionInput({ title: 'Ads paused', affectedActivities: ['advertising'] }))).body;
    const impact = await kit.call('GET', `${ADMIN}/sellers/${s.sellerId}/suspension-impact`, staff());
    expect(impact.status).toBe(200);
    expect(impact.body.unavailable).toEqual(expect.arrayContaining(['offers', 'orders', 'returns', 'cases', 'balances']));

    const input = { reasonCode: 'repeated_late_dispatch', reason: '14 of 40 orders shipped late in 30 days', reviewDate: futureDate(14), openOrders: 'seller_keeps_fulfilling', secondReviewerId: requesterId };
    expect((await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/suspend`, staff(requesterId), input)).body.error.code).toBe('SAME_REVIEWER_NOT_ALLOWED');
    const reviewerId = newId();
    const res = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/suspend`, staff(requesterId), { ...input, secondReviewerId: reviewerId });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ state: 'pending_approval', approval: { required: true } });
    const req = kit.callsOf('requestApproval').map((c) => c[0] as any).find((x) => x.target.id === res.body.suspensionId);
    expect(req).toMatchObject({ action: 'sellers.sellers.suspend', nominatedReviewerId: reviewerId });
    expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('restricted');

    await kit.decide(res.body.approval.approvalRequestId, 'approved', reviewerId);
    expect((await kit.svc.getSeller(s.sellerId))).toMatchObject({ status: 'suspended', canSellNew: false });
    expect(kit.last('sellers.seller.suspended')).toMatchObject({ sellerId: s.sellerId, suspensionId: res.body.suspensionId, openOrders: 'seller_keeps_fulfilling' });
    expect(await kit.svc.canSell(s.sellerId, { activity: 'new_offers' })).toMatchObject({ allowed: false, restrictionId: res.body.suspensionId });

    // the suspension is listed with the restrictions and can be appealed from there
    const list = await kit.call('GET', `${SELLER}/restrictions?state=active`, s.sellerToken);
    expect(list.body.items.map((r: any) => r.id)).toEqual(expect.arrayContaining([res.body.suspensionId, keep.id, drop.id]));
    const ap = await kit.call('POST', `${SELLER}/restrictions/${res.body.suspensionId}/appeals`, s.sellerToken, { argument: 'Carrier strike caused the delays' });
    expect(ap.body.subject).toBe('suspension');
    expect((await kit.call('POST', `${ADMIN}/appeals/${ap.body.id}/assign`, staff(), { reviewerId })).body.error.code).toBe('SAME_REVIEWER_NOT_ALLOWED');

    const back = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/reinstate`, staff(), { reason: 'Dispatch back on track', keepRestrictionIds: [keep.id] });
    expect(back.status).toBe(200);
    expect(back.body.status).toBe('restricted');
    expect(kit.last('sellers.seller.reinstated')).toMatchObject({ from: 'suspended', to: 'restricted', endedSuspensionId: res.body.suspensionId, remainingRestrictionIds: [keep.id] });
    expect(kit.of('sellers.restriction.lifted').some((e) => e.restrictionId === drop.id)).toBe(true);
    expect((await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/reinstate`, staff(), { reason: 'again' })).status).toBe(409);
  });

  it('a declined suspension never takes effect', async () => {
    const s = await approvedSeller(kit);
    const res = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/suspend`, staff(), { reasonCode: 'other', reason: 'Test', reviewDate: futureDate(7), openOrders: 'seller_keeps_fulfilling', secondReviewerId: newId() });
    await kit.decide(res.body.approval.approvalRequestId, 'rejected');
    expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('approved');
  });
});

describe('warnings and closure', () => {
  it('issues and resolves warnings', async () => {
    const s = await approvedSeller(kit);
    const w = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/warnings`, staff(), { kind: 'performance', title: 'Dispatch below target', detail: '91% on time over 30 days' });
    expect(w.status).toBe(201);
    expect(kit.last('sellers.warning.issued')).toMatchObject({ sellerId: s.sellerId, warningId: w.body.id, kind: 'performance' });
    const perf = await kit.call('GET', `${SELLER}/performance`, s.sellerToken);
    expect(perf.body.warnings.map((x: any) => x.id)).toContain(w.body.id);
    const r = await kit.call('POST', `${ADMIN}/warnings/${w.body.id}/resolve`, staff(), { note: 'Resolved after 7 days on time' });
    expect(r.body).toMatchObject({ state: 'resolved', resolutionNote: 'Resolved after 7 days on time' });
    expect((await kit.call('POST', `${ADMIN}/warnings/${w.body.id}/resolve`, staff(), { note: 'again' })).status).toBe(409);
  });

  it('staff closure needs a second reviewer; seller-requested closure closes at once', async () => {
    const s = await approvedSeller(kit);
    const res = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/close`, staff(), { reason: 'Inactive for a year', reasonCode: 'inactive' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'approved', pendingChange: { kind: 'closure' } });
    await kit.decide(res.body.approval.approvalRequestId, 'approved');
    expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('closed');
    expect(kit.last('sellers.seller.closed')).toMatchObject({ sellerId: s.sellerId, reasonCode: 'inactive' });

    const t = await approvedSeller(kit);
    const own = await kit.call('POST', `${SELLER}/account/close`, t.sellerToken, { reason: 'Retiring', reauthToken: 'dev-reauth.seller-closure' });
    expect(own.status).toBe(202);
    expect(own.body.status).toBe('closed');
    expect(kit.last('sellers.seller.closed')).toMatchObject({ sellerId: t.sellerId, reasonCode: 'seller_request' });
    // members keep access to settle open obligations
    expect(await kit.svc.getMemberAccess(t.sellerId, t.accountId)).not.toBeNull();
  });
});

describe('trust enforcements', () => {
  it('creates the restriction, warning or pending suspension from the enforcement, once', async () => {
    const s = await approvedSeller(kit);
    const enforcementId = newId();
    const reportId = newId();
    const event = { enforcementId, reportId, action: 'restrict_seller', ownerTeam: 'sellers', targets: [{ type: 'seller', id: s.sellerId, label: 'x' }], reason: 'Counterfeit reports confirmed', params: { affectedActivities: ['new_offers'], reasonCode: 'counterfeit_risk' }, alreadyApplied: false };
    const manager = { kind: 'staff', id: newId() };
    await kit.emit('trust', 'trust.enforcement.recorded', event, manager);
    await kit.emit('trust', 'trust.enforcement.recorded', event, manager);
    const detail = await kit.call('GET', `${ADMIN}/sellers/${s.sellerId}`, staff());
    const fromTrust = detail.body.restrictions.filter((r: any) => r.trustEnforcementId === enforcementId);
    expect(fromTrust).toHaveLength(1);
    expect(fromTrust[0]).toMatchObject({ state: 'active', reasonCode: 'counterfeit_risk', recommendedBy: { name: 'Trust and Risk' }, trustReportId: reportId });

    await kit.emit('trust', 'trust.enforcement.recorded', { ...event, enforcementId: newId(), action: 'warn_seller', params: { title: 'Listing accuracy warning' } }, manager);
    expect(kit.last('sellers.warning.issued')).toMatchObject({ sellerId: s.sellerId, title: 'Listing accuracy warning' });

    await kit.emit('trust', 'trust.enforcement.recorded', { ...event, enforcementId: newId(), action: 'suspend_seller', params: { secondReviewerId: newId() } }, manager);
    expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('restricted');
    expect(kit.callsOf('requestApproval').some((c) => (c[0] as any).action === 'sellers.sellers.suspend' && (c[0] as any).target.sellerId === s.sellerId)).toBe(true);
  });

  it('requestRestriction (trust public API) follows the same approval rules', async () => {
    const s = await approvedSeller(kit);
    kit.authority.set('sellers.sellers.restrict', 'approval_required');
    try {
      const r = await kit.svc.requestRestriction({ ...(restrictionInput() as any), sellerId: s.sellerId, requestedBy: { kind: 'staff', id: newId() } });
      expect(r.state).toBe('pending_approval');
      expect(r.approval?.approvalRequestId).toBeTruthy();
    } finally {
      kit.authority.delete('sellers.sellers.restrict');
    }
  });
});
