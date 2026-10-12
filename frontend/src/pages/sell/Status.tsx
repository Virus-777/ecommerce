import { useState } from 'react';
import { StoreLayout } from '@/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Dialog, Field, FileDrop, Icon, IconButton, KeyValue, Select, StatusBadge, Textarea, TextInput, Timeline, type TimelineEvent } from '@marketly/web-shared/ui';

// Design: pages/store/sell-status.html (Information required) · views "approved", "rejected".
// Approval or rejection is decided by a Seller Manager (admin/seller-application); the applicant can
// answer the information request here, and appeal a rejection.

type View = 'approved' | 'rejected';

const APPLICATION: Array<[string, string]> = [
  ['Applicant', 'Avery Stone'],
  ['Business', 'Northwind Audio LLC'],
  ['Categories', 'Electronics'],
  ['Submitted', 'Tue, Sep 29, 2026'],
];

const atRisk = (t: string) => (
  <>
    <span className="sr-only">At risk: </span>
    {t}
  </>
);

const TIMELINE: Record<'' | 'sent' | View, TimelineEvent[]> = {
  '': [
    { t: 'Applied', d: 'Tue, Sep 29', state: 'done' },
    { t: atRisk('Information required'), d: 'Requested Wed, Oct 7 by Grace Kim, Seller Manager', state: 'warn', body: '2 items needed by Thu, Oct 22' },
    { t: 'Under review', d: 'Usually 3–5 business days after you reply' },
    { t: 'Approved' },
  ],
  sent: [
    { t: 'Applied', d: 'Tue, Sep 29', state: 'done' },
    { t: 'Information required', d: 'Requested Oct 7, sent today', state: 'done' },
    { t: 'Under review', d: 'Usually 3–5 business days', state: 'current' },
    { t: 'Approved' },
  ],
  approved: [
    { t: 'Applied', d: 'Tue, Sep 29', state: 'done' },
    { t: 'Information required', d: 'Oct 7, sent Oct 7', state: 'done' },
    { t: 'Under review', d: 'Oct 7 – Oct 8', state: 'done' },
    { t: 'Approved', d: 'Thu, Oct 8, 11:30 AM', state: 'done' },
  ],
  rejected: [
    { t: 'Applied', d: 'Tue, Sep 29', state: 'done' },
    { t: 'Information required', d: 'Oct 7, sent Oct 7', state: 'done' },
    { t: 'Under review', d: 'Oct 7 – Oct 8', state: 'done', body: 'Including an additional Trust and Risk check' },
    { t: 'Rejected', d: 'Thu, Oct 8, 11:30 AM', state: 'danger' },
  ],
};

const SETUP = ['Set shipping coverage and rates', 'Complete your store profile and return policy', 'Confirm payout deposits', 'Submit your first products or offers'];

function Head({ status, title, sub }: { status: string; title: string; sub: string }) {
  return (
    <div className="stack gap-2">
      <span className="row gap-2">
        <span className="xs muted">
          Application <span className="mono">SA-260929-0412</span> · Northwind Audio LLC
        </span>
        <StatusBadge status={status} />
      </span>
      <h1 className="h1">{title}</h1>
      <p className="sub">{sub}</p>
    </div>
  );
}

