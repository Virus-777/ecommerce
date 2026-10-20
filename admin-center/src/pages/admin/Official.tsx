import { fromZonedInput, zonedInput } from '@marketly/web-shared/lib/dates';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { formatMoney, money, num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, Button, Card, ChartFrame, Dialog, EmptyState, Field, fmtMoney, fmtMoneyCompact, Icon, Img, PageHeader, Pager, PeriodControl, Price, SearchInput, Select, seriesTable, Stat, TrendChart, usePeriod, type ChartRow,
  StatusBadge, SummaryRow, TableWrap, Textarea, TextInput, type IconName,
} from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { date, dateTime, LoadError, shortDate, SkeletonLines } from '@/app/parts';
import { flattenCategories, type CategoryNode } from './data/catalog';
import { pendingNote, priceLimitPct, STATUS_FILTERS, STATUS_LABEL, type OfficialRow, type PriceChange } from './data/official';

// Design: pages/admin/admin-official.html (trading + company offers) ·
// view "price-change" = the Change price dialog (?view=price-change&offer=<offerId>).
// API: GET /api/admin/finance/trading (KPIs, daily sales), GET /api/admin/offers/official/offers (offers.official.view; unitCost and
// marginPct from the recorded buying cost; stock.state and lowStockThreshold for low stock), GET /api/admin/offers/offers?productId
// (other offers), POST /api/admin/offers/official/offers/{id}/price-changes (approval above the caller's limit, from access/me limits).

type View = 'price-change';

// GET finance/trading takes any from–to range and compares with the days just before it, so the period control
// offers ranges only (no grain, no comparison choice).
const TRADING_PRESETS = ['today', 'last_7_days', 'last_14_days', 'last_30_days', 'last_90_days', 'month_to_date', 'quarter_to_date', 'year_to_date', 'last_12_months', 'custom'] as const;
const SALES_SERIES = [{ key: 'sales', label: 'Official Store' }];

const STOREFRONT: Array<{ icon: IconName; label: string; link: string; to: string }> = [
  { icon: 'layout-template', label: 'Official Store page', link: 'View', to: href('store/official') },
  { icon: 'layers', label: 'Featured collections', link: 'Manage', to: href('admin/content') },
  { icon: 'file-text', label: 'Service policies', link: 'Edit', to: href('admin/help-content') },
];

const MARGIN_WARN = 25;
const MARGIN_DANGER = 10;
const PAGE_SIZE = 20;

const k = (cents: number) => `$${(cents / 100_000).toFixed(1)}k`;
const pct = (v: number) => `${v.toFixed(1)}%`;
const marginOf = (price: number, cost: number) => ((price - cost) / price) * 100;
const signed = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}%`;
/** Now as a datetime-local value in Pacific Time (like every Admin Center date field). */
const localNow = () => zonedInput(new Date().toISOString());

interface Draft {
  newPrice: string;
  was: 'list' | 'none';
  start: string;
  end: string;
  reason: string;
}

function validate(d: Draft, o: OfficialRow) {
  const e: Partial<Record<keyof Draft, string>> = {};
  const np = Number(d.newPrice);
  const price = o.offer.price.amount / 100;
  const cost = o.unitCost ? o.unitCost.amount / 100 : null;
  const was = o.offer.compareAt ? o.offer.compareAt.amount / 100 : null;
  if (!d.newPrice.trim() || !Number.isFinite(np) || np <= 0) e.newPrice = 'Enter the new price in dollars, like 179.00.';
  else if (Math.abs(np - price) < 0.005) e.newPrice = 'Enter a price different from the current price.';
  else if (cost != null && np < cost) e.newPrice = `Below the buying cost of ${money(cost)}. Official Store offers can't be priced at a loss.`;
  if (!e.newPrice && d.was === 'list' && was != null && np >= was) e.was = 'The was-price must be higher than the new price. Choose None.';
  if (!d.start.trim()) e.start = 'Enter when the new price starts.';
  if (d.end && d.start && d.end <= d.start) e.end = 'The end must be after the start.';
  if (!d.reason.trim()) e.reason = "Enter a reason. It's recorded in Action history.";
  return e;
}

