import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { OpsLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { money } from '@/lib/format';
import { href } from '@/routes/href';
import { Alert, Button, Card, Deadline, Field, Icon, Meter, PageHeader, Select, Stat, StatusBadge, TableWrap, Textarea, TextInput, announce } from '@/ui';
import { EDGE_URGENT, OpsLegend } from './data/shared';

// Design: pages/ops/ops-finance-checks.html (single view): settlement checks for Oct 7, with the
// correction form open for MK-261007-41022 (over $200, so it needs a second reviewer).

const LIMIT = 200;
const LEGEND = [{ tone: 'danger' as const, label: EDGE_URGENT }];
const clock = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

interface Payment {
  order: string;
  method: string;
  collected: number;
  total: number;
  age: string;
  status: string;
  note: string;
}
const PAYMENTS: Payment[] = [
  { order: 'MK-261007-41022', method: 'Visa •••• 9012', collected: 1850, total: 1580, age: '1 d', status: 'Mismatch', note: 'Possible duplicate capture' },
  { order: 'MK-261006-37110', method: 'Mastercard •••• 5521', collected: 96.15, total: 104.15, age: '2 d', status: 'Mismatch', note: 'Coupon applied after authorization' },
  { order: 'MK-261007-39876', method: 'PayPal', collected: 312.4, total: 312.4, age: '1 d', status: 'Matched', note: 'Matched after payment retry' },
];

interface SellerAmount {
  seller: string;
  statement: string;
  expected: number;
  recorded: number;
  age: string;
  status: string;
  note: string;
}
const SELLER_AMOUNTS: SellerAmount[] = [
  { seller: 'Pixel & Port', statement: 'ST-2610-PP-02', expected: 4212.6, recorded: 4182.6, age: '1 d', status: 'Mismatch', note: 'Fee charged on shipping' },
  { seller: 'Casa Verde Home', statement: 'ST-2610-CV-02', expected: 2045, recorded: 1805, age: '3 d', status: 'Mismatch', note: 'Post-payout refund deducted twice' },
  { seller: 'Northwind Audio', statement: 'ST-2610-NA-02', expected: 3118.2, recorded: 3118.2, age: '1 d', status: 'Matched', note: '—' },
];

const CHARGEBACKS = [
  { id: 'CB-261005-0019', order: 'MK-260921-18833', seller: 'Trailhead Outfitters', amount: 139, reason: 'Item not received', due: 'Oct 12', status: 'Chargeback' },
  { id: 'CB-261007-0022', order: 'MK-260930-24410', seller: 'Marketly Official', amount: 329, reason: 'Unauthorized transaction', due: 'Oct 15', status: 'Disputed' },
];

const FAILED_PAYOUTS = [
  { id: 'PO-261002-0311', seller: 'Trailhead Outfitters', amount: 2904.18, failure: 'Bank rejected: account closed', age: '6 d', status: 'Failed', next: 'Request new payout details' },
  { id: 'PO-261002-0316', seller: 'Gadget Grove', amount: 611.4, failure: 'Account name does not match', age: '6 d', status: 'Failed', next: 'Held: seller restricted' },
];

const UNEXPLAINED = [{ item: 'Processor deposit for Oct 7', expected: 84210.33, received: 84198.03, age: '1 d', status: 'Mismatch', owner: 'Priya Nair' }];

type CheckId = 'deposit' | 'chargebacks' | 'payments' | 'sellers' | 'payouts' | 'unexplained';
interface CheckItem {
  id: CheckId;
  title: string;
  done?: string;
  late?: boolean;
}
const CHECKS: CheckItem[] = [
  { id: 'deposit', title: 'Processor deposit received', done: 'Done 8:05 AM · 1 unexplained difference logged' },
  { id: 'chargebacks', title: 'Chargebacks reviewed', done: 'Done 9:20 AM · 2 responses scheduled' },
  { id: 'payments', title: 'Payments matched to orders' },
  { id: 'sellers', title: 'Seller amounts match statements' },
  { id: 'payouts', title: 'Failed payouts followed up', late: true },
  { id: 'unexplained', title: 'Unexplained amounts explained' },
];

const CORRECTIONS = ['Refund duplicate capture to customer', 'Adjust order total', 'Write off difference'];
const REASONS = ['Choose a reason', 'Duplicate capture by payment provider', 'Coupon applied after authorization', 'Fee calculation error', 'Other, explained in note'];

interface Draft {
  order: string;
  type: string;
  amount: string;
  reason: string;
  note: string;
}
const DESIGN_DRAFT: Draft = {
  order: 'MK-261007-41022',
  type: CORRECTIONS[0],
  amount: '270.00',
  reason: 'Duplicate capture by payment provider',
  note: 'Processor log shows two captures 4 seconds apart after a retry. Customer charged twice for the shipping upgrade.',
};

/** Signed difference: +$270.00 / −$8.00 / $0.00 (muted). */
function Diff({ d }: { d: number }) {
  if (Math.abs(d) < 0.005) return <span className="muted">{money(0)}</span>;
  return d > 0 ? <span className="ac-diff-pos">+{money(d)}</span> : <span className="ac-diff-neg">−{money(-d)}</span>;
}

const mismatch = (s: string) => s === 'Mismatch';

export default function FinanceChecks() {
  const [payments, setPayments] = useState(PAYMENTS);
  const [checks, setChecks] = useState(CHECKS);
  const [draft, setDraft] = useState<Draft>(DESIGN_DRAFT);
  const [tried, setTried] = useState(false);
  const [resolved, setResolved] = useState(0);
  const [notice, setNotice] = useState('');
  const [complete, setComplete] = useState('');
  const formRef = useRef<HTMLElement>(null);

  const target = payments.find((p) => p.order === draft.order && mismatch(p.status));
  const diff = target ? target.collected - target.total : 0;
  const amount = Number(draft.amount.replace(/[$,]/g, ''));
  const needsReview = amount > LIMIT;
  const errors = {
    amount: !(amount > 0) ? 'Enter the correction amount.' : target && amount > Math.abs(diff) + 0.005 ? `The difference on this order is ${money(Math.abs(diff))}.` : '',
    reason: draft.reason === REASONS[0] ? 'Choose a reason. Every correction is recorded with its reason.' : '',
    note: draft.reason === REASONS[4] && !draft.note.trim() ? 'Explain the correction in the note.' : '',
  };
  const shown = tried ? errors : { amount: '', reason: '', note: '' };

  const openPayments = payments.filter((p) => mismatch(p.status)).length;
  const openSellers = SELLER_AMOUNTS.filter((s) => mismatch(s.status)).length;
  const openCount: Record<CheckId, string> = {
    deposit: '',
    chargebacks: '',
    payments: openPayments ? `${openPayments} mismatches open` : 'All payments matched',
    sellers: `${openSellers} mismatches open`,
    payouts: `${FAILED_PAYOUTS.length} open for 6 days`,
    unexplained: `${UNEXPLAINED.length} open`,
  };
  const doneN = checks.filter((c) => c.done).length;
  const firstOpen = checks.find((c) => !c.done && !c.late)?.id;
  const allDone = doneN === checks.length;

  const pick = (p: Payment) => {
    const d = p.collected - p.total;
    setDraft({
      order: p.order,
      type: d > 0 ? CORRECTIONS[0] : CORRECTIONS[1],
      amount: Math.abs(d).toFixed(2),
      reason: REASONS.includes(p.note) ? p.note : REASONS[0],
      note: '',
    });
    setTried(false);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    formRef.current?.querySelector<HTMLElement>('select')?.focus({ preventScroll: true });
  };

  const submit = () => {
    if (!target) return;
    setTried(true);
    if (Object.values(errors).some(Boolean)) return;
    if (needsReview) {
      setPayments((ps) => ps.map((p) => (p.order === target.order ? { ...p, status: 'In review', note: 'Correction with Morgan Hale for second review' } : p)));
      setNotice(`Correction for ${target.order} sent to Morgan Hale, Business Owner, for second review.`);
    } else {
      setPayments((ps) => ps.map((p) => (p.order === target.order ? { ...p, status: 'Matched', collected: p.total, note: `Corrected: ${draft.type.toLowerCase()}` } : p)));
      setNotice(`Correction recorded for ${target.order}. Payment now matches the order.`);
    }
    setResolved((r) => r + Math.abs(diff));
    announce(needsReview ? 'Correction sent for second review' : 'Correction recorded');
    const next = payments.find((p) => p.order !== target.order && mismatch(p.status));
    if (next) pick(next);
    else setDraft((d) => ({ ...d, order: '' }));
  };

  const signOff = (id: CheckId) => {
    const t = clock();
    setChecks((cs) => cs.map((c) => (c.id === id ? { ...c, done: `Done ${t} · Priya Nair${openCount[id] && id !== 'payments' ? ` · ${openCount[id]}, carried to tomorrow` : ''}` } : c)));
    announce(`${checks.find((c) => c.id === id)?.title} signed off`);
  };

  const completeDay = () => {
    const t = clock();
    setComplete(`Day check for Wed, Oct 7 completed at ${t}. The summary went to Morgan Hale.`);
    announce('Day check completed');
  };

  const openMismatches = openPayments + openSellers + UNEXPLAINED.length;

  return (
    <OpsLayout active="finance-checks">
      <PageHeader
        title="Daily finance checks"
        sub="Assigned to Priya Nair, Finance Manager · backup Morgan Hale · checking Wed, Oct 7 settlement · due 12:00 PM PT"
        actions={
          <>
            <Button variant="secondary" size="sm" icon="download">
              Export
            </Button>
            <Button size="sm" icon="circle-check" disabled={!allDone || !!complete} onClick={completeDay}>
              {complete ? 'Day check completed' : 'Complete day check'}
            </Button>
          </>
        }
      />
      {complete && <Alert tone="success" title={complete} />}
      <div className="ac-main">
        <div className="stack gap-5">
          <div className="ac-kpis">
            <div className="card pad">
              <Stat label="Open mismatches" value={String(openMismatches)} note={`${money(578 - resolved)} net difference`} />
            </div>
            <div className="card pad">
              <Stat label="Chargebacks and disputes" value="2" note="$468.00 at risk" />
            </div>
            <div className="card pad">
              <Stat label="Failed payouts" value="2" note="$3,515.58" />
            </div>
            <div className="card pad">
              <Stat label="Unexplained" value="$12.30" note="processor deposit Oct 7" />
            </div>
          </div>
          {notice && <Alert tone="success" title={notice} />}
          <Card title="Payments vs orders" sub="Collected by the payment provider vs order totals" flush>
            <div className="no-phone">
              <TableWrap label="Payments vs orders table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Order</th>
                      <th scope="col">Method</th>
                      <th className="r" scope="col">Collected</th>
                      <th className="r" scope="col">Order total</th>
                      <th className="r" scope="col">Difference</th>
                      <th scope="col">Age</th>
                      <th scope="col">Status</th>
                      <th scope="col">Note</th>
                      <th className="col-pin" scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.order} className={cx(mismatch(p.status) && 'is-flagged')}>
                        <td>
                          {mismatch(p.status) && <span className="sr-only">Urgent: </span>}
                          <Link className="mono nowrap" to={href('admin/order')} title={p.order}>
                            {p.order}
                          </Link>
                        </td>
                        <td>
                          <span className="small nowrap">{p.method}</span>
                        </td>
                        <td className="r">{money(p.collected)}</td>
                        <td className="r">{money(p.total)}</td>
                        <td className="r">
                          <Diff d={p.collected - p.total} />
                        </td>
                        <td>{p.age}</td>
                        <td>
                          <StatusBadge status={p.status} />
                        </td>
                        <td>
                          <span className="xs sub">{p.note}</span>
                        </td>
                        <td className="col-pin">
                          {mismatch(p.status) && (
                            <button type="button" className="btn btn-ghost btn-sm" aria-pressed={draft.order === p.order} onClick={() => pick(p)}>
                              <span>Record correction</span>
                              <span className="sr-only"> {p.order}</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              {openPayments > 0 && <OpsLegend items={LEGEND} />}
            </div>
            <div className="ac-mlist only-phone">
              {payments.map((p) => (
                <div key={p.order} className={cx('ac-mi', mismatch(p.status) && 'is-flagged')}>
                  {mismatch(p.status) && <span className="sr-only">Urgent: </span>}
                  <div className="row between gap-2 nowrap top">
                    <span className="small strong min-w-0">
                      {mismatch(p.status) ? (
                        <a className="mono nowrap" href="#" onClick={(e) => (e.preventDefault(), pick(p))}>
                          {p.order}
                        </a>
                      ) : (
                        <Link className="mono nowrap" to={href('admin/order')}>
                          {p.order}
                        </Link>
                      )}
                    </span>
                    <StatusBadge status={p.status} />
                  </div>
                  <div className="xs sub">
                    Collected {money(p.collected)} · order {money(p.total)} · <Diff d={p.collected - p.total} />
                  </div>
                  <div className="xs sub">
                    {p.method} · {p.age} · {p.note}
                  </div>
                </div>
              ))}
            </div>
            {openPayments > 0 && <OpsLegend className="only-phone" items={LEGEND} />}
          </Card>
          <Card title="Seller amounts" titleAs="h3" sub="Statement amounts vs ledger" flush>
            <div className="no-phone">
              <TableWrap label="Seller amounts table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Seller</th>
                      <th scope="col">Statement</th>
                      <th className="r" scope="col">Expected</th>
                      <th className="r" scope="col">Recorded</th>
                      <th className="r" scope="col">Difference</th>
                      <th scope="col">Age</th>
                      <th scope="col">Status</th>
                      <th className="col-pin" scope="col">
                        Note
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {SELLER_AMOUNTS.map((s) => (
                      <tr key={s.statement} className={cx(mismatch(s.status) && 'is-flagged')}>
                        <td>
                          {mismatch(s.status) && <span className="sr-only">Urgent: </span>}
                          <span className="small strong">{s.seller}</span>
                        </td>
                        <td>
                          <span className="mono small nowrap" title={s.statement}>
                            {s.statement}
                          </span>
                        </td>
                        <td className="r">{money(s.expected)}</td>
                        <td className="r">{money(s.recorded)}</td>
                        <td className="r">
                          <Diff d={s.recorded - s.expected} />
                        </td>
                        <td>{s.age}</td>
                        <td>
                          <StatusBadge status={s.status} />
                        </td>
                        <td className="col-pin">
                          <span className="xs sub">{s.note}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <OpsLegend items={LEGEND} />
            </div>
            <div className="ac-mlist only-phone">
              {SELLER_AMOUNTS.map((s) => (
                <div key={s.statement} className={cx('ac-mi', mismatch(s.status) && 'is-flagged')}>
                  {mismatch(s.status) && <span className="sr-only">Urgent: </span>}
                  <div className="row between gap-2 nowrap top">
                    <span className="small strong min-w-0">{s.seller}</span>
                    <StatusBadge status={s.status} />
                  </div>
                  <div className="xs sub">
                    <span className="mono">{s.statement}</span> · expected {money(s.expected)} · recorded {money(s.recorded)}
                  </div>
                  <div className="xs sub">
                    <Diff d={s.recorded - s.expected} /> · {s.age}
                    {s.note !== '—' && ` · ${s.note}`}
                  </div>
                </div>
              ))}
            </div>
            <OpsLegend className="only-phone" items={LEGEND} />
          </Card>
          <Card title="Chargebacks and payment disputes" titleAs="h3" sub="A customer disputed the charge with their card provider" flush>
            <div className="no-phone">
              <TableWrap label="Chargebacks and payment disputes table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Case</th>
                      <th scope="col">Order</th>
                      <th scope="col">Seller</th>
                      <th className="r" scope="col">Amount</th>
                      <th scope="col">Reason</th>
                      <th scope="col">Response due</th>
                      <th className="col-pin" scope="col">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {CHARGEBACKS.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <span className="mono small nowrap" title={c.id}>
                            {c.id}
                          </span>
                        </td>
                        <td>
                          <Link className="mono nowrap" to={href('admin/order')} title={c.order}>
                            {c.order}
                          </Link>
                        </td>
                        <td>
                          <span className="small">{c.seller}</span>
                        </td>
                        <td className="r">{money(c.amount)}</td>
                        <td>
                          <span className="small">{c.reason}</span>
                        </td>
                        <td>
                          <Deadline tone="warning">{c.due}</Deadline>
                        </td>
                        <td className="col-pin">
                          <StatusBadge status={c.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </div>
            <div className="ac-mlist only-phone">
              {CHARGEBACKS.map((c) => (
                <div key={c.id} className="ac-mi">
                  <div className="row between gap-2 nowrap top">
                    <span className="small strong min-w-0">
                      <span className="mono">{c.id}</span>
                    </span>
                    <StatusBadge status={c.status} />
                  </div>
                  <div className="xs sub">
                    {c.seller} · {money(c.amount)} · {c.reason}
                  </div>
                  <div className="xs sub">Response due {c.due}</div>
                </div>
              ))}
            </div>
          </Card>
          <Card
            title="Failed payouts"
            titleAs="h3"
            flush
            footClassName="start"
            foot={<span className="xs muted">Funds stay in the seller's Available balance until a new payout succeeds. New bank details need verification and a 72-hour review.</span>}
          >
            <div className="no-phone">
              <TableWrap label="Failed payouts table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Payout</th>
                      <th scope="col">Seller</th>
                      <th className="r" scope="col">Amount</th>
                      <th scope="col">Failure</th>
                      <th scope="col">Age</th>
                      <th scope="col">Status</th>
                      <th className="col-pin" scope="col">
                        Next step
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {FAILED_PAYOUTS.map((p) => (
                      <tr key={p.id} className="is-flagged">
                        <td>
                          <span className="sr-only">Urgent: </span>
                          <Link className="mono nowrap" to={href('admin/payouts')} title={p.id}>
                            {p.id}
                          </Link>
                        </td>
                        <td>
                          <span className="small strong">{p.seller}</span>
                        </td>
                        <td className="r">{money(p.amount)}</td>
                        <td>
                          <span className="small">{p.failure}</span>
                        </td>
                        <td>{p.age}</td>
                        <td>
                          <StatusBadge status={p.status} />
                        </td>
                        <td className="col-pin">
                          <span className="small">{p.next}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <OpsLegend items={LEGEND} />
            </div>
            <div className="ac-mlist only-phone">
              {FAILED_PAYOUTS.map((p) => (
                <div key={p.id} className="ac-mi is-flagged">
                  <span className="sr-only">Urgent: </span>
                  <div className="row between gap-2 nowrap top">
                    <span className="small strong min-w-0">
                      <span className="mono">{p.id}</span>
                    </span>
                    <StatusBadge status={p.status} />
                  </div>
                  <div className="xs sub">
                    {p.seller} · {money(p.amount)} · {p.age}
                  </div>
                  <div className="xs sub">{p.failure}</div>
                  <div className="xs sub">Next: {p.next}</div>
                </div>
              ))}
            </div>
            <OpsLegend className="only-phone" items={LEGEND} />
          </Card>
          <Card title="Unexplained amounts" titleAs="h3" flush>
            <div className="no-phone">
              <TableWrap label="Unexplained amounts table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th className="r" scope="col">Expected</th>
                      <th className="r" scope="col">Received</th>
                      <th className="r" scope="col">Difference</th>
                      <th scope="col">Age</th>
                      <th scope="col">Status</th>
                      <th className="col-pin" scope="col">
                        Owner
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {UNEXPLAINED.map((u) => (
                      <tr key={u.item} className="is-flagged">
                        <td>
                          <span className="sr-only">Urgent: </span>
                          {u.item}
                        </td>
                        <td className="r">{money(u.expected)}</td>
                        <td className="r">{money(u.received)}</td>
                        <td className="r">
                          <Diff d={u.received - u.expected} />
                        </td>
                        <td>{u.age}</td>
                        <td>
                          <StatusBadge status={u.status} />
                        </td>
                        <td className="col-pin">{u.owner}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <OpsLegend items={LEGEND} />
            </div>
            <div className="ac-mlist only-phone">
              {UNEXPLAINED.map((u) => (
                <div key={u.item} className="ac-mi is-flagged">
                  <span className="sr-only">Urgent: </span>
                  <div className="row between gap-2 nowrap top">
                    <span className="small strong min-w-0">{u.item}</span>
                    <StatusBadge status={u.status} />
                  </div>
                  <div className="xs sub">
                    Expected {money(u.expected)} · received {money(u.received)} · <Diff d={u.received - u.expected} />
                  </div>
                </div>
              ))}
            </div>
            <OpsLegend className="only-phone" items={LEGEND} />
          </Card>
        </div>
        <div className="stack gap-5">
          <Card title="Today's checklist" titleAs="h3" sub={`${doneN} of ${checks.length} done`}>
            <Meter pct={Math.round((doneN / checks.length) * 100)} label="Today's checklist" />
            <ul>
              {checks.map((c) => {
                const state = c.done ? 'is-done' : c.late ? 'is-late' : c.id === firstOpen ? 'is-now' : '';
                return (
                  <li key={c.id} className={cx('ac-ck', state)}>
                    <span className="ic" aria-hidden="true">
                      {c.done ? <Icon name="check" /> : c.late ? <Icon name="alarm-clock" /> : null}
                    </span>
                    <span className="stack gap-0 grow">
                      <span className="small strong">{c.title}</span>
                      <span className="xs muted">{c.done ?? openCount[c.id]}</span>
                    </span>
                    {!c.done && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => signOff(c.id)}>
                        <span>Sign off</span>
                        <span className="sr-only"> {c.title}</span>
                      </button>
                    )}
                    <span className="sr-only">{c.done ? 'Done' : c.late ? 'Overdue' : 'Not done'}</span>
                  </li>
                );
              })}
            </ul>
            {!allDone && <span className="xs muted">Complete day check unlocks when every check is signed off.</span>}
          </Card>
          <section className="card" ref={formRef}>
            <div className="card-head">
              <div className="stack gap-0">
                <h3 className="h4">Record correction</h3>
                <span className="xs muted">{target ? `${target.order} · collected ${money(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than the order total` : 'No open payment mismatches'}</span>
              </div>
            </div>
            {target ? (
              <>
                <div className="card-body">
                  <Field label="Correction">
                    <Select id="fc-type" options={CORRECTIONS} value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} />
                  </Field>
                  <Field label="Amount" error={shown.amount || undefined}>
                    <TextInput id="fc-amt" prefix="$" value={draft.amount} error={!!shown.amount} inputMode="decimal" onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
                  </Field>
                  <Field label="Reason (required)" error={shown.reason || undefined}>
                    <Select id="fc-reason" options={REASONS} value={draft.reason} className={cx(shown.reason && 'is-error')} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
                  </Field>
                  <Field label="Note" error={shown.note || undefined}>
                    <Textarea id="fc-note" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
                  </Field>
                  {needsReview && (
                    <Alert tone="warning" title="Second reviewer required">
                      Corrections over ${LIMIT} need a second Finance reviewer. This goes to Morgan Hale, Business Owner.
                    </Alert>
                  )}
                  <span className="xs muted row gap-1 nowrap wrap">
                    <Icon name="info" className="ic-sm" />
                    <span>Example threshold set by the Business Owner.</span>
                  </span>
                </div>
                <div className="card-foot">
                  <Button size="sm" icon={needsReview ? 'send' : 'check'} onClick={submit}>
                    {needsReview ? 'Send for second review' : 'Record correction'}
                  </Button>
                </div>
              </>
            ) : (
              <div className="card-body">
                <p className="small muted">Every payment matches its order. Sign off "Payments matched to orders" in the checklist.</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </OpsLayout>
  );
}
