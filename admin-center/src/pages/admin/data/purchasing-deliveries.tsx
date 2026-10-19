import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { num } from '@marketly/web-shared/lib/format';
import { Alert, announce, Button, Checkbox, Field, StatusBadge, Textarea, TextInput } from '@marketly/web-shared/ui';
import { shortDate } from '@/app/parts';
import type { PurchaseOrder } from './purchasing';

// Expected deliveries of a sent purchase order, shown inside the purchase order drawer.
// Ops › Receiving lists deliveries only, so a sent PO reaches the warehouse once it has one:
// POST /api/admin/purchasing/purchase-orders/{id}/deliveries (add), PATCH /deliveries/{id} (reschedule or delay),
// POST /purchase-orders/{id}/close (close a partly received PO short).
// These are inline panels rather than dialogs because a dialog on top of the drawer would fight it for focus.

export type Delivery = PurchaseOrder['deliveries'][number];

export const DELIVERY_STATUS_LABEL: Record<Delivery['status'], string> = {
  expected: 'Expected',
  delayed: 'Delayed',
  arrived: 'Arrived',
  receiving: 'Receiving',
  received: 'Received',
  received_with_issues: 'Received with issues',
  cancelled: 'Cancelled',
};

/** Deliveries the warehouse can still check in or count: Receiving shows these. */
export const isOpenDelivery = (d: Delivery) => d.status === 'expected' || d.status === 'delayed' || d.status === 'arrived' || d.status === 'receiving';
/** Only deliveries that have not arrived can be rescheduled (backend: reschedule / delay). */
const canReschedule = (d: Delivery) => d.status === 'expected' || d.status === 'delayed';

