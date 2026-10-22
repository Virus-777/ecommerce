import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { num } from '@marketly/web-shared/lib/format';
import { Alert, announce, Badge, Button, Drawer, EmptyState, Field, KeyValue, PageHeader, Pager, SearchInput, StatusBadge, TableWrap, Textarea, TextInput, Timeline } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { date, dateTime, dayKey, LoadError, monthYear, SkeletonLines } from '@/app/parts';
import { codeOf, DeptPage, fieldErrorsOf, PAGE_SIZE, totalPagesOf } from './data/departments';

// Admin › Departments › Registered devices (designed in React from the Marketly Departments canvas: the Post-sale
// devices screens; no admin artboard, so the DeptServices pattern). The phones customers register for Marketly post-sale
// cover: staff check the purchase, verify the device with the end of its cover (default the purchase date plus 12
// months) or reject it with a reason, and correct its details. A verified device under cover makes covered-by-warranty
// post-sale services $0. Full IMEIs need services.devices.manage; others see the last 4 digits.
// API: /api/admin/services/devices.

type S = components['schemas'];
type Device = S['services.DeviceAdmin'];
type DeviceStatus = Device['status'];
type DeviceUpdate = S['services.DeviceAdminUpdate'];
type Notify = (title: string, tone?: 'success' | 'danger') => void;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const DEVICE_STATUS: Record<DeviceStatus, { label: string; tone: 'brand' | 'info' | 'warning' | 'success' | 'danger' | '' }> = {
  pending: { label: 'Waiting for review', tone: 'brand' },
  verified: { label: 'Verified', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
};
/** Who changed a device, from the history's actor key (customer, staff:<id>, system) */
const byLabel = (by: string) => (by.startsWith('staff:') ? 'staff' : by.startsWith('system') ? 'automatic' : by);
const masked = (d: Device) => `••••••••••• ${d.imeiLast4}`;
const imeiText = (d: Device) => (d.imei ? d.imei.replace(/^(\d{2})(\d{6})(\d{6})(\d)$/, '$1 $2 $3 $4') : masked(d));
const coverText = (d: Device) => (d.status !== 'verified' || !d.coveredUntil ? '—' : d.covered ? `Covered to ${monthYear(d.coveredUntil)}` : `Cover ended ${date(d.coveredUntil)}`);

export default function DeptDevices() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const canView = can('services.view');
  const canHandle = can('services.devices.manage');
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; title: string } | null>(null);
  const notify: Notify = (title, tone = 'success') => {
    setNotice({ tone, title });
    announce(title);
  };
  const [status, setStatus] = useState<DeviceStatus | ''>('pending');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Device | null>(null);
  const query = { status: status || undefined, q: q.trim() || undefined };
  const list = useQuery({
    queryKey: ['services', 'devices', query, page],
    enabled: canView,
    queryFn: () => call(api.GET('/api/admin/services/devices', { params: { query: { ...query, page, limit: PAGE_SIZE } } })),
    placeholderData: keepPreviousData,
  });
  const waiting = useQuery({ queryKey: ['services', 'devices', 'waiting'], enabled: canView, queryFn: () => call(api.GET('/api/admin/services/devices', { params: { query: { status: 'pending', limit: 1 } } })) });
  const rows = list.data?.items ?? [];
  const filtered = !!(q || status);
  const changed = (d: Device, title: string) => {
    void qc.invalidateQueries({ queryKey: ['services', 'devices'] });
    setOpen(d);
    notify(title);
  };

  return (
    <DeptPage active="dept-devices" title="Registered devices" canView={canView}>
      <PageHeader
        crumbs={[{ label: 'Departments' }, { label: 'Registered devices' }]}
        title="Registered devices"
        sub={`Phones customers register for post-sale cover · verify each one with the end of its cover; covered-by-warranty services are free for a verified device while its cover runs${canHandle ? '' : ' · view only: verifying devices and full IMEIs need the registered devices permission'}`}
      />
      {notice && <Alert tone={notice.tone} title={notice.title} />}
      <section className="card">
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="dv-q" placeholder="IMEI, last 4 digits, model, order ref or customer" value={q} onChange={(v) => (setQ(v), setPage(1))} label="Search registered devices" />
            <select className="select" id="dv-st" aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value as DeviceStatus | ''), setPage(1))}>
              <option value="">All statuses</option>
              {(Object.keys(DEVICE_STATUS) as DeviceStatus[]).map((s) => (
                <option key={s} value={s}>
                  {DEVICE_STATUS[s].label}
                  {s === 'pending' && waiting.data?.total ? ` (${num(waiting.data.total)})` : ''}
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
        <TableWrap label="Registered devices table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">Customer</th>
                <th scope="col">IMEI</th>
                <th scope="col">Purchased</th>
                <th scope="col">Order ref</th>
                <th scope="col">Cover</th>
                <th className="r" scope="col">
                  Requests
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
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>
                    <span className="stack gap-0">
                      <span className="small strong">{d.label}</span>
                      <span className="xs muted">{[d.brand, d.storage].filter(Boolean).join(' · ')}</span>
                    </span>
                  </td>
                  <td className="small">{d.customerName ?? <span className="muted">Unknown customer</span>}</td>
                  <td className="mono small nowrap">{d.imei ? imeiText(d) : `•••• ${d.imeiLast4}`}</td>
                  <td className="small nowrap">{date(d.purchaseDate)}</td>
                  <td className="mono small nowrap">{d.orderRef ?? <span className="muted">—</span>}</td>
                  <td className="small nowrap">{d.status === 'verified' && d.coveredUntil ? <Badge tone={d.covered ? 'success' : undefined}>{coverText(d)}</Badge> : <span className="muted">—</span>}</td>
                  <td className="r small">{num(d.requestCount)}</td>
                  <td>
                    <StatusBadge status={DEVICE_STATUS[d.status].label} tone={DEVICE_STATUS[d.status].tone} />
                  </td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(d)}>
                      Open<span className="sr-only"> {d.label}</span>
                    </button>
                  </td>
                </tr>
              ))}
              {list.isSuccess && rows.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <EmptyState icon="badge-check" title={status === 'pending' && !q ? 'No devices waiting' : filtered ? 'No devices match' : 'No registered devices yet'}>
                      {status === 'pending' && !q ? 'Devices customers register in the app show up here for review.' : filtered ? 'Try another search or clear the filters.' : 'Customers register their phones in the app’s Post-sale services.'}
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableWrap>
        <div className="card-foot between">
          <span className="xs muted">Newest first · a customer who changes a rejected device sends it back for review.</span>
          <Pager page={page} total={totalPagesOf(list.data)} onPage={setPage} />
        </div>
      </section>
      {/* one drawer per device: its forms start from that device */}
      {open && <DeviceDrawer key={open.id} device={open} canHandle={canHandle} onClose={() => setOpen(null)} onChanged={changed} />}
    </DeptPage>
  );
}

