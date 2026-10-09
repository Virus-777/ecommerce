/**
 * The creative library: images and video uploaded through media first, or ad text; format checks per
 * placement, link and availability checks, and the review by Advertising and Content (or Marketing).
 */
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type { Creative, CreativeInput, CreativeSummary, LinkCheck, ReviewCheck } from '../../../spec/advertising.js';
import type * as common from '../../../spec/common.js';
import type * as media from '../../../spec/media.js';
import { formatIssues, hasDiscountClaim, idsInLink, linkState, sourceKinds, type ReviewRole } from '../domain/rules.js';
import { creativeReviewMachine } from '../domain/state-machines.js';
import type { CreativeListFilter, CreativeRec, PlacementRec } from '../ports.js';
import { encodeActor, invalid, notFound, Part, type By } from './core.js';

const MB = 1024 * 1024;
type Status = Creative['status'];

export interface CreativeQuery {
  q?: string;
  status?: string;
  source?: string;
  placementKey?: string;
  kind?: string;
  linkCheck?: string;
}

export class CreativesPart extends Part {
  private filter(q: CreativeQuery): CreativeListFilter {
    const kinds = sourceKinds(q.source);
    return {
      ...(q.q ? { q: q.q } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(kinds ? { advertiserKinds: kinds } : {}),
      ...(q.placementKey ? { placementKey: q.placementKey } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.linkCheck ? { linkCheck: q.linkCheck } : {}),
    };
  }

  async list(q: CreativeQuery, page: PageRequest): Promise<common.Page<Creative>> {
    const res = await this.repo.listCreatives(this.filter(q), page);
    return { ...res, items: await this.parts.views.creatives(res.items) };
  }

  async summary(q: CreativeQuery): Promise<CreativeSummary> {
    const c = await this.repo.creativeCounts(this.filter({ ...q, status: undefined }));
    const n = (k: string) => c[k] ?? 0;
    return { all: Object.values(c).reduce((a, b) => a + b, 0), draft: n('draft'), inReview: n('in_review'), changesRequested: n('changes_requested'), approved: n('approved'), rejected: n('rejected') };
  }

  async get(id: string, o: { sellerId?: string } = {}): Promise<Creative> {
    const row = await this.row(id, o);
    return (await this.parts.views.creatives([row]))[0]!;
  }

  private async row(id: string, o: { sellerId?: string } = {}): Promise<CreativeRec> {
    const row = isUuid(id) ? await this.repo.get('creatives', id) : undefined;
    if (!row || (o.sellerId !== undefined && row.seller_id !== o.sellerId)) throw notFound('Creative');
    return row;
  }

  /* ---------------------------------------------------------------- checks */

  /** Link check: store links to offers and products are checked for availability */
  async linkCheck(link: string | null | undefined): Promise<LinkCheck> {
    const base = linkState(link);
    const checkedAt = this.now().toISOString();
    if (base.state !== 'ok') return { ...base, checkedAt };
    const ids = idsInLink(link);
    if (!ids.length) return { ...base, checkedAt };
    const offers = await this.core.offerInfo(ids);
    const offer = offers ? ids.map((id) => offers.get(id)).find((x) => x) : undefined;
    if (offer) return offer.promotable ? { state: 'ok', detail: `Product page works${offer.available !== null ? ` · ${offer.available} in stock` : ''}`, checkedAt } : { state: 'fail', detail: `Promoted offer unavailable: ${offer.reason}`, checkedAt };
    for (const id of ids) {
      const p = await this.core.product(id);
      if (p) return { state: 'ok', detail: `Product page works · ${p.title}`, checkedAt };
    }
    return { ...base, checkedAt };
  }

  autoChecks(c: Pick<CreativeRec, 'kind' | 'headline' | 'body' | 'width' | 'height'>, placement: PlacementRec, headlineMax: number, link: LinkCheck): ReviewCheck[] {
    const checks: ReviewCheck[] = [{ state: 'ok', label: 'Label', detail: `"${placement.label}" label is added when the ad shows` }];
    if (c.kind === 'text') checks.push({ state: 'ok', label: 'Format', detail: 'Ad text' });
    else checks.push({ state: 'ok', label: 'Format', detail: `${c.width ?? '?'} × ${c.height ?? '?'} fits ${placement.name}` });
    if (c.headline) checks.push({ state: c.headline.length > headlineMax ? 'fail' : 'ok', label: 'Headline length', detail: `${c.headline.length} of ${headlineMax} characters` });
    if (hasDiscountClaim(c.headline) || hasDiscountClaim(c.body)) checks.push({ state: 'warn', label: 'Claims', detail: 'Discount claim: Content checks it against the linked promotion' });
    checks.push({ state: link.state, label: 'Link', detail: link.detail });
    return checks;
  }

  private async limits(sellerUpload: boolean) {
    return {
      maxImageBytes: sellerUpload ? 5 * MB : await this.core.num('maxImageBytes', MB),
      headlineMax: sellerUpload ? 40 : await this.core.num('headlineMaxChars', 60),
    };
  }

  /** Media facts and format issues for an uploaded file */
  private async mediaFacts(mediaId: string, kind: 'image' | 'video', sellerId: string | undefined): Promise<media.MediaAsset> {
    let asset: media.MediaAsset | null = null;
    try {
      asset = await this.ctx.use('media').getAsset(mediaId);
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'NOT_FOUND') throw err;
    }
    if (!asset || (sellerId && (asset.owner.kind !== 'seller' || asset.owner.id !== sellerId))) throw invalid([{ path: 'mediaId', message: 'Upload the file through media first' }], 'File not found');
    const wanted = kind === 'video' ? 'ad_video' : 'ad_creative';
    if (asset.purpose !== wanted) throw this.ctx.error('CREATIVE_FORMAT_INVALID', `Upload the file as ${wanted} (it was uploaded as ${asset.purpose}).`, { issues: [{ path: 'mediaId', message: `Purpose must be ${wanted}` }] });
    if (asset.status === 'rejected' || asset.status === 'removed' || asset.status === 'deleted' || asset.status === 'expired') throw this.ctx.error('CREATIVE_FORMAT_INVALID', asset.rejectionReason ?? 'This file cannot be used.', { issues: [{ path: 'mediaId', message: asset.status }] });
    return asset;
  }

