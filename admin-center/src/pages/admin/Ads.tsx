import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, BarsChart, Badge, Breadcrumbs, Button, Card, Dialog, fmtCount, fmtCountCompact, Icon, SearchInput, Select, Stat, StatusBadge, TableWrap, type IconName } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { dateTime, LoadError, shortDate, SkeletonLines } from '@/app/parts';
import { ACTION_LABEL, ACTION_PERMISSION, CampaignActionDialog, NEEDS_INPUT, runCampaignAction, type CampaignAction, type PendingAction } from './data/ad-actions';
import { CAMPAIGN_STATUS, isOwn, num, statusLabel, type AdCampaignSummary, type AdsDashboard, type CampaignStatus, type Page, type Placement } from './data/ads';

// Design: pages/admin/admin-ads.html. Data: GET /api/admin/advertising/dashboard (KPIs, side lists, billing,
// performance), GET …/campaigns (table, filtered on the server), GET …/placements (type filter), and the
// lifecycle actions POST …/campaigns/{id}/<action> from each row's allowedActions.

const LIFECYCLE: CampaignStatus[] = ['draft', 'in_review', 'approved', 'scheduled', 'live', 'paused', 'finished', 'archived'];
const SOURCES = [
  { value: '', label: 'Own and paid ads' },
  { value: 'own', label: 'Own promotions' },
  { value: 'seller', label: 'Seller paid ads' },
  { value: 'brand', label: 'Brand campaigns' },
];
const AT_RISK: CampaignStatus[] = ['in_review', 'paused'];

const campaignHref = (c: { ref: string }, view = '') => href('admin/ad-campaign', view, undefined, { ref: c.ref });

type RowAction = { label: string; icon?: IconName; variant?: 'ghost' | 'secondary'; to?: string; action?: CampaignAction; del?: boolean };
/** Row buttons from the API's allowedActions (at most two, in the design's order). */
function actionsFor(c: AdCampaignSummary, can: (p: string) => boolean): RowAction[] {
  const allowed = new Set(c.allowedActions);
  const out: RowAction[] = [];
  const add = (a: CampaignAction, icon?: IconName, variant?: 'secondary') => {
    if (allowed.has(a) && can(ACTION_PERMISSION[a])) out.push({ label: ACTION_LABEL[a], icon, variant, action: a });
  };
  if (allowed.has('review') && can('advertising.campaigns.review')) out.push({ label: 'Review', variant: 'secondary', to: campaignHref(c, 'approval') });
  add('pause', 'pause');
  add('resume', 'play');
  add('schedule', undefined, 'secondary');
  if (allowed.has('edit') && can('advertising.campaigns.manage')) out.push({ label: 'Edit', to: campaignHref(c) });
  // a staff draft that never ran (DELETE /campaigns/{id}); campaigns that ran are finished and archived instead
  if (allowed.has('delete') && can('advertising.campaigns.manage')) out.push({ label: 'Delete', icon: 'trash', del: true });
  add('finish');
  add('archive');
  add('renew');
  if (!out.length) out.push({ label: 'View', to: campaignHref(c, c.status === 'in_review' ? 'approval' : 'creative-preview') });
  return out.slice(0, 2);
}

