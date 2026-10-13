import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spec } from '../../../spec/settings.js';
import { schemas } from '../schema.js';
import { decided, draft, harness, inDays, inMinutes, staff, submit, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.app.close();
});
beforeEach(() => {
  h.clock.set(new Date());
  h.access.decision = 'approval_required';
  h.events.length = 0;
  h.audits.length = 0;
});

const get = (url: string) => h.app.inject({ method: 'GET', url: `/api/admin/settings${url}`, headers: staff() });

describe('definitions and values', () => {
  it('lists settings-owned keys and every module setting, filterable', async () => {
    const res = await get('/definitions');
    expect(res.statusCode).toBe(200);
    const defs = res.json() as any[];
    const byKey = new Map(defs.map((d) => [d.key, d]));
    expect(byKey.get('market.currency')).toMatchObject({ editable: false, approval: 'business_owner', minLeadDays: 30, section: 'market' });
    expect(byKey.get('checkout.guestCheckoutEnabled')).toMatchObject({ module: 'checkout', approval: 'business_owner', valueType: 'bool', default: true, public: true });
    expect(byKey.get('catalog.maxImagesPerProduct')).toMatchObject({ module: 'catalog', section: 'catalog', valueType: 'int', default: 12, label: 'Max images per product', sellerVisible: true, minLeadDays: 14 });
    expect(byKey.get('support.maxAttachments')).toMatchObject({ module: 'support', sellerVisible: false, minLeadDays: 0, approval: 'none' });
    // later-phase modules that are off have no definitions
    expect(defs.some((d) => d.module === 'wishlist')).toBe(false);

    const only = (await get('/definitions?module=checkout')).json() as any[];
    expect(only.length).toBeGreaterThan(2);
    expect(only.every((d) => d.module === 'checkout')).toBe(true);
    const section = (await get('/definitions?section=apps')).json() as any[];
    expect(section.map((d) => d.key)).toContain('apps.maintenance');
  });

  it('shows one setting with the declared default as version 0, and 404 for an unknown key', async () => {
    const res = await get('/values/catalog.minDescriptionLength');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ definition: { key: 'catalog.minDescriptionLength' }, current: { version: 0, value: 40, valueText: '40 characters' }, scheduled: [] });
    expect((await get('/values/nope.nothing')).statusCode).toBe(404);
    const history = (await get('/values/catalog.minDescriptionLength/history')).json();
    expect(history.items).toHaveLength(1);
  });

  it('sync-definitions writes the registry, the flags and seeds market defaults once', async () => {
    await h.app.kernel.jobs.runNow('settings.sync-definitions');
    const store = h.app.kernel.mongo.module('settings', spec.collections, schemas);
    const defs = await store.table<{ key: string }>('definitions').find();
    expect(defs.find((d) => d.key === 'market.timeZone')).toBeDefined();
    const flags = await store.table<{ key: string }>('feature_flags').find();
    expect(flags.map((f) => f.key)).toContain('wishlist');
    const seeded = await store.table<{ key: string; version: number }>('values').find({ key: 'market.country' });
    expect(seeded.map((v) => ({ key: v.key, version: v.version }))).toEqual([{ key: 'market.country', version: 1 }]);
    await h.app.kernel.jobs.runNow('settings.sync-definitions');
    expect(await store.table('values').count({ key: 'market.country' })).toBe(1);
    const detail = (await get('/values/market.country')).json();
    expect(detail.current).toMatchObject({ version: 1, value: 'US', changedBy: { kind: 'system' } });
  });
});

