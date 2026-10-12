import { Fragment, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useScrollRegion, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Checkbox, Field, Icon, KeyValue, PageHeader, Select, StatusBadge, Textarea, TextInput, type IconName, type Tone } from '@marketly/web-shared/ui';

// Design: pages/admin/admin-seller-application.html
// Views: "request-information" and "reject" replace the Decision card with an inline form.

type AppStatus = 'Under review' | 'Information required' | 'Approved' | 'Rejected';

interface Check {
  id: string;
  icon: IconName;
  title: string;
  passed: boolean;
  body: string;
  meta: string;
}

interface RiskFlag {
  level: 'Medium' | 'Low' | 'High';
  text: string;
}

interface Doc {
  id: string;
  icon: IconName;
  name: string;
  size?: string;
  /** Required but not uploaded. */
  missing?: boolean;
}

interface NeedItem {
  id: string;
  label: ReactNode;
  defaultOn: boolean;
}

interface TimelineEvt {
  t: string;
  d: string;
  state: 'done' | 'current' | 'warn' | 'danger';
}

const APP = {
  ref: 'APP-261002-0094',
  store: 'Lumen Cycle Co.',
  applied: 'Oct 2, 2026',
  reviewer: 'Grace Kim',
  owner: 'Marisol Vega',
  target: 'Oct 9 (5 business days)',
};

const BUSINESS: Array<[string, string]> = [
  ['Legal name', 'Lumen Cycle Company LLC'],
  ['Type', 'Limited liability company'],
  ['Registered', 'Oregon, 2019'],
  ['EIN', '•• •••4471'],
  ['Address', '61 NW Oregon Ave, Bend, OR 97703'],
  ['Seller type', 'Business · seller shipping'],
];
const CONTACT: Array<[string, string]> = [
  ['Owner', 'Marisol Vega'],
  ['Email', 'marisol@lumencycle.example'],
  ['Phone', '(541) 555-0172'],
  ['Support hours', 'Mon–Fri, 8 AM–5 PM PT'],
];
const STORE: Array<[string, string]> = [
  ['Store name', 'Lumen Cycle Co.'],
  ['Categories', 'Sports & Outdoors › Cycling'],
  ['Planned products', 'About 120 · lights, locks, tools, e-bike batteries'],
  ['Shipping', 'Contiguous US · UPS Ground, USPS Priority · dispatch 1 business day'],
  ['Return address', '61 NW Oregon Ave, Bend, OR 97703'],
  ['Agreement', 'Seller agreement v2026.3, fee schedule and product rules accepted Oct 2, 4:51 PM'],
];

const CHECKS: Check[] = [
  { id: 'identity', icon: 'id-card', title: 'Identity', passed: true, body: 'Marisol Vega · photo ID matched selfie and name on application.', meta: 'Automated check · Oct 3, 9:12 AM' },
  { id: 'business', icon: 'building-2', title: 'Business registration', passed: true, body: 'Active in Oregon Secretary of State records since Apr 2019. Owner listed as Marisol Vega.', meta: 'Automated check · Oct 3, 9:13 AM' },
  { id: 'payout', icon: 'landmark', title: 'Payout account', passed: false, body: 'Account holder name "M. Vega" does not match the legal business name. Payouts need a business account or proof of ownership.', meta: 'Bank verification · Oct 3, 9:20 AM' },
  { id: 'return', icon: 'map-pin', title: 'Return address', passed: false, body: 'Address exists and accepts packages. It is the same as the business address; no proof of occupancy uploaded.', meta: 'Address check · Oct 3, 9:21 AM' },
];

const RISK_TONE: Record<RiskFlag['level'], Tone> = { High: 'danger', Medium: 'warning', Low: 'info' };
const RISKS: RiskFlag[] = [
  { level: 'Medium', text: 'Payout account holder name does not match the legal business name.' },
  { level: 'Medium', text: 'Product plan includes e-bike batteries. Restricted category: needs UL 2271 safety certification.' },
  { level: 'Low', text: 'No previous marketplace selling history. Recommend a 60-day payout hold window after approval.' },
];