function InfoRequired({ onSent }: { onSent: () => void }) {
  const [doc, setDoc] = useState('');
  const [line1, setLine1] = useState('3315 SE Division St');
  const [city, setCity] = useState('Portland');
  const [state, setState] = useState('Oregon');
  const [zip, setZip] = useState('97202');
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState(false);

  const errors: { doc?: string; line1?: string; city?: string; zip?: string } = {};
  if (tried) {
    if (!doc) errors.doc = 'Upload the full registration record.';
    if (!line1.trim()) errors.line1 = 'Enter a street address.';
    else if (/\bp\.?\s*o\.?\s*box\b/i.test(line1)) errors.line1 = "PO boxes can't receive carrier returns. Use a street address.";
    if (!city.trim()) errors.city = 'Enter a city.';
    if (!/^\d{5}$/.test(zip.trim())) errors.zip = 'Enter a 5-digit ZIP code, like 97202.';
  }
  const n = Object.keys(errors).length;

  const send = () => {
    setTried(true);
    const bad = !doc || !line1.trim() || /\bp\.?\s*o\.?\s*box\b/i.test(line1) || !city.trim() || !/^\d{5}$/.test(zip.trim());
    if (!bad) onSent();
  };

  return (
    <>
      <Alert tone="warning" title="Deadline: Thu, Oct 22, 2026">
        14 days left · Requested on Wed, Oct 7 by Grace Kim, Seller Manager
      </Alert>
      {n > 0 && (
        <Alert tone="danger" title={`Check ${n} thing${n > 1 ? 's' : ''} before sending`}>
          {Object.values(errors).join(' ')}
        </Alert>
      )}
      {saved && n === 0 && (
        <Alert tone="success" title="Draft saved">
          Come back any time before Thu, Oct 22 to send it.
        </Alert>
      )}
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">1. Full business registration record</h2>
            <span className="xs muted">Needed for: Verification</span>
          </div>
        </div>
        <div className="card-body">
          <p className="small sub">The file you uploaded (registration-screenshot.png) is cropped and doesn't show the registry number or the registered owner. Upload the full record from the Oregon Secretary of State business registry.</p>
          {doc ? (
            <div className="panel row gap-3">
              <Icon name="file-check" />
              <span className="small grow">{doc}</span>
              <Badge tone="success" icon="check">
                Uploaded
              </Badge>
              <IconButton icon="x" size="sm" label={`Remove ${doc}`} onClick={() => setDoc('')} />
            </div>
          ) : (
            <FileDrop title="Upload registration record" hint="PDF, JPG or PNG up to 10 MB" accept="application/pdf,image/jpeg,image/png" multiple={false} onFiles={(f) => f[0] && setDoc(f[0].name)} />
          )}
          {errors.doc && (
            <span className="error-text">
              <Icon name="circle-alert" className="ic-sm" />
              {errors.doc}
            </span>
          )}
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h3 className="h4">2. A street return address</h3>
            <span className="xs muted">Needed for: Return address</span>
          </div>
        </div>
        <div className="card-body">
          <p className="small sub">PO Box 1182 can't receive carrier returns. Add a street address where customers can send items back.</p>
          <Field label="Street address" error={errors.line1}>
            <TextInput id="st-ret1" value={line1} error={!!errors.line1} onChange={(e) => setLine1(e.target.value)} />
          </Field>
          <div className="grid md3">
            <Field label="City" error={errors.city}>
              <TextInput id="st-retc" value={city} error={!!errors.city} onChange={(e) => setCity(e.target.value)} />
            </Field>
            <Field label="State">
              <Select id="st-rets" options={['Oregon', 'Washington']} value={state} onChange={(e) => setState(e.target.value)} />
            </Field>
            <Field label="ZIP code" error={errors.zip}>
              <TextInput id="st-retz" value={zip} inputMode="numeric" error={!!errors.zip} onChange={(e) => setZip(e.target.value)} />
            </Field>
          </div>
        </div>
        <div className="card-foot">
          <Button variant="ghost" onClick={() => setSaved(true)}>
            Save draft
          </Button>
          <Button icon="send" onClick={send}>
            Send for review
          </Button>
        </div>
      </section>
    </>
  );
}

