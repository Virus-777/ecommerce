import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { Alert, announce, Badge, Button, Dialog, Drawer, EmptyState, Field, Img, KeyValue, LogoTile, PageHeader, Pager, SearchInput, Select, StatusBadge, Switch, TableWrap, Tabs, Textarea, TextInput } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { dateTime, LoadError, SkeletonLines } from '@/app/parts';
import { initialsOf, tintOf } from './data/categories';
import { DeptPage, INQUIRY_STATUS, PAGE_SIZE, PhotosField, PictureField, SHOWN_STATUS, slugify, totalPagesOf, type Company, type CompanyInput, type Industry, type Inquiry, type MediaRef } from './data/departments';

// Admin › Departments › Companies (designed in React from the Marketly Departments canvas): the company directory of
// the app. Tabs: Companies | Industries | Inquiries. API: /api/admin/departments/{companies,industries,inquiries}.
// Inquiries come from customers on a company page; staff pass them on and note what was done.

type Tab = '' | 'industries' | 'inquiries';
type Notify = (title: string, tone?: 'success' | 'danger') => void;
const MAX_PHOTOS = 12;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s/]+\.\S+$/i;

export default function DeptCompanies() {
  const { api } = useApi();
  const { can } = useStaffSession();
  const canView = can('departments.view');
  const canEdit = can('departments.companies.manage');
  const [view, setView] = useView<Exclude<Tab, ''>>();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; title: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const notify: Notify = (title, tone = 'success') => {
    setNotice({ tone, title });
    announce(title);
  };
  const industries = useQuery({ queryKey: ['departments', 'industries'], enabled: canView, queryFn: () => call(api.GET('/api/admin/departments/industries')) });
  const newInquiries = useQuery({ queryKey: ['departments', 'inquiries', 'new-count'], enabled: canView, queryFn: () => call(api.GET('/api/admin/departments/inquiries', { params: { query: { status: 'new', limit: 1 } } })) });

  return (
    <DeptPage active="dept-companies" title="Companies" canView={canView}>
      <PageHeader
        crumbs={[{ label: 'Departments' }, { label: 'Companies' }]}
        title="Companies"
        sub={canEdit ? 'Company pages of the app’s directory · the carousel at the top is the companies_top ad placement' : 'View only: editing needs the Companies permission'}
        actions={
          canEdit &&
          !view && (
            <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
              Add company
            </Button>
          )
        }
      />
      <Tabs
        items={[
          { value: '', label: 'Companies' },
          { value: 'industries', label: 'Industries', count: industries.data?.length },
          { value: 'inquiries', label: 'Inquiries', count: (newInquiries.data as { total?: number } | undefined)?.total || undefined },
        ]}
        active={view}
        onChange={(v) => {
          setNotice(null);
          setView(v as Tab);
        }}
        label="Companies"
      />
      {notice && <Alert tone={notice.tone} title={notice.title} />}
      {view === 'industries' ? <IndustriesTab notify={notify} canEdit={canEdit} /> : view === 'inquiries' ? <InquiriesTab notify={notify} canEdit={canEdit} /> : <CompaniesTab notify={notify} canEdit={canEdit} industries={industries.data ?? []} adding={adding} setAdding={setAdding} />}
    </DeptPage>
  );
}

/* ---------------- Companies ---------------- */

type CompanyDraft = {
  id: string; name: string; slug: string; logo: MediaRef | null; industryId: string; city: string; tagline: string; verified: boolean; description: string; photos: MediaRef[];
  founded: string; employees: string; phone: string; email: string; website: string; address: string; lat: string; lng: string; status: Company['status']; position: string;
};
const draftOf = (c?: Company): CompanyDraft => ({
  id: c?.id ?? '',
  name: c?.name ?? '',
  slug: c?.slug ?? '',
  logo: c?.logo ?? null,
  industryId: c?.industry?.id ?? '',
  city: c?.city ?? '',
  tagline: c?.tagline ?? '',
  verified: c?.verified ?? false,
  description: c?.description ?? '',
  photos: c?.photos ?? [],
  founded: c?.founded ? String(c.founded) : '',
  employees: c?.employees ?? '',
  phone: c?.contacts.phone ?? '',
  email: c?.contacts.email ?? '',
  website: c?.contacts.website ?? '',
  address: c?.contacts.address ?? '',
  lat: c?.location ? String(c.location.lat) : '',
  lng: c?.location ? String(c.location.lng) : '',
  status: c?.status ?? 'hidden',
  position: c ? String(c.position) : '',
});