const DOCS: Doc[] = [
  { id: 'd1', icon: 'file-text', name: 'Articles of organization.pdf', size: '412 KB' },
  { id: 'd2', icon: 'id-card', name: 'Driver license, Marisol Vega (redacted)', size: '1.2 MB' },
  { id: 'd3', icon: 'file-text', name: 'Form W-9.pdf', size: '188 KB' },
  { id: 'd4', icon: 'file-text', name: 'Bank letter.pdf', size: '96 KB' },
  { id: 'd5', icon: 'file-x', name: 'UL 2271 battery certificates · not uploaded', missing: true },
];

const NEEDS: NeedItem[] = [
  { id: 'aa-ap-n1', label: <><b>Bank letter or statement</b> showing the account holder as Lumen Cycle Company LLC</>, defaultOn: true },
  { id: 'aa-ap-n2', label: <><b>UL 2271 certificates</b> for the e-bike batteries in the product plan, or remove those products</>, defaultOn: true },
  { id: 'aa-ap-n3', label: 'Proof of address for the return address', defaultOn: false },
  { id: 'aa-ap-n4', label: 'Photo ID for an additional business owner', defaultOn: false },
];

const BASE_EVENTS: TimelineEvt[] = [
  { t: 'Applied', d: 'Oct 2, 4:51 PM · Marisol Vega', state: 'done' },
  { t: 'Automated checks finished', d: 'Oct 3, 9:21 AM · 2 need attention', state: 'warn' },
  { t: 'Under review · Grace Kim', d: 'Oct 5, 10:02 AM', state: 'done' },
  { t: 'Trust and Risk review', d: 'Oct 6, 3:40 PM · Sven Larsen', state: 'done' },
];

const STEPS = ['Applied', 'Checks', 'Under review', 'Decision', 'Store setup', 'Launch ready'];

const REJECT_REASONS = ['Could not verify identity or business', 'Products outside the allowed assortment', 'Risk review not passed', 'Duplicate account'];
const REAPPLY = ['Immediately', '30 days', '90 days', 'Not eligible'];
const REMINDERS = ['3 days before the deadline', 'No reminder'];

const DEFAULT_MSG =
  'Thanks for applying. To finish our review, please upload a bank letter that shows Lumen Cycle Company LLC as the account holder, and UL 2271 certificates for the e-bike batteries you plan to sell. You can upload both from your application page.';

/** "Thu, Oct 22, 2026" -> "Oct 22" */
const shortDate = (s: string) => s.match(/([A-Z][a-z]{2} \d{1,2})/)?.[1] ?? s;

