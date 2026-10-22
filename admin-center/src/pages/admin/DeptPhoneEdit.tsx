import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { call, errorMessage, uploadMedia, useApi } from '@marketly/web-shared/api';
import { money, parseCents } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Button, Dialog, EmptyState, Field, Icon, IconButton, PageHeader, sameOriginFile, Select, Switch, Textarea, TextInput } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { actorLabel, date, LoadError, SkeletonLines, time } from '@/app/parts';
import { PHONE_STATUS, PHONES_KEY, PHONES_LIST, phoneHref, PhoneTile } from './DeptPhones';
import { codeOf, DeptPage, fieldErrorsOf, newKey, plural, useDragSort, type Money, type PhoneAdmin, type PhoneInput } from './data/departments';

// Admin › Departments › Phones › Add / Edit phone (designed from the Marketly Departments canvas: AdminPhoneEdit; two
// columns like Softwares › Edit app). One page for a new phone (/departments/phones/new) and an existing one.
// API: GET/PATCH/DELETE /api/admin/departments/phones/{id}, POST /phones; the preview photos (Detail tab gallery) and
// the advertisement images (Advertisements tab) are content_image uploads kept
// at full size (at least 1080 px wide, checked here before uploading). Money is typed in dollars and sent in cents.
// Rows, colors, photos and spec groups reorder by dragging their handle, or with the arrow keys on the handle.

type StorageRow = { key: string; size: string; price: string; was: string };
type ColorRow = { key: string; hex: string; name: string; short: string };
type PhotoRow = { key: string; id: string; url: string; width: number | null; height: number | null; alt: string };
type SpecRow = { key: string; name: string; value: string };
type Group = { key: string; name: string; rows: SpecRow[] };
type Draft = { brand: string; name: string; overview: string; storage: StorageRow[]; colors: ColorRow[]; photos: PhotoRow[]; adImages: PhotoRow[]; groups: Group[]; published: boolean; showServices: boolean; position: string; searchTerm: string };
type Patch = Partial<Draft> | ((d: Draft) => Partial<Draft>);
type Errors = Record<string, string>;

const DEFAULT_GROUPS = ['Display', 'Performance', 'Camera', 'Battery', 'Connectivity', 'Build', 'Software'];
const MAX_STORAGE = 8;
const MAX_COLORS = 12;
const MAX_PHOTOS = 20;
const MAX_GROUPS = 20;
const MAX_ROWS = 30;
const OVERVIEW_MAX = 1000;
const MIN_WIDTH = 1080;
const MAX_MB = 15;

/** Cents → the dollars a money field shows: 1,099.99 */
const amountText = (m?: Money | null) => (m ? money(m.amount / 100).slice(1) : '');
const HEX = /^#[0-9a-f]{6}$/i;

const photoRow = (f: PhoneAdmin['photos'][number]): PhotoRow => ({ key: f.id, id: f.id, url: f.thumbUrl ?? f.url, width: f.width ?? null, height: f.height ?? null, alt: f.alt ?? '' });
const draftOf = (p?: PhoneAdmin, count = 0): Draft => ({
  brand: p?.brand ?? '',
  name: p?.name ?? '',
  overview: p?.overview ?? '',
  storage: p ? p.storage.map((s, i) => ({ key: `s${i}`, size: s.size, price: amountText(s.price), was: amountText(s.was) })) : [{ key: 's0', size: '', price: '', was: '' }],
  colors: (p?.colors ?? []).map((c, i) => ({ key: `c${i}`, hex: c.hex.toUpperCase(), name: c.name, short: c.short ?? '' })),
  photos: (p?.photos ?? []).map(photoRow),
  adImages: (p?.adImages ?? []).map(photoRow),
  groups: p ? p.specGroups.map((g, i) => ({ key: `g${i}`, name: g.name, rows: g.rows.map((r, j) => ({ key: `g${i}r${j}`, name: r.name, value: r.value })) })) : DEFAULT_GROUPS.map((name, i) => ({ key: `g${i}`, name, rows: [] })),
  published: p ? p.status === 'published' : true,
  showServices: p?.showServices ?? true,
  position: String(p?.position ?? count + 1),
  searchTerm: p?.searchTerm ?? '',
});
/** A draft without its row keys, to tell whether anything changed */
const sig = (d: Draft) => JSON.stringify(d, (k, v) => (k === 'key' ? undefined : v));