describe('drafts', () => {
  it('drafts a change with items, impact preview and a SC- reference', async () => {
    const res = await draft(h, { items: [{ key: 'support.maxAttachments', value: 8 }], effectiveAt: inDays(h, 1), reason: 'Customers send more photos' });
    expect(res.statusCode, res.body).toBe(201);
    const c = res.json();
    expect(c.ref).toMatch(/^SC-\d{6}-\d{3}$/);
    expect(c).toMatchObject({
      status: 'draft',
      items: [{ key: 'support.maxAttachments', section: 'support', from: 5, to: 8, fromText: '5', toText: '8' }],
      impact: { blocking: [], needsApproval: false, approvalRule: 'none' },
      approval: null,
      timeline: [{ label: 'Draft created' }],
    });
    expect((await get(`/changes/${c.id}`)).json().id).toBe(c.id);
  });

  it('refuses unknown, read-only and invalid values', async () => {
    const unknown = await draft(h, { items: [{ key: 'nope.nothing', value: 1 }], effectiveAt: inDays(h, 1) });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatchObject({ code: 'UNKNOWN_SETTING', details: { key: 'nope.nothing' } });

    const readOnly = await draft(h, { items: [{ key: 'market.currency', value: 'EUR' }], effectiveAt: inDays(h, 40) });
    expect(readOnly.statusCode).toBe(409);
    expect(readOnly.json().error.code).toBe('SETTING_NOT_EDITABLE');

    const wrongType = await draft(h, { items: [{ key: 'support.maxAttachments', value: 'many' }], effectiveAt: inDays(h, 1) });
    expect(wrongType.statusCode).toBe(400);
    expect(wrongType.json().error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'items.0.value' }] } });

    const negative = await draft(h, { items: [{ key: 'support.maxAttachments', value: -1 }], effectiveAt: inDays(h, 1) });
    expect(negative.json().error.code).toBe('VALIDATION_FAILED');

    const tz = await draft(h, { items: [{ key: 'market.timeZone', value: 'Mars/Olympus' }], effectiveAt: inDays(h, 40) });
    expect(tz.json().error.code).toBe('VALIDATION_FAILED');

    const hours = await draft(h, { items: [{ key: 'support.businessHours', value: [{ weekday: 'mon', opens: '18:00', closes: '09:00' }] }], effectiveAt: inDays(h, 1) });
    expect(hours.json().error.code).toBe('VALIDATION_FAILED');

    const same = await draft(h, { items: [{ key: 'support.maxAttachmentMb', value: 10 }], effectiveAt: inDays(h, 1) });
    expect(same.json().error).toMatchObject({ code: 'VALIDATION_FAILED' });

    const twice = await draft(h, { items: [{ key: 'support.reopenWindowDays', value: 20 }, { key: 'support.reopenWindowDays', value: 21 }], effectiveAt: inDays(h, 1) });
    expect(twice.json().error.code).toBe('VALIDATION_FAILED');

    const scope = await draft(h, { items: [{ key: 'checkout.offerAccountAfterGuestPurchase', value: false }], effectiveAt: inDays(h, 1), applyScope: 'open_commitments' });
    expect(scope.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('edits a draft, but not a scheduled change', async () => {
    const c = (await draft(h, { items: [{ key: 'support.autoCloseAfterDays', value: 9 }], effectiveAt: inDays(h, 2) })).json();
    const edited = await h.app.inject({ method: 'PATCH', url: `/api/admin/settings/changes/${c.id}`, headers: staff(), payload: { items: [{ key: 'support.autoCloseAfterDays', value: 10 }], effectiveAt: inDays(h, 3), applyScope: 'new_only', reason: 'Ten days' } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ items: [{ to: 10 }], reason: 'Ten days', timeline: [{ label: 'Draft created' }, { label: 'Draft edited' }] });

    expect((await submit(h, c.id)).json().status).toBe('scheduled');
    const again = await h.app.inject({ method: 'PATCH', url: `/api/admin/settings/changes/${c.id}`, headers: staff(), payload: { items: [{ key: 'support.autoCloseAfterDays', value: 11 }], effectiveAt: inDays(h, 3), applyScope: 'new_only', reason: 'x' } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('recalculates the preview, with what registered estimators report', async () => {
    await h.api.registerImpactEstimator('support.appeal', (change) => [
      { module: 'support', kind: 'content', count: 3, message: `3 Help articles mention ${change.from} days`, severity: 'warning', owner: 'Content Manager' },
    ]);
    const c = (await draft(h, { items: [{ key: 'support.appealWindowDays', value: 21 }], effectiveAt: inDays(h, 1) })).json();
    expect(c.impact.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'content', count: 3, message: '3 Help articles mention 14 days' })]));
    const res = await h.app.inject({ method: 'POST', url: `/api/admin/settings/changes/${c.id}/preview`, headers: staff() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ blocking: [], approvalRule: 'business_owner', approvers: ['Business Owner'] }); // declared approval of support.appealWindowDays
  });

  it('a blocking estimator item blocks submit', async () => {
    await h.api.registerImpactEstimator('support.appealReply', () => [{ module: 'support', kind: 'staff', message: 'Open appeals would breach their deadline', severity: 'blocking' }]);
    const c = (await draft(h, { items: [{ key: 'support.appealReplyBusinessDays', value: 1 }], effectiveAt: inDays(h, 1) })).json();
    expect(c.impact.blocking).toContain('Open appeals would breach their deadline');
    const res = await submit(h, c.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'IMPACT_BLOCKING', details: { blocking: ['Open appeals would breach their deadline'] } });
  });
});

