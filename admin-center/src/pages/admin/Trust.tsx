import { useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Card, Deadline, Dialog, EmptyState, Field, Icon, PageHeader, Pager, Select, Stat, StatusBadge, TableWrap, Tabs, Textarea, announce } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, deadlineTone, shortDate } from '@/app/parts';
import {
  APPEAL_STATUS, DISMISS_REASONS, REPORT_TYPES, STATUS_LABEL, TRUST_KPIS, evidenceTone, isTabType, linkedRecords, reportMeta, reporterOutcomeFor, typeOf,
  type EvidenceTone, type ReportRow, type ReportType, type TrustAppeal, type TrustReportDetail,
} from './data/trust';
import { AppealActions } from './TrustAppealActions';
import { OwnerRecommendations, RecommendationItem, useOwnerRecommendations, type Done } from './TrustRecommendations';

// Design: pages/admin/admin-trust.html (single view). Tabs filter the report list; "Dismiss with
// reason" opens a dialog that needs a reason before the report leaves the queue. "Open report" and the
// report ID open the report detail (admin/trust-report).
// Data: GET /api/admin/trust/overview (KPIs), /reports?status=active (queue, highest risk first, a page at a time,
// filtered by type on the server), /reports/{id} for each card's evidence and routed recommendations, /appeals;
// POST /reports/{id}/dismiss, /reports/exports. Decisions (review §2a #7): the "Recommendations" tab lists what
// Trust routed to the caller's teams (GET /recommendations) to accept or decline; recommendation rows on the cards
// can be decided, sent or withdrawn in place; appeals get a reviewer and a decision (TrustAppealActions).
// Owner teams (Catalog, Seller Manager, Support, Finance…) usually lack trust.reports.view: they land on the
// Recommendations tab and the report queue is not fetched for them.

type TabKey = 'all' | ReportType | 'appeals' | 'recommendations';

const PAGE_SIZE = 20;

const EVIDENCE: Record<EvidenceTone, { icon: 'circle-x' | 'triangle-alert' | 'info' | 'circle-check'; sr?: string }> = {
  fail: { icon: 'circle-x', sr: 'Failed: ' },
  warn: { icon: 'triangle-alert', sr: 'Warning: ' },
  info: { icon: 'info' },
  ok: { icon: 'circle-check', sr: 'Passed: ' },
};