function problemsOf(d: CompanyDraft) {
  const year = new Date().getFullYear();
  const lat = d.lat.trim() ? Number(d.lat) : null;
  const lng = d.lng.trim() ? Number(d.lng) : null;
  return {
    name: d.name.trim() ? '' : 'Enter the company name.',
    tagline: d.tagline.trim().length > 120 ? 'Use at most 120 characters.' : '',
    founded: d.founded.trim() && !(Number.isInteger(Number(d.founded)) && Number(d.founded) >= 1800 && Number(d.founded) <= year) ? `Enter a year from 1800 to ${year}.` : '',
    email: d.email.trim() && !EMAIL.test(d.email.trim()) ? 'Enter a valid email address.' : '',
    website: d.website.trim() && !URL_RE.test(d.website.trim()) ? 'Use a full address, e.g. https://example.com.' : '',
    location:
      (lat === null) !== (lng === null)
        ? 'Enter both the latitude and the longitude, or neither.'
        : lat !== null && (Number.isNaN(lat) || lat < -90 || lat > 90 || Number.isNaN(lng!) || lng! < -180 || lng! > 180)
          ? 'Latitude goes from −90 to 90 and longitude from −180 to 180.'
          : '',
  };
}

function CompaniesTab({ notify, canEdit, industries, adding, setAdding }: { notify: Notify; canEdit: boolean; industries: Industry[]; adding: boolean; setAdding: (v: boolean) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [industryId, setIndustryId] = useState('');
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<CompanyDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');

  const query = { q: q.trim() || undefined, status: (status || undefined) as Company['status'] | undefined, industryId: industryId || undefined };
  const list = useQuery({
    queryKey: ['departments', 'companies', query, page],
    queryFn: () => call(api.GET('/api/admin/departments/companies', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];

  const editing = draft ?? (adding ? draftOf() : null);
  const setD = (patch: Partial<CompanyDraft>) => editing && setDraft({ ...editing, ...patch });
  const close = () => (setDraft(null), setAdding(false), setTried(false), setError(''));
  const errs = tried && editing ? problemsOf(editing) : null;

  const save = useMutation({
    mutationFn: (d: CompanyDraft) => {
      const body: CompanyInput = {
        name: d.name.trim(),
        slug: d.slug.trim() || null,
        logo: d.logo,
        industryId: d.industryId || null,
        city: d.city.trim() || null,
        tagline: d.tagline.trim() || null,
        verified: d.verified,
        description: d.description.trim() || null,
        photos: d.photos,
        founded: d.founded.trim() ? Number(d.founded) : null,
        employees: d.employees.trim() || null,
        contacts: { phone: d.phone.trim() || null, email: d.email.trim() || null, website: d.website.trim() || null, address: d.address.trim() || null },
        location: d.lat.trim() && d.lng.trim() ? { lat: Number(d.lat), lng: Number(d.lng) } : null,
        status: d.status,
        position: d.position.trim() ? Number(d.position) : null,
      };
      return d.id ? call(api.PATCH('/api/admin/departments/companies/{id}', { params: { path: { id: d.id } }, body })) : call(api.POST('/api/admin/departments/companies', { body }));
    },
    onSuccess: (c, d) => {
      void qc.invalidateQueries({ queryKey: ['departments'] });
      notify(d.id ? `${c.name} saved${c.status === 'hidden' ? ' (hidden from customers)' : ''}` : `${c.name} added${c.status === 'hidden' ? ' as hidden: publish it when it is ready' : ''}`);
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (d: CompanyDraft) => call(api.DELETE('/api/admin/departments/companies/{id}', { params: { path: { id: d.id } } })),
    onSuccess: (_r, d) => {
      void qc.invalidateQueries({ queryKey: ['departments'] });
      notify(`${d.name} deleted with its inquiries`);
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = () => {
    if (!editing) return;
    setTried(true);
    if (Object.values(problemsOf(editing)).some(Boolean)) return;
    save.mutate(editing);
  };

  return (
    <>
      <section className="card">
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="dc-q" placeholder="Search companies" value={q} onChange={(v) => (setQ(v), setPage(1))} label="Search companies" />
            <select className="select" id="dc-st" aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
              <option value="">All statuses</option>
              <option value="published">Published</option>
              <option value="hidden">Hidden</option>
            </select>
            <select className="select" id="dc-ind" aria-label="Industry" value={industryId} onChange={(e) => (setIndustryId(e.target.value), setPage(1))}>
              <option value="">All industries</option>
              {industries.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
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
        <TableWrap label="Companies table">
          <table className="table">
            <thead>
              <tr>
                <th className="r" scope="col">
                  Order
                </th>
                <th scope="col">Company</th>
                <th scope="col">Industry</th>
                <th scope="col">City</th>
                <th scope="col">Status</th>
                <th className="r" scope="col">
                  New inquiries
                </th>
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
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="r small">{c.position}</td>
                  <td>
                    <span className="row nowrap gap-3">
                      {c.logo ? <Img icon="building-2" src={c.logo.url} alt="" className="tiny" /> : <LogoTile initials={initialsOf(c.name)} tint={tintOf(c.name)} size="sm" />}
                      <span className="stack gap-0">
                        <span className="row gap-2">
                          <span className="small strong">{c.name}</span>
                          {c.verified && (
                            <Badge tone="info" icon="badge-check">
                              Verified
                            </Badge>
                          )}
                        </span>
                        <span className="xs muted">{c.tagline ?? `/companies/${c.slug}`}</span>
                      </span>
                    </span>
                  </td>
                  <td className="small">{c.industry?.name ?? '—'}</td>
                  <td className="small">{c.city ?? '—'}</td>
                  <td>
                    <StatusBadge status={SHOWN_STATUS[c.status]} tone={c.status === 'published' ? 'success' : ''} />
                  </td>
                  <td className="r small">{c.openInquiryCount ? <Badge tone="brand">{c.openInquiryCount}</Badge> : '0'}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setTried(false), setError(''), setDraft(draftOf(c)))}>
                      {canEdit ? 'Edit' : 'View'}
                      <span className="sr-only"> {c.name}</span>
                    </button>
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <EmptyState icon="building-2" title={q || status || industryId ? 'No companies match' : 'No companies yet'}>
                      {q || status || industryId ? 'Try another search or clear the filters.' : 'Add the first company page with “Add company”.'}
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <div className="card-foot between">
          <span className="xs muted">The app lists published companies in this order.</span>
          <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
        </div>
      </section>

      <Drawer
        open={!!editing}
        onClose={close}
        className="wide"
        title={editing?.id ? `Edit company: ${editing.name || 'Untitled'}` : 'Add company'}
        foot={
          canEdit ? (
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
                {editing?.id ? 'Save company' : 'Add company'}
              </Button>
            </>
          ) : undefined
        }
      >
        {editing && (
          <fieldset className="stack gap-4" disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
            {error && (
              <Alert tone="danger" title="The company wasn’t saved">
                {error}
              </Alert>
            )}
            <Field label="Name" error={errs?.name}>
              <TextInput id="dc-name" value={editing.name} error={!!errs?.name} onChange={(e) => setD({ name: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Slug" optional hint={`/companies/${editing.slug.trim() || slugify(editing.name) || '…'}`}>
                <TextInput id="dc-slug" value={editing.slug} placeholder={slugify(editing.name)} onChange={(e) => setD({ slug: e.target.value })} />
              </Field>
              <Field label="Industry" optional>
                <Select id="dc-industry" value={editing.industryId} options={[{ value: '', label: 'No industry' }, ...industries.map((i) => ({ value: i.id, label: i.visible ? i.name : `${i.name} (hidden)` }))]} onChange={(e) => setD({ industryId: e.target.value })} />
              </Field>
            </div>
            <Field label="Tagline" optional hint="One line on the company card, up to 120 characters" error={errs?.tagline}>
              <TextInput id="dc-tag" value={editing.tagline} error={!!errs?.tagline} onChange={(e) => setD({ tagline: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="City" optional>
                <TextInput id="dc-city" value={editing.city} onChange={(e) => setD({ city: e.target.value })} />
              </Field>
              <Field label="Founded" optional error={errs?.founded}>
                <TextInput id="dc-founded" inputMode="numeric" value={editing.founded} placeholder="e.g. 1998" error={!!errs?.founded} onChange={(e) => setD({ founded: e.target.value })} />
              </Field>
            </div>
            <div className="grid md2 gap-3">
              <Field label="Employees" optional>
                <TextInput id="dc-emp" value={editing.employees} placeholder="e.g. 50–100" onChange={(e) => setD({ employees: e.target.value })} />
              </Field>
              <Field label="Order" optional hint="Lower numbers show first">
                <TextInput id="dc-pos" type="number" min={1} value={editing.position} onChange={(e) => setD({ position: e.target.value })} />
              </Field>
            </div>
            <Switch id="dc-verified" label="Verified by Marketly (shows the Verified mark)" checked={editing.verified} onChange={(e) => setD({ verified: e.target.checked })} />
            <Field label="Description" optional hint="Plain text; a blank line starts a new paragraph">
              <Textarea id="dc-desc" rows={5} value={editing.description} onChange={(e) => setD({ description: e.target.value })} />
            </Field>
            <PictureField label="Logo" shape="square" icon="building-2" value={editing.logo} alt={editing.name.trim()} hint="Square, saved at 600 × 600. Without one, the app shows initials." disabled={!canEdit} onChange={(logo) => setD({ logo })} />
            <PhotosField photos={editing.photos} max={MAX_PHOTOS} alt={editing.name.trim()} disabled={!canEdit} onChange={(photos) => setD({ photos })} />
            <h3 className="h4">Contact</h3>
            <div className="grid md2 gap-3">
              <Field label="Phone" optional>
                <TextInput id="dc-phone" type="tel" value={editing.phone} onChange={(e) => setD({ phone: e.target.value })} />
              </Field>
              <Field label="Email" optional error={errs?.email}>
                <TextInput id="dc-email" type="email" value={editing.email} error={!!errs?.email} onChange={(e) => setD({ email: e.target.value })} />
              </Field>
            </div>
            <Field label="Website" optional error={errs?.website}>
              <TextInput id="dc-web" type="url" value={editing.website} placeholder="https://" error={!!errs?.website} onChange={(e) => setD({ website: e.target.value })} />
            </Field>
            <Field label="Address" optional>
              <Textarea id="dc-addr" rows={2} value={editing.address} onChange={(e) => setD({ address: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Latitude" optional hint="For the map, e.g. 45.5231" error={errs?.location}>
                <TextInput id="dc-lat" inputMode="decimal" value={editing.lat} error={!!errs?.location} onChange={(e) => setD({ lat: e.target.value })} />
              </Field>
              <Field label="Longitude" optional hint="e.g. -122.6765">
                <TextInput id="dc-lng" inputMode="decimal" value={editing.lng} error={!!errs?.location} onChange={(e) => setD({ lng: e.target.value })} />
              </Field>
            </div>
            <Field label="Status">
              <Select id="dc-status" value={editing.status} options={[{ value: 'published', label: 'Published: customers see it' }, { value: 'hidden', label: 'Hidden' }]} onChange={(e) => setD({ status: e.target.value as Company['status'] })} />
            </Field>
          </fieldset>
        )}
      </Drawer>
    </>
  );
}

/* ---------------- Industries ---------------- */

type IndustryDraft = { id: string; name: string; slug: string; position: string; visible: boolean };

function IndustriesTab({ notify, canEdit }: { notify: Notify; canEdit: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['departments', 'industries'], queryFn: () => call(api.GET('/api/admin/departments/industries')) });
  const rows = [...(list.data ?? [])].sort((a, b) => a.position - b.position);
  const [draft, setDraft] = useState<IndustryDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const close = () => (setDraft(null), setTried(false), setError(''));
  const setD = (patch: Partial<IndustryDraft>) => draft && setDraft({ ...draft, ...patch });

  const save = useMutation({
    mutationFn: (d: IndustryDraft) => {
      const body = { name: d.name.trim(), slug: d.slug.trim() || null, position: d.position ? Number(d.position) : null, visible: d.visible };
      return d.id ? call(api.PATCH('/api/admin/departments/industries/{id}', { params: { path: { id: d.id } }, body })) : call(api.POST('/api/admin/departments/industries', { body }));
    },
    onSuccess: (i, d) => {
      void qc.invalidateQueries({ queryKey: ['departments'] });
      notify(d.id ? `${i.name} saved` : `${i.name} added`);
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (i: Industry) => call(api.DELETE('/api/admin/departments/industries/{id}', { params: { path: { id: i.id } } })),
    onSuccess: (_r, i) => {
      void qc.invalidateQueries({ queryKey: ['departments'] });
      notify(`${i.name} deleted`);
    },
    onError: (e, i) => notify(`${i.name} wasn’t deleted: ${errorMessage(e)}`, 'danger'),
  });

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">Industries</h2>
            <span className="xs muted">The app shows visible industries as chips above the companies, in this order</span>
          </div>
          {canEdit && (
            <Button size="sm" icon="plus" onClick={() => setDraft({ id: '', name: '', slug: '', position: String(rows.length + 1), visible: true })}>
              Add industry
            </Button>
          )}
        </div>
        {list.isError ? (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : (
          <TableWrap label="Industries table">
            <table className="table">
              <thead>
                <tr>
                  <th className="r" scope="col">
                    Order
                  </th>
                  <th scope="col">Industry</th>
                  <th className="r" scope="col">
                    Published companies
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
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td className="r small">{i.position}</td>
                    <td>
                      <span className="stack gap-0">
                        <span className="small strong">{i.name}</span>
                        <span className="xs muted">{i.slug}</span>
                      </span>
                    </td>
                    <td className="r small">{num(i.companyCount)}</td>
                    <td>{i.visible ? <Badge tone="success">Visible</Badge> : <Badge icon="eye-off">Hidden</Badge>}</td>
                    <td>
                      {canEdit && (
                        <span className="row gap-1 nowrap">
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft({ id: i.id, name: i.name, slug: i.slug, position: String(i.position), visible: i.visible })}>
                            Edit<span className="sr-only"> {i.name}</span>
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove.mutate(i)} disabled={remove.isPending}>
                            Delete<span className="sr-only"> {i.name}</span>
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {list.isSuccess && rows.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <EmptyState icon="factory" title="No industries yet">
                        Industries such as Manufacturing, Technology or Logistics group the companies in the app.
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
        open={!!draft}
        onClose={close}
        title={draft?.id ? `Edit ${draft.name || 'industry'}` : 'Add industry'}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={() => (setTried(true), draft?.name.trim() && save.mutate(draft))} disabled={save.isPending}>
              {draft?.id ? 'Save industry' : 'Add industry'}
            </Button>
          </>
        }
      >
        {draft && (
          <>
            {error && <Alert tone="danger" title={error} />}
            <Field label="Name" error={tried && !draft.name.trim() ? 'Enter the industry name.' : undefined}>
              <TextInput id="di-name" value={draft.name} error={tried && !draft.name.trim()} onChange={(e) => setD({ name: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Slug" optional>
                <TextInput id="di-slug" value={draft.slug} placeholder={slugify(draft.name)} onChange={(e) => setD({ slug: e.target.value })} />
              </Field>
              <Field label="Order">
                <TextInput id="di-pos" type="number" min={1} value={draft.position} onChange={(e) => setD({ position: e.target.value })} />
              </Field>
            </div>
            <Switch id="di-visible" label="Show this industry in the app" checked={draft.visible} onChange={(e) => setD({ visible: e.target.checked })} />
          </>
        )}
      </Dialog>
    </>
  );
}

/* ---------------- Inquiries ---------------- */

function InquiriesTab({ notify, canEdit }: { notify: Notify; canEdit: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [status, setStatus] = useState<Inquiry['status'] | ''>('new');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Inquiry | null>(null);
  const [note, setNote] = useState('');
  const [next, setNext] = useState<Inquiry['status']>('new');
  const [error, setError] = useState('');
  const list = useQuery({
    queryKey: ['departments', 'inquiries', status, page],
    queryFn: () => call(api.GET('/api/admin/departments/inquiries', { params: { query: { status: status || undefined, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  const show = (i: Inquiry) => (setOpen(i), setNote(i.staffNote ?? ''), setNext(i.status), setError(''));
  const save = useMutation({
    mutationFn: (i: Inquiry) => call(api.PATCH('/api/admin/departments/inquiries/{id}', { params: { path: { id: i.id } }, body: { status: next, staffNote: note.trim() || null } })),
    onSuccess: (i) => {
      void qc.invalidateQueries({ queryKey: ['departments'] });
      notify(`Inquiry from ${i.name} to ${i.companyName} is ${INQUIRY_STATUS[i.status].toLowerCase()}`);
      setOpen(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <>
      <section className="card">
        <div className="card-body">
          <div className="toolbar">
            <select className="select" id="dq-st" aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value as Inquiry['status'] | ''), setPage(1))}>
              <option value="">All inquiries</option>
              {(Object.keys(INQUIRY_STATUS) as Inquiry['status'][]).map((s) => (
                <option key={s} value={s}>
                  {INQUIRY_STATUS[s]}
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
        <TableWrap label="Inquiries table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">From</th>
                <th scope="col">Company</th>
                <th scope="col">Message</th>
                <th scope="col">Received</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.isPending && (
                <tr>
                  <td colSpan={6}>
                    <SkeletonLines rows={4} />
                  </td>
                </tr>
              )}
              {rows.map((i) => (
                <tr key={i.id}>
                  <td>
                    <span className="stack gap-0">
                      <span className="small strong">{i.name}</span>
                      <span className="xs muted">{i.email}</span>
                    </span>
                  </td>
                  <td className="small">{i.companyName}</td>
                  <td className="small">
                    <span className="truncate" style={{ display: 'block', maxWidth: 320 }}>
                      {i.message}
                    </span>
                  </td>
                  <td className="small">{dateTime(i.createdAt)}</td>
                  <td>
                    <StatusBadge status={INQUIRY_STATUS[i.status]} tone={i.status === 'new' ? 'brand' : i.status === 'replied' ? 'success' : ''} />
                  </td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => show(i)}>
                      Open<span className="sr-only"> inquiry from {i.name}</span>
                    </button>
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <EmptyState icon="mail" title={status === 'new' ? 'No new inquiries' : 'No inquiries here'}>
                      Customers send inquiries from a company page in the app.
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <div className="card-foot between">
          <span className="xs muted">Pass each inquiry on to the company, then mark it replied or closed.</span>
          <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
        </div>
      </section>

      <Drawer
        open={!!open}
        onClose={() => setOpen(null)}
        title={open ? `Inquiry to ${open.companyName}` : 'Inquiry'}
        foot={
          canEdit ? (
            <>
              <span className="grow" />
              <Button variant="ghost" size="sm" onClick={() => setOpen(null)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => open && save.mutate(open)} disabled={save.isPending}>
                Save
              </Button>
            </>
          ) : undefined
        }
      >
        {open && (
          <>
            {error && <Alert tone="danger" title={error} />}
            <KeyValue
              pairs={[
                ['From', open.name],
                ['Email', <a href={`mailto:${open.email}`}>{open.email}</a>],
                ['Phone', open.phone ? <a href={`tel:${open.phone}`}>{open.phone}</a> : '—'],
                ['Received', dateTime(open.createdAt)],
                ['Signed-in customer', open.customerId ? 'Yes' : 'No'],
              ]}
            />
            <div className="stack gap-1">
              <span className="label">Message</span>
              <p className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                {open.message}
              </p>
            </div>
            <Field label="Status">
              <Select id="dq-next" value={next} disabled={!canEdit} options={(Object.keys(INQUIRY_STATUS) as Inquiry['status'][]).map((s) => ({ value: s, label: INQUIRY_STATUS[s] }))} onChange={(e) => setNext(e.target.value as Inquiry['status'])} />
            </Field>
            <Field label="Staff note" optional hint="Only staff see it, e.g. Forwarded to sales@northwind.example on Oct 21">
              <Textarea id="dq-note" rows={3} value={note} disabled={!canEdit} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </>
        )}
      </Drawer>
    </>
  );
}
