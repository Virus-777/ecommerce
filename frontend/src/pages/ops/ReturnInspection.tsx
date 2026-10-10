import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { OpsLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { money } from '@/lib/format';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, Breadcrumbs, Button, Card, Checkbox, Deadline, Field, Icon, Img, KeyValue, OptionCard, PageHeader, Stat, StatusBadge, SummaryRow, TableWrap, Tabs, Textarea, Timeline, announce, type TimelineEvent } from '@/ui';
import { CONDITIONS, DESIGN_INSPECTION, RETURNS, newInspection, type Condition, type Inspection, type Outcome, type ReturnRow, type ReturnStage } from './data/returns';
import { BeforeAfter, EDGE_RISK, EDGE_URGENT, OpsLegend } from './data/shared';

// Design: pages/ops/ops-return-inspection.html (queue) · view "inspecting-rt-261005-0212" = the
// inspection bench for RT-261005-0212 (like new, carry case missing, sell as Used – Like new).
// Other returns open the same bench with ?view=inspecting&rt=<return>.

const DESIGN_VIEW = 'inspecting-rt-261005-0212';
const DESIGN_RT = 'RT-261005-0212';
type View = typeof DESIGN_VIEW | 'inspecting';
type Tab = 'received' | 'arriving' | 'decided';

/** Items in each tab that are not on this page. */
const HIDDEN: Record<Tab, number> = { received: 0, arriving: 6, decided: 17 };
const TAB_STAGES: Record<Tab, ReturnStage[]> = {
  // The Received tab is the design's working queue: everything at the bench plus the next arrival.
  received: ['received', 'decided', 'arriving'],
  arriving: ['arriving'],
  decided: ['decided'],
};

const inspectHref = (rt: string) => (rt === DESIGN_RT ? href('ops/return-inspection', DESIGN_VIEW) : href('ops/return-inspection', 'inspecting', undefined, { rt }));

/* ---------------- Queue ---------------- */

