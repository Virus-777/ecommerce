import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type MouseEvent } from 'react';
import { useSearchParams } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { formatMoney, money, num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Card, Checkbox, Drawer, EmptyState, Field, Icon, KeyValue, PageHeader, Pager, SearchInput, Select, Stat, StatusBadge, SummaryRow, TableWrap, Tabs, TextInput } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { date, dateTime, LoadError, shortDate, SkeletonLines } from '@/app/parts';
import { ON_TIME_WARN, PO_STATUS_LABEL, poLimit, poStatusLabel, STATUS_FILTERS, type PoStatusKey, type PurchaseOrder, type PurchaseOrderRow, type ReorderSuggestion, type Supplier } from './data/purchasing';
import { ClosePoForm, DeliveryForm, DeliveryList, isOpenDelivery, type Delivery } from './data/purchasing-deliveries';
import { PriceListDialog, SupplierDialog } from './data/purchasing-suppliers';

// Design: pages/admin/admin-purchasing.html (purchase orders + suppliers) ·
// view "purchase-order" = the purchase order drawer (?view=purchase-order&po=<ref>). Draft POs open the same
// drawer with editable lines; "New purchase order" and reorder suggestions start a new draft (po=new).
// API: GET /api/admin/purchasing/summary, /suppliers (+/{id} price list), /purchase-orders (+/{id}), /reorder-suggestions;
// POST /purchase-orders, PATCH /purchase-orders/{id}, POST /{id}/send (approval above the buyer's limit), /{id}/cancel,
// POST /claims. After sending: POST /{id}/deliveries, PATCH /deliveries/{id}, POST /{id}/close (data/purchasing-deliveries).
// Suppliers: POST /suppliers, PATCH /suppliers/{id}, PUT /suppliers/{id}/items (data/purchasing-suppliers).

type View = 'purchase-order';
type TabKey = 'pos' | 'suppliers' | 'reorder';
const PAGE_SIZE = 20;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const usd = (dollars: number) => ({ amount: Math.round(dollars * 100), currency: 'USD' });

/* ---------- Draft editing ---------- */

interface LineForm {
  stockItemId: string;
  sku: string;
  name: string;
  qty: string;
  unit: string;
}
interface PoForm {
  supplierId: string;
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
  supplierId: po.supplier.id,
  expected: po.expectedDate?.slice(0, 10) ?? '',
  freight: (po.freight.amount / 100).toFixed(2),
  lines: po.lines.map((l) => ({ stockItemId: l.stockItemId, sku: l.sku, name: l.label, qty: String(l.quantityOrdered), unit: (l.unitCost.amount / 100).toFixed(2) })),
  addSku: '',
});
const n = (s: string) => (Number.isFinite(Number(s)) ? Number(s) : 0);
const formSubtotal = (f: PoForm) => f.lines.reduce((s, l) => s + n(l.qty) * n(l.unit), 0);

