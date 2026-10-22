import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type DragEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { assetPreview, call, errorMessage, uploadMedia, useApi } from '@marketly/web-shared/api';
import { fromZonedInput, zonedInput } from '@marketly/web-shared/lib/dates';
import { formatMoney, num } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Button, Checkbox, DateTimeField, Dialog, EmptyState, Field, Icon, IconButton, Img, Meter, PageHeader, SegmentedControl, Select, Switch, Textarea, TextInput } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { dateTime, LoadError, shortDate, SkeletonLines, TZ } from '@/app/parts';
import { appHref, useCategories } from './DeptSoftware';
import {
  APP_STATUS, codeOf, DeptPage, fieldErrorsOf, LinesField, moneyText, PictureField, PLATFORMS, plural, sizeLabel, slugify, toMoney,
  type AppAdmin, type AppInput, type AppPermission, type AppStatus, type MediaRef, type Platform, type VersionEntry,
} from './data/departments';

// Admin › Departments › Softwares › Edit app (designed from the Marketly Departments canvas: AdminAppEdit). One page for
// a new app (/departments/software/apps/new) and an existing one. API: GET/POST/PATCH/DELETE /api/admin/software/apps;
// the thumbnail and screenshots are content_image uploads, the package and databases software_package uploads (media
// module). Publishing needs a package, a thumbnail and, for a paid app, a price (VALIDATION_FAILED otherwise).

type FileDraft = { id: string; name: string; sizeBytes: number; uploadedAt: string | null };
type Draft = {
  title: string; slug: string; companyName: string; companyId: string; categoryId: string; subcategory: string; brief: string; icon: MediaRef | null; screenshots: MediaRef[]; description: string; moreDescription: string; whatYouGet: string[];
  free: boolean; price: string; salePrice: string; saleEndsAt: string; licenceLabel: string; licenceDevices: string; pkg: FileDraft | null; databases: FileDraft[]; databasesNote: string;
  version: string; releasedAt: string; whatsNew: string; versionHistory: VersionEntry[]; platforms: Platform[]; platformLabels: string[]; minRequirements: string; notice: string; permissions: AppPermission[];
  status: AppStatus; showInDepartment: boolean; allowReviews: boolean; position: string;
};
type Patch = Partial<Draft> | ((d: Draft) => Partial<Draft>);
const BRIEF_MAX = 60;
const MAX_SHOTS = 10;
const LIST = href('admin/departments-software');

const fileOf = (f: AppAdmin['files']['databases'][number]): FileDraft => ({ id: f.id, name: f.name, sizeBytes: f.sizeBytes, uploadedAt: f.uploadedAt ?? null });
const draftOf = (a?: AppAdmin): Draft => ({
  title: a?.title ?? '',
  slug: a?.slug ?? '',
  companyName: a?.company.name ?? '',
  companyId: a?.company.companyId ?? '',
  categoryId: a?.categoryId ?? '',
  subcategory: a?.subcategory ?? '',
  brief: a?.brief ?? '',
  icon: a?.icon ?? null,
  screenshots: a?.screenshots ?? [],
  description: a?.description ?? '',
  moreDescription: a?.moreDescription ?? '',
  whatYouGet: a?.whatYouGet ?? [],
  free: a?.price.free ?? true,
  price: moneyText(a?.price.amount),
  salePrice: moneyText(a?.price.saleAmount),
  saleEndsAt: zonedInput(a?.price.saleEndsAt, TZ),
  licenceLabel: a?.licenceLabel ?? '',
  licenceDevices: a?.licenceDevices != null ? String(a.licenceDevices) : '',
  pkg: a?.files.package ? fileOf(a.files.package) : null,
  databases: (a?.files.databases ?? []).map(fileOf),
  databasesNote: a?.files.databasesNote ?? '',
  version: a?.version ?? '',
  releasedAt: a?.releasedAt ?? '',
  whatsNew: a?.whatsNew ?? '',
  versionHistory: a?.versionHistory ?? [],
  platforms: a?.platforms ?? [],
  platformLabels: a?.platformLabels ?? [],
  minRequirements: a?.minRequirements ?? '',
  notice: a?.notice ?? '',
  permissions: a?.permissions ?? [],
  status: a?.status ?? 'draft',
  showInDepartment: a?.showInDepartment ?? true,
  allowReviews: a?.allowReviews ?? true,
  position: a ? String(a.position) : '',
});

type FieldKey = keyof Draft;
/** What is missing before saving (publishing needs more: a package and a thumbnail) */
function problemsOf(d: Draft): Partial<Record<FieldKey, string>> {
  const price = toMoney(d.price);
  const sale = d.salePrice.trim() ? toMoney(d.salePrice) : null;
  const out: Partial<Record<FieldKey, string>> = {
    title: d.title.trim() ? '' : 'Enter the app title.',
    companyName: d.companyName.trim() ? '' : 'Enter the company that makes it.',
    categoryId: d.categoryId ? '' : 'Pick a category.',
    brief: !d.brief.trim() ? 'Enter a brief description for the app lists.' : d.brief.trim().length > BRIEF_MAX ? `Keep it to ${BRIEF_MAX} characters.` : '',
    description: d.description.trim() ? '' : 'Enter the description.',
    price: d.free ? '' : !price || price.amount <= 0 ? 'Enter the price in dollars, e.g. 29.99.' : '',
    salePrice: d.free || !d.salePrice.trim() ? '' : !sale || sale.amount <= 0 ? 'Enter the sale price in dollars.' : price && sale.amount >= price.amount ? 'The sale price must be below the price.' : '',
    saleEndsAt: !d.free && d.salePrice.trim() && !d.saleEndsAt ? 'Pick when the sale ends.' : '',
    licenceDevices: d.free || !d.licenceDevices.trim() || (/^\d+$/.test(d.licenceDevices.trim()) && Number(d.licenceDevices) >= 1 && Number(d.licenceDevices) <= 100) ? '' : 'Enter how many devices one licence key unlocks, 1 to 100, or leave it empty for no limit.',
    platforms: d.platforms.length ? '' : 'Tick the platforms it runs on.',
    pkg: d.status === 'published' && !d.pkg ? 'Publishing needs an app package.' : '',
    icon: d.status === 'published' && !d.icon ? 'Publishing needs a thumbnail.' : '',
    versionHistory: d.versionHistory.some((v) => !v.version.trim() || !v.date) ? 'Every earlier version needs a version number and a date.' : '',
    permissions: d.permissions.some((p) => !p.name.trim() || !p.desc.trim()) ? 'Every permission needs a name and what it is for.' : '',
  };
  return out;
}
/** API field paths (details.issues) → form fields */
const FIELD_OF: Record<string, FieldKey> = { iconId: 'icon', screenshotIds: 'screenshots', packageId: 'pkg', databaseIds: 'databases', company: 'companyName', free: 'price' };
const fieldOfPath = (path: string): FieldKey => {
  const [head, sub] = path.split('.');
  if (head === 'company' && sub === 'companyId') return 'companyId';
  return FIELD_OF[head] ?? (head as FieldKey);
};

