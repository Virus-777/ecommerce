import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { formatMoney, num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, BarChart, Badge, Button, Card, Icon, Meter, PageHeader, SearchInput, Select, Stat, StatusBadge, TableWrap, Tabs, announce, type IconName } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, shortDate } from '@/app/parts';
import { ExportButton, ExportNotice } from './data/export-button';
import { useDatasetExport } from './data/report-export';
import { FUND_TONE, PROMO_KINDS, STATUS_LABEL, TABS, kindLabel, type CampaignRow, type PromotionsDashboard, type TabKey } from './data/promotions';
import { StopCampaign } from './PromotionStop';

// Design: pages/admin/admin-promotions.html (no views).
// Data: GET /api/admin/promotions/dashboard (KPIs, campaign results, daily discount cost),
// GET /api/admin/promotions/campaigns (the table; filtered on the page); POST /campaigns/{id}/pause|resume (the
// reason is optional: the server records a default), End (live or paused) and Cancel (not started yet) with a reason
// (PromotionStop). Export: dataset promotions.admin.campaigns (POST reports/exports).
// Rows open the campaign editor (admin/promotion-new?id=…), on the Finance confirmation view while in review.

const pct1 = (n?: number | null) => (n == null ? '—' : `${Math.round(n * 10) / 10}%`);
const pts = (n?: number | null) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n * 10) / 10)} pts`);

function kpis(d: PromotionsDashboard, range: string): Array<{ icon: IconName; label: string; value: string; note: string }> {
  const c = d.discountCost;
  const m = d.officialMargin;
  return [
    { icon: 'shopping-bag', label: 'Sales with a promotion', value: formatMoney(d.promotedSales), note: `${range} · ${num(d.promotedOrders)} orders` },
    { icon: 'ticket-percent', label: 'Discount cost', value: formatMoney(c.total), note: `Platform ${formatMoney(c.platform)} · sellers ${formatMoney(c.seller)} · shared ${formatMoney(d.sharedCost)}` },
    { icon: 'chart-column', label: 'Official Store margin impact', value: pts(m.changePts), note: m.before != null && m.after != null ? `${pct1(m.before)} → ${pct1(m.after)} on promoted items` : 'On promoted Official Store items' },
    { icon: 'tag', label: 'Coupon redemptions', value: num(d.couponRedemptions), note: `${pct1(d.redemptionShareOfOrders)} of orders` },
    { icon: 'undo-2', label: 'Returns on promoted orders', value: pct1(d.returnsOnPromotedPct), note: d.storeReturnsPct != null ? `Store average ${pct1(d.storeReturnsPct)}` : 'Store average not available' },
  ];
}

const editorHref = (p: CampaignRow) => href('admin/promotion-new', p.status === 'in_review' ? 'finance-confirmation' : '', undefined, { id: p.id });

export default function Promotions() {
  const navigate = useNavigate();
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const canPublish = can('promotions.campaigns.publish');
  const canManage = can('promotions.campaigns.manage');
  const canResults = can('promotions.results.view');
  const canExport = canResults && can('reports.exports.create');
  const campaignsExport = useDatasetExport('promotions.admin.campaigns');

  const [tab, setTab] = useState<TabKey>('all');
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [fund, setFund] = useState('');
  const [stopped, setStopped] = useState<string | null>(null);

  const dash = useQuery({ queryKey: ['promotions', 'dashboard'], enabled: canResults, queryFn: () => call(api.GET('/api/admin/promotions/dashboard')) });
  const list = useQuery({ queryKey: ['promotions', 'campaigns', 'all'], queryFn: () => call(api.GET('/api/admin/promotions/campaigns', { params: { query: { limit: 100 } } })) });
  const rows = list.data?.items ?? [];

  const pause = useMutation({
    mutationFn: (p: CampaignRow) =>
      p.status === 'paused'
        ? call(api.POST('/api/admin/promotions/campaigns/{id}/resume', { params: { path: { id: p.id } }, body: {} }))
        : call(api.POST('/api/admin/promotions/campaigns/{id}/pause', { params: { path: { id: p.id } }, body: {} })),
    onSuccess: (c) => {
      announce(`${c.name} ${c.status === 'paused' ? 'paused' : 'resumed'}`);
      void qc.invalidateQueries({ queryKey: ['promotions'] });
    },
  });

  const term = q.trim().toLowerCase();
  const inTab = (t: TabKey) => (p: CampaignRow) => {
    const st = TABS.find((x) => x.value === t)!.statuses;
    return !st || st.includes(p.status);
  };
  const visible = rows.filter((p) => inTab(tab)(p) && (!type || p.kind === type) && (!fund || p.fundingOwner === fund) && (!term || `${p.name} ${p.description ?? ''} ${p.code ?? ''}`.toLowerCase().includes(term)));

  const d = dash.data;
  const range = d ? `${shortDate(d.range.from)}–${shortDate(d.range.to)}` : '';
  const daily = (d?.dailyCost ?? []).slice(-14);
  const partial = daily.find((x) => x.partial);

  return (
    <AdminLayout active="promotions">
      <PageHeader
        crumbs={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Marketing and content' }]}
        title="Promotions and coupons"
        sub="Marketing creates campaigns · Finance confirms funding · Pacific Time"
        actions={
          canManage || canExport ? (
            <>
              {canExport && <ExportButton exp={campaignsExport} />}
              {canManage && (
                <Button size="sm" icon="plus" to={href('admin/promotion-new')}>
                  Create campaign
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      <ExportNotice exp={campaignsExport} />
      {canResults && (
        <div className="ab-kpis k5">
          {(d ? kpis(d, range) : Array.from({ length: 5 }, (_, i) => ({ icon: 'tag' as IconName, label: String(i), value: '', note: '' }))).map((k) => (
            <div className="card pad" key={k.label}>
              {d ? <Stat icon={k.icon} label={k.label} value={k.value} note={k.note} /> : <SkeletonLines rows={1} />}
            </div>
          ))}
        </div>
      )}
      {dash.isError && <LoadError error={dash.error} onRetry={() => void dash.refetch()} title="We couldn’t load the promotion results" />}
      {stopped && (
        <Alert tone="success" title="Campaign stopped">
          {stopped}
        </Alert>
      )}
      {pause.isError && (
        <Alert tone="danger" title="The campaign wasn’t changed">
          {errorMessage(pause.error)}
        </Alert>
      )}
      <div className="card">
        <div className="u-p-0-sp-4">
          <Tabs<TabKey> items={TABS.map((t) => ({ value: t.value, label: t.label, count: rows.filter(inTab(t.value)).length }))} active={tab} onChange={setTab} />
        </div>
        <div className="card-body u-pb-sp-3">
          <div className="toolbar">
            <SearchInput id="pr-q" placeholder="Search by name or code" value={q} onChange={setQ} />
            <Select id="pr-type" aria-label="Promotion type" value={type} onChange={(e) => setType(e.target.value)} options={[{ value: '', label: 'All types' }, ...PROMO_KINDS]} />
            <Select
              id="pr-fund"
              aria-label="Funded by"
              value={fund}
              onChange={(e) => setFund(e.target.value)}
              options={[
                { value: '', label: 'Any funding owner' },
                { value: 'platform', label: 'Platform' },
                { value: 'seller', label: 'Seller' },
                { value: 'shared', label: 'Shared' },
              ]}
            />
          </div>
        </div>
        {list.isError && (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        )}
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
              {list.isPending && (
                <tr>
                  <td colSpan={8}>
                    <SkeletonLines rows={4} />
                  </td>
                </tr>
              )}
              {visible.map((p) => {
                const budget = p.budget?.amount ?? 0;
                const pct = budget ? Math.min(100, Math.round((p.budgetUsed.amount / budget) * 100)) : 0;
                const near = pct >= 90;
                const live = p.status === 'live' || p.status === 'paused';
                return (
                  <tr key={p.id}>
                    <td>
                      <span className="ab-cell">
                        <span className="strong">
                          <Link to={editorHref(p)}>{p.name}</Link>
                        </span>
                        <span className="xs muted">{[p.code, p.description].filter(Boolean).join(' · ') || p.ref}</span>
                      </span>
                    </td>
                    <td>
                      <Badge className="t-deal-soft">{kindLabel(p.kind)}</Badge>
                    </td>
                    <td>
                      <span className="nowrap">{p.period.display.replace(/ PT$/, '')}</span>
                    </td>
                    <td>
                      <Badge tone={FUND_TONE[p.fundingOwner]}>{p.fundingLabel}</Badge>
                    </td>
                    <td>
                      <div className="stack gap-1 minw-140">
                        {p.budget ? (
                          <>
                            <span className="xs num">
                              {formatMoney(p.budgetUsed)} of {formatMoney(p.budget)}
                            </span>
                            <Meter pct={pct} tone={near ? 'warning' : undefined} label={`Budget used: ${p.name}`} />
                            {near && <span className="xs strong meter-note t-warning-text">Near target</span>}
                          </>
                        ) : (
                          <span className="xs num">{formatMoney(p.budgetUsed)} · no budget cap</span>
                        )}
                      </div>
                    </td>
                    <td className="r">{num(p.redemptions)}</td>
                    <td>
                      <StatusBadge status={STATUS_LABEL[p.status] ?? p.status} />
                    </td>
                    <td className="col-pin">
                      <span className="row gap-1 nowrap">
                        {live ? (
                          canPublish ? (
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => pause.mutate(p)} disabled={pause.isPending}>
                              <span>{p.status === 'live' ? 'Pause' : 'Resume'}</span>
                              <span className="sr-only"> {p.name}</span>
                            </button>
                          ) : null
                        ) : (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(editorHref(p))}>
                            <span>{canManage && ['draft', 'changes_requested'].includes(p.status) ? 'Edit' : 'Open'}</span>
                            <span className="sr-only"> {p.name}</span>
                          </button>
                        )}
                        <StopCampaign c={p} onDone={(c, k) => setStopped(`${c.name} is ${k === 'end' ? 'ended' : 'cancelled'}. The reason is in Action history.`)} />
                      </span>
                    </td>
                  </tr>
                );
              })}
              {list.isSuccess && !visible.length && (
                <tr>
                  <td colSpan={8} className="muted">
                    {rows.length ? 'No campaigns match these filters.' : 'No campaigns yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
      </div>
      {canResults && (
        <div className="grid lg2 gap-5">
          <Card
            title="Campaign results"
            sub={`${range} · costs recorded separately from sales`}
            flush
            foot={
              <>
                <span className="ab-note grow">Margin uses landed cost for Official Store items. Seller-funded discounts do not change company margin.</span>
                <Link className="small strong" to={href('admin/report', '', { key: 'campaign-results' })}>
                  Full report
                </Link>
              </>
            }
          >
            {d ? (
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
                    {d.results.map((r) => (
                      <tr key={r.campaignId}>
                        <td>
                          {r.name}
                          {r.status === 'ended' ? ' (ended)' : ''}
                        </td>
                        <td className="r">{formatMoney(r.sales)}</td>
                        <td className="r">{formatMoney(r.discountCost.total)}</td>
                        <td>{r.marginImpactPts != null ? pts(r.marginImpactPts) : (r.marginNote ?? '—')}</td>
                        <td className="col-pin">{r.sellersJoined ? `${r.sellersJoined} joined` : 'Not affected'}</td>
                      </tr>
                    ))}
                    {!d.results.length && (
                      <tr>
                        <td colSpan={5} className="muted">
                          No campaign results in this period.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </TableWrap>
            ) : (
              <div className="card-body">
                <SkeletonLines rows={4} />
              </div>
            )}
          </Card>
          <Card title="Daily discount cost" titleAs="h3" sub={`${daily.length ? `${shortDate(daily[0].date)}–${shortDate(daily[daily.length - 1].date)}` : range} · all campaigns · USD`}>
            {d ? (
              <BarChart labels={daily.map((x) => shortDate(x.date))} data={daily.map((x) => x.value.amount / 100)} height={200} fmt={(v) => `$${num(Math.round(v))}`} label="Daily discount cost" />
            ) : (
              <SkeletonLines rows={4} />
            )}
            {partial && (
              <p className="ab-note">
                <Icon name="info" className="ic-sm" /> {shortDate(partial.date)} is partial, through the latest update.
              </p>
            )}
          </Card>
        </div>
      )}
    </AdminLayout>
  );
}