function validateForm(f: PoForm): FormErrors {
  const e: FormErrors = { line: {} };
  if (!f.supplierId) e.supplier = 'Choose a supplier.';
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

type PoEvent = { t: string; d: string; state: 'done' | 'warn' | 'current' };

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

function ReceivedLine({ l }: { l: PurchaseOrder['lines'][number] }) {
  const pct = l.quantityOrdered ? Math.round((l.quantityReceived / l.quantityOrdered) * 100) : 0;
  const complete = l.quantityReceived >= l.quantityOrdered;
  const tone = complete ? 't-success' : l.quantityReceived > 0 ? 't-warning' : '';
  return (
    <div className="panel stack gap-2">
      <div className="row between top">
        <span className="stack gap-0">
          <span className="small strong">{l.label}</span>
          <span className="xs muted mono">{l.sku}</span>
        </span>
        <span className="small num strong">{formatMoney(l.lineTotal)}</span>
      </div>
      <div className={cx('meter', tone)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={l.label}>
        {complete ? <i className="u-w-100pct" /> : <i style={{ width: `${pct}%` }} />}
      </div>
      {!complete && l.quantityReceived > 0 && <span className="xs strong meter-note t-warning-text">Near target</span>}
      <div className="row between xs">
        <span>
          <b className="num">{num(l.quantityReceived)}</b> of <b className="num">{num(l.quantityOrdered)}</b> received
          {l.quantityDamaged > 0 && (
            <>
              {' · '}
              <span className="t-danger-text strong">{l.quantityDamaged} damaged, held</span>
            </>
          )}
        </span>
        <span className="muted">
          {formatMoney(l.unitCost)} each · {complete ? 'Complete' : l.quantityClosed ? `${l.quantityClosed} closed short` : l.expectedDate ? `Due ${shortDate(l.expectedDate)}` : 'Not received'}
        </span>
      </div>
    </div>
  );
}

function SupplierTable({ suppliers, label, loading, onEdit, onPrices }: { suppliers: Supplier[]; label: string; loading: boolean; onEdit?: (s: Supplier) => void; onPrices?: (s: Supplier) => void }) {
  const cols = onEdit ? 6 : 5;
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
            {onEdit && (
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={cols}>
                <SkeletonLines rows={3} />
              </td>
            </tr>
          )}
          {suppliers.map((s) => (
            <tr key={s.id}>
              <td>
                <span className="stack gap-0">
                  <span className="small strong">{s.name}</span>
                  <span className="xs muted">{s.location || (s.active ? '' : 'Inactive')}</span>
                </span>
              </td>
              <td>
                <span className="stack gap-0">
                  <span className="small">{s.contactName || s.email || '—'}</span>
                  {s.contactName && s.email && <span className="xs muted">{s.email}</span>}
                  {s.phone && <span className="xs muted">{s.phone}</span>}
                </span>
              </td>
              <td className="r">{plural(s.actualLeadTimeDays ?? s.leadTimeDays, 'day')}</td>
              <td className="r">
                <span className={cx(s.onTimePct != null && s.onTimePct < ON_TIME_WARN && 't-warning-text strong')}>{s.onTimePct == null ? 'New' : `${Math.round(s.onTimePct)}%`}</span>
              </td>
              <td className="r">{s.openPurchaseOrders}</td>
              {onEdit && (
                <td>
                  <span className="row gap-1 nowrap">
                    <Button variant="ghost" size="sm" onClick={() => onPrices?.(s)}>
                      Price list
                      <span className="sr-only"> {s.name}</span>
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onEdit(s)}>
                      Edit
                      <span className="sr-only"> {s.name}</span>
                    </Button>
                  </span>
                </td>
              )}
            </tr>
          ))}
          {!loading && suppliers.length === 0 && (
            <tr>
              <td colSpan={cols}>
                <EmptyState icon="truck" title="No suppliers yet">
                  Add a supplier to start a purchase order.
                </EmptyState>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </TableWrap>
  );
}

/* ---------- Page ---------- */

/** What the PO drawer shows below the lines of a sent PO: a delivery form, or the close-short form. */
type Panel = { kind: 'add-delivery' } | { kind: 'edit-delivery'; delivery: Delivery } | { kind: 'close' } | null;

export default function Purchasing() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { accountId, can } = useStaffSession();
  const canManage = can('purchasing.orders.manage');
  const canSuppliers = can('purchasing.suppliers.manage');
  const [view] = useView<View>();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>('pos');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | PoStatusKey>('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<{ tone?: 'success' | 'danger'; title: string; body: string } | null>(null);

  const me = useQuery({ queryKey: ['access', 'me', accountId], queryFn: () => call(api.GET('/api/admin/access/me')) });
  const limit = poLimit(me.data?.limits as Parameters<typeof poLimit>[0]);
  const limitText = limit === null ? 'no limit' : limit === 0 ? 'no sending authority' : `POs up to ${formatMoney({ amount: limit, currency: 'USD' })}`;

  const summary = useQuery({ queryKey: ['purchasing', 'summary'], queryFn: () => call(api.GET('/api/admin/purchasing/summary')) });
  const suppliersQ = useQuery({ queryKey: ['purchasing', 'suppliers'], queryFn: () => call(api.GET('/api/admin/purchasing/suppliers', { params: { query: { limit: 100 } } })) });
  const suppliers = suppliersQ.data?.items ?? [];
  const reorderQ = useQuery({ queryKey: ['purchasing', 'reorder'], queryFn: () => call(api.GET('/api/admin/purchasing/reorder-suggestions', { params: { query: { limit: 50 } } })) });
  const reorder: ReorderSuggestion[] = reorderQ.data?.items ?? [];
  const locations = useQuery({ queryKey: ['inventory', 'locations'], queryFn: () => call(api.GET('/api/admin/inventory/locations')) });
  const shipTo = (locations.data ?? []).find((l) => l.isDefault && l.active) ?? (locations.data ?? [])[0];

  /* ----- Purchase order table ----- */
  const query = { q: q.trim() || undefined, status: status || undefined, supplierId: supplierFilter || undefined };
  const list = useQuery({
    queryKey: ['purchasing', 'purchase-orders', query, page],
    queryFn: () => call(api.GET('/api/admin/purchasing/purchase-orders', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows: PurchaseOrderRow[] = list.data?.items ?? [];
  const pageInfo = list.data as { total?: number; totalPages?: number } | undefined;

  /* ----- Drawer: ?view=purchase-order&po=<ref|new> ----- */
  const drawerOpen = view === 'purchase-order';
  // Without ?po= the drawer opens the newest purchase order, or a new one when there are none yet.
  const poRef = params.get('po') ?? (drawerOpen && list.isSuccess ? (rows[0]?.ref ?? 'new') : '');
  const isNew = poRef === 'new';
  const lookup = useQuery({
    queryKey: ['purchasing', 'po-ref', poRef],
    enabled: drawerOpen && !!poRef && !isNew && !rows.some((r) => r.ref === poRef),
    queryFn: () => call(api.GET('/api/admin/purchasing/purchase-orders', { params: { query: { q: poRef, limit: 5 } } })),
  });
  const poId = rows.find((r) => r.ref === poRef)?.id ?? lookup.data?.items.find((r) => r.ref === poRef)?.id;
  const detail = useQuery({
    queryKey: ['purchasing', 'purchase-order', poId],
    enabled: drawerOpen && !!poId,
    queryFn: () => call(api.GET('/api/admin/purchasing/purchase-orders/{id}', { params: { path: { id: poId! } } })),
  });
  const po = isNew ? undefined : detail.data;

  const [form, setForm] = useState<PoForm | null>(null);
  const [tried, setTried] = useState(false);
  const [drawerError, setDrawerError] = useState('');
  const [newSupplierLocked, setNewSupplierLocked] = useState(false);
  // Emailing the PO is opt-in: offline servers have no email, and many suppliers get the order another way.
  const [emailIt, setEmailIt] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  // Set after sending so the drawer opens the delivery form once the sent PO has loaded.
  const [askDeliveryFor, setAskDeliveryFor] = useState('');
  useEffect(() => {
    if (po) setForm(po.status === 'draft' && canManage ? toForm(po) : null);
  }, [po?.id, po?.status]);
  useEffect(() => {
    setPanel(po && askDeliveryFor === po.id && po.status === 'sent' && !po.deliveries.length ? { kind: 'add-delivery' } : null);
    if (po && askDeliveryFor === po.id && po.status !== 'draft') setAskDeliveryFor('');
  }, [po?.id, po?.status]);
  const editing = form !== null && (isNew || po?.status === 'draft');

  const supplierDetail = useQuery({
    queryKey: ['purchasing', 'supplier', form?.supplierId],
    enabled: drawerOpen && !!form?.supplierId,
    queryFn: () => call(api.GET('/api/admin/purchasing/suppliers/{id}', { params: { path: { id: form!.supplierId } } })),
  });
  const supplierEmail = form ? (supplierDetail.data?.supplier.email ?? suppliers.find((s) => s.id === form.supplierId)?.email) || '' : '';

  const setPo = (ref: string) => {
    const next = new URLSearchParams(params);
    next.set('view', 'purchase-order');
    next.set('po', ref);
    setParams(next);
  };
  const openPo = (p: PurchaseOrderRow) => {
    setTried(false);
    setDrawerError('');
    setEmailIt(false);
    setPo(p.ref);
  };
  const startDraft = (supplierId = '', lines: LineForm[] = []) => {
    setForm({ supplierId, expected: '', freight: '0.00', lines, addSku: '' });
    setNewSupplierLocked(false);
    setEmailIt(false);
    setTried(false);
    setDrawerError('');
    setPo('new');
  };
  const closeDrawer = () => {
    const next = new URLSearchParams(params);
    next.delete('view');
    next.delete('po');
    setParams(next);
    setPanel(null);
  };

  const errors: FormErrors = form && tried ? validateForm(form) : { line: {} };
  const setF = (patch: Partial<PoForm>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const setLine = (i: number, patch: Partial<LineForm>) => setForm((f) => (f ? { ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) } : f));
  const removeLine = (i: number) => setForm((f) => (f ? { ...f, lines: f.lines.filter((_, j) => j !== i) } : f));
  const catalogue = form ? (supplierDetail.data?.items ?? []).filter((it) => !form.lines.some((l) => l.stockItemId === it.stockItemId)) : [];
  const addLine = () => {
    if (!form) return;
    const it = catalogue.find((c) => c.sku === form.addSku) ?? catalogue[0];
    if (!it) return;
    setF({ lines: [...form.lines, { stockItemId: it.stockItemId, sku: it.sku, name: it.label, qty: String(it.minOrderQuantity ?? 1), unit: (it.unitCost.amount / 100).toFixed(2) }], addSku: '' });
  };
  const fSubtotal = form ? formSubtotal(form) : 0;
  const fTotal = fSubtotal + (form ? n(form.freight) : 0);
  const overLimit = limit !== null && (editing ? Math.round(fTotal * 100) > limit : (po?.total.amount ?? 0) > limit);

  const commit = useMutation({
    mutationFn: async (mode: 'save' | 'send') => {
      const f = form!;
      const lines = f.lines.map((l) => ({ stockItemId: l.stockItemId, quantity: Number(l.qty), unitCost: usd(Number(l.unit)) }));
      const common = { lines, freight: usd(Number(f.freight)), expectedDate: f.expected || null };
      let saved: PurchaseOrder;
      if (isNew || !po) {
        if (!shipTo) throw new Error('No company stock location to ship to.');
        saved = await call(api.POST('/api/admin/purchasing/purchase-orders', { body: { supplierId: f.supplierId, shipToLocationId: shipTo.id, ...common } }));
      } else {
        saved = await call(api.PATCH('/api/admin/purchasing/purchase-orders/{id}', { params: { path: { id: po.id } }, body: common }));
      }
      if (mode === 'save') return { mode, po: saved, emailed: false };
      // The backend refuses emailSupplier for a supplier without an email, so only ask for it when there is one.
      const emailed = emailIt && !!supplierEmail;
      const sent = await call(api.POST('/api/admin/purchasing/purchase-orders/{id}/send', { params: { path: { id: saved.id } }, body: { emailSupplier: emailed } }));
      return { mode, po: sent, emailed };
    },
    onSuccess: ({ mode, po: p, emailed }) => {
      const total = formatMoney(p.total);
      const pendingApproval = mode === 'send' && p.status === 'draft' && p.approval?.required;
      const handOver = emailed ? `It is also emailed to ${supplierEmail} if this server can send email.` : `Send or give the order to ${p.supplier.name} yourself.`;
      setNotice(
        mode === 'save'
          ? { title: `${p.ref} saved as a draft`, body: `${plural(p.lines.length, 'line')} · ${total}. Nothing is sent to ${p.supplier.name} until you send it.` }
          : pendingApproval
            ? { title: `${p.ref} sent to ${p.approval?.approvers.join(' or ') || 'the approver'} for approval`, body: `${total} is over your limit. It is marked sent to ${p.supplier.name} once it is approved. Then add its expected delivery.` }
            : { title: `${p.ref} marked as sent to ${p.supplier.name}`, body: `${total} committed and counted as incoming stock. ${handOver} Add the expected delivery so the warehouse sees it in Receiving.` },
      );
      void qc.invalidateQueries({ queryKey: ['purchasing'] });
      void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
      setForm(null);
      if (mode === 'send' && !pendingApproval) {
        // Stay on the sent PO and open "Add expected delivery": without a delivery it never reaches Receiving.
        setAskDeliveryFor(p.id);
        setPo(p.ref);
      } else closeDrawer();
    },
    onError: (e) => setDrawerError(errorMessage(e)),
  });
  const doCommit = (mode: 'save' | 'send') => {
    if (!form) return;
    setTried(true);
    setDrawerError('');
    if (hasErrors(validateForm(form))) return;
    commit.mutate(mode);
  };

  const cancelDraft = useMutation({
    mutationFn: () => call(api.POST('/api/admin/purchasing/purchase-orders/{id}/cancel', { params: { path: { id: po!.id } }, body: { reason: 'Draft deleted before sending' } })),
    onSuccess: () => {
      setNotice({ title: `${po!.ref} deleted`, body: 'The draft was not sent, so nothing changes for the supplier.' });
      void qc.invalidateQueries({ queryKey: ['purchasing'] });
      setForm(null);
      closeDrawer();
    },
    onError: (e) => setDrawerError(errorMessage(e)),
  });
  const deleteDraft = () => {
    if (isNew || !po) {
      setForm(null);
      closeDrawer();
      return;
    }
    cancelDraft.mutate();
  };

  const damagedLines = (po?.lines ?? []).filter((l) => l.quantityDamaged > 0);
  const damaged = damagedLines.reduce((s, l) => s + l.quantityDamaged, 0);
  const claimValue = damagedLines.reduce((s, l) => s + l.quantityDamaged * l.unitCost.amount, 0);
  const claimed = (po?.claims ?? []).some((c) => c.kind === 'damage');
  const claim = useMutation({
    mutationFn: () => call(api.POST('/api/admin/purchasing/claims', { body: { purchaseOrderId: po!.id, kind: 'damage', lines: damagedLines.map((l) => ({ stockItemId: l.stockItemId, sku: l.sku, quantity: l.quantityDamaged, unitCost: l.unitCost })) } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['purchasing', 'purchase-order', poId] }),
    onError: (e) => setDrawerError(errorMessage(e)),
  });

  /* ----- Suppliers: add, edit, price list (dialogs in data/purchasing-suppliers) ----- */
  // supDialog.key remounts the form so it starts from the chosen supplier.
  const [supDialog, setSupDialog] = useState<{ key: number; supplier?: Supplier } | null>(null);
  const [priceList, setPriceList] = useState<Supplier | null>(null);
  const supplierActions = canSuppliers ? { onEdit: (s: Supplier) => setSupDialog({ key: Date.now(), supplier: s }), onPrices: (s: Supplier) => setPriceList(s) } : {};

  /* ----- Sent PO: deliveries and closing short ----- */
  const openDeliveries = (po?.deliveries ?? []).filter(isOpenDelivery);
  const canAddDelivery = canManage && !!po && (po.status === 'sent' || po.status === 'partly_received') && po.lines.some((l) => l.quantityOpen > 0);
  // Shown inside the drawer (the page notice is hidden behind it); cleared when another PO opens.
  const [drawerNotice, setDrawerNotice] = useState('');
  useEffect(() => setDrawerNotice(''), [po?.id]);
  const panelDone = (message: string) => {
    setPanel(null);
    setDrawerNotice(message);
  };

  const supplierInfo = po ? suppliers.find((s) => s.id === po.supplier.id) : undefined;
  const isDraftLike = po?.status === 'draft';
  const events: PoEvent[] = (po?.timeline ?? [])
    .slice()
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((e, i) => ({ t: e.label, d: [dateTime(e.at), e.actor?.name, e.detail].filter(Boolean).join(' · '), state: i === 0 && po?.approval?.required && po.status === 'draft' ? 'current' : /short|late|damag|backorder/i.test(e.label) ? 'warn' : 'done' }));
  if (isNew) events.push({ t: 'New draft', d: 'Not saved yet', state: 'current' });
  const sm = summary.data;
  const statusLabel = po ? poStatusLabel(po.status, po.approval) : 'Draft';
  const approvalText = (total: number) => (limit === null || total <= limit ? `Within your limit (${limitText})` : `Over your limit: needs ${po?.approval?.approvers.join(' or ') || 'the Business Owner'}`);

  return (
    <AdminLayout active="purchasing">
      <PageHeader
        crumbs={[{ label: 'Official store' }, { label: 'Suppliers and purchasing' }]}
        title="Suppliers and purchasing"
        sub={`Your sending authority: ${limitText}`}
        actions={
          (canManage || canSuppliers) && (
            <>
              {canSuppliers && (
                <Button variant="secondary" size="sm" icon="plus" onClick={() => setSupDialog({ key: Date.now() })}>
                  Add supplier
                </Button>
              )}
              {canManage && (
                <Button size="sm" icon="file-plus" onClick={() => startDraft()}>
                  New purchase order
                </Button>
              )}
            </>
          )
        }
      />

      {notice && (
        <Alert tone={notice.tone ?? 'success'} title={notice.title}>
          {notice.body}
        </Alert>
      )}
      {summary.isError && <LoadError error={summary.error} onRetry={() => void summary.refetch()} />}

      <div className="aa-kpis">
        <Card pad>{sm ? <Stat label="Open purchase orders" value={sm.openPurchaseOrders} note={`${formatMoney(sm.committed)} committed`} /> : <SkeletonLines rows={1} />}</Card>
        <Card pad>{sm ? <Stat label="Incoming units" value={num(sm.incomingUnits)} note={sm.nextArrival ? `Next arrival ${shortDate(sm.nextArrival)}` : 'No arrival scheduled'} /> : <SkeletonLines rows={1} />}</Card>
        <Card pad>{sm ? <Stat label="Late or short" value={<span className={cx(sm.lateOrShort > 0 && 't-warning-text')}>{sm.lateOrShort}</span>} note={sm.lateOrShortNote ?? 'Nothing late'} /> : <SkeletonLines rows={1} />}</Card>
        <Card pad>{sm ? <Stat label="Low-stock items" value={num(sm.lowStockItems)} note={`Reorder suggested for ${sm.reorderSuggested}`} /> : <SkeletonLines rows={1} />}</Card>
      </div>

      <section className="card">
        <Tabs<TabKey>
          items={[
            { value: 'pos', label: 'Purchase orders', count: pageInfo?.total ?? undefined },
            { value: 'suppliers', label: 'Suppliers', count: suppliersQ.data ? suppliers.length : undefined },
            { value: 'reorder', label: 'Reorder suggestions', count: reorderQ.data ? reorder.length : undefined },
          ]}
          active={tab}
          onChange={setTab}
        />
        {tab === 'pos' && (
          <>
            <div className="card-body">
              <div className="toolbar">
                <SearchInput
                  id="aa-po-q"
                  placeholder="Search PUR ref, supplier or SKU"
                  value={q}
                  onChange={(v) => {
                    setQ(v);
                    setPage(1);
                  }}
                />
                <Select
                  id="aa-po-st"
                  aria-label="Status"
                  options={STATUS_FILTERS}
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value as '' | PoStatusKey);
                    setPage(1);
                  }}
                />
                <Select
                  id="aa-po-sup"
                  aria-label="Supplier"
                  options={[{ value: '', label: 'All suppliers' }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))]}
                  value={supplierFilter}
                  onChange={(e) => {
                    setSupplierFilter(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
            </div>
            {list.isError && (
              <div className="card-body">
                <LoadError error={list.error} onRetry={() => void list.refetch()} />
              </div>
            )}
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
                  {list.isPending && (
                    <tr>
                      <td colSpan={7}>
                        <SkeletonLines rows={4} />
                      </td>
                    </tr>
                  )}
                  {rows.map((p) => {
                    const warn = !!p.approvalNote || p.lateOrShort || p.status === 'partly_received';
                    const onOpen = (e: MouseEvent) => {
                      e.preventDefault();
                      openPo(p);
                    };
                    const link = href('admin/purchasing', 'purchase-order', undefined, { po: p.ref });
                    return (
                      <tr key={p.id} className={cx(warn && 'is-warn')}>
                        <td>
                          {warn && <span className="sr-only">At risk: </span>}
                          <a className="mono strong nowrap" href={link} title={p.ref} onClick={onOpen}>
                            {p.ref}
                          </a>
                        </td>
                        <td>
                          <span className="small strong">{p.supplierName}</span>
                        </td>
                        <td>
                          <span className="small">
                            {plural(p.lineCount, 'line')} · {num(p.units)} units
                          </span>
                        </td>
                        <td className="r">
                          <span className="stack gap-0">
                            <span className="strong">{formatMoney(p.total)}</span>
                            {p.approvalNote && <span className="xs t-warning-text strong">{p.approvalNote}</span>}
                          </span>
                        </td>
                        <td>
                          <span className="small nowrap">{p.expectedLabel}</span>
                        </td>
                        <td>
                          <StatusBadge status={PO_STATUS_LABEL[p.status]} />
                        </td>
                        <td>
                          <a className="btn btn-ghost btn-sm" href={link} onClick={onOpen}>
                            <span>{p.status === 'partly_received' ? 'Open' : 'View'}</span>
                            <span className="sr-only"> {p.ref}</span>
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                  {list.isSuccess && !rows.length && (
                    <tr>
                      <td colSpan={7}>
                        <EmptyState icon="search-x" title={query.q || query.status || query.supplierId ? 'No purchase orders match' : 'No purchase orders yet'}>
                          {query.q || query.status || query.supplierId ? 'Try another PUR ref, supplier or SKU, or clear the filters.' : 'Start one with New purchase order or from a reorder suggestion.'}
                        </EmptyState>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </TableWrap>
            {rows.some((p) => p.approvalNote || p.lateOrShort || p.status === 'partly_received') && (
              <p className="status-legend status-legend--edge">
                <span className="sr-only">Legend: </span>
                <span className="sl sl-warning">
                  <i aria-hidden="true" />
                  Amber edge = at risk: late, short, partly received or waiting for approval
                </span>
              </p>
            )}
            {(pageInfo?.totalPages ?? 1) > 1 && (
              <div className="card-foot between">
                <span />
                <Pager page={page} total={pageInfo?.totalPages ?? 1} onPage={setPage} />
              </div>
            )}
          </>
        )}
        {tab === 'suppliers' && <SupplierTable suppliers={suppliers} label="Supplier list table" loading={suppliersQ.isPending} {...supplierActions} />}
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
                {reorderQ.isPending && (
                  <tr>
                    <td colSpan={6}>
                      <SkeletonLines rows={3} />
                    </td>
                  </tr>
                )}
                {reorder.map((r) => (
                  <tr key={r.stockItemId}>
                    <td>
                      <span className="stack gap-0">
                        <span className="small strong">{r.label}</span>
                        <span className="xs muted mono">{r.sku}</span>
                      </span>
                    </td>
                    <td>
                      <span className="small">{r.supplier?.name ?? 'No preferred supplier'}</span>
                    </td>
                    <td className="r">
                      <span className="strong num t-warning-text">{r.available}</span>
                    </td>
                    <td className="r">{r.avgDailySales != null ? r.avgDailySales.toFixed(1) : '—'}</td>
                    <td className="r">
                      <span className="stack gap-0">
                        <span className="strong num">{num(r.suggestedQuantity)}</span>
                        {r.estimatedCost && <span className="xs muted">{formatMoney(r.estimatedCost)}</span>}
                      </span>
                    </td>
                    <td>
                      {canManage && r.supplier && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startDraft(r.supplier!.id, [{ stockItemId: r.stockItemId, sku: r.sku, name: r.label, qty: String(r.suggestedQuantity), unit: r.unitCost ? (r.unitCost.amount / 100).toFixed(2) : '' }])}
                        >
                          Create draft PO
                          <span className="sr-only"> {r.sku}</span>
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
                {reorderQ.isSuccess && reorder.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      <EmptyState icon="circle-check" title="Nothing to reorder">
                        Stock is above the reorder point after incoming purchase orders.
                      </EmptyState>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>

      <Card title="Suppliers" sub="Lead time and on-time arrival over the last 90 days" flush>
        <SupplierTable suppliers={suppliers} label="Suppliers table" loading={suppliersQ.isPending} {...supplierActions} />
      </Card>

      <Drawer
        open={drawerOpen && (isNew ? !!form : true)}
        onClose={closeDrawer}
        title={isNew ? 'New purchase order' : po?.ref ?? poRef}
        foot={
          editing ? (
            <>
              <Button variant="ghost" icon="trash-2" onClick={deleteDraft} disabled={cancelDraft.isPending}>
                Delete draft
              </Button>
              <Button variant="secondary" onClick={() => doCommit('save')} disabled={commit.isPending}>
                Save draft
              </Button>
              <Button icon="send" onClick={() => doCommit('send')} disabled={commit.isPending || limit === 0}>
                {overLimit ? 'Send for approval' : 'Send to supplier'}
              </Button>
            </>
          ) : po && (po.status === 'partly_received' || po.status === 'sent') ? (
            <>
              {damaged > 0 && can('purchasing.claims.manage') && (
                <Button variant="ghost" onClick={() => claim.mutate()} disabled={claimed || claim.isPending}>
                  {claimed ? 'Supplier claim opened' : 'Open supplier claim'}
                </Button>
              )}
              {canManage && po.status === 'partly_received' && (
                <Button variant="ghost" onClick={() => setPanel({ kind: 'close' })} disabled={panel?.kind === 'close'}>
                  Close short
                </Button>
              )}
              {/* Receiving lists deliveries, so "Record receipt" only helps once the PO has an open one. */}
              {openDeliveries.length > 0 ? (
                <Button icon="package-check" to={href('ops/receiving')}>
                  Record receipt
                </Button>
              ) : (
                canAddDelivery && (
                  <Button icon="truck" onClick={() => setPanel({ kind: 'add-delivery' })} disabled={panel?.kind === 'add-delivery'}>
                    Add expected delivery
                  </Button>
                )
              )}
            </>
          ) : (
            <Button variant="ghost" onClick={closeDrawer}>
              Close
            </Button>
          )
        }
      >
        {drawerError && <Alert tone="danger" title={drawerError} />}
        {drawerNotice && <Alert tone="success" title={drawerNotice} />}
        {!isNew && (detail.isPending || lookup.isPending) && !po && <SkeletonLines rows={5} />}
        {!isNew && detail.isError && <LoadError error={detail.error} onRetry={() => void detail.refetch()} />}
        {!isNew && lookup.isSuccess && !poId && (
          <EmptyState icon="search-x" title="Purchase order not found">
            {poRef} doesn't exist or was removed.
          </EmptyState>
        )}
        {(isNew || po) && (
          <>
            <div className="row between">
              <StatusBadge status={statusLabel} />
              {po && (
                <span className="xs muted">
                  Created {date(po.createdAt)}
                  {po.createdBy.name ? ` by ${po.createdBy.name}` : ''}
                </span>
              )}
            </div>

            {editing && form ? (
              <>
                {isNew && !newSupplierLocked && (
                  <Field label="Supplier" error={errors.supplier}>
                    <Select
                      id="po-supplier"
                      className={cx(errors.supplier && 'is-error')}
                      options={[{ value: '', label: 'Choose a supplier' }, ...suppliers.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))]}
                      value={form.supplierId}
                      onChange={(e) => setF({ supplierId: e.target.value, lines: form.supplierId === e.target.value ? form.lines : [], addSku: '' })}
                    />
                  </Field>
                )}
                <KeyValue
                  pairs={[
                    ...(isNew ? [] : [['Supplier', supplierInfo?.location ? `${po!.supplier.name}, ${supplierInfo.location}` : po!.supplier.name] as [string, string]]),
                    ['Ship to', po?.shipToName ?? shipTo?.name ?? '—'],
                    ['Approval', approvalText(Math.round(fTotal * 100))],
                    ['Payment terms', po?.paymentTerms ?? supplierDetail.data?.supplier.paymentTerms ?? '—'],
                  ]}
                />
                <div className="stack gap-2">
                  <span className="label">Lines · quantity and unit cost</span>
                  {form.lines.map((l, i) => (
                    <div className="panel stack gap-2" key={l.stockItemId}>
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
                  {form.supplierId && catalogue.length > 0 && (
                    <div className="row gap-2">
                      <Select
                        id="po-add-sku"
                        aria-label="Product to add"
                        ctl="sm"
                        options={catalogue.map((c) => ({ value: c.sku, label: `${c.label} · ${formatMoney(c.unitCost)}` }))}
                        value={form.addSku || catalogue[0].sku}
                        onChange={(e) => setF({ addSku: e.target.value })}
                      />
                      <Button variant="secondary" size="sm" icon="plus" onClick={addLine}>
                        Add line
                      </Button>
                    </div>
                  )}
                  {form.supplierId && supplierDetail.isSuccess && supplierDetail.data.items.length === 0 && (
                    <span className="xs muted">This supplier has no price list yet, so there is nothing to add. Add its items with Price list on the Suppliers tab.</span>
                  )}
                </div>
                <div className="grid md2 gap-3">
                  <Field label="Freight" error={errors.freight}>
                    <TextInput id="po-freight" prefix="$" inputMode="decimal" value={form.freight} error={!!errors.freight} onChange={(e) => setF({ freight: e.target.value })} />
                  </Field>
                  <Field label="Expected arrival" optional>
                    <TextInput id="po-expected" type="date" value={form.expected} onChange={(e) => setF({ expected: e.target.value })} />
                  </Field>
                </div>
                <div className="well stack gap-2">
                  <SummaryRow k="Lines subtotal" v={money(fSubtotal)} />
                  <SummaryRow k="Freight" v={money(n(form.freight))} />
                  <SummaryRow k="PO total" v={money(fTotal)} className="total" />
                </div>
                {overLimit && limit !== null && (
                  <Alert tone="warning" title={`Over the ${formatMoney({ amount: limit, currency: 'USD' })} limit`}>
                    You can send purchase orders up to {formatMoney({ amount: limit, currency: 'USD' })}. This one is {money(fTotal)}, so it goes to an approver before the supplier sees it.
                  </Alert>
                )}
                {form.supplierId &&
                  (supplierEmail ? (
                    <div className="stack gap-1">
                      <Checkbox id="po-email" label={`Also email the PO to the supplier (${supplierEmail})`} checked={emailIt} onChange={(e) => setEmailIt(e.target.checked)} />
                      <span className="xs muted">Needs email set up on the server. Otherwise the PO is only marked as sent and you send it to the supplier yourself.</span>
                    </div>
                  ) : (
                    <span className="xs muted">Sending marks the PO as sent; send or give the order to the supplier yourself.</span>
                  ))}
                {limit === 0 && (
                  <Alert tone="info" title="You can prepare but not send">
                    Your roles have no authority to send purchase orders. Save the draft for someone who can.
                  </Alert>
                )}
              </>
            ) : (
              po && (
                <>
                  <KeyValue
                    pairs={[
                      ['Supplier', supplierInfo?.location ? `${po.supplier.name}, ${supplierInfo.location}` : po.supplier.name],
                      ['Ship to', po.shipToName],
                      ['Expected', po.expectedDate ? date(po.expectedDate) : 'Not set'],
                      ['Approval', po.approval?.required ? (po.status === 'draft' ? `Waiting for ${po.approval.approvers.join(' or ') || 'approval'}` : `Approved${po.approval.approvers.length ? ` by ${po.approval.approvers.join(', ')}` : ''}`) : 'Within the sender’s limit'],
                      ['Payment terms', po.paymentTerms],
                    ]}
                  />
                  <div className="stack gap-2">
                    <span className="label">{isDraftLike ? 'Lines · ordered' : 'Lines · expected vs received'}</span>
                    {po.lines.map((l) =>
                      isDraftLike ? (
                        <div className="panel stack gap-2" key={l.id}>
                          <div className="row between top">
                            <span className="stack gap-0">
                              <span className="small strong">{l.label}</span>
                              <span className="xs muted mono">{l.sku}</span>
                            </span>
                            <span className="small num strong">{formatMoney(l.lineTotal)}</span>
                          </div>
                          <div className="row between xs">
                            <span>
                              <b className="num">{num(l.quantityOrdered)}</b> units
                            </span>
                            <span className="muted">{formatMoney(l.unitCost)} each</span>
                          </div>
                        </div>
                      ) : (
                        <ReceivedLine key={l.id} l={l} />
                      ),
                    )}
                  </div>
                  <div className="well stack gap-2">
                    <SummaryRow k="Lines subtotal" v={formatMoney(po.linesSubtotal)} />
                    <SummaryRow k="Freight" v={formatMoney(po.freight)} />
                    <SummaryRow k="PO total" v={formatMoney(po.total)} className="total" />
                    {po.receivedValue.amount > 0 && <SummaryRow k="Received value" v={formatMoney(po.receivedValue)} />}
                    {damaged > 0 && <SummaryRow k={`Supplier claim · ${damaged} damaged`} v={formatMoney({ amount: claimValue, currency: po.total.currency })} />}
                  </div>
                  {claimed && (
                    <Alert tone="success" title="Supplier claim opened">
                      Claim for {damaged} damaged units sent to {supplierInfo?.contactName ?? 'the supplier'} at {po.supplier.name}. The units stay held until it is settled.
                    </Alert>
                  )}
                  {po.receipts.length > 0 && (
                    <Alert tone="info" title="Received at the warehouse">
                      {plural(po.receipts.length, 'receiving record')} on this purchase order. Inventory makes received units sellable after counting.
                    </Alert>
                  )}
                  <DeliveryList po={po} canManage={canManage} onEdit={(d) => setPanel({ kind: 'edit-delivery', delivery: d })} />
                  {canAddDelivery && !openDeliveries.length && !panel && (
                    <Alert tone="warning" title="No expected delivery yet">
                      The warehouse only sees this order in Receiving once it has an expected delivery. Use Add expected delivery.
                    </Alert>
                  )}
                  {canAddDelivery && openDeliveries.length > 0 && !panel && (
                    <div className="row">
                      <Button variant="ghost" size="sm" icon="plus" onClick={() => setPanel({ kind: 'add-delivery' })}>
                        Add another delivery
                      </Button>
                    </div>
                  )}
                  {panel?.kind === 'add-delivery' && canAddDelivery && (
                    <DeliveryForm key={`add-${po.id}`} po={po} leadTimeDays={supplierInfo?.leadTimeDays ?? 0} onDone={panelDone} onCancel={() => setPanel(null)} />
                  )}
                  {panel?.kind === 'edit-delivery' && (
                    <DeliveryForm key={`edit-${panel.delivery.id}`} po={po} leadTimeDays={supplierInfo?.leadTimeDays ?? 0} delivery={panel.delivery} onDone={panelDone} onCancel={() => setPanel(null)} />
                  )}
                  {panel?.kind === 'close' && po.status === 'partly_received' && <ClosePoForm po={po} canClaim={can('purchasing.claims.manage')} onDone={panelDone} onCancel={() => setPanel(null)} />}
                </>
              )
            )}
            <EventList events={events} />
          </>
        )}
      </Drawer>

      {supDialog && (
        <SupplierDialog
          key={supDialog.key}
          open
          supplier={supDialog.supplier}
          suppliers={suppliers}
          onClose={() => setSupDialog(null)}
          onSaved={(s, created) => {
            setSupDialog(null);
            if (created) {
              // A new supplier has nothing to order until its price list exists, so go straight to it.
              setNotice({ title: `${s.name} added`, body: 'Add the items it sells and their buying costs so you can order them.' });
              setPriceList(s);
            } else setNotice({ title: `${s.name} saved`, body: s.active ? 'The supplier details are updated.' : 'The supplier is inactive and can’t be chosen on new purchase orders.' });
          }}
        />
      )}
      {priceList && (
        <PriceListDialog
          key={priceList.id}
          supplier={priceList}
          onClose={() => setPriceList(null)}
          onSaved={(count) => {
            setNotice({ title: `${priceList.name} price list saved`, body: `${plural(count, 'item')} can now be ordered from ${priceList.name}.` });
            setPriceList(null);
          }}
        />
      )}
    </AdminLayout>
  );
}
