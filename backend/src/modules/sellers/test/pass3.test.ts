/**
 * Gap pass 3: duplicate checks and hashes on submit (trust.raiseSignal), the information reminder event,
 * getApplicationParticipant, tagline change requests, member reactivation, invitation revocation in
 * identity, trustEnforcementId on suspensions and warnings, trust.enforcement.reversed, the Verified
 * label validity setting and verification check retries.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, approvedSeller, boot, customer, type Kit, SELLER, STORE, staff, submitted } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(async () => {
  await kit?.close();
});

const DAY = 86_400_000;

describe('submitApplication: hashes and duplicate checks', () => {
  it('publishes ref, decisionTargetAt and hashes (never the tax id); a second application with the same details is sent to trust', async () => {
    const first = await submitted(kit);
    const e1 = kit.of('sellers.application.submitted').find((e) => e.applicationId === first.id);
    expect(e1).toMatchObject({ ref: first.application.ref, decisionTargetAt: expect.any(String), taxIdHash: expect.stringMatching(/^[0-9a-f]{64}$/), bankTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/), addressKey: expect.stringMatching(/^[0-9a-f]{64}$/), duplicateCount: 0 });
    expect(JSON.stringify(e1)).not.toContain('123456789');
    expect(new Date(e1.decisionTargetAt).getTime()).toBeGreaterThan(kit.clock.now().getTime());
    const row = (await kit.svc.core.repo.get('applications', first.id))!;
    expect(row.tax_id_hash).toBe(e1.taxIdHash);

    // same tax id, payout account and address (the helper uses the same business details)
    const second = await submitted(kit);
    const e2 = kit.of('sellers.application.submitted').find((e) => e.applicationId === second.id);
    expect(e2.taxIdHash).toBe(e1.taxIdHash);
    expect(e2.duplicateCount).toBeGreaterThanOrEqual(1);
    const signals = kit.callsOf('trust.raiseSignal').map((c) => c[0] as any).filter((s) => s.subjects[0].id === second.id);
    expect(signals.length).toBe(e2.duplicateCount);
    expect(signals.find((s) => s.subjects[1].id === first.sellerId)).toMatchObject({
      type: 'duplicate_application',
      dedupeKey: `duplicate_application:${second.id}`,
      subjects: [{ type: 'application', id: second.id }, { type: 'seller', id: first.sellerId }],
      evidence: [{ kind: 'signal', text: expect.stringContaining('tax id') }],
    });
    // every detail these two share is named, so a signal the query stops asking about shows up here
    expect(signals.find((s) => s.subjects[1].id === first.sellerId).evidence[0].text).toContain('tax id, bank account, business address, return address');
    // the reviewer sees the matches
    const admin = await kit.call('GET', `${ADMIN}/applications/${second.id}`, staff());
    expect(admin.body.duplicateSignals.join(' ')).toContain(first.application.ref);
  });

  /**
   * Each signal is asked for on its own, which the test above cannot say: its two applications share all
   * four, so the match is still found whichever one of them the query stops asking about.
   *
   * The address line is compared **ignoring case inside a JSON document** — `lower()` on MongoDB, the
   * `as_ci` collation on MySQL — so it is matched here against a differently cased copy of itself. The work
   * email is compared the same way, but the step that saves an application lower-cases it first, so nothing
   * this test writes can tell `as_ci` from a case-sensitive comparison there; the comment in
   * `queries.mysql.ts` says so where the code is.
   */
  it('a shared work email alone, and a shared address alone, each make a duplicate', async () => {
    let n = 20;
    // a 9-digit EIN and a 12-digit account, both unlike the helper's defaults and unlike each other's
    const unique = () => ({ taxId: `${++n}-${String(1_000_000 + n)}`, payoutAccount: `000${String(200_000_000 + n)}` });
    const elsewhere = (line1: string, postalCode: string) => ({ name: 'Northwind Audio LLC', line1, city: 'Bend', region: 'OR', postalCode, country: 'US' });

    const email = `ana.${newId().slice(-6)}@northwind.example.com`;
    const a = await submitted(kit, { ...unique(), address: elsewhere('12 Juniper Way', '97701'), workEmail: email });
    const b = await submitted(kit, { ...unique(), address: elsewhere('880 Alder Rd', '97702'), workEmail: email.toUpperCase() });
    const reasons = (id: string, matchRef: string) =>
      kit
        .callsOf('trust.raiseSignal')
        .map((c) => c[0] as any)
        .filter((s) => s.subjects[0].id === id && String(s.evidence[0].text).includes(matchRef))
        .map((s) => String(s.evidence[0].text));
    expect(reasons(b.id, a.application.ref)).toEqual([expect.stringContaining('Same work email as')]);

    const line1 = `${newId().slice(-4)} Larch Ave`;
    const c = await submitted(kit, { ...unique(), address: elsewhere(line1, '97703') });
    const d = await submitted(kit, { ...unique(), address: elsewhere(line1.toUpperCase(), '97703') });
    // the business address and the return address are the same place here (return_address.sameAsBusiness)
    expect(reasons(d.id, c.application.ref)).toEqual([expect.stringContaining('Same business address, return address as')]);
  });
});

