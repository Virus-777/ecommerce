import { useState } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { money, num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, Button, Card, Dialog, EmptyState, Field, Icon, Img, Legend, LineChart, PageHeader, Pager, Price, SearchInput, SegmentedControl, Select, Stat,
  StatusBadge, SummaryRow, TableWrap, Textarea, TextInput, type IconName,
} from '@marketly/web-shared/ui';
import { CATEGORY_FILTERS, DAILY_SALES_K, DAY_LABELS, OFFERS, PERIODS, PRICE_LIMIT_PCT, STATUS_FILTERS, type CompanyOffer, type Period } from './data/official';

// Design: pages/admin/admin-official.html (trading + company offers) ·
// view "price-change" = the Change price dialog for the Aurora headphones, above the 30% limit.

type View = 'price-change';

const PERIOD_ITEMS: Array<{ value: Period; label: string }> = [
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
];

const STOREFRONT: Array<{ icon: IconName; label: string; link: string; to: string }> = [
  { icon: 'layout-template', label: 'Official Store page', link: 'View', to: href('store/official') },
  { icon: 'layers', label: 'Featured collections · 4 live', link: 'Manage', to: href('admin/content') },
  { icon: 'file-text', label: 'Service policies · returns 30 days', link: 'Edit', to: href('admin/help-content') },
];

const LOW_STOCK = 10;
const MARGIN_WARN = 25;
const MARGIN_DANGER = 10;

const k = (v: number) => `$${v.toFixed(1)}k`;
const pct = (v: number) => `${v.toFixed(1)}%`;
const marginOf = (price: number, cost: number) => ((price - cost) / price) * 100;
const signed = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}%`;

interface Draft {
  newPrice: string;
  was: 'list' | 'none';
  start: string;
  end: string;
  reason: string;
}

/** The design's price-change state: a 31.7% cut on the Aurora headphones. */
const DESIGN_DRAFT: Draft = {
  newPrice: '129.00',
  was: 'list',
  start: 'Oct 12, 2026, 12:00 AM PT',
  end: 'Oct 19, 2026, 11:59 PM PT',
  reason: 'Home Week event, Oct 12–19. Match expected competitor price and clear older stock before the Aurora 2 arrives.',
};

function validate(d: Draft, o: CompanyOffer) {
  const e: Partial<Record<keyof Draft, string>> = {};
  const np = Number(d.newPrice);
  if (!d.newPrice.trim() || !Number.isFinite(np) || np <= 0) e.newPrice = 'Enter the new price in dollars, like 179.00.';
  else if (Math.abs(np - o.price) < 0.005) e.newPrice = 'Enter a price different from the current price.';
  else if (np < o.cost) e.newPrice = `Below the buying cost of ${money(o.cost)}. Official Store offers can't be priced at a loss.`;
  if (!e.newPrice && d.was === 'list' && o.was && np >= o.was) e.was = 'The was-price must be higher than the new price. Choose None.';
  if (!d.start.trim()) e.start = 'Enter when the new price starts.';
  if (!d.reason.trim()) e.reason = "Enter a reason. It's recorded in Action history.";
  return e;
}

