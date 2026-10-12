import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { Logo, OpsLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Breadcrumbs, Button, Card, Checkbox, Deadline, Field, Icon, Img, Meter, Select, SummaryRow, TextInput, announce, type IconName } from '@marketly/web-shared/ui';
import type { Tint } from '@marketly/web-shared/data/fixtures';

// Design: pages/ops/ops-pick-pack.html (pick list, wave 3) · view "packing-station" = packing
// station 2 with MK-261008-12544 (both items scanned, label created).

type View = 'packing-station';

/* ---------------- Pick list ---------------- */

type PickState = 'picked' | 'short' | 'damaged' | '';
interface PickItem {
  bin: string;
  sku: string;
  name: string;
  qty: number;
  picked: number;
  state: PickState;
  at?: string;
}
interface WaveOrder {
  ref: string;
  shipBy: string;
  tone: 'ok' | 'warning' | 'danger';
  items: PickItem[];
}

const WAVE: WaveOrder[] = [
  {
    ref: 'MK-261008-12544',
    shipBy: 'Ship by 2:00 PM',
    tone: 'warning',
    items: [
      { bin: 'A-03-2', sku: 'HAL-AUR-BLK', name: 'Halden Aurora ANC Headphones, Black', qty: 1, picked: 1, state: 'picked', at: '10:02 AM' },
      { bin: 'C-07-1', sku: 'MSW-PO-CRM', name: 'Mosswood Pour-over Coffee Set, Cream', qty: 1, picked: 0, state: '' },
    ],
  },
  { ref: 'MK-261008-12610', shipBy: 'Ship by 2:00 PM', tone: 'warning', items: [{ bin: 'D-02-3', sku: 'PLR-CI26', name: 'Pellar Cast Iron Skillet 26 cm', qty: 2, picked: 0, state: '' }] },
  {
    ref: 'MK-261008-12688',
    shipBy: 'Ship by 4:00 PM',
    tone: 'ok',
    items: [
      { bin: 'E-01-4', sku: 'AST-VC30', name: 'Aster Daily Vitamin C Serum 30 ml', qty: 1, picked: 0, state: '' },
      { bin: 'F-12-3', sku: 'NDV-MER-L-NVY', name: 'Nordvik Merino Crew, L, Navy', qty: 1, picked: 0, state: 'short' },
    ],
  },
  { ref: 'MK-261008-12702', shipBy: 'Ship by 4:00 PM', tone: 'ok', items: [{ bin: 'C-04-1', sku: 'BRL-LAMP-W', name: 'Brightline Smart LED Desk Lamp', qty: 1, picked: 0, state: '' }] },
];

/** Orders in wave 3 that are not on this page and already picked. */
const WAVE_TOTAL = 27;
const PICKED_ELSEWHERE = 11;

interface Report {
  tone: 'warning' | 'danger';
  title: string;
  body: string;
}
const FIRST_REPORT: Report = {
  tone: 'warning',
  title: 'Shortage reported on MK-261008-12688',
  body: 'Bin F-12-3 was empty for NDV-MER-L-NVY. Ana Silva is checking Returned stock. The order stays in the wave; do not pack it partly.',
};

const clock = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function Seg({ view }: { view: View | '' }) {
  return (
    <div className="seg" role="group">
      <Link to={href('ops/pick-pack')} className={cx(view === '' && 'is-active')} aria-current={view === '' ? 'page' : undefined}>
        Pick list
      </Link>
      <Link to={href('ops/pick-pack', 'packing-station')} className={cx(view === 'packing-station' && 'is-active')} aria-current={view === 'packing-station' ? 'page' : undefined}>
        Packing station
      </Link>
    </div>
  );
}

