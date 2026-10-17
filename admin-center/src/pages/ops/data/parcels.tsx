import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { call, errorMessage, useApi, useUploads } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { Alert, Button, Card, Dialog, Field, Icon, Img, SearchInput, Select, StatusBadge, TableWrap, Textarea, TextInput } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines, dateTime, shortDate } from '@/app/parts';
import { useStaffSession } from '@/app/session';
import { EmptyRow, SkeletonRows } from './shared';

// Return parcels at the warehouse dock, for pages/ops/ReturnInspection.tsx (no design: built from the page's parts).
// Official Store and Fulfilled by Marketly return parcels are scanned in here. Offline there are no carrier
// "delivered" events, so this check-in is what moves a return to Received and onto the inspection bench.
// API: GET warehouse/return-parcels (status, q), POST warehouse/return-parcels (ReceiveParcelInput: code,
// parcelCondition, photoIds, note; 409 PARCEL_ALREADY_RECEIVED), POST return-parcels/{id}/hand-over.
// A code with no approved return is recorded as an unexpected parcel and raised in the Return parcels work queue.

export type ParcelCondition = 'intact' | 'damaged' | 'opened';
export const PARCEL_CONDITIONS: Array<{ value: ParcelCondition; label: string }> = [
  { value: 'intact', label: 'Intact' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'opened', label: 'Opened' },
];
const conditionLabel = (c?: string | null) => PARCEL_CONDITIONS.find((x) => x.value === c)?.label ?? '—';

export interface ReturnParcel {
  id: string;
  returnId: string | null;
  returnRef: string | null;
  orderRef: string | null;
  trackingNumber: string | null;
  status: 'expected' | 'received' | 'handed_over';
  expectedBy: string | null;
  expectedItems: string[];
  unexpected: boolean;
  parcelCondition: ParcelCondition | null;
  note: string | null;
  receivedBy: { name?: string | null } | null;
  receivedAt: string | null;
  handedOverTo: { name?: string | null } | null;
  handedOverAt: string | null;
}

const STATUS_LABEL: Record<ReturnParcel['status'], string> = { expected: 'Expected', received: 'Received', handed_over: 'Handed over' };
const FILTERS = [
  { value: 'received', label: 'Received, to hand over' },
  { value: 'expected', label: 'Expected' },
  { value: 'handed_over', label: 'Handed over' },
  { value: '', label: 'All parcels' },
];
const parcelName = (p: ReturnParcel) => p.returnRef ?? p.trackingNumber ?? 'Unknown parcel';

