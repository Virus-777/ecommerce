import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { OpsLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { money, num } from '@/lib/format';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, Badge, Button, Card, Dialog, Field, Icon, Img, PageHeader, SearchInput, Select, StatusBadge, SummaryRow, TableWrap, Textarea, TextInput, announce, type IconName } from '@/ui';
import type { Tint } from '@/data/fixtures';
import { BeforeAfter, EDGE_RISK, EDGE_URGENT, OpsLegend } from './data/shared';

// Design: pages/ops/ops-inventory.html · view "adjust-stock" = the Adjust stock dialog
// (AST-VC30, 60 units Available → Damaged or held, over the 50-unit limit so it needs a second review).

type Group = 'Available' | 'Reserved' | 'Incoming' | 'Damaged or held' | 'Returned';
type Target = 'Available' | 'Damaged or held' | 'Returned' | 'Remove from stock (write off)';
const GROUP_KEY: Record<Group, keyof Counts> = { Available: 'available', Reserved: 'reserved', Incoming: 'incoming', 'Damaged or held': 'damaged', Returned: 'returned' };

interface Counts {
  available: number;
  reserved: number;
  incoming: number;
  damaged: number;
  returned: number;
}

interface StockRow extends Counts {
  sku: string;
  name: string;
  icon: IconName;
  tint: Tint;
  bin: string;
  reorder: number;
  /** Unit cost, for the "at cost" group totals. */
  cost: number;
}

const ROWS: StockRow[] = [
  { sku: 'HAL-AUR-BLK', name: 'Halden Aurora ANC Headphones, Black', icon: 'headphones', tint: '2', bin: 'A-03-2', available: 142, reserved: 38, incoming: 120, damaged: 0, returned: 3, reorder: 40, cost: 128 },
  { sku: 'HAL-AUR-SLV', name: 'Halden Aurora ANC Headphones, Silver', icon: 'headphones', tint: '2', bin: 'A-03-4', available: 0, reserved: 6, incoming: 80, damaged: 0, returned: 0, reorder: 25, cost: 128 },
  { sku: 'BRL-LAMP-W', name: 'Brightline Smart LED Desk Lamp', icon: 'lamp-desk', tint: '5', bin: 'C-04-1', available: 9, reserved: 4, incoming: 0, damaged: 1, returned: 1, reorder: 20, cost: 22 },
  { sku: 'PLR-CI26', name: 'Pellar Cast Iron Skillet 26 cm', icon: 'cooking-pot', tint: '3', bin: 'D-02-3', available: 77, reserved: 12, incoming: 120, damaged: 2, returned: 1, reorder: 30, cost: 24 },
  { sku: 'NDV-MER-M-NVY', name: 'Nordvik Merino Crew, M, Navy', icon: 'shirt', tint: '4', bin: 'F-12-2', available: 52, reserved: 7, incoming: 0, damaged: 0, returned: 2, reorder: 15, cost: 31 },
  { sku: 'NDV-MER-L-NVY', name: 'Nordvik Merino Crew, L, Navy', icon: 'shirt', tint: '4', bin: 'F-12-3', available: 11, reserved: 5, incoming: 40, damaged: 0, returned: 0, reorder: 15, cost: 31 },
  { sku: 'MSW-PO-CRM', name: 'Mosswood Pour-over Coffee Set, Cream', icon: 'coffee', tint: '3', bin: 'C-07-1', available: 58, reserved: 9, incoming: 0, damaged: 1, returned: 1, reorder: 20, cost: 18 },
  { sku: 'AST-VC30', name: 'Aster Daily Vitamin C Serum 30 ml', icon: 'droplet', tint: '5', bin: 'E-01-4', available: 140, reserved: 22, incoming: 0, damaged: 0, returned: 0, reorder: 50, cost: 9 },
];

