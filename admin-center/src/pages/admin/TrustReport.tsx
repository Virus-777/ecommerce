import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { STAFF } from '@marketly/web-shared/data/staff';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useCountdown, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, Avatar, Badge, Button, Card, Deadline, Dialog, EmptyState, Field, Icon, IconButton, Img, KeyValue, OptionCard, PageHeader, Select, StatusBadge, TableWrap, Tabs, Textarea, Timeline, announce,
  type TimelineEvent, type Tone,
} from '@marketly/web-shared/ui';
import { ACTION_TONE, REPORT_TYPES, REPORTS, type RoutedAction } from './data/trust';
import { actionDef, REVIEWERS, TRUST_ACTIONS, trustDetail, type CaseAction, type Reversible, type TrustActionKey, type TrustDetail } from './data/trust-reports';
import './TrustReport.css';

// Trust report (admin/trust-report): designed in React after the design export, following
// reports/Best ecommerce site UX patterns.md, "Trust and risk report detail".
// Views: '' investigation · 'take-action' = action dialog · 'decision-recorded' = after an action
// (status and timeline updated, success alert, next case prompt). J / K open the next / previous
// report in the queue. Trust recommends; actions owned by other teams are sent to that team, as on
// the Trust and risk queue.
//
// Rules applied here (blueprint "Create and edit forms"): the dialog's submit button is never
// disabled, errors show on submit; the result is an inline alert, not a toast (it is not a
// background job).

type View = 'take-action' | 'decision-recorded';
type EvTab = 'entities' | 'attachments' | 'history';

const ME = STAFF.admin.name;
const NOW = 'Oct 8, 10:47 AM';
const NEW_ENTRY = 'AE-261008-1047';
const BAND_CLASS = { High: 'high', Medium: 'med', Low: 'low' } as const;
const UNDO: Record<Reversible, { text: string; icon: 'undo-2' | 'lock'; cls: string }> = {
  yes: { text: 'Can be undone', icon: 'undo-2', cls: 't-success-text' },
  partly: { text: 'Only partly reversible', icon: 'lock', cls: 't-warning-text' },
  no: { text: 'Cannot be undone', icon: 'lock', cls: 't-danger-text' },
};

const reportHref = (ref: string) => href('admin/trust-report', '', { ref });
const reasonCode = (r: string) => r.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const available = (c: CaseAction): c is Exclude<CaseAction, { unavailable: string }> => !('unavailable' in c);

interface Draft {
  action: TrustActionKey;
  reason: string;
  reviewer: string;
  note: string;
}

/** Owner and button label of an action for this report (some reports route an action to another team). */
function routing(d: TrustDetail, k: TrustActionKey) {
  const def = actionDef(k);
  const c = d.actions[k];
  const owner = (available(c) && c.owner) || (k === 'suspend' && d.subject.kind === 'accounts' ? 'Support · Isabel Cruz' : def.owner);
  const byTrust = owner === 'Trust and Risk';
  return { def, c, owner, byTrust, submit: (available(c) && c.submit) || def.submit, reasons: (available(c) && c.reasons) || def.reasons };
}

function Sla({ label, seconds }: { label: string; seconds: number }) {
  const [h, m] = useCountdown(seconds);
  const hrs = Number(h);
  return (
    <span role="timer" aria-live="off">
      <Deadline tone={hrs < 4 ? 'warning' : 'ok'}>
        {label} · {hrs} h {m} m left
      </Deadline>
    </span>
  );
}

function NotFound({ refId }: { refId: string }) {
  return (
    <AdminLayout active="trust">
      <PageHeader crumbs={[{ label: 'Customers and service' }, { label: 'Trust and risk', to: href('admin/trust') }, { label: refId }]} title="Trust report not found" />
      <Card pad>
        <EmptyState
          icon="search-x"
          title={`There is no open trust report ${refId}`}
          as="h2"
          action={
            <Button to={href('admin/trust')} icon="shield-alert">
              Go to Trust and risk
            </Button>
          }
        >
          Reports are numbered like TR-3391. The report may have been closed or merged into another one; closed reports are in Action history.
        </EmptyState>
      </Card>
    </AdminLayout>
  );
}

