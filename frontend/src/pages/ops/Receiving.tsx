import { Fragment, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { OpsLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { num } from '@/lib/format';
import { useScrollRegion, useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, Badge, Breadcrumbs, Button, Card, Checkbox, Field, Icon, Img, KeyValue, PageHeader, Stat, StatusBadge, SummaryRow, TableWrap, Tabs, Textarea, TextInput, announce, type IconName, type Tone } from '@/ui';
import type { Tint } from '@/data/fixtures';
import { EDGE_RISK, EDGE_URGENT, OpsLegend } from './data/shared';

// Design: pages/ops/ops-receiving.html (Expected list) · view "receiving-pur-2610-0042" = receiving
// PUR-2610-0042 at step 3 "Record issues" (Black short 2, Silver 3 damaged, Teal matches).

const PO_VIEW = 'receiving-pur-2610-0042';
type Stage = 'expected' | 'arrived' | 'issues' | 'completed';
type Tab = 'expected' | 'receiving' | 'issues' | 'completed';

interface Delivery {
  po: string;
  supplier: string;
  expected: string;
  carrier: string;
  lines: number;
  units: number;
  status: string;
  tone: Tone;
  stage: Stage;
  late?: boolean;
}

const DELIVERIES: Delivery[] = [
  { po: 'PUR-2610-0042', supplier: 'Halden Audio Distribution', expected: 'Today, 10:00 AM – 12:00 PM', carrier: 'Freight · 2 pallets', lines: 3, units: 260, status: 'Arrived, dock 2', tone: 'info', stage: 'arrived' },
  { po: 'PUR-2610-0045', supplier: 'Pellar Cookware Co.', expected: 'Today, 1:00 – 3:00 PM', carrier: 'UPS Freight · PRO 482-119-5530', lines: 2, units: 120, status: 'Incoming', tone: '', stage: 'expected' },
  { po: 'PUR-2610-0047', supplier: 'Mosswood Home Goods', expected: 'Today, 3:00 – 5:00 PM', carrier: 'FedEx Freight · 1 pallet', lines: 4, units: 180, status: 'Delayed', tone: 'warning', stage: 'expected', late: true },
  { po: 'PUR-2610-0036', supplier: 'Nordvik Knitwear', expected: 'Mon, Oct 12', carrier: 'UPS Ground · 6 cartons', lines: 2, units: 40, status: 'Incoming', tone: '', stage: 'expected' },
  { po: 'PUR-2610-0039', supplier: 'Pellar Cookware Co.', expected: 'Received Oct 7', carrier: 'Shortage 4, damaged 2', lines: 1, units: 120, status: 'Received with issues', tone: 'warning', stage: 'issues', late: true },
  { po: 'PUR-2610-0031', supplier: 'Aster Skincare Labs', expected: 'Received Oct 6', carrier: 'UPS Ground · 4 cartons', lines: 1, units: 120, status: 'Completed', tone: 'success', stage: 'completed' },
  { po: 'PUR-2610-0028', supplier: 'Brightline Lighting', expected: 'Received Oct 5', carrier: 'FedEx Freight · 1 pallet', lines: 2, units: 60, status: 'Completed', tone: 'success', stage: 'completed' },
];

const TAB_STAGES: Record<Tab, Stage[]> = {
  // The Expected tab lists every open delivery, the design's default table.
  expected: ['arrived', 'expected', 'issues'],
  receiving: ['arrived'],
  issues: ['issues'],
  completed: ['completed'],
};

interface Line {
  sku: string;
  name: string;
  icon: IconName;
  tint: Tint;
  expected: number;
  received: number;
  damaged: number;
  bin: string;
  photos: string[];
}

const LINES: Line[] = [
  { sku: 'HAL-AUR-BLK', name: 'Halden Aurora ANC Headphones, Black', icon: 'headphones', tint: '2', expected: 120, received: 118, damaged: 0, bin: 'A-03-2', photos: [] },
  { sku: 'HAL-AUR-SLV', name: 'Halden Aurora ANC Headphones, Silver', icon: 'headphones', tint: '2', expected: 80, received: 80, damaged: 3, bin: 'A-03-4', photos: ['Crushed carton', 'Cracked headband', 'Dented case'] },
  { sku: 'HAL-PKT-TEAL', name: 'Halden Pocket Bluetooth Speaker, Teal', icon: 'speaker', tint: '2', expected: 60, received: 60, damaged: 0, bin: 'B-11-1', photos: [] },
];

const STEPS = ['Check in', 'Count lines', 'Record issues', 'Put away', 'Make available'];

/** Progress steps with the design's "Step n of m" screen-reader text on the current step. */
function ReceivingSteps({ current }: { current: number }) {
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

function DeliveryList({ deliveries, notice }: { deliveries: Delivery[]; notice: string }) {
  const [tab, setTab] = useState<Tab>('expected');
  const rows = deliveries.filter((d) => TAB_STAGES[tab].includes(d.stage));
  const count = (s: Stage[]) => deliveries.filter((d) => s.includes(d.stage)).length;
  const subs: Record<Tab, string> = {
    expected: 'Expected arrivals from Purchasing',
    receiving: 'Deliveries being counted at the dock',
    issues: 'Shortages and damage waiting on Purchasing',
    completed: 'Received and made available',
  };
  const poLink = (d: Delivery, cls = 'mono nowrap') =>
    d.po === 'PUR-2610-0042' && d.stage === 'arrived' ? (
      <Link className={cls} to={href('ops/receiving', PO_VIEW)} title={d.po}>
        {d.po}
      </Link>
    ) : (
      <a className={cls} href="#" title={d.po}>
        {d.po}
      </a>
    );

  return (
    <>
      <PageHeader
        title="Receiving"
        sub="Inbound purchase deliveries · Reno, NV · Purchasing orders, Warehouse receives, Inventory confirms what can be sold"
        actions={
          <Button variant="secondary" size="sm" icon="download">
            Export
          </Button>
        }
      />
      {notice && <Alert tone="success" title={notice} />}
      <div className="ac-kpis">
        <div className="card pad">
          <Stat label="Expected today" value="3" note="560 units" />
        </div>
        <div className="card pad">
          <Stat label="Arrived, not received" value={String(count(['arrived']))} note={count(['arrived']) ? 'PUR-2610-0042 at dock 2' : 'Dock clear'} />
        </div>
        <div className="card pad">
          <Stat label="Received this week" value="9" note="1,420 units" />
        </div>
        <div className="card pad">
          <Stat label="Open shortages" value={String(count(['issues']) + 1)} note="with Ken Watanabe" />
        </div>
      </div>
      <Tabs
        items={[
          { label: 'Expected', value: 'expected', count: count(['arrived', 'expected']) },
          { label: 'Receiving', value: 'receiving', count: count(['arrived']) },
          { label: 'Received with issues', value: 'issues', count: count(['issues']) },
          { label: 'Completed', value: 'completed' },
        ]}
        active={tab}
        onChange={setTab}
      />
      <Card title="Purchase deliveries" sub={subs[tab]} flush>
        <div className="no-phone">
          <TableWrap label="Purchase deliveries table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Purchase order</th>
                  <th scope="col">Supplier</th>
                  <th scope="col">Expected</th>
                  <th scope="col">Carrier</th>
                  <th className="r" scope="col">Lines</th>
                  <th className="r" scope="col">Units</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.po} className={cx(d.late && 'is-warn')}>
                    <td>
                      {d.late && <span className="sr-only">At risk: </span>}
                      {poLink(d)}
                    </td>
                    <td>
                      <span className="small strong">{d.supplier}</span>
                    </td>
                    <td>
                      <span className="small nowrap">{d.expected}</span>
                    </td>
                    <td>
                      <span className="xs sub">{d.carrier}</span>
                    </td>
                    <td className="r">{d.lines}</td>
                    <td className="r">{d.units}</td>
                    <td>
                      <StatusBadge status={d.status} tone={d.tone} />
                    </td>
                    <td>
                      {d.stage === 'arrived' ? (
                        <Link className="btn btn-primary btn-sm" to={href('ops/receiving', PO_VIEW)}>
                          <span>Start receiving</span>
                          <span className="sr-only"> {d.po}</span>
                        </Link>
                      ) : (
                        <button type="button" className="btn btn-ghost btn-sm">
                          <span>View</span>
                          <span className="sr-only"> {d.po}</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <OpsLegend items={[{ tone: 'warning', label: EDGE_RISK }]} />
        </div>
        <div className="ac-mlist only-phone">
          {rows.map((d) => (
            <div key={d.po} className={cx('ac-mi', d.late && 'is-warn')}>
              {d.late && <span className="sr-only">At risk: </span>}
              <div className="row between gap-2 nowrap top">
                <span className="small strong min-w-0">{poLink(d)}</span>
                <StatusBadge status={d.status} tone={d.tone} />
              </div>
              <div className="xs sub">
                {d.supplier} · {d.lines} lines · {d.units} units
              </div>
              <div className="xs sub">{d.expected}</div>
              <div className="xs sub">{d.carrier}</div>
              {d.stage === 'arrived' && (
                <div className="row gap-2 mt-1-5">
                  <Link className="btn btn-primary btn-sm" to={href('ops/receiving', PO_VIEW)}>
                    <span>Start receiving</span>
                  </Link>
                </div>
              )}
            </div>
          ))}
        </div>
        <OpsLegend className="only-phone" items={[{ tone: 'warning', label: EDGE_RISK }]} />
      </Card>
      <div className="grid lg2 gap-5">
        <Alert tone="warning" title="PUR-2610-0047 running late">
          FedEx Freight moved delivery to Fri, Oct 9. Ken Watanabe, Purchasing Manager, updated the expected date. 2 Mosswood SKUs stay in Incoming until then.
        </Alert>
        <Card title="Who does what" titleAs="h3">
          <KeyValue
            pairs={[
              ['Purchasing', 'Ken Watanabe orders stock and tracks arrival'],
              ['Warehouse', 'Carlos Mendez counts, records shortages and damage, puts away'],
              ['Inventory', 'Ana Silva confirms the sellable quantity'],
            ]}
          />
        </Card>
      </div>
    </>
  );
}

function LineBadge({ l }: { l: Line }) {
  const short = l.expected - l.received;
  if (l.damaged > 0)
    return (
      <Badge tone="danger" icon="circle-alert">
        {l.damaged} damaged
      </Badge>
    );
  if (short > 0)
    return (
      <Badge tone="warning" icon="triangle-alert">
        Short {short}
      </Badge>
    );
  if (short < 0)
    return (
      <Badge tone="warning" icon="triangle-alert">
        Over {-short}
      </Badge>
    );
  return (
    <Badge tone="success" icon="check">
      Matches
    </Badge>
  );
}

function ReceivePo({ onFinish, onSaveLater }: { onFinish: (sellable: number, issues: boolean) => void; onSaveLater: () => void }) {
  const [lines, setLines] = useState(LINES);
  const [note, setNote] = useState('Pallet 2 outer wrap torn. 3 Silver units with crushed cartons photographed. Black count 118 confirmed by second count.');
  const [confirmed, setConfirmed] = useState(true);
  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const toInt = (v: string) => Math.max(0, Math.floor(Number(v) || 0));

  const expected = lines.reduce((a, l) => a + l.expected, 0);
  const received = lines.reduce((a, l) => a + l.received, 0);
  const damaged = lines.reduce((a, l) => a + Math.min(l.damaged, l.received), 0);
  const shortage = lines.reduce((a, l) => a + Math.max(0, l.expected - l.received), 0);
  const sellable = received - damaged;
  const missingPhotos = lines.filter((l) => l.damaged > 0 && l.photos.length === 0);
  const missingBins = lines.filter((l) => !l.bin.trim());
  const canFinish = confirmed && !missingPhotos.length && !missingBins.length && sellable > 0;

  const onScan = (e: FormEvent) => {
    e.preventDefault();
    const code = scan.trim().toUpperCase();
    if (!code) return;
    const i = lines.findIndex((l) => l.sku === code);
    if (i < 0) {
      setScanMsg({ ok: false, text: `${code} is not on PUR-2610-0042. Set the unit aside and tell Purchasing.` });
    } else {
      setLine(i, { received: lines[i].received + 1 });
      setScanMsg({ ok: true, text: `${code}: received ${lines[i].received + 1} of ${lines[i].expected}` });
    }
    announce(i < 0 ? `${code} is not on this purchase order` : `${code} counted`);
    setScan('');
  };

  const finish = () => {
    setTried(true);
    if (!canFinish) return;
    setDone(true);
    announce(`${sellable} units available for sale`);
    onFinish(sellable, shortage > 0 || damaged > 0);
  };

  return (
    <>
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Receiving', to: href('ops/receiving') }, { label: 'PUR-2610-0042' }]} />
          <h1 className="h1">Receiving PUR-2610-0042</h1>
          <p className="sub small">Halden Audio Distribution · ordered Sep 28 by Ken Watanabe · arrived 10:22 AM, dock 2 · received by Carlos Mendez</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="printer" onClick={() => window.print()}>
            Print labels
          </Button>
        </div>
      </div>
      <ReceivingSteps current={done ? STEPS.length : 2} />
      {done && (
        <Alert tone="success" title={`${sellable} units available for sale`}>
          Put away to the bins below. {shortage > 0 && `Purchasing has the ${shortage}-unit shortage claim. `}
          <Link to={href('ops/receiving')}>Back to Receiving</Link>
        </Alert>
      )}
      <div className="ac-main">
        <div className="stack gap-4">
          <div className="row between">
            <h2 className="h3">Lines</h2>
            <span className="xs muted">
              {lines.length} lines · {expected} expected · {received} received
            </span>
          </div>
          <form className="row gap-2" onSubmit={onScan}>
            <label className="sr-only" htmlFor="rc-scan">
              Scan or enter SKU
            </label>
            <TextInput id="rc-scan" icon="scan-barcode" placeholder="Scan or enter SKU to count 1 unit" value={scan} onChange={(e) => setScan(e.target.value)} disabled={done} autoComplete="off" />
            <Button type="submit" variant="secondary" size="sm" disabled={done}>
              Count
            </Button>
          </form>
          {scanMsg && (
            <span className={cx('xs', scanMsg.ok ? 'muted' : 't-danger-text')} role="status">
              {scanMsg.text}
            </span>
          )}
          <div className="ac-lines">
            {lines.map((l, i) => {
              const short = l.expected - l.received;
              const flagged = l.damaged > 0;
              const warn = !flagged && short !== 0;
              return (
                <article key={l.sku} className={cx('ac-line', flagged && 'is-flagged', warn && 'is-warn')}>
                  {flagged && <span className="sr-only">Urgent: </span>}
                  {warn && <span className="sr-only">At risk: </span>}
                  <div className="row gap-3 nowrap top">
                    <Img icon={l.icon} tint={l.tint} className="thumb" />
                    <span className="stack gap-0 grow">
                      <span className="small strong">{l.name}</span>
                      <span className="xs mono muted">{l.sku}</span>
                    </span>
                    <LineBadge l={l} />
                  </div>
                  <div className="ac-line-nums">
                    <div className="field">
                      <label className="label" htmlFor={`rc-exp-${i}`}>
                        Expected
                      </label>
                      <input className="input ac-qty" id={`rc-exp-${i}`} value={l.expected} readOnly />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor={`rc-rec-${i}`}>
                        Received
                      </label>
                      <input className="input ac-qty" id={`rc-rec-${i}`} type="number" min={0} value={l.received} disabled={done} onChange={(e) => setLine(i, { received: toInt(e.target.value) })} />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor={`rc-dmg-${i}`}>
                        Damaged
                      </label>
                      <input className={cx('input ac-qty', l.damaged > l.received && 'is-error')} id={`rc-dmg-${i}`} type="number" min={0} value={l.damaged} disabled={done} onChange={(e) => setLine(i, { damaged: toInt(e.target.value) })} />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor={`rc-loc-${i}`}>
                        Put-away bin
                      </label>
                      <input className={cx('input ac-loc', tried && !l.bin.trim() && 'is-error')} id={`rc-loc-${i}`} value={l.bin} disabled={done} onChange={(e) => setLine(i, { bin: e.target.value.toUpperCase() })} />
                    </div>
                  </div>
                  {short > 0 && (
                    <div className="panel xs sub row gap-2">
                      <Icon name="triangle-alert" className="ic-sm" />
                      <span>{short} units short. Purchasing is told automatically and raises a supplier claim. Shortage stays on the purchase record.</span>
                    </div>
                  )}
                  {short < 0 && (
                    <div className="panel xs sub row gap-2">
                      <Icon name="triangle-alert" className="ic-sm" />
                      <span>{-short} units more than ordered. Extra units stay in Incoming until Purchasing accepts them.</span>
                    </div>
                  )}
                  {l.damaged > 0 && (
                    <div className="stack gap-2">
                      <span className="xs strong">Damage photos (required)</span>
                      <div className="ac-photos">
                        {l.photos.map((p, k) => (
                          <div key={`${p}-${k}`} className="ac-photo">
                            <Img icon="image" tint={l.tint} />
                            <span className="xs muted">{p}</span>
                          </div>
                        ))}
                        <div className="ac-photo">
                          <Button variant="secondary" size="sm" block icon="camera" disabled={done} onClick={() => setLine(i, { photos: [...l.photos, `Photo ${l.photos.length + 1}`] })}>
                            Add photo
                          </Button>
                        </div>
                      </div>
                      {tried && l.photos.length === 0 ? (
                        <span className="error-text">
                          <Icon name="circle-alert" className="ic-sm" />
                          Add at least one photo of the damage.
                        </span>
                      ) : (
                        <span className="xs muted">Damaged units go to Damaged or held. They are not offered for sale.</span>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          <OpsLegend items={[{ tone: 'danger', label: EDGE_URGENT }, { tone: 'warning', label: EDGE_RISK }]} />
          <Field label="Receiving note" optional>
            <Textarea id="rc-note" value={note} onChange={(e) => setNote(e.target.value)} disabled={done} />
          </Field>
        </div>
        <div className="stack gap-5">
          <Card
            title="Make available for sale"
            titleAs="h3"
            sub="Inventory Manager confirms the sellable quantity"
            foot={
              done ? (
                <Button variant="secondary" size="sm" to={href('ops/receiving')}>
                  Back to Receiving
                </Button>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onClick={onSaveLater}>
                    Save and finish later
                  </Button>
                  <Button size="sm" icon="circle-check" onClick={finish} disabled={tried && !canFinish}>
                    Make {sellable} units available
                  </Button>
                </>
              )
            }
          >
            <SummaryRow k="Received" v={`${num(received)} units`} />
            <SummaryRow k="Damaged or held" v={`−${damaged} units`} />
            <SummaryRow k="Shortage reported to Purchasing" v={`${shortage} units`} />
            <div className="divider" />
            <div className="row between base">
              <span className="small strong">Sellable now</span>
              <span className="ac-big">{sellable}</span>
            </div>
            <KeyValue pairs={lines.map((l) => [l.sku, `${l.received - Math.min(l.damaged, l.received)} → bin ${l.bin || '—'}`])} />
            {done ? (
              <Alert tone="success" title="Available for sale">
                Customers can buy these units now. HAL-AUR-SLV waiting orders were allocated first.
              </Alert>
            ) : (
              <Alert tone="info" title="Stays in Incoming until confirmed">
                Customers cannot buy these units until Ana Silva confirms. HAL-AUR-SLV is out of stock now, so 6 waiting orders get allocated first.
              </Alert>
            )}
            <Checkbox id="rc-confirm" label="I counted and checked these units. Ana Silva, Inventory Manager" checked={confirmed} disabled={done} onChange={(e) => setConfirmed(e.target.checked)} />
            {tried && !canFinish && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                {!confirmed ? 'Confirm that you counted and checked these units.' : missingPhotos.length ? 'Add damage photos for every line with damaged units.' : missingBins.length ? 'Enter a put-away bin for every line.' : 'There are no sellable units to make available.'}
              </span>
            )}
          </Card>
          <Card title="Delivery record" titleAs="h3">
            <KeyValue
              pairs={[
                ['Supplier', 'Halden Audio Distribution'],
                ['Purchase order', <span className="mono">PUR-2610-0042</span>],
                ['Carrier', 'Freight · BOL 77120-4418'],
                ['Expected', 'Today 10:00 AM – 12:00 PM'],
                ['Arrived', '10:22 AM, dock 2'],
                ['Buying cost', '$23,540.00'],
              ]}
            />
          </Card>
        </div>
      </div>
    </>
  );
}

export default function Receiving() {
  const [view, setView] = useView<typeof PO_VIEW>();
  const [deliveries, setDeliveries] = useState(DELIVERIES);
  const [notice, setNotice] = useState('');

  const finish = (sellable: number, issues: boolean) =>
    setDeliveries((ds) =>
      ds.map((d) =>
        d.po === 'PUR-2610-0042'
          ? { ...d, stage: issues ? 'issues' : 'completed', status: issues ? 'Received with issues' : 'Completed', tone: issues ? 'warning' : 'success', late: issues, expected: 'Received today', carrier: `${sellable} units made available` }
          : d,
      ),
    );

  return (
    <OpsLayout active="receiving">
      {view === PO_VIEW ? (
        <ReceivePo
          onFinish={finish}
          onSaveLater={() => {
            setNotice('Saved. PUR-2610-0042 stays in Receiving until it is finished.');
            setView('');
          }}
        />
      ) : (
        <DeliveryList deliveries={deliveries} notice={notice} />
      )}
    </OpsLayout>
  );
}
