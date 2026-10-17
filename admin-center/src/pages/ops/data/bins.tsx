import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError, call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { Alert, Badge, Button, Card, Checkbox, Dialog, EmptyState, Field, IconButton, Pager, Radio, SearchInput, Select, StatusBadge, TableWrap, Textarea, TextInput, announce } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines } from '@/app/parts';
import { EmptyRow, SkeletonRows } from './shared';

// Warehouse setup inside Ops › Inventory (pages/ops/Inventory.tsx): bins, the bins of a stock item, and box sizes.
// No design exists for these; they reuse the Inventory screen's table, dialog and form patterns.
// A fresh install has no bins: receiving can't put stock away and picking (requireBinScan) has nothing to scan
// until bins are created here.
// API: GET inventory/locations (the warehouse a bin belongs to), GET/POST warehouse/bins, PATCH warehouse/bins/{id},
// PUT warehouse/stock-items/{id}/bins, GET/PUT warehouse/box-types.

export type Bin = components['schemas']['warehouse.Bin'];
type BinKind = Bin['kind'];
type BoxType = components['schemas']['warehouse.BoxType'];
type Location = components['schemas']['inventory.Location'];
interface Page<T> {
  items: T[];
  total?: number;
  totalPages?: number;
}

export const BIN_KINDS: Array<{ value: BinKind; label: string }> = [
  { value: 'pick', label: 'Pick: shelf stock is picked from' },
  { value: 'bulk', label: 'Bulk: overflow storage' },
  { value: 'quarantine', label: 'Quarantine: damaged or held units' },
  { value: 'returns', label: 'Returns: parcels waiting for inspection' },
  { value: 'packing', label: 'Packing: packing station' },
  { value: 'dock', label: 'Dock: receiving or dispatch dock' },
];
const KIND_NAME: Record<BinKind, string> = { pick: 'Pick', bulk: 'Bulk', quarantine: 'Quarantine', returns: 'Returns', packing: 'Packing', dock: 'Dock' };
/** Stock is stored only in pick and bulk bins (the backend refuses other kinds for a stock item). */
const STORAGE: BinKind[] = ['pick', 'bulk'];

/** Field errors of a VALIDATION_FAILED answer as one line, so the dialog says what to fix. */
const issuesOf = (err: unknown) => (err instanceof ApiError ? Object.values(err.fieldErrors).join(' ') : '');

/** Company warehouses (bins belong to one); the default one first. */
export function useWarehouses() {
  const { api } = useApi();
  return useQuery({
    queryKey: ['inventory', 'locations'],
    queryFn: async () => {
      const all = (await call(api.GET('/api/admin/inventory/locations'))) as Location[];
      return all.filter((l) => l.ownerType === 'official' && l.kind === 'warehouse' && l.active).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    },
  });
}

/** Splits typed codes on new lines, commas and spaces; upper case like the backend stores them. */
const parseCodes = (text: string) => [...new Set(text.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))];

/* ------------------------------------------------------------------ bins */

