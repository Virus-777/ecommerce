import { useState } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { money } from '@/lib/format';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, Badge, Button, Card, Checkbox, Field, Icon, Img, KeyValue, Meter, PageHeader, Price, Select, Stat, StatusBadge, SummaryRow, TableWrap, Tabs, TextInput, announce, type IconName } from '@/ui';

// Design: pages/seller/seller-marketing.html · views: platform-campaigns, sponsored-ads (tabs).

type Tab = '' | 'platform-campaigns' | 'sponsored-ads';

interface Discount {
  id: string;
  name: string;
  offers: string;
  type: string;
  period: string;
  status: string;
  used: string;
}
interface CampaignOffer {
  id: string;
  name: string;
  sku: string;
  icon: IconName;
  stock: number;
}
interface Ad {
  id: string;
  name: string;
  view: '' | 'in-review';
  type: string;
  promotes: string;
  schedule: string;
  billing: string;
  status: string;
  note?: string;
  spend: number;
  limit: number;
}

const DISCOUNTS: Discount[] = [
  { id: 'd1', name: 'Fall audio markdown', offers: 'Halden Pocket Bluetooth Speaker (2 colors)', type: '10% off', period: 'Oct 1 – Oct 31', status: 'Live', used: '63 orders' },
  { id: 'd2', name: 'Cable kit with headphones', offers: 'Studio Cable Kit, with any Halden headphones', type: '$5.00 off', period: 'Oct 12 – Oct 25', status: 'Scheduled', used: '—' },
  { id: 'd3', name: 'Weekend microphone deal', offers: 'Ardent USB Desk Microphone', type: 'Free shipping over $75.00', period: 'Not set', status: 'Draft', used: '—' },
  { id: 'd4', name: 'Back to campus', offers: 'Halden Aurora ANC Wireless Headphones', type: '15% off', period: 'Aug 24 – Sep 14', status: 'Finished', used: '41 orders' },
];

const TYPES = ['Percentage off', 'Fixed amount off', 'Minimum spend', 'Free shipping'];
const OFFERS = [
  { label: 'Halden Pocket Bluetooth Speaker, Teal and Sand', price: 59 },
  { label: 'Halden Aurora ANC Wireless Headphones', price: 184 },
  { label: 'Studio Cable Kit', price: 24 },
];
const FEE = 0.1;

const CAMPAIGN_OFFERS: CampaignOffer[] = [
  { id: 'mk-hw-0', name: 'Halden Pocket Bluetooth Speaker', sku: 'HAL-PKT-TEAL', icon: 'speaker', stock: 88 },
  { id: 'mk-hw-1', name: 'Halden Aurora ANC Wireless Headphones', sku: 'HAL-AUR-BLK', icon: 'headphones', stock: 24 },
  { id: 'mk-hw-2', name: 'Studio Cable Kit', sku: 'NWA-CBL-KIT', icon: 'cable', stock: 12 },
];
const MIN_STOCK = 20;

const ADS: Ad[] = [
  { id: 'a1', name: 'Pocket Speaker search boost', view: '', type: 'Sponsored product', promotes: 'Halden Pocket Bluetooth Speaker', schedule: 'Sep 15 – Oct 31', billing: 'Per click, $0.35', status: 'Live', spend: 82.6, limit: 300 },
  { id: 'a2', name: 'Northwind store feature', view: 'in-review', type: 'Sponsored store', promotes: 'Store page', schedule: 'Oct 15 – Nov 15', billing: 'Fixed, $45 per day', status: 'In review', spend: 0, limit: 500 },
  { id: 'a3', name: 'Aurora headphones in Headphones', view: '', type: 'Sponsored product', promotes: 'Halden Aurora ANC Wireless Headphones', schedule: 'Sep 20 – Oct 20', billing: 'Per click, $0.40', status: 'Paused', note: 'Paused by you Oct 3', spend: 140.2, limit: 200 },
  { id: 'a4', name: 'Summer cable kit', view: '', type: 'Sponsored product', promotes: 'Studio Cable Kit', schedule: 'Jul 1 – Aug 31', billing: 'Per click, $0.25', status: 'Finished', spend: 96.5, limit: 100 },
];

