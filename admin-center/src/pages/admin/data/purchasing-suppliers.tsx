import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { Alert, announce, Button, Checkbox, Dialog, EmptyState, Field, SearchInput, TextInput } from '@marketly/web-shared/ui';
import { SkeletonLines } from '@/app/parts';
import type { Supplier, SupplierItem } from './purchasing';

// Supplier maintenance for Suppliers and purchasing:
// POST /api/admin/purchasing/suppliers (add), PATCH /suppliers/{id} (edit or deactivate),
// PUT /suppliers/{id}/items (replace the price list; only items on it can go on a purchase order).
// Price list rows are picked from Official Store stock: GET /api/admin/inventory/stock-items?ownerType=official.

type StockItem = components['schemas']['inventory.StockItem'];

/* ---------- Add / edit supplier ---------- */

interface SupplierForm {
  name: string;
  contact: string;
  email: string;
  phone: string;
  line1: string;
  city: string;
  region: string;
  postalCode: string;
  lead: string;
  terms: string;
  active: boolean;
}
const toForm = (s?: Supplier): SupplierForm => ({
  name: s?.name ?? '',
  contact: s?.contactName ?? '',
  email: s?.email ?? '',
  phone: s?.phone ?? '',
  line1: s?.address?.line1 ?? '',
  city: s?.address?.city ?? '',
  region: s?.address?.region ?? '',
  postalCode: s?.address?.postalCode ?? '',
  lead: s ? String(s.leadTimeDays) : '',
  terms: s?.paymentTerms ?? '',
  active: s?.active ?? true,
});

function validate(f: SupplierForm, existing: Supplier[], editingId?: string) {
  const e: Partial<Record<keyof SupplierForm, string>> = {};
  const name = f.name.trim().toLowerCase();
  if (!name) e.name = "Enter the supplier's name.";
  else if (existing.some((s) => s.id !== editingId && s.name.toLowerCase() === name)) e.name = 'This supplier is already in the list.';
  if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = 'Enter an email address, like orders@supplier.com.';
  // The table shows "City, ST" (the backend builds the supplier's location from the address).
  const anyAddress = [f.line1, f.city, f.region, f.postalCode].some((x) => x.trim());
  if (anyAddress && !f.city.trim()) e.city = 'Enter the city.';
  if (anyAddress && !/^[A-Za-z]{2}$/.test(f.region.trim())) e.region = 'Enter the 2-letter state, like NV.';
  if (!/^\d+$/.test(f.lead.trim()) || Number(f.lead) < 1) e.lead = 'Enter a lead time in whole days, like 7.';
  return e;
}

/** Add a supplier (no `supplier`) or edit one. */
export function SupplierDialog({ open, supplier, suppliers, onClose, onSaved }: { open: boolean; supplier?: Supplier; suppliers: Supplier[]; onClose: () => void; onSaved: (s: Supplier, created: boolean) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [f, setF] = useState<SupplierForm>(() => toForm(supplier));
  const [tried, setTried] = useState(false);
  const errors = tried ? validate(f, suppliers, supplier?.id) : {};
  const set = (patch: Partial<SupplierForm>) => setF((p) => ({ ...p, ...patch }));

  const save = useMutation({
    mutationFn: () => {
      const anyAddress = [f.line1, f.city, f.region, f.postalCode].some((x) => x.trim());
      // Address fields the form doesn't collect are kept from the saved address (or default to the US).
      const address = anyAddress
        ? { name: f.name.trim(), line1: f.line1.trim(), line2: supplier?.address?.line2 ?? null, city: f.city.trim(), region: f.region.trim().toUpperCase(), postalCode: f.postalCode.trim(), country: supplier?.address?.country ?? 'US' }
        : null;
      const body = {
        name: f.name.trim(),
        contactName: f.contact.trim() || null,
        email: f.email.trim() || null,
        phone: f.phone.trim() || null,
        address,
        leadTimeDays: Number(f.lead),
        paymentTerms: f.terms.trim() || null,
        ...(supplier ? { active: f.active } : {}),
      };
      return supplier
        ? call(api.PATCH('/api/admin/purchasing/suppliers/{id}', { params: { path: { id: supplier.id } }, body }))
        : call(api.POST('/api/admin/purchasing/suppliers', { body }));
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['purchasing'] });
      announce(supplier ? `${s.name} saved` : `${s.name} added`);
      onSaved(s, !supplier);
    },
  });
  const submit = () => {
    setTried(true);
    if (Object.keys(validate(f, suppliers, supplier?.id)).length) return;
    save.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={supplier ? `Edit ${supplier.name}` : 'Add supplier'}
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="check" onClick={submit} disabled={save.isPending}>
            {supplier ? 'Save supplier' : 'Add supplier'}
          </Button>
        </>
      }
    >
      {save.isError && <Alert tone="danger" title={errorMessage(save.error)} />}
      <Field label="Supplier name" error={errors.name}>
        <TextInput id="sup-name" value={f.name} error={!!errors.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <div className="grid md2 gap-3">
        <Field label="Contact" optional>
          <TextInput id="sup-contact" value={f.contact} onChange={(e) => set({ contact: e.target.value })} />
        </Field>
        <Field label="Lead time" error={errors.lead}>
          <TextInput id="sup-lead" suffix="days" inputMode="numeric" value={f.lead} error={!!errors.lead} onChange={(e) => set({ lead: e.target.value })} />
        </Field>
      </div>
      <div className="grid md2 gap-3">
        <Field label="Email" optional hint="Only used if this server can send email" error={errors.email}>
          <TextInput id="sup-email" type="email" value={f.email} error={!!errors.email} onChange={(e) => set({ email: e.target.value })} />
        </Field>
        <Field label="Phone" optional>
          <TextInput id="sup-phone" type="tel" value={f.phone} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
      </div>
      <Field label="Street address" optional>
        <TextInput id="sup-line1" value={f.line1} onChange={(e) => set({ line1: e.target.value })} />
      </Field>
      <div className="grid md2 gap-3">
        <Field label="City" optional error={errors.city}>
          <TextInput id="sup-city" placeholder="Reno" value={f.city} error={!!errors.city} onChange={(e) => set({ city: e.target.value })} />
        </Field>
        <div className="grid md2 gap-3">
          <Field label="State" optional error={errors.region}>
            <TextInput id="sup-region" placeholder="NV" maxLength={2} value={f.region} error={!!errors.region} onChange={(e) => set({ region: e.target.value })} />
          </Field>
          <Field label="ZIP" optional>
            <TextInput id="sup-zip" inputMode="numeric" value={f.postalCode} onChange={(e) => set({ postalCode: e.target.value })} />
          </Field>
        </div>
      </div>
      <Field label="Payment terms" optional hint={supplier ? undefined : 'Left empty, the store default applies'}>
        <TextInput id="sup-terms" placeholder="Net 30 from invoice" value={f.terms} onChange={(e) => set({ terms: e.target.value })} />
      </Field>
      {supplier && <Checkbox id="sup-active" label="Active (inactive suppliers can't be chosen on new purchase orders)" checked={f.active} onChange={(e) => set({ active: e.target.checked })} />}
    </Dialog>
  );
}