/** Units still to come on the PO (ordered − received − closed short). */
export const outstandingUnits = (po: PurchaseOrder) => po.lines.reduce((s, l) => s + Math.max(0, l.quantityOpen), 0);

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDay(d);
};
// The arrival window is whole days in the staff member's own time (the warehouse's day): from the start of the
// first day to the end of the last.
const dayStart = (day: string) => new Date(`${day}T00:00`).toISOString();
const dayEnd = (day: string) => new Date(`${day}T23:59`).toISOString();
const isoDay = (iso: string) => localDay(new Date(iso));
const validDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00`).getTime());

const windowText = (d: Delivery) => {
  const from = shortDate(d.windowFrom);
  const to = shortDate(d.windowTo);
  return from === to ? from : `${from} – ${to}`;
};

/** The deliveries on a PO, each with Reschedule while it has not arrived. */
export function DeliveryList({ po, canManage, onEdit }: { po: PurchaseOrder; canManage: boolean; onEdit: (d: Delivery) => void }) {
  if (!po.deliveries.length) return null;
  return (
    <div className="stack gap-2">
      <span className="label">Expected deliveries</span>
      {po.deliveries.map((d) => (
        <div className="panel stack gap-1" key={d.id}>
          <div className="row between top">
            <span className="stack gap-0">
              <span className="small strong">{windowText(d)}</span>
              <span className="xs muted">{[d.carrier, d.trackingRef, `${num(d.units)} units`].filter(Boolean).join(' · ')}</span>
            </span>
            <StatusBadge status={DELIVERY_STATUS_LABEL[d.status]} />
          </div>
          {d.delayReason && <span className="xs muted">{d.delayReason}</span>}
          {canManage && canReschedule(d) && (
            <div className="row">
              <Button variant="ghost" size="sm" icon="calendar" onClick={() => onEdit(d)}>
                Reschedule or edit
                <span className="sr-only"> delivery {windowText(d)}</span>
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

interface DeliveryFormState {
  from: string;
  to: string;
  units: string;
  carrier: string;
  trackingRef: string;
  note: string;
  delayed: boolean;
}

/**
 * Add an expected delivery (no `delivery`) or reschedule one. Adding defaults to the PO's expected date, else today +
 * the supplier's lead time, and to every unit still outstanding. The API takes a unit count, not per-line quantities:
 * the receiving record expects the PO's open lines.
 */
export function DeliveryForm({ po, leadTimeDays, delivery, onDone, onCancel }: { po: PurchaseOrder; leadTimeDays: number; delivery?: Delivery; onDone: (message: string) => void; onCancel: () => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const open = outstandingUnits(po);
  const [f, setF] = useState<DeliveryFormState>(() => {
    if (delivery) return { from: isoDay(delivery.windowFrom), to: isoDay(delivery.windowTo), units: String(delivery.units), carrier: delivery.carrier ?? '', trackingRef: delivery.trackingRef ?? '', note: '', delayed: delivery.status === 'delayed' };
    const day = po.expectedDate?.slice(0, 10) || addDays(leadTimeDays);
    return { from: day, to: day, units: String(open), carrier: '', trackingRef: '', note: '', delayed: false };
  });
  const [tried, setTried] = useState(false);
  const set = (patch: Partial<DeliveryFormState>) => setF((p) => ({ ...p, ...patch }));

  const errors: Partial<Record<'from' | 'to' | 'units' | 'note', string>> = {};
  if (!validDay(f.from)) errors.from = 'Choose the first day it can arrive.';
  if (f.to && !validDay(f.to)) errors.to = 'Choose a valid date.';
  else if (validDay(f.from) && f.to && f.to < f.from) errors.to = 'The last day must be on or after the first.';
  if (!delivery && (!/^\d+$/.test(f.units.trim()) || Number(f.units) < 1)) errors.units = 'Enter a whole number of 1 or more.';
  // The backend asks why a delivery changed; it is shown on the Receiving screen.
  if (delivery && !f.note.trim()) errors.note = 'Say why the delivery changed.';
  const shown = tried ? errors : {};

  const save = useMutation({
    mutationFn: () => {
      const windowFrom = dayStart(f.from);
      const windowTo = dayEnd(f.to || f.from);
      if (delivery) {
        return call(
          api.PATCH('/api/admin/purchasing/deliveries/{id}', {
            params: { path: { id: delivery.id } },
            body: { windowFrom, windowTo, carrier: f.carrier.trim() || null, trackingRef: f.trackingRef.trim() || null, delayed: f.delayed, reason: f.note.trim() },
          }),
        );
      }
      return call(
        api.POST('/api/admin/purchasing/purchase-orders/{id}/deliveries', {
          params: { path: { id: po.id } },
          body: { windowFrom, windowTo, units: Number(f.units), carrier: f.carrier.trim() || null, trackingRef: f.trackingRef.trim() || null, note: f.note.trim() || null },
        }),
      );
    },
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['purchasing'] });
      void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
      const msg = delivery ? `Delivery ${d.status === 'delayed' ? 'marked delayed' : `now due ${windowText(d)}`}` : `Delivery expected ${windowText(d)} added. It shows in Receiving.`;
      announce(msg);
      onDone(msg);
    },
  });
  const submit = () => {
    setTried(true);
    if (Object.keys(errors).length) return;
    save.mutate();
  };

  return (
    <div className="panel stack gap-3">
      <span className="small strong">{delivery ? 'Reschedule delivery' : 'Add expected delivery'}</span>
      {!delivery && <span className="xs muted">Receiving lists expected deliveries, so add one for the warehouse to check this order in.</span>}
      {save.isError && <Alert tone="danger" title={errorMessage(save.error)} />}
      <div className="grid md2 gap-3">
        <Field label="Arrives from" error={shown.from}>
          <TextInput id="dl-from" type="date" value={f.from} error={!!shown.from} onChange={(e) => set({ from: e.target.value, to: f.to && f.to < e.target.value ? e.target.value : f.to })} />
        </Field>
        <Field label="Arrives by" optional error={shown.to}>
          <TextInput id="dl-to" type="date" value={f.to} error={!!shown.to} onChange={(e) => set({ to: e.target.value })} />
        </Field>
      </div>
      {!delivery && (
        <Field label="Units on this delivery" hint={`${num(open)} still outstanding on ${po.ref}`} error={shown.units}>
          <TextInput id="dl-units" inputMode="numeric" value={f.units} error={!!shown.units} onChange={(e) => set({ units: e.target.value })} />
        </Field>
      )}
      <div className="grid md2 gap-3">
        <Field label="Carrier" optional>
          <TextInput id="dl-carrier" placeholder="UPS Freight" value={f.carrier} onChange={(e) => set({ carrier: e.target.value })} />
        </Field>
        <Field label="Tracking or BOL number" optional>
          <TextInput id="dl-ref" value={f.trackingRef} onChange={(e) => set({ trackingRef: e.target.value })} />
        </Field>
      </div>
      {delivery && <Checkbox id="dl-delayed" label="Mark as delayed" checked={f.delayed} onChange={(e) => set({ delayed: e.target.checked })} />}
      <Field label={delivery ? 'Reason' : 'Note'} optional={!delivery} hint={delivery ? 'Shown on the Receiving screen' : undefined} error={shown.note}>
        <Textarea id="dl-note" rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} />
      </Field>
      <div className="row gap-2">
        <Button size="sm" icon="check" onClick={submit} disabled={save.isPending}>
          {delivery ? 'Save delivery' : 'Add delivery'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={save.isPending}>
          {delivery ? 'Cancel' : 'Not now'}
        </Button>
      </div>
    </div>
  );
}

/** Close a partly received PO short: the open units leave Incoming; optionally raise a shortage claim. */
export function ClosePoForm({ po, canClaim, onDone, onCancel }: { po: PurchaseOrder; canClaim: boolean; onDone: (message: string) => void; onCancel: () => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [claim, setClaim] = useState(false);
  const [tried, setTried] = useState(false);
  const error = tried && !reason.trim() ? 'Say why the rest will not arrive.' : undefined;
  const close = useMutation({
    mutationFn: () => call(api.POST('/api/admin/purchasing/purchase-orders/{id}/close', { params: { path: { id: po.id } }, body: { reason: reason.trim(), raiseShortageClaim: canClaim && claim } })),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['purchasing'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      const msg = `${p.ref} closed short`;
      announce(msg);
      onDone(msg);
    },
  });
  const open = outstandingUnits(po);
  return (
    <div className="panel stack gap-3">
      <span className="small strong">Close {po.ref} short</span>
      <span className="xs muted">The {num(open)} units still outstanding will not arrive. They leave Incoming stock and the purchase order is finished.</span>
      {close.isError && <Alert tone="danger" title={errorMessage(close.error)} />}
      <Field label="Reason" error={error}>
        <Textarea id="po-close-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {canClaim && <Checkbox id="po-close-claim" label="Open a shortage claim with the supplier for the missing units" checked={claim} onChange={(e) => setClaim(e.target.checked)} />}
      <div className="row gap-2">
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            setTried(true);
            if (reason.trim()) close.mutate();
          }}
          disabled={close.isPending}
        >
          Close short
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={close.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
