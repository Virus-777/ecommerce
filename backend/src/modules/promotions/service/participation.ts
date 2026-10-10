/**
 * Seller participation in platform campaigns: invitations, explicit consent with the exact text, offer
 * eligibility and expected earnings, declines, withdrawals (immediate before the start, a request after),
 * staff removal. A seller's offers are included only after consent (plan ch. 15).
 */
import { AppError } from '../../../kernel/errors/index.js';
import { newId } from '../../../kernel/lib/ids.js';
import type { PageRequest } from '../../../kernel/lib/pagination.js';
import type * as common from '../../../spec/common.js';
import type { Invitation, Participation } from '../../../spec/promotions.js';
import type { ConsentMap } from '../domain/evaluate.js';
import { sellerParticipationMachine } from '../domain/state-machines.js';
import { bpsLabel, CONSENT_TEXT_VERSION, consentText, dayLabel, discountLabel, earningsImpact, fundingLabel, platformShareBps, unitDiscount, type CampaignModel } from '../domain/rules.js';
import { decodeActor, encodeActor, iso, isoOrNull, periodOf } from '../mappers.js';
import type { ParticipationRec } from '../ports.js';
import { invalid, notFound, Part, SYSTEM, type By } from './core.js';

const OPEN_CAMPAIGN = ['draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'live', 'paused'];
const ACTIVE_STATES = ['invited', 'accepted', 'withdrawal_requested'];

export class ParticipationPart extends Part {
  /* ---------------------------------------------------------------- views */

  async participation(rec: ParticipationRec, c: CampaignModel, o: { sellerView: boolean; names?: Map<string, string> } = { sellerView: false }): Promise<Participation> {
    const pos = await this.repo.find('participation_offers', { participation_id: rec.id });
    const offers = await this.parts.campaigns.participationOffers(
      c,
      pos.map((p) => ({ offerId: p.offer_id, eligible: p.eligible, reasons: (p.ineligible_reasons as unknown as string[]) ?? [], included: p.included })),
      { ...(o.sellerView ? { sellerId: rec.seller_id } : {}), sellerShareBps: rec.seller_share_bps },
    );
    const names = o.names ?? (await this.core.sellerNames([rec.seller_id]));
    return {
      id: rec.id,
      campaignId: rec.campaign_id,
      sellerId: rec.seller_id,
      sellerName: names.get(rec.seller_id) ?? 'Seller',
      state: rec.state as Participation['state'],
      offerCount: pos.filter((p) => p.included).length,
      offers,
      sellerShareBps: rec.seller_share_bps,
      platformShareBps: rec.platform_share_bps,
      respondBy: isoOrNull(rec.respond_by),
      consentedAt: isoOrNull(rec.consented_at),
      consentedBy: rec.consented_by ? decodeActor(rec.consented_by) : null,
      consentText: rec.consent_text,
      earningsExample: await this.example(c, rec.seller_share_bps),
      reason: rec.reason,
    };
  }

  /** Earnings per $100.00 sale (example) */
  async example(c: CampaignModel, sellerShareBps: number) {
    const base = 10000;
    const fee = await this.core.feeCalculator(null, base);
    const discount = c.kind === 'flash_sale' ? (c.discount.percentOffBps ? Math.round((base * c.discount.percentOffBps) / 10000) : 0) : unitDiscount(c.discount, base);
    return earningsImpact({ basePrice: base, discount, sellerShareBps, feeRateBps: fee.rateBps, currency: c.currency, isExample: true, fundingWords: fundingLabel(c.funding).toLowerCase(), feeAt: fee.feeAt });
  }

  async invitation(rec: ParticipationRec, c: CampaignModel): Promise<Invitation> {
    const part = await this.participation(rec, c, { sellerView: true });
    const started = c.startsAt.getTime() <= this.now().getTime();
    const featuredOn = [...(c.deals?.show ? ['Deals page'] : []), 'Campaign page'];
    return {
      participation: part,
      campaign: {
        id: c.id,
        name: c.name,
        description: c.description,
        period: periodOf(c),
        banner: null,
        featuredOn,
        discountLabel: discountLabel(c.discount, c.currency),
        rules: c.participation?.rules ?? [],
        funding: {
          discountBps: c.discount.percentOffBps ?? 0,
          sellerFundsBps: rec.seller_share_bps,
          platformFundsBps: rec.platform_share_bps,
          feeBasisNote: `The fee is charged on the price after your ${bpsLabel(rec.seller_share_bps)} share of the discount. Marketly's ${bpsLabel(rec.platform_share_bps)} share is credited to your proceeds.`,
        },
      },
      leavePolicy: started ? 'The campaign has started: leaving needs Marketing approval.' : `You can leave before ${dayLabel(c.startsAt, c.timeZone)}. After it starts, leaving needs Marketing approval.`,
      salesNote: null,
    };
  }

  async ownParticipation(sellerId: string, id: string): Promise<{ rec: ParticipationRec; c: CampaignModel }> {
    const rec = await this.repo.get('participations', id);
    if (!rec || rec.seller_id !== sellerId) throw notFound('Invitation');
    const { model } = await this.core.campaign(rec.campaign_id);
    return { rec, c: model };
  }

  /* ---------------------------------------------------------------- admin */

  async invite(id: string, body: { sellerIds?: string[] | null; respondBy: string }, by: By): Promise<Participation[]> {
    const { model: c } = await this.core.campaign(id);
    if (c.ownerKind !== 'platform') throw invalid([{ path: 'id', message: 'Only platform campaigns invite sellers' }]);
    if (!OPEN_CAMPAIGN.includes(c.status)) throw new AppError('ILLEGAL_TRANSITION', `A ${c.status} campaign can't invite sellers`, { from: c.status });
    const respondBy = new Date(body.respondBy);
    const issues = [];
    if (!c.participation?.inviteSellers) issues.push({ path: 'participation.inviteSellers', message: 'Turn on seller invitations for this campaign first' });
    if (respondBy.getTime() <= this.now().getTime()) issues.push({ path: 'respondBy', message: 'The response deadline must be in the future' });
    if (respondBy.getTime() >= c.endsAt.getTime()) issues.push({ path: 'respondBy', message: 'The response deadline must be before the campaign ends' });
    if (issues.length) throw invalid(issues);
    await this.parts.campaigns.rebuildEligible(id);
    const eligible = await this.repo.find('eligible_offers', { campaign_id: id, official_store: false });
    const sellerIds = body.sellerIds?.length ? [...new Set(body.sellerIds)] : [...new Set(eligible.filter((e) => e.eligible).map((e) => e.seller_id))];
    const platformBps = platformShareBps(c);
    const invited: ParticipationRec[] = [];
    await this.repo.transaction(async (tx) => {
      for (const sellerId of sellerIds) {
        const existing = await tx.findOne('participations', { campaign_id: id, seller_id: sellerId }, { forUpdate: true });
        let rec: ParticipationRec;
        if (existing) {
          if (!sellerParticipationMachine.can(existing.state as never, 'reinvite' as never)) continue;
          rec = await tx.update('participations', existing.id, { state: this.core.step(sellerParticipationMachine, existing.state, 'reinvite'), respond_by: respondBy, reason: null, seller_share_bps: 10000 - platformBps, platform_share_bps: platformBps, updated_at: this.now() });
          await tx.removeWhere('participation_offers', { participation_id: rec.id });
        } else {
          rec = await tx.insert('participations', { id: newId(), campaign_id: id, seller_id: sellerId, state: sellerParticipationMachine.initial, seller_share_bps: 10000 - platformBps, platform_share_bps: platformBps, respond_by: respondBy, consented_at: null, consented_by: null, consent_text: null, reason: null, updated_at: this.now() });
        }
        const offers = eligible.filter((e) => e.seller_id === sellerId);
        if (offers.length) await tx.insertMany('participation_offers', offers.map((e) => ({ participation_id: rec.id, offer_id: e.offer_id, eligible: e.eligible, ineligible_reasons: (e.reason ? [e.reason] : []) as never, included: false })));
        invited.push(rec);
      }
      await this.core.log(tx, id, 'sellers.invited', by, null, { sellers: invited.length, respondBy: respondBy.toISOString() });
    });
    if (invited.length) this.core.publish('promotions.participation.invited', { campaignId: id, sellerIds: invited.map((r) => r.seller_id), respondBy: respondBy.toISOString() }, by);
    const names = await this.core.sellerNames(invited.map((r) => r.seller_id));
    const out = [];
    for (const r of invited) out.push(await this.participation(r, c, { sellerView: false, names }));
    await this.core.audit({ action: 'promotions.participation.invite', actionLabel: `Invited ${invited.length} sellers`, category: 'other', target: { type: 'campaign', id, ref: c.ref, label: c.name }, after: { sellerIds: invited.map((r) => r.seller_id), respondBy: respondBy.toISOString() } }, by);
    return out;
  }

  async listForCampaign(id: string, state: string | undefined, page: PageRequest): Promise<common.Page<Participation>> {
    const { model: c } = await this.core.campaign(id);
    const p = await this.repo.page('participations', { campaign_id: id, ...(state ? { state: state.split(',') } : {}) }, page, { column: 'updated_at', direction: 'desc' });
    const names = await this.core.sellerNames(p.items.map((r) => r.seller_id));
    const items = [];
    for (const r of p.items) items.push(await this.participation(r, c, { sellerView: false, names }));
    return { ...p, items };
  }

  async decideWithdrawal(id: string, body: { approve: boolean; reason: string }, by: By): Promise<Participation> {
    const rec = await this.repo.get('participations', id);
    if (!rec) throw notFound('Participation');
    const after = await this.move(rec.id, body.approve ? 'approveWithdrawal' : 'rejectWithdrawal', by, { reason: body.reason });
    const { model: c } = await this.core.campaign(rec.campaign_id);
    await this.core.audit({ action: 'promotions.participation.decide_withdrawal', actionLabel: body.approve ? 'Approved seller leaving the campaign' : 'Kept seller in the campaign', category: 'other', target: { type: 'participation', id, label: c.name, sellerId: rec.seller_id }, relatedTargets: [{ type: 'campaign', id: c.id, ref: c.ref }], before: { state: rec.state }, after: { state: after.state }, reason: body.reason, visibleToSeller: true }, by);
    return this.participation(after, c);
  }

  async remove(id: string, body: { offerIds?: string[] | null; reason: string }, by: By): Promise<Participation> {
    const rec = await this.repo.get('participations', id);
    if (!rec) throw notFound('Participation');
    let after: ParticipationRec;
    if (body.offerIds?.length) {
      if (rec.state !== 'accepted' && rec.state !== 'withdrawal_requested') throw new AppError('ILLEGAL_TRANSITION', 'Offers can be removed only from an accepted participation', { from: rec.state, event: 'remove' });
      const pos = await this.repo.find('participation_offers', { participation_id: id });
      const unknown = body.offerIds.filter((o) => !pos.some((p) => p.offer_id === o));
      if (unknown.length) throw invalid([{ path: 'offerIds', message: 'Some offers are not in this participation' }]);
      const left = pos.filter((p) => p.included && !body.offerIds!.includes(p.offer_id));
      if (!left.length) after = await this.move(id, 'remove', by, { reason: body.reason });
      else {
        after = await this.repo.transaction(async (tx) => {
          await tx.updateWhere('participation_offers', { participation_id: id, offer_id: body.offerIds! }, { included: false });
          const r = await tx.update('participations', id, { reason: body.reason, updated_at: this.now() });
          await this.core.log(tx, rec.campaign_id, 'participation.offers_removed', by, body.reason, { participationId: id, sellerId: rec.seller_id, offerIds: body.offerIds });
          return r;
        });
        this.core.publish('promotions.participation.decided', { participationId: id, campaignId: rec.campaign_id, sellerId: rec.seller_id, state: after.state }, by);
      }
    } else after = await this.move(id, 'remove', by, { reason: body.reason });
    const { model: c } = await this.core.campaign(rec.campaign_id);
    await this.core.audit({ action: 'promotions.participation.remove', actionLabel: body.offerIds?.length ? 'Removed offers from a campaign' : 'Removed seller from a campaign', category: 'other', target: { type: 'participation', id, label: c.name, sellerId: rec.seller_id }, relatedTargets: [{ type: 'campaign', id: c.id, ref: c.ref }], before: { state: rec.state }, after: { state: after.state, offerIds: body.offerIds ?? null }, reason: body.reason, visibleToSeller: true }, by);
    return this.participation(after, c);
  }

  /** A participation transition with its log line and the decided event */
  async move(id: string, event: string, by: By, o: { reason?: string | null; patch?: Partial<ParticipationRec>; publish?: boolean } = {}): Promise<ParticipationRec> {
    const after = await this.repo.transaction(async (tx) => {
      const rec = await tx.get('participations', id, { forUpdate: true });
      if (!rec) throw notFound('Participation');
      const state = this.core.step(sellerParticipationMachine, rec.state, event);
      const r = await tx.update('participations', id, { ...o.patch, state, ...(o.reason !== undefined ? { reason: o.reason } : {}), updated_at: this.now() });
      if (state === 'removed' || state === 'withdrawn') await tx.updateWhere('participation_offers', { participation_id: id }, { included: false });
      await this.core.log(tx, rec.campaign_id, `participation.${event}`, by, o.reason ?? null, { participationId: id, sellerId: rec.seller_id, state });
      return r;
    });
    if (o.publish !== false) this.core.publish('promotions.participation.decided', { participationId: id, campaignId: after.campaign_id, sellerId: after.seller_id, state: after.state }, by);
    return after;
  }

  /* ---------------------------------------------------------------- seller */

  async listInvitations(sellerId: string, state: string | undefined, page: PageRequest): Promise<common.Page<Invitation>> {
    const p = await this.repo.page('participations', { seller_id: sellerId, ...(state ? { state } : {}) }, page, { column: 'updated_at', direction: 'desc' });
    const models = new Map((await this.core.models(await this.repo.getMany('campaigns', p.items.map((r) => r.campaign_id)))).map((c) => [c.id, c]));
    const items = [];
    for (const r of p.items) {
      const c = models.get(r.campaign_id);
      if (c) items.push(await this.invitation(r, c));
    }
    return { ...p, items };
  }

  async getInvitation(sellerId: string, id: string): Promise<Invitation> {
    const { rec, c } = await this.ownParticipation(sellerId, id);
    return this.invitation(rec, c);
  }

  async accept(sellerId: string, id: string, body: { offerIds: string[]; consent: boolean; consentTextVersion: string }, by: By): Promise<Invitation> {
    const { rec, c } = await this.ownParticipation(sellerId, id);
    if (!body.consent) throw this.ctx.error('CONSENT_REQUIRED', 'Tick the consent box to join: your offers are included only after you agree');
    this.core.step(sellerParticipationMachine, rec.state, 'accept');
    if (!OPEN_CAMPAIGN.includes(c.status) || c.endsAt.getTime() <= this.now().getTime()) throw this.ctx.error('INVITATION_CLOSED', 'This campaign is no longer open');
    if (rec.respond_by && new Date(rec.respond_by).getTime() < this.now().getTime()) throw this.ctx.error('INVITATION_CLOSED', 'The response deadline has passed');
    const offerIds = [...new Set(body.offerIds)];
    if (!offerIds.length) throw invalid([{ path: 'offerIds', message: 'Choose at least one offer' }]);
    const pos = await this.repo.find('participation_offers', { participation_id: id });
    const problems = offerIds
      .map((o) => {
        const po = pos.find((p) => p.offer_id === o);
        if (!po) return { offerId: o, reasons: ['Not part of this invitation'] };
        if (!po.eligible) return { offerId: o, reasons: (po.ineligible_reasons as unknown as string[]) ?? ['Not eligible'] };
        return null;
      })
      .filter(Boolean);
    if (problems.length) throw this.ctx.error('OFFER_NOT_ELIGIBLE', 'Only eligible offers can join', { offers: problems });
    const can = await this.core.optional('sellers', (s) => s.canSell(sellerId, { activity: 'promotions' }));
    if (can && !can.allowed) throw invalid([{ path: 'sellerId', message: can.reason ?? 'Your account cannot join promotions right now' }], 'Your account cannot join promotions right now');
    const text = consentText({ campaignName: c.name, period: periodOf(c).display, discount: discountLabel(c.discount, c.currency), offerCount: offerIds.length, sellerShareBps: rec.seller_share_bps, platformShareBps: rec.platform_share_bps, version: body.consentTextVersion || CONSENT_TEXT_VERSION });
    const after = await this.repo.transaction(async (tx) => {
      await tx.updateWhere('participation_offers', { participation_id: id }, { included: false });
      await tx.updateWhere('participation_offers', { participation_id: id, offer_id: offerIds }, { included: true });
      const locked = await tx.get('participations', id, { forUpdate: true });
      const state = this.core.step(sellerParticipationMachine, locked!.state, 'accept');
      const r = await tx.update('participations', id, { state, consented_at: this.now(), consented_by: encodeActor(by.actor), consent_text: text, reason: null, updated_at: this.now() });
      await this.core.log(tx, c.id, 'participation.accept', by, null, { participationId: id, sellerId, offerIds, consentTextVersion: body.consentTextVersion });
      return r;
    });
    this.core.publish('promotions.participation.decided', { participationId: id, campaignId: c.id, sellerId, state: after.state }, by);
    await this.core.audit({ action: 'promotions.participation.accept', actionLabel: `Joined ${c.name}`, category: 'other', target: { type: 'participation', id, label: c.name, sellerId }, relatedTargets: [{ type: 'campaign', id: c.id, ref: c.ref }], after: { state: after.state, offerIds, consentText: text, sellerShareBps: rec.seller_share_bps }, visibleToSeller: true }, by);
    return this.invitation(after, c);
  }

  async decline(sellerId: string, id: string, reason: string | null | undefined, by: By): Promise<Invitation> {
    const { c } = await this.ownParticipation(sellerId, id);
    const after = await this.move(id, 'decline', by, { reason: reason ?? null });
    return this.invitation(after, c);
  }

  async withdraw(sellerId: string, id: string, reason: string, by: By): Promise<Invitation> {
    const { rec, c } = await this.ownParticipation(sellerId, id);
    const started = c.startsAt.getTime() <= this.now().getTime() && ['scheduled', 'live', 'paused'].includes(c.status);
    const after = await this.move(id, started ? 'requestWithdrawal' : 'withdraw', by, { reason });
    await this.core.audit({ action: started ? 'promotions.participation.request_withdrawal' : 'promotions.participation.withdraw', actionLabel: started ? `Asked to leave ${c.name}` : `Left ${c.name}`, category: 'other', target: { type: 'participation', id, label: c.name, sellerId }, relatedTargets: [{ type: 'campaign', id: c.id, ref: c.ref }], before: { state: rec.state }, after: { state: after.state }, reason, visibleToSeller: true }, by);
    return this.invitation(after, c);
  }

  /* ---------------------------------------------------------------- evaluation support and system actions */

  /** Accepted sellers and their included offers per consent-based campaign */
  async consents(campaignIds: readonly string[]): Promise<ConsentMap> {
    const out: ConsentMap = new Map();
    if (!campaignIds.length) return out;
    const parts = await this.repo.find('participations', { campaign_id: [...campaignIds], state: ['accepted', 'withdrawal_requested'] });
    const offers = parts.length ? await this.repo.find('participation_offers', { participation_id: parts.map((p) => p.id), included: true }) : [];
    for (const p of parts) {
      const map = out.get(p.campaign_id) ?? new Map();
      map.set(p.seller_id, { platformBps: p.platform_share_bps, offerIds: new Set(offers.filter((o) => o.participation_id === p.id).map((o) => o.offer_id)) });
      out.set(p.campaign_id, map);
    }
    return out;
  }

  /** Remove a seller from campaigns that are not over (restriction or suspension), reason recorded */
  async removeSellerEverywhere(sellerId: string, reason: string, by: By = { actor: SYSTEM }): Promise<number> {
    const parts = await this.repo.find('participations', { seller_id: sellerId, state: ['invited', 'accepted'] });
    let n = 0;
    for (const p of parts) {
      const camp = await this.repo.get('campaigns', p.campaign_id);
      if (!camp || !OPEN_CAMPAIGN.includes(camp.status)) continue;
      await this.move(p.id, 'remove', by, { reason });
      n += 1;
    }
    // a pending withdrawal request is settled as a removal too
    for (const p of await this.repo.find('participations', { seller_id: sellerId, state: 'withdrawal_requested' })) {
      await this.move(p.id, 'approveWithdrawal', by, { reason });
      n += 1;
    }
    return n;
  }

  /** Job: remind 24 h before respondBy, expire unanswered invitations */
  async deadlines(): Promise<void> {
    const now = this.now();
    const open = await this.repo.find('participations', { state: 'invited' }, { limit: 1000 });
    for (const p of open) {
      if (!p.respond_by) continue;
      const due = new Date(p.respond_by).getTime();
      if (due < now.getTime()) {
        await this.move(p.id, 'expire', { actor: SYSTEM }, { reason: 'No answer before the deadline' });
        continue;
      }
      if (due - now.getTime() <= 24 * 3_600_000) {
        const key = `promotions:invite-reminder:${p.id}`;
        const sent = await this.repo.findOne('campaign_log', { campaign_id: p.campaign_id, action: 'participation.reminded', reason: p.id });
        if (sent) continue;
        await this.core.optional('notifications', (nApi) =>
          nApi.notify({
            topic: 'seller.promotion.invited',
            recipients: [{ kind: 'seller', sellerId: p.seller_id }],
            context: { campaign: { respondBy: iso(p.respond_by!) } },
            link: { kind: 'campaign', id: p.campaign_id, screen: 'seller/marketing', label: 'Review invitation' },
            dedupeKey: key,
            actionRequired: true,
            deadline: iso(p.respond_by!),
            sellerId: p.seller_id,
          }),
        );
        await this.repo.transaction((tx) => this.core.log(tx, p.campaign_id, 'participation.reminded', { actor: SYSTEM }, p.id));
      }
    }
  }
}
