import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError, call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { formatMoney, num } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { Alert, announce, Badge, Button, Drawer, EmptyState, Field, Img, KeyValue, PageHeader, Pager, SearchInput, StatusBadge, Switch, TableWrap, Tabs, Textarea, TextInput, Timeline } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { dateTime, dayKey, LoadError, SkeletonLines, time, weekdayDate } from '@/app/parts';
import { codeOf, DeptPage, PAGE_SIZE, plural, totalPagesOf } from './data/departments';

// Admin › Departments › Farm orders (designed in React from the Marketly Departments canvas, FarmIntro and FarmOrder;
// no admin artboard, so the DeptFood orders pattern). Tabs: Orders | Dealers. Customers order a farm machine with its
// attachments from the app (farm module, not cart and checkout): pay in full by card (authorized when placed, captured
// when the dealer confirms), installments the dealer arranges (no card), or pay on delivery (a card deposit captured on
// confirm, the balance paid to the dealer when it arrives). Staff confirm, schedule, send out, deliver, reject or cancel
// each order on the dealer's behalf. API: /api/admin/farm/{orders,dealers}.

type S = components['schemas'];
type FarmOrder = S['farm.FarmOrderAdmin'];
type FarmStatus = FarmOrder['status'];
type FarmAction = FarmOrder['actions'][number];
type PaymentOption = FarmOrder['paymentOption'];
type Dealer = S['farm.DealerAdmin'];
type DealerInput = S['farm.DealerInput'];
type Tab = '' | 'dealers';
type Notify = (title: string, tone?: 'success' | 'danger') => void;
type BadgeTone = 'brand' | 'info' | 'warning' | 'success' | 'danger' | 'outline' | '';
const REFRESH_MS = 30_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const FARM_STATUS: Record<FarmStatus, { label: string; tone: BadgeTone }> = {
  payment_pending: { label: 'Waiting for payment', tone: 'info' },
  payment_failed: { label: 'Payment failed', tone: 'danger' },
  placed: { label: 'New', tone: 'brand' },
  confirmed: { label: 'Confirmed', tone: 'info' },
  out_for_delivery: { label: 'Out for delivery', tone: 'warning' },
  delivered: { label: 'Delivered', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: '' },
};
const PAYMENT_OPTION: Record<PaymentOption, string> = { pay_in_full: 'Pay in full', installments: 'Installments', pay_on_delivery: 'Pay on delivery' };
/** Who changed an order, from the history's actor key (customer, staff:<id>, system) */
const byLabel = (by: string) => (by.startsWith('staff:') ? 'staff' : by.startsWith('system') ? 'automatic' : by);
const today = () => dayKey(new Date());
const osmLink = (p: { lat: number; lng: number }) => `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=15/${p.lat}/${p.lng}`;
const pointLabel = (p: { lat: number; lng: number }) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;

export default function DeptFarmOrders() {
  const { api } = useApi();
  const { can } = useStaffSession();
  const canView = can('farm.view');
  const canManage = can('farm.manage');
  const canHandle = can('farm.orders.manage');
  const [view, setView] = useView<Exclude<Tab, ''>>();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; title: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const notify: Notify = (title, tone = 'success') => {
    setNotice({ tone, title });
    announce(title);
  };
  const waiting = useQuery({ queryKey: ['farm', 'orders', 'waiting'], enabled: canView, refetchInterval: REFRESH_MS, queryFn: () => call(api.GET('/api/admin/farm/orders', { params: { query: { status: 'placed', limit: 1 } } })) });

  return (
    <DeptPage active="dept-farm-orders" title="Farm orders" canView={canView} need="See dealers and farm orders in Farm orders">
      <PageHeader
        crumbs={[{ label: 'Departments' }, { label: 'Farm orders' }]}
        title="Farm orders"
        sub={`Farm machine orders from the app and the dealers that deliver them · staff confirm and schedule each order for the dealer; a card is charged when the order is confirmed${canManage ? '' : ' · view only: changing dealers needs the Farm dealers permission'}`}
        actions={
          canManage &&
          view === 'dealers' && (
            <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
              Add dealer
            </Button>
          )
        }
      />
      <Tabs
        items={[
          { value: '', label: 'Orders', count: waiting.data?.total || undefined },
          { value: 'dealers', label: 'Dealers' },
        ]}
        active={view}
        onChange={(v) => {
          setNotice(null);
          setAdding(false);
          setView(v as Tab);
        }}
        label="Farm orders sections"
      />
      {notice && <Alert tone={notice.tone} title={notice.title} />}
      {view === 'dealers' ? <DealersTab notify={notify} canManage={canManage} adding={adding} setAdding={setAdding} /> : <OrdersTab notify={notify} canHandle={canHandle} />}
    </DeptPage>
  );
}