describe('submit, schedule and apply', () => {
  it('a change effective now applies at once: new version, event, value in force', async () => {
    const c = (await draft(h, { items: [{ key: 'support.phone', value: '1-800-555-0199' }], effectiveAt: inMinutes(h, 0), reason: 'New line' })).json();
    const res = await submit(h, c.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'applied', approval: { required: false } });
    expect(await h.api.get('support.phone')).toBe('1-800-555-0199');
    expect(h.events.map((e) => e.name)).toEqual(['settings.change.scheduled', 'settings.setting.changed']);
    expect(h.events[1]!.payload).toMatchObject({ key: 'support.phone', module: 'settings', from: '1-800-555-0136', to: '1-800-555-0199', changeId: c.id });
    expect(h.audits.map((a) => a.action)).toEqual(['settings.change.submit', 'settings.change.apply']);
    expect(h.audits[0]).toMatchObject({ module: 'settings', category: 'settings', target: { type: 'setting_change', id: c.id, ref: c.ref } });

    const detail = (await get('/values/support.phone')).json();
    expect(detail.current).toMatchObject({ value: '1-800-555-0199', changeId: c.id, reason: 'New line' });
    expect(detail.recent.length).toBeGreaterThanOrEqual(1);
    const store = await h.api.storeInfo();
    expect(store.support.phone).toBe('1-800-555-0199');
  });

  it('a future change is scheduled, counts from effectiveAt, and the job applies it', async () => {
    const at = inMinutes(h, 3);
    const c = (await draft(h, { items: [{ key: 'support.firstResponseBusinessHours', value: 6 }], effectiveAt: at })).json();
    const res = await submit(h, c.id);
    expect(res.json()).toMatchObject({ status: 'scheduled', submittedAt: expect.any(String) });
    expect(h.events[0]).toMatchObject({ name: 'settings.change.scheduled', payload: { changeId: c.id, keys: ['support.firstResponseBusinessHours'], sellerVisible: false, summary: 'First response business hours changes from 4 business hours to 6 business hours' } });
    expect(await h.api.get('support.firstResponseBusinessHours')).toBe(4);
    expect(await h.api.get('support.firstResponseBusinessHours', inMinutes(h, 10))).toBe(6);
    expect((await get('/values/support.firstResponseBusinessHours')).json().scheduled).toEqual([expect.objectContaining({ value: 6, changeId: c.id })]);
    expect((await get('/changes')).json().items.map((x: any) => x.id)).toContain(c.id);

    h.clock.advance(4 * 60_000);
    expect(await h.api.get('support.firstResponseBusinessHours')).toBe(6); // in force from effectiveAt, before the job runs
    await h.app.kernel.jobs.runNow('settings.apply-due-changes');
    await h.app.kernel.events.drain();
    const applied = (await get(`/changes/${c.id}`)).json();
    expect(applied).toMatchObject({ status: 'applied', appliedAt: expect.any(String) });
    expect(applied.timeline.at(-1).label).toBe('Applied');
    expect(h.events.find((e) => e.name === 'settings.setting.changed')!.payload).toMatchObject({ key: 'support.firstResponseBusinessHours', version: 1, from: 4, to: 6, effectiveFrom: at });
    const history = (await get('/values/support.firstResponseBusinessHours/history')).json();
    expect(history.items[0]).toMatchObject({ version: 1, value: 6, effectiveFrom: at });
    // a past instant still reads the old value
    expect(await h.api.get('support.firstResponseBusinessHours', new Date(Date.parse(at) - 60_000).toISOString())).toBe(4);
  });

  it('refuses an effective date inside the minimum notice', async () => {
    const c = (await draft(h, { items: [{ key: 'orders.dueSoonMinutes', value: 90 }], effectiveAt: inDays(h, 3) })).json();
    expect(c.impact.blocking[0]).toMatch(/14 days' notice/);
    const res = await submit(h, c.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'LEAD_TIME_TOO_SHORT', details: { earliest: expect.any(String), key: 'orders.dueSoonMinutes' } });
  });

  it('refuses a second open change of the same setting', async () => {
    const first = (await draft(h, { items: [{ key: 'support.reopenWindowDays', value: 45 }], effectiveAt: inDays(h, 5) })).json();
    const second = (await draft(h, { items: [{ key: 'support.reopenWindowDays', value: 60 }], effectiveAt: inDays(h, 6) })).json();
    expect((await submit(h, first.id)).json().status).toBe('scheduled');
    const res = await submit(h, second.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'CHANGE_CONFLICT', details: { changeRef: first.ref } });
    // cancelling the first frees the key
    const cancelled = await h.app.inject({ method: 'POST', url: `/api/admin/settings/changes/${first.id}/cancel`, headers: staff(), payload: { reason: 'Combined into one change' } });
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', cancelReason: 'Combined into one change' });
    expect((await submit(h, second.id)).json().status).toBe('scheduled');
  });

  it('announces seller-visible changes and lists them for sellers', async () => {
    const c = (await draft(h, { items: [{ key: 'catalog.maxImagesPerProduct', value: 15 }], effectiveAt: inDays(h, 15) })).json();
    expect(c.impact.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'sellers' })]));
    await submit(h, c.id);
    expect(h.events[0]).toMatchObject({ name: 'settings.change.scheduled', payload: { sellerVisible: true } });
    const { auth, callers } = await import('../../../testing/app.js');
    const res = await h.app.inject({ method: 'GET', url: '/api/seller/settings/upcoming-changes', headers: auth(callers.seller()) });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ ref: c.ref, module: 'catalog', title: 'Max images per product changes from 12 to 15', postedAt: expect.any(String) })]));
  });
});

