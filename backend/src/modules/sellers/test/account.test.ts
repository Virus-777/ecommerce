import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { ADMIN, approvedSeller, boot, member, owner, payoutInput, SELLER, staff, STORE, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(async () => kit?.close());

describe('account, setup and launch review', () => {
  it('keeps status, verification, product approval and payout readiness separate', async () => {
    const s = await approvedSeller(kit);
    const res = await kit.call('GET', `${SELLER}/account`, s.sellerToken);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: s.sellerId, status: 'approved', verification: { state: 'verified' }, payoutReadiness: { state: 'verification_pending' }, launchReview: { state: 'not_started' }, pendingAgreements: 0 });
    expect(res.body.verification.notChecked[0]).toContain('authenticity');
    expect(res.body.productApproval).toBeNull(); // catalog is off in this app
    expect((await kit.call('GET', `${SELLER}/account`, owner(newId()))).status).toBe(404);
  });

  it('setup checklist; the launch review unlocks after payout verification and a first submission', async () => {
    const s = await approvedSeller(kit);
    const early = await kit.call('POST', `${SELLER}/setup/launch-review`, s.sellerToken, {});
    expect(early.body.error).toMatchObject({ code: 'LAUNCH_REVIEW_NOT_READY', details: { missing: ['payout_verification', 'first_submission'] } });
    const setup = await kit.call('GET', `${SELLER}/setup`, s.sellerToken);
    expect(setup.body.steps.find((x: any) => x.key === 'launch_review').state).toBe('locked');
    expect(setup.body.unavailable).toEqual(expect.arrayContaining(['shipping_coverage', 'return_address']));

    await kit.emit('finance', 'finance.destination.verified', { sellerId: s.sellerId, reviewId: newId() });
    await kit.emit('catalog', 'catalog.product.submitted', { productId: newId(), ownerSellerId: s.sellerId, submissionId: newId(), ref: 'SUB-261010-0001', kind: 'new', title: 'Headphones', reviewDueAt: kit.clock.now().toISOString() });
    const after = await kit.call('GET', `${SELLER}/setup`, s.sellerToken);
    expect(after.body.payoutReadiness.state).toBe('verified');
    expect(after.body.steps.find((x: any) => x.key === 'first_submission').state).toBe('done');
    const req = await kit.call('POST', `${SELLER}/setup/launch-review`, s.sellerToken, { note: 'Ready' });
    expect(req.body.state).toBe('requested');
    expect(kit.last('sellers.launch_review.requested')).toEqual({ sellerId: s.sellerId });
    const changes = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/launch-review/decide`, staff(), { outcome: 'changes_needed', issues: ['Add a logo'] });
    expect(changes.body).toMatchObject({ state: 'changes_needed', issues: ['Add a logo'] });
    await kit.call('POST', `${SELLER}/setup/launch-review`, s.sellerToken, {});
    const pass = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/launch-review/decide`, staff(), { outcome: 'pass' });
    expect(pass.body.state).toBe('passed');
    expect(kit.last('sellers.launch_review.decided')).toMatchObject({ sellerId: s.sellerId, outcome: 'passed' });
    expect(await kit.svc.getSeller(s.sellerId)).toMatchObject({ canSellNew: true, launchReady: true });
    expect((await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/launch-review/decide`, staff(), { outcome: 'pass' })).status).toBe(409);
  });

  it('business details show only the last 4 tax id digits; contact changes need no review', async () => {
    const s = await approvedSeller(kit);
    const b = await kit.call('GET', `${SELLER}/business`, s.sellerToken);
    expect(b.body).toMatchObject({ legalName: 'Northwind Audio LLC', taxIdType: 'ein', taxIdLast4: '6789' });
    expect(b.body.owners[0]).toMatchObject({ name: 'Ana Lopez', verificationState: 'verified' });
    const c = await kit.call('PATCH', `${SELLER}/business/contact`, s.sellerToken, { phone: '+15035559999', supportHours: 'Mon–Sat' });
    expect(c.body.contact).toMatchObject({ phone: '+15035559999', supportHours: 'Mon–Sat', name: 'Ana Lopez' });
    expect(kit.audits.some((a) => a.action === 'sellers.business.contact' && a.target.id === s.sellerId)).toBe(true);
    expect((await kit.call('GET', `${SELLER}/business`, member(s.sellerId, []))).status).toBe(403);
  });

  it('business change requests wait for review; approval changes the legal name', async () => {
    const s = await approvedSeller(kit);
    const req = await kit.call('POST', `${SELLER}/business/change-requests`, s.sellerToken, { kind: 'legal_name', proposed: { legalName: 'Northwind Sound LLC' }, evidenceIds: [newId()], reauthToken: 'dev-reauth.business-change' });
    expect(req.status).toBe(201);
    expect(req.body).toMatchObject({ kind: 'legal_name', state: 'pending', current: { legalName: 'Northwind Audio LLC' } });
    expect(kit.last('sellers.change_request.submitted')).toMatchObject({ changeRequestId: req.body.id, kind: 'legal_name' });
    const queue = await kit.call('GET', `${ADMIN}/change-requests?kind=legal_name&limit=100`, staff());
    expect(queue.body.items.some((c: any) => c.id === req.body.id)).toBe(true);
    const d = await kit.call('POST', `${ADMIN}/change-requests/${req.body.id}/decide`, staff(), { approve: true, reason: 'Registry confirms the new name' });
    expect(d.body.state).toBe('approved');
    expect(kit.last('sellers.change_request.decided')).toMatchObject({ changeRequestId: req.body.id, approved: true });
    expect((await kit.call('GET', `${SELLER}/business`, s.sellerToken)).body.legalName).toBe('Northwind Sound LLC');
    const missing = await kit.call('POST', `${SELLER}/business/change-requests`, s.sellerToken, { kind: 'ownership', proposed: { owners: [] }, evidenceIds: [], reauthToken: 'dev-reauth.business-change' });
    expect(missing.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('payout account change: owner only, tokenised, old account keeps payouts until finance verifies', async () => {
    const s = await approvedSeller(kit);
    await kit.emit('finance', 'finance.destination.verified', { sellerId: s.sellerId, reviewId: newId() });
    const body = { details: payoutInput('000999881234', 'Ana Lopez'), reauthToken: 'dev-reauth.payout-account' };
    const staffMember = member(s.sellerId, ['sellers.payout-account.manage']);
    expect((await kit.call('POST', `${SELLER}/payout-account/change`, staffMember, body, { 'idempotency-key': newId() })).body.error.code).toBe('OWNER_ONLY');
    const wrongHolder = await kit.call('POST', `${SELLER}/payout-account/change`, s.sellerToken, { ...body, details: payoutInput('000999881234', 'Someone Else') }, { 'idempotency-key': newId() });
    expect(wrongHolder.body.error.code).toBe('PAYOUT_DETAILS_INVALID');
    const res = await kit.call('POST', `${SELLER}/payout-account/change`, s.sellerToken, body, { 'idempotency-key': newId() });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ pendingChange: { label: 'Checking •••• 1234' }, readiness: { state: 'change_under_review', destinationLabel: 'Checking •••• 7731' } });
    expect(kit.last('sellers.payout_account.changed')).toMatchObject({ sellerId: s.sellerId, isInitial: false, previousLabel: 'Checking •••• 7731', label: 'Checking •••• 1234' });
    expect((await kit.call('POST', `${SELLER}/payout-account/change`, s.sellerToken, body, { 'idempotency-key': newId() })).body.error.code).toBe('CONFLICT');

    await kit.emit('finance', 'finance.destination.rejected', { sellerId: s.sellerId, reviewId: newId(), reason: 'Name on the account does not match' });
    let acct = await kit.call('GET', `${SELLER}/payout-account`, s.sellerToken);
    expect(acct.body).toMatchObject({ current: { label: 'Checking •••• 7731' }, pendingChange: null, readiness: { state: 'verified' } });

    await kit.call('POST', `${SELLER}/payout-account/change`, s.sellerToken, body, { 'idempotency-key': newId() });
    await kit.emit('finance', 'finance.destination.verified', { sellerId: s.sellerId, reviewId: newId() });
    acct = await kit.call('GET', `${SELLER}/payout-account`, s.sellerToken);
    expect(acct.body).toMatchObject({ current: { label: 'Checking •••• 1234' }, readiness: { state: 'verified', destinationLabel: 'Checking •••• 1234' } });
  });

  it('agreements: new versions from content wait for the owner; outdated versions are refused', async () => {
    const s = await approvedSeller(kit);
    const list = await kit.call('GET', `${SELLER}/agreements`, s.sellerToken);
    expect(list.body.accepted).toHaveLength(4);
    expect(list.body.pending).toEqual([]);
    const out = await kit.call('POST', `${SELLER}/agreements/seller_agreement/accept`, s.sellerToken, { versionLabel: 'v0.1', signedName: 'Ana Lopez' });
    expect(out.body.error.code).toBe('AGREEMENT_VERSION_OUTDATED');
    const same = await kit.call('POST', `${SELLER}/agreements/seller_agreement/accept`, s.sellerToken, { versionLabel: 'v1.0', signedName: 'Ana Lopez' });
    expect(same.status).toBe(200);
    await kit.emit('content', 'content.policy.effective', { policyVersionId: newId(), policyKey: 'seller_agreement', version: 'v1.1' });
    const events = await kit.svc.core.repo.find('account_events', { seller_id: s.sellerId, kind: 'agreement_pending' });
    expect(events).toHaveLength(1);
  });
});

describe('storefront', () => {
  it('profile edits publish at once; a new store name is a change request; public storefront shows approved claims only', async () => {
    const s = await approvedSeller(kit, { launch: true });
    const logoId = newId();
    const up = await kit.call('PATCH', `${SELLER}/store-profile`, s.sellerToken, { logoId, introduction: 'Headphones tested before they ship', storeName: 'Northwind Sound', contactOptions: { orderMessages: true, productQuestions: true, showPhone: true, phone: '+15035550100', replyTarget: 'within_12h' } });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ logo: { id: logoId }, introduction: 'Headphones tested before they ship' });
    expect(up.body.storeName).not.toBe('Northwind Sound');
    expect(up.body.pendingChanges[0]).toMatchObject({ kind: 'store_name', proposed: { storeName: 'Northwind Sound' } });
    expect(kit.last('sellers.storefront.updated')).toMatchObject({ sellerId: s.sellerId, fields: expect.arrayContaining(['logo', 'introduction', 'contactOptions']) });
    expect(kit.callsOf('media.attach').some((c) => c[0] === logoId && (c[1] as any).kind === 'store_logo' && (c[2] as any).id === s.sellerId)).toBe(true);
    const tooLong = await kit.call('PATCH', `${SELLER}/store-profile`, s.sellerToken, { introduction: 'x'.repeat(401) });
    expect(tooLong.body.error.code).toBe('VALIDATION_FAILED');

    const noEvidence = await kit.call('POST', `${SELLER}/store-profile/claims`, s.sellerToken, { kind: 'authorized_retailer', text: 'Authorized Halden retailer', evidenceIds: [] });
    expect(noEvidence.body.error.code).toBe('VALIDATION_FAILED');
    const claim = await kit.call('POST', `${SELLER}/store-profile/claims`, s.sellerToken, { kind: 'authorized_retailer', text: 'Authorized Halden retailer', evidenceIds: [newId()] });
    expect(claim.status).toBe(201);
    const slug = up.body.slug;
    let sf = await kit.call('GET', `${STORE}/stores/${slug}`, s.token);
    expect(sf.status).toBe(200);
    expect(sf.body.approvedClaims).toEqual([]);
    const decided = await kit.call('POST', `${ADMIN}/change-requests/${claim.body.id}/decide`, staff(), { approve: true, reason: 'Letter checked' });
    expect(decided.body).toMatchObject({ kind: 'public_claim', state: 'approved' });
    sf = await kit.call('GET', `${STORE}/stores/${slug}`, s.token);
    expect(sf.body).toMatchObject({ sellingNow: true, approvedClaims: [{ kind: 'authorized_retailer', text: 'Authorized Halden retailer' }], contact: { phone: '+15035550100', replyTarget: 'within_12h' } });
    expect(sf.body.unavailable).toEqual(expect.arrayContaining(['rating', 'shipping', 'returns']));

    const revoke = await kit.call('POST', `${ADMIN}/claims/${claim.body.id}/revoke`, staff(), { reason: 'Halden says no agreement', recordViolation: true });
    expect(revoke.body.state).toBe('revoked');
    sf = await kit.call('GET', `${STORE}/stores/${slug}`, s.token);
    expect(sf.body.approvedClaims).toEqual([]);

    const name = await kit.call('POST', `${ADMIN}/change-requests/${up.body.pendingChanges[0].id}/decide`, staff(), { approve: true, reason: 'OK' });
    expect(name.body.state).toBe('approved');
    expect((await kit.svc.getSeller(s.sellerId))!.storeName).toBe('Northwind Sound');
    expect((await kit.call('GET', `${STORE}/stores/unknown-store-${newId().slice(-4)}`, s.token)).status).toBe(404);
  });

  it('store names already used by another seller are refused', async () => {
    const a = await approvedSeller(kit);
    const b = await approvedSeller(kit);
    const nameOfA = (await kit.svc.getSeller(a.sellerId))!.storeName;
    const res = await kit.call('PATCH', `${SELLER}/store-profile`, b.sellerToken, { storeName: nameOfA.toUpperCase() });
    expect(res.body.error.code).toBe('STORE_NAME_TAKEN');
  });

  it('featured collections: limit, order, scope; suspended stores show none', async () => {
    const s = await approvedSeller(kit, { launch: true });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = await kit.call('POST', `${SELLER}/store-profile/collections`, s.sellerToken, { title: `Collection ${i}`, offerIds: [newId()] });
      expect(c.status).toBe(201);
      ids.push(c.body.id);
    }
    expect((await kit.call('POST', `${SELLER}/store-profile/collections`, s.sellerToken, { title: 'One more', offerIds: [] })).body.error.code).toBe('COLLECTION_LIMIT_REACHED');
    const reordered = await kit.call('PUT', `${SELLER}/store-profile/collections/order`, s.sellerToken, { collectionIds: [...ids].reverse() });
    expect(reordered.body.map((c: any) => c.id)).toEqual([...ids].reverse());
    expect((await kit.call('PUT', `${SELLER}/store-profile/collections/order`, s.sellerToken, { collectionIds: ids.slice(1) })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await kit.call('PATCH', `${SELLER}/store-profile/collections/${ids[0]}`, owner(newId()), { title: 'x', offerIds: [] })).status).toBe(404);
    const upd = await kit.call('PATCH', `${SELLER}/store-profile/collections/${ids[0]}`, s.sellerToken, { title: 'Best sellers', offerIds: [newId(), newId()], visible: false });
    expect(upd.body).toMatchObject({ title: 'Best sellers', offerCount: 2, visible: false });
    expect((await kit.call('DELETE', `${SELLER}/store-profile/collections/${ids[1]}`, s.sellerToken)).status).toBe(204);
    const slug = (await kit.call('GET', `${SELLER}/store-profile`, s.sellerToken)).body.slug;
    const sf = await kit.call('GET', `${STORE}/stores/${slug}`, s.token);
    expect(sf.body.collections).toHaveLength(4);
    const one = await kit.call('GET', `${STORE}/stores/${slug}/collections/${ids[2]}`, s.token);
    expect(one.body.id).toBe(ids[2]);
    expect((await kit.call('GET', `${STORE}/stores/${slug}/collections/${ids[0]}`, s.token)).status).toBe(404);
  });

  it('brand requests: duplicates while pending are refused; approval tells catalog', async () => {
    const s = await approvedSeller(kit);
    const body = { brandName: 'Halden', relationship: 'authorized_reseller', evidenceIds: [newId()] };
    const r = await kit.call('POST', `${SELLER}/brand-requests`, s.sellerToken, body);
    expect(r.status).toBe(201);
    expect((await kit.call('POST', `${SELLER}/brand-requests`, s.sellerToken, body)).body.error.code).toBe('CONFLICT');
    await kit.call('POST', `${ADMIN}/change-requests/${r.body.id}/decide`, staff(), { approve: true, reason: 'Known brand' });
    expect(kit.last('sellers.change_request.decided')).toMatchObject({ kind: 'brand_request', approved: true, brandRequest: { brandName: 'Halden' } });
    const own = await kit.call('GET', `${SELLER}/change-requests?state=approved`, s.sellerToken);
    expect(own.body.items.some((c: any) => c.id === r.body.id)).toBe(true);
  });
});

describe('members', () => {
  it('invites staff with a role template; owner-only and non-delegable keys are refused', async () => {
    const s = await approvedSeller(kit);
    const roles = await kit.call('GET', `${SELLER}/roles`, s.sellerToken);
    expect(roles.body.roles.map((r: any) => r.key)).toEqual(['owner', 'products_inventory', 'shipping', 'customer_service', 'custom']);
    expect(roles.body.permissions.find((p: any) => p.key === 'sellers.payout-account.manage')).toMatchObject({ ownerOnly: true, delegable: false });
    const refused = await kit.call('POST', `${SELLER}/invitations`, s.sellerToken, { email: 'sam@example.com', name: 'Sam', role: 'custom', permissions: ['sellers.payout-account.manage'] });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('NOT_DELEGABLE');
    const inv = await kit.call('POST', `${SELLER}/invitations`, s.sellerToken, { email: 'Sam@Example.com', name: 'Sam', role: 'custom', permissions: ['sellers.store.manage'] });
    expect(inv.status).toBe(201);
    expect(inv.body).toMatchObject({ status: 'invited', email: 'sam@example.com', permissions: ['sellers.store.manage'] });
    expect(kit.last('sellers.member.invited')).toMatchObject({ sellerId: s.sellerId, memberId: inv.body.id });
    expect((await kit.call('POST', `${SELLER}/invitations`, s.sellerToken, { email: 'sam@example.com', name: 'Sam', role: 'shipping' })).body.error.code).toBe('MEMBER_EXISTS');

    // accepting in identity activates the member and grants the seller context
    const invitationId = (await kit.svc.core.repo.get('members', inv.body.id))!.invitation_id!;
    const accountId = newId();
    await kit.emit('identity', 'identity.invitation.accepted', { invitationId, accountId, purpose: 'seller_member', contextRef: s.sellerId });
    await kit.emit('identity', 'identity.invitation.accepted', { invitationId, accountId, purpose: 'seller_member', contextRef: s.sellerId });
    expect(kit.of('sellers.member.joined').filter((e) => e.memberId === inv.body.id)).toHaveLength(1);
    expect(await kit.svc.getMemberAccess(s.sellerId, accountId)).toEqual({ memberId: inv.body.id, role: 'custom', permissions: ['sellers.store.manage'], isOwner: false });
    expect(kit.callsOf('grantSellerContext').some((c) => (c[0] as any).memberId === inv.body.id && !(c[0] as any).isOwner)).toBe(true);

    // public API for notifications: active members (owner first) and the owner
    const ownerRow = (await kit.svc.core.repo.find('members', { seller_id: s.sellerId, is_owner: true }))[0]!;
    expect(await kit.svc.listMembers(s.sellerId)).toEqual([
      { memberId: ownerRow.id, accountId: s.accountId, role: ownerRow.role, isOwner: true },
      { memberId: inv.body.id, accountId, role: 'custom', isOwner: false },
    ]);
    expect(await kit.svc.ownerOf(s.sellerId)).toEqual({ accountId: s.accountId, memberId: ownerRow.id });
    expect(await kit.svc.ownerOf(newId())).toBeNull();
    expect(await kit.svc.listMembers(newId())).toEqual([]);

    const upd = await kit.call('PATCH', `${SELLER}/members/${inv.body.id}`, s.sellerToken, { role: 'shipping' });
    expect(upd.body.role).toBe('shipping');
    expect(kit.last('sellers.member.permissions_changed')).toMatchObject({ memberId: inv.body.id });
    const ownerMember = (await kit.call('GET', `${SELLER}/members`, s.sellerToken)).body.find((m: any) => m.isOwner);
    expect((await kit.call('POST', `${SELLER}/members/${ownerMember.id}/remove`, s.sellerToken, {})).body.error.code).toBe('LAST_OWNER');
    expect((await kit.call('PATCH', `${SELLER}/members/${ownerMember.id}`, s.sellerToken, { role: 'shipping' })).body.error.code).toBe('OWNER_ONLY');

    const sus = await kit.call('POST', `${SELLER}/members/${inv.body.id}/suspend`, s.sellerToken, { reason: 'On leave' });
    expect(sus.body.status).toBe('suspended');
    expect(await kit.svc.getMemberAccess(s.sellerId, accountId)).toBeNull();
    expect((await kit.svc.listMembers(s.sellerId)).map((m) => m.accountId)).toEqual([s.accountId]);
    const rm = await kit.call('POST', `${SELLER}/members/${inv.body.id}/remove`, s.sellerToken, { reason: 'Left' });
    expect(rm.body.status).toBe('removed');
    expect(kit.last('sellers.member.removed')).toMatchObject({ memberId: inv.body.id, accountId });
    expect(kit.callsOf('revokeSellerContext').some((c) => c[0] === accountId && c[1] === s.sellerId)).toBe(true);
    expect((await kit.call('GET', `${SELLER}/members`, member(s.sellerId, ['sellers.staff.manage']))).body.error.code).toBe('OWNER_ONLY');
  });

  it('revoked invitations are not activated; expired ones lapse; closed accounts lose memberships', async () => {
    const s = await approvedSeller(kit);
    const inv = (await kit.call('POST', `${SELLER}/invitations`, s.sellerToken, { email: 'x@example.com', name: 'X', role: 'shipping' })).body;
    expect((await kit.call('POST', `${SELLER}/invitations/${inv.id}/resend`, s.sellerToken)).body.status).toBe('invited');
    expect((await kit.call('POST', `${SELLER}/invitations/${inv.id}/revoke`, s.sellerToken)).body.status).toBe('revoked');
    const invitationId = (await kit.svc.core.repo.get('members', inv.id))!.invitation_id!;
    await kit.emit('identity', 'identity.invitation.accepted', { invitationId, accountId: newId(), purpose: 'seller_member', contextRef: s.sellerId });
    expect((await kit.svc.core.repo.get('members', inv.id))!.status).toBe('revoked');

    const inv2 = (await kit.call('POST', `${SELLER}/invitations`, s.sellerToken, { email: 'y@example.com', name: 'Y', role: 'shipping' })).body;
    kit.clock.advance(8 * 86_400_000);
    await kit.svc.expireInvitations();
    kit.clock.advance(-8 * 86_400_000);
    expect((await kit.svc.core.repo.get('members', inv2.id))!.status).toBe('expired');

    await kit.emit('identity', 'identity.account.closed', { accountId: s.accountId, at: kit.clock.now().toISOString() });
    expect(await kit.svc.getMemberAccess(s.sellerId, s.accountId)).toBeNull();
    // an owner leaving raises seller_owner_missing in sellers.accounts (before pass 3: a seller_performance item)
    expect(kit.work.find((w) => w.dedupeKey === `seller_owner_missing:${s.sellerId}`)).toMatchObject({ queueKey: 'sellers.accounts', kind: 'seller_owner_missing', sourceModule: 'sellers' });
  });
});

describe('admin views', () => {
  it('lists sellers with filters, stats and the seller 360', async () => {
    const s = await approvedSeller(kit);
    await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/notes`, staff(), { body: 'Prefers email' });
    await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/account-manager`, staff(), { staffId: newId() });
    const list = await kit.call('GET', `${ADMIN}/sellers?status=approved&limit=100`, staff());
    expect(list.status).toBe(200);
    expect(list.body.items.find((r: any) => r.id === s.sellerId)).toMatchObject({ status: 'approved', verified: true, openCases: 0 });
    const q = await kit.call('GET', `${ADMIN}/sellers?q=${encodeURIComponent((await kit.svc.getSeller(s.sellerId))!.storeName)}`, staff());
    expect(q.body.items.map((r: any) => r.id)).toEqual([s.sellerId]);
    const stats = await kit.call('GET', `${ADMIN}/sellers/stats`, staff());
    expect(stats.body.byStatus.approved).toBeGreaterThan(0);
    const detail = await kit.call('GET', `${ADMIN}/sellers/${s.sellerId}`, staff());
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ account: { id: s.sellerId, accountManager: { name: 'Sam Staff' } }, notes: [{ body: 'Prefers email' }], owner: { name: 'Ana Lopez' } });
    expect(detail.body.unavailable).toEqual(expect.arrayContaining(['obligations', 'payouts']));
    expect(detail.body.history.length).toBeGreaterThan(0);
    const snaps = await kit.svc.searchSellers({ statuses: ['approved'] }, { limit: 100 });
    expect(snaps.items.some((x) => x.id === s.sellerId)).toBe(true);
    const rows = await kit.svc.exportRows('sellers.admin.accounts', { status: 'approved' }, { kind: 'staff', accountId: newId(), sessionId: 's' } as any);
    expect(rows.rows.length).toBeGreaterThan(0);
  });

  it('grants and revokes the Verified label', async () => {
    const s = await approvedSeller(kit);
    const rev = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/verification`, staff(), { action: 'revoke', reason: 'Registration lapsed' });
    expect(rev.body).toMatchObject({ state: 'revoked', reason: 'Registration lapsed' });
    const grant = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/verification`, staff(), { action: 'grant', reason: 'Renewed' });
    expect(grant.body.state).toBe('verified');
    expect(kit.last('sellers.verification.changed')).toEqual({ sellerId: s.sellerId, state: 'verified' });
    kit.clock.advance(400 * 86_400_000);
    await kit.svc.verificationLapse();
    kit.clock.advance(-400 * 86_400_000);
    expect((await kit.svc.getSeller(s.sellerId))!.verified).toBe(false);
  });

  it('invitations to apply can be revoked and expire', async () => {
    const res = await kit.call('POST', `${ADMIN}/seller-invitations`, staff(), { email: 'new@shop.example.com', businessName: 'New Shop' });
    // the plain code goes to notifications in the event; only its hash is stored
    const code = kit.svc.applications.invitationCode(res.body.id);
    expect(kit.last('sellers.invitation.sent')).toEqual({ invitationId: res.body.id, email: 'new@shop.example.com', businessName: 'New Shop', code, expiresAt: res.body.expiresAt });
    const stored = await kit.svc.core.repo.get('seller_invitations', res.body.id);
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(JSON.stringify(res.body)).not.toContain(code);
    expect((await kit.call('POST', `${ADMIN}/seller-invitations/${res.body.id}/revoke`, staff())).body.state).toBe('revoked');
    expect((await kit.call('POST', `${ADMIN}/seller-invitations/${res.body.id}/revoke`, staff())).status).toBe(409);
  });
});