function SideList({ title, items, empty }: { title: string; items: Array<{ key: string; name: string; to?: string; meta: string; status: string }>; empty: string }) {
  return (
    <Card title={title} titleAs="h3" flush>
      <ul className="list pad">
        {items.map((it) => (
          <li key={it.key}>
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
        {items.length === 0 && (
          <li>
            <span className="xs muted">{empty}</span>
          </li>
        )}
      </ul>
    </Card>
  );
}

export default function Ads() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [type, setType] = useState('');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [notice, setNotice] = useState('');
  /** The draft whose Delete was pressed (confirmation dialog) */
  const [toDelete, setToDelete] = useState<AdCampaignSummary | null>(null);
  const remove = useMutation({
    mutationFn: (c: AdCampaignSummary) => call(api.DELETE('/api/admin/advertising/campaigns/{id}', { params: { path: { id: c.id } } })),
    onSuccess: (_, c) => {
      setToDelete(null);
      const msg = `${c.name} deleted`;
      setNotice(msg);
      announce(msg);
      void qc.invalidateQueries({ queryKey: ['advertising'] });
    },
  });
  const [ending, setEnding] = useState<Record<string, 'finish'>>({});

  const dash = useQuery({ queryKey: ['advertising', 'dashboard'], queryFn: () => call(api.GET('/api/admin/advertising/dashboard')) as Promise<AdsDashboard> });
  const placements = useQuery({ queryKey: ['advertising', 'placements'], queryFn: () => call(api.GET('/api/admin/advertising/placements')) as Promise<Placement[]> });
  const needle = q.trim();
  const list = useQuery({
    queryKey: ['advertising', 'campaigns', { q: needle, source, type }],
    queryFn: () =>
      call(api.GET('/api/admin/advertising/campaigns', { params: { query: { q: needle || undefined, source: (source || undefined) as 'own' | undefined, placementKey: type || undefined, limit: 100 } } })) as Promise<Page<AdCampaignSummary>>,
    placeholderData: keepPreviousData,
  });

  const act = useMutation({
    mutationFn: ({ p, body }: { p: PendingAction; body?: Record<string, unknown> }) => runCampaignAction(api, p.id, p.action, body),
    onSuccess: (c, { p }) => {
      setPending(null);
      const msg = p.action === 'renew' ? `Renewal draft ${c.ref} created. Set the details in the campaign.` : `${p.name}: ${statusLabel(c.status)}`;
      setNotice(msg);
      announce(msg);
      void qc.invalidateQueries({ queryKey: ['advertising'] });
      void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
    },
  });
  const start = (c: AdCampaignSummary, action: CampaignAction) => {
    const p: PendingAction = { id: c.id, name: c.name, action, startsAt: c.startsAt, endsAt: c.endsAt };
    act.reset();
    if (NEEDS_INPUT[action]) setPending(p);
    else act.mutate({ p });
  };

  const d = dash.data;
  const rows = list.data?.items ?? [];
  const typeOptions = [{ value: '', label: 'All ad types' }, ...(placements.data ?? []).map((p) => ({ value: p.key, label: p.name }))];
  const perf = d?.performance;
  const perfRange = perf ? `${shortDate(perf.range.from)}–${shortDate(perf.range.to)}` : '';
  const endingFirst = d?.endingSoonList[0];

  return (
    <AdminLayout active="ads">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Advertisements' }]} />
          <h1 className="h1">Advertisements</h1>
          <p className="sub small">Own promotions and seller paid ads · Pacific Time</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="settings-2" to={href('admin/ad-placements')}>
            Placements and rules
          </Button>
          {can('advertising.campaigns.manage') && (
            <Button size="sm" icon="plus" to={href('admin/ad-campaign')}>
              Create campaign
            </Button>
          )}
        </div>
      </div>

      {notice && <Alert tone="success" title={notice} />}
      {act.error && !pending && <Alert tone="danger" title="That didn’t work">{errorMessage(act.error)}</Alert>}
      {dash.error && <LoadError error={dash.error} onRetry={() => void dash.refetch()} />}

      <div className="ab-kpis k6">
        {d ? (
          <>
            <div className="card pad">
              <Stat icon="radio" label="Live now" value={d.liveNow.total} note={`${d.liveNow.own} own · ${d.liveNow.paid} paid`} />
            </div>
            <div className="card pad">
              <Stat icon="calendar" label="Starting in 7 days" value={d.startingIn7Days} note={d.nextStartAt ? `Next: ${dateTime(d.nextStartAt)}` : 'Nothing scheduled'} />
            </div>
            <div className="card pad">
              <Stat icon="timer" label="Ending soon" value={d.endingSoon} note={endingFirst ? `${endingFirst.name}${endingFirst.endsAt ? `, ${shortDate(endingFirst.endsAt)}` : ''}` : 'None'} />
            </div>
            <div className="card pad">
              <Stat icon="list-checks" label="Waiting approval" value={d.waitingApproval} note={d.oldestWaitingDays != null ? `Oldest ${d.oldestWaitingDays} day${d.oldestWaitingDays === 1 ? '' : 's'}` : 'None waiting'} />
            </div>
            <div className="card pad">
              <Stat icon="circle-dollar-sign" label="Spend this month" value={formatMoney(d.spendThisMonth)} note="Seller paid ads · billed separately from commission" />
            </div>
            <div className="card pad">
              <Stat icon="shopping-bag" label="Attributed purchases" value={num(d.attributedOrders)} note={`${formatMoney(d.attributedSales)} · ${d.attributionDays}-day click window`} />
            </div>
          </>
        ) : (
          Array.from({ length: 6 }, (_, i) => (
            <div className="card pad" key={i}>
              <SkeletonLines rows={1} />
            </div>
          ))
        )}
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
                    <StatusBadge status={CAMPAIGN_STATUS[s]} />
                  </Fragment>
                ))}
              </div>
              <div className="toolbar">
                <SearchInput id="ad-q" placeholder="Search campaign or advertiser" value={q} onChange={setQ} />
                <Select id="ad-src" aria-label="Source" options={SOURCES} value={source} onChange={(e) => setSource(e.target.value)} />
                <Select id="ad-type" aria-label="Placement type" options={typeOptions} value={type} onChange={(e) => setType(e.target.value)} />
              </div>
            </div>
            {list.error ? (
              <div className="card-body">
                <LoadError error={list.error} onRetry={() => void list.refetch()} />
              </div>
            ) : !list.data ? (
              <div className="card-body">
                <SkeletonLines rows={5} />
              </div>
            ) : (
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
                    {rows.map((c) => {
                      const warn = AT_RISK.includes(c.status);
                      const shown = c.status === 'draft' || c.status === 'in_review' || c.status === 'approved' || (c.status === 'scheduled' && !c.displays);
                      return (
                        <tr key={c.id} className={cx(warn && 'is-warn')}>
                          <td>
                            {warn && <span className="sr-only">At risk: </span>}
                            <Link className="strong" to={campaignHref(c, c.status === 'in_review' ? 'approval' : 'creative-preview')}>
                              {c.name}
                            </Link>
                          </td>
                          <td>
                            <span className="row nowrap gap-2">
                              {c.advertiser.name}
                              {isOwn(c.advertiser) ? <Badge tone="brand">Own</Badge> : <Badge tone="info">Paid</Badge>}
                            </span>
                          </td>
                          <td>
                            <span className="ab-cell">
                              <span className="strong">{c.placementName}</span>
                              <span className="xs muted">{c.pagesLabel}</span>
                            </span>
                          </td>
                          <td>
                            <span className="nowrap">{c.periodLabel}</span>
                          </td>
                          <td>{c.budgetLabel}</td>
                          <td className="r">{shown ? '—' : num(c.displays)}</td>
                          <td className="r">{shown ? '—' : num(c.clicks)}</td>
                          <td>
                            <span title={c.statusNote ?? undefined}>
                              <StatusBadge status={statusLabel(c.status)} />
                            </span>
                          </td>
                          <td className="col-pin">
                            <span className="row nowrap gap-1">
                              {actionsFor(c, can).map((a) => {
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
                                  <button key={a.label} type="button" className={cls} disabled={act.isPending || remove.isPending} onClick={() => (a.del ? (remove.reset(), setToDelete(c)) : a.action && start(c, a.action))}>
                                    {inner}
                                  </button>
                                );
                              })}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={9} className="muted">
                          {needle || source || type ? 'No campaigns match these filters.' : 'No campaigns yet. Create one to get started.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </TableWrap>
            )}
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

          {can('advertising.reports.view') || can('advertising.campaigns.view') ? (
            <Card title="Performance" titleAs="h3" sub={perf ? `${perfRange} · all live campaigns` : undefined}>
              {perf ? (
                <>
                  <div className="grid m2 md4 gap-3">
                    {[
                      { k: 'Displays', v: num(perf.metrics.displays) },
                      { k: 'Clicks', v: num(perf.metrics.clicks), d: `${perf.metrics.ctrPct.toFixed(1)}% of displays` },
                      { k: 'Dismissals', v: num(perf.metrics.dismissals), d: perf.openingAdClosedPct != null ? `Opening ad closed: ${Math.round(perf.openingAdClosedPct)}%` : undefined },
                      { k: 'Attributed purchases', v: num(perf.metrics.attributedOrders), d: formatMoney(perf.metrics.attributedSales) },
                    ].map((p) => (
                      <div className="panel" key={p.k}>
                        <Stat label={p.k} value={p.v} note={p.d} />
                      </div>
                    ))}
                  </div>
                  {perf.daily.length > 0 && (
                    <BarsChart
                      rows={perf.daily.map((x) => ({ x: x.date, label: shortDate(x.date), displays: x.displays }))}
                      series={[{ key: 'displays', label: 'Ad displays' }]}
                      fmt={fmtCount}
                      axisFmt={fmtCountCompact}
                      height={200}
                      label="Daily ad displays"
                    />
                  )}
                  <p className="ab-note">
                    <Icon name="info" className="ic-sm" /> {perf.attributionNote}
                    {perf.daily.some((x) => x.partial) ? ` ${shortDate(perf.daily.filter((x) => x.partial).slice(-1)[0].date)} is partial.` : ''}
                  </p>
                </>
              ) : dash.isLoading ? (
                <SkeletonLines rows={3} />
              ) : null}
            </Card>
          ) : null}
        </div>

        <div className="stack gap-5">
          <SideList
            title="Waiting approval"
            empty={d ? 'Nothing waiting for approval.' : 'Loading…'}
            items={(d?.waitingList ?? []).map((c) => ({
              key: c.id,
              name: c.name,
              to: campaignHref(c, 'approval'),
              meta: `${c.advertiser.name}${isOwn(c.advertiser) ? '' : ' · paid'}${c.statusNote ? ` · ${c.statusNote}` : ''}`,
              status: statusLabel(c.status),
            }))}
          />
          <SideList
            title="Upcoming starts"
            empty={d ? 'No campaigns start in the next 7 days.' : 'Loading…'}
            items={(d?.upcomingStarts ?? []).map((c) => ({ key: c.id, name: c.name, to: campaignHref(c, 'creative-preview'), meta: `${c.placementName}${c.startsAt ? ` · ${dateTime(c.startsAt)}` : ''}`, status: statusLabel(c.status) }))}
          />
          <Card
            title="Ending soon"
            titleAs="h3"
            flush
            foot={
              endingFirst ? (
                ending[endingFirst.id] ? (
                  <span className="xs muted">{`It finishes ${endingFirst.endsAt ? dateTime(endingFirst.endsAt) : ''} as planned.`}</span>
                ) : (
                  <>
                    {endingFirst.allowedActions.includes('renew') && can('advertising.campaigns.manage') && (
                      <Button variant="secondary" size="sm" onClick={() => start(endingFirst, 'renew')}>
                        Renew
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => (setEnding((e) => ({ ...e, [endingFirst.id]: 'finish' })), announce(`${endingFirst.name} will finish as planned`))}>
                      Let it finish
                    </Button>
                  </>
                )
              ) : undefined
            }
          >
            <ul className="list pad">
              {(d?.endingSoonList ?? []).map((c) => (
                <li key={c.id}>
                  <span className="grow stack gap-0">
                    <Link className="small strong" to={campaignHref(c, 'creative-preview')}>
                      {c.name}
                    </Link>
                    <span className="xs muted">{c.endsAt ? `Ends ${dateTime(c.endsAt)} · finish or renew deliberately` : c.periodLabel}</span>
                  </span>
                  <Badge tone="warning">Ending soon</Badge>
                </li>
              ))}
              {d && d.endingSoonList.length === 0 && (
                <li>
                  <span className="xs muted">No campaigns end in the next few days.</span>
                </li>
              )}
              {!d && (
                <li>
                  <SkeletonLines rows={1} />
                </li>
              )}
            </ul>
          </Card>
          <Card title="Seller ad billing" titleAs="h3" sub={d ? `Example model: ${d.billing.modelLabel}` : undefined}>
            {d ? (
              <div className="ab-sumlist">
                <div>
                  <span>Billed this month</span>
                  <span>{formatMoney(d.billing.billedThisMonth)}</span>
                </div>
                <div>
                  <span>Unused budget returned</span>
                  <span>{formatMoney(d.billing.unusedBudgetReturned)}</span>
                </div>
                <div>
                  <span>Cancelled campaigns</span>
                  <span>{d.billing.cancelledCampaigns}</span>
                </div>
              </div>
            ) : (
              <SkeletonLines rows={3} />
            )}
            <p className="ab-note">
              <Icon name="info" className="ic-sm" /> Ad charges appear on seller statements as a separate line from sales commission.
            </p>
          </Card>
        </div>
      </div>

      <Dialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title={toDelete ? `Delete ${toDelete.name}?` : 'Delete campaign'}
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setToDelete(null)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button variant="danger" icon="trash" onClick={() => toDelete && remove.mutate(toDelete)} disabled={remove.isPending}>
              {remove.isPending ? 'Deleting…' : 'Delete draft'}
            </Button>
          </>
        }
      >
        {remove.isError && (
          <Alert tone="danger" title="The draft wasn’t deleted">
            {errorMessage(remove.error)}
          </Alert>
        )}
        <span className="small">
          The draft {toDelete?.ref} and the creatives only it uses are deleted. This can’t be undone; Action history keeps a record. Campaigns that have run can’t be deleted: finish and archive them instead.
        </span>
      </Dialog>
      <CampaignActionDialog
        pending={pending}
        busy={act.isPending}
        error={act.error}
        onClose={() => setPending(null)}
        onConfirm={(body) => pending && act.mutate({ p: pending, body })}
      />
    </AdminLayout>
  );
}
