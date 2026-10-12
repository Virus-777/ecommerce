import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { money } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Card, Deadline, Dialog, Field, Icon, KeyValue, Legend, Meter, PageHeader, SegmentedControl, SplitBar, Stat, StatusBadge, TableWrap, Tabs, Textarea, announce, type IconName } from '@marketly/web-shared/ui';
import {
  CATEGORY_RATES, DISCOUNT_FUNDING, DISPUTES, FEE_RULES, FINANCE_KPIS, MONEY_FLOW, MONEY_PANELS, PERIODS, REFUNDS, UNEXPLAINED,
  type DisputeRow, type Edge, type Period, type Person, type RefundRow, type UnexplainedRow,
} from './data/finance';

// Design: pages/admin/admin-finance.html · views "disputes-and-chargebacks" and "refunds-failing"
// are the tabs of the Finance queues card.

type Tab = 'disputes-and-chargebacks' | 'refunds-failing';

const LEGEND_TEXT = { danger: 'Red edge = urgent: overdue or past target', warning: 'Amber edge = at risk: due soon or near target' } as const;

/** Status legend with the design's sr-only "Legend: " prefix (the shared StatusLegend omits it). */
function EdgeLegend({ items }: { items: Array<keyof typeof LEGEND_TEXT> }) {
  return (
    <p className="status-legend status-legend--edge">
      <span className="sr-only">Legend: </span>
      {items.map((t) => (
        <span key={t} className={`sl sl-${t}`}>
          <i aria-hidden="true" />
          {LEGEND_TEXT[t]}
        </span>
      ))}
    </p>
  );
}

const edgeClass = (e: Edge) => cx(e === 'flagged' && 'is-flagged', e === 'warn' && 'is-warn');

function EdgeMark({ edge }: { edge: Edge }) {
  if (edge === 'flagged') return <span className="sr-only">Urgent: </span>;
  if (edge === 'warn') return <span className="sr-only">At risk: </span>;
  return null;
}

function PersonCell({ p }: { p: Person }) {
  return (
    <span className="row nowrap gap-2">
      <Avatar name={p.name} className="ab-av-sm" />
      <span className="ab-cell">
        <span className="strong">{p.name}</span>
        <span className="xs muted">{p.role}</span>
      </span>
    </span>
  );
}

/** Row action button: visible label plus the row reference for screen readers. */
function RowButton({ variant = 'secondary', icon, sr, onClick, children }: { variant?: 'secondary' | 'ghost'; icon?: IconName; sr?: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`btn btn-${variant} btn-sm`} onClick={onClick}>
      {icon && <Icon name={icon} />}
      <span>{children}</span>
      {sr && <span className="sr-only"> {sr}</span>}
    </button>
  );
}

const orderLink = (ref: string) => (
  <Link className="mono nowrap" to={href('admin/order', '', { ref })} title={ref}>
    {ref}
  </Link>
);
const refLink = (ref: string) => (
  <a className="mono nowrap" href="#" title={ref}>
    {ref}
  </a>
);

/** Evidence due within a day: the row is at risk. */
const dueSoon = (d: DisputeRow) => 'tone' in d.due && d.due.tone === 'warning';

type Pending = { kind: 'resolve'; row: UnexplainedRow } | { kind: 'evidence'; row: DisputeRow } | null;

