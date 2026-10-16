import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, useApi, type components } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, type MoneyValue, isoInText } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Badge, Button, Card, Deadline, Icon, Meter, StatusLegend, TableWrap, type Tone } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { helpLinkTo } from './data/help-articles';
import { PeriodPerformance } from './data/period-dashboard';
import { dateTime, deadlineLabel, deadlineTone, LoadError, longDate, screenHref, shortDate, SkeletonLines, time, weekdayDate, date } from './data/home';

// Design: pages/seller/seller-dashboard.html (no views).
// API: GET /api/seller/reports/dashboard (work tiles, dispatch deadlines, sales, performance, announcements),
// GET /api/seller/settings/upcoming-changes (announced rule changes), GET /api/seller/finance/balances
// (payouts; finance.balances.view). The SellerDashboard screen query isn't used: its balance fails on the
// running server (G13: Money.formatted null) and its performance targets lack the thresholds the meters need.

type WorkTile = components['schemas']['reports.SellerWorkTile'];
type Balances = components['schemas']['finance.SellerBalances'];
type UpcomingChange = components['schemas']['settings.UpcomingChange'];

/** The dashboard's json fields (typed `unknown` in the API spec; shapes from reports.md SellerDashboard). */
interface DispatchRow {
  orderId: string;
  orderRef: string;
  placedAt: string;
  buyerLabel: string;
  itemsLabel: string;
  deadline: { dueAt: string; state: string };
  nextAction: string;
}
interface Sales {
  range: { from: string; to: string };
  gross: MoneyValue;
  deltaPct: number | null;
  orders: number;
  averageOrder: MoneyValue | null;
  today: MoneyValue;
  todayOrders: number;
  series: Array<{ key: string; label: string; points: Array<{ x: string; y: number; label: string }> }>;
  basis: string;
}
interface Metric {
  key: string;
  label?: string;
  value: number;
  display: string;
  status: 'meets' | 'watch' | 'below' | 'action_needed';
  detail: string;
  target: { comparator: 'gte' | 'lte'; threshold: number; unit: string; display: string; isExample: boolean };
}
interface Performance {
  overall: string;
  period: { from: string; to: string };
  metrics: Metric[];
}
interface Announcement {
  title: string;
  body?: string | null;
  kind?: string | null;
  effectiveFrom?: string | null;
  link?: { label?: string; url?: string } | string | null;
}

const TILE_LABEL: Record<WorkTile['key'], string> = {
  overdue_dispatch: 'Overdue dispatch',
  dispatch_due_today: 'Dispatch due today',
  new_orders: 'New orders',
  low_stock: 'Low or out of stock',
  open_returns: 'Open returns',
  unanswered_messages: 'Unanswered messages',
};

/** The three service metrics the dashboard shows (design: dispatch, cancellations, message response). */
const PERF_KEYS = ['dispatch_reliability', 'cancellation_rate', 'response_time'];
const METRIC_LABEL: Record<string, string> = { dispatch_reliability: 'On-time dispatch', cancellation_rate: 'Cancellation rate', response_time: 'Message response time' };
const PERF_STATUS: Record<Metric['status'], { badge: string; tone: 'success' | 'warning' | 'danger'; note?: string }> = {
  meets: { badge: 'Meets target', tone: 'success' },
  watch: { badge: 'Watch', tone: 'warning', note: 'Near target' },
  below: { badge: 'Below target', tone: 'danger', note: 'Below target' },
  action_needed: { badge: 'Action needed', tone: 'danger', note: 'Past target' },
};

/** Meter fill: share of a "at least" target reached, or how much of an "at most" allowance is used. */
function meterPct(m: Metric): number {
  const { comparator, threshold, unit } = m.target;
  if (comparator === 'gte') return Math.max(0, Math.min(100, unit === 'percent' ? m.value : threshold ? (m.value / threshold) * 100 : 100));
  if (!threshold) return m.value > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((m.value / threshold) * 100)));
}


