import { useState } from 'react';
import { Link } from 'react-router';
import { STAFF } from '@marketly/web-shared/data/staff';
import { sellers } from '@marketly/web-shared/data/fixtures';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { money } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Deadline, Dialog, Field, Icon, KeyValue, LogoTile, Meter, OptionCard, PageHeader, Select, StatusBadge, SummaryRow, TableWrap, Tabs, Textarea, TextInput } from '@marketly/web-shared/ui';
import {
  ACCOUNT_KV, APPEALS, HISTORY, METRICS, OBLIGATIONS, PAYOUTS, RESTRICTION, SECOND_REVIEWERS, SELLER_PROFILE, SUSPEND_EFFECTS, SUSPEND_ORDER_OPTIONS, SUSPEND_REASONS, SUSPEND_SAMPLE,
  type HistoryEvent, type ObKind,
} from './data/seller';

// Design: pages/admin/admin-seller.html · view "suspend-seller" = the suspend dialog.

const NOTE: Record<'success' | 'warning' | 'danger', string> = { success: 'Within target', warning: 'Near target', danger: 'Below target' };
const OB_LINK: Record<ObKind, (ref: string) => string> = {
  orders: (ref) => href('admin/order', '', { ref }),
  returns: () => href('admin/returns'),
  cases: (ref) => href('admin/case', '', { ref }),
};
const OB_KINDS = Object.keys(OBLIGATIONS) as ObKind[];

type OrderChoice = (typeof SUSPEND_ORDER_OPTIONS)[number]['value'];
interface SuspendDraft {
  orders: OrderChoice;
  reason: string;
  date: string;
  details: string;
  reviewer: string;
}
const BLANK: SuspendDraft = { orders: 'keep', reason: '', date: SUSPEND_SAMPLE.date, details: '', reviewer: SECOND_REVIEWERS[0] };

function validate(d: SuspendDraft) {
  const e: Partial<Record<keyof SuspendDraft, string>> = {};
  if (!d.reason) e.reason = 'Choose a reason.';
  if (!d.date.trim()) e.date = 'Enter a review date.';
  if (!d.details.trim()) e.details = 'Write the details shown to the seller. Include facts and what the seller can do to resolve it.';
  return e;
}

