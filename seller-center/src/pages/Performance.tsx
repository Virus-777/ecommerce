import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { call, errorMessage, useApi, useUploads, type components } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { Alert, announce, Badge, Button, Card, Checkbox, Deadline, Dialog, Field, FileDrop, Icon, PageHeader, Select, StatusBadge, TableWrap, Textarea, type Tone } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { date, dateTime, LoadError, monthYear, shortDate, SkeletonLines, time, weekdayDate } from './data/home';

// Design: pages/seller/seller-performance.html (no views).
// API: GET /api/seller/sellers/account (status, verification, payout readiness; shared with the session),
// GET /api/seller/sellers/performance (metrics against targets, feedback, warnings, 12-month history),
// GET /api/seller/sellers/restrictions?state=active (reason, affected activity, what still works, how to resolve,
// appeal route, appeals and evidence). "Upload documents" → POST …/restrictions/{id}/evidence (media upload,
// purpose verification_document); "Appeal restriction" → POST …/restrictions/{id}/appeals. Both need
// sellers.account-health.manage. The SellerPerformance screen query would answer the same in one call; REST is
// used for its generated types (and to stay clear of G13).
// Gaps: restriction scope has category ids only (no names: affectedSummary is shown); history events have no
// state (an event naming an active restriction or open warning is marked at risk); actor names are missing.

type Account = components['schemas']['sellers.SellerAccount'];
type Summary = components['schemas']['sellers.PerformanceSummary'];
type Metric = components['schemas']['sellers.PerformanceMetric'];
type Restriction = components['schemas']['sellers.Restriction'];
type Appeal = components['schemas']['sellers.Appeal'];

const STATUS: Record<Metric['status'], { label: string; tone: Tone; row?: string; sr?: string }> = {
  meets: { label: 'Meets target', tone: 'success' },
  watch: { label: 'At risk', tone: 'warning', row: 'is-warn', sr: 'At risk: ' },
  below: { label: 'Below target', tone: 'danger', row: 'is-flagged', sr: 'Urgent: ' },
  action_needed: { label: 'Action needed', tone: 'danger', row: 'is-flagged', sr: 'Urgent: ' },
};

const ACCOUNT_STATUS: Record<Account['status'], string> = {
  approved: 'Approved',
  restricted: 'Restricted',
  suspended: 'Suspended',
  under_review: 'Under review',
  information_required: 'Information required',
  applied: 'Applied',
  closed: 'Closed',
};

const PAYOUT: Record<Account['payoutReadiness']['state'], { label: string; tone: Tone }> = {
  verified: { label: 'Active', tone: 'success' },
  change_under_review: { label: 'Change under review', tone: 'info' },
  verification_pending: { label: 'Verification pending', tone: 'warning' },
  not_added: { label: 'Not set up', tone: 'warning' },
  blocked: { label: 'Blocked', tone: 'danger' },
};

const ACTIVITY: Record<Restriction['affectedActivities'][number], string> = {
  new_listings: 'Creating new listings',
  new_offers: 'Creating new offers',
  product_submissions: 'Submitting new products for review',
  offer_reactivation: 'Reactivating paused or hidden offers',
  sales: 'Selling the affected offers',
  advertising: 'Advertising',
  promotions: 'Promotions and deals',
  payout_schedule: 'Your payout schedule',
};

const DOC_TYPES = ['Invoice from the brand or an approved distributor', 'Authorization letter from the brand', 'Other proof of authorization'];
const OPEN_APPEAL: Appeal['state'][] = ['submitted', 'under_review'];
const DOC_ACCEPT = /\.(pdf|png|jpe?g)$|^(application\/pdf|image\/(png|jpeg))$/i;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const year = (iso: string) => new Date(iso).getFullYear();

function MetricTarget({ m, windowDays }: { m: Metric; windowDays: number }) {
  const t = m.target;
  return (
    <span className="small nowrap">
      {t.display}
      {t.windowDays !== windowDays && ` in ${t.windowDays} days`}
      {t.isExample && ' (example)'}
    </span>
  );
}