/* ---------- Price list ---------- */

interface Row {
  stockItemId: string;
  sku: string;
  label: string;
  supplierSku: string;
  unit: string;
  moq: string;
  lead: string;
  preferred: boolean;
}
const fromItem = (it: SupplierItem): Row => ({
  stockItemId: it.stockItemId,
  sku: it.sku,
  label: it.label,
  supplierSku: it.supplierSku ?? '',
  unit: (it.unitCost.amount / 100).toFixed(2),
  moq: it.minOrderQuantity != null ? String(it.minOrderQuantity) : '',
  lead: it.leadTimeDays != null ? String(it.leadTimeDays) : '',
  preferred: it.preferred,
});
type RowErrors = Partial<Record<'unit' | 'moq' | 'lead', string>>;
function rowErrors(r: Row): RowErrors {
  const e: RowErrors = {};
  if (!r.unit.trim() || !Number.isFinite(Number(r.unit)) || Number(r.unit) < 0) e.unit = 'Enter the buying cost, like 12.50.';
  if (r.moq.trim() && (!/^\d+$/.test(r.moq.trim()) || Number(r.moq) < 1)) e.moq = 'Whole number of 1 or more.';
  if (r.lead.trim() && !/^\d+$/.test(r.lead.trim())) e.lead = 'Whole days.';
  return e;
}

