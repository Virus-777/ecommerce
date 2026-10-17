import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { call, errorMessage, newIdempotencyKey, useApi, useUploads } from '@marketly/web-shared/api';
import { Logo, OpsLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Breadcrumbs, Button, Card, Checkbox, Deadline, Dialog, EmptyState, Field, Icon, Img, Meter, Select, SummaryRow, Textarea, TextInput, announce } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines, deadlineLabel, deadlineTone, time } from '@/app/parts';
import { useStaffSession } from '@/app/session';

// Design: pages/ops/ops-pick-pack.html (pick list of the current wave) · view "packing-station" = packing one order
// (?order=<MK ref>; without it, the first picked order).
// API: GET warehouse/waves (current open or picking wave), POST warehouse/waves (create), POST waves/{id}/start,
// POST pick-lines/{id}/pick, POST pick-lines/{id}/report-shortage, POST fulfillments/{id}/report-damage,
// GET warehouse/fulfillments(/{id}), POST fulfillments/{id}/packages, POST packages/{id}/scan, PATCH packages/{id},
// GET packages/{id}/service-options, POST packages/{id}/label (idempotent), GET packages/{id}/label, POST packages/{id}/pack,
// GET warehouse/box-types, GET warehouse/summary (location and carrier pickup), POST fulfillments/{id}/resume (held orders),
// POST packages/{id}/void-label, GET packages/{id}/packing-slip (PDF).

type View = 'packing-station';

interface MediaRef {
  id?: string;
  url: string;
  alt?: string | null;
}
interface DeadlineInfo {
  dueAt: string;
  state: string;
}
interface Line {
  id: string;
  orderItemId: string;
  sku: string;
  label: string;
  image: MediaRef | null;
  quantity: number;
  binCode: string | null;
  picked: number;
  short: number;
  state: 'pending' | 'picked' | 'short' | 'cancelled';
  pickedAt: string | null;
}
interface WaveOrder {
  fulfillmentId: string;
  orderRef: string;
  deadline: DeadlineInfo;
  status: string;
  lines: Line[];
}
interface Wave {
  id: string;
  ref: string;
  status: 'open' | 'picking' | 'completed' | 'cancelled';
  carrierPickupAt: string | null;
  orderCount: number;
  pickedOrderCount: number;
  progressPct: number;
  nextBinCode: string | null;
  alerts: string[];
  orders: WaveOrder[];
}
interface PackageItem {
  orderItemId: string;
  sku: string;
  label: string;
  image: MediaRef | null;
  quantity: number;
  scanned: number;
}
interface Package {
  id: string;
  index: number;
  of: number;
  status: 'open' | 'labelled' | 'packed' | 'dispatched' | 'voided';
  items: PackageItem[];
  allScanned: boolean;
  boxTypeId: string | null;
  suggestedBoxTypeId: string | null;
  weight: { value: number; unit: string } | null;
  fragile: boolean;
  handlingNote: string | null;
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  labelUrl: string | null;
}
interface Fulfillment {
  id: string;
  orderRef: string;
  sellerName: string | null;
  status: string;
  deadline: DeadlineInfo;
  deliveryChoice: string;
  shipTo: { name: string; line1: string; line2?: string | null; city: string; region: string; postalCode: string };
  lines: Line[];
  packages: Package[];
  holdReason: string | null;
  mixedOrderNote: string | null;
  totalPackagesInOrder: number;
}
interface BoxType {
  id: string;
  name: string;
  dimensions: { length: number; width: number; height: number; unit: string };
  active: boolean;
}
interface ServiceOption {
  serviceCode: string;
  carrier: string;
  service: string;
  arrivalLabel: string;
  keepsPromise: boolean;
  matchesCustomerChoice: boolean;
  selected: boolean;
}
interface Summary {
  locationId: string;
  nextCarrierPickupAt: string | null;
}

function Seg({ view, order }: { view: View | ''; order?: string }) {
  return (
    <div className="seg" role="group">
      <Link to={href('ops/pick-pack')} className={cx(view === '' && 'is-active')} aria-current={view === '' ? 'page' : undefined}>
        Pick list
      </Link>
      <Link to={href('ops/pick-pack', 'packing-station', undefined, order ? { order } : undefined)} className={cx(view === 'packing-station' && 'is-active')} aria-current={view === 'packing-station' ? 'page' : undefined}>
        Packing station
      </Link>
    </div>
  );
}

