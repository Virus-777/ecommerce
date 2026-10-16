import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import {
  Alert, Badge, Breadcrumbs, Button, Card, Dialog, EmptyState, Field, Icon, IconButton, LogoTile, OptionCard, PageHeader, Pager, SearchInput, Select,
  StatusBadge, StatusLegend, Switch, TableWrap, Tabs, Textarea, TextInput,
} from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, shortDate, SkeletonLines } from '@/app/parts';
import {
  ATTR_TYPES, attrType, BRAND_STATUS_LABEL, BRAND_STATUS_TONE, brandNote, claimLine, flattenTree, initialsOf, ruleIcon, tintOf, toApiAttribute, WHO_CAN_SELL,
  type ApiCategory, type BrandAdmin, type BrandStatusKey, type CategoryAttribute, type CategoryNode, type ChangeRequest, type ImageRule, type SellingPolicy,
} from './data/categories';

// Design: pages/admin/admin-categories.html · view "brands" = the Brands tab.
// API: GET/POST/PATCH /api/admin/catalog/categories, GET/PUT /categories/{id}/attributes (attributes + image standards),
// GET/POST/PATCH /catalog/brands, POST /brands/{id}/status; brand claims = sellers change requests (brand_request, public_claim).

type Notice = { tone: 'success' | 'danger'; title: string; body?: string };
type CatStatus = 'visible' | 'hidden' | 'soon';
type AttrSet = { attrs: CategoryAttribute[]; rules: ImageRule[] };