/** Timeline with the design's "At risk:" note on amber events. */
function HistoryTimeline({ events }: { events: HistoryEvent[] }) {
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e.t + e.d} className={`ev is-${e.state}`}>
          {e.state === 'warn' && <span className="sr-only">At risk: </span>}
          <span className="dot" aria-hidden="true" />
          <div className="stack gap-1">
            <span className="t">{e.t}</span>
            <span className="d">{e.d}</span>
            {e.body && <div className="small sub">{e.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function Seller() {
  const s = sellers.gadgetgrove;
  const [view, setView] = useView<'suspend-seller'>();
  const [status, setStatus] = useState(s.status);
  const [history, setHistory] = useState(HISTORY);
  const [flash, setFlash] = useState('');
  const [obTab, setObTab] = useState<ObKind>('orders');
  const [reminded, setReminded] = useState<Record<string, boolean>>({});
  // The design's "suspend-seller" view shows the dialog filled in.
  const [draft, setDraft] = useState<SuspendDraft>(() => (view === 'suspend-seller' ? { ...BLANK, ...SUSPEND_SAMPLE } : BLANK));
  const [tried, setTried] = useState(false);

  const pending = status === 'Suspension pending';
  const open = view === 'suspend-seller' && !pending;
  const errors = tried ? validate(draft) : {};
  const set = <K extends keyof SuspendDraft>(k: K, v: SuspendDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const ob = OBLIGATIONS[obTab];
  const others = OB_KINDS.filter((k) => k !== obTab);

  const openSuspend = () => {
    setDraft(BLANK);
    setTried(false);
    setView('suspend-seller');
  };
  const close = () => setView('');
  const submit = () => {
    setTried(true);
    if (Object.keys(validate(draft)).length) return;
    const reviewer = draft.reviewer.split(' · ')[0];
    setStatus('Suspension pending');
    setHistory((h) => [
      {
        t: 'Suspension sent to second reviewer',
        d: `Today · ${STAFF.admin.name}`,
        state: 'current',
        body: `Reason: ${draft.reason.toLowerCase()}. Review date ${draft.date}. Waiting for ${reviewer}.${draft.orders === 'cancel' ? ' Unshipped orders to be cancelled and refunded (Finance approval needed).' : ''}`,
      },
      ...h.map((e) => (e.state === 'current' ? { ...e, state: 'done' as const } : e)),
    ]);
    setFlash(`${reviewer} has been asked to approve the suspension. New sales continue until it is approved.`);
    close();
  };

  const statusBadge = pending ? <StatusBadge status={status} tone="danger" /> : <StatusBadge status={status} />;

  return (
    <AdminLayout active="sellers">
      <PageHeader
        crumbs={[{ label: 'Sellers', to: href('admin/sellers') }, { label: s.name }]}
        title={
          <span className="row gap-3">
            <LogoTile initials={s.initials} tint={s.tint} />
            <span>{s.name}</span>
          </span>
        }
        sub={
          <>
            {s.location} · seller since {SELLER_PROFILE.since} · owner {SELLER_PROFILE.owner} · account manager {SELLER_PROFILE.manager} · {statusBadge} <span className="xs muted">{s.verified ? 'Verified' : 'Not verified'}</span>
          </>
        }
        actions={
          <>
            <Button variant="secondary" size="sm" icon="mail">
              Message seller
            </Button>
            <Button variant="secondary" size="sm" icon="pencil">
              Edit restriction
            </Button>
            {pending ? (
              <Button variant="danger-soft" size="sm" icon="ban" disabled>
                Suspension pending
              </Button>
            ) : (
              <Button variant="danger-soft" size="sm" icon="ban" to={href('admin/seller', 'suspend-seller')} onClick={(e) => (e.preventDefault(), openSuspend())}>
                Suspend
              </Button>
            )}
          </>
        }
      />
      {flash && (
        <Alert tone="success" title="Suspension sent for second review">
          {flash}
        </Alert>
      )}
      <section className="card u-bc-warning">
        <div className="card-head">
          <div className="row gap-2">
            <Icon name="triangle-alert" />
            <h2 className="h4">Active restriction since Oct 2, 2026</h2>
          </div>
          <Badge tone="warning" icon="calendar">
            Review Oct 30
          </Badge>
        </div>
        <div className="card-body">
          <KeyValue pairs={RESTRICTION} />
        </div>
      </section>
      <div className="aa-split">
        <div className="stack gap-5">
          <Card title="Performance vs targets" sub="Last 30 days · 186 orders" titleAs="h3">
            <div className="aa-perf">
              {METRICS.map((m) => (
                <div key={m.label} className="aa-metric">
                  <span className="xs strong muted">{m.label}</span>
                  <span className="row between base">
                    <span className="v">{m.value}</span>
                    <span className="xs muted">{m.target}</span>
                  </span>
                  <Meter pct={m.pct} tone={m.tone} label={`${m.value} ${m.target}`} />
                  {m.tone === 'success' ? (
                    <span className="xs muted">{NOTE.success}</span>
                  ) : (
                    <>
                      <span className={`xs strong meter-note t-${m.tone}-text`}>{NOTE[m.tone]}</span>
                      {m.detail && <span className={`xs t-${m.tone}-text strong`}>{m.detail}</span>}
                    </>
                  )}
                </div>
              ))}
            </div>
            <span className="xs muted">Policy violations in 90 days: 2 (condition misdescribed). Seller feedback: {s.positive}% positive from {s.ratings} ratings.</span>
          </Card>
          <Card title="Open obligations" sub="Stay accessible during any restriction or suspension" titleAs="h3" flush>
            <Tabs items={OB_KINDS.map((k) => ({ value: k, label: OBLIGATIONS[k].tab, count: OBLIGATIONS[k].count }))} active={obTab} onChange={setObTab} />
            <TableWrap label="Open obligations table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{ob.col}</th>
                    <th scope="col">Item</th>
                    <th scope="col">Status</th>
                    <th scope="col">Deadline</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ob.rows.map((r) => (
                    <tr key={r.ref} className={cx(r.urgent && 'is-flagged')}>
                      <td>
                        {r.urgent && <span className="sr-only">Urgent: </span>}
                        <Link className="mono strong nowrap" to={OB_LINK[obTab](r.ref)} title={r.ref}>
                          {r.ref}
                        </Link>
                      </td>
                      <td>{r.item}</td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                      <td>
                        <Deadline tone={r.deadline.tone}>{r.deadline.text}</Deadline>
                      </td>
                      <td>
                        {r.urgent && (
                          <button type="button" className="btn btn-ghost btn-sm" disabled={reminded[r.ref]} onClick={() => setReminded((m) => ({ ...m, [r.ref]: true }))}>
                            <span>{reminded[r.ref] ? 'Reminded' : 'Remind'}</span>
                            <span className="sr-only"> {r.ref}</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            {ob.rows.some((r) => r.urgent) && (
              <p className="status-legend status-legend--edge">
                <span className="sr-only">Legend: </span>
                <span className="sl sl-danger">
                  <i aria-hidden="true" />
                  Red edge = urgent: overdue or past target
                </span>
              </p>
            )}
            <div className="card-body u-pt-sp-2">
              <span className="xs muted">
                Also open: {others.map((k) => `${OBLIGATIONS[k].tab.toLowerCase()} ${listRefs(OBLIGATIONS[k].rows.map((r) => r.ref))}`).join(' · ')}.
              </span>
            </div>
          </Card>
          <Card title="Appeals" titleAs="h3" flush>
            <TableWrap label="Appeals table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Appeal</th>
                    <th scope="col">Submitted</th>
                    <th scope="col">Argument</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {APPEALS.map((a) => (
                    <tr key={a.ref}>
                      <td>
                        <span className="mono nowrap" title={a.ref}>
                          {a.ref}
                        </span>
                      </td>
                      <td>{a.submitted}</td>
                      <td>
                        <span className="small">{a.argument}</span>
                      </td>
                      <td>{a.owner}</td>
                      <td>
                        <span className="stack gap-1">
                          <StatusBadge status={a.status} />
                          {a.due ? <Deadline tone="warning">{a.due}</Deadline> : <span className="xs muted">{a.outcome}</span>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
          <Card
            title="Action history"
            titleAs="h3"
            actions={
              <Link className="small strong" to={href('admin/audit')}>
                Full log
              </Link>
            }
          >
            <HistoryTimeline events={history} />
          </Card>
        </div>
        <div className="stack gap-5">
          <Card title="Account" titleAs="h3">
            <KeyValue pairs={[['Account status', statusBadge], ...ACCOUNT_KV]} />
          </Card>
          <Card
            title="Payouts and holds"
            titleAs="h3"
            actions={
              <Link className="small strong" to={href('admin/payouts')}>
                Finance view
              </Link>
            }
          >
            <div className="stack gap-2">
              <SummaryRow k="Pending earnings" v={money(PAYOUTS.pending)} />
              <SummaryRow k="Available" v={money(PAYOUTS.available)} />
              <SummaryRow k="Held" v={<span className="t-warning-text strong">{money(PAYOUTS.held)}</span>} />
            </div>
            <div className="panel stack gap-1">
              <span className="small strong">Hold · {money(PAYOUTS.held)}</span>
              <span className="xs sub">{PAYOUTS.holdNote}</span>
            </div>
            <div className="row between small">
              <span>Next payout · {PAYOUTS.next}</span>
              <StatusBadge status="Scheduled" />
            </div>
            <span className="xs muted">
              {money(PAYOUTS.available)} to {PAYOUTS.bank}. Scheduled is not paid; the seller sees "Paid" only after the bank confirms.
            </span>
          </Card>
          <Card title="Notes" titleAs="h3">
            <div className="aa-note">
              <span className="row between xs">
                <b>Grace Kim</b>
                <span className="muted">Oct 7</span>
              </span>
              <span>Pickup log checks out for 3 days only. Not enough to explain 34 late orders. Leaning toward keeping the restriction.</span>
            </div>
            <Field label="Add a note">
              <Textarea id="aa-sd-note" placeholder="Visible to staff only" />
            </Field>
          </Card>
        </div>
      </div>

      <Dialog
        open={open}
        onClose={close}
        title={`Suspend ${s.name}`}
        size="lg"
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" icon="send" onClick={submit}>
              Send to second reviewer
            </Button>
          </>
        }
      >
        <Alert tone="danger" title="Suspension stops all new sales">
          Customers can no longer buy from {s.name}. Existing orders, returns and cases stay open and accessible to the seller and our teams until they are resolved.
        </Alert>
        <div className="stack gap-2">
          <span className="label">What happens</span>
          <TableWrap label={`Suspend ${s.name} table`}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Area</th>
                  <th scope="col">Effect</th>
                </tr>
              </thead>
              <tbody>
                {SUSPEND_EFFECTS.map(([area, effect]) => (
                  <tr key={area}>
                    <td>
                      <span className="small strong">{area}</span>
                    </td>
                    <td>
                      <span className="small">{effect}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </div>
        <div className="stack gap-2">
          <span className="label">Open orders</span>
          {SUSPEND_ORDER_OPTIONS.map((o) => (
            <OptionCard
              key={o.id}
              id={o.id}
              name="aa-ss-o"
              title={<span className="small strong">{o.title}</span>}
              body={o.body}
              checked={draft.orders === o.value}
              onChange={() => set('orders', o.value)}
            />
          ))}
        </div>
        <div className="grid md2 gap-3">
          <Field label="Reason" error={errors.reason}>
            <Select id="aa-ss-r" options={[{ value: '', label: 'Choose a reason' }, ...SUSPEND_REASONS.map((r) => ({ value: r, label: r }))]} value={draft.reason} onChange={(e) => set('reason', e.target.value)} />
          </Field>
          <Field label="Review date" error={errors.date}>
            <TextInput id="aa-ss-d" value={draft.date} error={!!errors.date} onChange={(e) => set('date', e.target.value)} placeholder="" />
          </Field>
        </div>
        <Field label="Details shown to the seller" hint="Required. Include facts and what the seller can do to resolve it." error={errors.details}>
          <Textarea id="aa-ss-x" value={draft.details} onChange={(e) => set('details', e.target.value)} placeholder="" />
        </Field>
        <div className="well stack gap-2">
          <Field label="Second reviewer" hint="Suspension takes effect only after a second reviewer approves.">
            <Select id="aa-ss-rv" options={SECOND_REVIEWERS} value={draft.reviewer} onChange={(e) => set('reviewer', e.target.value)} />
          </Field>
          <span className="xs muted">Appeal route: seller can appeal in Seller Center within 14 days. Appeals are decided by someone who did not make this decision.</span>
        </div>
      </Dialog>
    </AdminLayout>
  );
}

/** ["a", "b"] -> "a and b"; ["a", "b", "c"] -> "a, b, c" (as in the design copy). */
function listRefs(refs: string[]) {
  return refs.length === 2 ? `${refs[0]} and ${refs[1]}` : refs.join(', ');
}
