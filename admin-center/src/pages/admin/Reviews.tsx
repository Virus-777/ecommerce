import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { STAFF } from '@marketly/web-shared/data/staff';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Dialog, EmptyState, Field, Img, OptionCard, PageHeader, Select, StatusBadge, TableWrap, Tabs, Textarea, type Tone } from '@marketly/web-shared/ui';
import {
  DECIDED_SEED, LEGIT, POLICY_REASONS, QA_ROWS, REPORTED, RESPONSE_ROWS, ROW_REASONS,
  type DecidedRow, type Edge, type QaRow, type ReportedItem, type ReportKind, type ReportOutcome, type ResponseRow, type RowAction,
} from './data/reviews';

// Design: pages/admin/admin-reviews.html (reported content: queue + decision) ·
// view "q-a-and-seller-responses" = the Q&A answers and seller responses tables.

type View = 'q-a-and-seller-responses';
type TabKey = 'reported' | 'qa' | 'seller' | 'decided';
type Decision = 'keep' | 'remove' | 'edit';

const KIND_FILTERS: Array<{ value: '' | ReportKind; label: string }> = [
  { value: '', label: 'All types' },
  { value: 'Product review', label: 'Product reviews' },
  { value: 'Seller feedback', label: 'Seller feedback' },
  { value: 'Q&A answer', label: 'Q&A answers' },
];

const NOUN: Record<ReportKind, string> = { 'Product review': 'review', 'Seller feedback': 'feedback', 'Q&A answer': 'answer' };

const DECISIONS: Array<{ value: Decision; title: string; body: string }> = [
  { value: 'keep', title: 'Keep', body: 'Content follows the policy' },
  { value: 'remove', title: 'Remove for policy', body: 'Pick the rule it breaks' },
  { value: 'edit', title: 'Request edit', body: 'Ask the reviewer to change one part' },
];

const OUTCOME: Record<Decision, ReportOutcome> = { keep: 'Kept', remove: 'Removed', edit: 'Edit requested' };
const OUTCOME_TONE: Record<ReportOutcome, Tone> = { Kept: 'success', Removed: 'danger', 'Edit requested': 'warning' };

const template = (d: Decision, noun: string) =>
  d === 'keep'
    ? `We reviewed this report. The ${noun} describes the buyer's own experience with a verified purchase and follows our review policy, so it stays published. You can respond publicly under the ${noun}.`
    : d === 'remove'
      ? `We reviewed this report and removed the ${noun} because it breaks our review policy. Thank you for reporting it.`
      : `Please edit your ${noun} to remove the part that breaks our review policy. The rest of your ${noun} can stay as written.`;

/** Validation for the reported-content decision. */
function decisionErrors(decision: Decision, reason: string, msg: string) {
  const e: { reason?: string; msg?: string } = {};
  if (decision === 'keep' && reason !== LEGIT) e.reason = `Keeping means there is no policy breach. Choose "${LEGIT}", or pick Remove for policy.`;
  if (decision !== 'keep' && (!reason || reason === LEGIT)) e.reason = 'Pick the rule it breaks. "Harms sales" is not a removal reason.';
  if (decision === 'edit' && !msg.trim()) e.msg = 'Tell the reviewer which part to change.';
  return e;
}

/** Row actions in the Q&A and seller response tables. */
const ACTIONS: Record<RowAction, { label: string; variant: 'ghost' | 'secondary' | 'danger-soft' | 'primary'; outcome: string; tone: Tone }> = {
  keep: { label: 'Keep', variant: 'ghost', outcome: 'Kept', tone: 'success' },
  staff: { label: 'Add staff answer', variant: 'secondary', outcome: 'Staff answer added', tone: 'brand' },
  edit: { label: 'Request edit', variant: 'secondary', outcome: 'Edit requested', tone: 'warning' },
  remove: { label: 'Remove', variant: 'danger-soft', outcome: 'Removed', tone: 'danger' },
  publish: { label: 'Publish', variant: 'primary', outcome: 'Published', tone: 'success' },
  reject: { label: 'Reject response', variant: 'danger-soft', outcome: 'Rejected', tone: 'danger' },
  trust: { label: 'Send to Trust and Risk', variant: 'ghost', outcome: 'With Trust and Risk', tone: 'warning' },
};
/** Actions that open the reason dialog before they apply. */
const NEEDS_DIALOG: RowAction[] = ['staff', 'edit', 'remove', 'reject'];

