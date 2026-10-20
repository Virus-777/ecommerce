import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, Field, Icon, Img, KeyValue, Meter, PageHeader, Price, Select, Stat, StatusBadge, SummaryRow, TableWrap, Tabs, TextInput, announce } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import {
  DISCOUNT_TYPES,
  EMPTY_DISCOUNT,
  PARTICIPATION_TONE,
  adStatus,
  discountActions,
  discountRule,
  discountStatus,
  isAmount,
  isLaterPhase,
  isOpenInvitation,
  offersLabel,
  parsePT,
  participationState,
  bpsPercent,
  periodShort,
  retryUnlessLater,
  shortDay,
  weekdayPT,
  type DiscountDraft,
  type DiscountType,
  type Invitation,
  type SellerAdCampaign,
  type SellerDiscount,
} from './data/marketing';

// Design: pages/seller/seller-marketing.html · views: platform-campaigns, sponsored-ads (tabs).
// Data: promotions (GET/POST /api/seller/promotions/discounts, …/preview, …/{id}/schedule|pause|resume|end;
// GET /api/seller/promotions/invitations, …/{id}/accept (with the invitation's consentTextVersion)|decline|withdraw
// (reason optional)) and advertising (GET …/summary,
// …/campaigns, POST …/campaigns/{id}/pause|resume). Advertising is a launch-phase-3 module: while it answers
// 501 NOT_IMPLEMENTED the Sponsored ads tab says so and offers no actions.

type Tab = '' | 'platform-campaigns' | 'sponsored-ads';

const money = formatMoney;
const sk = <span className="sk sk-line" aria-hidden="true" />;

function LoadError({ error, retry, title }: { error: unknown; retry: () => void; title: string }) {
  return (
    <Alert tone="danger" title={title}>
      {errorMessage(error)}{' '}
      <Button variant="secondary" size="sm" onClick={retry}>
        Try again
      </Button>
    </Alert>
  );
}

/* ================================================================== discounts */

function draftErrors(d: DiscountDraft, price: number | null) {
  const e: Partial<Record<keyof DiscountDraft, string>> = {};
  const a = Number(d.amt);
  if (!d.name.trim()) e.name = 'Enter a name for the discount.';
  if (!isAmount(d.amt)) e.amt = d.type === 'Percentage off' ? 'Enter a percentage, like 10.' : 'Enter an amount in dollars, like 5.00.';
  else if (d.type === 'Percentage off' && a > 90) e.amt = 'Enter 90% or less.';
  else if (d.type === 'Fixed amount off' && price !== null && a * 100 >= price) e.amt = `Enter less than the price, ${money({ amount: price, currency: 'USD' })}.`;
  if (d.type === 'Minimum spend' && !isAmount(d.min)) e.min = 'Enter the minimum order in dollars, like 75.00.';
  if (!/^\d+$/.test(d.limit.trim()) || Number(d.limit) < 1) e.limit = 'Enter a whole number of units, 1 or more.';
  if (!d.offerId) e.offerId = 'Choose an offer.';
  const s = parsePT(d.start);
  const en = parsePT(d.end, { endOfDay: true });
  if (!d.start.trim()) e.start = 'Enter a start date and time.';
  else if (!s) e.start = 'Use a date like Nov 20, 2026, 12:00 AM.';
  if (!d.end.trim()) e.end = 'Enter an end date and time.';
  else if (!en) e.end = 'Use a date like Nov 30, 2026, 11:59 PM.';
  else if (s && en <= s) e.end = 'End after the start.';
  return e;
}

const FIELD_OF: Record<string, keyof DiscountDraft> = { name: 'name', discount: 'amt', 'discount.percentOffBps': 'amt', 'discount.amountOff': 'amt', 'discount.minSpend': 'min', offerIds: 'offerId', startsAt: 'start', endsAt: 'end', perCustomerUnits: 'limit' };