/** Work-queue tile; the shared QueueTile only announces "(urgent)", the design also marks amber tiles "(at risk)". */
function Tile({ t }: { t: WorkTile }) {
  const tone = t.tone === 'neutral' ? undefined : t.tone;
  return (
    <Link className={cx('queue-tile', tone && `t-${tone}`)} to={screenHref(t.screen, t.screenState) ?? href('seller/dashboard')}>
      <span className="qn">
        {t.count}
        {tone && <span className="sr-only"> ({tone === 'danger' ? 'urgent' : 'at risk'})</span>}
      </span>
      <span className="stack gap-0 grow">
        <span className="small strong">{TILE_LABEL[t.key] ?? t.key}</span>
        <span className="xs muted">{t.sub}</span>
      </span>
      <Icon name="chevron-right" className="ic-sm" />
    </Link>
  );
}

function PayoutsCard() {
  const { api } = useApi();
  const { sellerId, can } = useSellerSession();
  const allowed = can('finance.balances.view');
  const bal = useQuery({ queryKey: ['finance', 'balances', sellerId], queryFn: () => call(api.GET('/api/seller/finance/balances')) as Promise<Balances>, enabled: allowed });
  const b = bal.data;
  return (
    <Card
      title="Payouts"
      titleAs="h3"
      sub="Approved sales are not paid out until they become available"
      actions={
        allowed ? (
          <Link className="small strong" to={href('seller/finance')}>
            Finance
          </Link>
        ) : undefined
      }
    >
      {!allowed ? (
        <p className="small sub">Balances and payouts are visible to the owner and staff with Finance access.</p>
      ) : bal.isPending ? (
        <SkeletonLines rows={3} />
      ) : bal.isError ? (
        <LoadError error={bal.error} onRetry={() => void bal.refetch()} />
      ) : b ? (
        <>
          <div className="grid c2 gap-3">
            <div className="stack gap-1">
              <span className="xs muted strong">Pending</span>
              <span className="sa-money">{formatMoney(b.pending)}</span>
              <span className="xs muted">Waiting for delivery and hold</span>
            </div>
            <div className="stack gap-1">
              <span className="xs muted strong">Available</span>
              <span className="sa-money">{formatMoney(b.available)}</span>
              <span className="xs muted">Included in next payout</span>
            </div>
          </div>
          {b.nextPayout ? (
            <div className="panel row between">
              <span className="small">
                Next payout · <b>{weekdayDate(b.nextPayout.scheduledFor)}</b>
              </span>
              <span className="small strong num">{formatMoney(b.nextPayout.estimatedAmount)}</span>
            </div>
          ) : (
            <div className="panel row between">
              <span className="small">No payout scheduled</span>
            </div>
          )}
          <span className="xs muted">
            {[b.destination?.label ? `To ${b.destination.label}` : 'No payout account yet', `Held: ${formatMoney(b.held)}`].join(' · ')}
            {b.nextPayout?.note && <> · {b.nextPayout.note}</>}
          </span>
          <p className="xs muted row gap-1 nowrap top">
            <Icon name="info" className="ic-sm" />
            <span className="wrap">{b.settlementRules.text} Your seller agreement sets the final terms.</span>
          </p>
        </>
      ) : null}
    </Card>
  );
}

function announcementLink(a: Announcement): { label: string; to?: string; external?: string } | null {
  const l = typeof a.link === 'string' ? { url: a.link } : a.link;
  if (!l?.url) return null;
  const t = helpLinkTo(l.url);
  return t.to || t.external ? { label: l.label ?? 'Read the change', ...t } : null;
}