interface Draft {
  name: string;
  type: string;
  amt: string;
  limit: string;
  offer: string;
  start: string;
  end: string;
  stack: boolean;
}
const DRAFT: Draft = { name: 'Holiday speaker deal', type: TYPES[0], amt: '10', limit: '2', offer: OFFERS[0].label, start: 'Nov 20, 2026, 12:00 AM', end: 'Nov 30, 2026, 11:59 PM', stack: true };

const short = (d: string) => d.replace(/, \d{4}.*$/, '');

function draftErrors(d: Draft, price: number) {
  const e: Partial<Record<keyof Draft, string>> = {};
  const a = Number(d.amt);
  if (!d.name.trim()) e.name = 'Enter a name for the discount.';
  if (!/^\d+(\.\d{1,2})?$/.test(d.amt.trim()) || a <= 0) e.amt = d.type === 'Percentage off' ? 'Enter a percentage, like 10.' : 'Enter an amount in dollars, like 5.00.';
  else if (d.type === 'Percentage off' && a > 90) e.amt = 'Enter 90% or less.';
  else if (d.type === 'Fixed amount off' && a >= price) e.amt = `Enter less than the price, ${money(price)}.`;
  if (!/^\d+$/.test(d.limit.trim()) || Number(d.limit) < 1) e.limit = 'Enter a whole number of units, 1 or more.';
  if (!d.start.trim()) e.start = 'Enter a start date and time.';
  if (!d.end.trim()) e.end = 'Enter an end date and time.';
  return e;
}

