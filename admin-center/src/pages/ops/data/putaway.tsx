import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { Badge, Button, Icon, TextInput, announce } from '@marketly/web-shared/ui';
import { dateTime } from '@/app/parts';

// Put-away of received units (step 4 of Receiving), used by pages/ops/Receiving.tsx.
// The warehouse creates one put-away task per received line when a receiving record is submitted
// (sellable units to a suggested bin, damaged units to a quarantine bin). A task stays open until a worker
// scans the bin the units went into; that also assigns the bin to the stock item, which picking needs.
// API: GET warehouse/putaway-tasks (receiptId or status filter), GET warehouse/putaway-tasks/labels,
// GET warehouse/scan (context putaway: is the code a bin, and is it the suggested one),
// POST warehouse/putaway-tasks/{id}/complete.

export type PutawayTask = components['schemas']['warehouse.PutawayTask'];
interface Page<T> {
  items: T[];
  total?: number;
  totalPages?: number;
}

/** The warehouse's catch-all suggestion for damaged units when no quarantine bin exists yet. */
const ANY_QUARANTINE = 'QUARANTINE';

/**
 * Put-away tasks of one receipt, or the open tasks of every receipt.
 * `pollUntilFound`: the tasks are created by an event right after the receipt is submitted, so they can
 * arrive a moment after the receipt changes; poll briefly until the first ones show up.
 */
export function usePutawayTasks(query: { receiptId?: string; status?: 'open' | 'done'; page?: number; limit?: number }, opts: { enabled?: boolean; pollUntilFound?: boolean } = {}) {
  const { api } = useApi();
  return useQuery({
    queryKey: ['warehouse', 'putaway-tasks', query],
    queryFn: () => call(api.GET('/api/admin/warehouse/putaway-tasks', { params: { query: { limit: 100, ...query } } })) as Promise<Page<PutawayTask>>,
    enabled: opts.enabled ?? true,
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (opts.pollUntilFound && !q.state.data?.items.length && q.state.dataUpdateCount < 10 ? 3000 : false),
  });
}

/** Opens the printable item and put-away labels of a receipt (SKU barcode, label, bin, quantity). */
export function usePutawayLabels() {
  const { api } = useApi();
  return useMutation({
    mutationFn: (receiptId: string) => call(api.GET('/api/admin/warehouse/putaway-tasks/labels', { params: { query: { receiptId } } })) as Promise<{ url: string }>,
    onSuccess: (l) => window.open(l.url, '_blank', 'noopener'),
  });
}

type Outcome = { kind: 'done'; task: PutawayTask } | { kind: 'check'; code: string; message: string } | { kind: 'refused'; message: string };

