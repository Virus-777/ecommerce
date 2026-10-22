import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { formatMoney, num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { Alert, announce, Badge, Button, Checkbox, Dialog, Drawer, EmptyState, Field, IconButton, Img, KeyValue, LogoTile, PageHeader, Pager, SearchInput, SegmentedControl, Select, StatusBadge, Switch, TableWrap, Tabs, Textarea, TextInput, Timeline } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { dateTime, LoadError, SkeletonLines, time, TZ } from '@/app/parts';
import { initialsOf, tintOf } from './data/categories';
import {
  codeOf, DeptPage, FOOD_ORDER_STATUS, fieldErrorsOf, HideReviewDialog, LinesField, moneyText, newKey, PAGE_SIZE, PhotosField, PictureField, plural, RESTAURANT_STATUS, slugify, toMoney, totalPagesOf, WEEKDAYS,
  type FoodAction, type FoodCategory, type FoodDay, type FoodOrder, type FoodOrderStatus, type FoodReview, type MediaRef, type MenuItem, type MenuItemInput, type MenuSection, type OptionGroup, type Restaurant, type RestaurantInput, type RestaurantStatus,
} from './data/departments';

// Admin › Departments › Food delivery (designed in React from the Marketly Departments canvas: FoodHome, FoodService,
// FoodItem; no admin artboard, so the DeptServices pattern). Tabs: Orders | Restaurants | Categories | Reviews.
// API: /api/admin/food/{orders,restaurants,sections,items,categories,reviews}. Customers pay by card in the food flow
// (no cart): the card is authorized when the order is placed and captured on delivery; declined and cancelled orders
// are only voided. Staff accept, prepare, send, deliver or cancel each order on the restaurant's behalf.

type Tab = '' | 'restaurants' | 'categories' | 'reviews';
type Notify = (title: string, tone?: 'success' | 'danger') => void;
type Ctx = { notify: Notify; canManage: boolean };
type Adding = { adding: boolean; setAdding: (v: boolean) => void };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const REFRESH_MS = 30_000;
const MAX_PHOTOS = 12;
const MAX_ITEM_PHOTOS = 5;

/** Who changed an order, from the history's actor key (customer, staff:<id>, system) */
const byLabel = (by: string) => (by.startsWith('staff:') ? 'staff' : by.startsWith('system') ? 'automatic' : by);
const itemsOf = (o: FoodOrder) => o.lines.reduce((s, l) => s + l.quantity, 0);
const ratingText = (r: { average?: number | null; count: number }) => (r.average != null && r.count ? `★ ${r.average.toFixed(1)} (${num(r.count)})` : 'No reviews');

export default function DeptFood() {
  const { api } = useApi();
  const { can } = useStaffSession();
  const canView = can('food.view');
  const canManage = can('food.manage');
  const canHandle = can('food.orders.manage');
  const [view, setView] = useView<Exclude<Tab, ''>>();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; title: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const notify: Notify = (title, tone = 'success') => {
    setNotice({ tone, title });
    announce(title);
  };
  const waiting = useQuery({ queryKey: ['food', 'orders', 'waiting'], enabled: canView, refetchInterval: REFRESH_MS, queryFn: () => call(api.GET('/api/admin/food/orders', { params: { query: { status: 'placed', limit: 1 } } })) });
  const ctx: Ctx = { notify, canManage };
  const addLabel = view === 'restaurants' ? 'Add restaurant' : view === 'categories' ? 'Add category' : '';

  return (
    <DeptPage active="dept-food" title="Food delivery" canView={canView} need="See restaurants, menus, food orders and reviews in Food delivery">
      <PageHeader
        crumbs={[{ label: 'Departments' }, { label: 'Food delivery' }]}
        title="Food delivery"
        sub={`Food orders from the app, the restaurants and their menus · staff handle each order for the restaurant; the card is charged on delivery${canManage ? '' : ' · view only: editing needs the Food delivery permission'}`}
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
          { value: '', label: 'Orders', count: waiting.data?.total || undefined },
          { value: 'restaurants', label: 'Restaurants' },
          { value: 'categories', label: 'Categories' },
          { value: 'reviews', label: 'Reviews' },
        ]}
        active={view}
        onChange={(v) => {
          setNotice(null);
          setAdding(false);
          setView(v as Tab);
        }}
        label="Food delivery sections"
      />
      {notice && <Alert tone={notice.tone} title={notice.title} />}
      {view === 'restaurants' ? (
        <RestaurantsTab {...ctx} adding={adding} setAdding={setAdding} />
      ) : view === 'categories' ? (
        <CategoriesTab {...ctx} adding={adding} setAdding={setAdding} />
      ) : view === 'reviews' ? (
        <ReviewsTab {...ctx} />
      ) : (
        <OrdersTab {...ctx} canHandle={canHandle} />
      )}
    </DeptPage>
  );
}

/* ---------------- shared lookups ---------------- */

function useCategories() {
  const { api } = useApi();
  return useQuery({ queryKey: ['food', 'categories'], queryFn: () => call(api.GET('/api/admin/food/categories')) });
}
function useAllRestaurants() {
  const { api } = useApi();
  return useQuery({ queryKey: ['food', 'restaurants', 'all'], queryFn: () => call(api.GET('/api/admin/food/restaurants', { params: { query: { limit: 100 } } })) });
}

/* ---------------- Orders ---------------- */

const ACTION: Record<FoodAction, { label: string; variant: 'primary' | 'secondary' | 'danger-soft'; done: string; needsNote?: boolean }> = {
  accept: { label: 'Accept', variant: 'primary', done: 'accepted' },
  prepare: { label: 'Start preparing', variant: 'primary', done: 'being prepared' },
  send: { label: 'Send', variant: 'primary', done: 'on the way' },
  deliver: { label: 'Mark delivered', variant: 'primary', done: 'delivered: the card was charged' },
  decline: { label: 'Decline', variant: 'danger-soft', done: 'declined: the card hold was released', needsNote: true },
  cancel: { label: 'Cancel', variant: 'secondary', done: 'cancelled: the card hold was released', needsNote: true },
};
const ACTION_ORDER: FoodAction[] = ['accept', 'prepare', 'send', 'deliver', 'decline', 'cancel'];
const addressLines = (a: FoodOrder['address']) => [a.name, a.line1, a.line2, `${a.city}, ${a.region} ${a.postalCode}`].filter(Boolean) as string[];

