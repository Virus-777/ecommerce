import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { call, errorMessage, useApi, ApiError } from '@marketly/web-shared/api';
import { OpsLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, num, type MoneyValue } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Dialog, Field, Icon, Img, PageHeader, Pager, SearchInput, Select, StatusBadge, SummaryRow, TableWrap, Textarea, TextInput, announce } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines, dateTime } from '@/app/parts';
import { useStaffSession } from '@/app/session';
import { BeforeAfter, EDGE_RISK, EDGE_URGENT, EmptyRow, OpsLegend, SkeletonRows } from './data/shared';

// Design: pages/ops/ops-inventory.html · view "adjust-stock" = the Adjust stock dialog.
// API: GET inventory/summary (group tiles), GET inventory/stock-items (official, filters, pages), GET inventory/low-stock,
// GET inventory/adjustments (history with second review), POST inventory/adjustments (applied, or pending_review when the
// quantity is above the staff member's limit from access/me), GET access/me (the adjustment limit).

type Group = 'available' | 'reserved' | 'incoming' | 'damaged_held' | 'returned';
type From = 'available' | 'incoming' | 'damaged_held' | 'returned' | 'outside';
type To = 'available' | 'damaged_held' | 'returned' | 'outside';

interface Quantities {
  available: number;
  reserved: number;
  incoming: number;
  damagedHeld: number;
  returned: number;
}
interface StockItem {
  id: string;
  sku: string;
  label: string;
  image: { url: string; alt?: string | null } | null;
  quantities: Quantities;
  state: string;
  lowStockThreshold: number | null;
  binCode: string | null;
}
interface Page<T> {
  items: T[];
  total?: number;
  totalPages?: number;
}
interface Summary {
  skuCount: number;
  groups: Array<{ group: Group; label: string; meaning: string; units: number; valueAtCost: MoneyValue | null }>;
  lowStockCount: number;
  outOfStockCount: number;
  lowStockHeadline: string;
}
interface LowStock {
  item: StockItem;
  incoming: { quantity?: number; reference?: string | null } | null;
}
interface Adjustment {
  id: string;
  sku: string;
  fromGroup: string;
  toGroup: string;
  quantity: number;
  reasonLabel: string;
  note: string | null;
  state: 'requested' | 'pending_review' | 'applied' | 'rejected' | 'cancelled';
  approval: { approvers?: string[] | null; approverLabel?: string | null } | null;
  requestedBy: { name?: string | null } | null;
  decidedBy: { name?: string | null } | null;
  createdAt: string;
}
interface AccessMe {
  limits?: Array<{ action: { key: string }; value: { authority?: string; limitNumber?: number | null } | null }>;
}

const GROUP_TONE: Record<Group, string> = { available: 'var(--success)', reserved: 'var(--info)', incoming: 'var(--border-strong)', damaged_held: 'var(--danger)', returned: 'var(--warning)' };
const GROUP_LABEL: Record<string, string> = { available: 'Available', reserved: 'Reserved', incoming: 'Incoming', damaged_held: 'Damaged or held', returned: 'Returned', outside: 'Outside stock' };
const Q_KEY: Record<Group, keyof Quantities> = { available: 'available', reserved: 'reserved', incoming: 'incoming', damaged_held: 'damagedHeld', returned: 'returned' };

const FROM_GROUPS: Array<{ value: From; label: string }> = [
  { value: 'available', label: 'Available' },
  { value: 'incoming', label: 'Incoming' },
  { value: 'damaged_held', label: 'Damaged or held' },
  { value: 'returned', label: 'Returned' },
  { value: 'outside', label: 'Found stock (into stock)' },
];
const TO_GROUPS: Array<{ value: To; label: string }> = [
  { value: 'available', label: 'Available' },
  { value: 'damaged_held', label: 'Damaged or held' },
  { value: 'returned', label: 'Returned' },
  { value: 'outside', label: 'Remove from stock (write off)' },
];
const REASONS = [
  { value: '', label: 'Choose a reason' },
  { value: 'quality_hold', label: 'Quality hold: supplier notice' },
  { value: 'damaged_in_warehouse', label: 'Damaged in warehouse' },
  { value: 'count_correction', label: 'Count correction' },
  { value: 'found_stock', label: 'Found stock' },
  { value: 'theft_or_loss', label: 'Theft or loss' },
  { value: 'write_off', label: 'Write off' },
  { value: 'repair', label: 'Repair' },
  { value: 'supplier_return', label: 'Return to supplier' },
  { value: 'other', label: 'Other' },
];
const STOCK_FILTERS = [
  { value: '', label: 'All stock groups' },
  { value: 'low_or_out', label: 'Low or out of stock' },
  { value: 'has_damaged_or_held', label: 'Has damaged or held' },
  { value: 'has_returned', label: 'Has returned' },
  { value: 'has_incoming', label: 'Has incoming' },
];
const LIMIT = 24;