function useDealers() {
  const { api } = useApi();
  return useQuery({ queryKey: ['farm', 'dealers'], queryFn: () => call(api.GET('/api/admin/farm/dealers')) });
}

/* ---------------- Orders ---------------- */

const ACTION: Record<FarmAction, { label: string; variant: 'primary' | 'secondary' | 'danger-soft'; needsNote?: boolean }> = {
  confirm: { label: 'Confirm', variant: 'primary' },
  reschedule: { label: 'Change delivery date', variant: 'secondary' },
  dispatch: { label: 'Mark out for delivery', variant: 'primary' },
  deliver: { label: 'Mark delivered', variant: 'primary' },
  reject: { label: 'Reject', variant: 'danger-soft', needsNote: true },
  cancel: { label: 'Cancel order', variant: 'secondary', needsNote: true },
};
const ACTION_ORDER: FarmAction[] = ['confirm', 'reschedule', 'dispatch', 'deliver', 'reject', 'cancel'];
const charged = (o: FarmOrder) => (o.paymentOption === 'installments' || !o.cardAmount.amount ? '' : `: the card was charged ${formatMoney(o.cardAmount)}${o.paymentOption === 'pay_on_delivery' ? ' (deposit)' : ''}`);
const released = (o: FarmOrder) => (o.paymentOption === 'installments' || !o.cardAmount.amount ? '' : ': the card hold was released');
const doneText = (o: FarmOrder, a: FarmAction) =>
  a === 'confirm' ? `confirmed for ${weekdayDate(o.deliveryDate)}${charged(o)}` : a === 'reschedule' ? `moved to ${weekdayDate(o.deliveryDate)}` : a === 'dispatch' ? 'is out for delivery' : a === 'deliver' ? 'delivered' : a === 'reject' ? `rejected${released(o)}` : `cancelled${released(o)}`;