function AvailableCell({ n }: { n: number }) {
  if (n === 0)
    return (
      <span className="stack gap-0">
        <span className="strong num t-danger-text">
          0<span className="xs"> · Out</span>
        </span>
        <span className="xs muted">Not sellable</span>
      </span>
    );
  if (n < LOW_STOCK)
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

export default function Official() {
  const [view, setView] = useView<View>();
  const [period, setPeriod] = useState<Period>('14');
  const [offers, setOffers] = useState(OFFERS);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(STATUS_FILTERS[0]);
  const [cat, setCat] = useState(CATEGORY_FILTERS[0]);
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);

  /* ----- Trading ----- */
  const p = PERIODS[period];
  const days = Number(period);
  const sales = DAILY_SALES_K.slice(-days);
  const salesK = sales.reduce((a, b) => a + b, 0);

  /* ----- Offers table ----- */
  const needle = q.trim().toLowerCase();
  const rows = offers.filter((o) => {
    if (needle && !o.name.toLowerCase().includes(needle) && !o.sku.toLowerCase().includes(needle)) return false;
    if (cat !== CATEGORY_FILTERS[0] && o.category !== cat) return false;
    if (status === 'Low stock') return o.available > 0 && o.available < LOW_STOCK;
    if (status === 'Out of stock') return o.available === 0;
    if (status !== STATUS_FILTERS[0]) return o.status === status;
    return true;
  });

  /* ----- Price change dialog ----- */
  const [pcId, setPcId] = useState(OFFERS[0].id);
  const [draft, setDraft] = useState<Draft>(DESIGN_DRAFT);
  const [attempted, setAttempted] = useState(false);
  const offer = offers.find((o) => o.id === pcId) ?? offers[0];
  const open = view === 'price-change';
  const set = <K extends keyof Draft>(key: K, v: Draft[K]) => setDraft((d) => ({ ...d, [key]: v }));

  const np = Number(draft.newPrice);
  const npValid = draft.newPrice.trim() !== '' && Number.isFinite(np) && np > 0;
  const change = npValid ? ((np - offer.price) / offer.price) * 100 : 0;
  const overLimit = npValid && Math.abs(change) > PRICE_LIMIT_PCT;
  const marginNow = marginOf(offer.price, offer.cost);
  const marginAfter = npValid ? marginOf(np, offer.cost) : 0;
  const errors = attempted ? validate(draft, offer) : {};

  const openChange = (o: CompanyOffer) => {
    setPcId(o.id);
    setDraft({ newPrice: o.price.toFixed(2), was: o.was ? 'list' : 'none', start: 'Oct 11, 2026, 12:00 AM PT', end: '', reason: '' });
    setAttempted(false);
    setView('price-change');
  };
  const close = () => setView('');
  const submit = () => {
    setAttempted(true);
    if (Object.keys(validate(draft, offer)).length) return;
    const pending = overLimit ? `Price change to ${money(np)} waiting for Morgan Hale` : `${money(np)} from ${draft.start}`;
    setOffers((list) => list.map((o) => (o.id === offer.id ? { ...o, note: pending } : o)));
    setNotice(
      overLimit
        ? { title: 'Sent to Morgan Hale for approval', body: `${offer.short}: ${money(offer.price)} to ${money(np)} (${signed(change)}). It goes live only after the Business Owner approves.` }
        : { title: 'Price change scheduled', body: `${offer.sku} changes from ${money(offer.price)} to ${money(np)} on ${draft.start}. Recorded in Action history.` },
    );
    close();
  };

  return (
    <AdminLayout active="official">
      <PageHeader
        crumbs={[{ label: 'Official store' }, { label: 'Offers and trading' }]}
        title="Official Store"
        sub={`Company trading · ${p.range} · owner Dana Ortiz, Official Store Manager`}
        actions={
          <>
            <SegmentedControl items={PERIOD_ITEMS} active={period} onChange={setPeriod} label="Period" />
            <Button variant="secondary" size="sm" icon="chart-column" to={href('admin/reports')}>
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

      <div className="aa-kpis">
        <Card pad>
          <Stat label="Company sales" value={k(salesK)} delta={p.salesDelta} dir="up" good note={`vs prior ${days} days`} />
        </Card>
        <Card pad>
          <Stat label="Gross margin" value={pct(p.marginPct)} note={`${k((salesK * p.marginPct) / 100)} after buying cost`} />
        </Card>
        <Card pad>
          <Stat label="Discounts given" value={k((salesK * p.discountPct) / 100)} note={`${pct(p.discountPct)} of sales · company-funded`} />
        </Card>
        <Card pad>
          <Stat label="Returns" value={k(p.returnsK)} delta={p.returnsDelta} dir="down" good note={`${p.returnsPct} of sales`} />
        </Card>
      </div>

      <div className="aa-split">
        <Card title="Company sales by day" sub="Official Store only · USD">
          <Legend items={['Official Store']} />
          <LineChart labels={DAY_LABELS.slice(-days)} series={[{ name: 'Official Store', data: sales }]} height={210} area fmt={(v) => `$${Math.round(v)}k`} label="Official Store daily sales" />
        </Card>
        <div className="stack gap-5">
          <Card title="Marketplace fee income" sub="Reported separately · not company trading" titleAs="h3">
            <span className="h2 num">{k(p.feeK)}</span>
            <span className="small sub">on {k(p.sellerSalesK)} of seller sales in the same period. Seller sales are not company revenue and are not in the figures on the left.</span>
            <span className="xs muted">Example rate of 10%. Final fees are in the seller agreement.</span>
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

      <Card
        title="Company offers"
        sub="612 offers · price, cost and sellable stock"
        flush
        actions={
          <>
            <Button variant="secondary" size="sm" icon="upload">
              Bulk price update
            </Button>
            <Button size="sm" icon="plus">
              Add offer
            </Button>
          </>
        }
        footClassName="between"
        foot={
          <>
            <span className="xs muted">Price change limit: Official Store Manager up to 30%. Larger changes need Business Owner approval. Available excludes reserved and damaged stock.</span>
            <Pager page={page} total={62} onPage={setPage} />
          </>
        }
      >
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="aa-of-q" placeholder="Search company offers by name or SKU" value={q} onChange={setQ} />
            <Select id="aa-of-st" aria-label="Status" options={STATUS_FILTERS} value={status} onChange={(e) => setStatus(e.target.value)} />
            <Select id="aa-of-cat" aria-label="Category" options={CATEGORY_FILTERS} value={cat} onChange={(e) => setCat(e.target.value)} />
          </div>
        </div>
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
              {rows.map((o) => {
                const m = marginOf(o.price, o.cost);
                const edge = o.available === 0 ? 'flagged' : o.available < LOW_STOCK || m < MARGIN_WARN ? 'warn' : '';
                return (
                  <tr key={o.id} className={cx(edge && `is-${edge}`)}>
                    <td>
                      {edge && <span className="sr-only">{edge === 'flagged' ? 'Urgent: ' : 'At risk: '}</span>}
                      <span className="cell-main">
                        <Img icon={o.icon} tint={o.tint} className="tiny" />
                        <span className="stack gap-0">
                          <span className="small strong clamp-2">{o.name}</span>
                          <span className="xs muted">
                            <span className="mono nowrap" title={o.sku}>
                              {o.sku}
                            </span>
                            {o.note && ` · ${o.note}`}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="r">
                      <Price amount={o.price} was={o.was} noOff />
                    </td>
                    <td className="r">{money(o.cost)}</td>
                    <td className="r">
                      <span className={cx('strong', m < MARGIN_WARN && 't-warning-text')}>{pct(m)}</span>
                    </td>
                    <td className="r">
                      <AvailableCell n={o.available} />
                    </td>
                    <td>
                      <StatusBadge status={o.status} />
                    </td>
                    <td>
                      <Button variant="ghost" size="sm" onClick={() => openChange(o)}>
                        Change price
                        <span className="sr-only"> {o.sku}</span>
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {!rows.length && (
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
            Red edge = urgent: overdue or past target
          </span>
          <span className="sl sl-warning">
            <i aria-hidden="true" />
            Amber edge = at risk: due soon or near target
          </span>
        </p>
      </Card>

      <Dialog
        open={open}
        onClose={close}
        size="lg"
        title={`Change price · ${offer.short}`}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button icon={overLimit ? 'send' : 'check'} onClick={submit}>
              {overLimit ? 'Send to Morgan Hale for approval' : 'Schedule price change'}
            </Button>
          </>
        }
      >
        <div className="row nowrap gap-3">
          <Img icon={offer.icon} tint={offer.tint} className="thumb" />
          <div className="stack gap-0">
            <span className="strong">{offer.name}</span>
            <span className="xs muted">
              Official Store offer · SKU <span className="mono">{offer.sku}</span> · {num(offer.available)} available · cost {money(offer.cost)}
            </span>
          </div>
        </div>
        <div className="grid md3 gap-3">
          <Field label="Current price" hint={offer.was ? `List price ${money(offer.was)}` : 'No list price'}>
            <TextInput id="aa-pc-cur" prefix="$" value={offer.price.toFixed(2)} placeholder="" readOnly />
          </Field>
          <Field label="New price" hint={npValid ? `Change ${signed(change)}` : 'Change —'} error={errors.newPrice}>
            <TextInput id="aa-pc-new" prefix="$" inputMode="decimal" value={draft.newPrice} placeholder="" error={!!errors.newPrice} onChange={(e) => set('newPrice', e.target.value)} />
          </Field>
          <Field label="Show was-price" hint="Must be a real recent price" error={errors.was}>
            <Select
              id="aa-pc-was"
              className={cx(errors.was && 'is-error')}
              options={offer.was ? [{ value: 'list', label: `List price ${money(offer.was)}` }, { value: 'none', label: 'None' }] : [{ value: 'none', label: 'None' }]}
              value={draft.was}
              onChange={(e) => set('was', e.target.value as Draft['was'])}
            />
          </Field>
        </div>
        <div className="grid md2 gap-3">
          <Field label="Starts" error={errors.start}>
            <TextInput id="aa-pc-start" value={draft.start} placeholder="" error={!!errors.start} onChange={(e) => set('start', e.target.value)} />
          </Field>
          <Field label="Ends" optional>
            <TextInput id="aa-pc-end" value={draft.end} placeholder="" onChange={(e) => set('end', e.target.value)} />
          </Field>
        </div>
        {overLimit ? (
          <Alert tone="warning" title={`This change is above the ${PRICE_LIMIT_PCT}% limit`}>
            Official Store Manager (Dana Ortiz) can change prices by up to {PRICE_LIMIT_PCT}% without approval. This is a {Math.abs(change).toFixed(1)}% {change < 0 ? 'cut' : 'increase'}, so it goes to Morgan Hale (Business Owner) before it can go live.
          </Alert>
        ) : (
          npValid &&
          Math.abs(change) >= 0.05 && (
            <Alert tone="info" title={`Within your ${PRICE_LIMIT_PCT}% limit`}>
              This is a {Math.abs(change).toFixed(1)}% {change < 0 ? 'cut' : 'increase'}, so it goes live at the start time without approval.
            </Alert>
          )
        )}
        <div className="well stack gap-2">
          <SummaryRow k="Margin now" v={`${pct(marginNow)} · ${money(offer.price - offer.cost)} per unit`} />
          <SummaryRow
            k="Margin after change"
            v={
              npValid ? (
                <span className={cx(marginAfter < MARGIN_DANGER ? 't-danger-text strong' : marginAfter < MARGIN_WARN && 't-warning-text strong')}>
                  {pct(marginAfter)} · {money(np - offer.cost)} per unit
                </span>
              ) : (
                '—'
              )
            }
          />
          <SummaryRow k="Discount funding" v={npValid && np > offer.price ? 'None (price increase)' : 'Company (Official Store markdown)'} />
          <SummaryRow k="Other offers on this product" v={offer.otherOffers} />
          <span className="xs muted">The main offer is still chosen by the published rule (eligibility, availability, delivery and total price). The price applies to new orders only; open carts show the change before checkout.</span>
        </div>
        <Field label="Reason" hint="Required. Recorded in Action history." error={errors.reason}>
          <Textarea id="aa-pc-reason" placeholder="" className={cx(errors.reason && 'is-error')} value={draft.reason} onChange={(e) => set('reason', e.target.value)} />
        </Field>
      </Dialog>
    </AdminLayout>
  );
}