const ROW_NOTICE: Record<RowAction, (name: string) => string> = {
  keep: (n) => `Answer on ${n} kept`,
  staff: (n) => `Staff answer for ${n} sent for a second check`,
  edit: (n) => `Edit requested on ${n}`,
  remove: (n) => `Answer on ${n} removed`,
  publish: (n) => `Published on ${n}`,
  reject: (n) => `Response from ${n} rejected`,
  trust: (n) => `Response from ${n} sent to Trust and Risk`,
};

const EDGE_SR: Record<Exclude<Edge, ''>, string> = { warn: 'At risk: ', flagged: 'Urgent: ' };
const EDGE_CLASS: Record<Edge, string> = { '': '', warn: 'is-warn', flagged: 'is-flagged' };

/** Status legend with the design's sr-only "Legend:" prefix (the shared StatusLegend omits it). */
function EdgeLegend({ warn = true }: { warn?: boolean }) {
  return (
    <p className="status-legend status-legend--edge">
      <span className="sr-only">Legend: </span>
      <span className="sl sl-danger">
        <i aria-hidden="true" />
        Red edge = urgent: overdue or past target
      </span>
      {warn && (
        <span className="sl sl-warning">
          <i aria-hidden="true" />
          Amber edge = at risk: due soon or near target
        </span>
      )}
    </p>
  );
}

function StarsBar({ rating, cls }: { rating: number; cls: string }) {
  return (
    <span className={cx('stars5', cls)} style={{ '--r': `${(rating / 5) * 100}%` } as CSSProperties} role="img" aria-label={`${rating} out of 5 stars`}>
      ★★★★★
    </span>
  );
}

function KvRow({ k, v, mono }: { k: string; v: string; mono?: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>
        {mono && (
          <>
            <span className="mono">{mono}</span>
            {' · '}
          </>
        )}
        {v}
      </dd>
    </>
  );
}

interface RowDialog {
  id: string;
  action: RowAction;
  name: string;
}

