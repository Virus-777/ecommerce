import { useState, type MouseEvent } from 'react';
import { AdminLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { useView } from '@/lib/hooks';
import { money, num } from '@/lib/format';
import { href } from '@/routes/href';
import { Alert, Button, Card, Dialog, Drawer, EmptyState, Field, Icon, KeyValue, PageHeader, SearchInput, Select, Stat, StatusBadge, SummaryRow, TableWrap, Tabs, TextInput } from '@/ui';
import {
  APPROVER, BUYER, ON_TIME_WARN, PO_LIMIT, PURCHASE_ORDERS, REORDER, SUPPLIER_ITEMS, SUPPLIERS,
  type PoEvent, type PoLine, type PurchaseOrder, type Supplier,
} from './data/purchasing';

// Design: pages/admin/admin-purchasing.html (purchase orders + suppliers) ·
// view "purchase-order" = the PUR-2610-0042 drawer (partly received). Draft POs open the same
// drawer with editable lines; "New purchase order" and reorder suggestions start a new draft.

type View = 'purchase-order';
type TabKey = 'pos' | 'suppliers' | 'reorder';

const DESIGN_REF = 'PUR-2610-0042';
const STATUS_FILTERS = ['All statuses', 'Draft', 'Sent', 'Partly received', 'Received'];
const TODAY = 'Oct 10';

const subtotalOf = (lines: PoLine[]) => lines.reduce((s, l) => s + l.ordered * l.unit, 0);
const totalOf = (po: PurchaseOrder) => subtotalOf(po.lines) + po.freight;
const unitsOf = (po: PurchaseOrder) => po.lines.reduce((s, l) => s + l.ordered, 0);
const isDraftLike = (po: PurchaseOrder) => po.status === 'Draft' || po.status === 'In review';
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/* ---------- Draft editing ---------- */

interface LineForm {
  sku: string;
  name: string;
  qty: string;
  unit: string;
}
interface PoForm {
  supplier: string;
  expected: string;
  freight: string;
  lines: LineForm[];
  addSku: string;
}
interface FormErrors {
  supplier?: string;
  lines?: string;
  freight?: string;
  line: Record<number, { qty?: string; unit?: string }>;
}

const toForm = (po: PurchaseOrder): PoForm => ({
  supplier: po.supplier,
  expected: po.expected === 'Not set' ? '' : po.expected,
  freight: po.freight.toFixed(2),
  lines: po.lines.map((l) => ({ sku: l.sku, name: l.name, qty: String(l.ordered), unit: l.unit.toFixed(2) })),
  addSku: '',
});
const n = (s: string) => (Number.isFinite(Number(s)) ? Number(s) : 0);
const formSubtotal = (f: PoForm) => f.lines.reduce((s, l) => s + n(l.qty) * n(l.unit), 0);

function validateForm(f: PoForm): FormErrors {
  const e: FormErrors = { line: {} };
  if (!f.supplier) e.supplier = 'Choose a supplier.';
  if (!f.lines.length) e.lines = 'Add at least one line.';
  f.lines.forEach((l, i) => {
    const le: { qty?: string; unit?: string } = {};
    if (!/^\d+$/.test(l.qty.trim()) || Number(l.qty) < 1) le.qty = 'Enter a whole number of 1 or more.';
    if (!l.unit.trim() || !Number.isFinite(Number(l.unit)) || Number(l.unit) <= 0) le.unit = 'Enter a unit cost above $0.00.';
    if (le.qty || le.unit) e.line[i] = le;
  });
  if (!f.freight.trim() || !Number.isFinite(Number(f.freight)) || Number(f.freight) < 0) e.freight = 'Enter freight in dollars, or 0.00.';
  return e;
}
const hasErrors = (e: FormErrors) => !!(e.supplier || e.lines || e.freight || Object.keys(e.line).length);

/* ---------- Small blocks ---------- */

function EventList({ events }: { events: PoEvent[] }) {
  return (
    <ol className="timeline">
      {events.map((e, i) => (
        <li key={i} className={`ev is-${e.state}`}>
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

function ReceivedLine({ l, restDue }: { l: PoLine; restDue?: string }) {
  const pct = Math.round((l.received / l.ordered) * 100);
  const complete = l.received >= l.ordered;
  const tone = complete ? 't-success' : l.received > 0 ? 't-warning' : '';
  return (
    <div className="panel stack gap-2">
      <div className="row between top">
        <span className="stack gap-0">
          <span className="small strong">{l.name}</span>
          <span className="xs muted mono">{l.sku}</span>
        </span>
        <span className="small num strong">{money(l.ordered * l.unit)}</span>
      </div>
      <div className={cx('meter', tone)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={l.name}>
        {complete ? <i className="u-w-100pct" /> : <i style={{ width: `${pct}%` }} />}
      </div>
      {!complete && l.received > 0 && <span className="xs strong meter-note t-warning-text">Near target</span>}
      <div className="row between xs">
        <span>
          <b className="num">{num(l.received)}</b> of <b className="num">{num(l.ordered)}</b> received
          {l.damaged > 0 && (
            <>
              {' · '}
              <span className="t-danger-text strong">{l.damaged} damaged, held</span>
            </>
          )}
        </span>
        <span className="muted">
          {money(l.unit)} each · {complete ? 'Complete' : (restDue ?? 'Not received')}
        </span>
      </div>
    </div>
  );
}

function SupplierTable({ suppliers, pos, label }: { suppliers: Supplier[]; pos: PurchaseOrder[]; label: string }) {
  return (
    <TableWrap label={label}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Supplier</th>
            <th scope="col">Contact</th>
            <th className="r" scope="col">Lead time</th>
            <th className="r" scope="col">On time</th>
            <th className="r" scope="col">Open POs</th>
          </tr>
        </thead>
        <tbody>
          {suppliers.map((s) => (
            <tr key={s.name}>
              <td>
                <span className="stack gap-0">
                  <span className="small strong">{s.name}</span>
                  <span className="xs muted">{s.city}</span>
                </span>
              </td>
              <td>
                <span className="small">{s.contact || '—'}</span>
              </td>
              <td className="r">{plural(s.leadDays, 'day')}</td>
              <td className="r">
                <span className={cx(s.onTime !== null && s.onTime < ON_TIME_WARN && 't-warning-text strong')}>{s.onTime === null ? 'New' : `${s.onTime}%`}</span>
              </td>
              <td className="r">{pos.filter((p) => p.supplier === s.name && p.status !== 'Received').length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/* ---------- Page ---------- */

interface SupplierForm {
  name: string;
  city: string;
  contact: string;
  lead: string;
}
const EMPTY_SUPPLIER: SupplierForm = { name: '', city: '', contact: '', lead: '' };
function validateSupplier(f: SupplierForm, existing: Supplier[]) {
  const e: Partial<Record<keyof SupplierForm, string>> = {};
  if (!f.name.trim()) e.name = "Enter the supplier's name.";
  else if (existing.some((s) => s.name.toLowerCase() === f.name.trim().toLowerCase())) e.name = 'This supplier is already in the list.';
  if (!/^.+,\s*[A-Z]{2}$/.test(f.city.trim())) e.city = 'Enter a city and state, like Reno, NV.';
  if (!/^\d+$/.test(f.lead.trim()) || Number(f.lead) < 1) e.lead = 'Enter a lead time in whole days, like 7.';
  return e;
}

export default function Purchasing() {
  const [view, setView] = useView<View>();
  const [pos, setPos] = useState(PURCHASE_ORDERS);
  const [suppliers, setSuppliers] = useState(SUPPLIERS);
  const [tab, setTab] = useState<TabKey>('pos');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(STATUS_FILTERS[0]);
  const [supplierFilter, setSupplierFilter] = useState('All suppliers');
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);

  /* ----- KPIs ----- */
  const open = pos.filter((p) => p.status !== 'Received');
  const committed = open.reduce((s, p) => s + totalOf(p), 0);

  /* ----- Purchase order table ----- */
  const needle = q.trim().toLowerCase();
  const rows = pos.filter((p) => {
    if (status !== STATUS_FILTERS[0] && p.status !== status) return false;
    if (supplierFilter !== 'All suppliers' && p.supplier !== supplierFilter) return false;
    if (!needle) return true;
    return p.ref.toLowerCase().includes(needle) || p.supplier.toLowerCase().includes(needle) || p.lines.some((l) => l.sku.toLowerCase().includes(needle));
  });

  /* ----- Drawer ----- */
  const [selRef, setSelRef] = useState(DESIGN_REF);
  const [newPo, setNewPo] = useState<PurchaseOrder | null>(null);
  const [form, setForm] = useState<PoForm | null>(null);
  const [tried, setTried] = useState(false);
  const [claims, setClaims] = useState<string[]>([]);
  const po = (newPo && newPo.ref === selRef ? newPo : pos.find((p) => p.ref === selRef)) ?? pos.find((p) => p.ref === DESIGN_REF)!;
  const drawerOpen = view === 'purchase-order';
  const editing = po.status === 'Draft' && form !== null;

  const openPo = (p: PurchaseOrder) => {
    setSelRef(p.ref);
    setForm(p.status === 'Draft' ? toForm(p) : null);
    setTried(false);
    setView('purchase-order');
  };
  const nextRef = () => {
    const max = Math.max(...pos.map((p) => Number(p.ref.slice(-4))), newPo ? Number(newPo.ref.slice(-4)) : 0);
    return `PUR-2610-${String(max + 1).padStart(4, '0')}`;
  };
  const startDraft = (supplier = '', lines: PoLine[] = []) => {
    const draft: PurchaseOrder = {
      ref: nextRef(), supplier, status: 'Draft', expected: 'Not set', expectedDetail: 'Not set', created: TODAY, createdBy: BUYER,
      shipTo: 'Marketly warehouse, Reno, NV', terms: 'Net 30 from invoice', freight: 0, lines,
      events: [{ t: 'Draft created', d: `${TODAY} · ${BUYER}`, state: 'done' }],
    };
    setNewPo(draft);
    openPo(draft);
  };
  const closeDrawer = () => setView('');

  const errors: FormErrors = form && tried ? validateForm(form) : { line: {} };
  const setF = (patch: Partial<PoForm>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const setLine = (i: number, patch: Partial<LineForm>) => setForm((f) => (f ? { ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) } : f));
  const removeLine = (i: number) => setForm((f) => (f ? { ...f, lines: f.lines.filter((_, j) => j !== i) } : f));
  const catalogue = form ? (SUPPLIER_ITEMS[form.supplier] ?? []).filter((it) => !form.lines.some((l) => l.sku === it.sku)) : [];
  const addLine = () => {
    if (!form) return;
    const it = catalogue.find((c) => c.sku === form.addSku) ?? catalogue[0];
    if (!it) return;
    setF({ lines: [...form.lines, { sku: it.sku, name: it.name, qty: '1', unit: it.unit.toFixed(2) }], addSku: '' });
  };
  const fSubtotal = form ? formSubtotal(form) : 0;
  const fTotal = fSubtotal + (form ? n(form.freight) : 0);
  const overLimit = editing ? fTotal > PO_LIMIT : totalOf(po) > PO_LIMIT;

  const commit = (mode: 'save' | 'send') => {
    if (!form) return;
    setTried(true);
    if (hasErrors(validateForm(form))) return;
    const lines: PoLine[] = form.lines.map((l) => ({ sku: l.sku, name: l.name, ordered: Number(l.qty), unit: Number(l.unit), received: 0, damaged: 0 }));
    const total = subtotalOf(lines) + Number(form.freight);
    const toApprover = mode === 'send' && total > PO_LIMIT;
    const expected = form.expected.trim() || 'Not set';
    const next: PurchaseOrder = {
      ...po,
      supplier: form.supplier,
      freight: Number(form.freight),
      lines,
      expected,
      expectedDetail: expected,
      restDue: expected === 'Not set' ? undefined : `Due ${expected}`,
      status: mode === 'save' ? 'Draft' : toApprover ? 'In review' : 'Sent',
      events:
        mode === 'save'
          ? po.events
          : [{ t: toApprover ? `Sent to ${APPROVER} for approval` : 'Sent to supplier', d: `${TODAY} · ${BUYER}`, state: toApprover ? 'current' : 'done' }, ...po.events],
    };
    setPos((list) => (list.some((p) => p.ref === next.ref) ? list.map((p) => (p.ref === next.ref ? next : p)) : [next, ...list]));
    if (newPo?.ref === next.ref) setNewPo(null);
    setNotice(
      mode === 'save'
        ? { title: `${next.ref} saved as a draft`, body: `${plural(lines.length, 'line')} · ${money(total)}. Nothing is sent to ${next.supplier} until you send it.` }
        : toApprover
          ? { title: `${next.ref} sent to ${APPROVER} for approval`, body: `${money(total)} is over the ${money(PO_LIMIT)} limit. It goes to ${next.supplier} once the Business Owner approves.` }
          : { title: `${next.ref} sent to ${next.supplier}`, body: `${money(total)} committed. The warehouse sees it as incoming stock.` },
    );
    setForm(null);
    closeDrawer();
  };
  const deleteDraft = () => {
    setPos((list) => list.filter((p) => p.ref !== po.ref));
    if (newPo?.ref === po.ref) setNewPo(null);
    setNotice({ title: `${po.ref} deleted`, body: 'The draft was not sent, so nothing changes for the supplier.' });
    setSelRef(DESIGN_REF);
    setForm(null);
    closeDrawer();
  };
  const openClaim = () => {
    setClaims((c) => [...c, po.ref]);
  };

  /* ----- Add supplier ----- */
  const [supOpen, setSupOpen] = useState(false);
  const [sup, setSup] = useState<SupplierForm>(EMPTY_SUPPLIER);
  const [supTried, setSupTried] = useState(false);
  const supErrors = supTried ? validateSupplier(sup, suppliers) : {};
  const saveSupplier = () => {
    setSupTried(true);
    if (Object.keys(validateSupplier(sup, suppliers)).length) return;
    setSuppliers((s) => [...s, { name: sup.name.trim(), city: sup.city.trim(), contact: sup.contact.trim(), leadDays: Number(sup.lead), onTime: null }]);
    setNotice({ title: `${sup.name.trim()} added`, body: 'You can now choose this supplier on a new purchase order.' });
    setSupOpen(false);
  };

  const damaged = po.lines.reduce((s, l) => s + l.damaged, 0);
  const claimValue = po.lines.reduce((s, l) => s + l.damaged * l.unit, 0);
  const receivedValue = po.lines.reduce((s, l) => s + l.received * l.unit, 0);
  const supplierInfo = suppliers.find((s) => s.name === po.supplier);
  const claimed = claims.includes(po.ref);

  return (
    <AdminLayout active="purchasing">
      <PageHeader
        crumbs={[{ label: 'Official store' }, { label: 'Suppliers and purchasing' }]}
        title="Suppliers and purchasing"
        sub="Owner Ken Watanabe, Purchasing Manager · POs up to $25,000 without extra approval"
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon="plus"
              onClick={() => {
                setSup(EMPTY_SUPPLIER);
                setSupTried(false);
                setSupOpen(true);
              }}
            >
              Add supplier
            </Button>
            <Button size="sm" icon="file-plus" onClick={() => startDraft()}>
              New purchase order
            </Button>
          </>
        }
      />

      {notice && (
        <Alert tone="success" title={notice.title}>
          {notice.body}
        </Alert>
      )}

      <div className="aa-kpis">
        <Card pad>
          <Stat label="Open purchase orders" value={open.length} note={`${money(committed)} committed`} />
        </Card>
        <Card pad>
          <Stat label="Incoming units" value="660" note="Next arrival Oct 13" />
        </Card>
        <Card pad>
          <Stat label="Late or short" value={<span className="t-warning-text">1</span>} note="PUR-2610-0042 · 80 units" />
        </Card>
        <Card pad>
          <Stat label="Low-stock items" value="12" note={`Reorder suggested for ${REORDER.length}`} />
        </Card>
      </div>

      <section className="card">
        <Tabs<TabKey>
          items={[
            { value: 'pos', label: 'Purchase orders', count: pos.length },
            { value: 'suppliers', label: 'Suppliers', count: suppliers.length },
            { value: 'reorder', label: 'Reorder suggestions', count: REORDER.length },
          ]}
          active={tab}
          onChange={setTab}
        />
        {tab === 'pos' && (
          <>
            <div className="card-body">
              <div className="toolbar">
                <SearchInput id="aa-po-q" placeholder="Search PUR ref, supplier or SKU" value={q} onChange={setQ} />
                <Select id="aa-po-st" aria-label="Status" options={STATUS_FILTERS} value={status} onChange={(e) => setStatus(e.target.value)} />
                <Select id="aa-po-sup" aria-label="Supplier" options={['All suppliers', ...suppliers.map((s) => s.name)]} value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)} />
              </div>
            </div>
            <TableWrap label="Suppliers and purchasing table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Purchase order</th>
                    <th scope="col">Supplier</th>
                    <th scope="col">Items</th>
                    <th className="r" scope="col">Cost</th>
                    <th scope="col">Expected arrival</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const total = totalOf(p);
                    const needsApproval = isDraftLike(p) && total > PO_LIMIT;
                    const warn = needsApproval || p.status === 'Partly received';
                    const onOpen = (e: MouseEvent) => {
                      e.preventDefault();
                      openPo(p);
                    };
                    return (
                      <tr key={p.ref} className={cx(warn && 'is-warn')}>
                        <td>
                          {warn && <span className="sr-only">At risk: </span>}
                          <a className="mono strong nowrap" href={href('admin/purchasing', 'purchase-order')} title={p.ref} onClick={onOpen}>
                            {p.ref}
                          </a>
                        </td>
                        <td>
                          <span className="small strong">{p.supplier}</span>
                        </td>
                        <td>
                          <span className="small">
                            {plural(p.lines.length, 'line')} · {num(unitsOf(p))} units
                          </span>
                        </td>
                        <td className="r">
                          <span className="stack gap-0">
                            <span className="strong">{money(total)}</span>
                            {needsApproval && <span className="xs t-warning-text strong">{p.status === 'In review' ? `Waiting for ${APPROVER}` : `Over $25,000: needs ${APPROVER}`}</span>}
                          </span>
                        </td>
                        <td>
                          <span className="small nowrap">{p.expected}</span>
                        </td>
                        <td>
                          <StatusBadge status={p.status} />
                        </td>
                        <td>
                          <a className="btn btn-ghost btn-sm" href={href('admin/purchasing', 'purchase-order')} onClick={onOpen}>
                            <span>{p.status === 'Partly received' ? 'Open' : 'View'}</span>
                            <span className="sr-only"> {p.ref}</span>
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                  {!rows.length && (
                    <tr>
                      <td colSpan={7}>
                        <EmptyState icon="search-x" title="No purchase orders match">
                          Try another PUR ref, supplier or SKU, or clear the filters.
                        </EmptyState>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </TableWrap>
            <p className="status-legend status-legend--edge">
              <span className="sr-only">Legend: </span>
              <span className="sl sl-warning">
                <i aria-hidden="true" />
                Amber edge = at risk: due soon or near target
              </span>
            </p>
          </>
        )}
        {tab === 'suppliers' && <SupplierTable suppliers={suppliers} pos={pos} label="Supplier list table" />}
        {tab === 'reorder' && (
          <TableWrap label="Reorder suggestions table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Supplier</th>
                  <th className="r" scope="col">Available</th>
                  <th className="r" scope="col">Sells per day</th>
                  <th className="r" scope="col">Suggested</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {REORDER.map((r) => {
                  const it = SUPPLIER_ITEMS[r.supplier].find((i) => i.sku === r.sku)!;
                  return (
                    <tr key={r.sku}>
                      <td>
                        <span className="stack gap-0">
                          <span className="small strong">{r.name}</span>
                          <span className="xs muted mono">{r.sku}</span>
                        </span>
                      </td>
                      <td>
                        <span className="small">{r.supplier}</span>
                      </td>
                      <td className="r">
                        <span className="strong num t-warning-text">{r.available}</span>
                      </td>
                      <td className="r">{r.perDay}</td>
                      <td className="r">
                        <span className="stack gap-0">
                          <span className="strong num">{num(r.suggested)}</span>
                          <span className="xs muted">{money(r.suggested * it.unit)}</span>
                        </span>
                      </td>
                      <td>
                        <Button variant="ghost" size="sm" onClick={() => startDraft(r.supplier, [{ sku: r.sku, name: it.name, unit: it.unit, ordered: r.suggested, received: 0, damaged: 0 }])}>
                          Create draft PO
                          <span className="sr-only"> {r.sku}</span>
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>

      <Card title="Suppliers" sub="Lead time and on-time arrival over the last 90 days" flush>
        <SupplierTable suppliers={suppliers} pos={pos} label="Suppliers table" />
      </Card>

      <Drawer
        open={drawerOpen}
        onClose={closeDrawer}
        title={po.ref}
        foot={
          editing ? (
            <>
              <Button variant="ghost" icon="trash-2" onClick={deleteDraft}>
                Delete draft
              </Button>
              <Button variant="secondary" onClick={() => commit('save')}>
                Save draft
              </Button>
              <Button icon="send" onClick={() => commit('send')}>
                {overLimit ? `Send to ${APPROVER} for approval` : 'Send to supplier'}
              </Button>
            </>
          ) : po.status === 'Partly received' || po.status === 'Sent' ? (
            <>
              {damaged > 0 && (
                <Button variant="ghost" onClick={openClaim} disabled={claimed}>
                  {claimed ? 'Supplier claim opened' : 'Open supplier claim'}
                </Button>
              )}
              <Button icon="package-check" to={href('ops/receiving')}>
                Record receipt
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={closeDrawer}>
              Close
            </Button>
          )
        }
      >
        <div className="row between">
          <StatusBadge status={po.status} />
          <span className="xs muted">
            Created {po.created} by {po.createdBy}
          </span>
        </div>

        {editing && form ? (
          <>
            {newPo?.ref === po.ref && (
              <Field label="Supplier" error={errors.supplier}>
                <Select
                  id="po-supplier"
                  className={cx(errors.supplier && 'is-error')}
                  options={[{ value: '', label: 'Choose a supplier' }, ...suppliers.map((s) => ({ value: s.name, label: s.name }))]}
                  value={form.supplier}
                  onChange={(e) => setF({ supplier: e.target.value, lines: form.supplier === e.target.value ? form.lines : [], addSku: '' })}
                />
              </Field>
            )}
            <KeyValue
              pairs={[
                ...(newPo?.ref === po.ref ? [] : [['Supplier', supplierInfo ? `${po.supplier}, ${supplierInfo.city}` : po.supplier] as [string, string]]),
                ['Ship to', po.shipTo],
                ['Approval', fTotal > PO_LIMIT ? `Over ${BUYER}'s limit: needs ${APPROVER} (Business Owner)` : `Within ${BUYER}'s limit (POs up to $25,000)`],
                ['Payment terms', po.terms],
              ]}
            />
            <div className="stack gap-2">
              <span className="label">Lines · quantity and unit cost</span>
              {form.lines.map((l, i) => (
                <div className="panel stack gap-2" key={l.sku}>
                  <div className="row between top">
                    <span className="stack gap-0">
                      <span className="small strong">{l.name}</span>
                      <span className="xs muted mono">{l.sku}</span>
                    </span>
                    <span className="small num strong">{money(n(l.qty) * n(l.unit))}</span>
                  </div>
                  <div className="grid md2 gap-3">
                    <Field label="Quantity" error={errors.line[i]?.qty}>
                      <TextInput id={`po-qty-${i}`} ctl="sm" inputMode="numeric" value={l.qty} error={!!errors.line[i]?.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                    </Field>
                    <Field label="Unit cost" error={errors.line[i]?.unit}>
                      <TextInput id={`po-unit-${i}`} ctl="sm" prefix="$" inputMode="decimal" value={l.unit} error={!!errors.line[i]?.unit} onChange={(e) => setLine(i, { unit: e.target.value })} />
                    </Field>
                  </div>
                  <div className="row">
                    <Button variant="ghost" size="sm" icon="trash-2" onClick={() => removeLine(i)}>
                      Remove line
                      <span className="sr-only"> {l.sku}</span>
                    </Button>
                  </div>
                </div>
              ))}
              {errors.lines && (
                <span className="error-text">
                  <Icon name="circle-alert" className="ic-sm" />
                  {errors.lines}
                </span>
              )}
              {form.supplier && catalogue.length > 0 && (
                <div className="row gap-2">
                  <Select
                    id="po-add-sku"
                    aria-label="Product to add"
                    ctl="sm"
                    options={catalogue.map((c) => ({ value: c.sku, label: `${c.name} · ${money(c.unit)}` }))}
                    value={form.addSku || catalogue[0].sku}
                    onChange={(e) => setF({ addSku: e.target.value })}
                  />
                  <Button variant="secondary" size="sm" icon="plus" onClick={addLine}>
                    Add line
                  </Button>
                </div>
              )}
            </div>
            <div className="grid md2 gap-3">
              <Field label="Freight" error={errors.freight}>
                <TextInput id="po-freight" prefix="$" inputMode="decimal" value={form.freight} error={!!errors.freight} onChange={(e) => setF({ freight: e.target.value })} />
              </Field>
              <Field label="Expected arrival" optional>
                <TextInput id="po-expected" placeholder="Oct 20" value={form.expected} onChange={(e) => setF({ expected: e.target.value })} />
              </Field>
            </div>
            <div className="well stack gap-2">
              <SummaryRow k="Lines subtotal" v={money(fSubtotal)} />
              <SummaryRow k="Freight" v={money(n(form.freight))} />
              <SummaryRow k="PO total" v={money(fTotal)} className="total" />
            </div>
            {fTotal > PO_LIMIT && (
              <Alert tone="warning" title={`Over the ${money(PO_LIMIT)} limit`}>
                {BUYER} can send purchase orders up to $25,000. This one is {money(fTotal)}, so it goes to {APPROVER} (Business Owner) for approval before the supplier sees it.
              </Alert>
            )}
          </>
        ) : (
          <>
            <KeyValue
              pairs={[
                ['Supplier', supplierInfo ? `${po.supplier}, ${supplierInfo.city}` : po.supplier],
                ['Ship to', po.shipTo],
                ['Expected', po.expectedDetail],
                ['Approval', totalOf(po) > PO_LIMIT ? (po.status === 'In review' ? `Waiting for ${APPROVER} (Business Owner)` : `Approved by ${APPROVER}`) : `Within ${BUYER}'s limit (POs up to $25,000)`],
                ['Payment terms', po.terms],
              ]}
            />
            <div className="stack gap-2">
              <span className="label">{isDraftLike(po) ? 'Lines · ordered' : 'Lines · expected vs received'}</span>
              {po.lines.map((l) =>
                isDraftLike(po) ? (
                  <div className="panel stack gap-2" key={l.sku}>
                    <div className="row between top">
                      <span className="stack gap-0">
                        <span className="small strong">{l.name}</span>
                        <span className="xs muted mono">{l.sku}</span>
                      </span>
                      <span className="small num strong">{money(l.ordered * l.unit)}</span>
                    </div>
                    <div className="row between xs">
                      <span>
                        <b className="num">{num(l.ordered)}</b> units
                      </span>
                      <span className="muted">{money(l.unit)} each</span>
                    </div>
                  </div>
                ) : (
                  <ReceivedLine key={l.sku} l={l} restDue={po.restDue} />
                ),
              )}
            </div>
            <div className="well stack gap-2">
              <SummaryRow k="Lines subtotal" v={money(subtotalOf(po.lines))} />
              <SummaryRow k="Freight" v={money(po.freight)} />
              <SummaryRow k="PO total" v={money(totalOf(po))} className="total" />
              {receivedValue > 0 && <SummaryRow k="Received value" v={money(receivedValue)} />}
              {damaged > 0 && <SummaryRow k={`Supplier claim · ${damaged} damaged`} v={money(claimValue)} />}
            </div>
            {claimed && (
              <Alert tone="success" title="Supplier claim opened">
                Claim for {damaged} damaged units ({money(claimValue)}) sent to {supplierInfo?.contact ?? 'the supplier'} at {po.supplier}. The units stay held until it is settled.
              </Alert>
            )}
            {po.info && (
              <Alert tone="info" title={po.info.title}>
                {po.info.body}
              </Alert>
            )}
          </>
        )}
        <EventList events={po.events} />
      </Drawer>

      <Dialog
        open={supOpen}
        onClose={() => setSupOpen(false)}
        title="Add supplier"
        foot={
          <>
            <Button variant="ghost" onClick={() => setSupOpen(false)}>
              Cancel
            </Button>
            <Button icon="check" onClick={saveSupplier}>
              Add supplier
            </Button>
          </>
        }
      >
        <Field label="Supplier name" error={supErrors.name}>
          <TextInput id="sup-name" value={sup.name} error={!!supErrors.name} onChange={(e) => setSup({ ...sup, name: e.target.value })} />
        </Field>
        <div className="grid md2 gap-3">
          <Field label="City and state" error={supErrors.city}>
            <TextInput id="sup-city" placeholder="Reno, NV" value={sup.city} error={!!supErrors.city} onChange={(e) => setSup({ ...sup, city: e.target.value })} />
          </Field>
          <Field label="Lead time" error={supErrors.lead}>
            <TextInput id="sup-lead" suffix="days" inputMode="numeric" value={sup.lead} error={!!supErrors.lead} onChange={(e) => setSup({ ...sup, lead: e.target.value })} />
          </Field>
        </div>
        <Field label="Contact" optional>
          <TextInput id="sup-contact" value={sup.contact} onChange={(e) => setSup({ ...sup, contact: e.target.value })} />
        </Field>
      </Dialog>
    </AdminLayout>
  );
}
