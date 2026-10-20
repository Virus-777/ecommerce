import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { formatMoney, parseCents } from '@marketly/web-shared/lib/format';
import { addDays } from '@marketly/web-shared/lib/period';
import { Button, IconButton, TextInput, announce } from '@marketly/web-shared/ui';
import { isoDaysAgo } from './finance';

// Unit costs per offer (docs/09 §3.1): what the seller paid for one unit, with the day it applies from, so
// Statistics can show profit. Rows are never edited; a new cost from a day replaces the old one from that day on.
// API: GET offers/offers/{id}/costs (history), PUT offers/offers/{id}/cost (one), POST offers/costs (up to 500).

export type OfferCost = components['schemas']['offers.OfferCost'];
type Money = components['schemas']['Money'];

/** The permission to set unit costs (sellers' owner and catalogue roles). */
export const COST_PERMISSION = 'offers.costs.manage';
/** How far back a cost may start (the backend refuses more), so old sales can get a cost. */
export const MAX_COST_DAYS_BACK = 400;

/** Today in market time (YYYY-MM-DD). */
export const costToday = () => isoDaysAgo(0);
/** The earliest day a cost may start. */
export const costEarliest = () => addDays(costToday(), -MAX_COST_DAYS_BACK);
/** A "from" day kept inside what the backend accepts. */
export const clampCostDay = (d: string) => (d < costEarliest() ? costEarliest() : d > costToday() ? costToday() : d);

/** "12.40" → 1240; zero is a valid cost (a free sample still has a cost of $0). Null when not a price. */
export const parseCost = (text: string): number | null => (text.trim() === '' ? null : parseCents(text));

/** Cache keys the cost writes refresh: the offer, its history, the product lists and the profit reports. */
function useCostRefresh() {
  const qc = useQueryClient();
  return (offerIds: string[]) => {
    void qc.invalidateQueries({ queryKey: ['reports'] });
    void qc.invalidateQueries({ queryKey: ['offers'] });
    void qc.invalidateQueries({ queryKey: ['catalog'] });
    offerIds.forEach((id) => void qc.invalidateQueries({ queryKey: ['offer-costs', id] }));
  };
}

/** PUT offers/offers/{id}/cost. */
export function useSetCost() {
  const { api } = useApi();
  const refresh = useCostRefresh();
  return useMutation({
    mutationFn: (v: { offerId: string; unitCost: Money; effectiveFrom?: string; note?: string }) =>
      call(api.PUT('/api/seller/offers/offers/{id}/cost', { params: { path: { id: v.offerId } }, body: { unitCost: v.unitCost, ...(v.effectiveFrom ? { effectiveFrom: v.effectiveFrom } : {}), ...(v.note ? { note: v.note } : {}) } })),
    onSuccess: (c) => {
      refresh([c.offerId]);
      announce(`Unit cost ${formatMoney(c.unitCost)} saved`);
    },
  });
}

/** POST offers/costs: each item is saved or refused on its own. */
export function useSetCosts() {
  const { api } = useApi();
  const refresh = useCostRefresh();
  return useMutation({
    mutationFn: (items: Array<{ offerId: string; unitCost: Money; effectiveFrom?: string }>) => call(api.POST('/api/seller/offers/costs', { body: { items } })),
    onSuccess: (res, items) => {
      refresh(items.map((i) => i.offerId));
      announce(`${res.saved} unit cost${res.saved === 1 ? '' : 's'} saved`);
    },
  });
}

/**
 * A unit cost in a table cell: the amount and a pencil; editing shows the amount and the day it applies from.
 * `from` is the day offered for a first cost (e.g. the start of the period on screen, so its sales get a cost).
 */
export function UnitCostCell({ offerId, current, currency = 'USD', from, canEdit, label }: { offerId: string; current?: Money | null; currency?: string; from: string; canEdit: boolean; label: string }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [day, setDay] = useState(from);
  const save = useSetCost();
  const cents = parseCost(text);

  if (!editing) {
    return (
      <span className="row gap-1 nowrap" style={{ justifyContent: 'flex-end' }}>
        <span className={current ? 'num' : 'small muted'}>{current ? formatMoney(current) : 'Not set'}</span>
        {canEdit && (
          <IconButton
            icon="pencil"
            label={`${current ? 'Change' : 'Set'} the unit cost of ${label}`}
            onClick={() => {
              setText(current ? (current.amount / 100).toFixed(2) : '');
              setDay(current ? costToday() : clampCostDay(from));
              save.reset();
              setEditing(true);
            }}
          />
        )}
      </span>
    );
  }
  const submit = () => {
    if (cents === null) return;
    save.mutate({ offerId, unitCost: { amount: cents, currency }, effectiveFrom: day }, { onSuccess: () => setEditing(false) });
  };
  return (
    <form
      className="stack gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <span className="row gap-1 nowrap">
        <TextInput id={`${id}-cost`} ctl="sm" prefix="$" inputMode="decimal" aria-label={`Unit cost of ${label}`} value={text} error={text !== '' && cents === null} autoFocus style={{ width: '6.5rem' }} onChange={(e) => setText(e.target.value)} />
        <TextInput id={`${id}-from`} ctl="sm" type="date" aria-label="Applies from" title="Applies from" value={day} min={costEarliest()} max={costToday()} style={{ width: '9.5rem' }} onChange={(e) => setDay(e.target.value)} />
      </span>
      <span className="row gap-1 nowrap" style={{ justifyContent: 'flex-end' }}>
        <Button size="sm" type="submit" disabled={cents === null || !day || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </span>
      {save.isError && <span className="xs t-danger-text">{errorMessage(save.error)}</span>}
    </form>
  );
}