const locationLines = (l: FarmOrder['location']) => [l.name, l.line1, l.line2, [l.city, [l.region, l.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean) as string[];

/** An action's refusal in plain words (REFUND_NOT_AVAILABLE, PAYMENT_CAPTURE_FAILED, DELIVERY_DATE_UNAVAILABLE…) */
function actionError(e: unknown, action: FarmAction): string {
  const details = e instanceof ApiError ? e.details : {};
  switch (codeOf(e)) {
    case 'REFUND_NOT_AVAILABLE':
      return 'The card was already charged for this order, and refunds of farm orders aren’t in the app yet, so it can’t be cancelled here. Deliver it, or settle the refund with the customer and Finance outside the app.';
    case 'PAYMENT_CAPTURE_FAILED':
      return 'The card couldn’t be charged, so the order is still waiting for confirmation. Try “Confirm” again in a moment, or reject the order.';
    case 'DELIVERY_DATE_UNAVAILABLE':
      return details.earliest && details.latest ? `Pick a delivery date from ${weekdayDate(String(details.earliest))} to ${weekdayDate(String(details.latest))}.` : 'Pick a delivery date from today on.';
    case 'ILLEGAL_TRANSITION':
      return 'The order changed in the meantime. Check its status and try again.';
    case 'NOT_FOUND':
      return 'This order no longer exists.';
    default:
      return `The order wasn’t ${action === 'reschedule' ? 'rescheduled' : 'changed'}: ${errorMessage(e)}`;
  }
}

function OrdersTab({ notify, canHandle }: { notify: Notify; canHandle: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const dealers = useDealers();
  const [state, setState] = useState<'open' | 'past' | ''>('open');
  const [status, setStatus] = useState<FarmStatus | ''>('');
  const [dealerId, setDealerId] = useState('');
  const [paymentOption, setPaymentOption] = useState<PaymentOption | ''>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<FarmOrder | null>(null);
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [staffNote, setStaffNote] = useState('');
  const [error, setError] = useState('');
  const query = { state: state || undefined, status: status || undefined, dealerId: dealerId || undefined, paymentOption: paymentOption || undefined, q: q.trim() || undefined };
  const list = useQuery({
    queryKey: ['farm', 'orders', query, page],
    queryFn: () => call(api.GET('/api/admin/farm/orders', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
    // every 30 s while the browser tab is visible (react-query pauses intervals in hidden tabs)
    refetchInterval: REFRESH_MS,
  });
  const rows = list.data?.items ?? [];
  // the drawer follows the refreshed list (the newer of the two copies)
  const shown = open ? (rows.find((r) => r.id === open.id && r.history.length >= open.history.length) ?? open) : null;
  const show = (o: FarmOrder) => (setOpen(o), setDate(o.deliveryDate), setNote(''), setStaffNote(o.staffNote ?? ''), setError(''));
  const filtered = !!(q || status || dealerId || paymentOption);

  const act = useMutation({
    mutationFn: ({ o, action }: { o: FarmOrder; action: FarmAction }) =>
      call(
        api.POST('/api/admin/farm/orders/{id}/status', {
          params: { path: { id: o.id } },
          body: { action, deliveryDate: action === 'confirm' || action === 'reschedule' ? date || null : null, note: note.trim() || null, staffNote: staffNote.trim() || null },
        }),
      ),
    onSuccess: (o, v) => {
      void qc.invalidateQueries({ queryKey: ['farm', 'orders'] });
      notify(`${o.ref} ${doneText(o, v.action)}`);
      setOpen(o);
      setDate(o.deliveryDate);
      setNote('');
      setError('');
    },
    onError: (e, v) => {
      void qc.invalidateQueries({ queryKey: ['farm', 'orders'] });
      setError(actionError(e, v.action));
    },
  });
  const run = (o: FarmOrder, action: FarmAction) => {
    if (ACTION[action].needsNote && !note.trim()) {
      setError(`Say why in the note to the customer before you ${action === 'reject' ? 'reject' : 'cancel'} the order.`);
      document.getElementById('fm-note')?.focus();
      return;
    }
    if ((action === 'confirm' || action === 'reschedule') && !(DATE.test(date) && date >= today())) {
      setError(action === 'reschedule' ? 'Pick the new delivery date: today or later.' : 'Pick the delivery date: today or later.');
      document.getElementById('fm-date')?.focus();
      return;
    }
    if (action === 'reschedule' && date === o.deliveryDate) {
      setError('Pick a different date to change the delivery date.');
      document.getElementById('fm-date')?.focus();
      return;
    }
    act.mutate({ o, action });
  };
  const needsDate = shown ? shown.actions.includes('confirm') || shown.actions.includes('reschedule') : false;

  return (
    <>
      <section className="card">
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="fm-q" placeholder="FM- reference, customer, contact or phone" value={q} onChange={(v) => (setQ(v), setPage(1))} label="Search farm orders" />
            <select className="select" id="fm-state" aria-label="Open or past" value={state} onChange={(e) => (setState(e.target.value as 'open' | 'past' | ''), setPage(1))}>
              <option value="open">Open orders</option>
              <option value="past">Past orders</option>
              <option value="">All orders</option>
            </select>
            <select className="select" id="fm-st" aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value as FarmStatus | ''), setPage(1))}>
              <option value="">All statuses</option>
              {(Object.keys(FARM_STATUS) as FarmStatus[]).map((s) => (
                <option key={s} value={s}>
                  {FARM_STATUS[s].label}
                </option>
              ))}
            </select>
            <select className="select" id="fm-dealer" aria-label="Dealer" value={dealerId} onChange={(e) => (setDealerId(e.target.value), setPage(1))}>
              <option value="">All dealers</option>
              {(dealers.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.active ? d.name : `${d.name} (off)`}
                </option>
              ))}
            </select>
            <select className="select" id="fm-pay" aria-label="Payment option" value={paymentOption} onChange={(e) => (setPaymentOption(e.target.value as PaymentOption | ''), setPage(1))}>
              <option value="">All payment options</option>
              {(Object.keys(PAYMENT_OPTION) as PaymentOption[]).map((p) => (
                <option key={p} value={p}>
                  {PAYMENT_OPTION[p]}
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
        <TableWrap label="Farm orders table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Ref</th>
                <th scope="col">Customer</th>
                <th scope="col">Machine</th>
                <th scope="col">Dealer</th>
                <th scope="col">Delivery</th>
                <th scope="col">Payment</th>
                <th className="r" scope="col">
                  Total
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
              {rows.map((o) => (
                <tr key={o.id}>
                  <td className="mono small strong nowrap">{o.ref}</td>
                  <td>
                    <span className="stack gap-0">
                      <span className="small strong">{o.customer.name ?? o.contactName}</span>
                      <span className="xs muted">{o.contactPhone}</span>
                    </span>
                  </td>
                  <td>
                    <span className="row nowrap gap-3">
                      <Img icon="tractor" src={o.machine.image?.url} alt="" className="tiny" />
                      <span className="stack gap-0">
                        <span className="small strong">{o.machine.title}</span>
                        <span className="xs muted">{o.attachments.length ? `+ ${plural(o.attachments.length, 'attachment')}` : 'No attachments'}</span>
                      </span>
                    </span>
                  </td>
                  <td className="small">{o.dealer.name}</td>
                  <td className="small nowrap">
                    <span className="stack gap-0">
                      <span>{weekdayDate(o.deliveryDate)}</span>
                      <span className="xs muted">{o.deliveryDateConfirmed ? 'Confirmed' : 'Requested'}</span>
                    </span>
                  </td>
                  <td className="small nowrap">{PAYMENT_OPTION[o.paymentOption]}</td>
                  <td className="r small nowrap">{formatMoney(o.total)}</td>
                  <td>
                    <StatusBadge status={FARM_STATUS[o.status].label} tone={FARM_STATUS[o.status].tone} />
                  </td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => show(o)}>
                      Open<span className="sr-only"> {o.ref}</span>
                    </button>
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <EmptyState icon="tractor" title={state === 'open' && !filtered ? 'No open orders' : 'No orders here'}>
                      {state === 'open' && !filtered ? 'New farm orders show up here as customers place them. The list refreshes every 30 seconds.' : 'Try another filter or search.'}
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <div className="card-foot between">
          <span className="xs muted">Refreshes every 30 seconds{list.dataUpdatedAt ? ` · updated ${time(new Date(list.dataUpdatedAt).toISOString())}` : ''} · new orders not confirmed in time are cancelled automatically.</span>
          <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
        </div>
      </section>

      <Drawer open={!!shown} onClose={() => setOpen(null)} className="wide" title={shown ? `${shown.ref} · ${shown.machine.title}` : 'Order'}>
        {shown && (
          <>
            {error && <Alert tone="danger" title={error} />}
            <div className="row gap-2 wrap">
              <StatusBadge status={FARM_STATUS[shown.status].label} tone={FARM_STATUS[shown.status].tone} />
              <span className="small muted">
                {shown.statusLabel}
                {shown.placedAt ? ` · placed ${dateTime(shown.placedAt)}` : ` · created ${dateTime(shown.createdAt)}`}
              </span>
            </div>
            <div className="stack gap-2">
              <span className="label">Machine and attachments</span>
              <ul className="list">
                <li>
                  <Img icon="tractor" src={shown.machine.image?.url} alt="" className="tiny" />
                  <span className="grow stack gap-0">
                    <span className="small strong">{shown.machine.title}</span>
                    {shown.machine.highlights.length > 0 && <span className="xs muted">{shown.machine.highlights.join(' · ')}</span>}
                  </span>
                  <span className="small nowrap">{formatMoney(shown.machinePrice)}</span>
                </li>
                {shown.attachments.map((a) => (
                  <li key={a.productId}>
                    <Img icon="package" src={a.image?.url} alt="" className="tiny" />
                    <span className="grow small">{a.title}</span>
                    <span className="small nowrap">{a.priceLabel || formatMoney(a.price)}</span>
                  </li>
                ))}
              </ul>
              <KeyValue
                pairs={[
                  ['Machine', formatMoney(shown.machinePrice)],
                  ['Attachments', shown.attachments.length ? formatMoney(shown.attachmentsTotal) : 'None'],
                  ['Delivery', 'Included'],
                  [<span className="strong">Total</span>, <span className="strong">{formatMoney(shown.total)}</span>],
                ]}
              />
            </div>
            <div className="stack gap-2">
              <span className="label">Payment</span>
              <KeyValue
                pairs={[
                  ['Option', shown.paymentLabel || PAYMENT_OPTION[shown.paymentOption]],
                  ['By card', shown.cardAmount.amount ? `${formatMoney(shown.cardAmount)}${shown.paymentOption === 'pay_on_delivery' ? ' deposit' : ''} · charged when confirmed` : 'Nothing: the dealer arranges the plan with the customer'],
                  ...(shown.deposit ? [['Deposit', formatMoney(shown.deposit)] as [string, ReactNode]] : []),
                  ...(shown.balance ? [['Balance', `${formatMoney(shown.balance)} · the dealer collects it on delivery`] as [string, ReactNode]] : []),
                  ['Card', [shown.methodLabel, shown.paymentState].filter(Boolean).join(' · ') || '—'],
                ]}
              />
            </div>
            <div className="stack gap-2">
              <span className="label">Delivery</span>
              <KeyValue
                pairs={[
                  ['Delivery date', `${weekdayDate(shown.deliveryDate)}${shown.deliveryDateConfirmed ? ' · confirmed' : ' · requested, not confirmed yet'}`],
                  ...(shown.requestedDeliveryDate !== shown.deliveryDate ? [['Customer asked for', weekdayDate(shown.requestedDeliveryDate)] as [string, ReactNode]] : []),
                  ['Dealer', [shown.dealer.name, shown.dealer.phone].filter(Boolean).join(' · ')],
                  ['Farm location', <span style={{ whiteSpace: 'pre-line' }}>{locationLines(shown.location).join('\n')}</span>],
                  [
                    'Map point',
                    shown.location.point ? (
                      <span>
                        <a href={osmLink(shown.location.point)} target="_blank" rel="noreferrer">
                          {pointLabel(shown.location.point)}
                        </a>
                        <span className="muted">{shown.location.pinned ? ' · the customer’s pin' : ' · from the address'}</span>
                      </span>
                    ) : (
                      <span className="muted">Unknown: the address couldn’t be placed on the map</span>
                    ),
                  ],
                ]}
              />
            </div>
            <div className="stack gap-2">
              <span className="label">Contact</span>
              <KeyValue
                pairs={[
                  ['Contact', shown.contactName],
                  ['Phone', <a href={`tel:${shown.contactPhone}`}>{shown.contactPhone}</a>],
                  ['Customer', shown.customer.name ?? '—'],
                  ['Email', shown.customer.email ? <a href={`mailto:${shown.customer.email}`}>{shown.customer.email}</a> : '—'],
                  ['Notes for the dealer', shown.notes ? <span style={{ whiteSpace: 'pre-line' }}>{shown.notes}</span> : '—'],
                  ...(shown.dealerNote ? [['Note to the customer', shown.dealerNote] as [string, ReactNode]] : []),
                ]}
              />
            </div>
            <div className="stack gap-2">
              <span className="label">History</span>
              <Timeline events={[...shown.history].reverse().map((h, i) => ({ t: FARM_STATUS[h.status as FarmStatus]?.label ?? h.status, d: `${dateTime(h.at)}${h.by ? ` · ${byLabel(h.by)}` : ''}${h.note ? ` · “${h.note}”` : ''}`, state: i === 0 ? 'current' : 'done' }))} />
            </div>
            {canHandle && shown.actions.length > 0 && (
              <>
                {needsDate && (
                  <Field label={shown.actions.includes('confirm') ? 'Delivery date' : 'New delivery date'} hint={shown.actions.includes('confirm') ? `The customer asked for ${weekdayDate(shown.requestedDeliveryDate)}; confirming sets this date` : 'Changes the delivery date; the customer is told'}>
                    <TextInput id="fm-date" type="date" min={today()} value={date} onChange={(e) => setDate(e.target.value)} />
                  </Field>
                )}
                <Field label="Note to the customer" optional hint="Needed to reject or cancel, e.g. This model is no longer available">
                  <Textarea id="fm-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
                <Field label="Staff note" optional hint="Only staff see it">
                  <Textarea id="fm-snote" rows={2} value={staffNote} onChange={(e) => setStaffNote(e.target.value)} />
                </Field>
                <div className="row gap-2 wrap">
                  {ACTION_ORDER.filter((a) => shown.actions.includes(a)).map((a) => (
                    <Button key={a} variant={ACTION[a].variant} size="sm" onClick={() => run(shown, a)} disabled={act.isPending}>
                      {act.isPending && act.variables?.action === a ? 'Working…' : a === 'confirm' && DATE.test(date) ? `Confirm for ${weekdayDate(date)}` : ACTION[a].label}
                    </Button>
                  ))}
                </div>
                {shown.actions.includes('confirm') && shown.cardAmount.amount > 0 && <span className="xs sub">Confirming charges the card {formatMoney(shown.cardAmount)}{shown.paymentOption === 'pay_on_delivery' ? ' (the deposit)' : ''}. Rejecting or cancelling before then releases the hold.</span>}
              </>
            )}
            {!canHandle && shown.staffNote && <KeyValue pairs={[['Staff note', shown.staffNote]]} />}
          </>
        )}
      </Drawer>
    </>
  );
}

/* ---------------- Dealers ---------------- */

type DealerDraft = {
  id: string; name: string; line1: string; line2: string; city: string; region: string; postalCode: string; country: string; lat: string; lng: string;
  hours: string; phone: string; messagePhone: string; messageEmail: string; leadDays: string; position: string; active: boolean; point: Dealer['point']; pinned: boolean; orderCount: number;
};
const dealerDraftOf = (d?: Dealer, position = 1): DealerDraft => ({
  id: d?.id ?? '',
  name: d?.name ?? '',
  line1: d?.address.line1 ?? '',
  line2: d?.address.line2 ?? '',
  city: d?.address.city ?? '',
  region: d?.address.region ?? '',
  postalCode: d?.address.postalCode ?? '',
  country: d?.address.country ?? '',
  lat: d?.pinned && d.point ? String(d.point.lat) : '',
  lng: d?.pinned && d.point ? String(d.point.lng) : '',
  hours: d?.hours ?? '',
  phone: d?.phone ?? '',
  messagePhone: d?.messagePhone ?? '',
  messageEmail: d?.messageEmail ?? '',
  leadDays: d?.leadDays != null ? String(d.leadDays) : '',
  position: String(d?.position ?? position),
  active: d?.active ?? true,
  point: d?.point ?? null,
  pinned: d?.pinned ?? false,
  orderCount: d?.orderCount ?? 0,
});
function dealerProblems(d: DealerDraft) {
  const lat = d.lat.trim() ? Number(d.lat) : null;
  const lng = d.lng.trim() ? Number(d.lng) : null;
  const lead = d.leadDays.trim() ? Number(d.leadDays) : null;
  return {
    name: d.name.trim() ? '' : 'Enter the dealer’s name.',
    line1: d.line1.trim() ? '' : 'Enter the street address.',
    city: d.city.trim() ? '' : 'Enter the city.',
    region: d.region.trim() ? '' : 'Enter the state, e.g. OR.',
    location: (lat === null) !== (lng === null) ? 'Enter both the latitude and the longitude, or neither.' : lat !== null && (Number.isNaN(lat) || lat < -90 || lat > 90 || Number.isNaN(lng!) || lng! < -180 || lng! > 180) ? 'Latitude goes from −90 to 90 and longitude from −180 to 180.' : '',
    hours: d.hours.trim() ? '' : 'Enter the opening hours, e.g. Mon–Sat 7:00–18:00.',
    phone: d.phone.trim() ? '' : 'Enter the phone number for the Call button.',
    messageEmail: d.messageEmail.trim() && !EMAIL.test(d.messageEmail.trim()) ? 'Enter a valid email address.' : '',
    leadDays: lead !== null && !(Number.isInteger(lead) && lead >= 0 && lead <= 60) ? 'Use whole days from 0 to 60.' : '',
    position: d.position.trim() && !(Number.isInteger(Number(d.position)) && Number(d.position) >= 1) ? 'Use a whole number from 1.' : '',
  };
}
const pointText = (d: DealerDraft) =>
  !d.id
    ? 'Without a pin the address is placed on the map when you save. The app sends each order to the nearest active dealer.'
    : d.point
      ? d.pinned
        ? `On the map at the pin (${pointLabel(d.point)}). Clear both fields to place it by its address instead.`
        : `On the map from its address (${pointLabel(d.point)}). Set a pin to place it exactly.`
      : 'Not on the map: the address couldn’t be placed. Without a point this dealer is never the nearest, only the default when it comes first.';

function DealersTab({ notify, canManage, adding, setAdding }: { notify: Notify; canManage: boolean; adding: boolean; setAdding: (v: boolean) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const list = useDealers();
  const rows = [...(list.data ?? [])].sort((a, b) => a.position - b.position);
  const [draft, setDraft] = useState<DealerDraft | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const editing = draft ?? (adding ? dealerDraftOf(undefined, rows.length + 1) : null);
  const setD = (patch: Partial<DealerDraft>) => editing && setDraft({ ...editing, ...patch });
  const close = () => (setDraft(null), setAdding(false), setTried(false), setError(''));
  const errs = tried && editing ? dealerProblems(editing) : null;

  const save = useMutation({
    mutationFn: (d: DealerDraft) => {
      const body: DealerInput = {
        name: d.name.trim(),
        address: { line1: d.line1.trim(), line2: d.line2.trim() || null, city: d.city.trim(), region: d.region.trim().toUpperCase(), postalCode: d.postalCode.trim() || null, country: d.country.trim().toUpperCase() || null },
        point: d.lat.trim() && d.lng.trim() ? { lat: Number(d.lat), lng: Number(d.lng) } : null,
        hours: d.hours.trim(),
        phone: d.phone.trim(),
        messagePhone: d.messagePhone.trim() || null,
        messageEmail: d.messageEmail.trim() || null,
        leadDays: d.leadDays.trim() ? Number(d.leadDays) : null,
        active: d.active,
        position: d.position.trim() ? Number(d.position) : null,
      };
      return d.id ? call(api.PATCH('/api/admin/farm/dealers/{id}', { params: { path: { id: d.id } }, body })) : call(api.POST('/api/admin/farm/dealers', { body }));
    },
    onSuccess: (r, d) => {
      void qc.invalidateQueries({ queryKey: ['farm', 'dealers'] });
      notify(`${r.name} ${d.id ? 'saved' : 'added'}${r.point ? '' : ': its address couldn’t be placed on the map, so set a pin'}${r.active ? '' : ' (switched off)'}`, r.point ? 'success' : 'danger');
      close();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (d: DealerDraft) => call(api.DELETE('/api/admin/farm/dealers/{id}', { params: { path: { id: d.id } } })),
    onSuccess: (_r, d) => {
      void qc.invalidateQueries({ queryKey: ['farm', 'dealers'] });
      notify(`${d.name} deleted`);
      close();
    },
    onError: (e) => setError(codeOf(e) === 'IN_USE' ? 'Orders still use this dealer, so it can’t be deleted. Turn off “Takes orders” to switch it off instead.' : errorMessage(e)),
  });
  const submit = () => {
    if (!editing) return;
    setTried(true);
    if (Object.values(dealerProblems(editing)).some(Boolean)) return;
    save.mutate(editing);
  };

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div className="stack gap-0">
            <h2 className="h4">Dealers</h2>
            <span className="xs muted">Orders go to the nearest active dealer; the first active one is the default for customers without an address</span>
          </div>
        </div>
        {list.isError ? (
          <div className="card-body">
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : (
          <TableWrap label="Dealers table">
            <table className="table">
              <thead>
                <tr>
                  <th className="r" scope="col">
                    Order
                  </th>
                  <th scope="col">Dealer</th>
                  <th scope="col">Hours</th>
                  <th scope="col">Contact</th>
                  <th scope="col">Map</th>
                  <th className="r" scope="col">
                    Lead time
                  </th>
                  <th className="r" scope="col">
                    Orders
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
                      <SkeletonLines rows={3} />
                    </td>
                  </tr>
                )}
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td className="r small">{d.position}</td>
                    <td>
                      <span className="stack gap-0">
                        <span className="small strong">{d.name}</span>
                        <span className="xs muted">{[d.address.line1, d.address.city, d.address.region].filter(Boolean).join(', ')}</span>
                      </span>
                    </td>
                    <td className="small">{d.hours}</td>
                    <td>
                      <span className="stack gap-0">
                        <span className="small">{d.phone}</span>
                        <span className="xs muted">{d.messagePhone ? `Texts ${d.messagePhone}` : d.messageEmail ? `Email ${d.messageEmail}` : 'No Message button'}</span>
                      </span>
                    </td>
                    <td className="small nowrap">{d.point ? d.pinned ? <Badge icon="map-pin">Pin</Badge> : 'From address' : <Badge tone="warning">Not on the map</Badge>}</td>
                    <td className="r small nowrap">{d.leadDays != null ? plural(d.leadDays, 'day') : 'Default'}</td>
                    <td className="r small">
                      {d.openOrders ? <Badge tone="brand">{d.openOrders} open</Badge> : null} {num(d.orderCount)}
                    </td>
                    <td>{d.active ? <Badge tone="success">Takes orders</Badge> : <Badge>Off</Badge>}</td>
                    <td>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft(dealerDraftOf(d))}>
                        {canManage ? 'Edit' : 'View'}
                        <span className="sr-only"> {d.name}</span>
                      </button>
                    </td>
                  </tr>
                ))}
                {list.isSuccess && rows.length === 0 && (
                  <tr>
                    <td colSpan={9}>
                      <EmptyState icon="store" title="No dealers yet">
                        {canManage ? 'Add a dealer with “Add dealer”: customers can’t order farm machines until one takes orders.' : 'Customers can’t order farm machines until a dealer takes orders.'}
                      </EmptyState>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        )}
        <div className="card-foot">
          <span className="xs muted">Lead time: days from today to the earliest delivery date customers can pick (Default uses the farm setting).</span>
        </div>
      </section>

      <Drawer
        open={!!editing}
        onClose={close}
        className="wide"
        title={editing?.id ? `${canManage ? 'Edit' : 'View'} dealer: ${editing.name || 'Untitled'}` : 'Add dealer'}
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
                {editing?.id ? 'Save dealer' : 'Add dealer'}
              </Button>
            </>
          ) : undefined
        }
      >
        {editing && (
          <fieldset className="stack gap-4" disabled={!canManage} style={{ border: 0, padding: 0, margin: 0 }}>
            {error && (
              <Alert tone="danger" title={editing.id ? 'The dealer wasn’t saved' : 'The dealer wasn’t added'}>
                {error}
              </Alert>
            )}
            {errs && Object.values(errs).some(Boolean) && <Alert tone="danger" title={Object.values(errs).find(Boolean)!} />}
            <Field label="Name" error={errs?.name}>
              <TextInput id="fd-name" value={editing.name} placeholder="e.g. Greenfield Agri Equipment" error={!!errs?.name} onChange={(e) => setD({ name: e.target.value })} />
            </Field>
            <Field label="Street address" error={errs?.line1}>
              <TextInput id="fd-line1" value={editing.line1} placeholder="e.g. 18200 SE Route 9" error={!!errs?.line1} onChange={(e) => setD({ line1: e.target.value })} />
            </Field>
            <Field label="Address line 2" optional>
              <TextInput id="fd-line2" value={editing.line2} onChange={(e) => setD({ line2: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="City" error={errs?.city}>
                <TextInput id="fd-city" value={editing.city} error={!!errs?.city} onChange={(e) => setD({ city: e.target.value })} />
              </Field>
              <Field label="State" hint="Two-letter code, e.g. OR" error={errs?.region}>
                <TextInput id="fd-region" value={editing.region} maxLength={3} error={!!errs?.region} onChange={(e) => setD({ region: e.target.value })} />
              </Field>
            </div>
            <div className="grid md2 gap-3">
              <Field label="ZIP code" optional>
                <TextInput id="fd-zip" value={editing.postalCode} onChange={(e) => setD({ postalCode: e.target.value })} />
              </Field>
              <Field label="Country" optional hint="Two-letter code; the market’s (US) when empty">
                <TextInput id="fd-country" value={editing.country} maxLength={2} onChange={(e) => setD({ country: e.target.value })} />
              </Field>
            </div>
            <div className="grid md2 gap-3">
              <Field label="Pin latitude" optional hint="For distances and the nearest dealer, e.g. 45.5231" error={errs?.location}>
                <TextInput id="fd-lat" inputMode="decimal" value={editing.lat} error={!!errs?.location} onChange={(e) => setD({ lat: e.target.value })} />
              </Field>
              <Field label="Pin longitude" optional hint="e.g. -122.6765">
                <TextInput id="fd-lng" inputMode="decimal" value={editing.lng} error={!!errs?.location} onChange={(e) => setD({ lng: e.target.value })} />
              </Field>
            </div>
            <span className="xs sub">{pointText(editing)}</span>
            <Field label="Opening hours" hint="As customers read it, e.g. Mon–Sat 7:00–18:00" error={errs?.hours}>
              <TextInput id="fd-hours" value={editing.hours} error={!!errs?.hours} onChange={(e) => setD({ hours: e.target.value })} />
            </Field>
            <Field label="Phone" hint="The Call button" error={errs?.phone}>
              <TextInput id="fd-phone" type="tel" value={editing.phone} error={!!errs?.phone} onChange={(e) => setD({ phone: e.target.value })} />
            </Field>
            <div className="grid md2 gap-3">
              <Field label="Message phone" optional hint="The Message button opens a text message to it">
                <TextInput id="fd-mphone" type="tel" value={editing.messagePhone} onChange={(e) => setD({ messagePhone: e.target.value })} />
              </Field>
              <Field label="Message email" optional hint="Used when there is no message phone" error={errs?.messageEmail}>
                <TextInput id="fd-memail" type="email" value={editing.messageEmail} error={!!errs?.messageEmail} onChange={(e) => setD({ messageEmail: e.target.value })} />
              </Field>
            </div>
            <div className="grid md2 gap-3">
              <Field label="Lead time (days)" optional hint="Days from today to the earliest delivery; empty uses the farm setting" error={errs?.leadDays}>
                <TextInput id="fd-lead" type="number" min={0} max={60} value={editing.leadDays} error={!!errs?.leadDays} onChange={(e) => setD({ leadDays: e.target.value })} />
              </Field>
              <Field label="Order" optional hint="The first active dealer is the default" error={errs?.position}>
                <TextInput id="fd-pos" type="number" min={1} value={editing.position} error={!!errs?.position} onChange={(e) => setD({ position: e.target.value })} />
              </Field>
            </div>
            <Switch id="fd-active" label="Takes orders: customers’ orders can go to this dealer" checked={editing.active} onChange={(e) => setD({ active: e.target.checked })} />
            {editing.id && editing.orderCount > 0 && <span className="xs sub">{plural(editing.orderCount, 'order')} use this dealer, so it can’t be deleted; switch it off instead.</span>}
          </fieldset>
        )}
      </Drawer>
    </>
  );
}
