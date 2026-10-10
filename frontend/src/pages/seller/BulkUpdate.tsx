import { useRef, useState, type ReactNode } from 'react';
import { SellerLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { useView } from '@/lib/hooks';
import { money } from '@/lib/format';
import { href } from '@/routes/href';
import { Alert, Button, Card, Icon, PageHeader, SegmentedControl, StatusLegend, Steps, TableWrap, announce, type IconName } from '@/ui';
import { PRODUCT_ROWS } from './data/products';

// Design: pages/seller/seller-bulk-update.html (step 3, preview of an uploaded CSV with 4 bad rows) ·
// view "applied" = step 4 done, correction report and upload history. Uploading a CSV parses and
// validates it in the browser against the seller's SKUs.

type View = 'applied';

interface PreviewRow {
  row: number;
  sku: string;
  product?: string;
  oldPrice?: number;
  /** undefined = column not in the file (keep), null = empty cell. */
  newPrice?: number | null;
  rawPrice?: string;
  oldQty?: number;
  newQty?: number;
  rawQty?: string;
  error?: string;
}

interface Stats {
  total: number;
  ready: number;
  price: number;
  stock: number;
  errors: number;
  unchanged: number;
}

interface UploadFile {
  name: string;
  uploaded: string;
  by: string;
  rows: PreviewRow[];
  stats: Stats;
}

interface HistoryRow {
  file: string;
  uploaded: string;
  by: string;
  applied: number;
  skipped: number;
}

const MIN_PRICE: Record<string, number> = { 'Cables and adapters': 5 };
const minPrice = (cat: string) => MIN_PRICE[cat] ?? 10;
const CATALOG = Object.fromEntries(PRODUCT_ROWS.map((r) => [r.sku, r]));
const short = (sku: string) => {
  const r = CATALOG[sku];
  return r ? `${r.name.replace(' Bluetooth', '').replace(' Wireless', '').replace(' True Wireless Earbuds', '').replace(' Headphones', '')}, ${r.condition === 'New' ? r.variant : r.condition}` : undefined;
};

/** The design's uploaded file: 48 rows, 8 shown in the preview. */
const SAMPLE: UploadFile = {
  name: 'northwind-price-stock-2026-10-08.csv',
  uploaded: '10:18 AM',
  by: 'Avery Stone',
  stats: { total: 48, ready: 44, price: 12, stock: 36, errors: 4, unchanged: 0 },
  rows: [
    { row: 2, sku: 'NWA-PKT-TEAL', product: 'Halden Pocket Speaker, Teal', oldPrice: 59, newPrice: 54, oldQty: 88 },
    { row: 3, sku: 'NWA-PKT-CHR', product: 'Halden Pocket Speaker, Charcoal', oldPrice: 59, newPrice: 54, oldQty: 6, newQty: 18 },
    { row: 4, sku: 'NWA-PKT-BLU', rawPrice: '54.00', rawQty: '10', error: 'Unknown SKU. Check the code or create the offer first.' },
    { row: 5, sku: 'NWA-AUR-BLK', product: 'Halden Aurora ANC, Midnight black', oldPrice: 184, newPrice: 179, oldQty: 14, newQty: 20 },
    { row: 6, sku: 'NWA-AUR-SLV', product: 'Halden Aurora ANC, Silver', oldPrice: 184, newPrice: 179, oldQty: 0, newQty: -3, error: "Quantity can't be negative. Enter 0 or more." },
    { row: 7, sku: 'NWA-CBL-KIT', product: 'Northwind Studio Cable Kit', oldPrice: 24, newPrice: 2.4, oldQty: 42, error: 'Price $2.40 is below the $5.00 minimum for Cables and adapters. Did you mean $24.00?' },
    { row: 8, sku: 'NWA-AUR-BLK-U', product: 'Halden Aurora ANC, Used – Good', oldPrice: 139, newPrice: 135, oldQty: 2 },
    { row: 9, sku: 'NWA-BUDS-CHR', product: 'Halden Buds Pro, Charcoal', oldPrice: 149, newPrice: null, oldQty: 12, error: 'Price is empty. Leave the column out to keep the current price.' },
  ],
};

const HISTORY: HistoryRow[] = [{ file: 'stock-count-oct-01.csv', uploaded: 'Oct 1, 5:40 PM', by: 'Jae Park', applied: 22, skipped: 0 }];
const sampleHistory = (f: UploadFile): HistoryRow => ({ file: f.name, uploaded: `Oct 8, ${f.uploaded}`, by: f.by, applied: f.stats.ready, skipped: f.stats.errors });

const priceChanged = (r: PreviewRow) => typeof r.newPrice === 'number' && r.oldPrice !== undefined && r.newPrice !== r.oldPrice;
const qtyChanged = (r: PreviewRow) => r.newQty !== undefined && r.oldQty !== undefined && r.newQty !== r.oldQty;
const isReady = (r: PreviewRow) => !r.error && (priceChanged(r) || qtyChanged(r));

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Parses a seller_sku/price/quantity CSV and validates every row. Returns an error message for a bad file. */
function parseCsv(name: string, text: string): UploadFile | string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return 'The file is empty. Download the template, fill it in and upload it again.';
  const head = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const iSku = head.indexOf('seller_sku');
  const iPrice = head.indexOf('price');
  const iQty = head.indexOf('quantity');
  if (iSku < 0) return 'This file has no seller_sku column. Download the template and keep its header row.';
  if (iPrice < 0 && iQty < 0) return 'Add a price or quantity column. Leave a column out to keep the current values.';
  const rows: PreviewRow[] = lines.slice(1).map((line, k) => {
    const cells = splitCsvLine(line);
    const sku = (cells[iSku] ?? '').toUpperCase();
    const rawPrice = iPrice >= 0 ? (cells[iPrice] ?? '').replace(/^\$/, '') : undefined;
    const rawQty = iQty >= 0 ? cells[iQty] ?? '' : undefined;
    const r: PreviewRow = { row: k + 2, sku };
    const p = CATALOG[sku];
    if (!sku) return { ...r, rawPrice, rawQty, error: 'Seller SKU is empty.' };
    if (!p) return { ...r, rawPrice, rawQty, error: 'Unknown SKU. Check the code or create the offer first.' };
    r.product = short(sku);
    r.oldPrice = p.price;
    r.oldQty = p.stock;
    const errs: string[] = [];
    if (rawPrice !== undefined) {
      if (rawPrice === '') {
        r.newPrice = null;
        errs.push('Price is empty. Leave the column out to keep the current price.');
      } else if (!Number.isFinite(Number(rawPrice))) {
        r.rawPrice = rawPrice;
        errs.push(`Price "${rawPrice}" is not a number. Use digits only, like 54.00.`);
      } else {
        r.newPrice = Number(rawPrice);
        const min = minPrice(p.category);
        if (r.newPrice < min) errs.push(`Price ${money(r.newPrice)} is below the ${money(min)} minimum for ${p.category}. Did you mean ${money(p.price)}?`);
        else if (Math.abs(r.newPrice - p.price) / p.price > 0.5) errs.push(`Price changes over 50% need extra confirmation. Change ${p.sku} on its offer page.`);
      }
    }
    if (rawQty !== undefined && rawQty !== '') {
      const q = Number(rawQty);
      if (!Number.isInteger(q)) {
        r.rawQty = rawQty;
        errs.push('Quantity must be a whole number.');
      } else {
        r.newQty = q;
        if (q < 0) errs.push("Quantity can't be negative. Enter 0 or more.");
      }
    }
    return errs.length ? { ...r, error: errs.join(' ') } : r;
  });
  const t = '10:30 AM'; // mock session clock
  return { name, uploaded: t, by: 'Avery Stone', rows, stats: statsOf(rows) };
}

