import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { fromZonedInput, zonedInput } from '@marketly/web-shared/lib/dates';
import { formatMoney, num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { Alert, announce, Badge, Button, DateTimeField, Dialog, Drawer, EmptyState, Field, IconButton, Img, KeyValue, LogoTile, PageHeader, Pager, SearchInput, Select, StatusBadge, Switch, TableWrap, Tabs, Textarea, TextInput, Timeline } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { dateTime, LoadError, SkeletonLines, TZ } from '@/app/parts';
import { initialsOf, tintOf } from './data/categories';
import {
  AREA, DeptPage, HANDOVER, LinesField, moneyText, newKey, PAGE_SIZE, PhotosField, PictureField, plural, PRICE_UNIT, REQUEST_STATUS, SHOWN_STATUS, slugify, toMoney, totalPagesOf, WEEKDAYS,
  type HandoverOption, type MediaRef, type OpeningDay, type PriceRow, type Provider, type ProviderInput, type ProviderStaff, type RequestStatus, type RequestUpdate, type Service, type ServiceArea, type ServiceCategory, type ServiceInput, type ServiceRequest, type ServiceReview, type ServiceStep,
} from './data/departments';

// Admin › Departments › OS install, Post-sale services, Welfare services and Booking (designed in React from the Marketly
// Departments canvas: OsInstall*, PostSale*, Welfare*, Booking*): one page per service area. Tabs: Requests | Services |
// Providers | Categories | Reviews. API: /api/admin/services/{requests,services,providers,categories,reviews}. Customers
// pay the provider (no online payment for requests and bookings in v1); staff confirm, start, complete or decline
// requests on the provider's behalf and can move a booking to another time (the API answers SLOT_TAKEN when it is taken).

type Tab = '' | 'services' | 'providers' | 'categories' | 'reviews';
type Notify = (title: string, tone?: 'success' | 'danger') => void;
type Ctx = { area: ServiceArea; notify: Notify; canManage: boolean };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s/]+\.\S+$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_PHOTOS = 12;

/** Who changed a request, from the history's actor key (customer, staff:<id>, system) */
const byLabel = (by: string) => (by.startsWith('staff:') ? 'staff' : by.startsWith('system') ? 'automatic' : by);

export const OsInstallPage = () => <DeptServices area="os_install" />;
export const PostSalePage = () => <DeptServices area="post_sale" />;
export const WelfarePage = () => <DeptServices area="welfare" />;
export const BookingPage = () => <DeptServices area="booking" />;

function DeptServices({ area }: { area: ServiceArea }) {
  const { api } = useApi();
  const { can } = useStaffSession();
  const canView = can('services.view');
  const canManage = can('services.manage');
  const canHandle = can('services.requests.manage');
  const a = AREA[area];
  const [view, setView] = useView<Exclude<Tab, ''>>();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; title: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const notify: Notify = (title, tone = 'success') => {
    setNotice({ tone, title });
    announce(title);
  };
  const waiting = useQuery({ queryKey: ['services', 'requests', area, 'waiting'], enabled: canView, queryFn: () => call(api.GET('/api/admin/services/requests', { params: { query: { area, status: 'requested', limit: 1 } } })) });
  const ctx: Ctx = { area, notify, canManage };
  const addLabel = view === 'services' ? 'Add service' : view === 'providers' ? 'Add provider' : view === 'categories' ? 'Add category' : '';

  return (
    <DeptPage active={a.nav} title={a.title} canView={canView}>
      <PageHeader
        crumbs={[{ label: 'Departments' }, { label: a.title }]}
        title={a.title}
        sub={`Requests and bookings customers make in the app, the services and the providers who give them · customers pay the provider${canManage ? '' : ' · view only: editing needs the services permission'}`}
        actions={
          canManage &&
          addLabel && (
            <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
              {addLabel}
            </Button>
          )
        }
      />
      <Tabs
        items={[
          { value: '', label: 'Requests', count: (waiting.data as { total?: number } | undefined)?.total || undefined },
          { value: 'services', label: 'Services' },
          { value: 'providers', label: 'Providers' },
          { value: 'categories', label: 'Categories' },
          { value: 'reviews', label: 'Reviews' },
        ]}
        active={view}
        onChange={(v) => {
          setNotice(null);
          setAdding(false);
          setView(v as Tab);
        }}
        label={a.title}
      />
      {notice && <Alert tone={notice.tone} title={notice.title} />}
      {view === 'services' ? (
        <ServicesTab {...ctx} adding={adding} setAdding={setAdding} />
      ) : view === 'providers' ? (
        <ProvidersTab {...ctx} adding={adding} setAdding={setAdding} />
      ) : view === 'categories' ? (
        <CategoriesTab {...ctx} adding={adding} setAdding={setAdding} />
      ) : view === 'reviews' ? (
        <ReviewsTab {...ctx} />
      ) : (
        <RequestsTab {...ctx} canHandle={canHandle} />
      )}
    </DeptPage>
  );
}

/* ---------------- shared lookups ---------------- */

function useCategories(area: ServiceArea) {
  const { api } = useApi();
  return useQuery({ queryKey: ['services', 'categories', area], queryFn: () => call(api.GET('/api/admin/services/categories', { params: { query: { area } } })) });
}
function useAllProviders() {
  const { api } = useApi();
  return useQuery({ queryKey: ['services', 'providers', 'all'], queryFn: () => call(api.GET('/api/admin/services/providers', { params: { query: { limit: 100 } } })) });
}
const ratingText = (r: Service['rating']) => (r.average != null && r.count ? `★ ${r.average.toFixed(1)} (${num(r.count)})` : 'No reviews');

/* ---------------- Requests ---------------- */

/** What staff can do from each status (services state machine "Service request") */
const NEXT: Record<RequestStatus, Array<{ to: NonNullable<ServiceRequest['status']>; label: string; variant: 'primary' | 'secondary' | 'danger-soft' }>> = {
  requested: [
    { to: 'confirmed', label: 'Confirm', variant: 'primary' },
    { to: 'declined', label: 'Decline', variant: 'danger-soft' },
    { to: 'cancelled', label: 'Cancel', variant: 'secondary' },
  ],
  confirmed: [
    { to: 'in_progress', label: 'Start', variant: 'primary' },
    { to: 'completed', label: 'Complete', variant: 'secondary' },
    { to: 'declined', label: 'Decline', variant: 'danger-soft' },
    { to: 'cancelled', label: 'Cancel', variant: 'secondary' },
  ],
  in_progress: [
    { to: 'completed', label: 'Complete', variant: 'primary' },
    { to: 'cancelled', label: 'Cancel', variant: 'secondary' },
  ],
  completed: [],
  cancelled: [],
  declined: [],
};

const whenOf = (r: ServiceRequest) => (r.slotStart ? dateTime(r.slotStart) : r.details.preferredDate ? `Prefers ${r.details.preferredDate}` : '—');