function OrdersTab({ notify, canHandle }: Ctx & { canHandle: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const restaurants = useAllRestaurants();
  const [state, setState] = useState<'open' | 'past' | ''>('open');
  const [status, setStatus] = useState<FoodOrderStatus | ''>('');
  const [restaurantId, setRestaurantId] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<FoodOrder | null>(null);
  const [note, setNote] = useState('');
  const [staffNote, setStaffNote] = useState('');
  const [error, setError] = useState('');
  const query = { state: state || undefined, status: status || undefined, restaurantId: restaurantId || undefined, q: q.trim() || undefined };
  const list = useQuery({
    queryKey: ['food', 'orders', query, page],
    queryFn: () => call(api.GET('/api/admin/food/orders', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
    // every 30 s while the browser tab is visible (react-query pauses intervals in hidden tabs)
    refetchInterval: REFRESH_MS,
  });
  const rows = list.data?.items ?? [];
  // the drawer follows the refreshed list (the newer of the two copies)
  const shown = open ? (rows.find((r) => r.id === open.id && r.history.length >= open.history.length) ?? open) : null;
  const show = (o: FoodOrder) => (setOpen(o), setNote(''), setStaffNote(o.staffNote ?? ''), setError(''));

  const act = useMutation({
    mutationFn: ({ o, action }: { o: FoodOrder; action: FoodAction }) => call(api.POST('/api/admin/food/orders/{id}/status', { params: { path: { id: o.id } }, body: { action, note: note.trim() || null, staffNote: staffNote.trim() || null } })),
    onSuccess: (o, v) => {
      void qc.invalidateQueries({ queryKey: ['food', 'orders'] });
      notify(`${o.ref} ${ACTION[v.action].done}`);
      setOpen(o);
      setNote('');
      setError('');
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: ['food', 'orders'] });
      setError(codeOf(e) === 'PAYMENT_CAPTURE_FAILED' ? 'The card couldn’t be charged, so the order is still on the way. Try “Mark delivered” again in a moment, or cancel the order.' : codeOf(e) === 'ILLEGAL_TRANSITION' ? 'The order changed in the meantime. Check its status and try again.' : errorMessage(e));
    },
  });
  const run = (o: FoodOrder, action: FoodAction) => {
    if (ACTION[action].needsNote && !note.trim()) {
      setError(`Say why in the note to the customer before you ${action === 'decline' ? 'decline' : 'cancel'} the order.`);
      document.getElementById('fo-note')?.focus();
      return;
    }
    act.mutate({ o, action });
  };

  return (
    <>
      <section className="card">
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="fo-q" placeholder="FD- reference, customer name or email" value={q} onChange={(v) => (setQ(v), setPage(1))} label="Search food orders" />
            <select className="select" id="fo-state" aria-label="Open or past" value={state} onChange={(e) => (setState(e.target.value as 'open' | 'past' | ''), setPage(1))}>
              <option value="open">Open orders</option>
              <option value="past">Past orders</option>
              <option value="">All orders</option>
            </select>
            <select className="select" id="fo-st" aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value as FoodOrderStatus | ''), setPage(1))}>
              <option value="">All statuses</option>
              {(Object.keys(FOOD_ORDER_STATUS) as FoodOrderStatus[]).map((s) => (
                <option key={s} value={s}>
                  {FOOD_ORDER_STATUS[s].label}
                </option>
              ))}
            </select>
            <select className="select" id="fo-rest" aria-label="Restaurant" value={restaurantId} onChange={(e) => (setRestaurantId(e.target.value), setPage(1))}>
              <option value="">All restaurants</option>
              {(restaurants.data?.items ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
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
        <TableWrap label="Food orders table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Ref</th>
                <th scope="col">Customer</th>
                <th scope="col">Restaurant</th>
                <th className="r" scope="col">
                  Items
                </th>
                <th className="r" scope="col">
                  Total
                </th>
                <th scope="col">Status</th>
                <th scope="col">Placed</th>
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
              {rows.map((o) => (
                <tr key={o.id}>
                  <td className="mono small strong nowrap">{o.ref}</td>
                  <td>
                    <span className="stack gap-0">
                      <span className="small strong">{o.customer.name ?? o.address.name}</span>
                      <span className="xs muted">{o.contactPhone ?? o.customer.email ?? ''}</span>
                    </span>
                  </td>
                  <td className="small">{o.restaurant.name}</td>
                  <td className="r small">{itemsOf(o)}</td>
                  <td className="r small nowrap">{formatMoney(o.total)}</td>
                  <td>
                    <StatusBadge status={FOOD_ORDER_STATUS[o.status].label} tone={FOOD_ORDER_STATUS[o.status].tone} />
                  </td>
                  <td className="small nowrap">{o.placedAt ? dateTime(o.placedAt) : <span className="muted">{dateTime(o.createdAt)}</span>}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => show(o)}>
                      Open<span className="sr-only"> {o.ref}</span>
                    </button>
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <EmptyState icon="utensils" title={state === 'open' && !q && !status && !restaurantId ? 'No open orders' : 'No orders here'}>
                      {state === 'open' && !q && !status && !restaurantId ? 'New food orders show up here as customers place them. The list refreshes every 30 seconds.' : 'Try another filter or search.'}
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <div className="card-foot between">
          <span className="xs muted">Refreshes every 30 seconds{list.dataUpdatedAt ? ` · updated ${time(new Date(list.dataUpdatedAt).toISOString())}` : ''} · orders not accepted in time are declined automatically.</span>
          <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
        </div>
      </section>

      <Drawer open={!!shown} onClose={() => setOpen(null)} className="wide" title={shown ? `${shown.ref} · ${shown.restaurant.name}` : 'Order'}>
        {shown && (
          <>
            {error && <Alert tone="danger" title={error} />}
            <div className="row gap-2 wrap">
              <StatusBadge status={FOOD_ORDER_STATUS[shown.status].label} tone={FOOD_ORDER_STATUS[shown.status].tone} />
              <span className="small muted">
                {shown.statusLabel}
                {shown.placedAt ? ` · placed ${dateTime(shown.placedAt)}` : ''}
              </span>
            </div>
            <div className="stack gap-2">
              <span className="label">{plural(itemsOf(shown), 'item')}</span>
              <ul className="list">
                {shown.lines.map((l, i) => (
                  <li key={`${l.itemId}-${i}`}>
                    <Img icon="utensils" src={l.image?.url} alt="" className="tiny" />
                    <span className="grow stack gap-0">
                      <span className="small strong">
                        {l.quantity} × {l.name}
                      </span>
                      {l.optionsLabel && <span className="xs muted">{l.optionsLabel}</span>}
                      {l.note && <span className="xs" style={{ fontStyle: 'italic' }}>“{l.note}”</span>}
                    </span>
                    <span className="small nowrap">{formatMoney(l.total)}</span>
                  </li>
                ))}
              </ul>
              <KeyValue
                pairs={[
                  ['Subtotal', formatMoney(shown.subtotal)],
                  ['Delivery', shown.deliveryFee.amount ? formatMoney(shown.deliveryFee) : 'Free'],
                  [<span className="strong">Total</span>, <span className="strong">{formatMoney(shown.total)}</span>],
                ]}
              />
            </div>
            <KeyValue
              pairs={[
                ['Customer', shown.customer.name ?? shown.address.name],
                ['Email', shown.customer.email ? <a href={`mailto:${shown.customer.email}`}>{shown.customer.email}</a> : '—'],
                ['Phone', shown.contactPhone ? <a href={`tel:${shown.contactPhone}`}>{shown.contactPhone}</a> : shown.address.phone ? <a href={`tel:${shown.address.phone}`}>{shown.address.phone}</a> : '—'],
                ['Deliver to', <span style={{ whiteSpace: 'pre-line' }}>{addressLines(shown.address).join('\n')}</span>],
                ['Courier note', shown.courierNote ?? '—'],
                ['Arrives', shown.etaLabel ?? '—'],
                ['Payment', [shown.methodLabel, shown.paymentState].filter(Boolean).join(' · ') || '—'],
                ...(shown.restaurantNote ? [['Note to the customer', shown.restaurantNote] as [string, ReactNode]] : []),
              ]}
            />
            <div className="stack gap-2">
              <span className="label">History</span>
              <Timeline events={[...shown.history].reverse().map((h, i) => ({ t: FOOD_ORDER_STATUS[h.status as FoodOrderStatus]?.label ?? h.status, d: `${dateTime(h.at)}${h.by ? ` · ${byLabel(h.by)}` : ''}${h.note ? ` · “${h.note}”` : ''}`, state: i === 0 ? 'current' : 'done' }))} />
            </div>
            {canHandle && shown.actions.length > 0 && (
              <>
                <Field label="Note to the customer" optional hint="Needed to decline or cancel, e.g. Out of fresh dough tonight">
                  <Textarea id="fo-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
                <Field label="Staff note" optional hint="Only staff see it">
                  <Textarea id="fo-snote" rows={2} value={staffNote} onChange={(e) => setStaffNote(e.target.value)} />
                </Field>
                <div className="row gap-2 wrap">
                  {ACTION_ORDER.filter((a) => shown.actions.includes(a)).map((a) => (
                    <Button key={a} variant={ACTION[a].variant} size="sm" onClick={() => run(shown, a)} disabled={act.isPending}>
                      {act.isPending && act.variables?.action === a ? 'Working…' : ACTION[a].label}
                    </Button>
                  ))}
                </div>
              </>
            )}
            {!canHandle && shown.staffNote && <KeyValue pairs={[['Staff note', shown.staffNote]]} />}
          </>
        )}
      </Drawer>
    </>
  );
}

/* ---------------- Restaurants ---------------- */

function RestaurantsTab({ notify, canManage, adding, setAdding }: Ctx & Adding) {
  const { api } = useApi();
  const categories = useCategories();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<RestaurantStatus | ''>('');
  const [categoryId, setCategoryId] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Restaurant | null>(null);
  // one editor per opening: saving a new restaurant keeps the same editor (it moves on to the menu)
  const [session, setSession] = useState(0);
  const [wasAdding, setWasAdding] = useState(adding);
  if (adding !== wasAdding) {
    setWasAdding(adding);
    if (adding) {
      setEditing(null);
      setSession((s) => s + 1);
    }
  }
  const query = { q: q.trim() || undefined, status: status || undefined, categoryId: categoryId || undefined };
  const list = useQuery({
    queryKey: ['food', 'restaurants', query, page],
    queryFn: () => call(api.GET('/api/admin/food/restaurants', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];

  if (editing || adding) {
    return <RestaurantEditor key={session} restaurant={editing ?? undefined} categories={categories.data ?? []} notify={notify} canManage={canManage} onSaved={setEditing} onClose={() => (setEditing(null), setAdding(false))} />;
  }
  return (
    <section className="card">
      <div className="card-body">
        <div className="toolbar">
          <SearchInput id="fr-q" placeholder="Search restaurants" value={q} onChange={(v) => (setQ(v), setPage(1))} label="Search restaurants" />
          <select className="select" id="fr-st" aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value as RestaurantStatus | ''), setPage(1))}>
            <option value="">All statuses</option>
            {(Object.keys(RESTAURANT_STATUS) as RestaurantStatus[]).map((s) => (
              <option key={s} value={s}>
                {RESTAURANT_STATUS[s].label}
              </option>
            ))}
          </select>
          <select className="select" id="fr-cat" aria-label="Category" value={categoryId} onChange={(e) => (setCategoryId(e.target.value), setPage(1))}>
            <option value="">All categories</option>
            {(categories.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
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
      <TableWrap label="Restaurants table">
        <table className="table">
          <thead>
            <tr>
              <th className="r" scope="col">
                Order
              </th>
              <th scope="col">Restaurant</th>
              <th scope="col">Cuisine</th>
              <th scope="col">City</th>
              <th scope="col">Rating</th>
              <th className="r" scope="col">
                Items
              </th>
              <th className="r" scope="col">
                Open orders
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
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="r small">{r.position}</td>
                <td>
                  <span className="row nowrap gap-3">
                    {r.logo ? <Img icon="store" src={r.logo.url} alt="" className="tiny" /> : <LogoTile initials={initialsOf(r.name)} tint={tintOf(r.name)} size="sm" />}
                    <span className="stack gap-0">
                      <span className="row gap-2">
                        <span className="small strong">{r.name}</span>
                        {r.promoBadge && <Badge tone="deal">{r.promoBadge}</Badge>}
                      </span>
                      <span className="xs muted">{r.phone ?? `/${r.slug}`}</span>
                    </span>
                  </span>
                </td>
                <td className="small">{r.cuisine}</td>
                <td className="small">{r.city ?? '—'}</td>
                <td className="small nowrap">{ratingText(r.ratings)}</td>
                <td className="r small">{num(r.itemCount)}</td>
                <td className="r small">{r.openOrders ? <Badge tone="brand">{r.openOrders}</Badge> : '0'}</td>
                <td>
                  <StatusBadge status={RESTAURANT_STATUS[r.status].label} tone={RESTAURANT_STATUS[r.status].tone} />
                </td>
                <td>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setEditing(r), setSession((s) => s + 1))}>
                    {canManage ? 'Edit' : 'View'}
                    <span className="sr-only"> {r.name}</span>
                  </button>
                </td>
              </tr>
            ))}
            {list.isSuccess && rows.length === 0 && (
              <tr>
                <td colSpan={9}>
                  <EmptyState icon="utensils" title={q || status || categoryId ? 'No restaurants match' : 'No restaurants yet'}>
                    {q || status || categoryId ? 'Try another search or clear the filters.' : 'Add a restaurant with “Add restaurant”, then its menu: sections, items, sizes and extras.'}
                  </EmptyState>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableWrap>
      <div className="card-foot between">
        <span className="xs muted">The app lists published restaurants in this order · paused ones show as closed.</span>
        <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
      </div>
    </section>
  );
}

type RestaurantDraft = {
  name: string; slug: string; cuisine: string; categoryIds: string[]; image: MediaRef | null; logo: MediaRef | null; photos: MediaRef[]; address: string; city: string; phone: string; days: FoodDay[]; timeZone: string;
  deliveryMin: string; deliveryMax: string; fee: string; freeOver: string; minOrder: string; promoText: string; promoBadge: string; status: RestaurantStatus; position: string;
};
const DEFAULT_DAYS: FoodDay[] = WEEKDAYS.map((w) => ({ weekday: w.value, open: true, from: '11:00', to: '22:00' }));
const restaurantDraftOf = (r?: Restaurant): RestaurantDraft => ({
  name: r?.name ?? '',
  slug: r?.slug ?? '',
  cuisine: r?.cuisine ?? '',
  categoryIds: r?.categoryIds ?? [],
  image: r?.image ?? null,
  logo: r?.logo ?? null,
  photos: r?.photos ?? [],
  address: r?.address ?? '',
  city: r?.city ?? '',
  phone: r?.phone ?? '',
  days: WEEKDAYS.map((w) => r?.hours.find((d) => d.weekday === w.value) ?? (r ? { weekday: w.value, open: false, from: null, to: null } : DEFAULT_DAYS.find((d) => d.weekday === w.value)!)),
  timeZone: r?.timeZone ?? '',
  deliveryMin: r ? String(r.deliveryMinMinutes) : '20',
  deliveryMax: r ? String(r.deliveryMaxMinutes) : '35',
  fee: r ? moneyText(r.deliveryFee) : '1.99',
  freeOver: moneyText(r?.freeDeliveryOver),
  minOrder: moneyText(r?.minOrder),
  promoText: r?.promoText ?? '',
  promoBadge: r?.promoBadge ?? '',
  status: r?.status ?? 'draft',
  position: r ? String(r.position) : '',
});
const badMoney = (v: string, required = false) => (v.trim() ? Number.isNaN(Number(v)) || Number(v) < 0 : required);
function restaurantProblems(d: RestaurantDraft) {
  const min = Number(d.deliveryMin);
  const max = Number(d.deliveryMax);
  return {
    name: d.name.trim() ? '' : 'Enter the restaurant’s name.',
    cuisine: d.cuisine.trim() ? '' : 'Enter the cuisine, e.g. Pizza · Italian.',
    delivery: !Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 240 || !d.deliveryMin.trim() || !d.deliveryMax.trim() ? 'Enter the delivery time in whole minutes, e.g. 20 to 30.' : min > max ? 'The shortest delivery time can’t be longer than the longest.' : '',
    fee: badMoney(d.fee, true) ? 'Enter the delivery fee in dollars (0 for free delivery).' : '',
    freeOver: badMoney(d.freeOver) ? 'Enter the free-delivery threshold in dollars.' : '',
    minOrder: badMoney(d.minOrder) ? 'Enter the minimum order in dollars.' : '',
    hours: d.days.some((x) => x.open && !(TIME.test(x.from ?? '') && TIME.test(x.to ?? ''))) ? 'Each open day needs an opening and a closing time (HH:MM).' : '',
  };
}

function RestaurantEditor({ restaurant, categories, notify, canManage, onSaved, onClose }: Ctx & { restaurant?: Restaurant; categories: FoodCategory[]; onSaved: (r: Restaurant) => void; onClose: () => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [part, setPart] = useState<'details' | 'menu'>('details');
  const [draft, setDraft] = useState<RestaurantDraft>(() => restaurantDraftOf(restaurant));
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const d = draft;
  const setD = (patch: Partial<RestaurantDraft>) => setDraft((x) => ({ ...x, ...patch }));
  const setDay = (i: number, patch: Partial<FoodDay>) => setDraft((x) => ({ ...x, days: x.days.map((y, k) => (k === i ? { ...y, ...patch } : y)) }));
  const errs = tried ? restaurantProblems(d) : null;

  const save = useMutation({
    mutationFn: (x: RestaurantDraft) => {
      const body: RestaurantInput = {
        name: x.name.trim(),
        slug: x.slug.trim() || null,
        cuisine: x.cuisine.trim(),
        categoryIds: x.categoryIds,
        imageId: x.image?.id ?? null,
        logoId: x.logo?.id ?? null,
        photoIds: x.photos.map((p) => p.id),
        address: x.address.trim() || null,
        city: x.city.trim() || null,
        phone: x.phone.trim() || null,
        hours: x.days.map((y) => (y.open ? y : { ...y, from: null, to: null })),
        timeZone: x.timeZone.trim() || null,
        deliveryMinMinutes: Number(x.deliveryMin),
        deliveryMaxMinutes: Number(x.deliveryMax),
        deliveryFee: toMoney(x.fee) ?? { amount: 0, currency: 'USD' },
        freeDeliveryOver: toMoney(x.freeOver),
        minOrder: toMoney(x.minOrder),
        promoText: x.promoText.trim() || null,
        promoBadge: x.promoBadge.trim() || null,
        status: x.status,
        position: x.position.trim() ? Number(x.position) : null,
      };
      return restaurant ? call(api.PATCH('/api/admin/food/restaurants/{id}', { params: { path: { id: restaurant.id } }, body })) : call(api.POST('/api/admin/food/restaurants', { body }));
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['food'] });
      notify(restaurant ? `${r.name} saved` : `${r.name} added as ${RESTAURANT_STATUS[r.status].label.toLowerCase()}: add its menu next`);
      setTried(false);
      setError('');
      onSaved(r);
      if (!restaurant) setPart('menu');
    },
    onError: (e) => {
      const fe = Object.values(fieldErrorsOf(e));
      setError(codeOf(e) === 'SLUG_TAKEN' ? 'Another restaurant already uses this slug.' : fe.length ? fe.join(' ') : errorMessage(e));
    },
  });
  const remove = useMutation({
    mutationFn: () => call(api.DELETE('/api/admin/food/restaurants/{id}', { params: { path: { id: restaurant!.id } } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['food'] });
      notify(`${restaurant!.name} deleted`);
      onClose();
    },
    onError: (e) => {
      setConfirmDelete(false);
      setError(codeOf(e) === 'IN_USE' ? 'This restaurant has orders, so it can’t be deleted. Pause it (closed for now) or hide it instead.' : errorMessage(e));
    },
  });
  const submit = () => {
    setTried(true);
    if (Object.values(restaurantProblems(d)).some(Boolean)) return;
    save.mutate(d);
  };
  const toggleCategory = (id: string, on: boolean) => setD({ categoryIds: on ? [...d.categoryIds, id] : d.categoryIds.filter((x) => x !== id) });

  return (
    <>
      <div className="row between wrap gap-3">
        <div className="row gap-3 items-center">
          <Button variant="ghost" size="sm" icon="arrow-left" onClick={onClose}>
            All restaurants
          </Button>
          <h2 className="h3" style={{ margin: 0 }}>
            {restaurant ? restaurant.name : 'Add restaurant'}
          </h2>
          {restaurant && <StatusBadge status={RESTAURANT_STATUS[restaurant.status].label} tone={RESTAURANT_STATUS[restaurant.status].tone} />}
        </div>
        {restaurant && <SegmentedControl label="Restaurant part" items={[{ value: 'details', label: 'Details' }, { value: 'menu', label: 'Menu' }]} active={part} onChange={setPart} />}
      </div>
      {part === 'menu' && restaurant ? (
        <MenuEditor restaurant={restaurant} notify={notify} canManage={canManage} />
      ) : (
        <section className="card">
          <fieldset className="card-body stack gap-4" disabled={!canManage} style={{ border: 0, margin: 0 }}>
            {error && (
              <Alert tone="danger" title="The restaurant wasn’t saved">
                {error}
              </Alert>
            )}
            {errs && Object.values(errs).some(Boolean) && <Alert tone="danger" title={Object.values(errs).find(Boolean)!} />}
            <div className="grid md2 gap-3">
              <Field label="Name" error={errs?.name}>
                <TextInput id="fr-name" value={d.name} error={!!errs?.name} onChange={(e) => setD({ name: e.target.value })} />
              </Field>
              <Field label="Cuisine" hint="On the card, e.g. Pizza · Italian" error={errs?.cuisine}>
                <TextInput id="fr-cuisine" value={d.cuisine} error={!!errs?.cuisine} onChange={(e) => setD({ cuisine: e.target.value })} />
              </Field>
            </div>
            <div className="grid md2 gap-3">
              <Field label="Slug" optional hint={d.slug.trim() || slugify(d.name) || '…'}>
                <TextInput id="fr-slug" value={d.slug} placeholder={slugify(d.name)} onChange={(e) => setD({ slug: e.target.value })} />
              </Field>
              <Field label="Order" optional hint="Lower numbers show first">
                <TextInput id="fr-pos" type="number" min={1} value={d.position} onChange={(e) => setD({ position: e.target.value })} />
              </Field>
            </div>
            <div className="stack gap-2">
              <span className="label">Categories</span>
              <span className="xs sub">The food category chips customers find it under</span>
              {categories.length ? (
                <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', columnGap: 16 }}>
                  {categories.map((c) => (
                    <Checkbox key={c.id} id={`fr-cat-${c.id}`} label={c.visible ? c.name : `${c.name} (hidden)`} checked={d.categoryIds.includes(c.id)} onChange={(e) => toggleCategory(c.id, e.target.checked)} />
                  ))}
                </div>
              ) : (
                <span className="small muted">No food categories yet: add them on the Categories tab.</span>
              )}
            </div>
            <PictureField label="Card picture" shape="wide" icon="utensils" value={d.image} alt={d.name.trim()} hint="16 : 9, saved at 1200 × 675. On the restaurant’s card and page." disabled={!canManage} onChange={(image) => setD({ image })} />
            <PictureField label="Logo" shape="square" icon="store" value={d.logo} alt={d.name.trim()} hint="Square, saved at 600 × 600. Without one, the app shows initials." disabled={!canManage} onChange={(logo) => setD({ logo })} />
            <PhotosField photos={d.photos} max={MAX_PHOTOS} alt={d.name.trim()} disabled={!canManage} onChange={(photos) => setD({ photos })} />
            <h3 className="h4">Delivery</h3>
            <div className="grid md2 gap-3">
              <Field label="Delivery time from (minutes)" error={errs?.delivery}>
                <TextInput id="fr-dmin" type="number" min={1} value={d.deliveryMin} error={!!errs?.delivery} onChange={(e) => setD({ deliveryMin: e.target.value })} />
              </Field>
              <Field label="Delivery time to (minutes)" hint="Customers see e.g. 20–30 min">
                <TextInput id="fr-dmax" type="number" min={1} value={d.deliveryMax} error={!!errs?.delivery} onChange={(e) => setD({ deliveryMax: e.target.value })} />
              </Field>
            </div>
            <div className="grid md2 gap-3">
              <Field label="Delivery fee" hint="Dollars; 0 for free delivery" error={errs?.fee}>
                <TextInput id="fr-fee" inputMode="decimal" prefix="$" value={d.fee} error={!!errs?.fee} onChange={(e) => setD({ fee: e.target.value })} />
              </Field>
              <Field label="Free delivery over" optional hint="The fee is waived from this subtotal" error={errs?.freeOver}>
                <TextInput id="fr-free" inputMode="decimal" prefix="$" value={d.freeOver} error={!!errs?.freeOver} onChange={(e) => setD({ freeOver: e.target.value })} />
              </Field>
            </div>
            <div className="grid md2 gap-3">
              <Field label="Minimum order" optional error={errs?.minOrder}>
                <TextInput id="fr-min" inputMode="decimal" prefix="$" value={d.minOrder} error={!!errs?.minOrder} onChange={(e) => setD({ minOrder: e.target.value })} />
              </Field>
              <Field label="Badge on the card" optional hint="Short, e.g. Free delivery">
                <TextInput id="fr-badge" value={d.promoBadge} onChange={(e) => setD({ promoBadge: e.target.value })} />
              </Field>
            </div>
            <Field label="Promotion line" optional hint="On the restaurant’s page, e.g. Free delivery on orders over $25 this week">
              <TextInput id="fr-promo" value={d.promoText} onChange={(e) => setD({ promoText: e.target.value })} />
            </Field>
            <h3 className="h4">Contact</h3>
            <div className="grid md2 gap-3">
              <Field label="Phone" optional>
                <TextInput id="fr-phone" type="tel" value={d.phone} onChange={(e) => setD({ phone: e.target.value })} />
              </Field>
              <Field label="City" optional hint="Cards show the city">
                <TextInput id="fr-city" value={d.city} onChange={(e) => setD({ city: e.target.value })} />
              </Field>
            </div>
            <Field label="Address" optional>
              <Textarea id="fr-addr" rows={2} value={d.address} onChange={(e) => setD({ address: e.target.value })} />
            </Field>
            <div className="stack gap-2">
              <span className="label">Opening hours</span>
              <span className="xs sub">In the restaurant’s time zone. A closing time before the opening time runs past midnight.</span>
              {d.days.map((x, i) => (
                <div key={x.weekday} className="row gap-3 wrap items-center">
                  <span className="small" style={{ width: 96 }}>
                    {WEEKDAYS[i].label}
                  </span>
                  <Switch id={`fr-open-${x.weekday}`} label={x.open ? 'Open' : 'Closed'} checked={x.open} onChange={(e) => setDay(i, e.target.checked ? { open: true, from: x.from ?? '11:00', to: x.to ?? '22:00' } : { open: false })} />
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
            <Field label="Time zone" optional hint={`An IANA name, e.g. America/Chicago; empty uses the market’s (${TZ})`}>
              <TextInput id="fr-tz" value={d.timeZone} placeholder={TZ} onChange={(e) => setD({ timeZone: e.target.value })} />
            </Field>
            <Field label="Status" hint="Paused: shown as closed, no new orders">
              <Select id="fr-status" value={d.status} options={(Object.keys(RESTAURANT_STATUS) as RestaurantStatus[]).map((s) => ({ value: s, label: s === 'published' ? 'Published: customers see it' : RESTAURANT_STATUS[s].label }))} onChange={(e) => setD({ status: e.target.value as RestaurantStatus })} />
            </Field>
          </fieldset>
          {canManage && (
            <div className="card-foot">
              {restaurant && (
                <Button variant="danger-soft" size="sm" onClick={() => setConfirmDelete(true)} disabled={save.isPending || remove.isPending}>
                  Delete
                </Button>
              )}
              <span className="grow" />
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={submit} disabled={save.isPending || remove.isPending}>
                {restaurant ? 'Save restaurant' : 'Add restaurant'}
              </Button>
            </div>
          )}
        </section>
      )}
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${restaurant?.name ?? 'restaurant'}?`}
        foot={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Delete restaurant
            </Button>
          </>
        }
      >
        <p className="small" style={{ margin: 0 }}>
          The restaurant and its menu are removed for good. Restaurants with orders can only be paused or hidden.
        </p>
      </Dialog>
    </>
  );
}

/* ---------------- Menu ---------------- */

function MenuEditor({ restaurant, notify, canManage }: Ctx & { restaurant: Restaurant }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const menu = useQuery({ queryKey: ['food', 'menu', restaurant.id], queryFn: () => call(api.GET('/api/admin/food/restaurants/{id}/menu', { params: { path: { id: restaurant.id } } })) });
  const sections = [...(menu.data ?? [])].sort((a, b) => a.position - b.position);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [item, setItem] = useState<ItemDraft | null>(null);
  const [error, setError] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['food'] });

  const addSection = useMutation({
    mutationFn: (name: string) => call(api.POST('/api/admin/food/restaurants/{id}/sections', { params: { path: { id: restaurant.id } }, body: { name, position: (sections.at(-1)?.position ?? 0) + 1 } })),
    onSuccess: (s) => (refresh(), setNewName(''), setError(''), announce(`${s.name} added`)),
    onError: (e) => setError(errorMessage(e)),
  });
  const patchSection = useMutation({
    mutationFn: (changes: Array<{ s: MenuSection; name: string; position: number }>) => Promise.all(changes.map((c) => call(api.PATCH('/api/admin/food/sections/{id}', { params: { path: { id: c.s.id } }, body: { name: c.name, position: c.position } })))),
    onSuccess: () => (refresh(), setRenaming(null), setError('')),
    onError: (e) => setError(errorMessage(e)),
  });
  const removeSection = useMutation({
    mutationFn: (s: MenuSection) => call(api.DELETE('/api/admin/food/sections/{id}', { params: { path: { id: s.id } } })),
    onSuccess: (_r, s) => (refresh(), setError(''), notify(`${s.name} deleted`)),
    onError: (e, s) => setError(codeOf(e) === 'IN_USE' ? `${s.name} still has items: move or delete them first.` : errorMessage(e)),
  });
  const move = (i: number, dir: -1 | 1) => {
    const a = sections[i];
    if (!a || !sections[i + dir]) return;
    // positions may repeat or skip: number the new order 1, 2, 3… and save the sections whose number changed
    patchSection.mutate(swap(sections, i, i + dir).map((s, k) => ({ s, name: s.name, position: k + 1 })).filter((c) => c.s.position !== c.position));
    announce(`${a.name} moved ${dir < 0 ? 'up' : 'down'}`);
  };

  if (menu.isError) return <LoadError error={menu.error} onRetry={() => void menu.refetch()} />;
  if (menu.isPending) return <SkeletonLines rows={6} />;
  return (
    <>
      {error && <Alert tone="danger" title={error} />}
      {sections.length === 0 && (
        <section className="card">
          <div className="card-body">
            <EmptyState icon="utensils" title="No menu yet">
              Start with sections such as Pizzas, Sides and Drinks, then add the items to each.
            </EmptyState>
          </div>
        </section>
      )}
      {sections.map((s, i) => (
        <section key={s.id} className="card">
          <div className="card-head">
            {renaming?.id === s.id ? (
              <span className="row gap-2 grow">
                <input className="input grow" aria-label={`New name for ${s.name}`} value={renaming.name} onChange={(e) => setRenaming({ id: s.id, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && renaming.name.trim() && patchSection.mutate([{ s, name: renaming.name.trim(), position: s.position }])} />
                <Button size="sm" onClick={() => renaming.name.trim() && patchSection.mutate([{ s, name: renaming.name.trim(), position: s.position }])} disabled={patchSection.isPending || !renaming.name.trim()}>
                  Save
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <>
                <div className="stack gap-0">
                  <h3 className="h4">{s.name}</h3>
                  <span className="xs muted">{plural(s.items.length, 'item')}</span>
                </div>
                {canManage && (
                  <span className="row gap-1 nowrap">
                    <IconButton icon="arrow-up" label={`Move ${s.name} up`} disabled={i === 0 || patchSection.isPending} onClick={() => move(i, -1)} />
                    <IconButton icon="arrow-down" label={`Move ${s.name} down`} disabled={i === sections.length - 1 || patchSection.isPending} onClick={() => move(i, 1)} />
                    <Button variant="ghost" size="sm" onClick={() => setRenaming({ id: s.id, name: s.name })}>
                      Rename<span className="sr-only"> {s.name}</span>
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => removeSection.mutate(s)} disabled={removeSection.isPending}>
                      Delete<span className="sr-only"> {s.name}</span>
                    </Button>
                    <Button variant="secondary" size="sm" icon="plus" onClick={() => setItem(itemDraftOf(undefined, s.id, s.items.length + 1))}>
                      Add item<span className="sr-only"> to {s.name}</span>
                    </Button>
                  </span>
                )}
              </>
            )}
          </div>
          {s.items.length > 0 ? (
            <TableWrap label={`${s.name} items`}>
              <table className="table">
                <thead>
                  <tr>
                    <th className="r" scope="col">
                      Order
                    </th>
                    <th scope="col">Item</th>
                    <th className="r" scope="col">
                      Price
                    </th>
                    <th scope="col">Diet</th>
                    <th scope="col">Options</th>
                    <th scope="col">Rating</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...s.items].sort((a, b) => a.position - b.position).map((it) => (
                    <tr key={it.id}>
                      <td className="r small">{it.position}</td>
                      <td>
                        <span className="row nowrap gap-3">
                          <Img icon="utensils" src={it.photos[0]?.url} alt="" className="tiny" />
                          <span className="stack gap-0">
                            <span className="row gap-2">
                              <span className="small strong">{it.name}</span>
                              {it.tag && <Badge tone="brand">{it.tag}</Badge>}
                            </span>
                            <span className="xs muted truncate" style={{ maxWidth: 260 }}>
                              {[it.popular ? 'Popular' : '', it.recommended ? 'Recommended' : '', it.description ?? ''].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td className="r small nowrap">
                        <span className="strong">{formatMoney(it.price)}</span>
                        {it.wasPrice && (
                          <>
                            {' '}
                            <s className="xs muted">{formatMoney(it.wasPrice)}</s>
                          </>
                        )}
                      </td>
                      <td className="xs">{it.dietTags.join(', ') || <span className="muted">—</span>}</td>
                      <td className="xs">{it.optionGroups.length ? it.optionGroups.map((g) => g.name).join(', ') : <span className="muted">—</span>}</td>
                      <td className="small nowrap">{ratingText(it.ratings)}</td>
                      <td>{it.available ? <Badge tone="success">Available</Badge> : <Badge icon="eye-off">Unavailable</Badge>}</td>
                      <td>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setItem(itemDraftOf(it))}>
                          {canManage ? 'Edit' : 'View'}
                          <span className="sr-only"> {it.name}</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          ) : (
            <div className="card-body">
              <span className="small muted">No items in this section yet.</span>
            </div>
          )}
        </section>
      ))}
      {canManage && (
        <section className="card">
          <div className="card-body">
            <div className="row gap-2 wrap">
              <input className="input grow" id="fm-new" aria-label="New section name" placeholder="New section, e.g. Pizzas or Drinks" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && newName.trim() && addSection.mutate(newName.trim())} />
              <Button variant="secondary" size="sm" icon="plus" onClick={() => addSection.mutate(newName.trim())} disabled={!newName.trim() || addSection.isPending}>
                Add section
              </Button>
            </div>
          </div>
        </section>
      )}
      <ItemDrawer restaurant={restaurant} sections={sections} draft={item} setDraft={setItem} notify={notify} canManage={canManage} />
    </>
  );
}

type ChoiceDraft = { id: string; name: string; delta: string; default: boolean; available: boolean };
type GroupDraft = { id: string; name: string; required: boolean; min: string; max: string; choices: ChoiceDraft[] };
type ItemDraft = { id: string; sectionId: string; name: string; description: string; photos: MediaRef[]; price: string; wasPrice: string; tag: string; dietTags: string[]; popular: boolean; recommended: boolean; available: boolean; position: string; groups: GroupDraft[] };
const itemDraftOf = (it?: MenuItem, sectionId = '', position = 1): ItemDraft => ({
  id: it?.id ?? '',
  sectionId: it?.sectionId ?? sectionId,
  name: it?.name ?? '',
  description: it?.description ?? '',
  photos: it?.photos ?? [],
  price: moneyText(it?.price),
  wasPrice: moneyText(it?.wasPrice),
  tag: it?.tag ?? '',
  dietTags: it?.dietTags ?? [],
  popular: it?.popular ?? false,
  recommended: it?.recommended ?? false,
  available: it?.available ?? true,
  position: String(it?.position ?? position),
  groups: (it?.optionGroups ?? []).map((g) => ({ id: g.id, name: g.name, required: g.required, min: String(g.min), max: String(g.max), choices: g.choices.map((c) => ({ id: c.id, name: c.name, delta: moneyText(c.priceDelta) || '0', default: c.default, available: c.available })) })),
});
function itemProblems(d: ItemDraft) {
  const price = toMoney(d.price);
  const was = d.wasPrice.trim() ? toMoney(d.wasPrice) : null;
  const groupProblem = d.groups
    .map((g) => {
      const min = Number(g.min);
      const max = Number(g.max);
      if (!g.name.trim()) return 'Every option group needs a name, e.g. Size or Extras.';
      if (!g.choices.length) return `${g.name}: add at least one choice.`;
      if (g.choices.some((c) => !c.name.trim())) return `${g.name}: every choice needs a name.`;
      if (g.choices.some((c) => c.delta.trim() !== '' && Number.isNaN(Number(c.delta)))) return `${g.name}: enter price changes in dollars, e.g. 2 or -1.50.`;
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1) return `${g.name}: pick whole numbers, at least 1 for the most.`;
      if (min > max) return `${g.name}: the fewest choices can’t be more than the most.`;
      if (max > g.choices.length) return `${g.name}: customers can’t pick more choices than there are.`;
      if (g.required && min < 1) return `${g.name}: a required group needs at least 1 choice picked.`;
      if (g.choices.filter((c) => c.default).length > max) return `${g.name}: more choices are picked by default than customers may pick.`;
      return '';
    })
    .find(Boolean);
  return {
    sectionId: d.sectionId ? '' : 'Pick the section.',
    name: d.name.trim() ? '' : 'Enter the item’s name.',
    price: !price || price.amount < 0 ? 'Enter the price in dollars, e.g. 12.50.' : '',
    wasPrice: d.wasPrice.trim() && (!was || (price && was.amount <= price.amount)) ? 'The was price must be above the price.' : '',
    groups: groupProblem ?? '',
  };
}

function ItemDrawer({ restaurant, sections, draft, setDraft, notify, canManage }: Ctx & { restaurant: Restaurant; sections: MenuSection[]; draft: ItemDraft | null; setDraft: (d: ItemDraft | null) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const close = () => (setDraft(null), setTried(false), setError(''));
  const setD = (patch: Partial<ItemDraft>) => draft && setDraft({ ...draft, ...patch });
  const setGroup = (gi: number, patch: Partial<GroupDraft>) => draft && setD({ groups: draft.groups.map((g, k) => (k === gi ? { ...g, ...patch } : g)) });
  const setChoice = (gi: number, ci: number, patch: Partial<ChoiceDraft>) => draft && setGroup(gi, { choices: draft.groups[gi].choices.map((c, k) => (k === ci ? { ...c, ...patch } : c)) });
  const errs = tried && draft ? itemProblems(draft) : null;

  const save = useMutation({
    mutationFn: (d: ItemDraft) => {
      const groups: OptionGroup[] = d.groups.map((g) => ({ id: g.id, name: g.name.trim(), required: g.required, min: Number(g.min), max: Number(g.max), choices: g.choices.map((c) => ({ id: c.id, name: c.name.trim(), priceDelta: toMoney(c.delta) ?? { amount: 0, currency: 'USD' }, default: c.default, available: c.available })) }));
      const body: MenuItemInput = { sectionId: d.sectionId, name: d.name.trim(), description: d.description.trim() || null, photoIds: d.photos.map((p) => p.id), price: toMoney(d.price)!, wasPrice: toMoney(d.wasPrice), tag: d.tag.trim() || null, dietTags: d.dietTags, popular: d.popular, recommended: d.recommended, optionGroups: groups, available: d.available, position: d.position.trim() ? Number(d.position) : null };
      return d.id ? call(api.PATCH('/api/admin/food/items/{id}', { params: { path: { id: d.id } }, body })) : call(api.POST('/api/admin/food/restaurants/{id}/items', { params: { path: { id: restaurant.id } }, body }));
    },
    onSuccess: (it, d) => {
      void qc.invalidateQueries({ queryKey: ['food'] });
      notify(d.id ? `${it.name} saved${it.available ? '' : ' (unavailable)'}` : `${it.name} added to the menu`);
      close();
    },
    onError: (e) => {
      const fe = Object.values(fieldErrorsOf(e));
      setError(fe.length ? fe.join(' ') : errorMessage(e));
    },
  });
  const remove = useMutation({
    mutationFn: (d: ItemDraft) => call(api.DELETE('/api/admin/food/items/{id}', { params: { path: { id: d.id } } })),
    onSuccess: (_r, d) => {
      void qc.invalidateQueries({ queryKey: ['food'] });
      notify(`${d.name} deleted: past orders keep their copy`);
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = () => {
    if (!draft) return;
    setTried(true);
    if (Object.values(itemProblems(draft)).some(Boolean)) return;
    save.mutate(draft);
  };

  return (
    <Drawer
      open={!!draft}
      onClose={close}
      className="wide"
      title={draft?.id ? `Edit item: ${draft.name || 'Untitled'}` : 'Add item'}
      foot={
        canManage ? (
          <>
            {draft?.id && (
              <Button variant="danger-soft" size="sm" onClick={() => draft && remove.mutate(draft)} disabled={save.isPending || remove.isPending}>
                Delete
              </Button>
            )}
            <span className="grow" />
            <Button variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={save.isPending || remove.isPending}>
              {draft?.id ? 'Save item' : 'Add item'}
            </Button>
          </>
        ) : undefined
      }
    >
      {draft && (
        <fieldset className="stack gap-4" disabled={!canManage} style={{ border: 0, padding: 0, margin: 0 }}>
          {error && (
            <Alert tone="danger" title="The item wasn’t saved">
              {error}
            </Alert>
          )}
          {errs && Object.values(errs).some(Boolean) && <Alert tone="danger" title={Object.values(errs).find(Boolean)!} />}
          <div className="grid md2 gap-3">
            <Field label="Name" error={errs?.name}>
              <TextInput id="fi-name" value={draft.name} placeholder="e.g. Margherita" error={!!errs?.name} onChange={(e) => setD({ name: e.target.value })} />
            </Field>
            <Field label="Section" error={errs?.sectionId}>
              <Select id="fi-sec" value={draft.sectionId} options={[{ value: '', label: 'Pick a section…' }, ...sections.map((s) => ({ value: s.id, label: s.name }))]} onChange={(e) => setD({ sectionId: e.target.value })} />
            </Field>
          </div>
          <Field label="Description" optional hint="e.g. San Marzano tomato, fior di latte, basil">
            <Textarea id="fi-desc" rows={3} value={draft.description} onChange={(e) => setD({ description: e.target.value })} />
          </Field>
          <PhotosField photos={draft.photos} max={MAX_ITEM_PHOTOS} alt={draft.name.trim()} disabled={!canManage} hint="16 : 9, saved at 1200 × 675. The first photo shows on the menu." onChange={(photos) => setD({ photos })} />
          <div className="grid md2 gap-3">
            <Field label="Price" hint="Dollars, e.g. 12.50" error={errs?.price}>
              <TextInput id="fi-price" inputMode="decimal" prefix="$" value={draft.price} error={!!errs?.price} onChange={(e) => setD({ price: e.target.value })} />
            </Field>
            <Field label="Was price" optional hint="Above the price: the menu shows a discount badge" error={errs?.wasPrice}>
              <TextInput id="fi-was" inputMode="decimal" prefix="$" value={draft.wasPrice} error={!!errs?.wasPrice} onChange={(e) => setD({ wasPrice: e.target.value })} />
            </Field>
          </div>
          <div className="grid md2 gap-3">
            <Field label="Tag" optional hint="e.g. Most ordered, Spicy">
              <TextInput id="fi-tag" value={draft.tag} onChange={(e) => setD({ tag: e.target.value })} />
            </Field>
            <Field label="Order" optional hint="Lower numbers show first in the section">
              <TextInput id="fi-pos" type="number" min={1} value={draft.position} onChange={(e) => setD({ position: e.target.value })} />
            </Field>
          </div>
          <LinesField id="fi-diet" label="Diet tags" hint="e.g. Vegetarian, Vegan, Gluten free" lines={draft.dietTags} max={6} disabled={!canManage} onChange={(dietTags) => setD({ dietTags })} />
          <Switch id="fi-pop" label="Popular: listed first on the restaurant’s menu" checked={draft.popular} onChange={(e) => setD({ popular: e.target.checked })} />
          <Switch id="fi-rec" label="Recommended: shown in Recommended foods on the department home" checked={draft.recommended} onChange={(e) => setD({ recommended: e.target.checked })} />
          <Switch id="fi-av" label="Available to order" checked={draft.available} onChange={(e) => setD({ available: e.target.checked })} />

          <div className="stack gap-3">
            <span className="label">
              Options <span className="muted">({draft.groups.length})</span>
            </span>
            <span className="xs sub">Sizes and extras customers pick, e.g. Size (required, pick 1) or Extras (pick up to 3). A choice can make the price lower (negative).</span>
            {draft.groups.map((g, gi) => (
              <div key={g.id} className="stack gap-2" style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 10 }}>
                <div className="row gap-2 wrap items-center">
                  <input className="input grow" aria-label={`Option group ${gi + 1} name`} placeholder="Group, e.g. Size" value={g.name} onChange={(e) => setGroup(gi, { name: e.target.value })} />
                  <Switch id={`fi-g-${g.id}-req`} label="Required" checked={g.required} onChange={(e) => setGroup(gi, { required: e.target.checked, min: e.target.checked && Number(g.min) < 1 ? '1' : g.min })} />
                  {canManage && (
                    <>
                      <IconButton icon="arrow-up" label={`Move ${g.name || `group ${gi + 1}`} up`} disabled={gi === 0} onClick={() => setD({ groups: swap(draft.groups, gi, gi - 1) })} />
                      <IconButton icon="arrow-down" label={`Move ${g.name || `group ${gi + 1}`} down`} disabled={gi === draft.groups.length - 1} onClick={() => setD({ groups: swap(draft.groups, gi, gi + 1) })} />
                      <IconButton icon="x" label={`Remove ${g.name || `group ${gi + 1}`}`} onClick={() => setD({ groups: draft.groups.filter((_, k) => k !== gi) })} />
                    </>
                  )}
                </div>
                <div className="row gap-3 wrap items-center">
                  <label className="row gap-2 items-center small">
                    Pick at least
                    <input className="input" type="number" min={0} style={{ width: 80 }} value={g.min} onChange={(e) => setGroup(gi, { min: e.target.value })} />
                  </label>
                  <label className="row gap-2 items-center small">
                    at most
                    <input className="input" type="number" min={1} style={{ width: 80 }} value={g.max} onChange={(e) => setGroup(gi, { max: e.target.value })} />
                  </label>
                  <span className="xs muted">{g.max === '1' ? 'One choice' : 'Several choices'}</span>
                </div>
                {g.choices.map((c, ci) => (
                  <div key={c.id} className="row gap-2 wrap items-center">
                    <input className="input grow" aria-label={`${g.name || 'Group'} choice ${ci + 1} name`} placeholder="Choice, e.g. Large 14&quot;" value={c.name} onChange={(e) => setChoice(gi, ci, { name: e.target.value })} />
                    <input className="input" style={{ width: 110 }} inputMode="decimal" aria-label={`${c.name || `Choice ${ci + 1}`} price change in dollars`} placeholder="± $" value={c.delta} onChange={(e) => setChoice(gi, ci, { delta: e.target.value })} />
                    <Checkbox id={`fi-c-${c.id}-def`} label="Default" checked={c.default} onChange={(e) => setChoice(gi, ci, { default: e.target.checked })} />
                    <Checkbox id={`fi-c-${c.id}-av`} label="Available" checked={c.available} onChange={(e) => setChoice(gi, ci, { available: e.target.checked })} />
                    {canManage && <IconButton icon="x" label={`Remove ${c.name || `choice ${ci + 1}`}`} onClick={() => setGroup(gi, { choices: g.choices.filter((_, k) => k !== ci) })} />}
                  </div>
                ))}
                {canManage && g.choices.length < 30 && (
                  <div>
                    <Button variant="ghost" size="sm" icon="plus" onClick={() => setGroup(gi, { choices: [...g.choices, { id: newKey(), name: '', delta: '0', default: false, available: true }] })}>
                      Add a choice
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {errs?.groups && <span className="xs t-danger-text">{errs.groups}</span>}
            {canManage && draft.groups.length < 10 && (
              <div>
                <Button variant="secondary" size="sm" icon="plus" onClick={() => setD({ groups: [...draft.groups, { id: newKey(), name: '', required: false, min: '0', max: '1', choices: [{ id: newKey(), name: '', delta: '0', default: false, available: true }] }] })}>
                  Add an option group
                </Button>
              </div>
            )}
          </div>
        </fieldset>
      )}
    </Drawer>
  );
}
const swap = <T,>(l: T[], i: number, j: number) => {
  const next = [...l];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};

/* ---------------- Categories ---------------- */

type CategoryDraft = { id: string; name: string; slug: string; icon: string; image: MediaRef | null; position: string; visible: boolean };

function CategoriesTab({ notify, canManage, adding, setAdding }: Ctx & Adding) {
  const { api } = useApi();
  const qc = useQueryClient();
  const list = useCategories();
  const rows = [...(list.data ?? [])].sort((a, b) => a.position - b.position);
  const [draft, setDraft] = useState<CategoryDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const editing = draft ?? (adding ? { id: '', name: '', slug: '', icon: '', image: null, position: String(rows.length + 1), visible: true } : null);
  const close = () => (setDraft(null), setAdding(false), setTried(false), setError(''));
  const setD = (patch: Partial<CategoryDraft>) => editing && setDraft({ ...editing, ...patch });

  const save = useMutation({
    mutationFn: (d: CategoryDraft) => {
      const body = { name: d.name.trim(), slug: d.slug.trim() || null, icon: d.icon.trim() || null, imageId: d.image?.id ?? null, position: d.position ? Number(d.position) : null, visible: d.visible };
      return d.id ? call(api.PATCH('/api/admin/food/categories/{id}', { params: { path: { id: d.id } }, body })) : call(api.POST('/api/admin/food/categories', { body }));
    },
    onSuccess: (c, d) => {
      void qc.invalidateQueries({ queryKey: ['food'] });
      notify(d.id ? `${c.name} saved` : `${c.name} added`);
      close();
    },
    onError: (e) => setError(codeOf(e) === 'SLUG_TAKEN' ? 'Another category already uses this slug.' : errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (c: FoodCategory) => call(api.DELETE('/api/admin/food/categories/{id}', { params: { path: { id: c.id } } })),
    onSuccess: (_r, c) => {
      void qc.invalidateQueries({ queryKey: ['food'] });
      notify(`${c.name} deleted${c.restaurantCount ? `: ${plural(c.restaurantCount, 'restaurant')} lost the category` : ''}`);
    },
    onError: (e, c) => notify(`${c.name} wasn’t deleted: ${errorMessage(e)}`, 'danger'),
  });

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">Categories</h2>
            <span className="xs muted">The food category chips of the department home, in this order</span>
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
                    Restaurants
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
                      <span className="row nowrap gap-3">
                        <Img icon="utensils" src={c.image?.url} alt="" className="tiny" />
                        <span className="stack gap-0">
                          <span className="small strong">{c.name}</span>
                          <span className="xs muted">
                            {c.slug}
                            {c.icon ? ` · icon ${c.icon}` : ''}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="r small">{num(c.restaurantCount)}</td>
                    <td>{c.visible ? <Badge tone="success">Visible</Badge> : <Badge icon="eye-off">Hidden</Badge>}</td>
                    <td>
                      {canManage && (
                        <span className="row gap-1 nowrap">
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft({ id: c.id, name: c.name, slug: c.slug, icon: c.icon ?? '', image: c.image ?? null, position: String(c.position), visible: c.visible })}>
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
                        Categories such as Pizza, Burgers or Sushi group the restaurants.
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
              <TextInput id="fc-name" value={editing.name} error={tried && !editing.name.trim()} onChange={(e) => setD({ name: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Slug" optional>
                <TextInput id="fc-slug" value={editing.slug} placeholder={slugify(editing.name)} onChange={(e) => setD({ slug: e.target.value })} />
              </Field>
              <Field label="Order">
                <TextInput id="fc-pos" type="number" min={1} value={editing.position} onChange={(e) => setD({ position: e.target.value })} />
              </Field>
            </div>
            <Field label="Icon" optional hint="A Lucide icon name, e.g. pizza or salad">
              <TextInput id="fc-icon" value={editing.icon} onChange={(e) => setD({ icon: e.target.value })} />
            </Field>
            <PictureField label="Picture" shape="square" icon="utensils" value={editing.image} alt={editing.name.trim()} hint="Optional. Square, saved at 600 × 600; shown instead of the icon." disabled={!canManage} onChange={(image) => setD({ image })} />
            <Switch id="fc-visible" label="Show this category in the app" checked={editing.visible} onChange={(e) => setD({ visible: e.target.checked })} />
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
  const restaurants = useAllRestaurants();
  const [hidden, setHidden] = useState<'' | 'true' | 'false'>('');
  const [restaurantId, setRestaurantId] = useState('');
  const [page, setPage] = useState(1);
  const [hiding, setHiding] = useState<FoodReview | null>(null);
  const [error, setError] = useState('');
  const query = { hidden: hidden ? hidden === 'true' : undefined, restaurantId: restaurantId || undefined };
  const list = useQuery({
    queryKey: ['food', 'reviews', query, page],
    queryFn: () => call(api.GET('/api/admin/food/reviews', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  const moderate = useMutation({
    mutationFn: ({ r, hide, reason }: { r: FoodReview; hide: boolean; reason?: string | null }) => call(api.POST('/api/admin/food/reviews/{id}/moderate', { params: { path: { id: r.id } }, body: { hidden: hide, reason: reason ?? null } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['food'] });
      setHiding(null);
      setError('');
      notify(r.hidden ? `${r.name}’s review of ${r.restaurant.name} is hidden from customers` : `${r.name}’s review of ${r.restaurant.name} shows again`);
    },
    onError: (e, v) => (v.hide ? setError(errorMessage(e)) : notify(`The review wasn’t changed: ${errorMessage(e)}`, 'danger')),
  });

  return (
    <section className="card">
      <div className="card-body">
        <div className="toolbar">
          <select className="select" id="fv-st" aria-label="Status" value={hidden} onChange={(e) => (setHidden(e.target.value as '' | 'true' | 'false'), setPage(1))}>
            <option value="">All reviews</option>
            <option value="false">Visible</option>
            <option value="true">Hidden</option>
          </select>
          <select className="select" id="fv-rest" aria-label="Restaurant" value={restaurantId} onChange={(e) => (setRestaurantId(e.target.value), setPage(1))}>
            <option value="">All restaurants</option>
            {(restaurants.data?.items ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
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
              <th scope="col">Restaurant</th>
              <th scope="col">Order</th>
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
                <td colSpan={8}>
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
                  <span className="truncate" style={{ display: 'block', maxWidth: 300 }}>
                    {r.text ?? <span className="muted">No text</span>}
                  </span>
                </td>
                <td className="small">{r.restaurant.name}</td>
                <td className="mono xs">{r.orderRef}</td>
                <td className="small">{r.name}</td>
                <td className="small nowrap">{dateTime(r.date)}</td>
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
                <td colSpan={8}>
                  <EmptyState icon="star" title="No reviews here">
                    Customers rate a delivered order once; the rating counts for the restaurant and every item in it.
                  </EmptyState>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableWrap>
      <div className="card-foot between">
        <span className="xs muted">{plural(rows.length, 'review')} on this page · hiding one takes it out of the ratings.</span>
        <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
      </div>
      <HideReviewDialog open={!!hiding} who={hiding?.name ?? ''} busy={moderate.isPending} error={error} onClose={() => setHiding(null)} onHide={(reason) => hiding && moderate.mutate({ r: hiding, hide: true, reason })} />
    </section>
  );
}