/** Everything a parcel check-in or hand-over changes: the parcel lists, the return queues and the work queue counts. */
function useRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['warehouse', 'return-parcels'] });
    void qc.invalidateQueries({ queryKey: ['returns'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };
}

/**
 * Check in a return parcel at the dock: scan the return label (or type the return reference or tracking number),
 * say what state the box is in, add photos of a damaged or opened box. `code` prefills the field (an Arriving row).
 */
export function CheckInDialog({ open, code: initial, onClose, onDone }: { open: boolean; code?: string; onClose: () => void; onDone: (msg: string) => void }) {
  const { api } = useApi();
  const refresh = useRefresh();
  const photos = useUploads('inspection_photo', { max: 4, accept: /^image\// });
  const [code, setCode] = useState('');
  const [condition, setCondition] = useState<ParcelCondition>('intact');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const { clear } = photos;

  // a fresh form each time the dialog opens
  useEffect(() => {
    if (!open) return;
    setCode(initial ?? '');
    setCondition('intact');
    setNote('');
    setTried(false);
    clear();
  }, [open, initial, clear]);

  const receive = useMutation({
    mutationFn: () => call(api.POST('/api/admin/warehouse/return-parcels', { body: { code: code.trim(), parcelCondition: condition, photoIds: photos.assetIds.length ? photos.assetIds : undefined, note: note.trim() || undefined } })) as Promise<ReturnParcel>,
    onSuccess: (p) => {
      refresh();
      onDone(
        p.unexpected
          ? `Parcel ${parcelName(p)} recorded as unexpected: no approved Official Store return matches it. It is in the Return parcels work queue so support can find the customer.`
          : `${parcelName(p)} checked in${p.orderRef ? ` (order ${p.orderRef})` : ''}. The return is now in the Received tab. Hand the parcel to the inspection bench.`,
      );
      onClose();
    },
  });
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setTried(true);
    if (code.trim() && !photos.uploading) receive.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Check in return parcel"
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="package-check" onClick={() => submit()} disabled={receive.isPending || photos.uploading}>
            {receive.isPending ? 'Checking in…' : 'Check in'}
          </Button>
        </>
      }
    >
      {receive.error && <Alert tone="danger">{errorMessage(receive.error)}</Alert>}
      <form onSubmit={submit} className="stack gap-3">
        <Field label="Return label or reference" hint="Scan the return label, or type the RT- reference or tracking number" error={tried && !code.trim() ? 'Scan the return label or enter the return reference.' : undefined}>
          <TextInput id="rp-code" className="mono" value={code} autoComplete="off" autoFocus icon="scan-barcode" error={tried && !code.trim()} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Parcel condition">
          <Select id="rp-cond" options={PARCEL_CONDITIONS} value={condition} onChange={(e) => setCondition(e.target.value as ParcelCondition)} />
        </Field>
        <Field label="Note" optional>
          <Textarea id="rp-note" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </form>
      <input
        ref={file}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          photos.add(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <Button variant="secondary" size="sm" icon="camera" onClick={() => file.current?.click()}>
        Add photo
      </Button>
      <span className="xs muted">
        {photos.items.length ? `${photos.assetIds.length} of ${photos.items.length} photos ready` : condition === 'intact' ? 'Photos are optional.' : 'Add a photo of the box: it is the evidence if the carrier damaged it.'} {photos.error}
      </span>
    </Dialog>
  );
}

/** The parcels at the dock: received ones are handed to inspection here; expected ones can be checked in. */
export function ParcelsCard({ onCheckIn, onDone }: { onCheckIn: (code: string) => void; onDone: (msg: string) => void }) {
  const { api } = useApi();
  const staff = useStaffSession();
  const refresh = useRefresh();
  const canReceive = staff.can('warehouse.returns.receive');
  const [status, setStatus] = useState('received');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const query = { status: (status || undefined) as ReturnParcel['status'] | undefined, q: search || undefined, limit: 100 };
  const list = useQuery({ queryKey: ['warehouse', 'return-parcels', query], queryFn: () => call(api.GET('/api/admin/warehouse/return-parcels', { params: { query } })) as Promise<{ items: ReturnParcel[]; total?: number }> });
  const handOver = useMutation({
    mutationFn: (p: ReturnParcel) => call(api.POST('/api/admin/warehouse/return-parcels/{id}/hand-over', { params: { path: { id: p.id } }, body: {} })) as Promise<ReturnParcel>,
    onSuccess: (p) => {
      refresh();
      onDone(`${parcelName(p)} handed to returns inspection.`);
    },
  });
  const rows = list.data?.items ?? [];

  const action = (p: ReturnParcel) => {
    if (!canReceive) return null;
    if (p.status === 'received')
      return (
        <Button size="sm" variant="secondary" icon="arrow-right" onClick={() => handOver.mutate(p)} disabled={handOver.isPending}>
          Hand over<span className="sr-only"> {parcelName(p)}</span>
        </Button>
      );
    if (p.status === 'expected')
      return (
        <Button size="sm" variant="ghost" icon="package-check" onClick={() => onCheckIn(p.returnRef ?? p.trackingNumber ?? '')}>
          Check in<span className="sr-only"> {parcelName(p)}</span>
        </Button>
      );
    return null;
  };
  const when = (p: ReturnParcel) =>
    p.status === 'expected' ? (p.expectedBy ? `Expected by ${shortDate(p.expectedBy)}` : 'Expected') : p.status === 'handed_over' ? `Handed over ${p.handedOverAt ? dateTime(p.handedOverAt) : ''}` : `${p.receivedAt ? dateTime(p.receivedAt) : ''}${p.receivedBy?.name ? ` · ${p.receivedBy.name}` : ''}`;
  const name = (p: ReturnParcel) => (
    <span className="stack gap-0">
      <span className="mono nowrap">{parcelName(p)}</span>
      {p.orderRef && <span className="xs mono muted nowrap">{p.orderRef}</span>}
      {p.unexpected && <span className="xs t-warning-text strong">Unexpected parcel</span>}
    </span>
  );

  return (
    <Card title="Return parcels" sub="Check parcels in at the dock, then hand them to the inspection bench" flush>
      <div className="card-body stack gap-2">
        <div className="toolbar">
          <SearchInput id="rp-q" placeholder="Search return, order or tracking number" value={q} onChange={setQ} />
          <label className="sr-only" htmlFor="rp-status">
            Parcel status
          </label>
          <Select id="rp-status" options={FILTERS} value={status} onChange={(e) => setStatus(e.target.value)} />
        </div>
        {handOver.error && <Alert tone="danger">{errorMessage(handOver.error)}</Alert>}
      </div>
      {list.error ? (
        <div className="card-body">
          <LoadError error={list.error} onRetry={() => void list.refetch()} />
        </div>
      ) : (
        <>
          <div className="no-phone">
            <TableWrap label="Return parcels table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Parcel</th>
                    <th scope="col">Items</th>
                    <th scope="col">Condition</th>
                    <th scope="col">When</th>
                    <th scope="col">Status</th>
                    <th className="col-pin" scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.isPending && <SkeletonRows cols={6} />}
                  {!list.isPending && !rows.length && <EmptyRow cols={6}>{status === 'received' ? 'No parcels are waiting to be handed over.' : 'No parcels here.'}</EmptyRow>}
                  {rows.map((p) => (
                    <tr key={p.id} className={cx(p.unexpected && 'is-warn')}>
                      <td>{name(p)}</td>
                      <td>
                        <div className="cell-main">
                          <Img icon="package" className="tiny" />
                          <span className="small">{p.expectedItems.length ? p.expectedItems.join('; ') : '—'}</span>
                        </div>
                      </td>
                      <td>
                        <span className={cx('small', p.parcelCondition && p.parcelCondition !== 'intact' && 't-warning-text strong')}>{conditionLabel(p.parcelCondition)}</span>
                      </td>
                      <td>
                        <span className="small">{when(p)}</span>
                      </td>
                      <td>
                        <StatusBadge status={STATUS_LABEL[p.status] ?? p.status} />
                      </td>
                      <td className="col-pin">{action(p)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </div>
          <div className="ac-mlist only-phone">
            {list.isPending && <SkeletonLines rows={3} />}
            {rows.map((p) => (
              <div key={p.id} className={cx('ac-mi', p.unexpected && 'is-warn')}>
                <div className="row between gap-2 nowrap top">
                  <span className="small strong min-w-0">{name(p)}</span>
                  <StatusBadge status={STATUS_LABEL[p.status] ?? p.status} />
                </div>
                {p.expectedItems.length > 0 && <div className="xs sub">{p.expectedItems.join('; ')}</div>}
                <div className="xs sub">
                  {conditionLabel(p.parcelCondition)} · {when(p)}
                </div>
                {action(p) && <div className="row gap-2 mt-1-5">{action(p)}</div>}
              </div>
            ))}
            {!list.isPending && !rows.length && <div className="ac-mi xs sub">No parcels here.</div>}
          </div>
        </>
      )}
      {!canReceive && (
        <div className="card-body">
          <span className="xs muted">
            <Icon name="info" className="ic-sm" /> Warehouse staff with return receiving access check parcels in and hand them over.
          </span>
        </div>
      )}
    </Card>
  );
}