/** Progress steps with the design's "Step n of m" screen-reader text. */
function AppSteps({ current }: { current: number }) {
  const ref = useScrollRegion<HTMLOListElement>();
  return (
    <ol className="steps" aria-label="Progress" ref={ref} data-scroll-region="">
      {STEPS.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && <li className="bar" aria-hidden="true" />}
          <li className={cx('step', i < current && 'is-done', i === current && 'is-current')} aria-current={i === current ? 'step' : undefined}>
            {i < current && <span className="sr-only">Completed: </span>}
            <span className="n">{i < current ? <Icon name="check" className="ic-sm" /> : i + 1}</span>
            {i === current && <span className="sr-only">{`Step ${i + 1} of ${STEPS.length}: `}</span>}
            {s}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

/** Timeline with the design's "At risk:" note on amber events. */
function EventTimeline({ events }: { events: TimelineEvt[] }) {
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e.t} className={`ev is-${e.state}`}>
          {e.state === 'warn' && <span className="sr-only">At risk: </span>}
          <span className="dot" aria-hidden="true" />
          <div className="stack gap-1">
            <span className="t">{e.t}</span>
            <span className="d">{e.d}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function SellerApplication() {
  const [view, setView] = useView<'request-information' | 'reject'>();
  const [status, setStatus] = useState<AppStatus>('Under review');
  const [flash, setFlash] = useState<{ title: string; body: string } | null>(null);

  // Request information form
  const [needs, setNeeds] = useState<Record<string, boolean>>(() => Object.fromEntries(NEEDS.map((n) => [n.id, n.defaultOn])));
  const [due, setDue] = useState('Thu, Oct 22, 2026');
  const [reminder, setReminder] = useState(REMINDERS[0]);
  const [msg, setMsg] = useState(DEFAULT_MSG);
  const [reqTried, setReqTried] = useState(false);
  const [sentDue, setSentDue] = useState('');

  // Reject form (the design's view opens with a reason chosen and the explanation missing)
  const [reason, setReason] = useState('Products outside the allowed assortment');
  const [explain, setExplain] = useState('');
  const [reapply, setReapply] = useState('30 days');
  const [rejectedReason, setRejectedReason] = useState('');

  const canApprove = CHECKS.every((c) => c.passed);
  const passed = CHECKS.filter((c) => c.passed).length;
  const missing = DOCS.filter((d) => d.missing).length;
  const decided = status === 'Approved' || status === 'Rejected';
  // While the request form is open the design already shows the status it will move to.
  const shownStatus: AppStatus = view === 'request-information' && status === 'Under review' ? 'Information required' : status;

  const anyNeed = Object.values(needs).some(Boolean);
  const reqErrors = {
    needs: reqTried && !anyNeed ? 'Choose at least one item the applicant must send.' : '',
    due: reqTried && !due.trim() ? 'Enter a reply-by date.' : '',
    msg: reqTried && !msg.trim() ? 'Write a message to the applicant. They see it in the email and on their application.' : '',
  };
  const rejectErrors = {
    reason: !reason ? 'Choose a reason.' : '',
    explain: !explain.trim() ? 'Write an explanation. The applicant sees this text, so say what was checked and what they can do next.' : '',
  };
  const canReject = !rejectErrors.reason && !rejectErrors.explain;

  const sendRequest = () => {
    setReqTried(true);
    if (!anyNeed || !due.trim() || !msg.trim()) return;
    const n = Object.values(needs).filter(Boolean).length;
    setStatus('Information required');
    setSentDue(due);
    setFlash({
      title: `Information requested from ${APP.owner}`,
      body: `${n} item${n > 1 ? 's' : ''} requested. Reply by ${due}${reminder === REMINDERS[0] ? ', with a reminder 3 days before' : ''}. The application closes if there is no reply.`,
    });
    setView('');
  };

  const reject = () => {
    if (!canReject) return;
    setStatus('Rejected');
    setRejectedReason(reason);
    setFlash({ title: 'Application rejected', body: `${APP.owner} gets your explanation by email. Can reapply after: ${reapply.toLowerCase()}. Recorded in Action history.` });
    setView('');
  };

  const approve = () => {
    if (!canApprove) return;
    setStatus('Approved');
    setFlash({ title: 'Seller approved', body: `${APP.store} can now set up their store. Products still need review before they go live.` });
  };

  const lastEvent: TimelineEvt =
    shownStatus === 'Information required'
      ? { t: 'Information required', d: `Today · reply by ${shortDate(sentDue || due)}`, state: 'current' }
      : shownStatus === 'Rejected'
        ? { t: `Rejected · ${APP.reviewer}`, d: `Today · ${rejectedReason}`, state: 'danger' }
        : shownStatus === 'Approved'
          ? { t: `Approved · ${APP.reviewer}`, d: 'Today', state: 'done' }
          : { t: 'Decision', d: 'Due Oct 9', state: 'current' };

  const decisionCard = (
    <Card title="Decision" sub={`Decision target: ${APP.target}`} titleAs="h3">
      {decided ? (
        <Alert tone={status === 'Approved' ? 'success' : 'info'} title={`Decision: ${status}`}>
          {status === 'Approved' ? 'Store setup is next.' : `Reason: ${rejectedReason}. Can reapply after: ${reapply.toLowerCase()}.`}
        </Alert>
      ) : (
        <div className="stack gap-2">
          <label className={cx('opt-card', !canApprove && 'is-disabled')} htmlFor="aa-ap-d1">
            <input type="radio" name="aa-ap-d" id="aa-ap-d1" disabled={!canApprove} checked={false} onChange={approve} />
            <span className="stack gap-1 grow">
              <span className="small strong">Approve</span>
              <span className="small sub">Seller can set up their store. Products still need review before they go live.</span>
            </span>
          </label>
          {!canApprove && (
            <span className="xs t-warning-text strong" style={{ paddingLeft: 'var(--sp-4)' }}>
              <Icon name="lock" className="ic-sm" /> Resolve the payout account check before approving.
            </span>
          )}
          <Link className="opt-card link-inherit u-td-none" to={href('admin/seller-application', 'request-information')} preventScrollReset>
            <span className="stack gap-1 grow">
              <span className="small strong">Request information</span>
              <span className="small sub">Ask for documents with a deadline</span>
            </span>
            <Icon name="chevron-right" className="ic-sm" />
          </Link>
          <Link className="opt-card link-inherit u-td-none" to={href('admin/seller-application', 'reject')} preventScrollReset>
            <span className="stack gap-1 grow">
              <span className="small strong">Reject</span>
              <span className="small sub">Explanation required</span>
            </span>
            <Icon name="chevron-right" className="ic-sm" />
          </Link>
        </div>
      )}
      <span className="xs muted">Approval does not publish products or allow payouts. Payout readiness and product approval are tracked separately.</span>
    </Card>
  );

  const requestCard = (
    <Card
      title="Request information"
      sub="Status changes to Information required. The applicant gets an email and a task in their application."
      titleAs="h3"
      foot={
        <>
          <Button variant="ghost" to={href('admin/seller-application')}>
            Back
          </Button>
          <Button icon="send" onClick={sendRequest}>
            Send request
          </Button>
        </>
      }
    >
      <div className="stack gap-2">
        <span className="label">What the applicant must send</span>
        {NEEDS.map((n) => (
          <Checkbox key={n.id} id={n.id} label={<span className="small">{n.label}</span>} checked={needs[n.id]} onChange={(e) => setNeeds((s) => ({ ...s, [n.id]: e.target.checked }))} />
        ))}
        {reqErrors.needs && (
          <span className="error-text">
            <Icon name="circle-alert" className="ic-sm" />
            {reqErrors.needs}
          </span>
        )}
      </div>
      <div className="grid md2 gap-3">
        <Field label="Reply by" hint="14 days. The application closes if there is no reply." error={reqErrors.due}>
          <TextInput id="aa-ap-due" value={due} error={!!reqErrors.due} onChange={(e) => setDue(e.target.value)} placeholder="" />
        </Field>
        <Field label="Reminder">
          <Select id="aa-ap-rem" options={REMINDERS} value={reminder} onChange={(e) => setReminder(e.target.value)} />
        </Field>
      </div>
      <Field label="Message to applicant" error={reqErrors.msg}>
        <Textarea id="aa-ap-msg" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="" />
      </Field>
    </Card>
  );

  const rejectCard = (
    <Card
      title="Reject application"
      sub="The applicant reads your explanation. Rejections are recorded in Action history."
      titleAs="h3"
      foot={
        <>
          <Button variant="ghost" to={href('admin/seller-application')}>
            Back
          </Button>
          <Button variant="danger" icon="circle-x" disabled={!canReject} onClick={reject}>
            Reject application
          </Button>
        </>
      }
    >
      <Field label="Reason" error={rejectErrors.reason}>
        <Select id="aa-ap-rr" options={[{ value: '', label: 'Choose a reason' }, ...REJECT_REASONS.map((r) => ({ value: r, label: r }))]} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Field label="Explanation to applicant" error={rejectErrors.explain}>
        <Textarea id="aa-ap-rx" value={explain} onChange={(e) => setExplain(e.target.value)} placeholder="Explain what we checked, why the application cannot be approved and what would change the outcome" />
      </Field>
      <Field label="Can reapply after">
        <Select id="aa-ap-ra" options={REAPPLY} value={reapply} onChange={(e) => setReapply(e.target.value)} />
      </Field>
      <Alert tone="info" title="Before you reject">
        Two checks passed and two need attention. Requesting information is usually the right step when documents can fix the issue.
      </Alert>
    </Card>
  );

  const panel = decided ? decisionCard : view === 'request-information' ? requestCard : view === 'reject' ? rejectCard : decisionCard;

  return (
    <AdminLayout active="applications">
      <PageHeader
        crumbs={[{ label: 'Sellers' }, { label: 'Applications', to: href('admin/seller-application') }, { label: APP.store }]}
        title={APP.store}
        sub={
          <>
            Application {APP.ref} · applied {APP.applied} · reviewer {APP.reviewer} · <StatusBadge status={shownStatus} />
          </>
        }
        actions={
          <>
            <Button variant="secondary" size="sm" icon="mail">
              Message applicant
            </Button>
            <Button variant="secondary" size="sm" icon="user-plus">
              Assign
            </Button>
          </>
        }
      />
      {flash && (
        <Alert tone="success" title={flash.title}>
          {flash.body}
        </Alert>
      )}
      <AppSteps current={status === 'Approved' ? 4 : status === 'Rejected' ? 3 : 2} />
      <div className="aa-split">
        <div className="stack gap-5">
          <Card title="Business and store details">
            <div className="aa-2">
              <div className="aa-sec">
                <span className="h4">Business</span>
                <KeyValue pairs={BUSINESS} />
              </div>
              <div className="aa-sec">
                <span className="h4">Contact</span>
                <KeyValue pairs={CONTACT} />
              </div>
            </div>
            <div className="aa-sec">
              <span className="h4">Store</span>
              <KeyValue pairs={STORE} />
            </div>
          </Card>
          <Card title="Verification checks" sub={`${passed} passed · ${CHECKS.length - passed} need attention`} titleAs="h3">
            {CHECKS.map((c) => (
              <div key={c.id} className={cx('aa-chk', c.passed ? 't-success' : 't-warning')}>
                <Icon name={c.icon} />
                <div className="stack gap-1">
                  <div className="row between">
                    <span className="small strong">{c.title}</span>
                    <Badge tone={c.passed ? 'success' : 'warning'}>{c.passed ? 'Passed' : 'Needs attention'}</Badge>
                  </div>
                  <span className="small sub">{c.body}</span>
                  <span className="xs muted">{c.meta}</span>
                </div>
              </div>
            ))}
          </Card>
          <Card title="Risk flags from Trust and Risk" sub="Sven Larsen · reviewed Oct 6" titleAs="h3">
            <ul className="list">
              {RISKS.map((r) => (
                <li key={r.text}>
                  <Badge tone={RISK_TONE[r.level]}>{r.level}</Badge>
                  <span className="grow small">{r.text}</span>
                </li>
              ))}
            </ul>
            <span className="xs muted">Recommendation: request information. No signs of a linked or previously closed account.</span>
          </Card>
          <Card title="Documents" sub={`${DOCS.length - missing} uploaded · ${missing} missing`} titleAs="h3">
            <div className="stack gap-2">
              {DOCS.map((d) =>
                d.missing ? (
                  <div key={d.id} className="aa-doc u-bs-dashed">
                    <Icon name={d.icon} />
                    <span className="grow t-danger-text strong">{d.name}</span>
                  </div>
                ) : (
                  <div key={d.id} className="aa-doc">
                    <Icon name={d.icon} />
                    <span className="grow">{d.name}</span>
                    <span className="xs muted">{d.size}</span>
                    <Button variant="ghost" size="sm">
                      View
                    </Button>
                  </div>
                ),
              )}
            </div>
          </Card>
        </div>
        <div className="stack gap-5">
          {panel}
          <Card title="Status timeline" titleAs="h3">
            <EventTimeline events={[...BASE_EVENTS, lastEvent]} />
          </Card>
          <Card title="Notes" titleAs="h3">
            <div className="aa-note">
              <span className="row between xs">
                <b>Grace Kim</b>
                <span className="muted">Oct 6, 4:05 PM</span>
              </span>
              <span>Good fit for cycling. If documents come back clean, approve with batteries excluded until certificates are checked.</span>
            </div>
            <Field label="Add a note">
              <Textarea id="aa-ap-note" placeholder="Visible to staff only" />
            </Field>
          </Card>
        </div>
      </div>
    </AdminLayout>
  );
}