const catStatus = (c: CategoryNode): CatStatus => (!c.visible ? 'hidden' : c.count === 0 ? (c.empty === 'soon' ? 'soon' : 'hidden') : 'visible');
const slugify = (s: string) => s.toLowerCase().replace(/&/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function TreeBadge({ status }: { status: CatStatus }) {
  if (status === 'hidden') return <Badge icon="eye-off">Hidden</Badge>;
  if (status === 'soon') return <Badge tone="info" icon="clock">Coming soon</Badge>;
  return null;
}

const HEAD_BADGE: Record<CatStatus, ReactNode> = {
  visible: <Badge tone="success">Visible</Badge>,
  hidden: <Badge>Hidden</Badge>,
  soon: <Badge tone="info">Coming soon</Badge>,
};

/* ---------------- Categories tab ---------------- */

function CategoriesTab({ nodes, setNodes, activeId, setActiveId, attrSet, attrsLoading, attrsError, retryAttrs, setAttrs, canEdit }: {
  nodes: CategoryNode[];
  setNodes: (f: (n: CategoryNode[]) => CategoryNode[]) => void;
  activeId: string;
  setActiveId: (id: string) => void;
  attrSet: AttrSet | undefined;
  attrsLoading: boolean;
  attrsError: unknown;
  retryAttrs: () => void;
  setAttrs: (id: string, list: CategoryAttribute[]) => void;
  canEdit: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [q, setQ] = useState('');

  const childrenOf = (id: string | null) => nodes.filter((n) => n.parent === id);
  const parentIds = new Set(nodes.map((n) => n.parent).filter(Boolean) as string[]);
  const term = q.trim().toLowerCase();
  const matches = (n: CategoryNode): boolean => !term || n.name.toLowerCase().includes(term) || childrenOf(n.id).some(matches);

  // Open the branch of the selected category.
  useEffect(() => {
    const c = nodes.find((n) => n.id === activeId);
    if (c?.parent) setExpanded((s) => (s.has(c.parent!) ? s : new Set(s).add(c.parent!)));
  }, [activeId, nodes.length]);

  const toggle = (e: MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderNodes = (parent: string | null, lvl: number): ReactNode[] =>
    childrenOf(parent)
      .filter(matches)
      .flatMap((n) => {
        const hasKids = parentIds.has(n.id);
        const isOpen = hasKids && (expanded.has(n.id) || !!term);
        const status = catStatus(n);
        const on = n.id === activeId;
        return [
          <a
            key={n.id}
            href="#"
            className={cx('aa-tn', status !== 'visible' && 'is-muted', on && 'is-active')}
            style={{ '--lvl': lvl } as CSSProperties}
            aria-current={on ? 'true' : undefined}
            onClick={(e) => {
              e.preventDefault();
              setActiveId(n.id);
            }}
          >
            {hasKids ? (
              <button type="button" className="tg" aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${n.name}`} onClick={(e) => toggle(e, n.id)}>
                <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} className="ic-sm" />
              </button>
            ) : (
              <span className="tg sp" aria-hidden="true" />
            )}
            <Icon name={isOpen ? 'folder-open' : 'folder'} className="ic-sm" />
            <span className="nm">{n.name}</span>
            <TreeBadge status={status} />
            <span className="cnt">{num(n.count)}</span>
          </a>,
          ...(isOpen ? renderNodes(n.id, lvl + 1) : []),
        ];
      });

  const cat = nodes.find((n) => n.id === activeId) ?? nodes[0];
  if (!cat) return null;
  const parent = nodes.find((n) => n.id === cat.parent);
  const status = catStatus(cat);
  const attrs = attrSet?.attrs ?? [];
  const tops = nodes.filter((n) => n.parent === null && n.id !== cat.id);
  const filledOf = (a: CategoryAttribute) => a.filled;

  const setCat = (patch: Partial<CategoryNode>) => setNodes((list) => list.map((n) => (n.id === cat.id ? { ...n, ...patch } : n)));
  const setAttr = (id: string, patch: Partial<CategoryAttribute>) => setAttrs(cat.id, attrs.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const addAttr = () => setAttrs(cat.id, [...attrs, { id: `new-${crypto.randomUUID()}`, savedId: null, name: '', type: 'Text', values: '', options: [], unit: null, required: false, filterable: false, filled: 0, publishedRequired: false }]);
  const removeAttr = (id: string) => setAttrs(cat.id, attrs.filter((a) => a.id !== id));
  const newlyRequired = attrs.filter((a) => a.required && !a.publishedRequired && a.filled < cat.count);

  return (
    <div className="aa-rv">
      <section className="card">
        <div className="card-head">
          <span className="h4">Category tree</span>
          <span className="row gap-1">
            <IconButton icon="chevrons-down-up" label="Collapse all" onClick={() => setExpanded(new Set())} />
            <IconButton icon="chevrons-up-down" label="Expand all" onClick={() => setExpanded(new Set(parentIds))} />
          </span>
        </div>
        <div className="card-body">
          <SearchInput id="aa-ct-q" placeholder="Find a category" value={q} onChange={setQ} label="Find a category" />
          <nav className="aa-tree" aria-label="Category tree">
            {renderNodes(null, 0)}
          </nav>
          {term && !nodes.some(matches) && <p className="small muted">No categories match "{q}".</p>}
        </div>
        <div className="card-foot start">
          <span className="xs muted">Counts are active products with at least one eligible offer.</span>
        </div>
      </section>

      <div className="stack gap-5">
        <section className="card">
          <div className="card-head">
            <div className="stack gap-1">
              <Breadcrumbs items={parent ? [{ label: parent.name }, { label: cat.name }] : [{ label: cat.name }]} />
              <h2 className="h3">{cat.name || 'Untitled category'}</h2>
              <span className="xs muted">
                {plural(cat.count, 'product')} · {plural(cat.offers, 'offer')} · slug /{parent ? `${parent.slug}/` : ''}
                {cat.isNew ? slugify(cat.name) : cat.slug}
              </span>
            </div>
            {HEAD_BADGE[status]}
          </div>
          <div className="card-body">
            <div className="grid md2 gap-3">
              <Field label="Category name" error={cat.name.trim() ? undefined : 'Enter a category name.'}>
                <TextInput id="aa-ct-name" value={cat.name} error={!cat.name.trim()} disabled={!canEdit} onChange={(e) => setCat({ name: e.target.value })} />
              </Field>
              <Field label="Parent">
                <Select
                  id="aa-ct-parent"
                  value={cat.parent ?? ''}
                  disabled={!canEdit || parentIds.has(cat.id)}
                  options={[...tops.map((t) => ({ value: t.id, label: t.name })), { value: '', label: 'Top level' }]}
                  onChange={(e) => setCat({ parent: e.target.value || null })}
                />
              </Field>
            </div>
            <div className="stack gap-2">
              <span className="label">Store visibility</span>
              <Switch id="aa-ct-menu" label="Show in store menus and search filters" checked={cat.visible} disabled={!canEdit} onChange={(e) => setCat({ visible: e.target.checked })} />
              <span className="small sub">When this category has no eligible inventory:</span>
              <div className="grid md2 gap-2">
                <OptionCard id="aa-ct-e1" name="aa-ct-empty" title={<span className="small strong">Hide the category</span>} body="Removed from menus until an offer is eligible" checked={cat.empty === 'hide'} disabled={!canEdit} onChange={() => setCat({ empty: 'hide' })} />
                <OptionCard id="aa-ct-e2" name="aa-ct-empty" title={<span className="small strong">Show "Coming soon"</span>} body="Page stays visible with a short note" checked={cat.empty === 'soon'} disabled={!canEdit} onChange={() => setCat({ empty: 'soon' })} />
              </div>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div className="stack gap-0">
              <h3 className="h4">Attributes</h3>
              <span className="xs muted">Required attributes block submission · filterable attributes appear as store filters</span>
            </div>
            {canEdit && (
              <div className="row gap-2">
                <Button variant="secondary" size="sm" icon="plus" onClick={addAttr} disabled={!attrSet}>
                  Add attribute
                </Button>
              </div>
            )}
          </div>
          {attrsError ? (
            <div className="card-body">
              <LoadError error={attrsError} onRetry={retryAttrs} />
            </div>
          ) : attrsLoading ? (
            <div className="card-body">
              <SkeletonLines rows={4} />
            </div>
          ) : attrs.length === 0 ? (
            <div className="card-body">
              <EmptyState icon="list" title="No attributes yet">
                {canEdit ? 'Add the attributes sellers must fill in for this category.' : 'This category has no attributes.'}
              </EmptyState>
            </div>
          ) : (
            <div className="aa-ed">
              <TableWrap label="Attributes table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Attribute name</th>
                      <th scope="col">Type</th>
                      <th scope="col">Values or unit</th>
                      <th className="c" scope="col">
                        Required
                      </th>
                      <th className="c" scope="col">
                        Filterable
                      </th>
                      <th className="r" scope="col">
                        Filled in
                      </th>
                      <th className="col-pin" scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {attrs.map((a, i) => {
                      const label = a.name || 'new attribute';
                      const locked = !!a.inherited || !canEdit;
                      return (
                        <tr key={a.id}>
                          <td>
                            {locked ? (
                              <span className="stack gap-0">
                                <span className="small strong">{a.name}</span>
                                {a.inherited && <span className="xs muted">Inherited from {a.inherited}</span>}
                              </span>
                            ) : (
                              <>
                                <label className="sr-only" htmlFor={`aa-at-n${i}`}>
                                  Attribute name
                                </label>
                                <input className={cx('input', !a.name.trim() && 'is-error')} id={`aa-at-n${i}`} type="text" value={a.name} placeholder="Attribute name" onChange={(e) => setAttr(a.id, { name: e.target.value })} />
                              </>
                            )}
                          </td>
                          <td>
                            {locked ? (
                              <span className="small">{a.type}</span>
                            ) : (
                              <>
                                <label className="sr-only" htmlFor={`aa-at-t${i}`}>
                                  Type
                                </label>
                                <select className="select" id={`aa-at-t${i}`} value={a.type} onChange={(e) => setAttr(a.id, { type: e.target.value })}>
                                  {ATTR_TYPES.map((t) => (
                                    <option key={t}>{t}</option>
                                  ))}
                                </select>
                              </>
                            )}
                          </td>
                          <td>
                            <span className="small sub">{a.values || <span className="muted">—</span>}</span>
                          </td>
                          <td className="c">
                            <input type="checkbox" id={`aa-at-r${i}`} aria-label={`Required: ${label}`} checked={a.required} disabled={locked} onChange={(e) => setAttr(a.id, { required: e.target.checked })} />
                          </td>
                          <td className="c">
                            <input type="checkbox" id={`aa-at-f${i}`} aria-label={`Filterable: ${label}`} checked={a.filterable} disabled={locked} onChange={(e) => setAttr(a.id, { filterable: e.target.checked })} />
                          </td>
                          <td className="r">
                            <span className={cx('small num', a.required && filledOf(a) < cat.count && 't-warning-text strong')}>
                              {num(filledOf(a))} / {num(cat.count)}
                            </span>
                          </td>
                          <td className="col-pin">{!locked && <IconButton icon="trash-2" label={`Remove ${label}`} onClick={() => removeAttr(a.id)} />}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
            </div>
          )}
          {newlyRequired.length > 0 && (
            <div className="card-body">
              {newlyRequired.map((a) => (
                <Alert key={a.id} tone="warning" title={`${plural(cat.count - a.filled, 'product is', 'products are')} missing ${a.name}`}>
                  Making an attribute required does not unpublish existing products. They appear under Missing content and their sellers get a request to fill it in.
                </Alert>
              ))}
            </div>
          )}
        </section>

        <Card title="Image standards" titleAs="h3" sub="Checked automatically on every submission">
          {(attrSet?.rules ?? []).length > 0 ? (
            <ul className="list">
              {attrSet!.rules.map((s) => (
                <li key={s.text}>
                  <Icon name={ruleIcon(s)} className="ic-sm" />
                  <span className="grow small">{s.text}</span>
                  <Badge tone={s.severity === 'blocking' ? 'danger' : 'warning'}>{s.severity === 'blocking' ? 'Blocking' : 'Warning'}</Badge>
                </li>
              ))}
            </ul>
          ) : attrsLoading ? (
            <SkeletonLines rows={2} />
          ) : (
            <p className="small sub">No image standards are set for this category. Submissions only get the general image checks.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Brands tab ---------------- */

type BrandDraft = { id: string; name: string; who: SellingPolicy; status: BrandStatusKey; reason: string };
const PAGE_SIZE = 20;

function BrandsTab({ notify, addOpen, setAddOpen }: { notify: (n: Notice) => void; addOpen: boolean; setAddOpen: (v: boolean) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const canEdit = can('catalog.taxonomy.manage');
  const canClaims = can('sellers.storefronts.review');
  const [q, setQ] = useState('');
  const [st, setSt] = useState('');
  const [auth, setAuth] = useState('');
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<BrandDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [claim, setClaim] = useState<ChangeRequest | null>(null);
  const [claimNote, setClaimNote] = useState('');
  const [claimTried, setClaimTried] = useState(false);
  const [error, setError] = useState('');

  const query = { q: q.trim() || undefined, status: (st || undefined) as BrandStatusKey | undefined, sellingPolicy: (auth || undefined) as SellingPolicy | undefined };
  const list = useQuery({
    queryKey: ['catalog', 'brands', 'list', query, page],
    queryFn: () => call(api.GET('/api/admin/catalog/brands', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows: BrandAdmin[] = list.data?.items ?? [];
  const totalPages = Math.max(1, (list.data as { totalPages?: number } | undefined)?.totalPages ?? 1);

  const claimsQ = useQuery({
    queryKey: ['sellers', 'change-requests', 'brand-claims'],
    enabled: canClaims,
    queryFn: async () => {
      const [a, b] = await Promise.all([
        call(api.GET('/api/admin/sellers/change-requests', { params: { query: { kind: 'brand_request', state: 'pending', limit: 50 } } })),
        call(api.GET('/api/admin/sellers/change-requests', { params: { query: { kind: 'public_claim', state: 'pending', limit: 50 } } })),
      ]);
      return [...a.items, ...b.items].sort((x, y) => x.submittedAt.localeCompare(y.submittedAt));
    },
  });
  const claims = claimsQ.data ?? [];

  const editing = draft ?? (addOpen ? { id: '', name: '', who: 'open' as SellingPolicy, status: 'active' as BrandStatusKey, reason: '' } : null);
  const original = editing?.id ? rows.find((b) => b.brand.id === editing.id) : undefined;
  const statusChanged = !!original && original.status !== editing?.status;
  const needsReason = editing ? (editing.id ? statusChanged || (original?.sellingPolicy !== editing.who) : editing.status !== 'active') : false;
  const errors = tried && editing ? { name: editing.name.trim() ? '' : 'Enter the brand name.', reason: needsReason && !editing.reason.trim() ? (editing.status === 'blocked' ? 'Enter why the brand is blocked. Sellers with offers see it.' : 'Enter the reason for this change. It is recorded in Action history.') : '' } : { name: '', reason: '' };
  const closeBrand = () => {
    setDraft(null);
    setAddOpen(false);
    setTried(false);
    setError('');
  };
  const setD = (patch: Partial<BrandDraft>) => editing && setDraft({ ...editing, ...patch });

  const save = useMutation({
    mutationFn: async (d: BrandDraft) => {
      const name = d.name.trim();
      const reason = d.reason.trim();
      let id = d.id;
      if (!id) {
        const created = await call(api.POST('/api/admin/catalog/brands', { body: { name, sellingPolicy: d.who } }));
        id = created.brand.id;
      } else if (original && (original.brand.name !== name || original.sellingPolicy !== d.who)) {
        await call(api.PATCH('/api/admin/catalog/brands/{id}', { params: { path: { id } }, body: { name, sellingPolicy: d.who, reason: reason || null } }));
      }
      if ((!d.id && d.status !== 'active') || (original && original.status !== d.status)) {
        await call(api.POST('/api/admin/catalog/brands/{id}/status', { params: { path: { id } }, body: { status: d.status, reason } }));
      }
      return { name, isNew: !d.id, status: d.status };
    },
    onSuccess: ({ name, isNew, status }) => {
      void qc.invalidateQueries({ queryKey: ['catalog', 'brands'] });
      notify(
        isNew
          ? { tone: 'success', title: `${name} added`, body: 'Sellers can choose it when they submit a product.' }
          : { tone: 'success', title: `${name} saved`, body: status === 'blocked' ? 'New offers for this brand are blocked. Existing orders are not affected.' : 'Changes apply to new submissions and show in Action history.' },
      );
      closeBrand();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const saveBrand = () => {
    if (!editing) return;
    setTried(true);
    if (!editing.name.trim() || (needsReason && !editing.reason.trim())) return;
    save.mutate(editing);
  };
  const openBrand = (b: BrandAdmin) => {
    setTried(false);
    setError('');
    setDraft({ id: b.brand.id, name: b.brand.name, who: b.sellingPolicy, status: b.status, reason: '' });
  };

  const claimError = claimTried && !claimNote.trim() ? "Enter why you're declining. The seller sees this note." : '';
  const openClaim = (c: ChangeRequest) => {
    setClaim(c);
    setClaimNote('');
    setClaimTried(false);
    setError('');
  };
  const decide = useMutation({
    mutationFn: ({ approve }: { approve: boolean }) => call(api.POST('/api/admin/sellers/change-requests/{id}/decide', { params: { path: { id: claim!.id } }, body: { approve, reason: claimNote.trim() || 'Approved after review' } })),
    onSuccess: (_r, { approve }) => {
      void qc.invalidateQueries({ queryKey: ['sellers', 'change-requests'] });
      void qc.invalidateQueries({ queryKey: ['catalog', 'brands'] });
      notify({ tone: 'success', title: approve ? 'Brand claim approved' : 'Brand claim declined', body: `${claimLine(claim!)}. The seller has been notified.` });
      setClaim(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const decideClaim = (approve: boolean) => {
    if (!claim) return;
    if (!approve) {
      setClaimTried(true);
      if (!claimNote.trim()) return;
    }
    decide.mutate({ approve });
  };

  const rowNotes = rows.map((b) => ({ b, note: brandNote(b) }));

  return (
    <>
      <section className="card">
        <div className="card-body">
          <div className="toolbar">
            <SearchInput
              id="aa-br-q"
              placeholder="Search brands"
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              label="Search brands"
            />
            <select
              className="select"
              id="aa-br-st"
              aria-label="Status"
              value={st}
              onChange={(e) => {
                setSt(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {(Object.keys(BRAND_STATUS_LABEL) as BrandStatusKey[]).map((s) => (
                <option key={s} value={s}>
                  {BRAND_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <select
              className="select"
              id="aa-br-auth"
              aria-label="Authorization"
              value={auth}
              onChange={(e) => {
                setAuth(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Any authorization</option>
              {(Object.keys(WHO_CAN_SELL) as SellingPolicy[]).map((s) => (
                <option key={s} value={s}>
                  {WHO_CAN_SELL[s]}
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
        <TableWrap label="Categories and brands table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Brand</th>
                <th className="r" scope="col">
                  Products
                </th>
                <th className="r" scope="col">
                  Offers
                </th>
                <th className="r" scope="col">
                  Sellers
                </th>
                <th scope="col">Who can sell</th>
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
                    <SkeletonLines rows={5} />
                  </td>
                </tr>
              )}
              {rowNotes.map(({ b, note }) => (
                <tr key={b.brand.id} className={cx(note.warn && 'is-warn')}>
                  <td>
                    {note.warn && <span className="sr-only">At risk: </span>}
                    <span className="row nowrap gap-3">
                      <LogoTile initials={initialsOf(b.brand.name)} tint={tintOf(b.brand.id)} size="sm" />
                      <span className="stack gap-0">
                        <span className="small strong">{b.brand.name}</span>
                        <span className={note.warn ? 'xs t-warning-text strong' : 'xs muted'}>{note.text}</span>
                      </span>
                    </span>
                  </td>
                  <td className="r">{num(b.productCount)}</td>
                  <td className="r">{num(b.offerCount)}</td>
                  <td className="r">{num(b.sellerCount)}</td>
                  <td>
                    <span className="small">{b.status === 'under_review' ? 'Brand not verified' : WHO_CAN_SELL[b.sellingPolicy]}</span>
                  </td>
                  <td>
                    <StatusBadge status={BRAND_STATUS_LABEL[b.status]} tone={BRAND_STATUS_TONE[b.status]} />
                  </td>
                  <td>
                    {canEdit && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => openBrand(b)}>
                        <span>{b.status === 'under_review' ? 'Review' : 'Edit'}</span>
                        <span className="sr-only"> {b.brand.name}</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <EmptyState icon="search-x" title="No brands match">
                      Try another name or clear the filters.
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        {rowNotes.some((r) => r.note.warn) && <StatusLegend items={[{ tone: 'warning', label: 'Amber edge = at risk: flagged or waiting for a decision' }]} />}
        <div className="card-foot between">
          <span className="xs muted">Brand claims on storefronts (for example "authorized reseller") are reviewed before they show to customers.</span>
          <Pager page={page} total={totalPages} onPage={setPage} />
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">Brand claims waiting</h2>
            <span className="xs muted">{canClaims ? plural(claims.length, 'request') : 'Needs the storefront review permission'}</span>
          </div>
        </div>
        {claimsQ.isError ? (
          <div className="card-body">
            <LoadError error={claimsQ.error} onRetry={() => void claimsQ.refetch()} />
          </div>
        ) : claimsQ.isPending && canClaims ? (
          <div className="card-body">
            <SkeletonLines rows={2} />
          </div>
        ) : claims.length > 0 ? (
          <ul className="list pad">
            {claims.map((c) => (
              <li key={c.id}>
                <LogoTile initials={initialsOf(c.storeName)} tint={tintOf(c.sellerId)} size="sm" />
                <span className="grow stack gap-0">
                  <span className="small strong">{claimLine(c)}</span>
                  <span className="xs muted">
                    {c.kind === 'brand_request' ? 'New brand request' : c.evidence.length ? `${plural(c.evidence.length, 'document')} attached` : 'No documents attached'} · {shortDate(c.submittedAt)}
                  </span>
                </span>
                <Button variant="secondary" size="sm" onClick={() => openClaim(c)}>
                  Review
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="card-body">
            <EmptyState icon="circle-check" title="No brand claims waiting">
              New claims from sellers show up here.
            </EmptyState>
          </div>
        )}
      </section>

      <Dialog
        open={!!editing}
        onClose={closeBrand}
        title={original ? `${original.status === 'under_review' ? 'Review' : 'Edit'} ${original.brand.name}` : 'Add brand'}
        foot={
          <>
            <Button variant="ghost" onClick={closeBrand}>
              Cancel
            </Button>
            <Button onClick={saveBrand} disabled={save.isPending}>
              {editing?.id ? 'Save brand' : 'Add brand'}
            </Button>
          </>
        }
      >
        {editing && (
          <>
            {error && <Alert tone="danger" title={error} />}
            <Field label="Brand name" error={errors.name}>
              <TextInput id="aa-br-name" value={editing.name} error={!!errors.name} onChange={(e) => setD({ name: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Who can sell">
                <Select id="aa-br-who" options={(Object.keys(WHO_CAN_SELL) as SellingPolicy[]).map((k) => ({ value: k, label: WHO_CAN_SELL[k] }))} value={editing.who} onChange={(e) => setD({ who: e.target.value as SellingPolicy })} />
              </Field>
              <Field label="Status">
                <Select id="aa-br-status" options={(Object.keys(BRAND_STATUS_LABEL) as BrandStatusKey[]).map((k) => ({ value: k, label: BRAND_STATUS_LABEL[k] }))} value={editing.status} onChange={(e) => setD({ status: e.target.value as BrandStatusKey })} />
              </Field>
            </div>
            {needsReason && (
              <Field label={editing.status === 'blocked' ? 'Reason for blocking' : 'Reason'} hint={editing.status === 'blocked' ? 'Required. Sellers with offers for this brand see it.' : 'Required. Recorded in Action history.'} error={errors.reason}>
                <Textarea id="aa-br-reason" className={cx(errors.reason && 'is-error')} value={editing.reason} onChange={(e) => setD({ reason: e.target.value })} />
              </Field>
            )}
          </>
        )}
      </Dialog>

      <Dialog
        open={!!claim}
        onClose={() => setClaim(null)}
        title="Review brand claim"
        foot={
          <>
            <Button variant="ghost" onClick={() => setClaim(null)}>
              Cancel
            </Button>
            <Button variant="danger-soft" onClick={() => decideClaim(false)} disabled={decide.isPending}>
              Decline
            </Button>
            <Button icon="check" onClick={() => decideClaim(true)} disabled={decide.isPending}>
              Approve
            </Button>
          </>
        }
      >
        {claim && (
          <>
            {error && <Alert tone="danger" title={error} />}
            <div className="row nowrap gap-3">
              <LogoTile initials={initialsOf(claim.storeName)} tint={tintOf(claim.sellerId)} size="sm" />
              <span className="stack gap-0">
                <span className="small strong">{claimLine(claim)}</span>
                <span className="xs muted">
                  {claim.evidence.map((e, i) => (
                    <a key={e.id ?? i} href={e.url ?? '#'} target="_blank" rel="noreferrer">
                      {e.alt || `Document ${i + 1}`}{' '}
                    </a>
                  ))}
                  {shortDate(claim.submittedAt)}
                </span>
              </span>
            </div>
            <Field label="Note to seller" hint="Required when you decline." error={claimError}>
              <Textarea id="aa-cl-note" className={cx(claimError && 'is-error')} value={claimNote} onChange={(e) => setClaimNote(e.target.value)} />
            </Field>
          </>
        )}
      </Dialog>
    </>
  );
}

/* ---------------- Page ---------------- */

export default function Categories() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const canEdit = can('catalog.taxonomy.manage');
  const [view, setView] = useView<'brands'>();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [addBrand, setAddBrand] = useState(false);

  const tree = useQuery({ queryKey: ['catalog', 'categories', 'admin'], queryFn: () => call(api.GET('/api/admin/catalog/categories')) });
  const brandCount = useQuery({ queryKey: ['catalog', 'brands', 'count'], queryFn: () => call(api.GET('/api/admin/catalog/brands', { params: { query: { page: 1, limit: 1 } } })) });
  const saved = useMemo(() => flattenTree((tree.data ?? []) as ApiCategory[]), [tree.data]);
  const [nodes, setNodesState] = useState<CategoryNode[]>([]);
  useEffect(() => setNodesState(saved), [saved]);
  const setNodes = (f: (n: CategoryNode[]) => CategoryNode[]) => setNodesState(f);
  const [activeId, setActiveId] = useState('');
  const active = activeId || nodes.find((n) => n.parent !== null)?.id || nodes[0]?.id || '';
  const activeNode = nodes.find((n) => n.id === active);

  // Attributes and image standards of the selected category; local edits per category until published.
  const attrsQ = useQuery({
    queryKey: ['catalog', 'category-attributes', active],
    enabled: !!active && !activeNode?.isNew,
    queryFn: async (): Promise<AttrSet> => {
      const r = await call(api.GET('/api/admin/catalog/categories/{id}/attributes', { params: { path: { id: active } } }));
      return {
        rules: r.imageRules,
        attrs: r.attributes.map((x) => ({
          id: x.attribute.id,
          savedId: x.attribute.id,
          name: x.attribute.name,
          type: attrType(x.attribute),
          values: x.attribute.options.length ? (x.attribute.options.length > 5 ? `${x.attribute.options.length} values` : x.attribute.options.join(', ')) : x.attribute.unit ?? '',
          options: x.attribute.options,
          unit: x.attribute.unit ?? null,
          required: x.attribute.required,
          filterable: x.attribute.filterable,
          filled: x.filledCount,
          publishedRequired: x.attribute.required,
          inherited: x.inheritedFrom?.name,
        })),
      };
    },
  });
  const [attrEdits, setAttrEdits] = useState<Record<string, CategoryAttribute[]>>({});
  const attrSet: AttrSet | undefined = activeNode?.isNew ? { attrs: attrEdits[active] ?? [], rules: [] } : attrsQ.data ? { attrs: attrEdits[active] ?? attrsQ.data.attrs, rules: attrsQ.data.rules } : undefined;
  const setAttrs = (id: string, list: CategoryAttribute[]) => setAttrEdits((m) => ({ ...m, [id]: list }));

  const addCategory = () => {
    const a = nodes.find((n) => n.id === active);
    const parent = a ? (a.parent ?? a.id) : null;
    const id = `new-${Date.now()}`;
    setNodes((list) => {
      const idx = list.reduce((last, n, i) => (n.parent === parent || n.id === parent ? i : last), list.length - 1);
      const next = [...list];
      next.splice(idx + 1, 0, { id, name: 'New category', parent, count: 0, offers: 0, slug: '', position: list.filter((n) => n.parent === parent).length + 1, visible: true, empty: 'hide', isNew: true });
      return next;
    });
    setActiveId(id);
    setNotice(null);
  };

  const changed = nodes.filter((n) => {
    if (n.isNew) return true;
    const s = saved.find((x) => x.id === n.id);
    return s && (s.name !== n.name || s.parent !== n.parent || s.visible !== n.visible || s.empty !== n.empty);
  });
  const dirty = changed.length > 0 || Object.keys(attrEdits).length > 0;

  const publishM = useMutation({
    mutationFn: async () => {
      const idMap: Record<string, string> = {};
      // New top-level categories first, so children can point at them.
      const ordered = [...changed].sort((a, b) => Number(!!a.parent) - Number(!!b.parent));
      for (const n of ordered) {
        const parentId = n.parent ? idMap[n.parent] ?? n.parent : null;
        if (n.isNew) {
          const c = await call(api.POST('/api/admin/catalog/categories', { body: { name: n.name.trim(), parentId, visible: n.visible, comingSoon: n.empty === 'soon' } }));
          idMap[n.id] = c.id;
        } else {
          await call(api.PATCH('/api/admin/catalog/categories/{id}', { params: { path: { id: n.id } }, body: { name: n.name.trim(), parentId, visible: n.visible, comingSoon: n.empty === 'soon' } }));
        }
      }
      for (const [catId, list] of Object.entries(attrEdits)) {
        const id = idMap[catId] ?? catId;
        const rules = catId === active ? attrSet?.rules ?? [] : qc.getQueryData<AttrSet>(['catalog', 'category-attributes', catId])?.rules ?? [];
        await call(api.PUT('/api/admin/catalog/categories/{id}/attributes', { params: { path: { id } }, body: { attributes: list.filter((a) => !a.inherited).map(toApiAttribute), imageRules: rules } }));
      }
      return idMap;
    },
    onSuccess: (idMap) => {
      setAttrEdits({});
      if (idMap[active]) setActiveId(idMap[active]);
      void qc.invalidateQueries({ queryKey: ['catalog', 'categories'] });
      void qc.invalidateQueries({ queryKey: ['catalog', 'category-attributes'] });
      setNotice({ tone: 'success', title: 'Changes published', body: 'New submissions use the updated categories and attributes. The change is recorded in Action history.' });
    },
    onError: (e) => setNotice({ tone: 'danger', title: 'Changes not published', body: errorMessage(e) }),
  });

  const publish = () => {
    const unnamedCat = nodes.some((n) => !n.name.trim());
    const unnamedAttr = Object.values(attrEdits).some((list) => list.some((a) => !a.name.trim()));
    if (unnamedCat || unnamedAttr) {
      setNotice({ tone: 'danger', title: 'Changes not published', body: unnamedCat ? 'Give every category a name before publishing.' : 'Name every attribute or remove the empty rows before publishing.' });
      return;
    }
    if (!dirty) {
      setNotice({ tone: 'success', title: 'Nothing to publish', body: 'There are no unpublished changes.' });
      return;
    }
    publishM.mutate();
  };

  const isBrands = view === 'brands';
  const brandTotal = (brandCount.data as { total?: number } | undefined)?.total;

  return (
    <AdminLayout active="categories">
      <PageHeader
        crumbs={[{ label: 'Catalog' }, { label: 'Categories and brands' }]}
        title="Categories and brands"
        sub={`${canEdit ? 'Changes apply to new submissions and show in Action history' : 'View only: editing needs the Catalog taxonomy permission'}${dirty ? ' · unpublished changes' : ''}`}
        actions={
          canEdit &&
          (isBrands ? (
            <Button size="sm" icon="plus" onClick={() => setAddBrand(true)}>
              Add brand
            </Button>
          ) : (
            <>
              <Button variant="secondary" size="sm" icon="folder-plus" onClick={addCategory} disabled={!nodes.length}>
                Add category
              </Button>
              <Button size="sm" icon="upload" onClick={publish} disabled={publishM.isPending}>
                Publish changes
              </Button>
            </>
          ))
        }
      />
      <Tabs
        items={[
          { value: '', label: 'Categories', count: tree.data ? nodes.filter((n) => n.parent === null).length : undefined },
          { value: 'brands', label: 'Brands', count: brandTotal },
        ]}
        active={view}
        onChange={(v) => {
          setNotice(null);
          setView(v as '' | 'brands');
        }}
        label="Categories and brands"
      />
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.body}
        </Alert>
      )}
      {isBrands ? (
        <BrandsTab notify={setNotice} addOpen={addBrand} setAddOpen={setAddBrand} />
      ) : tree.isError ? (
        <LoadError error={tree.error} onRetry={() => void tree.refetch()} />
      ) : tree.isPending ? (
        <section className="card">
          <div className="card-body">
            <SkeletonLines rows={6} />
          </div>
        </section>
      ) : nodes.length === 0 ? (
        <section className="card">
          <div className="card-body">
            <EmptyState icon="folder" title="No categories yet">
              Add the first category to start the store menu.
            </EmptyState>
          </div>
        </section>
      ) : (
        <CategoriesTab
          nodes={nodes}
          setNodes={setNodes}
          activeId={active}
          setActiveId={setActiveId}
          attrSet={attrSet}
          attrsLoading={attrsQ.isPending && !activeNode?.isNew}
          attrsError={attrsQ.error}
          retryAttrs={() => void attrsQ.refetch()}
          setAttrs={setAttrs}
          canEdit={canEdit}
        />
      )}
    </AdminLayout>
  );
}