  /* ---------------------------------------------------------------- create and edit */

  async create(input: CreativeInput, by: By, o: { sellerId?: string } = {}): Promise<Creative> {
    const placement = await this.core.placementByKey(input.placementKey);
    if (!placement) throw invalid([{ path: 'placementKey', message: `Unknown placement ${input.placementKey}` }]);
    const adv = o.sellerId ? { kind: 'seller' as const, sellerId: o.sellerId, brandId: null } : (input.advertiser ?? { kind: 'platform' as const });
    if (adv.kind === 'seller' && !isUuid(adv.sellerId)) throw invalid([{ path: 'advertiser.sellerId', message: 'Choose the seller' }]);
    if (adv.kind === 'brand' && !isUuid(adv.brandId)) throw invalid([{ path: 'advertiser.brandId', message: 'Choose the brand' }]);
    const limits = await this.limits(Boolean(o.sellerId));

    let asset: media.MediaAsset | null = null;
    if (input.kind !== 'text') {
      if (!input.mediaId) throw invalid([{ path: 'mediaId', message: 'Upload the image or video through media first' }]);
      asset = await this.mediaFacts(input.mediaId, input.kind, o.sellerId);
    }
    const issues = formatIssues({ kind: input.kind, device: input.device, width: asset?.width, height: asset?.height, bytes: asset?.sizeBytes, contentType: asset?.contentType, headline: input.headline, body: input.body, buttonText: input.buttonText }, (placement.formats ?? []) as never, limits);
    if (issues.length) throw this.ctx.error('CREATIVE_FORMAT_INVALID', issues.map((i) => i.message).join('; '), { issues });

    // the campaign it is added for
    let campaignId: string | null = null;
    if (input.campaignId) {
      const c = isUuid(input.campaignId) ? await this.repo.get('campaigns', input.campaignId) : undefined;
      if (!c || (o.sellerId && c.seller_id !== o.sellerId)) throw notFound('Campaign');
      if (c.status !== 'draft') throw new AppError('ILLEGAL_TRANSITION', 'Creatives can be added to draft campaigns only', { from: c.status, event: 'edit' });
      if (c.placement_id !== placement.id) throw invalid([{ path: 'placementKey', message: 'The campaign uses another placement' }]);
      campaignId = c.id;
    }

    const link = await this.linkCheck(input.link);
    const id = newId();
    const label = input.headline ?? asset?.fileName ?? 'Ad creative';
    if (asset) await this.ctx.use('media').attach(asset.id, { module: 'advertising', kind: 'ad_creative', refId: id, refLabel: label }, o.sellerId ? { kind: 'seller', id: o.sellerId } : { kind: 'platform' });
    const values = {
      kind: input.kind,
      headline: input.headline?.trim() || null,
      body: input.body?.trim() || null,
      width: asset?.width ?? null,
      height: asset?.height ?? null,
    };
    try {
      await this.repo.transaction(async (tx) => {
        await tx.insert('creatives', {
          id,
          advertiser_kind: adv.kind,
          seller_id: adv.kind === 'seller' ? (adv.sellerId ?? null) : null,
          brand_id: adv.kind === 'brand' ? (adv.brandId ?? null) : null,
          kind: input.kind,
          device: input.device,
          placement_key: placement.key,
          media_id: asset?.id ?? null,
          file_name: asset?.fileName ?? null,
          width: asset?.width ?? null,
          height: asset?.height ?? null,
          bytes: asset?.sizeBytes ?? null,
          duration_seconds: asset?.durationSeconds ?? null,
          headline: values.headline,
          body: values.body,
          button_text: input.buttonText?.trim() || null,
          link: input.link?.trim() || null,
          status: creativeReviewMachine.initial,
          link_check: link as never,
          auto_checks: this.autoChecks(values, placement, limits.headlineMax, link) as never,
          created_by: encodeActor(by.actor),
          created_at: this.now(),
        });
        if (campaignId) await tx.insertIgnore('campaign_creatives', { campaign_id: campaignId, creative_id: id, device: input.device });
      });
    } catch (err) {
      if (asset) await this.core.optionalMedia((m) => m.detach(asset!.id, { module: 'advertising', kind: 'ad_creative', refId: id }));
      throw err;
    }
    return this.get(id);
  }