describe('approval', () => {
  it('sends a Business Owner setting to access and schedules it when approved', async () => {
    const c = (await draft(h, { items: [{ key: 'checkout.guestCheckoutEnabled', value: false }], effectiveAt: inMinutes(h, 2), reason: 'Fraud wave' })).json();
    expect(c.impact).toMatchObject({ needsApproval: true, approvalRule: 'business_owner', approvers: ['Business Owner'] });
    const res = await submit(h, c.id);
    expect(res.statusCode, res.body).toBe(200);
    const pending = res.json();
    expect(pending).toMatchObject({ status: 'pending_approval', approval: { required: true, approvalRequestId: h.access.lastRequestId } });
    // a Business Owner rule goes to the Business Owner only (never another Platform Administrator)
    expect(h.access.checks.at(-1)).toBe('settings.changes.apply-owner');
    expect(h.access.requests.at(-1)).toMatchObject({ action: 'settings.changes.apply-owner', target: { type: 'setting_change', id: c.id, ref: c.ref }, reason: 'Fraud wave' });
    expect(h.events.map((e) => e.name)).toEqual(['settings.change.submitted']);
    expect(await h.api.get('checkout.guestCheckoutEnabled')).toBe(true);

    h.clock.advance(3 * 60_000);
    decided(h, c, 'approved');
    await h.app.kernel.events.drain();
    const after = (await get(`/changes/${c.id}`)).json();
    // effectiveAt passed while pending: applied at once after approval
    expect(after.status).toBe('applied');
    expect(after.timeline.map((t: any) => t.label)).toEqual(expect.arrayContaining([expect.stringMatching(/^Approved/), 'Applied']));
    expect(await h.api.get('checkout.guestCheckoutEnabled')).toBe(false);
    const version = (await get('/values/checkout.guestCheckoutEnabled')).json().current;
    expect(version.approvedBy).toMatchObject({ kind: 'staff' });
    // the same decision again changes nothing
    decided(h, c, 'approved');
    await h.app.kernel.events.drain();
    expect((await get(`/changes/${c.id}`)).json().status).toBe('applied');
  });

  it('the Business Owner (allowed by access) schedules directly', async () => {
    h.access.decision = 'allowed';
    const c = (await draft(h, { items: [{ key: 'checkout.offerAccountAfterGuestPurchase', value: false }, { key: 'market.locale', value: 'en-GB' }], effectiveAt: inDays(h, 1) })).json();
    expect(c.impact.approvalRule).toBe('second_reviewer'); // strictest of none and second_reviewer
    const res = await submit(h, c.id);
    // a second reviewer is always someone else, even when the caller holds the authority
    expect(res.json().status).toBe('pending_approval');
    expect(h.access.requests.at(-1)).toMatchObject({ action: 'settings.changes.apply' });

    const bo = (await draft(h, { items: [{ key: 'market.serviceRegion', value: { code: 'US-49', label: 'United States, 48 states and Alaska', includedRegions: ['AK', 'CA'] } }], effectiveAt: inDays(h, 31) })).json();
    expect(bo.impact.approvalRule).toBe('business_owner');
    const direct = await submit(h, bo.id);
    expect(direct.json()).toMatchObject({ status: 'scheduled', approval: { required: false, reason: 'You hold this authority' } });
  });

  it('a rejected or expired approval rejects the change and frees the key', async () => {
    const c = (await draft(h, { items: [{ key: 'identity.lockoutMinutes', value: 30 }], effectiveAt: inDays(h, 1) })).json();
    expect(c.impact.approvalRule).toBe('second_reviewer');
    await submit(h, c.id);
    h.events.length = 0;
    decided(h, c, 'rejected');
    await h.app.kernel.events.drain();
    expect((await get(`/changes/${c.id}`)).json()).toMatchObject({ status: 'rejected', cancelReason: 'Not now' });
    expect(h.events).toEqual([{ name: 'settings.change.cancelled', payload: expect.objectContaining({ changeId: c.id, outcome: 'rejected', reason: 'Not now' }) }]);
    const again = (await draft(h, { items: [{ key: 'identity.lockoutMinutes', value: 20 }], effectiveAt: inDays(h, 1) })).json();
    expect((await submit(h, again.id)).json().status).toBe('pending_approval');
    decided(h, again, 'expired');
    await h.app.kernel.events.drain();
    expect((await get(`/changes/${again.id}`)).json().status).toBe('rejected');
  });

  it('a returned request goes back to draft with the comment; cancelling a pending change withdraws its request', async () => {
    const c = (await draft(h, { items: [{ key: 'identity.maxFailedSignIns', value: 4 }], effectiveAt: inDays(h, 1) })).json();
    await submit(h, c.id);
    const requestId = h.access.lastRequestId!;
    h.app.kernel.events.publish('access', 'access.approval.returned', {
      requestId,
      actionKey: 'settings.changes.apply',
      module: 'settings',
      target: { type: 'setting_change', id: c.id },
      by: { kind: 'staff', id: c.createdBy.id ?? 'x', name: 'Reviewer' },
      comment: 'Explain the support impact',
      requestedById: 'someone',
    });
    await h.app.kernel.events.drain();
    const back = (await get(`/changes/${c.id}`)).json();
    expect(back).toMatchObject({ status: 'draft', approval: null });
    expect(back.timeline.at(-1)).toMatchObject({ label: 'Returned for changes', detail: 'Explain the support impact' });

    await submit(h, c.id);
    const second = h.access.lastRequestId!;
    const res = await h.app.inject({ method: 'POST', url: `/api/admin/settings/changes/${c.id}/cancel`, headers: staff(), payload: { reason: 'Not needed' } });
    expect(res.json().status).toBe('cancelled');
    expect(h.access.cancelled.at(-1)).toEqual({ requestId: second, reason: 'Not needed' });
    expect(h.audits.at(-1)).toMatchObject({ action: 'settings.change.cancel', reason: 'Not needed' });
    // and an approval decided later for it is ignored
    decided(h, c, 'cancelled', second);
    await h.app.kernel.events.drain();
    expect((await get(`/changes/${c.id}`)).json().status).toBe('cancelled');
  });

  it('access refusing the action answers 403', async () => {
    h.access.decision = 'denied';
    const c = (await draft(h, { items: [{ key: 'identity.codeResendSeconds', value: 90 }], effectiveAt: inDays(h, 1) })).json();
    const res = await submit(h, c.id);
    expect(res.statusCode).toBe(403);
    expect((await get(`/changes/${c.id}`)).json().status).toBe('draft');
  });
});