/** Report a damaged item at pick or pack: quantity, note and photos (required by the API). */
function DamageDialog({ target, onClose, onDone }: { target: { fulfillmentId: string; line: Line } | null; onClose: () => void; onDone: (msg: string) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const photos = useUploads('inspection_photo', { max: 4, accept: /^image\// });
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const report = useMutation({
    mutationFn: () => call(api.POST('/api/admin/warehouse/fulfillments/{id}/report-damage', { params: { path: { id: target!.fulfillmentId } }, body: { lineId: target!.line.id, quantity: 1, note: note.trim(), photoIds: photos.assetIds } as never })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['warehouse'] });
      onDone(`Damaged ${target!.line.sku} reported. The order is on hold and Inventory is finding a replacement unit. Do not pack it partly.`);
      onClose();
    },
  });
  const ok = note.trim() && photos.assetIds.length && !photos.uploading;
  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title="Report damaged item"
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setTried(true);
              if (ok) report.mutate();
            }}
            disabled={report.isPending}
          >
            Report damage
          </Button>
        </>
      }
    >
      {report.error && <Alert tone="danger">{errorMessage(report.error)}</Alert>}
      <p className="small sub">
        {target?.line.label} · <span className="mono">{target?.line.sku}</span> · bin <span className="mono">{target?.line.binCode ?? '—'}</span>
      </p>
      <Field label="What’s wrong" error={tried && !note.trim() ? 'Describe the damage.' : undefined}>
        <Textarea id="dmg-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => photos.add(Array.from(e.target.files ?? []))} />
      <Button variant="secondary" size="sm" icon="camera" onClick={() => input.current?.click()}>
        Add photo
      </Button>
      <span className="xs muted">
        {photos.items.length ? `${photos.assetIds.length} of ${photos.items.length} photos ready` : 'At least one photo is required.'} {photos.error}
      </span>
      {tried && !photos.assetIds.length && <span className="error-text">Add a photo of the damage.</span>}
    </Dialog>
  );
}