  async update(id: string, patch: { headline?: string | null; body?: string | null; buttonText?: string | null; link?: string | null; mediaId?: string | null }, by: By): Promise<Creative> {
    const before = await this.row(id);
    if (before.status === 'in_review' || before.status === 'rejected') creativeReviewMachine.next(before.status as Status, 'edit' as never);
    const placement = (await this.core.placementByKey(before.placement_key))!;
    const limits = await this.limits(before.advertiser_kind === 'seller');
    let asset: media.MediaAsset | null = null;
    const mediaChanged = patch.mediaId !== undefined && patch.mediaId !== null && patch.mediaId !== before.media_id;
    if (mediaChanged) {
      if (before.kind === 'text') throw invalid([{ path: 'mediaId', message: 'Text ads have no file' }]);
      asset = await this.mediaFacts(patch.mediaId!, before.kind as 'image' | 'video', before.seller_id ?? undefined);
    }
    const next = {
      kind: before.kind as 'image' | 'text' | 'video',
      headline: patch.headline !== undefined ? patch.headline?.trim() || null : before.headline,
      body: patch.body !== undefined ? patch.body?.trim() || null : before.body,
      button_text: patch.buttonText !== undefined ? patch.buttonText?.trim() || null : before.button_text,
      link: patch.link !== undefined ? patch.link?.trim() || null : before.link,
      width: asset?.width ?? before.width,
      height: asset?.height ?? before.height,
    };
    const issues = formatIssues({ kind: next.kind, device: before.device as never, width: next.width, height: next.height, bytes: asset?.sizeBytes ?? before.bytes, contentType: asset?.contentType ?? null, headline: next.headline, body: next.body, buttonText: next.button_text }, (placement.formats ?? []) as never, limits);
    if (issues.length) throw this.ctx.error('CREATIVE_FORMAT_INVALID', issues.map((i) => i.message).join('; '), { issues });
    const link = await this.linkCheck(next.link);
    if (asset) await this.ctx.use('media').attach(asset.id, { module: 'advertising', kind: 'ad_creative', refId: id, refLabel: next.headline ?? asset.fileName }, before.seller_id ? { kind: 'seller', id: before.seller_id } : { kind: 'platform' });
    const status = before.status === 'approved' ? creativeReviewMachine.next('approved', 'edit') : before.status;
    const after = await this.repo.update('creatives', id, {
      headline: next.headline,
      body: next.body,
      button_text: next.button_text,
      link: next.link,
      status,
      link_check: link as never,
      auto_checks: this.autoChecks(next, placement, limits.headlineMax, link) as never,
      ...(asset ? { media_id: asset.id, file_name: asset.fileName, width: asset.width ?? null, height: asset.height ?? null, bytes: asset.sizeBytes, duration_seconds: asset.durationSeconds ?? null } : {}),
    });
    if (asset && before.media_id) await this.core.optionalMedia((m) => m.detach(before.media_id!, { module: 'advertising', kind: 'ad_creative', refId: id }));
    if (status !== before.status) this.parts.serving.invalidate();
    await this.core.audit(
      {
        action: 'advertising.creative.update',
        actionLabel: `Edited creative ${next.headline ?? before.file_name ?? id}`,
        target: { type: 'ad_creative', id, label: next.headline ?? before.file_name ?? null, screen: 'admin/ad-assets' },
        before: { headline: before.headline, body: before.body, buttonText: before.button_text, link: before.link, mediaId: before.media_id, status: before.status },
        after: { headline: after.headline, body: after.body, buttonText: after.button_text, link: after.link, mediaId: after.media_id, status: after.status },
      },
      by,
    );
    return this.get(id);
  }