describe('applications: participant and reminders', () => {
  it('getApplicationParticipant returns the applicant (null for unknown)', async () => {
    const s = await submitted(kit);
    expect(await kit.svc.getApplicationParticipant(s.id)).toMatchObject({ applicationId: s.id, ref: s.application.ref, state: 'submitted', applicantAccountId: s.accountId, sellerId: s.sellerId, name: 'Ana Lopez', email: expect.stringContaining('@northwind.example.com'), storeName: expect.stringContaining('Northwind') });
    expect(await kit.svc.getApplicationParticipant(newId())).toBeNull();
    expect(await kit.svc.getApplicationParticipant('nope')).toBeNull();
  });

  it('the deadlines job publishes sellers.application.information_reminder once per request', async () => {
    const s = await submitted(kit);
    const reviewer = staff();
    await kit.call('POST', `${ADMIN}/applications/${s.id}/start-review`, reviewer);
    const dueAt = new Date(kit.clock.now().getTime() + 2 * DAY).toISOString();
    const req = await kit.call('POST', `${ADMIN}/applications/${s.id}/request-information`, reviewer, { items: [{ title: 'Utility bill', detail: 'Proof of address', neededFor: 'business', documentKind: 'proof_of_address' }, { title: 'Bank letter', neededFor: 'payout', documentKind: 'bank_letter' }], message: 'Two documents please', dueAt, reminder: 'three_days_before' });
    expect(req.status, JSON.stringify(req.body)).toBe(200);
    await kit.svc.applicationDeadlines();
    await kit.svc.applicationDeadlines();
    await kit.app.kernel.events.drain();
    const reminders = kit.of('sellers.application.information_reminder').filter((e) => e.applicationId === s.id);
    expect(reminders).toEqual([{ applicationId: s.id, ref: s.application.ref, sellerId: s.sellerId, applicantAccountId: s.accountId, dueAt: new Date(dueAt).toISOString(), openItems: 2 }]);
  });
});