function PickList() {
  const { api } = useApi();
  const qc = useQueryClient();
  const staff = useStaffSession();
  const [scan, setScan] = useState('');
  const [bin, setBin] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [report, setReport] = useState<{ tone: 'warning' | 'danger'; title: string; body: string } | null>(null);
  const [damage, setDamage] = useState<{ fulfillmentId: string; line: Line } | null>(null);
  const canPick = staff.can('warehouse.picking.perform');
  const canWave = staff.can('warehouse.waves.manage');

  const summary = useQuery({ queryKey: ['warehouse', 'summary'], queryFn: () => call(api.GET('/api/admin/warehouse/summary', { params: { query: {} } })) as Promise<Summary> });
  const wave = useQuery({
    queryKey: ['warehouse', 'wave', 'current'],
    queryFn: async () => {
      const picking = (await call(api.GET('/api/admin/warehouse/waves', { params: { query: { status: 'picking', limit: 1 } } }))) as { items: Wave[] };
      if (picking.items[0]) return picking.items[0];
      const open = (await call(api.GET('/api/admin/warehouse/waves', { params: { query: { status: 'open', limit: 1 } } }))) as { items: Wave[] };
      return open.items[0] ?? null;
    },
  });
  const waiting = useQuery({ queryKey: ['warehouse', 'fulfillments', 'awaiting_pick'], queryFn: () => call(api.GET('/api/admin/warehouse/fulfillments', { params: { query: { status: 'awaiting_pick', limit: 100 } } })) as Promise<{ items: unknown[] }>, enabled: wave.data === null });
  const w = wave.data ?? null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['warehouse'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };
  const create = useMutation({
    mutationFn: () => call(api.POST('/api/admin/warehouse/waves', { body: { locationId: summary.data!.locationId } as never })),
    onSuccess: () => {
      announce('Pick wave created');
      refresh();
    },
  });
  const start = useMutation({
    mutationFn: () => call(api.POST('/api/admin/warehouse/waves/{id}/start', { params: { path: { id: w!.id } } })),
    onSuccess: refresh,
  });
  const pick = useMutation({
    mutationFn: (v: { line: Line; ref: string; binCode: string; itemCode: string }) => call(api.POST('/api/admin/warehouse/pick-lines/{id}/pick', { params: { path: { id: v.line.id } }, body: { binCode: v.binCode, itemCode: v.itemCode, quantity: 1 } })),
    onSuccess: (_r, v) => {
      const n = v.line.picked + 1;
      const text = n >= v.line.quantity ? `${v.line.sku} picked for ${v.ref}` : `${v.line.sku}: ${n} of ${v.line.quantity} picked. Scan the next unit.`;
      setMsg({ ok: true, text });
      setBin('');
      announce(text);
      refresh();
    },
    onError: (e) => setMsg({ ok: false, text: errorMessage(e) }),
  });
  const shortage = useMutation({
    mutationFn: (v: { line: Line; ref: string }) => call(api.POST('/api/admin/warehouse/pick-lines/{id}/report-shortage', { params: { path: { id: v.line.id } }, body: { quantityFound: v.line.picked } as never })),
    onSuccess: (_r, v) => {
      const r = { tone: 'warning' as const, title: `Shortage reported on ${v.ref}`, body: `Bin ${v.line.binCode ?? '—'} was short for ${v.line.sku}. Inventory is checking stock. The order stays in the wave; do not pack it partly.` };
      setReport(r);
      announce(r.title);
      refresh();
    },
    onError: (e) => setMsg({ ok: false, text: errorMessage(e) }),
  });

  const orders = w?.orders ?? [];
  const next = (() => {
    if (w?.status !== 'picking') return null;
    for (const o of orders) for (const l of o.lines) if (l.state === 'pending') return { order: o, line: l };
    return null;
  })();

  const onScan = (e: FormEvent) => {
    e.preventDefault();
    const code = scan.trim().toUpperCase();
    setScan('');
    if (!code || !w || w.status !== 'picking') return;
    const open = orders.flatMap((o) => o.lines.filter((l) => l.state === 'pending').map((l) => ({ o, l })));
    const binHit = open.find((c) => (c.l.binCode ?? '').toUpperCase() === code);
    if (binHit && !open.some((c) => c.l.sku.toUpperCase() === code)) {
      setBin(code);
      const text = `Bin ${code} confirmed. Scan the item.`;
      setMsg({ ok: true, text });
      announce(text);
      return;
    }
    // An item barcode: prefer the next line, then any open line with this SKU (in the scanned bin when one was scanned).
    const hit =
      open.find((c) => c.l.id === next?.line.id && c.l.sku.toUpperCase() === code) ??
      open.find((c) => c.l.sku.toUpperCase() === code && (!bin || (c.l.binCode ?? '').toUpperCase() === bin)) ??
      open.find((c) => c.l.sku.toUpperCase() === code);
    if (!hit) {
      const text = `${code} is not an open pick in ${w.ref}. Check the bin and scan again.`;
      setMsg({ ok: false, text });
      announce(text);
      return;
    }
    pick.mutate({ line: hit.l, ref: hit.o.orderRef, binCode: bin || hit.l.binCode || '', itemCode: code });
  };

  const problemLine = (o: WaveOrder) => o.lines.find((l) => l.state === 'pending') ?? o.lines.find((l) => l.state === 'picked');

  const header = (
    <div className="page-head">
      <div className="t">
        <h1 className="h1">Pick and pack</h1>
        <p className="sub small">
          {w ? `${w.ref} · ${w.orderCount} Official Store ${w.orderCount === 1 ? 'order' : 'orders'}${w.carrierPickupAt ? ` · carrier pickup ${time(w.carrierPickupAt)}` : ''}` : 'Official Store orders'} · marketplace sellers pack their own orders
        </p>
      </div>
      <div className="actions">
        <Seg view="" />
      </div>
    </div>
  );

  if (wave.isPending) {
    return (
      <>
        {header}
        <SkeletonLines rows={6} />
      </>
    );
  }
  if (wave.error) {
    return (
      <>
        {header}
        <LoadError error={wave.error} onRetry={() => void wave.refetch()} />
      </>
    );
  }
  if (!w) {
    const n = waiting.data?.items.length ?? 0;
    return (
      <>
        {header}
        {create.error && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
        <EmptyState
          icon="package-check"
          title="No wave to pick"
          as="h2"
          action={
            canWave && n > 0 ? (
              <Button icon="plus" onClick={() => create.mutate()} disabled={create.isPending || !summary.data}>
                Create a wave
              </Button>
            ) : undefined
          }
        >
          {waiting.isPending ? 'Checking orders waiting to be picked…' : n ? `${n} ${n === 1 ? 'order is' : 'orders are'} waiting to be picked${summary.data?.nextCarrierPickupAt ? ` before the ${time(summary.data.nextCarrierPickupAt)} pickup` : ''}.${canWave ? '' : ' A Warehouse Manager creates the next wave.'}` : 'Every Official Store order is picked.'}
        </EmptyState>
      </>
    );
  }

  return (
    <>
      {header}
      {w.status === 'open' ? (
        <Alert tone="info" title={`${w.ref} is ready to pick`}>
          {canPick ? (
            <Button size="sm" icon="play" onClick={() => start.mutate()} disabled={start.isPending}>
              Start picking
            </Button>
          ) : (
            'Warehouse staff with picking access start the wave.'
          )}
          {start.error && <span className="xs t-danger-text"> {errorMessage(start.error)}</span>}
        </Alert>
      ) : (
        <form onSubmit={onScan}>
          <label className="ac-scan" htmlFor="pp-scan">
            <Icon name="scan-barcode" className="ic-lg" />
            <span className="sr-only">Scan bin or item barcode</span>
            <input id="pp-scan" type="text" placeholder="Scan bin or item barcode" autoComplete="off" value={scan} disabled={!canPick || pick.isPending} onChange={(e) => setScan(e.target.value)} />
          </label>
        </form>
      )}
      {msg && (
        <p className={cx('xs strong row gap-1', msg.ok ? 't-success-text' : 't-danger-text')} role="status">
          <Icon name={msg.ok ? 'circle-check' : 'circle-alert'} className="ic-sm" />
          {msg.text}
        </p>
      )}
      <div className="stack gap-2">
        <div className="row between small">
          <span className="strong">
            {w.pickedOrderCount} of {w.orderCount} orders picked
          </span>
          {(next?.line.binCode ?? w.nextBinCode) && (
            <span className="muted">
              Next bin <b className="mono">{next?.line.binCode ?? w.nextBinCode}</b>
            </span>
          )}
        </div>
        <Meter pct={w.progressPct} label={`${w.pickedOrderCount} of ${w.orderCount} orders picked`} />
      </div>
      {report ? (
        <Alert tone={report.tone} title={report.title}>
          {report.body}
        </Alert>
      ) : (
        w.alerts.map((a) => <Alert key={a} tone="warning" title={a} />)
      )}
      <div className="grid lg2 gap-4">
        {orders.map((o) => {
          const n = o.lines.length;
          const picked = o.lines.filter((i) => i.state === 'picked').length;
          const pl = problemLine(o);
          return (
            <section key={o.fulfillmentId} className="card">
              <div className="card-head">
                <div className="stack gap-0">
                  <Link className="mono strong" to={href('ops/pick-pack', 'packing-station', undefined, { order: o.orderRef })}>
                    {o.orderRef}
                  </Link>
                  <span className="xs muted">
                    {n} {n === 1 ? 'item' : 'items'} · {picked} picked
                  </span>
                </div>
                <Deadline tone={deadlineTone(o.deadline.state)}>{deadlineLabel(o.deadline.dueAt, 'Ship by')}</Deadline>
              </div>
              <div className="card-body ac-hand u-g-0">
                {o.lines.map((it) => {
                  const isNext = next?.line.id === it.id;
                  return (
                    <div key={it.id} className={cx('ac-pick', it.state === 'picked' && 'is-done', it.state === 'short' && 'is-short', isNext && 'is-next')}>
                      <span className="ac-bin">{it.binCode ?? '—'}</span>
                      <span className="stack gap-0 grow">
                        <span className="small strong">{it.label}</span>
                        <span className="xs mono muted">{it.sku}</span>
                        {it.state === 'picked' && (
                          <span className="xs t-success-text strong row gap-1">
                            <Icon name="circle-check" className="ic-sm" />
                            Picked {it.pickedAt ? time(it.pickedAt) : ''}
                          </span>
                        )}
                        {it.state === 'short' && (
                          <span className="xs t-warning-text strong row gap-1">
                            <Icon name="triangle-alert" className="ic-sm" />
                            Shortage reported
                          </span>
                        )}
                        {isNext && <span className="t-brand-text strong small">{it.picked > 0 ? `Scan unit ${it.picked + 1} of ${it.quantity}` : 'Scan this item next'}</span>}
                      </span>
                      <span className="q" aria-label={`Quantity ${it.quantity}`}>
                        ×{it.quantity}
                      </span>
                    </div>
                  );
                })}
              </div>
              {canPick && w.status === 'picking' && pl && (
                <div className="card-foot">
                  <Button variant="ghost" size="sm" icon="package-x" onClick={() => pl.state === 'pending' && shortage.mutate({ line: pl, ref: o.orderRef })} disabled={pl.state !== 'pending' || shortage.isPending}>
                    Report shortage
                  </Button>
                  <Button variant="ghost" size="sm" icon="circle-alert" onClick={() => setDamage({ fulfillmentId: o.fulfillmentId, line: pl })}>
                    Report damaged item
                  </Button>
                </div>
              )}
            </section>
          );
        })}
      </div>
      {canPick && w.status === 'picking' && (
        <div className="ac-handbar only-phone">
          <Button variant="secondary" icon="flag" disabled={!next} onClick={() => next && shortage.mutate({ line: next.line, ref: next.order.orderRef })}>
            Report problem
          </Button>
          <Button icon="check" disabled={!next || pick.isPending} onClick={() => next && pick.mutate({ line: next.line, ref: next.order.orderRef, binCode: next.line.binCode ?? '', itemCode: next.line.sku })}>
            Confirm pick
          </Button>
        </div>
      )}
      <DamageDialog
        target={damage}
        onClose={() => setDamage(null)}
        onDone={(text) => {
          setReport({ tone: 'danger', title: 'Damaged item reported', body: text });
          announce('Damaged item reported');
        }}
      />
    </>
  );
}

function PackingStation({ orderRef }: { orderRef: string }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const staff = useStaffSession();
  const canPack = staff.can('warehouse.packing.perform');
  const [scan, setScan] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [box, setBox] = useState('');
  const [weight, setWeight] = useState('');
  const [service, setService] = useState('');
  const [fragile, setFragile] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [damage, setDamage] = useState<{ fulfillmentId: string; line: Line } | null>(null);
  const [tried, setTried] = useState(false);
  // One Idempotency-Key per package: the server scopes a key to the operation and hashes the path, so reusing one
  // key for package 2 is refused (IDEMPOTENCY_KEY_REUSED). A retry of the same package keeps its key, so a label
  // bought by a request whose answer got lost is replayed, not bought twice. Voiding a label drops the key.
  const labelKeys = useRef(new Map<string, string>());
  const labelKeyFor = (packageId: string) => {
    let k = labelKeys.current.get(packageId);
    if (!k) {
      k = newIdempotencyKey();
      labelKeys.current.set(packageId, k);
    }
    return k;
  };
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voidTried, setVoidTried] = useState(false);
  const canResume = staff.can('warehouse.waves.manage');

  const found = useQuery({
    queryKey: ['warehouse', 'fulfillment', 'find', orderRef],
    queryFn: async () => {
      if (orderRef) {
        const r = (await call(api.GET('/api/admin/warehouse/fulfillments', { params: { query: { q: orderRef, limit: 5 } } }))) as { items: Array<{ id: string; orderRef: string }> };
        return r.items.find((f) => f.orderRef.toUpperCase() === orderRef.toUpperCase())?.id ?? null;
      }
      for (const status of ['packing', 'picked'] as const) {
        const r = (await call(api.GET('/api/admin/warehouse/fulfillments', { params: { query: { status, limit: 1 } } }))) as { items: Array<{ id: string }> };
        if (r.items[0]) return r.items[0].id;
      }
      return null;
    },
  });
  const fid = found.data ?? null;
  const ful = useQuery({ queryKey: ['warehouse', 'fulfillment', fid], queryFn: () => call(api.GET('/api/admin/warehouse/fulfillments/{id}', { params: { path: { id: fid! } } })) as Promise<Fulfillment>, enabled: !!fid });
  const boxes = useQuery({ queryKey: ['warehouse', 'box-types'], queryFn: () => call(api.GET('/api/admin/warehouse/box-types')) as Promise<BoxType[]> });
  const f = ful.data;
  const pkg = f?.packages.find((p) => p.status === 'open' || p.status === 'labelled') ?? f?.packages.find((p) => p.status === 'packed' || p.status === 'dispatched');
  const options = useQuery({ queryKey: ['warehouse', 'service-options', pkg?.id], queryFn: () => call(api.GET('/api/admin/warehouse/packages/{id}/service-options', { params: { path: { id: pkg!.id } } })) as Promise<ServiceOption[]>, enabled: !!pkg && pkg.status === 'open' });

  useEffect(() => {
    if (!pkg) return;
    setBox((b) => b || pkg.boxTypeId || pkg.suggestedBoxTypeId || '');
    setWeight((w) => w || (pkg.weight ? String(pkg.weight.value) : ''));
    setFragile(pkg.fragile);
  }, [pkg?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const sel = options.data?.find((o) => o.selected) ?? options.data?.find((o) => o.matchesCustomerChoice && o.keepsPromise);
    if (sel) setService((s) => s || sel.serviceCode);
  }, [options.data]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['warehouse'] });
  const openPkg = useMutation({ mutationFn: () => call(api.POST('/api/admin/warehouse/fulfillments/{id}/packages', { params: { path: { id: f!.id } }, body: { station: '2' } as never })), onSuccess: refresh });
  const scanItem = useMutation({
    mutationFn: (code: string) => call(api.POST('/api/admin/warehouse/packages/{id}/scan', { params: { path: { id: pkg!.id } }, body: { code } })) as Promise<Package>,
    onSuccess: (p, code) => {
      const done = p.items.reduce((a, i) => a + Math.min(i.scanned, i.quantity), 0);
      const total = p.items.reduce((a, i) => a + i.quantity, 0);
      const text = `${code} scanned. ${done} of ${total} items confirmed.`;
      setMsg({ ok: true, text });
      announce(text);
      refresh();
    },
    onError: (e) => setMsg({ ok: false, text: errorMessage(e) }),
  });
  const weightOk = Number(weight) > 0;
  const pack = useMutation({
    mutationFn: async () => {
      let p = pkg!;
      if (p.status === 'open') {
        await call(api.PATCH('/api/admin/warehouse/packages/{id}', { params: { path: { id: p.id } }, body: { boxTypeId: box || undefined, weight: { value: Number(weight), unit: 'lb', fromScale: true }, fragile, serviceCode: service || undefined } as never }));
        const label = (await call(api.POST('/api/admin/warehouse/packages/{id}/label', { params: { path: { id: p.id }, header: { 'Idempotency-Key': labelKeyFor(p.id) } }, body: { printer: 'PS-2' } as never } as never))) as { package: Package };
        p = label.package;
      }
      return call(api.POST('/api/admin/warehouse/packages/{id}/pack', { params: { path: { id: p.id } } }));
    },
    onSuccess: () => {
      announce(`${f!.orderRef} packed`);
      refresh();
      void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
    },
    // The label may have been bought before a later step failed: reload so the next try starts from the package's real state.
    onError: refresh,
  });
  const reprint = useMutation({
    mutationFn: () => call(api.GET('/api/admin/warehouse/packages/{id}/label', { params: { path: { id: pkg!.id } } })) as Promise<{ url: string }>,
    onSuccess: (l) => window.open(l.url, '_blank', 'noopener'),
  });
  // Held order: back to picking once Inventory resolved the shortage or damage (409 DISCREPANCY_OPEN until then).
  const resume = useMutation({
    mutationFn: () => call(api.POST('/api/admin/warehouse/fulfillments/{id}/resume', { params: { path: { id: f!.id } }, body: {} })),
    onSuccess: () => {
      announce(`${f!.orderRef} resumed`);
      refresh();
      void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
    },
  });
  // Wrong service or bad print: void the label while the package is still open on the bench (labelled, not packed).
  const voidLabel = useMutation({
    mutationFn: () => call(api.POST('/api/admin/warehouse/packages/{id}/void-label', { params: { path: { id: pkg!.id } }, body: { reason: voidReason.trim() } })),
    onSuccess: () => {
      // the package is open again: its next label is a new purchase, so it needs a new key
      labelKeys.current.delete(pkg!.id);
      setVoidOpen(false);
      announce('Label voided. Choose the service and mark the package packed to buy a new label.');
      refresh();
    },
  });
  // The packing slip as a PDF from the server: only this package's items, package n of N, the returns note.
  const slip = useMutation({
    mutationFn: () => call(api.GET('/api/admin/warehouse/packages/{id}/packing-slip', { params: { path: { id: pkg!.id } } })) as Promise<{ url: string }>,
    onSuccess: (l) => window.open(l.url, '_blank', 'noopener'),
  });

  const head = (sub: string) => (
    <div className="page-head">
      <div className="t">
        <Breadcrumbs items={[{ label: 'Pick and pack', to: href('ops/pick-pack') }, { label: f?.orderRef ?? (orderRef || 'Packing station') }]} />
        <h1 className="h1">Packing station 2</h1>
        <p className="sub small">{sub}</p>
      </div>
      <div className="actions">
        <Seg view="packing-station" order={f?.orderRef ?? orderRef} />
      </div>
    </div>
  );

  if (found.isPending || (fid && ful.isPending)) {
    return (
      <>
        {head('Loading the order…')}
        <SkeletonLines rows={6} />
      </>
    );
  }
  const err = found.error ?? ful.error;
  if (err) {
    return (
      <>
        {head('Official Store items only')}
        <LoadError error={err} onRetry={() => void (found.error ? found.refetch() : ful.refetch())} />
      </>
    );
  }
  if (!f) {
    return (
      <>
        {head('Official Store items only')}
        <EmptyState icon="package" title={orderRef ? 'Order not found' : 'Nothing to pack'} as="h2" action={<Button to={href('ops/pick-pack')}>Back to the pick list</Button>}>
          {orderRef ? `${orderRef} isn’t an Official Store order in the warehouse.` : 'No picked orders are waiting at the packing station.'}
        </EmptyState>
      </>
    );
  }

  const items = pkg?.items ?? f.lines.filter((l) => l.state !== 'cancelled').map((l) => ({ orderItemId: l.orderItemId, sku: l.sku, label: l.label, image: l.image, quantity: l.quantity, scanned: 0 }));
  const nScanned = items.filter((i) => i.scanned >= i.quantity).length;
  const allScanned = !!pkg && pkg.allScanned;
  const packed = pkg?.status === 'packed' || pkg?.status === 'dispatched';
  const editable = canPack && pkg?.status === 'open';
  const sub = `Order ${f.orderRef}${pkg ? ` · Package ${pkg.index} of ${pkg.of}` : ''} · ${f.sellerName ? `Sold by ${f.sellerName} · Fulfilled by Marketly` : 'Official Store items only'}`;
  const svc = options.data?.find((o) => o.serviceCode === service);

  const onScan = (e: FormEvent) => {
    e.preventDefault();
    const code = scan.trim().toUpperCase();
    setScan('');
    if (!code || !pkg) return;
    scanItem.mutate(code);
  };
  const markPacked = () => {
    setTried(true);
    if (!allScanned || (pkg?.status === 'open' && !weightOk) || problem) return;
    pack.mutate();
  };
  const shortLine = () => f.lines.find((l) => !items.find((i) => i.orderItemId === l.orderItemId && i.scanned >= i.quantity)) ?? f.lines[0];

  return (
    <>
      {head(sub)}
      {!pkg && f.status !== 'on_hold' && (
        <Alert tone="info" title={f.status === 'picked' || f.status === 'packing' ? 'Ready to pack' : `This order is ${f.status.replace(/_/g, ' ')}`}>
          {canPack && (f.status === 'picked' || f.status === 'packing') ? (
            <Button size="sm" icon="package" onClick={() => openPkg.mutate()} disabled={openPkg.isPending}>
              Start packing
            </Button>
          ) : (
            'Packing starts once every item is picked.'
          )}
          {openPkg.error && <span className="xs t-danger-text"> {errorMessage(openPkg.error)}</span>}
        </Alert>
      )}
      {(f.holdReason || f.status === 'on_hold') && (
        <Alert tone="warning" title="On hold">
          {f.holdReason ?? 'A shortage or damaged item was reported.'}
          {f.status === 'on_hold' && (
            <>
              {' '}
              {canResume ? (
                <Button size="sm" icon="play" onClick={() => resume.mutate()} disabled={resume.isPending}>
                  {resume.isPending ? 'Resuming…' : 'Resume'}
                </Button>
              ) : (
                'A Warehouse Manager resumes it once Inventory has resolved the report.'
              )}
              {resume.error && <span className="xs t-danger-text"> {errorMessage(resume.error)}</span>}
            </>
          )}
        </Alert>
      )}
      {pkg && (
        <form onSubmit={onScan}>
          <label className="ac-scan" htmlFor="pk-scan">
            <Icon name="scan-barcode" className="ic-lg" />
            <span className="sr-only">Scan item to confirm</span>
            <input id="pk-scan" type="text" placeholder="Scan each item to confirm" autoComplete="off" value={scan} disabled={!editable || scanItem.isPending} onChange={(e) => setScan(e.target.value)} />
          </label>
        </form>
      )}
      {msg && (
        <p className={cx('xs strong row gap-1', msg.ok ? 't-success-text' : 't-danger-text')} role="status">
          <Icon name={msg.ok ? 'circle-check' : 'circle-alert'} className="ic-sm" />
          {msg.text}
        </p>
      )}
      {packed ? (
        <Alert tone="success" title={`${f.orderRef} packed`}>
          Package {pkg!.index} of {pkg!.of} goes out with the next carrier pickup.{pkg!.trackingNumber && <> Tracking <span className="mono">{pkg!.trackingNumber}</span> is on the order.</>} <Link to={href('ops/pick-pack')}>Back to the pick list</Link>
        </Alert>
      ) : (
        f.mixedOrderNote && (
          <Alert tone="info" title="Mixed order">
            {f.mixedOrderNote} Your packing slip lists only this package’s items.
          </Alert>
        )
      )}
      {pack.error && <Alert tone="danger">{errorMessage(pack.error)}</Alert>}
      {problem && <Alert tone="warning" title="Problem reported">{problem}</Alert>}
      <div className="ac-main">
        <div className="stack gap-5">
          <Card
            title="Items to pack"
            sub={`${nScanned} of ${items.length} scanned`}
            foot={
              canPack ? (
                <Button variant="ghost" size="sm" icon="circle-alert" onClick={() => setDamage({ fulfillmentId: f.id, line: shortLine() })} disabled={packed}>
                  Report damaged item
                </Button>
              ) : undefined
            }
          >
            <div className="ac-hand u-d-flex u-fd-column">
              {items.map((it) => (
                <div key={it.orderItemId} className="ac-pick">
                  <Img icon="package" src={it.image?.url} alt={it.image?.alt ?? ''} className="thumb" />
                  <span className="stack gap-0 grow">
                    <span className="small strong">{it.label}</span>
                    <span className="xs mono muted">{it.sku}</span>
                    {it.scanned >= it.quantity ? (
                      <span className="xs t-success-text strong row gap-1">
                        <Icon name="circle-check" className="ic-sm" />
                        Scanned
                      </span>
                    ) : (
                      <span className="t-brand-text strong small">{it.scanned ? `Scan unit ${it.scanned + 1} of ${it.quantity}` : 'Scan to confirm'}</span>
                    )}
                  </span>
                  <span className="q">×{it.quantity}</span>
                </div>
              ))}
            </div>
            {tried && !allScanned && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                Scan every item before you mark the package as packed.
              </span>
            )}
          </Card>
          <Card title="Package" titleAs="h3">
            <div className="ac-fgrid">
              <Field label="Box size" hint="Suggested from item dimensions">
                <Select
                  id="pk-box"
                  options={[{ value: '', label: 'Choose a box' }, ...(boxes.data ?? []).filter((b) => b.active).map((b) => ({ value: b.id, label: `${b.name} · ${b.dimensions.length} × ${b.dimensions.width} × ${b.dimensions.height} ${b.dimensions.unit}` }))]}
                  value={box}
                  disabled={!editable}
                  onChange={(e) => setBox(e.target.value)}
                />
              </Field>
              <Field label="Weight" error={tried && editable && !weightOk ? 'Weigh the package. The weight prints on the label.' : undefined}>
                <TextInput id="pk-wt" value={weight} suffix="lb · from scale" inputMode="decimal" error={tried && editable && !weightOk} disabled={!editable} onChange={(e) => setWeight(e.target.value)} />
              </Field>
              <Field label="Carrier service" hint="Matches the delivery option the customer chose">
                <Select
                  id="pk-svc"
                  options={
                    options.data?.length
                      ? options.data.map((o) => ({ value: o.serviceCode, label: `${o.carrier} ${o.service} · ${o.arrivalLabel}${o.keepsPromise ? '' : ' (breaks the promise)'}` }))
                      : [{ value: '', label: pkg?.service ? `${pkg.carrier ?? ''} ${pkg.service}`.trim() : f.deliveryChoice }]
                  }
                  value={service}
                  disabled={!editable}
                  onChange={(e) => setService(e.target.value)}
                />
              </Field>
              <Field label="Tracking number" hint="Created with the label">
                <TextInput id="pk-trk" value={pkg?.trackingNumber ?? ''} placeholder="Not created yet" readOnly />
              </Field>
            </div>
            <Checkbox id="pk-fragile" label="Fragile: use paper fill" checked={fragile} disabled={!editable} onChange={(e) => setFragile(e.target.checked)} />
          </Card>
        </div>
        <div className="stack gap-5">
          <Card
            title="Packing slip"
            titleAs="h3"
            actions={
              // With a package, print the server's PDF slip (what goes in the box); before that, the preview below.
              <Button variant="ghost" size="sm" icon="printer" onClick={() => (pkg ? slip.mutate() : window.print())} disabled={slip.isPending}>
                Print
              </Button>
            }
          >
            {slip.error && <span className="xs t-danger-text">{errorMessage(slip.error)}</span>}
            <div className="ac-slip">
              <div className="row between">
                <Logo />
                <span className="xs mono">{f.orderRef}</span>
              </div>
              <span className="xs muted">
                {pkg ? `Package ${pkg.index} of ${pkg.of}` : `${f.totalPackagesInOrder} ${f.totalPackagesInOrder === 1 ? 'package' : 'packages'} in this order`} · {f.sellerName ? `Sold by ${f.sellerName} · Fulfilled by Marketly` : 'Sold and shipped by Marketly Official'}
              </span>
              <div className="stack gap-1">
                <span className="small strong">Ship to</span>
                <span className="small">
                  {f.shipTo.name}
                  <br />
                  {f.shipTo.line1}
                  {f.shipTo.line2 ? `, ${f.shipTo.line2}` : ''}
                  <br />
                  {f.shipTo.city}, {f.shipTo.region} {f.shipTo.postalCode}
                </span>
              </div>
              <div className="divider" />
              {items.map((it) => (
                <SummaryRow key={it.orderItemId} k={it.label} v={it.quantity} />
              ))}
              <div className="divider" />
              <span className="xs sub">Returns: start a return from your order page.{f.mixedOrderNote ? ' Other packages ship separately.' : ''}</span>
            </div>
          </Card>
          <Card
            title="Carrier label"
            titleAs="h3"
            foot={
              canPack ? (
                <>
                  <Button variant="ghost" size="sm" icon="printer" onClick={() => reprint.mutate()} disabled={!pkg?.trackingNumber || reprint.isPending}>
                    Reprint label
                  </Button>
                  {pkg?.status === 'labelled' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="circle-x"
                      onClick={() => {
                        voidLabel.reset();
                        setVoidReason('');
                        setVoidTried(false);
                        setVoidOpen(true);
                      }}
                    >
                      Void label
                    </Button>
                  )}
                  <Button size="sm" icon="package-check" onClick={markPacked} disabled={!pkg || packed || pack.isPending}>
                    {packed ? 'Packed' : pack.isPending ? 'Packing…' : 'Mark as packed'}
                  </Button>
                </>
              ) : (
                <span className="xs muted">Packing needs warehouse packing access.</span>
              )
            }
          >
            <div className="row gap-3 nowrap">
              <Img icon="barcode" tint="1" className="thumb" />
              <span className="stack gap-0">
                <span className="small strong">{pkg?.service ? `${pkg.carrier ?? ''} ${pkg.service}`.trim() : svc ? `${svc.carrier} ${svc.service}` : f.deliveryChoice}</span>
                <span className="xs mono">{pkg?.trackingNumber ?? 'Label is bought when you mark the package packed'}</span>
                <span className="xs muted">4x6 label · printer PS-2</span>
              </span>
            </div>
            {reprint.error && <span className="xs t-danger-text">{errorMessage(reprint.error)}</span>}
          </Card>
        </div>
      </div>
      {canPack && (
        <div className="ac-handbar only-phone">
          <Button variant="secondary" icon="printer" onClick={() => reprint.mutate()} disabled={!pkg?.trackingNumber}>
            Print label
          </Button>
          <Button icon="package-check" onClick={markPacked} disabled={!pkg || packed || pack.isPending}>
            {packed ? 'Packed' : 'Mark as packed'}
          </Button>
        </div>
      )}
      <DamageDialog target={damage} onClose={() => setDamage(null)} onDone={setProblem} />
      <Dialog
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        title="Void label"
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setVoidOpen(false)}>
              Keep label
            </Button>
            <Button
              variant="danger"
              icon="circle-x"
              onClick={() => {
                setVoidTried(true);
                if (voidReason.trim()) voidLabel.mutate();
              }}
              disabled={voidLabel.isPending}
            >
              Void label
            </Button>
          </>
        }
      >
        {voidLabel.error && <Alert tone="danger">{errorMessage(voidLabel.error)}</Alert>}
        <p className="small">
          {pkg?.carrier} {pkg?.service} · tracking <span className="mono">{pkg?.trackingNumber ?? '—'}</span>. The package opens again so you can choose another service and buy a new label. Throw the old label away.
        </p>
        <Field label="Why is the label voided?" error={voidTried && !voidReason.trim() ? 'Say why the label is voided.' : undefined}>
          <Textarea id="pk-void" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}

export default function PickPack() {
  const [view] = useView<View>();
  const [params] = useSearchParams();
  const order = params.get('order') ?? '';
  return <OpsLayout active="pick-pack">{view === 'packing-station' ? <PackingStation key={order} orderRef={order} /> : <PickList />}</OpsLayout>;
}