export default function Finance() {
  const [view] = useView<Tab>();
  const tab: Tab | '' = view === 'disputes-and-chargebacks' || view === 'refunds-failing' ? view : '';
  const [period, setPeriod] = useState<Period>('mtd');
  const [unexplained, setUnexplained] = useState(UNEXPLAINED);
  const [disputes, setDisputes] = useState(DISPUTES);
  const [refunds, setRefunds] = useState(REFUNDS);
  const [done, setDone] = useState<{ tab: Tab | ''; title: string; body: string } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [note, setNote] = useState('');
  const [attempted, setAttempted] = useState(false);

  const range = PERIODS.find((p) => p.value === period)!.range;
  const openRefunds = refunds.filter((r) => r.status === 'Failed' || r.status === 'Checking').length;

  const open = (p: Pending) => {
    setPending(p);
    setNote('');
    setAttempted(false);
  };
  const close = () => setPending(null);
  const noteError = attempted && !note.trim() ? (pending?.kind === 'evidence' ? 'Describe the evidence before you submit it.' : 'Enter a reason. Every correction needs a recorded reason.') : undefined;

  const submit = () => {
    setAttempted(true);
    if (!pending || !note.trim()) return;
    if (pending.kind === 'resolve') {
      const r = pending.row;
      setUnexplained((l) => l.filter((x) => x.ref !== r.ref));
      setDone({ tab: '', title: `${r.ref} resolved`, body: `${r.action} recorded with your reason. It appears in Action history.` });
    } else {
      const r = pending.row;
      setDisputes((l) => l.map((x) => (x.ref === r.ref ? { ...x, status: 'Under review', due: { note: 'Evidence sent Oct 8' }, action: 'Open' } : x)));
      setDone({ tab: 'disputes-and-chargebacks', title: `Evidence submitted for ${r.ref}`, body: 'The provider usually decides within 60 days. The seller hold stays until then.' });
    }
    announce('Saved');
    close();
  };

  const refundAction = (r: RefundRow) => {
    if (r.action?.kind === 'ask') {
      setRefunds((l) => l.map((x) => (x.ref === r.ref ? { ...x, status: 'Waiting on customer', action: null } : x)));
      setDone({ tab: 'refunds-failing', title: `Asked ${r.customer} for a new refund method`, body: 'The refund stays Failed until the customer adds a method. We retry automatically.' });
    } else {
      setRefunds((l) => l.map((x) => (x.ref === r.ref ? { ...x, status: 'Sent', edge: '', action: null } : x)));
      setDone({ tab: 'refunds-failing', title: `${r.ref} was sent`, body: 'The provider confirmed the refund. No retry is needed.' });
    }
  };

  const tabs = [
    { label: 'Unexplained amounts', value: '', count: unexplained.length, to: href('admin/finance') },
    { label: 'Disputes and chargebacks', value: 'disputes-and-chargebacks', count: disputes.length, to: href('admin/finance', 'disputes-and-chargebacks') },
    { label: 'Refunds failing', value: 'refunds-failing', count: openRefunds, to: href('admin/finance', 'refunds-failing') },
  ];

  const discountTotal = DISCOUNT_FUNDING.reduce((s, d) => s + d.amount, 0);

  return (
    <AdminLayout active="finance">
      <PageHeader
        crumbs={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Finance' }]}
        title="Payments and fees"
        sub={`${range} · USD · Pacific Time · counted by payment date · owner Priya Nair, Finance Manager`}
        actions={
          <>
            <SegmentedControl items={PERIODS} active={period} onChange={setPeriod} />
            <Button variant="secondary" size="sm" icon="download">
              Export
            </Button>
          </>
        }
      />
      <div className="ab-kpis k6">
        {FINANCE_KPIS.map((k) => (
          <div key={k.label} className="card pad">
            <Stat icon={k.icon} label={k.label} value={k.value} note={k.note} />
          </div>
        ))}
      </div>
      <div className="ab-main">
        <div className="stack gap-5">
          <Card
            title="Finance queues"
            sub="Work these before the Friday payout run"
            flush
            footClassName={tab ? 'start' : 'between'}
            foot={
              tab === 'disputes-and-chargebacks' ? (
                <p className="ab-note">
                  <Icon name="info" className="ic-sm" /> Example rule: the marketplace fee is kept while a chargeback is open and returned to the seller if we win. Final treatment is in the seller agreement.
                </p>
              ) : tab === 'refunds-failing' ? (
                <p className="ab-note">
                  <Icon name="info" className="ic-sm" /> A retry first asks the payment provider for the result, so a refund is never sent twice. The customer sees "Failed" with the next step, not "Sent".
                </p>
              ) : (
                <>
                  <p className="ab-note">
                    <Icon name="info" className="ic-sm" /> Every correction needs a recorded reason. Corrections over $500 need a second Finance reviewer.
                  </p>
                  <Link className="small strong" to={href('ops/finance-checks')}>
                    Daily finance checks <Icon name="arrow-right" className="ic-sm" />
                  </Link>
                </>
              )
            }
          >
            <div className="u-p-0-sp-4">
              <Tabs items={tabs} active={tab} />
            </div>
            {tab === 'disputes-and-chargebacks' && (
              <div className="card-body u-pb-0">
                <Alert tone="info" title="What a chargeback is">
                  A chargeback happens when a customer disputes a charge with their card issuer or payment provider instead of with us; the provider takes the money back until the dispute is decided.
                </Alert>
              </div>
            )}
            {done && done.tab === tab && (
              <div className="card-body u-pb-0">
                <Alert tone="success" title={done.title}>
                  {done.body}
                </Alert>
              </div>
            )}
            <TableWrap label="Finance queues table">
              {tab === 'disputes-and-chargebacks' ? (
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Case</th>
                      <th scope="col">Order and seller</th>
                      <th scope="col">Customer</th>
                      <th scope="col">Reason given</th>
                      <th className="r" scope="col">Amount</th>
                      <th scope="col">Evidence due</th>
                      <th scope="col">Seller balance effect</th>
                      <th scope="col">Status</th>
                      <th className="col-pin" scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {disputes.map((d) => (
                      <tr key={d.ref} className={edgeClass(dueSoon(d) ? 'warn' : '')}>
                        <td>
                          <EdgeMark edge={dueSoon(d) ? 'warn' : ''} />
                          {refLink(d.ref)}
                        </td>
                        <td>
                          <span className="ab-cell">
                            <span className="strong">{orderLink(d.order)}</span>
                            <span className="xs muted">{d.seller}</span>
                          </span>
                        </td>
                        <td>{d.customer}</td>
                        <td>{d.reason}</td>
                        <td className="r">
                          <span className="num">{money(d.amount)}</span>
                        </td>
                        <td>{'tone' in d.due ? <Deadline tone={d.due.tone}>{d.due.text}</Deadline> : <span className="xs muted">{d.due.note}</span>}</td>
                        <td>
                          {'held' in d.effect ? (
                            <Badge tone="warning">Held {money(d.effect.held)}</Badge>
                          ) : d.effect.released ? (
                            <span className="xs t-success-text strong">{d.effect.note}</span>
                          ) : (
                            <span className="xs muted">{d.effect.note}</span>
                          )}
                        </td>
                        <td>
                          <StatusBadge status={d.status} />
                        </td>
                        <td className="col-pin">
                          {d.action === 'Submit evidence' ? (
                            <RowButton sr={d.ref} onClick={() => open({ kind: 'evidence', row: d })}>
                              Submit evidence
                            </RowButton>
                          ) : (
                            <RowButton variant="ghost" sr={d.ref}>
                              Open
                            </RowButton>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : tab === 'refunds-failing' ? (
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Refund</th>
                      <th scope="col">Order</th>
                      <th scope="col">Customer</th>
                      <th className="r" scope="col">Amount</th>
                      <th scope="col">Why it failed</th>
                      <th scope="col">Attempts</th>
                      <th scope="col">Status</th>
                      <th className="col-pin" scope="col">
                        Next step
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {refunds.map((r) => (
                      <tr key={r.ref} className={edgeClass(r.edge)}>
                        <td>
                          <EdgeMark edge={r.edge} />
                          {refLink(r.ref)}
                        </td>
                        <td>{orderLink(r.order)}</td>
                        <td>{r.customer}</td>
                        <td className="r">
                          <span className="num">{money(r.amount)}</span>
                        </td>
                        <td>
                          <span className="ab-cell">
                            <span className="strong">{r.why}</span>
                            <span className="xs muted">{r.whyDetail}</span>
                          </span>
                        </td>
                        <td>{r.attempts}</td>
                        <td>
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="col-pin">
                          {r.action ? (
                            <RowButton icon={r.action.icon} sr={r.action.srRef ? r.ref : undefined} onClick={() => refundAction(r)}>
                              {r.action.label}
                            </RowButton>
                          ) : (
                            <span className="xs muted">{r.status === 'Sent' ? 'No retry needed' : 'Request sent'}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Reference</th>
                      <th scope="col">What we found</th>
                      <th className="r" scope="col">Difference</th>
                      <th scope="col">Detected</th>
                      <th scope="col">Owner</th>
                      <th className="col-pin" scope="col">
                        Next step
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {unexplained.length === 0 && (
                      <tr>
                        <td colSpan={6} className="muted">
                          No unexplained amounts. Every difference has a recorded reason.
                        </td>
                      </tr>
                    )}
                    {unexplained.map((u) => (
                      <tr key={u.ref} className={edgeClass(u.edge)}>
                        <td>
                          <EdgeMark edge={u.edge} />
                          {u.isOrder ? orderLink(u.ref) : refLink(u.ref)}
                        </td>
                        <td>
                          <span className="ab-cell">
                            <span className="strong">{u.title}</span>
                            <span className="xs muted">{u.detail}</span>
                          </span>
                        </td>
                        <td className="r">{u.diff < 0 ? <span className="t-danger-text strong num">−{money(-u.diff)}</span> : <span className="num strong">{money(u.diff)}</span>}</td>
                        <td>{u.detected}</td>
                        <td>
                          <PersonCell p={u.owner} />
                        </td>
                        <td className="col-pin">
                          <RowButton sr={u.ref} onClick={() => open({ kind: 'resolve', row: u })}>
                            {u.action}
                          </RowButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </TableWrap>
            <EdgeLegend items={tab === 'refunds-failing' ? ['danger', 'warning'] : ['warning']} />
          </Card>

          <Card title="Where the money went" sub="Month to date · one payment can cover several seller groups" titleAs="h3">
            <div className="ab-flow">
              {MONEY_FLOW.map((f) => (
                <div key={f.label} className="r">
                  <span>{f.label}</span>
                  <b>{f.value}</b>
                  <Meter pct={f.pct} tone={f.tone} label={`${f.label} ${f.value}`} />
                  {f.note && <span className="xs strong meter-note t-warning-text">{f.note}</span>}
                </div>
              ))}
            </div>
            <div className="divider" />
            <div className="grid md3 gap-3">
              {MONEY_PANELS.map((p) => (
                <div key={p.k} className="panel stack gap-1">
                  <span className="xs muted">{p.k}</span>
                  <b className="num">{p.v}</b>
                  <span className="xs muted">{p.note}</span>
                </div>
              ))}
            </div>
            <div className="stack gap-2">
              <div className="row between xs sub">
                <span>Official Store 58%</span>
                <span>Marketplace sellers 42%</span>
              </div>
              <SplitBar a={58} b={42} />
              <Legend items={['Official Store', 'Marketplace sellers']} />
            </div>
            <p className="ab-note">
              <Icon name="info" className="ic-sm" /> Seller sales are not marketplace income. Only the fee portion is income. Company proceeds stay in company trading reports and are never part of a seller payout.
            </p>
          </Card>
        </div>
        <div className="stack gap-5">
          <Card
            title="Fee rules"
            sub="Effective Sep 1, 2026 · seller agreement v2.0"
            titleAs="h3"
            actions={
              <Button variant="ghost" size="sm" to={href('admin/settings')}>
                Edit in settings
              </Button>
            }
          >
            <KeyValue pairs={FEE_RULES} />
            <div className="divider" />
            <span className="small strong">Category rates</span>
            <TableWrap label="Fee rules table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Category</th>
                    <th className="r col-pin" scope="col">
                      Rate
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {CATEGORY_RATES.map((c) => (
                    <tr key={c.category}>
                      <td>{c.category}</td>
                      <td className="r col-pin">{c.rate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <div className="panel small">
              <b>Illustration:</b> a $100.00 item sale with a 10% fee creates $10.00 of fee income and $90.00 of seller earnings before other adjustments.
            </div>
            <p className="ab-note">
              <Icon name="info" className="ic-sm" /> Example rates. Final fees are in the seller agreement.
            </p>
          </Card>
          <Card title="Discount funding this month" sub="Recorded separately from sales" titleAs="h3">
            <div className="ab-sumlist">
              {DISCOUNT_FUNDING.map((d) => (
                <div key={d.label}>
                  <span>{d.label}</span>
                  <span>{money(d.amount)}</span>
                </div>
              ))}
              <div>
                <span>Total discount cost</span>
                <span>
                  <b>{money(discountTotal)}</b>
                </span>
              </div>
            </div>
            <Link className="small strong" to={href('admin/promotions')}>
              Campaign results <Icon name="arrow-right" className="ic-sm" />
            </Link>
          </Card>
        </div>
      </div>

      <Dialog
        open={pending !== null}
        onClose={close}
        title={pending ? (pending.kind === 'evidence' ? `Submit evidence for ${pending.row.ref}` : `${pending.row.action} · ${pending.row.ref}`) : ''}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={submit}>{pending?.kind === 'evidence' ? 'Submit evidence' : 'Record and resolve'}</Button>
          </>
        }
      >
        {pending?.kind === 'resolve' && (
          <p className="small sub">
            {pending.row.title}. {pending.row.detail}
          </p>
        )}
        {pending?.kind === 'evidence' && (
          <p className="small sub">
            {pending.row.customer} · {pending.row.reason} · {money(pending.row.amount)} · order {pending.row.order}
          </p>
        )}
        <Field
          label={pending?.kind === 'evidence' ? 'Evidence summary' : 'Reason for the record'}
          hint={pending?.kind === 'evidence' ? 'Tracking, delivery photos and messages you are sending to the provider.' : 'Shown in Action history with your name.'}
          error={noteError}
        >
          <Textarea id="fi-note" value={note} onChange={(e) => setNote(e.target.value)} aria-required="true" />
        </Field>
      </Dialog>
    </AdminLayout>
  );
}
