import { useState } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Dialog, EmptyState, Field, Icon, Img, SearchInput, Select, StatusBadge, StatusLegend, TableWrap, Textarea, TextInput, announce, type IconName } from '@marketly/web-shared/ui';

// Design: pages/seller/seller-inventory.html · view "adjust-stock" = the Adjust stock dialog for
// NWA-PKT-CHR (6 → 18, received new stock). Inline quantity edits ask for a reason before saving.

type View = 'adjust-stock';

interface StockRow {
  sku: string;
  name: string;
  variant: string;
  category: string;
  icon: IconName;
  tint: string;
  available: number;
  reserved: number;
  low: number;
  updated: string;
}

interface Adjustment {
  when: string;
  sku: string;
  from: number;
  to: number;
  reason: string;
  by: string;
  /** Free-text instead of "from → to" (e.g. offer hidden). */
  detail?: string;
}

const ROWS: StockRow[] = [
  { sku: 'NWA-PKT-TEAL', name: 'Halden Pocket Bluetooth Speaker', variant: 'Teal', category: 'Speakers', icon: 'speaker', tint: '2', available: 88, reserved: 4, low: 10, updated: 'Oct 8, 9:15 AM · Order MK-261008-12077' },
  { sku: 'NWA-PKT-CHR', name: 'Halden Pocket Bluetooth Speaker', variant: 'Charcoal', category: 'Speakers', icon: 'speaker', tint: '6', available: 6, reserved: 1, low: 10, updated: 'Oct 7, 6:49 PM · Order MK-261007-10433' },
  { sku: 'NWA-AUR-BLK', name: 'Halden Aurora ANC Wireless Headphones', variant: 'Midnight black', category: 'Headphones', icon: 'headphones', tint: '2', available: 14, reserved: 2, low: 5, updated: 'Oct 8, 8:03 AM · Order MK-261008-11902' },
  { sku: 'NWA-AUR-SLV', name: 'Halden Aurora ANC Wireless Headphones', variant: 'Silver', category: 'Headphones', icon: 'headphones', tint: '1', available: 0, reserved: 1, low: 5, updated: 'Oct 7, 3:21 PM · Order MK-261007-10291' },
  { sku: 'NWA-CBL-KIT', name: 'Northwind Studio Cable Kit', variant: '3.5 mm + 6.35 mm, 2 m', category: 'Cables and adapters', icon: 'cable', tint: '3', available: 42, reserved: 5, low: 15, updated: 'Oct 6, 4:30 PM · Avery Stone, received stock' },
  { sku: 'NWA-AUR-BLK-U', name: 'Halden Aurora ANC Wireless Headphones', variant: 'Midnight black', category: 'Headphones', icon: 'headphones', tint: '2', available: 2, reserved: 0, low: 2, updated: 'Oct 2, 11:12 AM · Avery Stone' },
  { sku: 'NWA-BUDS-CHR', name: 'Halden Buds Pro True Wireless Earbuds', variant: 'Charcoal', category: 'Headphones', icon: 'ear', tint: '1', available: 12, reserved: 0, low: 4, updated: 'Oct 4, 3:00 PM · Catalog team' },
];

const HISTORY: Adjustment[] = [
  { when: 'Oct 6, 4:30 PM', sku: 'NWA-CBL-KIT', from: 12, to: 42, reason: 'Received new stock · Invoice 7781', by: 'Avery Stone' },
  { when: 'Oct 5, 11:02 AM', sku: 'NWA-PKT-CHR', from: 9, to: 7, reason: 'Damaged · dented grille, set aside', by: 'Jae Park' },
  { when: 'Oct 2, 11:12 AM', sku: 'NWA-AUR-BLK-U', from: 0, to: 0, reason: 'Hold for photos', by: 'Avery Stone', detail: 'offer hidden' },
];

const REASONS = ['Received new stock', 'Count correction', 'Damaged or defective', 'Lost or missing', 'Returned item restocked', 'Moved to another channel', 'Other'];
const NOW = 'Oct 8, 10:14 AM';

const statusOf = (r: { available: number; low: number }) => (r.available === 0 ? 'Out of stock' : r.available <= r.low ? 'Low stock' : 'In stock');

interface AdjustDraft {
  /** One SKU (Adjust button) or the inline edits being saved. */
  skus: string[];
  mode: 'one' | 'edits';
  qty: string;
  reason: string;
  note: string;
}