/** Low stock as the API reports it (the item's threshold, else the default low-stock threshold). */
const isLow = (s: OfficialRow['stock']) => s.available > 0 && (s.state === 'low_stock' || (s.lowStockThreshold != null && s.available <= s.lowStockThreshold));

function AvailableCell({ n, low }: { n: number; low: boolean }) {
  if (n === 0)
    return (
      <span className="stack gap-0">
        <span className="strong num t-danger-text">
          0<span className="xs"> · Out</span>
        </span>
        <span className="xs muted">Not sellable</span>
      </span>
    );
  if (low)
    return (
      <span className="stack gap-0">
        <span className="strong num t-warning-text">
          {n}
          <span className="xs"> · Low</span>
        </span>
        <span className="xs t-warning-text">Low stock</span>
      </span>
    );
  return <span className="strong num">{num(n)}</span>;
}

const nameOf = (o: OfficialRow) => `${o.offer.productTitle}${o.offer.variantLabel ? `, ${o.offer.variantLabel}` : ''}`;

export default function Official() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { accountId, can } = useStaffSession();
  const canPrice = can('offers.official.price');
  const canView = can('offers.official.view');
  const [view] = useView<View>();
  const [params, setParams] = useSearchParams();
  const period = usePeriod({ preset: 'last_14_days' });
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [cat, setCat] = useState('');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);

  /* ----- Trading ----- */
  const days = period.days;
  const range = period.range;
  const trading = useQuery({
    queryKey: ['finance', 'trading', range],
    enabled: can('finance.trading.view'),
    queryFn: () => call(api.GET('/api/admin/finance/trading', { params: { query: range } })),
    placeholderData: (prev) => prev,
  });
  const t = trading.data;
  const sales = t?.productSales.amount ?? 0;

  /* ----- Offers table ----- */
  const me = useQuery({ queryKey: ['access', 'me', accountId], queryFn: () => call(api.GET('/api/admin/access/me')) });
  const limit = priceLimitPct(me.data?.limits as Parameters<typeof priceLimitPct>[0]);
  const cats = useQuery({ queryKey: ['catalog', 'categories', 'admin'], queryFn: () => call(api.GET('/api/admin/catalog/categories')), enabled: can('catalog.view') });
  const filter = STATUS_FILTERS.find((f) => f.value === status) ?? STATUS_FILTERS[0];
  const query = { q: q.trim() || undefined, categoryId: cat || undefined, ...filter.query };
  const list = useQuery({
    queryKey: ['offers', 'official', 'list', query, page],
    queryFn: () => call(api.GET('/api/admin/offers/official/offers', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
    enabled: canView,
  });
  const rows = list.data?.items ?? [];
  const pageInfo = list.data as { total?: number; totalPages?: number } | undefined;

  /* ----- Price change dialog ----- */
  const open = view === 'price-change';
  const pcId = params.get('offer') ?? '';
  const offer = rows.find((o) => o.offer.id === pcId);
  const [draft, setDraft] = useState<Draft>({ newPrice: '', was: 'none', start: '', end: '', reason: '' });
  const [attempted, setAttempted] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const set = <K extends keyof Draft>(key: K, v: Draft[K]) => setDraft((d) => ({ ...d, [key]: v }));

  const others = useQuery({
    queryKey: ['offers', 'admin', 'product', offer?.offer.productId],
    enabled: open && !!offer,
    queryFn: () => call(api.GET('/api/admin/offers/offers', { params: { query: { productId: offer!.offer.productId, ownerType: 'seller', status: 'active', limit: 5 } } })),
  });
  const otherText = others.data
    ? others.data.items.length
      ? others.data.items.map((o) => `${o.seller.name} ${formatMoney(o.offer.price)}`).join(' · ')
      : 'None'
    : '…';

  const price = offer ? offer.offer.price.amount / 100 : 0;
  const cost = offer?.unitCost ? offer.unitCost.amount / 100 : null;
  const was = offer?.offer.compareAt ? offer.offer.compareAt.amount / 100 : null;
  const np = Number(draft.newPrice);
  const npValid = draft.newPrice.trim() !== '' && Number.isFinite(np) && np > 0;
  const change = npValid && price ? ((np - price) / price) * 100 : 0;
  const overLimit = npValid && limit !== null && Math.abs(change) > limit;
  const marginNow = cost != null && price ? marginOf(price, cost) : null;
  const marginAfter = cost != null && npValid ? marginOf(np, cost) : null;
  const errors = attempted && offer ? validate(draft, offer) : {};

  const openChange = (o: OfficialRow) => {
    setDraft({ newPrice: (o.offer.price.amount / 100).toFixed(2), was: o.offer.compareAt ? 'list' : 'none', start: localNow(), end: '', reason: '' });
    setAttempted(false);
    setSubmitError('');
    const next = new URLSearchParams(params);
    next.set('view', 'price-change');
    next.set('offer', o.offer.id);
    setParams(next);
  };
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete('offer');
    next.delete('view');
    setParams(next);
  };

  const priceM = useMutation({
    mutationFn: () => {
      const cents = Math.round(np * 100);
      const currency = offer!.offer.price.currency;
      return call(
        api.POST('/api/admin/offers/official/offers/{id}/price-changes', {
          params: { path: { id: offer!.offer.id } },
          body: {
            price: { amount: cents, currency },
            compareAt: draft.was === 'list' && offer!.offer.compareAt ? { amount: offer!.offer.compareAt, basis: 'list_price' } : null,
            startsAt: draft.start ? fromZonedInput(draft.start) : null,
            endsAt: draft.end ? fromZonedInput(draft.end) : null,
            reason: draft.reason.trim(),
          },
        }),
      ) as Promise<PriceChange>;
    },
    onSuccess: (pc) => {
      const short = offer!.offer.productTitle;
      setNotice(
        pc.state === 'pending_approval'
          ? { title: `Sent to ${pc.approval?.approvers.join(' or ') || 'the approver'} for approval`, body: `${short}: ${formatMoney(pc.from)} to ${formatMoney(pc.to)} (${signed(pc.changePct)}). It goes live only after it is approved.` }
          : pc.state === 'applied'
            ? { title: 'Price changed', body: `${offer!.offer.sellerSku} is now ${formatMoney(pc.to)} (was ${formatMoney(pc.from)}). Recorded in Action history.` }
            : { title: 'Price change scheduled', body: `${offer!.offer.sellerSku} changes from ${formatMoney(pc.from)} to ${formatMoney(pc.to)}${pc.startsAt ? ` on ${dateTime(pc.startsAt)} PT` : ''}. Recorded in Action history.` },
      );
      void qc.invalidateQueries({ queryKey: ['offers'] });
      void qc.invalidateQueries({ queryKey: ['access', 'me'] });
      close();
    },
    onError: (e) => setSubmitError(errorMessage(e)),
  });
  const submit = () => {
    if (!offer) return;
    setAttempted(true);
    setSubmitError('');
    if (Object.keys(validate(draft, offer)).length) return;
    priceM.mutate();
  };

  const daily = t?.daily ?? [];
  const salesRows: ChartRow[] = daily.map((d) => ({ x: d.date, label: shortDate(d.date), sales: d.sales.amount }));
  const catOptions = [{ value: '', label: 'All categories' }, ...flattenCategories((cats.data ?? []) as CategoryNode[])
      // The offers filter matches the exact category (no roll-up of subcategories), so only subcategories are offered.
      .filter((c) => c.label.includes(' › '))
      .map((c) => ({ value: c.id, label: c.label }))];

  return (
    <AdminLayout active="official">
      <PageHeader
        crumbs={[{ label: 'Official store' }, { label: 'Offers and trading' }]}
        title="Official Store"
        sub={`Company trading · ${date(range.from)} – ${date(range.to)}${t ? ` · cost basis: ${t.costBasis}` : ''}`}
        actions={
          <>
            <PeriodControl period={period} presets={[...TRADING_PRESETS]} noGrain noCompare idPrefix="ot" />
            <Button variant="secondary" size="sm" icon="chart-column" to={href('admin/report', '', { key: 'product-sales-and-margin' })}>
              Trading report
            </Button>
          </>
        }
      />

      {notice && (
        <Alert tone="success" title={notice.title}>
          {notice.body}
        </Alert>
      )}

      {trading.isError && <LoadError error={trading.error} onRetry={() => void trading.refetch()} title="We couldn’t load company trading" />}
      {!can('finance.trading.view') && (
        <Alert tone="info" title="Trading figures hidden">
          Company trading needs the Finance trading permission.
        </Alert>
      )}
      {can('finance.trading.view') && (
        <>
          <div className="aa-kpis">
            <Card pad>
              {t ? (
                <Stat label="Company sales" value={k(sales)} delta={t.salesChangePct != null ? pct(Math.abs(t.salesChangePct)) : undefined} dir={t.salesChangePct != null && t.salesChangePct < 0 ? 'down' : 'up'} good={(t.salesChangePct ?? 0) >= 0} note={`vs prior ${days} days`} />
              ) : (
                <SkeletonLines rows={1} />
              )}
            </Card>
            <Card pad>{t ? <Stat label="Gross margin" value={pct(t.grossMarginPct ?? 0)} note={`${k(t.grossMargin.amount)} after buying cost`} /> : <SkeletonLines rows={1} />}</Card>
            <Card pad>{t ? <Stat label="Discounts given" value={k(t.discounts.amount)} note={`${sales ? pct((t.discounts.amount / sales) * 100) : '0.0%'} of sales · company-funded`} /> : <SkeletonLines rows={1} />}</Card>
            <Card pad>
              {t ? (
                <Stat label="Returns" value={k(t.returnsCost.amount)} delta={t.returnsPctChangePts != null ? `${Math.abs(t.returnsPctChangePts).toFixed(1)} pts` : undefined} dir={(t.returnsPctChangePts ?? 0) > 0 ? 'up' : 'down'} good={(t.returnsPctChangePts ?? 0) <= 0} note={`${pct(t.returnsPctOfSales ?? 0)} of sales`} />
              ) : (
                <SkeletonLines rows={1} />
              )}
            </Card>
          </div>

          <div className="aa-split">
            <ChartFrame titleAs="h2" title="Company sales by day" sub="Official Store only · USD" loading={!t} refreshing={trading.isPlaceholderData} height={210} table={seriesTable(salesRows, SALES_SERIES, fmtMoney, { xLabel: 'Day' })}>
              <TrendChart rows={salesRows} series={SALES_SERIES} fmt={fmtMoney} axisFmt={fmtMoneyCompact} area height={210} label="Official Store daily sales" />
            </ChartFrame>
            <div className="stack gap-5">
              <Card title="Marketplace fee income" sub="Reported separately · not company trading" titleAs="h3">
                <span className="small sub">Marketplace fees on seller sales are not company revenue and are not in the figures on the left.</span>
                <Link className="small strong" to={href('admin/finance')}>
                  See fee income in Payments and fees
                </Link>
              </Card>
              <Card title="Storefront" sub="What customers see on the Official Store page" titleAs="h3">
                <ul className="list">
                  {STOREFRONT.map((s) => (
                    <li key={s.label}>
                      <Icon name={s.icon} className="ic-sm" />
                      <span className="grow small">{s.label}</span>
                      <Link className="small strong" to={s.to}>
                        {s.link}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
        </>
      )}

      <Card
        title="Company offers"
        sub={pageInfo?.total != null ? `${num(pageInfo.total)} offers · price, cost and sellable stock` : 'Price, cost and sellable stock'}
        flush
        actions={
          can('offers.official.manage') && (
            <>
              <Button variant="secondary" size="sm" icon="upload" disabled title="Official Store price files arrive with launch phase 2">
                Bulk price update
              </Button>
              <Button size="sm" icon="plus" disabled title="New Official Store offers are created from a company stock item; the form is not part of this design yet">
                Add offer
              </Button>
            </>
          )
        }
        footClassName="between"
        foot={
          <>
            <span className="xs muted">
              {limit === null ? 'Your price changes have no approval limit.' : limit === 0 ? 'Your price changes always need approval.' : `Your price change limit: up to ${limit}%. Larger changes need approval.`} Available excludes reserved and damaged stock.
            </span>
            <Pager page={page} total={Math.max(1, pageInfo?.totalPages ?? 1)} onPage={setPage} />
          </>
        }
      >
        <div className="card-body">
          <div className="toolbar">
            <SearchInput
              id="aa-of-q"
              placeholder="Search company offers by name or SKU"
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
            />
            <Select
              id="aa-of-st"
              aria-label="Status"
              options={STATUS_FILTERS.map((f) => ({ value: f.value, label: f.label }))}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            />
            <Select
              id="aa-of-cat"
              aria-label="Category"
              options={catOptions}
              value={cat}
              onChange={(e) => {
                setCat(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>
        {!canView && (
          <div className="card-body">
            <p className="small muted">Your role doesn’t include viewing Official Store offers.</p>
          </div>
        )}
        {list.isError && (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        )}
        <TableWrap label="Company offers table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th className="r" scope="col">Price</th>
                <th className="r" scope="col">Cost</th>
                <th className="r" scope="col">Margin</th>
                <th className="r" scope="col">Available</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {canView && list.isPending && (
                <tr>
                  <td colSpan={7}>
                    <SkeletonLines rows={5} />
                  </td>
                </tr>
              )}
              {rows.map((o) => {
                const m = o.marginPct;
                const avail = o.stock.available;
                const low = isLow(o.stock);
                const edge = avail === 0 ? 'flagged' : low || (m != null && m < MARGIN_WARN) ? 'warn' : '';
                const note = pendingNote(o.pendingPriceChange, shortDate, formatMoney) ?? o.note;
                return (
                  <tr key={o.offer.id} className={cx(edge && `is-${edge}`)}>
                    <td>
                      {edge && <span className="sr-only">{edge === 'flagged' ? 'Urgent: ' : 'At risk: '}</span>}
                      <span className="cell-main">
                        <Img icon="package" src={o.offer.image?.url ?? undefined} className="tiny" />
                        <span className="stack gap-0">
                          <span className="small strong clamp-2">{nameOf(o)}</span>
                          <span className="xs muted">
                            <span className="mono nowrap" title={o.offer.sellerSku ?? ''}>
                              {o.offer.sellerSku}
                            </span>
                            {note && ` · ${note}`}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="r">
                      <Price amount={o.offer.price.amount / 100} was={o.offer.compareAt ? o.offer.compareAt.amount / 100 : null} noOff />
                    </td>
                    <td className="r">{o.unitCost ? formatMoney(o.unitCost) : '—'}</td>
                    <td className="r">{m != null ? <span className={cx('strong', m < MARGIN_WARN && 't-warning-text')}>{pct(m)}</span> : <span className="muted">—</span>}</td>
                    <td className="r">
                      <AvailableCell n={avail} low={low} />
                    </td>
                    <td>
                      <StatusBadge status={STATUS_LABEL[o.offer.status]} />
                    </td>
                    <td>
                      {canPrice && (
                        <Button variant="ghost" size="sm" onClick={() => openChange(o)} disabled={o.pendingPriceChange?.state === 'pending_approval'}>
                          Change price
                          <span className="sr-only"> {o.offer.sellerSku}</span>
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {list.isSuccess && !rows.length && (
                <tr>
                  <td colSpan={7}>
                    <EmptyState icon="search-x" title="No company offers match">
                      Try another name or SKU, or clear the status and category filters.
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <p className="status-legend status-legend--edge">
          <span className="sr-only">Legend: </span>
          <span className="sl sl-danger">
            <i aria-hidden="true" />
            Red edge = urgent: out of stock
          </span>
          <span className="sl sl-warning">
            <i aria-hidden="true" />
            Amber edge = at risk: low stock or margin below {MARGIN_WARN}%
          </span>
        </p>
      </Card>

      <Dialog
        open={open && !!offer}
        onClose={close}
        size="lg"
        title={offer ? `Change price · ${offer.offer.productTitle}` : 'Change price'}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button icon={overLimit ? 'send' : 'check'} onClick={submit} disabled={priceM.isPending}>
              {overLimit ? 'Send for approval' : 'Schedule price change'}
            </Button>
          </>
        }
      >
        {offer && (
          <>
            {submitError && <Alert tone="danger" title={submitError} />}
            <div className="row nowrap gap-3">
              <Img icon="package" src={offer.offer.image?.url ?? undefined} className="thumb" />
              <div className="stack gap-0">
                <span className="strong">{nameOf(offer)}</span>
                <span className="xs muted">
                  Official Store offer · SKU <span className="mono">{offer.offer.sellerSku}</span> · {num(offer.stock.available)} available · cost {cost != null ? money(cost) : 'not on file'}
                </span>
              </div>
            </div>
            <div className="grid md3 gap-3">
              <Field label="Current price" hint={was != null ? `List price ${money(was)}` : 'No list price'}>
                <TextInput id="aa-pc-cur" prefix="$" value={price.toFixed(2)} placeholder="" readOnly />
              </Field>
              <Field label="New price" hint={npValid ? `Change ${signed(change)}` : 'Change —'} error={errors.newPrice}>
                <TextInput id="aa-pc-new" prefix="$" inputMode="decimal" value={draft.newPrice} placeholder="" error={!!errors.newPrice} onChange={(e) => set('newPrice', e.target.value)} />
              </Field>
              <Field label="Show was-price" hint="Must be a real recent price" error={errors.was}>
                <Select
                  id="aa-pc-was"
                  className={cx(errors.was && 'is-error')}
                  options={was != null ? [{ value: 'list', label: `List price ${money(was)}` }, { value: 'none', label: 'None' }] : [{ value: 'none', label: 'None' }]}
                  value={draft.was}
                  onChange={(e) => set('was', e.target.value as Draft['was'])}
                />
              </Field>
            </div>
            <div className="grid md2 gap-3">
              <Field label="Starts" error={errors.start}>
                <TextInput id="aa-pc-start" type="datetime-local" value={draft.start} placeholder="" error={!!errors.start} onChange={(e) => set('start', e.target.value)} />
              </Field>
              <Field label="Ends" optional error={errors.end}>
                <TextInput id="aa-pc-end" type="datetime-local" value={draft.end} placeholder="" error={!!errors.end} onChange={(e) => set('end', e.target.value)} />
              </Field>
            </div>
            {overLimit ? (
              <Alert tone="warning" title={`This change is above your ${limit}% limit`}>
                You can change Official Store prices by up to {limit}% without approval. This is a {Math.abs(change).toFixed(1)}% {change < 0 ? 'cut' : 'increase'}, so it goes to an approver before it can go live.
              </Alert>
            ) : (
              npValid &&
              Math.abs(change) >= 0.05 && (
                <Alert tone="info" title={limit === null ? 'No approval needed' : `Within your ${limit}% limit`}>
                  This is a {Math.abs(change).toFixed(1)}% {change < 0 ? 'cut' : 'increase'}, so it goes live at the start time without approval.
                </Alert>
              )
            )}
            <div className="well stack gap-2">
              <SummaryRow k="Margin now" v={marginNow != null && cost != null ? `${pct(marginNow)} · ${money(price - cost)} per unit` : 'Buying cost not on file'} />
              <SummaryRow
                k="Margin after change"
                v={
                  marginAfter != null && cost != null ? (
                    <span className={cx(marginAfter < MARGIN_DANGER ? 't-danger-text strong' : marginAfter < MARGIN_WARN && 't-warning-text strong')}>
                      {pct(marginAfter)} · {money(np - cost)} per unit
                    </span>
                  ) : (
                    '—'
                  )
                }
              />
              <SummaryRow k="Discount funding" v={npValid && np > price ? 'None (price increase)' : 'Company (Official Store markdown)'} />
              <SummaryRow k="Other offers on this product" v={otherText} />
              <span className="xs muted">The main offer is still chosen by the published rule (eligibility, availability, delivery and total price). The price applies to new orders only; open carts show the change before checkout.</span>
            </div>
            <Field label="Reason" hint="Required. Recorded in Action history." error={errors.reason}>
              <Textarea id="aa-pc-reason" placeholder="" className={cx(errors.reason && 'is-error')} value={draft.reason} onChange={(e) => set('reason', e.target.value)} />
            </Field>
          </>
        )}
      </Dialog>
    </AdminLayout>
  );
}