function RequestsTab({ area, notify, canHandle }: Ctx & { canHandle: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [status, setStatus] = useState<RequestStatus | ''>('requested');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<ServiceRequest | null>(null);
  const [providerNote, setProviderNote] = useState('');
  const [staffNote, setStaffNote] = useState('');
  const [moveTo, setMoveTo] = useState('');
  const [error, setError] = useState('');
  const query = { area, status: status || undefined, q: q.trim() || undefined };
  const list = useQuery({
    queryKey: ['services', 'requests', query, page],
    queryFn: () => call(api.GET('/api/admin/services/requests', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  const show = (r: ServiceRequest) => (setOpen(r), setProviderNote(r.providerNote ?? ''), setStaffNote(r.staffNote ?? ''), setMoveTo(zonedInput(r.slotStart, TZ)), setError(''));

  const update = useMutation({
    mutationFn: ({ r, body }: { r: ServiceRequest; body: RequestUpdate }) => call(api.PATCH('/api/admin/services/requests/{id}', { params: { path: { id: r.id } }, body })),
    onSuccess: (r, v) => {
      void qc.invalidateQueries({ queryKey: ['services'] });
      const st = v.body?.status;
      notify(st ? `${r.ref} is ${REQUEST_STATUS[r.status].label.toLowerCase()}` : v.body?.slotStart ? `${r.ref} moved to ${r.slotStart ? dateTime(r.slotStart) : 'the new time'}` : `${r.ref}: notes saved`);
      show(r);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const act = (r: ServiceRequest, to: NonNullable<ServiceRequest['status']>) => {
    if (to === 'declined' && !providerNote.trim()) {
      setError('Say why in the note to the customer before declining.');
      document.getElementById('sr-pnote')?.focus();
      return;
    }
    update.mutate({ r, body: { status: to as RequestUpdate['status'], providerNote: providerNote.trim() || null, staffNote: staffNote.trim() || null } });
  };

  return (
    <>
      <section className="card">
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="sr-q" placeholder="Ref, customer name or phone" value={q} onChange={(v) => (setQ(v), setPage(1))} label="Search requests" />
            <select className="select" id="sr-st" aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value as RequestStatus | ''), setPage(1))}>
              <option value="">All statuses</option>
              {(Object.keys(REQUEST_STATUS) as RequestStatus[]).map((s) => (
                <option key={s} value={s}>
                  {REQUEST_STATUS[s].label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {list.isError && (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        )}
        <TableWrap label="Requests table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Ref</th>
                <th scope="col">Customer</th>
                <th scope="col">Service</th>
                <th scope="col">When</th>
                <th scope="col">Status</th>
                <th scope="col">Received</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.isPending && (
                <tr>
                  <td colSpan={7}>
                    <SkeletonLines rows={5} />
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono small strong nowrap">{r.ref}</td>
                  <td>
                    <span className="stack gap-0">
                      <span className="small strong">{r.contact.name}</span>
                      <span className="xs muted">{r.contact.phone}</span>
                    </span>
                  </td>
                  <td>
                    <span className="stack gap-0">
                      <span className="small">{r.serviceTitle}</span>
                      <span className="xs muted">{r.providerName}</span>
                    </span>
                  </td>
                  <td className="small">{whenOf(r)}</td>
                  <td>
                    <StatusBadge status={REQUEST_STATUS[r.status].label} tone={REQUEST_STATUS[r.status].tone} />
                  </td>
                  <td className="small">{dateTime(r.createdAt)}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => show(r)}>
                      Open<span className="sr-only"> {r.ref}</span>
                    </button>
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <EmptyState icon="clipboard-list" title={status === 'requested' && !q ? 'Nothing waiting' : 'No requests here'}>
                      {status === 'requested' && !q ? 'New requests and bookings from the app show up here for confirmation.' : 'Try another status or search.'}
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <div className="card-foot between">
          <span className="xs muted">Confirm what the provider can do; decline with a note to the customer when they can’t.</span>
          <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
        </div>
      </section>

      <Drawer open={!!open} onClose={() => setOpen(null)} className="wide" title={open ? `${open.ref} · ${open.serviceTitle}` : 'Request'}>
        {open && (
          <>
            {error && <Alert tone="danger" title={error} />}
            <div className="row gap-2 wrap">
              <StatusBadge status={REQUEST_STATUS[open.status].label} tone={REQUEST_STATUS[open.status].tone} />
              <span className="small muted">
                {open.providerName} · received {dateTime(open.createdAt)}
              </span>
            </div>
            <KeyValue
              pairs={[
                ['Customer', open.contact.name],
                ['Phone', <a href={`tel:${open.contact.phone}`}>{open.contact.phone}</a>],
                ['Email', open.contact.email ? <a href={`mailto:${open.contact.email}`}>{open.contact.email}</a> : '—'],
                ['When', whenOf(open)],
                ...(open.staff ? [['Staff member', `${open.staff.name}${open.staff.role ? ` · ${open.staff.role}` : ''}`] as [string, string]] : []),
                ...(open.details.deviceModel ? [['Device', open.details.deviceModel] as [string, string]] : []),
                ...(open.details.osVersion ? [['OS version', open.details.osVersion] as [string, string]] : []),
                ...(open.details.handover ? [['Hand-over', HANDOVER[open.details.handover]] as [string, string]] : []),
                ...(open.details.address ? [['Address', open.details.address] as [string, string]] : []),
                ...(open.details.careFor ? [['Care for', open.details.careFor] as [string, string]] : []),
                ...(open.details.plan ? [['Plan', open.details.plan] as [string, string]] : []),
              ]}
            />
            {open.details.notes && (
              <div className="stack gap-1">
                <span className="label">Customer’s notes</span>
                <p className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                  {open.details.notes}
                </p>
              </div>
            )}
            <div className="stack gap-2">
              <span className="label">History</span>
              <Timeline events={[...open.history].reverse().map((h, i) => ({ t: REQUEST_STATUS[h.status as RequestStatus]?.label ?? h.status, d: `${dateTime(h.at)}${h.by ? ` · ${byLabel(h.by)}` : ''}`, state: i === 0 ? 'current' : 'done' }))} />
            </div>
            <Field label="Note to the customer" optional hint="Shown in the app with the request, e.g. why it was declined or what to bring">
              <Textarea id="sr-pnote" rows={3} value={providerNote} disabled={!canHandle} onChange={(e) => setProviderNote(e.target.value)} />
            </Field>
            <Field label="Staff note" optional hint="Only staff see it">
              <Textarea id="sr-snote" rows={2} value={staffNote} disabled={!canHandle} onChange={(e) => setStaffNote(e.target.value)} />
            </Field>
            {canHandle && (
              <div className="row gap-2 wrap">
                {NEXT[open.status].map((n) => (
                  <Button key={n.to} variant={n.variant} size="sm" onClick={() => act(open, n.to)} disabled={update.isPending}>
                    {n.label}
                  </Button>
                ))}
                <Button variant="ghost" size="sm" onClick={() => update.mutate({ r: open, body: { providerNote: providerNote.trim() || null, staffNote: staffNote.trim() || null } })} disabled={update.isPending}>
                  Save notes
                </Button>
              </div>
            )}
            {canHandle && open.slotStart && (open.status === 'requested' || open.status === 'confirmed') && (
              <div className="stack gap-2">
                <span className="label">Move the booking</span>
                <span className="xs sub">Pick another time in opening hours. The app tells the customer; a time someone else booked is refused.</span>
                <div className="row gap-2 wrap">
                  <DateTimeField id="sr-move" value={moveTo} onChange={setMoveTo} step={15} />
                  <Button variant="secondary" size="sm" onClick={() => moveTo && update.mutate({ r: open, body: { slotStart: fromZonedInput(moveTo, TZ) } })} disabled={!moveTo || moveTo === zonedInput(open.slotStart, TZ) || update.isPending}>
                    Move booking
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Drawer>
    </>
  );
}

/* ---------------- Services ---------------- */

type ServiceDraft = {
  id: string; title: string; slug: string; summary: string; image: MediaRef | null; photos: MediaRef[]; categoryId: string; providerId: string; badge: string;
  fromPrice: string; priceUnit: Service['priceUnit']; durationLabel: string; supportedLabel: string; coverage: string; tags: string[]; description: string;
  included: string[]; requirements: string[]; supported: string[]; osVersions: string[]; handover: Array<{ mode: HandoverOption['mode']; fee: string; note: string }>;
  priceTable: PriceRow[]; priceTableTitle: string; terms: string[]; steps: ServiceStep[]; slotMinutes: string; durationMinutes: string; status: Service['status']; position: string;
};
const serviceDraftOf = (s?: Service): ServiceDraft => ({
  id: s?.id ?? '',
  title: s?.title ?? '',
  slug: s?.slug ?? '',
  summary: s?.summary ?? '',
  image: s?.image ?? null,
  photos: s?.photos ?? [],
  categoryId: s?.categoryId ?? '',
  providerId: s?.providerId ?? '',
  badge: s?.badge ?? '',
  fromPrice: moneyText(s?.fromPrice),
  priceUnit: s?.priceUnit ?? 'fixed',
  durationLabel: s?.durationLabel ?? '',
  supportedLabel: s?.supportedLabel ?? '',
  coverage: s?.coverage ?? '',
  tags: s?.tags ?? [],
  description: s?.description ?? '',
  included: s?.included ?? [],
  requirements: s?.requirements ?? [],
  supported: s?.supported ?? [],
  osVersions: s?.osVersions ?? [],
  handover: (s?.handover ?? []).map((h) => ({ mode: h.mode, fee: moneyText(h.fee), note: h.note ?? '' })),
  priceTable: s?.priceTable ?? [],
  priceTableTitle: s?.priceTableTitle ?? '',
  terms: s?.terms ?? [],
  steps: s?.steps ?? [],
  slotMinutes: s?.slotMinutes ? String(s.slotMinutes) : '',
  durationMinutes: s?.durationMinutes ? String(s.durationMinutes) : '',
  status: s?.status ?? 'hidden',
  position: s ? String(s.position) : '',
});

function serviceProblems(d: ServiceDraft, area: ServiceArea) {
  const slot = d.slotMinutes.trim() ? Number(d.slotMinutes) : null;
  const money = (v: string) => v.trim() && (Number.isNaN(Number(v)) || Number(v) < 0);
  return {
    title: d.title.trim() ? '' : 'Enter the service name.',
    providerId: d.providerId ? '' : 'Pick the provider who gives it.',
    fromPrice: money(d.fromPrice) ? 'Enter a price in dollars, e.g. 29 or 24.50.' : '',
    slotMinutes: area === 'booking' && slot === null ? 'Booked services need a slot length.' : slot !== null && (!Number.isInteger(slot) || slot < 15 || slot > 480) ? 'Use whole minutes from 15 to 480.' : '',
    handover: d.handover.some((h) => money(h.fee)) ? 'Enter hand-over fees in dollars.' : '',
    priceTable: d.priceTable.some((r) => !r.label.trim() || !r.price.trim()) ? 'Every price row needs a label and a price.' : '',
    steps: d.steps.some((s) => !s.title.trim()) ? 'Every step needs a title.' : '',
  };
}

function ServicesTab({ area, notify, canManage, adding, setAdding }: Ctx & { adding: boolean; setAdding: (v: boolean) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const categories = useCategories(area);
  const providers = useAllProviders();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [providerId, setProviderId] = useState('');
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<ServiceDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const query = { area, q: q.trim() || undefined, status: (status || undefined) as Service['status'] | undefined, providerId: providerId || undefined };
  const list = useQuery({
    queryKey: ['services', 'services', query, page],
    queryFn: () => call(api.GET('/api/admin/services/services', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  const cats = categories.data ?? [];
  const provs = providers.data?.items ?? [];
  const catName = (id?: string | null) => cats.find((c) => c.id === id)?.name ?? '—';

  const editing = draft ?? (adding ? serviceDraftOf() : null);
  const setD = (patch: Partial<ServiceDraft>) => editing && setDraft({ ...editing, ...patch });
  const close = () => (setDraft(null), setAdding(false), setTried(false), setError(''));
  const errs = tried && editing ? serviceProblems(editing, area) : null;
  const noun = AREA[area].noun;

  const save = useMutation({
    mutationFn: (d: ServiceDraft) => {
      const body: ServiceInput = {
        area,
        title: d.title.trim(),
        slug: d.slug.trim() || null,
        summary: d.summary.trim() || null,
        image: d.image,
        photos: d.photos,
        categoryId: d.categoryId || null,
        providerId: d.providerId,
        badge: d.badge.trim() || null,
        fromPrice: toMoney(d.fromPrice),
        priceUnit: d.priceUnit,
        durationLabel: d.durationLabel.trim() || null,
        supportedLabel: d.supportedLabel.trim() || null,
        coverage: d.coverage.trim() || null,
        tags: d.tags,
        description: d.description.trim() || null,
        included: d.included,
        requirements: d.requirements,
        supported: d.supported,
        osVersions: d.osVersions,
        handover: d.handover.map((h) => ({ mode: h.mode, fee: toMoney(h.fee), note: h.note.trim() || null })),
        priceTable: d.priceTable.map((r) => ({ label: r.label.trim(), detail: r.detail?.trim() || null, price: r.price.trim() })),
        priceTableTitle: d.priceTableTitle.trim() || null,
        terms: d.terms,
        steps: d.steps.map((s) => ({ title: s.title.trim(), detail: s.detail?.trim() || null })),
        slotMinutes: d.slotMinutes.trim() ? Number(d.slotMinutes) : null,
        durationMinutes: d.durationMinutes.trim() ? Number(d.durationMinutes) : null,
        status: d.status,
        position: d.position.trim() ? Number(d.position) : null,
      };
      return d.id ? call(api.PATCH('/api/admin/services/services/{id}', { params: { path: { id: d.id } }, body })) : call(api.POST('/api/admin/services/services', { body }));
    },
    onSuccess: (s, d) => {
      void qc.invalidateQueries({ queryKey: ['services'] });
      notify(d.id ? `${s.title} saved${s.status === 'hidden' ? ' (hidden from customers)' : ''}` : `${s.title} added${s.status === 'hidden' ? ' as hidden: publish it when it is ready' : ''}`);
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (d: ServiceDraft) => call(api.DELETE('/api/admin/services/services/{id}', { params: { path: { id: d.id } } })),
    onSuccess: (_r, d) => {
      void qc.invalidateQueries({ queryKey: ['services'] });
      notify(`${d.title} deleted`);
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = () => {
    if (!editing) return;
    setTried(true);
    if (Object.values(serviceProblems(editing, area)).some(Boolean)) return;
    save.mutate(editing);
  };

  return (
    <>
      <section className="card">
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="ss-q" placeholder="Search services" value={q} onChange={(v) => (setQ(v), setPage(1))} label="Search services" />
            <select className="select" id="ss-st" aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
              <option value="">All statuses</option>
              <option value="published">Published</option>
              <option value="hidden">Hidden</option>
            </select>
            <select className="select" id="ss-pr" aria-label="Provider" value={providerId} onChange={(e) => (setProviderId(e.target.value), setPage(1))}>
              <option value="">All providers</option>
              {provs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {list.isError && (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        )}
        <TableWrap label="Services table">
          <table className="table">
            <thead>
              <tr>
                <th className="r" scope="col">
                  Order
                </th>
                <th scope="col">Service</th>
                <th scope="col">Provider</th>
                <th scope="col">Category</th>
                <th className="r" scope="col">
                  From
                </th>
                <th scope="col">Rating</th>
                <th className="r" scope="col">
                  Open requests
                </th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.isPending && (
                <tr>
                  <td colSpan={9}>
                    <SkeletonLines rows={5} />
                  </td>
                </tr>
              )}
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="r small">{s.position}</td>
                  <td>
                    <span className="row nowrap gap-3">
                      <Img icon={AREA[area].icon} src={s.image?.url} alt="" className="tiny" />
                      <span className="stack gap-0">
                        <span className="row gap-2">
                          <span className="small strong">{s.title}</span>
                          {s.badge && <Badge tone="brand">{s.badge}</Badge>}
                        </span>
                        <span className="xs muted">{s.durationLabel ?? s.summary ?? `/${s.slug}`}</span>
                      </span>
                    </span>
                  </td>
                  <td className="small">{s.providerName}</td>
                  <td className="small">{catName(s.categoryId)}</td>
                  <td className="r small nowrap">{s.priceUnit === 'free' ? 'Free' : s.fromPrice ? `${formatMoney(s.fromPrice)}${s.priceUnit === 'hour' ? '/hr' : s.priceUnit === 'night' ? '/night' : s.priceUnit === 'visit' ? '/visit' : ''}` : '—'}</td>
                  <td className="small nowrap">{ratingText(s.rating)}</td>
                  <td className="r small">{s.openRequestCount ? <Badge tone="brand">{s.openRequestCount}</Badge> : '0'}</td>
                  <td>
                    <StatusBadge status={SHOWN_STATUS[s.status]} tone={s.status === 'published' ? 'success' : ''} />
                  </td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setTried(false), setError(''), setDraft(serviceDraftOf(s)))}>
                      {canManage ? 'Edit' : 'View'}
                      <span className="sr-only"> {s.title}</span>
                    </button>
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <EmptyState icon={AREA[area].icon} title={q || status || providerId ? 'No services match' : `No ${noun}s yet`}>
                      {q || status || providerId ? 'Try another search or clear the filters.' : provs.length ? `Add the first ${noun} with “Add service”.` : 'Add a provider first on the Providers tab, then the services they give.'}
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <div className="card-foot between">
          <span className="xs muted">The app lists published services in this order.</span>
          <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
        </div>
      </section>

      <Drawer
        open={!!editing}
        onClose={close}
        className="wide"
        title={editing?.id ? `Edit service: ${editing.title || 'Untitled'}` : `Add ${noun}`}
        foot={
          canManage ? (
            <>
              {editing?.id && (
                <Button variant="danger-soft" size="sm" onClick={() => editing && remove.mutate(editing)} disabled={save.isPending || remove.isPending}>
                  Delete
                </Button>
              )}
              <span className="grow" />
              <Button variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button size="sm" onClick={submit} disabled={save.isPending || remove.isPending}>
                {editing?.id ? 'Save service' : 'Add service'}
              </Button>
            </>
          ) : undefined
        }
      >
        {editing && (
          <fieldset className="stack gap-4" disabled={!canManage} style={{ border: 0, padding: 0, margin: 0 }}>
            {error && (
              <Alert tone="danger" title="The service wasn’t saved">
                {error}
              </Alert>
            )}
            {errs && Object.values(errs).some(Boolean) && <Alert tone="danger" title={Object.values(errs).find(Boolean)!} />}
            <Field label="Name" error={errs?.title}>
              <TextInput id="ss-title" value={editing.title} placeholder={area === 'booking' ? 'e.g. Haircut' : area === 'welfare' ? 'e.g. In-home elder care' : area === 'post_sale' ? 'e.g. Screen replacement' : 'e.g. Android clean reinstall'} error={!!errs?.title} onChange={(e) => setD({ title: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Provider" error={errs?.providerId}>
                <Select id="ss-prov" value={editing.providerId} options={[{ value: '', label: 'Pick a provider…' }, ...provs.map((p) => ({ value: p.id, label: p.status === 'hidden' ? `${p.name} (hidden)` : p.name }))]} onChange={(e) => setD({ providerId: e.target.value })} />
              </Field>
              <Field label="Category" optional>
                <Select id="ss-cat" value={editing.categoryId} options={[{ value: '', label: 'No category' }, ...cats.map((c) => ({ value: c.id, label: c.visible ? c.name : `${c.name} (hidden)` }))]} onChange={(e) => setD({ categoryId: e.target.value })} />
              </Field>
            </div>
            <div className="grid md2 gap-3">
              <Field label="Slug" optional hint={editing.slug.trim() || slugify(editing.title) || '…'}>
                <TextInput id="ss-slug" value={editing.slug} placeholder={slugify(editing.title)} onChange={(e) => setD({ slug: e.target.value })} />
              </Field>
              <Field label="Badge" optional hint="A short tag on the card, e.g. Popular or Genuine parts">
                <TextInput id="ss-badge" value={editing.badge} onChange={(e) => setD({ badge: e.target.value })} />
              </Field>
            </div>
            <Field label="Summary" optional hint="One line on the card">
              <TextInput id="ss-sum" value={editing.summary} onChange={(e) => setD({ summary: e.target.value })} />
            </Field>
            <Field label="Description" optional hint="Plain text; a blank line starts a new paragraph">
              <Textarea id="ss-desc" rows={4} value={editing.description} onChange={(e) => setD({ description: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="From price" optional hint="Dollars, e.g. 29 or 24.50" error={errs?.fromPrice}>
                <TextInput id="ss-price" inputMode="decimal" prefix="$" value={editing.fromPrice} error={!!errs?.fromPrice} disabled={editing.priceUnit === 'free'} onChange={(e) => setD({ fromPrice: e.target.value })} />
              </Field>
              <Field label="Price reads">
                <Select id="ss-unit" value={editing.priceUnit} options={(Object.keys(PRICE_UNIT) as Service['priceUnit'][]).map((u) => ({ value: u, label: PRICE_UNIT[u] }))} onChange={(e) => setD({ priceUnit: e.target.value as Service['priceUnit'] })} />
              </Field>
            </div>
            <div className="grid md2 gap-3">
              <Field label="How long it takes" optional hint="e.g. About 1–2 hours, Same day, 30 min">
                <TextInput id="ss-dur" value={editing.durationLabel} onChange={(e) => setD({ durationLabel: e.target.value })} />
              </Field>
              <Field label="Where it is offered" optional hint="e.g. Millbrook and 15 km around">
                <TextInput id="ss-cov" value={editing.coverage} onChange={(e) => setD({ coverage: e.target.value })} />
              </Field>
            </div>
            {(area === 'os_install' || area === 'post_sale') && (
              <Field label="Devices on the card" optional hint="e.g. Samsung, Pixel, Xiaomi">
                <TextInput id="ss-supl" value={editing.supportedLabel} onChange={(e) => setD({ supportedLabel: e.target.value })} />
              </Field>
            )}
            <div className="grid md2 gap-3">
              <Field label="Slot length (minutes)" optional={area !== 'booking'} hint={area === 'booking' ? 'Customers book one slot of this length' : 'Set it only if customers pick a time; leave empty for requests without a time'} error={errs?.slotMinutes}>
                <TextInput id="ss-slot" type="number" min={15} max={480} step={5} value={editing.slotMinutes} error={!!errs?.slotMinutes} onChange={(e) => setD({ slotMinutes: e.target.value })} />
              </Field>
              <Field label="Duration (minutes)" optional hint="How long the service itself takes">
                <TextInput id="ss-durm" type="number" min={1} value={editing.durationMinutes} onChange={(e) => setD({ durationMinutes: e.target.value })} />
              </Field>
            </div>
            <PictureField label="Card picture" shape="wide" icon={AREA[area].icon} value={editing.image} alt={editing.title.trim()} hint="16 : 9, saved at 1200 × 675. Without one, the app shows the area icon." disabled={!canManage} onChange={(image) => setD({ image })} />
            <PhotosField photos={editing.photos} max={MAX_PHOTOS} alt={editing.title.trim()} disabled={!canManage} onChange={(photos) => setD({ photos })} />
            <LinesField id="ss-tags" label="Facts on the card" hint="Short tags, e.g. Free pickup" lines={editing.tags} max={6} disabled={!canManage} onChange={(tags) => setD({ tags })} />
            <LinesField id="ss-inc" label="What’s included" lines={editing.included} disabled={!canManage} onChange={(included) => setD({ included })} />
            <LinesField id="ss-req" label="Eligibility and requirements" lines={editing.requirements} disabled={!canManage} onChange={(requirements) => setD({ requirements })} />
            {(area === 'os_install' || area === 'post_sale') && <LinesField id="ss-sup" label="Supported models" lines={editing.supported} disabled={!canManage} onChange={(supported) => setD({ supported })} />}
            {area === 'os_install' && <LinesField id="ss-os" label="OS versions customers pick from" hint="e.g. Android 17, Keep current" lines={editing.osVersions} max={10} disabled={!canManage} onChange={(osVersions) => setD({ osVersions })} />}
            <HandoverField rows={editing.handover} error={errs?.handover} disabled={!canManage} onChange={(handover) => setD({ handover })} />
            <PriceTableField title={editing.priceTableTitle} rows={editing.priceTable} error={errs?.priceTable} disabled={!canManage} onTitle={(priceTableTitle) => setD({ priceTableTitle })} onChange={(priceTable) => setD({ priceTable })} />
            <LinesField id="ss-terms" label={area === 'post_sale' ? 'Warranty terms' : 'Terms'} lines={editing.terms} disabled={!canManage} onChange={(terms) => setD({ terms })} />
            <StepsField steps={editing.steps} error={errs?.steps} disabled={!canManage} onChange={(steps) => setD({ steps })} />
            <div className="grid md2 gap-3">
              <Field label="Status">
                <Select id="ss-status" value={editing.status} options={[{ value: 'published', label: 'Published: customers see it' }, { value: 'hidden', label: 'Hidden' }]} onChange={(e) => setD({ status: e.target.value as Service['status'] })} />
              </Field>
              <Field label="Order" optional hint="Lower numbers show first">
                <TextInput id="ss-pos" type="number" min={1} value={editing.position} onChange={(e) => setD({ position: e.target.value })} />
              </Field>
            </div>
          </fieldset>
        )}
      </Drawer>
    </>
  );
}

function HandoverField({ rows, onChange, error, disabled }: { rows: ServiceDraft['handover']; onChange: (r: ServiceDraft['handover']) => void; error?: string; disabled: boolean }) {
  const free = (Object.keys(HANDOVER) as HandoverOption['mode'][]).filter((m) => !rows.some((r) => r.mode === m));
  const setRow = (i: number, patch: Partial<ServiceDraft['handover'][number]>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack gap-2">
      <span className="label">How customers hand over</span>
      <span className="xs sub">The choices on the booking form, e.g. Drop-off, or Pickup with a fee</span>
      {rows.map((r, i) => (
        <div key={r.mode} className="row gap-2 wrap items-center">
          <select className="select" aria-label={`Hand-over ${i + 1}`} value={r.mode} disabled={disabled} onChange={(e) => setRow(i, { mode: e.target.value as HandoverOption['mode'] })}>
            {(Object.keys(HANDOVER) as HandoverOption['mode'][]).filter((m) => m === r.mode || free.includes(m)).map((m) => (
              <option key={m} value={m}>
                {HANDOVER[m]}
              </option>
            ))}
          </select>
          <input className="input" style={{ width: 110 }} aria-label={`${HANDOVER[r.mode]} fee in dollars`} inputMode="decimal" placeholder="Fee $" value={r.fee} disabled={disabled} onChange={(e) => setRow(i, { fee: e.target.value })} />
          <input className="input grow" aria-label={`${HANDOVER[r.mode]} note`} placeholder="Note, e.g. Ready in about 2 hours" value={r.note} disabled={disabled} onChange={(e) => setRow(i, { note: e.target.value })} />
          {!disabled && <IconButton icon="x" label={`Remove ${HANDOVER[r.mode]}`} onClick={() => onChange(rows.filter((_, k) => k !== i))} />}
        </div>
      ))}
      {error && <span className="xs t-danger-text">{error}</span>}
      {!disabled && free.length > 0 && (
        <div>
          <Button variant="secondary" size="sm" icon="plus" onClick={() => onChange([...rows, { mode: free[0], fee: '', note: '' }])}>
            Add a hand-over option
          </Button>
        </div>
      )}
    </div>
  );
}

function PriceTableField({ title, rows, onTitle, onChange, error, disabled }: { title: string; rows: PriceRow[]; onTitle: (t: string) => void; onChange: (r: PriceRow[]) => void; error?: string; disabled: boolean }) {
  const setRow = (i: number, patch: Partial<PriceRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack gap-2">
      <span className="label">Price table</span>
      <span className="xs sub">Prices by model, or a schedule of plans. The price is shown as typed, e.g. $229, $24/hr or Free.</span>
      <Field label="Table title" optional>
        <TextInput id="ss-ptt" value={title} placeholder="e.g. Price by model, Schedule and prices" disabled={disabled} onChange={(e) => onTitle(e.target.value)} />
      </Field>
      {rows.map((r, i) => (
        <div key={i} className="row gap-2 wrap items-center">
          <input className="input grow" aria-label={`Row ${i + 1} label`} placeholder="Label, e.g. Galaxy S25 or Weekly" value={r.label} disabled={disabled} onChange={(e) => setRow(i, { label: e.target.value })} />
          <input className="input grow" aria-label={`Row ${i + 1} detail`} placeholder="Detail (optional)" value={r.detail ?? ''} disabled={disabled} onChange={(e) => setRow(i, { detail: e.target.value })} />
          <input className="input" style={{ width: 120 }} aria-label={`Row ${i + 1} price`} placeholder="Price" value={r.price} disabled={disabled} onChange={(e) => setRow(i, { price: e.target.value })} />
          {!disabled && <IconButton icon="x" label={`Remove row ${i + 1}`} onClick={() => onChange(rows.filter((_, k) => k !== i))} />}
        </div>
      ))}
      {error && <span className="xs t-danger-text">{error}</span>}
      {!disabled && rows.length < 30 && (
        <div>
          <Button variant="secondary" size="sm" icon="plus" onClick={() => onChange([...rows, { label: '', detail: null, price: '' }])}>
            Add a row
          </Button>
        </div>
      )}
    </div>
  );
}

function StepsField({ steps, onChange, error, disabled }: { steps: ServiceStep[]; onChange: (s: ServiceStep[]) => void; error?: string; disabled: boolean }) {
  const setStep = (i: number, patch: Partial<ServiceStep>) => onChange(steps.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  return (
    <div className="stack gap-2">
      <span className="label">How it works</span>
      <span className="xs sub">Numbered steps in order, e.g. Request · Pick a time</span>
      {steps.map((s, i) => (
        <div key={i} className="row gap-2 wrap items-center">
          <span className="xs muted num">{i + 1}</span>
          <input className="input grow" aria-label={`Step ${i + 1} title`} placeholder="Title, e.g. Pickup" value={s.title} disabled={disabled} onChange={(e) => setStep(i, { title: e.target.value })} />
          <input className="input grow" aria-label={`Step ${i + 1} detail`} placeholder="Detail, e.g. Courier collects it" value={s.detail ?? ''} disabled={disabled} onChange={(e) => setStep(i, { detail: e.target.value })} />
          {!disabled && <IconButton icon="x" label={`Remove step ${i + 1}`} onClick={() => onChange(steps.filter((_, k) => k !== i))} />}
        </div>
      ))}
      {error && <span className="xs t-danger-text">{error}</span>}
      {!disabled && steps.length < 8 && (
        <div>
          <Button variant="secondary" size="sm" icon="plus" onClick={() => onChange([...steps, { title: '', detail: null }])}>
            Add a step
          </Button>
        </div>
      )}
    </div>
  );
}

/* ---------------- Providers ---------------- */

type ProviderDraft = {
  id: string; name: string; slug: string; logo: MediaRef | null; cover: MediaRef | null; kind: string; categoryId: string; city: string; verified: boolean; photos: MediaRef[];
  description: string; since: string; phone: string; email: string; website: string; address: string; lat: string; lng: string; days: OpeningDay[]; staff: ProviderStaff[]; replyTime: string; status: Provider['status'];
};
const DEFAULT_DAYS: OpeningDay[] = WEEKDAYS.map((w) => (w.value === 'sun' ? { weekday: w.value, open: false, from: null, to: null } : { weekday: w.value, open: true, from: w.value === 'sat' ? '10:00' : '09:00', to: w.value === 'sat' ? '16:00' : '18:00' }));
const providerDraftOf = (p?: Provider): ProviderDraft => ({
  id: p?.id ?? '',
  name: p?.name ?? '',
  slug: p?.slug ?? '',
  logo: p?.logo ?? null,
  cover: p?.cover ?? null,
  kind: p?.kind ?? '',
  categoryId: p?.categoryId ?? '',
  city: p?.city ?? '',
  verified: p?.verified ?? false,
  photos: p?.photos ?? [],
  description: p?.description ?? '',
  since: p?.since ? String(p.since) : '',
  phone: p?.contacts.phone ?? '',
  email: p?.contacts.email ?? '',
  website: p?.contacts.website ?? '',
  address: p?.contacts.address ?? '',
  lat: p?.location ? String(p.location.lat) : '',
  lng: p?.location ? String(p.location.lng) : '',
  days: WEEKDAYS.map((w) => p?.hours.days.find((d) => d.weekday === w.value) ?? DEFAULT_DAYS.find((d) => d.weekday === w.value)!),
  staff: p?.staff ?? [],
  replyTime: p?.replyTime ?? '',
  status: p?.status ?? 'hidden',
});

function providerProblems(d: ProviderDraft) {
  const year = new Date().getFullYear();
  const lat = d.lat.trim() ? Number(d.lat) : null;
  const lng = d.lng.trim() ? Number(d.lng) : null;
  return {
    name: d.name.trim() ? '' : 'Enter the provider’s name.',
    since: d.since.trim() && !(Number.isInteger(Number(d.since)) && Number(d.since) >= 1800 && Number(d.since) <= year) ? `Enter a year from 1800 to ${year}.` : '',
    email: d.email.trim() && !EMAIL.test(d.email.trim()) ? 'Enter a valid email address.' : '',
    website: d.website.trim() && !URL_RE.test(d.website.trim()) ? 'Use a full address, e.g. https://example.com.' : '',
    location: (lat === null) !== (lng === null) ? 'Enter both the latitude and the longitude, or neither.' : lat !== null && (Number.isNaN(lat) || lat < -90 || lat > 90 || Number.isNaN(lng!) || lng! < -180 || lng! > 180) ? 'Latitude goes from −90 to 90 and longitude from −180 to 180.' : '',
    hours: d.days.some((x) => x.open && !(TIME.test(x.from ?? '') && TIME.test(x.to ?? '') && (x.from ?? '') < (x.to ?? ''))) ? 'Each open day needs an opening time before its closing time (HH:MM).' : '',
    staff: d.staff.some((s) => !s.name.trim()) ? 'Every staff member needs a name.' : '',
  };
}

function ProvidersTab({ area, notify, canManage, adding, setAdding }: Ctx & { adding: boolean; setAdding: (v: boolean) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const categories = useCategories(area);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const query = { q: q.trim() || undefined, status: (status || undefined) as Provider['status'] | undefined };
  const list = useQuery({
    queryKey: ['services', 'providers', query, page],
    queryFn: () => call(api.GET('/api/admin/services/providers', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];

  const editing = draft ?? (adding ? providerDraftOf() : null);
  const setD = (patch: Partial<ProviderDraft>) => editing && setDraft({ ...editing, ...patch });
  const setDay = (i: number, patch: Partial<OpeningDay>) => editing && setD({ days: editing.days.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
  const close = () => (setDraft(null), setAdding(false), setTried(false), setError(''));
  const errs = tried && editing ? providerProblems(editing) : null;

  const save = useMutation({
    mutationFn: (d: ProviderDraft) => {
      const body: ProviderInput = {
        name: d.name.trim(),
        slug: d.slug.trim() || null,
        logo: d.logo,
        cover: d.cover,
        kind: d.kind.trim() || null,
        categoryId: d.categoryId || null,
        city: d.city.trim() || null,
        verified: d.verified,
        photos: d.photos,
        description: d.description.trim() || null,
        since: d.since.trim() ? Number(d.since) : null,
        contacts: { phone: d.phone.trim() || null, email: d.email.trim() || null, website: d.website.trim() || null, address: d.address.trim() || null },
        location: d.lat.trim() && d.lng.trim() ? { lat: Number(d.lat), lng: Number(d.lng) } : null,
        hours: { days: d.days.map((x) => (x.open ? x : { ...x, from: null, to: null })), timeZone: TZ },
        staff: d.staff.map((s) => ({ ...s, name: s.name.trim(), role: s.role?.trim() || null })),
        replyTime: d.replyTime.trim() || null,
        status: d.status,
      };
      return d.id ? call(api.PATCH('/api/admin/services/providers/{id}', { params: { path: { id: d.id } }, body })) : call(api.POST('/api/admin/services/providers', { body }));
    },
    onSuccess: (p, d) => {
      void qc.invalidateQueries({ queryKey: ['services'] });
      notify(d.id ? `${p.name} saved` : `${p.name} added${p.status === 'hidden' ? ' as hidden: publish it when its services are ready' : ''}`);
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (d: ProviderDraft) => call(api.DELETE('/api/admin/services/providers/{id}', { params: { path: { id: d.id } } })),
    onSuccess: (_r, d) => {
      void qc.invalidateQueries({ queryKey: ['services'] });
      notify(`${d.name} deleted`);
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = () => {
    if (!editing) return;
    setTried(true);
    if (Object.values(providerProblems(editing)).some(Boolean)) return;
    save.mutate(editing);
  };

  return (
    <>
      <section className="card">
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="sp-q" placeholder="Search providers" value={q} onChange={(v) => (setQ(v), setPage(1))} label="Search providers" />
            <select className="select" id="sp-st" aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
              <option value="">All statuses</option>
              <option value="published">Published</option>
              <option value="hidden">Hidden</option>
            </select>
          </div>
        </div>
        {list.isError && (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        )}
        <TableWrap label="Providers table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Kind</th>
                <th scope="col">City</th>
                <th scope="col">Areas</th>
                <th className="r" scope="col">
                  Services
                </th>
                <th className="r" scope="col">
                  Open requests
                </th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.isPending && (
                <tr>
                  <td colSpan={8}>
                    <SkeletonLines rows={5} />
                  </td>
                </tr>
              )}
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="row nowrap gap-3">
                      {p.logo ? <Img icon="store" src={p.logo.url} alt="" className="tiny" /> : <LogoTile initials={initialsOf(p.name)} tint={tintOf(p.name)} size="sm" />}
                      <span className="stack gap-0">
                        <span className="row gap-2">
                          <span className="small strong">{p.name}</span>
                          {p.verified && (
                            <Badge tone="info" icon="badge-check">
                              Verified
                            </Badge>
                          )}
                        </span>
                        <span className="xs muted">{p.contacts.phone ?? p.contacts.email ?? `/${p.slug}`}</span>
                      </span>
                    </span>
                  </td>
                  <td className="small">{p.kind ?? '—'}</td>
                  <td className="small">{p.city ?? '—'}</td>
                  <td>
                    <span className="row gap-1 wrap">
                      {p.areas.length ? p.areas.map((x) => <Badge key={x} tone={x === area ? 'brand' : undefined}>{AREA[x].title}</Badge>) : <span className="xs muted">No services yet</span>}
                    </span>
                  </td>
                  <td className="r small">{num(p.serviceCount)}</td>
                  <td className="r small">{p.openRequestCount ? <Badge tone="brand">{p.openRequestCount}</Badge> : '0'}</td>
                  <td>
                    <StatusBadge status={SHOWN_STATUS[p.status]} tone={p.status === 'published' ? 'success' : ''} />
                  </td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setTried(false), setError(''), setDraft(providerDraftOf(p)))}>
                      {canManage ? 'Edit' : 'View'}
                      <span className="sr-only"> {p.name}</span>
                    </button>
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <EmptyState icon="store" title={q || status ? 'No providers match' : 'No providers yet'}>
                      {q || status ? 'Try another search or clear the filters.' : 'Providers are the shops, clinics and agencies who give the services. Add the first with “Add provider”.'}
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <div className="card-foot between">
          <span className="xs muted">One provider can give services in several areas. Their opening hours set the bookable times.</span>
          <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
        </div>
      </section>

      <Drawer
        open={!!editing}
        onClose={close}
        className="wide"
        title={editing?.id ? `Edit provider: ${editing.name || 'Untitled'}` : 'Add provider'}
        foot={
          canManage ? (
            <>
              {editing?.id && (
                <Button variant="danger-soft" size="sm" onClick={() => editing && remove.mutate(editing)} disabled={save.isPending || remove.isPending}>
                  Delete
                </Button>
              )}
              <span className="grow" />
              <Button variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button size="sm" onClick={submit} disabled={save.isPending || remove.isPending}>
                {editing?.id ? 'Save provider' : 'Add provider'}
              </Button>
            </>
          ) : undefined
        }
      >
        {editing && (
          <fieldset className="stack gap-4" disabled={!canManage} style={{ border: 0, padding: 0, margin: 0 }}>
            {error && (
              <Alert tone="danger" title="The provider wasn’t saved">
                {error}
              </Alert>
            )}
            {errs && Object.values(errs).some(Boolean) && <Alert tone="danger" title={Object.values(errs).find(Boolean)!} />}
            <Field label="Name" error={errs?.name}>
              <TextInput id="sp-name" value={editing.name} error={!!errs?.name} onChange={(e) => setD({ name: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Slug" optional hint={editing.slug.trim() || slugify(editing.name) || '…'}>
                <TextInput id="sp-slug" value={editing.slug} placeholder={slugify(editing.name)} onChange={(e) => setD({ slug: e.target.value })} />
              </Field>
              <Field label="Kind" optional hint="e.g. Hair salon, Dental clinic, Licensed home care agency">
                <TextInput id="sp-kind" value={editing.kind} onChange={(e) => setD({ kind: e.target.value })} />
              </Field>
            </div>
            {area === 'booking' && (
              <Field label="Booking category" optional hint="The chip customers find it under, e.g. Beauty">
                <Select id="sp-cat" value={editing.categoryId} options={[{ value: '', label: 'No category' }, ...(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))]} onChange={(e) => setD({ categoryId: e.target.value })} />
              </Field>
            )}
            <div className="grid md2 gap-3">
              <Field label="City" optional>
                <TextInput id="sp-city" value={editing.city} onChange={(e) => setD({ city: e.target.value })} />
              </Field>
              <Field label="Since" optional hint="Year founded" error={errs?.since}>
                <TextInput id="sp-since" inputMode="numeric" value={editing.since} error={!!errs?.since} onChange={(e) => setD({ since: e.target.value })} />
              </Field>
            </div>
            <Switch id="sp-verified" label="Verified provider (shows the Verified mark)" checked={editing.verified} onChange={(e) => setD({ verified: e.target.checked })} />
            <Field label="Description" optional hint="Plain text; a blank line starts a new paragraph">
              <Textarea id="sp-desc" rows={4} value={editing.description} onChange={(e) => setD({ description: e.target.value })} />
            </Field>
            <PictureField label="Logo" shape="square" icon="store" value={editing.logo} alt={editing.name.trim()} hint="Square, saved at 600 × 600. Without one, the app shows initials." disabled={!canManage} onChange={(logo) => setD({ logo })} />
            <PictureField label="Cover" shape="wide" icon="image" value={editing.cover} alt={editing.name.trim()} hint="16 : 9, on the provider’s card" disabled={!canManage} onChange={(cover) => setD({ cover })} />
            <PhotosField photos={editing.photos} max={MAX_PHOTOS} alt={editing.name.trim()} disabled={!canManage} onChange={(photos) => setD({ photos })} />
            <h3 className="h4">Contact</h3>
            <div className="grid md2 gap-3">
              <Field label="Phone" optional>
                <TextInput id="sp-phone" type="tel" value={editing.phone} onChange={(e) => setD({ phone: e.target.value })} />
              </Field>
              <Field label="Email" optional error={errs?.email}>
                <TextInput id="sp-email" type="email" value={editing.email} error={!!errs?.email} onChange={(e) => setD({ email: e.target.value })} />
              </Field>
            </div>
            <Field label="Website" optional error={errs?.website}>
              <TextInput id="sp-web" type="url" value={editing.website} placeholder="https://" error={!!errs?.website} onChange={(e) => setD({ website: e.target.value })} />
            </Field>
            <Field label="Address" optional>
              <Textarea id="sp-addr" rows={2} value={editing.address} onChange={(e) => setD({ address: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Latitude" optional hint="For the map, e.g. 45.5231" error={errs?.location}>
                <TextInput id="sp-lat" inputMode="decimal" value={editing.lat} error={!!errs?.location} onChange={(e) => setD({ lat: e.target.value })} />
              </Field>
              <Field label="Longitude" optional hint="e.g. -122.6765">
                <TextInput id="sp-lng" inputMode="decimal" value={editing.lng} error={!!errs?.location} onChange={(e) => setD({ lng: e.target.value })} />
              </Field>
            </div>
            <Field label="Reply time" optional hint="e.g. Replies within 1 hour">
              <TextInput id="sp-reply" value={editing.replyTime} onChange={(e) => setD({ replyTime: e.target.value })} />
            </Field>
            <div className="stack gap-2">
              <span className="label">Opening hours</span>
              <span className="xs sub">Pacific Time. Bookable services are cut into slots inside these hours.</span>
              {editing.days.map((x, i) => (
                <div key={x.weekday} className="row gap-3 wrap items-center">
                  <span className="small" style={{ width: 96 }}>
                    {WEEKDAYS[i].label}
                  </span>
                  <Switch id={`sp-open-${x.weekday}`} label={x.open ? 'Open' : 'Closed'} checked={x.open} onChange={(e) => setDay(i, e.target.checked ? { open: true, from: x.from ?? '09:00', to: x.to ?? '18:00' } : { open: false })} />
                  {x.open && (
                    <>
                      <input className="input" type="time" style={{ width: 130 }} aria-label={`${WEEKDAYS[i].label} opens`} value={x.from ?? ''} onChange={(e) => setDay(i, { from: e.target.value })} />
                      <span className="xs muted">to</span>
                      <input className="input" type="time" style={{ width: 130 }} aria-label={`${WEEKDAYS[i].label} closes`} value={x.to ?? ''} onChange={(e) => setDay(i, { to: e.target.value })} />
                    </>
                  )}
                </div>
              ))}
              {errs?.hours && <span className="xs t-danger-text">{errs.hours}</span>}
            </div>
            <div className="stack gap-2">
              <span className="label">Staff</span>
              <span className="xs sub">Stylists or technicians customers can pick when booking; leave empty when they don’t choose</span>
              {editing.staff.map((s, i) => (
                <div key={s.id} className="row gap-2 wrap items-center">
                  <input className="input grow" aria-label={`Staff ${i + 1} name`} placeholder="Name" value={s.name} onChange={(e) => setD({ staff: editing.staff.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} />
                  <input className="input grow" aria-label={`Staff ${i + 1} role`} placeholder="Role, e.g. Stylist" value={s.role ?? ''} onChange={(e) => setD({ staff: editing.staff.map((x, k) => (k === i ? { ...x, role: e.target.value } : x)) })} />
                  {canManage && <IconButton icon="x" label={`Remove ${s.name || `staff member ${i + 1}`}`} onClick={() => setD({ staff: editing.staff.filter((_, k) => k !== i) })} />}
                </div>
              ))}
              {errs?.staff && <span className="xs t-danger-text">{errs.staff}</span>}
              {canManage && editing.staff.length < 30 && (
                <div>
                  <Button variant="secondary" size="sm" icon="plus" onClick={() => setD({ staff: [...editing.staff, { id: newKey(), name: '', role: null }] })}>
                    Add a staff member
                  </Button>
                </div>
              )}
            </div>
            <Field label="Status">
              <Select id="sp-status" value={editing.status} options={[{ value: 'published', label: 'Published: customers see it' }, { value: 'hidden', label: 'Hidden' }]} onChange={(e) => setD({ status: e.target.value as Provider['status'] })} />
            </Field>
          </fieldset>
        )}
      </Drawer>
    </>
  );
}

/* ---------------- Categories ---------------- */

type CategoryDraft = { id: string; name: string; slug: string; icon: string; position: string; visible: boolean };

function CategoriesTab({ area, notify, canManage, adding, setAdding }: Ctx & { adding: boolean; setAdding: (v: boolean) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const list = useCategories(area);
  const rows = [...(list.data ?? [])].sort((a, b) => a.position - b.position);
  const [draft, setDraft] = useState<CategoryDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const editing = draft ?? (adding ? { id: '', name: '', slug: '', icon: '', position: String(rows.length + 1), visible: true } : null);
  const close = () => (setDraft(null), setAdding(false), setTried(false), setError(''));
  const setD = (patch: Partial<CategoryDraft>) => editing && setDraft({ ...editing, ...patch });

  const save = useMutation({
    mutationFn: (d: CategoryDraft) => {
      const body = { area, name: d.name.trim(), slug: d.slug.trim() || null, icon: d.icon.trim() || null, position: d.position ? Number(d.position) : null, visible: d.visible };
      return d.id ? call(api.PATCH('/api/admin/services/categories/{id}', { params: { path: { id: d.id } }, body })) : call(api.POST('/api/admin/services/categories', { body }));
    },
    onSuccess: (c, d) => {
      void qc.invalidateQueries({ queryKey: ['services'] });
      notify(d.id ? `${c.name} saved` : `${c.name} added`);
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (c: ServiceCategory) => call(api.DELETE('/api/admin/services/categories/{id}', { params: { path: { id: c.id } } })),
    onSuccess: (_r, c) => {
      void qc.invalidateQueries({ queryKey: ['services'] });
      notify(`${c.name} deleted`);
    },
    onError: (e, c) => notify(`${c.name} wasn’t deleted: ${errorMessage(e)}`, 'danger'),
  });

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">Categories</h2>
            <span className="xs muted">The chips the app shows on the {AREA[area].title} page, in this order</span>
          </div>
        </div>
        {list.isError ? (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : (
          <TableWrap label="Categories table">
            <table className="table">
              <thead>
                <tr>
                  <th className="r" scope="col">
                    Order
                  </th>
                  <th scope="col">Category</th>
                  <th className="r" scope="col">
                    {area === 'booking' ? 'Published providers' : 'Published services'}
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.isPending && (
                  <tr>
                    <td colSpan={5}>
                      <SkeletonLines rows={3} />
                    </td>
                  </tr>
                )}
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="r small">{c.position}</td>
                    <td>
                      <span className="stack gap-0">
                        <span className="small strong">{c.name}</span>
                        <span className="xs muted">
                          {c.slug}
                          {c.icon ? ` · icon ${c.icon}` : ''}
                        </span>
                      </span>
                    </td>
                    <td className="r small">{num(c.serviceCount)}</td>
                    <td>{c.visible ? <Badge tone="success">Visible</Badge> : <Badge icon="eye-off">Hidden</Badge>}</td>
                    <td>
                      {canManage && (
                        <span className="row gap-1 nowrap">
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft({ id: c.id, name: c.name, slug: c.slug, icon: c.icon ?? '', position: String(c.position), visible: c.visible })}>
                            Edit<span className="sr-only"> {c.name}</span>
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove.mutate(c)} disabled={remove.isPending}>
                            Delete<span className="sr-only"> {c.name}</span>
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {list.isSuccess && rows.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <EmptyState icon="layout-grid" title="No categories yet">
                        {area === 'booking' ? 'Categories such as Beauty, Health or Car service group the providers.' : area === 'welfare' ? 'Categories such as Elder care, Child care or Home help group the services.' : area === 'post_sale' ? 'Categories such as Screen repair, Battery or Warranty group the services.' : 'Categories such as Android, iOS or Data backup group the services.'}
                      </EmptyState>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>
      <Dialog
        open={!!editing}
        onClose={close}
        title={editing?.id ? `Edit ${editing.name || 'category'}` : 'Add category'}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={() => (setTried(true), editing?.name.trim() && save.mutate(editing))} disabled={save.isPending}>
              {editing?.id ? 'Save category' : 'Add category'}
            </Button>
          </>
        }
      >
        {editing && (
          <>
            {error && <Alert tone="danger" title={error} />}
            <Field label="Name" error={tried && !editing.name.trim() ? 'Enter the category name.' : undefined}>
              <TextInput id="sc-name" value={editing.name} error={tried && !editing.name.trim()} onChange={(e) => setD({ name: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Slug" optional>
                <TextInput id="sc-slug" value={editing.slug} placeholder={slugify(editing.name)} onChange={(e) => setD({ slug: e.target.value })} />
              </Field>
              <Field label="Order">
                <TextInput id="sc-pos" type="number" min={1} value={editing.position} onChange={(e) => setD({ position: e.target.value })} />
              </Field>
            </div>
            <Field label="Icon" optional hint="A Lucide icon name, e.g. scissors or stethoscope">
              <TextInput id="sc-icon" value={editing.icon} onChange={(e) => setD({ icon: e.target.value })} />
            </Field>
            <Switch id="sc-visible" label="Show this category in the app" checked={editing.visible} onChange={(e) => setD({ visible: e.target.checked })} />
          </>
        )}
      </Dialog>
    </>
  );
}

/* ---------------- Reviews ---------------- */

function ReviewsTab({ notify, canManage }: Ctx) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [status, setStatus] = useState<ServiceReview['status'] | ''>('');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['services', 'reviews', status, page],
    queryFn: () => call(api.GET('/api/admin/services/reviews', { params: { query: { status: status || undefined, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  const toggle = useMutation({
    mutationFn: (r: ServiceReview) => call(api.PATCH('/api/admin/services/reviews/{id}', { params: { path: { id: r.id } }, body: { status: r.status === 'visible' ? 'hidden' : 'visible' } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['services'] });
      notify(r.status === 'hidden' ? `${r.authorName}’s review is hidden from customers` : `${r.authorName}’s review shows again`);
    },
    onError: (e) => notify(`The review wasn’t changed: ${errorMessage(e)}`, 'danger'),
  });

  return (
    <section className="card">
      <div className="card-body">
        <div className="toolbar">
          <select className="select" id="sv-st" aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value as ServiceReview['status'] | ''), setPage(1))}>
            <option value="">All reviews</option>
            <option value="visible">Visible</option>
            <option value="hidden">Hidden</option>
          </select>
        </div>
      </div>
      {list.isError && (
        <div className="card-body">
          <LoadError error={list.error} onRetry={() => void list.refetch()} />
        </div>
      )}
      <TableWrap label="Reviews table">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Rating</th>
              <th scope="col">Review</th>
              <th scope="col">Service</th>
              <th scope="col">By</th>
              <th scope="col">Written</th>
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
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="small nowrap" aria-label={`${r.rating} of 5 stars`}>
                  {'★'.repeat(r.rating)}
                  <span className="muted">{'★'.repeat(5 - r.rating)}</span>
                </td>
                <td className="small">
                  <span className="truncate" style={{ display: 'block', maxWidth: 320 }}>
                    {r.text ?? <span className="muted">No text</span>}
                  </span>
                </td>
                <td className="small">{r.serviceTitle}</td>
                <td className="small">{r.authorName}</td>
                <td className="small">{dateTime(r.createdAt)}</td>
                <td>{r.status === 'visible' ? <Badge tone="success">Visible</Badge> : <Badge icon="eye-off">Hidden</Badge>}</td>
                <td>
                  {canManage && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggle.mutate(r)} disabled={toggle.isPending}>
                      {r.status === 'visible' ? 'Hide' : 'Show'}
                      <span className="sr-only"> review by {r.authorName}</span>
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {list.isSuccess && rows.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState icon="star" title="No reviews here">
                    Customers rate a service after their request is completed.
                  </EmptyState>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableWrap>
      <div className="card-foot between">
        <span className="xs muted">{plural(rows.length, 'review')} on this page · hiding one takes it out of the service’s rating.</span>
        <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
      </div>
    </section>
  );
}
