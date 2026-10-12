/**
 * Pass 4: recommendations keep who drafted and routed them and their pending approval in columns, enforcements their
 * pending reversal, and rights-owner reports their organisation (reporter_org).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { spec } from '../../../spec/trust.js';
import { schemas } from '../infra/mongo/schema.js';
import { ADMIN, boot, listing, PUBLIC, routed, staff, staffReport, visitor, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(() => kit.close());

const table = (name: string) => kit.app.kernel.mongo.module('trust', spec.collections, schemas).table<any>(name);

describe('columns', () => {
  it('a recommendation names who drafted and who routed it; they cannot decide it', async () => {
    const sellerId = newId();
    const r = await staffReport(kit, [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }]);
    const drafter = newId();
    const rec = await routed(kit, r.id, { action: 'warn_seller', targets: [{ type: 'seller', id: sellerId, label: 'Gadget Grove' }] }, drafter);
    expect(rec).toMatchObject({ createdBy: { staffId: drafter }, routedBy: { staffId: drafter }, approvalRequestId: null });
    const row = await table('recommendations').get(rec.id);
    expect(row).toMatchObject({ created_by: drafter, routed_by: drafter, approval_request_id: null });
    const own = await kit.call('POST', `${ADMIN}/recommendations/${rec.id}/decide`, staff(drafter), { accept: true, reason: 'x' });
    expect(own.body.error.code).toBe('SEPARATE_DUTIES');
  });

  it('a rights owner report keeps the contact and the brand apart', async () => {
    const l = listing(kit);
    const res = await kit.call('POST', `${PUBLIC}/reports`, visitor(), { brandName: 'Brightline', contactName: 'Rita Brand', contactEmail: 'rita@brightline.example.com', offerOrProductIds: [l.offerId], details: 'Not an authorised reseller', proofMediaIds: [newId()] });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const reportId = kit.of('trust.rights_report.received').find((e) => e.ref === res.body.ref)!.reportId;
    const row = await table('reports').get(reportId);
    expect(row).toMatchObject({ reporter_name: 'Rita Brand', reporter_org: 'Brightline' });
    const full = await kit.call('GET', `${ADMIN}/reports/${reportId}`, staff());
    expect(full.body.reporter).toMatchObject({ name: 'Rita Brand', organization: 'Brightline' });
    const dismissed = await kit.call('POST', `${ADMIN}/reports/${reportId}/dismiss`, staff(), { reason: 'Authorised reseller', reporterOutcome: 'The seller is authorised' });
    expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200);
    expect(dismissed.body.resolution).toMatchObject({ outcome: 'dismissed' });
    expect(kit.of('trust.report.resolved').find((e) => e.reportId === reportId)).toMatchObject({ outcome: 'dismissed', reporters: [{ kind: 'rights_owner', contactName: 'Rita Brand' }] });
  });
});