describe('rules a module declares for its settings', () => {
  it('a declared Business Owner setting (finance.payoutSchedule) needs 30 days notice and Business Owner approval', async () => {
    const def = (await get('/values/finance.payoutSchedule')).json().definition;
    expect(def).toMatchObject({ valueType: 'string', approval: 'business_owner', sellerVisible: true, minLeadDays: 30 });

    const early = (await draft(h, { items: [{ key: 'finance.payoutSchedule', value: 'weekly:THU' }], effectiveAt: inDays(h, 20) })).json();
    expect(early.impact.blocking[0]).toMatch(/30 days' notice/);
    const refused = await submit(h, early.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'LEAD_TIME_TOO_SHORT', details: { key: 'finance.payoutSchedule' } });
    await h.app.inject({ method: 'POST', url: `/api/admin/settings/changes/${early.id}/cancel`, headers: staff(), payload: { reason: 'Too early' } });

    const c = (await draft(h, { items: [{ key: 'finance.payoutSchedule', value: 'weekly:THU' }], effectiveAt: inDays(h, 31) })).json();
    expect(c.impact).toMatchObject({ blocking: [], needsApproval: true, approvalRule: 'business_owner', approvers: ['Business Owner'] });
    const res = await submit(h, c.id);
    expect(res.json()).toMatchObject({ status: 'pending_approval', approval: { required: true } });
    expect(h.access.requests.at(-1)).toMatchObject({ action: 'settings.changes.apply-owner', details: { approvalRule: 'business_owner' } });
    await h.app.inject({ method: 'POST', url: `/api/admin/settings/changes/${c.id}/cancel`, headers: staff(), payload: { reason: 'Test done' } });
  });

  it('a read-only setting cannot be changed', async () => {
    expect((await get('/values/orders.orderRefPrefix')).json().definition).toMatchObject({ editable: false, sellerVisible: false });
    const res = await draft(h, { items: [{ key: 'orders.orderRefPrefix', value: 'MX' }], effectiveAt: inDays(h, 1) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'SETTING_NOT_EDITABLE', details: { key: 'orders.orderRefPrefix' } });
  });

  it('refuses a value outside the declared bounds or choices', async () => {
    const over = await draft(h, { items: [{ key: 'support.maxAttachments', value: 21 }], effectiveAt: inDays(h, 1) });
    expect(over.json().error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'items.0.value', message: 'Must be at most 20' }] } });
    const under = await draft(h, { items: [{ key: 'support.appealWindowDays', value: 0 }], effectiveAt: inDays(h, 1) });
    expect(under.json().error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ message: 'Must be at least 1' }] } });
    const choice = await draft(h, { items: [{ key: 'finance.statementPeriod', value: 'daily' }], effectiveAt: inDays(h, 30) });
    expect(choice.json().error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ message: 'Must be one of weekly, monthly' }] } });
    const ok = await draft(h, { items: [{ key: 'support.maxAttachments', value: 20 }], effectiveAt: inDays(h, 1) });
    expect(ok.statusCode, ok.body).toBe(201);
  });
});

