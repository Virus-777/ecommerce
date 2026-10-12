import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { announce, BarChart, Badge, Breadcrumbs, Button, Card, Icon, SearchInput, Select, Stat, StatusBadge, TableWrap, type IconName } from '@marketly/web-shared/ui';

// Design: pages/admin/admin-ads.html

type Status = 'Draft' | 'In review' | 'Approved' | 'Scheduled' | 'Live' | 'Paused' | 'Finished' | 'Archived';
type Source = 'own' | 'seller' | 'brand';

interface Campaign {
  id: string;
  name: string;
  advertiser: string;
  source: Source;
  type: string;
  placement: string;
  period: string;
  budget: string;
  displays: string;
  clicks: string;
  status: Status;
}

const CAMPAIGNS: Campaign[] = [
  { id: 'c1', name: 'Home Week opening ad', advertiser: 'Marketly', source: 'own', type: 'Opening full-screen', placement: 'Home, category entry', period: 'Oct 6 – Oct 19', budget: 'Internal', displays: '128,400', clicks: '3,210', status: 'Live' },
  { id: 'c2', name: 'Halden Aurora banner', advertiser: 'Halden (brand)', source: 'brand', type: 'Banner', placement: 'Home, Electronics', period: 'Oct 1 – Oct 10', budget: '$1,240 of $3,000', displays: '86,200', clicks: '1,930', status: 'Live' },
  { id: 'c3', name: 'Kestrel SSD sponsored products', advertiser: 'Pixel & Port', source: 'seller', type: 'Sponsored product', placement: 'Search, Computers', period: 'Oct 3 – Oct 31', budget: '$412 of $1,500', displays: '54,100', clicks: '1,480', status: 'Live' },
  { id: 'c4', name: 'Free shipping weekend pop-up', advertiser: 'Marketly', source: 'own', type: 'Pop-up', placement: 'Home, cart page excluded', period: 'Oct 10 – Oct 18', budget: 'Internal', displays: '—', clicks: '—', status: 'Scheduled' },
  { id: 'c5', name: 'Fall Home Sale opening ad', advertiser: 'Marketly', source: 'own', type: 'Opening full-screen', placement: 'Home, campaign page', period: 'Oct 16 – Oct 25', budget: 'Internal', displays: '—', clicks: '—', status: 'In review' },
  { id: 'c6', name: 'Kestrel 27" monitor sponsored product', advertiser: 'Pixel & Port', source: 'seller', type: 'Sponsored product', placement: 'Search, Monitors', period: 'Oct 12 – Nov 8', budget: '$0 of $800', displays: '—', clicks: '—', status: 'In review' },
  { id: 'c7', name: 'Trailhead Ridge store feature', advertiser: 'Trailhead Outfitters', source: 'seller', type: 'Sponsored store', placement: 'Home, Sports', period: 'Oct 1 – Oct 20', budget: '$96 of $600', displays: '12,800', clicks: '210', status: 'Paused' },
  { id: 'c8', name: 'Fall picks banner', advertiser: 'Marketly', source: 'own', type: 'Banner', placement: 'Home & Kitchen', period: 'Oct 9 – Oct 31', budget: 'Internal', displays: '—', clicks: '—', status: 'Approved' },
  { id: 'c9', name: 'Northwind Audio store feature', advertiser: 'Northwind Audio', source: 'seller', type: 'Sponsored store', placement: 'Electronics', period: 'Not set', budget: '$500 limit', displays: '—', clicks: '—', status: 'Draft' },
  { id: 'c10', name: 'Back to campus opening ad', advertiser: 'Marketly', source: 'own', type: 'Opening full-screen', placement: 'Home', period: 'Aug 15 – Sep 15', budget: 'Internal', displays: '402,300', clicks: '8,870', status: 'Finished' },
  { id: 'c11', name: 'Summer clearance banner', advertiser: 'Marketly', source: 'own', type: 'Banner', placement: 'Home, Deals', period: 'Jul 1 – Jul 31', budget: 'Internal', displays: '311,000', clicks: '6,020', status: 'Archived' },
];