function Queue({ rows }: { rows: ReturnRow[] }) {
  const [tab, setTab] = useState<Tab>('received');
  const list = rows.filter((r) => TAB_STAGES[tab].includes(r.stage));
  const n = (s: ReturnStage) => rows.filter((r) => r.stage === s).length;
  const waiting = rows.filter((r) => r.stage === 'received' && r.status !== 'Decision made').length;
  const overdue = rows.filter((r) => r.edge === 'flagged' && r.stage === 'received');
  const legend = [
    ...(list.some((r) => r.edge === 'flagged') ? [{ tone: 'danger' as const, label: EDGE_URGENT }] : []),
    ...(list.some((r) => r.edge === 'warn') ? [{ tone: 'warning' as const, label: EDGE_RISK }] : []),
  ];

  const action = (r: ReturnRow) => {
    if (r.stage !== 'received') return null;
    const cont = r.status === 'Inspecting';
    return (
      <Link className={cx('btn btn-sm', cont ? 'btn-primary' : 'btn-secondary')} to={inspectHref(r.rt)}>
        <span>{cont ? 'Continue' : 'Inspect'}</span>
        <span className="sr-only"> {r.rt}</span>
      </Link>
    );
  };

  return (
    <>
      <PageHeader
        title="Return inspection"
        sub="Official Store returns received at Reno, NV. Warehouse inspects, Inventory records the stock outcome, Finance approves the refund."
        actions={
          <Button variant="secondary" size="sm" icon="download">
            Export
          </Button>
        }
      />
      <div className="ac-kpis">
        <div className="card pad">
          <Stat label="Waiting for inspection" value={String(waiting)} note="target 2 business days" />
        </div>
        <div className="card pad">
          <Stat label="Overdue" value={String(overdue.length)} note={overdue[0]?.rt ?? 'none'} />
        </div>
        <div className="card pad">
          <Stat label="Arriving this week" value={String(n('arriving') + HIDDEN.arriving)} note="tracked separately from deliveries" />
        </div>
        <div className="card pad">
          <Stat label="Refunds with Finance" value="3" note="$412.00 proposed" />
        </div>
      </div>
      <Tabs
        items={[
          { label: 'Received', value: 'received', count: rows.filter((r) => r.stage !== 'arriving').length },
          { label: 'Arriving', value: 'arriving', count: n('arriving') + HIDDEN.arriving },
          { label: 'Decided this week', value: 'decided', count: n('decided') + HIDDEN.decided },
        ]}
        active={tab}
        onChange={setTab}
      />
      <Card title="Return queue" flush>
        <div className="no-phone">
          <TableWrap label="Return queue table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Return</th>
                  <th scope="col">Item</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Received</th>
                  <th scope="col">Inspector</th>
                  <th scope="col">Status</th>
                  <th scope="col">Target</th>
                  <th className="col-pin" scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.rt} className={cx(r.edge === 'flagged' && 'is-flagged', r.edge === 'warn' && 'is-warn')}>
                    <td>
                      {r.edge === 'flagged' && <span className="sr-only">Urgent: </span>}
                      {r.edge === 'warn' && <span className="sr-only">At risk: </span>}
                      <span className="stack gap-0">
                        {r.stage === 'received' ? (
                          <Link className="mono nowrap" to={inspectHref(r.rt)} title={r.rt}>
                            {r.rt}
                          </Link>
                        ) : (
                          <a className="mono nowrap" href="#" title={r.rt}>
                            {r.rt}
                          </a>
                        )}
                        <span className="xs mono muted nowrap" title={r.order}>
                          {r.order}
                        </span>
                      </span>
                    </td>
                    <td>
                      <div className="cell-main">
                        <Img icon={r.icon} tint={r.tint} className="tiny" />
                        <span className="small">{r.item}</span>
                      </div>
                    </td>
                    <td>
                      <span className="small">{r.reason}</span>
                    </td>
                    <td>
                      <span className="small nowrap">{r.received}</span>
                    </td>
                    <td>
                      <span className="small nowrap">{r.inspector}</span>
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td>
                      <Deadline tone={r.target.tone}>{r.target.text}</Deadline>
                    </td>
                    <td className="col-pin">{action(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          {legend.length > 0 && <OpsLegend items={legend} />}
        </div>
        <div className="ac-mlist only-phone">
          {list.map((r) => (
            <div key={r.rt} className={cx('ac-mi', r.edge === 'flagged' && 'is-flagged', r.edge === 'warn' && 'is-warn')}>
              {r.edge === 'flagged' && <span className="sr-only">Urgent: </span>}
              {r.edge === 'warn' && <span className="sr-only">At risk: </span>}
              <div className="row between gap-2 nowrap top">
                <span className="small strong min-w-0">
                  {r.stage === 'received' ? (
                    <Link className="mono nowrap" to={inspectHref(r.rt)}>
                      {r.rt}
                    </Link>
                  ) : (
                    <span className="mono nowrap">{r.rt}</span>
                  )}
                </span>
                <StatusBadge status={r.status} />
              </div>
              <div className="xs sub">{r.item}</div>
              <div className="xs sub">
                {r.reason} · received {r.received}
              </div>
              <div className="xs sub">
                <Deadline tone={r.target.tone}>{r.target.text}</Deadline>
              </div>
            </div>
          ))}
        </div>
        {legend.length > 0 && <OpsLegend className="only-phone" items={legend} />}
      </Card>
    </>
  );
}

/* ---------------- Inspection bench ---------------- */

const OUTCOMES: Array<{ id: Outcome; title: string; body: (i: Inspection, price: string) => string }> = [
  { id: 'restock', title: 'Restock as new', body: () => 'Only for sealed, unused items' },
  { id: 'repair', title: 'Repair', body: (i) => `Send to ${i.brand} service partner, ${i.serviceDays} business days` },
  { id: 'regrade', title: 'Sell as different condition', body: (i, p) => `Used – Like new offer ${i.sku}-LN at ${p}` },
  { id: 'supplier', title: 'Return to supplier', body: (i) => `${i.supplier}, return authorization needed` },
  { id: 'writeoff', title: 'Write off', body: () => 'Not sellable. Records the cost as a return loss.' },
];

const grade = (c: Condition | '') => (c === 'good' ? { label: 'Used – Good', suffix: 'GD', factor: 0.75 } : { label: 'Used – Like new', suffix: 'LN', factor: 0.84 });

function outcomeDisabled(o: Outcome, c: Condition | '') {
  if (o === 'restock') return c !== 'new';
  if (o === 'regrade') return c === 'damaged' || c === 'new';
  return false;
}

function stockMovement(i: Inspection): { to: string; sku: string } | null {
  const g = grade(i.condition);
  switch (i.outcome) {
    case 'restock':
      return { to: 'Available · New', sku: i.sku };
    case 'regrade':
      return { to: `Available · ${g.label}`, sku: `${i.sku}-${g.suffix}` };
    case 'repair':
      return { to: 'Damaged or held · at repair partner', sku: i.sku };
    case 'supplier':
      return { to: 'Damaged or held · return to supplier', sku: i.sku };
    case 'writeoff':
      return { to: 'Removed · return loss', sku: i.sku };
    default:
      return null;
  }
}

function Bench({ row, initial, onSave, onSent }: { row: ReturnRow; initial: Inspection; onSave: (i: Inspection) => void; onSent: (i: Inspection, refund: number) => void }) {
  const [ins, setIns] = useState(initial);
  const [tried, setTried] = useState(false);
  const [sent, setSent] = useState(row.status === 'Decision made');
  const [saved, setSaved] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = <K extends keyof Inspection>(k: K, v: Inspection[K]) => {
    setSaved(false);
    setIns((x) => ({ ...x, [k]: v }));
  };
  const chooseCondition = (c: Condition) => {
    setSaved(false);
    setIns((x) => ({ ...x, condition: c, outcome: x.outcome && outcomeDisabled(x.outcome, c) ? '' : x.outcome }));
  };

  const missing = ins.checks.filter((c) => c.part && !c.ok && c.part.value > 0);
  const failed = ins.checks.filter((c) => !c.part && !c.ok);
  const deduction = missing.reduce((a, c) => a + (c.part?.value ?? 0), 0);
  const refund = Math.max(0, row.price - deduction - row.labelCost);
  const regradePrice = money(Math.round(row.price * grade(ins.condition).factor));
  const move = stockMovement(ins);

  const errors = {
    photos: ins.photos.length === 0 ? 'Add at least one photo of the returned item.' : '',
    condition: !ins.condition ? 'Choose the condition of the item.' : '',
    outcome: !ins.outcome ? 'Propose an outcome for the Returns Manager.' : '',
    why: deduction > 0 && !ins.why.trim() ? 'Explain the deduction. The customer sees this reason.' : '',
  };
  const shown = tried ? errors : { photos: '', condition: '', outcome: '', why: '' };
  const nErrors = Object.values(errors).filter(Boolean).length;

  const send = () => {
    setTried(true);
    if (nErrors) return;
    setSent(true);
    onSent(ins, refund);
    announce(`Inspection sent to Finance. Proposed refund ${money(refund)}`);
  };
  const save = () => {
    onSave(ins);
    setSaved(true);
    announce('Inspection saved');
  };

  const events: TimelineEvent[] = [
    { t: 'Return requested', d: ins.requested.d, state: 'done', body: ins.requested.note },
    { t: 'Return approved', d: 'Oct 2 · automatic, within 30 days', state: 'done' },
    { t: 'Received at Reno, NV', d: ins.receivedAt, state: 'done' },
    { t: 'Inspection', d: `Today · ${row.inspector === 'Unassigned' ? 'Carlos Mendez' : row.inspector}`, state: sent ? 'done' : 'current' },
    { t: 'Refund decision', d: 'Finance · Priya Nair', state: sent ? 'current' : '' },
  ];

  const disabled = sent;

  return (
    <>
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Return inspection', to: href('ops/return-inspection') }, { label: row.rt }]} />
          <h1 className="h1">Inspecting {row.rt}</h1>
          <p className="sub small">
            Order {row.order} · {row.item} · reason: {row.reason} · received {row.received} by {row.inspector === 'Unassigned' ? 'Carlos Mendez' : row.inspector}
          </p>
        </div>
        <div className="actions">
          <StatusBadge status={sent ? 'Decision made' : 'Inspecting'} />
        </div>
      </div>
      {sent && (
        <Alert tone="success" title={`Sent to Finance: ${money(refund)} proposed refund`}>
          Priya Nair approves the refund. The customer sees "Refund under review" until then. <Link to={href('ops/return-inspection')}>Back to the return queue</Link>
        </Alert>
      )}
      {tried && nErrors > 0 && !sent && (
        <Alert tone="danger" title={`Finish ${nErrors} step${nErrors > 1 ? 's' : ''} before sending`}>
          {Object.values(errors).filter(Boolean).join(' ')}
        </Alert>
      )}
      <div className="ac-main">
        <div className="stack gap-5">
          <Card title="Photos" sub={`${ins.photos.length} taken at the inspection bench`}>
            {ins.photos.length > 0 && (
              <div className="ac-photos">
                {ins.photos.map((p, k) => (
                  <div key={`${p.label}-${k}`} className="ac-photo">
                    <Img icon={p.icon} tint={row.tint} />
                    <span className="xs muted">{p.label}</span>
                  </div>
                ))}
              </div>
            )}
            <div
              className="dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const files = Array.from(e.dataTransfer.files);
                if (files.length && !disabled) set('photos', [...ins.photos, ...files.map((f) => ({ label: f.name, icon: 'image' as const }))]);
              }}
            >
              <Icon name="image-plus" className="ic-lg" />
              <span className="small strong u-c-text">Add more photos</span>
              <span className="xs">JPG or PNG from the bench camera</span>
              <input
                ref={fileRef}
                type="file"
                hidden
                accept="image/jpeg,image/png"
                multiple
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length) set('photos', [...ins.photos, ...files.map((f) => ({ label: f.name, icon: 'image' as const }))]);
                  e.target.value = '';
                }}
              />
              <Button variant="secondary" size="sm" disabled={disabled} onClick={() => fileRef.current?.click()}>
                Browse files
              </Button>
            </div>
            {shown.photos && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                {shown.photos}
              </span>
            )}
          </Card>
          <Card title="Condition" titleAs="h3">
            <div className="grid md2 gap-2" role="radiogroup" aria-label="Condition">
              {CONDITIONS.map((c, k) => (
                <OptionCard key={c.id} id={`rq-c${k + 1}`} name="rq-cond" title={<span className="small strong">{c.title}</span>} body={c.body} checked={ins.condition === c.id} disabled={disabled} onChange={() => chooseCondition(c.id)} />
              ))}
            </div>
            {shown.condition && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                {shown.condition}
              </span>
            )}
            <span className="small strong">Contents and checks</span>
            <div className="ac-perm">
              {ins.checks.map((c, k) => (
                <Checkbox
                  key={c.label}
                  id={`rq-k${k + 1}`}
                  label={c.label}
                  checked={c.ok}
                  disabled={disabled}
                  onChange={(e) => set('checks', ins.checks.map((x, j) => (j === k ? { ...x, ok: e.target.checked } : x)))}
                />
              ))}
            </div>
            {missing.map((c) => (
              <Alert key={c.label} tone="warning" title={`Missing part: ${c.part!.name}`}>
                Customer did not mention it in the return request. Lena Park, Returns Manager, decides whether a deduction applies.
              </Alert>
            ))}
            {ins.condition && failed.length > 0 && (
              <Alert tone="danger" title={`Check not passed: ${failed.map((c) => c.label).join(', ')}`}>
                Record what you found in the photos. Choose Repair, Return to supplier or Write off unless the Returns Manager says otherwise.
              </Alert>
            )}
          </Card>
          <Card title="Outcome" titleAs="h3" sub="Proposed by the inspector, decided by the Returns Manager">
            <div className="stack gap-2" role="radiogroup" aria-label="Outcome">
              {OUTCOMES.map((o, k) => (
                <OptionCard
                  key={o.id}
                  id={`rq-o${k}`}
                  name="rq-out"
                  title={<span className="small strong">{o.title}</span>}
                  body={o.id === 'regrade' ? `${grade(ins.condition).label} offer ${ins.sku}-${grade(ins.condition).suffix} at ${regradePrice}` : o.body(ins, regradePrice)}
                  checked={ins.outcome === o.id}
                  disabled={disabled || outcomeDisabled(o.id, ins.condition)}
                  onChange={() => set('outcome', o.id)}
                />
              ))}
            </div>
            {shown.outcome && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                {shown.outcome}
              </span>
            )}
            {move && (
              <div className="well stack gap-2">
                <span className="small strong">Stock outcome, recorded by Inventory</span>
                <KeyValue
                  pairs={[
                    ['Movement', <BeforeAfter b="Returned · 1 unit" a={move.to} />],
                    [
                      'SKU',
                      <>
                        <span className="mono">{move.sku}</span> · bin {ins.bin}
                      </>,
                    ],
                    ['Recorded by', `Ana Silva, Inventory Manager · ${sent ? 'notified' : 'waiting'}`],
                  ]}
                />
              </div>
            )}
          </Card>
        </div>
        <div className="stack gap-5">
          <Card
            title="Proposed refund"
            titleAs="h3"
            sub="Sent to Finance for approval"
            foot={
              <>
                <Button variant="ghost" size="sm" onClick={save} disabled={disabled}>
                  {saved ? 'Saved' : 'Save inspection'}
                </Button>
                <Button size="sm" icon="send" onClick={send} disabled={disabled}>
                  {sent ? 'Sent to Finance' : 'Send to Finance'}
                </Button>
              </>
            }
          >
            <SummaryRow k="Item price" v={money(row.price)} />
            <SummaryRow k="Original shipping" v={money(0)} />
            {missing.map((c) => (
              <SummaryRow key={c.label} k={`Missing ${c.part!.name}`} v={`−${money(c.part!.value)}`} />
            ))}
            <SummaryRow k="Return shipping label (change of mind)" v={`−${money(row.labelCost)}`} />
            <div className="divider" />
            <SummaryRow className="total" k="Proposed refund" v={money(refund)} />
            {deduction > 0 && (
              <span className="xs muted row gap-1 nowrap wrap">
                <Icon name="info" className="ic-sm" />
                <span>Example deduction for missing accessories, per the returns policy.</span>
              </span>
            )}
            <Field label="Reason for deduction" error={shown.why || undefined}>
              <Textarea id="rq-why" value={ins.why} disabled={disabled} onChange={(e) => set('why', e.target.value)} />
            </Field>
            <div className="panel xs sub stack gap-1">
              <span>
                <Icon name="landmark" className="ic-sm" /> Finance approver: <b>Priya Nair</b>, refunds up to $2,000
              </span>
              <span>Refund to {ins.payment} within 5 business days after approval.</span>
            </div>
            <Alert tone="info" title="Approved is not paid">
              The customer sees "Refund under review" now, "Approved" after Finance, and "Sent" only when the payment provider confirms.
            </Alert>
          </Card>
          <Card title="Return record" titleAs="h3">
            <Timeline events={events} />
          </Card>
        </div>
      </div>
    </>
  );
}