function DiscountsTab() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { sellerId, can } = useSellerSession();
  const canManage = can('promotions.discounts.manage');
  const list = useQuery({ queryKey: ['promotions', 'discounts', sellerId], queryFn: () => call(api.GET('/api/seller/promotions/discounts', { params: { query: { page: 1, limit: 100 } } })) });
  const offers = useQuery({ queryKey: ['offers', 'list', sellerId, { status: 'active', limit: 100 }], queryFn: () => call(api.GET('/api/seller/offers/offers', { params: { query: { status: 'active', page: 1, limit: 100 } } })) });
  const offerRows = offers.data?.items ?? [];

  const [d, setD] = useState<DiscountDraft>(EMPTY_DISCOUNT);
  const [tried, setTried] = useState(false);
  const [notice, setNotice] = useState('');
  const [serverErrs, setServerErrs] = useState<Partial<Record<keyof DiscountDraft, string>>>({});
  const set = <K extends keyof DiscountDraft>(k: K, v: DiscountDraft[K]) => (setD((p) => ({ ...p, [k]: v })), setServerErrs((s) => ({ ...s, [k]: undefined })));
  useEffect(() => {
    if (!d.offerId && offerRows[0]) setD((p) => ({ ...p, offerId: offerRows[0].offer.id }));
  }, [d.offerId, offerRows]);

  const offer = offerRows.find((o) => o.offer.id === d.offerId)?.offer;
  const price = offer?.price ?? null;
  const errs = { ...(tried ? draftErrors(d, price?.amount ?? null) : {}), ...serverErrs };
  const rule = discountRule(d, price?.currency);
  const isPct = d.type === 'Percentage off';
  const isFixed = d.type === 'Fixed amount off';

  const preview = useQuery({
    queryKey: ['promotions', 'preview', d.offerId, rule],
    queryFn: () => call(api.POST('/api/seller/promotions/discounts/preview', { body: { offerId: d.offerId, discount: rule!.discount } })),
    enabled: !!d.offerId && !!rule,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['promotions', 'discounts', sellerId] });
  const create = useMutation({
    mutationFn: async (schedule: boolean) => {
      const r = discountRule(d, price?.currency)!;
      const created = await call(
        api.POST('/api/seller/promotions/discounts', {
          body: {
            name: d.name.trim(),
            kind: r.kind,
            discount: r.discount,
            offerIds: [d.offerId],
            startsAt: parsePT(d.start)!,
            endsAt: parsePT(d.end, { endOfDay: true })!,
            timeZone: 'America/Los_Angeles',
            perCustomerUnits: Number(d.limit),
            combinesWithPlatformCoupons: d.stack,
          },
        }),
      );
      if (schedule) return call(api.POST('/api/seller/promotions/discounts/{id}/schedule', { params: { path: { id: created.campaign.id } } }));
      return created;
    },
    onSuccess: async (x, schedule) => {
      setNotice(schedule ? `“${x.campaign.name}” is scheduled from ${x.campaign.period.display.split(' – ')[0]}.` : `“${x.campaign.name}” saved as a draft.`);
      announce(schedule ? 'Discount scheduled' : 'Discount saved as draft');
      setD({ ...EMPTY_DISCOUNT, offerId: d.offerId });
      setTried(false);
      await refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VALIDATION_FAILED') setServerErrs(Object.fromEntries(Object.entries(e.fieldErrors).map(([k, v]) => [FIELD_OF[k] ?? FIELD_OF[k.split('.')[0]] ?? 'name', v])));
      void refresh();
    },
  });
  const submit = (schedule: boolean) => {
    setTried(true);
    setNotice('');
    if (Object.keys(draftErrors(d, price?.amount ?? null)).length) return;
    create.mutate(schedule);
  };

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'schedule' | 'pause' | 'resume' | 'end' }) => {
      const params = { params: { path: { id } } };
      if (action === 'schedule') return call(api.POST('/api/seller/promotions/discounts/{id}/schedule', params));
      if (action === 'pause') return call(api.POST('/api/seller/promotions/discounts/{id}/pause', params));
      if (action === 'resume') return call(api.POST('/api/seller/promotions/discounts/{id}/resume', params));
      return call(api.POST('/api/seller/promotions/discounts/{id}/end', { ...params, body: {} }));
    },
    onSuccess: async (x, v) => {
      announce(`${x.campaign.name}: ${v.action === 'end' ? 'ended' : v.action === 'schedule' ? 'scheduled' : v.action === 'pause' ? 'paused' : 'resumed'}`);
      await refresh();
    },
  });
  const ACTION_LABEL = { schedule: 'Schedule', pause: 'Pause', resume: 'Resume', end: 'End' } as const;
  const rows: SellerDiscount[] = list.data?.items ?? [];
  const pv = preview.data;

  return (
    <div className="sb-main">
      <Card
        title="Your discounts"
        sub="Discounts you create are funded by you and lower the fee basis"
        flush
        actions={
          canManage ? (
            <Button size="sm" icon="plus" onClick={() => document.getElementById('mk-name')?.focus()}>
              Create discount
            </Button>
          ) : undefined
        }
      >
        {list.isError ? (
          <div className="card-body">
            <LoadError title="We couldn’t load your discounts" error={list.error} retry={() => void list.refetch()} />
          </div>
        ) : (
          <>
            {act.isError && (
              <div className="card-body">
                <Alert tone="danger">{errorMessage(act.error)}</Alert>
              </div>
            )}
            <TableWrap label="Your discounts table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Discount</th>
                    <th scope="col">Offers</th>
                    <th scope="col">Type</th>
                    <th scope="col">Period (PT)</th>
                    <th scope="col">Funding</th>
                    <th scope="col">Status</th>
                    <th className="r col-pin" scope="col">
                      Used
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.isPending &&
                    Array.from({ length: 3 }, (_, i) => (
                      <tr key={i} className="sk-row" aria-hidden="true">
                        <td colSpan={7}>{sk}</td>
                      </tr>
                    ))}
                  {rows.map((x) => {
                    const actions = canManage ? discountActions(x.campaign.status) : [];
                    return (
                      <tr key={x.campaign.id}>
                        <td>
                          <span className="small strong">{x.campaign.name}</span>
                          {x.campaign.nextAction && (
                            <>
                              <br />
                              <span className="xs muted">{x.campaign.nextAction}</span>
                            </>
                          )}
                        </td>
                        <td>
                          <span className="small minw-200 inline-block">{offersLabel(x.offers)}</span>
                        </td>
                        <td>
                          <span className="small t-deal-text strong nowrap">{x.discountLabel}</span>
                        </td>
                        <td>
                          <span className="small nowrap">{periodShort(x.campaign.period.display)}</span>
                        </td>
                        <td>
                          <Badge tone="outline">{x.campaign.fundingLabel}</Badge>
                        </td>
                        <td>
                          <StatusBadge status={discountStatus(x.campaign.status)} />
                          {actions.length > 0 && (
                            <span className="row gap-1 mt-1">
                              {actions.map((a) => (
                                <Button key={a} variant="ghost" size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: x.campaign.id, action: a })}>
                                  {ACTION_LABEL[a]}
                                  <span className="sr-only"> {x.campaign.name}</span>
                                </Button>
                              ))}
                            </span>
                          )}
                        </td>
                        <td className="r col-pin">
                          <span className="small num">{x.usedOrders ? `${x.usedOrders} order${x.usedOrders === 1 ? '' : 's'}` : '—'}</span>
                        </td>
                      </tr>
                    );
                  })}
                  {!list.isPending && !rows.length && (
                    <tr>
                      <td colSpan={7}>
                        <span className="small sub">No discounts yet. Create one to lower the price of your offers for a set time.</span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </TableWrap>
          </>
        )}
      </Card>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h3 className="h4">Create a discount</h3>
            <span className="xs muted">Preview before it goes live</span>
          </div>
        </div>
        <fieldset className="card-body fieldset-reset" disabled={!canManage}>
          {!canManage && <Alert tone="info">Your role can view discounts but not create or change them.</Alert>}
          {notice && <Alert tone="success" title={notice} />}
          {create.isError && !(create.error instanceof ApiError && create.error.code === 'VALIDATION_FAILED') && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
          <Field label="Discount name" hint="Only you see this name." error={errs.name}>
            <TextInput id="mk-name" value={d.name} error={!!errs.name} placeholder="" onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Type">
            <Select id="mk-type" options={[...DISCOUNT_TYPES]} value={d.type} onChange={(e) => set('type', e.target.value as DiscountType)} />
          </Field>
          <div className="sb-form-grid">
            <Field label={d.type === 'Free shipping' ? 'Free shipping on orders over' : 'Amount'} error={errs.amt}>
              <TextInput id="mk-amt" value={d.amt} error={!!errs.amt} placeholder="" inputMode="decimal" prefix={isPct ? undefined : '$'} suffix={isPct ? '%' : undefined} onChange={(e) => set('amt', e.target.value)} />
            </Field>
            <Field label="Limit per customer" error={errs.limit}>
              <TextInput id="mk-limit" value={d.limit} error={!!errs.limit} placeholder="" inputMode="numeric" suffix="units" onChange={(e) => set('limit', e.target.value)} />
            </Field>
          </div>
          {d.type === 'Minimum spend' && (
            <Field label="Minimum order" hint="Your items in the customer’s package" error={errs.min}>
              <TextInput id="mk-min" value={d.min} error={!!errs.min} placeholder="" inputMode="decimal" prefix="$" onChange={(e) => set('min', e.target.value)} />
            </Field>
          )}
          <Field label="Offers" error={errs.offerId} hint={offers.isError ? errorMessage(offers.error) : !offers.isPending && !offerRows.length ? 'You have no active offers to discount.' : undefined}>
            <Select
              id="mk-offers"
              options={offers.isPending ? [{ value: '', label: 'Loading your offers…' }] : offerRows.map((o) => ({ value: o.offer.id, label: `${o.offer.productTitle}${o.offer.variantLabel ? `, ${o.offer.variantLabel}` : ''} · ${money(o.offer.price)}` }))}
              value={d.offerId}
              onChange={(e) => set('offerId', e.target.value)}
            />
          </Field>
          <div className="sb-form-grid">
            <Field label="Starts" hint={errs.start ? undefined : 'Pacific time, like Nov 20, 2026, 12:00 AM'} error={errs.start}>
              <TextInput id="mk-start" icon="calendar" value={d.start} error={!!errs.start} placeholder="" onChange={(e) => set('start', e.target.value)} />
            </Field>
            <Field label="Ends" error={errs.end}>
              <TextInput id="mk-end" icon="calendar" value={d.end} error={!!errs.end} placeholder="" onChange={(e) => set('end', e.target.value)} />
            </Field>
          </div>
          <Checkbox id="mk-stack" label="Can combine with Marketly coupons (platform-funded part never comes from you)" checked={d.stack} onChange={(e) => set('stack', e.target.checked)} />
          <div className="panel stack gap-1">
            <span className="xs muted">Customer sees</span>
            {pv ? (
              <>
                {isPct || isFixed ? <Price amount={pv.customerPrice.amount / 100} was={pv.customerPrice.amount < pv.regularPrice.amount ? pv.regularPrice.amount / 100 : null} /> : <Price amount={pv.regularPrice.amount / 100} />}
                <span className="xs sub">
                  {pv.earnings.explanation}
                  {pv.earnings.isExample ? ' Example rate.' : ''}
                </span>
              </>
            ) : price ? (
              <>
                <Price amount={price.amount / 100} />
                <span className="xs sub">{preview.isError ? errorMessage(preview.error) : 'Enter an amount to see the price and your earnings per unit.'}</span>
              </>
            ) : (
              sk
            )}
          </div>
        </fieldset>
        {canManage && (
          <div className="card-foot">
            <Button variant="ghost" onClick={() => submit(false)} disabled={create.isPending}>
              Save draft
            </Button>
            <Button onClick={() => submit(true)} disabled={create.isPending}>
              Schedule discount
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

/* ================================================================== platform campaigns */

function InvitationView({ inv }: { inv: Invitation }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { sellerId, can } = useSellerSession();
  const canJoin = can('promotions.campaigns.join');
  const p = inv.participation;
  const c = inv.campaign;
  const state = p.state;
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(p.offers.map((o) => [o.offerId, o.included && o.eligible])));
  const [consent, setConsent] = useState(false);
  const [leaveReason, setLeaveReason] = useState('');
  const chosen = p.offers.filter((o) => o.eligible && picked[o.offerId]);
  const nPicked = chosen.length;
  const sample = chosen[0] ?? p.offers.find((o) => o.eligible) ?? p.offers[0];
  const impact = sample?.earnings ?? p.earningsExample ?? null;
  const joined = state === 'accepted' || state === 'withdrawal_requested';
  const open = state === 'invited' || state === 'declined';

  const refresh = () => qc.invalidateQueries({ queryKey: ['promotions', 'invitations', sellerId] });
  const accept = useMutation({
    mutationFn: () => call(api.POST('/api/seller/promotions/invitations/{id}/accept', { params: { path: { id: p.id } }, body: { offerIds: chosen.map((o) => o.offerId), consent: true, consentTextVersion: inv.consentTextVersion } })),
    onSuccess: async () => (announce(`Joined ${c.name}`), await refresh()),
  });
  const decline = useMutation({
    mutationFn: () => call(api.POST('/api/seller/promotions/invitations/{id}/decline', { params: { path: { id: p.id } }, body: {} })),
    onSuccess: async () => (announce('Invitation declined'), await refresh()),
  });
  const withdraw = useMutation({
    mutationFn: () => call(api.POST('/api/seller/promotions/invitations/{id}/withdraw', { params: { path: { id: p.id } }, body: leaveReason.trim() ? { reason: leaveReason.trim() } : {} })),
    onSuccess: async () => (announce(`You asked to leave ${c.name}`), await refresh()),
  });
  const err = accept.error ?? decline.error ?? withdraw.error;
  const busy = accept.isPending || decline.isPending || withdraw.isPending;
  const start = shortDay(c.period.startsAt.slice(0, 10));

  return (
    <div className="sb-main">
      <div className="stack gap-5">
        <section className="card">
          <div className="card-head">
            <div className="stack gap-0">
              <h2 className="h4">
                Invitation: {c.name}{' '}
                {p.respondBy && state === 'invited' && (
                  <Badge tone="warning" icon="clock">
                    Join by {weekdayPT(p.respondBy)}
                  </Badge>
                )}
              </h2>
              <span className="xs muted">Platform campaign · {c.period.display} · run by Marketly Marketing</span>
            </div>
          </div>
          <div className="card-body">
            {c.banner?.url ? (
              <div className="imgph wide tint-3" style={{ aspectRatio: '5/1' }}>
                <img src={c.banner.url} alt={c.banner.alt ?? ''} />
              </div>
            ) : (
              <div className="imgph wide tint-3" style={{ aspectRatio: '5/1' }}>
                <Icon name="house" />
              </div>
            )}
            {(c.description || c.featuredOn.length > 0) && (
              <p className="small sub">
                {c.description}
                {c.featuredOn.length > 0 ? ` Featured on: ${c.featuredOn.join(', ')}.` : ''}
              </p>
            )}
            <div className="grid md2 gap-4">
              <div className="stack gap-2">
                <span className="small strong">Eligibility</span>
                <ul className="sb-ticks ok">
                  {c.rules.map((t) => (
                    <li key={t}>
                      <Icon name="circle-check" />
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="stack gap-2">
                <span className="small strong">Who funds what</span>
                <KeyValue
                  pairs={[
                    ['Campaign discount', c.discountLabel],
                    ['You fund', `${bpsPercent(c.funding.sellerFundsBps)} of the price`],
                    ['Marketly funds', `${bpsPercent(c.funding.platformFundsBps)} of the price`],
                    ['Fee basis', c.funding.feeBasisNote],
                  ]}
                />
              </div>
            </div>
          </div>
        </section>
        <Card title="Choose offers" titleAs="h3" sub="Only eligible offers can join" flush>
          <TableWrap label="Choose offers table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                  <th scope="col">Offer</th>
                  <th scope="col">Stock</th>
                  <th className="col-pin" scope="col">
                    Eligibility
                  </th>
                </tr>
              </thead>
              <tbody>
                {p.offers.map((o) => (
                  <tr key={o.offerId} className={cx(picked[o.offerId] && o.eligible && 'is-selected')}>
                    <td>
                      <input type="checkbox" id={`mk-o-${o.offerId}`} aria-label={`Include ${o.title}`} checked={o.eligible && !!picked[o.offerId]} disabled={!o.eligible || !open || !canJoin} onChange={(e) => setPicked((s) => ({ ...s, [o.offerId]: e.target.checked }))} />
                    </td>
                    <td>
                      <label htmlFor={`mk-o-${o.offerId}`} className="row gap-3 nowrap minw-240">
                        <Img icon="package" tint="2" className="tiny" src={o.image?.url ?? undefined} alt="" />
                        <span className="stack gap-0">
                          <span className="small strong">{o.title}</span>
                          {o.sku && (
                            <span className="xs muted mono nowrap" title={o.sku}>
                              {o.sku}
                            </span>
                          )}
                        </span>
                      </label>
                    </td>
                    <td>
                      <span className="num small">{o.stock}</span>
                    </td>
                    <td className="col-pin">
                      {o.eligible ? (
                        <Badge tone="success">Eligible</Badge>
                      ) : (
                        <span className="stack gap-1">
                          <Badge tone="danger">Not eligible</Badge>
                          {o.ineligibleReasons.map((r) => (
                            <span key={r} className="xs muted">
                              {r}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {!p.offers.length && (
                  <tr>
                    <td colSpan={4}>
                      <span className="small sub">None of your offers are in this campaign’s categories.</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      </div>
      <div className="stack gap-5">
        {impact && sample && (
          <Card title="Expected impact per unit" titleAs="h3" sub={sample.title}>
            <div className="sb-recon">
              <SummaryRow k="Regular price" v={money(impact.basePrice)} />
              <SummaryRow k="Campaign price for customers" v={<span className="t-deal-text strong">{money(impact.customerPays)}</span>} />
              <SummaryRow k={`You fund (${bpsPercent(c.funding.sellerFundsBps)})`} v={<span className="sb-neg">−{money(impact.sellerFunds)}</span>} />
              <SummaryRow k={`Marketly funds (${bpsPercent(c.funding.platformFundsBps)})`} v={money(impact.platformFunds)} />
              <SummaryRow k={`Fee, ${bpsPercent(impact.feeRateBps)} of ${money(impact.feeBasis)}`} v={<span className="sb-neg">−{money(impact.fee)}</span>} />
              <SummaryRow className="total" k="Your earnings per unit" v={<b>{money(impact.sellerEarns)}</b>} />
              <SummaryRow k="Regular earnings per unit" v={money(impact.regularSellerEarns)} />
            </div>
            <span className="xs muted">
              {impact.isExample ? 'Example only. ' : ''}
              {inv.salesNote ?? impact.explanation}
            </span>
          </Card>
        )}
        <section className="card">
          <div className="card-head">
            <div className="stack gap-0">
              <h3 className="h4">Join {c.name}</h3>
            </div>
          </div>
          <div className="card-body">
            {err && <Alert tone="danger">{errorMessage(err)}</Alert>}
            {!canJoin && <Alert tone="info">Your role can’t join platform campaigns.</Alert>}
            {state === 'accepted' && (
              <Alert tone="success" title={`You joined ${c.name}`}>
                {p.offerCount} offer{p.offerCount === 1 ? '' : 's'} show the campaign price from {start}.
              </Alert>
            )}
            {state === 'withdrawal_requested' && <Alert tone="warning" title="You asked to leave">Marketly Marketing reviews your request.{p.reason ? ` Reason: ${p.reason}` : ''}</Alert>}
            {state === 'declined' && <Alert tone="info" title="Invitation declined">{p.respondBy ? `You can still join until ${weekdayPT(p.respondBy)}.` : 'You can still join while the invitation is open.'}</Alert>}
            {open ? (
              <Checkbox
                id="mk-consent"
                label={
                  inv.consentText ||
                  `I agree to fund ${bpsPercent(c.funding.sellerFundsBps)} of the price on the ${nPicked} selected offer${nPicked === 1 ? '' : 's'} during ${c.period.display}, and not to raise their prices during the campaign. Marketly funds the other ${bpsPercent(c.funding.platformFundsBps)}.`
                }
                checked={consent}
                disabled={!canJoin}
                onChange={(e) => setConsent(e.target.checked)}
              />
            ) : (
              p.consentText && <p className="xs sub">{`You agreed${p.consentedAt ? ` on ${weekdayPT(p.consentedAt)}` : ''}: ${p.consentText}`}</p>
            )}
            {state === 'accepted' && canJoin && (
              <Field label="Reason for leaving" optional>
                <TextInput id="mk-leave" value={leaveReason} onChange={(e) => setLeaveReason(e.target.value)} />
              </Field>
            )}
            <span className="xs muted">{inv.leavePolicy}</span>
          </div>
          {canJoin && (
            <div className="card-foot">
              {joined ? (
                state === 'accepted' && (
                  <Button variant="ghost" disabled={busy} onClick={() => withdraw.mutate()}>
                    Leave campaign
                  </Button>
                )
              ) : (
                <>
                  {state === 'invited' && (
                    <Button variant="ghost" disabled={busy} onClick={() => decline.mutate()}>
                      Decline
                    </Button>
                  )}
                  <Button disabled={!consent || nPicked === 0 || busy} onClick={() => accept.mutate()}>
                    Join campaign
                  </Button>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function CampaignsTab({ invitations }: { invitations: ReturnType<typeof useInvitations> }) {
  const items = invitations.data?.items ?? [];
  const open = items.filter(isOpenInvitation);
  const past = items.filter((i) => !isOpenInvitation(i));
  if (invitations.isError) return <LoadError title="We couldn’t load campaign invitations" error={invitations.error} retry={() => void invitations.refetch()} />;
  if (invitations.isPending)
    return (
      <div className="sb-main" aria-busy="true">
        <div className="sk sk-card" />
        <div className="sk sk-card" />
      </div>
    );
  return (
    <div className="stack gap-5">
      {open.length ? (
        open.map((i) => <InvitationView key={i.participation.id} inv={i} />)
      ) : (
        <section className="card">
          <div className="card-body">
            <EmptyState icon="megaphone" title="No campaign invitations right now">
              When Marketly Marketing plans a campaign your offers fit, the invitation shows here with its rules, who funds what and the date to join by.
            </EmptyState>
          </div>
        </section>
      )}
      {past.length > 0 && (
        <Card title="Past campaigns" titleAs="h3" flush>
          <ul className="list pad">
            {past.map((i) => {
              const label = participationState(i.participation.state);
              return (
                <li key={i.participation.id}>
                  <span className="grow stack gap-0">
                    <span className="small strong">{i.campaign.name}</span>
                    <span className="xs muted">
                      {periodShort(i.campaign.period.display)} · {i.participation.offerCount} offer{i.participation.offerCount === 1 ? '' : 's'} · you funded {bpsPercent(i.participation.sellerShareBps)}
                    </span>
                  </span>
                  <StatusBadge status={new Date(i.campaign.period.endsAt).getTime() < Date.now() && i.participation.state === 'accepted' ? 'Finished' : label} tone={PARTICIPATION_TONE[label] || undefined} />
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

function useInvitations() {
  const { api } = useApi();
  const { sellerId } = useSellerSession();
  return useQuery({ queryKey: ['promotions', 'invitations', sellerId], queryFn: () => call(api.GET('/api/seller/promotions/invitations', { params: { query: { page: 1, limit: 50 } } })) });
}

/* ================================================================== sponsored ads */

function AdsTab({ campaigns }: { campaigns: ReturnType<typeof useAdCampaigns> }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { sellerId, can } = useSellerSession();
  const canManage = can('advertising.requests.manage');
  const summary = useQuery({ queryKey: ['advertising', 'summary', sellerId], queryFn: () => call(api.GET('/api/seller/advertising/summary')), retry: retryUnlessLater });
  const later = isLaterPhase(campaigns.error) || isLaterPhase(summary.error);
  const toggle = useMutation({
    mutationFn: (x: SellerAdCampaign) =>
      x.campaign.status === 'live'
        ? call(api.POST('/api/seller/advertising/campaigns/{id}/pause', { params: { path: { id: x.campaign.id } } }))
        : call(api.POST('/api/seller/advertising/campaigns/{id}/resume', { params: { path: { id: x.campaign.id } } })),
    onSuccess: async (x) => {
      announce(`${x.campaign.name} ${x.campaign.status === 'paused' ? 'paused' : 'resumed'}`);
      await qc.invalidateQueries({ queryKey: ['advertising'] });
    },
  });
  const rows = campaigns.data?.items ?? [];
  const s = summary.data;

  if (later)
    return (
      <Alert tone="info" title="Sponsored ads aren’t available yet">
        Marketly opens sponsored product and store campaigns in a later launch phase. Requests, spend and results will show here once they do.
      </Alert>
    );

  return (
    <>
      <Alert tone="info" title="Paid ads are labeled Sponsored for customers">
        Marketly reviews every request before it runs. Ad charges appear on your statement separately from sales commission. Paid campaigns bring attention to an offer and never guarantee purchases.
      </Alert>
      <Card
        title="Sponsored ads"
        sub="Spend this campaign against your total limit"
        flush
        actions={
          canManage ? (
            <Button size="sm" icon="plus" to={href('seller/ad-request')}>
              Request a sponsored campaign
            </Button>
          ) : undefined
        }
      >
        {campaigns.isError ? (
          <div className="card-body">
            <LoadError title="We couldn’t load your sponsored campaigns" error={campaigns.error} retry={() => void campaigns.refetch()} />
          </div>
        ) : (
          <>
            {toggle.isError && (
              <div className="card-body">
                <Alert tone="danger">{errorMessage(toggle.error)}</Alert>
              </div>
            )}
            <TableWrap label="Sponsored ads table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Campaign</th>
                    <th scope="col">Type</th>
                    <th scope="col">Promotes</th>
                    <th scope="col">Schedule</th>
                    <th scope="col">Billing</th>
                    <th scope="col">Status</th>
                    <th scope="col">Spend vs limit</th>
                    <th className="col-pin" scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.isPending &&
                    Array.from({ length: 3 }, (_, i) => (
                      <tr key={i} className="sk-row" aria-hidden="true">
                        <td colSpan={8}>{sk}</td>
                      </tr>
                    ))}
                  {rows.map((x) => {
                    const pctUsed = x.totalLimit.amount ? Math.round((x.spend.amount / x.totalLimit.amount) * 100) : 0;
                    const near = pctUsed >= 90;
                    const st = x.campaign.status;
                    const canToggle = canManage && ((st === 'live' && x.campaign.allowedActions.includes('pause')) || (st === 'paused' && x.campaign.allowedActions.includes('resume')));
                    return (
                      <tr key={x.campaign.id}>
                        <td>
                          <Link className="small strong" to={href('seller/ad-request', st === 'draft' ? '' : 'in-review', undefined, { id: x.campaign.id })}>
                            {x.campaign.name}
                          </Link>
                        </td>
                        <td>
                          <span className="small nowrap">{x.campaign.placementName}</span>
                        </td>
                        <td>
                          <span className="small minw-180 inline-block">{x.promotes}</span>
                        </td>
                        <td>
                          <span className="small nowrap">{x.campaign.periodLabel}</span>
                        </td>
                        <td>
                          <span className="xs sub nowrap">{x.billingLabel}</span>
                        </td>
                        <td>
                          <StatusBadge status={adStatus(st)} />
                          {x.campaign.statusNote && (
                            <>
                              <br />
                              <span className="xs muted">{x.campaign.statusNote}</span>
                            </>
                          )}
                        </td>
                        <td>
                          <div className="stack gap-1 minw-140">
                            <span className="xs num">
                              {money(x.spend)} of {money(x.totalLimit)}
                            </span>
                            <Meter pct={pctUsed} tone={near ? 'warning' : undefined} label={`Spend vs limit: ${x.campaign.name}`} />
                            {near && <span className="xs strong meter-note t-warning-text">Near target</span>}
                          </div>
                        </td>
                        <td className="col-pin">
                          {canToggle && (
                            <Button variant="ghost" size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate(x)}>
                              {st === 'live' ? 'Pause' : 'Resume'}
                              <span className="sr-only"> {x.campaign.name}</span>
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {!campaigns.isPending && !rows.length && (
                    <tr>
                      <td colSpan={8}>
                        <span className="small sub">No sponsored campaigns yet.</span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </TableWrap>
          </>
        )}
      </Card>
      {summary.isError ? (
        <LoadError title="We couldn’t load ad results" error={summary.error} retry={() => void summary.refetch()} />
      ) : (
        <div className="grid md3 gap-4">
          <div className="card pad">
            <Stat label={s ? `Ad spend, ${shortDay(s.range.from)}–${shortDay(s.range.to)}` : 'Ad spend'} value={s ? money(s.spend) : '…'} note={s?.statementNote ?? 'Shown on statements as ad charges'} />
          </div>
          <div className="card pad">
            <Stat label="Clicks" value={s ? String(s.clicks) : '…'} note="All sponsored campaigns" />
          </div>
          <div className="card pad">
            <Stat label="Attributed orders" value={s ? String(s.attributedOrders) : '…'} note={s ? `Ordered within ${s.attributionDays} days of a click` : ''} />
          </div>
        </div>
      )}
    </>
  );
}

function useAdCampaigns() {
  const { api } = useApi();
  const { sellerId } = useSellerSession();
  return useQuery({ queryKey: ['advertising', 'campaigns', sellerId], queryFn: () => call(api.GET('/api/seller/advertising/campaigns', { params: { query: { page: 1, limit: 50 } } })), retry: retryUnlessLater });
}

/* ================================================================== page */

export default function Marketing() {
  const [view, setView] = useView<Exclude<Tab, ''>>();
  const tab: Tab = view === 'platform-campaigns' || view === 'sponsored-ads' ? view : '';
  const { api } = useApi();
  const { sellerId } = useSellerSession();
  const discounts = useQuery({ queryKey: ['promotions', 'discounts', sellerId], queryFn: () => call(api.GET('/api/seller/promotions/discounts', { params: { query: { page: 1, limit: 100 } } })) });
  const invitations = useInvitations();
  const ads = useAdCampaigns();

  const tabs = [
    { value: '' as Tab, label: 'Discounts', count: discounts.data ? discounts.data.items.filter((x) => !['ended', 'cancelled'].includes(x.campaign.status)).length : undefined },
    { value: 'platform-campaigns' as Tab, label: 'Platform campaigns', count: invitations.data ? invitations.data.items.filter((i) => i.participation.state === 'invited').length : undefined },
    { value: 'sponsored-ads' as Tab, label: 'Sponsored ads', count: ads.data ? ads.data.items.length : undefined },
  ];

  return (
    <SellerLayout active="marketing">
      <PageHeader title="Marketing and ads" sub="Discounts you fund, Marketly campaigns you can join and sponsored ads you can request." />
      <div className="u-mb-calc--1-x-sp-2">
        <Tabs items={tabs} active={tab} onChange={(v) => setView(v as Exclude<Tab, ''>)} />
      </div>
      {tab === '' && <DiscountsTab />}
      {tab === 'platform-campaigns' && <CampaignsTab invitations={invitations} />}
      {tab === 'sponsored-ads' && <AdsTab campaigns={ads} />}
    </SellerLayout>
  );
}