export default function DeptSoftwareApp() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const { api } = useApi();
  const { can } = useStaffSession();
  const canView = can('software.view');
  const canManage = can('software.manage');
  const app = useQuery({ queryKey: ['software', 'app', id], enabled: canView && !isNew, queryFn: () => call(api.GET('/api/admin/software/apps/{id}', { params: { path: { id } } })) });
  const crumbs = [{ label: 'Departments' }, { label: 'Softwares', to: LIST }];

  return (
    <DeptPage active="dept-software" title={isNew ? 'Add app' : 'Edit app'} canView={canView} need="See apps, packs, purchases and reviews in Softwares">
      {isNew || app.data ? (
        <AppEditor key={app.data?.id ?? 'new'} app={app.data} canManage={canManage} />
      ) : app.isError ? (
        <>
          <PageHeader crumbs={[...crumbs, { label: 'App' }]} title="Edit app" />
          {codeOf(app.error) === 'NOT_FOUND' ? (
            <section className="card">
              <div className="card-body">
                <EmptyState icon="app-window" title="This app doesn’t exist" as="h2" action={<Button to={LIST}>Back to Softwares</Button>}>
                  It may have been deleted.
                </EmptyState>
              </div>
            </section>
          ) : (
            <LoadError error={app.error} onRetry={() => void app.refetch()} />
          )}
        </>
      ) : (
        <>
          <PageHeader crumbs={[...crumbs, { label: 'App' }]} title="Edit app" />
          <SkeletonLines rows={10} />
        </>
      )}
    </DeptPage>
  );
}

