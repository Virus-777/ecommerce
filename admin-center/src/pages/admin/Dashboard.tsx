import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import ADMIN_DASHBOARD from '@marketly/web-shared/api/graphql/admin/AdminDashboard.graphql?raw';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, isoInText } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Card, Deadline, EmptyState, Icon, Legend, LineChart, SegmentedControl, SplitBar, Stat, StatusBadge, TableWrap, announce } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, deadlineLabel, deadlineTone, longDate, screenHref, time, weekdayDate } from '@/app/parts';
import {
  PERIOD, RANGES, compactMoney, deltaText, exceptionOf, greeting, moneyText,
  type AdminDashboardData, type NextPayoutRun, type Range, type WorkItem,
} from './data/dashboard';

// Design: pages/admin/admin-dashboard.html (single view).
// Data: GraphQL AdminDashboard (KPIs, sales split, ads, approvals waiting for me, the work summary with needs-attention
// tiles, overdue dispatch and team on shift, the next payout run), POST shipping/exceptions/{id}/notify-seller (Remind),
// POST reports/exports (Export).

const TEAM_STATUS: Record<string, string> = { away: 'Away', off: 'Off shift' };

export default function Dashboard() {
  const { api, gql } = useApi();
  const qc = useQueryClient();
  const { name, can } = useStaffSession();
  const [range, setRange] = useState<Range>('7d');
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState('');

  const dash = useQuery({
    queryKey: ['reports', 'admin-dashboard', range],
    queryFn: async () => (await gql<AdminDashboardData>(ADMIN_DASHBOARD, { period: PERIOD[range], overdueLimit: 5, adListLimit: 3 }, 'AdminDashboard')).data,
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });

  const remind = useMutation({
    mutationFn: async (w: WorkItem) => {
      const id = exceptionOf(w);
      if (!id) throw new Error('No delivery exception');
      await call(api.POST('/api/admin/shipping/exceptions/{id}/notify-seller', { params: { path: { id } }, body: {} }));
      return w;
    },
    onSuccess: (w) => {
      setDone((d) => ({ ...d, [w.id]: true }));
      setActionError('');
      announce(`Reminder sent to ${w.sellerName ?? 'the seller'} for ${w.subject?.ref ?? w.title}`);
      void qc.invalidateQueries({ queryKey: ['workqueues'] });
      void qc.invalidateQueries({ queryKey: ['reports', 'admin-dashboard'] });
    },
    onError: (e) => setActionError(errorMessage(e)),
  });

  const exportReport = useMutation({
    mutationFn: () => call(api.POST('/api/admin/reports/exports', { body: { reportKey: 'commerce.sales', format: 'csv' } })),
    onSuccess: (x) => announce(`Export ${x.ref} started. The file downloads from Reports when it is ready.`),
    onError: (e) => announce(errorMessage(e)),
  });

  const d = dash.data?.adminDashboard ?? null;
  const ads = dash.data?.adDashboard ?? null;
  const approvals = dash.data?.myApprovalSummary ?? null;
  const w = dash.data?.workSummary ?? null;
  const attention = w?.needsAttention ?? [];
  const dispatch = w?.overdueDispatch ?? [];
  const team = w?.team ?? [];
  const run = dash.data?.nextPayoutRun ?? undefined;
  const official = d?.series.find((s) => s.key === 'official');
  const sellers = d?.series.find((s) => s.key !== 'official');
  const splitOfficial = d?.split.find((s) => s.key === 'official');
  const splitSellers = d?.split.find((s) => s.key !== 'official');
  const firstName = name.split(' ')[0];
  const adList = ads ? [...ads.live, ...ads.upcomingStarts].slice(0, 3) : [];
  const canRemind = can('shipping.exceptions.manage');

  return (
    <AdminLayout active="dashboard">
      <div className="page-head">
        <div className="t">
          <h1 className="h1">
            {greeting()}
            {firstName ? `, ${firstName}` : ''}
          </h1>
          <p className="sub small">{d ? `${longDate(d.asOf)} · figures through ${time(d.asOf)} PT · ${d.basisLabel.charAt(0).toLowerCase()}${d.basisLabel.slice(1)}` : <span className="sk sk-line" style={{ display: 'inline-block', width: 280 }} />}</p>
        </div>
        <div className="actions">
          <SegmentedControl items={RANGES} active={range} onChange={setRange} label="Date range" />
          {can('reports.exports.create') ? (
            <Button variant="secondary" size="sm" icon="download" disabled={exportReport.isPending} onClick={() => exportReport.mutate()}>
              Export
            </Button>
          ) : null}
        </div>
      </div>

      {dash.isError && <LoadError error={dash.error} onRetry={() => void dash.refetch()} title="We couldn’t load the figures" />}

      <div className="ad-kpis">
        {d
          ? d.kpis.map((k) => {
              const dt = deltaText(k.delta);
              return (
                <div className="card pad" key={k.metricKey}>
                  <Stat label={k.label} value={k.display} delta={dt.text} dir={dt.dir} good={dt.good} note={k.note ?? undefined} />
                </div>
              );
            })
          : Array.from({ length: 4 }, (_, i) => (
              <div className="card pad" key={i} aria-hidden="true">
                <span className="sk sk-line short" />
                <span className="sk sk-line" />
              </div>
            ))}
      </div>

      <div className="ad-main">
        <div className="stack gap-5">
          <Card
            title="Sales split"
            sub={`Last ${official?.points.length ?? 14} days · ${d?.currency ?? 'USD'}`}
            actions={
              <Link className="small strong" to={href('admin/report', '', { key: 'commerce.sales' })}>
                Open report
              </Link>
            }
          >
            {official && sellers ? (
              <>
                <Legend items={[official.label, sellers.label]} />
                <LineChart
                  labels={official.points.map((p) => p.label)}
                  series={[
                    { name: 'Official', data: official.points.map((p) => p.value) },
                    { name: 'Sellers', data: sellers.points.map((p) => p.value) },
                  ]}
                  height={230}
                  fmt={compactMoney}
                  label="Daily sales, Official Store vs marketplace sellers"
                />
                {splitOfficial && splitSellers && (
                  <div className="stack gap-2">
                    <div className="row between xs sub">
                      <span>
                        Official Store {Math.round(splitOfficial.sharePct)}% · {moneyText(splitOfficial.amount, formatMoney)}
                      </span>
                      <span>
                        Sellers {Math.round(splitSellers.sharePct)}% · {moneyText(splitSellers.amount, formatMoney)}
                      </span>
                    </div>
                    <SplitBar a={Math.round(splitOfficial.sharePct)} b={100 - Math.round(splitOfficial.sharePct)} />
                  </div>
                )}
              </>
            ) : dash.isPending ? (
              <div className="sk sk-card" style={{ height: 230 }} aria-hidden="true" />
            ) : (
              <p className="small muted">Sales figures are not available right now.</p>
            )}
          </Card>

          <Card
            titleAs="h3"
            title="Overdue and at-risk dispatch"
            sub={w ? (dispatch.length ? `${dispatch.length} item${dispatch.length === 1 ? '' : 's'} past or near their dispatch deadline` : 'Nothing past its dispatch deadline') : undefined}
            actions={
              <Button variant="secondary" size="sm" to={href('ops/dispatch')}>
                Open dispatch queue
              </Button>
            }
            flush
          >
            {!w ? (
              dash.isPending ? (
                <SkeletonLines rows={4} />
              ) : (
                <div className="card-body">
                  <p className="small muted">Dispatch work items are not available right now.</p>
                </div>
              )
            ) : dispatch.length === 0 ? (
              <div className="card-body">
                <EmptyState icon="package-check" title="No overdue dispatch">
                  Every order is within its dispatch deadline.
                </EmptyState>
              </div>
            ) : (
              <>
                {actionError && (
                  <div className="card-body">
                    <Alert tone="danger" title="That didn’t work">
                      {actionError}
                    </Alert>
                  </div>
                )}
                <TableWrap label="Overdue and at-risk dispatch table">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Order</th>
                        <th scope="col">Seller</th>
                        <th scope="col">Item</th>
                        <th scope="col">Deadline</th>
                        <th scope="col">Owner</th>
                        <th className="col-pin" scope="col">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {dispatch.map((r) => {
                        const ref = r.subject?.ref ?? r.title;
                        const urgent = deadlineTone(r.deadline?.state) === 'danger';
                        const orderTo = r.subject?.ref ? href('admin/order', '', { ref: r.subject.ref }) : undefined;
                        const owner = r.assignee?.name ?? (r.waitingOn?.toLowerCase() === 'seller' ? 'Seller' : (r.ownerRole ?? ''));
                        const exc = exceptionOf(r);
                        return (
                          <tr key={r.id} className={urgent ? 'is-flagged' : 'is-warn'}>
                            <td className="cell-id">
                              <span className="sr-only">{urgent ? 'Urgent: ' : 'At risk: '}</span>
                              {orderTo ? (
                                <Link className="mono nowrap" to={orderTo} title={ref}>
                                  {ref}
                                </Link>
                              ) : (
                                <span className="mono nowrap">{ref}</span>
                              )}
                            </td>
                            <td className="cell-name">
                              <span className="ellip" title={r.sellerName ?? ''}>
                                {r.sellerName ?? 'Official Store'}
                              </span>
                            </td>
                            <td className="cell-name">
                              <span className="ellip" title={isoInText(r.summary ?? r.title)}>
                                {isoInText(r.summary ?? r.title)}
                              </span>
                            </td>
                            <td>{r.deadline?.dueAt && <Deadline tone={urgent ? 'danger' : 'warning'}>{deadlineLabel(r.deadline.dueAt)}</Deadline>}</td>
                            <td className="cell-name">
                              <span className="ellip" title={owner}>
                                {owner}
                              </span>
                            </td>
                            <td className="col-pin">
                              {exc && canRemind ? (
                                <button type="button" className="btn btn-ghost btn-sm" disabled={done[r.id] || (remind.isPending && remind.variables?.id === r.id)} onClick={() => remind.mutate(r)}>
                                  <span>{done[r.id] ? 'Reminded' : 'Remind'}</span>
                                  <span className="sr-only"> {ref}</span>
                                </button>
                              ) : orderTo ? (
                                <Link className="btn btn-ghost btn-sm" to={orderTo}>
                                  <span>View</span>
                                  <span className="sr-only"> {ref}</span>
                                </Link>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableWrap>
                <UrgencyLegend kind="edge" />
              </>
            )}
          </Card>

          <div className="grid lg2 gap-5">
            <Card
              titleAs="h3"
              title="Advertising today"
              sub={ads ? `${ads.liveNow.total} live · ${ads.startingIn7Days} starting this week` : undefined}
              actions={
                <Link className="small strong" to={href('admin/ads')}>
                  Manage
                </Link>
              }
              flush
            >
              {!ads ? (
                dash.isPending ? (
                  <SkeletonLines rows={3} />
                ) : (
                  <div className="card-body">
                    <p className="small muted">Advertising figures are not available right now.</p>
                  </div>
                )
              ) : adList.length === 0 ? (
                <div className="card-body">
                  <p className="small muted">No ads are live or starting this week.</p>
                </div>
              ) : (
                <ul className="list pad">
                  {adList.map((a) => (
                    <li key={a.id}>
                      <span className="grow stack gap-0">
                        <span className="small strong">{a.name}</span>
                        <span className="xs muted">{[a.placementName, a.deliveryLabel, a.budgetLabel ?? a.periodLabel].filter(Boolean).join(' · ')}</span>
                      </span>
                      <StatusBadge status={a.status.charAt(0) + a.status.slice(1).toLowerCase()} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <PayoutCard run={run} loading={dash.isPending} hidden={!can('finance.ledger.view')} />
          </div>
        </div>

        <div className="stack gap-5">
          <Card titleAs="h3" title="Needs attention" sub="Queues past or near their targets">
            {!w ? (
              dash.isPending ? <SkeletonLines rows={5} /> : <p className="small muted">Queue figures are not available right now.</p>
            ) : attention.length === 0 && !approvals?.toDecide ? (
              <EmptyState icon="circle-check" title="All clear">
                No queue is past or near its target.
              </EmptyState>
            ) : (
              <div className="ad-queues">
                {approvals && approvals.toDecide > 0 && (
                  <Link className={cx('queue-tile', approvals.overdue ? 't-danger' : approvals.dueSoon ? 't-warning' : undefined)} to={href('admin/inbox', 'needs-my-action')}>
                    <span className="qn">
                      {approvals.toDecide}
                      {(approvals.overdue > 0 || approvals.dueSoon > 0) && <span className="sr-only">{approvals.overdue ? ' (urgent)' : ' (at risk)'}</span>}
                    </span>
                    <span className="stack gap-0 grow">
                      <span className="small strong">Approvals waiting for you</span>
                      <span className="xs muted">{approvals.overdue ? `${approvals.overdue} overdue` : approvals.dueSoon ? `${approvals.dueSoon} due soon` : 'Two-person approvals'}</span>
                    </span>
                    <Icon name="chevron-right" className="ic-sm" />
                  </Link>
                )}
                {attention.map((q) => {
                  const tone = q.tone === 'neutral' ? undefined : q.tone;
                  const to = screenHref(q.screen, q.screenFilter) ?? screenHref(q.screen) ?? href('admin/dashboard');
                  return (
                    <Link key={q.queueKey} className={cx('queue-tile', tone && `t-${tone}`)} to={to}>
                      <span className="qn">
                        {q.count}
                        {tone && <span className="sr-only">{tone === 'danger' ? ' (urgent)' : ' (at risk)'}</span>}
                      </span>
                      <span className="stack gap-0 grow">
                        <span className="small strong">{q.name}</span>
                        <span className="xs muted">{[q.areaLabel, q.oldestLabel].filter(Boolean).join(' · ')}</span>
                      </span>
                      <Icon name="chevron-right" className="ic-sm" />
                    </Link>
                  );
                })}
              </div>
            )}
            <UrgencyLegend kind="number" />
          </Card>
          <Card titleAs="h3" title="Team on shift" sub="Leads and backups" flush>
            {!w ? (
              dash.isPending ? <SkeletonLines rows={4} /> : null
            ) : team.length === 0 ? (
              <div className="card-body">
                <p className="small muted">No leads or backups are set for the work queues yet.</p>
              </div>
            ) : (
              <ul className="list pad">
                {team.map((t) => {
                  const covering = t.coveringFor?.name;
                  return (
                    <li key={`${t.staff.staffId}-${t.area}`}>
                      <Avatar name={t.staff.name} />
                      <span className="grow stack gap-0">
                        <span className="small strong">{t.staff.name}</span>
                        <span className="xs muted">{t.area}</span>
                      </span>
                      <span className="xs muted">{TEAM_STATUS[t.status.toLowerCase()] ?? (covering ? `Backup for ${covering.split(' ')[0]}` : t.role.toLowerCase() === 'lead' ? 'Lead' : 'Backup')}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}

function PayoutCard({ run, loading, hidden }: { run?: NextPayoutRun; loading: boolean; hidden: boolean }) {
  const rows: Array<{ label: string; n: number; tone?: 'warning' | 'danger' }> = run
    ? [
        { label: 'Ready to pay', n: run.readyCount },
        { label: 'Held for review', n: run.heldCount, tone: 'warning' },
        { label: 'Failed last run', n: run.failedLastRun, tone: 'danger' },
      ]
    : [];
  const when = run?.scheduledRelease ? `${weekdayDate(run.scheduledRelease)} · ${time(run.scheduledRelease)} PT` : undefined;
  return (
    <Card
      titleAs="h3"
      title="Next payout run"
      sub={hidden ? 'Your role doesn’t include payouts' : when}
      actions={
        hidden ? undefined : (
          <Link className="small strong" to={href('admin/payouts')}>
            Review
          </Link>
        )
      }
    >
      {hidden ? (
        <p className="small muted">Finance staff review and approve payout runs.</p>
      ) : loading ? (
        <SkeletonLines rows={3} />
      ) : !run ? (
        <p className="small muted">No payout run is scheduled.</p>
      ) : (
        <>
          <div className="row between base">
            <span className="h2 num">{moneyText(run.total, formatMoney)}</span>
            <span className="small muted">
              {run.sellerCount} seller{run.sellerCount === 1 ? '' : 's'}
            </span>
          </div>
          <ul className="list">
            {rows.map((p) => (
              <li key={p.label}>
                <span className="grow small">{p.label}</span>
                {p.tone && p.n > 0 ? (
                  <span className="row gap-2">
                    <Badge tone={p.tone}>{p.n}</Badge>
                  </span>
                ) : (
                  <span className="small strong num">{p.n}</span>
                )}
              </li>
            ))}
          </ul>
          {run.approval?.required && (
            <Alert tone="warning" title={run.status.toLowerCase() === 'pending_approval' ? 'Second review needed' : 'Approval needed'}>
              {run.approval.reason}
            </Alert>
          )}
        </>
      )}
    </Card>
  );
}

/** The design's urgency legend. Local because the shared StatusLegend omits the "Legend:" sr-only prefix. */
function UrgencyLegend({ kind }: { kind: 'edge' | 'number' }) {
  return (
    <p className={`status-legend status-legend--${kind}`}>
      <span className="sr-only">Legend: </span>
      <span className="sl sl-danger">
        <i aria-hidden="true" />
        Red {kind} = urgent: overdue or past target
      </span>
      <span className="sl sl-warning">
        <i aria-hidden="true" />
        Amber {kind} = at risk: due soon or near target
      </span>
    </p>
  );
}