/** One task: scan or type the bin, adjust the quantity when only part fits, confirm. */
function TaskRow({ task, showReceipt, canPerform }: { task: PutawayTask; showReceipt: boolean; canPerform: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [bin, setBin] = useState('');
  const [qty, setQty] = useState(String(task.quantity));
  // A different bin than suggested is allowed but asked once: the worker confirms by pressing again.
  const [check, setCheck] = useState<{ code: string; message: string } | null>(null);
  const [refused, setRefused] = useState('');
  const damaged = task.suggestedBinCode === ANY_QUARANTINE;
  const id = `pa-${task.id}`;

  const complete = useMutation({
    mutationFn: async ({ code, quantity, confirmed }: { code: string; quantity: number; confirmed: boolean }): Promise<Outcome> => {
      if (!confirmed) {
        const s = (await call(api.GET('/api/admin/warehouse/scan', { params: { query: { code, context: 'putaway', contextId: task.id } } }))) as components['schemas']['warehouse.ScanResult'];
        if (s.kind !== 'bin' || !s.bin) return { kind: 'refused', message: `${code} is not a bin at this warehouse. Scan the label on the bin.` };
        if (!s.bin.active) return { kind: 'refused', message: `${s.bin.code} is not active. Choose another bin.` };
        if (damaged && s.bin.kind !== 'quarantine') return { kind: 'refused', message: `${s.bin.code} is not a quarantine bin. Damaged units go to a quarantine bin.` };
        // any quarantine bin will do for damaged units; otherwise ask when it is not the suggested bin
        if (s.message && !damaged) return { kind: 'check', code: s.bin.code, message: s.message };
      }
      const t = (await call(api.POST('/api/admin/warehouse/putaway-tasks/{id}/complete', { params: { path: { id: task.id } }, body: { binCode: code, quantity } }))) as PutawayTask;
      return { kind: 'done', task: t };
    },
    onSuccess: (r) => {
      if (r.kind === 'refused') {
        setRefused(r.message);
        setCheck(null);
        return;
      }
      if (r.kind === 'check') {
        setCheck({ code: r.code, message: r.message });
        return;
      }
      announce(`${r.task.quantity} × ${r.task.sku} put away in ${r.task.binCode ?? bin}`);
      // the task list, the warehouse counts (put-away open) and the stock item's bin in Inventory change
      void qc.invalidateQueries({ queryKey: ['warehouse'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const code = bin.trim().toUpperCase();
    const quantity = Math.floor(Number(qty));
    setRefused('');
    if (!code) return setRefused('Scan or enter the bin the units went into.');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > task.quantity) return setRefused(`Enter between 1 and ${task.quantity} units.`);
    complete.mutate({ code, quantity, confirmed: check?.code === code });
  };

  const done = task.status === 'done';
  return (
    <article className={cx('ac-line', !done && damaged && 'is-flagged')}>
      {!done && damaged && <span className="sr-only">Damaged units: </span>}
      <div className="row gap-3 nowrap top">
        <span className="stack gap-0 grow">
          <span className="small strong">{task.label}</span>
          <span className="xs mono muted">
            {task.sku}
            {showReceipt && ` · ${task.receiptRef}`}
          </span>
        </span>
        {done ? (
          <Badge tone="success" icon="check">
            {task.quantity} in {task.binCode}
          </Badge>
        ) : (
          <Badge tone={damaged ? 'danger' : 'outline'}>{task.quantity} to put away</Badge>
        )}
      </div>
      {done ? (
        <span className="xs muted">
          Put away{task.doneBy?.name ? ` by ${task.doneBy.name}` : ''}
          {task.doneAt ? `, ${dateTime(task.doneAt)}` : ''}
        </span>
      ) : (
        <>
          <span className="xs sub">
            {damaged ? (
              'Damaged units: put them in a quarantine bin.'
            ) : task.suggestedBinCode ? (
              <>
                Suggested bin <b className="mono">{task.suggestedBinCode}</b>
              </>
            ) : (
              'No bin suggested. Put the units in any pick or bulk bin and scan it.'
            )}
          </span>
          {canPerform ? (
            <form className="row gap-2" onSubmit={submit}>
              <label className="sr-only" htmlFor={`${id}-bin`}>
                Bin for {task.sku}
              </label>
              <span className="grow">
                <TextInput
                  id={`${id}-bin`}
                  icon="scan-barcode"
                  placeholder="Scan or enter bin"
                  value={bin}
                  autoComplete="off"
                  error={!!refused}
                  onChange={(e) => {
                    setBin(e.target.value.toUpperCase());
                    setCheck(null);
                  }}
                />
              </span>
              <label className="sr-only" htmlFor={`${id}-qty`}>
                Units
              </label>
              <input className="input ac-qty" id={`${id}-qty`} type="number" min={1} max={task.quantity} value={qty} onChange={(e) => setQty(e.target.value)} />
              <Button type="submit" size="sm" variant={check ? 'primary' : 'secondary'} disabled={complete.isPending}>
                {complete.isPending ? 'Saving…' : check ? 'Put away here anyway' : 'Put away'}
              </Button>
            </form>
          ) : (
            <span className="xs muted">Warehouse staff with put-away access confirm the bin.</span>
          )}
          {check && (
            <span className="xs t-warning-text" role="status">
              <Icon name="triangle-alert" className="ic-sm" /> {check.message}. Press “Put away here anyway” to use {check.code}.
            </span>
          )}
          {(refused || complete.error) && (
            <span className="error-text" role="alert">
              <Icon name="circle-alert" className="ic-sm" />
              {refused || errorMessage(complete.error)}
            </span>
          )}
          {Number(qty) > 0 && Number(qty) < task.quantity && <span className="xs muted">The other {task.quantity - Number(qty)} units stay on an open task for another bin.</span>}
        </>
      )}
    </article>
  );
}

/** A list of put-away tasks (open first). `showReceipt` adds the receipt reference for the all-receipts list. */
export function PutawayTaskList({ tasks, showReceipt = false, canPerform, empty }: { tasks: PutawayTask[]; showReceipt?: boolean; canPerform: boolean; empty: string }) {
  if (!tasks.length) return <p className="xs muted">{empty}</p>;
  const sorted = [...tasks].sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done'));
  return (
    <div className="ac-lines">
      {sorted.map((t) => (
        <TaskRow key={t.id} task={t} showReceipt={showReceipt} canPerform={canPerform} />
      ))}
    </div>
  );
}
