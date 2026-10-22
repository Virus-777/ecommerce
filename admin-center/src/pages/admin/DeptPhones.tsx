import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { formatMoney, percentOff } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Button, Dialog, EmptyState, Icon, Img, PageHeader, sameOriginFile, SearchInput, TableWrap } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { dateTime, LoadError, SkeletonLines } from '@/app/parts';
import { DeptPage, plural, useDragSort, type Money, type PhoneAdmin } from './data/departments';

// Admin › Departments › Phones (designed from the Marketly Departments canvas: AdminPhones). The phones of the app's
// Phone tab are standalone records staff add (DeptPhoneEdit.tsx), in the order the tab shows them; hidden phones keep
// their place. API: GET /api/admin/departments/phones (every phone, at most 100: search and filters work on the
// page), PUT /phones/order (drag a row by its handle, or focus the handle and use the arrow keys). Photos counts the
// preview photos (Detail tab gallery), Ads the advertisement images (Advertisements tab).

export const PHONES_KEY = ['departments', 'phones'];
export const PHONES_LIST = href('admin/departments-phones');
export const phoneHref = (id: string) => href('admin/departments-phone', '', { id });

type Status = PhoneAdmin['status'];
export const PHONE_STATUS: Record<Status, { label: string; tone: 'success' | 'outline' }> = {
  published: { label: 'On the Phone tab', tone: 'success' },
  hidden: { label: 'Hidden', tone: 'outline' },
};

/** The storage size the list's price shows: the cheapest one */
const cheapest = (p: PhoneAdmin) => p.storage.reduce<PhoneAdmin['storage'][number] | undefined>((m, s) => (!m || s.price.amount < m.price.amount ? s : m), undefined);

/** A card of the app's Phone tab: cover with the deal badge, name, first storage and color, price and was price */
export function PhoneTile({ name, meta, cover, price, was }: { name: string; meta: string; cover?: string | null; price: Money | null; was?: Money | null }) {
  const pct = price && was ? percentOff(price.amount, was.amount) : 0;
  return (
    <div style={{ width: 168, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ aspectRatio: '1', borderRadius: 14, background: 'var(--img-2)', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--img-ink)', marginBottom: 4, overflow: 'hidden' }}>
        {cover ? <img src={sameOriginFile(cover)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Icon name="smartphone" style={{ width: 40, height: 40 }} />}
        {pct > 0 && <span style={{ position: 'absolute', top: 8, left: 8, fontSize: 12, fontWeight: 600, padding: '3px 8px', borderRadius: 999, background: 'var(--deal)', color: 'var(--on-deal)' }}>-{pct}%</span>}
      </div>
      <span className="small" style={{ fontWeight: 500, lineHeight: '18px' }}>
        {name}
      </span>
      {meta && <span className="xs muted">{meta}</span>}
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 17, fontWeight: 700 }}>{formatMoney(price) || '$—'}</span>
        {pct > 0 && <s className="small muted">{formatMoney(was)}</s>}
      </span>
    </div>
  );
}