export default function Reviews() {
  const [view, setView] = useView<View>();
  const [sub, setSub] = useState<'' | 'seller' | 'decided'>('');
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);

  /* ----- Reported content: queue + decision ----- */
  const [outcomes, setOutcomes] = useState<Record<string, ReportOutcome>>({});
  const [decided, setDecided] = useState<DecidedRow[]>(DECIDED_SEED);
  const [kind, setKind] = useState<'' | ReportKind>('');
  const pending = REPORTED.filter((r) => !outcomes[r.id]);
  const queue = pending.filter((r) => !kind || r.kind === kind);
  const [activeId, setActiveId] = useState(REPORTED[0].id);
  const active: ReportedItem | undefined = queue.find((r) => r.id === activeId) ?? queue[0];
  const noun = active ? NOUN[active.kind] : 'review';

  const [decision, setDecision] = useState<Decision>('keep');
  const [reason, setReason] = useState(LEGIT);
  const [msg, setMsg] = useState(() => template('keep', 'review'));
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? decisionErrors(decision, reason, msg) : {};

  const select = (item: ReportedItem) => {
    setActiveId(item.id);
    setDecision('keep');
    setReason(LEGIT);
    setMsg(template('keep', NOUN[item.kind]));
    setAttempted(false);
  };
  const changeDecision = (d: Decision) => {
    setDecision(d);
    setReason(d === 'keep' ? LEGIT : '');
    setMsg(template(d, noun));
    setAttempted(false);
  };
  const goNext = (afterId: string) => {
    const idx = queue.findIndex((r) => r.id === afterId);
    const rest = queue.filter((r) => r.id !== afterId);
    const next = rest[idx] ?? rest[0];
    if (next) select(next);
  };

  const submitDecision = () => {
    if (!active) return;
    setAttempted(true);
    if (Object.keys(decisionErrors(decision, reason, msg)).length) return;
    const outcome = OUTCOME[decision];
    const cap = noun[0].toUpperCase() + noun.slice(1);
    setOutcomes((o) => ({ ...o, [active.id]: outcome }));
    setDecided((d) => [{ id: active.id, title: active.fullTitle, kind: active.kind, outcome, reason, by: STAFF.admin.name, when: 'Just now' }, ...d]);
    setNotice({
      title: decision === 'keep' ? `${cap} kept` : decision === 'remove' ? `${cap} removed for ${reason.toLowerCase()}` : `Edit requested from ${active.author}`,
      body: `${active.reporter} and ${active.author} can see the outcome. Recorded in Action history.`,
    });
    goNext(active.id);
  };

  /* ----- Q&A answers and seller responses ----- */
  const [rowOutcome, setRowOutcome] = useState<Record<string, RowAction>>({});
  const [dlg, setDlg] = useState<RowDialog | null>(null);
  const [dlgReason, setDlgReason] = useState('');
  const [dlgText, setDlgText] = useState('');
  const [dlgTried, setDlgTried] = useState(false);
  const qaPending = QA_ROWS.filter((r) => !rowOutcome[r.id]).length;
  const srPending = RESPONSE_ROWS.filter((r) => !rowOutcome[r.id]).length;

  const applyRow = (id: string, action: RowAction, name: string) => {
    setRowOutcome((o) => ({ ...o, [id]: action }));
    setNotice({
      title: ROW_NOTICE[action](name),
      body: action === 'trust' ? 'Sven Larsen (Trust and Risk) has the case. The response stays hidden.' : 'The author is notified. Recorded in Action history.',
    });
  };
  const rowClick = (id: string, action: RowAction, name: string) => {
    if (!NEEDS_DIALOG.includes(action)) return applyRow(id, action, name);
    setDlg({ id, action, name });
    setDlgReason('');
    setDlgText('');
    setDlgTried(false);
  };
  const rowDialogErrors = (d: RowDialog) => {
    const e: { reason?: string; text?: string } = {};
    if (d.action === 'staff') {
      if (!dlgText.trim()) e.text = 'Write the staff answer. It is labelled "Marketly staff" on the product page.';
    } else {
      if (!dlgReason) e.reason = 'Choose a reason. The author sees it and it is recorded in Action history.';
      if (d.action === 'edit' && !dlgText.trim()) e.text = 'Tell the author what to change.';
    }
    return e;
  };
  const dlgErrors = dlg && dlgTried ? rowDialogErrors(dlg) : {};
  const submitDlg = () => {
    if (!dlg) return;
    setDlgTried(true);
    if (Object.keys(rowDialogErrors(dlg)).length) return;
    applyRow(dlg.id, dlg.action, dlg.name);
    setDlg(null);
  };

  /* ----- Tabs: Q&A answers and Seller responses share the design view ----- */
  const sellerRef = useRef<HTMLElement>(null);
  const isQa = view === 'q-a-and-seller-responses';
  const tab: TabKey = isQa ? (sub === 'seller' ? 'seller' : 'qa') : sub === 'decided' ? 'decided' : 'reported';
  useEffect(() => {
    if (tab === 'seller') sellerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [tab]);
  const onTab = (t: TabKey) => {
    setNotice(null);
    setSub(t === 'seller' ? 'seller' : t === 'decided' ? 'decided' : '');
    setView(t === 'qa' || t === 'seller' ? 'q-a-and-seller-responses' : '');
  };

  const renderActions = (row: QaRow | ResponseRow, name: string, wrap: boolean) => {
    const done = rowOutcome[row.id];
    if (done) return <StatusBadge status={ACTIONS[done].outcome} tone={ACTIONS[done].tone} />;
    const btns = row.actions.map((a) => (
      <Button key={a} variant={ACTIONS[a].variant} size="sm" onClick={() => rowClick(row.id, a, name)}>
        {ACTIONS[a].label}
        <span className="sr-only"> {name}</span>
      </Button>
    ));
    return wrap ? <span className="row nowrap gap-1">{btns}</span> : btns;
  };
  const rowEdge = (row: QaRow | ResponseRow): Edge => (rowOutcome[row.id] ? '' : row.edge);

  const policyAlert = (
    <Alert tone="warning" icon="scale" title="Don't remove legitimate negative reviews">
      Unfavorable is not a policy reason. Remove only for personal information, hate or harassment, spam or links, off-topic content, conflict of interest or proven fake reviews. Product reviews and seller feedback are judged separately.
    </Alert>
  );

  const submitLabel = decision === 'keep' ? `Keep ${noun} and notify` : decision === 'remove' ? `Remove ${noun} and notify` : 'Request edit and notify';

  return (
    <AdminLayout active="reviews">
      <PageHeader
        crumbs={[{ label: 'Catalog' }, { label: 'Reviews and Q&A' }]}
        title="Reviews and Q&A"
        sub="Moderation lead Noor Aziz · backup Isabel Cruz · fake review patterns go to Trust and Risk (Sven Larsen)"
        actions={
          <Button variant="secondary" size="sm" icon="book-open" to={href('admin/help-content')}>
            Moderation policy
          </Button>
        }
      />
      <Tabs<TabKey>
        items={[
          { value: 'reported', label: 'Reported content', count: pending.length },
          { value: 'qa', label: 'Q&A answers', count: qaPending },
          { value: 'seller', label: 'Seller responses', count: srPending },
          { value: 'decided', label: 'Decided' },
        ]}
        active={tab}
        onChange={onTab}
      />

      {notice && (
        <Alert tone="success" title={notice.title}>
          {notice.body}
        </Alert>
      )}

      {tab === 'reported' && (
        <div className="aa-rv">
          <section className="card">
            <div className="card-head">
              <span className="h4">Reported</span>
              <select className="select" id="aa-rv-kind" aria-label="Content type" value={kind} onChange={(e) => setKind(e.target.value as '' | ReportKind)}>
                {KIND_FILTERS.map((k) => (
                  <option key={k.label} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
            {queue.length ? (
              <nav className="aa-q" aria-label="Reported items">
                {queue.map((r) => (
                  <a
                    key={r.id}
                    href="#"
                    className={cx(r.id === active?.id && 'is-active')}
                    aria-current={r.id === active?.id ? 'true' : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      select(r);
                    }}
                  >
                    <span className="row between">
                      <span className="xs strong muted">{r.kind}</span>
                      <span className="xs muted">{r.age}</span>
                    </span>
                    <span className="small strong">{r.title}</span>
                    <span className="row gap-2">
                      {r.rating !== undefined && <StarsBar rating={r.rating} cls="xs" />}
                      <Badge tone={r.reasonTone}>{r.reason}</Badge>
                    </span>
                    <span className="xs muted">{r.reportedBy}</span>
                  </a>
                ))}
              </nav>
            ) : (
              <div className="card-body">
                <EmptyState icon="circle-check" title={pending.length ? 'Nothing of this type' : 'Queue clear'}>
                  {pending.length ? 'Choose All types to see the other reported items.' : 'Every reported item has a decision. New reports appear here.'}
                </EmptyState>
              </div>
            )}
          </section>

          <div className="stack gap-5">
            {policyAlert}
            {active && (
              <>
                <section className="card">
                  <div className="card-head">
                    <div className="row nowrap gap-3">
                      <Img icon={active.icon} tint={active.tint} className="tiny" />
                      <div className="stack gap-0">
                        <span className="eyebrow">{active.kind}</span>
                        <Link className="small strong" to={href(active.link === 'seller' ? 'store/seller' : 'store/product')}>
                          {active.fullTitle}
                        </Link>
                      </div>
                    </div>
                    <Badge tone={active.reasonTone === 'outline' ? 'warning' : active.reasonTone}>Reported · {active.reason}</Badge>
                  </div>
                  <div className="card-body">
                    <div className="row gap-2">
                      {active.rating !== undefined && <StarsBar rating={active.rating} cls="u-fs-16" />}
                      <span className="strong">{active.headline}</span>
                    </div>
                    <span className="row gap-2 xs muted">
                      By {active.author} · {active.byline}
                      {active.verified && (
                        <>
                          {' · '}
                          <Badge tone="success" icon="badge-check">
                            Verified Purchase
                          </Badge>
                        </>
                      )}
                      {active.seller && ` · sold by ${active.seller}`}
                      {active.condition && ` · ${active.condition}`}
                    </span>
                    <p className="small">{active.body}</p>
                    {active.photos > 0 && (
                      <div className="row gap-2">
                        {Array.from({ length: active.photos }, (_, i) => (
                          <Img key={i} icon="image" tint={active.tint} className="thumb" />
                        ))}
                      </div>
                    )}
                    {active.sellerResponse && (
                      <div className="panel stack gap-1">
                        <span className="xs strong muted">Seller response · published {active.sellerResponse.date}</span>
                        <span className="small">{active.sellerResponse.text}</span>
                      </div>
                    )}
                    <dl className="kv">
                      {active.kv.map((p) => (
                        <KvRow key={p.k} k={p.k} v={p.v} mono={p.mono} />
                      ))}
                    </dl>
                    {active.note && (
                      <div className="aa-note">
                        <span className="xs strong">{active.note.title}</span>
                        <span>{active.note.text}</span>
                      </div>
                    )}
                  </div>
                </section>

                <section className="card">
                  <div className="card-head">
                    <div className="stack gap-0">
                      <h2 className="h4">Decision</h2>
                      <span className="xs muted">The reviewer and the reporter both see the outcome</span>
                    </div>
                  </div>
                  <div className="card-body">
                    <div className="grid md3 gap-2">
                      {DECISIONS.map((d, i) => (
                        <OptionCard
                          key={d.value}
                          id={`aa-rv-d${i + 1}`}
                          name="aa-rv-d"
                          title={<span className="small strong">{d.title}</span>}
                          body={d.body}
                          checked={decision === d.value}
                          onChange={() => changeDecision(d.value)}
                        />
                      ))}
                    </div>
                    <Field label="Reason" hint={'Required. "Harms sales" is not a removal reason.'} error={errors.reason}>
                      <select className={cx('select', errors.reason && 'is-error')} id="aa-rv-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                        {decision !== 'keep' && <option value="">Pick the rule it breaks</option>}
                        <option value={LEGIT}>{LEGIT}</option>
                        {POLICY_REASONS.map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label={decision === 'edit' ? 'Message to reviewer' : 'Message to reporter'} optional={decision !== 'edit'} error={errors.msg}>
                      <Textarea id="aa-rv-msg" placeholder="" value={msg} className={cx(errors.msg && 'is-error')} onChange={(e) => setMsg(e.target.value)} />
                    </Field>
                  </div>
                  <div className="card-foot">
                    <Button variant="ghost" onClick={() => goNext(active.id)}>
                      Skip
                    </Button>
                    <Button variant={decision === 'remove' ? 'danger' : 'primary'} icon={decision === 'keep' ? 'check' : decision === 'remove' ? 'trash-2' : 'pencil'} onClick={submitDecision}>
                      {submitLabel}
                    </Button>
                  </div>
                </section>
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'decided' && (
        <section className="card">
          <div className="card-head">
            <div className="stack gap-0">
              <h2 className="h4">Decided</h2>
              <span className="xs muted">Last 7 days · the reviewer and the reporter were told each outcome</span>
            </div>
          </div>
          <TableWrap label="Decided content table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Content</th>
                  <th scope="col">Decision</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Decided by</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <span className="stack gap-0">
                        <span className="small strong">{d.title}</span>
                        <span className="xs muted">{d.kind}</span>
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={d.outcome} tone={OUTCOME_TONE[d.outcome]} />
                    </td>
                    <td>
                      <span className="small">{d.reason}</span>
                    </td>
                    <td>
                      <span className="small">
                        {d.by} · {d.when}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </section>
      )}

      {isQa && (
        <>
          {policyAlert}
          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h2 className="h4">Q&amp;A answers needing review</h2>
                <span className="xs muted">Answers are labelled by who wrote them: seller, Marketly staff or customer</span>
              </div>
            </div>
            <TableWrap label="Q&A answers needing review table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Product and question</th>
                    <th scope="col">Answer</th>
                    <th scope="col">Answered by</th>
                    <th scope="col">Why held</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {QA_ROWS.map((r) => {
                    const edge = rowEdge(r);
                    return (
                      <tr key={r.id} className={EDGE_CLASS[edge]}>
                        <td>
                          {edge && <span className="sr-only">{EDGE_SR[edge]}</span>}
                          <span className="stack gap-0">
                            <span className="small strong">{r.product}</span>
                            <span className="xs sub">{r.question}</span>
                          </span>
                        </td>
                        <td>
                          <span className="small">{r.answer}</span>
                        </td>
                        <td>
                          <Badge tone={r.by.tone}>{r.by.label}</Badge>
                        </td>
                        <td>
                          <span className="small">{r.why}</span>
                        </td>
                        <td>{renderActions(r, r.product, true)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            <EdgeLegend />
          </section>
          <section className="card" ref={sellerRef}>
            <div className="card-head">
              <div className="stack gap-0">
                <h3 className="h4">Seller responses waiting</h3>
                <span className="xs muted">Sellers can respond publicly once per review · held when a rule check fails</span>
              </div>
            </div>
            <TableWrap label="Seller responses waiting table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Review</th>
                    <th scope="col">Seller response</th>
                    <th scope="col">Rule check</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {RESPONSE_ROWS.map((r) => {
                    const edge = rowEdge(r);
                    return (
                      <tr key={r.id} className={EDGE_CLASS[edge]}>
                        <td>
                          {edge && <span className="sr-only">{EDGE_SR[edge]}</span>}
                          <span className="stack gap-1">
                            <StarsBar rating={r.rating} cls="sm" />
                            <span className="small">{r.review}</span>
                            <span className="xs muted">{r.context}</span>
                          </span>
                        </td>
                        <td>
                          <span className="stack gap-0">
                            <span className="xs strong muted">{r.seller}</span>
                            <span className="small">{r.response}</span>
                          </span>
                        </td>
                        <td>
                          <Badge tone={r.check.tone}>{r.check.label}</Badge>
                        </td>
                        <td>{renderActions(r, r.seller, r.actions.length > 1)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            <EdgeLegend warn={false} />
          </section>
        </>
      )}

      <Dialog
        open={!!dlg}
        onClose={() => setDlg(null)}
        title={dlg ? `${ACTIONS[dlg.action].label} · ${dlg.name}` : ''}
        foot={
          dlg && (
            <>
              <Button variant="ghost" onClick={() => setDlg(null)}>
                Cancel
              </Button>
              <Button variant={dlg.action === 'remove' || dlg.action === 'reject' ? 'danger' : 'primary'} icon={dlg.action === 'staff' ? 'send' : 'check'} onClick={submitDlg}>
                {dlg.action === 'staff' ? 'Send for second check' : `${ACTIONS[dlg.action].label} and notify`}
              </Button>
            </>
          )
        }
      >
        {dlg && dlg.action !== 'staff' && (
          <Field label="Reason" hint="Required. Shown to the author." error={dlgErrors.reason}>
            <Select
              id="aa-rv-row-reason"
              className={cx(dlgErrors.reason && 'is-error')}
              options={[{ value: '', label: 'Choose a reason' }, ...ROW_REASONS.map((r) => ({ value: r, label: r }))]}
              value={dlgReason}
              onChange={(e) => setDlgReason(e.target.value)}
            />
          </Field>
        )}
        {dlg && (
          <Field
            label={dlg.action === 'staff' ? 'Staff answer' : 'Message to author'}
            optional={dlg.action !== 'staff' && dlg.action !== 'edit'}
            hint={dlg.action === 'staff' ? 'Labelled "Marketly staff". A second moderator checks it before it is published.' : undefined}
            error={dlgErrors.text}
          >
            <Textarea id="aa-rv-row-text" className={cx(dlgErrors.text && 'is-error')} value={dlgText} onChange={(e) => setDlgText(e.target.value)} />
          </Field>
        )}
      </Dialog>
    </AdminLayout>
  );
}