/** Group tiles: the design's values at cost; adjustments move cost with the unit cost of the SKU. */
const GROUP_TILES: Array<{ label: string; key: keyof Counts; tone: string; cost: number; note: string }> = [
  { label: 'Available', key: 'available', tone: 'var(--success)', cost: 22479, note: 'Sellable to new customers' },
  { label: 'Reserved', key: 'reserved', tone: 'var(--info)', cost: 6091, note: 'Allocated to accepted orders' },
  { label: 'Incoming', key: 'incoming', tone: 'var(--border-strong)', cost: 27040, note: 'Expected from suppliers' },
  { label: 'Damaged or held', key: 'damaged', tone: 'var(--danger)', cost: 88, note: 'Awaiting inspection or unsellable' },
  { label: 'Returned', key: 'returned', tone: 'var(--warning)', cost: 474, note: 'Needs a condition decision' },
];

interface HistoryRow {
  date: string;
  sku: string;
  from?: string;
  to?: string;
  /** Change label when the change is not a move between groups. */
  label?: string;
  qty: string;
  reason: string;
  staff: string;
  review: string;
}

const HISTORY: HistoryRow[] = [
  { date: 'Oct 8, 9:05 AM', sku: 'PLR-CI26', from: 'Available', to: 'Damaged or held', qty: '2', reason: 'Damaged in receiving, PUR-2610-0039', staff: 'Ana Silva', review: 'Not required' },
  { date: 'Oct 7, 4:22 PM', sku: 'HAL-AUR-BLK', from: 'Returned', to: 'Available', qty: '1', reason: 'Return RT-261001-0161 inspected, like new', staff: 'Ana Silva', review: 'Not required' },
  { date: 'Oct 7, 11:40 AM', sku: 'BRL-LAMP-W', label: 'Count correction', qty: '−3', reason: 'Cycle count correction, bin C-04-1', staff: 'Ana Silva', review: 'Not required' },
  { date: 'Oct 6, 3:15 PM', sku: 'AST-VC30', from: 'Incoming', to: 'Available', qty: '120', reason: 'Received PUR-2610-0031', staff: 'Ana Silva', review: 'Dana Ortiz approved' },
  { date: 'Oct 5, 10:02 AM', sku: 'MSW-PO-CRM', from: 'Available', to: 'Damaged or held', qty: '1', reason: 'Chipped cup found during packing', staff: 'Carlos Mendez', review: 'Not required' },
];

const FROM_GROUPS: Group[] = ['Available', 'Reserved', 'Incoming', 'Damaged or held', 'Returned'];
const TO_GROUPS: Target[] = ['Available', 'Damaged or held', 'Returned', 'Remove from stock (write off)'];
const REASONS = ['Choose a reason', 'Quality hold: supplier notice', 'Damaged in warehouse', 'Count correction', 'Found stock', 'Theft or loss'];
const REVIEWERS = ['Dana Ortiz, Official Store Manager', 'Morgan Hale, Business Owner'];
const LIMIT = 50;
const NOW = 'Oct 8, 10:05 AM';

const STOCK_FILTERS = ['All stock groups', 'Low or out of stock', 'Has damaged or held', 'Has returned'];
const LOCATIONS = ['All locations', 'Zone A', 'Zone C', 'Zone D', 'Zone E', 'Zone F'];

interface Draft {
  sku: string;
  from: Group;
  to: Target;
  qty: string;
  reason: string;
  note: string;
  reviewer: string;
}

const DESIGN_DRAFT: Draft = { sku: 'AST-VC30', from: 'Available', to: 'Damaged or held', qty: '60', reason: 'Quality hold: supplier notice', note: 'Supplier recall notice for batch L2609 received Oct 8, 8:15 AM. Hold until lab result.', reviewer: REVIEWERS[0] };
const blankDraft = (sku: string): Draft => ({ sku, from: 'Available', to: 'Damaged or held', qty: '', reason: REASONS[0], note: '', reviewer: REVIEWERS[0] });

const statusOf = (r: StockRow) => (r.available === 0 ? 'Out of stock' : r.available <= r.reorder ? 'Low stock' : 'In stock');

function Num({ n, tone }: { n: number; tone?: 'danger' | 'warning' }) {
  if (!n) return <span className="muted">0</span>;
  return tone ? <span className={`t-${tone}-text strong`}>{n}</span> : <>{n}</>;
}