/** What is missing or wrong before saving, by API field path (storage[1].price, colors[0].hex…) */
function problemsOf(d: Draft): Errors {
  const out: Errors = {};
  const put = (path: string, msg: string) => void (out[path] ||= msg);
  if (!d.brand.trim()) put('brand', 'Enter the brand.');
  else if (d.brand.trim().length > 40) put('brand', 'Keep the brand to 40 characters.');
  if (!d.name.trim()) put('name', 'Enter the phone name.');
  else if (d.name.trim().length > 80) put('name', 'Keep the name to 80 characters.');
  if (d.overview.trim().length > OVERVIEW_MAX) put('overview', 'Keep the overview to 1,000 characters.');
  if (!d.storage.length) put('storage', 'Add at least one storage size with a price.');
  d.storage.forEach((s, i) => {
    const price = parseCents(s.price);
    const was = s.was.trim() ? parseCents(s.was) : null;
    if (!s.size.trim()) put(`storage[${i}].size`, 'Enter the storage size, e.g. 256 GB.');
    if (price == null || price <= 0) put(`storage[${i}].price`, 'Enter the price in dollars, e.g. 1,099.99.');
    if (s.was.trim() && (was == null || (price != null && was <= price))) put(`storage[${i}].was`, 'The was price must be above the price.');
  });
  d.colors.forEach((c, i) => {
    if (!HEX.test(c.hex.trim())) put(`colors[${i}].hex`, 'Enter the swatch color like #8C918F.');
    if (!c.name.trim()) put(`colors[${i}].name`, 'Enter the full color name.');
  });
  if (!d.photos.length) put('photos', 'Add at least one preview photo.');
  d.groups.forEach((g, i) => {
    if (!g.name.trim() && g.rows.some((r) => r.name.trim() && r.value.trim())) put(`specGroups[${i}].name`, 'Name the group.');
  });
  if (d.searchTerm.trim().length > 80) put('searchTerm', 'Keep it to 80 characters.');
  return out;
}
/** API issue paths (storage.1.price or storage[1].price) → the form's paths */
const pathOf = (p: string) => p.replace(/\.(\d+)(?=\.|\[|$)/g, '[$1]');

export default function DeptPhoneEdit() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const { api } = useApi();
  const { can } = useStaffSession();
  const canView = can('departments.view');
  const canManage = can('departments.phones.manage');
  const phone = useQuery({ queryKey: ['departments', 'phone', id], enabled: canView && !isNew, queryFn: () => call(api.GET('/api/admin/departments/phones/{id}', { params: { path: { id } } })) });
  const list = useQuery({ queryKey: PHONES_KEY, enabled: canView, queryFn: () => call(api.GET('/api/admin/departments/phones')) });
  const crumbs = [{ label: 'Admin' }, { label: 'Departments' }, { label: 'Phones', to: PHONES_LIST }];
  const title = isNew ? 'Add phone' : 'Edit phone';

  return (
    <DeptPage active="dept-phones" title={title} canView={canView}>
      {(isNew && !list.isPending) || phone.data ? (
        <PhoneEditor key={phone.data?.id ?? 'new'} phone={phone.data} count={list.data?.items.length ?? 0} canManage={canManage} />
      ) : phone.isError ? (
        <>
          <PageHeader crumbs={crumbs} title={title} />
          {codeOf(phone.error) === 'NOT_FOUND' ? (
            <section className="card">
              <div className="card-body">
                <EmptyState icon="smartphone" title="This phone doesn’t exist" as="h2" action={<Button to={PHONES_LIST}>Back to Phones</Button>}>
                  It may have been deleted.
                </EmptyState>
              </div>
            </section>
          ) : (
            <LoadError error={phone.error} onRetry={() => void phone.refetch()} />
          )}
        </>
      ) : (
        <>
          <PageHeader crumbs={crumbs} title={title} />
          <SkeletonLines rows={10} />
        </>
      )}
    </DeptPage>
  );
}