/** One active restriction with its documents and appeal dialogs. */
function RestrictionPanel({ r, onNotice }: { r: Restriction; onNotice: (n: { title: string; body: string }) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useSellerSession();
  const mayAct = can('sellers.account-health.manage');
  const [dlg, setDlg] = useState<'' | 'upload' | 'appeal'>('');

  const appeal = (r.appeals ?? []).find((a) => OPEN_APPEAL.includes(a.state));
  const docsSent = (r.resolutionEvidence?.length ?? 0) > 0;
  const status = appeal ? 'Appealed' : docsSent ? 'In review' : 'Restricted';
  const deadline = r.appealRoute.deadline;
  const closed = new Date(deadline).getTime() < Date.now();
  const steps = r.toResolve.split(/\n+/).map((s) => s.replace(/^\s*(\d+[.)]|[-•])\s*/, '').trim()).filter(Boolean);

  // Upload form
  const docs = useUploads('verification_document', { max: 5, accept: DOC_ACCEPT });
  const [docType, setDocType] = useState(DOC_TYPES[0]);
  const [uploadTried, setUploadTried] = useState(false);
  const uploadError = uploadTried && !docs.assetIds.length ? (docs.uploading ? 'Wait for the documents to finish uploading.' : 'Add at least one document (PDF, JPG or PNG).') : undefined;

  // Appeal form
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [appealTried, setAppealTried] = useState(false);
  const appealErrors = appealTried
    ? {
        reason: reason.trim().length < 30 ? 'Explain why the restriction should be lifted (at least 30 characters).' : undefined,
        confirm: !confirm ? 'Confirm the information is accurate.' : undefined,
      }
    : {};

  const refresh = () => void qc.invalidateQueries({ queryKey: ['sellers'] });
  const evidence = useMutation({
    mutationFn: () => call(api.POST('/api/seller/sellers/restrictions/{id}/evidence', { params: { path: { id: r.id } }, body: { evidenceIds: docs.assetIds, note: docType } })),
    onSuccess: () => {
      onNotice({ title: 'Documents submitted', body: 'Marketly reviews them and lifts the restriction if they resolve it.' });
      setDlg('');
      announce('Documents submitted for review');
      refresh();
    },
  });
  const submitAppeal = useMutation({
    mutationFn: () => call(api.POST('/api/seller/sellers/restrictions/{id}/appeals', { params: { path: { id: r.id } }, body: { argument: reason.trim() } })),
    onSuccess: (a) => {
      onNotice({ title: 'Appeal submitted', body: `${r.appealRoute.reviewer}, not the person who applied the restriction, decides by ${shortDate(a.decideBy.dueAt)}. We email you the decision.` });
      setDlg('');
      announce('Appeal submitted');
      refresh();
    },
  });

  const openUpload = () => {
    docs.clear();
    setUploadTried(false);
    evidence.reset();
    setDlg('upload');
  };
  const openAppeal = () => {
    setReason('');
    setConfirm(false);
    setAppealTried(false);
    submitAppeal.reset();
    setDlg('appeal');
  };
  const sendUpload = () => {
    setUploadTried(true);
    if (!docs.assetIds.length || docs.uploading) return;
    evidence.mutate();
  };
  const sendAppeal = () => {
    setAppealTried(true);
    if (reason.trim().length < 30 || !confirm) return;
    submitAppeal.mutate();
  };
  const appealBy = `${weekdayDate(deadline)}, ${time(deadline)} PT`;

  return (
    <section className="sb-restrict" aria-labelledby={`sb-r-${r.id}`}>
      <div className="hd">
        <Icon name="ban" />
        <div className="stack gap-1 grow">
          <span className="row gap-2">
            <h2 className="h3" id={`sb-r-${r.id}`}>
              {r.title}
            </h2>
            <StatusBadge status={status} />
          </span>
          <span className="small sub">
            {r.startedAt && `Since ${weekdayDate(r.startedAt)}, ${year(r.startedAt)} · `}
            {r.setBy.name && `applied by ${r.setBy.name} · `}reference <span className="mono">{r.ref}</span>
          </span>
        </div>
      </div>
      <div className="bd">
        <div className="stack gap-2">
          <span className="small strong">Reason</span>
          <p className="small">
            {r.reason}
            {r.ruleRef && ` ${r.ruleRef}.`}
          </p>
        </div>
        <div className="stack gap-2">
          <span className="small strong">How to resolve</span>
          <ol className="ol small stack gap-1">
            {steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
            <li>{`Marketly reviews it and lifts the restriction if it is resolved. Review date ${date(r.reviewDate)}.`}</li>
          </ol>
        </div>
        <div className="stack gap-2">
          <span className="small strong">Affected activity</span>
          <ul className="sb-ticks no">
            {(r.affectedActivities ?? []).map((a) => (
              <li key={a}>
                <Icon name="circle-x" />
                <span>{ACTIVITY[a] ?? a}</span>
              </li>
            ))}
          </ul>
          {r.affectedSummary && <p className="xs sub">{r.affectedSummary}</p>}
        </div>
        <div className="stack gap-2">
          <span className="small strong">Still works</span>
          <ul className="sb-ticks ok">
            {(r.stillWorks ?? []).map((a) => (
              <li key={a}>
                <Icon name="circle-check" />
                <span>{a}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="card-foot between">
        <span className="row gap-2">
          {appeal ? (
            <Deadline tone="ok">
              Appeal submitted {shortDate(appeal.submittedAt)} · decision by {shortDate(appeal.decideBy.dueAt)}
            </Deadline>
          ) : closed ? (
            <Deadline tone="danger">Appeal window closed {date(deadline)}</Deadline>
          ) : (
            <Deadline tone="warning">Appeal by {appealBy}</Deadline>
          )}
          <span className="xs muted">Appeals go to {r.appealRoute.reviewer}, not the person who applied it.</span>
        </span>
        {mayAct ? (
          <span className="row gap-2">
            <Button variant="secondary" icon="upload" onClick={openUpload}>
              {docsSent ? 'Upload more documents' : 'Upload documents'}
            </Button>
            <Button icon="scale" onClick={openAppeal} disabled={!!appeal || closed}>
              {appeal ? 'Appeal submitted' : 'Appeal restriction'}
            </Button>
          </span>
        ) : (
          <span className="xs muted">The owner or staff with account health access can upload documents or appeal.</span>
        )}
      </div>

      <Dialog
        open={dlg === 'upload'}
        onClose={() => setDlg('')}
        title="Upload documents"
        foot={
          <>
            <Button variant="ghost" onClick={() => setDlg('')}>
              Cancel
            </Button>
            <Button onClick={sendUpload} disabled={evidence.isPending}>
              Submit for review
            </Button>
          </>
        }
      >
        <p className="small sub">
          Restriction <span className="mono">{r.ref}</span>. {r.toResolve}
        </p>
        <Field label="Document type">
          <Select id={`rs-doc-type-${r.id}`} options={DOC_TYPES} value={docType} onChange={(e) => setDocType(e.target.value)} />
        </Field>
        <FileDrop title="Drag documents here or browse" hint="PDF, JPG or PNG, up to 10 MB each" accept="application/pdf,image/jpeg,image/png" onFiles={docs.add} />
        {docs.items.length > 0 && (
          <ul className="stack gap-1">
            {docs.items.map((f) => (
              <li key={f.key} className="row between small">
                <span className="row gap-2">
                  <Icon name="file-text" className="ic-sm" />
                  {f.name}
                  {f.status === 'uploading' && <span className="xs muted">Uploading…</span>}
                  {f.status === 'failed' && <span className="xs muted">{f.error ?? 'Upload failed'}</span>}
                </span>
                <Button variant="ghost" size="sm" icon="trash-2" label={`Remove ${f.name}`} onClick={() => docs.remove(f.key)} />
              </li>
            ))}
          </ul>
        )}
        {(uploadError || docs.error || evidence.isError) && (
          <span className="error-text">
            <Icon name="circle-alert" className="ic-sm" />
            {evidence.isError ? errorMessage(evidence.error) : (uploadError ?? docs.error)}
          </span>
        )}
      </Dialog>

      <Dialog
        open={dlg === 'appeal'}
        onClose={() => setDlg('')}
        title="Appeal restriction"
        foot={
          <>
            <Button variant="ghost" onClick={() => setDlg('')}>
              Cancel
            </Button>
            <Button onClick={sendAppeal} disabled={submitAppeal.isPending}>
              Submit appeal
            </Button>
          </>
        }
      >
        <p className="small sub">
          {r.appealRoute.reviewer}, not the person who applied it, decides. Appeal by {appealBy}.
        </p>
        <Field label="Why should the restriction be lifted?" hint="Say what you changed or why the listings were accurate." error={appealErrors.reason}>
          <Textarea id={`rs-appeal-${r.id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Checkbox id={`rs-confirm-${r.id}`} label="The information in this appeal is accurate" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
        {(appealErrors.confirm || submitAppeal.isError) && (
          <span className="error-text">
            <Icon name="circle-alert" className="ic-sm" />
            {submitAppeal.isError ? errorMessage(submitAppeal.error) : appealErrors.confirm}
          </span>
        )}
      </Dialog>
    </section>
  );
}

export default function Performance() {
  const { api } = useApi();
  const { sellerId } = useSellerSession();
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);

  const account = useQuery({ queryKey: ['sellers', 'account', sellerId], queryFn: () => call(api.GET('/api/seller/sellers/account')) });
  const perf = useQuery({ queryKey: ['sellers', 'performance', sellerId], queryFn: () => call(api.GET('/api/seller/sellers/performance')) as Promise<Summary> });
  const restrictions = useQuery({
    queryKey: ['sellers', 'restrictions', sellerId, 'active'],
    queryFn: () => call(api.GET('/api/seller/sellers/restrictions', { params: { query: { state: 'active', limit: 20 } } })),
  });

  const a = account.data as Account | undefined;
  const p = perf.data;
  const active = (restrictions.data?.items ?? []) as Restriction[];
  const feedback = (p?.feedback ?? null) as { positivePct?: number | null; ratingCount?: number | null } | null;
  const windowDays = p?.metrics[0]?.target.windowDays ?? 30;
  const openWarnings = (p?.warnings ?? []).filter((w) => w.state === 'open');
  const atRisk = [...active.map((r) => r.title.toLowerCase()), ...openWarnings.map((w) => w.title.toLowerCase())];
  const payout = a ? PAYOUT[a.payoutReadiness.state] : undefined;
  const payoutHit = active.some((r) => r.affectedActivities.includes('payout_schedule'));

  return (
    <SellerLayout active="performance">
      <PageHeader
        title="Account health"
        sub={p ? `Measured over the last ${windowDays} days unless stated (${shortDate(p.period.from)} – ${date(p.period.to)}). Updated ${dateTime(p.updatedAt)} PT.` : 'Measured over the last 30 days unless stated. Updated daily at 6:00 AM PT.'}
      />
      {notice && (
        <Alert tone="success" title={notice.title}>
          {notice.body}
        </Alert>
      )}
      {account.isError && <LoadError error={account.error} onRetry={() => void account.refetch()} title="We couldn’t load your account status" />}
      <div className="sb-kpis">
        {!a ? (
          Array.from({ length: 4 }, (_, i) => <div key={i} className="card pad sb-bal sk sk-card" aria-hidden="true" style={{ minHeight: 96 }} />)
        ) : (
          <>
            <div className="card pad sb-bal">
              <div className="stat">
                <span className="k">Account status</span>
                <span className="v">
                  <StatusBadge status={ACCOUNT_STATUS[a.status] ?? a.status} />
                </span>
              </div>
              <span className="why">
                {a.sellerSince ? `Selling since ${date(a.sellerSince)}` : `Since ${date(a.statusSince)}`}
                {a.activeRestrictions.length > 0 && ` · ${plural(a.activeRestrictions.length, 'restriction')}`}
              </span>
            </div>
            <div className="card pad sb-bal">
              <div className="stat">
                <span className="k">Verification</span>
                <span className="v">
                  {a.verification.state === 'verified' ? (
                    <Badge tone="info" icon="shield-check">
                      Verified seller
                    </Badge>
                  ) : (
                    <Badge tone={a.verification.state === 'not_verified' ? '' : 'warning'}>{a.verification.state === 'lapsed' ? 'Verification lapsed' : a.verification.state === 'revoked' ? 'Verification revoked' : 'Not verified'}</Badge>
                  )}
                </span>
              </div>
              <span className="why">{a.verification.lastCheckedAt ? `Business and identity checked ${monthYear(a.verification.lastCheckedAt)}` : (a.verification.reason ?? 'Not checked yet')}</span>
            </div>
            <div className="card pad sb-bal">
              <div className="stat">
                <span className="k">Payouts</span>
                <span className="v">{payout && <StatusBadge status={payout.label} tone={payout.tone} />}</span>
              </div>
              <span className="why">{active.length ? (payoutHit ? 'Affected by a restriction' : 'Not affected by the restriction') : a.payoutReadiness.note}</span>
            </div>
            <div className="card pad sb-bal">
              <div className="stat">
                <span className="k">Seller feedback</span>
                <span className="v">{feedback?.ratingCount ? `${Math.round(feedback.positivePct ?? 0)}%` : '–'}</span>
              </div>
              <span className="why">{feedback?.ratingCount ? `positive · ${plural(feedback.ratingCount, 'rating')}` : perf.isPending ? '' : 'No ratings yet'}</span>
            </div>
          </>
        )}
      </div>

      {restrictions.isError && <LoadError error={restrictions.error} onRetry={() => void restrictions.refetch()} title="We couldn’t load your restrictions" />}
      {active.map((r) => (
        <RestrictionPanel key={r.id} r={r} onNotice={setNotice} />
      ))}

      {openWarnings.map((w) => (
        <Alert key={w.id} tone="warning" title={w.title}>
          {w.detail} · issued {date(w.issuedAt)}
        </Alert>
      ))}

      <div className="sb-main">
        <Card
          flush
          titleAs="h3"
          title="Performance against targets"
          foot={<span className="xs muted grow">Missing targets repeatedly can lead to warnings, restrictions or suspension. We always tell you the reason and how to appeal.</span>}
        >
          {perf.isError ? (
            <div className="pad">
              <LoadError error={perf.error} onRetry={() => void perf.refetch()} />
            </div>
          ) : !p ? (
            <SkeletonLines rows={5} />
          ) : !p.metrics.length ? (
            <p className="small sub pad">No metrics yet. They appear after your first orders.</p>
          ) : (
            <>
              <TableWrap label="Performance against targets table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Metric</th>
                      <th className="r" scope="col">
                        Yours
                      </th>
                      <th scope="col">Target</th>
                      <th scope="col">Status</th>
                      <th className="col-pin" scope="col">
                        Details
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.metrics.map((m) => {
                      const s = STATUS[m.status];
                      return (
                        <tr key={m.key} className={cx(s.row)}>
                          <td>
                            {s.sr && <span className="sr-only">{s.sr}</span>}
                            <span className="small strong nowrap" title={m.definition}>
                              {m.label}
                            </span>
                          </td>
                          <td className="r">
                            <span className="num strong">{m.display}</span>
                          </td>
                          <td>
                            <MetricTarget m={m} windowDays={windowDays} />
                          </td>
                          <td>
                            <StatusBadge status={s.label} tone={s.tone} />
                          </td>
                          <td className="col-pin">
                            <span className="xs sub minw-200 inline-block">{m.detail}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
              <p className="status-legend status-legend--edge">
                <span className="sr-only">Legend: </span>
                <span className="sl sl-danger">
                  <i aria-hidden="true" />
                  Red edge = urgent: overdue or past target
                </span>
                <span className="sl sl-warning">
                  <i aria-hidden="true" />
                  Amber edge = at risk: due soon or near target
                </span>
              </p>
            </>
          )}
        </Card>
        <Card titleAs="h3" title="Warnings and actions" sub="Last 12 months">
          {perf.isError ? (
            <p className="small sub">Not available right now.</p>
          ) : !p ? (
            <SkeletonLines rows={4} />
          ) : !p.history.length ? (
            <p className="small sub">No warnings or actions in the last 12 months.</p>
          ) : (
            <ol className="timeline">
              {p.history.map((e, i) => {
                const warn = atRisk.some((t) => e.label.toLowerCase().includes(t));
                return (
                  <li key={`${e.at}-${i}`} className={cx('ev', warn ? 'is-warn' : 'is-done')}>
                    {warn && <span className="sr-only">At risk: </span>}
                    <span className="dot" aria-hidden="true" />
                    <div className="stack gap-1">
                      <span className="t">{e.label.charAt(0).toUpperCase() + e.label.slice(1)}</span>
                      <span className="d">
                        {date(e.at)}
                        {e.detail && ` · ${e.detail}`}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>
      </div>
    </SellerLayout>
  );
}