describe('store profile: tagline', () => {
  it('a new tagline is a change request (the current one stays live); approval publishes it; removing needs no review', async () => {
    const s = await approvedSeller(kit);
    const tooLong = await kit.call('PATCH', `${SELLER}/store-profile`, s.sellerToken, { tagline: 'x'.repeat(81) });
    expect(tooLong.status).toBe(400);
    const up = await kit.call('PATCH', `${SELLER}/store-profile`, s.sellerToken, { tagline: 'Headphones tested before they ship' });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.tagline).toBeNull();
    const pending = up.body.pendingChanges.find((c: any) => c.kind === 'tagline');
    expect(pending).toMatchObject({ state: 'pending', proposed: { tagline: 'Headphones tested before they ship' } });
    expect(kit.last('sellers.change_request.submitted')).toMatchObject({ changeRequestId: pending.id, kind: 'tagline' });
    expect((await kit.call('GET', `${ADMIN}/change-requests?kind=tagline&limit=100`, staff())).body.items.map((c: any) => c.id)).toContain(pending.id);

    const d = await kit.call('POST', `${ADMIN}/change-requests/${pending.id}/decide`, staff(), { approve: true, reason: 'Accurate' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(kit.last('sellers.storefront.updated')).toMatchObject({ sellerId: s.sellerId, fields: ['tagline'] });
    expect((await kit.call('GET', `${SELLER}/store-profile`, s.sellerToken)).body.tagline).toBe('Headphones tested before they ship');

    const removed = await kit.call('PATCH', `${SELLER}/store-profile`, s.sellerToken, { tagline: '' });
    expect(removed.body.tagline).toBeNull();
    expect(removed.body.pendingChanges.filter((c: any) => c.kind === 'tagline')).toEqual([]);
  });
});

describe('members', () => {
  it('reactivates a suspended member with their permissions and grants the seller context again; revoking an invitation cancels it in identity', async () => {
    const s = await approvedSeller(kit);
    const inv = await kit.call('POST', `${SELLER}/invitations`, s.sellerToken, { email: `m.${newId().slice(-5)}@example.com`, name: 'Max', role: 'custom', permissions: ['sellers.store.manage'] });
    const invitationId = (await kit.svc.core.repo.get('members', inv.body.id))!.invitation_id!;
    const accountId = newId();
    await kit.emit('identity', 'identity.invitation.accepted', { invitationId, accountId, purpose: 'seller_member', contextRef: s.sellerId });
    expect((await kit.call('POST', `${SELLER}/members/${inv.body.id}/reactivate`, s.sellerToken, {})).status).toBe(409);
    await kit.call('POST', `${SELLER}/members/${inv.body.id}/suspend`, s.sellerToken, { reason: 'On leave' });
    expect(await kit.svc.getMemberAccess(s.sellerId, accountId)).toBeNull();

    const grantsBefore = kit.callsOf('grantSellerContext').length;
    const re = await kit.call('POST', `${SELLER}/members/${inv.body.id}/reactivate`, s.sellerToken, { reason: 'Back from leave' });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body).toMatchObject({ status: 'active', permissions: ['sellers.store.manage'] });
    expect(await kit.svc.getMemberAccess(s.sellerId, accountId)).toMatchObject({ memberId: inv.body.id, permissions: ['sellers.store.manage'] });
    expect(kit.callsOf('grantSellerContext').length).toBe(grantsBefore + 1);
    expect(kit.last('sellers.member.reactivated')).toEqual({ sellerId: s.sellerId, memberId: inv.body.id, accountId, permissions: ['sellers.store.manage'] });
    expect(kit.audits.some((a) => a.action === 'sellers.member.reactivate' && a.target.id === inv.body.id)).toBe(true);
    // another seller's member → 404
    const other = await approvedSeller(kit);
    expect((await kit.call('POST', `${SELLER}/members/${inv.body.id}/reactivate`, other.sellerToken, {})).status).toBe(404);

    const inv2 = await kit.call('POST', `${SELLER}/invitations`, s.sellerToken, { email: `r.${newId().slice(-5)}@example.com`, name: 'Rae', role: 'shipping' });
    const inv2Id = (await kit.svc.core.repo.get('members', inv2.body.id))!.invitation_id!;
    expect((await kit.call('POST', `${SELLER}/invitations/${inv2.body.id}/revoke`, s.sellerToken)).body.status).toBe('revoked');
    expect(kit.callsOf('revokeInvitation').find((c) => c[0] === inv2Id)![1]).toMatchObject({ contextRef: s.sellerId, by: { kind: expect.any(String) } });
  });
});

const reversed = (o: { enforcementId: string; action: string; sellerId: string; appliedRef?: string | null }) => ({
  enforcementId: o.enforcementId,
  ref: 'EN-261010-0001',
  reportId: newId(),
  reportRef: 'TR-261010-0001',
  action: o.action,
  ownerTeam: 'sellers',
  targets: [{ type: 'seller', id: o.sellerId, label: 'Seller' }],
  params: {},
  appliedRef: o.appliedRef ?? null,
  executionState: 'applied',
  reason: 'Appeal overturned',
  appealId: newId(),
  reversedBy: { kind: 'staff', id: newId(), name: 'Tara Trust' },
  reversedAt: new Date().toISOString(),
});

