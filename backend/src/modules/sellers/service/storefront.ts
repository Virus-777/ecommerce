/**
 * Storefront: the store profile editor, public claims and brand requests, change requests (store name,
 * tagline, claims, legal name, ownership, address) with their staff review, featured collections and the public storefront.
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { ChangeRequest, CollectionInput, ContactOptions, FeaturedCollection, PublicClaim, SellerSummary, StoreProfile, StoreProfileInput, Storefront } from '../../../spec/sellers.js';
import { isWholeAccount, locationOf, normalizeScope, sameStoreName, type StoredVerification } from '../domain/rules.js';
import { changeRequestMachine, publicClaimMachine } from '../domain/state-machines.js';
import * as map from '../mappers.js';
import type { ChangeRequestRec, ClaimRec, ProfileRec, SellerRec } from '../ports.js';
import type { SellersRepository } from '../repository.js';
import { invalid, notFound, Part, type By } from './core.js';

const TAGLINE_MAX = 80;
const DEFAULT_CONTACT: ContactOptions = { orderMessages: true, productQuestions: true, showPhone: false, phone: null, replyTarget: 'within_24h' };
const PUBLIC = ['approved', 'restricted', 'suspended'];

const IMPACT: Record<string, string> = {
  store_name: 'Your current store name stays on the storefront until the new name is approved.',
  legal_name: 'Selling continues. Payouts keep going to your verified account; it may need to match the new legal name.',
  ownership: 'Selling continues. Identity checks run again for new owners and the Verified label may be reviewed.',
  business_address: 'Selling continues. Your return address is not changed by this request (manage it in Returns).',
  public_claim: 'The claim shows on your storefront only after staff approve it.',
  tagline: 'Your current tagline stays on the storefront until the new one is approved.',
  brand_request: 'You can list products of this brand once Marketly adds it.',
};

export class StorefrontPart extends Part {
  /* ---------------------------------------------------------------- profile */

  async profileOf(sellerId: string, repo: SellersRepository = this.repo): Promise<ProfileRec> {
    return (
      (await repo.getProfile(sellerId)) ?? {
        seller_id: sellerId,
        logo_media_id: null,
        banner_media_id: null,
        introduction: null,
        location: null,
        contact_options: DEFAULT_CONTACT as never,
        warranty: null,
        updated_at: this.now(),
        tagline: null,
      }
    );
  }

  async createProfile(tx: SellersRepository, s: SellerRec) {
    if (await tx.getProfile(s.id)) return;
    await tx.upsertProfile({ ...(await this.profileOf(s.id, tx)), location: locationOf(s.business_address as unknown as common.Address) });
  }

  private contactOf(p: ProfileRec): ContactOptions {
    return { ...DEFAULT_CONTACT, ...((p.contact_options ?? {}) as Partial<ContactOptions>) };
  }

  async storeProfile(s: SellerRec): Promise<StoreProfile> {
    const p = await this.profileOf(s.id);
    const collections = await this.repo.find('featured_collections', { seller_id: s.id }, { orderBy: [['position', 'asc']] });
    const claims = (await this.repo.find('public_claims', { seller_id: s.id }, { orderBy: [['submitted_at', 'desc']] })).map((c) => this.liveClaim(c));
    const pending = await this.repo.find('change_requests', { seller_id: s.id, state: 'pending' }, { orderBy: [['submitted_at', 'desc']] });
    const refs = await this.core.mediaRefs([p.logo_media_id, p.banner_media_id, ...collections.map((c) => c.image_media_id), ...claims.flatMap((c) => map.strings(c.evidence_media_ids)), ...pending.flatMap((c) => map.strings(c.evidence_media_ids))]);
    const returns = await this.core.optional('returns', 'returns', null, async (r) => (await r.sellerReturnTermsFor([s.id]))[s.id]);
    return {
      sellerId: s.id,
      slug: s.slug,
      storeName: s.store_name,
      logo: refs(p.logo_media_id),
      banner: refs(p.banner_media_id),
      introduction: p.introduction,
      location: p.location,
      contactOptions: this.contactOf(p),
      warranty: p.warranty,
      categories: await this.categoriesOf(s),
      collections: collections.map((c) => map.collection(c, refs)),
      claims: claims.map((c) => map.claim(c, refs)),
      pendingChanges: pending.map((c) => map.changeRequest(c, { storeName: s.store_name, refs })),
      verification: map.verificationLabel(s),
      returnTermsSummary: returns?.summary ?? null,
      updatedAt: map.isoReq(p.updated_at),
      tagline: p.tagline,
    };
  }

  /** Categories from the application, paused where an active restriction stops new offers or sales */
  private async categoriesOf(s: SellerRec) {
    const app = await this.core.applicationOf(s);
    const ids = ((app?.business ?? {}) as { categoryIds?: string[] }).categoryIds ?? [];
    if (!ids.length) return [];
    const names = new Map<string, string>();
    const tree = await this.core.optional('catalog', 'categories', null, (c) => c.listCategories({ includeHidden: true }));
    const walk = (list: { id: string; name: string; children?: unknown[] }[]) => list.forEach((c) => (names.set(c.id, c.name), walk((c.children ?? []) as never)));
    walk((tree ?? []) as never);
    const restrictions = await this.parts.enforcement.activeRestrictions(s.id);
    return ids.map((id) => {
      const r = restrictions.find((x) => {
        const scope = normalizeScope(x.scope as never);
        const acts = map.strings(x.affected_activities);
        return acts.some((a) => ['new_offers', 'new_listings', 'sales'].includes(a)) && (isWholeAccount(scope) || scope.categoryIds?.includes(id));
      });
      return { categoryId: id, name: names.get(id) ?? 'Category', state: r || s.status === 'suspended' ? 'paused' : 'active', ...(r ? { reason: r.title } : s.status === 'suspended' ? { reason: 'Account suspended' } : {}) };
    });
  }

  async getStoreProfile(sellerId: string) {
    return this.storeProfile(await this.core.seller(sellerId));
  }

  async updateStoreProfile(sellerId: string, input: StoreProfileInput, by: By): Promise<StoreProfile> {
    const s = await this.core.seller(sellerId);
    const max = await this.core.setting('introMaxChars');
    const issues: { path: string; message: string }[] = [];
    if (input.introduction && input.introduction.length > max) issues.push({ path: 'introduction', message: `At most ${max} characters` });
    if (input.contactOptions?.showPhone && !input.contactOptions.phone?.trim()) issues.push({ path: 'contactOptions.phone', message: 'Add the phone number to show' });
    if (input.storeName !== undefined && input.storeName !== null && !input.storeName.trim()) issues.push({ path: 'storeName', message: 'The store name cannot be empty' });
    if (typeof input.tagline === 'string' && input.tagline.trim().length > TAGLINE_MAX) issues.push({ path: 'tagline', message: `At most ${TAGLINE_MAX} characters` });
    if (issues.length) throw invalid(issues);

    let nameRequest: ChangeRequestRec | undefined;
    if (input.storeName && !sameStoreName(input.storeName, s.store_name)) {
      const taken = (await this.repo.sellersByStoreName(input.storeName)).some((x) => x.id !== s.id);
      if (taken) throw new AppError('STORE_NAME_TAKEN', 'Another seller uses this store name');
      for (const old of await this.repo.find('change_requests', { seller_id: s.id, kind: 'store_name', state: 'pending' })) {
        await this.repo.update('change_requests', old.id, { state: this.core.step(changeRequestMachine, old.state, 'withdraw') });
      }
      nameRequest = await this.newChangeRequest(s, 'store_name', { storeName: s.store_name }, { storeName: input.storeName.trim() }, [], by);
    }

    // a new tagline is reviewed like claims (the current one stays live); removing it needs no review
    let taglineRequest: ChangeRequestRec | undefined;
    const current = await this.profileOf(s.id);
    const tagline = typeof input.tagline === 'string' ? input.tagline.trim() : undefined;
    if (tagline !== undefined && tagline !== (current.tagline ?? '')) {
      for (const old of await this.repo.find('change_requests', { seller_id: s.id, kind: 'tagline', state: 'pending' })) {
        await this.repo.update('change_requests', old.id, { state: this.core.step(changeRequestMachine, old.state, 'withdraw') });
        await this.core.resolveWork(`change_request:${old.id}`, 'Replaced by a newer tagline', by.actor);
      }
      if (tagline) taglineRequest = await this.newChangeRequest(s, 'tagline', { tagline: current.tagline }, { tagline }, [], by);
    }

    const before = await this.profileOf(s.id);
    const media = this.ctx.use('media');
    const owner = { kind: 'seller' as const, id: s.id };
    const fields: string[] = [];
    const next: ProfileRec = { ...before, contact_options: this.contactOf(before) as never };
    const swap = async (field: 'logo_media_id' | 'banner_media_id', id: string | null | undefined, kind: 'store_logo' | 'store_banner') => {
      if (id === undefined || id === before[field]) return;
      if (id) await media.attach(id, { module: 'sellers', kind, refId: s.id, refLabel: s.store_name }, owner);
      if (before[field]) await media.detach(before[field]!, { module: 'sellers', kind, refId: s.id });
      next[field] = id;
      fields.push(kind === 'store_logo' ? 'logo' : 'banner');
    };
    await swap('logo_media_id', input.logoId, 'store_logo');
    await swap('banner_media_id', input.bannerId, 'store_banner');
    const set = <K extends 'introduction' | 'location' | 'warranty'>(k: K, v: string | null | undefined) => {
      if (v === undefined) return;
      const val = v?.trim() || null;
      if (val !== before[k]) {
        next[k] = val;
        fields.push(k);
      }
    };
    set('introduction', input.introduction);
    set('location', input.location);
    set('warranty', input.warranty);
    if (input.contactOptions) {
      next.contact_options = { ...input.contactOptions, orderMessages: true, phone: input.contactOptions.phone?.trim() || null } as never;
      fields.push('contactOptions');
    }
    if (tagline === '' && before.tagline) {
      next.tagline = null;
      fields.push('tagline');
    }
    if (fields.length) {
      next.updated_at = this.now();
      await this.repo.upsertProfile(next);
      this.core.publish('sellers.storefront.updated', { sellerId: s.id, fields }, by);
    }
    if (nameRequest) this.core.publish('sellers.change_request.submitted', { changeRequestId: nameRequest.id, sellerId: s.id, kind: 'store_name' }, by);
    if (taglineRequest) this.core.publish('sellers.change_request.submitted', { changeRequestId: taglineRequest.id, sellerId: s.id, kind: 'tagline' }, by);
    return this.storeProfile(s);
  }

  /* ---------------------------------------------------------------- change requests */

  private async newChangeRequest(s: SellerRec, kind: ChangeRequest['kind'], current: unknown, proposed: unknown, evidence: string[], by: By, repo: SellersRepository = this.repo) {
    return repo.insert('change_requests', {
      id: newId(),
      seller_id: s.id,
      kind,
      current: (current ?? null) as never,
      proposed: proposed as never,
      evidence_media_ids: evidence as never,
      state: changeRequestMachine.initial,
      decision_reason: null,
      impact: IMPACT[kind] ?? null,
      submitted_by: map.actorText(by.actor),
      submitted_at: this.now(),
      decided_by: null,
      decided_at: null,
    });
  }

  private async view(rows: ChangeRequestRec[]): Promise<ChangeRequest[]> {
    if (!rows.length) return [];
    const sellers = new Map((await this.repo.getMany('sellers', rows.map((r) => r.seller_id))).map((s) => [s.id, s]));
    const refs = await this.core.mediaRefs(rows.flatMap((r) => map.strings(r.evidence_media_ids)));
    return rows.map((r) => map.changeRequest(r, { storeName: sellers.get(r.seller_id)?.store_name ?? '', refs }));
  }

  async requestBusinessChange(sellerId: string, body: { kind: 'legal_name' | 'ownership' | 'business_address'; proposed: unknown; evidenceIds: string[] }, by: By): Promise<ChangeRequest> {
    const s = await this.core.seller(sellerId);
    const p = (body.proposed ?? {}) as Record<string, any>;
    const issues: { path: string; message: string }[] = [];
    let proposed: unknown;
    let current: unknown;
    if (body.kind === 'legal_name') {
      if (typeof p.legalName !== 'string' || !p.legalName.trim()) issues.push({ path: 'proposed.legalName', message: 'Enter the new legal name' });
      proposed = { legalName: String(p.legalName ?? '').trim() };
      current = { legalName: s.legal_name };
    } else if (body.kind === 'business_address') {
      const a = p.address ?? {};
      for (const f of ['line1', 'city', 'region', 'postalCode', 'country']) if (typeof a[f] !== 'string' || !a[f].trim()) issues.push({ path: `proposed.address.${f}`, message: 'Required' });
      proposed = { address: { name: a.name ?? s.legal_name, line1: a.line1, line2: a.line2 ?? null, city: a.city, region: a.region, postalCode: a.postalCode, country: a.country ?? 'US' } };
      current = { address: s.business_address };
    } else {
      const owners = Array.isArray(p.owners) ? p.owners : [];
      if (!owners.length) issues.push({ path: 'proposed.owners', message: 'List the owners' });
      if (owners.filter((o: any) => o?.isPrimary).length !== 1) issues.push({ path: 'proposed.owners', message: 'Mark exactly one primary owner' });
      if (owners.some((o: any) => typeof o?.name !== 'string' || !o.name.trim() || typeof o.ownershipPct !== 'number' || o.ownershipPct <= 0)) issues.push({ path: 'proposed.owners', message: 'Each owner needs a name and an ownership percentage' });
      if (owners.reduce((t: number, o: any) => t + (Number(o?.ownershipPct) || 0), 0) > 100) issues.push({ path: 'proposed.owners', message: 'Ownership cannot add up to more than 100%' });
      proposed = { owners: owners.map((o: any) => ({ name: String(o.name ?? '').trim(), ownershipPct: Number(o.ownershipPct), isPrimary: Boolean(o.isPrimary) })) };
      const v = ((await this.core.applicationOf(s))?.verification ?? {}) as unknown as StoredVerification;
      current = { owners: (v.owners ?? []).map((o) => ({ name: o.name, ownershipPct: o.ownershipPct, isPrimary: o.isPrimary })) };
    }
    if (!body.evidenceIds?.length) issues.push({ path: 'evidenceIds', message: 'Add a document that shows the change' });
    if (issues.length) throw invalid(issues);
    const row = await this.newChangeRequest(s, body.kind, current, proposed, [...new Set(body.evidenceIds)], by);
    await this.parts.enforcement.attachEvidence(body.evidenceIds, { kind: 'seller', id: s.id }, row.id, `Change request ${body.kind}`);
    await this.core.timeline(this.repo, s.id, { kind: 'change_requested', title: `Change requested: ${body.kind.replace(/_/g, ' ')}`, actor: by.actor });
    this.core.publish('sellers.change_request.submitted', { changeRequestId: row.id, sellerId: s.id, kind: body.kind }, by);
    await this.core.audit(
      { action: 'sellers.business.change_request', actionLabel: 'Requested a business change', category: 'other', target: { type: 'change_request', id: row.id, label: `${s.store_name} · ${body.kind}`, sellerId: s.id, screen: 'seller/business' }, before: current, after: proposed, visibleToSeller: true },
      by,
    );
    return (await this.view([row]))[0]!;
  }

  async listOwnChangeRequests(sellerId: string, state: ChangeRequest['state'] | undefined, page: PageRequest): Promise<common.Page<ChangeRequest>> {
    await this.core.seller(sellerId);
    const p = await this.repo.page('change_requests', { seller_id: sellerId, ...(state ? { state } : {}) }, page, { column: 'submitted_at', direction: 'desc' });
    return { ...p, items: await this.view(p.items) };
  }

  async withdrawChangeRequest(sellerId: string, id: string, by: By): Promise<ChangeRequest> {
    const c = isUuid(id) ? await this.repo.get('change_requests', id) : undefined;
    if (!c || c.seller_id !== sellerId) throw notFound('Change request');
    const after = await this.repo.update('change_requests', c.id, { state: this.core.step(changeRequestMachine, c.state, 'withdraw') });
    if (c.kind === 'public_claim') {
      const claimId = (c.proposed as { claimId?: string })?.claimId;
      const claim = claimId ? await this.repo.get('public_claims', claimId) : undefined;
      if (claim?.state === 'pending') await this.repo.update('public_claims', claim.id, { state: this.core.step(publicClaimMachine, claim.state, 'withdraw') });
    }
    await this.core.resolveWork(`change_request:${c.id}`, 'Withdrawn by the seller', by.actor);
    return (await this.view([after]))[0]!;
  }

  async listChangeRequestsAdmin(f: { kind?: ChangeRequest['kind']; state?: ChangeRequest['state'] }, page: PageRequest): Promise<common.Page<ChangeRequest>> {
    const p = await this.repo.page('change_requests', { ...(f.kind ? { kind: f.kind } : {}), state: f.state ?? 'pending' }, page, { column: 'submitted_at', direction: 'asc' });
    return { ...p, items: await this.view(p.items) };
  }

  /** Approve or reject a change request; a public claim's id is accepted too */
  async decideChangeRequest(id: string, body: { approve: boolean; reason: string; claimExpiresAt?: string | null }, by: By): Promise<ChangeRequest> {
    if (!body.reason?.trim()) throw invalid([{ path: 'reason', message: 'Give the reason the seller will read' }]);
    if (!isUuid(id)) throw notFound('Change request');
    let c = await this.repo.get('change_requests', id);
    if (!c) {
      const claim = await this.repo.get('public_claims', id);
      if (claim) c = (await this.repo.find('change_requests', { seller_id: claim.seller_id, kind: 'public_claim' })).find((x) => (x.proposed as { claimId?: string })?.claimId === claim.id);
    }
    if (!c) throw notFound('Change request');
    const s = await this.core.seller(c.seller_id);
    const now = this.now();
    const state = this.core.step(changeRequestMachine, c.state, body.approve ? 'approve' : 'reject');
    const proposed = (c.proposed ?? {}) as Record<string, any>;
    let storefrontFields: string[] = [];
    const after = await this.repo.transaction(async (tx) => {
      const row = await tx.update('change_requests', c!.id, { state, decision_reason: body.reason.trim(), decided_by: map.actorText(by.actor), decided_at: now });
      if (c!.kind === 'public_claim' && proposed.claimId) {
        const claim = await tx.get('public_claims', proposed.claimId, { forUpdate: true });
        if (claim?.state === 'pending') {
          await tx.update('public_claims', claim.id, {
            state: this.core.step(publicClaimMachine, claim.state, body.approve ? 'approve' : 'reject'),
            decision_reason: body.reason.trim(),
            decided_by: map.actorText(by.actor),
            decided_at: now,
            expires_at: body.approve && body.claimExpiresAt ? new Date(body.claimExpiresAt) : null,
          });
          if (body.approve) storefrontFields = ['claims'];
        }
      }
      if (body.approve) {
        if (c!.kind === 'store_name' && proposed.storeName) {
          await tx.update('sellers', s.id, { store_name: String(proposed.storeName), updated_at: now });
          storefrontFields = ['storeName'];
        }
        if (c!.kind === 'tagline' && typeof proposed.tagline === 'string') {
          const profile = (await tx.getProfile(s.id)) ?? (await this.profileOf(s.id, tx));
          await tx.upsertProfile({ ...profile, tagline: proposed.tagline, updated_at: now });
          storefrontFields = ['tagline'];
        }
        if (c!.kind === 'legal_name' && proposed.legalName) await tx.update('sellers', s.id, { legal_name: String(proposed.legalName), updated_at: now });
        if (c!.kind === 'business_address' && proposed.address) await tx.update('sellers', s.id, { business_address: proposed.address, updated_at: now });
        if (c!.kind === 'ownership' && Array.isArray(proposed.owners)) await this.applyOwnership(tx, s, proposed.owners);
      }
      await this.core.timeline(tx, s.id, { kind: 'change_decided', title: `${c!.kind.replace(/_/g, ' ')} change ${body.approve ? 'approved' : 'rejected'}`, detail: body.reason.trim(), actor: by.actor });
      return row;
    });
    this.core.publish('sellers.change_request.decided', { changeRequestId: c.id, sellerId: s.id, kind: c.kind, approved: body.approve, brandRequest: c.kind === 'brand_request' && body.approve ? proposed : null }, by);
    if (storefrontFields.length) this.core.publish('sellers.storefront.updated', { sellerId: s.id, fields: storefrontFields }, by);
    await this.core.audit(
      {
        action: 'sellers.change_request.decide',
        actionLabel: body.approve ? 'Approved a seller change request' : 'Rejected a seller change request',
        category: 'other',
        target: { type: 'change_request', id: c.id, label: `${s.store_name} · ${c.kind}`, sellerId: s.id, screen: 'admin/seller-changes' },
        reason: body.reason,
        before: c.current,
        after: body.approve ? c.proposed : null,
        visibleToSeller: true,
      },
      by,
    );
    return (await this.view([after]))[0]!;
  }

  /** Ownership approved: new owner list; identity checks run again for the new owners */
  private async applyOwnership(tx: SellersRepository, s: SellerRec, owners: { name: string; ownershipPct: number; isPrimary: boolean }[]) {
    const app = await this.core.applicationOf(s, tx);
    if (!app) return;
    const v = (app.verification ?? {}) as unknown as StoredVerification;
    const known = new Map((v.owners ?? []).map((o) => [o.name.toLowerCase(), o]));
    const next = owners.map((o) => known.get(o.name.toLowerCase()) ?? { id: newId(), name: o.name, ownershipPct: o.ownershipPct, isPrimary: o.isPrimary, idDocumentIds: [], verificationState: 'pending' as const });
    await tx.update('applications', app.id, { verification: { ...v, owners: next.map((o, i) => ({ ...o, ownershipPct: owners[i]!.ownershipPct, isPrimary: owners[i]!.isPrimary })) } as never });
    if (next.some((o) => o.verificationState !== 'verified')) {
      await tx.insert('verification_checks', { id: newId(), application_id: app.id, seller_id: s.id, kind: 'identity', result: 'pending', summary: 'Ownership changed: checking the new owners', source: 'automated', provider: null, provider_ref: null, accepted_note: null, checked_by: null, checked_at: null });
    }
  }

  /* ---------------------------------------------------------------- claims and brands */

  private liveClaim(c: ClaimRec): ClaimRec {
    return c.state === 'approved' && c.expires_at && c.expires_at.getTime() < this.now().getTime() ? { ...c, state: 'expired' } : c;
  }

  async submitPublicClaim(sellerId: string, body: { kind: PublicClaim['kind']; text: string; brandId?: string | null; evidenceIds: string[] }, by: By): Promise<PublicClaim> {
    const s = await this.core.seller(sellerId);
    const issues: { path: string; message: string }[] = [];
    if (!body.text?.trim()) issues.push({ path: 'text', message: 'Write the claim as it should appear' });
    else if (body.text.trim().length > 120) issues.push({ path: 'text', message: 'At most 120 characters' });
    if (!body.evidenceIds?.length) issues.push({ path: 'evidenceIds', message: 'Claims need evidence, e.g. an authorisation letter' });
    if (body.kind === 'brand_affiliation' && !body.brandId) issues.push({ path: 'brandId', message: 'Choose the brand' });
    if (issues.length) throw invalid(issues);
    const evidence = [...new Set(body.evidenceIds)];
    const claim = await this.repo.insert('public_claims', {
      id: newId(),
      seller_id: s.id,
      kind: body.kind,
      text: body.text.trim(),
      brand_id: body.brandId ?? null,
      evidence_media_ids: evidence as never,
      state: publicClaimMachine.initial,
      decision_reason: null,
      decided_by: null,
      submitted_at: this.now(),
      decided_at: null,
      expires_at: null,
    });
    await this.parts.enforcement.attachEvidence(evidence, { kind: 'seller', id: s.id }, claim.id, `Public claim: ${claim.text}`);
    const cr = await this.newChangeRequest(s, 'public_claim', null, { claimId: claim.id, kind: claim.kind, text: claim.text, brandId: claim.brand_id }, evidence, by);
    this.core.publish('sellers.change_request.submitted', { changeRequestId: cr.id, sellerId: s.id, kind: 'public_claim' }, by);
    return map.claim(claim, await this.core.mediaRefs(evidence));
  }

  async requestBrand(sellerId: string, body: { brandName: string; website?: string | null; relationship: 'brand_owner' | 'authorized_reseller' | 'retailer'; categoryIds?: string[] | null; evidenceIds: string[] }, by: By): Promise<ChangeRequest> {
    const s = await this.core.seller(sellerId);
    const issues: { path: string; message: string }[] = [];
    if (!body.brandName?.trim()) issues.push({ path: 'brandName', message: 'Enter the brand name' });
    if (!body.evidenceIds?.length) issues.push({ path: 'evidenceIds', message: 'Add evidence of your relationship with the brand' });
    if (issues.length) throw invalid(issues);
    const pending = await this.repo.find('change_requests', { seller_id: s.id, kind: 'brand_request', state: 'pending' });
    if (pending.some((p) => sameStoreName(String((p.proposed as { brandName?: string })?.brandName ?? ''), body.brandName))) throw new AppError('CONFLICT', 'You already asked for this brand; it is waiting for review');
    const proposed = { brandName: body.brandName.trim(), website: body.website ?? null, relationship: body.relationship, categoryIds: body.categoryIds ?? [] };
    const evidence = [...new Set(body.evidenceIds)];
    const row = await this.newChangeRequest(s, 'brand_request', null, proposed, evidence, by);
    await this.parts.enforcement.attachEvidence(evidence, { kind: 'seller', id: s.id }, row.id, `Brand request: ${proposed.brandName}`);
    this.core.publish('sellers.change_request.submitted', { changeRequestId: row.id, sellerId: s.id, kind: 'brand_request' }, by);
    return (await this.view([row]))[0]!;
  }

  async withdrawPublicClaim(sellerId: string, id: string, by: By): Promise<PublicClaim> {
    const c = isUuid(id) ? await this.repo.get('public_claims', id) : undefined;
    if (!c || c.seller_id !== sellerId) throw notFound('Claim');
    const wasLive = c.state === 'approved';
    const after = await this.repo.update('public_claims', c.id, { state: this.core.step(publicClaimMachine, this.liveClaim(c).state, 'withdraw') });
    for (const cr of await this.repo.find('change_requests', { seller_id: sellerId, kind: 'public_claim', state: 'pending' })) {
      if ((cr.proposed as { claimId?: string })?.claimId === c.id) await this.repo.update('change_requests', cr.id, { state: this.core.step(changeRequestMachine, cr.state, 'withdraw') });
    }
    if (wasLive) this.core.publish('sellers.storefront.updated', { sellerId, fields: ['claims'] }, by);
    return map.claim(after, await this.core.mediaRefs(map.strings(after.evidence_media_ids)));
  }

  async revokePublicClaim(id: string, body: { reason: string; recordViolation: boolean }, by: By): Promise<PublicClaim> {
    if (!body.reason?.trim()) throw invalid([{ path: 'reason', message: 'Say why the claim is removed' }]);
    const c = isUuid(id) ? await this.repo.get('public_claims', id) : undefined;
    if (!c) throw notFound('Claim');
    const after = await this.repo.update('public_claims', c.id, {
      state: this.core.step(publicClaimMachine, this.liveClaim(c).state, 'revoke'),
      decision_reason: body.reason.trim(),
      decided_by: map.actorText(by.actor),
      decided_at: this.now(),
    });
    if (body.recordViolation) await this.parts.performance.recordViolation(c.seller_id, c.id);
    const s = await this.core.seller(c.seller_id);
    await this.core.timeline(this.repo, s.id, { kind: 'claim_revoked', title: `Claim removed: ${c.text}`, detail: body.reason.trim(), actor: by.actor });
    this.core.publish('sellers.storefront.updated', { sellerId: s.id, fields: ['claims'] }, by);
    await this.core.audit(
      {
        action: 'sellers.claim.revoke',
        actionLabel: 'Removed a public claim',
        category: 'seller_enforcement',
        target: { type: 'public_claim', id: c.id, label: `${s.store_name} · ${c.text}`, sellerId: s.id, screen: 'admin/seller-changes' },
        reason: body.reason,
        before: { state: c.state },
        after: { state: after.state, violationRecorded: body.recordViolation },
        visibleToSeller: true,
      },
      by,
    );
    return map.claim(after, await this.core.mediaRefs(map.strings(after.evidence_media_ids)));
  }

  /** Approved claims past their expiry become expired (daily) */
  async expireClaims() {
    for (const c of await this.repo.find('public_claims', { state: 'approved', expires_at: { op: '<', value: this.now() } }, { limit: 500 })) {
      await this.repo.update('public_claims', c.id, { state: this.core.step(publicClaimMachine, c.state, 'expire') });
      this.core.publish('sellers.storefront.updated', { sellerId: c.seller_id, fields: ['claims'] });
    }
  }

  /* ---------------------------------------------------------------- collections */

  private async checkOffers(sellerId: string, offerIds: string[]) {
    const offers = this.ctx.tryUse('offers');
    if (!offers || !offerIds.length) return;
    const bad: string[] = [];
    for (const id of new Set(offerIds)) if (!(await offers.getOwnOffer(sellerId, id))) bad.push(id);
    if (bad.length) throw invalid(bad.map((id) => ({ path: 'offerIds', message: `${id} is not one of your offers` })));
  }

  private async collectionOf(sellerId: string, id: string) {
    const c = isUuid(id) ? await this.repo.get('featured_collections', id) : undefined;
    if (!c || c.seller_id !== sellerId) throw notFound('Collection');
    return c;
  }

  async createCollection(sellerId: string, input: CollectionInput, by: By): Promise<FeaturedCollection> {
    const s = await this.core.seller(sellerId);
    if (!input.title?.trim()) throw invalid([{ path: 'title', message: 'Give the collection a title' }]);
    const existing = await this.repo.find('featured_collections', { seller_id: s.id });
    if (existing.length >= (await this.core.setting('maxCollections'))) throw new AppError('COLLECTION_LIMIT_REACHED', 'You already have the maximum number of featured collections');
    await this.checkOffers(s.id, input.offerIds);
    const id = newId();
    if (input.imageId) await this.ctx.use('media').attach(input.imageId, { module: 'sellers', kind: 'store_banner', refId: id, refLabel: input.title }, { kind: 'seller', id: s.id });
    const row = await this.repo.insert('featured_collections', {
      id,
      seller_id: s.id,
      title: input.title.trim(),
      image_media_id: input.imageId ?? null,
      offer_ids: [...new Set(input.offerIds)] as never,
      position: existing.reduce((m, c) => Math.max(m, c.position), 0) + 1,
      visible: input.visible ?? true,
      updated_at: this.now(),
    });
    this.core.publish('sellers.storefront.updated', { sellerId: s.id, fields: ['collections'] }, by);
    return map.collection(row, await this.core.mediaRefs([row.image_media_id]));
  }

  async updateCollection(sellerId: string, id: string, input: CollectionInput, by: By): Promise<FeaturedCollection> {
    const c = await this.collectionOf(sellerId, id);
    if (!input.title?.trim()) throw invalid([{ path: 'title', message: 'Give the collection a title' }]);
    await this.checkOffers(sellerId, input.offerIds);
    const media = this.ctx.use('media');
    if (input.imageId !== undefined && input.imageId !== c.image_media_id) {
      if (input.imageId) await media.attach(input.imageId, { module: 'sellers', kind: 'store_banner', refId: c.id, refLabel: input.title }, { kind: 'seller', id: sellerId });
      if (c.image_media_id) await media.detach(c.image_media_id, { module: 'sellers', kind: 'store_banner', refId: c.id });
    }
    const row = await this.repo.update('featured_collections', c.id, {
      title: input.title.trim(),
      ...(input.imageId !== undefined ? { image_media_id: input.imageId ?? null } : {}),
      offer_ids: [...new Set(input.offerIds)] as never,
      ...(input.visible !== undefined && input.visible !== null ? { visible: input.visible } : {}),
      updated_at: this.now(),
    });
    this.core.publish('sellers.storefront.updated', { sellerId, fields: ['collections'] }, by);
    return map.collection(row, await this.core.mediaRefs([row.image_media_id]));
  }

  async deleteCollection(sellerId: string, id: string, by: By) {
    const c = await this.collectionOf(sellerId, id);
    if (c.image_media_id) await this.ctx.use('media').detach(c.image_media_id, { module: 'sellers', kind: 'store_banner', refId: c.id });
    await this.repo.remove('featured_collections', c.id);
    this.core.publish('sellers.storefront.updated', { sellerId, fields: ['collections'] }, by);
  }

  async reorderCollections(sellerId: string, ids: string[], by: By): Promise<FeaturedCollection[]> {
    await this.core.seller(sellerId);
    const rows = await this.repo.find('featured_collections', { seller_id: sellerId });
    const known = new Set(rows.map((r) => r.id));
    if (ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some((i) => !known.has(i))) {
      throw invalid([{ path: 'collectionIds', message: 'Send every collection of your store exactly once' }]);
    }
    for (const [i, id] of ids.entries()) await this.repo.update('featured_collections', id, { position: i + 1, updated_at: this.now() });
    this.core.publish('sellers.storefront.updated', { sellerId, fields: ['collections'] }, by);
    const after = await this.repo.find('featured_collections', { seller_id: sellerId }, { orderBy: [['position', 'asc']] });
    const refs = await this.core.mediaRefs(after.map((c) => c.image_media_id));
    return after.map((c) => map.collection(c, refs));
  }

  /* ---------------------------------------------------------------- public storefront */

  async cards(rows: SellerRec[]): Promise<SellerSummary[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const profiles = new Map<string, ProfileRec>();
    for (const id of ids) profiles.set(id, await this.profileOf(id));
    const refs = await this.core.mediaRefs([...profiles.values()].map((p) => p.logo_media_id));
    const shipping = await this.core.optional('shipping', 'shipping', null, (s) => s.getSellerShippingSummaries(ids));
    const out: SellerSummary[] = [];
    for (const s of rows) {
      const fb = await this.core.optional('reviews', 'rating', null, (r) => r.getSellerFeedbackSummary(s.id));
      const p = profiles.get(s.id)!;
      out.push({
        id: s.id,
        slug: s.slug,
        storeName: s.store_name,
        logo: refs(p.logo_media_id),
        verified: s.verification_state === 'verified',
        location: p.location ?? locationOf(s.business_address as unknown as common.Address),
        positivePct: fb?.positivePct ?? null,
        ratingCount: fb?.count ?? null,
        dispatchLabel: shipping?.[s.id]?.dispatchLabel ?? null,
      });
    }
    return out;
  }

  async getStorefrontCard(ids: string[]): Promise<SellerSummary[]> {
    const rows = await this.repo.getMany('sellers', ids.filter(isUuid));
    const cards = new Map((await this.cards(rows.filter((r) => r.approved_at))).map((c) => [c.id, c]));
    return ids.map((id) => cards.get(id)).filter((c): c is SellerSummary => Boolean(c));
  }

  private async publicSeller(slug: string): Promise<SellerRec | undefined> {
    const s = await this.repo.sellerBySlug(slug);
    return s && s.approved_at && PUBLIC.includes(s.status) ? s : undefined;
  }

  async getStorefrontBySlug(slug: string): Promise<Storefront | null> {
    const s = await this.publicSeller(slug);
    return s ? this.storefront(s) : null;
  }

  async getStorefront(slug: string): Promise<Storefront> {
    const sf = await this.getStorefrontBySlug(slug);
    if (!sf) throw notFound('Store');
    return sf;
  }

  /** Visible collections with the offers that can be shown (ineligible offers stay saved but hidden) */
  private async visibleCollections(s: SellerRec, unavailable: string[] | null) {
    if (s.status === 'suspended') return [];
    const rows = await this.repo.find('featured_collections', { seller_id: s.id, visible: true }, { orderBy: [['position', 'asc']] });
    const all = [...new Set(rows.flatMap((r) => map.strings(r.offer_ids)))];
    const active = all.length ? await this.core.optional('offers', 'collections', unavailable, async (o) => new Set((await o.listActiveOffersByIds(all)).map((x) => x.id))) : new Set<string>();
    const refs = await this.core.mediaRefs(rows.map((r) => r.image_media_id));
    return rows.map((r) => {
      const offerIds = map.strings(r.offer_ids).filter((id) => !active || active.has(id));
      return { ...map.collection(r, refs), offerIds, offerCount: offerIds.length, itemCount: offerIds.length };
    });
  }

  async storefront(s: SellerRec): Promise<Storefront> {
    const unavailable: string[] = [];
    const p = await this.profileOf(s.id);
    const [card] = await this.cards([s]);
    const contact = this.contactOf(p);
    const fb = await this.core.optional('reviews', 'rating', unavailable, (r) => r.getSellerFeedbackSummary(s.id));
    const replies = await this.core.optional('messaging', 'replies', unavailable, (m) => m.sellerResponseStats(s.id, { from: this.core.today(new Date(this.now().getTime() - 90 * 86_400_000)), to: this.core.today() }));
    const dispatch = (await this.parts.performance.dispatchPct([s.id])).get(s.id) ?? fb?.onTimeDispatchPct ?? null;
    const shippingSummary = await this.core.optional('shipping', 'shipping', unavailable, async (x) => (await x.getSellerShippingSummaries([s.id]))[s.id]);
    const returns = await this.core.optional('returns', 'returns', unavailable, async (r) => (await r.sellerReturnTermsFor([s.id]))[s.id]);
    const categories = await this.core.optional('search', 'categories', unavailable, async (x) => (await x.sellerCategoryCounts([s.id]))[s.id] ?? []);
    const promo = await this.core.optional('promotions', 'promotion', unavailable, async (x) => (await x.activeSellerPromotions([s.id], {}))[s.id]?.[0] ?? null);
    const claims = (await this.repo.find('public_claims', { seller_id: s.id, state: 'approved' })).map((c) => this.liveClaim(c)).filter((c) => c.state === 'approved');
    const banner = (await this.core.mediaRefs([p.banner_media_id]))(p.banner_media_id);
    return {
      seller: card!,
      banner,
      introduction: p.introduction,
      warranty: p.warranty,
      sellingSince: this.core.today(s.approved_at ?? s.created_at),
      sellingNow: this.parts.accounts.canSellNew(s),
      highlights: {
        positivePct: fb?.positivePct ?? null,
        ratingCount: fb?.count ?? null,
        onTimeDispatchPct: dispatch,
        repliesWithin24hPct: replies?.repliedWithinTargetPct ?? null,
        medianReplyHours: replies?.averageReplyMinutes != null ? Math.round((replies.averageReplyMinutes / 60) * 10) / 10 : null,
      },
      verification: map.verificationLabel(s),
      approvedClaims: claims.map((c) => ({ kind: c.kind, text: c.text })),
      shipping: shippingSummary
        ? { shipsFrom: shippingSummary.shipsFrom, shipsTo: shippingSummary.coverageLabel, dispatch: shippingSummary.dispatchLabel, carriers: shippingSummary.carriers, cutoff: shippingSummary.sameDayCutoff }
        : null,
      returns: returns ? { window: `${returns.windowDays} days`, returnShipping: returns.summary, warranty: p.warranty } : null,
      contact: { canMessage: contact.orderMessages, productQuestions: contact.productQuestions, replyTarget: contact.replyTarget, ...(contact.showPhone && contact.phone ? { phone: contact.phone } : {}) },
      categories: (categories ?? []).map((c) => ({ categoryId: c.categoryId, name: c.name, offerCount: c.count })),
      collections: await this.visibleCollections(s, unavailable),
      promotion: promo ?? null,
      productCount: (categories ?? []).reduce((t, c) => t + c.count, 0),
      unavailable,
      tagline: p.tagline,
    };
  }

  async getStorefrontCollection(slug: string, collectionId: string): Promise<FeaturedCollection> {
    const s = await this.publicSeller(slug);
    if (!s) throw notFound('Store');
    const c = (await this.visibleCollections(s, null)).find((x) => x.id === collectionId);
    if (!c) throw notFound('Collection');
    const { itemCount: _i, ...rest } = c;
    return rest;
  }
}
