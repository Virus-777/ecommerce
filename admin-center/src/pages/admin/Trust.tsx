import { useState } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Button, Card, Deadline, Dialog, EmptyState, Field, Icon, PageHeader, Select, Stat, StatusBadge, TableWrap, Tabs, Textarea, announce } from '@marketly/web-shared/ui';
import { ACTION_TONE, APPEALS, DISMISS_REASONS, REPORT_TYPES, REPORTS, TRUST_KPIS, type Evidence, type ReportType, type TrustReport } from './data/trust';

// Design: pages/admin/admin-trust.html (single view). Tabs filter the report list; "Dismiss with
// reason" opens a dialog that needs a reason before the report leaves the queue.

type TabKey = 'all' | ReportType | 'appeals';

const EVIDENCE: Record<Evidence['tone'], { icon: 'circle-x' | 'triangle-alert' | 'info' | 'circle-check'; sr?: string }> = {
  fail: { icon: 'circle-x', sr: 'Failed: ' },
  warn: { icon: 'triangle-alert', sr: 'Warning: ' },
  info: { icon: 'info' },
  ok: { icon: 'circle-check', sr: 'Passed: ' },
};

function ReportCard({ r, first, onDismiss }: { r: TrustReport; first: boolean; onDismiss: () => void }) {
  const H = first ? 'h2' : 'h3';
  const type = REPORT_TYPES[r.type];
  return (
    <section className="card ab-report">
      <div className="top">
        <span className={`ab-risk t-${r.level}`} aria-label={`Risk score ${r.score} of 100`}>
          {r.score}
          <small>{r.level === 'high' ? 'High' : 'Medium'}</small>
        </span>
        <div className="grow stack gap-1">
          <span className="row gap-2">
            <span className="mono small">{r.id}</span>
            <Badge icon={type.icon}>{type.label}</Badge>
            <StatusBadge status={r.status} />
          </span>
          <H className="h4">{r.title}</H>
          <span className="xs muted">{r.meta}</span>
        </div>
        <div className="row gap-2">
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss with reason
          </Button>
          <Button variant="secondary" size="sm">
            Open report
          </Button>
        </div>
      </div>
      <div className="body">
        <div className="stack gap-3">
          <span className="small strong">Evidence</span>
          <ul className="ab-checks">
            {r.evidence.map((e) => (
              <li key={e.text} className={`t-${e.tone}`}>
                {EVIDENCE[e.tone].sr && <span className="sr-only">{EVIDENCE[e.tone].sr}</span>}
                <Icon name={EVIDENCE[e.tone].icon} className="ic-sm" />
                <span className="stack gap-0">
                  <span>{e.text}</span>
                </span>
              </li>
            ))}
          </ul>
          <span className="small strong">Linked records</span>
          <div className="ab-links">
            {r.links.map((l) => (
              <Link key={l.label} className="ab-link" to={href(l.to)}>
                <Icon name={l.icon} />
                {l.label}
              </Link>
            ))}
          </div>
        </div>
        <div className="stack gap-3">
          <span className="small strong">Recommended actions · routed to the owning team</span>
          <ul className="ab-route">
            {r.actions.map((a) => (
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
        </div>
      </div>
    </section>
  );
}

export default function Trust() {
  const [tab, setTab] = useState<TabKey>('all');
  const [reports, setReports] = useState(REPORTS);
  const [dismissing, setDismissing] = useState<TrustReport | null>(null);
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const openAppeals = APPEALS.filter((a) => a.status !== 'Resolved').length;
  const countOf = (k: TabKey) => (k === 'all' ? reports.length : k === 'appeals' ? openAppeals : reports.filter((r) => r.type === k).length);

  const tabs: Array<{ label: string; value: TabKey; count: number }> = [
    { label: 'All open', value: 'all', count: countOf('all') },
    ...(Object.keys(REPORT_TYPES) as ReportType[]).map((k) => ({ label: REPORT_TYPES[k].label, value: k, count: countOf(k) })),
    { label: 'Appeals', value: 'appeals', count: countOf('appeals') },
  ];

  const visible = tab === 'appeals' ? [] : reports.filter((r) => tab === 'all' || r.type === tab);
  const showAppeals = tab === 'all' || tab === 'appeals';

  const openDismiss = (r: TrustReport) => {
    setDismissing(r);
    setReason('');
    setDetails('');
    setAttempted(false);
  };
  const close = () => setDismissing(null);
  const errors = attempted ? { reason: reason ? undefined : 'Choose why you are dismissing this report.', details: details.trim() ? undefined : 'Add details for the record.' } : {};
  const dismiss = () => {
    setAttempted(true);
    if (!dismissing || !reason || !details.trim()) return;
    setReports((l) => l.filter((r) => r.id !== dismissing.id));
    setNotice(`${dismissing.id} dismissed: ${reason}. The reporter is told the outcome and the reason is in Action history.`);
    announce(`${dismissing.id} dismissed`);
    close();
  };

  const H = visible.length ? 'h3' : 'h2';

  return (
    <AdminLayout active="trust">
      <PageHeader
        crumbs={[{ label: 'Admin', to: href('admin/dashboard') }, { label: 'Customers and service' }]}
        title="Trust and risk"
        sub="Queue owner Sven Larsen, Trust and Risk Manager · Trust recommends; Catalog, Seller Manager, Support and Finance act"
        actions={
          <Button variant="secondary" size="sm" icon="download">
            Export
          </Button>
        }
      />
      <div className="ab-kpis k6">
        {TRUST_KPIS.map((k) => (
          <div key={k.label} className="card pad">
            <Stat icon={k.icon} label={k.label} value={countOf(k.source)} note={k.note} />
          </div>
        ))}
      </div>
      {notice && (
        <Alert tone="success" title="Report dismissed">
          {notice}
        </Alert>
      )}
      <Tabs items={tabs} active={tab} onChange={setTab} />

      {visible.map((r, i) => (
        <ReportCard key={r.id} r={r} first={i === 0} onDismiss={() => openDismiss(r)} />
      ))}
      {tab !== 'all' && tab !== 'appeals' && visible.length === 0 && (
        <Card pad>
          <EmptyState icon="shield-check" title="No open reports here" as="h2">
            New {REPORT_TYPES[tab].label.toLowerCase()} reports appear here as soon as they are filed or detected.
          </EmptyState>
        </Card>
      )}

      {showAppeals && (
        <section className="card">
          <div className="card-head">
            <div className="stack gap-0">
              <H className="h4">Appeals</H>
              <span className="xs muted">Reviewed by someone other than the person who decided</span>
            </div>
          </div>
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
                </tr>
              </thead>
              <tbody>
                {APPEALS.map((a) => (
                  <tr key={a.ref}>
                    <td>
                      <a className="mono nowrap" href="#" title={a.ref}>
                        {a.ref}
                      </a>
                    </td>
                    <td>{a.filedBy}</td>
                    <td>{a.decision}</td>
                    <td>{a.filed}</td>
                    <td>
                      <span className="row nowrap gap-2">
                        <Avatar name={a.reviewer.name} className="ab-av-sm" />
                        <span className="ab-cell">
                          <span className="strong">{a.reviewer.name}</span>
                          <span className="xs muted">{a.reviewer.role}</span>
                        </span>
                      </span>
                    </td>
                    <td>{'date' in a.decideBy ? <Deadline tone="ok">{a.decideBy.date}</Deadline> : <span className="xs muted">{a.decideBy.decided}</span>}</td>
                    <td>
                      <StatusBadge status={a.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <div className="card-foot">
            <span className="ab-note grow">Restrictions keep valid order history, returns and access to help for everyone involved.</span>
          </div>
        </section>
      )}

      <Dialog
        open={dismissing !== null}
        onClose={close}
        title={dismissing ? `Dismiss ${dismissing.id}` : ''}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" onClick={dismiss}>
              Dismiss report
            </Button>
          </>
        }
      >
        <p className="small sub">{dismissing?.title}</p>
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