function Available({ r }: { r: StockRow }) {
  const s = statusOf(r);
  if (s === 'Out of stock')
    return (
      <span className="ac-out">
        0<span className="sr-only"> out of stock</span>
      </span>
    );
  if (s === 'Low stock') return <span className="ac-low">{r.available}</span>;
  return <span className="strong">{r.available}</span>;
}

function validate(d: Draft, row: StockRow) {
  const e: Partial<Record<'qty' | 'reason' | 'to', string>> = {};
  const q = Number(d.qty);
  const have = row[GROUP_KEY[d.from]];
  if (!d.qty.trim() || !Number.isInteger(q) || q <= 0) e.qty = 'Enter a whole number of units, 1 or more.';
  else if (q > have) e.qty = `Only ${have} units are in ${d.from}.`;
  if (d.to === d.from) e.to = 'Choose a different group to move units to.';
  if (d.reason === REASONS[0]) e.reason = 'Choose a reason. Every change is recorded with its reason.';
  return e;
}

export default function Inventory() {
  const [view, setView] = useView<'adjust-stock'>();
  const [rows, setRows] = useState(ROWS);
  const [tileCost, setTileCost] = useState<Record<keyof Counts, number>>(() => Object.fromEntries(GROUP_TILES.map((t) => [t.key, t.cost])) as Record<keyof Counts, number>);
  const [history, setHistory] = useState(HISTORY);
  const [q, setQ] = useState('');
  const [grp, setGrp] = useState(STOCK_FILTERS[0]);
  const [loc, setLoc] = useState(LOCATIONS[0]);
  const [draft, setDraft] = useState<Draft>(DESIGN_DRAFT);
  const [attempted, setAttempted] = useState(false);
  const [done, setDone] = useState<{ title: string; body: string } | null>(null);

  const open = view === 'adjust-stock';
  const row = rows.find((r) => r.sku === draft.sku) ?? rows[0];
  const errors = attempted ? validate(draft, row) : {};
  const qty = Number(draft.qty) || 0;
  const needsReview = qty > LIMIT;

  const totals = useMemo(() => {
    const t: Counts = { available: 0, reserved: 0, incoming: 0, damaged: 0, returned: 0 };
    rows.forEach((r) => (Object.keys(t) as Array<keyof Counts>).forEach((k) => (t[k] += r[k])));
    return t;
  }, [rows]);

  const filtered = rows.filter((r) => {
    const s = q.trim().toLowerCase();
    if (s && ![r.sku, r.name, r.bin].some((x) => x.toLowerCase().includes(s))) return false;
    if (grp === 'Low or out of stock' && statusOf(r) === 'In stock') return false;
    if (grp === 'Has damaged or held' && !r.damaged) return false;
    if (grp === 'Has returned' && !r.returned) return false;
    if (loc !== LOCATIONS[0] && !r.bin.startsWith(loc.slice(-1))) return false;
    return true;
  });
  const lowCount = rows.filter((r) => statusOf(r) !== 'In stock').length;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const openAdjust = (sku?: string) => {
    setDraft(blankDraft(sku ?? rows[0].sku));
    setAttempted(false);
    setView('adjust-stock');
  };
  const close = () => setView('');

  const submit = () => {
    setAttempted(true);
    if (Object.keys(validate(draft, row)).length) return;
    const toGroup = draft.to === 'Remove from stock (write off)' ? null : (draft.to as Group);
    const entry: HistoryRow = {
      date: NOW,
      sku: draft.sku,
      from: draft.from,
      to: toGroup ?? 'Written off',
      qty: String(qty),
      reason: draft.note.trim() ? `${draft.reason}. ${draft.note.trim()}` : draft.reason,
      staff: 'Ana Silva',
      review: needsReview ? `Waiting for ${draft.reviewer.split(',')[0]}` : 'Not required',
    };
    setHistory((h) => [entry, ...h]);
    if (needsReview) {
      setDone({ title: 'Sent for second review', body: `${qty} units of ${draft.sku} move from ${draft.from} to ${draft.to} after ${draft.reviewer.split(',')[0]} approves.` });
    } else {
      const fromKey = GROUP_KEY[draft.from];
      const toKey = toGroup ? GROUP_KEY[toGroup] : null;
      setRows((rs) => rs.map((r) => (r.sku === draft.sku ? { ...r, [fromKey]: r[fromKey] - qty, ...(toKey ? { [toKey]: r[toKey] + qty } : {}) } : r)));
      setTileCost((c) => ({ ...c, [fromKey]: c[fromKey] - qty * row.cost, ...(toKey ? { [toKey]: c[toKey] + qty * row.cost } : {}) }));
      setDone({ title: 'Stock adjusted', body: `${qty} units of ${draft.sku} moved from ${draft.from} to ${draft.to}. The change is in the adjustment history.` });
    }
    announce(needsReview ? 'Adjustment sent for second review' : 'Stock adjusted');
    close();
  };

  const fromBefore = row[GROUP_KEY[draft.from]];
  const toGroup = draft.to === 'Remove from stock (write off)' ? null : (draft.to as Group);
  const toBefore = toGroup ? row[GROUP_KEY[toGroup]] : 0;
  const valid = !Object.keys(validate(draft, row)).length;

  return (
    <OpsLayout active="inventory">
      <PageHeader
        title="Official Store stock"
        sub="Reno, NV warehouse · company-owned stock only. Seller stock is never mixed in."
        actions={
          <>
            <Button variant="secondary" size="sm" icon="download">
              Export
            </Button>
            <Button size="sm" icon="sliders-horizontal" onClick={() => openAdjust()}>
              Adjust stock
            </Button>
          </>
        }
      />
      <div className="ac-groups">
        {GROUP_TILES.map((t) => (
          <div key={t.key} className="ac-grp" style={{ '--tone': t.tone } as CSSProperties}>
            <span className="xs strong sub">{t.label}</span>
            <span className="v">{num(totals[t.key])}</span>
            <span className="xs muted">{money(tileCost[t.key])} at cost</span>
            <span className="xs muted">{t.note}</span>
          </div>
        ))}
      </div>
      {done && (
        <Alert tone="success" title={done.title}>
          {done.body}
        </Alert>
      )}
      <Alert tone="warning" title={`${lowCount} SKUs at or below reorder point`}>
        Halden Aurora Silver is out of stock, 80 incoming on PUR-2610-0042 (arrived today). Brightline desk lamp and Nordvik Merino L are low. Customers can buy only Available units.
      </Alert>
      <div className="toolbar">
        <SearchInput id="inv-q" placeholder="Search SKU, product or bin" value={q} onChange={setQ} />
        <label className="sr-only" htmlFor="inv-grp">
          Stock group
        </label>
        <Select id="inv-grp" options={STOCK_FILTERS} value={grp} onChange={(e) => setGrp(e.target.value)} />
        <label className="sr-only" htmlFor="inv-loc">
          Location
        </label>
        <Select id="inv-loc" options={LOCATIONS} value={loc} onChange={(e) => setLoc(e.target.value)} />
      </div>
      <Card title="Stock by SKU" sub={`${filtered.length} of 214 Official Store SKUs`} flush>
        <div className="no-phone">
          <TableWrap label="Stock by SKU table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Location</th>
                  <th className="r" scope="col">Available</th>
                  <th className="r" scope="col">Reserved</th>
                  <th className="r" scope="col">Incoming</th>
                  <th className="r" scope="col">Damaged or held</th>
                  <th className="r" scope="col">Returned</th>
                  <th className="r" scope="col">Reorder at</th>
                  <th scope="col">Status</th>
                  <th className="col-pin" scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const s = statusOf(r);
                  return (
                    <tr key={r.sku} className={cx(s === 'Out of stock' && 'is-flagged', s === 'Low stock' && 'is-warn')}>
                      <td>
                        {s === 'Out of stock' && <span className="sr-only">Urgent: </span>}
                        {s === 'Low stock' && <span className="sr-only">At risk: </span>}
                        <div className="cell-main">
                          <Img icon={r.icon} tint={r.tint} className="tiny" />
                          <span className="stack gap-0">
                            <span className="small strong">{r.name}</span>
                            <span className="xs mono muted nowrap" title={r.sku}>
                              {r.sku}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className="mono small nowrap" title={r.bin}>
                          {r.bin}
                        </span>
                      </td>
                      <td className="r">
                        <Available r={r} />
                      </td>
                      <td className="r">{r.reserved}</td>
                      <td className="r">
                        <Num n={r.incoming} />
                      </td>
                      <td className="r">
                        <Num n={r.damaged} tone="danger" />
                      </td>
                      <td className="r">
                        <Num n={r.returned} tone="warning" />
                      </td>
                      <td className="r">
                        <span className="muted">{r.reorder}</span>
                      </td>
                      <td>
                        <StatusBadge status={s} />
                      </td>
                      <td className="col-pin">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => openAdjust(r.sku)}>
                          <span>Adjust</span>
                          <span className="sr-only"> {r.sku}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
          <OpsLegend items={[{ tone: 'danger', label: EDGE_URGENT }, { tone: 'warning', label: EDGE_RISK }]} />
        </div>
        <div className="ac-mlist only-phone">
          {filtered.map((r) => {
            const s = statusOf(r);
            return (
              <div key={r.sku} className={cx('ac-mi', s === 'Out of stock' && 'is-flagged', s === 'Low stock' && 'is-warn')}>
                {s === 'Out of stock' && <span className="sr-only">Urgent: </span>}
                {s === 'Low stock' && <span className="sr-only">At risk: </span>}
                <div className="row between gap-2 nowrap top">
                  <span className="small strong min-w-0">{r.name}</span>
                  <StatusBadge status={s} />
                </div>
                <div className="xs sub">
                  <span className="mono">{r.sku}</span> · bin <span className="mono">{r.bin}</span>
                </div>
                <div className="xs sub">
                  Available <b>{r.available}</b> · Reserved {r.reserved} · Incoming {r.incoming} · Damaged {r.damaged} · Returned {r.returned}
                </div>
              </div>
            );
          })}
        </div>
        <OpsLegend className="only-phone" items={[{ tone: 'danger', label: EDGE_URGENT }, { tone: 'warning', label: EDGE_RISK }]} />
      </Card>
      <div className="grid lg2 gap-5">
        <Card
          title="Adjustment history"
          titleAs="h3"
          sub="Reason, staff member and date for every change"
          flush
          actions={
            <Link className="small strong" to={href('admin/audit')}>
              Full history
            </Link>
          }
        >
          <div className="no-phone">
            <TableWrap label="Adjustment history table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">SKU</th>
                    <th scope="col">Change</th>
                    <th className="r" scope="col">Qty</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Staff</th>
                    <th className="col-pin" scope="col">Second review</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={`${h.date}-${h.sku}-${i}`}>
                      <td>
                        <span className="small nowrap">{h.date}</span>
                      </td>
                      <td>
                        <span className="mono small nowrap" title={h.sku}>
                          {h.sku}
                        </span>
                      </td>
                      <td>{h.from && h.to ? <BeforeAfter b={h.from} a={h.to} /> : <span className="xs">{h.label}</span>}</td>
                      <td className="r">
                        <b>{h.qty}</b>
                      </td>
                      <td>
                        <span className="small minw-180 cell-text">{h.reason}</span>
                      </td>
                      <td>
                        <span className="small nowrap">{h.staff}</span>
                      </td>
                      <td className="col-pin">
                        <span className="xs muted">{h.review}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </div>
          <div className="ac-mlist only-phone">
            {history.map((h, i) => (
              <div key={`${h.date}-${h.sku}-${i}`} className="ac-mi">
                <div className="row between gap-2 nowrap top">
                  <span className="small strong min-w-0">
                    <span className="mono">{h.sku}</span> · {h.qty} units
                  </span>
                  <span className="xs muted nowrap">{h.date}</span>
                </div>
                <div className="xs sub">{h.from && h.to ? <BeforeAfter b={h.from} a={h.to} /> : h.label}</div>
                <div className="xs sub">
                  {h.reason} · {h.staff}
                </div>
              </div>
            ))}
          </div>
        </Card>
        <div className="stack gap-5">
          <Card title="Stock rules" titleAs="h3">
            <ul className="list">
              <li>
                <Icon name="shield-check" className="ic-sm" />
                <span className="small grow">Checkout cannot sell more than the Available quantity.</span>
              </li>
              <li>
                <Icon name="refresh-cw" className="ic-sm" />
                <span className="small grow">Reserved units return to Available only when the purchase ends or is cancelled.</span>
              </li>
              <li>
                <Icon name="user-check" className="ic-sm" />
                <span className="small grow">Adjustments over 50 units need a second reviewer (Inventory Manager limit).</span>
              </li>
            </ul>
          </Card>
          <Card
            titleAs="h3"
            title={
              <span className="row gap-2 nowrap">
                <Icon name="arrow-left-right" className="ic-sm" />
                Transfers <Badge tone="outline">Later</Badge>
              </span>
            }
          >
            <p className="small sub">Transfers between warehouses and seller-owned stock storage arrive with multiple warehouses in the operational expansion phase. One location, Reno, NV, at launch.</p>
          </Card>
        </div>
      </div>

      <Dialog
        open={open}
        onClose={close}
        title="Adjust stock"
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button icon={needsReview ? 'send' : 'check'} onClick={submit}>
              {needsReview ? 'Send for second review' : 'Apply adjustment'}
            </Button>
          </>
        }
      >
        <Field label="SKU">
          <Select id="adj-sku" options={rows.map((r) => ({ value: r.sku, label: `${r.sku} · ${r.name}` }))} value={draft.sku} onChange={(e) => set('sku', e.target.value)} />
        </Field>
        <div className="panel row gap-4 xs sub">
          <span>
            Available <b>{row.available}</b>
          </span>
          <span>
            Reserved <b>{row.reserved}</b>
          </span>
          <span>
            Damaged or held <b>{row.damaged}</b>
          </span>
          <span>
            Bin <b className="mono">{row.bin}</b>
          </span>
        </div>
        <div className="ac-fgrid">
          <Field label="From group">
            <Select id="adj-from" options={FROM_GROUPS} value={draft.from} onChange={(e) => set('from', e.target.value as Group)} />
          </Field>
          <Field label="To group" error={errors.to}>
            <Select id="adj-to" options={TO_GROUPS} value={draft.to} onChange={(e) => set('to', e.target.value as Target)} />
          </Field>
          <Field label="Quantity" error={errors.qty}>
            <TextInput id="adj-qty" type="number" min={1} value={draft.qty} error={!!errors.qty} suffix="units" onChange={(e) => set('qty', e.target.value)} />
          </Field>
          <Field label="Reason (required)" error={errors.reason}>
            <Select id="adj-reason" options={REASONS} value={draft.reason} onChange={(e) => set('reason', e.target.value)} aria-invalid={!!errors.reason || undefined} className={cx(errors.reason && 'is-error')} />
          </Field>
          <div className="full">
            <Field label="Note" optional>
              <Textarea id="adj-note" value={draft.note} onChange={(e) => set('note', e.target.value)} />
            </Field>
          </div>
        </div>
        {qty > 0 && valid && (
          <div className="well stack gap-2">
            <span className="small strong">After this change</span>
            <SummaryRow k={draft.from} v={<BeforeAfter b={fromBefore} a={fromBefore - qty} />} />
            {toGroup ? <SummaryRow k={toGroup} v={<BeforeAfter b={toBefore} a={toBefore + qty} />} /> : <SummaryRow k="Written off" v={`${qty} units`} />}
            {draft.from === 'Available' && row.reserved > 0 && <span className="xs muted">{row.reserved} reserved units stay with their orders. Order Manager is notified to check them.</span>}
          </div>
        )}
        {needsReview && (
          <>
            <Alert tone="warning" title="Second review needed">
              {qty} units is above your {LIMIT}-unit adjustment limit. The change applies after {draft.reviewer}, approves it.
            </Alert>
            <Field label="Second reviewer">
              <Select id="adj-rev" options={REVIEWERS} value={draft.reviewer} onChange={(e) => set('reviewer', e.target.value)} />
            </Field>
          </>
        )}
      </Dialog>
    </OpsLayout>
  );
}
