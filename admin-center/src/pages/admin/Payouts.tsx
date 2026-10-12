import { useState } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { money } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Button, Card, Checkbox, Dialog, Field, Icon, PageHeader, Pager, SearchInput, Stat, StatusBadge, TableWrap, Textarea, announce } from '@marketly/web-shared/ui';
import {
  APPROVALS, DESTINATION_CHANGES, FAILED_PAYOUTS, PAYOUT_KPIS, RUN, RUN_CHECKS, RUN_SELLERS, STATUS_MEANING,
  type ApprovalStep, type DestState, type DestinationChange, type FailedPayout, type RunSeller,
} from './data/payouts';

// Design: pages/admin/admin-payouts.html · view "approve-run" = the second-approval dialog.

type View = 'approve-run';
type CheckTone = 'ok' | 'info' | 'warn';

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

const CHECK_ICON = { ok: 'circle-check', info: 'info', warn: 'triangle-alert' } as const;
const CHECK_SR: Partial<Record<CheckTone, string>> = { ok: 'Passed: ', warn: 'Warning: ' };

/** .ab-checks list (passed / info / warning lines). */
function Checks({ items }: { items: Array<{ tone: CheckTone; text: string; sub?: string }> }) {
  return (
    <ul className="ab-checks">
      {items.map((c) => (
        <li key={c.text} className={`t-${c.tone}`}>
          {CHECK_SR[c.tone] && <span className="sr-only">{CHECK_SR[c.tone]}</span>}
          <Icon name={CHECK_ICON[c.tone]} className="ic-sm" />
          <span className="stack gap-0">
            <span>{c.text}</span>
            {c.sub && <span className="xs muted">{c.sub}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

const DEST: Record<DestState, { cls: string; icon: 'shield-check' | 'triangle-alert' | 'clock'; text: string }> = {
  verified: { cls: 't-success-text', icon: 'shield-check', text: 'Verified' },
  review: { cls: 't-warning-text', icon: 'triangle-alert', text: 'Change under review' },
  pending: { cls: 't-warning-text', icon: 'clock', text: 'Verification pending' },
};

const isAtRisk = (s: RunSeller) => s.status === 'On hold' || s.dest.state !== 'verified';

const APPROVAL_BADGE: Record<ApprovalStep['state'], { label: string; tone: 'success' | 'warning' }> = {
  approved: { label: 'Approved', tone: 'success' },
  pending: { label: 'Pending', tone: 'warning' },
  'sent-back': { label: 'Changes requested', tone: 'warning' },
};

/** .ab-approvals list; `dialog` switches to the dialog's wording. */
function Approvals({ steps, dialog }: { steps: ApprovalStep[]; dialog?: boolean }) {
  return (
    <ul className="ab-approvals">
      {steps.map((s, i) => {
        const done = s.state === 'approved';
        const title = dialog ? s.who : done || !s.pendingTitle ? `${s.who} · ${s.role}` : s.pendingTitle;
        return (
          <li key={s.who}>
            <span className={cx('n', done ? 'is-done' : 'is-wait')}>{done ? <Icon name="check" className="ic-sm" /> : i + 1}</span>
            <span className="ab-cell">
              <span className="strong">{title}</span>
              <span className="xs muted">{dialog ? s.dialogMeta : s.meta}</span>
            </span>
            <StatusBadge status={APPROVAL_BADGE[s.state].label} tone={APPROVAL_BADGE[s.state].tone} />
          </li>
        );
      })}
    </ul>
  );
}

const DIALOG_NOTE = 'Checked holds against open disputes CS-104882 and CB-2210. OK to release.';

export default function Payouts() {
  const [view, setView] = useView<View>();
  const [sellers, setSellers] = useState(RUN_SELLERS);
  const [failed, setFailed] = useState(FAILED_PAYOUTS);
  const [changes, setChanges] = useState(DESTINATION_CHANGES);
  const [approvals, setApprovals] = useState(APPROVALS);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [reminded, setReminded] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; title: string; body: string } | null>(null);
  // The design's "approve-run" view shows the dialog filled in; opening it from the page starts empty.
  const [confirm, setConfirm] = useState(view === 'approve-run');
  const [note, setNote] = useState(view === 'approve-run' ? DIALOG_NOTE : '');
  const [errors, setErrors] = useState<{ confirm?: string; note?: string }>({});

  const runState = approvals[approvals.length - 1].state;
  const rows = sellers.filter((s) => s.seller.toLowerCase().includes(q.trim().toLowerCase()));

  const resetApproval = () => {
    setConfirm(false);
    setNote('');
    setErrors({});
  };
  const close = () => setView('');

  const approve = () => {
    if (!confirm) {
      setErrors({ confirm: 'Confirm that you reviewed the held, failed and changed-destination payouts.' });
      return;
    }
    setApprovals((l) => l.map((s, i) => (i === l.length - 1 ? { ...s, state: 'approved', meta: 'Approved Oct 9, 9:12 AM' } : s)));
    setNotice({ tone: 'success', title: `Payout run ${RUN.id} approved`, body: `Release is scheduled for ${RUN.release}. Each payout moves to Processing at release and shows Paid when the bank confirms.` });
    announce('Payout run approved');
    close();
  };
  const sendBack = () => {
    if (!note.trim()) {
      setErrors({ note: 'Add a comment so Priya Nair knows what to change.' });
      return;
    }
    setApprovals((l) => l.map((s, i) => (i === l.length - 1 ? { ...s, state: 'sent-back', meta: 'Sent back by Owen Price · Oct 9' } : s)));
    setNotice({ tone: 'info', title: 'Run sent back to Priya Nair', body: `Your comment: "${note.trim()}". The run is not released until both approvals are recorded.` });
    announce('Run sent back');
    close();
  };

  const retry = (f: FailedPayout) => {
    setFailed((l) => l.map((x) => (x.ref === f.ref ? { ...x, status: 'Pending', edge: '' } : x)));
    setNotice({ tone: 'success', title: `${f.ref} added to this run`, body: `${money(f.amount)} to ${f.seller} is paid at release.` });
  };

  const decide = (c: DestinationChange, approved: boolean) => {
    setChanges((l) => l.map((x) => (x.id === c.id ? { ...x, state: approved ? 'approved' : 'rejected', decided: approved ? 'Approved Oct 9 by Owen Price · reason: all verification checks reviewed' : `Rejected Oct 9 by Owen Price · payouts stay on ${c.from}` } : x)));
    setSellers((l) => l.map((s) => (s.seller === c.seller ? { ...s, dest: { bank: approved ? c.to : c.from, state: 'verified' } } : s)));
    announce(approved ? 'Destination change approved' : 'Destination change rejected');
  };

  const kpis = PAYOUT_KPIS.map((k, i) => (i === 0 && runState === 'approved' ? { ...k, note: 'Approved · release scheduled' } : k));

  return (
    <AdminLayout active="payouts">
      <PageHeader
        crumbs={[{ label: 'Finance', to: href('admin/finance') }, { label: 'Payouts' }]}
        title={`Payout run ${RUN.id}`}
        sub={RUN.sub}
        actions={
          <>
            <Button variant="secondary" size="sm" icon="file-text">
              Statements
            </Button>
            <Button variant="secondary" size="sm" icon="download">
              Export run
            </Button>
          </>
        }
      />
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.body}
        </Alert>
      )}
      <div className="ab-kpis k5">
        {kpis.map((k) => (
          <div key={k.label} className="card pad">
            <Stat icon={k.icon} label={k.label} value={k.value} note={k.note} />
          </div>
        ))}
      </div>
      <p className="ab-note">
        <Icon name="info" className="ic-sm" /> Example schedule: weekly, after delivery plus a 7-day hold. Final payout timing is set in the seller agreement.
      </p>
      <div className="ab-main wide">
        <div className="stack gap-5">
          <Card
            title="Sellers in this run"
            sub={`Showing ${rows.length} of 41 · held and changed rows first`}
            flush
            actions={
              <span className="no-phone">
                <SearchInput id="po-q" placeholder="Search seller" value={q} onChange={setQ} />
              </span>
            }
            foot={
              <>
                <span className="ab-note grow">Held amounts stay in the seller balance as Held and appear on the seller statement with the same reason and review date.</span>
                <Pager page={page} total={5} onPage={setPage} />
              </>
            }
          >
            <TableWrap label="Sellers in this run table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Seller</th>
                    <th className="r" scope="col">Available</th>
                    <th scope="col">Holds (reason · review date)</th>
                    <th className="r" scope="col">Negative balance</th>
                    <th scope="col">Destination</th>
                    <th className="r" scope="col">Payout</th>
                    <th className="col-pin" scope="col">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted">
                        No seller in this run matches "{q}".
                      </td>
                    </tr>
                  )}
                  {rows.map((s) => {
                    const warn = isAtRisk(s);
                    const d = DEST[s.dest.state];
                    return (
                      <tr key={s.seller} className={cx(warn && 'is-warn')}>
                        <td>
                          {warn && <span className="sr-only">At risk: </span>}
                          <Link className="strong" to={href('admin/seller')}>
                            {s.seller}
                          </Link>
                        </td>
                        <td className="r">
                          <span className="num">{money(s.available)}</span>
                        </td>
                        <td>
                          {s.hold ? (
                            <span className="ab-cell">
                              <span className="strong">
                                <span className="t-warning-text num">{money(s.hold.amount)}</span> · {s.hold.reason}
                              </span>
                              <span className="xs muted">Review by {s.hold.review}</span>
                            </span>
                          ) : (
                            <span className="muted">None</span>
                          )}
                        </td>
                        <td className="r">
                          {s.negative ? (
                            <span className="ab-cell">
                              <span className="strong">
                                <span className="t-danger-text strong num">−{money(s.negative.amount)}</span>
                              </span>
                              <span className="xs muted">{s.negative.note}</span>
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          <span className="ab-cell">
                            <span className="strong">{s.dest.bank}</span>
                            <span className="xs muted">
                              <span className={d.cls}>
                                <Icon name={d.icon} className="ic-sm" /> {d.text}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="r">
                          <span className="num strong">{money(s.payout)}</span>
                        </td>
                        <td className="col-pin">
                          <StatusBadge status={s.status} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            <EdgeLegend items={['warning']} />
          </Card>

          <Card title="Failed payouts" sub="From the Oct 2 run · the seller sees the same reason" titleAs="h3" flush>
            <TableWrap label="Failed payouts table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Payout</th>
                    <th scope="col">Seller</th>
                    <th className="r" scope="col">Amount</th>
                    <th scope="col">Reason from the bank</th>
                    <th scope="col">Fix</th>
                    <th scope="col">Status</th>
                    <th className="col-pin" scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {failed.map((f) => (
                    <tr key={f.ref} className={cx(f.edge === 'flagged' && 'is-flagged', f.edge === 'warn' && 'is-warn')}>
                      <td>
                        {f.edge === 'flagged' && <span className="sr-only">Urgent: </span>}
                        {f.edge === 'warn' && <span className="sr-only">At risk: </span>}
                        <a className="mono nowrap" href="#" title={f.ref}>
                          {f.ref}
                        </a>
                      </td>
                      <td>{f.seller}</td>
                      <td className="r">
                        <span className="num">{money(f.amount)}</span>
                      </td>
                      <td>{f.reason}</td>
                      <td>{f.fixed ? <span className="t-success-text">{f.fix}</span> : f.fix}</td>
                      <td>
                        <StatusBadge status={f.status} />
                      </td>
                      <td className="col-pin">
                        {f.status === 'Pending' ? (
                          <span className="xs muted">Added to this run</span>
                        ) : (
                          <button type="button" className="btn btn-secondary btn-sm" disabled={!f.canRetry} onClick={() => retry(f)}>
                            {f.canRetry && <Icon name="refresh-cw" />}
                            <span>{f.canRetry ? 'Retry in this run' : 'Retry'}</span>
                            <span className="sr-only"> {f.ref}</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <EdgeLegend items={['danger', 'warning']} />
          </Card>

          <Card title="Destination changes" sub="Changes need verification and a recorded review before money goes to the new account" titleAs="h3" flush>
            <ul className="list pad">
              {changes.map((c) =>
                c.state === 'review' ? (
                  <li key={c.id} className="row top">
                    <span className="grow stack gap-2">
                      <span className="row gap-2">
                        <b className="small">{c.seller}</b>
                        <StatusBadge status="Under review" />
                      </span>
                      <span className="small">
                        {c.from} <Icon name="arrow-right" className="ic-sm" /> {c.to} · {c.requested}
                      </span>
                      <Checks items={c.checks} />
                      <span className="xs muted">{c.note}</span>
                    </span>
                    <span className="row gap-2">
                      <Button variant="ghost" size="sm" onClick={() => decide(c, false)}>
                        Reject
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => decide(c, true)}>
                        Approve change
                      </Button>
                    </span>
                  </li>
                ) : (
                  <li key={c.id}>
                    <span className="grow stack gap-0">
                      <span className="small">
                        <b>{c.seller}</b> · {c.from} <Icon name="arrow-right" className="ic-sm" /> {c.to}
                      </span>
                      <span className="xs muted">{c.decided}</span>
                    </span>
                    <StatusBadge status={c.state === 'approved' ? 'Approved' : 'Rejected'} />
                  </li>
                ),
              )}
            </ul>
          </Card>
        </div>
        <div className="stack gap-5 ab-sticky">
          <Card
            title="Approval"
            sub="Runs over $50,000 need a second Finance reviewer"
            titleAs="h3"
            foot={
              runState === 'pending' ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="bell"
                    disabled={reminded}
                    onClick={() => {
                      setReminded(true);
                      announce('Reminder sent to Owen Price');
                    }}
                  >
                    {reminded ? 'Reminder sent' : 'Remind Owen Price'}
                  </Button>
                  <Button size="sm" to={href('admin/payouts', 'approve-run')} onClick={resetApproval}>
                    Open approval
                  </Button>
                </>
              ) : (
                <span className="xs muted">{runState === 'approved' ? `Release scheduled ${RUN.release}` : 'Waiting for Priya Nair to update the run'}</span>
              )
            }
          >
            <Approvals steps={approvals} />
            <Alert tone="info" title="You can view this run">
              Riley Chen, Platform Administrator: this role manages accounts but has no payout authority.
            </Alert>
            <div className="ab-sumlist">
              <div>
                <span>Paying now</span>
                <span>{money(RUN.payingNow)}</span>
              </div>
              <div>
                <span>Held, not paid</span>
                <span>{money(RUN.held)}</span>
              </div>
              <div>
                <span>Negative balances offset</span>
                <span>{money(RUN.offset)}</span>
              </div>
              <div>
                <span>Release</span>
                <span>{RUN.release}</span>
              </div>
            </div>
          </Card>
          <Card title="Payout status meaning" titleAs="h3">
            <div className="stack gap-2 small">
              {STATUS_MEANING.map((s) => (
                <span key={s.status} className="row gap-2">
                  <StatusBadge status={s.status} />
                  <span className="sub">{s.text}</span>
                </span>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Dialog
        open={view === 'approve-run'}
        onClose={close}
        title={`Approve payout run ${RUN.id}`}
        size="lg"
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={sendBack}>
              Send back with comment
            </Button>
            <Button icon="check" onClick={approve}>
              Approve and schedule release
            </Button>
          </>
        }
      >
        <div className="row gap-2 small sub">
          <Avatar name="Owen Price" className="ab-av-sm" />
          <span>
            Approving as <b>Owen Price</b>, Finance Specialist · second reviewer
          </span>
        </div>
        <div className="grid md2 gap-4">
          <div className="well stack gap-2">
            <div className="ab-sumlist">
              <div>
                <span>Run total</span>
                <span>{money(RUN.total)}</span>
              </div>
              <div>
                <span>Paying now · {RUN.payingSellers} sellers</span>
                <span>{money(RUN.payingNow)}</span>
              </div>
              <div>
                <span>Held · {RUN.heldSellers} sellers</span>
                <span>{money(RUN.held)}</span>
              </div>
              <div>
                <span>Retries included</span>
                <span>
                  {RUN.retries.n} · {money(RUN.retries.amount)}
                </span>
              </div>
              <div>
                <span>Release</span>
                <span>{RUN.release}</span>
              </div>
            </div>
          </div>
          <Approvals steps={approvals} dialog />
        </div>
        <Checks items={RUN_CHECKS} />
        <Checkbox
          id="po-confirm"
          label="I reviewed the held, failed and changed-destination payouts in this run"
          checked={confirm}
          aria-invalid={errors.confirm ? true : undefined}
          aria-describedby={errors.confirm ? 'po-confirm-err' : undefined}
          onChange={(e) => {
            setConfirm(e.target.checked);
            setErrors((x) => ({ ...x, confirm: undefined }));
          }}
        />
        {errors.confirm && (
          <span className="error-text" id="po-confirm-err">
            <Icon name="circle-alert" className="ic-sm" />
            {errors.confirm}
          </span>
        )}
        <Field label="Approval note" optional error={errors.note}>
          <Textarea
            id="po-note"
            placeholder=""
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setErrors((x) => ({ ...x, note: undefined }));
            }}
          />
        </Field>
        <Alert tone="info" title="Approved is not paid">
          At release each payout moves to Processing. It shows Paid only when the bank confirms the deposit. Sellers see the same status.
        </Alert>
      </Dialog>
    </AdminLayout>
  );
}