interface Draft {
  id: string;
  from: From;
  to: To;
  qty: string;
  reason: string;
  note: string;
  reviewDate: string;
}
const blankDraft = (id: string): Draft => ({ id, from: 'available', to: 'damaged_held', qty: '', reason: '', note: '', reviewDate: '' });

const statusOf = (r: StockItem) => (r.state === 'out_of_stock' || r.quantities.available === 0 ? 'Out of stock' : r.state === 'low_stock' ? 'Low stock' : 'In stock');

function Num({ n, tone }: { n: number; tone?: 'danger' | 'warning' }) {
  if (!n) return <span className="muted">0</span>;
  return tone ? <span className={`t-${tone}-text strong`}>{n}</span> : <>{n}</>;
}

function Available({ r }: { r: StockItem }) {
  const s = statusOf(r);
  if (s === 'Out of stock')
    return (
      <span className="ac-out">
        0<span className="sr-only"> out of stock</span>
      </span>
    );
  if (s === 'Low stock') return <span className="ac-low">{r.quantities.available}</span>;
  return <span className="strong">{r.quantities.available}</span>;
}

const have = (row: StockItem | undefined, g: From) => (!row || g === 'outside' ? Infinity : row.quantities[Q_KEY[g]]);

function validate(d: Draft, row: StockItem | undefined) {
  const e: Partial<Record<'qty' | 'reason' | 'to' | 'reviewDate' | 'id', string>> = {};
  const q = Number(d.qty);
  if (!row) e.id = 'Choose a SKU.';
  if (!d.qty.trim() || !Number.isInteger(q) || q <= 0) e.qty = 'Enter a whole number of units, 1 or more.';
  else if (q > have(row, d.from)) e.qty = `Only ${have(row, d.from)} units are in ${GROUP_LABEL[d.from]}.`;
  if ((d.to as string) === (d.from as string)) e.to = 'Choose a different group to move units to.';
  if (!d.reason) e.reason = 'Choose a reason. Every change is recorded with its reason.';
  if (d.to === 'damaged_held' && !d.reviewDate) e.reviewDate = 'Choose when the hold is reviewed.';
  return e;
}

const reviewLabel = (a: Adjustment) =>
  a.state === 'pending_review'
    ? `Waiting for ${a.approval?.approverLabel ?? a.approval?.approvers?.join(' or ') ?? 'second review'}`
    : a.state === 'rejected'
      ? `Rejected${a.decidedBy?.name ? ` by ${a.decidedBy.name}` : ''}`
      : a.state === 'cancelled'
        ? 'Withdrawn'
        : a.decidedBy?.name
          ? `${a.decidedBy.name} approved`
          : 'Not required';