const LIFECYCLE: Status[] = ['Draft', 'In review', 'Approved', 'Scheduled', 'Live', 'Paused', 'Finished', 'Archived'];
const SOURCES = [
  { value: '', label: 'Own and paid ads' },
  { value: 'own', label: 'Own promotions' },
  { value: 'seller', label: 'Seller paid ads' },
  { value: 'brand', label: 'Brand campaigns' },
];
const TYPES = ['All ad types', 'Opening full-screen', 'Banner', 'Pop-up', 'Sponsored product', 'Sponsored store'];
const AT_RISK: Status[] = ['In review', 'Paused'];

const DAILY = { labels: ['Oct 1', 'Oct 2', 'Oct 3', 'Oct 4', 'Oct 5', 'Oct 6', 'Oct 7', 'Oct 8'], data: [24, 27, 31, 35, 34, 49, 52, 29] };
const PERFORMANCE: Array<{ k: string; v: string; d?: string }> = [
  { k: 'Displays', v: '281,500' },
  { k: 'Clicks', v: '6,620', d: '2.4% of displays' },
  { k: 'Dismissals', v: '41,300', d: 'Opening ad closed: 32%' },
  { k: 'Attributed purchases', v: '186', d: '$21,940.00' },
];

type Action = { label: string; icon?: IconName; variant?: 'ghost' | 'secondary'; to?: string; next?: Status };
function actionsFor(c: Campaign): Action[] {
  switch (c.status) {
    case 'Live':
      return [{ label: 'Pause', icon: 'pause', next: 'Paused' }, { label: 'Finish', next: 'Finished' }];
    case 'Scheduled':
      return [{ label: 'Pause', icon: 'pause', next: 'Paused' }, { label: 'Edit', to: href('admin/ad-campaign', 'schedule-limits') }];
    case 'In review':
      return [{ label: 'Review', variant: 'secondary', to: href('admin/ad-campaign', 'approval') }];
    case 'Paused':
      return [{ label: 'Resume', icon: 'play', next: 'Live' }, { label: 'Finish', next: 'Finished' }];
    case 'Approved':
      return [{ label: 'Schedule', variant: 'secondary', next: 'Scheduled' }];
    case 'Draft':
      return [{ label: 'Edit', to: href('admin/ad-campaign') }];
    case 'Finished':
      return [{ label: 'Archive', next: 'Archived' }, { label: 'Renew', to: href('admin/ad-campaign') }];
    default:
      return [{ label: 'View', to: href('admin/ad-campaign', 'creative-preview') }];
  }
}