export default function DeptPhones() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const canView = can('departments.view');
  const canManage = can('departments.phones.manage');
  // the notice of a phone just deleted on its edit page
  const [notice, setNotice] = useState((useLocation().state as { notice?: string } | null)?.notice ?? '');
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [brand, setBrand] = useState('');
  const [status, setStatus] = useState<Status | ''>('');
  const [preview, setPreview] = useState(false);

  const list = useQuery({ queryKey: PHONES_KEY, enabled: canView, queryFn: () => call(api.GET('/api/admin/departments/phones')) });
  const all = list.data?.items ?? [];
  const byId = new Map(all.map((p) => [p.id, p]));
  const brands = [...new Set(all.map((p) => p.brand))].sort((a, b) => a.localeCompare(b));
  const term = q.trim().toLowerCase();
  const rows = all.filter((p) => (!term || `${p.name} ${p.brand}`.toLowerCase().includes(term)) && (!brand || p.brand === brand) && (!status || p.status === status));
  const hidden = all.filter((p) => p.status === 'hidden').length;
  const filtered = !!(term || brand || status);

  const order = useMutation({
    mutationFn: (ids: string[]) => call(api.PUT('/api/admin/departments/phones/order', { body: { ids } })),
    onSuccess: (d) => qc.setQueryData(PHONES_KEY, d),
    // a dropped order shows at once; on failure show the server's order again
    onError: (e) => {
      setError(errorMessage(e));
      void qc.invalidateQueries({ queryKey: PHONES_KEY });
    },
  });
  const sort = useDragSort({
    keys: rows.map((p) => p.id),
    disabled: !canManage || order.isPending,
    onSort: (keys, moved) => {
      // the shown phones (all of them, or the filtered ones) take the places they held among all phones
      const ids = all.map((p) => p.id);
      const slots = ids.map((id, i) => (keys.includes(id) ? i : -1)).filter((i) => i >= 0);
      slots.forEach((slot, k) => (ids[slot] = keys[k]));
      qc.setQueryData(PHONES_KEY, { items: ids.map((id, i) => ({ ...byId.get(id)!, position: i + 1 })) });
      setError('');
      setNotice('');
      order.mutate(ids);
      announce(`${byId.get(moved)?.name ?? 'Phone'} moved to place ${ids.indexOf(moved) + 1} of ${ids.length}`);
    },
  });
  const shown = sort.order.map((id) => byId.get(id)).filter((p): p is PhoneAdmin => !!p);
  const onTab = all.filter((p) => p.status === 'published');

  return (
    <DeptPage active="dept-phones" title="Phones" canView={canView}>
      <PageHeader
        crumbs={[{ label: 'Admin' }, { label: 'Departments' }]}
        title="Phones"
        sub="The Phone tab in the app: phones staff add with their price, options, spec sheet and photos, in the order shown"
        actions={
          <>
            <Button variant="secondary" size="sm" icon="eye" onClick={() => setPreview(true)} disabled={!list.data}>
              Preview in store
            </Button>
            {canManage && (
              <Button size="sm" icon="plus" to={phoneHref('new')}>
                Add phone
              </Button>
            )}
          </>
        }
      />
      {notice && <Alert tone="success" title={notice} />}
      {error && (
        <Alert tone="danger" title="The new order wasn’t saved">
          {error}
        </Alert>
      )}
      <section className="card">
        <div className="card-head toolbar" style={{ justifyContent: 'flex-start' }}>
          <div style={{ width: 280, maxWidth: '100%' }}>
            <SearchInput id="ph-q" placeholder="Search phones or brands" value={q} onChange={setQ} label="Search phones" />
          </div>
          <select className="select" id="ph-brand" aria-label="Brand" value={brand} onChange={(e) => setBrand(e.target.value)} style={{ width: 170 }}>
            <option value="">All brands</option>
            {brands.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <select className="select" id="ph-status" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as Status | '')} style={{ width: 150 }}>
            <option value="">All statuses</option>
            {(Object.keys(PHONE_STATUS) as Status[]).map((s) => (
              <option key={s} value={s}>
                {PHONE_STATUS[s].label}
              </option>
            ))}
          </select>
          {list.isSuccess && (
            <span className="xs muted" style={{ marginLeft: 'auto' }}>
              {filtered ? `${rows.length} of ${plural(all.length, 'phone')}` : plural(all.length, 'phone')}
              {hidden ? ` · ${hidden} hidden` : ''}
            </span>
          )}
        </div>
        {list.isError ? (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : list.isPending ? (
          <div className="card-body">
            <SkeletonLines rows={6} />
          </div>
        ) : all.length === 0 ? (
          <div className="card-body">
            <EmptyState
              icon="smartphone"
              title="No phones yet"
              as="h2"
              action={
                canManage && (
                  <Button size="sm" icon="plus" to={phoneHref('new')}>
                    Add phone
                  </Button>
                )
              }
            >
              Add the phones the app’s Phone tab shows, with their prices, colors, photos and spec sheet.
            </EmptyState>
          </div>
        ) : (
          <TableWrap label="Phones table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col" style={{ width: 24 }}>
                    <span className="sr-only">Order</span>
                  </th>
                  <th scope="col">Phone</th>
                  <th scope="col">Storage</th>
                  <th scope="col">Price</th>
                  <th scope="col">Colors</th>
                  <th scope="col" className="r">
                    Photos
                  </th>
                  <th scope="col" className="r">
                    Ads
                  </th>
                  <th scope="col" className="r">
                    Specs
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => {
                  const s = cheapest(p);
                  const h = sort.handle(p.id);
                  return (
                    <tr key={p.id} ref={sort.item(p.id)} style={sort.dragged === p.id ? { opacity: 0.6 } : undefined}>
                      <td>
                        {canManage ? (
                          <button type="button" className="icon-btn sm" aria-label={`Move ${p.name}`} title="Drag, or use the arrow keys, to move" disabled={order.isPending} {...h} style={{ ...h.style, width: 30, height: 30 }}>
                            <Icon name="grip-vertical" className="ic-sm" />
                          </button>
                        ) : (
                          <span className="muted" style={{ display: 'inline-flex' }}>
                            <Icon name="grip-vertical" className="ic-sm" />
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="row nowrap gap-3" style={{ minWidth: 220 }}>
                          <Img icon="smartphone" src={p.photos[0]?.thumbUrl ?? p.photos[0]?.url} alt="" className="tiny" />
                          <span className="stack gap-0" style={{ minWidth: 0 }}>
                            <span className="strong">{p.name}</span>
                            <span className="xs muted">{p.brand}</span>
                          </span>
                        </span>
                      </td>
                      <td className="xs" style={{ color: 'var(--text-2)' }}>
                        {p.storage.map((x) => x.size).join(', ')}
                      </td>
                      <td className="nowrap">
                        <span className="strong">{s ? `${p.storage.length > 1 ? 'from ' : ''}${formatMoney(s.price)}` : '—'}</span>
                        {s?.was && s.was.amount > s.price.amount && (
                          <>
                            {' '}
                            <s className="xs muted">{formatMoney(s.was)}</s>
                          </>
                        )}
                      </td>
                      <td className="xs" style={{ color: 'var(--text-2)' }}>
                        {p.colors.map((c) => c.short || c.name).join(', ') || '—'}
                      </td>
                      <td className="r">{p.photos.length}</td>
                      <td className="r">{p.adImages.length}</td>
                      <td className="r">{p.specGroups.reduce((n, g) => n + g.rows.length, 0)}</td>
                      <td>
                        <Badge tone={PHONE_STATUS[p.status].tone}>{PHONE_STATUS[p.status].label}</Badge>
                      </td>
                      <td className="xs muted nowrap">{dateTime(p.updatedAt)}</td>
                      <td className="r nowrap">
                        <Button variant="ghost" size="sm" to={phoneHref(p.id)}>
                          {canManage ? 'Edit' : 'View'}
                          <span className="sr-only"> {p.name}</span>
                        </Button>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="small muted">
                      No phones match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        )}
        <div className="card-foot" style={{ justifyContent: 'space-between' }}>
          <span className="xs muted">{canManage ? 'Drag a row to change its place on the Phone tab · hidden phones keep their place' : 'View only: adding, editing and ordering phones needs the Phones permission'}</span>
        </div>
      </section>

      <Dialog open={preview} onClose={() => setPreview(false)} title="Phone tab preview" size="lg">
        <p className="small muted" style={{ margin: 0 }}>
          The Phone tab is in the Marketly app. It shows {onTab.length ? plural(onTab.length, 'phone') : 'no phones'} like this, in this order; hidden phones are left out.
        </p>
        {onTab.length > 0 ? (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, 168px)' }}>
            {onTab.map((p) => (
              <PhoneTile key={p.id} name={p.name} meta={[p.storage[0]?.size, p.colors[0]?.name].filter(Boolean).join(' · ')} cover={p.photos[0]?.thumbUrl ?? p.photos[0]?.url} price={p.storage[0]?.price ?? null} was={p.storage[0]?.was} />
            ))}
          </div>
        ) : (
          <span className="small muted">Turn on “Show on the Phone tab” on a phone to show it here.</span>
        )}
      </Dialog>
    </DeptPage>
  );
}