/** Replace a supplier's price list: the SKUs it sells to us, with buying cost, minimum order and lead time. */
export function PriceListDialog({ supplier, onClose, onSaved }: { supplier: Supplier; onClose: () => void; onSaved: (count: number) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['purchasing', 'supplier', supplier.id], queryFn: () => call(api.GET('/api/admin/purchasing/suppliers/{id}', { params: { path: { id: supplier.id } } })) });
  // null until the saved list has loaded; then the working copy.
  const [rows, setRows] = useState<Row[] | null>(null);
  const list = rows ?? (detail.data ? detail.data.items.map(fromItem) : null);
  const [tried, setTried] = useState(false);
  const [q, setQ] = useState('');
  const stock = useQuery({
    queryKey: ['inventory', 'stock-items', 'official-search', q.trim()],
    enabled: q.trim().length >= 2,
    queryFn: () => call(api.GET('/api/admin/inventory/stock-items', { params: { query: { ownerType: 'official', q: q.trim(), limit: 10 } } })),
  });
  const results: StockItem[] = (stock.data?.items ?? []).filter((s) => s.ownerType === 'official' && !list?.some((r) => r.stockItemId === s.id));

  const edit = (fn: (rs: Row[]) => Row[]) => setRows(fn(list ?? []));
  const setRow = (i: number, patch: Partial<Row>) => edit((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = (s: StockItem) =>
    edit((rs) => [...rs, { stockItemId: s.id, sku: s.sku, label: s.label, supplierSku: '', unit: s.unitCost ? (s.unitCost.amount / 100).toFixed(2) : '', moq: '', lead: '', preferred: false }]);

  const save = useMutation({
    mutationFn: () =>
      call(
        api.PUT('/api/admin/purchasing/suppliers/{id}/items', {
          params: { path: { id: supplier.id } },
          body: {
            items: (list ?? []).map((r) => ({
              stockItemId: r.stockItemId,
              supplierSku: r.supplierSku.trim() || null,
              unitCost: { amount: Math.round(Number(r.unit) * 100), currency: 'USD' },
              minOrderQuantity: r.moq.trim() ? Number(r.moq) : null,
              leadTimeDays: r.lead.trim() ? Number(r.lead) : null,
              preferred: r.preferred,
            })),
          },
        }),
      ),
    onSuccess: (items) => {
      void qc.invalidateQueries({ queryKey: ['purchasing'] });
      announce(`${supplier.name} price list saved`);
      onSaved(items.length);
    },
  });
  const submit = () => {
    setTried(true);
    if ((list ?? []).some((r) => Object.keys(rowErrors(r)).length)) return;
    save.mutate();
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={`${supplier.name} · price list`}
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="check" onClick={submit} disabled={save.isPending || !list}>
            Save price list
          </Button>
        </>
      }
    >
      {save.isError && <Alert tone="danger" title={errorMessage(save.error)} />}
      {detail.isError && <Alert tone="danger" title={errorMessage(detail.error)} />}
      <p className="small muted">Only items on this list can be ordered from {supplier.name}. Saving replaces the whole list.</p>
      {!list && !detail.isError && <SkeletonLines rows={4} />}
      {list && (
        <div className="stack gap-2">
          {list.map((r, i) => {
            const e = tried ? rowErrors(r) : {};
            return (
              <div className="panel stack gap-2" key={r.stockItemId}>
                <div className="row between top">
                  <span className="stack gap-0">
                    <span className="small strong">{r.label}</span>
                    <span className="xs muted mono">{r.sku}</span>
                  </span>
                  <Button variant="ghost" size="sm" icon="trash-2" onClick={() => edit((rs) => rs.filter((_, j) => j !== i))}>
                    Remove
                    <span className="sr-only"> {r.sku}</span>
                  </Button>
                </div>
                <div className="grid md2 gap-3">
                  <Field label="Unit cost" error={e.unit}>
                    <TextInput id={`pl-unit-${i}`} ctl="sm" prefix="$" inputMode="decimal" value={r.unit} error={!!e.unit} onChange={(ev) => setRow(i, { unit: ev.target.value })} />
                  </Field>
                  <Field label="Supplier SKU" optional>
                    <TextInput id={`pl-ssku-${i}`} ctl="sm" value={r.supplierSku} onChange={(ev) => setRow(i, { supplierSku: ev.target.value })} />
                  </Field>
                  <Field label="Minimum order" optional error={e.moq}>
                    <TextInput id={`pl-moq-${i}`} ctl="sm" inputMode="numeric" suffix="units" value={r.moq} error={!!e.moq} onChange={(ev) => setRow(i, { moq: ev.target.value })} />
                  </Field>
                  <Field label="Lead time" optional hint="Empty uses the supplier's" error={e.lead}>
                    <TextInput id={`pl-lead-${i}`} ctl="sm" inputMode="numeric" suffix="days" value={r.lead} error={!!e.lead} onChange={(ev) => setRow(i, { lead: ev.target.value })} />
                  </Field>
                </div>
                <Checkbox id={`pl-pref-${i}`} label="Preferred supplier for this item (used by reorder suggestions)" checked={r.preferred} onChange={(ev) => setRow(i, { preferred: ev.target.checked })} />
              </div>
            );
          })}
          {list.length === 0 && (
            <EmptyState icon="package" title="No items yet">
              Search Official Store stock below to add what this supplier sells.
            </EmptyState>
          )}
        </div>
      )}
      <div className="stack gap-2">
        <span className="label">Add an item</span>
        <SearchInput id="pl-q" placeholder="Search Official Store SKU or product" value={q} onChange={setQ} />
        {stock.isError && <span className="xs t-danger-text">{errorMessage(stock.error)}</span>}
        {stock.isFetching && <SkeletonLines rows={2} />}
        {q.trim().length >= 2 && stock.isSuccess && results.length === 0 && <span className="xs muted">No Official Store stock matches, or it's already on the list.</span>}
        {results.map((s) => (
          <div className="row between" key={s.id}>
            <span className="stack gap-0">
              <span className="small strong">{s.label}</span>
              <span className="xs muted mono">
                {s.sku}
                {s.unitCost ? ` · average cost ${formatMoney(s.unitCost)}` : ''}
              </span>
            </span>
            <Button variant="secondary" size="sm" icon="plus" onClick={() => add(s)}>
              Add
              <span className="sr-only"> {s.sku}</span>
            </Button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