function SideList({ title, items }: { title: string; items: Array<{ name: string; to?: string; meta: string; status: string }> }) {
  return (
    <Card title={title} titleAs="h3" flush>
      <ul className="list pad">
        {items.map((it) => (
          <li key={it.name}>
            <span className="grow stack gap-0">
              {it.to ? (
                <Link className="small strong" to={it.to}>
                  {it.name}
                </Link>
              ) : (
                <span className="small strong">{it.name}</span>
              )}
              <span className="xs muted">{it.meta}</span>
            </span>
            <StatusBadge status={it.status} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function Ads() {
  const [rows, setRows] = useState(CAMPAIGNS);
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [type, setType] = useState(TYPES[0]);
  const [ending, setEnding] = useState<'' | 'renewed' | 'finish'>('');

  const setStatus = (id: string, status: Status) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));
    const c = rows.find((r) => r.id === id);
    if (c) announce(`${c.name}: ${status}`);
  };

  const needle = q.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (!needle || r.name.toLowerCase().includes(needle) || r.advertiser.toLowerCase().includes(needle)) &&
      (!source || r.source === source) &&
      (type === TYPES[0] || r.type === type),
  );
  const live = rows.filter((r) => r.status === 'Live');
  const liveOwn = live.filter((r) => r.source === 'own').length;
  const inReview = rows.filter((r) => r.status === 'In review');

  return (
    <AdminLayout active="ads">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Advertisements' }]} />
          <h1 className="h1">Advertisements</h1>
          <p className="sub small">Owner Jamie Brooks, Advertising Manager · own promotions and seller paid ads (pilot with 3 sellers) · Pacific Time</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="settings-2" to={href('admin/ad-placements')}>
            Placements and rules
          </Button>
          <Button size="sm" icon="plus" to={href('admin/ad-campaign')}>
            Create campaign
          </Button>
        </div>
      </div>

      <div className="ab-kpis k6">
        <div className="card pad">
          <Stat icon="radio" label="Live now" value={live.length} note={`${liveOwn} own · ${live.length - liveOwn} paid`} />
        </div>
        <div className="card pad">
          <Stat icon="calendar" label="Starting in 7 days" value="2" note="Next: Oct 9, 6:00 AM" />
        </div>
        <div className="card pad">
          <Stat icon="timer" label="Ending soon" value="1" note="Halden Aurora banner, Oct 10" />
        </div>
        <div className="card pad">
          <Stat icon="list-checks" label="Waiting approval" value={inReview.length} note="Oldest 1 day" />
        </div>
        <div className="card pad">
          <Stat icon="circle-dollar-sign" label="Spend this month" value="$1,748.00" note="Seller paid ads · billed separately from commission" />
        </div>
        <div className="card pad">
          <Stat icon="shopping-bag" label="Attributed purchases" value="186" note="$21,940.00 · 7-day click window" />
        </div>
      </div>

      <div className="ab-main">
        <div className="stack gap-5">
          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h2 className="h4">Campaigns</h2>
                <span className="xs muted">Every status in the campaign lifecycle</span>
              </div>
            </div>
            <div className="card-body" style={{ paddingBottom: 'var(--sp-2)' }}>
              <div className="ab-lifecycle" aria-label="Campaign lifecycle">
                {LIFECYCLE.map((s, i) => (
                  <Fragment key={s}>
                    {i > 0 && <Icon name="chevron-right" />}
                    <StatusBadge status={s} />
                  </Fragment>
                ))}
              </div>
              <div className="toolbar">
                <SearchInput id="ad-q" placeholder="Search campaign or advertiser" value={q} onChange={setQ} />
                <Select id="ad-src" aria-label="Source" options={SOURCES} value={source} onChange={(e) => setSource(e.target.value)} />
                <Select id="ad-type" aria-label="Placement type" options={TYPES} value={type} onChange={(e) => setType(e.target.value)} />
              </div>
            </div>
            <TableWrap label="Campaigns table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Campaign</th>
                    <th scope="col">Advertiser</th>
                    <th scope="col">Type and placement</th>
                    <th scope="col">Period</th>
                    <th scope="col">Budget / spend</th>
                    <th className="r" scope="col">Displays</th>
                    <th className="r" scope="col">Clicks</th>
                    <th scope="col">Status</th>
                    <th className="col-pin" scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => {
                    const warn = AT_RISK.includes(c.status);
                    return (
                      <tr key={c.id} className={cx(warn && 'is-warn')}>
                        <td>
                          {warn && <span className="sr-only">At risk: </span>}
                          <Link className="strong" to={href('admin/ad-campaign', 'creative-preview')}>
                            {c.name}
                          </Link>
                        </td>
                        <td>
                          <span className="row nowrap gap-2">
                            {c.advertiser}
                            {c.source === 'own' ? <Badge tone="brand">Own</Badge> : <Badge tone="info">Paid</Badge>}
                          </span>
                        </td>
                        <td>
                          <span className="ab-cell">
                            <span className="strong">{c.type}</span>
                            <span className="xs muted">{c.placement}</span>
                          </span>
                        </td>
                        <td>
                          <span className="nowrap">{c.period}</span>
                        </td>
                        <td>{c.budget}</td>
                        <td className="r">{c.displays}</td>
                        <td className="r">{c.clicks}</td>
                        <td>
                          <StatusBadge status={c.status} />
                        </td>
                        <td className="col-pin">
                          <span className="row nowrap gap-1">
                            {actionsFor(c).map((a) => {
                              const inner = (
                                <>
                                  {a.icon && <Icon name={a.icon} />}
                                  <span>{a.label}</span>
                                  <span className="sr-only"> {c.name}</span>
                                </>
                              );
                              const cls = cx('btn', a.variant === 'secondary' ? 'btn-secondary' : 'btn-ghost', 'btn-sm');
                              return a.to ? (
                                <Link key={a.label} className={cls} to={a.to}>
                                  {inner}
                                </Link>
                              ) : (
                                <button key={a.label} type="button" className={cls} onClick={() => a.next && setStatus(c.id, a.next)}>
                                  {inner}
                                </button>
                              );
                            })}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={9} className="muted">
                        No campaigns match these filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </TableWrap>
            <p className="status-legend status-legend--edge">
              <span className="sr-only">Legend: </span>
              <span className="sl sl-warning">
                <i aria-hidden="true" />
                Amber edge = at risk: due soon or near target
              </span>
            </p>
            <div className="card-foot">
              <span className="ab-note grow">Pausing takes an ad off the site within 1 minute. Expired ads and ads for unavailable offers are removed automatically.</span>
            </div>
          </section>

          <Card title="Performance" titleAs="h3" sub="Oct 1–8 · all live campaigns">
            <div className="grid m2 md4 gap-3">
              {PERFORMANCE.map((p) => (
                <div className="panel" key={p.k}>
                  <Stat label={p.k} value={p.v} note={p.d} />
                </div>
              ))}
            </div>
            <BarChart labels={DAILY.labels} data={DAILY.data} fmt={(v) => `${Math.round(v)}k`} label="Daily ad displays in thousands" />
            <p className="ab-note">
              <Icon name="info" className="ic-sm" /> Attribution period: a purchase counts when it happens within 7 days of a click on the ad. Paid campaigns never guarantee purchases. Oct 8 is partial.
            </p>
          </Card>
        </div>

        <div className="stack gap-5">
          <SideList
            title="Waiting approval"
            items={inReview.map((c) => ({
              name: c.name,
              to: c.source === 'own' ? href('admin/ad-campaign', 'approval') : undefined,
              meta: c.source === 'own' ? `${c.advertiser} · needs Content review · Noor Aziz` : `${c.advertiser} · paid · creative check`,
              status: c.status,
            }))}
          />
          <SideList
            title="Upcoming starts"
            items={[
              { name: 'Fall picks banner', meta: 'Banner · Oct 9, 6:00 AM', status: rows.find((r) => r.id === 'c8')!.status },
              { name: 'Free shipping weekend pop-up', meta: 'Pop-up · Oct 10, 12:00 AM', status: rows.find((r) => r.id === 'c4')!.status },
            ]}
          />
          <Card
            title="Ending soon"
            titleAs="h3"
            flush
            foot={
              ending ? (
                <span className="xs muted">{ending === 'renewed' ? 'Renewal draft created. Set new dates in the campaign.' : 'It finishes Oct 10, 11:59 PM as planned.'}</span>
              ) : (
                <>
                  <Button variant="secondary" size="sm" onClick={() => (setEnding('renewed'), announce('Renewal draft created'))}>
                    Renew
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => (setEnding('finish'), announce('Halden Aurora banner will finish as planned'))}>
                    Let it finish
                  </Button>
                </>
              )
            }
          >
            <ul className="list pad">
              <li>
                <span className="grow stack gap-0">
                  <span className="small strong">Halden Aurora banner</span>
                  <span className="xs muted">Ends Oct 10, 11:59 PM · finish or renew deliberately</span>
                </span>
                <Badge tone="warning">Ending soon</Badge>
              </li>
            </ul>
          </Card>
          <Card title="Seller ad billing" titleAs="h3" sub="Example model: fixed placement fee per week">
            <div className="ab-sumlist">
              <div>
                <span>Billed this month</span>
                <span>$1,748.00</span>
              </div>
              <div>
                <span>Unused budget returned</span>
                <span>$312.00</span>
              </div>
              <div>
                <span>Cancelled campaigns</span>
                <span>0</span>
              </div>
            </div>
            <p className="ab-note">
              <Icon name="info" className="ic-sm" /> Ad charges appear on seller statements as a separate line from sales commission.
            </p>
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}
