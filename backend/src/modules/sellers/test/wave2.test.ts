/**
 * Wave 2 (BACKEND-REQUESTS.md): typed JSON fields (G20, G58f), the information-request draft (G33c), the appeal on the
 * application (G33d), the members status filter (G49b), history states (G58c), restriction scope names (G58d),
 * evidence document types (G58e), seller slugs (G69a) and the applications view permission (G77).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../kernel/lib/ids.js';
import { token } from '../../../testing/app.js';
import { devClaims } from '../../../kernel/auth/dev.js';
import { ADMIN, approvedSeller, boot, restrictionInput, SELLER, staff, STORE, submitted, type Kit } from './helpers.js';

let kit: Kit;
beforeAll(async () => {
  kit = await boot();
});
afterAll(async () => kit?.close());

const staffWith = (permissions: string[]) => token({ ...devClaims('staff', { permissions }) }, 3600);

describe('typed fields (G20, G58f)', () => {
  it('answers the programme, setup, account and admin detail with named shapes', async () => {
    const program = await kit.call('GET', `${STORE}/program`, token(devClaims('visitor'), 3600));
    expect(program.status, JSON.stringify(program.body)).toBe(200);
    expect(program.body).toMatchObject({ payoutTiming: { holdDaysAfterDelivery: 7, isExample: true }, contact: { email: expect.any(String) }, faq: expect.arrayContaining([expect.objectContaining({ q: expect.any(String), a: expect.any(String) })]) });
    expect(program.body.fulfillmentModels[0]).toMatchObject({ availability: 'launch' });

    const s = await approvedSeller(kit);
    const setup = await kit.call('GET', `${SELLER}/setup`, s.sellerToken);
    expect(setup.status, JSON.stringify(setup.body)).toBe(200);
    expect(setup.body.steps[0].cta).toEqual({ label: 'Edit storefront', screen: 'seller/store' });
    const account = await kit.call('GET', `${SELLER}/account`, s.sellerToken);
    expect(account.status, JSON.stringify(account.body)).toBe(200);
    expect(account.body.me).toMatchObject({ isOwner: true });

    const detail = await kit.call('GET', `${ADMIN}/sellers/${s.sellerId}`, staff());
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.owner).toMatchObject({ name: expect.any(String) });
    expect(detail.body.business.contact).toMatchObject({ name: 'Ana Lopez' });
    // G58c: every history event carries a state for colouring
    expect(detail.body.history.length).toBeGreaterThan(0);
    expect(detail.body.history.every((e: { state?: string }) => ['info', 'success', 'warning', 'danger'].includes(e.state ?? ''))).toBe(true);
    expect(detail.body.history.find((e: { label: string }) => /approved/i.test(e.label))?.state).toBe('success');
  });
});

describe('seller slug (G69a)', () => {
  it('lists sellers with their slug and opens the admin detail by slug', async () => {
    const s = await approvedSeller(kit);
    const list = await kit.call('GET', `${ADMIN}/sellers?limit=100`, staff());
    const row = list.body.items.find((r: { id: string }) => r.id === s.sellerId);
    expect(row.slug).toEqual(expect.any(String));
    const bySlug = await kit.call('GET', `${ADMIN}/sellers/${row.slug}`, staff());
    expect(bySlug.status, JSON.stringify(bySlug.body)).toBe(200);
    expect(bySlug.body.account.id).toBe(s.sellerId);
    expect((await kit.call('GET', `${ADMIN}/sellers/no-such-store`, staff())).status).toBe(404);
  });
});

describe('information request draft (G33c) and the appeal on the application (G33d)', () => {
  it('saves a draft answer without sending it; sending uses the saved note', async () => {
    const s = await submitted(kit);
    const reviewer = staff();
    await kit.call('POST', `${ADMIN}/applications/${s.id}/start-review`, reviewer);
    const dueAt = new Date(kit.clock.now().getTime() + 5 * 86_400_000).toISOString();
    const req = await kit.call('POST', `${ADMIN}/applications/${s.id}/request-information`, reviewer, { items: [{ title: 'Shipping plan', detail: 'How you ship batteries', neededFor: 'business' }], message: 'Tell us more', dueAt, reminder: 'none' });
    const itemId = req.body.application.informationRequest.items[0].id;
    const draft = await kit.call('PUT', `${STORE}/applications/${s.id}/response-draft`, s.token, { items: [{ itemId, note: 'Ground only, UN3480 labels' }] });
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    expect(draft.body.state).toBe('information_required');
    expect(draft.body.informationRequest).toMatchObject({ draftSavedAt: expect.any(String), items: [{ status: 'open', response: { note: 'Ground only, UN3480 labels', draft: true, documentIds: [] } }] });
    expect((await kit.call('PUT', `${STORE}/applications/${s.id}/response-draft`, s.token, { items: [{ itemId: newId(), note: 'x' }] })).status).toBe(400);

    const sent = await kit.call('POST', `${STORE}/applications/${s.id}/respond`, s.token, { items: [] });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.state).toBe('under_review');
    expect(sent.body.informationRequest.items[0]).toMatchObject({ status: 'provided', response: { note: 'Ground only, UN3480 labels' } });
  });

  it('shows the appeal against a rejection with its state', async () => {
    const s = await submitted(kit);
    const reviewer = staff();
    await kit.call('POST', `${ADMIN}/applications/${s.id}/start-review`, reviewer);
    await kit.call('POST', `${ADMIN}/applications/${s.id}/reject`, reviewer, { reasonCode: 'outside_assortment', explanation: 'Not at launch', reapply: 'after_30_days' });
    const appeal = await kit.call('POST', `${STORE}/applications/${s.id}/appeal`, s.token, { argument: 'Certified refurbished' });
    expect(appeal.status, JSON.stringify(appeal.body)).toBe(201);
    const app = (await kit.call('GET', `${STORE}/applications/current`, s.token)).body;
    expect(app.appeal).toMatchObject({ id: appeal.body.id, ref: appeal.body.ref, state: 'submitted', level: 1, decision: null });
  });
});

describe('members (G49b)', () => {
  it('leaves revoked invitations out unless asked for', async () => {
    const s = await approvedSeller(kit);
    const inv = await kit.call('POST', `${SELLER}/invitations`, s.sellerToken, { email: `pat.${newId().slice(-6)}@example.com`, name: 'Pat', role: 'shipping' });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect((await kit.call('POST', `${SELLER}/invitations/${inv.body.id}/revoke`, s.sellerToken, {})).status).toBe(200);
    const ids = async (q = '') => (await kit.call('GET', `${SELLER}/members${q}`, s.sellerToken)).body.map((m: { id: string }) => m.id);
    expect(await ids()).not.toContain(inv.body.id);
    expect(await ids('?status=revoked')).toEqual([inv.body.id]);
    expect(await ids('?status=all')).toContain(inv.body.id);
  });
});

describe('restrictions (G58d, G58e)', () => {
  it('names the scope categories and keeps the document type of resolution evidence', async () => {
    const s = await approvedSeller(kit, { launch: true });
    const input = restrictionInput();
    const res = await kit.call('POST', `${ADMIN}/sellers/${s.sellerId}/restrictions`, staff(), input);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.scope.categories).toEqual(input.scope.categoryIds.map((id: string) => ({ id, name: expect.any(String) })));
    const mediaId = newId();
    const sent = await kit.call('POST', `${SELLER}/restrictions/${res.body.id}/evidence`, s.sellerToken, { evidenceIds: [mediaId], note: 'Signed by the brand', documentType: 'authorization_letter' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.evidence).toEqual([expect.objectContaining({ file: expect.objectContaining({ id: mediaId }), documentType: 'authorization_letter', note: 'Signed by the brand' })]);
  });
});

describe('applications view permission (G77)', () => {
  it('lets sellers.applications.view read the queue and an application', async () => {
    const s = await submitted(kit);
    const viewer = staffWith(['sellers.applications.view']);
    expect((await kit.call('GET', `${ADMIN}/applications`, viewer)).status).toBe(200);
    expect((await kit.call('GET', `${ADMIN}/applications/${s.id}`, viewer)).status).toBe(200);
    expect((await kit.call('POST', `${ADMIN}/applications/${s.id}/start-review`, viewer)).status).toBe(403);
    expect((await kit.call('GET', `${ADMIN}/applications`, staffWith(['sellers.applications.review']))).status).toBe(403);
  });
});
