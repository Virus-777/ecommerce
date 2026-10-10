/**
 * Pass 4: recommendations keep who drafted and routed them and their pending approval in columns, enforcements their
 * pending reversal, rights-owner reports their organisation (reporter_org), and the 0002 backfill from the timeline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { m0002Pass4PeopleApprovalsReporterOrg } from '../infra/postgres/migrations/0002_pass4_people_approvals_reporter_org.js';
import { ADMIN, boot, listing, PUBLIC, routed, staff, staffReport, visitor, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(() => kit.close());

const db = () => kit.app.kernel.database.kysely.withSchema('trust') as any;

describe('columns', () => {
  it('a recommendation names who drafted and who routed it; they cannot decide it', async () => {
    const sellerId = newId();
    const r = await staffReport(kit, [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }]);
    const drafter = newId();
    const rec = await routed(kit, r.id, { action: 'warn_seller', targets: [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }] }, drafter);
    expect(rec).toMatchObject({ createdBy: { staffId: drafter }, routedBy: { staffId: drafter }, approvalRequestId: null });
    const row = await db().selectFrom('recommendations').selectAll().where('id', '=', rec.id).executeTakeFirst();
    expect(row).toMatchObject({ created_by: drafter, routed_by: drafter, approval_request_id: null });
    const own = await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, staff(drafter), { accept: true, reason: 'x' });
    expect(own.body.error.code).toBe('SEPARATE_DUTIES');
  });

  it('a rights owner report keeps the contact and the brand apart', async () => {
    const l = listing(kit);
    const res = await kit.call('POST', `${PUBLIC}/reports`, visitor(), { brandName: 'Brightline', contactName: 'Rita Brand', contactEmail: 'rita@brightline.example.com', offerOrProductIds: [l.offerId], details: 'Not an authorised reseller', proofMediaIds: [newId()] });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const reportId = kit.of('trust.rights_report.received').find((e) => e.ref === res.body.ref)!.reportId;
    const row = await db().selectFrom('reports').selectAll().where('id', '=', reportId).executeTakeFirst();
    expect(row).toMatchObject({ reporter_name: 'Rita Brand', reporter_org: 'Brightline' });
    const full = await kit.call('GET', `${ADMIN}/reports/${reportId}`, staff());
    expect(full.body.reporter).toMatchObject({ name: 'Rita Brand', organization: 'Brightline' });
    const dismissed = await kit.call('POST', `${ADMIN}/reports/${reportId}/dismiss`, staff(), { reason: 'Authorised reseller', reporterOutcome: 'The seller is authorised' });
    expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200);
    expect(dismissed.body.resolution).toMatchObject({ outcome: 'dismissed' });
    expect(kit.of('trust.report.resolved').find((e) => e.reportId === reportId)).toMatchObject({ outcome: 'dismissed', reporters: [{ kind: 'rights_owner', contactName: 'Rita Brand' }] });
  });
});

describe('migration 0002 backfill', () => {
  it('fills created_by, routed_by, pending approvals and reporter_org from the timeline and reporter_name', async () => {
    const sellerId = newId();
    const r = await staffReport(kit, [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }]);
    const drafter = newId();
    const pendingRec = await routed(kit, r.id, { action: 'restrict_seller', ownerTeam: 'sellers', targets: [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }], params: { affectedActivities: ['new_offers'] } }, drafter);
    const decidedRec = await routed(kit, r.id, { action: 'warn_seller', targets: [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }] }, drafter);
    // the accept above the limit waits for approval
    kit.authority.set('sellers.sellers.restrict', { decision: 'approval_required' });
    const held = await kit.call('POST', `${ADMIN}/recommendations/${pendingRec.id}/decide`, staff(newId(), ['trust.recommendations.decide', 'sellers.accounts.restrict']), { accept: true, reason: 'Counterfeit' });
    kit.authority.delete('sellers.sellers.restrict');
    const requestId = held.body.approval.approvalRequestId as string;
    // a rights owner report stored the old way
    const l = listing(kit);
    const rights = await kit.call('POST', `${PUBLIC}/reports`, visitor(), { brandName: 'Halden', contactName: 'Hal Owner', contactEmail: 'hal@halden.example.com', offerOrProductIds: [l.offerId], details: 'Fake', proofMediaIds: [newId()] });
    const rightsId = kit.of('trust.rights_report.received').find((e) => e.ref === rights.body.ref)!.reportId;

    const k = kit.app.kernel.database;
    await db().updateTable('reports').set({ reporter_name: 'Hal Owner (Halden)' }).where('id', '=', rightsId).execute();
    await k.exec(`alter table trust.recommendations drop column created_by, drop column routed_by, drop column approval_request_id;
alter table trust.enforcements drop column reversal_request_id;
alter table trust.reports drop column reporter_org;`);
    await k.exec(`begin;\n${m0002Pass4PeopleApprovalsReporterOrg.sql}\ncommit;`);

    const recs = await db().selectFrom('recommendations').selectAll().where('id', 'in', [pendingRec.id, decidedRec.id]).execute();
    const byId = new Map(recs.map((x: any) => [x.id, x]));
    expect(byId.get(pendingRec.id)).toMatchObject({ created_by: drafter, routed_by: drafter, approval_request_id: requestId });
    expect(byId.get(decidedRec.id)).toMatchObject({ created_by: drafter, routed_by: drafter, approval_request_id: null });
    const report = await db().selectFrom('reports').selectAll().where('id', '=', rightsId).executeTakeFirst();
    expect(report).toMatchObject({ reporter_name: 'Hal Owner', reporter_org: 'Halden' });

    // the backfilled pending approval still finishes the accept
    await kit.emit('access', 'access.approval.decided', { requestId, ref: 'AP-1', actionKey: 'sellers.sellers.restrict', module: 'sellers', target: { type: 'trust_recommendation', id: pendingRec.id, sellerId }, outcome: 'approved', approverIds: [], requestedById: newId() });
    const after = await db().selectFrom('recommendations').selectAll().where('id', '=', pendingRec.id).executeTakeFirst();
    expect(after).toMatchObject({ state: 'completed', approval_request_id: null });
  });
});
