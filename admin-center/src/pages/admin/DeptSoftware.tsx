import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { formatMoney, num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Button, CopyButton, Dialog, Drawer, EmptyState, Field, IconButton, Img, KeyValue, PageHeader, Pager, SearchInput, Select, StatusBadge, Switch, TableWrap, Tabs, Textarea, TextInput } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { dateTime, LoadError, shortDate, SkeletonLines } from '@/app/parts';
import { statusLabel } from './data/ads';
import {
  APP_STATUS, codeOf, DeptPage, fieldErrorsOf, HideReviewDialog, moneyText, newKey, PAGE_SIZE, platformLabel, PLATFORMS, plural, PURCHASE_STATUS, slugify, toMoney, totalPagesOf,
  type AppReview, type AppRow, type Entitlement, type AppStatus, type Pack, type PackInput, type Platform, type PurchaseStatus, type Rail, type SoftwareCategory, type SoftwarePurchase,
} from './data/departments';

// Admin › Departments › Softwares (designed from the Marketly Departments canvas: AdminSoftwareApps; the app editor is
// DeptSoftwareApp). Tabs: Apps | Categories | Deals and packs | Carousel ads | Recommendations | Purchases | Owners and licences | Reviews.
// API: /api/admin/software/{apps,categories,packs,rails,purchases,entitlements,reviews}. Paid apps and packs are bought
// with a card in their own payment flow (no cart); staff can give an app to a customer (support goodwill, a payment
// settled elsewhere). Owning a paid app comes with a licence key staff can look up and reissue. The carousel above the
// department is an ad placement (software_top) run from Advertisements.

type Tab = '' | 'categories' | 'deals' | 'ads' | 'rails' | 'purchases' | 'licences' | 'reviews';
type Notify = (title: string, tone?: 'success' | 'danger') => void;
type Ctx = { notify: Notify; canManage: boolean };
type Adding = { adding: boolean; setAdding: (v: boolean) => void };
const PLACEMENT = 'software_top';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const appHref = (id: string) => href('admin/departments-software-app', '', { id });
const star = <span style={{ color: 'var(--star)' }}>★</span>;

export default function DeptSoftware() {
  const { api } = useApi();
  const { can } = useStaffSession();
  const canView = can('software.view');
  const canManage = can('software.manage');
  const canAds = can('advertising.campaigns.view');
  const [view, setView] = useView<Exclude<Tab, ''>>();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; title: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const notify: Notify = (title, tone = 'success') => {
    setNotice({ tone, title });
    announce(title);
  };
  const apps = useQuery({ queryKey: ['software', 'apps', 'count'], enabled: canView, queryFn: () => call(api.GET('/api/admin/software/apps', { params: { query: { limit: 1 } } })) });
  const categories = useCategories(canView);
  const packs = usePacks(canView);
  const rails = useQuery({ queryKey: ['software', 'rails'], enabled: canView, queryFn: () => call(api.GET('/api/admin/software/rails')) });
  const ads = useQuery({ queryKey: ['advertising', 'campaigns', { placementKey: PLACEMENT }, 'count'], enabled: canView && canAds, queryFn: () => call(api.GET('/api/admin/advertising/campaigns', { params: { query: { placementKey: PLACEMENT, limit: 1 } } })) });
  const ctx: Ctx = { notify, canManage };
  const addLabel = view === 'categories' ? 'Add category' : view === 'deals' ? 'Add pack' : view === 'purchases' ? 'Give an app' : '';

  return (
    <DeptPage active="dept-software" title="Softwares" canView={canView} need="See apps, packs, purchases and reviews in Softwares">
      <PageHeader
        crumbs={[{ label: 'Departments' }, { label: 'Softwares' }]}
        title="Softwares"
        sub={`The Softwares department in the app: apps, categories, deals and the ads above them · times in PT${canManage ? '' : ' · view only: editing needs the Softwares permission'}`}
        actions={
          canManage && (
            <>
              <Button variant="secondary" size="sm" icon="plus" to={appHref('new')}>
                Add app
              </Button>
              {addLabel && (
                <Button size="sm" icon={view === 'purchases' ? 'gift' : 'plus'} onClick={() => setAdding(true)}>
                  {addLabel}
                </Button>
              )}
            </>
          )
        }
      />
      <Tabs
        items={[
          { value: '', label: 'Apps', count: apps.data?.total ?? undefined },
          { value: 'categories', label: 'Categories', count: categories.data?.length },
          { value: 'deals', label: 'Deals and packs', count: packs.data?.length },
          { value: 'ads', label: 'Carousel ads', count: ads.data?.total ?? undefined },
          { value: 'rails', label: 'Recommendations', count: rails.data?.length },
          { value: 'purchases', label: 'Purchases' },
          { value: 'licences', label: 'Owners and licences' },
          { value: 'reviews', label: 'Reviews' },
        ]}
        active={view}
        onChange={(v) => {
          setNotice(null);
          setAdding(false);
          setView(v as Tab);
        }}
        label="Softwares sections"
      />
      {notice && <Alert tone={notice.tone} title={notice.title} />}
      {view === 'categories' ? (
        <CategoriesTab {...ctx} adding={adding} setAdding={setAdding} />
      ) : view === 'deals' ? (
        <DealsTab {...ctx} adding={adding} setAdding={setAdding} />
      ) : view === 'ads' ? (
        <AdsTab canAds={canAds} />
      ) : view === 'rails' ? (
        <RailsTab {...ctx} />
      ) : view === 'purchases' ? (
        <PurchasesTab {...ctx} adding={adding} setAdding={setAdding} />
      ) : view === 'licences' ? (
        <LicencesTab {...ctx} />
      ) : view === 'reviews' ? (
        <ReviewsTab {...ctx} />
      ) : (
        <AppsTab {...ctx} />
      )}
    </DeptPage>
  );
}

/* ---------------- shared lookups ---------------- */

export function useCategories(enabled = true) {
  const { api } = useApi();
  return useQuery({ queryKey: ['software', 'categories'], enabled, queryFn: () => call(api.GET('/api/admin/software/categories')) });
}
function usePacks(enabled = true) {
  const { api } = useApi();
  return useQuery({ queryKey: ['software', 'packs'], enabled, queryFn: () => call(api.GET('/api/admin/software/packs')) });
}
/** The first 100 apps (pickers, the On sale list) */
function useAllApps() {
  const { api } = useApi();
  return useQuery({ queryKey: ['software', 'apps', 'all'], queryFn: () => call(api.GET('/api/admin/software/apps', { params: { query: { limit: 100 } } })) });
}
/** Apps matching a search (two letters or more) */
function useAppSearch(term: string, enabled: boolean) {
  const { api } = useApi();
  return useQuery({ queryKey: ['software', 'apps', 'search', term], enabled: enabled && term.length >= 2, queryFn: () => call(api.GET('/api/admin/software/apps', { params: { query: { q: term, limit: 8 } } })) });
}

export function PriceCell({ price }: { price: AppRow['price'] }) {
  if (price.free) return <Badge tone="brand">Free</Badge>;
  return (
    <>
      <span className="strong">{price.label}</span>
      {price.wasLabel && (
        <>
          {' '}
          <s className="xs muted">{price.wasLabel}</s>
        </>
      )}
    </>
  );
}

/* ---------------- Apps ---------------- */