export default function Inventory() {
  const [view, setView] = useView<View>();
  const [rows, setRows] = useState(ROWS);
  const [history, setHistory] = useState(HISTORY);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [st, setSt] = useState('All statuses');
  const [cat, setCat] = useState('All categories');
  const [done, setDone] = useState('');
  const [draft, setDraft] = useState<AdjustDraft>(() =>
    view === 'adjust-stock' ? { skus: ['NWA-PKT-CHR'], mode: 'one', qty: '18', reason: REASONS[0], note: 'Shipment from Halden distributor, invoice HD-55102.' } : { skus: [], mode: 'one', qty: '', reason: REASONS[0], note: '' },
  );
  const [tried, setTried] = useState(false);

  const needle = q.trim().toLowerCase();
  const visible = rows.filter((r) => (!needle || `${r.name} ${r.variant} ${r.sku}`.toLowerCase().includes(needle)) && (st === 'All statuses' || statusOf(r) === st) && (cat === 'All categories' || r.category === cat));

  const inStock = rows.filter((r) => statusOf(r) === 'In stock');
  const low = rows.filter((r) => statusOf(r) === 'Low stock');
  const out = rows.filter((r) => statusOf(r) === 'Out of stock');
  const reserved = rows.reduce((a, r) => a + r.reserved, 0);

  // Inline edits that differ from the saved quantity.
  const changed = Object.entries(edits).filter(([sku, v]) => {
    const r = rows.find((x) => x.sku === sku);
    return r && v.trim() !== '' && Number(v) !== r.available;
  });
  const invalidEdit = changed.some(([, v]) => !Number.isInteger(Number(v)) || Number(v) < 0);

  const single = draft.mode === 'one' ? rows.find((r) => r.sku === draft.skus[0]) : undefined;
  const qtyN = Number(draft.qty);
  const qtyErr = !single || !tried ? '' : draft.qty.trim() === '' || !Number.isInteger(qtyN) || qtyN < 0 ? 'Enter a whole number of 0 or more.' : qtyN === single.available ? 'Enter a different quantity to record an adjustment.' : '';
  const diff = single && draft.qty.trim() !== '' && Number.isInteger(qtyN) ? qtyN - single.available : 0;

  const openAdjust = (sku: string) => {
    const r = rows.find((x) => x.sku === sku)!;
    setDraft({ skus: [sku], mode: 'one', qty: edits[sku] ?? String(r.available), reason: REASONS[0], note: '' });
    setTried(false);
    setView('adjust-stock');
  };
  const openSaveEdits = () => {
    if (invalidEdit) return;
    setDraft({ skus: changed.map(([sku]) => sku), mode: 'edits', qty: '', reason: REASONS[1], note: '' });
    setTried(false);
    setView('adjust-stock');
  };
  const close = () => setView('');

  const save = () => {
    setTried(true);
    const targets: Array<[string, number]> = single ? [[single.sku, qtyN]] : changed.map(([sku, v]) => [sku, Number(v)]);
    if (single && (draft.qty.trim() === '' || !Number.isInteger(qtyN) || qtyN < 0 || qtyN === single.available)) return;
    if (!targets.length) return;
    const reasonText = draft.note.trim() ? `${draft.reason} · ${draft.note.trim()}` : draft.reason;
    const entries: Adjustment[] = targets.map(([sku, to]) => ({ when: NOW, sku, from: rows.find((r) => r.sku === sku)!.available, to, reason: reasonText, by: 'Avery Stone' }));
    setRows((list) => list.map((r) => {
      const t = targets.find(([sku]) => sku === r.sku);
      return t ? { ...r, available: t[1], updated: `${NOW} · Avery Stone, ${draft.reason.toLowerCase()}` } : r;
    }));
    setHistory((h) => [...entries, ...h]);
    setEdits((e) => {
      const next = { ...e };
      targets.forEach(([sku]) => delete next[sku]);
      return next;
    });
    const msg = entries.length === 1 ? `Stock for ${entries[0].sku} changed from ${entries[0].from} to ${entries[0].to}.` : `${entries.length} quantities saved.`;
    setDone(msg);
    announce(msg);
    close();
  };

  const exportCsv = () => {
    const csv = ['seller_sku,product,available,reserved,low_stock_at,status', ...rows.map((r) => [r.sku, `"${r.name}, ${r.variant}"`, r.available, r.reserved, r.low, statusOf(r)].join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'northwind-inventory.csv';
    a.click();
    URL.revokeObjectURL(url);
    announce('Inventory exported');
  };

  const hasDanger = visible.some((r) => statusOf(r) === 'Out of stock');
  const hasWarn = visible.some((r) => statusOf(r) === 'Low stock');

  return (
    <SellerLayout active="inventory">
      <div className="page-head">
        <div className="t">
          <h1 className="h1">Inventory</h1>
          <p className="sub small">Quantities for your approved offers. Customers cannot buy more than the available quantity.</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="download" onClick={exportCsv}>
            Export
          </Button>
          <Button size="sm" icon="upload" to={href('seller/bulk-update')}>
            Bulk update
          </Button>
        </div>
      </div>
      {done && <Alert tone="success" title="Stock updated">{done} The change is recorded in Recent adjustments.</Alert>}
      <div className="sa-kpis">
        <div className="card pad">
          <div className="stat">
            <span className="k">
              <Icon name="package-check" className="ic-sm" />
              In stock
            </span>
            <span className="v">{inStock.length} SKUs</span>
            <span className="d">{inStock.reduce((a, r) => a + r.available, 0)} units available</span>
          </div>
        </div>
        <div className="card pad">
          <div className="stat">
            <span className="k">
              <Icon name="triangle-alert" className="ic-sm" />
              Low stock
            </span>
            <span className="v">
              {low.length} SKU{low.length === 1 ? '' : 's'}
            </span>
            <span className="d">At or below threshold</span>
          </div>
        </div>
        <div className="card pad">
          <div className="stat">
            <span className="k">
              <Icon name="package-x" className="ic-sm" />
              Out of stock
            </span>
            <span className="v">
              {out.length} SKU{out.length === 1 ? '' : 's'}
            </span>
            <span className="d">Customers can't buy until restocked</span>
          </div>
        </div>
        <div className="card pad">
          <div className="stat">
            <span className="k">
              <Icon name="lock" className="ic-sm" />
              Reserved for open orders
            </span>
            <span className="v">{reserved} units</span>
            <span className="d">Released only if an order is cancelled</span>
          </div>
        </div>
      </div>
      <div className="toolbar">
        <SearchInput id="inv-search" placeholder="Search product or SKU" value={q} onChange={setQ} />
        <label className="sr-only" htmlFor="inv-st">
          Stock status
        </label>
        <select className="select" id="inv-st" value={st} onChange={(e) => setSt(e.target.value)}>
          {['All statuses', 'In stock', 'Low stock', 'Out of stock'].map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="inv-cat">
          Category
        </label>
        <select className="select" id="inv-cat" value={cat} onChange={(e) => setCat(e.target.value)}>
          {['All categories', 'Headphones', 'Speakers', 'Cables and adapters'].map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <span className="grow" />
        <Link className="small strong" to={href('seller/bulk-update')}>
          <Icon name="file-spreadsheet" className="ic-sm" /> Update many SKUs with a file
        </Link>
      </div>
      <section className="card">
        <TableWrap label="Inventory table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Product / SKU</th>
                <th className="r" scope="col">
                  Available
                </th>
                <th className="r" scope="col">
                  Reserved
                </th>
                <th className="r" scope="col">
                  Low-stock at
                </th>
                <th scope="col">Status</th>
                <th scope="col">Last updated</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const i = rows.indexOf(r);
                const status = statusOf(r);
                const edge = status === 'Out of stock' ? 'is-flagged' : status === 'Low stock' ? 'is-warn' : '';
                const v = edits[r.sku] ?? String(r.available);
                const bad = v.trim() !== '' && (!Number.isInteger(Number(v)) || Number(v) < 0);
                return (
                  <tr key={r.sku} className={edge}>
                    <td>
                      {edge && <span className="sr-only">{edge === 'is-flagged' ? 'Urgent: ' : 'At risk: '}</span>}
                      <div className="cell-main">
                        <Img icon={r.icon} tint={r.tint} className="tiny" />
                        <div className="stack gap-0">
                          <Link className="small strong" to={href('seller/offer')}>
                            {r.name}
                          </Link>
                          <span className="xs muted">
                            <span className="mono nowrap" title={r.sku}>
                              {r.sku}
                            </span>{' '}
                            · {r.variant}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="r">
                      <label className="sr-only" htmlFor={`inv-q${i}`}>
                        Available for {r.sku}
                      </label>
                      <input
                        className={bad ? 'input sa-num is-error' : 'input sa-num'}
                        id={`inv-q${i}`}
                        type="number"
                        min={0}
                        value={v}
                        aria-invalid={bad || undefined}
                        onChange={(e) => setEdits((x) => ({ ...x, [r.sku]: e.target.value }))}
                      />
                    </td>
                    <td className="r">
                      <span className="num">{r.reserved}</span>
                    </td>
                    <td className="r">
                      <span className="num">{r.low}</span>
                    </td>
                    <td>
                      <StatusBadge status={status} />
                    </td>
                    <td>
                      <span className="xs sub">{r.updated}</span>
                    </td>
                    <td>
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
        {visible.length === 0 && <EmptyState icon="search-x" title="No SKUs match these filters" />}
        {(hasDanger || hasWarn) && (
          <StatusLegend
            items={[
              ...(hasDanger ? [{ tone: 'danger' as const, label: 'Red edge = urgent: overdue or past target' }] : []),
              ...(hasWarn ? [{ tone: 'warning' as const, label: 'Amber edge = at risk: due soon or near target' }] : []),
            ]}
          />
        )}
        <div className="card-foot between">
          <span className="xs muted">{invalidEdit ? <span className="t-danger-text">Quantities must be whole numbers of 0 or more.</span> : 'Changing a quantity asks you for a reason before it saves.'}</span>
          <Button size="sm" disabled={!changed.length || invalidEdit} onClick={openSaveEdits}>
            Save {changed.length} change{changed.length === 1 ? '' : 's'}
          </Button>
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">Recent adjustments</h2>
            <span className="xs muted">Every change keeps its reason, person and time</span>
          </div>
        </div>
        <TableWrap label="Recent adjustments table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">SKU</th>
                <th scope="col">Change</th>
                <th scope="col">Reason</th>
                <th scope="col">By</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => {
                const d = h.to - h.from;
                return (
                  <tr key={`${h.sku}${h.when}${i}`}>
                    <td>{h.when}</td>
                    <td>
                      <span className="mono xs nowrap" title={h.sku}>
                        {h.sku}
                      </span>
                    </td>
                    <td>
                      <span className={d > 0 ? 'num t-success-text strong' : d < 0 ? 'num t-danger-text strong' : 'num'}>{d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '0'}</span>{' '}
                      <span className="xs muted">{h.detail ?? `${h.from} → ${h.to}`}</span>
                    </td>
                    <td>{h.reason}</td>
                    <td>{h.by}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <Dialog
        open={view === 'adjust-stock' && draft.skus.length > 0}
        onClose={close}
        title={single ? 'Adjust stock' : 'Save stock changes'}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={save}>{single ? 'Save adjustment' : `Save ${changed.length} change${changed.length === 1 ? '' : 's'}`}</Button>
          </>
        }
      >
        {single ? (
          <>
            <div className="row gap-3 nowrap">
              <Img icon={single.icon} tint={single.tint} className="thumb" />
              <div className="stack gap-0">
                <span className="strong">
                  {single.name}, {single.variant}
                </span>
                <span className="xs muted mono">{single.sku}</span>
              </div>
            </div>
            <div className="grid c2 gap-3">
              <div className="panel stack gap-0">
                <span className="xs muted">Available now</span>
                <span className="h3 num">{single.available}</span>
              </div>
              <div className="panel stack gap-0">
                <span className="xs muted">Reserved for orders</span>
                <span className="h3 num">{single.reserved}</span>
              </div>
            </div>
            <div className="grid md2">
              <Field label="New available quantity" hint={`Change: ${diff > 0 ? '+' : diff < 0 ? '−' : ''}${Math.abs(diff)} units`} error={qtyErr}>
                <TextInput id="adj-qty" type="number" min={0} value={draft.qty} error={!!qtyErr} onChange={(e) => setDraft((d) => ({ ...d, qty: e.target.value }))} />
              </Field>
              <Field label="Reason">
                <Select id="adj-reason" options={REASONS} value={draft.reason} onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))} />
              </Field>
            </div>
          </>
        ) : (
          <>
            <ul className="list">
              {changed.map(([sku, v]) => {
                const r = rows.find((x) => x.sku === sku)!;
                return (
                  <li key={sku}>
                    <span className="grow stack gap-0">
                      <span className="small strong">
                        {r.name}, {r.variant}
                      </span>
                      <span className="xs muted mono">{sku}</span>
                    </span>
                    <span className="num small">
                      {r.available} → <b>{v}</b>
                    </span>
                  </li>
                );
              })}
            </ul>
            <Field label="Reason">
              <Select id="adj-reason" options={REASONS} value={draft.reason} onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))} />
            </Field>
          </>
        )}
        <Field label="Note" optional hint="Helps your team and our support staff understand the change later.">
          <Textarea id="adj-note" value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} />
        </Field>
        <div className="panel row gap-2 small">
          <Icon name="history" className="ic-sm" />
          <span>
            Recorded as <b>Avery Stone</b> · Oct 8, 2026, 10:14 AM PT, with the reason and note above. Reserved units are not affected.
          </span>
        </div>
      </Dialog>
    </SellerLayout>
  );
}