function AppEditor({ app, canManage }: { app?: AppAdmin; canManage: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // the notice of a just-added app survives the switch from /apps/new to the app's own address
  const added = (useLocation().state as { notice?: string } | null)?.notice ?? '';
  const { can } = useStaffSession();
  const categories = useCategories();
  const companies = useQuery({ queryKey: ['departments', 'companies', 'pick'], enabled: canManage && can('departments.view'), queryFn: () => call(api.GET('/api/admin/departments/companies', { params: { query: { limit: 100 } } })) });
  const base = draftOf(app);
  const baseRef = useRef(base);
  baseRef.current = base;
  const [draft, setDraft] = useState<Draft | null>(null);
  const d = draft ?? base;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(base);
  const setD = (patch: Patch) => setDraft((cur) => {
    const c = cur ?? baseRef.current;
    return { ...c, ...(typeof patch === 'function' ? patch(c) : patch) };
  });
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<Partial<Record<FieldKey, string>>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(added);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const client = tried ? problemsOf(d) : {};
  const err = (k: FieldKey) => client[k] || server[k] || '';
  const firstProblem = Object.values(client).find(Boolean) || Object.values(server).find(Boolean) || '';
  const disabled = !canManage;

  const save = useMutation({
    mutationFn: (x: Draft) => {
      const body: AppInput = {
        title: x.title.trim(),
        slug: x.slug.trim() || null,
        company: { name: x.companyName.trim(), companyId: x.companyId || null },
        categoryId: x.categoryId,
        subcategory: x.subcategory.trim() || null,
        brief: x.brief.trim(),
        iconId: x.icon?.id ?? null,
        screenshotIds: x.screenshots.map((s) => s.id),
        description: x.description.trim(),
        moreDescription: x.moreDescription.trim() || null,
        whatYouGet: x.whatYouGet,
        free: x.free,
        price: x.free ? null : toMoney(x.price),
        salePrice: x.free ? null : toMoney(x.salePrice),
        saleEndsAt: x.free || !x.salePrice.trim() ? null : fromZonedInput(x.saleEndsAt, TZ),
        licenceLabel: x.licenceLabel.trim() || null,
        licenceDevices: x.free || !x.licenceDevices.trim() ? null : Number(x.licenceDevices),
        packageId: x.pkg?.id ?? null,
        databaseIds: x.databases.map((f) => f.id),
        databasesNote: x.databasesNote.trim() || null,
        version: x.version.trim() || null,
        releasedAt: x.releasedAt || null,
        whatsNew: x.whatsNew.trim() || null,
        versionHistory: x.versionHistory.map((v) => ({ version: v.version.trim(), date: v.date, notes: v.notes?.trim() || null })),
        platforms: x.platforms,
        platformLabels: x.platformLabels,
        minRequirements: x.minRequirements.trim() || null,
        notice: x.notice.trim() || null,
        permissions: x.permissions.map((p) => ({ name: p.name.trim(), desc: p.desc.trim() })),
        status: x.status,
        showInDepartment: x.showInDepartment,
        allowReviews: x.allowReviews,
        position: x.position.trim() ? Number(x.position) : null,
      };
      return app ? call(api.PATCH('/api/admin/software/apps/{id}', { params: { path: { id: app.id } }, body })) : call(api.POST('/api/admin/software/apps', { body }));
    },
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ['software'] });
      qc.setQueryData(['software', 'app', a.id], a);
      const msg = app ? `${a.title} saved${a.status === 'published' ? ': the app page shows the changes now' : ` (${APP_STATUS[a.status].label.toLowerCase()})`}` : `${a.title} added as ${APP_STATUS[a.status].label.toLowerCase()}`;
      announce(msg);
      setDraft(null);
      setTried(false);
      setServer({});
      setError('');
      if (app) setNotice(msg);
      else navigate(appHref(a.id), { replace: true, state: { notice: a.status === 'published' ? msg : `${msg}: publish it when it is ready` } });
    },
    onError: (e) => {
      const fe = fieldErrorsOf(e);
      const mapped: Partial<Record<FieldKey, string>> = {};
      Object.entries(fe).forEach(([path, msg]) => (mapped[fieldOfPath(path)] ||= msg));
      setServer(mapped);
      setNotice('');
      setError(codeOf(e) === 'SLUG_TAKEN' ? 'Another app already uses this slug. Change the slug.' : codeOf(e) === 'FILE_NOT_READY' ? 'An uploaded file isn’t ready yet or isn’t a software package. Wait for the check to finish or upload it again.' : Object.keys(fe).length ? 'Fix the fields marked below.' : errorMessage(e));
    },
  });
  const remove = useMutation({
    mutationFn: () => call(api.DELETE('/api/admin/software/apps/{id}', { params: { path: { id: app!.id } } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['software'] });
      announce(`${app!.title} deleted`);
      navigate(LIST);
    },
    onError: (e) => {
      setConfirmDelete(false);
      setError(codeOf(e) === 'IN_USE' ? 'Customers own this app, so it can’t be deleted. Set the status to Hidden instead.' : errorMessage(e));
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
  const discard = () => {
    if (!app) return navigate(LIST);
    setDraft(null);
    setTried(false);
    setServer({});
    setError('');
  };

  const cats = categories.data ?? [];
  const cat = cats.find((c) => c.id === d.categoryId);
  const sizeBytes = (d.pkg?.sizeBytes ?? 0) + d.databases.reduce((s, f) => s + f.sizeBytes, 0);
  const price = toMoney(d.price);
  const sale = d.salePrice.trim() ? toMoney(d.salePrice) : null;
  const company = (companies.data?.items ?? []).find((c) => c.id === d.companyId);
  const setVersion = (i: number, patch: Partial<VersionEntry>) => setD((x) => ({ versionHistory: x.versionHistory.map((v, k) => (k === i ? { ...v, ...patch } : v)) }));
  const setPermission = (i: number, patch: Partial<AppPermission>) => setD((x) => ({ permissions: x.permissions.map((p, k) => (k === i ? { ...p, ...patch } : p)) }));

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Departments' }, { label: 'Softwares', to: LIST }, { label: app ? app.title : 'New app' }]}
        title={app ? `Edit app: ${app.title}` : 'Add app'}
        sub={app ? `${APP_STATUS[app.status].label} · last saved ${dateTime(app.updatedAt)}${app.updatedBy ? ` by ${app.updatedBy}` : ''} · changes go live when you save${canManage ? '' : ' · view only'}` : 'A new app starts as a draft: add its files, then publish it'}
      />
      {notice && <Alert tone="success" title={notice} />}
      {(error || firstProblem) && (
        <Alert tone="danger" title={app ? 'The app wasn’t saved' : 'The app wasn’t added'}>
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
              <div className="grid md2 gap-4">
                <Field label="App title" error={err('title')}>
                  <TextInput id="a-title" value={d.title} error={!!err('title')} onChange={(e) => setD({ title: e.target.value })} />
                </Field>
                <Field label="Slug" optional hint={`Opens /software/app/${d.slug.trim() || slugify(d.title) || '…'}`} error={err('slug')}>
                  <TextInput id="a-slug" value={d.slug} placeholder={slugify(d.title)} error={!!err('slug')} onChange={(e) => setD({ slug: e.target.value })} />
                </Field>
              </div>
              <div className="grid md2 gap-4">
                <Field label="Company" hint="The maker’s name, shown under the title" error={err('companyName')}>
                  <TextInput id="a-co" value={d.companyName} placeholder="e.g. Forge Software" error={!!err('companyName')} onChange={(e) => setD({ companyName: e.target.value })} />
                </Field>
                <Field label="Company page" optional hint={companies.isError ? 'Companies couldn’t be loaded' : 'Links to the company page in Companies'} error={err('companyId')}>
                  <Select
                    id="a-co-link"
                    value={d.companyId}
                    disabled={disabled || !companies.data}
                    options={[{ value: '', label: 'No link' }, ...(d.companyId && !company ? [{ value: d.companyId, label: 'Linked company' }] : []), ...(companies.data?.items ?? []).map((c) => ({ value: c.id, label: c.status === 'hidden' ? `${c.name} (hidden)` : c.name }))]}
                    onChange={(e) => {
                      const picked = (companies.data?.items ?? []).find((c) => c.id === e.target.value);
                      setD((x) => ({ companyId: e.target.value, companyName: picked && (!x.companyName.trim() || x.companyName === company?.name) ? picked.name : x.companyName }));
                    }}
                  />
                </Field>
              </div>
              <div className="grid md2 gap-4">
                <Field label="Category" error={err('categoryId')}>
                  <Select id="a-cat" value={d.categoryId} options={[{ value: '', label: 'Pick a category…' }, ...cats.map((c) => ({ value: c.id, label: c.visible ? c.name : `${c.name} (hidden)` }))]} onChange={(e) => setD({ categoryId: e.target.value })} />
                </Field>
                <Field label="Subcategory" optional hint="e.g. Photo editing" error={err('subcategory')}>
                  <TextInput id="a-sub" value={d.subcategory} onChange={(e) => setD({ subcategory: e.target.value })} />
                </Field>
              </div>
              <Field label="Brief description" hint={`Shown in app lists · ${d.brief.length} / ${BRIEF_MAX}`} error={err('brief')}>
                <TextInput id="a-brief" value={d.brief} maxLength={BRIEF_MAX} error={!!err('brief')} onChange={(e) => setD({ brief: e.target.value })} />
              </Field>
              <PictureField label="Thumbnail" shape="square" icon="app-window" value={d.icon} alt={d.title.trim()} hint="Square PNG or WebP, at least 512 × 512" disabled={disabled} onChange={(icon) => setD({ icon })} />
              {err('icon') && <span className="xs t-danger-text">{err('icon')}</span>}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="h4">Descriptions</h2>
            </div>
            <div className="card-body stack gap-4">
              <Field label="Description" error={err('description')}>
                <Textarea id="a-desc" rows={4} value={d.description} onChange={(e) => setD({ description: e.target.value })} />
              </Field>
              <Field label="Additional description" optional hint="Shown under “More about this app”" error={err('moreDescription')}>
                <Textarea id="a-more" rows={3} value={d.moreDescription} onChange={(e) => setD({ moreDescription: e.target.value })} />
              </Field>
              <LinesField id="a-get" label="What you get" hint="Short bullets on the app page, e.g. Lifetime updates for version 4" lines={d.whatYouGet} max={12} disabled={disabled} onChange={(whatYouGet) => setD({ whatYouGet })} />
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h2 className="h4">Image preview</h2>
                <span className="xs muted">Up to {MAX_SHOTS} screenshots · shown in this order · drag to reorder</span>
              </div>
            </div>
            <div className="card-body">
              <ScreenshotsField shots={d.screenshots} alt={d.title.trim()} disabled={disabled} onChange={(f) => setD((x) => ({ screenshots: f(x.screenshots) }))} />
              {err('screenshots') && <span className="xs t-danger-text">{err('screenshots')}</span>}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="h4">Price</h2>
            </div>
            <div className="card-body stack gap-4">
              <SegmentedControl label="Price type" items={[{ value: 'free', label: 'Free' }, { value: 'paid', label: 'Paid' }]} active={d.free ? 'free' : 'paid'} onChange={(v) => !disabled && setD({ free: v === 'free' })} />
              {!d.free && (
                <>
                  <div className="grid md2 gap-4">
                    <Field label="Price" error={err('price')}>
                      <TextInput id="a-price" inputMode="decimal" prefix="$" value={d.price} error={!!err('price')} onChange={(e) => setD({ price: e.target.value })} />
                    </Field>
                    <Field label="Sale price" optional hint={sale && d.saleEndsAt ? `Ends ${dateTime(fromZonedInput(d.saleEndsAt, TZ) ?? '')} PT · shown as a discount in Deals` : 'Shown as a discount in Deals until the sale ends'} error={err('salePrice')}>
                      <TextInput id="a-sale" inputMode="decimal" prefix="$" value={d.salePrice} error={!!err('salePrice')} onChange={(e) => setD({ salePrice: e.target.value })} />
                    </Field>
                  </div>
                  <div className="grid md2 gap-4">
                    {d.salePrice.trim() ? (
                      <Field label="Sale ends" error={err('saleEndsAt')}>
                        <DateTimeField id="a-sale-end" value={d.saleEndsAt} onChange={(saleEndsAt) => setD({ saleEndsAt })} error={!!err('saleEndsAt')} disabled={disabled} />
                      </Field>
                    ) : (
                      <span />
                    )}
                    <Field label="Licence" optional hint="e.g. One-time purchase · 2 devices" error={err('licenceLabel')}>
                      <TextInput id="a-lic" value={d.licenceLabel} onChange={(e) => setD({ licenceLabel: e.target.value })} />
                    </Field>
                  </div>
                  <div className="grid md2 gap-4">
                    <Field label="Devices per licence key" optional hint="How many devices one key unlocks, 1 to 100; empty for no limit" error={err('licenceDevices')}>
                      <TextInput id="a-lic-dev" type="number" min={1} max={100} value={d.licenceDevices} placeholder="No limit" error={!!err('licenceDevices')} onChange={(e) => setD({ licenceDevices: e.target.value })} />
                    </Field>
                    <span className="xs sub" style={{ alignSelf: 'center' }}>
                      Buying the app gives the customer a licence key (shown on the app page and in My apps) that unlocks it on {d.licenceDevices.trim() && /^\d+$/.test(d.licenceDevices.trim()) ? plural(Number(d.licenceDevices), 'device') : 'any number of devices'}.
                    </span>
                  </div>
                </>
              )}
              {d.free && <span className="xs sub">Customers get it with one tap; free apps need no licence key.</span>}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h2 className="h4">Files</h2>
                <span className="xs muted">Any signed-in customer can download these; a paid app needs its licence key to unlock</span>
              </div>
            </div>
            <div className="card-body stack gap-4">
              <FilesField pkg={d.pkg} databases={d.databases} disabled={disabled} pkgError={err('pkg')} dbError={err('databases')} onPackage={(pkg) => setD({ pkg })} onDatabases={(f) => setD((x) => ({ databases: f(x.databases) }))} />
              <Field label="About the databases" optional hint="e.g. Preset library and LUT packs, needed for offline use">
                <TextInput id="a-db-note" value={d.databasesNote} onChange={(e) => setD({ databasesNote: e.target.value })} />
              </Field>
              <div className="row between small" style={{ paddingTop: 4 }}>
                <span className="muted">Size (worked out from the files)</span>
                <span className="strong">{sizeBytes ? sizeLabel(sizeBytes) : '—'}</span>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="h4">Update info</h2>
            </div>
            <div className="card-body stack gap-4">
              <div className="grid md2 gap-4">
                <Field label="Version" optional hint="e.g. 4.2.0" error={err('version')}>
                  <TextInput id="a-ver" value={d.version} onChange={(e) => setD({ version: e.target.value })} />
                </Field>
                <Field label="Released" optional hint="When this version came out (Updated)" error={err('releasedAt')}>
                  <TextInput id="a-rel" type="date" value={d.releasedAt} onChange={(e) => setD({ releasedAt: e.target.value })} />
                </Field>
              </div>
              <Field label="What’s new" optional error={err('whatsNew')}>
                <Textarea id="a-new" rows={3} value={d.whatsNew} onChange={(e) => setD({ whatsNew: e.target.value })} />
              </Field>
              <div className="stack gap-2">
                <span className="label">
                  Version history <span className="muted">({d.versionHistory.length})</span>
                </span>
                <span className="xs sub">Earlier versions, newest first</span>
                {d.versionHistory.map((v, i) => (
                  <div key={i} className="row gap-2 wrap items-center">
                    <input className="input" style={{ width: 110 }} aria-label={`Earlier version ${i + 1}`} placeholder="Version" value={v.version} onChange={(e) => setVersion(i, { version: e.target.value })} />
                    <input className="input" style={{ width: 160 }} type="date" aria-label={`Version ${v.version || i + 1} date`} value={v.date} onChange={(e) => setVersion(i, { date: e.target.value })} />
                    <input className="input grow" aria-label={`Version ${v.version || i + 1} notes`} placeholder="What changed (optional)" value={v.notes ?? ''} onChange={(e) => setVersion(i, { notes: e.target.value })} />
                    {!disabled && <IconButton icon="x" label={`Remove version ${v.version || i + 1}`} onClick={() => setD((x) => ({ versionHistory: x.versionHistory.filter((_, k) => k !== i) }))} />}
                  </div>
                ))}
                {err('versionHistory') && <span className="xs t-danger-text">{err('versionHistory')}</span>}
                {!disabled && (
                  <div className="row gap-2 wrap">
                    <Button variant="secondary" size="sm" icon="plus" onClick={() => setD((x) => ({ versionHistory: [...x.versionHistory, { version: '', date: '', notes: null }] }))}>
                      Add a version
                    </Button>
                    {d.version.trim() && !d.versionHistory.some((v) => v.version === d.version.trim()) && (
                      <Button variant="ghost" size="sm" onClick={() => setD((x) => ({ versionHistory: [{ version: x.version.trim(), date: x.releasedAt, notes: x.whatsNew.trim() || null }, ...x.versionHistory] }))}>
                        Copy version {d.version.trim()} to the history
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="h4">Runtime platforms</h2>
            </div>
            <div className="card-body stack gap-4">
              <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', columnGap: 16 }}>
                {PLATFORMS.map((p) => (
                  <Checkbox key={p.value} id={`a-pl-${p.value}`} label={p.label} checked={d.platforms.includes(p.value)} onChange={(e) => setD((x) => ({ platforms: e.target.checked ? PLATFORMS.map((y) => y.value).filter((v) => v === p.value || x.platforms.includes(v)) : x.platforms.filter((v) => v !== p.value) }))} />
                ))}
              </div>
              {err('platforms') && <span className="xs t-danger-text">{err('platforms')}</span>}
              <LinesField id="a-pl-lines" label="Platform lines" hint="With minimum versions, as the app page lists them, e.g. Windows 10+ or macOS 13+" lines={d.platformLabels} max={8} disabled={disabled} onChange={(platformLabels) => setD({ platformLabels })} />
              <Field label="Minimum requirements" optional error={err('minRequirements')}>
                <TextInput id="a-req" value={d.minRequirements} placeholder="e.g. Windows 10 64-bit or macOS 13 · 8 GB RAM · 2 GB free space" onChange={(e) => setD({ minRequirements: e.target.value })} />
              </Field>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="h4">Notices and permissions</h2>
            </div>
            <div className="card-body stack gap-4">
              <Field label="Notices" optional hint="Shown in a highlighted box on the app page" error={err('notice')}>
                <Textarea id="a-notice" rows={2} value={d.notice} onChange={(e) => setD({ notice: e.target.value })} />
              </Field>
              <div className="stack gap-2">
                <span className="label">
                  Permissions <span className="muted">({d.permissions.length})</span>
                </span>
                <span className="xs sub">What the app may use on the device and why, e.g. Storage · Open and save photos on this device</span>
                {d.permissions.map((p, i) => (
                  <div key={i} className="row gap-2 wrap items-center">
                    <input className="input" style={{ width: 200 }} aria-label={`Permission ${i + 1} name`} placeholder="Name, e.g. Camera" value={p.name} onChange={(e) => setPermission(i, { name: e.target.value })} />
                    <input className="input grow" aria-label={`Permission ${i + 1} use`} placeholder="What it is for" value={p.desc} onChange={(e) => setPermission(i, { desc: e.target.value })} />
                    {!disabled && <IconButton icon="x" label={`Remove ${p.name || `permission ${i + 1}`}`} onClick={() => setD((x) => ({ permissions: x.permissions.filter((_, k) => k !== i) }))} />}
                  </div>
                ))}
                {err('permissions') && <span className="xs t-danger-text">{err('permissions')}</span>}
                {!disabled && d.permissions.length < 20 && (
                  <div>
                    <Button variant="secondary" size="sm" icon="plus" onClick={() => setD((x) => ({ permissions: [...x.permissions, { name: '', desc: '' }] }))}>
                      Add a permission
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </section>
        </fieldset>

        <div className="stack gap-5">
          <section className="card">
            <div className="card-head">
              <h2 className="h4">Status and visibility</h2>
            </div>
            <fieldset className="card-body stack gap-3" disabled={disabled} style={{ border: 0, margin: 0 }}>
              <Field label="Status" error={err('status')}>
                <Select id="a-st" value={d.status} options={(Object.keys(APP_STATUS) as AppStatus[]).map((s) => ({ value: s, label: APP_STATUS[s].label }))} onChange={(e) => setD({ status: e.target.value as AppStatus })} />
              </Field>
              <Switch id="a-show" label="Show in the Softwares department" checked={d.showInDepartment} onChange={(e) => setD({ showInDepartment: e.target.checked })} />
              <Switch id="a-rev" label="Allow ratings and reviews" checked={d.allowReviews} onChange={(e) => setD({ allowReviews: e.target.checked })} />
              <Field label="Order" optional hint="Lower numbers show first in lists">
                <TextInput id="a-pos" type="number" min={1} value={d.position} onChange={(e) => setD({ position: e.target.value })} />
              </Field>
              {!d.showInDepartment && <span className="xs sub">Left out of rails, categories and search; the app page still opens from a link.</span>}
              {app && (
                <>
                  <div className="row between small">
                    <span className="muted">Views</span>
                    <span className="strong">{num(app.views)}</span>
                  </div>
                  <div className="row between small">
                    <span className="muted">Downloads</span>
                    <span className="strong">{num(app.downloads)}</span>
                  </div>
                  <div className="row between small">
                    <span className="muted">Owners</span>
                    <span className="row gap-2 items-center">
                      <span className="strong">{num(app.owners)}</span>
                      {app.owners > 0 && (
                        <Link className="xs" to={href('admin/departments-software', 'licences', undefined, { app: app.id })}>
                          {app.price.free ? 'See owners' : 'Owners and licence keys'}
                        </Link>
                      )}
                    </span>
                  </div>
                  <div className="row between small">
                    <span className="muted">Rating</span>
                    <span className="strong">
                      {app.ratings.average != null && app.ratings.count ? (
                        <>
                          <span style={{ color: 'var(--star)' }}>★</span> {app.ratings.average.toFixed(1)} · {plural(app.ratings.count, 'rating')}
                        </>
                      ) : (
                        'No ratings yet'
                      )}
                    </span>
                  </div>
                </>
              )}
            </fieldset>
            {canManage && (
              <div className="card-foot" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                <Button size="sm" block onClick={submit} disabled={save.isPending || remove.isPending || (!!app && !dirty)}>
                  {save.isPending ? 'Saving…' : app ? (d.status === 'published' ? 'Publish changes' : 'Save changes') : 'Add app'}
                </Button>
                <Button variant="secondary" size="sm" block onClick={discard} disabled={save.isPending || (!!app && !dirty)}>
                  {app ? 'Discard changes' : 'Cancel'}
                </Button>
                <span className="xs muted">{d.status === 'published' ? 'Publishing updates the app page right away. ' : ''}A published app needs a thumbnail and an app package; a paid app needs a price.</span>
                {app &&
                  (app.owners > 0 ? (
                    <span className="xs muted">Owned by {plural(app.owners, 'customer')}: set the status to Hidden instead of deleting it.</span>
                  ) : (
                    <Button variant="danger-soft" size="sm" block icon="trash" onClick={() => setConfirmDelete(true)} disabled={save.isPending || remove.isPending}>
                      Delete app
                    </Button>
                  ))}
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h2 className="h4">Preview</h2>
                <span className="xs muted">How the app list shows it</span>
              </div>
            </div>
            <div className="card-body">
              <div className="row gap-3" style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 14, alignItems: 'flex-start' }}>
                <div style={{ width: 56, flex: 'none' }}>
                  <Img icon="app-window" src={d.icon?.url} alt="" />
                </div>
                <span className="stack gap-0 grow" style={{ minWidth: 0 }}>
                  <span className="small strong">{d.title.trim() || 'App title'}</span>
                  <span className="xs" style={{ color: 'var(--text-2)' }}>
                    {app?.ratings.average != null && app.ratings.count ? (
                      <>
                        <span style={{ color: 'var(--star)' }}>★</span> {app.ratings.average.toFixed(1)} ·{' '}
                      </>
                    ) : null}
                    {[cat?.name ?? 'Category', sizeBytes ? sizeLabel(sizeBytes) : null].filter(Boolean).join(' · ')}
                  </span>
                  <span className="xs muted truncate">{d.brief.trim() || 'Brief description'}</span>
                  <span className="row gap-2 items-center" style={{ marginTop: 6 }}>
                    {d.free ? (
                      <span className="strong">Free</span>
                    ) : (
                      <>
                        <span className="strong" style={{ fontSize: 15 }}>
                          {formatMoney(sale ?? price) || '$—'}
                        </span>
                        {sale && price && <s className="xs muted">{formatMoney(price)}</s>}
                      </>
                    )}
                    <span className="btn btn-primary btn-sm" style={{ marginLeft: 'auto', borderRadius: 999, minHeight: 30, padding: '0 12px', pointerEvents: 'none' }} aria-hidden="true">
                      {d.free ? 'Get' : 'Buy'}
                    </span>
                  </span>
                </span>
              </div>
              {d.status !== 'published' && (
                <span className="xs muted" style={{ display: 'block', marginTop: 8 }}>
                  Customers see it once it is published{d.showInDepartment ? '' : ' (and only through a link)'}.
                </span>
              )}
            </div>
          </section>
        </div>
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${app?.title ?? 'app'}?`}
        foot={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Delete app
            </Button>
          </>
        }
      >
        <p className="small" style={{ margin: 0 }}>
          The app, its files and its reviews are removed for good. Packs and rails that list it drop it.
        </p>
      </Dialog>
    </>
  );
}

/* ---------------- Screenshots ---------------- */

/** Up to 10 screenshots (content_image, uploaded as they are: phone shots are tall, PC shots wide), in order. */
function ScreenshotsField({ shots, alt, disabled, onChange }: { shots: MediaRef[]; alt: string; disabled: boolean; onChange: (f: (s: MediaRef[]) => MediaRef[]) => void }) {
  const { session } = useApi();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState('');
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const room = MAX_SHOTS - shots.length - uploading;
  const add = (files: File[]) => {
    const images = files.filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type));
    const take = images.slice(0, Math.max(0, room));
    setError(images.length < files.length ? 'Only JPG, PNG or WebP pictures can be added.' : take.length < images.length ? `Up to ${MAX_SHOTS} screenshots: some were left out.` : '');
    take.forEach((file) => {
      setUploading((n) => n + 1);
      uploadMedia(session, file, 'content_image', alt ? { alt } : {})
        .then((asset) => {
          const url = new URL(asset.url || assetPreview(asset), window.location.origin).href;
          onChange((s) => (s.length >= MAX_SHOTS ? s : [...s, { id: asset.id, url, alt: alt || null, width: asset.width ?? null, height: asset.height ?? null }]));
        })
        .catch((e) => setError(errorMessage(e)))
        .finally(() => setUploading((n) => n - 1));
    });
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= shots.length || from === to) return;
    onChange((s) => {
      const next = [...s];
      const [m] = next.splice(from, 1);
      next.splice(to, 0, m);
      return next;
    });
    announce(`Screenshot ${from + 1} moved to place ${to + 1}`);
  };
  const dropFiles = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    add([...e.dataTransfer.files]);
  };
  return (
    <div className="stack gap-2">
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        {shots.map((s, i) => (
          <div
            key={s.id}
            style={{ position: 'relative', opacity: dragFrom === i ? 0.5 : 1, cursor: disabled ? undefined : 'grab' }}
            draggable={!disabled}
            onDragStart={() => setDragFrom(i)}
            onDragEnd={() => setDragFrom(null)}
            onDragOver={(e) => dragFrom !== null && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom !== null) move(dragFrom, i);
              setDragFrom(null);
            }}
          >
            <Img icon="image" src={s.url} alt={`Screenshot ${i + 1}`} className="wide" />
            <span className="xs strong" style={{ position: 'absolute', left: 6, top: 6, background: 'var(--surface)', borderRadius: 999, padding: '1px 7px', color: 'var(--text-2)' }}>
              {i + 1}
            </span>
            {!disabled && (
              <>
                <span style={{ position: 'absolute', right: 4, top: 4, background: 'var(--surface)', borderRadius: 999 }}>
                  <IconButton icon="x" size="sm" label={`Remove screenshot ${i + 1}`} onClick={() => onChange((x) => x.filter((y) => y.id !== s.id))} />
                </span>
                <span className="row gap-1" style={{ position: 'absolute', right: 4, bottom: 4, background: 'var(--surface)', borderRadius: 999 }}>
                  <IconButton icon="arrow-left" size="sm" label={`Move screenshot ${i + 1} earlier`} disabled={i === 0} onClick={() => move(i, i - 1)} />
                  <IconButton icon="arrow-right" size="sm" label={`Move screenshot ${i + 1} later`} disabled={i === shots.length - 1} onClick={() => move(i, i + 1)} />
                </span>
              </>
            )}
          </div>
        ))}
        {Array.from({ length: uploading }, (_, i) => (
          <div key={`up-${i}`} className="imgph wide" role="status">
            <span className="xs">Uploading…</span>
          </div>
        ))}
        {!disabled && room > 0 && (
          <button type="button" className="dropzone" style={{ padding: 8, justifyContent: 'center', aspectRatio: '16 / 9', boxSizing: 'border-box', cursor: 'pointer' }} onClick={() => input.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={dropFiles}>
            <Icon name="image-plus" className="ic-lg" />
            <span className="xs">Add screenshots</span>
          </button>
        )}
      </div>
      {shots.length === 0 && disabled && <span className="small muted">No screenshots.</span>}
      <span className="xs sub">JPG, PNG or WebP. Phone screenshots can be tall; PC screenshots wide.</span>
      {error && <span className="xs t-danger-text">{error}</span>}
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => (add([...(e.target.files ?? [])]), (e.target.value = ''))} />
    </div>
  );
}

/* ---------------- Files ---------------- */

type Upload = { key: string; kind: 'package' | 'database'; name: string; size: number; sent: number; error?: string };

/** The app package (one) and its databases (any number): software_package uploads with progress. */
function FilesField({ pkg, databases, disabled, pkgError, dbError, onPackage, onDatabases }: { pkg: FileDraft | null; databases: FileDraft[]; disabled: boolean; pkgError: string; dbError: string; onPackage: (f: FileDraft | null) => void; onDatabases: (f: (d: FileDraft[]) => FileDraft[]) => void }) {
  const { session } = useApi();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const pkgInput = useRef<HTMLInputElement>(null);
  const dbInput = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const patch = (key: string, p: Partial<Upload>) => setUploads((l) => l.map((u) => (u.key === key ? { ...u, ...p } : u)));
  const start = (kind: Upload['kind'], files: File[]) => {
    files.forEach((file) => {
      const key = `f${++seq.current}`;
      setUploads((l) => [...l.filter((u) => !(kind === 'package' && u.kind === 'package')), { key, kind, name: file.name, size: file.size, sent: 0 }]);
      uploadMedia(session, file, 'software_package', { timeoutMs: 20 * 60_000, onProgress: (sent) => patch(key, { sent }) })
        .then((asset) => {
          const f: FileDraft = { id: asset.id, name: asset.fileName || file.name, sizeBytes: asset.sizeBytes || file.size, uploadedAt: new Date().toISOString() };
          if (kind === 'package') onPackage(f);
          else onDatabases((d) => [...d, f]);
          setUploads((l) => l.filter((u) => u.key !== key));
          announce(`${f.name} uploaded`);
        })
        .catch((e) => patch(key, { error: errorMessage(e) }));
    });
  };
  const drop = (kind: Upload['kind']) => (e: DragEvent) => {
    e.preventDefault();
    if (disabled) return;
    const files = [...e.dataTransfer.files];
    start(kind, kind === 'package' ? files.slice(0, 1) : files);
  };
  const pkgUpload = uploads.find((u) => u.kind === 'package');
  const dbUploads = uploads.filter((u) => u.kind === 'database');

  return (
    <>
      <div className="stack gap-2">
        <span className="label">App package</span>
        {pkgUpload ? (
          <UploadRow u={pkgUpload} onDismiss={() => setUploads((l) => l.filter((x) => x.key !== pkgUpload.key))} />
        ) : pkg ? (
          <FileRow f={pkg} note={pkg.uploadedAt ? 'checked, no threats found' : ''} disabled={disabled} onReplace={() => pkgInput.current?.click()} onRemove={() => onPackage(null)} />
        ) : (
          !disabled && <DropRow text="Drop the app package (.apk, .exe, .dmg, .zip…), or" onBrowse={() => pkgInput.current?.click()} onDrop={drop('package')} />
        )}
        {!pkg && !pkgUpload && disabled && <span className="small muted">No package yet.</span>}
        {pkgError && <span className="xs t-danger-text">{pkgError}</span>}
        <input ref={pkgInput} type="file" hidden onChange={(e) => (start('package', [...(e.target.files ?? [])].slice(0, 1)), (e.target.value = ''))} />
      </div>
      <div className="stack gap-2">
        <span className="label">
          Databases <span className="opt">(optional)</span>
        </span>
        {databases.map((f) => (
          <FileRow key={f.id} f={f} disabled={disabled} onRemove={() => onDatabases((d) => d.filter((x) => x.id !== f.id))} />
        ))}
        {dbUploads.map((u) => (
          <UploadRow key={u.key} u={u} onDismiss={() => setUploads((l) => l.filter((x) => x.key !== u.key))} />
        ))}
        {!disabled && <DropRow text="Drop .db, .sqlite or .zip files, or" onBrowse={() => dbInput.current?.click()} onDrop={drop('database')} />}
        {dbError && <span className="xs t-danger-text">{dbError}</span>}
        <span className="xs sub">Extra data the app needs, e.g. offline libraries. Owners download them next to the package.</span>
        <input ref={dbInput} type="file" multiple hidden accept=".db,.sqlite,.sqlite3,.zip" onChange={(e) => (start('database', [...(e.target.files ?? [])]), (e.target.value = ''))} />
      </div>
    </>
  );
}

const fileBox = { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10 } as const;

function FileRow({ f, note, disabled, onReplace, onRemove }: { f: FileDraft; note?: string; disabled: boolean; onReplace?: () => void; onRemove: () => void }) {
  return (
    <div style={fileBox}>
      <span className="imgph" style={{ width: 36, height: 36, borderRadius: 6, background: 'var(--img-2)' }}>
        <Icon name={/\.(db|sqlite3?)$/i.test(f.name) ? 'database' : 'package'} />
      </span>
      <span className="stack gap-0 grow" style={{ minWidth: 0 }}>
        <span className="small strong truncate">{f.name}</span>
        <span className="xs muted">{[sizeLabel(f.sizeBytes), f.uploadedAt ? `uploaded ${shortDate(f.uploadedAt)}` : '', note].filter(Boolean).join(' · ')}</span>
      </span>
      {!disabled && (
        <>
          {onReplace && (
            <Button variant="ghost" size="sm" onClick={onReplace}>
              Replace
            </Button>
          )}
          <IconButton icon="x" size="sm" label={`Remove ${f.name}`} onClick={onRemove} />
        </>
      )}
    </div>
  );
}

function UploadRow({ u, onDismiss }: { u: Upload; onDismiss: () => void }) {
  const pct = u.size ? Math.min(100, Math.round((u.sent / u.size) * 100)) : 0;
  const checking = !u.error && u.size > 0 && u.sent >= u.size;
  return (
    <div style={fileBox} role="status">
      <span className="imgph" style={{ width: 36, height: 36, borderRadius: 6, background: 'var(--img-2)' }}>
        <Icon name={u.error ? 'circle-alert' : 'upload'} />
      </span>
      <span className="stack gap-1 grow" style={{ minWidth: 0 }}>
        <span className="small strong truncate">{u.name}</span>
        {u.error ? (
          <span className="xs t-danger-text">{u.error}</span>
        ) : (
          <>
            <Meter pct={checking ? 100 : pct} label={`Upload of ${u.name}`} />
            <span className="xs muted">{checking ? `${sizeLabel(u.size)} · checking the file for threats…` : `Uploading ${pct}% · ${sizeLabel(u.sent)} of ${sizeLabel(u.size)}`}</span>
          </>
        )}
      </span>
      {u.error && <IconButton icon="x" size="sm" label={`Dismiss ${u.name}`} onClick={onDismiss} />}
    </div>
  );
}

function DropRow({ text, onBrowse, onDrop }: { text: string; onBrowse: () => void; onDrop: (e: DragEvent) => void }) {
  return (
    <div className="dropzone" style={{ padding: 14, flexDirection: 'row', justifyContent: 'center' }} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <Icon name="upload" />
      <span>
        {text}{' '}
        <button type="button" className="link-inline strong" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--brand-text)', font: 'inherit' }} onClick={onBrowse}>
          browse
        </button>
      </span>
    </div>
  );
}