export default function Status() {
  const [view] = useView<View>();
  const [sent, setSent] = useState(false);
  const [appealOpen, setAppealOpen] = useState(false);
  const [appealed, setAppealed] = useState(false);
  const [appealDoc, setAppealDoc] = useState('');
  const [appealMsg, setAppealMsg] = useState('');
  const [appealTried, setAppealTried] = useState(false);

  const appealErrors = appealTried ? { doc: appealDoc ? undefined : 'Attach the correct registration record.', msg: appealMsg.trim() ? undefined : 'Tell us what our check got wrong.' } : {};
  const submitAppeal = () => {
    setAppealTried(true);
    if (!appealDoc || !appealMsg.trim()) return;
    setAppealed(true);
    setAppealOpen(false);
  };

  const timeline = view === 'approved' || view === 'rejected' ? TIMELINE[view] : sent ? TIMELINE.sent : TIMELINE[''];

  return (
    <StoreLayout appbar={{ title: 'Application status', back: href('sell/landing') }} footer={false}>
      <div className="container page">
        <div className="split">
          <div className="stack gap-5">
            {view === 'approved' ? (
              <>
                <Head status="Approved" title="You're approved to sell on Marketly" sub="Approved by Grace Kim, Seller Manager, on Thu, Oct 8. Finish setting up your store before your offers can go live." />
                <div className="buy-indic">
                  <div>
                    <span className="xs muted">Account status</span>
                    <Badge tone="success">Approved</Badge>
                    <span className="small">You can sign in to Seller Center and set up your store.</span>
                  </div>
                  <div>
                    <span className="xs muted">Product approval</span>
                    <Badge>Draft</Badge>
                    <span className="small">0 products submitted. Each product or offer is reviewed before it's published.</span>
                  </div>
                  <div>
                    <span className="xs muted">Payout readiness</span>
                    <Badge tone="warning">Pending</Badge>
                    <span className="small">Confirm the 2 small deposits sent to •••• 7731 on Oct 8.</span>
                  </div>
                </div>
                <Alert tone="info" title="Approval alone doesn't publish anything">
                  Customers see your offers only after your store setup is complete and each offer is approved.
                </Alert>
                <section className="card">
                  <div className="card-head">
                    <div className="stack gap-0">
                      <h2 className="h4">Next: finish setup</h2>
                    </div>
                  </div>
                  <div className="card-body">
                    <ul className="stack gap-2 small">
                      {SETUP.map((s) => (
                        <li key={s} className="row gap-2 nowrap">
                          <Icon name="circle" className="ic-sm" />
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="card-foot">
                    <Button iconRight="arrow-right" to={href('seller/setup')}>
                      Finish setup in Seller Center
                    </Button>
                  </div>
                </section>
              </>
            ) : view === 'rejected' ? (
              <>
                <Head status={appealed ? 'Appealed' : 'Rejected'} title="We couldn't approve your application" sub="Reviewed by Grace Kim, Seller Manager, with the Trust and Risk team on Thu, Oct 8." />
                {appealed && (
                  <Alert tone="success" title="Appeal sent">
                    A different reviewer checks your new registration record and replies within 5 business days.
                  </Alert>
                )}
                <section className="card">
                  <div className="card-head">
                    <div className="stack gap-0">
                      <h2 className="h4">Reason</h2>
                    </div>
                  </div>
                  <div className="card-body">
                    <p className="small">The registry number on your application doesn't match the Oregon Secretary of State record for Northwind Audio LLC, and the registration document we requested shows a different owner name. We can't verify who owns the business.</p>
                    <span className="xs muted">Rule: Seller agreement, section 2.1, Business verification.</span>
                  </div>
                </section>
                <section className="card">
                  <div className="card-head">
                    <div className="stack gap-0">
                      <h3 className="h4">What you can do</h3>
                    </div>
                  </div>
                  <div className="card-body">
                    <ul className="stack gap-3 small">
                      <li className="buy-feature">
                        <Icon name="scale" />
                        <span className="stack gap-0">
                          <span className="strong">Appeal by Thu, Oct 22</span>
                          <span className="xs muted">If our check was wrong, send the correct registration record. A different reviewer replies within 5 business days.</span>
                        </span>
                      </li>
                      <li className="buy-feature">
                        <Icon name="calendar-clock" />
                        <span className="stack gap-0">
                          <span className="strong">Reapply from Mon, Jan 4, 2027</span>
                          <span className="xs muted">Start a new application once the business registration and ownership records match.</span>
                        </span>
                      </li>
                      <li className="buy-feature">
                        <Icon name="mail" />
                        <span className="stack gap-0">
                          <span className="strong">Ask us a question</span>
                          <span className="xs muted">sellers@marketly.example · 1-800-555-0177, Mon–Fri 8 AM–5 PM PT</span>
                        </span>
                      </li>
                    </ul>
                  </div>
                  <div className="card-foot">
                    <Button variant="ghost" href="mailto:sellers@marketly.example?subject=Application%20SA-260929-0412">
                      Contact the seller team
                    </Button>
                    <Button variant="secondary" icon="scale" onClick={() => setAppealOpen(true)} disabled={appealed}>
                      {appealed ? 'Appeal sent' : 'Appeal this decision'}
                    </Button>
                  </div>
                </section>
                <p className="xs muted">Your uploaded documents are kept for 90 days for the appeal and then deleted.</p>
              </>
            ) : sent ? (
              <>
                <Head status="Under review" title="Thanks, your application is back in review" sub="We got your registration record and street return address. A Seller Manager reviews your application, usually within 3–5 business days." />
                <Alert tone="success" title="Sent for review">
                  We email you at avery@northwindaudio.example when there's a decision or if we need anything else.
                </Alert>
              </>
            ) : (
              <>
                <Head status="Information required" title="We need 2 more things to review your application" sub="Your application is on hold until we get these. Send them by Thu, Oct 22, 2026, or the application closes and you'll need to start again." />
                <InfoRequired onSent={() => setSent(true)} />
              </>
            )}
          </div>
          <aside className="stack gap-4">
            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h3 className="h4">Application progress</h3>
                </div>
              </div>
              <div className="card-body">
                <Timeline events={timeline} />
              </div>
            </section>
            <section className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <h3 className="h4">Your application</h3>
                </div>
              </div>
              <div className="card-body">
                <KeyValue pairs={APPLICATION} />
              </div>
            </section>
            <div className="card pad stack gap-1">
              <span className="small strong">Questions?</span>
              <span className="xs muted">sellers@marketly.example · 1-800-555-0177, Mon–Fri 8 AM–5 PM PT</span>
            </div>
          </aside>
        </div>
      </div>

      <Dialog
        open={appealOpen}
        onClose={() => setAppealOpen(false)}
        title="Appeal this decision"
        foot={
          <>
            <Button variant="ghost" onClick={() => setAppealOpen(false)}>
              Cancel
            </Button>
            <Button icon="scale" onClick={submitAppeal}>
              Send appeal
            </Button>
          </>
        }
      >
        <p className="small sub">A different reviewer checks the case and replies within 5 business days. You can appeal until Thu, Oct 22.</p>
        <div className="field">
          <span className="label">Correct registration record</span>
          {appealDoc ? (
            <div className="panel row gap-3">
              <Icon name="file-check" />
              <span className="small grow">{appealDoc}</span>
              <IconButton icon="x" size="sm" label={`Remove ${appealDoc}`} onClick={() => setAppealDoc('')} />
            </div>
          ) : (
            <FileDrop title="Upload registration record" hint="PDF, JPG or PNG up to 10 MB" accept="application/pdf,image/jpeg,image/png" multiple={false} onFiles={(f) => f[0] && setAppealDoc(f[0].name)} />
          )}
          {appealErrors.doc && (
            <span className="error-text">
              <Icon name="circle-alert" className="ic-sm" />
              {appealErrors.doc}
            </span>
          )}
        </div>
        <Field label="What did our check get wrong?" error={appealErrors.msg}>
          <Textarea id="st-appeal" value={appealMsg} onChange={(e) => setAppealMsg(e.target.value)} />
        </Field>
      </Dialog>
    </StoreLayout>
  );
}