function statsOf(rows: PreviewRow[]): Stats {
  const ready = rows.filter(isReady);
  return {
    total: rows.length,
    ready: ready.length,
    price: ready.filter(priceChanged).length,
    stock: ready.filter(qtyChanged).length,
    errors: rows.filter((r) => r.error).length,
    unchanged: rows.filter((r) => !r.error && !priceChanged(r) && !qtyChanged(r)).length,
  };
}

function download(name: string, lines: string[][]) {
  const csv = lines.map((l) => l.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function Change({ from, to, money: isMoney }: { from: number; to: number; money?: boolean }) {
  const f = isMoney ? money : String;
  return (
    <span className="num nowrap">
      <span className="sa-strike">{f(from)}</span>
      <span className="sa-arrow">→</span>
      <b>{f(to)}</b>
    </span>
  );
}

function PriceCell({ r }: { r: PreviewRow }) {
  if (r.newPrice === null) return <span className="xs muted">No value</span>;
  if (r.oldPrice === undefined || typeof r.newPrice !== 'number') return r.rawPrice ? <span className="num">{Number.isFinite(Number(r.rawPrice)) ? money(Number(r.rawPrice)) : r.rawPrice}</span> : r.oldPrice !== undefined ? <span className="num muted">{money(r.oldPrice)}</span> : <span className="xs muted">No value</span>;
  return r.newPrice !== r.oldPrice ? <Change from={r.oldPrice} to={r.newPrice} money /> : <span className="num muted">{money(r.oldPrice)}</span>;
}

function QtyCell({ r }: { r: PreviewRow }) {
  if (r.oldQty === undefined || r.newQty === undefined) return r.rawQty && r.oldQty === undefined ? <span className="num">{r.rawQty}</span> : r.oldQty !== undefined ? <span className="num muted">{r.oldQty}</span> : <span className="xs muted">No value</span>;
  return r.newQty !== r.oldQty ? <Change from={r.oldQty} to={r.newQty} /> : <span className="num muted">{r.oldQty}</span>;
}

const KPI = ({ icon, k, v, d }: { icon: IconName; k: string; v: ReactNode; d?: string }) => (
  <div className="card pad">
    <div className="stat">
      <span className="k">
        <Icon name={icon} className="ic-sm" />
        {k}
      </span>
      <span className="v">{v}</span>
      {d && <span className="d">{d}</span>}
    </div>
  </div>
);

type Filter = 'all' | 'errors' | 'ready';

export default function BulkUpdate() {
  const [view, setView] = useView<View>();
  const [file, setFile] = useState<UploadFile>(SAMPLE);
  const [history, setHistory] = useState<HistoryRow[]>(() => (view === 'applied' ? [sampleHistory(SAMPLE), ...HISTORY] : HISTORY));
  const [appliedAt, setAppliedAt] = useState('Oct 8, 2026, 10:21 AM PT');
  const [filter, setFilter] = useState<Filter>('all');
  const [fileError, setFileError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const applied = view === 'applied';
  const s = file.stats;
  const errorRows = file.rows.filter((r) => r.error);
  const shown = file.rows.filter((r) => (filter === 'errors' ? !!r.error : filter === 'ready' ? isReady(r) : true));

  const pick = () => input.current?.click();
  const onFile = async (f?: File) => {
    if (!f) return;
    const parsed = parseCsv(f.name, await f.text());
    if (typeof parsed === 'string') {
      setFileError(parsed);
      announce(parsed);
      return;
    }
    setFileError('');
    setFile(parsed);
    setFilter('all');
    setView('');
    announce(`${parsed.stats.total} rows read from ${f.name}: ${parsed.stats.ready} ready, ${parsed.stats.errors} with errors`);
  };
  const apply = () => {
    if (!s.ready) return;
    setHistory((h) => [sampleHistory(file), ...h.filter((x) => x.file !== file.name || x.uploaded !== `Oct 8, ${file.uploaded}`)]);
    if (file !== SAMPLE) setAppliedAt(`Oct 8, 2026, 10:32 AM PT`);
    setView('applied');
    announce(`${s.ready} rows applied`);
  };
  const template = () => {
    download('northwind-price-stock-template.csv', [['seller_sku', 'price', 'quantity'], ...PRODUCT_ROWS.map((r) => [r.sku, r.price.toFixed(2), String(r.stock)])]);
    announce('Template downloaded');
  };
  const report = () => {
    download(`${file.name.replace(/\.csv$/i, '')}-corrections.csv`, [['row', 'seller_sku', 'what_to_fix'], ...errorRows.map((r) => [String(r.row), r.sku, r.error ?? ''])]);
    announce('Correction report downloaded');
  };

  return (
    <SellerLayout active="inventory">
      <PageHeader crumbs={[{ label: 'Inventory', to: href('seller/inventory') }, { label: 'Bulk update' }]} title="Bulk price and stock update" sub="Update prices and quantities for many SKUs with one CSV file." />
      <Steps items={['Download template', 'Upload file', applied ? 'Check preview' : <><span className="sr-only">Step 3 of 4: </span>Check preview</>, 'Apply']} current={applied ? 4 : 2} />
      <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => (onFile(e.target.files?.[0]), (e.target.value = ''))} />
      <div className="grid md2">
        <div className="card pad stack gap-2">
          <span className="row gap-2">
            <Icon name="file-down" />
            <span className="strong">1. Download the template</span>
          </span>
          <p className="small sub">Prefilled with your 24 SKUs, current prices and quantities. Columns: seller_sku, price, quantity.</p>
          <div className="row gap-2">
            <Button variant="secondary" size="sm" icon="download" onClick={template}>
              Download template
            </Button>
          </div>
        </div>
        <div className="card pad stack gap-2">
          <span className="row gap-2">
            <Icon name="file-up" />
            <span className="strong">2. Upload your file</span>
          </span>
          <div className="panel row gap-2 nowrap">
            <Icon name="file-spreadsheet" className="ic-sm" />
            <span className="small grow truncate">{file.name}</span>
            <span className="xs muted">{s.total} rows</span>
          </div>
          <div className="row gap-2">
            <Button variant="ghost" size="sm" onClick={pick}>
              Replace file
            </Button>
          </div>
        </div>
      </div>
      {fileError && (
        <Alert tone="danger" title="We couldn't read that file">
          {fileError}
        </Alert>
      )}
      {applied ? (
        <>
          <Alert tone="success" title={`${s.ready} rows applied`}>
            Applied {appliedAt} by Avery Stone. New prices and quantities are live on your offers now.{s.errors ? ` ${s.errors} row${s.errors === 1 ? ' was' : 's were'} skipped.` : ''}
          </Alert>
          <div className="sa-kpis">
            <KPI icon="circle-check" k="Updated" v={s.ready} />
            <KPI icon="circle-alert" k="Skipped" v={<span className="t-danger-text">{s.errors}</span>} d="See correction report" />
            <KPI icon="tag" k="Price changes" v={s.price} />
            <KPI icon="boxes" k="Stock changes" v={s.stock} d={'Recorded as "Bulk update"'} />
          </div>
          {errorRows.length > 0 && (
            <Card
              title="Correction report"
              sub={`${errorRows.length} row${errorRows.length === 1 ? ' was' : 's were'} not applied. Fix and upload just these rows.`}
              actions={
                <Button size="sm" icon="download" onClick={report}>
                  Download report (CSV)
                </Button>
              }
              flush
            >
              <TableWrap label="Correction report table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Row</th>
                      <th scope="col">Seller SKU</th>
                      <th scope="col">What to fix</th>
                    </tr>
                  </thead>
                  <tbody>
                    {errorRows.map((r) => (
                      <tr key={r.row} className="is-flagged">
                        <td>
                          <span className="sr-only">Urgent: </span>
                          <span className="num xs muted">{r.row}</span>
                        </td>
                        <td>
                          <span className="mono xs nowrap" title={r.sku}>
                            {r.sku}
                          </span>
                        </td>
                        <td>
                          <span className="small">{r.error}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <StatusLegend items={[{ tone: 'danger', label: 'Red edge = urgent: overdue or past target' }]} />
            </Card>
          )}
          <Card title="Upload history" titleAs="h3" flush>
            <TableWrap label="Upload history table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">File</th>
                    <th scope="col">Uploaded</th>
                    <th scope="col">By</th>
                    <th className="r" scope="col">
                      Applied
                    </th>
                    <th className="r" scope="col">
                      Skipped
                    </th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={`${h.file}${i}`}>
                      <td>{h.file}</td>
                      <td>{h.uploaded}</td>
                      <td>{h.by}</td>
                      <td className="r">{h.applied}</td>
                      <td className="r">{h.skipped}</td>
                      <td>
                        {i === 0 && h.file === file.name && errorRows.length ? (
                          <a
                            className="small"
                            href="#"
                            onClick={(e) => {
                              e.preventDefault();
                              report();
                            }}
                          >
                            Report
                          </a>
                        ) : (
                          <a className="small" href="#">
                            Report
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        </>
      ) : (
        <>
          <div className="sa-kpis">
            <KPI icon="file-spreadsheet" k="Rows in file" v={s.total} />
            <KPI icon="circle-check" k="Ready to apply" v={s.ready} d={`${s.price} price · ${s.stock} stock changes`} />
            <KPI icon="circle-alert" k="Errors" v={<span className={cx(s.errors > 0 && 't-danger-text')}>{s.errors}</span>} d="Skipped unless fixed" />
            <KPI icon="minus" k="Unchanged" v={s.unchanged} />
          </div>
          {s.errors > 0 && (
            <Alert tone="warning" title={`${s.errors} row${s.errors === 1 ? ' has' : 's have'} errors`}>
              Rows with errors are skipped. Nothing changes until you apply. Fix them in your file and upload again, or apply the {s.ready} valid rows now and download the correction report.
            </Alert>
          )}
          <Card
            title="Preview"
            sub={`${file.name} · uploaded ${file.uploaded} by ${file.by}`}
            actions={
              <SegmentedControl<Filter>
                items={[
                  { value: 'all', label: 'All rows' },
                  { value: 'errors', label: `Errors (${s.errors})` },
                  { value: 'ready', label: `Ready (${s.ready})` },
                ]}
                active={filter}
                onChange={setFilter}
              />
            }
            flush
            foot={
              <>
                <span className="xs muted grow">
                  Showing {shown.length} of {filter === 'all' ? s.total : filter === 'errors' ? s.errors : s.ready} rows
                </span>
                <Button variant="secondary" size="sm" icon="download" onClick={report} disabled={!errorRows.length}>
                  Download correction report
                </Button>
                <Button variant="secondary" size="sm" icon="upload" onClick={pick}>
                  Upload a corrected file
                </Button>
                <Button size="sm" onClick={apply} disabled={!s.ready}>
                  Apply {s.ready} valid row{s.ready === 1 ? '' : 's'}
                </Button>
              </>
            }
          >
            <TableWrap label="Preview table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Seller SKU</th>
                    <th scope="col">Product</th>
                    <th scope="col">Price</th>
                    <th scope="col">Quantity</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.row} className={r.error ? 'is-flagged' : ''}>
                      <td>
                        {r.error && <span className="sr-only">Urgent: </span>}
                        <span className="num xs muted">{r.row}</span>
                      </td>
                      <td>
                        <span className="mono xs nowrap" title={r.sku}>
                          {r.sku}
                        </span>
                      </td>
                      <td>{r.product ? <span className="small">{r.product}</span> : <span className="xs muted">Not found</span>}</td>
                      <td>
                        <PriceCell r={r} />
                      </td>
                      <td>
                        <QtyCell r={r} />
                      </td>
                      <td>
                        {r.error ? (
                          <span className="error-text wrap items-start u-maxw-36ch">
                            <Icon name="circle-alert" className="ic-sm" />
                            <span>{r.error}</span>
                          </span>
                        ) : isReady(r) ? (
                          <span className="badge t-success">Ready</span>
                        ) : (
                          <span className="badge">Unchanged</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            {shown.some((r) => r.error) && <StatusLegend items={[{ tone: 'danger', label: 'Red edge = urgent: overdue or past target' }]} />}
          </Card>
        </>
      )}
      <p className="xs muted row gap-1 nowrap top">
        <Icon name="info" className="ic-sm" />
        <span className="wrap">Price changes over 50% in one update and broad catalog edits need extra confirmation. Stock changes are recorded with the reason "Bulk update" and your name.</span>
      </p>
    </SellerLayout>
  );
}