function PhoneEditor({ phone, count, canManage }: { phone?: PhoneAdmin; count: number; canManage: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // the notice of a just-added phone survives the switch from /phones/new to the phone's own address
  const added = (useLocation().state as { notice?: string } | null)?.notice ?? '';
  const base = useMemo(() => draftOf(phone, count), [phone, count]);
  const baseRef = useRef(base);
  baseRef.current = base;
  const [draft, setDraft] = useState<Draft | null>(null);
  const d = draft ?? base;
  const dirty = draft !== null && sig(draft) !== sig(base);
  const setD = (patch: Patch) =>
    setDraft((cur) => {
      const c = cur ?? baseRef.current;
      return { ...c, ...(typeof patch === 'function' ? patch(c) : patch) };
    });
  // groups shown closed: an existing phone opens with its first group expanded
  const [closed, setClosed] = useState(() => new Set(phone ? base.groups.slice(1).map((g) => g.key) : []));
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<Errors>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(added);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const client = tried ? problemsOf(d) : {};
  const err = (path: string) => client[path] || server[path] || '';
  const firstProblem = Object.values(client).find(Boolean) || '';
  const disabled = !canManage;
  const currency = phone?.storage[0]?.price.currency ?? 'USD';
  const toMoney = (text: string): Money | null => {
    const c = parseCents(text);
    return c == null ? null : { amount: c, currency };
  };

  const save = useMutation({
    mutationFn: (x: Draft) => {
      const body: PhoneInput = {
        brand: x.brand.trim(),
        name: x.name.trim(),
        overview: x.overview.trim() || null,
        storage: x.storage.map((s) => ({ size: s.size.trim(), price: toMoney(s.price)!, was: s.was.trim() ? toMoney(s.was) : null })),
        colors: x.colors.map((c) => ({ hex: c.hex.trim().toUpperCase(), name: c.name.trim(), short: c.short.trim() || null })),
        photos: x.photos.map((f) => ({ id: f.id, alt: f.alt.trim() || null })),
        adImages: x.adImages.map((f) => ({ id: f.id, alt: f.alt.trim() || null })),
        // rows with an empty name or value, then empty groups, are left out by the API
        specGroups: x.groups.map((g) => ({ name: g.name.trim(), rows: g.rows.map((r) => ({ name: r.name.trim(), value: r.value.trim() })) })),
        showServices: x.showServices,
        searchTerm: x.searchTerm.trim() || null,
        status: x.published ? 'published' : 'hidden',
        position: Number(x.position) || null,
      };
      return phone ? call(api.PATCH('/api/admin/departments/phones/{id}', { params: { path: { id: phone.id } }, body })) : call(api.POST('/api/admin/departments/phones', { body }));
    },
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: PHONES_KEY });
      qc.setQueryData(['departments', 'phone', p.id], p);
      const msg = phone ? `${p.name} saved${p.status === 'published' ? ': the Phone tab shows the changes now' : ' (hidden from the Phone tab)'}` : `${p.name} added${p.status === 'published' ? ' to the Phone tab' : ' as hidden'}`;
      announce(msg);
      setDraft(null);
      setTried(false);
      setServer({});
      setError('');
      if (phone) setNotice(msg);
      else navigate(phoneHref(p.id), { replace: true, state: { notice: msg } });
    },
    onError: (e) => {
      const fe = fieldErrorsOf(e);
      const mapped: Errors = {};
      // storage[1].price.amount marks the storage[1].price field
      Object.entries(fe).forEach(([path, msg]) => (mapped[path === 'slug' ? 'name' : pathOf(path).replace(/\.(amount|currency)$/, '')] ||= msg));
      setServer(mapped);
      setNotice('');
      setError(codeOf(e) === 'SLUG_TAKEN' ? 'Another phone already has this name’s web address. Change the name.' : Object.keys(fe).length ? 'Fix the fields marked below.' : errorMessage(e));
    },
  });
  const remove = useMutation({
    mutationFn: () => call(api.DELETE('/api/admin/departments/phones/{id}', { params: { path: { id: phone!.id } } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PHONES_KEY });
      const msg = `${phone!.name} deleted`;
      announce(msg);
      navigate(PHONES_LIST, { state: { notice: msg } });
    },
    onError: (e) => {
      setConfirmDelete(false);
      setError(errorMessage(e));
    },
  });
  const submit = () => {
    setTried(true);
    setNotice('');
    if (Object.values(problemsOf(d)).some(Boolean)) {
      setError('');
      return;
    }
    save.mutate(d);
  };

  const total = phone ? Math.max(count, phone.position) : count + 1;
  const places = Array.from({ length: Math.max(total, 1) }, (_, i) => String(i + 1));
  const first = d.storage[0];
  const price = first ? toMoney(first.price) : null;
  const was = first?.was.trim() ? toMoney(first.was) : null;
  const status = d.published ? 'published' : 'hidden';
  const groups = useDragSort({
    keys: d.groups.map((g) => g.key),
    disabled,
    onSort: (keys, moved) => {
      setD((x) => ({ groups: keys.map((k) => x.groups.find((g) => g.key === k)!) }));
      announce(`Group ${d.groups.find((g) => g.key === moved)?.name || ''} moved to place ${keys.indexOf(moved) + 1}`);
    },
  });
  const shownGroups = groups.order.map((k) => d.groups.find((g) => g.key === k)).filter((g): g is Group => !!g);

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Admin' }, { label: 'Departments' }, { label: 'Phones', to: PHONES_LIST }]}
        title={phone ? `Edit phone: ${phone.name}` : 'Add phone'}
        sub={phone ? `${PHONE_STATUS[phone.status].label} · last saved ${date(phone.updatedAt)}, ${time(phone.updatedAt)}${phone.updatedBy ? ` by ${actorLabel(phone.updatedBy)}` : ''}${canManage ? '' : ' · view only'}` : 'A new phone: add its storage sizes, colors, photos and spec sheet, then save it'}
        actions={
          phone && (
            <a className="btn btn-secondary btn-sm" href={href('store/search', '', undefined, { q: phone.searchTerm || phone.name })} target="_blank" rel="noreferrer" title="Opens the store search the app’s Find in store button opens">
              <Icon name="eye" />
              <span>View in store</span>
            </a>
          )
        }
      />
      {notice && <Alert tone="success" title={notice} />}
      {(error || firstProblem) && (
        <Alert tone="danger" title={phone ? 'The phone wasn’t saved' : 'The phone wasn’t added'}>
          {error || firstProblem}
        </Alert>
      )}
      <div className="ab-main">
        <fieldset className="stack gap-5" disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <section className="card">
            <div className="card-head">
              <h2 className="h4">Basics</h2>
            </div>
            <div className="card-body stack gap-4">
              <div className="grid gap-4" style={{ gridTemplateColumns: '220px minmax(0, 1fr)' }}>
                <Field label="Brand" error={err('brand')}>
                  <TextInput id="p-brand" value={d.brand} maxLength={40} error={!!err('brand')} onChange={(e) => setD({ brand: e.target.value })} />
                </Field>
                <Field label="Phone name" error={err('name')}>
                  <TextInput id="p-name" value={d.name} maxLength={80} error={!!err('name')} onChange={(e) => setD({ name: e.target.value })} />
                </Field>
              </div>
              <Field label="Overview" hint="Shown under the options on the Detail tab · 1,000 characters at most" error={err('overview')}>
                <Textarea id="p-over" rows={3} value={d.overview} maxLength={OVERVIEW_MAX} onChange={(e) => setD({ overview: e.target.value })} />
              </Field>
            </div>
          </section>

          <StorageCard rows={d.storage} err={err} disabled={disabled} onChange={(f) => setD((x) => ({ storage: f(x.storage) }))} />
          <ColorsCard rows={d.colors} err={err} disabled={disabled} onChange={(f) => setD((x) => ({ colors: f(x.colors) }))} />
          <PhotosCard kind="photos" photos={d.photos} name={d.name.trim()} err={err} disabled={disabled} onChange={(f) => setD((x) => ({ photos: f(x.photos) }))} />
          <PhotosCard kind="adImages" photos={d.adImages} name={d.name.trim()} err={err} disabled={disabled} onChange={(f) => setD((x) => ({ adImages: f(x.adImages) }))} />

          <section className="card">
            <div className="card-head" style={{ flexWrap: 'nowrap' }}>
              <div className="stack gap-0 grow">
                <h2 className="h4">Specifications</h2>
                <span className="xs muted">The spec sheet on the Detail tab, by group · drag groups and rows to reorder · empty rows are left out</span>
              </div>
              {!disabled && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon="plus"
                  disabled={d.groups.length >= MAX_GROUPS}
                  onClick={() => {
                    const key = newKey();
                    setD((x) => ({ groups: [...x.groups, { key, name: '', rows: [{ key: newKey(), name: '', value: '' }] }] }));
                    requestAnimationFrame(() => document.getElementById(`g-${key}`)?.focus());
                  }}
                >
                  Add group
                </Button>
              )}
            </div>
            <div className="card-body" style={{ gap: 12 }}>
              {shownGroups.map((g) => {
                const i = d.groups.indexOf(g);
                return (
                  <SpecGroupBox
                    key={g.key}
                    group={g}
                    index={i}
                    open={!closed.has(g.key)}
                    dragging={groups.dragged === g.key}
                    itemRef={groups.item(g.key)}
                    handle={groups.handle(g.key)}
                    err={err}
                    disabled={disabled}
                    onToggle={() => setClosed((s) => (s.has(g.key) ? new Set([...s].filter((k) => k !== g.key)) : new Set([...s, g.key])))}
                    onRemove={() => {
                      setD((x) => ({ groups: x.groups.filter((y) => y.key !== g.key) }));
                      announce(`Group ${g.name || i + 1} removed`);
                    }}
                    onChange={(f) => setD((x) => ({ groups: x.groups.map((y) => (y.key === g.key ? { ...y, ...f(y) } : y)) }))}
                  />
                );
              })}
              {d.groups.length === 0 && <span className="small muted">No spec groups. {disabled ? '' : 'Add a group, e.g. Display or Camera.'}</span>}
            </div>
          </section>
        </fieldset>

        <div className="stack gap-5">
          <section className="card">
            <div className="card-head">
              <h2 className="h4">Status and visibility</h2>
            </div>
            <fieldset className="card-body stack" disabled={disabled} style={{ border: 0, margin: 0, gap: 14 }}>
              <Switch id="p-pub" label="Show on the Phone tab" checked={d.published} onChange={(e) => setD({ published: e.target.checked })} />
              <Switch id="p-svc" label="Show the free OS install and post-sale card" checked={d.showServices} onChange={(e) => setD({ showServices: e.target.checked })} />
              <Field label="Place on the Phone tab" error={err('position')}>
                <Select id="p-pos" value={d.position} options={places.map((v, i) => ({ value: v, label: `${v} of ${places.length}${i === 0 ? ' (first)' : i === places.length - 1 ? ' (last)' : ''}` }))} onChange={(e) => setD({ position: e.target.value })} />
              </Field>
              <Field label="Find in store searches for" optional hint="Empty: the phone name" error={err('searchTerm')}>
                <TextInput id="p-find" value={d.searchTerm} maxLength={80} placeholder={d.name.trim()} error={!!err('searchTerm')} onChange={(e) => setD({ searchTerm: e.target.value })} />
              </Field>
            </fieldset>
            {canManage && (
              <div className="card-foot" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                <Button size="sm" block onClick={submit} disabled={save.isPending || remove.isPending || (!!phone && !dirty)}>
                  {save.isPending ? 'Saving…' : phone ? 'Save changes' : 'Add phone'}
                </Button>
                <Button variant="secondary" size="sm" block to={PHONES_LIST}>
                  Cancel
                </Button>
                <span className="xs muted">Saving updates the Phone tab right away. A phone needs a name, one storage size with a price and one photo.</span>
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h2 className="h4">Preview</h2>
                <span className="xs muted">How the Phone tab shows it</span>
              </div>
            </div>
            <div className="card-body">
              <PhoneTile name={d.name.trim() || 'Phone name'} meta={[first?.size.trim(), d.colors[0]?.name.trim()].filter(Boolean).join(' · ')} cover={d.photos[0]?.url} price={price} was={was} />
              {status === 'hidden' && <span className="xs muted">Hidden: the Phone tab leaves it out until “Show on the Phone tab” is on.</span>}
            </div>
          </section>

          {phone && canManage && (
            <section className="card">
              <div className="card-body" style={{ gap: 10 }}>
                <Button variant="danger-soft" size="sm" block icon="trash" onClick={() => setConfirmDelete(true)} disabled={save.isPending || remove.isPending}>
                  Delete phone
                </Button>
                <span className="xs muted">Removes the phone and its photos from the Phone tab. Shared links to it show “This phone is no longer listed”.</span>
              </div>
            </section>
          )}
        </div>
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${phone?.name ?? 'phone'}?`}
        foot={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
              {remove.isPending ? 'Deleting…' : 'Delete phone'}
            </Button>
          </>
        }
      >
        <p className="small" style={{ margin: 0 }}>
          The phone and its photos are removed from the Phone tab for good. Shared links to it show “This phone is no longer listed”.
        </p>
      </Dialog>
    </>
  );
}

/* ---------------- Shared bits ---------------- */

type ListChange<T> = (f: (rows: T[]) => T[]) => void;
type Handle = ReturnType<ReturnType<typeof useDragSort>['handle']>;

/** The drag handle of a row: a button (arrow keys move it) that starts a pointer drag */
function DragHandle({ label, handle, disabled }: { label: string; handle: Handle; disabled: boolean }) {
  if (disabled) {
    return (
      <span className="muted" style={{ display: 'inline-flex' }}>
        <Icon name="grip-vertical" className="ic-sm" />
      </span>
    );
  }
  return (
    <button type="button" className="icon-btn sm" aria-label={label} title="Drag, or use the arrow keys, to move" {...handle} style={{ ...handle.style, width: 24, height: 30, color: 'var(--text-3)' }}>
      <Icon name="grip-vertical" className="ic-sm" />
    </button>
  );
}

/** A row's error messages under its fields */
function RowErrors({ messages, column = '2 / -1' }: { messages: string[]; column?: string }) {
  const list = [...new Set(messages.filter(Boolean))];
  if (!list.length) return null;
  return (
    <span className="error-text" style={{ gridColumn: column }}>
      <Icon name="circle-alert" className="ic-sm" />
      {list.join(' ')}
    </span>
  );
}

const reorder = <T extends { key: string }>(rows: T[], keys: string[]) => keys.map((k) => rows.find((r) => r.key === k)).filter((r): r is T => !!r);

/* ---------------- Storage and price ---------------- */

const STORAGE_COLS = '24px minmax(0, 1fr) 180px 180px 34px';

function StorageCard({ rows, err, disabled, onChange }: { rows: StorageRow[]; err: (p: string) => string; disabled: boolean; onChange: ListChange<StorageRow> }) {
  const sort = useDragSort({
    keys: rows.map((r) => r.key),
    disabled,
    onSort: (keys, moved) => {
      onChange((x) => reorder(x, keys));
      announce(`${rows.find((r) => r.key === moved)?.size || 'Storage size'} moved to place ${keys.indexOf(moved) + 1}`);
    },
  });
  const set = (key: string, patch: Partial<StorageRow>) => onChange((x) => x.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <section className="card">
      <div className="card-head">
        <div className="stack gap-0">
          <h2 className="h4">Storage and price</h2>
          <span className="xs muted">One row per storage size · the first row is selected when the page opens</span>
        </div>
      </div>
      <div className="card-body" style={{ gap: 12 }}>
        <div className="stack" style={{ gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: STORAGE_COLS, gap: '8px 12px', alignItems: 'center' }}>
            <span />
            <span className="label">Storage</span>
            <span className="label">Price</span>
            <span className="label">
              Was price <span className="opt">(optional)</span>
            </span>
            <span />
          </div>
          {sort.order.map((key) => {
            const r = rows.find((x) => x.key === key);
            if (!r) return null;
            const i = rows.indexOf(r);
            const name = r.size.trim() || `storage size ${i + 1}`;
            const e = { size: err(`storage[${i}].size`), price: err(`storage[${i}].price`), was: err(`storage[${i}].was`), row: err(`storage[${i}]`) };
            return (
              <div key={key} ref={sort.item(key)} style={{ display: 'grid', gridTemplateColumns: STORAGE_COLS, gap: '8px 12px', alignItems: 'center', opacity: sort.dragged === key ? 0.6 : 1 }}>
                <DragHandle label={`Move ${name}`} handle={sort.handle(key)} disabled={disabled} />
                <TextInput id={`st-${key}-size`} aria-label={`Storage ${i + 1}`} placeholder="e.g. 256 GB" value={r.size} error={!!e.size} onChange={(ev) => set(key, { size: ev.target.value })} />
                <TextInput id={`st-${key}-price`} aria-label={`Price of ${name}`} inputMode="decimal" prefix="$" value={r.price} error={!!e.price} onChange={(ev) => set(key, { price: ev.target.value })} />
                <TextInput id={`st-${key}-was`} aria-label={`Was price of ${name}`} inputMode="decimal" prefix="$" value={r.was} error={!!e.was} onChange={(ev) => set(key, { was: ev.target.value })} />
                {disabled ? <span /> : <IconButton icon="x" size="sm" label={`Remove ${name}`} onClick={() => onChange((x) => x.filter((y) => y.key !== key))} />}
                <RowErrors messages={[e.size, e.price, e.was, e.row]} column="2 / 5" />
              </div>
            );
          })}
        </div>
        {err('storage') && <span className="xs t-danger-text">{err('storage')}</span>}
        {!disabled && (
          <Button variant="soft" size="sm" icon="plus" style={{ alignSelf: 'flex-start' }} disabled={rows.length >= MAX_STORAGE} onClick={() => onChange((x) => [...x, { key: newKey(), size: '', price: '', was: '' }])}>
            Add storage size
          </Button>
        )}
        <span className="hint">A was price shows crossed out with “Save $200” and a −15% badge on the photo.</span>
      </div>
    </section>
  );
}

/* ---------------- Colors ---------------- */

const COLOR_COLS = '24px 120px minmax(0, 1fr) 160px 34px';

function ColorsCard({ rows, err, disabled, onChange }: { rows: ColorRow[]; err: (p: string) => string; disabled: boolean; onChange: ListChange<ColorRow> }) {
  const sort = useDragSort({
    keys: rows.map((r) => r.key),
    disabled,
    onSort: (keys, moved) => {
      onChange((x) => reorder(x, keys));
      announce(`${rows.find((r) => r.key === moved)?.name || 'Color'} moved to place ${keys.indexOf(moved) + 1}`);
    },
  });
  const set = (key: string, patch: Partial<ColorRow>) => onChange((x) => x.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <section className="card">
      <div className="card-head">
        <div className="stack gap-0">
          <h2 className="h4">Colors</h2>
          <span className="xs muted">The short name shows under the swatch; the full name in the title line</span>
        </div>
      </div>
      <div className="card-body" style={{ gap: 12 }}>
        {rows.length > 0 && (
          <div className="stack" style={{ gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: COLOR_COLS, gap: '8px 12px', alignItems: 'center' }}>
              <span />
              <span className="label">Swatch</span>
              <span className="label">Full name</span>
              <span className="label">Short name</span>
              <span />
            </div>
            {sort.order.map((key) => {
              const c = rows.find((x) => x.key === key);
              if (!c) return null;
              const i = rows.indexOf(c);
              const name = c.name.trim() || `color ${i + 1}`;
              const e = { hex: err(`colors[${i}].hex`), name: err(`colors[${i}].name`), short: err(`colors[${i}].short`), row: err(`colors[${i}]`) };
              const valid = HEX.test(c.hex.trim());
              return (
                <div key={key} ref={sort.item(key)} style={{ display: 'grid', gridTemplateColumns: COLOR_COLS, gap: '8px 12px', alignItems: 'center', opacity: sort.dragged === key ? 0.6 : 1 }}>
                  <DragHandle label={`Move ${name}`} handle={sort.handle(key)} disabled={disabled} />
                  <span className="input-group" style={{ padding: '0 8px 0 6px', ...(e.hex ? { borderColor: 'var(--danger)' } : {}) }}>
                    <span style={{ position: 'relative', width: 28, height: 28, borderRadius: 6, flex: 'none', background: valid ? c.hex.trim() : 'var(--surface-2)', boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, .08)' }}>
                      <input type="color" aria-label={`Pick the swatch color of ${name}`} value={valid ? c.hex.trim().toLowerCase() : '#000000'} onChange={(ev) => set(key, { hex: ev.target.value.toUpperCase() })} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, border: 0, padding: 0, cursor: disabled ? undefined : 'pointer' }} />
                    </span>
                    <input className="input" id={`co-${key}-hex`} aria-label={`Swatch color of ${name}`} aria-invalid={!!e.hex || undefined} value={c.hex} placeholder="#000000" maxLength={7} style={{ fontSize: 13 }} onChange={(ev) => set(key, { hex: ev.target.value })} />
                  </span>
                  <TextInput id={`co-${key}-name`} aria-label={`Full name of color ${i + 1}`} placeholder="e.g. Titanium Gray" value={c.name} error={!!e.name} onChange={(ev) => set(key, { name: ev.target.value })} />
                  <TextInput id={`co-${key}-short`} aria-label={`Short name of ${name}`} placeholder={c.name.trim() || 'e.g. Gray'} value={c.short} error={!!e.short} onChange={(ev) => set(key, { short: ev.target.value })} />
                  {disabled ? <span /> : <IconButton icon="x" size="sm" label={`Remove ${name}`} onClick={() => onChange((x) => x.filter((y) => y.key !== key))} />}
                  <RowErrors messages={[e.hex, e.name, e.short, e.row]} column="2 / 5" />
                </div>
              );
            })}
          </div>
        )}
        {rows.length === 0 && disabled && <span className="small muted">No colors.</span>}
        {err('colors') && <span className="xs t-danger-text">{err('colors')}</span>}
        {!disabled && (
          <Button variant="soft" size="sm" icon="plus" style={{ alignSelf: 'flex-start' }} disabled={rows.length >= MAX_COLORS} onClick={() => onChange((x) => [...x, { key: newKey(), hex: '#8C918F', name: '', short: '' }])}>
            Add color
          </Button>
        )}
      </div>
    </section>
  );
}

/* ---------------- Photos ---------------- */

/** A picture's pixel size, read in the browser before uploading (null when it can't be read) */
const pixelsOf = (file: File) =>
  new Promise<{ width: number; height: number } | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => (resolve({ width: img.naturalWidth, height: img.naturalHeight }), URL.revokeObjectURL(url));
    img.onerror = () => (resolve(null), URL.revokeObjectURL(url));
    img.src = url;
  });

/** The two picture lists: preview photos (the Detail tab gallery, first = cover) and advertisement images (the Advertisements tab) */
type PhotoKind = 'photos' | 'adImages';
const PHOTO_COPY: Record<PhotoKind, { title: string; sub: string; drop: string; hint: string; noun: string; Noun: string; none: string; cover: boolean }> = {
  photos: {
    title: 'Preview photos',
    sub: 'The gallery on the Detail tab, shown cropped square · drag to reorder · the first is the cover on the Phone tab',
    drop: 'Drop photos here or',
    hint: 'The description is read out by screen readers. A tap on the Detail tab opens the photo full screen.',
    noun: 'photo',
    Noun: 'Photo',
    none: 'No preview photos.',
    cover: true,
  },
  adImages: {
    title: 'Advertisements',
    sub: 'Full-size images for the Advertisements tab, shown edge to edge in this order · drag to reorder · optional: without any, the tab is not shown',
    drop: 'Drop advertisement images here or',
    hint: 'The description is read out by screen readers. Images keep their own shape on the Advertisements tab, one under another.',
    noun: 'advertisement',
    Noun: 'Advertisement',
    none: 'No advertisement images: the app leaves out the Advertisements tab.',
    cover: false,
  },
};

function PhotosCard({ kind, photos, name, err, disabled, onChange }: { kind: PhotoKind; photos: PhotoRow[]; name: string; err: (p: string) => string; disabled: boolean; onChange: ListChange<PhotoRow> }) {
  const copy = PHOTO_COPY[kind];
  const { session } = useApi();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const sort = useDragSort({
    keys: photos.map((p) => p.key),
    grid: true,
    disabled,
    onSort: (keys, moved) => {
      onChange((x) => reorder(x, keys));
      announce(`${copy.Noun} ${photos.findIndex((p) => p.key === moved) + 1} moved to place ${keys.indexOf(moved) + 1}${copy.cover && keys.indexOf(moved) === 0 ? ': the cover' : ''}`);
    },
  });
  const add = async (files: File[]) => {
    const problems: string[] = [];
    let room = MAX_PHOTOS - photos.length - uploading;
    const take: Array<{ file: File; width: number; height: number }> = [];
    for (const file of files) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
        problems.push(`${file.name}: only JPG, PNG or WebP images can be added.`);
        continue;
      }
      if (file.size > MAX_MB * 1024 * 1024) {
        problems.push(`${file.name} is over ${MAX_MB} MB.`);
        continue;
      }
      const px = await pixelsOf(file);
      if (!px) {
        problems.push(`${file.name} couldn’t be read as a picture.`);
        continue;
      }
      if (px.width < MIN_WIDTH) {
        problems.push(`${file.name} is ${px.width} px wide: images need to be at least ${MIN_WIDTH} px wide.`);
        continue;
      }
      if (room <= 0) {
        problems.push(`Up to ${MAX_PHOTOS} ${copy.noun}s: ${file.name} was left out.`);
        continue;
      }
      room -= 1;
      take.push({ file, ...px });
    }
    setErrors(problems);
    take.forEach(({ file, width, height }) => {
      setUploading((n) => n + 1);
      uploadMedia(session, file, 'content_image', name ? { alt: name } : {})
        .then((asset) => {
          const shown = asset.renditions.find((r) => r.size === 'small') ?? asset.renditions.find((r) => r.size === 'thumb') ?? asset.renditions[0];
          const url = new URL(shown?.url || asset.url || '', window.location.origin).href;
          onChange((x) => (x.length >= MAX_PHOTOS ? x : [...x, { key: asset.id, id: asset.id, url, width: asset.width ?? width, height: asset.height ?? height, alt: '' }]));
          announce(`${file.name} uploaded`);
        })
        .catch((e) => setErrors((l) => [...l, `${file.name}: ${errorMessage(e)}`]))
        .finally(() => setUploading((n) => n - 1));
    });
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    if (!disabled && e.dataTransfer.files.length) void add([...e.dataTransfer.files]);
  };
  const startDrag = (e: ReactPointerEvent, key: string) => {
    // the remove button and the description field keep their own pointer behaviour
    if ((e.target as HTMLElement).closest('button, input')) return;
    sort.start(e, key);
  };
  const set = (key: string, patch: Partial<PhotoRow>) => onChange((x) => x.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <section className="card">
      <div className="card-head" style={{ flexWrap: 'nowrap' }}>
        <div className="stack gap-0 grow">
          <h2 className="h4">{copy.title}</h2>
          <span className="xs muted">{copy.sub}</span>
        </div>
        <span className="xs muted nowrap">
          {photos.length} of {MAX_PHOTOS}
        </span>
      </div>
      <div className="card-body" style={{ gap: 16 }}>
        {!disabled && photos.length + uploading < MAX_PHOTOS && (
          <div className="dropzone" onDragOver={(e) => e.preventDefault()} onDrop={drop}>
            <Icon name="upload" className="ic-lg" />
            <span>
              {copy.drop}{' '}
              <button type="button" className="strong" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--brand-text)', font: 'inherit' }} onClick={() => input.current?.click()}>
                browse
              </button>
            </span>
            <span className="xs">JPG, PNG or WebP · at least {MIN_WIDTH} px wide · {MAX_MB} MB each · kept at full size</span>
          </div>
        )}
        {errors.map((m, i) => (
          <span key={i} className="xs t-danger-text">
            {m}
          </span>
        ))}
        {err(kind) && <span className="xs t-danger-text">{err(kind)}</span>}
        {(photos.length > 0 || uploading > 0) && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
            {sort.order.map((key, n) => {
              const p = photos.find((x) => x.key === key);
              if (!p) return null;
              const i = photos.indexOf(p);
              const h = sort.handle(key);
              const e = err(`${kind}[${i}]`) || err(`${kind}[${i}].id`) || err(`${kind}[${i}].alt`);
              return (
                <div key={key} ref={sort.item(key)} style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, opacity: sort.dragged === key ? 0.6 : 1 }}>
                  <div onPointerDown={(ev) => startDrag(ev, key)} style={{ position: 'relative', height: 200, borderRadius: 10, border: `1px solid ${e ? 'var(--danger)' : 'var(--border)'}`, background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', cursor: disabled ? undefined : 'grab', touchAction: 'none' }}>
                    <img src={sameOriginFile(p.url)} alt={p.alt || `${copy.Noun} ${n + 1}`} draggable={false} style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }} />
                    {disabled ? (
                      <span style={{ position: 'absolute', left: 8, top: 8 }}>
                        <Badge tone="solid">{n + 1}</Badge>
                      </span>
                    ) : (
                      <button type="button" className="badge t-solid" aria-label={`Move ${copy.noun} ${n + 1}${copy.cover && n === 0 ? ', the cover' : ''}`} title="Drag, or use the arrow keys, to move" {...h} style={{ ...h.style, position: 'absolute', left: 8, top: 8, border: 0 }}>
                        {n + 1}
                      </button>
                    )}
                    {copy.cover && n === 0 && (
                      <span style={{ position: 'absolute', left: 36, top: 8 }}>
                        <Badge tone="brand">Cover</Badge>
                      </span>
                    )}
                    {!disabled && (
                      <span style={{ position: 'absolute', right: 6, top: 6, background: 'var(--surface)', borderRadius: 6 }}>
                        <IconButton icon="trash" size="sm" label={`Remove ${copy.noun} ${n + 1}`} onClick={() => onChange((x) => x.filter((y) => y.key !== key))} />
                      </span>
                    )}
                    {p.width && p.height && (
                      <span className="xs" style={{ position: 'absolute', left: 8, bottom: 8, padding: '2px 6px', borderRadius: 6, background: 'rgba(19, 32, 28, .72)', color: '#FFFFFF' }}>
                        {p.width} × {p.height}
                      </span>
                    )}
                  </div>
                  <input className="input" aria-label={`Description of ${copy.noun} ${n + 1}`} placeholder={kind === 'photos' ? 'Describe the photo' : 'Describe the image'} value={p.alt} maxLength={200} style={{ minHeight: 36, height: 36, fontSize: 13 }} onChange={(ev) => set(key, { alt: ev.target.value })} />
                  {e && <span className="xs t-danger-text">{e}</span>}
                </div>
              );
            })}
            {Array.from({ length: uploading }, (_, i) => (
              <div key={`up-${i}`} role="status" style={{ height: 200, borderRadius: 10, border: '1px dashed var(--border-strong)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="xs muted">Uploading…</span>
              </div>
            ))}
          </div>
        )}
        {photos.length === 0 && disabled && <span className="small muted">{copy.none}</span>}
        <span className="hint">{copy.hint}</span>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => (void add([...(e.target.files ?? [])]), (e.target.value = ''))} />
      </div>
    </section>
  );
}

/* ---------------- Specifications ---------------- */

const SPEC_COLS = '24px 200px minmax(0, 1fr) 34px';

function SpecGroupBox({ group, index, open, dragging, itemRef, handle, err, disabled, onToggle, onRemove, onChange }: { group: Group; index: number; open: boolean; dragging: boolean; itemRef: (el: HTMLElement | null) => void; handle: Handle; err: (p: string) => string; disabled: boolean; onToggle: () => void; onRemove: () => void; onChange: (f: (g: Group) => Partial<Group>) => void }) {
  const name = group.name.trim() || `group ${index + 1}`;
  const sort = useDragSort({
    keys: group.rows.map((r) => r.key),
    disabled,
    onSort: (keys, moved) => {
      onChange((g) => ({ rows: reorder(g.rows, keys) }));
      announce(`${group.rows.find((r) => r.key === moved)?.name || 'Row'} moved to place ${keys.indexOf(moved) + 1}`);
    },
  });
  const setRow = (key: string, patch: Partial<SpecRow>) => onChange((g) => ({ rows: g.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const nameErr = err(`specGroups[${index}].name`);
  const groupErr = err(`specGroups[${index}]`) || err(`specGroups[${index}].rows`);
  return (
    <div ref={itemRef} style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', opacity: dragging ? 0.6 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px 8px 12px', background: 'var(--surface-2)' }}>
        <DragHandle label={`Move group ${name}`} handle={handle} disabled={disabled} />
        <input className={nameErr ? 'input is-error' : 'input'} id={`g-${group.key}`} aria-label="Group name" aria-invalid={!!nameErr || undefined} placeholder="e.g. Display" value={group.name} maxLength={40} style={{ width: 240, minHeight: 36, height: 36, fontSize: 13, fontWeight: 600 }} onChange={(e) => onChange(() => ({ name: e.target.value }))} />
        {nameErr && <span className="xs t-danger-text">{nameErr}</span>}
        <span className="xs muted" style={{ marginLeft: 'auto' }}>
          {plural(group.rows.length, 'row')}
        </span>
        {!disabled && <IconButton icon="trash" size="sm" label={`Remove group ${name}`} onClick={onRemove} />}
        <button type="button" className="icon-btn sm" aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`} aria-expanded={open} onClick={onToggle}>
          <Icon name="chevron-down" className="ic-sm" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
        </button>
      </div>
      {open && (
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sort.order.map((key) => {
            const r = group.rows.find((x) => x.key === key);
            if (!r) return null;
            const j = group.rows.indexOf(r);
            const label = r.name.trim() || `row ${j + 1}`;
            const e = [err(`specGroups[${index}].rows[${j}].name`), err(`specGroups[${index}].rows[${j}].value`), err(`specGroups[${index}].rows[${j}]`)];
            return (
              <div key={key} ref={sort.item(key)} style={{ display: 'grid', gridTemplateColumns: SPEC_COLS, gap: '8px 12px', alignItems: 'center', opacity: sort.dragged === key ? 0.6 : 1 }}>
                <DragHandle label={`Move ${label}`} handle={sort.handle(key)} disabled={disabled} />
                <input className={e[0] ? 'input is-error' : 'input'} aria-label={`Spec name, ${name} row ${j + 1}`} aria-invalid={!!e[0] || undefined} placeholder="e.g. Refresh rate" value={r.name} maxLength={60} style={{ minHeight: 40, height: 40, fontSize: 13 }} onChange={(ev) => setRow(key, { name: ev.target.value })} />
                <input className={e[1] ? 'input is-error' : 'input'} aria-label={`Value of ${label}`} aria-invalid={!!e[1] || undefined} placeholder="e.g. 1–120 Hz" value={r.value} maxLength={200} style={{ minHeight: 40, height: 40, fontSize: 13 }} onChange={(ev) => setRow(key, { value: ev.target.value })} />
                {disabled ? <span /> : <IconButton icon="x" size="sm" label={`Remove ${label}`} onClick={() => onChange((g) => ({ rows: g.rows.filter((y) => y.key !== key) }))} />}
                <RowErrors messages={e} column="2 / 4" />
              </div>
            );
          })}
          {groupErr && <span className="xs t-danger-text">{groupErr}</span>}
          {group.rows.length === 0 && disabled && <span className="small muted">No rows.</span>}
          {!disabled && (
            <div style={{ display: 'grid', gridTemplateColumns: SPEC_COLS, gap: '8px 12px' }}>
              <span />
              <Button
                variant="ghost"
                size="sm"
                icon="plus"
                disabled={group.rows.length >= MAX_ROWS}
                onClick={() => {
                  const key = newKey();
                  onChange((g) => ({ rows: [...g.rows, { key, name: '', value: '' }] }));
                }}
                style={{ justifySelf: 'start', color: 'var(--brand-text)' }}
              >
                Add row
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
