import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AdminLayout } from '@/layouts';
import { money, num } from '@/lib/format';
import { href } from '@/routes/href';
import { BarChart, Badge, Button, Card, Icon, Meter, PageHeader, SearchInput, Select, Stat, StatusBadge, TableWrap, Tabs, type IconName, type Tone } from '@/ui';
import { DAILY_DISCOUNT_COST, PROMOTIONS, PROMO_RESULTS, PROMO_TYPES, type Promotion, type PromoFunding } from './data/promotions';

// Design: pages/admin/admin-promotions.html (no views).

const KPIS: Array<{ icon: IconName; label: string; value: string; note: string }> = [
  { icon: 'shopping-bag', label: 'Sales with a promotion', value: '$96,240.00', note: 'Oct 1–8 · 1,214 orders' },
  { icon: 'ticket-percent', label: 'Discount cost', value: '$11,870.00', note: 'Platform $6,420 · sellers $4,180 · shared $1,270' },
  { icon: 'chart-column', label: 'Official Store margin impact', value: '−2.4 pts', note: '31.8% → 29.4% on promoted items' },
  { icon: 'tag', label: 'Coupon redemptions', value: '1,912', note: '6.1% of orders' },
  { icon: 'undo-2', label: 'Returns on promoted orders', value: '3.1%', note: 'Store average 2.8%' },
];

type TabKey = 'all' | 'live' | 'scheduled' | 'finance' | 'ended' | 'drafts';
const TABS: Array<{ value: TabKey; label: string; match: (p: Promotion) => boolean }> = [
  { value: 'all', label: 'All', match: () => true },
  { value: 'live', label: 'Live', match: (p) => p.status === 'Live' || p.status === 'Paused' },
  { value: 'scheduled', label: 'Scheduled', match: (p) => p.status === 'Scheduled' },
  { value: 'finance', label: 'Waiting for Finance', match: (p) => p.status === 'In review' },
  { value: 'ended', label: 'Ended', match: (p) => p.status === 'Finished' },
  { value: 'drafts', label: 'Drafts', match: (p) => p.status === 'Draft' },
];

const FUND_TONE: Record<PromoFunding, Tone> = { Platform: 'brand', Seller: 'info', Shared: 'outline' };
const fundLabel = (p: Promotion) => (p.funding === 'Shared' ? `Shared ${p.split}/${100 - (p.split ?? 50)}` : p.funding);

