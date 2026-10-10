import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import {
  Alert, Badge, Button, Checkbox, Card, Deadline, Dialog, EmptyState, Field, Icon, IconButton, Img, KeyValue, LogoTile, OptionCard, PageHeader,
  SegmentedControl, Select, StatusBadge, StatusLegend, TableWrap, Textarea, TextInput,
} from '@/ui';
import {
  COMMENT_FIELDS, MERGE_EFFECTS, MERGE_REASON_DEFAULT, MERGE_RECORDS, MERGE_TARGETS, QUEUE_CATEGORIES, REASONS, SUBMISSIONS,
  type Decision, type FieldComment, type HistoryEvent, type ReviewCheck, type Submission, type SubmissionStatus,
} from './data/product-review';

// Design: pages/admin/admin-product-review.html · view "merge-duplicate" = the merge dialog open.

type Segment = 'new' | 'shared' | 'resubmitted';
type DupState = 'open' | 'merged' | 'dismissed';
type Notice = { tone: 'success' | 'info'; title: string; body: string };

const SEGMENTS: Array<{ value: Segment; label: string }> = [
  { value: 'new', label: 'New products' },
  { value: 'shared', label: 'Shared content changes' },
  { value: 'resubmitted', label: 'Resubmitted' },
];
const SEGMENT_TEST: Record<Segment, (s: Submission) => boolean> = {
  new: (s) => s.kind === 'new',
  shared: (s) => s.kind === 'shared',
  resubmitted: (s) => !!s.resubmitted,
};

const DECISIONS: Array<{ value: Decision; title: string; body: string }> = [
  { value: 'approve', title: 'Approve', body: 'Publish as a new product' },
  { value: 'changes', title: 'Request changes', body: 'Seller fixes and resubmits' },
  { value: 'reject', title: 'Reject', body: 'Outside allowed assortment or unsafe' },
];
const DECISION_STATUS: Record<Decision, SubmissionStatus> = { approve: 'Approved', changes: 'Changes requested', reject: 'Rejected' };

/** Side-by-side comparison in the duplicate check (this submission vs the existing product). */
const DUP_COMPARE = [
  { head: 'This submission', name: 'K75 Wireless Mechanical Keyboard, Lavender', pairs: [['Brand', 'Kestrel'], ['Model', 'K75-LV-BR'], ['Layout', '75%'], ['Switch', 'Kestrel Brown'], ['Color', 'Lavender', 'diff'], ['Category', 'Accessories', 'diff']] },
  { head: 'Existing · PRD-10233', name: 'Kestrel K75 Wireless Mechanical Keyboard', link: true, foot: '2 offers · 731 reviews · on sale since Mar 2026', pairs: [['Brand', 'Kestrel'], ['Model', 'K75-GY-BR'], ['Layout', '75%'], ['Switch', 'Kestrel Brown'], ['Color', 'Gray'], ['Category', 'Keyboards']] },
];

const now = () => new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Differs() {
  return <span className="xs t-warning-text strong">Differs</span>;
}

function CheckBody({ body }: { body: ReviewCheck['body'] }) {
  return Array.isArray(body) ? (
    <ul className="ul small sub">
      {body.map((b) => (
        <li key={b}>{b}</li>
      ))}
    </ul>
  ) : (
    <p className="small sub">{body}</p>
  );
}

