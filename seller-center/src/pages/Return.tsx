import { Fragment, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { money } from '@marketly/web-shared/lib/format';
import { useScrollRegion, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Avatar, Badge, Breadcrumbs, Button, Card, Deadline, Field, Icon, Img, KeyValue, OptionCard, Select, StatusBadge, SummaryRow, Textarea, announce, type IconName } from '@marketly/web-shared/ui';

// Design: pages/seller/seller-return.html · view "inspect-and-refund" (the parcel is back: record the
// inspection and refund). Approving the return here leads on to the inspection step.

type Decision = 'approve' | 'info' | 'reject';
type Cond = 'ok' | 'dmg' | 'miss';

const PAID = 59;
const LABEL = 8.45;
const FEE_RATE = 0.1;

const STEPS = ['Requested', 'Your response', 'Return shipped', 'Received and inspected', 'Refund'];

const PHOTOS: Array<{ icon: IconName; tint: string; cap: string }> = [
  { icon: 'image', tint: '2', cap: 'Speaker, front' },
  { icon: 'smartphone', tint: '6', cap: 'Bluetooth screen, disconnected' },
  { icon: 'package-open', tint: '3', cap: 'Box and cable' },
];

const REJECT_REASONS = ['Choose a reason', 'Outside the return window', 'Item not eligible for return', 'Item damaged by the customer', 'Other (explain below)'];
const STOCK = ['Return to supplier (Halden RMA)', 'Back to available stock', 'Damaged stock', 'Write off'];
const STOCK_HINT: Record<string, string> = {
  'Return to supplier (Halden RMA)': 'Updates your inventory: the unit does not go back on sale.',
  'Back to available stock': 'Updates your inventory: the unit goes back on sale.',
  'Damaged stock': 'Updates your inventory: the unit is held as damaged and not sold.',
  'Write off': 'Updates your inventory: the unit is removed from stock.',
};

interface Msg {
  id: string;
  kind: 'customer' | 'me' | 'staff' | 'note';
  who?: string;
  when?: string;
  text: string;
  icon?: IconName;
}
interface Ev {
  t: string;
  d: string;
  state: 'done' | 'current' | 'warn';
}
interface FileItem {
  name: string;
  meta: string;
}

const RESPOND_MSGS: Msg[] = [
  { id: 'm1', kind: 'customer', who: 'Dana W. (customer)', when: 'Oct 5, 4:12 PM', text: 'Requesting a return. The speaker cuts out after a few minutes, photos attached.' },
  { id: 'n1', kind: 'note', icon: 'clock', text: 'Respond by Oct 9, 4:00 PM PT. After that, Marketly support may decide this return.' },
];
const INSPECT_MSGS: Msg[] = [
  RESPOND_MSGS[0],
  { id: 'm2', kind: 'me', who: 'You · Avery Stone', when: 'Oct 5, 6:15 PM', text: 'Sorry about that. I approved the return and sent a prepaid label to your email. The refund follows once it arrives and we test it.' },
  { id: 'n2', kind: 'note', icon: 'circle-check', text: 'Return approved and label sent · Oct 5, 6:15 PM' },
  { id: 'm3', kind: 'customer', who: 'Dana W. (customer)', when: 'Oct 7, 8:30 AM', text: 'Dropped it off yesterday. When will I get my money back?' },
  { id: 'm4', kind: 'staff', who: 'Marco Diaz · Marketly support', when: 'Oct 7, 9:12 AM', text: 'The customer asked us about refund timing. The parcel is due today. Please record the inspection by Oct 10, 10:20 AM PT so the refund stays on target.' },
];
const RESPOND_EVENTS: Ev[] = [
  { t: 'Waiting for your response', d: 'Due Oct 9, 4:00 PM PT', state: 'warn' },
  { t: 'Viewed by Leo Grant', d: 'Oct 6, 9:02 AM', state: 'done' },
  { t: 'Return requested', d: 'Oct 5, 4:12 PM · Dana W.', state: 'done' },
  { t: 'Delivered', d: 'Sep 29, 1:48 PM · USPS', state: 'done' },
];
const INSPECT_EVENTS: Ev[] = [
  { t: 'Return delivered to you', d: 'Oct 8, 10:20 AM', state: 'current' },
  { t: 'Support note added', d: 'Oct 7, 9:12 AM · Marco Diaz', state: 'done' },
  { t: 'Return shipped by customer', d: 'Oct 6, 5:41 PM', state: 'done' },
  { t: 'Approved, label sent', d: 'Oct 5, 6:15 PM · Avery Stone', state: 'done' },
  { t: 'Return requested', d: 'Oct 5, 4:12 PM · Dana W.', state: 'done' },
];
const SHIPMENT_EVENTS: Ev[] = [
  { t: 'Delivered to your return address', d: 'Oct 8, 10:20 AM', state: 'done' },
  { t: 'In transit', d: 'Oct 7, 6:02 AM · Portland, OR', state: 'done' },
  { t: 'Dropped off by customer', d: 'Oct 6, 5:41 PM · Seattle, WA', state: 'done' },
  { t: 'Return approved, label sent', d: 'Oct 5, 6:15 PM · by Avery Stone', state: 'done' },
];

/** Progress steps with the design's "Step n of m" note on the current step. */
function ReturnSteps({ current }: { current: number }) {
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

/** Timeline with the design's "At risk:" note on warning events. */
function Events({ events }: { events: Ev[] }) {
  return (
    <ol className="timeline">
      {events.map((e, i) => (
        <li key={i} className={cx('ev', `is-${e.state}`)}>
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

/** Design dropzone (title in .u-c-text) with a working file picker. */
function Drop({ title, hint, accept, onFiles }: { title: string; hint: string; accept: string; onFiles: (f: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className="dropzone"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <Icon name="image-plus" className="ic-lg" />
      <span className="small strong u-c-text">{title}</span>
      <span className="xs">{hint}</span>
      <input ref={input} type="file" hidden multiple accept={accept} onChange={(e) => onFiles(Array.from(e.target.files ?? []))} />
      <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
        Browse files
      </Button>
    </div>
  );
}

const fileItems = (files: File[]): FileItem[] => files.map((f) => ({ name: f.name, meta: `${(f.size / 1048576).toFixed(1)} MB · you · Oct 8` }));

function FileList({ files }: { files: FileItem[] }) {
  if (!files.length) return null;
  return (
    <ul className="list">
      {files.map((f, i) => (
        <li key={`${f.name}${i}`}>
          <Icon name="file-text" className="ic-sm" />
          <span className="grow small">{f.name}</span>
          <span className="xs muted">{f.meta}</span>
        </li>
      ))}
    </ul>
  );
}

export default function Return() {
  const [view] = useView<'inspect-and-refund'>();
  const inspect = view === 'inspect-and-refund';

  // Respond step
  const [decision, setDecision] = useState<Decision>('approve');
  const [noReturn, setNoReturn] = useState(false);
  const [infoQ, setInfoQ] = useState('');
  const [rejReason, setRejReason] = useState(REJECT_REASONS[0]);
  const [rejText, setRejText] = useState('');
  const [respTried, setRespTried] = useState(false);
  const [responded, setResponded] = useState<'' | Decision>('');

  // Inspect step
  const [cond, setCond] = useState<Cond>('ok');
  const [notes, setNotes] = useState('Tested on two phones. Drops connection at 4–6 min on battery, works on USB power. Matches a known battery-board fault. All parts and box included.');
  const [stock, setStock] = useState(STOCK[0]);
  const [inspPhotos, setInspPhotos] = useState<FileItem[]>([]);
  const [refundKind, setRefundKind] = useState<'full' | 'part'>('full');
  const [partAmt, setPartAmt] = useState('');
  const [partWhy, setPartWhy] = useState('');
  const [refTried, setRefTried] = useState(false);
  const [refunded, setRefunded] = useState<number | null>(null);

  // Messages
  const [respondMsgs, setRespondMsgs] = useState(RESPOND_MSGS);
  const [inspectMsgs, setInspectMsgs] = useState(INSPECT_MSGS);
  const msgs = inspect ? inspectMsgs : respondMsgs;
  const setMsgs = inspect ? setInspectMsgs : setRespondMsgs;
  const [reply, setReply] = useState('');
  const [replyErr, setReplyErr] = useState('');
  const [evidence, setEvidence] = useState<FileItem[]>([]);
  const inspectEvidence: FileItem[] = [{ name: 'inspection-test-oct8.mp4', meta: '14.2 MB · you · Oct 8' }, ...evidence];
  const attachRef = useRef<HTMLInputElement>(null);

  const addNote = (text: string, icon: IconName = 'circle-check') => setMsgs((m) => [...m, { id: `n${Date.now()}`, kind: 'note', icon, text }]);

  // ---- respond validation & submit
  const respErrors = {
    infoQ: respTried && decision === 'info' && !infoQ.trim() ? 'Write the question for the customer.' : '',
    rejReason: respTried && decision === 'reject' && rejReason === REJECT_REASONS[0] ? 'Choose a reason for rejecting.' : '',
    rejText: respTried && decision === 'reject' && !rejText.trim() ? 'Explain which term applies so the customer knows what to do next.' : '',
  };
  const submitResponse = (d: Decision) => {
    setDecision(d);
    setRespTried(true);
    if ((d === 'info' && !infoQ.trim()) || (d === 'reject' && (rejReason === REJECT_REASONS[0] || !rejText.trim()))) return;
    setResponded(d);
    if (d === 'approve') addNote(noReturn ? 'Refund approved without return · just now' : 'Return approved and label sent · just now');
    if (d === 'info') setRespondMsgs((m) => [...m, { id: `m${Date.now()}`, kind: 'me', who: 'You · Avery Stone', when: 'Just now', text: infoQ.trim() }, { id: `n${Date.now()}`, kind: 'note', icon: 'pause', text: 'Respond-by clock paused until the customer replies (up to 3 days)' }]);
    if (d === 'reject') addNote(`Return rejected: ${rejReason} · just now`, 'circle-x');
    announce(d === 'approve' ? 'Return approved. Label sent to the customer.' : d === 'info' ? 'Question sent to the customer' : 'Return rejected');
  };

  // ---- refund validation & submit
  const amt = Number(partAmt);
  const amtErr = refundKind === 'part' && refTried ? (!/^\d+(\.\d{1,2})?$/.test(partAmt.trim()) || amt <= 0 ? 'Enter the partial amount, like 53.00.' : amt > PAID ? `Enter ${money(PAID)} or less. You can't refund more than the customer paid.` : '') : '';
  const whyErr = refundKind === 'part' && refTried && !partWhy.trim() ? 'Explain the deduction to the customer.' : '';
  const refundAmount = refundKind === 'full' ? PAID : /^\d+(\.\d{1,2})?$/.test(partAmt.trim()) && amt > 0 && amt <= PAID ? amt : 0;
  const confirmRefund = () => {
    setRefTried(true);
    if (refundKind === 'part' && (!refundAmount || !partWhy.trim())) return;
    setRefunded(refundAmount);
    addNote(`Inspection recorded and ${money(refundAmount)} refund started · just now`);
    announce(`Refund of ${money(refundAmount)} started`);
  };

  // ---- messages
  const send = () => {
    if (!reply.trim()) {
      setReplyErr('Write a message first.');
      return;
    }
    setMsgs((m) => [...m, { id: `m${Date.now()}`, kind: 'me', who: 'You · Avery Stone', when: 'Just now', text: reply.trim() }]);
    setReply('');
    setReplyErr('');
    announce('Message sent');
  };
  const addEvidence = (files: File[]) => {
    if (!files.length) return;
    setEvidence((e) => [...e, ...fileItems(files)]);
    announce(`${files.length} file${files.length > 1 ? 's' : ''} added to the case`);
  };

  // ---- earnings impact
  const impactRefund = inspect ? (refunded ?? (refundAmount || PAID)) : responded === 'reject' ? 0 : PAID;
  const fee = Math.round(impactRefund * FEE_RATE * 100) / 100;
  const earn = Math.round((impactRefund - fee) * 100) / 100;
  const labelCost = inspect || decision !== 'approve' || !noReturn ? LABEL : 0;
  const total = earn + (responded === 'reject' ? 0 : labelCost);
  const neg = (n: number) => `−${money(n)}`;

  // ---- status & progress
  const status = inspect ? (refunded === null ? 'Inspecting' : refunded < PAID ? 'Partly refunded' : 'Refunded') : responded === 'approve' ? (noReturn ? 'Refunded' : 'Return approved') : responded === 'reject' ? 'Rejected' : responded === 'info' ? 'Waiting on customer' : 'Return requested';
  const step = inspect ? (refunded === null ? 3 : 5) : responded === 'approve' ? (noReturn ? 5 : 2) : 1;
  const events: Ev[] = inspect
    ? refunded === null
      ? INSPECT_EVENTS
      : [{ t: `Refund ${money(refunded)} processing`, d: 'Just now · Avery Stone', state: 'current' }, { ...INSPECT_EVENTS[0], state: 'done' }, ...INSPECT_EVENTS.slice(1)]
    : responded
      ? [{ t: responded === 'approve' ? 'Approved, label sent' : responded === 'info' ? 'Information requested' : 'Return rejected', d: 'Just now · Avery Stone', state: 'done' }, ...RESPOND_EVENTS.slice(1)]
      : RESPOND_EVENTS;

  const decisionCard = (
    <section className="card">
      <div className="card-head">
        <div className="stack gap-0">
          <h3 className="h4">Your response</h3>
          <span className="xs muted">The customer sees your decision and any explanation</span>
        </div>
      </div>
      <div className="card-body">
        {responded && (
          <Alert tone={responded === 'reject' ? 'warning' : 'success'} title={responded === 'approve' ? (noReturn ? 'Refund approved without a return' : 'Return approved and label sent') : responded === 'info' ? 'Question sent to the customer' : 'Return rejected'}>
            {responded === 'approve' && !noReturn ? (
              <>
                The customer has the prepaid label. When the parcel arrives,{' '}
                <Link to={href('seller/return', 'inspect-and-refund')}>record the inspection and refund</Link>
                .
              </>
            ) : responded === 'info' ? (
              'The respond-by clock is paused until the customer replies, up to 3 days.'
            ) : responded === 'reject' ? (
              'The customer can ask Marketly to review your decision.'
            ) : (
              'The refund goes back to Visa •••• 2290.'
            )}
          </Alert>
        )}
        <OptionCard id="rt-dec-approve" name="rt-dec" title={<span className="strong">Approve return</span>} body="Send a prepaid label. Refund after you receive and inspect the item." checked={decision === 'approve'} onChange={() => setDecision('approve')} />
        <div className={cx('sb-subform', decision === 'approve' && 'is-on')}>
          <span className="small strong">Return shipping</span>
          <OptionCard
            id="rt-ship-seller"
            name="rt-ship"
            title={
              <span className="row between">
                <span className="strong small">You pay: prepaid USPS label</span>
                <span className="num small">{money(LABEL)}</span>
              </span>
            }
            body="Deducted from your earnings. Example rate."
            checked
            onChange={() => undefined}
          />
          <OptionCard id="rt-ship-cust" name="rt-ship" title={<span className="strong small">Customer pays</span>} body="Not allowed for defective items under platform rules." disabled checked={false} />
          <label className="check" htmlFor="rt-noreturn">
            <input type="checkbox" id="rt-noreturn" checked={noReturn} onChange={(e) => setNoReturn(e.target.checked)} />
            <span>Refund without asking for the item back (records a reason; use for low-value or unsafe items)</span>
          </label>
        </div>
        <OptionCard id="rt-dec-info" name="rt-dec" title={<span className="strong">Request more information</span>} body="Pauses the respond-by clock until the customer replies, up to 3 days." checked={decision === 'info'} onChange={() => setDecision('info')} />
        <div className={cx('sb-subform', decision === 'info' && 'is-on')}>
          <Field label="Question for the customer" error={respErrors.infoQ}>
            <Textarea id="rt-info-q" placeholder="Example: Does the speaker cut out when connected by cable as well?" value={infoQ} onChange={(e) => setInfoQ(e.target.value)} onFocus={() => setDecision('info')} />
          </Field>
        </div>
        <OptionCard id="rt-dec-reject" name="rt-dec" title={<span className="strong">Reject return</span>} body="Only when the request breaks your published terms. The customer can ask Marketly to review." checked={decision === 'reject'} onChange={() => setDecision('reject')} />
        <div className={cx('sb-subform', decision === 'reject' && 'is-on')}>
          <Field label="Reason for rejecting (required)" error={respErrors.rejReason}>
            <Select id="rt-rej-reason" options={REJECT_REASONS} value={rejReason} onChange={(e) => setRejReason(e.target.value)} onFocus={() => setDecision('reject')} />
          </Field>
          <Field label="Explanation shown to the customer (required)" error={respErrors.rejText}>
            <Textarea id="rt-rej-text" placeholder="Explain which term applies and what the customer can do next." value={rejText} onChange={(e) => setRejText(e.target.value)} onFocus={() => setDecision('reject')} />
          </Field>
        </div>
      </div>
      <div className="card-foot">
        <Button variant="secondary" onClick={() => submitResponse('info')} disabled={!!responded}>
          Request information
        </Button>
        {decision === 'reject' ? (
          <Button variant="danger" icon="x" onClick={() => submitResponse('reject')} disabled={!!responded}>
            Reject return
          </Button>
        ) : (
          <Button icon="check" onClick={() => submitResponse('approve')} disabled={!!responded}>
            {noReturn ? 'Approve refund without return' : 'Approve and send label'}
          </Button>
        )}
      </div>
    </section>
  );

  const requestCard = (H: 'h2' | 'h3') => (
    <Card title="Customer’s request" titleAs={H} sub="Submitted with the return form">
      <div className="row gap-2">
        <Badge tone="warning" icon="zap-off">
          Defective
        </Badge>
        <Badge tone="outline">Wants: refund to original payment</Badge>
      </div>
      <p className="sb-quote">“Works for about five minutes, then the sound cuts out and it disconnects from my phone. Tried two phones and a full charge. Same thing every time.”</p>
      <div className="sb-photos">
        {PHOTOS.map((p) => (
          <figure key={p.cap}>
            <Img icon={p.icon} tint={p.tint} className="r43" />
            <figcaption>{p.cap}</figcaption>
          </figure>
        ))}
      </div>
      <span className="xs muted">3 photos · uploaded Oct 5, 4:10 PM</span>
    </Card>
  );

  const inspectCards = (
    <>
      <Card title="Return shipment" sub="Tracked separately from the original delivery">
        <KeyValue
          pairs={[
            ['Carrier', 'USPS Ground Advantage, prepaid label'],
            ['Tracking', <span className="mono">9202 1901 2475 3381 0049 17</span>],
            ['Label cost', '$8.45 (you pay, defective item)'],
            ['Delivered to', 'Northwind Audio Returns, Portland, OR 97214'],
          ]}
        />
        <Events events={SHIPMENT_EVENTS} />
      </Card>
      <Card title="Inspection outcome" titleAs="h3" sub="Record what arrived before you decide the refund">
        <fieldset className="stack gap-2 fieldset-reset">
          <legend className="label" style={{ marginBottom: 6 }}>
            Condition on arrival
          </legend>
          <OptionCard id="rt-cond-ok" name="rt-cond" title={<span className="strong small">As described by the customer</span>} body="Defect confirmed: audio drops after 4–6 minutes on battery." checked={cond === 'ok'} onChange={() => setCond('ok')} />
          <OptionCard id="rt-cond-dmg" name="rt-cond" title={<span className="strong small">Damaged by the customer</span>} body="Physical damage not reported in the request. Add photos." checked={cond === 'dmg'} onChange={() => (setCond('dmg'), setRefundKind('part'))} />
          <OptionCard id="rt-cond-miss" name="rt-cond" title={<span className="strong small">Missing parts</span>} body="Choose what is missing so a partial refund can be explained." checked={cond === 'miss'} onChange={() => (setCond('miss'), setRefundKind('part'))} />
        </fieldset>
        <div className="sb-form-grid">
          <Field label="Inspection notes" optional>
            <Textarea id="rt-insp-notes" placeholder="" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <Field label="Stock outcome" hint={STOCK_HINT[stock]}>
            <Select id="rt-stock" options={STOCK} value={stock} onChange={(e) => setStock(e.target.value)} />
          </Field>
        </div>
        <Drop title="Add inspection photos" hint="Optional, JPG or PNG up to 10 MB. Kept with the case if the customer disputes it." accept="image/jpeg,image/png" onFiles={(f) => setInspPhotos((p) => [...p, ...fileItems(f)])} />
        <FileList files={inspPhotos} />
      </Card>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h3 className="h4">Refund decision</h3>
            <span className="xs muted">
              Refundable now: {money(refunded === null ? PAID : PAID - refunded)} of {money(PAID)}
            </span>
          </div>
        </div>
        <div className="card-body">
          {refunded !== null && (
            <Alert tone="success" title={`Refund of ${money(refunded)} is Processing`}>
              It shows as Sent once the card network confirms it. Stock outcome recorded: {stock}.
            </Alert>
          )}
          <OptionCard
            id="rt-ref-full"
            name="rt-ref"
            title={
              <span className="row between">
                <span className="strong small">Full refund</span>
                <span className="num strong">{money(PAID)}</span>
              </span>
            }
            body="Item value. Original shipping was free."
            checked={refundKind === 'full'}
            onChange={() => setRefundKind('full')}
          />
          <OptionCard id="rt-ref-part" name="rt-ref" title={<span className="strong small">Partial refund</span>} body="Only with a recorded reason, for example missing parts or damage caused after delivery." checked={refundKind === 'part'} onChange={() => setRefundKind('part')} />
          <div className="sb-form-grid">
            <div className="field">
              <label className="label" htmlFor="rt-ref-amt">
                Partial amount
              </label>
              <span className="input-group">
                <span className="affix">$</span>
                <input
                  className={cx('input', amtErr && 'is-error')}
                  id="rt-ref-amt"
                  type="text"
                  inputMode="decimal"
                  value={partAmt}
                  placeholder="0.00"
                  aria-invalid={amtErr ? true : undefined}
                  aria-describedby={amtErr ? 'rt-ref-amt-err' : 'rt-ref-amt-hint'}
                  onChange={(e) => setPartAmt(e.target.value)}
                  onFocus={() => setRefundKind('part')}
                />
              </span>
              {amtErr ? (
                <span className="error-text" id="rt-ref-amt-err">
                  <Icon name="circle-alert" className="ic-sm" />
                  {amtErr}
                </span>
              ) : (
                <span className="hint" id="rt-ref-amt-hint">
                  Up to {money(PAID)}. You can't refund more than the customer paid.
                </span>
              )}
            </div>
            <Field label="Explanation for the customer (required for partial)" error={whyErr}>
              <Textarea id="rt-ref-why" placeholder="Example: Charging cable was not returned. Deducted $6.00, the replacement cost." value={partWhy} onChange={(e) => setPartWhy(e.target.value)} />
            </Field>
          </div>
          <Alert tone="info" title="What the customer sees">
            After you confirm, the refund shows as Processing until the card network confirms it, then Sent. We tell the customer it can take 3–5 business days to appear. We never show it as received before that.
          </Alert>
        </div>
        <div className="card-foot">
          <Button variant="ghost" onClick={() => announce('Inspection draft saved')} disabled={refunded !== null}>
            Save draft
          </Button>
          <Button icon="check" onClick={confirmRefund} disabled={refunded !== null}>
            {`Confirm inspection and refund ${money(refundKind === 'full' ? PAID : refundAmount)}`}
          </Button>
        </div>
      </section>
    </>
  );

  const respondCards = (
    <>
      {requestCard('h2')}
      <div className="grid lg2 gap-5">
        <Card title="Order item" titleAs="h3">
          <div className="row top gap-3">
            <Img icon="speaker" tint="2" className="thumb" />
            <div className="stack gap-1 grow">
              <span className="small strong">Halden Pocket Bluetooth Speaker</span>
              <span className="xs sub">
                Teal · <span className="mono">HAL-PKT-TEAL</span> · Qty 1 of 1
              </span>
              <span className="xs sub">Delivered Sep 29 · return window ends Oct 29</span>
            </div>
            <span className="num strong">{money(PAID)}</span>
          </div>
          <KeyValue
            pairs={[
              ['Paid by customer', '$59.00 item · $0.00 shipping · no discount'],
              ['Max refundable', '$59.00 (nothing refunded yet)'],
              ['Payment', 'Visa •••• 2290, refund goes back to this card'],
            ]}
          />
        </Card>
        <Card title="Policy that applies" titleAs="h3" sub="Terms accepted at purchase, Sep 26, 2026">
          <KeyValue
            pairs={[
              ['Your return terms', '30 days after delivery'],
              ['Reason category', 'Defective item'],
              [
                'Return shipping',
                <>
                  <b>You pay</b> (platform rule for defective, damaged or wrong items)
                </>,
              ],
              ['Remedy offered', 'Refund or replacement'],
              ['Respond by', 'Fri, Oct 9, 4:00 PM PT (2 business days, example)'],
            ]}
          />
          <p className="xs muted">Platform baseline: 30-day returns. You may offer more generous terms, not shorter ones.</p>
        </Card>
      </div>
      {decisionCard}
    </>
  );

  const msgNode = (m: Msg): ReactNode =>
    m.kind === 'note' ? (
      <span key={m.id} className="sb-sysnote">
        <Icon name={m.icon ?? 'clock'} className="ic-sm" />
        {m.text}
      </span>
    ) : (
      <div key={m.id} className={cx('sb-msg', m.kind === 'me' && 'me', m.kind === 'staff' && 'staff')}>
        <span className="who">
          {m.who}
          {m.kind === 'staff' && (
            <Badge tone="info" icon="shield">
              Marketly
            </Badge>
          )}
          <span className="when">{m.when}</span>
        </span>
        <span>{m.text}</span>
      </div>
    );

  return (
    <SellerLayout active="returns">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Returns and cases', to: href('seller/returns') }, { label: 'RT-261005-0912' }]} />
          <h1 className="h1">
            Return <span className="mono">RT-261005-0912</span>
          </h1>
          <p className="sub small">
            Order{' '}
            <Link className="mono" to={href('seller/order')}>
              MK-260926-31840
            </Link>{' '}
            · requested Oct 5, 2026, 4:12 PM PT by Dana W. · reason: Defective
          </p>
        </div>
        <div className="actions">
          <StatusBadge status={status} />
        </div>
      </div>
      <div className="sb-main">
        <div className="stack gap-5">
          <ReturnSteps current={step} />
          {inspect ? inspectCards : respondCards}
          {inspect && requestCard('h3')}
          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h3 className="h4">Messages and evidence</h3>
                <span className="xs muted">{inspect ? 'Customer, you and Marketly support · kept with this case' : 'Customer and you · Marketly support joins if the case is escalated'}</span>
              </div>
            </div>
            <div className="card-body">
              <div className="sb-thread" aria-live="polite">
                {msgs.map(msgNode)}
              </div>
              <Field label="Reply" hint={replyErr ? undefined : 'Messages stay private to this order. Don’t share personal contact details or links outside Marketly.'} error={replyErr}>
                <Textarea id="rt-reply" placeholder={inspect ? 'Reply to the customer and Marketly support' : 'Write to the customer'} value={reply} onChange={(e) => (setReply(e.target.value), setReplyErr(''))} />
              </Field>
              <div className="stack gap-2">
                <span className="label">Dispute evidence</span>
                <span className="xs muted">If the customer disputes your decision, support reviews purchase terms, shipment records, photos and these messages. Add files now so they are on record.</span>
                <Drop title="Upload evidence" hint="Photos, test videos, invoices or carrier records · PDF, JPG, PNG, MP4 up to 25 MB" accept="application/pdf,image/jpeg,image/png,video/mp4" onFiles={addEvidence} />
                <FileList files={inspect ? inspectEvidence : evidence} />
              </div>
            </div>
            <div className="card-foot">
              <input ref={attachRef} type="file" hidden multiple onChange={(e) => addEvidence(Array.from(e.target.files ?? []))} />
              <Button variant="ghost" icon="paperclip" onClick={() => attachRef.current?.click()}>
                Attach file
              </Button>
              <Button variant="secondary" icon="send" onClick={send}>
                Send message
              </Button>
            </div>
          </section>
        </div>
        <div className="stack gap-5">
          {inspect ? (
            <Alert tone="info" title="Inspect and refund by Sat, Oct 10, 10:20 AM PT">
              Received Oct 8, 10:20 AM. Example target: 2 days after receipt. Marketly support may step in if this passes.
            </Alert>
          ) : (
            <Alert tone="warning" title="Respond by Fri, Oct 9, 4:00 PM PT">
              <Deadline tone="warning">1 day 6 h left</Deadline>
              <br />
              If you miss the deadline, Marketly support may decide the return for you, and it counts as an unresolved case in Account health.
            </Alert>
          )}
          <section className="card">
            <div className="card-body">
              <div className="sb-impact">
                <div className="row between">
                  <span className="small strong">Effect on your earnings</span>
                  {!inspect && <Badge tone="outline">Example</Badge>}
                </div>
                <div className="flow">
                  <div>
                    <span className="xs muted">Refund to customer</span>
                    <b>{money(impactRefund)}</b>
                  </div>
                  <div>
                    <span className="xs muted">Your earnings</span>
                    <b className="sb-neg">{neg(earn)}</b>
                  </div>
                  <div>
                    <span className="xs muted">Marketplace fee refunded to you</span>
                    <b>{money(fee)}</b>
                  </div>
                </div>
                {labelCost > 0 && responded !== 'reject' && <SummaryRow k="Prepaid return label (you pay, defective item)" v={<span className="sb-neg">{neg(labelCost)}</span>} />}
                <SummaryRow className="strong" k="Total change to your balance" v={<b className="sb-neg">{neg(total)}</b>} />
                <span className="xs muted">
                  Refund {money(impactRefund)} → your earnings {neg(earn)}, fee refunded {money(fee)}.{' '}
                  {inspect ? 'Commission rate 10% (example rate).' : 'Example rate of 10%. Final fees are in the seller agreement.'} If this order was already paid out, the amount is deducted from your next payout.
                </span>
              </div>
            </div>
          </section>
          <Card title="Customer" titleAs="h3">
            <div className="row gap-3">
              <Avatar name="Dana W." />
              <div className="stack gap-0">
                <span className="small strong">Dana W.</span>
                <span className="xs muted">Seattle, WA · 4 orders with you</span>
              </div>
            </div>
            <p className="xs muted">Contact details stay private. Use the case messages.</p>
          </Card>
          <Card title="Activity" titleAs="h3">
            <Events events={events} />
          </Card>
        </div>
      </div>
    </SellerLayout>
  );
}