export default function Promotions() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(PROMOTIONS);
  const [tab, setTab] = useState<TabKey>('all');
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [fund, setFund] = useState('');

  const term = q.trim().toLowerCase();
  const match = TABS.find((t) => t.value === tab)!.match;
  const visible = rows.filter((p) => match(p) && (!type || p.type === type) && (!fund || p.funding === fund) && (!term || `${p.name} ${p.scope}`.toLowerCase().includes(term)));

  const togglePause = (id: string) => setRows((rs) => rs.map((p) => (p.id === id ? { ...p, status: p.status === 'Live' ? 'Paused' : 'Live' } : p)));

  return (
    <AdminLayout active="promotions">
      <PageHeader
        crumbs={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Marketing and content' }]}
        title="Promotions and coupons"
        sub="Owner Jamie Brooks, Marketing Manager · Finance confirms funding · Pacific Time"
        actions={
          <>
            <Button variant="secondary" size="sm" icon="download">
              Export
            </Button>
            <Button size="sm" icon="plus" to={href('admin/promotion-new')}>
              Create campaign
            </Button>
          </>
        }
      />
      <div className="ab-kpis k5">
        {KPIS.map((k) => (
          <div className="card pad" key={k.label}>
            <Stat icon={k.icon} label={k.label} value={k.value} note={k.note} />
          </div>
        ))}
      </div>
      <div className="card">
        <div className="u-p-0-sp-4">
          <Tabs<TabKey> items={TABS.map((t) => ({ value: t.value, label: t.label, count: rows.filter(t.match).length }))} active={tab} onChange={setTab} />
        </div>
        <div className="card-body u-pb-sp-3">
          <div className="toolbar">
            <SearchInput id="pr-q" placeholder="Search by name or code" value={q} onChange={setQ} />
            <Select id="pr-type" aria-label="Promotion type" value={type} onChange={(e) => setType(e.target.value)} options={[{ value: '', label: 'All types' }, ...PROMO_TYPES]} />
            <Select id="pr-fund" aria-label="Funded by" value={fund} onChange={(e) => setFund(e.target.value)} options={[{ value: '', label: 'Any funding owner' }, 'Platform', 'Seller', 'Shared']} />
          </div>
        </div>
        <TableWrap label="Promotions and coupons table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                <th scope="col">Type</th>
                <th scope="col">Period (PT)</th>
                <th scope="col">Funding owner</th>
                <th scope="col">Budget used</th>
                <th className="r" scope="col">
                  Redemptions
                </th>
                <th scope="col">Status</th>
                <th className="col-pin" scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => {
                const pct = Math.round((p.used / p.budget) * 100);
                const near = pct >= 90;
                const live = p.status === 'Live' || p.status === 'Paused';
                return (
                  <tr key={p.id}>
                    <td>
                      <span className="ab-cell">
                        <span className="strong">
                          <Link to={href('admin/promotion-new', p.editorView)}>{p.name}</Link>
                        </span>
                        <span className="xs muted">{p.scope}</span>
                      </span>
                    </td>
                    <td>
                      <Badge className="t-deal-soft">{p.type}</Badge>
                    </td>
                    <td>
                      <span className="nowrap">{p.period}</span>
                    </td>
                    <td>
                      <Badge tone={FUND_TONE[p.funding]}>{fundLabel(p)}</Badge>
                    </td>
                    <td>
                      <div className="stack gap-1 minw-140">
                        <span className="xs num">
                          {money(p.used)} of {money(p.budget)}
                        </span>
                        <Meter pct={pct} tone={near ? 'warning' : undefined} label={`Budget used: ${p.name}`} />
                        {near && <span className="xs strong meter-note t-warning-text">Near target</span>}
                      </div>
                    </td>
                    <td className="r">{num(p.redemptions)}</td>
                    <td>
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="col-pin">
                      {live ? (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => togglePause(p.id)}>
                          <span>{p.status === 'Live' ? 'Pause' : 'Resume'}</span>
                          <span className="sr-only"> {p.name}</span>
                        </button>
                      ) : (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(href('admin/promotion-new', p.editorView))}>
                          <span>Edit</span>
                          <span className="sr-only"> {p.name}</span>
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!visible.length && (
                <tr>
                  <td colSpan={8} className="muted">
                    No campaigns match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
      </div>
      <div className="grid lg2 gap-5">
        <Card
          title="Campaign results"
          sub="Oct 1–8 · costs recorded separately from sales"
          flush
          foot={
            <>
              <span className="ab-note grow">Margin uses landed cost for Official Store items. Seller-funded discounts do not change company margin.</span>
              <Link className="small strong" to={href('admin/reports')}>
                Full report
              </Link>
            </>
          }
        >
          <TableWrap label="Campaign results table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Campaign</th>
                  <th className="r" scope="col">
                    Sales
                  </th>
                  <th className="r" scope="col">
                    Discount cost
                  </th>
                  <th scope="col">Margin impact</th>
                  <th className="col-pin" scope="col">
                    Sellers
                  </th>
                </tr>
              </thead>
              <tbody>
                {PROMO_RESULTS.map((r) => (
                  <tr key={r.name}>
                    <td>{r.name}</td>
                    <td className="r">{money(r.sales)}</td>
                    <td className="r">{money(r.cost)}</td>
                    <td>{r.margin}</td>
                    <td className="col-pin">{r.sellers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
        <Card title="Daily discount cost" titleAs="h3" sub="Oct 1–8 · all campaigns · USD">
          <BarChart labels={DAILY_DISCOUNT_COST.labels} data={DAILY_DISCOUNT_COST.data} height={200} fmt={(v) => `$${num(Math.round(v))}`} label="Daily discount cost" />
          <p className="ab-note">
            <Icon name="info" className="ic-sm" /> Oct 8 is partial, through 9:40 AM PT.
          </p>
        </Card>
      </div>
    </AdminLayout>
  );
}