export default function ProductReview() {
  const [view, setView] = useView<'merge-duplicate'>();
  const [segment, setSegment] = useState<Segment>('new');
  const [cat, setCat] = useState('');
  const [activeId, setActiveId] = useState(SUBMISSIONS[0].id);
  const [status, setStatus] = useState<Record<string, SubmissionStatus>>({});
  const [comments, setComments] = useState<Record<string, FieldComment[]>>(() => Object.fromEntries(SUBMISSIONS.map((s) => [s.id, s.comments])));
  const [history, setHistory] = useState<Record<string, HistoryEvent[]>>({});
  const [dup, setDup] = useState<Record<string, DupState>>({});
  const [notice, setNotice] = useState<Notice | null>(null);

  const sub = SUBMISSIONS.find((s) => s.id === activeId) ?? SUBMISSIONS[0];
  const subStatus = status[sub.id] ?? 'Submitted';
  const dupState = dup[sub.id] ?? 'open';

  // Decision form for the open submission.
  const [decision, setDecision] = useState<Decision>(sub.defaultDecision ?? 'changes');
  const [reason, setReason] = useState(sub.defaultReason ?? '');
  const [tried, setTried] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newField, setNewField] = useState(COMMENT_FIELDS[0]);
  const [newComment, setNewComment] = useState('');
  const [commentTried, setCommentTried] = useState(false);

  // Merge dialog form.
  const [keep, setKeep] = useState(MERGE_TARGETS[0].id);
  const [records, setRecords] = useState<string[]>(MERGE_RECORDS.map((r) => r.id));
  const [mergeReason, setMergeReason] = useState(MERGE_REASON_DEFAULT);
  const [mergeTried, setMergeTried] = useState(false);

  const queue = useMemo(
    () => SUBMISSIONS.filter((s) => SEGMENT_TEST[segment](s) && (!cat || s.cat === cat) && ((status[s.id] ?? 'Submitted') === 'Submitted' || s.id === activeId)),
    [segment, cat, status, activeId],
  );

  const open = (s: Submission) => {
    setActiveId(s.id);
    setDecision(s.defaultDecision ?? 'changes');
    setReason(s.defaultReason ?? '');
    setTried(false);
    setAdding(false);
    setNotice(null);
  };

  const checks = sub.checks.map((c) =>
    c.id === 'dup' && dupState === 'merged'
      ? { ...c, tone: 'success' as const, title: `Merged into ${keep}`, badge: 'Merged', body: `Added as the Lavender variation of ${keep}. The seller's offer moved with it.` }
      : c.id === 'dup' && dupState === 'dismissed'
        ? { ...c, tone: 'success' as const, badge: 'Not a duplicate', body: 'Marked as a separate product by Omar Haddad. The duplicate check will not block approval.' }
        : c,
  );
  const attention = checks.filter((c) => c.tone !== 'success').length;
  const blocking = checks.filter((c) => c.badge === 'Blocking');
  const subComments = comments[sub.id] ?? [];
  const events = [...(history[sub.id] ?? []), ...sub.history];
  const missingAttr = sub.attributes.some((a) => a.required && !a.value);

  const needsReason = decision !== 'approve';
  const reasonError = tried && needsReason && !reason ? `Choose a reason to ${decision === 'reject' ? 'reject this submission' : 'request changes'}. The seller sees it with your field comments.` : '';
  const blockError = tried && decision === 'approve' && blocking.length > 0 ? `Resolve ${plural(blocking.length, 'blocking check')} before approving: ${blocking.map((c) => c.title).join('; ')}.` : '';

  const addEvent = (id: string, ev: HistoryEvent) =>
    setHistory((h) => ({ ...h, [id]: [ev, ...(h[id] ?? []).map((e) => ({ ...e, state: e.state === 'current' ? ('done' as const) : e.state }))] }));

  const submit = () => {
    setTried(true);
    if ((needsReason && !reason) || (decision === 'approve' && blocking.length > 0)) return;
    const next = DECISION_STATUS[decision];
    setStatus((s) => ({ ...s, [sub.id]: next }));
    addEvent(sub.id, { t: next === 'Approved' ? 'Approved and published' : next, d: `${now()} · Omar Haddad${needsReason ? ` · ${reason}` : ''}`, state: 'current' });
    const n = subComments.length;
    setNotice(
      decision === 'approve'
        ? { tone: 'success', title: `${sub.title} is approved`, body: `It is now live with ${sub.seller}'s offer. ${sub.seller} has been notified.` }
        : decision === 'changes'
          ? { tone: 'success', title: `Change request sent to ${sub.seller}`, body: `Reason: ${reason}${n ? ` · ${plural(n, 'field comment')}` : ''}. The submission comes back to the queue when the seller resubmits.` }
          : { tone: 'success', title: `${sub.title} was rejected`, body: `Reason: ${reason}. ${sub.seller} can appeal within 14 days.` },
    );
    setTried(false);
  };

  const saveDraft = () => setNotice({ tone: 'info', title: 'Draft saved', body: 'Your decision and field comments are saved. Only reviewers can see a draft.' });

  const nextInQueue = queue.find((s) => s.id !== sub.id && (status[s.id] ?? 'Submitted') === 'Submitted');

  const commentError = commentTried && !newComment.trim() ? 'Enter a comment for the seller.' : '';
  const addComment = () => {
    setCommentTried(true);
    if (!newComment.trim()) return;
    setComments((c) => ({ ...c, [sub.id]: [...(c[sub.id] ?? []), { id: `c${Date.now()}`, field: newField, comment: newComment.trim() }] }));
    setNewComment('');
    setCommentTried(false);
    setAdding(false);
  };
  const removeComment = (id: string) => setComments((c) => ({ ...c, [sub.id]: (c[sub.id] ?? []).filter((x) => x.id !== id) }));

  // Merge flow.
  const openMerge = () => {
    setKeep(MERGE_TARGETS[0].id);
    setRecords(MERGE_RECORDS.map((r) => r.id));
    setMergeReason(MERGE_REASON_DEFAULT);
    setMergeTried(false);
    setView('merge-duplicate');
  };
  const closeMerge = () => setView('');
  const mergeReasonError = mergeTried && !mergeReason.trim() ? 'Enter a reason for the merge. The affected sellers see it.' : '';
  const recordsError = mergeTried && records.length === 0 ? 'Choose at least one record to merge.' : '';
  const merge = () => {
    setMergeTried(true);
    if (!mergeReason.trim() || records.length === 0) return;
    setDup((d) => ({ ...d, [sub.id]: 'merged' }));
    addEvent(sub.id, { t: `Merged into ${keep}`, d: `${now()} · Omar Haddad · ${plural(records.length, 'record')}`, state: 'current' });
    setNotice({ tone: 'success', title: `${plural(records.length, 'record')} merged into ${keep}`, body: 'Pixel & Port and Gadget Grove have been notified. You can reverse the merge from Action history within 30 days.' });
    closeMerge();
  };
  const toggleRecord = (id: string) => setRecords((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]));

  return (
    <AdminLayout active="review">
      <PageHeader
        crumbs={[{ label: 'Catalog' }, { label: 'Review queue' }]}
        title="Review queue"
        sub="23 waiting · oldest 2 days · review target 2 business days · lead Omar Haddad, backup Noor Aziz"
        actions={<SegmentedControl items={SEGMENTS} active={segment} onChange={setSegment} label="Submission type" />}
      />
      <div className="aa-rv">
        <section className="card">
          <div className="card-head">
            <span className="h4">Submissions</span>
            <span className="xs muted">Oldest first</span>
          </div>
          <div className="card-body u-pb-0">
            <div className="field aa-flt">
              <label className="label" htmlFor="aa-pr-cat">
                Category
              </label>
              <select className="select" id="aa-pr-cat" value={cat} onChange={(e) => setCat(e.target.value)}>
                <option value="">All categories</option>
                {QUEUE_CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>
          <nav className="aa-q u-mt-sp-3" aria-label="Submissions">
            {queue.map((s) => {
              const on = s.id === sub.id;
              return (
                <Link
                  key={s.id}
                  to={href('admin/product-review')}
                  className={cx(on && 'is-active')}
                  aria-current={on ? 'true' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    open(s);
                  }}
                >
                  <span className="row nowrap top gap-3">
                    <Img icon={s.icon} tint={s.tint} className="tiny" />
                    <span className="stack gap-0 grow">
                      <span className="small strong clamp-2">{s.title}</span>
                      <span className="xs muted">
                        {s.seller} · {s.cat} › {s.sub}
                      </span>
                    </span>
                  </span>
                  <span className="row between">
                    {s.flags.length ? (
                      <span className="aa-flags">
                        {s.flags.map((f) => (
                          <Badge key={f.label} tone={f.tone} icon={f.icon}>
                            {f.label}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      <span />
                    )}
                    {(status[s.id] ?? 'Submitted') === 'Submitted' ? <Deadline tone={s.waitingTone}>{s.waiting}</Deadline> : <StatusBadge status={status[s.id]} />}
                  </span>
                </Link>
              );
            })}
          </nav>
          {queue.length === 0 && (
            <div className="card-body">
              <EmptyState icon="inbox" title="Nothing waiting here">
                No submissions match this type and category.
              </EmptyState>
            </div>
          )}
          <div className="card-foot u-justify-center">
            <a className="small strong" href="#">
              Show all 23
            </a>
          </div>
        </section>

        <div className="stack gap-5">
          {notice && (
            <Alert tone={notice.tone} title={notice.title}>
              {notice.body}
            </Alert>
          )}
          <section className="card">
            <div className="card-head">
              <div className="row nowrap top gap-3">
                <Img icon={sub.icon} tint={sub.tint} className="thumb" />
                <div className="stack gap-1">
                  <span className="eyebrow">
                    {sub.kind === 'shared' ? 'Shared content change' : 'New product'} · {sub.ref}
                  </span>
                  <h2 className="h3">{sub.title}</h2>
                  <span className="xs muted">
                    <span className="row nowrap gap-2">
                      <LogoTile initials={sub.sellerInitials} tint={sub.sellerTint} size="sm" />
                      <span className="stack gap-0">
                        <span className="small strong nowrap">{sub.seller}</span>
                        <span className="xs muted nowrap">
                          Submitted by {sub.submittedBy} · {sub.submittedAt}
                        </span>
                      </span>
                    </span>
                  </span>
                </div>
              </div>
              <div className="row gap-2">
                <StatusBadge status={subStatus} />
                {subStatus === 'Submitted' && <Deadline tone={sub.waitingTone}>Review by {sub.reviewBy}</Deadline>}
              </div>
            </div>
            <div className="card-body">
              <div className="aa-sec">
                <span className="h4">Content</span>
                <KeyValue
                  pairs={[
                    ['Brand', <>{sub.brand} {sub.brandNote && <span className="xs muted">· {sub.brandNote}</span>}</>],
                    ['Category', sub.categoryDiffers ? <>{sub.cat} › {sub.sub} <Differs /></> : `${sub.cat} › ${sub.sub}`],
                    ['Model', <span className="mono">{sub.model}</span>],
                    ['UPC', <span className="mono">{sub.upc}</span>],
                    ['Offer', sub.offer],
                  ]}
                />
                <p className="small sub">
                  {sub.description.map((seg, i) =>
                    typeof seg === 'string' ? (
                      seg
                    ) : (
                      <mark key={i} className="aa-mark">
                        {seg.mark}
                      </mark>
                    ),
                  )}
                </p>
              </div>
              {sub.images.length > 0 && (
                <div className="aa-sec">
                  <span className="h4">Images · {sub.images.length}</span>
                  <div className="aa-imgs">
                    {sub.images.map((im) => (
                      <figure key={im.caption} className={cx(im.bad && 'is-bad')}>
                        <Img icon={im.icon} tint={im.tint} />
                        <figcaption>{im.caption}</figcaption>
                      </figure>
                    ))}
                  </div>
                </div>
              )}
              {sub.attributes.length > 0 && (
                <div className="aa-sec">
                  <span className="h4">Attributes</span>
                  <TableWrap label={`${sub.title} table`}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Attribute</th>
                          <th scope="col">Value</th>
                          <th scope="col">
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {sub.attributes.map((a) => {
                          const missing = a.required && !a.value;
                          return (
                            <tr key={a.name} className={cx(missing && 'is-flagged')}>
                              <td>
                                {missing && <span className="sr-only">Urgent: </span>}
                                {a.name}
                                {a.required && <span className="xs muted"> · required</span>}
                              </td>
                              <td>{missing ? <span className="t-danger-text strong small">Missing</span> : a.value}</td>
                              <td>{missing && <Badge tone="danger">Required</Badge>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </TableWrap>
                  {missingAttr && <StatusLegend items={[{ tone: 'danger', label: 'Red edge = urgent: overdue or past target' }]} />}
                </div>
              )}
            </div>
          </section>

          <Card title="Automated checks" titleAs="h3" sub={`Ran ${sub.checksRan} · ${attention ? `${attention} need attention · ` : ''}${checks.length - attention} passed`}>
            {checks.map((c) => (
              <div key={c.id} className={`aa-chk t-${c.tone}`}>
                <Icon name={c.icon} />
                <div className="stack gap-2">
                  <div className="row between">
                    <span className="small strong">{c.title}</span>
                    <Badge tone={c.badge === 'Not a duplicate' ? '' : c.tone}>{c.badge}</Badge>
                  </div>
                  <CheckBody body={c.body} />
                  {c.id === 'dup' && dupState === 'open' && sub.duplicateOf && (
                    <>
                      <div className="aa-cmp">
                        {DUP_COMPARE.map((p) => (
                          <div key={p.head} className="panel stack gap-2">
                            <span className="row gap-2">
                              <Img icon="keyboard" tint="6" className="tiny" />
                              <span className="stack gap-0">
                                <span className="xs strong muted">{p.head}</span>
                                {p.link ? (
                                  <Link className="small strong" to={href('store/product')}>
                                    {p.name}
                                  </Link>
                                ) : (
                                  <span className="small strong">{p.name}</span>
                                )}
                              </span>
                            </span>
                            <dl className="kv">
                              {p.pairs.map(([k, v, diff]) => [
                                <dt key={`${k}-t`}>{k}</dt>,
                                <dd key={`${k}-d`} className={cx(diff && 'aa-diff')}>
                                  {v}
                                  {diff && (
                                    <>
                                      {' '}
                                      <Differs />
                                    </>
                                  )}
                                </dd>,
                              ])}
                            </dl>
                            {p.foot && <span className="xs muted">{p.foot}</span>}
                          </div>
                        ))}
                      </div>
                      <div className="row gap-2">
                        <Button size="sm" icon="merge" onClick={openMerge}>
                          Merge into {sub.duplicateOf}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDup((d) => ({ ...d, [sub.id]: 'dismissed' }))}>
                          Not a duplicate
                        </Button>
                      </div>
                    </>
                  )}
                  {c.id === 'dup' && dupState === 'dismissed' && (
                    <div className="row gap-2">
                      <Button variant="ghost" size="sm" icon="undo-2" onClick={() => setDup((d) => ({ ...d, [sub.id]: 'open' }))}>
                        Undo
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {checks.length === 0 && <p className="small sub">No automated checks apply to this change.</p>}
          </Card>

          {subStatus === 'Submitted' ? (
            <Card
              title="Decision"
              titleAs="h3"
              sub="The seller sees your reason and each field comment"
              foot={
                <>
                  <Button variant="ghost" onClick={saveDraft}>
                    Save draft
                  </Button>
                  {decision === 'approve' ? (
                    <Button icon="check" onClick={submit}>
                      Approve and publish
                    </Button>
                  ) : decision === 'reject' ? (
                    <Button variant="danger" icon="x" onClick={submit}>
                      Reject submission
                    </Button>
                  ) : (
                    <Button icon="send" onClick={submit}>
                      Send change request
                    </Button>
                  )}
                </>
              }
            >
              <div className="grid md3 gap-2">
                {DECISIONS.map((d, i) => (
                  <OptionCard
                    key={d.value}
                    id={`aa-pr-d${i + 1}`}
                    name="aa-pr-d"
                    title={<span className="small strong">{d.title}</span>}
                    body={d.body}
                    checked={decision === d.value}
                    onChange={() => {
                      setDecision(d.value);
                      setTried(false);
                    }}
                  />
                ))}
              </div>
              <Field label="Reason" hint="Required for Request changes and Reject." error={reasonError}>
                <Select
                  id="aa-pr-reason"
                  className={cx(reasonError && 'is-error')}
                  options={[{ value: '', label: 'Choose a reason' }, ...REASONS]}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <div className="stack gap-2">
                <span className="label">Field comments · {subComments.length}</span>
                {subComments.length > 0 && (
                  <TableWrap label="Decision table">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Field</th>
                          <th scope="col">Comment to seller</th>
                          <th scope="col">
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {subComments.map((c) => (
                          <tr key={c.id}>
                            <td>
                              <span className="small strong">{c.field}</span>
                            </td>
                            <td>
                              <span className="small">{c.comment}</span>
                            </td>
                            <td>
                              <IconButton icon="trash-2" label="Remove comment" onClick={() => removeComment(c.id)} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
                {adding ? (
                  <div className="panel stack gap-3">
                    <div className="grid md2 gap-3">
                      <Field label="Field">
                        <Select id="aa-pr-cf" options={COMMENT_FIELDS} value={newField} onChange={(e) => setNewField(e.target.value)} />
                      </Field>
                      <Field label="Comment to seller" error={commentError}>
                        <TextInput id="aa-pr-cc" value={newComment} error={!!commentError} onChange={(e) => setNewComment(e.target.value)} />
                      </Field>
                    </div>
                    <div className="row gap-2">
                      <Button size="sm" onClick={addComment}>
                        Add comment
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setAdding(false);
                          setCommentTried(false);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" icon="plus" onClick={() => setAdding(true)}>
                    Add field comment
                  </Button>
                )}
              </div>
              {blockError && <Alert tone="danger" title="Can't approve yet">{blockError}</Alert>}
              {sub.duplicateOf && dupState === 'open' && (
                <Alert tone="info" title="Duplicate first">
                  If you merge this into {sub.duplicateOf}, the change request goes with the new Lavender variation and the seller fixes it there.
                </Alert>
              )}
            </Card>
          ) : (
            <Card title="Decision" titleAs="h3" sub="Sent to the seller">
              <div className="row between">
                <span className="row gap-2">
                  <StatusBadge status={subStatus} />
                  <span className="small sub">{reason && subStatus !== 'Approved' ? `Reason: ${reason}` : 'Published to the catalog'}</span>
                </span>
                {nextInQueue && (
                  <Button size="sm" iconRight="arrow-right" onClick={() => open(nextInQueue)}>
                    Next submission
                  </Button>
                )}
              </div>
            </Card>
          )}

          <Card title="History" titleAs="h3">
            <ol className="timeline">
              {events.map((e, i) => (
                <li key={`${e.t}-${i}`} className={`ev is-${e.state}`}>
                  {e.state === 'warn' && <span className="sr-only">At risk: </span>}
                  <span className="dot" aria-hidden="true" />
                  <div className="stack gap-1">
                    <span className="t">{e.t}</span>
                    <span className="d">{e.d}</span>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>

      <Dialog
        open={view === 'merge-duplicate'}
        onClose={closeMerge}
        size="lg"
        title="Merge duplicate into existing product"
        foot={
          <>
            <Button variant="ghost" onClick={closeMerge}>
              Cancel
            </Button>
            <Button icon="merge" onClick={merge}>
              Merge {plural(records.length, 'record')} into {keep}
            </Button>
          </>
        }
      >
        <p className="small sub">Merging keeps one product page. Offers, reviews and past orders move to the product you keep, and the merged records redirect to it.</p>
        <div className="stack gap-2">
          <span className="label">Product to keep</span>
          {MERGE_TARGETS.map((t, i) => (
            <OptionCard
              key={t.id}
              id={`aa-mg-t${i + 1}`}
              name="aa-mg-t"
              checked={keep === t.id}
              onChange={() => setKeep(t.id)}
              title={
                keep === t.id ? (
                  <span className="row gap-2">
                    <span className="strong small">{t.title}</span>
                    <Badge tone="brand">Keep</Badge>
                  </span>
                ) : (
                  <span className="strong small">{t.title}</span>
                )
              }
              body={
                <>
                  <span className="mono">{t.id}</span> · {t.meta}
                </>
              }
              right={<Img icon={t.icon} tint={t.tint} className="tiny" />}
            />
          ))}
        </div>
        <div className="stack gap-2">
          <span className="label">Records merged into {keep}</span>
          {MERGE_RECORDS.map((r) => (
            <Checkbox
              key={r.id}
              id={r.id}
              checked={records.includes(r.id)}
              onChange={() => toggleRecord(r.id)}
              label={
                <span className="small">
                  <b>{r.ref}</b>
                  {r.text}
                </span>
              }
            />
          ))}
          {recordsError && (
            <span className="error-text">
              <Icon name="circle-alert" className="ic-sm" />
              {recordsError}
            </span>
          )}
        </div>
        <TableWrap label="Merge duplicate into existing product table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col">How it carries over</th>
                <th scope="col">After merge</th>
              </tr>
            </thead>
            <tbody>
              {MERGE_EFFECTS.map((m) => (
                <tr key={m.what}>
                  <td>
                    <span className="strong small">{m.what}</span>
                  </td>
                  <td>
                    <span className="small">{m.how}</span>
                  </td>
                  <td>
                    <span className="small num">{m.after}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <Alert tone="info" title="Sellers are notified">
          Pixel &amp; Port and Gadget Grove get a message explaining the merge and where their offers now appear. The merge is recorded in Action history and the Catalog Manager can reverse it within 30 days.
        </Alert>
        <Field label="Reason for merge" hint="Required. Shown to the affected sellers." error={mergeReasonError}>
          <Textarea id="aa-mg-reason" className={cx(mergeReasonError && 'is-error')} value={mergeReason} onChange={(e) => setMergeReason(e.target.value)} />
        </Field>
      </Dialog>
    </AdminLayout>
  );
}