  /** Approve (every required role), request changes, reject/revoke, or leave a note */
  async review(id: string, body: { role: ReviewRole; decision: 'approved' | 'changes_requested' | 'rejected' | 'note'; reasonCode?: string | null; comment?: string | null }, by: By): Promise<Creative> {
    const before = await this.row(id);
    if ((body.decision === 'changes_requested' || body.decision === 'rejected') && !body.comment?.trim() && !body.reasonCode) throw invalid([{ path: 'comment', message: 'Give a reason' }]);
    const reviewer = encodeActor(by.actor);
    const now = this.now();
    const after = await this.repo.transaction(async (tx) => {
      const locked = await tx.get('creatives', id, { forUpdate: true });
      if (!locked) throw notFound('Creative');
      let status = locked.status as Status;
      if (body.decision === 'changes_requested') status = creativeReviewMachine.next(status, 'requestChanges');
      else if (body.decision === 'rejected') status = creativeReviewMachine.next(status, status === 'approved' ? 'revoke' : 'reject');
      else if (body.decision === 'approved') {
        if (status !== 'in_review') creativeReviewMachine.next(status, 'approve');
        const prior = await tx.find('creative_reviews', { creative_id: id }, { orderBy: [['at', 'asc']] });
        const lastReset = Math.max(-1, ...prior.map((p, i) => (p.decision === 'changes_requested' || p.decision === 'rejected' ? i : -1)));
        const roles = new Set(prior.slice(lastReset + 1).filter((p) => p.decision === 'approved').map((p) => p.role));
        roles.add(body.role);
        const own = locked.advertiser_kind === 'platform' || locked.advertiser_kind === 'official_store';
        if (roles.has('advertising') && (roles.has('content') || (own && roles.has('marketing')))) status = creativeReviewMachine.next(status, 'approve');
      }
      await tx.insert('creative_reviews', { id: newId(), creative_id: id, reviewer_id: reviewer, role: body.role, decision: body.decision, reason_code: body.reasonCode ?? null, comment: body.comment?.trim() || null, at: now });
      return status === locked.status ? locked : tx.update('creatives', id, { status });
    });
    const link = await this.repo.findOne('campaign_creatives', { creative_id: id });
    this.core.publish('advertising.creative.reviewed', { creativeId: id, campaignId: link?.campaign_id ?? null, decision: body.decision, reasonCode: body.reasonCode ?? null }, by);
    if (after.status !== before.status) this.parts.serving.invalidate();
    await this.core.audit(
      {
        action: `advertising.creative.review`,
        actionLabel: `${body.decision === 'note' ? 'Noted on' : body.decision === 'approved' ? 'Approved' : body.decision === 'rejected' ? 'Rejected' : 'Requested changes to'} creative ${before.headline ?? before.file_name ?? id}`,
        target: { type: 'ad_creative', id, label: before.headline ?? before.file_name ?? null, screen: 'admin/ad-assets' },
        reason: body.comment ?? body.reasonCode ?? null,
        before: { status: before.status },
        after: { status: after.status, role: body.role, decision: body.decision },
      },
      by,
    );
    return this.get(id);
  }

  /** System revoke (trust enforcement, suspended offer): approved → rejected, in review → rejected */
  async revoke(id: string, reason: string, by: By): Promise<boolean> {
    const row = await this.repo.get('creatives', id);
    if (!row) return false;
    const event = row.status === 'approved' ? 'revoke' : row.status === 'in_review' ? 'reject' : null;
    if (!event) return false;
    await this.repo.transaction(async (tx) => {
      await tx.update('creatives', id, { status: creativeReviewMachine.next(row.status as Status, event) });
      await tx.insert('creative_reviews', { id: newId(), creative_id: id, reviewer_id: encodeActor(by.actor), role: 'advertising', decision: 'rejected', reason_code: 'policy', comment: reason, at: this.now() });
    });
    const link = await this.repo.findOne('campaign_creatives', { creative_id: id });
    this.core.publish('advertising.creative.reviewed', { creativeId: id, campaignId: link?.campaign_id ?? null, decision: 'rejected', reasonCode: 'policy' }, by);
    this.parts.serving.invalidate();
    return true;
  }

  /** Re-run the link, availability and label checks */
  async recheck(id: string): Promise<Creative> {
    const row = await this.row(id);
    await this.refreshChecks(row);
    return this.get(id);
  }

  async refreshChecks(row: CreativeRec): Promise<LinkCheck> {
    const placement = await this.core.placementByKey(row.placement_key);
    const limits = await this.limits(row.advertiser_kind === 'seller');
    const link = await this.linkCheck(row.link);
    await this.repo.update('creatives', row.id, { link_check: link as never, ...(placement ? { auto_checks: this.autoChecks(row as never, placement, limits.headlineMax, link) as never } : {}) });
    return link;
  }
}
