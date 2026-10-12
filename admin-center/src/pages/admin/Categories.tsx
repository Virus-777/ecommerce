import { useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import {
  Alert, Badge, Breadcrumbs, Button, Card, Dialog, EmptyState, Field, Icon, IconButton, LogoTile, OptionCard, PageHeader, Pager, SearchInput, Select,
  StatusBadge, StatusLegend, Switch, TableWrap, Tabs, Textarea, TextInput,
} from '@marketly/web-shared/ui';
import {
  ATTR_TYPES, BRAND_CLAIMS, BRAND_ROWS, BRAND_STATUSES, BRAND_STATUS_TONE, CATEGORY_TREE, IMAGE_STANDARDS, INITIAL_ACTIVE, INITIAL_EXPANDED, KEYBOARD_ATTRIBUTES,
  WHO_CAN_SELL, defaultAttributes, type BrandClaim, type BrandRow, type BrandStatus, type CategoryAttribute, type CategoryNode,
} from './data/categories';

// Design: pages/admin/admin-categories.html · view "brands" = the Brands tab.

type Notice = { tone: 'success' | 'danger'; title: string; body?: string };
type CatStatus = 'visible' | 'hidden' | 'soon';

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

function CategoriesTab({ nodes, setNodes, activeId, setActiveId, attrsFor, setAttrs }: {
  nodes: CategoryNode[];
  setNodes: (f: (n: CategoryNode[]) => CategoryNode[]) => void;
  activeId: string;
  setActiveId: (id: string) => void;
  attrsFor: (c: CategoryNode) => CategoryAttribute[];
  setAttrs: (id: string, list: CategoryAttribute[]) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(INITIAL_EXPANDED));
  const [q, setQ] = useState('');

  const childrenOf = (id: string | null) => nodes.filter((n) => n.parent === id);
  const parentIds = new Set(nodes.map((n) => n.parent).filter(Boolean) as string[]);
  const term = q.trim().toLowerCase();
  const matches = (n: CategoryNode): boolean => !term || n.name.toLowerCase().includes(term) || childrenOf(n.id).some(matches);

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
  const parent = nodes.find((n) => n.id === cat.parent);
  const status = catStatus(cat);
  const attrs = attrsFor(cat);
  const offers = cat.offers ?? Math.round(cat.count * 2.04);
  const tops = nodes.filter((n) => n.parent === null && n.id !== cat.id);

  const setCat = (patch: Partial<CategoryNode>) => setNodes((list) => list.map((n) => (n.id === cat.id ? { ...n, ...patch } : n)));
  const setAttr = (id: string, patch: Partial<CategoryAttribute>) => setAttrs(cat.id, attrs.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const addAttr = () => setAttrs(cat.id, [...attrs, { id: `n${Date.now()}`, name: '', type: 'Text', values: '', required: false, filterable: false, filled: 0, publishedRequired: false }]);
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
                {plural(cat.count, 'product')} · {plural(offers, 'offer')} · slug /{parent ? `${slugify(parent.name)}/` : ''}
                {slugify(cat.name)}
              </span>
            </div>
            {HEAD_BADGE[status]}
          </div>
          <div className="card-body">
            <div className="grid md2 gap-3">
              <Field label="Category name" error={cat.name.trim() ? undefined : 'Enter a category name.'}>
                <TextInput id="aa-ct-name" value={cat.name} error={!cat.name.trim()} onChange={(e) => setCat({ name: e.target.value })} />
              </Field>
              <Field label="Parent">
                <Select
                  id="aa-ct-parent"
                  value={cat.parent ?? ''}
                  disabled={parentIds.has(cat.id)}
                  options={[...tops.map((t) => ({ value: t.id, label: t.name })), { value: '', label: 'Top level' }]}
                  onChange={(e) => setCat({ parent: e.target.value || null })}
                />
              </Field>
            </div>
            <div className="stack gap-2">
              <span className="label">Store visibility</span>
              <Switch id="aa-ct-menu" label="Show in store menus and search filters" checked={cat.visible} onChange={(e) => setCat({ visible: e.target.checked })} />
              <span className="small sub">When this category has no eligible inventory:</span>
              <div className="grid md2 gap-2">
                <OptionCard id="aa-ct-e1" name="aa-ct-empty" title={<span className="small strong">Hide the category</span>} body="Removed from menus until an offer is eligible" checked={cat.empty === 'hide'} onChange={() => setCat({ empty: 'hide' })} />
                <OptionCard id="aa-ct-e2" name="aa-ct-empty" title={<span className="small strong">Show "Coming soon"</span>} body="Page stays visible with a short note" checked={cat.empty === 'soon'} onChange={() => setCat({ empty: 'soon' })} />
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
            <div className="row gap-2">
              <Button variant="secondary" size="sm" icon="plus" onClick={addAttr}>
                Add attribute
              </Button>
            </div>
          </div>
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
                    return (
                      <tr key={a.id}>
                        <td>
                          {a.inherited ? (
                            <span className="stack gap-0">
                              <span className="small strong">{a.name}</span>
                              <span className="xs muted">Inherited from All products</span>
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
                          {a.inherited ? (
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
                          <input type="checkbox" id={`aa-at-r${i}`} aria-label={`Required: ${label}`} checked={a.required} disabled={a.inherited} onChange={(e) => setAttr(a.id, { required: e.target.checked })} />
                        </td>
                        <td className="c">
                          <input type="checkbox" id={`aa-at-f${i}`} aria-label={`Filterable: ${label}`} checked={a.filterable} disabled={a.inherited} onChange={(e) => setAttr(a.id, { filterable: e.target.checked })} />
                        </td>
                        <td className="r">
                          <span className={cx('small num', a.required && a.filled < cat.count && 't-warning-text strong')}>
                            {num(a.filled)} / {num(cat.count)}
                          </span>
                        </td>
                        <td className="col-pin">{!a.inherited && <IconButton icon="trash-2" label={`Remove ${label}`} onClick={() => removeAttr(a.id)} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          </div>
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

        <Card
          title="Image standards"
          titleAs="h3"
          sub="Checked automatically on every submission"
          actions={
            <Button variant="ghost" size="sm" icon="pencil">
              Edit standards
            </Button>
          }
        >
          <ul className="list">
            {IMAGE_STANDARDS.map((s) => (
              <li key={s.text}>
                <Icon name={s.icon} className="ic-sm" />
                <span className="grow small">{s.text}</span>
                <Badge tone={s.level === 'Blocking' ? 'danger' : 'warning'}>{s.level}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Brands tab ---------------- */

type BrandDraft = { id: string; name: string; who: string; status: BrandStatus; reason: string };

function BrandsTab({ brands, setBrands, claims, setClaims, notify, addOpen, setAddOpen }: {
  brands: BrandRow[];
  setBrands: (f: (b: BrandRow[]) => BrandRow[]) => void;
  claims: BrandClaim[];
  setClaims: (f: (c: BrandClaim[]) => BrandClaim[]) => void;
  notify: (n: Notice) => void;
  addOpen: boolean;
  setAddOpen: (v: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const [st, setSt] = useState('');
  const [auth, setAuth] = useState('');
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<BrandDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [claim, setClaim] = useState<BrandClaim | null>(null);
  const [claimNote, setClaimNote] = useState('');
  const [claimTried, setClaimTried] = useState(false);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return brands.filter((b) => (!term || b.name.toLowerCase().includes(term)) && (!st || b.status === st) && (!auth || b.who === auth));
  }, [brands, q, st, auth]);

  const editing = draft ?? (addOpen ? { id: '', name: '', who: WHO_CAN_SELL[1], status: 'Active' as BrandStatus, reason: '' } : null);
  const errors = tried && editing ? { name: editing.name.trim() ? '' : 'Enter the brand name.', reason: editing.status === 'Blocked' && !editing.reason.trim() ? 'Enter why the brand is blocked. Sellers with offers see it.' : '' } : { name: '', reason: '' };
  const closeBrand = () => {
    setDraft(null);
    setAddOpen(false);
    setTried(false);
  };
  const setD = (patch: Partial<BrandDraft>) => editing && setDraft({ ...editing, ...patch });
  const saveBrand = () => {
    if (!editing) return;
    setTried(true);
    if (!editing.name.trim() || (editing.status === 'Blocked' && !editing.reason.trim())) return;
    const name = editing.name.trim();
    if (editing.id) {
      setBrands((list) => list.map((b) => (b.id === editing.id ? { ...b, name, who: editing.who, status: editing.status, warn: editing.status !== 'Active' && b.warn, note: editing.status === 'Blocked' ? `Blocked: ${editing.reason.trim()}` : b.warn && editing.status === 'Active' ? 'Brand page live' : b.note } : b)));
      notify({ tone: 'success', title: `${name} saved`, body: editing.status === 'Blocked' ? 'New offers for this brand are blocked. Existing orders are not affected.' : 'Changes apply to new submissions and show in Action history.' });
    } else {
      const initials = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
      setBrands((list) => [...list, { id: `b${Date.now()}`, name, initials, tint: '3', products: 0, offers: 0, sellers: 0, who: editing.who, status: editing.status, note: 'No products yet' }]);
      notify({ tone: 'success', title: `${name} added`, body: 'Sellers can choose it when they submit a product.' });
    }
    closeBrand();
  };
  const openBrand = (b: BrandRow) => {
    setTried(false);
    setDraft({ id: b.id, name: b.name, who: b.who, status: b.status, reason: '' });
  };

  const claimError = claimTried && !claimNote.trim() ? "Enter why you're declining. The seller sees this note." : '';
  const openClaim = (c: BrandClaim) => {
    setClaim(c);
    setClaimNote('');
    setClaimTried(false);
  };
  const decideClaim = (approve: boolean) => {
    if (!claim) return;
    if (!approve) {
      setClaimTried(true);
      if (!claimNote.trim()) return;
    }
    setClaims((list) => list.filter((c) => c.id !== claim.id));
    notify({ tone: 'success', title: approve ? 'Brand claim approved' : 'Brand claim declined', body: `${claim.title}. The seller has been notified.` });
    setClaim(null);
  };

  const original = editing?.id ? brands.find((b) => b.id === editing.id) : undefined;
  const whoOptions = editing && !WHO_CAN_SELL.includes(editing.who) ? [editing.who, ...WHO_CAN_SELL] : WHO_CAN_SELL;

  return (
    <>
      <section className="card">
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="aa-br-q" placeholder="Search brands" value={q} onChange={setQ} label="Search brands" />
            <select className="select" id="aa-br-st" aria-label="Status" value={st} onChange={(e) => setSt(e.target.value)}>
              <option value="">All statuses</option>
              {BRAND_STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <select className="select" id="aa-br-auth" aria-label="Authorization" value={auth} onChange={(e) => setAuth(e.target.value)}>
              <option value="">Any authorization</option>
              {WHO_CAN_SELL.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>
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
              {rows.map((b) => (
                <tr key={b.id} className={cx(b.warn && 'is-warn')}>
                  <td>
                    {b.warn && <span className="sr-only">At risk: </span>}
                    <span className="row nowrap gap-3">
                      <LogoTile initials={b.initials} tint={b.tint} size="sm" />
                      <span className="stack gap-0">
                        <span className="small strong">{b.name}</span>
                        <span className={b.warn ? 'xs t-warning-text strong' : 'xs muted'}>{b.note}</span>
                      </span>
                    </span>
                  </td>
                  <td className="r">{num(b.products)}</td>
                  <td className="r">{num(b.offers)}</td>
                  <td className="r">{num(b.sellers)}</td>
                  <td>
                    <span className="small">{b.who}</span>
                  </td>
                  <td>
                    <StatusBadge status={b.status} tone={BRAND_STATUS_TONE[b.status]} />
                  </td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => openBrand(b)}>
                      <span>{b.status === 'Under review' ? 'Review' : 'Edit'}</span>
                      <span className="sr-only"> {b.name}</span>
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
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
        {rows.some((b) => b.warn) && <StatusLegend items={[{ tone: 'warning', label: 'Amber edge = at risk: due soon or near target' }]} />}
        <div className="card-foot between">
          <span className="xs muted">Brand claims on storefronts (for example "authorized reseller") are reviewed before they show to customers.</span>
          <Pager page={page} total={22} onPage={setPage} />
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">Brand claims waiting</h2>
            <span className="xs muted">{plural(claims.length, 'request')}</span>
          </div>
        </div>
        {claims.length > 0 ? (
          <ul className="list pad">
            {claims.map((c) => (
              <li key={c.id}>
                <LogoTile initials={c.initials} tint={c.tint} size="sm" />
                <span className="grow stack gap-0">
                  <span className="small strong">{c.title}</span>
                  <span className="xs muted">{c.detail}</span>
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
        title={original ? `${original.status === 'Under review' ? 'Review' : 'Edit'} ${original.name}` : 'Add brand'}
        foot={
          <>
            <Button variant="ghost" onClick={closeBrand}>
              Cancel
            </Button>
            <Button onClick={saveBrand}>{editing?.id ? 'Save brand' : 'Add brand'}</Button>
          </>
        }
      >
        {editing && (
          <>
            <Field label="Brand name" error={errors.name}>
              <TextInput id="aa-br-name" value={editing.name} error={!!errors.name} onChange={(e) => setD({ name: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Who can sell">
                <Select id="aa-br-who" options={whoOptions} value={editing.who} onChange={(e) => setD({ who: e.target.value })} />
              </Field>
              <Field label="Status">
                <Select id="aa-br-status" options={BRAND_STATUSES} value={editing.status} onChange={(e) => setD({ status: e.target.value as BrandStatus })} />
              </Field>
            </div>
            {editing.status === 'Blocked' && (
              <Field label="Reason for blocking" hint="Required. Sellers with offers for this brand see it." error={errors.reason}>
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
            <Button variant="danger-soft" onClick={() => decideClaim(false)}>
              Decline
            </Button>
            <Button icon="check" onClick={() => decideClaim(true)}>
              Approve
            </Button>
          </>
        }
      >
        {claim && (
          <>
            <div className="row nowrap gap-3">
              <LogoTile initials={claim.initials} tint={claim.tint} size="sm" />
              <span className="stack gap-0">
                <span className="small strong">{claim.title}</span>
                <span className="xs muted">{claim.detail}</span>
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
  const [view, setView] = useView<'brands'>();
  const [nodes, setNodes] = useState(CATEGORY_TREE);
  const [activeId, setActiveId] = useState(INITIAL_ACTIVE);
  const [attrs, setAttrsMap] = useState<Record<string, CategoryAttribute[]>>({});
  const [brands, setBrands] = useState(BRAND_ROWS);
  const [claims, setClaims] = useState(BRAND_CLAIMS);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [addBrand, setAddBrand] = useState(false);

  const attrsFor = (c: CategoryNode) => attrs[c.id] ?? (c.id === 'computers-keyboards' ? KEYBOARD_ATTRIBUTES : defaultAttributes(c.count));
  const setAttrs = (id: string, list: CategoryAttribute[]) => setAttrsMap((m) => ({ ...m, [id]: list }));

  const addCategory = () => {
    const active = nodes.find((n) => n.id === activeId);
    const parent = active ? (active.parent ?? active.id) : null;
    const id = `new-${Date.now()}`;
    setNodes((list) => {
      // Insert after the last sibling so it shows at the end of its branch.
      const idx = list.reduce((last, n, i) => (n.parent === parent || n.id === parent ? i : last), list.length - 1);
      const next = [...list];
      next.splice(idx + 1, 0, { id, name: 'New category', parent, count: 0, visible: true, empty: 'hide' });
      return next;
    });
    setActiveId(id);
    setNotice(null);
  };

  const publish = () => {
    const unnamedCat = nodes.some((n) => !n.name.trim());
    const unnamedAttr = Object.values(attrs).some((list) => list.some((a) => !a.name.trim()));
    if (unnamedCat || unnamedAttr) {
      setNotice({ tone: 'danger', title: 'Changes not published', body: unnamedCat ? 'Give every category a name before publishing.' : 'Name every attribute or remove the empty rows before publishing.' });
      return;
    }
    setAttrsMap((m) => Object.fromEntries(Object.entries(m).map(([k, list]) => [k, list.map((a) => ({ ...a, publishedRequired: a.required }))])));
    // Keyboards ships with an unpublished change (Warranty made required): publishing it records it as published.
    setAttrsMap((m) => (m['computers-keyboards'] ? m : { ...m, 'computers-keyboards': KEYBOARD_ATTRIBUTES.map((a) => ({ ...a, publishedRequired: a.required })) }));
    setNotice({ tone: 'success', title: 'Changes published', body: 'New submissions use the updated categories and attributes. The change is recorded in Action history.' });
  };

  const isBrands = view === 'brands';

  return (
    <AdminLayout active="categories">
      <PageHeader
        crumbs={[{ label: 'Catalog' }, { label: 'Categories and brands' }]}
        title="Categories and brands"
        sub="Owner Omar Haddad, Catalog Manager · changes apply to new submissions and show in Action history"
        actions={
          isBrands ? (
            <Button size="sm" icon="plus" onClick={() => setAddBrand(true)}>
              Add brand
            </Button>
          ) : (
            <>
              <Button variant="secondary" size="sm" icon="folder-plus" onClick={addCategory}>
                Add category
              </Button>
              <Button size="sm" icon="upload" onClick={publish}>
                Publish changes
              </Button>
            </>
          )
        }
      />
      <Tabs
        items={[
          { value: '', label: 'Categories', count: nodes.filter((n) => n.parent === null).length },
          { value: 'brands', label: 'Brands', count: 214 + brands.length - BRAND_ROWS.length },
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
        <BrandsTab brands={brands} setBrands={setBrands} claims={claims} setClaims={setClaims} notify={setNotice} addOpen={addBrand} setAddOpen={setAddBrand} />
      ) : (
        <CategoriesTab nodes={nodes} setNodes={setNodes} activeId={activeId} setActiveId={setActiveId} attrsFor={attrsFor} setAttrs={setAttrs} />
      )}
    </AdminLayout>
  );
}