describe('cancel and lists', () => {
  it('cancels drafts and scheduled changes; never applied or cancelled ones', async () => {
    const c = (await draft(h, { items: [{ key: 'support.lateItemRefundAfterDays', value: 10 }], effectiveAt: inDays(h, 2) })).json();
    const cancel = (id: string) => h.app.inject({ method: 'POST', url: `/api/admin/settings/changes/${id}/cancel`, headers: staff(), payload: { reason: 'No longer needed' } });
    const first = await cancel(c.id);
    expect(first.json()).toMatchObject({ status: 'cancelled' });
    await h.app.kernel.events.drain();
    expect(h.events.at(-1)).toMatchObject({ name: 'settings.change.cancelled', payload: { outcome: 'cancelled', reason: 'No longer needed' } });
    const again = await cancel(c.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ILLEGAL_TRANSITION');
    expect((await submit(h, c.id)).statusCode).toBe(409);
    expect((await cancel('0190a0a0-0000-7000-8000-000000000000')).statusCode).toBe(404);
  });

  it('lists scheduled changes by default and filters by status, key and section', async () => {
    const d = (await draft(h, { items: [{ key: 'support.sellerReplyBusinessDays', value: 3 }], effectiveAt: inDays(h, 2) })).json();
    const scheduled = (await get('/changes')).json().items as any[];
    expect(scheduled.every((x) => x.status === 'scheduled')).toBe(true);
    expect((await get('/changes?status=draft')).json().items.map((x: any) => x.id)).toContain(d.id);
    expect((await get('/changes?status=draft&key=support.sellerReplyBusinessDays')).json().items.map((x: any) => x.id)).toEqual([d.id]);
    expect((await get('/changes?status=draft&section=support')).json().items.map((x: any) => x.id)).toContain(d.id);
    expect((await get('/changes?status=draft&section=apps')).json().items.map((x: any) => x.id)).not.toContain(d.id);
    const paged = (await get('/changes?status=draft&limit=1')).json();
    expect(paged.items).toHaveLength(1);
    expect(paged.nextCursor).toEqual(expect.any(String));
  });
});