export default function Inventory() {
  const { api } = useApi();
  const qc = useQueryClient();
  const staff = useStaffSession();
  const [view, setView] = useView<'adjust-stock'>();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [grp, setGrp] = useState('');
  const [zone, setZone] = useState('');
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<Draft>(blankDraft(''));
  const [attempted, setAttempted] = useState(false);
  const [done, setDone] = useState<{ title: string; body: string; tone: 'success' | 'info' } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const canAdjust = staff.can('inventory.stock.adjust-official');
  const summary = useQuery({ queryKey: ['inventory', 'summary'], queryFn: () => call(api.GET('/api/admin/inventory/summary', { params: { query: { ownerType: 'official' } as never } })) as Promise<Summary> });
  const params = { ownerType: 'official' as const, q: search || undefined, filter: (grp || undefined) as never, zone: zone || undefined, page, limit: LIMIT };
  const items = useQuery({ queryKey: ['inventory', 'stock-items', params], queryFn: () => call(api.GET('/api/admin/inventory/stock-items', { params: { query: params } })) as Promise<Page<StockItem>>, placeholderData: keepPreviousData });
  const low = useQuery({ queryKey: ['inventory', 'low-stock'], queryFn: () => call(api.GET('/api/admin/inventory/low-stock', { params: { query: { limit: 5 } as never } })) as Promise<Page<LowStock>> });
  const history = useQuery({ queryKey: ['inventory', 'adjustments'], queryFn: () => call(api.GET('/api/admin/inventory/adjustments', { params: { query: { limit: 8 } as never } })) as Promise<Page<Adjustment>> });
  // All official SKUs for the dialog's picker and the zone filter (the company catalog is small).
  const allItems = useQuery({ queryKey: ['inventory', 'stock-items', 'all'], queryFn: () => call(api.GET('/api/admin/inventory/stock-items', { params: { query: { ownerType: 'official', limit: 100, page: 1 } } })) as Promise<Page<StockItem>> });
  // Same query as the session's access/me (shared cache): the adjustment limit decides "Send for second review".
  const access = useQuery({ queryKey: ['access', 'me', staff.accountId], queryFn: () => call(api.GET('/api/admin/access/me')) });

  const limit = useMemo(() => {
    const limits = (access.data as AccessMe | undefined)?.limits ?? [];
    const l = limits.find((x) => x.action.key === 'inventory.adjustments.apply' && x.value?.authority !== 'not_permitted');
    return l?.value?.limitNumber ?? null;
  }, [access.data]);
  const pickList = useMemo(() => allItems.data?.items ?? [], [allItems.data]);
  const zones = useMemo(() => [...new Set(pickList.map((r) => r.binCode?.split('-')[0]).filter(Boolean) as string[])].sort(), [pickList]);
  const rows = items.data?.items ?? [];

  const open = view === 'adjust-stock';
  const row = pickList.find((r) => r.id === draft.id) ?? rows.find((r) => r.id === draft.id);
  const errors = attempted ? validate(draft, row) : {};
  const qty = Number(draft.qty) || 0;
  const needsReview = limit != null && qty > limit;

  const adjust = useMutation({
    mutationFn: () =>
      call(
        api.POST('/api/admin/inventory/adjustments', {
          body: {
            stockItemId: draft.id,
            fromGroup: draft.from,
            toGroup: draft.to,
            quantity: qty,
            reasonCode: draft.reason,
            note: draft.note.trim() || undefined,
            reviewDate: draft.to === 'damaged_held' ? draft.reviewDate : undefined,
          } as never,
        }),
      ) as Promise<Adjustment>,
    onSuccess: (a) => {
      const move = `${a.quantity} units of ${a.sku} ${a.state === 'pending_review' ? 'move' : 'moved'} from ${GROUP_LABEL[a.fromGroup] ?? a.fromGroup} to ${GROUP_LABEL[a.toGroup] ?? a.toGroup}`;
      if (a.state === 'pending_review') setDone({ tone: 'info', title: 'Sent for second review', body: `${move} after ${a.approval?.approverLabel ?? 'a second reviewer'} approves. Nothing moves until then.` });
      else setDone({ tone: 'success', title: 'Stock adjusted', body: `${move}. The change is in the adjustment history.` });
      announce(a.state === 'pending_review' ? 'Adjustment sent for second review' : 'Stock adjusted');
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
      setView('');
    },
  });

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const openAdjust = (id?: string) => {
    setDraft(blankDraft(id ?? pickList[0]?.id ?? rows[0]?.id ?? ''));
    setAttempted(false);
    adjust.reset();
    setView('adjust-stock');
  };
  const close = () => setView('');

  const submit = () => {
    setAttempted(true);
    if (Object.keys(validate(draft, row)).length) return;
    adjust.mutate();
  };

  const fieldErrors = adjust.error instanceof ApiError ? adjust.error.fieldErrors : {};
  const fromBefore = draft.from === 'outside' || !row ? 0 : row.quantities[Q_KEY[draft.from]];
  const toBefore = draft.to === 'outside' || !row ? 0 : row.quantities[Q_KEY[draft.to]];
  const valid = !Object.keys(validate(draft, row)).length;
  const lowItems = low.data?.items ?? [];
  const s = summary.data;
  const tiles = s?.groups ?? (Object.keys(GROUP_TONE) as Group[]).map((g) => ({ group: g, label: GROUP_LABEL[g], meaning: '', units: -1, valueAtCost: null as MoneyValue | null }));

  return (
    <OpsLayout active="inventory">
      <PageHeader
        title="Official Store stock"
        sub="Reno, NV warehouse · company-owned stock only. Seller stock is never mixed in."
        actions={
          <>
            <Button variant="secondary" size="sm" icon="download" disabled title="Stock exports aren’t available yet">
              Export
            </Button>
            {canAdjust && (
              <Button size="sm" icon="sliders-horizontal" onClick={() => openAdjust()} disabled={!pickList.length}>
                Adjust stock
              </Button>
            )}
          </>
        }
      />
      {summary.error ? (
        <LoadError error={summary.error} onRetry={() => void summary.refetch()} />
      ) : (
        <div className="ac-groups">
          {tiles.map((t) => (
            <div key={t.group} className="ac-grp" style={{ '--tone': GROUP_TONE[t.group] ?? 'var(--border-strong)' } as CSSProperties}>
              <span className="xs strong sub">{t.label}</span>
              {t.units < 0 ? <span className="sk sk-line" /> : <span className="v">{num(t.units)}</span>}
              <span className="xs muted">{t.valueAtCost && t.valueAtCost.amount > 0 ? `${formatMoney(t.valueAtCost)} at cost` : 'Cost not recorded'}</span>
              <span className="xs muted">{t.meaning}</span>
            </div>
          ))}
        </div>
      )}
      {done && (
        <Alert tone={done.tone} title={done.title}>
          {done.body}
        </Alert>
      )}
      {s && s.lowStockCount + s.outOfStockCount > 0 && (
        <Alert tone="warning" title={s.lowStockHeadline}>
          {lowItems
            .map((l) => `${l.item.label} (${l.item.sku}) is ${l.item.quantities.available === 0 ? 'out of stock' : `low, ${l.item.quantities.available} left`}${l.incoming?.quantity ? `, ${l.incoming.quantity} incoming${l.incoming.reference ? ` on ${l.incoming.reference}` : ''}` : ''}.`)
            .join(' ')}{' '}
          Customers can buy only Available units.
        </Alert>
      )}
      <div className="toolbar">
        <SearchInput id="inv-q" placeholder="Search SKU, product or bin" value={q} onChange={setQ} />
        <label className="sr-only" htmlFor="inv-grp">
          Stock group
        </label>
        <Select
          id="inv-grp"
          options={STOCK_FILTERS}
          value={grp}
          onChange={(e) => {
            setGrp(e.target.value);
            setPage(1);
          }}
        />
        <label className="sr-only" htmlFor="inv-loc">
          Location
        </label>
        <Select
          id="inv-loc"
          options={[{ value: '', label: 'All locations' }, ...zones.map((z) => ({ value: z, label: `Zone ${z}` }))]}
          value={zone}
          onChange={(e) => {
            setZone(e.target.value);
            setPage(1);
          }}
        />
      </div>
      <Card title="Stock by SKU" sub={items.data ? `${items.data.total ?? rows.length} of ${s?.skuCount ?? items.data.total ?? rows.length} Official Store SKUs` : 'Loading…'} flush>
        {items.error ? (
          <div className="card-body">
            <LoadError error={items.error} onRetry={() => void items.refetch()} />
          </div>
        ) : (
          <>
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
                    {items.isPending && <SkeletonRows cols={10} />}
                    {!items.isPending && !rows.length && <EmptyRow cols={10}>No SKUs match these filters.</EmptyRow>}
                    {rows.map((r) => {
                      const st = statusOf(r);
                      return (
                        <tr key={r.id} className={cx(st === 'Out of stock' && 'is-flagged', st === 'Low stock' && 'is-warn')}>
                          <td>
                            {st === 'Out of stock' && <span className="sr-only">Urgent: </span>}
                            {st === 'Low stock' && <span className="sr-only">At risk: </span>}
                            <div className="cell-main">
                              <Img icon="package" src={r.image?.url} alt={r.image?.alt ?? ''} className="tiny" />
                              <span className="stack gap-0">
                                <span className="small strong">{r.label}</span>
                                <span className="xs mono muted nowrap" title={r.sku}>
                                  {r.sku}
                                </span>
                              </span>
                            </div>
                          </td>
                          <td>
                            <span className="mono small nowrap" title={r.binCode ?? ''}>
                              {r.binCode ?? '—'}
                            </span>
                          </td>
                          <td className="r">
                            <Available r={r} />
                          </td>
                          <td className="r">{r.quantities.reserved}</td>
                          <td className="r">
                            <Num n={r.quantities.incoming} />
                          </td>
                          <td className="r">
                            <Num n={r.quantities.damagedHeld} tone="danger" />
                          </td>
                          <td className="r">
                            <Num n={r.quantities.returned} tone="warning" />
                          </td>
                          <td className="r">
                            <span className="muted">{r.lowStockThreshold ?? '—'}</span>
                          </td>
                          <td>
                            <StatusBadge status={st} />
                          </td>
                          <td className="col-pin">
                            {canAdjust && (
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => openAdjust(r.id)}>
                                <span>Adjust</span>
                                <span className="sr-only"> {r.sku}</span>
                              </button>
                            )}
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
              {items.isPending && <SkeletonLines rows={4} />}
              {!items.isPending && !rows.length && <div className="ac-mi xs sub">No SKUs match these filters.</div>}
              {rows.map((r) => {
                const st = statusOf(r);
                return (
                  <div key={r.id} className={cx('ac-mi', st === 'Out of stock' && 'is-flagged', st === 'Low stock' && 'is-warn')}>
                    {st === 'Out of stock' && <span className="sr-only">Urgent: </span>}
                    {st === 'Low stock' && <span className="sr-only">At risk: </span>}
                    <div className="row between gap-2 nowrap top">
                      <span className="small strong min-w-0">{r.label}</span>
                      <StatusBadge status={st} />
                    </div>
                    <div className="xs sub">
                      <span className="mono">{r.sku}</span> · bin <span className="mono">{r.binCode ?? '—'}</span>
                    </div>
                    <div className="xs sub">
                      Available <b>{r.quantities.available}</b> · Reserved {r.quantities.reserved} · Incoming {r.quantities.incoming} · Damaged {r.quantities.damagedHeld} · Returned {r.quantities.returned}
                    </div>
                  </div>
                );
              })}
            </div>
            <OpsLegend className="only-phone" items={[{ tone: 'danger', label: EDGE_URGENT }, { tone: 'warning', label: EDGE_RISK }]} />
            {(items.data?.totalPages ?? 1) > 1 && (
              <div className="card-foot">
                <Pager page={page} total={items.data?.totalPages ?? 1} onPage={setPage} only="website" />
              </div>
            )}
          </>
        )}
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
          {history.error ? (
            <div className="card-body">
              <LoadError error={history.error} onRetry={() => void history.refetch()} />
            </div>
          ) : (
            <>
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
                      {history.isPending && <SkeletonRows cols={7} rows={3} />}
                      {!history.isPending && !history.data?.items.length && <EmptyRow cols={7}>No adjustments yet.</EmptyRow>}
                      {history.data?.items.map((h) => (
                        <tr key={h.id}>
                          <td>
                            <span className="small nowrap">{dateTime(h.createdAt)}</span>
                          </td>
                          <td>
                            <span className="mono small nowrap" title={h.sku}>
                              {h.sku}
                            </span>
                          </td>
                          <td>
                            <BeforeAfter b={GROUP_LABEL[h.fromGroup] ?? h.fromGroup} a={GROUP_LABEL[h.toGroup] ?? h.toGroup} />
                          </td>
                          <td className="r">
                            <b>{h.quantity}</b>
                          </td>
                          <td>
                            <span className="small minw-180 cell-text">{h.note ? `${h.reasonLabel}. ${h.note}` : h.reasonLabel}</span>
                          </td>
                          <td>
                            <span className="small nowrap">{h.requestedBy?.name ?? '—'}</span>
                          </td>
                          <td className="col-pin">
                            <span className="xs muted">{reviewLabel(h)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </div>
              <div className="ac-mlist only-phone">
                {history.isPending && <SkeletonLines rows={3} />}
                {history.data?.items.map((h) => (
                  <div key={h.id} className="ac-mi">
                    <div className="row between gap-2 nowrap top">
                      <span className="small strong min-w-0">
                        <span className="mono">{h.sku}</span> · {h.quantity} units
                      </span>
                      <span className="xs muted nowrap">{dateTime(h.createdAt)}</span>
                    </div>
                    <div className="xs sub">
                      <BeforeAfter b={GROUP_LABEL[h.fromGroup] ?? h.fromGroup} a={GROUP_LABEL[h.toGroup] ?? h.toGroup} />
                    </div>
                    <div className="xs sub">
                      {h.reasonLabel} · {h.requestedBy?.name ?? '—'}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
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
                <span className="small grow">{limit != null ? `Adjustments over ${limit} units need a second reviewer (your limit).` : 'Adjustments above your role’s limit need a second reviewer.'}</span>
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
        open={open && canAdjust}
        onClose={close}
        title="Adjust stock"
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button icon={needsReview ? 'send' : 'check'} onClick={submit} disabled={adjust.isPending}>
              {adjust.isPending ? 'Saving…' : needsReview ? 'Send for second review' : 'Apply adjustment'}
            </Button>
          </>
        }
      >
        {adjust.error && <Alert tone="danger">{errorMessage(adjust.error)}</Alert>}
        <Field label="SKU" error={errors.id}>
          <Select id="adj-sku" options={pickList.map((r) => ({ value: r.id, label: `${r.sku} · ${r.label}` }))} value={draft.id} onChange={(e) => set('id', e.target.value)} />
        </Field>
        {row && (
          <div className="panel row gap-4 xs sub">
            <span>
              Available <b>{row.quantities.available}</b>
            </span>
            <span>
              Reserved <b>{row.quantities.reserved}</b>
            </span>
            <span>
              Damaged or held <b>{row.quantities.damagedHeld}</b>
            </span>
            <span>
              Bin <b className="mono">{row.binCode ?? '—'}</b>
            </span>
          </div>
        )}
        <div className="ac-fgrid">
          <Field label="From group">
            <Select id="adj-from" options={FROM_GROUPS} value={draft.from} onChange={(e) => set('from', e.target.value as From)} />
          </Field>
          <Field label="To group" error={errors.to ?? fieldErrors.toGroup}>
            <Select id="adj-to" options={TO_GROUPS} value={draft.to} onChange={(e) => set('to', e.target.value as To)} />
          </Field>
          <Field label="Quantity" error={errors.qty ?? fieldErrors.quantity}>
            <TextInput id="adj-qty" type="number" min={1} value={draft.qty} error={!!errors.qty} suffix="units" onChange={(e) => set('qty', e.target.value)} />
          </Field>
          <Field label="Reason (required)" error={errors.reason ?? fieldErrors.reasonCode}>
            <Select id="adj-reason" options={REASONS} value={draft.reason} onChange={(e) => set('reason', e.target.value)} aria-invalid={!!errors.reason || undefined} className={cx(errors.reason && 'is-error')} />
          </Field>
          {draft.to === 'damaged_held' && (
            <Field label="Review the hold on" error={errors.reviewDate ?? fieldErrors.reviewDate}>
              <TextInput id="adj-review" type="date" value={draft.reviewDate} error={!!errors.reviewDate} onChange={(e) => set('reviewDate', e.target.value)} />
            </Field>
          )}
          <div className="full">
            <Field label="Note" optional>
              <Textarea id="adj-note" value={draft.note} onChange={(e) => set('note', e.target.value)} />
            </Field>
          </div>
        </div>
        {qty > 0 && valid && row && (
          <div className="well stack gap-2">
            <span className="small strong">After this change</span>
            {draft.from === 'outside' ? <SummaryRow k="Found stock" v={`${qty} units`} /> : <SummaryRow k={GROUP_LABEL[draft.from]} v={<BeforeAfter b={fromBefore} a={fromBefore - qty} />} />}
            {draft.to !== 'outside' ? <SummaryRow k={GROUP_LABEL[draft.to]} v={<BeforeAfter b={toBefore} a={toBefore + qty} />} /> : <SummaryRow k="Written off" v={`${qty} units`} />}
            {draft.from === 'available' && row.quantities.reserved > 0 && <span className="xs muted">{row.quantities.reserved} reserved units stay with their orders. Order Manager is notified to check them.</span>}
          </div>
        )}
        {needsReview && (
          <Alert tone="warning" title="Second review needed">
            {qty} units is above your {limit}-unit adjustment limit. The change applies after a second reviewer approves it.
          </Alert>
        )}
      </Dialog>
    </OpsLayout>
  );
}