function PickList() {
  const [wave, setWave] = useState(WAVE);
  const [scan, setScan] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [report, setReport] = useState<Report>(FIRST_REPORT);

  const next = (() => {
    for (const o of wave) for (const it of o.items) if (!it.state) return { order: o.ref, sku: it.sku };
    return null;
  })();
  const nextItem = next && wave.find((o) => o.ref === next.order)!.items.find((i) => i.sku === next.sku)!;
  const orderDone = (o: WaveOrder) => o.items.every((i) => i.state === 'picked');
  const pickedOrders = PICKED_ELSEWHERE + wave.filter(orderDone).length;
  const pct = Math.round((pickedOrders / WAVE_TOTAL) * 100);

  const updateItem = (ref: string, sku: string, fn: (i: PickItem) => PickItem) => setWave((w) => w.map((o) => (o.ref === ref ? { ...o, items: o.items.map((i) => (i.sku === sku ? fn(i) : i)) } : o)));

  const pickOne = (ref: string, it: PickItem) => {
    const n = it.picked + 1;
    updateItem(ref, it.sku, (i) => ({ ...i, picked: n, ...(n >= i.qty ? { state: 'picked' as const, at: clock() } : {}) }));
    const text = n >= it.qty ? `${it.sku} picked for ${ref}` : `${it.sku}: ${n} of ${it.qty} picked. Scan the next unit.`;
    setMsg({ ok: true, text });
    announce(text);
  };

  const onScan = (e: FormEvent) => {
    e.preventDefault();
    const code = scan.trim().toUpperCase();
    setScan('');
    if (!code) return;
    // A bin or item barcode: prefer the next item, then any open item in the wave.
    const candidates = wave.flatMap((o) => o.items.filter((i) => !i.state).map((i) => ({ ref: o.ref, it: i })));
    const hit = candidates.find((c) => c.it.sku === next?.sku && c.ref === next?.order && (c.it.sku === code || c.it.bin === code)) ?? candidates.find((c) => c.it.sku === code || c.it.bin === code);
    if (!hit) {
      const text = `${code} is not an open pick in wave 3. Check the bin and scan again.`;
      setMsg({ ok: false, text });
      announce(text);
      return;
    }
    pickOne(hit.ref, hit.it);
  };

  const reportProblem = (ref: string, kind: 'short' | 'damaged') => {
    const o = wave.find((x) => x.ref === ref)!;
    const it = o.items.find((i) => !i.state) ?? o.items.find((i) => i.state !== 'short' && i.state !== 'damaged');
    if (!it) return;
    updateItem(ref, it.sku, (i) => ({ ...i, state: kind }));
    const r: Report =
      kind === 'short'
        ? { tone: 'warning', title: `Shortage reported on ${ref}`, body: `Bin ${it.bin} was empty for ${it.sku}. Ana Silva is checking Returned stock. The order stays in the wave; do not pack it partly.` }
        : { tone: 'danger', title: `Damaged item reported on ${ref}`, body: `${it.sku} from bin ${it.bin} moved to Damaged or held. Ana Silva is finding a replacement unit. Do not pack the order partly.` };
    setReport(r);
    announce(r.title);
  };

  return (
    <>
      <div className="page-head">
        <div className="t">
          <h1 className="h1">Pick and pack</h1>
          <p className="sub small">Wave 3 · 27 Official Store orders · UPS pickup 4:00 PM · marketplace sellers pack their own orders</p>
        </div>
        <div className="actions">
          <Seg view="" />
        </div>
      </div>
      <form onSubmit={onScan}>
        <label className="ac-scan" htmlFor="pp-scan">
          <Icon name="scan-barcode" className="ic-lg" />
          <span className="sr-only">Scan bin or item barcode</span>
          <input id="pp-scan" type="text" placeholder="Scan bin or item barcode" autoComplete="off" value={scan} onChange={(e) => setScan(e.target.value)} />
        </label>
      </form>
      {msg && (
        <p className={cx('xs strong row gap-1', msg.ok ? 't-success-text' : 't-danger-text')} role="status">
          <Icon name={msg.ok ? 'circle-check' : 'circle-alert'} className="ic-sm" />
          {msg.text}
        </p>
      )}
      <div className="stack gap-2">
        <div className="row between small">
          <span className="strong">
            {pickedOrders} of {WAVE_TOTAL} orders picked
          </span>
          {nextItem && (
            <span className="muted">
              Next bin <b className="mono">{nextItem.bin}</b>
            </span>
          )}
        </div>
        <Meter pct={pct} label={`${pickedOrders} of ${WAVE_TOTAL} orders picked`} />
      </div>
      <Alert tone={report.tone} title={report.title}>
        {report.body}
      </Alert>
      <div className="grid lg2 gap-4">
        {wave.map((o) => {
          const n = o.items.length;
          const picked = o.items.filter((i) => i.state === 'picked').length;
          return (
            <section key={o.ref} className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <Link className="mono strong" to={href('ops/pick-pack', 'packing-station')} state={{ fresh: true }}>
                    {o.ref}
                  </Link>
                  <span className="xs muted">
                    {n} {n === 1 ? 'item' : 'items'} · {picked} picked
                  </span>
                </div>
                <Deadline tone={o.tone}>{o.shipBy}</Deadline>
              </div>
              <div className="card-body ac-hand u-g-0">
                {o.items.map((it) => {
                  const isNext = next?.order === o.ref && next.sku === it.sku;
                  return (
                    <div key={it.sku} className={cx('ac-pick', it.state === 'picked' && 'is-done', (it.state === 'short' || it.state === 'damaged') && 'is-short', isNext && 'is-next')}>
                      <span className="ac-bin">{it.bin}</span>
                      <span className="stack gap-0 grow">
                        <span className="small strong">{it.name}</span>
                        <span className="xs mono muted">{it.sku}</span>
                        {it.state === 'picked' && (
                          <span className="xs t-success-text strong row gap-1">
                            <Icon name="circle-check" className="ic-sm" />
                            Picked {it.at}
                          </span>
                        )}
                        {it.state === 'short' && (
                          <span className="xs t-warning-text strong row gap-1">
                            <Icon name="triangle-alert" className="ic-sm" />
                            Shortage reported
                          </span>
                        )}
                        {it.state === 'damaged' && (
                          <span className="xs t-warning-text strong row gap-1">
                            <Icon name="circle-alert" className="ic-sm" />
                            Damaged item reported
                          </span>
                        )}
                        {isNext && <span className="t-brand-text strong small">{it.picked > 0 ? `Scan unit ${it.picked + 1} of ${it.qty}` : 'Scan this item next'}</span>}
                      </span>
                      <span className="q" aria-label={`Quantity ${it.qty}`}>
                        ×{it.qty}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="card-foot">
                <Button variant="ghost" size="sm" icon="package-x" onClick={() => reportProblem(o.ref, 'short')}>
                  Report shortage
                </Button>
                <Button variant="ghost" size="sm" icon="circle-alert" onClick={() => reportProblem(o.ref, 'damaged')}>
                  Report damaged item
                </Button>
              </div>
            </section>
          );
        })}
      </div>
      <div className="ac-handbar only-phone">
        <Button variant="secondary" icon="flag" disabled={!next} onClick={() => next && reportProblem(next.order, 'short')}>
          Report problem
        </Button>
        <Button icon="check" disabled={!next} onClick={() => next && nextItem && pickOne(next.order, nextItem)}>
          Confirm pick
        </Button>
      </div>
    </>
  );
}

/* ---------------- Packing station ---------------- */

interface PackItem {
  sku: string;
  name: string;
  icon: IconName;
  tint: Tint;
  qty: number;
}
const PACK_ORDER = 'MK-261008-12544';
const PACK_ITEMS: PackItem[] = [
  { sku: 'HAL-AUR-BLK', name: 'Halden Aurora ANC Headphones, Black', icon: 'headphones', tint: '2', qty: 1 },
  { sku: 'MSW-PO-CRM', name: 'Mosswood Pour-over Coffee Set, Cream', icon: 'coffee', tint: '3', qty: 1 },
];
const BOXES = ['S box · 10 × 8 × 4 in', 'M box · 14 × 10 × 6 in', 'L box · 18 × 14 × 8 in', 'Padded mailer'];
const SERVICES = ['UPS Ground · arrives Tue, Oct 13', 'UPS 2nd Day Air · arrives Mon, Oct 12'];
const TRACKING = '1Z84E2W70392104418';

function PackingStation({ fresh }: { fresh: boolean }) {
  // Opened from a pick-list order: nothing scanned yet. Opened by URL: the design's state (both scanned).
  const [scanned, setScanned] = useState<Record<string, boolean>>(() => Object.fromEntries(PACK_ITEMS.map((i) => [i.sku, !fresh])));
  const [scan, setScan] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [box, setBox] = useState(BOXES[1]);
  const [weight, setWeight] = useState('3.4');
  const [service, setService] = useState(SERVICES[0]);
  const [fragile, setFragile] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [packed, setPacked] = useState(false);
  const [tried, setTried] = useState(false);

  const nScanned = PACK_ITEMS.filter((i) => scanned[i.sku]).length;
  const allScanned = nScanned === PACK_ITEMS.length;
  const weightOk = Number(weight) > 0;
  const service0 = service.split(' · ')[0];

  const onScan = (e: FormEvent) => {
    e.preventDefault();
    const code = scan.trim().toUpperCase();
    setScan('');
    if (!code) return;
    const it = PACK_ITEMS.find((i) => i.sku === code);
    let text: string;
    if (!it) text = `${code} is not in package 1 of ${PACK_ORDER}. Put it aside.`;
    else if (scanned[it.sku]) text = `${code} is already scanned.`;
    else {
      setScanned((s) => ({ ...s, [it.sku]: true }));
      text = `${code} scanned. ${nScanned + 1} of ${PACK_ITEMS.length} items confirmed.`;
    }
    setMsg({ ok: !!it && !scanned[it.sku], text });
    announce(text);
  };

  const markPacked = () => {
    setTried(true);
    if (!allScanned || !weightOk || problem) return;
    setPacked(true);
    announce(`${PACK_ORDER} packed`);
  };

  const report = (kind: 'shortage' | 'damaged') => {
    const it = PACK_ITEMS.find((i) => !scanned[i.sku]) ?? PACK_ITEMS[PACK_ITEMS.length - 1];
    const text = kind === 'shortage' ? `Shortage reported for ${it.sku}. Ana Silva is checking stock. Do not pack the order partly.` : `Damaged ${it.sku} reported. Ana Silva is sending a replacement unit to station 2.`;
    setProblem(text);
    announce(text);
  };

  return (
    <>
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Pick and pack', to: href('ops/pick-pack') }, { label: PACK_ORDER }]} />
          <h1 className="h1">Packing station 2</h1>
          <p className="sub small">Order {PACK_ORDER} · Package 1 of 2 · Official Store items only</p>
        </div>
        <div className="actions">
          <Seg view="packing-station" />
        </div>
      </div>
      <form onSubmit={onScan}>
        <label className="ac-scan" htmlFor="pk-scan">
          <Icon name="scan-barcode" className="ic-lg" />
          <span className="sr-only">Scan item to confirm</span>
          <input id="pk-scan" type="text" placeholder="Scan each item to confirm" autoComplete="off" value={scan} disabled={packed} onChange={(e) => setScan(e.target.value)} />
        </label>
      </form>
      {msg && (
        <p className={cx('xs strong row gap-1', msg.ok ? 't-success-text' : 't-danger-text')} role="status">
          <Icon name={msg.ok ? 'circle-check' : 'circle-alert'} className="ic-sm" />
          {msg.text}
        </p>
      )}
      {packed ? (
        <Alert tone="success" title={`${PACK_ORDER} packed`}>
          Package 1 of 2 goes out with the UPS pickup at 4:00 PM. Tracking <span className="mono">{TRACKING}</span> is on the order. <Link to={href('ops/pick-pack')}>Back to the pick list</Link>
        </Alert>
      ) : (
        <Alert tone="info" title="Mixed order">
          This order also has Package 2 of 2 from Pixel &amp; Port. They ship it separately. Your packing slip lists only Official Store items.
        </Alert>
      )}
      {problem && <Alert tone="warning" title="Problem reported">{problem}</Alert>}
      <div className="ac-main">
        <div className="stack gap-5">
          <Card
            title="Items to pack"
            sub={`${nScanned} of ${PACK_ITEMS.length} scanned`}
            foot={
              <>
                <Button variant="ghost" size="sm" icon="package-x" onClick={() => report('shortage')} disabled={packed}>
                  Report shortage
                </Button>
                <Button variant="ghost" size="sm" icon="circle-alert" onClick={() => report('damaged')} disabled={packed}>
                  Report damaged item
                </Button>
              </>
            }
          >
            <div className="ac-hand u-d-flex u-fd-column">
              {PACK_ITEMS.map((it) => (
                <div key={it.sku} className="ac-pick">
                  <Img icon={it.icon} tint={it.tint} className="thumb" />
                  <span className="stack gap-0 grow">
                    <span className="small strong">{it.name}</span>
                    <span className="xs mono muted">{it.sku}</span>
                    {scanned[it.sku] ? (
                      <span className="xs t-success-text strong row gap-1">
                        <Icon name="circle-check" className="ic-sm" />
                        Scanned
                      </span>
                    ) : (
                      <span className="t-brand-text strong small">Scan to confirm</span>
                    )}
                  </span>
                  <span className="q">×{it.qty}</span>
                </div>
              ))}
            </div>
            {tried && !allScanned && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                Scan every item before you mark the package as packed.
              </span>
            )}
          </Card>
          <Card title="Package" titleAs="h3">
            <div className="ac-fgrid">
              <Field label="Box size" hint="Suggested from item dimensions">
                <Select id="pk-box" options={BOXES} value={box} disabled={packed} onChange={(e) => setBox(e.target.value)} />
              </Field>
              <Field label="Weight" error={tried && !weightOk ? 'Weigh the package. The weight prints on the label.' : undefined}>
                <TextInput id="pk-wt" value={weight} suffix="lb · from scale" inputMode="decimal" error={tried && !weightOk} disabled={packed} onChange={(e) => setWeight(e.target.value)} />
              </Field>
              <Field label="Carrier service" hint="Matches the delivery option the customer chose">
                <Select id="pk-svc" options={SERVICES} value={service} disabled={packed} onChange={(e) => setService(e.target.value)} />
              </Field>
              <Field label="Tracking number" hint="Created with the label">
                <TextInput id="pk-trk" value={TRACKING} readOnly />
              </Field>
            </div>
            <Checkbox id="pk-fragile" label="Fragile: ceramic item, use paper fill" checked={fragile} disabled={packed} onChange={(e) => setFragile(e.target.checked)} />
          </Card>
        </div>
        <div className="stack gap-5">
          <Card
            title="Packing slip"
            titleAs="h3"
            actions={
              <Button variant="ghost" size="sm" icon="printer" onClick={() => announce('Packing slip sent to the printer')}>
                Print
              </Button>
            }
          >
            <div className="ac-slip">
              <div className="row between">
                <Logo />
                <span className="xs mono">{PACK_ORDER}</span>
              </div>
              <span className="xs muted">Package 1 of 2 · Sold and shipped by Marketly Official</span>
              <div className="stack gap-1">
                <span className="small strong">Ship to</span>
                <span className="small">
                  Sam Rivera
                  <br />
                  4127 Fremont Ave N
                  <br />
                  Seattle, WA 98103
                </span>
              </div>
              <div className="divider" />
              {PACK_ITEMS.map((it) => (
                <SummaryRow key={it.sku} k={it.name} v={it.qty} />
              ))}
              <div className="divider" />
              <span className="xs sub">Returns: 30 days from delivery. Start a return from your order page. Package 2 ships separately from Pixel &amp; Port.</span>
            </div>
          </Card>
          <Card
            title="Carrier label"
            titleAs="h3"
            foot={
              <>
                <Button variant="ghost" size="sm" icon="printer" onClick={() => announce('Label sent to printer PS-2')}>
                  Reprint label
                </Button>
                <Button size="sm" icon="package-check" onClick={markPacked} disabled={packed}>
                  {packed ? 'Packed' : 'Mark as packed'}
                </Button>
              </>
            }
          >
            <div className="row gap-3 nowrap">
              <Img icon="barcode" tint="1" className="thumb" />
              <span className="stack gap-0">
                <span className="small strong">{service0}</span>
                <span className="xs mono">{TRACKING}</span>
                <span className="xs muted">4x6 label · printer PS-2</span>
              </span>
            </div>
          </Card>
        </div>
      </div>
      <div className="ac-handbar only-phone">
        <Button variant="secondary" icon="printer" onClick={() => announce('Label sent to printer PS-2')}>
          Print label
        </Button>
        <Button icon="package-check" onClick={markPacked} disabled={packed}>
          {packed ? 'Packed' : 'Mark as packed'}
        </Button>
      </div>
    </>
  );
}

export default function PickPack() {
  const [view] = useView<View>();
  const location = useLocation();
  const fresh = !!(location.state as { fresh?: boolean } | null)?.fresh;
  return (
    <OpsLayout active="pick-pack">
      {view === 'packing-station' ? <PackingStation key={location.key} fresh={fresh} /> : <PickList />}
    </OpsLayout>
  );
}