export default function ReturnInspection() {
  const [view] = useView<View>();
  const [params] = useSearchParams();
  const [rows, setRows] = useState(RETURNS);
  const [drafts, setDrafts] = useState<Record<string, Inspection>>({ [DESIGN_RT]: DESIGN_INSPECTION });

  const rt = view === DESIGN_VIEW ? DESIGN_RT : view === 'inspecting' ? params.get('rt') : null;
  const row = rt ? rows.find((r) => r.rt === rt && r.stage !== 'arriving') : undefined;

  const save = (r: ReturnRow, i: Inspection) => {
    setDrafts((d) => ({ ...d, [r.rt]: i }));
    setRows((rs) => rs.map((x) => (x.rt === r.rt && x.status === 'Returned' ? { ...x, status: 'Inspecting', inspector: x.inspector === 'Unassigned' ? 'Carlos Mendez' : x.inspector } : x)));
  };
  const sent = (r: ReturnRow, i: Inspection) => {
    setDrafts((d) => ({ ...d, [r.rt]: i }));
    setRows((rs) => rs.map((x) => (x.rt === r.rt ? { ...x, status: 'Decision made', stage: 'decided', edge: '', target: { tone: 'ok', text: 'Refund with Finance' }, inspector: x.inspector === 'Unassigned' ? 'Carlos Mendez' : x.inspector } : x)));
  };

  return (
    <OpsLayout active="return-inspection">
      {row ? (
        <Bench key={row.rt} row={row} initial={drafts[row.rt] ?? newInspection(row)} onSave={(i) => save(row, i)} onSent={(i) => sent(row, i)} />
      ) : (
        <>
          {rt && <Alert tone="warning" title={`${rt} is not at the inspection bench`}>It has not been received yet, or the return number is wrong.</Alert>}
          <Queue rows={rows} />
        </>
      )}
    </OpsLayout>
  );
}