export default function TrustReport() {
  const { ref = '' } = useParams();
  const d = trustDetail(ref);
  if (!d) return <NotFound refId={ref} />;
  // Keyed by report so state resets when J/K moves to another report.
  return <Investigation key={ref} d={d} />;
}

function Investigation({ d }: { d: TrustDetail }) {
  const r = d.report;
  const navigate = useNavigate();
  const [view, setView] = useView<View>();
  const [assignee, setAssignee] = useState(d.assignee);
  const [extra, setExtra] = useState<TimelineEvent[]>([]);
  const [recorded, setRecorded] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft>({ action: d.recommended.action, reason: '', reviewer: '', note: '' });
  const [attempted, setAttempted] = useState(false);
  const [allFactors, setAllFactors] = useState(false);
  const [tab, setTab] = useState<EvTab>('entities');

  const idx = REPORTS.findIndex((x) => x.id === r.id);
  const prev = REPORTS[idx - 1];
  const next = REPORTS[idx + 1];

  // J = next report, K = previous (as in Stripe Radar reviews and Gmail). Ignored while typing or in a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || document.querySelector('[data-dialog]')) return;
      const k = e.key.toLowerCase();
      if (k === 'j' && next) navigate(reportHref(next.id));
      else if (k === 'k' && prev) navigate(reportHref(prev.id));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [next, prev, navigate]);

  const decided = view === 'decision-recorded';
  // Opening ?view=decision-recorded directly shows the recommended action as the recorded one.
  const recCase = d.actions[d.recommended.action];
  const fallback: Draft = { action: d.recommended.action, reason: d.recommended.reason, reviewer: available(recCase) && recCase.secondReviewer ? REVIEWERS[0].name : '', note: '' };
  const shown: Draft | null = decided ? (recorded ?? fallback) : null;

  /* ----- Dialog ----- */
  const sel = routing(d, draft.action);
  const selCase = available(sel.c) ? sel.c : null;
  const needsReviewer = !!selCase?.secondReviewer;
  const errors = attempted
    ? {
        action: selCase ? undefined : 'Choose an action that applies to this report.',
        reason: draft.reason ? undefined : 'Choose a reason code. It is written to Action history with this decision.',
        reviewer: needsReviewer && !draft.reviewer ? 'Choose a second reviewer. This action does not go ahead until they approve.' : undefined,
      }
    : {};
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((x) => ({ ...x, [k]: v }));

  const openAction = (k: TrustActionKey = d.recommended.action) => {
    setDraft({ action: k, reason: '', reviewer: '', note: '' });
    setAttempted(false);
    setView('take-action');
  };
  const submit = () => {
    setAttempted(true);
    if (!selCase || !draft.reason || (needsReviewer && !draft.reviewer)) return;
    // Acting on an unassigned report makes you its assignee.
    if (!assignee) assignToMe();
    setRecorded(draft);
    setView('decision-recorded', { replace: true });
    announce(`${sel.def.label} recorded for ${r.id}`);
  };

  /* ----- Derived state after a decision ----- */
  let status: { label: string; tone?: Tone } = { label: r.status };
  let routed: RoutedAction[] = r.actions;
  let timeline: TimelineEvent[] = [...d.timeline, ...extra];
  let outcome: ReturnType<typeof routing> | null = null;
  if (shown) {
    const o = (outcome = routing(d, shown.action));
    const oc = o.c as Exclude<CaseAction, { unavailable: string }>;
    const reviewer = oc.secondReviewer ? shown.reviewer : '';
    status =
      shown.action === 'clear'
        ? { label: 'Resolved' }
        : shown.action === 'request-info' && o.byTrust
          ? { label: d.subject.kind === 'seller' ? 'Waiting on seller' : 'Waiting on customer' }
          : reviewer
            ? { label: 'Waiting for second review', tone: 'warning' }
            : o.byTrust
              ? { label: 'Open' }
              : { label: 'Sent to owner', tone: 'info' };
    routed = [...r.actions, { title: oc.what, owner: o.owner, status: o.byTrust ? 'Completed' : reviewer ? 'Pending' : 'Sent to owner', reason: shown.reason }];
    timeline = [
      ...timeline.map((e) => (e.state === 'current' ? { ...e, state: 'done' as const } : e)),
      { t: `${o.def.label}: ${oc.what}`, d: `${NOW} · by ${ME}`, state: 'done', body: `Reason code ${reasonCode(shown.reason)} written to Action history (${NEW_ENTRY}).${shown.note.trim() ? ` Note: ${shown.note.trim()}` : ''}` },
      ...(reviewer ? [{ t: `Waiting for second review by ${reviewer}`, d: 'Requested just now', state: 'warn' as const }] : []),
      ...(!o.byTrust ? [{ t: `Sent to ${o.owner}`, d: reviewer ? 'After approval' : 'Just now · in their queue', state: 'current' as const }] : []),
      ...(shown.action === 'request-info' && o.byTrust ? [{ t: 'Waiting for the seller to reply', d: 'Due Oct 13 · SLA paused', state: 'current' as const }] : []),
    ];
  }

  const assignToMe = () => {
    const from = assignee;
    setAssignee(ME);
    setExtra((x) => [...x, { t: `Assigned to ${ME}`, d: `${NOW}${from ? ` · from ${from}` : ''}`, state: 'done' }]);
    announce(`${r.id} assigned to you`);
  };

  /* ----- Factors ----- */
  const raising = d.factors.filter((f) => f.dir === 'raises');
  const lowering = d.factors.filter((f) => f.dir === 'lowers');
  const shownRaising = allFactors ? raising : raising.slice(0, 3);
  const shownLowering = allFactors ? lowering : lowering.slice(0, 2);
  const hidden = d.factors.length - shownRaising.length - shownLowering.length;

  const type = REPORT_TYPES[r.type];
  const band = BAND_CLASS[d.band];
  const histLabel = d.subject.kind === 'seller' ? 'Seller history' : 'Account history';
  const tabs = [
    { label: 'Related entities', value: 'entities' as const, count: d.entities.length },
    { label: 'Attachments', value: 'attachments' as const, count: d.attachments.length },
    { label: histLabel, value: 'history' as const },
  ];
  const recDef = actionDef(d.recommended.action);

  return (
    <AdminLayout active="trust">
      <PageHeader
        crumbs={[{ label: 'Customers and service' }, { label: 'Trust and risk', to: href('admin/trust') }, { label: r.id }]}
        eyebrow={`Trust report · ${type.label}`}
        title={`Trust report ${r.id}`}
        sub={r.title}
        actions={
          <>
            <StatusBadge status={status.label} tone={status.tone} />
            <nav className="trr-queue" aria-label="Queue">
              {prev ? <IconButton icon="chevron-left" label={`Previous report, ${prev.id} (K)`} to={reportHref(prev.id)} /> : <IconButton icon="chevron-left" label="Previous report" disabled />}
              <span className="pos">
                {idx + 1} of {REPORTS.length}
              </span>
              {next ? <IconButton icon="chevron-right" label={`Next report, ${next.id} (J)`} to={reportHref(next.id)} /> : <IconButton icon="chevron-right" label="Next report" disabled />}
              <span className="no-phone xs muted row gap-1 nowrap" aria-hidden="true">
                <span className="trr-kbd">J</span>
                <span className="trr-kbd">K</span>
              </span>
            </nav>
            <Button size="sm" icon="gavel" onClick={() => openAction()}>
              Take action
            </Button>
          </>
        }
      />

      <div className="card pad trr-strip">
        <span className="row gap-3">
          {decided ? <Deadline>Decision recorded {NOW} · within SLA</Deadline> : <Sla label={d.sla.label} seconds={d.sla.seconds} />}
          <span className="xs muted">{r.meta.split(' · assigned')[0]}</span>
        </span>
        <span className="who">
          {assignee ? (
            <>
              <Avatar name={assignee} className="ab-av-sm" />
              <span className="ab-cell">
                <span className="small strong">{assignee === ME ? `${ME} (you)` : assignee}</span>
                <span className="xs muted">Assignee</span>
              </span>
            </>
          ) : (
            <span className="ab-cell">
              <span className="small strong t-warning-text">Unassigned</span>
              <span className="xs muted">Nobody owns this report yet</span>
            </span>
          )}
          {assignee !== ME && (
            <Button variant="secondary" size="sm" icon="user-check" onClick={assignToMe}>
              Assign to me
            </Button>
          )}
        </span>
      </div>

      {decided && shown && outcome && (
        <>
          <Alert tone="success" title={outcome.byTrust ? `${outcome.def.label} recorded` : `${outcome.def.label} sent to ${outcome.owner}`}>
            Reason code <span className="mono">{reasonCode(shown.reason)}</span> was written to Action history as <span className="mono">{NEW_ENTRY}</span>.{' '}
            {available(outcome.c) && outcome.c.secondReviewer && shown.reviewer ? `${shown.reviewer} is asked to approve before ${outcome.owner.split(' · ')[0]} acts. ` : ''}
            {!outcome.byTrust && !(available(outcome.c) && outcome.c.secondReviewer) ? `${outcome.owner.split(' · ')[0]} carries it out and records it; the status updates here. ` : ''}
            <Link to={href('admin/audit', '', undefined, { q: r.id })}>See it in Action history</Link>
          </Alert>
          <div className="card pad trr-next">
            {next ? (
              <>
                <span className="row gap-3 nowrap min-w-0">
                  <span className={`ab-risk t-${next.level}`} aria-label={`Risk score ${next.score} of 100`}>
                    {next.score}
                  </span>
                  <span className="ab-cell">
                    <span className="xs muted">Next in queue · {next.id}</span>
                    <span className="small strong">{next.title}</span>
                  </span>
                </span>
                <span className="row gap-2 nowrap">
                  <span className="no-phone xs muted">
                    or press <span className="trr-kbd">J</span>
                  </span>
                  <Button size="sm" iconRight="arrow-right" to={reportHref(next.id)}>
                    Open {next.id}
                  </Button>
                </span>
              </>
            ) : (
              <>
                <span className="small strong">That was the last report in the queue.</span>
                <Button variant="secondary" size="sm" to={href('admin/trust')}>
                  Back to Trust and risk
                </Button>
              </>
            )}
          </div>
        </>
      )}

      <div className="ab-main wide">
        <div className="stack gap-5">
          <Card title="Verdict" sub={d.scoredAt}>
            <div className="trr-verdict">
              <div className={`trr-band t-${band}`}>
                <span className="b">{d.band} risk</span>
                <span className="s">Score {r.score} / 100</span>
              </div>
              <p className="trr-why">{d.why}</p>
            </div>
          </Card>

          <Card
            title="Risk factors"
            sub="The signals that moved the score most. No single factor decides the band."
            foot={
              d.factors.length > 5 || hidden > 0 || allFactors ? (
                <Button variant="ghost" size="sm" icon={allFactors ? 'chevrons-down-up' : 'chevrons-up-down'} aria-expanded={allFactors} onClick={() => setAllFactors((x) => !x)}>
                  {allFactors ? 'Show fewer' : `Show all ${d.factors.length} factors`}
                </Button>
              ) : undefined
            }
          >
            <div className="trr-factors">
              {[
                { title: 'Raising risk', icon: 'arrow-up' as const, cls: 't-danger-text', list: shownRaising, total: raising.length },
                { title: 'Lowering risk', icon: 'arrow-down' as const, cls: 't-success-text', list: shownLowering, total: lowering.length },
              ].map((g) => (
                <div className="trr-fgroup" key={g.title}>
                  <h3>
                    <Icon name={g.icon} className={cx('ic-sm', g.cls)} />
                    {g.title} <span className="muted">({g.total})</span>
                  </h3>
                  {g.list.length ? (
                    <ul className="trr-flist">
                      {g.list.map((f) => (
                        <li key={f.title} className={`t-${f.dir}`}>
                          <Icon name={f.dir === 'raises' ? 'arrow-up' : 'arrow-down'} />
                          <span className="strong">{f.title}</span>
                          <Badge tone={f.weight === 'Strong' ? 'outline' : ''}>{f.weight}</Badge>
                          <span className="d">{f.detail}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="trr-empty-group">None found.</span>
                  )}
                </div>
              ))}
            </div>
          </Card>

          <Card title="Evidence" className="trr-ev" flush>
            <div className="card-body trr-tabs">
              <Tabs items={tabs} active={tab} onChange={setTab} label="Evidence" />
            </div>
            {tab === 'entities' && (
              <div role="tabpanel" aria-label="Related entities">
                <TableWrap label="Related entities table">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Entity</th>
                        <th scope="col">Linked by</th>
                        <th className="col-pin" scope="col">
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.entities.map((e) => (
                        <tr key={e.kind + e.label}>
                          <td>
                            <span className="trr-ent">
                              <Icon name={e.icon} className="ic-sm" />
                              <span className="ab-cell">
                                <span className="xs muted">{e.kind}</span>
                                <Link className="strong" to={href(e.to)}>
                                  {e.label}
                                </Link>
                                {e.sub && <span className="xs muted">{e.sub}</span>}
                              </span>
                            </span>
                          </td>
                          <td>
                            <span className="small minw-200 cell-text">{e.shared}</span>
                          </td>
                          <td className="col-pin">{e.status ? <StatusBadge status={e.status} /> : <span className="xs muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </div>
            )}
            {tab === 'attachments' && (
              <div role="tabpanel" aria-label="Attachments" className="card-body">
                <div className="ab-photos">
                  {d.attachments.map((a) => (
                    <figure key={a.name}>
                      <Img icon={a.icon} tint={a.tint} className="r43" />
                      <figcaption>
                        <b>{a.name}</b>
                        <br />
                        {a.by} · {a.when}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            )}
            {tab === 'history' && (
              <div role="tabpanel" aria-label={histLabel} className="card-body">
                <KeyValue pairs={d.history.facts} />
                <div className="divider" />
                <ul className="trr-hist">
                  {d.history.rows.map((h) => (
                    <li key={h.when + h.what}>
                      <span className="ab-cell">
                        <span className="small">{h.what}</span>
                        <span className="xs muted">
                          {h.when}
                          {h.entry && (
                            <>
                              {' · '}
                              <Link className="mono" to={href('admin/audit-entry', '', { id: h.entry })}>
                                {h.entry}
                              </Link>
                            </>
                          )}
                        </span>
                      </span>
                      <StatusBadge status={h.outcome} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          <Card title="Actions on this report" sub="Trust recommends; the owning team carries out the action and records its reason">
            <ul className="ab-route">
              {routed.map((a) => (
                <li key={a.title}>
                  <span className="stack gap-0">
                    <span className="small strong">{a.title}</span>
                    <span className="xs muted">{a.owner}</span>
                  </span>
                  <Badge tone={ACTION_TONE[a.status]}>{a.status}</Badge>
                  {a.reason && <span className="xs sub">Reason recorded: {a.reason}</span>}
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="stack gap-5">
          {!decided && (
            <Card title="Recommended next step" className="trr-rec" sub={`${recDef.label} · ${routing(d, recDef.key).byTrust ? 'done by Trust' : `sent to ${routing(d, recDef.key).owner}`}`}>
              <p className="small">{d.recommended.text}</p>
              <Button size="sm" icon={recDef.icon} onClick={() => openAction(recDef.key)}>
                {recDef.label}: review and confirm
              </Button>
            </Card>
          )}

          <Card title="Actions" sub="Every action needs a reason code, which is written to Action history">
            <ul className="trr-acts">
              {TRUST_ACTIONS.map((a) => {
                const ro = routing(d, a.key);
                const c = ro.c;
                if (!available(c)) {
                  return (
                    <li key={a.key} className="is-off">
                      <span className="ic">
                        <Icon name={a.icon} />
                      </span>
                      <span className="ab-cell">
                        <span className="small strong">{a.label}</span>
                        <span className="xs muted">Does not apply: {c.unavailable}</span>
                      </span>
                    </li>
                  );
                }
                const u = UNDO[a.reversible];
                return (
                  <li key={a.key}>
                    <span className="ic">
                      <Icon name={a.icon} />
                    </span>
                    <span className="ab-cell">
                      <span className="small strong">{a.label}</span>
                      <span className="xs muted">
                        {c.what} · {ro.byTrust ? 'done by Trust' : `sent to ${ro.owner}`}
                      </span>
                      <span className={cx('trr-undo', u.cls)}>
                        <Icon name={u.icon} />
                        {u.text}
                        {c.secondReviewer ? ' · second reviewer' : ''}
                      </span>
                    </span>
                    <Button variant="secondary" size="sm" onClick={() => openAction(a.key)} srLabel={a.label}>
                      Choose
                    </Button>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card title="Timeline" sub="Every report, assignment and action, oldest first">
            <Timeline events={timeline} />
          </Card>
        </div>
      </div>

      <Dialog
        open={view === 'take-action'}
        onClose={() => setView('')}
        title={`Take action on ${r.id}`}
        size="lg"
        foot={
          <>
            <Button variant="ghost" onClick={() => setView('')}>
              Cancel
            </Button>
            <Button variant={draft.action === 'suspend' ? 'danger' : 'primary'} onClick={submit}>
              {needsReviewer ? 'Send for second review' : sel.submit}
            </Button>
          </>
        }
      >
        <p className="small sub">{r.title}</p>
        <fieldset className="stack gap-2 fieldset-reset">
          <legend className="label">Action</legend>
          {TRUST_ACTIONS.map((a) => {
            const ro = routing(d, a.key);
            const c = ro.c;
            const u = UNDO[a.reversible];
            return (
              <OptionCard
                key={a.key}
                id={`tra-${a.key}`}
                name="tra-action"
                title={
                  <span className="row gap-2">
                    <span className="small strong">{a.label}</span>
                    {a.key === d.recommended.action && <Badge tone="brand">Recommended</Badge>}
                  </span>
                }
                body={available(c) ? `${c.what} · ${ro.byTrust ? 'done by Trust' : `sent to ${ro.owner}`}` : `Does not apply: ${c.unavailable}`}
                right={available(c) ? <span className={cx('trr-undo', u.cls)}>{u.text}</span> : undefined}
                checked={draft.action === a.key}
                disabled={!available(c)}
                onChange={() => setDraft((x) => ({ ...x, action: a.key, reason: '', reviewer: '' }))}
              />
            );
          })}
        </fieldset>
        {errors.action && (
          <span className="error-text">
            <Icon name="circle-alert" className="ic-sm" />
            {errors.action}
          </span>
        )}
        {selCase && (
          <div className="panel trr-conseq">
            <span className="small strong">What happens</span>
            <span className="r">
              <Icon name="info" />
              <span>{selCase.consequence}</span>
            </span>
            <span className="r">
              <Icon name={UNDO[sel.def.reversible].icon} />
              <span>{sel.def.undo}</span>
            </span>
            <span className="r">
              <Icon name="user-round" />
              <span>{sel.byTrust ? 'Done by Trust and Risk as soon as you confirm.' : `Trust recommends; ${sel.owner} carries it out from their queue and records it.`}</span>
            </span>
            {selCase.done && (
              <span className="r">
                <Icon name="circle-check" />
                <span>Already in place: {selCase.done}</span>
              </span>
            )}
          </div>
        )}
        <Field label="Reason code" hint={draft.reason ? <>Written to Action history as <span className="mono">{reasonCode(draft.reason)}</span></> : 'Written to Action history with your name and this report'} error={errors.reason}>
          <Select id="tra-reason" options={[{ value: '', label: 'Select a reason code' }, ...sel.reasons.map((x) => ({ value: x, label: x }))]} value={draft.reason} onChange={(e) => set('reason', e.target.value)} />
        </Field>
        {needsReviewer && (
          <Field label="Second reviewer" hint={`${selCase?.secondReviewer} They get it in their inbox; nothing changes until they approve.`} error={errors.reviewer}>
            <Select id="tra-reviewer" options={[{ value: '', label: 'Select a reviewer' }, ...REVIEWERS.filter((p) => p.name !== ME).map((p) => ({ value: p.name, label: `${p.name}, ${p.role}` }))]} value={draft.reviewer} onChange={(e) => set('reviewer', e.target.value)} />
          </Field>
        )}
        <Field label="Note for the record" optional hint="Staff only. Saved with the reason code.">
          <Textarea id="tra-note" placeholder="What you checked and why" value={draft.note} onChange={(e) => set('note', e.target.value)} />
        </Field>
      </Dialog>
    </AdminLayout>
  );
}