type Mode = 'view' | 'edit';
type EditDraft = { brand: string; model: string; storage: string; imei: string; purchaseDate: string; orderRef: string; coveredUntil: string; staffNote: string };
const editDraftOf = (d: Device): EditDraft => ({ brand: d.brand, model: d.model, storage: d.storage ?? '', imei: d.imei ?? '', purchaseDate: d.purchaseDate, orderRef: d.orderRef ?? '', coveredUntil: d.coveredUntil ?? '', staffNote: d.staffNote ?? '' });

function DeviceDrawer({ device, canHandle, onClose, onChanged }: { device: Device; canHandle: boolean; onClose: () => void; onChanged: (d: Device, title: string) => void }) {
  const { api } = useApi();
  const [d, setDevice] = useState(device);
  const [mode, setMode] = useState<Mode>('view');
  const [until, setUntil] = useState(device.coveredUntil ?? device.suggestedCoveredUntil);
  const [reason, setReason] = useState('');
  const [staffNote, setStaffNote] = useState(device.staffNote ?? '');
  const [draft, setDraft] = useState<EditDraft>(() => editDraftOf(device));
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const done = (x: Device, title: string) => {
    setDevice(x);
    setUntil(x.coveredUntil ?? x.suggestedCoveredUntil);
    setReason('');
    setStaffNote(x.staffNote ?? '');
    setDraft(editDraftOf(x));
    setError('');
    setFields({});
    setMode('view');
    onChanged(x, title);
  };
  const failed = (e: unknown) => {
    setFields(fieldErrorsOf(e));
    setError(codeOf(e) === 'IMEI_TAKEN' ? 'Another registered device already has this IMEI.' : codeOf(e) === 'ILLEGAL_TRANSITION' ? 'The device changed in the meantime. Close it and open it again.' : errorMessage(e));
  };

  const verify = useMutation({
    mutationFn: () => call(api.POST('/api/admin/services/devices/{id}/verify', { params: { path: { id: d.id } }, body: { coveredUntil: until || null, staffNote: staffNote.trim() || null } })),
    onSuccess: (x) => done(x, `${x.label} verified: covered to ${x.coveredUntil ? date(x.coveredUntil) : '—'}`),
    onError: failed,
  });
  const reject = useMutation({
    mutationFn: () => call(api.POST('/api/admin/services/devices/{id}/reject', { params: { path: { id: d.id } }, body: { reason: reason.trim(), staffNote: staffNote.trim() || null } })),
    onSuccess: (x) => done(x, `${x.label} ${d.status === 'verified' ? 'is no longer verified' : 'rejected'}: the customer was told why`),
    onError: failed,
  });
  const save = useMutation({
    mutationFn: () => {
      const body: DeviceUpdate = {
        brand: draft.brand.trim(),
        model: draft.model.trim(),
        storage: draft.storage.trim() || null,
        ...(draft.imei.replace(/[\s-]/g, '') !== (d.imei ?? '') ? { imei: draft.imei.replace(/[\s-]/g, '') } : {}),
        purchaseDate: draft.purchaseDate,
        orderRef: draft.orderRef.trim() || null,
        ...(d.status === 'verified' && draft.coveredUntil ? { coveredUntil: draft.coveredUntil } : {}),
        staffNote: draft.staffNote.trim() || null,
      };
      return call(api.PATCH('/api/admin/services/devices/{id}', { params: { path: { id: d.id } }, body }));
    },
    onSuccess: (x) => done(x, `${x.label} saved`),
    onError: failed,
  });
  const busy = verify.isPending || reject.isPending || save.isPending;
  const canVerify = d.status !== 'verified';
  const canReject = d.status !== 'rejected';
  const today = dayKey(new Date());

  const runVerify = () => {
    if (!DATE.test(until) || until < d.purchaseDate) return setError(`Pick the end of the cover: on or after the purchase date (${date(d.purchaseDate)}).`);
    verify.mutate();
  };
  const runReject = () => {
    if (!reason.trim()) {
      setError(d.status === 'verified' ? 'Say why the verification is withdrawn: the customer sees it.' : 'Say why the device is rejected: the customer sees it.');
      document.getElementById('dv-reason')?.focus();
      return;
    }
    reject.mutate();
  };
  const editProblems = {
    brand: draft.brand.trim() ? '' : 'Enter the brand.',
    model: draft.model.trim() ? '' : 'Enter the model.',
    imei: /^\d{15}$/.test(draft.imei.replace(/[\s-]/g, '')) ? '' : 'An IMEI has 15 digits.',
    purchaseDate: DATE.test(draft.purchaseDate) && draft.purchaseDate <= today ? '' : 'Pick the purchase date: today or earlier.',
    coveredUntil: d.status === 'verified' && !(DATE.test(draft.coveredUntil) && draft.coveredUntil >= draft.purchaseDate) ? 'The cover ends on or after the purchase date.' : '',
  };
  const runSave = () => {
    const problem = Object.values(editProblems).find(Boolean);
    if (problem) return setError(problem);
    save.mutate();
  };
  const fieldError = (k: keyof typeof editProblems) => (error && editProblems[k]) || fields[k] || undefined;

  return (
    <Drawer
      open
      onClose={onClose}
      className="wide"
      title={`${d.label} · ${d.customerName ?? 'Customer'}`}
      foot={
        canHandle && mode === 'edit' ? (
          <>
            <span className="grow" />
            <Button variant="ghost" size="sm" onClick={() => (setMode('view'), setDraft(editDraftOf(d)), setError(''), setFields({}))}>
              Cancel
            </Button>
            <Button size="sm" onClick={runSave} disabled={busy}>
              {save.isPending ? 'Saving…' : 'Save device'}
            </Button>
          </>
        ) : undefined
      }
    >
      {error && <Alert tone="danger" title={error} />}
      <div className="row gap-2 wrap">
        <StatusBadge status={DEVICE_STATUS[d.status].label} tone={DEVICE_STATUS[d.status].tone} />
        {d.status === 'verified' && d.coveredUntil && <Badge tone={d.covered ? 'success' : undefined}>{coverText(d)}</Badge>}
        <span className="small muted">registered {dateTime(d.createdAt)}</span>
      </div>
      {mode === 'view' ? (
        <>
          <KeyValue
            pairs={[
              ['Device', [d.brand, d.model, d.storage].filter(Boolean).join(' · ')],
              ['IMEI', d.imei ? <span className="mono">{imeiText(d)}</span> : <span><span className="mono">{masked(d)}</span> <span className="xs muted">· the full IMEI needs the registered devices permission</span></span>],
              ['Purchase date', date(d.purchaseDate)],
              ['Marketly order', d.orderRef ? <span className="mono">{d.orderRef}</span> : '—'],
              ['Customer', d.customerName ?? <span className="mono xs">{d.customerId}</span>],
              ['Cover', d.status === 'verified' ? (d.coveredUntil ? `To ${date(d.coveredUntil)}${d.covered ? '' : ' (ended)'}` : '—') : `Not verified · would run to ${date(d.suggestedCoveredUntil)} (purchase + 12 months)`],
              ...(d.verifiedAt ? [['Verified', `${dateTime(d.verifiedAt)}${d.verifiedBy ? ` · ${byLabel(d.verifiedBy)}` : ''}`] as [string, ReactNode]] : []),
              ...(d.rejectReason ? [['Reason given', d.rejectReason] as [string, ReactNode]] : []),
              ['Requests', num(d.requestCount)],
              ...(!canHandle && d.staffNote ? [['Staff note', d.staffNote] as [string, ReactNode]] : []),
            ]}
          />
          <div className="stack gap-2">
            <span className="label">History</span>
            <Timeline events={[...d.history].reverse().map((h, i) => ({ t: DEVICE_STATUS[h.status as DeviceStatus]?.label ?? h.status, d: `${dateTime(h.at)}${h.by ? ` · ${byLabel(h.by)}` : ''}`, state: i === 0 ? 'current' : 'done' }))} />
          </div>
          {canHandle && (
            <>
              {canVerify && (
                <Field label="Covered until" hint={`The end of the post-sale cover; the default is the purchase date plus 12 months (${date(d.suggestedCoveredUntil)})`}>
                  <TextInput id="dv-until" type="date" min={d.purchaseDate} value={until} onChange={(e) => setUntil(e.target.value)} />
                </Field>
              )}
              {canReject && (
                <Field label={d.status === 'verified' ? 'Reason to withdraw the verification' : 'Reason to reject'} optional hint="Needed to reject; the customer sees it, e.g. The receipt doesn’t match this IMEI">
                  <Textarea id="dv-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
              )}
              <Field label="Staff note" optional hint="Only staff see it">
                <Textarea id="dv-snote" rows={2} value={staffNote} onChange={(e) => setStaffNote(e.target.value)} />
              </Field>
              <div className="row gap-2 wrap">
                {canVerify && (
                  <Button size="sm" icon="badge-check" onClick={runVerify} disabled={busy}>
                    {verify.isPending ? 'Working…' : DATE.test(until) ? `Verify · covered to ${monthYear(until)}` : 'Verify'}
                  </Button>
                )}
                {canReject && (
                  <Button variant="danger-soft" size="sm" onClick={runReject} disabled={busy}>
                    {reject.isPending ? 'Working…' : d.status === 'verified' ? 'Withdraw verification' : 'Reject'}
                  </Button>
                )}
                <span className="grow" />
                <Button variant="secondary" size="sm" icon="pencil" onClick={() => (setMode('edit'), setError(''))} disabled={busy}>
                  Edit details
                </Button>
              </div>
            </>
          )}
        </>
      ) : (
        <fieldset className="stack gap-4" disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="grid md2 gap-3">
            <Field label="Brand" error={fieldError('brand')}>
              <TextInput id="dv-brand" value={draft.brand} error={!!fieldError('brand')} onChange={(e) => setDraft({ ...draft, brand: e.target.value })} />
            </Field>
            <Field label="Model" error={fieldError('model')}>
              <TextInput id="dv-model" value={draft.model} error={!!fieldError('model')} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
            </Field>
          </div>
          <div className="grid md2 gap-3">
            <Field label="Storage" optional hint="e.g. 256 GB">
              <TextInput id="dv-storage" value={draft.storage} onChange={(e) => setDraft({ ...draft, storage: e.target.value })} />
            </Field>
            <Field label="IMEI" hint="15 digits; checked when you save" error={fieldError('imei')}>
              <TextInput id="dv-imei" inputMode="numeric" value={draft.imei} error={!!fieldError('imei')} onChange={(e) => setDraft({ ...draft, imei: e.target.value })} />
            </Field>
          </div>
          <div className="grid md2 gap-3">
            <Field label="Purchase date" error={fieldError('purchaseDate')}>
              <TextInput id="dv-pdate" type="date" max={today} value={draft.purchaseDate} error={!!fieldError('purchaseDate')} onChange={(e) => setDraft({ ...draft, purchaseDate: e.target.value })} />
            </Field>
            <Field label="Marketly order ref" optional>
              <TextInput id="dv-oref" value={draft.orderRef} onChange={(e) => setDraft({ ...draft, orderRef: e.target.value })} />
            </Field>
          </div>
          {d.status === 'verified' && (
            <Field label="Covered until" hint="The end of the post-sale cover" error={fieldError('coveredUntil')}>
              <TextInput id="dv-cuntil" type="date" min={draft.purchaseDate} value={draft.coveredUntil} error={!!fieldError('coveredUntil')} onChange={(e) => setDraft({ ...draft, coveredUntil: e.target.value })} />
            </Field>
          )}
          <Field label="Staff note" optional hint="Only staff see it">
            <Textarea id="dv-enote" rows={2} value={draft.staffNote} onChange={(e) => setDraft({ ...draft, staffNote: e.target.value })} />
          </Field>
        </fieldset>
      )}
    </Drawer>
  );
}