function ReportCard({ r, detail, first, onDismiss, onDone }: { r: ReportRow; detail?: TrustReportDetail; first: boolean; onDismiss?: () => void; onDone: (d: Done) => void }) {
  const H = first ? 'h2' : 'h3';
  const type = typeOf(r.type);
  const level = r.riskLevel === 'high' ? 'high' : 'med';
  const links = linkedRecords(detail?.subjects ?? r.subjects, detail?.linkedCaseRefs ?? []);
  return (
    <section className="card ab-report">
      <div className="top">
        <span className={`ab-risk t-${level}`} aria-label={`Risk score ${r.riskScore} of 100`}>
          {r.riskScore}
          <small>{r.riskLevel === 'high' ? 'High' : r.riskLevel === 'medium' ? 'Medium' : 'Low'}</small>
        </span>
        <div className="grow stack gap-1">
          <span className="row gap-2">
            <Link className="mono small" to={href('admin/trust-report', '', { ref: r.ref })}>
              {r.ref}
            </Link>
            <Badge icon={type.icon}>{type.label}</Badge>
            <StatusBadge status={STATUS_LABEL[r.status] ?? r.status} />
          </span>
          <H className="h4">{r.title}</H>
          <span className="xs muted">{reportMeta(r, shortDate)}</span>
        </div>
        <div className="row gap-2">
          {onDismiss && (
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              Dismiss with reason
            </Button>
          )}
          <Button variant="secondary" size="sm" to={href('admin/trust-report', '', { ref: r.ref })} srLabel={r.ref}>
            Open report
          </Button>
        </div>
      </div>
      <div className="body">
        <div className="stack gap-3">
          <span className="small strong">Evidence</span>
          {detail ? (
            detail.evidence.length ? (
              <ul className="ab-checks">
                {detail.evidence.map((e) => {
                  const t = evidenceTone(e);
                  return (
                    <li key={e.id} className={`t-${t}`}>
                      {EVIDENCE[t].sr && <span className="sr-only">{EVIDENCE[t].sr}</span>}
                      <Icon name={EVIDENCE[t].icon} className="ic-sm" />
                      <span className="stack gap-0">
                        <span>{e.text}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <span className="xs muted">No evidence recorded yet.</span>
            )
          ) : (
            <SkeletonLines rows={2} />
          )}
          <span className="small strong">Linked records</span>
          <div className="ab-links">
            {links.map((l, i) => (
              <Link key={`${i}-${l.label}`} className="ab-link" to={l.to}>
                <Icon name={l.icon} />
                {l.label}
              </Link>
            ))}
          </div>
        </div>
        <div className="stack gap-3">
          <span className="small strong">Recommended actions · routed to the owning team</span>
          {detail ? (
            detail.recommendations.length ? (
              <ul className="ab-route">
                {detail.recommendations.map((a) => (
                  <RecommendationItem key={a.id} r={a} onDone={onDone} />
                ))}
              </ul>
            ) : (
              <span className="xs muted">No actions recommended yet. Open the report to recommend one.</span>
            )
          ) : (
            <SkeletonLines rows={2} />
          )}
        </div>
      </div>
    </section>
  );
}

function AppealsCard({ appeals, H, onDone }: { appeals: TrustAppeal[]; H: 'h2' | 'h3'; onDone: (d: Done) => void }) {
  return (
    <section className="card">
      <div className="card-head">
        <div className="stack gap-0">
          <H className="h4">Appeals</H>
          <span className="xs muted">Reviewed by someone other than the person who decided</span>
        </div>
      </div>
      {appeals.length ? (
        <TableWrap label="Appeals table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Appeal</th>
                <th scope="col">Filed by</th>
                <th scope="col">Decision appealed</th>
                <th scope="col">Filed</th>
                <th scope="col">Reviewer</th>
                <th scope="col">Decide by</th>
                <th scope="col">Status</th>
                <th className="col-pin" scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {appeals.map((a) => {
                const decided = !!a.decision;
                const decidedAt = (a.decision as { decidedAt?: string } | null)?.decidedAt;
                return (
                  <tr key={a.id}>
                    <td>
                      {a.reportRef ? (
                        <Link className="mono nowrap" to={href('admin/trust-report', '', { ref: a.reportRef })} title={a.ref}>
                          {a.ref}
                        </Link>
                      ) : (
                        <span className="mono nowrap">{a.ref}</span>
                      )}
                    </td>
                    <td>{a.appellantName}</td>
                    <td>
                      {a.decisionAppealed}
                      {a.reportRef ? ` (${a.reportRef})` : ''}
                    </td>
                    <td>{shortDate(a.filedAt)}</td>
                    <td>
                      {a.reviewer ? (
                        <span className="row nowrap gap-2">
                          <Avatar name={a.reviewer.name} className="ab-av-sm" />
                          <span className="ab-cell">
                            <span className="strong">{a.reviewer.name}</span>
                            <span className="xs muted">{a.reviewer.role ?? ''}</span>
                          </span>
                        </span>
                      ) : (
                        <span className="xs muted">Not assigned</span>
                      )}
                    </td>
                    <td>{decided ? <span className="xs muted">{decidedAt ? `Decided ${shortDate(decidedAt)}` : 'Decided'}</span> : <Deadline tone={deadlineTone(a.decideBy.state)}>{shortDate(a.decideBy.dueAt)}</Deadline>}</td>
                    <td>
                      <StatusBadge status={APPEAL_STATUS[a.state] ?? a.state} />
                    </td>
                    <td className="col-pin">
                      <AppealActions a={a} onDone={onDone} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      ) : (
        <div className="card-body">
          <EmptyState icon="scale" title="No appeals" as="h3">
            Appeals against trust actions appear here, with the reviewer and the date to decide by.
          </EmptyState>
        </div>
      )}
      <div className="card-foot">
        <span className="ab-note grow">Restrictions keep valid order history, returns and access to help for everyone involved.</span>
      </div>
    </section>
  );
}

export default function Trust() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const canView = can('trust.reports.view');
  const canDecide = can('trust.reports.decide');
  const canExport = can('trust.reports.export');
  const canOwner = can('trust.recommendations.decide');

  // Owner teams without the trust queue start on their recommendations.
  const [tab, setTabState] = useState<TabKey>(!canView && canOwner ? 'recommendations' : 'all');
  const [page, setPage] = useState(1);
  const setTab = (t: TabKey) => {
    setTabState(t);
    setPage(1);
  };
  const [dismissing, setDismissing] = useState<ReportRow | null>(null);
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<Done | null>(null);

  const reportTab = isTabType(tab) || tab === 'all';
  const overview = useQuery({ queryKey: ['trust', 'overview'], enabled: canView, queryFn: () => call(api.GET('/api/admin/trust/overview')) });
  // A12: the server filters to active reports (open, under review, escalated) and by type, a page at a time, so
  // closed reports never take the slots of open ones.
  const reports = useQuery({
    queryKey: ['trust', 'reports', 'queue', isTabType(tab) ? tab : 'all', page],
    enabled: canView && reportTab,
    queryFn: () => call(api.GET('/api/admin/trust/reports', { params: { query: { status: 'active', ...(isTabType(tab) ? { type: tab } : {}), sort: 'risk', page, limit: PAGE_SIZE } } })),
  });
  const appeals = useQuery({ queryKey: ['trust', 'appeals'], enabled: canView, queryFn: () => call(api.GET('/api/admin/trust/appeals', { params: { query: { limit: 50 } } })) });
  // Shares its cache with the Recommendations view's first page, so the tab count and the list agree.
  const ownerRecs = useOwnerRecommendations('sent_to_owner', 1, canOwner);

  const rows = reports.data?.items ?? [];
  const totalPages = reports.data?.totalPages ?? 1;
  const visible = reportTab ? rows : [];
  const details$ = useQueries({
    queries: visible.map((r) => ({ queryKey: ['trust', 'report', r.id], queryFn: () => call(api.GET('/api/admin/trust/reports/{id}', { params: { path: { id: r.id } } })) })),
  });

  const ov = overview.data;
  const appealRows = appeals.data?.items ?? [];
  const openAppeals = ov?.appealsWaiting ?? appealRows.filter((a) => a.state === 'open' || a.state === 'under_review').length;
  const countOf = (k: TabKey): number =>
    k === 'all' ? (ov?.open ?? 0) : k === 'appeals' ? openAppeals : k === 'recommendations' ? (ownerRecs.data?.total ?? ownerRecs.data?.items.length ?? 0) : (ov?.byType?.[k] ?? 0);
  const noteOf = (k: (typeof TRUST_KPIS)[number]) => {
    if (!ov) return k.note;
    if (k.source === 'all') return `${ov.highRisk} high risk`;
    if (k.source === 'appeals') return ov.nextAppealDecideBy ? `Decide by ${shortDate(ov.nextAppealDecideBy)}` : 'None waiting';
    return ov.typeNotes?.[k.source] ?? k.note;
  };

  const tabs: Array<{ label: string; value: TabKey; count: number }> = [
    ...(canView
      ? [
          { label: 'All open', value: 'all' as TabKey, count: countOf('all') },
          ...(Object.keys(REPORT_TYPES) as ReportType[]).map((k) => ({ label: REPORT_TYPES[k].label, value: k as TabKey, count: countOf(k) })),
          { label: 'Appeals', value: 'appeals' as TabKey, count: countOf('appeals') },
        ]
      : []),
    ...(canOwner ? [{ label: 'Recommendations', value: 'recommendations' as TabKey, count: countOf('recommendations') }] : []),
  ];
  const showAppeals = canView && (tab === 'all' || tab === 'appeals');

  const dismissM = useMutation({
    mutationFn: (v: { r: ReportRow; reason: string; details: string }) =>
      call(api.POST('/api/admin/trust/reports/{id}/dismiss', { params: { path: { id: v.r.id } }, body: { reason: `${v.reason}. ${v.details.trim()}`, reporterOutcome: reporterOutcomeFor(v.reason) } })),
    onSuccess: (_d, v) => {
      setNotice({ title: 'Report dismissed', text: `${v.r.ref} dismissed: ${v.reason}. The reporter is told the outcome and the reason is in Action history.` });
      announce(`${v.r.ref} dismissed`);
      setDismissing(null);
      void qc.invalidateQueries({ queryKey: ['trust'] });
      void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
      void qc.invalidateQueries({ queryKey: ['notifications', 'summary', 'staff'] });
    },
  });

  const exportM = useMutation({
    mutationFn: () => call(api.POST('/api/admin/trust/reports/exports', { body: { filters: { status: ['open', 'under_review', 'escalated'], ...(isTabType(tab) ? { type: tab } : {}) }, format: 'csv' } })),
    onSuccess: () => setNotice({ title: 'Export started', text: 'The trust queue export is being prepared. You can download it from Reports when it is ready.' }),
  });

  const openDismiss = (r: ReportRow) => {
    setDismissing(r);
    setReason('');
    setDetails('');
    setAttempted(false);
    dismissM.reset();
  };
  const close = () => setDismissing(null);
  const errors = attempted ? { reason: reason ? undefined : 'Choose why you are dismissing this report.', details: details.trim() ? undefined : 'Add details for the record.' } : {};
  const dismiss = () => {
    setAttempted(true);
    if (!dismissing || !reason || !details.trim()) return;
    dismissM.mutate({ r: dismissing, reason, details });
  };

  const H = visible.length ? 'h3' : 'h2';
  const queueOwner = ov?.queueOwner;

  return (
    <AdminLayout active="trust">
      <PageHeader
        crumbs={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Customers and service' }]}
        title="Trust and risk"
        sub={`${queueOwner ? `Queue owner ${queueOwner.name}${queueOwner.role ? `, ${queueOwner.role}` : ''} · ` : ''}Trust recommends; Catalog, Seller Manager, Support and Finance act`}
        actions={
          canExport ? (
            <Button variant="secondary" size="sm" icon="download" onClick={() => exportM.mutate()} disabled={exportM.isPending}>
              Export
            </Button>
          ) : undefined
        }
      />
      {canView && (
        <div className="ab-kpis k6">
          {TRUST_KPIS.map((k) => (
            <div key={k.label} className="card pad">
              {ov ? <Stat icon={k.icon} label={k.label} value={countOf(k.source)} note={noteOf(k)} /> : <SkeletonLines rows={1} />}
            </div>
          ))}
        </div>
      )}
      {overview.isError && <LoadError error={overview.error} onRetry={() => void overview.refetch()} />}
      {exportM.isError && (
        <Alert tone="danger" title="The export didn’t start">
          {errorMessage(exportM.error)}
        </Alert>
      )}
      {notice && (
        <Alert tone="success" title={notice.title}>
          {notice.text}
        </Alert>
      )}
      {canView && !canDecide && <p className="ab-note">You can view reports. Dismissing and deciding need the Trust and Risk decide permission.</p>}
      {!canView && !canOwner && <p className="ab-note">Your role can’t see the trust queue or decide recommendations.</p>}
      {tabs.length > 0 && <Tabs items={tabs} active={tab} onChange={setTab} />}

      {tab === 'recommendations' && canOwner && <OwnerRecommendations onDone={setNotice} />}

      {canView && reportTab && reports.isPending && (
        <Card pad>
          <SkeletonLines rows={4} />
        </Card>
      )}
      {reportTab && reports.isError && <LoadError error={reports.error} onRetry={() => void reports.refetch()} />}

      {visible.map((r, i) => (
        <ReportCard key={r.id} r={r} detail={details$[i]?.data} first={i === 0} onDismiss={canDecide ? () => openDismiss(r) : undefined} onDone={setNotice} />
      ))}
      {reportTab && totalPages > 1 && <Pager page={page} total={totalPages} onPage={setPage} />}
      {reportTab && reports.isSuccess && visible.length === 0 && (
        <Card pad>
          <EmptyState icon="shield-check" title="No open reports here" as="h2">
            {isTabType(tab) ? `New ${REPORT_TYPES[tab].label.toLowerCase()} reports appear here as soon as they are filed or detected.` : 'New reports appear here as soon as they are filed or detected.'}
          </EmptyState>
        </Card>
      )}

      {showAppeals &&
        (appeals.isPending ? (
          <Card pad>
            <SkeletonLines rows={3} />
          </Card>
        ) : appeals.isError ? (
          <LoadError error={appeals.error} onRetry={() => void appeals.refetch()} title="We couldn’t load the appeals" />
        ) : (
          <AppealsCard appeals={appealRows} H={H} onDone={setNotice} />
        ))}

      <Dialog
        open={dismissing !== null}
        onClose={close}
        title={dismissing ? `Dismiss ${dismissing.ref}` : ''}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" onClick={dismiss} disabled={dismissM.isPending}>
              Dismiss report
            </Button>
          </>
        }
      >
        <p className="small sub">{dismissing?.title}</p>
        {dismissM.isError && (
          <Alert tone="danger" title="The report wasn’t dismissed">
            {errorMessage(dismissM.error)}
          </Alert>
        )}
        <Field label="Reason" error={errors.reason}>
          <Select id="tr-reason" options={[{ value: '', label: 'Select a reason' }, ...DISMISS_REASONS.map((r) => ({ value: r, label: r }))]} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="Details for the record" error={errors.details}>
          <Textarea id="tr-detail" placeholder="What you checked and why no action is needed" value={details} onChange={(e) => setDetails(e.target.value)} />
        </Field>
        <Alert tone="info" title="Completed actions stay in place">
          Dismissing closes the report. Actions the owning teams already took keep their own records and can be reversed from their pages.
        </Alert>
      </Dialog>
    </AdminLayout>
  );
}