describe('trust enforcements: trustEnforcementId and reversal (decision D9)', () => {
  it('a reversed restrict_seller lifts the restriction it created and reinstates the seller, once', async () => {
    const s = await approvedSeller(kit);
    const enforcementId = newId();
    const manager = { kind: 'staff', id: newId() };
    await kit.emit('trust', 'trust.enforcement.recorded', { enforcementId, reportId: newId(), action: 'restrict_seller', ownerTeam: 'sellers', targets: [{ type: 'seller', id: s.sellerId, label: 'x' }], reason: 'Counterfeit', params: { affectedActivities: ['new_offers'] }, alreadyApplied: false }, manager);
    expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('restricted');
    const payload = reversed({ enforcementId, action: 'restrict_seller', sellerId: s.sellerId });
    await kit.emit('trust', 'trust.enforcement.reversed', payload);
    await kit.emit('trust', 'trust.enforcement.reversed', payload);
    expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('approved');
    const lifted = kit.of('sellers.restriction.lifted').filter((e) => e.sellerId === s.sellerId);
    expect(lifted).toHaveLength(1);
    expect(lifted[0]).toMatchObject({ trustEnforcementId: enforcementId, reason: expect.stringContaining('Appeal overturned') });
    expect(kit.of('sellers.seller.reinstated').filter((e) => e.sellerId === s.sellerId)).toHaveLength(1);
    // another enforcement's reversal and other actions change nothing
    await kit.emit('trust', 'trust.enforcement.reversed', reversed({ enforcementId: newId(), action: 'restrict_seller', sellerId: s.sellerId }));
    await kit.emit('trust', 'trust.enforcement.reversed', reversed({ enforcementId, action: 'suspend_offer', sellerId: s.sellerId }));
    expect(kit.of('sellers.restriction.lifted').filter((e) => e.sellerId === s.sellerId)).toHaveLength(1);
  });

  it('warnings keep trustEnforcementId; the reversal resolves the warning (sellers.warning.resolved)', async () => {
    const s = await approvedSeller(kit);
    const enforcementId = newId();
    await kit.emit('trust', 'trust.enforcement.recorded', { enforcementId, reportId: newId(), action: 'warn_seller', ownerTeam: 'sellers', targets: [{ type: 'seller', id: s.sellerId, label: 'x' }], reason: 'Listing accuracy', params: { title: 'Listing accuracy warning' }, alreadyApplied: false }, { kind: 'staff', id: newId() });
    const issued = kit.last('sellers.warning.issued');
    expect(issued).toMatchObject({ sellerId: s.sellerId, trustEnforcementId: enforcementId });
    await kit.emit('trust', 'trust.enforcement.reversed', reversed({ enforcementId, action: 'warn_seller', sellerId: s.sellerId }));
    expect(kit.last('sellers.warning.resolved')).toEqual({ sellerId: s.sellerId, warningId: issued.warningId, note: expect.stringContaining('Appeal overturned'), trustEnforcementId: enforcementId });
    expect((await kit.svc.core.repo.get('warnings', issued.warningId))!.state).toBe('resolved');
    // staff resolving a warning publishes the event too
    const w = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/warnings`, staff(), { kind: 'performance', title: 'Late dispatch', detail: 'Three late orders' });
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    expect(kit.last('sellers.warning.issued').trustEnforcementId).toBeNull();
    const r = await kit.call('POST', `${ADMIN}/warnings/${w.body.id}/resolve`, staff(), { note: 'Back on target' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(kit.last('sellers.warning.resolved')).toMatchObject({ warningId: w.body.id, note: 'Back on target', trustEnforcementId: null });
  });

  it('suspend_seller: the suspension keeps trustEnforcementId; reversal cancels a pending one or reinstates an active one', async () => {
    const s = await approvedSeller(kit);
    const pendingId = newId();
    const rec = (enforcementId: string) => ({ enforcementId, reportId: newId(), action: 'suspend_seller', ownerTeam: 'sellers', targets: [{ type: 'seller', id: s.sellerId, label: 'x' }], reason: 'Fraud ring', params: { secondReviewerId: newId() }, alreadyApplied: false });
    await kit.emit('trust', 'trust.enforcement.recorded', rec(pendingId), { kind: 'staff', id: newId() });
    const pending = await kit.svc.core.repo.findOne('suspensions', { seller_id: s.sellerId, state: 'pending_approval' });
    expect(pending).toMatchObject({ trust_enforcement_id: pendingId });
    await kit.emit('trust', 'trust.enforcement.reversed', reversed({ enforcementId: pendingId, action: 'suspend_seller', sellerId: s.sellerId }));
    expect((await kit.svc.core.repo.get('suspensions', pending!.id))!.state).toBe('cancelled');
    // an approval arriving later changes nothing
    const req = kit.callsOf('requestApproval').map((c) => c[0] as any).find((a) => a.target.id === pending!.id);
    if (req) {
      const id = [...kit.approvals.entries()].find(([, v]) => v === req)![0];
      await kit.decide(id, 'approved');
      expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('approved');
    }

    const activeId = newId();
    await kit.emit('trust', 'trust.enforcement.recorded', rec(activeId), { kind: 'staff', id: newId() });
    const row = (await kit.svc.core.repo.findOne('suspensions', { seller_id: s.sellerId, trust_enforcement_id: activeId }))!;
    const approvalId = [...kit.approvals.entries()].find(([, v]) => v.target.id === row.id)![0];
    await kit.decide(approvalId, 'approved');
    expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('suspended');
    expect(kit.last('sellers.seller.suspended')).toMatchObject({ suspensionId: row.id, trustEnforcementId: activeId });
    await kit.emit('trust', 'trust.enforcement.reversed', reversed({ enforcementId: activeId, action: 'suspend_seller', sellerId: s.sellerId }));
    expect((await kit.svc.getSeller(s.sellerId))!.status).toBe('approved');
    expect((await kit.svc.core.repo.get('suspensions', row.id))!.state).toBe('ended');
    expect(kit.last('sellers.seller.reinstated')).toMatchObject({ sellerId: s.sellerId, from: 'suspended', endedSuspensionId: row.id });
  });
});

describe('Verified label and verification checks', () => {
  it('a granted label lasts verifiedLabelValidDays (365 by default) and lapses after it', async () => {
    const s = await approvedSeller(kit);
    const seller = (await kit.svc.core.repo.get('sellers', s.sellerId))!;
    if (seller.verification_state !== 'verified') {
      const g = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/verification`, staff(), { action: 'grant', reason: 'Checks passed' });
      expect(g.status, JSON.stringify(g.body)).toBe(200);
    }
    const after = (await kit.svc.core.repo.get('sellers', s.sellerId))!;
    expect(Math.round((after.verification_expires_at!.getTime() - after.verified_at!.getTime()) / DAY)).toBe(365);
    kit.clock.advance(366 * DAY);
    try {
      await kit.svc.verificationLapse();
      expect((await kit.svc.core.repo.get('sellers', s.sellerId))!.verification_state).toBe('lapsed');
    } finally {
      kit.clock.advance(-366 * DAY);
    }
  });

  it('the job retries checks that were sent but have no result yet', async () => {
    const s = await submitted(kit);
    const check = (await kit.svc.core.repo.find('verification_checks', { application_id: s.id }))[0]!;
    await kit.svc.core.repo.update('verification_checks', check.id, { result: 'pending', provider_ref: 'stale-ref', checked_at: null });
    await kit.svc.runVerificationChecks();
    const again = (await kit.svc.core.repo.get('verification_checks', check.id))!;
    expect(again.provider_ref).not.toBe('stale-ref');
  });
});

void STORE;
void customer;
