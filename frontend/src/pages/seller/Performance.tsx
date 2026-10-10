import { useState, type ReactNode } from 'react';
import { SellerLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { Alert, announce, Badge, Button, Card, Checkbox, Deadline, Dialog, Field, FileDrop, Icon, PageHeader, Select, StatusBadge, TableWrap, Textarea, type Tone } from '@/ui';

// Design: pages/seller/seller-performance.html (no views). "Upload documents" and "Appeal
// restriction" open local dialogs; submitting updates the restriction status and the timeline.

interface Target {
  metric: string;
  yours: string;
  target: string;
  status: 'Meets target' | 'At risk' | 'Action needed';
  details: ReactNode;
}

const STATUS: Record<Target['status'], { tone: Tone; row?: string; sr?: string }> = {
  'Meets target': { tone: 'success' },
  'At risk': { tone: 'warning', row: 'is-warn', sr: 'At risk: ' },
  'Action needed': { tone: 'danger', row: 'is-flagged', sr: 'Urgent: ' },
};

const TARGETS: Target[] = [
  { metric: 'Dispatch reliability', yours: '96.4%', target: 'At least 95%', status: 'Meets target', details: 'Last 30 days · 362 of 376 orders on time' },
  { metric: 'Cancellation rate', yours: '0.8%', target: 'At most 2.5%', status: 'Meets target', details: '3 seller cancellations in 376 orders' },
  { metric: 'Return rate', yours: '4.7%', target: 'At most 8% for Electronics', status: 'Meets target', details: '18 returns in 380 units' },
  {
    metric: 'Unresolved cases',
    yours: '1',
    target: '0 past their deadline',
    status: 'At risk',
    details: (
      <>
        <span className="mono nowrap" title="RT-261004-0871">
          RT-261004-0871
        </span>{' '}
        response overdue 6 h
      </>
    ),
  },
  { metric: 'Policy violations', yours: '1', target: '0 in 90 days', status: 'Action needed', details: 'Brand claim without documents · Oct 2' },
];

interface HistoryEvent {
  t: string;
  d: string;
  state: 'warn' | 'done' | 'current';
}

const HISTORY: HistoryEvent[] = [
  { t: 'Restriction: new Cameras listings paused', d: 'Oct 2, 2026 · open · appeal by Oct 16', state: 'warn' },
  { t: 'Warning: 3 late dispatches in one week', d: 'Sep 18, 2026 · resolved Sep 25 after 7 days on time', state: 'done' },
  { t: 'Warning: listing photo with another store’s watermark', d: 'Aug 30, 2026 · resolved same day, photo replaced', state: 'done' },
  { t: 'Account approved', d: 'Jul 14, 2026', state: 'done' },
];

const AFFECTED = ['Creating new offers in Cameras', 'Reactivating the 2 hidden Vantor listings'];
const STILL_WORKS = ['Existing orders, dispatch and shipping', 'Returns, refunds and cases', 'Customer messages and questions', 'Payouts and statements', 'All listings in other categories'];
const DOC_TYPES = ['Invoice from Vantor or an approved distributor', 'Authorization letter from Vantor', 'Other proof of authorization'];

type Dlg = '' | 'upload' | 'appeal';

export default function Performance() {
  const [dlg, setDlg] = useState<Dlg>('');
  const [history, setHistory] = useState(HISTORY);
  const [docsSent, setDocsSent] = useState(false);
  const [appealed, setAppealed] = useState(false);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);

  // Upload form
  const [docType, setDocType] = useState(DOC_TYPES[0]);
  const [files, setFiles] = useState<File[]>([]);
  const [uploadTried, setUploadTried] = useState(false);
  const uploadError = uploadTried && !files.length ? 'Add at least one document (PDF, JPG or PNG).' : undefined;

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

  const status = appealed ? 'Appealed' : docsSent ? 'In review' : 'Restricted';
  const addEvent = (e: HistoryEvent) => setHistory((h) => [e, ...h]);

  const openUpload = () => {
    setFiles([]);
    setUploadTried(false);
    setDlg('upload');
  };
  const openAppeal = () => {
    setReason('');
    setConfirm(false);
    setAppealTried(false);
    setDlg('appeal');
  };
  const submitUpload = () => {
    setUploadTried(true);
    if (!files.length) return;
    setDocsSent(true);
    addEvent({ t: `Documents submitted: ${files.length} file${files.length > 1 ? 's' : ''}`, d: 'Oct 8, 2026 · Marketly reviews within 3 business days (example)', state: 'current' });
    setNotice({ title: 'Documents submitted', body: 'Marketly reviews them within 3 business days (example) and lifts the pause if the brand claim is supported.' });
    setDlg('');
    announce('Documents submitted for review');
  };
  const submitAppeal = () => {
    setAppealTried(true);
    if (reason.trim().length < 30 || !confirm) return;
    setAppealed(true);
    addEvent({ t: 'Appeal submitted', d: 'Oct 8, 2026 · reviewed by a second Seller Manager', state: 'current' });
    setNotice({ title: 'Appeal submitted', body: 'A second Seller Manager reviewer, not the person who applied the restriction, decides. We email you the decision.' });
    setDlg('');
    announce('Appeal submitted');
  };

  return (
    <SellerLayout active="performance">
      <PageHeader title="Account health" sub="Measured over the last 30 days unless stated. Updated daily at 6:00 AM PT." />
      {notice && (
        <Alert tone="success" title={notice.title}>
          {notice.body}
        </Alert>
      )}
      <div className="sb-kpis">
        <div className="card pad sb-bal">
          <div className="stat">
            <span className="k">Account status</span>
            <span className="v">
              <StatusBadge status="Approved" />
            </span>
          </div>
          <span className="why">Selling since Jul 14, 2026 · 1 category restriction</span>
        </div>
        <div className="card pad sb-bal">
          <div className="stat">
            <span className="k">Verification</span>
            <span className="v">
              <Badge tone="info" icon="shield-check">
                Verified seller
              </Badge>
            </span>
          </div>
          <span className="why">Business and identity checked Jul 2026</span>
        </div>
        <div className="card pad sb-bal">
          <div className="stat">
            <span className="k">Payouts</span>
            <span className="v">
              <StatusBadge status="Active" />
            </span>
          </div>
          <span className="why">Not affected by the restriction</span>
        </div>
        <div className="card pad sb-bal">
          <div className="stat">
            <span className="k">Seller feedback</span>
            <span className="v">98%</span>
          </div>
          <span className="why">positive · 4,812 ratings</span>
        </div>
      </div>

      <section className="sb-restrict" aria-labelledby="sb-r-title">
        <div className="hd">
          <Icon name="ban" />
          <div className="stack gap-1 grow">
            <span className="row gap-2">
              <h2 className="h3" id="sb-r-title">
                New listings in Cameras paused
              </h2>
              <StatusBadge status={status} />
            </span>
            <span className="small sub">
              Since Fri, Oct 2, 2026 · applied by Grace Kim, Seller Manager · reference <span className="mono">RS-261002-0019</span>
            </span>
          </div>
        </div>
        <div className="bd">
          <div className="stack gap-2">
            <span className="small strong">Reason</span>
            <p className="small">
              Two Vantor V4 Action Camera listings said “authorized Vantor dealer” and used Vantor campaign photos without documents that show you are authorized. Seller rules section 4.2, brand claims.
            </p>
          </div>
          <div className="stack gap-2">
            <span className="small strong">How to resolve</span>
            <ol className="ol small stack gap-1">
              <li>Upload an invoice or authorization letter from Vantor or an approved distributor, dated within 12 months.</li>
              <li>Or remove the authorized-dealer claim and replace the photos with your own.</li>
              <li>Marketly reviews within 3 business days (example) and lifts the pause if it is resolved.</li>
            </ol>
          </div>
          <div className="stack gap-2">
            <span className="small strong">Affected activity</span>
            <ul className="sb-ticks no">
              {AFFECTED.map((a) => (
                <li key={a}>
                  <Icon name="circle-x" />
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="stack gap-2">
            <span className="small strong">Still works</span>
            <ul className="sb-ticks ok">
              {STILL_WORKS.map((a) => (
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
            {appealed ? <Deadline tone="ok">Appeal submitted Oct 8 · decision within 3 business days (example)</Deadline> : <Deadline tone="warning">Appeal by Fri, Oct 16, 11:59 PM PT</Deadline>}
            <span className="xs muted">Appeals go to a second Seller Manager reviewer, not the person who applied it.</span>
          </span>
          <span className="row gap-2">
            <Button variant="secondary" icon="upload" onClick={openUpload}>
              {docsSent ? 'Upload more documents' : 'Upload documents'}
            </Button>
            <Button icon="scale" onClick={openAppeal} disabled={appealed}>
              {appealed ? 'Appeal submitted' : 'Appeal restriction'}
            </Button>
          </span>
        </div>
      </section>

      <div className="sb-main">
        <Card
          flush
          titleAs="h3"
          title="Performance against targets"
          foot={<span className="xs muted grow">Missing targets repeatedly can lead to warnings, restrictions or suspension. We always tell you the reason and how to appeal.</span>}
        >
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
                {TARGETS.map((t) => {
                  const s = STATUS[t.status];
                  return (
                    <tr key={t.metric} className={cx(s.row)}>
                      <td>
                        {s.sr && <span className="sr-only">{s.sr}</span>}
                        <span className="small strong nowrap">{t.metric}</span>
                      </td>
                      <td className="r">
                        <span className="num strong">{t.yours}</span>
                      </td>
                      <td>
                        <span className="small nowrap">{t.target}</span>
                      </td>
                      <td>
                        <StatusBadge status={t.status} tone={s.tone} />
                      </td>
                      <td className="col-pin">
                        <span className="xs sub minw-200 inline-block">{t.details}</span>
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
        </Card>
        <Card titleAs="h3" title="Warnings and actions" sub="Last 12 months">
          <ol className="timeline">
            {history.map((e, i) => (
              <li key={`${e.t}-${i}`} className={cx('ev', `is-${e.state}`)}>
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

      <Dialog
        open={dlg === 'upload'}
        onClose={() => setDlg('')}
        title="Upload documents"
        foot={
          <>
            <Button variant="ghost" onClick={() => setDlg('')}>
              Cancel
            </Button>
            <Button onClick={submitUpload}>Submit for review</Button>
          </>
        }
      >
        <p className="small sub">
          Restriction <span className="mono">RS-261002-0019</span>. Documents must show you are authorized to sell Vantor products and be dated within 12 months.
        </p>
        <Field label="Document type">
          <Select id="rs-doc-type" options={DOC_TYPES} value={docType} onChange={(e) => setDocType(e.target.value)} />
        </Field>
        <FileDrop title="Drag documents here or browse" hint="PDF, JPG or PNG, up to 10 MB each" accept="application/pdf,image/jpeg,image/png" onFiles={(f) => setFiles((prev) => [...prev, ...f])} />
        {files.length > 0 && (
          <ul className="stack gap-1">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="row between small">
                <span className="row gap-2">
                  <Icon name="file-text" className="ic-sm" />
                  {f.name}
                </span>
                <Button variant="ghost" size="sm" icon="trash-2" label={`Remove ${f.name}`} onClick={() => setFiles((l) => l.filter((_, j) => j !== i))} />
              </li>
            ))}
          </ul>
        )}
        {uploadError && (
          <span className="error-text">
            <Icon name="circle-alert" className="ic-sm" />
            {uploadError}
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
            <Button onClick={submitAppeal}>Submit appeal</Button>
          </>
        }
      >
        <p className="small sub">A second Seller Manager reviewer, not the person who applied it, decides. Appeal by Fri, Oct 16, 11:59 PM PT.</p>
        <Field label="Why should the restriction be lifted?" hint="Say what you changed or why the listings were accurate." error={appealErrors.reason}>
          <Textarea id="rs-appeal" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Checkbox id="rs-confirm" label="The information in this appeal is accurate" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
        {appealErrors.confirm && (
          <span className="error-text">
            <Icon name="circle-alert" className="ic-sm" />
            {appealErrors.confirm}
          </span>
        )}
      </Dialog>
    </SellerLayout>
  );
}