function AppsTab({ canManage }: Ctx) {
  const { api } = useApi();
  const categories = useCategories();
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState<AppStatus | ''>('');
  const [platform, setPlatform] = useState<Platform | ''>('');
  const [page, setPage] = useState(1);
  const query = { q: q.trim() || undefined, categoryId: categoryId || undefined, status: status || undefined, platform: platform || undefined };
  const list = useQuery({
    queryKey: ['software', 'apps', query, page],
    queryFn: () => call(api.GET('/api/admin/software/apps', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const inReview = useQuery({ queryKey: ['software', 'apps', 'in-review'], queryFn: () => call(api.GET('/api/admin/software/apps', { params: { query: { status: 'in_review', limit: 1 } } })) });
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? rows.length;
  const from = (page - 1) * PAGE_SIZE + 1;
  const filtered = !!(q || categoryId || status || platform);

  return (
    <section className="card">
      <div className="card-body">
        <div className="toolbar">
          <SearchInput id="sw-q" placeholder="Search apps or companies" value={q} onChange={(v) => (setQ(v), setPage(1))} label="Search apps" />
          <select className="select" id="sw-cat" aria-label="Category" value={categoryId} onChange={(e) => (setCategoryId(e.target.value), setPage(1))}>
            <option value="">All categories</option>
            {(categories.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select className="select" id="sw-st" aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value as AppStatus | ''), setPage(1))}>
            <option value="">All statuses</option>
            {(Object.keys(APP_STATUS) as AppStatus[]).map((s) => (
              <option key={s} value={s}>
                {APP_STATUS[s].label}
              </option>
            ))}
          </select>
          <select className="select" id="sw-pl" aria-label="Platform" value={platform} onChange={(e) => (setPlatform(e.target.value as Platform | ''), setPage(1))}>
            <option value="">All platforms</option>
            {PLATFORMS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          {list.isSuccess && (
            <span className="xs muted" style={{ marginLeft: 'auto' }}>
              {plural(total, 'app')}
              {inReview.data?.total ? ` · ${num(inReview.data.total)} in review` : ''}
            </span>
          )}
        </div>
      </div>
      {list.isError && (
        <div className="card-body">
          <LoadError error={list.error} onRetry={() => void list.refetch()} />
        </div>
      )}
      <TableWrap label="Apps table">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">App</th>
              <th scope="col">Category</th>
              <th scope="col">Price</th>
              <th className="r" scope="col">
                Size
              </th>
              <th scope="col">Platforms</th>
              <th scope="col">Rating</th>
              <th className="r" scope="col">
                Downloads
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
                  <SkeletonLines rows={6} />
                </td>
              </tr>
            )}
            {rows.map((a) => (
              <tr key={a.id}>
                <td>
                  <span className="row nowrap gap-3" style={{ minWidth: 200 }}>
                    <Img icon="app-window" src={a.icon?.url} alt="" className="tiny" />
                    <span className="stack gap-0" style={{ minWidth: 0 }}>
                      <span className="strong">{a.title}</span>
                      <span className="xs muted">
                        {a.company.name}
                        {a.version ? ` · v${a.version}` : ''}
                      </span>
                    </span>
                  </span>
                </td>
                <td>{a.category.name}</td>
                <td className="nowrap">
                  <PriceCell price={a.price} />
                </td>
                <td className="r nowrap">{a.sizeLabel}</td>
                <td className="xs" style={{ color: 'var(--text-2)' }}>
                  {a.platforms.map(platformLabel).join(', ')}
                </td>
                <td className="nowrap">
                  {a.rating != null && a.ratingCount ? (
                    <span aria-label={`${a.rating.toFixed(1)} of 5 stars from ${plural(a.ratingCount, 'rating')}`}>
                      {star} {a.rating.toFixed(1)}
                    </span>
                  ) : (
                    <span className="xs muted">No ratings</span>
                  )}
                </td>
                <td className="r">{num(a.downloads)}</td>
                <td>
                  <StatusBadge status={APP_STATUS[a.status].label} tone={APP_STATUS[a.status].tone} />
                </td>
                <td className="r nowrap">
                  <Button variant="ghost" size="sm" to={appHref(a.id)}>
                    {canManage ? 'Edit' : 'View'}
                    <span className="sr-only"> {a.title}</span>
                  </Button>
                </td>
              </tr>
            ))}
            {list.isSuccess && rows.length === 0 && (
              <tr>
                <td colSpan={9}>
                  <EmptyState icon="app-window" title={filtered ? 'No apps match' : 'No apps yet'}>
                    {filtered ? 'Try another search or clear the filters.' : canManage ? 'Add the first app with “Add app”: its files, price and the platforms it runs on.' : 'Apps staff add show up here.'}
                  </EmptyState>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableWrap>
      <div className="card-foot between">
        <span className="xs muted">{rows.length ? `Showing ${num(from)}–${num(from + rows.length - 1)} of ${num(total)}` : ' '}</span>
        <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
      </div>
    </section>
  );
}

/* ---------------- Categories ---------------- */

type CategoryDraft = { id: string; name: string; slug: string; icon: string; position: string; visible: boolean };

function CategoriesTab({ notify, canManage, adding, setAdding }: Ctx & Adding) {
  const { api } = useApi();
  const qc = useQueryClient();
  const list = useCategories();
  const rows = [...(list.data ?? [])].sort((a, b) => a.position - b.position);
  const [draft, setDraft] = useState<CategoryDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const editing = draft ?? (adding ? { id: '', name: '', slug: '', icon: '', position: String(rows.length + 1), visible: true } : null);
  const close = () => (setDraft(null), setAdding(false), setTried(false), setError(''));
  const setD = (patch: Partial<CategoryDraft>) => editing && setDraft({ ...editing, ...patch });

  const save = useMutation({
    mutationFn: (d: CategoryDraft) => {
      const body = { name: d.name.trim(), slug: d.slug.trim() || null, icon: d.icon.trim() || null, position: d.position ? Number(d.position) : null, visible: d.visible };
      return d.id ? call(api.PATCH('/api/admin/software/categories/{id}', { params: { path: { id: d.id } }, body })) : call(api.POST('/api/admin/software/categories', { body }));
    },
    onSuccess: (c, d) => {
      void qc.invalidateQueries({ queryKey: ['software'] });
      notify(d.id ? `${c.name} saved` : `${c.name} added`);
      close();
    },
    onError: (e) => setError(codeOf(e) === 'SLUG_TAKEN' ? 'Another category already uses this slug. Pick another one.' : errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (c: SoftwareCategory) => call(api.DELETE('/api/admin/software/categories/{id}', { params: { path: { id: c.id } } })),
    onSuccess: (_r, c) => {
      void qc.invalidateQueries({ queryKey: ['software'] });
      notify(`${c.name} deleted`);
    },
    onError: (e, c) => notify(codeOf(e) === 'IN_USE' ? `${c.name} wasn’t deleted: apps still use it. Move them to another category first, or hide the category.` : `${c.name} wasn’t deleted: ${errorMessage(e)}`, 'danger'),
  });

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">Categories</h2>
            <span className="xs muted">The category chips of the Softwares department, in this order</span>
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
                    Published apps
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
                    <td className="r small">{num(c.appCount)}</td>
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
                        Categories such as Games, Productivity or Browsers group the apps. Every app needs one.
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
              <TextInput id="swc-name" value={editing.name} error={tried && !editing.name.trim()} onChange={(e) => setD({ name: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Slug" optional>
                <TextInput id="swc-slug" value={editing.slug} placeholder={slugify(editing.name)} onChange={(e) => setD({ slug: e.target.value })} />
              </Field>
              <Field label="Order">
                <TextInput id="swc-pos" type="number" min={1} value={editing.position} onChange={(e) => setD({ position: e.target.value })} />
              </Field>
            </div>
            <Field label="Icon" optional hint="A Lucide icon name, e.g. gamepad-2 or globe">
              <TextInput id="swc-icon" value={editing.icon} onChange={(e) => setD({ icon: e.target.value })} />
            </Field>
            <Switch id="swc-visible" label="Show this category in the app" checked={editing.visible} onChange={(e) => setD({ visible: e.target.checked })} />
          </>
        )}
      </Dialog>
    </>
  );
}

/* ---------------- Deals and packs ---------------- */

type PackDraft = { id: string; name: string; slug: string; summary: string; appIds: string[]; price: string; licenceLabel: string; visible: boolean; position: string };
const packDraftOf = (p?: Pack): PackDraft => ({ id: p?.id ?? '', name: p?.name ?? '', slug: p?.slug ?? '', summary: p?.summary ?? '', appIds: p?.apps.map((a) => a.id) ?? [], price: moneyText(p?.price), licenceLabel: p?.licenceLabel ?? '', visible: p?.visible ?? true, position: p ? String(p.position) : '' });
type Known = { title: string; icon?: string | null; regular?: number | null; free?: boolean };

function DealsTab({ notify, canManage, adding, setAdding }: Ctx & Adding) {
  const { api } = useApi();
  const qc = useQueryClient();
  const list = usePacks();
  const all = useAllApps();
  const rows = [...(list.data ?? [])].sort((a, b) => a.position - b.position);
  const [draft, setDraft] = useState<PackDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const term = q.trim();
  const search = useAppSearch(term, canManage && (!!draft || adding));
  const editing = draft ?? (adding ? packDraftOf() : null);
  const setD = (patch: Partial<PackDraft>) => editing && setDraft({ ...editing, ...patch });
  const close = () => (setDraft(null), setAdding(false), setTried(false), setError(''), setQ(''));

  // what is known of each app: the first 100 apps, the search results and the packs' own app lists
  const known = new Map<string, Known>();
  rows.forEach((p) => p.apps.forEach((a) => known.set(a.id, { title: a.title, icon: a.icon?.url })));
  [...(all.data?.items ?? []), ...(search.data?.items ?? [])].forEach((a) => known.set(a.id, { title: a.title, icon: a.icon?.url, regular: a.price.amount?.amount ?? null, free: a.price.free }));
  const onSale = (all.data?.items ?? []).filter((a) => !a.price.free && a.price.saleAmount).sort((a, b) => (b.price.offPercent ?? 0) - (a.price.offPercent ?? 0));

  const problems = (d: PackDraft) => {
    const price = toMoney(d.price);
    return {
      name: d.name.trim() ? '' : 'Enter the pack name.',
      apps: d.appIds.length >= 2 ? '' : 'A pack needs two or more paid apps.',
      price: !price || price.amount <= 0 ? 'Enter the pack price in dollars, e.g. 59.99.' : '',
    };
  };
  const errs = tried && editing ? problems(editing) : null;
  const regulars = editing?.appIds.map((id) => known.get(id)?.regular) ?? [];
  const totalCents = regulars.every((r) => r != null) ? regulars.reduce<number>((s, r) => s + (r ?? 0), 0) : null;
  const priceCents = editing ? toMoney(editing.price)?.amount ?? null : null;
  const savePct = totalCents && priceCents != null && priceCents < totalCents ? Math.round((1 - priceCents / totalCents) * 100) : 0;

  const save = useMutation({
    mutationFn: (d: PackDraft) => {
      const body: PackInput = { name: d.name.trim(), slug: d.slug.trim() || null, summary: d.summary.trim() || null, appIds: d.appIds, price: toMoney(d.price)!, licenceLabel: d.licenceLabel.trim() || null, visible: d.visible, position: d.position.trim() ? Number(d.position) : null };
      return d.id ? call(api.PATCH('/api/admin/software/packs/{id}', { params: { path: { id: d.id } }, body })) : call(api.POST('/api/admin/software/packs', { body }));
    },
    onSuccess: (p, d) => {
      void qc.invalidateQueries({ queryKey: ['software'] });
      notify(d.id ? `${p.name} saved` : `${p.name} added${p.visible ? '' : ' as hidden'}`);
      close();
    },
    onError: (e) => {
      const fe = Object.values(fieldErrorsOf(e));
      setError(codeOf(e) === 'SLUG_TAKEN' ? 'Another pack already uses this slug.' : fe.length ? fe.join(' ') : errorMessage(e));
    },
  });
  const remove = useMutation({
    mutationFn: (d: PackDraft) => call(api.DELETE('/api/admin/software/packs/{id}', { params: { path: { id: d.id } } })),
    onSuccess: (_r, d) => {
      void qc.invalidateQueries({ queryKey: ['software'] });
      notify(`${d.name} deleted`);
      close();
    },
    onError: (e) => setError(codeOf(e) === 'IN_USE' ? 'Customers bought this pack, so it can’t be deleted. Turn off “Show this pack” to hide it.' : errorMessage(e)),
  });
  const submit = () => {
    if (!editing) return;
    setTried(true);
    if (Object.values(problems(editing)).some(Boolean)) return;
    save.mutate(editing);
  };
  const move = (i: number, dir: -1 | 1) => {
    if (!editing) return;
    const j = i + dir;
    if (j < 0 || j >= editing.appIds.length) return;
    const next = [...editing.appIds];
    [next[i], next[j]] = [next[j], next[i]];
    setD({ appIds: next });
  };
  const results = (search.data?.items ?? []).filter((a) => !a.price.free && !editing?.appIds.includes(a.id));

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">Packs</h2>
            <span className="xs muted">Paid apps sold together for one price · the first visible pack is the deal card on the Recommended tab</span>
          </div>
        </div>
        {list.isError && (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        )}
        <TableWrap label="Packs table">
          <table className="table">
            <thead>
              <tr>
                <th className="r" scope="col">
                  Order
                </th>
                <th scope="col">Pack</th>
                <th scope="col">Apps</th>
                <th className="r" scope="col">
                  Price
                </th>
                <th className="r" scope="col">
                  Apps’ total
                </th>
                <th className="r" scope="col">
                  Sold
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
                    <SkeletonLines rows={3} />
                  </td>
                </tr>
              )}
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="r small">{p.position}</td>
                  <td>
                    <span className="stack gap-0">
                      <span className="small strong">{p.name}</span>
                      <span className="xs muted">{p.summary ?? p.licenceLabel ?? `/${p.slug}`}</span>
                    </span>
                  </td>
                  <td className="small">
                    <span className="truncate" style={{ display: 'block', maxWidth: 260 }}>
                      {p.apps.map((a) => a.title).join(', ')}
                    </span>
                  </td>
                  <td className="r small nowrap strong">{formatMoney(p.price)}</td>
                  <td className="r small nowrap">
                    <s className="muted">{p.totalLabel}</s>
                    {p.savePercent > 0 && (
                      <>
                        {' '}
                        <Badge tone="deal">Save {p.savePercent}%</Badge>
                      </>
                    )}
                  </td>
                  <td className="r small">{num(p.sold)}</td>
                  <td>{p.visible ? <Badge tone="success">Visible</Badge> : <Badge icon="eye-off">Hidden</Badge>}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setTried(false), setError(''), setDraft(packDraftOf(p)))}>
                      {canManage ? 'Edit' : 'View'}
                      <span className="sr-only"> {p.name}</span>
                    </button>
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <EmptyState icon="package" title="No packs yet">
                      A pack sells two or more paid apps for less than their prices added up, e.g. Writer, Sheets and Slides Pro for $59.99.
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">On sale</h2>
            <span className="xs muted">Apps with a sale price show in Deals until the sale ends · set the sale price on the app</span>
          </div>
        </div>
        {all.isError ? (
          <div className="card-body">
            <LoadError error={all.error} onRetry={() => void all.refetch()} />
          </div>
        ) : all.isPending ? (
          <div className="card-body">
            <SkeletonLines rows={3} />
          </div>
        ) : onSale.length === 0 ? (
          <div className="card-body">
            <span className="small muted">No app is on sale now.</span>
          </div>
        ) : (
          <ul className="list pad">
            {onSale.map((a) => (
              <li key={a.id}>
                <Img icon="app-window" src={a.icon?.url} alt="" className="tiny" />
                <span className="grow stack gap-0">
                  <span className="small strong">{a.title}</span>
                  <span className="xs muted">
                    {a.price.label} instead of {a.price.wasLabel ?? formatMoney(a.price.amount)}
                    {a.price.saleEndsAt ? ` · until ${dateTime(a.price.saleEndsAt)}` : ''}
                  </span>
                </span>
                {a.price.offPercent ? <Badge tone="deal">−{a.price.offPercent}%</Badge> : null}
                <Button variant="ghost" size="sm" to={appHref(a.id)}>
                  {canManage ? 'Edit' : 'View'}
                  <span className="sr-only"> {a.title}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
        {(all.data?.totalPages ?? 1) > 1 && <div className="card-foot xs muted">From the first 100 apps.</div>}
      </section>

      <Drawer
        open={!!editing}
        onClose={close}
        className="wide"
        title={editing?.id ? `Edit pack: ${editing.name || 'Untitled'}` : 'Add pack'}
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
                {editing?.id ? 'Save pack' : 'Add pack'}
              </Button>
            </>
          ) : undefined
        }
      >
        {editing && (
          <fieldset className="stack gap-4" disabled={!canManage} style={{ border: 0, padding: 0, margin: 0 }}>
            {error && (
              <Alert tone="danger" title="The pack wasn’t saved">
                {error}
              </Alert>
            )}
            {errs && Object.values(errs).some(Boolean) && <Alert tone="danger" title={Object.values(errs).find(Boolean)!} />}
            <Field label="Name" error={errs?.name}>
              <TextInput id="swp-name" value={editing.name} placeholder="e.g. Office Pro pack" error={!!errs?.name} onChange={(e) => setD({ name: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Slug" optional hint={editing.slug.trim() || slugify(editing.name) || '…'}>
                <TextInput id="swp-slug" value={editing.slug} placeholder={slugify(editing.name)} onChange={(e) => setD({ slug: e.target.value })} />
              </Field>
              <Field label="Licence" optional hint="e.g. Lifetime licence">
                <TextInput id="swp-lic" value={editing.licenceLabel} onChange={(e) => setD({ licenceLabel: e.target.value })} />
              </Field>
            </div>
            <Field label="Summary" optional hint="One line on the deal card, e.g. Writer, Sheets and Slides Pro — 3 apps for $59.99">
              <TextInput id="swp-sum" value={editing.summary} onChange={(e) => setD({ summary: e.target.value })} />
            </Field>
            <div className="stack gap-2">
              <span className="label">
                Apps in the pack <span className="muted">({editing.appIds.length})</span>
              </span>
              <span className="xs sub">Two or more paid apps. Customers who own some of them still pay the pack price.</span>
              {editing.appIds.length > 0 && (
                <ul className="list">
                  {editing.appIds.map((id, i) => {
                    const a = known.get(id);
                    return (
                      <li key={id}>
                        <Img icon="app-window" src={a?.icon ?? undefined} alt="" className="tiny" />
                        <span className="grow stack gap-0">
                          <span className="small strong">{a?.title ?? 'App'}</span>
                          <span className="xs muted">{a?.regular != null ? formatMoney({ amount: a.regular, currency: 'USD' }) : a?.free ? 'Free: packs hold paid apps only' : ' '}</span>
                        </span>
                        {canManage && (
                          <>
                            <IconButton icon="arrow-up" label={`Move ${a?.title ?? 'app'} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                            <IconButton icon="arrow-down" label={`Move ${a?.title ?? 'app'} down`} disabled={i === editing.appIds.length - 1} onClick={() => move(i, 1)} />
                            <IconButton icon="x" label={`Remove ${a?.title ?? 'app'}`} onClick={() => setD({ appIds: editing.appIds.filter((x) => x !== id) })} />
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {errs?.apps && <span className="xs t-danger-text">{errs.apps}</span>}
              {canManage && (
                <div className="stack gap-2">
                  <SearchInput id="swp-q" placeholder="Find paid apps to add" value={q} onChange={setQ} label="Find paid apps" />
                  {term.length >= 2 &&
                    (search.isPending ? (
                      <SkeletonLines rows={2} />
                    ) : results.length === 0 ? (
                      <span className="xs muted">No paid apps to add for “{term}”.</span>
                    ) : (
                      <ul className="list">
                        {results.map((a) => (
                          <li key={a.id}>
                            <Img icon="app-window" src={a.icon?.url} alt="" className="tiny" />
                            <span className="grow stack gap-0">
                              <span className="small">{a.title}</span>
                              <span className="xs muted">
                                {formatMoney(a.price.amount)} · {APP_STATUS[a.status].label}
                              </span>
                            </span>
                            <Button variant="secondary" size="sm" icon="plus" onClick={() => (setD({ appIds: [...editing.appIds, a.id] }), announce(`${a.title} added`))}>
                              Add<span className="sr-only"> {a.title}</span>
                            </Button>
                          </li>
                        ))}
                      </ul>
                    ))}
                </div>
              )}
            </div>
            <div className="grid md2 gap-3">
              <Field label="Pack price" hint="Dollars, e.g. 59.99" error={errs?.price}>
                <TextInput id="swp-price" inputMode="decimal" prefix="$" value={editing.price} error={!!errs?.price} onChange={(e) => setD({ price: e.target.value })} />
              </Field>
              <Field label="Order" optional hint="Lower numbers show first">
                <TextInput id="swp-pos" type="number" min={1} value={editing.position} onChange={(e) => setD({ position: e.target.value })} />
              </Field>
            </div>
            <div className="row gap-3 wrap small">
              <span className="muted">The apps’ regular prices added up</span>
              <span className="strong">{totalCents != null ? formatMoney({ amount: totalCents, currency: 'USD' }) : rows.find((p) => p.id === editing.id)?.totalLabel ?? '—'}</span>
              {savePct > 0 && <Badge tone="deal">Customers save {savePct}%</Badge>}
              {totalCents != null && priceCents != null && priceCents >= totalCents && <span className="xs t-danger-text">The pack costs as much as the apps bought one by one.</span>}
            </div>
            <Switch id="swp-visible" label="Show this pack in Deals" checked={editing.visible} onChange={(e) => setD({ visible: e.target.checked })} />
          </fieldset>
        )}
      </Drawer>
    </>
  );
}

/* ---------------- Carousel ads ---------------- */

function AdsTab({ canAds }: { canAds: boolean }) {
  const { api } = useApi();
  const list = useQuery({ queryKey: ['advertising', 'campaigns', { placementKey: PLACEMENT }], enabled: canAds, queryFn: () => call(api.GET('/api/admin/advertising/campaigns', { params: { query: { placementKey: PLACEMENT, limit: 50 } } })) });
  const adsLink = href('admin/ads', '', undefined, { placement: PLACEMENT });
  const rows = list.data?.items ?? [];
  if (!canAds) {
    return (
      <Alert tone="info" title="The carousel is an ad placement">
        The banners above the Softwares department are ads on the “{PLACEMENT}” placement, made and approved in Advertisements. Seeing them needs the advertising permission.
      </Alert>
    );
  }
  return (
    <section className="card">
      <div className="card-head">
        <div className="stack gap-0">
          <h2 className="h4">Carousel ads</h2>
          <span className="xs muted">Ads on the Softwares carousel ({PLACEMENT}) · read only here: make, approve and pause them in Advertisements</span>
        </div>
        <Button variant="secondary" size="sm" icon="megaphone" to={adsLink}>
          Open in Advertisements
        </Button>
      </div>
      {list.isError && (
        <div className="card-body">
          <LoadError error={list.error} onRetry={() => void list.refetch()} />
        </div>
      )}
      <TableWrap label="Carousel ads table">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Campaign</th>
              <th scope="col">Advertiser</th>
              <th scope="col">Runs</th>
              <th className="r" scope="col">
                Displays
              </th>
              <th className="r" scope="col">
                Clicks
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
                <td colSpan={7}>
                  <SkeletonLines rows={3} />
                </td>
              </tr>
            )}
            {rows.map((c) => (
              <tr key={c.id}>
                <td>
                  <span className="stack gap-0">
                    <span className="small strong">{c.name}</span>
                    <span className="xs muted mono">{c.ref}</span>
                  </span>
                </td>
                <td className="small">{c.advertiser.name}</td>
                <td className="small">{c.periodLabel}</td>
                <td className="r small">{num(c.displays)}</td>
                <td className="r small">{num(c.clicks)}</td>
                <td>
                  <span className="stack gap-0">
                    <StatusBadge status={statusLabel(c.status)} />
                    {c.statusNote && <span className="xs muted">{c.statusNote}</span>}
                  </span>
                </td>
                <td>
                  <Button variant="ghost" size="sm" to={href('admin/ad', '', { id: c.id })}>
                    Open<span className="sr-only"> {c.name}</span>
                  </Button>
                </td>
              </tr>
            ))}
            {list.isSuccess && rows.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState icon="megaphone" title="No carousel ads" action={<Button to={adsLink}>Go to Advertisements</Button>}>
                    Without ads the department opens on its rails. Make an ad for the {PLACEMENT} placement in Advertisements.
                  </EmptyState>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableWrap>
    </section>
  );
}

/* ---------------- Recommendations (rails) ---------------- */

type RailDraft = Rail & { uid: string };
const SOURCES: Array<{ value: Rail['source']; label: string; hint: string }> = [
  { value: 'manual', label: 'Picked by staff', hint: 'The apps you pick, in your order' },
  { value: 'newest', label: 'Newest', hint: 'The latest releases' },
  { value: 'category', label: 'A category', hint: 'Popular apps of one category' },
  { value: 'platform', label: 'A platform', hint: 'Apps that run on one platform, e.g. Windows for PC apps' },
  { value: 'top_rated', label: 'Top rated', hint: 'Best rated apps with at least 3 reviews' },
];

function RailsTab({ notify, canManage }: Ctx) {
  const { api } = useApi();
  const qc = useQueryClient();
  const rails = useQuery({ queryKey: ['software', 'rails'], queryFn: () => call(api.GET('/api/admin/software/rails')) });
  const categories = useCategories();
  const all = useAllApps();
  const [draft, setDraft] = useState<RailDraft[] | null>(null);
  const [added, setAdded] = useState<Record<string, Known>>({});
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<Record<string, string>>({});
  const saved: RailDraft[] = (rails.data ?? []).map((r) => ({ ...r, uid: r.key }));
  const d = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const known = new Map<string, Known>(Object.entries(added));
  (all.data?.items ?? []).forEach((a) => known.set(a.id, { title: a.title, icon: a.icon?.url }));
  const set = (next: RailDraft[]) => (setDraft(next), setError(''));
  const setRail = (i: number, patch: Partial<RailDraft>) => set(d.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= d.length) return;
    const next = [...d];
    [next[i], next[j]] = [next[j], next[i]];
    set(next);
    announce(`${d[i].title || 'Rail'} moved ${dir < 0 ? 'up' : 'down'}`);
  };
  const problems = d.map((r) => (!r.title.trim() ? 'Enter a title.' : r.source === 'category' && !r.categoryId ? 'Pick the category.' : r.source === 'platform' && !r.platform ? 'Pick the platform.' : r.source === 'manual' && !r.appIds.length ? 'Pick at least one app.' : !(r.limit >= 3 && r.limit <= 20) ? 'Show 3 to 20 apps.' : ''));
  const [tried, setTried] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      const keys = new Set<string>();
      const body = d.map(({ uid: _uid, ...r }) => {
        let key = r.key || slugify(r.title);
        while (keys.has(key)) key = `${key}-2`;
        keys.add(key);
        return { ...r, key, title: r.title.trim(), categoryId: r.source === 'category' ? r.categoryId : null, platform: r.source === 'platform' ? r.platform : null, appIds: r.source === 'manual' ? r.appIds : [] };
      });
      return call(api.PUT('/api/admin/software/rails', { body: { rails: body } }));
    },
    onSuccess: (r) => {
      qc.setQueryData(['software', 'rails'], r);
      setDraft(null);
      setTried(false);
      setIssues({});
      notify(`Recommendations saved: ${plural(r.length, 'rail')}. The app shows them now.`);
    },
    onError: (e) => {
      setIssues(fieldErrorsOf(e));
      setError(errorMessage(e));
    },
  });

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">Rails of the Recommended tab</h2>
            <span className="xs muted">
              Shown top to bottom · {plural(d.length, 'rail')}
              {dirty ? ' · unsaved changes' : ''}
            </span>
          </div>
          {canManage && (
            <span className="row gap-2">
              <Button variant="ghost" size="sm" onClick={() => (setDraft(null), setTried(false), setIssues({}), setError(''))} disabled={!dirty || save.isPending}>
                Discard changes
              </Button>
              <Button size="sm" icon="check" onClick={() => (setTried(true), problems.every((p) => !p) && save.mutate())} disabled={!dirty || save.isPending}>
                Save rails
              </Button>
            </span>
          )}
        </div>
        {error && (
          <div className="card-body">
            <Alert tone="danger" title="The rails weren’t saved">
              {error}
            </Alert>
          </div>
        )}
        {rails.isError ? (
          <div className="card-body">
            <LoadError error={rails.error} onRetry={() => void rails.refetch()} />
          </div>
        ) : rails.isPending ? (
          <div className="card-body">
            <SkeletonLines rows={5} />
          </div>
        ) : d.length === 0 ? (
          <div className="card-body">
            <EmptyState icon="layout-list" title="No rails">
              Without rails the Recommended tab only shows the pack deal. Add a rail such as New apps or PC apps.
            </EmptyState>
          </div>
        ) : (
          <ul className="list pad">
            {d.map((r, i) => {
              const own = Object.entries(issues).filter(([k]) => k.startsWith(`rails.${i}.`)).map(([, v]) => v);
              const problem = (tried && problems[i]) || own[0] || '';
              return (
                <li key={r.uid} style={{ display: 'block' }}>
                  <RailEditor
                    rail={r}
                    index={i}
                    count={d.length}
                    problem={problem}
                    categories={categories.data ?? []}
                    known={known}
                    canManage={canManage}
                    onChange={(patch) => setRail(i, patch)}
                    onMove={(dir) => move(i, dir)}
                    onRemove={() => set(d.filter((_, k) => k !== i))}
                    onKnow={(id, k) => setAdded((a) => ({ ...a, [id]: k }))}
                  />
                </li>
              );
            })}
          </ul>
        )}
        {canManage && d.length < 12 && (
          <div className="card-foot">
            <Button variant="secondary" size="sm" icon="plus" onClick={() => set([...d, { uid: newKey(), key: '', title: '', source: 'manual', style: 'carousel', categoryId: null, platform: null, appIds: [], limit: 10, visible: true }])}>
              Add a rail
            </Button>
          </div>
        )}
      </section>
    </>
  );
}

function RailEditor({ rail: r, index: i, count, problem, categories, known, canManage, onChange, onMove, onRemove, onKnow }: { rail: RailDraft; index: number; count: number; problem: string; categories: SoftwareCategory[]; known: Map<string, Known>; canManage: boolean; onChange: (p: Partial<RailDraft>) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void; onKnow: (id: string, k: Known) => void }) {
  const [q, setQ] = useState('');
  const term = q.trim();
  const search = useAppSearch(term, canManage && r.source === 'manual');
  const results = (search.data?.items ?? []).filter((a) => !r.appIds.includes(a.id));
  const moveApp = (k: number, dir: -1 | 1) => {
    const j = k + dir;
    if (j < 0 || j >= r.appIds.length) return;
    const next = [...r.appIds];
    [next[k], next[j]] = [next[j], next[k]];
    onChange({ appIds: next });
  };
  const id = `swr-${r.uid}`;
  return (
    <fieldset className="stack gap-3" disabled={!canManage} style={{ border: 0, padding: 0, margin: 0 }}>
      <div className="row gap-2 items-center">
        <span className="xs muted num">{i + 1}</span>
        <input className="input grow" aria-label={`Rail ${i + 1} title`} placeholder="Title, e.g. PC apps" value={r.title} onChange={(e) => onChange({ title: e.target.value })} />
        {!r.visible && <Badge icon="eye-off">Hidden</Badge>}
        {canManage && (
          <>
            <IconButton icon="arrow-up" label={`Move ${r.title || `rail ${i + 1}`} up`} disabled={i === 0} onClick={() => onMove(-1)} />
            <IconButton icon="arrow-down" label={`Move ${r.title || `rail ${i + 1}`} down`} disabled={i === count - 1} onClick={() => onMove(1)} />
            <IconButton icon="x" label={`Remove ${r.title || `rail ${i + 1}`}`} onClick={onRemove} />
          </>
        )}
      </div>
      <div className="grid md2 gap-3">
        <Field label="Apps from" hint={SOURCES.find((s) => s.value === r.source)?.hint}>
          <Select id={`${id}-src`} value={r.source} options={SOURCES.map((s) => ({ value: s.value, label: s.label }))} onChange={(e) => onChange({ source: e.target.value as Rail['source'] })} />
        </Field>
        <Field label="Shown as">
          <Select id={`${id}-style`} value={r.style} options={[{ value: 'carousel', label: 'Carousel: tiles side by side' }, { value: 'list', label: 'List: rows' }]} onChange={(e) => onChange({ style: e.target.value as Rail['style'] })} />
        </Field>
      </div>
      <div className="grid md2 gap-3">
        {r.source === 'category' && (
          <Field label="Category">
            <Select id={`${id}-cat`} value={r.categoryId ?? ''} options={[{ value: '', label: 'Pick a category…' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]} onChange={(e) => onChange({ categoryId: e.target.value || null })} />
          </Field>
        )}
        {r.source === 'platform' && (
          <Field label="Platform">
            <Select id={`${id}-pl`} value={r.platform ?? ''} options={[{ value: '', label: 'Pick a platform…' }, ...PLATFORMS]} onChange={(e) => onChange({ platform: (e.target.value || null) as Platform | null })} />
          </Field>
        )}
        <Field label="Apps shown" hint="3 to 20">
          <TextInput id={`${id}-limit`} type="number" min={3} max={20} value={String(r.limit)} onChange={(e) => onChange({ limit: Number(e.target.value) })} />
        </Field>
      </div>
      {r.source === 'manual' && (
        <div className="stack gap-2">
          <span className="label">
            Picked apps <span className="muted">({r.appIds.length})</span>
          </span>
          {r.appIds.length > 0 && (
            <ul className="list">
              {r.appIds.map((appId, k) => {
                const a = known.get(appId);
                return (
                  <li key={appId}>
                    <span className="xs muted num">{k + 1}</span>
                    <Img icon="app-window" src={a?.icon ?? undefined} alt="" className="tiny" />
                    <span className="grow small">{a?.title ?? 'App'}</span>
                    {canManage && (
                      <>
                        <IconButton icon="arrow-up" label={`Move ${a?.title ?? 'app'} up`} disabled={k === 0} onClick={() => moveApp(k, -1)} />
                        <IconButton icon="arrow-down" label={`Move ${a?.title ?? 'app'} down`} disabled={k === r.appIds.length - 1} onClick={() => moveApp(k, 1)} />
                        <IconButton icon="x" label={`Remove ${a?.title ?? 'app'}`} onClick={() => onChange({ appIds: r.appIds.filter((x) => x !== appId) })} />
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {canManage && r.appIds.length < 20 && (
            <>
              <SearchInput id={`${id}-q`} placeholder="Find apps to add" value={q} onChange={setQ} label={`Find apps for ${r.title || `rail ${i + 1}`}`} />
              {term.length >= 2 &&
                (search.isPending ? (
                  <SkeletonLines rows={2} />
                ) : results.length === 0 ? (
                  <span className="xs muted">No apps to add for “{term}”.</span>
                ) : (
                  <ul className="list">
                    {results.map((a) => (
                      <li key={a.id}>
                        <Img icon="app-window" src={a.icon?.url} alt="" className="tiny" />
                        <span className="grow stack gap-0">
                          <span className="small">{a.title}</span>
                          <span className="xs muted">
                            {a.category.name} · {APP_STATUS[a.status].label}
                          </span>
                        </span>
                        <Button variant="secondary" size="sm" icon="plus" onClick={() => (onKnow(a.id, { title: a.title, icon: a.icon?.url }), onChange({ appIds: [...r.appIds, a.id] }), announce(`${a.title} added`))}>
                          Add<span className="sr-only"> {a.title}</span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                ))}
            </>
          )}
        </div>
      )}
      <Switch id={`${id}-vis`} label="Show this rail" checked={r.visible} onChange={(e) => onChange({ visible: e.target.checked })} />
      {problem && <span className="xs t-danger-text">{problem}</span>}
    </fieldset>
  );
}

/* ---------------- Purchases ---------------- */

function PurchasesTab({ notify, canManage, adding, setAdding }: Ctx & Adding) {
  const { api } = useApi();
  const qc = useQueryClient();
  const all = useAllApps();
  const [status, setStatus] = useState<PurchaseStatus | ''>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<SoftwarePurchase | null>(null);
  const [give, setGive] = useState({ customerId: '', appId: '', reason: '' });
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const query = { status: status || undefined, q: q.trim() || undefined };
  const list = useQuery({
    queryKey: ['software', 'purchases', query, page],
    queryFn: () => call(api.GET('/api/admin/software/purchases', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  const closeGive = () => (setAdding(false), setGive({ customerId: '', appId: '', reason: '' }), setTried(false), setError(''));
  const giveErrs = {
    customerId: UUID.test(give.customerId.trim()) ? '' : 'Enter the customer’s id (from Customers), e.g. 0192f6a4-…',
    appId: give.appId ? '' : 'Pick the app.',
    reason: give.reason.trim() ? '' : 'Say why, e.g. Paid by bank transfer or Goodwill for case CS-104882.',
  };
  const grant = useMutation({
    mutationFn: () => call(api.POST('/api/admin/software/entitlements', { body: { customerId: give.customerId.trim(), appId: give.appId, reason: give.reason.trim() } })),
    onSuccess: (e) => {
      void qc.invalidateQueries({ queryKey: ['software'] });
      notify(`${e.title} given to the customer: it is in their library now`);
      closeGive();
    },
    onError: (e) => setError(codeOf(e) === 'ALREADY_OWNED' ? 'This customer already owns the app.' : codeOf(e) === 'NOT_FOUND' ? 'No customer or app with that id.' : errorMessage(e)),
  });
  const methodOf = (p: SoftwarePurchase) => p.methodLabel ?? '—';

  return (
    <>
      <section className="card">
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="swb-q" placeholder="SW- reference or customer email" value={q} onChange={(v) => (setQ(v), setPage(1))} label="Search purchases" />
            <select className="select" id="swb-st" aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value as PurchaseStatus | ''), setPage(1))}>
              <option value="">All statuses</option>
              {(Object.keys(PURCHASE_STATUS) as PurchaseStatus[]).map((s) => (
                <option key={s} value={s}>
                  {PURCHASE_STATUS[s].label}
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
        <TableWrap label="Purchases table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Ref</th>
                <th scope="col">Customer</th>
                <th scope="col">App or pack</th>
                <th className="r" scope="col">
                  Amount
                </th>
                <th scope="col">Method</th>
                <th scope="col">Status</th>
                <th scope="col">Date</th>
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
                  <td className="mono small strong nowrap">{p.ref}</td>
                  <td>
                    <span className="stack gap-0">
                      <span className="small strong">{p.customer.name ?? 'Customer'}</span>
                      <span className="xs muted">{p.customer.email ?? p.customer.id}</span>
                    </span>
                  </td>
                  <td>
                    <span className="stack gap-0">
                      <span className="small">{p.title}</span>
                      {p.packId && <span className="xs muted">Pack · {plural(p.items.length, 'app')}</span>}
                    </span>
                  </td>
                  <td className="r small nowrap">{formatMoney(p.amount)}</td>
                  <td className="small">{methodOf(p)}</td>
                  <td>
                    <StatusBadge status={PURCHASE_STATUS[p.status].label} tone={PURCHASE_STATUS[p.status].tone} />
                  </td>
                  <td className="small nowrap">{dateTime(p.createdAt)}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(p)}>
                      Open<span className="sr-only"> {p.ref}</span>
                    </button>
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <EmptyState icon="receipt" title={q || status ? 'No purchases match' : 'No purchases yet'}>
                      {q || status ? 'Try another status or search.' : 'Paid apps and packs customers buy in the app show up here.'}
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <div className="card-foot between">
          <span className="xs muted">The card is charged at once and the apps are owned right away · refunds are handled outside the app for now.</span>
          <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
        </div>
      </section>

      <Drawer open={!!open} onClose={() => setOpen(null)} className="wide" title={open ? `${open.ref} · ${open.title}` : 'Purchase'}>
        {open && (
          <>
            <div className="row gap-2 wrap">
              <StatusBadge status={PURCHASE_STATUS[open.status].label} tone={PURCHASE_STATUS[open.status].tone} />
              <span className="small muted">
                {formatMoney(open.amount)} · {dateTime(open.createdAt)}
              </span>
            </div>
            {open.declineMessage && <Alert tone="danger" title="The bank declined the payment">{open.declineMessage}</Alert>}
            <KeyValue
              pairs={[
                ['Customer', open.customer.name ?? 'Customer'],
                ['Email', open.customer.email ? <a href={`mailto:${open.customer.email}`}>{open.customer.email}</a> : '—'],
                ['Customer id', <span className="mono xs">{open.customer.id}</span>],
                ['Bought', open.packId ? `Pack: ${open.title}` : open.title],
                ['Amount', formatMoney(open.amount)],
                ['Method', methodOf(open)],
                ['Started', dateTime(open.createdAt)],
                ['Paid', open.paidAt ? dateTime(open.paidAt) : '—'],
                ...(open.intentId ? [['Payment intent', <span className="mono xs">{open.intentId}</span>] as [string, ReactNode]] : []),
              ]}
            />
            <div className="stack gap-2">
              <span className="label">Apps {open.status === 'paid' ? 'owned' : 'in the purchase'}</span>
              <ul className="list">
                {open.items.map((it) => (
                  <li key={it.appId}>
                    <Img icon="app-window" src={it.icon?.url} alt="" className="tiny" />
                    <span className="grow small">{it.title}</span>
                    <Button variant="ghost" size="sm" to={appHref(it.appId)}>
                      Open app<span className="sr-only"> {it.title}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </Drawer>

      <Dialog
        open={canManage && adding}
        onClose={closeGive}
        title="Give an app"
        foot={
          <>
            <Button variant="ghost" onClick={closeGive}>
              Cancel
            </Button>
            <Button icon="gift" onClick={() => (setTried(true), !Object.values(giveErrs).some(Boolean) && grant.mutate())} disabled={grant.isPending}>
              Give the app
            </Button>
          </>
        }
      >
        {error && <Alert tone="danger" title={error} />}
        <p className="small sub" style={{ margin: 0 }}>
          The customer owns the app right away, without paying: support goodwill or a payment settled elsewhere.
        </p>
        <Field label="Customer id" hint="From the customer’s page in Customers" error={tried ? giveErrs.customerId : undefined}>
          <TextInput id="swg-cust" value={give.customerId} placeholder="0192f6a4-…" error={tried && !!giveErrs.customerId} onChange={(e) => setGive({ ...give, customerId: e.target.value })} />
        </Field>
        <Field label="App" error={tried ? giveErrs.appId : undefined}>
          <Select id="swg-app" value={give.appId} options={[{ value: '', label: 'Pick an app…' }, ...(all.data?.items ?? []).map((a) => ({ value: a.id, label: `${a.title}${a.price.free ? ' (free)' : ` · ${a.price.label}`}${a.status === 'published' ? '' : ` · ${APP_STATUS[a.status].label}`}` }))]} onChange={(e) => setGive({ ...give, appId: e.target.value })} />
        </Field>
        <Field label="Reason" hint="Kept with the customer’s library" error={tried ? giveErrs.reason : undefined}>
          <Textarea id="swg-reason" rows={2} value={give.reason} onChange={(e) => setGive({ ...give, reason: e.target.value })} />
        </Field>
      </Dialog>
    </>
  );
}

/* ---------------- Owners and licences ---------------- */

const SOURCE: Record<Entitlement['source'], string> = { purchase: 'Bought', pack: 'Bought in a pack', free: 'Free app', staff: 'Given by staff' };

function LicencesTab({ notify, canManage }: Ctx) {
  const { api } = useApi();
  const qc = useQueryClient();
  const all = useAllApps();
  const [params] = useSearchParams();
  const [appId, setAppId] = useState(() => params.get('app') ?? '');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [reissuing, setReissuing] = useState<Entitlement | null>(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const term = q.trim();
  // a customer id searches that customer's apps; anything else is a licence key, SW- reference or email
  const query = { appId: appId || undefined, customerId: UUID.test(term) ? term : undefined, q: term && !UUID.test(term) ? term : undefined };
  const list = useQuery({
    queryKey: ['software', 'entitlements', query, page],
    queryFn: () => call(api.GET('/api/admin/software/entitlements', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  const apps = all.data?.items ?? [];
  const closeReissue = () => (setReissuing(null), setReason(''), setTried(false), setError(''));
  const reissue = useMutation({
    mutationFn: (e: Entitlement) => call(api.POST('/api/admin/software/entitlements/{id}/reissue-licence', { params: { path: { id: e.id } }, body: { reason: reason.trim() } })),
    onSuccess: (e) => {
      void qc.invalidateQueries({ queryKey: ['software', 'entitlements'] });
      notify(`New licence key for ${e.customer.name ?? e.customer.email ?? 'the customer'}’s ${e.app.title}: ${e.licenceKey ?? ''}. The old key stopped working and the customer was told.`);
      closeReissue();
    },
    onError: (e) => setError(codeOf(e) === 'NO_LICENCE' ? 'This app is free now, so the owner has no licence key.' : Object.values(fieldErrorsOf(e)).join(' ') || errorMessage(e)),
  });

  return (
    <>
      <section className="card">
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="swl-q" placeholder="Licence key, SW- reference, email or customer id" value={q} onChange={(v) => (setQ(v), setPage(1))} label="Search owners" />
            <select className="select" id="swl-app" aria-label="App" value={appId} onChange={(e) => (setAppId(e.target.value), setPage(1))}>
              <option value="">All apps</option>
              {appId && !apps.some((a) => a.id === appId) && <option value={appId}>This app</option>}
              {apps.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                  {a.price.free ? ' (free)' : ''}
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
        <TableWrap label="Owners and licences table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">App</th>
                <th scope="col">How</th>
                <th scope="col">Licence key</th>
                <th scope="col">Owned since</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.isPending && (
                <tr>
                  <td colSpan={6}>
                    <SkeletonLines rows={5} />
                  </td>
                </tr>
              )}
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>
                    <span className="stack gap-0">
                      <span className="small strong">{e.customer.name ?? 'Customer'}</span>
                      <span className="xs muted">{e.customer.email ?? e.customer.id}</span>
                    </span>
                  </td>
                  <td>
                    <span className="row nowrap gap-2">
                      <Img icon="app-window" src={e.app.icon?.url} alt="" className="tiny" />
                      <span className="small">{e.app.title}</span>
                    </span>
                  </td>
                  <td>
                    <span className="stack gap-0">
                      <span className="small">{SOURCE[e.source]}</span>
                      {e.purchaseRef && <span className="xs muted mono">{e.purchaseRef}</span>}
                      {e.source === 'staff' && e.grantedBy && <span className="xs muted">by {e.grantedBy}</span>}
                    </span>
                  </td>
                  <td>
                    {e.licenceKey ? (
                      <span className="stack gap-0">
                        <span className="row gap-1 nowrap items-center">
                          <span className="mono small strong">{e.licenceKey}</span>
                          <CopyButton text={e.licenceKey} label={`Copy ${e.customer.name ?? 'the customer'}’s licence key`} />
                        </span>
                        <span className="xs muted">
                          {e.licenceIssuedAt ? `Issued ${dateTime(e.licenceIssuedAt)}` : ''}
                          {e.licenceReissues ? ` · reissued ${e.licenceReissues === 1 ? 'once' : `${e.licenceReissues} times`}` : ''}
                        </span>
                      </span>
                    ) : (
                      <span className="small muted">{e.free ? 'Free: no key' : '—'}</span>
                    )}
                  </td>
                  <td className="small nowrap">{dateTime(e.ownedAt)}</td>
                  <td>
                    {canManage && e.licenceKey && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setError(''), setTried(false), setReason(''), setReissuing(e))}>
                        Reissue licence<span className="sr-only"> of {e.customer.name ?? 'the customer'} for {e.app.title}</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <EmptyState icon="key-round" title={term || appId ? 'No owners match' : 'Nobody owns an app yet'}>
                      {term || appId ? 'Check the licence key (XXXXX-XXXXX-XXXXX-XXXXX), the SW- reference or the email.' : 'Customers who get a free app or buy a paid one show up here.'}
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <div className="card-foot between">
          <span className="xs muted">A paid app’s licence key unlocks it on as many devices as its licence says · reissuing gives a new key and the old one stops working.</span>
          <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
        </div>
      </section>

      <Dialog
        open={!!reissuing}
        onClose={closeReissue}
        title={`Reissue the ${reissuing?.app.title ?? 'app'} licence key?`}
        foot={
          <>
            <Button variant="ghost" onClick={closeReissue}>
              Cancel
            </Button>
            <Button icon="key-round" onClick={() => (setTried(true), reason.trim() && reissuing && reissue.mutate(reissuing))} disabled={reissue.isPending}>
              Reissue licence
            </Button>
          </>
        }
      >
        {error && <Alert tone="danger" title={error} />}
        <p className="small sub" style={{ margin: 0 }}>
          {reissuing?.customer.name ?? 'The customer'} gets a new key at once and is told; the key ending {reissuing?.licenceKey?.slice(-5) ?? ''} stops working on every device.
        </p>
        <Field label="Reason" hint="Kept in the action history, e.g. The customer’s key leaked (case CS-104882)" error={tried && !reason.trim() ? 'Say why the key is replaced.' : undefined}>
          <Textarea id="swl-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}

/* ---------------- Reviews ---------------- */

function ReviewsTab({ notify, canManage }: Ctx) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [hidden, setHidden] = useState<'' | 'true' | 'false'>('');
  const [stars, setStars] = useState('');
  const [page, setPage] = useState(1);
  const [hiding, setHiding] = useState<AppReview | null>(null);
  const [error, setError] = useState('');
  const query = { hidden: hidden ? hidden === 'true' : undefined, stars: stars ? Number(stars) : undefined };
  const list = useQuery({
    queryKey: ['software', 'reviews', query, page],
    queryFn: () => call(api.GET('/api/admin/software/reviews', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  const moderate = useMutation({
    mutationFn: ({ r, hide, reason }: { r: AppReview; hide: boolean; reason?: string | null }) => call(api.POST('/api/admin/software/reviews/{id}/moderate', { params: { path: { id: r.id } }, body: { hidden: hide, reason: reason ?? null } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['software'] });
      setHiding(null);
      setError('');
      notify(r.hidden ? `${r.name}’s review of ${r.app.title} is hidden from customers` : `${r.name}’s review of ${r.app.title} shows again`);
    },
    onError: (e, v) => (v.hide ? setError(errorMessage(e)) : notify(`The review wasn’t changed: ${errorMessage(e)}`, 'danger')),
  });

  return (
    <section className="card">
      <div className="card-body">
        <div className="toolbar">
          <select className="select" id="swv-st" aria-label="Status" value={hidden} onChange={(e) => (setHidden(e.target.value as '' | 'true' | 'false'), setPage(1))}>
            <option value="">All reviews</option>
            <option value="false">Visible</option>
            <option value="true">Hidden</option>
          </select>
          <select className="select" id="swv-stars" aria-label="Stars" value={stars} onChange={(e) => (setStars(e.target.value), setPage(1))}>
            <option value="">All ratings</option>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {plural(n, 'star')}
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
      <TableWrap label="Reviews table">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Rating</th>
              <th scope="col">Review</th>
              <th scope="col">App</th>
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
                <td className="small nowrap" aria-label={`${r.stars} of 5 stars`}>
                  {'★'.repeat(r.stars)}
                  <span className="muted">{'★'.repeat(5 - r.stars)}</span>
                </td>
                <td className="small">
                  <span className="truncate" style={{ display: 'block', maxWidth: 320 }}>
                    {r.text ?? <span className="muted">No text</span>}
                  </span>
                </td>
                <td className="small">{r.app.title}</td>
                <td className="small">{r.name}</td>
                <td className="small nowrap">{shortDate(r.date)}</td>
                <td>{r.hidden ? <Badge icon="eye-off">Hidden</Badge> : <Badge tone="success">Visible</Badge>}</td>
                <td>
                  {canManage && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => (r.hidden ? moderate.mutate({ r, hide: false }) : (setError(''), setHiding(r)))} disabled={moderate.isPending}>
                      {r.hidden ? 'Show' : 'Hide'}
                      <span className="sr-only"> review by {r.name}</span>
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {list.isSuccess && rows.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState icon="star" title="No reviews here">
                    Owners rate an app from its page in the app.
                  </EmptyState>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableWrap>
      <div className="card-foot between">
        <span className="xs muted">{plural(rows.length, 'review')} on this page · hiding one takes it out of the app’s rating.</span>
        <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
      </div>
      <HideReviewDialog open={!!hiding} who={hiding?.name ?? ''} busy={moderate.isPending} error={error} onClose={() => setHiding(null)} onHide={(reason) => hiding && moderate.mutate({ r: hiding, hide: true, reason })} />
    </section>
  );
}