export default function Marketing() {
  const [view, setView] = useView<Exclude<Tab, ''>>();
  const tab: Tab = view === 'platform-campaigns' || view === 'sponsored-ads' ? view : '';

  // Discounts
  const [discounts, setDiscounts] = useState(DISCOUNTS);
  const [d, setD] = useState<Draft>(DRAFT);
  const [tried, setTried] = useState(false);
  const [discNotice, setDiscNotice] = useState('');
  const offer = OFFERS.find((o) => o.label === d.offer) ?? OFFERS[0];
  const errs = tried ? draftErrors(d, offer.price) : {};
  const a = Number(d.amt) || 0;
  const pct = d.type === 'Percentage off';
  const fixed = d.type === 'Fixed amount off';
  const now = pct ? offer.price * (1 - Math.min(a, 90) / 100) : fixed ? Math.max(offer.price - a, 0) : offer.price;
  const typeLabel = pct ? `${a}% off` : fixed ? `${money(a)} off` : d.type === 'Minimum spend' ? `${money(a)} off orders over ${money(offer.price)}` : `Free shipping over ${money(a)}`;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const addDiscount = (status: 'Draft' | 'Scheduled') => {
    setTried(true);
    if (Object.keys(draftErrors(d, offer.price)).length) return;
    setDiscounts((l) => [{ id: `d${Date.now()}`, name: d.name.trim(), offers: d.offer, type: typeLabel, period: `${short(d.start)} – ${short(d.end)}`, status, used: '—' }, ...l]);
    setDiscNotice(status === 'Draft' ? `“${d.name.trim()}” saved as a draft.` : `“${d.name.trim()}” is scheduled from ${d.start}.`);
    setD({ ...DRAFT, name: '', amt: '', start: '', end: '' });
    setTried(false);
    announce(status === 'Draft' ? 'Discount saved as draft' : 'Discount scheduled');
  };

  // Platform campaign
  const [picked, setPicked] = useState<Record<string, boolean>>({ 'mk-hw-0': true, 'mk-hw-1': true });
  const [consent, setConsent] = useState(false);
  const [joined, setJoined] = useState<'' | 'joined' | 'declined'>('');
  const nPicked = CAMPAIGN_OFFERS.filter((o) => picked[o.id] && o.stock >= MIN_STOCK).length;

  // Sponsored ads
  const [ads, setAds] = useState(ADS);
  const togglePause = (id: string) =>
    setAds((l) =>
      l.map((x) => {
        if (x.id !== id) return x;
        const paused = x.status === 'Live';
        announce(`${x.name} ${paused ? 'paused' : 'resumed'}`);
        return { ...x, status: paused ? 'Paused' : 'Live', note: paused ? 'Paused by you just now' : undefined };
      }),
    );

  const tabs = [
    { value: '' as Tab, label: 'Discounts', count: discounts.filter((x) => x.status !== 'Finished').length },
    { value: 'platform-campaigns' as Tab, label: 'Platform campaigns', count: joined ? 0 : 1 },
    { value: 'sponsored-ads' as Tab, label: 'Sponsored ads', count: ads.length },
  ];

  return (
    <SellerLayout active="marketing">
      <PageHeader title="Marketing and ads" sub="Discounts you fund, Marketly campaigns you can join and sponsored ads you can request." />
      <div className="u-mb-calc--1-x-sp-2">
        <Tabs items={tabs} active={tab} onChange={(v) => setView(v as Exclude<Tab, ''>)} />
      </div>

      {tab === '' && (
        <div className="sb-main">
          <Card
            title="Your discounts"
            sub="Discounts you create are funded by you and lower the fee basis"
            flush
            actions={
              <Button size="sm" icon="plus" onClick={() => document.getElementById('mk-name')?.focus()}>
                Create discount
              </Button>
            }
          >
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
                  {discounts.map((x) => (
                    <tr key={x.id}>
                      <td>
                        <span className="small strong">{x.name}</span>
                      </td>
                      <td>
                        <span className="small minw-200 inline-block">{x.offers}</span>
                      </td>
                      <td>
                        <span className="small t-deal-text strong nowrap">{x.type}</span>
                      </td>
                      <td>
                        <span className="small nowrap">{x.period}</span>
                      </td>
                      <td>
                        <Badge tone="outline">Seller-funded</Badge>
                      </td>
                      <td>
                        <StatusBadge status={x.status} />
                      </td>
                      <td className="r col-pin">
                        <span className="small num">{x.used}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h3 className="h4">Create a discount</h3>
                <span className="xs muted">Preview before it goes live</span>
              </div>
            </div>
            <div className="card-body">
              {discNotice && <Alert tone="success" title={discNotice} />}
              <Field label="Discount name" hint="Only you see this name." error={errs.name}>
                <TextInput id="mk-name" value={d.name} error={!!errs.name} placeholder="" onChange={(e) => set('name', e.target.value)} />
              </Field>
              <Field label="Type">
                <Select id="mk-type" options={TYPES} value={d.type} onChange={(e) => set('type', e.target.value)} />
              </Field>
              <div className="sb-form-grid">
                <Field label="Amount" error={errs.amt}>
                  <TextInput id="mk-amt" value={d.amt} error={!!errs.amt} placeholder="" inputMode="decimal" prefix={pct ? undefined : '$'} suffix={pct ? '%' : undefined} onChange={(e) => set('amt', e.target.value)} />
                </Field>
                <Field label="Limit per customer" error={errs.limit}>
                  <TextInput id="mk-limit" value={d.limit} error={!!errs.limit} placeholder="" inputMode="numeric" suffix="units" onChange={(e) => set('limit', e.target.value)} />
                </Field>
              </div>
              <Field label="Offers">
                <Select id="mk-offers" options={OFFERS.map((o) => o.label)} value={d.offer} onChange={(e) => set('offer', e.target.value)} />
              </Field>
              <div className="sb-form-grid">
                <Field label="Starts" error={errs.start}>
                  <TextInput id="mk-start" icon="calendar" value={d.start} error={!!errs.start} placeholder="" onChange={(e) => set('start', e.target.value)} />
                </Field>
                <Field label="Ends" error={errs.end}>
                  <TextInput id="mk-end" icon="calendar" value={d.end} error={!!errs.end} placeholder="" onChange={(e) => set('end', e.target.value)} />
                </Field>
              </div>
              <Checkbox id="mk-stack" label="Can combine with Marketly coupons (platform-funded part never comes from you)" checked={d.stack} onChange={(e) => set('stack', e.target.checked)} />
              <div className="panel stack gap-1">
                <span className="xs muted">Customer sees</span>
                {pct || fixed ? <Price amount={Math.round(now * 100) / 100} was={a > 0 ? offer.price : null} /> : <Price amount={offer.price} />}
                <span className="xs sub">
                  {pct || fixed
                    ? `Your earnings per unit: ${money(now * (1 - FEE))} (was ${money(offer.price * (1 - FEE))}) after the 10% fee on the discounted price. Example rate.`
                    : `${typeLabel}. Your earnings per unit stay ${money(offer.price * (1 - FEE))} before the discount on the order. Example rate.`}
                </span>
              </div>
            </div>
            <div className="card-foot">
              <Button variant="ghost" onClick={() => addDiscount('Draft')}>
                Save draft
              </Button>
              <Button onClick={() => addDiscount('Scheduled')}>Schedule discount</Button>
            </div>
          </section>
        </div>
      )}

      {tab === 'platform-campaigns' && (
        <div className="sb-main">
          <div className="stack gap-5">
            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h2 className="h4">
                    Invitation: Home Week{' '}
                    <Badge tone="warning" icon="clock">
                      Join by Sat, Oct 10
                    </Badge>
                  </h2>
                  <span className="xs muted">Platform campaign · Mon, Oct 12, 12:00 AM – Mon, Oct 19, 11:59 PM PT · run by Marketly Marketing</span>
                </div>
              </div>
              <div className="card-body">
                <div className="imgph wide tint-3" style={{ aspectRatio: '5/1' }}>
                  <Icon name="house" />
                </div>
                <p className="small sub">Marketly features Home Week on the home page, the Deals page and an opening ad. Joined offers show the campaign price and a Home Week label.</p>
                <div className="grid md2 gap-4">
                  <div className="stack gap-2">
                    <span className="small strong">Eligibility</span>
                    <ul className="sb-ticks ok">
                      {['Offer rating 4.0 or higher', 'Dispatch within 2 business days', 'At least 20 units in stock', 'No price increase in the last 30 days'].map((t) => (
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
                        ['Campaign discount', '15% off'],
                        ['You fund', '10% of the price'],
                        ['Marketly funds', '5% of the price'],
                        ['Fee basis', 'Price after your 10%; Marketly’s 5% does not reduce your proceeds'],
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
                    {CAMPAIGN_OFFERS.map((o) => {
                      const ok = o.stock >= MIN_STOCK;
                      return (
                        <tr key={o.id} className={cx(picked[o.id] && ok && 'is-selected')}>
                          <td>
                            <input type="checkbox" id={o.id} aria-label={`Include ${o.name}`} checked={ok && !!picked[o.id]} disabled={!ok || joined === 'joined'} onChange={(e) => setPicked((p) => ({ ...p, [o.id]: e.target.checked }))} />
                          </td>
                          <td>
                            <label htmlFor={o.id} className="row gap-3 nowrap minw-240">
                              <Img icon={o.icon} tint="2" className="tiny" />
                              <span className="stack gap-0">
                                <span className="small strong">{o.name}</span>
                                <span className="xs muted mono nowrap" title={o.sku}>
                                  {o.sku}
                                </span>
                              </span>
                            </label>
                          </td>
                          <td>
                            <span className="num small">{o.stock}</span>
                          </td>
                          <td className="col-pin">
                            {ok ? (
                              <Badge tone="success">Eligible</Badge>
                            ) : (
                              <span className="stack gap-1">
                                <Badge tone="danger">Not eligible</Badge>
                                <span className="xs muted">
                                  Needs at least {MIN_STOCK} units in stock (you have {o.stock})
                                </span>
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            </Card>
          </div>
          <div className="stack gap-5">
            <Card title="Expected impact per unit" titleAs="h3" sub="Halden Pocket Bluetooth Speaker">
              <div className="sb-recon">
                <SummaryRow k="Regular price" v="$59.00" />
                <SummaryRow k="Campaign price for customers" v={<span className="t-deal-text strong">$50.15</span>} />
                <SummaryRow k="You fund (10%)" v={<span className="sb-neg">−$5.90</span>} />
                <SummaryRow k="Marketly funds (5%)" v="$2.95" />
                <SummaryRow k="Fee, 10% of $53.10" v={<span className="sb-neg">−$5.31</span>} />
                <SummaryRow className="total" k="Your earnings per unit" v={<b>$47.79</b>} />
                <SummaryRow k="Regular earnings per unit" v="$53.10" />
              </div>
              <span className="xs muted">Example only. Similar Home Week offers sold 2–3 times their usual weekly units last year, which is not a promise of sales.</span>
            </Card>
            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h3 className="h4">Join Home Week</h3>
                </div>
              </div>
              <div className="card-body">
                {joined === 'joined' && (
                  <Alert tone="success" title="You joined Home Week">
                    {nPicked} offer{nPicked === 1 ? '' : 's'} show the campaign price from Mon, Oct 12. You can leave before then.
                  </Alert>
                )}
                {joined === 'declined' && <Alert tone="info" title="Invitation declined">You can still join until Sat, Oct 10.</Alert>}
                <Checkbox
                  id="mk-consent"
                  label={`I agree to fund 10% of the price on the ${nPicked} selected offer${nPicked === 1 ? '' : 's'} from Oct 12 to Oct 19, 2026, and not to raise their prices during the campaign. Marketly funds the other 5%.`}
                  checked={consent}
                  disabled={joined === 'joined'}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span className="xs muted">You can leave before Oct 12. After it starts, leaving needs approval from Marketly Marketing.</span>
              </div>
              <div className="card-foot">
                {joined === 'joined' ? (
                  <Button variant="ghost" onClick={() => (setJoined(''), setConsent(false), announce('You left Home Week'))}>
                    Leave campaign
                  </Button>
                ) : (
                  <>
                    <Button variant="ghost" onClick={() => (setJoined('declined'), announce('Invitation declined'))}>
                      Decline
                    </Button>
                    <Button disabled={!consent || nPicked === 0} onClick={() => (setJoined('joined'), announce('Joined Home Week'))}>
                      Join campaign
                    </Button>
                  </>
                )}
              </div>
            </section>
            <Card title="Past campaigns" titleAs="h3" flush>
              <ul className="list pad">
                <li>
                  <span className="grow stack gap-0">
                    <span className="small strong">Back to Campus Week</span>
                    <span className="xs muted">Aug 24 – Aug 31 · 2 offers · you funded 5%</span>
                  </span>
                  <StatusBadge status="Finished" />
                </li>
              </ul>
            </Card>
          </div>
        </div>
      )}

      {tab === 'sponsored-ads' && (
        <>
          <Alert tone="info" title="Paid ads are labeled Sponsored for customers">
            Marketly reviews every request before it runs. Ad charges appear on your statement separately from sales commission. Paid campaigns bring attention to an offer and never guarantee purchases.
          </Alert>
          <Card
            title="Sponsored ads"
            sub="Spend this campaign against your total limit"
            flush
            actions={
              <Button size="sm" icon="plus" to={href('seller/ad-request')}>
                Request a sponsored campaign
              </Button>
            }
          >
            <TableWrap label="Sponsored ads table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Campaign</th>
                    <th scope="col">Type</th>
                    <th scope="col">Promotes</th>
                    <th scope="col">Schedule</th>
                    <th scope="col">Billing (example)</th>
                    <th scope="col">Status</th>
                    <th scope="col">Spend vs limit</th>
                    <th className="col-pin" scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ads.map((x) => {
                    const pctUsed = Math.round((x.spend / x.limit) * 100);
                    const near = pctUsed >= 90;
                    return (
                      <tr key={x.id}>
                        <td>
                          <Link className="small strong" to={href('seller/ad-request', x.view)}>
                            {x.name}
                          </Link>
                        </td>
                        <td>
                          <span className="small nowrap">{x.type}</span>
                        </td>
                        <td>
                          <span className="small minw-180 inline-block">{x.promotes}</span>
                        </td>
                        <td>
                          <span className="small nowrap">{x.schedule}</span>
                        </td>
                        <td>
                          <span className="xs sub nowrap">{x.billing}</span>
                        </td>
                        <td>
                          <StatusBadge status={x.status} />
                          {x.note && (
                            <>
                              <br />
                              <span className="xs muted">{x.note}</span>
                            </>
                          )}
                        </td>
                        <td>
                          <div className="stack gap-1 minw-140">
                            <span className="xs num">
                              {money(x.spend)} of {money(x.limit)}
                            </span>
                            <Meter pct={pctUsed} tone={near ? 'warning' : undefined} label={`Spend vs limit: ${x.name}`} />
                            {near && <span className="xs strong meter-note t-warning-text">Near target</span>}
                          </div>
                        </td>
                        <td className="col-pin">
                          {(x.status === 'Live' || x.status === 'Paused') && (
                            <Button variant="ghost" size="sm" onClick={() => togglePause(x.id)}>
                              {x.status === 'Live' ? 'Pause' : 'Resume'}
                              <span className="sr-only"> {x.name}</span>
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          </Card>
          <div className="grid md3 gap-4">
            <div className="card pad">
              <Stat label="Ad spend, Oct 1–8" value="$96.10" note="Shown on statements as ad charges" />
            </div>
            <div className="card pad">
              <Stat label="Clicks" value="262" note="Pocket Speaker and Aurora" />
            </div>
            <div className="card pad">
              <Stat label="Attributed orders" value="19" note="Ordered within 7 days of a click" />
            </div>
          </div>
        </>
      )}
    </SellerLayout>
  );
}