function AddBinsDialog({ open, onClose, warehouses }: { open: boolean; onClose: () => void; warehouses: Location[] }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [locationId, setLocationId] = useState('');
  const [kind, setKind] = useState<BinKind>('pick');
  const [text, setText] = useState('');
  // optional range helper: prefix + from..to, e.g. A-03- 1..6 → A-03-1 … A-03-6
  const [prefix, setPrefix] = useState('');
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('');
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLocationId(warehouses[0]?.id ?? '');
    setKind('pick');
    setText('');
    setPrefix('');
    setTo('');
    setTried(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const codes = parseCodes(text);
  const create = useMutation({
    mutationFn: () => call(api.POST('/api/admin/warehouse/bins', { body: { locationId, codes, kind } })) as Promise<Bin[]>,
    onSuccess: (bins) => {
      announce(bins.length === 1 ? `Bin ${bins[0].code} created` : `${bins.length} bins created`);
      void qc.invalidateQueries({ queryKey: ['warehouse', 'bins'] });
      onClose();
    },
  });

  const addRange = () => {
    const a = Math.floor(Number(from));
    const b = Math.floor(Number(to));
    if (!prefix.trim() || !Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < a || b - a >= 500) return;
    const width = String(to).trim().length; // keep leading zeros when the "to" number has them (01..12)
    const range = Array.from({ length: b - a + 1 }, (_, i) => `${prefix.trim().toUpperCase()}${String(a + i).padStart(width, '0')}`);
    setText((t) => [t.trim(), ...range].filter(Boolean).join('\n'));
  };

  const submit = () => {
    setTried(true);
    if (!codes.length || !locationId) return;
    create.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add bins"
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="plus" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Saving…' : codes.length > 1 ? `Add ${codes.length} bins` : 'Add bin'}
          </Button>
        </>
      }
    >
      {create.error && (
        <Alert tone="danger">
          {errorMessage(create.error)} {issuesOf(create.error)}
        </Alert>
      )}
      {warehouses.length > 1 && (
        <Field label="Warehouse">
          <Select id="bin-loc" options={warehouses.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` }))} value={locationId} onChange={(e) => setLocationId(e.target.value)} />
        </Field>
      )}
      {!warehouses.length && <Alert tone="warning">No active company warehouse. Add the warehouse location first.</Alert>}
      <Field label="Kind" hint="Stock is stored in pick and bulk bins. Damaged units from receiving go to a quarantine bin.">
        <Select id="bin-kind" options={BIN_KINDS} value={kind} onChange={(e) => setKind(e.target.value as BinKind)} />
      </Field>
      <Field label="Bin codes" hint="One per line, or separated by commas. Zone-aisle-level, e.g. A-03-2. The first part is the zone." error={tried && !codes.length ? 'Enter at least one bin code.' : undefined}>
        <Textarea id="bin-codes" value={text} onChange={(e) => setText(e.target.value)} placeholder={'A-01-1\nA-01-2\nQ-01-1'} />
      </Field>
      <div className="well stack gap-2">
        <span className="small strong">Fill a range</span>
        <div className="row gap-2">
          <label className="sr-only" htmlFor="bin-prefix">
            Prefix
          </label>
          <TextInput id="bin-prefix" className="ac-loc" placeholder="A-03-" value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} />
          <label className="sr-only" htmlFor="bin-from">
            From
          </label>
          <input className="input ac-qty" id="bin-from" type="number" min={0} value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="xs muted">to</span>
          <label className="sr-only" htmlFor="bin-to">
            To
          </label>
          <input className="input ac-qty" id="bin-to" type="text" inputMode="numeric" placeholder="6" value={to} onChange={(e) => setTo(e.target.value)} />
          <Button variant="secondary" size="sm" onClick={addRange}>
            Add to list
          </Button>
        </div>
        <span className="xs muted">A-03- from 1 to 6 adds A-03-1 to A-03-6. Write the end as 06 to get A-03-01 to A-03-06.</span>
      </div>
      {codes.length > 0 && <span className="xs muted">{codes.length === 1 ? `1 bin: ${codes[0]}` : `${codes.length} bins: ${codes.slice(0, 6).join(', ')}${codes.length > 6 ? ', …' : ''}`}</span>}
    </Dialog>
  );
}

function EditBinDialog({ bin, onClose }: { bin: Bin | null; onClose: () => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [kind, setKind] = useState<BinKind>('pick');
  const [active, setActive] = useState(true);
  useEffect(() => {
    if (!bin) return;
    setKind(bin.kind);
    setActive(bin.active);
  }, [bin]);

  const save = useMutation({
    // only the changed fields: the backend refuses deactivating, or making non-storage, a bin with stock items
    mutationFn: () =>
      call(api.PATCH('/api/admin/warehouse/bins/{id}', { params: { path: { id: bin!.id } }, body: { kind: kind !== bin!.kind ? kind : undefined, active: active !== bin!.active ? active : undefined } })) as Promise<Bin>,
    onSuccess: (b) => {
      announce(`Bin ${b.code} saved`);
      void qc.invalidateQueries({ queryKey: ['warehouse', 'bins'] });
      onClose();
    },
  });
  useEffect(() => save.reset(), [bin?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = !!bin && (kind !== bin.kind || active !== bin.active);
  return (
    <Dialog
      open={!!bin}
      onClose={onClose}
      title={bin ? `Bin ${bin.code}` : 'Bin'}
      size="sm"
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="check" onClick={() => save.mutate()} disabled={!changed || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
      {bin && (
        <>
          <span className="xs sub">
            Zone <b>{bin.zone}</b> · barcode <span className="mono">{bin.barcode}</span> · {bin.assignedItems} stock {bin.assignedItems === 1 ? 'item' : 'items'}
          </span>
          <Field label="Kind">
            <Select id="bin-edit-kind" options={BIN_KINDS} value={kind} onChange={(e) => setKind(e.target.value as BinKind)} />
          </Field>
          <Checkbox id="bin-edit-active" label="Active: can be scanned at put-away and picking" checked={active} onChange={(e) => setActive(e.target.checked)} />
          {bin.assignedItems > 0 && (!active || !STORAGE.includes(kind)) && (
            <Alert tone="warning">Move its {bin.assignedItems} stock {bin.assignedItems === 1 ? 'item' : 'items'} to another bin first (Stock › Bins on the item).</Alert>
          )}
        </>
      )}
    </Dialog>
  );
}

const LIMIT = 50;

/** The Bins view of Ops › Inventory: every bin of a warehouse, add, change kind, deactivate. */
export function BinsPanel({ canManage }: { canManage: boolean }) {
  const { api } = useApi();
  const warehouses = useWarehouses();
  const list = warehouses.data ?? [];
  const [locationId, setLocationId] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Bin | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const loc = locationId || list[0]?.id || '';
  const params = { locationId: loc || undefined, q: search || undefined, kind: (kind || undefined) as BinKind | undefined, page, limit: LIMIT };
  const bins = useQuery({
    queryKey: ['warehouse', 'bins', params],
    queryFn: () => call(api.GET('/api/admin/warehouse/bins', { params: { query: params } })) as Promise<Page<Bin>>,
    placeholderData: keepPreviousData,
    enabled: warehouses.isSuccess,
  });
  const rows = bins.data?.items ?? [];
  const filtered = !!(search || kind);

  const editButton = (b: Bin) =>
    canManage && (
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(b)}>
        <span>Edit</span>
        <span className="sr-only"> bin {b.code}</span>
      </button>
    );

  return (
    <>
      <div className="toolbar">
        <SearchInput id="bin-q" placeholder="Search bin code or barcode" value={q} onChange={setQ} />
        <label className="sr-only" htmlFor="bin-kind-filter">
          Kind
        </label>
        <Select
          id="bin-kind-filter"
          options={[{ value: '', label: 'All kinds' }, ...BIN_KINDS.map((k) => ({ value: k.value, label: KIND_NAME[k.value] }))]}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setPage(1);
          }}
        />
        {list.length > 1 && (
          <>
            <label className="sr-only" htmlFor="bin-loc-filter">
              Warehouse
            </label>
            <Select
              id="bin-loc-filter"
              options={list.map((w) => ({ value: w.id, label: w.name }))}
              value={loc}
              onChange={(e) => {
                setLocationId(e.target.value);
                setPage(1);
              }}
            />
          </>
        )}
        {canManage && (
          <Button size="sm" icon="plus" onClick={() => setAdding(true)} disabled={!list.length}>
            Add bins
          </Button>
        )}
      </div>
      {warehouses.error ? (
        <LoadError error={warehouses.error} onRetry={() => void warehouses.refetch()} />
      ) : bins.error ? (
        <LoadError error={bins.error} onRetry={() => void bins.refetch()} />
      ) : !bins.isPending && !rows.length && !filtered ? (
        <EmptyState icon="warehouse" title="No bins yet" as="h2" action={canManage ? <Button icon="plus" onClick={() => setAdding(true)} disabled={!list.length}>Add bins</Button> : undefined}>
          Add the pick and bulk bins stock is stored in, and at least one quarantine bin for damaged units. Receiving puts stock away into these bins and pickers scan them.
        </EmptyState>
      ) : (
        <Card title="Bins" sub={bins.data ? `${bins.data.total ?? rows.length} bins` : 'Loading…'} flush>
          <div className="no-phone">
            <TableWrap label="Bins table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Bin</th>
                    <th scope="col">Zone</th>
                    <th scope="col">Kind</th>
                    <th className="r" scope="col">Stock items</th>
                    <th scope="col">Status</th>
                    <th className="col-pin" scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {bins.isPending && <SkeletonRows cols={6} />}
                  {!bins.isPending && !rows.length && <EmptyRow cols={6}>No bins match these filters.</EmptyRow>}
                  {rows.map((b) => (
                    <tr key={b.id}>
                      <td>
                        <span className="stack gap-0">
                          <span className="mono small strong">{b.code}</span>
                          <span className="xs mono muted nowrap" title={b.barcode}>
                            {b.barcode}
                          </span>
                        </span>
                      </td>
                      <td>
                        <span className="small">{b.zone}</span>
                      </td>
                      <td>
                        <span className="small">{KIND_NAME[b.kind]}</span>
                      </td>
                      <td className="r">{b.assignedItems || <span className="muted">0</span>}</td>
                      <td>{b.active ? <StatusBadge status="Active" tone="success" /> : <StatusBadge status="Inactive" tone="" />}</td>
                      <td className="col-pin">{editButton(b)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </div>
          <div className="ac-mlist only-phone">
            {bins.isPending && <SkeletonLines rows={4} />}
            {!bins.isPending && !rows.length && <div className="ac-mi xs sub">No bins match these filters.</div>}
            {rows.map((b) => (
              <div key={b.id} className="ac-mi">
                <div className="row between gap-2 nowrap top">
                  <span className="mono small strong min-w-0">{b.code}</span>
                  {b.active ? <StatusBadge status="Active" tone="success" /> : <StatusBadge status="Inactive" tone="" />}
                </div>
                <div className="xs sub">
                  {KIND_NAME[b.kind]} · zone {b.zone} · {b.assignedItems} stock {b.assignedItems === 1 ? 'item' : 'items'}
                </div>
                {canManage && <div className="row gap-2 mt-1-5">{editButton(b)}</div>}
              </div>
            ))}
          </div>
          {(bins.data?.totalPages ?? 1) > 1 && (
            <div className="card-foot">
              <Pager page={page} total={bins.data?.totalPages ?? 1} onPage={setPage} only="website" />
            </div>
          )}
        </Card>
      )}
      <AddBinsDialog open={adding} onClose={() => setAdding(false)} warehouses={list} />
      <EditBinDialog bin={editing} onClose={() => setEditing(null)} />
    </>
  );
}

/* ------------------------------------------------------------------ bins of one stock item */

interface Assigned {
  binId: string;
  code: string;
  primary: boolean;
}

/**
 * Sets the bins a stock item is stored in. It starts from the item's current bins (GET …/stock-items/{id}/bins);
 * saving sends the whole list (PUT replaces it, exactly one primary).
 */
export function StockBinsDialog({ item, onClose }: { item: { id: string; sku: string; label: string; binCode: string | null } | null; onClose: () => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [rows, setRows] = useState<Assigned[]>([]);
  const [code, setCode] = useState('');
  const [addError, setAddError] = useState('');
  // the item the list was filled for (fill once per opening, after its current bins have loaded)
  const loadedFor = useRef('');

  /** A bin by its exact code (the list search matches parts of codes and barcodes). */
  const findBin = async (raw: string): Promise<Bin | undefined> => {
    const c = raw.trim().toUpperCase();
    const page = (await call(api.GET('/api/admin/warehouse/bins', { params: { query: { q: c, limit: 20 } } }))) as Page<Bin>;
    return page.items.find((b) => b.code === c || b.barcode === c);
  };

  // start from the bins the item is in now (primary first)
  const current = useQuery({
    queryKey: ['warehouse', 'stock-item-bins', item?.id],
    queryFn: () => call(api.GET('/api/admin/warehouse/stock-items/{stockItemId}/bins', { params: { path: { stockItemId: item!.id } } })),
    enabled: !!item,
  });
  useEffect(() => {
    if (!item || loadedFor.current === item.id || !current.isSuccess) return;
    loadedFor.current = item.id;
    setRows(current.data.map((a) => ({ binId: a.binId, code: a.binCode, primary: a.primary })));
    setCode('');
    setAddError('');
  }, [item, current.isSuccess, current.data]);
  useEffect(() => {
    if (!item) loadedFor.current = '';
  }, [item]);

  const add = useMutation({
    mutationFn: findBin,
    onSuccess: (b) => {
      const c = code.trim().toUpperCase();
      if (!b) return setAddError(`There is no bin ${c}. Create it in the Bins view first.`);
      if (!b.active) return setAddError(`${b.code} is not active.`);
      if (!STORAGE.includes(b.kind)) return setAddError(`${b.code} is a ${KIND_NAME[b.kind].toLowerCase()} bin. Stock is stored in pick or bulk bins.`);
      if (rows.some((r) => r.binId === b.id)) return setAddError(`${b.code} is already listed.`);
      setRows((rs) => [...rs, { binId: b.id, code: b.code, primary: rs.length === 0 }]);
      setCode('');
      setAddError('');
    },
  });

  const save = useMutation({
    mutationFn: () => call(api.PUT('/api/admin/warehouse/stock-items/{stockItemId}/bins', { params: { path: { stockItemId: item!.id } }, body: { bins: rows.map((r) => ({ binId: r.binId, primary: r.primary })) } })),
    onSuccess: () => {
      announce(`Bins of ${item!.sku} saved`);
      // Inventory learns the primary bin from warehouse.bin.assigned; bins show their item counts
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: ['warehouse'] });
      onClose();
    },
  });
  useEffect(() => save.reset(), [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = (id: string) =>
    setRows((rs) => {
      const next = rs.filter((r) => r.binId !== id);
      // keep exactly one primary
      if (next.length && !next.some((r) => r.primary)) next[0] = { ...next[0], primary: true };
      return next;
    });

  return (
    <Dialog
      open={!!item}
      onClose={onClose}
      title={item ? `Bins of ${item.sku}` : 'Bins'}
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="check" onClick={() => save.mutate()} disabled={save.isPending || !current.isSuccess}>
            {save.isPending ? 'Saving…' : 'Save bins'}
          </Button>
        </>
      }
    >
      {save.error && (
        <Alert tone="danger">
          {errorMessage(save.error)} {issuesOf(save.error)}
        </Alert>
      )}
      {item && <span className="small strong">{item.label}</span>}
      {current.isPending ? (
        <SkeletonLines rows={2} />
      ) : current.isError ? (
        <LoadError error={current.error} onRetry={() => void current.refetch()} />
      ) : rows.length ? (
        <ul className="list">
          {rows.map((r) => (
            <li key={r.binId}>
              <Radio id={`sb-${r.binId}`} name="sb-primary" label={<span className="mono">{r.code}</span>} checked={r.primary} onChange={() => setRows((rs) => rs.map((x) => ({ ...x, primary: x.binId === r.binId })))} />
              <span className="grow">{r.primary && <Badge tone="outline">Primary: picked from first</Badge>}</span>
              <IconButton icon="trash-2" label={`Remove ${r.code}`} onClick={() => remove(r.binId)} />
            </li>
          ))}
        </ul>
      ) : (
        <Alert tone="warning">No bins. Pickers can’t pick this item until it is in a bin.</Alert>
      )}
      <form
        className="row gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) add.mutate(code);
        }}
      >
        <label className="sr-only" htmlFor="sb-add">
          Bin code
        </label>
        <span className="grow">
          <TextInput id="sb-add" icon="scan-barcode" placeholder="Scan or enter a bin code" value={code} autoComplete="off" error={!!addError} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </span>
        <Button type="submit" variant="secondary" size="sm" icon="plus" disabled={add.isPending}>
          Add bin
        </Button>
      </form>
      {(addError || add.error) && <span className="error-text">{addError || errorMessage(add.error)}</span>}
      <span className="xs muted">Saving replaces every bin this item is stored in with this list. Lines not picked yet move to the new primary bin.</span>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ box types */

interface BoxDraft {
  id: string;
  name: string;
  kind: BoxType['kind'];
  length: string;
  width: string;
  height: string;
  unit: 'in' | 'cm';
  maxWeight: string;
  weightUnit: 'lb' | 'kg';
}
const toDraft = (b: BoxType): BoxDraft => ({
  id: b.id,
  name: b.name,
  kind: b.kind,
  length: String(b.dimensions.length),
  width: String(b.dimensions.width),
  height: String(b.dimensions.height),
  unit: b.dimensions.unit,
  maxWeight: b.maxWeight ? String(b.maxWeight.value) : '',
  weightUnit: b.maxWeight?.unit ?? 'lb',
});
const blankBox = (): BoxDraft => ({ id: crypto.randomUUID(), name: '', kind: 'box', length: '', width: '', height: '', unit: 'in', maxWeight: '', weightUnit: 'lb' });
const positive = (v: string) => Number(v) > 0;
const boxSize = (b: BoxType) => `${b.dimensions.length} × ${b.dimensions.width} × ${b.dimensions.height} ${b.dimensions.unit}${b.maxWeight ? ` · up to ${b.maxWeight.value} ${b.maxWeight.unit}` : ''}`;

/**
 * The Box types view: the box and mailer sizes packers choose from at the packing station.
 * PUT replaces the whole list; a size left out is retired (packages that used it keep it).
 */
export function BoxTypesPanel({ canManage }: { canManage: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  // same query key as Pick and pack, so a change shows there too
  const boxes = useQuery({ queryKey: ['warehouse', 'box-types'], queryFn: () => call(api.GET('/api/admin/warehouse/box-types')) as Promise<BoxType[]> });
  const [drafts, setDrafts] = useState<BoxDraft[] | null>(null);
  const [tried, setTried] = useState(false);
  const editing = drafts !== null;

  const save = useMutation({
    mutationFn: (list: BoxDraft[]) =>
      call(
        api.PUT('/api/admin/warehouse/box-types', {
          body: {
            boxTypes: list.map((d) => ({
              id: d.id,
              name: d.name.trim(),
              kind: d.kind,
              active: true,
              dimensions: { length: Number(d.length), width: Number(d.width), height: Number(d.height), unit: d.unit },
              maxWeight: d.maxWeight.trim() ? { value: Number(d.maxWeight), unit: d.weightUnit } : null,
            })),
          },
        }),
      ) as Promise<BoxType[]>,
    onSuccess: () => {
      announce('Box sizes saved');
      void qc.invalidateQueries({ queryKey: ['warehouse', 'box-types'] });
      setDrafts(null);
    },
  });

  const setDraft = (id: string, patch: Partial<BoxDraft>) => setDrafts((ds) => (ds ?? []).map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const invalid = (d: BoxDraft) => !d.name.trim() || !positive(d.length) || !positive(d.width) || !positive(d.height) || (!!d.maxWeight.trim() && !positive(d.maxWeight));
  const submit = () => {
    setTried(true);
    if (!drafts || drafts.some(invalid)) return;
    save.mutate(drafts);
  };
  const fe = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const list = boxes.data ?? [];

  if (boxes.error) return <LoadError error={boxes.error} onRetry={() => void boxes.refetch()} />;
  return (
    <Card
      title="Box and mailer sizes"
      sub="What packers choose from at the packing station. The packing station suggests a size from the item dimensions."
      actions={
        canManage && !editing ? (
          <Button
            size="sm"
            variant="secondary"
            icon="pencil"
            disabled={boxes.isPending}
            onClick={() => {
              setDrafts(list.length ? list.map(toDraft) : [blankBox()]);
              setTried(false);
              save.reset();
            }}
          >
            Edit sizes
          </Button>
        ) : undefined
      }
      foot={
        editing ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setDrafts(null)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button size="sm" icon="check" onClick={submit} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save sizes'}
            </Button>
          </>
        ) : undefined
      }
    >
      {boxes.isPending ? (
        <SkeletonLines rows={3} />
      ) : !editing ? (
        list.length ? (
          <ul className="list">
            {list.map((b) => (
              <li key={b.id}>
                <span className="small strong">{b.name}</span>
                <span className="grow xs sub">{boxSize(b)}</span>
                <Badge tone="outline">{b.kind === 'mailer' ? 'Mailer' : 'Box'}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small sub">No box sizes yet. Packers then enter the package dimensions by hand.</p>
        )
      ) : (
        <div className="stack gap-4">
          {save.error && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
          <div className="ac-lines">
            {drafts.map((d, i) => {
              const err = (k: string) => fe[`boxTypes.${i}.${k}`];
              return (
                <article key={d.id} className={cx('ac-line', tried && invalid(d) && 'is-warn')}>
                  <div className="ac-fgrid">
                    <Field label="Name" error={(tried && !d.name.trim() ? 'Enter a name.' : undefined) ?? err('name')}>
                      <TextInput id={`bx-name-${d.id}`} value={d.name} placeholder="M box" onChange={(e) => setDraft(d.id, { name: e.target.value })} />
                    </Field>
                    <Field label="Kind">
                      <Select id={`bx-kind-${d.id}`} options={[{ value: 'box', label: 'Box' }, { value: 'mailer', label: 'Mailer' }]} value={d.kind} onChange={(e) => setDraft(d.id, { kind: e.target.value as BoxDraft['kind'] })} />
                    </Field>
                  </div>
                  <div className="ac-line-nums">
                    {(['length', 'width', 'height'] as const).map((k) => (
                      <div key={k} className="field">
                        <label className="label" htmlFor={`bx-${k}-${d.id}`}>
                          {k[0].toUpperCase() + k.slice(1)}
                        </label>
                        <input className={cx('input ac-qty', tried && !positive(d[k]) && 'is-error')} id={`bx-${k}-${d.id}`} type="number" min={0} step="0.1" value={d[k]} onChange={(e) => setDraft(d.id, { [k]: e.target.value })} />
                      </div>
                    ))}
                    <div className="field">
                      <label className="label" htmlFor={`bx-unit-${d.id}`}>
                        Unit
                      </label>
                      <Select id={`bx-unit-${d.id}`} ctl="sm" options={['in', 'cm']} value={d.unit} onChange={(e) => setDraft(d.id, { unit: e.target.value as BoxDraft['unit'] })} />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor={`bx-max-${d.id}`}>
                        Max weight (optional)
                      </label>
                      <input className={cx('input ac-qty', tried && !!d.maxWeight.trim() && !positive(d.maxWeight) && 'is-error')} id={`bx-max-${d.id}`} type="number" min={0} step="0.1" value={d.maxWeight} onChange={(e) => setDraft(d.id, { maxWeight: e.target.value })} />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor={`bx-wu-${d.id}`}>
                        Weight unit
                      </label>
                      <Select id={`bx-wu-${d.id}`} ctl="sm" options={['lb', 'kg']} value={d.weightUnit} onChange={(e) => setDraft(d.id, { weightUnit: e.target.value as BoxDraft['weightUnit'] })} />
                    </div>
                  </div>
                  {(err('dimensions') || err('maxWeight')) && <span className="error-text">{err('dimensions') ?? err('maxWeight')}</span>}
                  {tried && (!positive(d.length) || !positive(d.width) || !positive(d.height)) && <span className="error-text">Enter length, width and height above zero.</span>}
                  <div className="row">
                    <Button variant="ghost" size="sm" icon="trash-2" onClick={() => setDrafts((ds) => (ds ?? []).filter((x) => x.id !== d.id))}>
                      Remove {d.name.trim() || 'this size'}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="row">
            <Button variant="secondary" size="sm" icon="plus" onClick={() => setDrafts((ds) => [...(ds ?? []), blankBox()])}>
              Add a size
            </Button>
          </div>
          <span className="xs muted">A removed size is retired: packages already packed in it keep it.</span>
        </div>
      )}
    </Card>
  );
}