export default function Dashboard() {
  const { api } = useApi();
  const { sellerId, storeName } = useSellerSession();
  const dash = useQuery({ queryKey: ['reports', 'dashboard', sellerId], queryFn: () => call(api.GET('/api/seller/reports/dashboard')), refetchInterval: 5 * 60_000 });
  const changes = useQuery({ queryKey: ['settings', 'upcoming-changes', sellerId], queryFn: () => call(api.GET('/api/seller/settings/upcoming-changes')) });

  const d = dash.data;
  const deadlines = ((d?.dispatchDeadlines ?? []) as DispatchRow[]).slice(0, 5);
  const sales = (d?.sales ?? null) as Sales | null;
  const perf = (d?.performance ?? null) as Performance | null;
  const metrics = PERF_KEYS.map((k) => perf?.metrics.find((m) => m.key === k)).filter((m): m is Metric => !!m);
  const news = [
    ...((d?.announcements ?? []) as Announcement[]).map((a) => ({ key: `a-${a.title}`, icon: 'file-text' as const, title: a.title, tag: a.kind ? a.kind.charAt(0).toUpperCase() + a.kind.slice(1) : undefined, body: a.body ?? '', when: a.effectiveFrom ? `Effective ${date(a.effectiveFrom)}` : undefined, link: announcementLink(a), strong: !!a.effectiveFrom })),
    ...((changes.data?.items ?? []) as UpcomingChange[]).map((c) => ({
      key: `c-${c.ref}`,
      icon: 'calendar-days' as const,
      title: c.title,
      tag: c.module ? c.module.charAt(0).toUpperCase() + c.module.slice(1) : undefined,
      body: c.description ?? c.appliesTo,
      when: `Effective ${date(c.effectiveAt)} · Posted ${shortDate(c.postedAt)}`,
      link: c.helpLink ? announcementLink({ title: c.title, link: { label: 'Read the change', url: c.helpLink } }) : null,
      strong: true,
    })),
  ];

  return (
    <SellerLayout active="dashboard">
      <div className="page-head">
        <div className="t">
          <h1 className="h1">Today at {storeName}</h1>
          <p className="sub small">{d ? `${longDate(d.asOf)} · updated ${time(d.asOf)} PT` : ' '}</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="plus" to={href('seller/catalog-match')}>
            Add product
          </Button>
          <Button size="sm" to={href('seller/orders')}>
            Go to orders
          </Button>
        </div>
      </div>
      {dash.isError && <LoadError error={dash.error} onRetry={() => void dash.refetch()} title="We couldn’t load today’s figures" />}
      <section className="stack gap-3" aria-labelledby="sa-work">
        <h2 className="h3" id="sa-work">
          Work for today
        </h2>
        <div className="sa-tiles">
          {d ? d.workToday.map((t) => <Tile key={t.key} t={t} />) : Array.from({ length: 6 }, (_, i) => <div key={i} className="sk sk-card" aria-hidden="true" />)}
        </div>
        <StatusLegend
          kind="number"
          items={[
            { tone: 'danger', label: 'Red number = urgent: overdue or past target' },
            { tone: 'warning', label: 'Amber number = at risk: due soon or near target' },
          ]}
        />
      </section>
      <div className="sa-split">
        <div className="stack gap-5">
          <Card
            title="Dispatch deadlines"
            titleAs="h3"
            sub="Open orders, most urgent first"
            actions={
              <Link className="small strong" to={href('seller/orders')}>
                All orders
              </Link>
            }
            flush
          >
            {!d ? (
              <div className="pad">
                <SkeletonLines rows={3} />
              </div>
            ) : deadlines.length === 0 ? (
              <div className="card-body">
                <p className="small sub">No open orders to dispatch.</p>
              </div>
            ) : (
              <TableWrap label="Dispatch deadlines table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Order</th>
                      <th scope="col">Buyer</th>
                      <th scope="col">Items</th>
                      <th scope="col">Deadline</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {deadlines.map((r) => {
                      const tone = deadlineTone(r.deadline.state);
                      const to = href('seller/order', '', { ref: r.orderRef });
                      return (
                        <tr key={r.orderId} className={tone === 'danger' ? 'is-flagged' : tone === 'warning' ? 'is-warn' : undefined}>
                          <td>
                            {tone !== 'ok' && <span className="sr-only">{tone === 'danger' ? 'Urgent: ' : 'At risk: '}</span>}
                            <Link className="mono small nowrap" to={to} title={r.orderRef}>
                              {r.orderRef}
                            </Link>
                            <div className="xs muted">{dateTime(r.placedAt)}</div>
                          </td>
                          <td>{r.buyerLabel}</td>
                          <td>
                            <span className="small">{r.itemsLabel}</span>
                          </td>
                          <td>
                            <Deadline tone={tone}>{deadlineLabel(r.deadline.dueAt)}</Deadline>
                          </td>
                          <td>
                            <Link className={cx('btn btn-sm', tone === 'danger' ? 'btn-primary' : 'btn-secondary')} to={to}>
                              <span>{r.nextAction}</span>
                              <span className="sr-only"> {r.orderRef}</span>
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            )}
            <StatusLegend
              items={[
                { tone: 'danger', label: 'Red edge = urgent: overdue or past target' },
                { tone: 'warning', label: 'Amber edge = at risk: due soon or near target' },
              ]}
            />
          </Card>
          <PeriodPerformance today={sales ? { gross: sales.today, orders: sales.todayOrders } : undefined} />
        </div>
        <div className="stack gap-5">
          <PayoutsCard />
          <Card
            title="Performance"
            titleAs="h3"
            sub="Last 30 days, compared with service targets"
            actions={
              <Link className="small strong" to={href('seller/performance')}>
                Account health
              </Link>
            }
          >
            {!d ? (
              <SkeletonLines rows={3} />
            ) : metrics.length === 0 ? (
              <p className="small sub">Performance figures aren’t available right now.</p>
            ) : (
              <ul className="sa-perf">
                {metrics.map((m) => {
                  const st = PERF_STATUS[m.status] ?? PERF_STATUS.meets;
                  return (
                    <li key={m.key}>
                      <div className="row between">
                        <span className="small strong">{METRIC_LABEL[m.key] ?? m.label ?? m.key}</span>
                        <Badge tone={st.tone as Tone}>{st.badge}</Badge>
                      </div>
                      <div className="row between xs muted">
                        <span>
                          <b className="num u-c-text">{m.display}</b> · {m.detail}
                        </span>
                        <span>
                          Target: {m.target.display.charAt(0).toLowerCase() + m.target.display.slice(1)}
                          {m.target.isExample && ' (example)'}
                        </span>
                      </div>
                      <Meter pct={meterPct(m)} tone={st.tone} label={m.display} />
                      {st.note && <span className={`xs strong meter-note t-${st.tone}-text`}>{st.note}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card title="Announcements" titleAs="h3" flush>
            {!d || changes.isPending ? (
              <div className="pad">
                <SkeletonLines rows={2} />
              </div>
            ) : news.length === 0 ? (
              <div className="card-body">
                <p className="small sub">No announcements right now. Rule changes that affect your store appear here before they take effect.</p>
              </div>
            ) : (
              <ul className="list pad">
                {news.map((n) => (
                  <li key={n.key} className="items-start">
                    <Icon name={n.icon} />
                    <span className="grow stack gap-1">
                      {n.tag ? (
                        <span className="row gap-2">
                          <span className="small strong">{n.title}</span>
                          <Badge tone="info">{n.tag}</Badge>
                        </span>
                      ) : (
                        <span className="small strong">{n.title}</span>
                      )}
                      {n.body && <span className="xs sub">{isoInText(n.body)}</span>}
                      <span className={n.strong ? 'xs strong' : 'xs muted'}>
                        {n.when}
                        {n.link && (
                          <>
                            {n.when && ' · '}
                            {n.link.to ? (
                              <Link to={n.link.to} className="link-inline">
                                {n.link.label}
                              </Link>
                            ) : (
                              <a href={n.link.external} className="link-inline" target="_blank" rel="noopener noreferrer">
                                {n.link.label}
                              </a>
                            )}
                          </>
                        )}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      <PeriodPerformance part="details" />
    </SellerLayout>
  );
}
