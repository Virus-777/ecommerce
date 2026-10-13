import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Card, Checkbox, Dialog, Field, Icon, KeyValue, LogoTile, PageHeader, Select, StatusBadge, Switch, TableWrap, Tabs, Textarea, TextInput, announce } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, date } from '@/app/parts';
import { isStepUpCancel, stepUpHeader, useStepUp } from './data/step-up';
import { isoDay, useDebounced } from './data/seller';
import {
  NOTICE_AUDIENCE, NOTICE_DELAYS, NOTICE_PLACES, NOTICE_TYPES, STATUS_LABEL, ago, clock, dayRange, effectLabel, lb, parseArea, priceAt, whenLabel,
  type Carrier, type FreeShippingRule, type NoticeInput, type NoticeKind, type ServiceNotice, type ShippingProfile, type Zone,
} from './data/shipping';

// Design: pages/admin/admin-shipping.html · view "add-service-notice" = the add notice dialog.
// Data: GET /api/admin/shipping/summary (owner, live notices, exception counts), /carriers (services, tracking,
// on-time), /methods (customer labels), /profiles (Official Store rates), /zones, /dispatch-targets, /notices,
// /free-shipping-rules; GET /api/admin/sellers/performance-targets (reply target).
// Writes: PATCH /carriers/{id}/services/{serviceId} (enable/disable), POST /notices (+ /{id}/publish),
// POST /notices/preview (checkout preview in the dialog).

type Section = 'carriers' | 'destinations' | 'dispatch' | 'calendar' | 'free';
const SECTIONS: Array<{ value: Section; label: string }> = [
  { value: 'carriers', label: 'Carriers and methods' },
  { value: 'destinations', label: 'Destinations' },
  { value: 'dispatch', label: 'Dispatch targets' },
  { value: 'calendar', label: 'Calendar and notices' },
  { value: 'free', label: 'Free shipping' },
];
const sectionId = (s: Section) => `aa-sh-${s}`;

interface NoticeDraft {
  title: string;
  type: NoticeKind;
  carrier: string;
  area: string;
  from: string;
  until: string;
  delay: string;
  audience: 'all' | 'official' | 'marketplace';
  message: string;
  places: Record<string, boolean>;
}
const ALL_PLACES = Object.fromEntries(NOTICE_PLACES.map((p) => [p.id, true]));
const blank = (): NoticeDraft => ({ title: '', type: 'disruption', carrier: 'all', area: '', from: isoDay(0), until: isoDay(3), delay: '1', audience: 'all', message: '', places: ALL_PLACES });
const MSG_MAX = 200;

function validate(d: NoticeDraft, zones: Zone[]) {
  const e: Partial<Record<keyof NoticeDraft, string>> = {};
  if (!d.title.trim()) e.title = 'Enter a notice title.';
  const area = parseArea(d.area, zones);
  if (!d.area.trim()) e.area = 'Enter the affected area: ZIP prefixes, states or zones.';
  else if (area.unknown.length) e.area = `We don’t recognise ${area.unknown.join(', ')}. Use ZIP prefixes (956), state codes (CA) or zone names.`;
  if (!d.from) e.from = 'Enter a start date.';
  if (!d.until) e.until = 'Enter an end date.';
  else if (d.from && d.until < d.from) e.until = 'The end date must be on or after the start date.';
  if (!d.message.trim()) e.message = 'Write the message customers see.';
  else if (d.message.length >= MSG_MAX) e.message = `Keep the message under ${MSG_MAX} characters (${d.message.length} now).`;
  if (!Object.values(d.places).some(Boolean)) e.places = 'Choose at least one place to show the notice.';
  return e;
}

/** Carrier select: "all", "c:<code>" (every service of a carrier) or "s:<serviceId>" (one service). */
function carrierOptions(carriers: Carrier[]) {
  return [
    { value: 'all', label: 'All carriers' },
    ...carriers.flatMap((c) => [
      { value: `c:${c.code}`, label: `${c.name} · all services` },
      ...c.services.filter((s) => s.enabled).map((s) => ({ value: `s:${s.id}`, label: `${s.name} only` })),
    ]),
  ];
}

function toInput(d: NoticeDraft, carriers: Carrier[], zones: Zone[]): NoticeInput {
  const area = parseArea(d.area, zones);
  const service = d.carrier.startsWith('s:') ? d.carrier.slice(2) : '';
  const carrierCode = d.carrier.startsWith('c:') ? d.carrier.slice(2) : service ? (carriers.find((c) => c.services.some((s) => s.id === service))?.code ?? '') : '';
  return {
    title: d.title.trim(),
    kind: d.type,
    from: d.from,
    to: d.until,
    carrierCodes: carrierCode ? [carrierCode] : [],
    carrierServiceIds: service ? [service] : [],
    regions: area.regions,
    postalPrefixes: area.postalPrefixes,
    zoneIds: area.zoneIds,
    sellerScope: d.audience,
    effect: NOTICE_DELAYS.find((x) => x.value === d.delay)!.effect,
    customerMessage: d.message.trim(),
    surfaces: NOTICE_PLACES.filter((p) => d.places[p.id]).map((p) => p.surface),
  };
}

interface Estimate {
  carrierService?: string;
  methodName?: string;
  arrivalLabel?: string;
  changed?: boolean;
}

export default function Shipping() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const stepUp = useStepUp();
  const [view, setView] = useView<'add-service-notice'>();
  const [section, setSection] = useState<Section>('carriers');
  const [flash, setFlash] = useState('');
  const [draft, setDraft] = useState<NoticeDraft>(blank);
  const [tried, setTried] = useState(false);
  const canManage = can('shipping.settings.manage');
  const canNotices = can('shipping.notices.manage');

  const get = <T,>(key: string, fn: () => Promise<T>) => ({ queryKey: ['shipping', key], queryFn: fn });
  const summary = useQuery(get('summary', () => call(api.GET('/api/admin/shipping/summary'))));
  const carriersQ = useQuery(get('carriers', () => call(api.GET('/api/admin/shipping/carriers'))));
  const methodsQ = useQuery(get('methods', () => call(api.GET('/api/admin/shipping/methods'))));
  const profilesQ = useQuery(get('profiles', () => call(api.GET('/api/admin/shipping/profiles', { params: { query: { ownerType: 'official', limit: 100 } } }))));
  const zonesQ = useQuery(get('zones', () => call(api.GET('/api/admin/shipping/zones'))));
  const targetsQ = useQuery(get('dispatch-targets', () => call(api.GET('/api/admin/shipping/dispatch-targets'))));
  const noticesQ = useQuery(get('notices', () => call(api.GET('/api/admin/shipping/notices', { params: { query: { limit: 50 } } }))));
  const freeQ = useQuery(get('free-shipping-rules', () => call(api.GET('/api/admin/shipping/free-shipping-rules'))));
  const perfQ = useQuery({ queryKey: ['sellers', 'performance-targets'], queryFn: () => call(api.GET('/api/admin/sellers/performance-targets')) as Promise<Array<{ metric: string; display: string }>>, staleTime: 300_000, retry: false });

  const carriers: Carrier[] = carriersQ.data ?? [];
  const zones: Zone[] = zonesQ.data ?? [];
  const notices: ServiceNotice[] = (noticesQ.data?.items ?? []).filter((n) => n.status !== 'withdrawn');
  const official = ((profilesQ.data as { items?: ShippingProfile[] } | undefined)?.items ?? []).find((p) => p.ownerType === 'official' && p.isDefault && p.status === 'active');
  const live = summary.data?.liveNotices ?? [];
  const services = carriers.flatMap((c) => c.services);

  const open = view === 'add-service-notice' && canNotices;
  const errors = tried ? validate(draft, zones) : {};
  const set = <K extends keyof NoticeDraft>(k: K, v: NoticeDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const jump = (s: Section) => {
    setSection(s);
    document.getElementById(sectionId(s))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const toggle = useMutation({
    mutationFn: (v: { carrierId: string; serviceId: string; enabled: boolean }) =>
      stepUp.run((code) =>
        call(api.PATCH('/api/admin/shipping/carriers/{id}/services/{serviceId}', { params: { path: { id: v.carrierId, serviceId: v.serviceId }, header: stepUpHeader(code) as never }, body: { enabled: v.enabled } })),
      ),
    onSuccess: (_r, v) => {
      announce(v.enabled ? 'Service enabled' : 'Service disabled');
      void qc.invalidateQueries({ queryKey: ['shipping', 'carriers'] });
    },
  });

  const save = useMutation({
    mutationFn: async (publish: boolean) => {
      const input = toInput(draft, carriers, zones);
      const created = await stepUp.run((code) => call(api.POST('/api/admin/shipping/notices', { params: { header: stepUpHeader(code) as never }, body: input })));
      if (!publish) return created;
      const mode = draft.from > isoDay(0) ? 'scheduled' : 'now';
      return stepUp.run((code) => call(api.POST('/api/admin/shipping/notices/{id}/publish', { params: { path: { id: created.id }, header: stepUpHeader(code) as never }, body: { mode } })));
    },
    onSuccess: (n) => {
      setFlash(
        n.status === 'draft'
          ? `"${n.title}" saved as a draft. Customers don't see it until you publish it.`
          : n.status === 'live'
            ? `"${n.title}" is live. Delivery estimates now include the delay.`
            : `"${n.title}" is scheduled and goes live on ${date(n.from)}.`,
      );
      announce('Service notice saved');
      setView('');
      void qc.invalidateQueries({ queryKey: ['shipping'] });
      void qc.invalidateQueries({ queryKey: ['notifications', 'summary', 'staff'] });
    },
  });

  const openNotice = () => {
    setDraft(blank());
    setTried(false);
    save.reset();
    setView('add-service-notice');
  };
  const close = () => setView('');
  const submit = (publish: boolean) => {
    setTried(true);
    if (Object.keys(validate(draft, zones)).length) return;
    save.mutate(publish);
  };

  // Checkout preview for the first ZIP prefix in the area (or a Sacramento ZIP).
  const area = parseArea(draft.area, zones);
  const postal = area.postalPrefixes[0] ? area.postalPrefixes[0].padEnd(5, '0').replace(/^(\d{3})00$/, '$114') : '95814';
  const previewInput = useDebounced(open && draft.title.trim() && draft.from && draft.until ? JSON.stringify(toInput({ ...draft, title: draft.title || 'Preview', message: draft.message || ' ' }, carriers, zones)) : '', 500);
  const preview = useQuery({
    queryKey: ['shipping', 'notice-preview', previewInput, postal],
    queryFn: () => call(api.POST('/api/admin/shipping/notices/preview', { body: { notice: JSON.parse(previewInput) as NoticeInput, postalCode: postal, surface: 'checkout' } })),
    enabled: !!previewInput,
    retry: false,
  });
  const estimate = ((preview.data?.estimates ?? []) as Estimate[]).find((e) => e.changed) ?? ((preview.data?.estimates ?? []) as Estimate[])[0];
  const paused = draft.delay === 'pause';

  const methodLabel = (code: string) => methodsQ.data?.find((m) => m.code === code);
  const tierCols = (() => {
    const std = official?.methods.find((m) => m.rateType === 'by_weight');
    const bounds = (std?.tiers ?? []).map((t) => t.upToGrams).filter((g): g is number => g != null);
    if (!bounds.length) return [] as Array<{ label: string; grams: number }>;
    return [
      { label: `Up to ${lb(bounds[0]!)}`, grams: bounds[0]! },
      ...bounds.slice(1).map((g, i) => ({ label: `${lb(bounds[i]!).replace(' lb', '')}–${lb(g)}`, grams: g })),
      { label: `Over ${lb(bounds[bounds.length - 1]!)}`, grams: bounds[bounds.length - 1]! + 1 },
    ];
  })();

  const freeRules: Array<{ key: string; title: string; sub: string; status: string }> = (freeQ.data ?? []).map((r: FreeShippingRule) => ({
    key: r.id,
    title: r.name,
    sub: [`${methodLabel(r.methodCode)?.name ?? r.methodCode} method`, r.fundedBy === 'company' ? 'company-funded' : 'seller-funded', r.minOrderValue ? `orders ${formatMoney(r.minOrderValue)}+` : '', r.window ? whenLabel(r.window.from, r.window.to) : 'always on']
      .filter(Boolean)
      .join(' · '),
    status: STATUS_LABEL[r.status] ?? r.status,
  }));
  if (official?.freeShippingThreshold && !freeRules.some((r) => /official/i.test(r.title))) {
    freeRules.unshift({
      key: 'official-threshold',
      title: `Official Store orders ${formatMoney(official.freeShippingThreshold)} and over`,
      sub: `${methodLabel(official.freeShippingMethodCode ?? '')?.name ?? 'Standard'} method · company-funded · always on`,
      status: 'Active',
    });
  }

  const dt = targetsQ.data;
  const reply = perfQ.data?.find((t) => t.metric === 'response_time')?.display;
  const loadErr = carriersQ.error ?? summary.error;

  return (
    <AdminLayout active="shipping">
      <PageHeader
        crumbs={[{ label: 'Commerce' }, { label: 'Shipping' }]}
        title="Platform shipping settings"
        sub={`Owner ${summary.data?.owner ?? 'Shipping Manager'} · changes show their effective date and apply to new orders only`}
        actions={
          <>
            <Button variant="secondary" size="sm" icon="truck" to={href('ops/dispatch')}>
              Dispatch and exceptions
            </Button>
            {canNotices && (
              <Button size="sm" icon="plus" to={href('admin/shipping', 'add-service-notice')} onClick={(e) => (e.preventDefault(), openNotice())}>
                Add service notice
              </Button>
            )}
          </>
        }
      />
      {live.length > 0 && (
        <Alert tone="warning" title={live.length === 1 ? '1 service notice is live' : `${live.length} service notices are live`}>
          {live.map((n) => `${n.title}: ${n.message} ${whenLabel(n.from, n.to)}.`).join(' ')}
        </Alert>
      )}
      {flash && (
        <Alert tone="success" title="Service notice saved">
          {flash}
        </Alert>
      )}
      {toggle.isError && !isStepUpCancel(toggle.error) && (
        <Alert tone="danger" title="We couldn’t change the service">
          {errorMessage(toggle.error)}
        </Alert>
      )}
      {loadErr && <LoadError error={loadErr} onRetry={() => void (carriersQ.refetch(), summary.refetch())} />}
      <Tabs items={SECTIONS} active={section} onChange={jump} />
      <div className="aa-carrier" id={sectionId('carriers')}>
        {carriersQ.isLoading
          ? [0, 1, 2].map((i) => (
              <Card key={i} title={<span className="sk sk-line short" />} titleAs={i === 0 ? 'h2' : 'h3'}>
                <SkeletonLines rows={3} />
              </Card>
            ))
          : carriers.map((c, ci) => {
              const active = c.status === 'active' && c.services.some((m) => m.enabled);
              return (
                <Card
                  key={c.id}
                  title={c.name}
                  sub={`Account ${c.accountLabel ?? '—'} · ${c.trackingConnected ? 'connected' : 'not connected'}`}
                  titleAs={ci === 0 ? 'h2' : 'h3'}
                  actions={<StatusBadge status={active ? 'Active' : 'Paused'} />}
                >
                  <ul className="list">
                    {c.services.map((m) => {
                      const id = `aa-sh-${c.code}-${m.code}`;
                      const eta = `${m.transit.min === m.transit.max ? m.transit.min : `${m.transit.min}–${m.transit.max}`} business day${m.transit.max === 1 ? '' : 's'}`;
                      return (
                        <li key={m.id}>
                          <span className="grow stack gap-0">
                            <span className="small strong">{m.name.replace(new RegExp(`^${c.name}\\s+`), '')}</span>
                            <span className="xs muted">{eta}</span>
                          </span>
                          <Switch
                            id={id}
                            checked={m.enabled}
                            disabled={!canManage || toggle.isPending}
                            onChange={(e) => toggle.mutate({ carrierId: c.id, serviceId: m.id, enabled: e.target.checked })}
                            label={<span className="sr-only">{`${c.name} ${m.name} enabled`}</span>}
                          />
                        </li>
                      );
                    })}
                  </ul>
                  <span className="row between xs">
                    <span className="muted">On-time delivery, 30 days</span>
                    <b className="num">{c.onTimeRate30d != null ? `${c.onTimeRate30d.toFixed(1)}%` : '—'}</b>
                  </span>
                  <span className="xs muted">{c.trackingConnected ? `Tracking updates connected${c.lastEventAt ? ` · last event ${ago(c.lastEventAt)}` : ''}` : 'Tracking updates not connected'}</span>
                  {!canManage && <span className="xs muted">Changing services needs the shipping settings permission.</span>}
                </Card>
              );
            })}
      </div>
      <Card title="Shipping methods and rates" sub="Official Store rates · sellers set their own within these methods" titleAs="h3" flush>
        {profilesQ.isLoading ? (
          <SkeletonLines rows={3} />
        ) : profilesQ.isError ? (
          <LoadError error={profilesQ.error} onRetry={() => void profilesQ.refetch()} />
        ) : !official ? (
          <div className="card-body">
            <span className="small muted">No active Official Store shipping profile.</span>
          </div>
        ) : (
          <TableWrap label="Shipping methods and rates table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Method</th>
                  <th scope="col">Customer sees</th>
                  <th scope="col">Carriers</th>
                  {tierCols.map((c) => (
                    <th key={c.label} className="r" scope="col">
                      {c.label}
                    </th>
                  ))}
                  <th scope="col">Free when</th>
                </tr>
              </thead>
              <tbody>
                {official.methods
                  .filter((m) => m.enabled)
                  .map((m) => {
                    const free = official.freeShippingThreshold && official.freeShippingMethodCode === m.methodCode ? `Official Store order ${formatMoney(official.freeShippingThreshold)}+` : m.freeOver ? `Order ${formatMoney(m.freeOver)}+` : '';
                    return (
                      <tr key={m.methodId}>
                        <td>
                          <span className="small strong">{m.name}</span>
                        </td>
                        <td>
                          <span className="small">{methodLabel(m.methodCode)?.customerLabel ?? '—'}</span>
                        </td>
                        <td>
                          <span className="small">{m.carrierServiceIds.map((id) => services.find((s) => s.id === id)?.name).filter(Boolean).join(', ') || '—'}</span>
                        </td>
                        {tierCols.map((c) => (
                          <td key={c.label} className="r">
                            {formatMoney(priceAt(m, c.grams)) || '—'}
                          </td>
                        ))}
                        <td>{free ? <span className="small">{free}</span> : <span className="xs muted">Never</span>}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
      <div className="aa-2">
        <Card id={sectionId('destinations')} title="Destinations" sub="One service region at launch" titleAs="h3">
          {zonesQ.isLoading ? (
            <SkeletonLines rows={4} />
          ) : zonesQ.isError ? (
            <LoadError error={zonesQ.error} onRetry={() => void zonesQ.refetch()} />
          ) : (
            <ul className="list">
              {zones.map((z) => {
                const std = z.transitByMethod.standard;
                const sub =
                  z.kind === 'served'
                    ? [`${z.regions.length} state${z.regions.length === 1 ? '' : 's'}${z.postalPrefixes.length ? ` · ${z.postalPrefixes.length} ZIP prefixes` : ''}`, std ? `Standard ${std.min}–${std.max} days` : ''].filter(Boolean).join(' · ')
                    : (z.customerMessage ?? 'Not served. Customers see this before checkout.');
                return (
                  <li key={z.id}>
                    <Icon name={z.kind === 'served' ? 'map' : 'circle-slash'} className="ic-sm" />
                    <span className="grow stack gap-0">
                      <span className="small strong">{z.name}</span>
                      <span className="xs muted">{sub}</span>
                    </span>
                    <StatusBadge status={z.kind === 'served' ? (z.status === 'active' ? 'Active' : 'Disabled') : z.status === 'active' ? 'Disabled' : 'Allowed'} />
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card id={sectionId('dispatch')} title="Dispatch targets" sub="Late dispatch creates an overdue task and notifies the customer" titleAs="h3">
          {targetsQ.isLoading ? (
            <SkeletonLines rows={4} />
          ) : targetsQ.isError || !dt ? (
            <LoadError error={targetsQ.error} onRetry={() => void targetsQ.refetch()} />
          ) : (
            <>
              <div className="aa-sec">
                <span className="row gap-2">
                  <LogoTile initials="M" tint="brand" size="xs" />
                  <span className="h4">Official Store</span>
                </span>
                <KeyValue
                  pairs={[
                    ['Order cutoff', `${clock(dt.official.cutoff)} PT, ${dayRange(dt.official.businessDays)}`],
                    ['Before cutoff', dt.official.beforeCutoff],
                    ['After cutoff', dt.official.afterCutoff],
                    [
                      'Current',
                      dt.official.onTimeRate30d != null || summary.data?.officialOnTimeRate30d != null ? (
                        <>
                          <span className="t-success-text strong">{`${(dt.official.onTimeRate30d ?? summary.data?.officialOnTimeRate30d ?? 0).toFixed(1)}% on time`}</span> · 30 days
                        </>
                      ) : (
                        <span className="muted">No shipments in the last 30 days</span>
                      ),
                    ],
                  ]}
                />
              </div>
              <div className="aa-sec">
                <span className="h4">Default seller targets</span>
                <KeyValue
                  pairs={[
                    ['Dispatch within', `${dt.sellerDefault.dispatchWithinBusinessDays} business days (sellers can promise ${dt.sellerDefault.allowedMinDays}–${dt.sellerDefault.allowedMaxDays})`],
                    ['Valid tracking', `Within ${dt.sellerDefault.validTrackingWithinHours} hours of dispatch`],
                    ...(reply ? ([['Reply to customers', reply.replace(/^At most /, 'Within ').replace(/ h$/, ' hours')]] as Array<[string, string]>) : []),
                    ['Performance target', `${dt.sellerDefault.onTimeTargetPct}% on time over 30 days`],
                  ]}
                />
                <span className="xs muted">{dt.note}</span>
              </div>
            </>
          )}
        </Card>
      </div>
      <div className="aa-2">
        <Card
          id={sectionId('calendar')}
          title="Holiday calendar and service notices"
          sub="Customers see these in delivery estimates"
          titleAs="h3"
          flush
          actions={
            canNotices ? (
              <Button variant="ghost" size="sm" icon="plus" to={href('admin/shipping', 'add-service-notice')} onClick={(e) => (e.preventDefault(), openNotice())}>
                Add
              </Button>
            ) : undefined
          }
        >
          {noticesQ.isLoading ? (
            <SkeletonLines rows={3} />
          ) : noticesQ.isError ? (
            <LoadError error={noticesQ.error} onRetry={() => void noticesQ.refetch()} />
          ) : notices.length ? (
            <TableWrap label="Holiday calendar and service notices table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Notice</th>
                    <th scope="col">Effect</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {notices.map((n) => {
                    const atRisk = n.status === 'live';
                    return (
                      <tr key={n.id} className={cx(atRisk && 'is-warn')}>
                        <td>
                          {atRisk && <span className="sr-only">At risk: </span>}
                          <span className="small nowrap">{whenLabel(n.from, n.to)}</span>
                        </td>
                        <td>
                          <span className="small">{n.title}</span>
                        </td>
                        <td>
                          <span className="small">{effectLabel(n, carriers)}</span>
                        </td>
                        <td>
                          <StatusBadge status={STATUS_LABEL[n.status] ?? n.status} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          ) : (
            <div className="card-body">
              <span className="small muted">No holidays or service notices yet.</span>
            </div>
          )}
          {notices.some((n) => n.status === 'live') && (
            <p className="status-legend status-legend--edge">
              <span className="sr-only">Legend: </span>
              <span className="sl sl-warning">
                <i aria-hidden="true" />
                Amber edge = at risk: due soon or near target
              </span>
            </p>
          )}
        </Card>
        <Card id={sectionId('free')} title="Free-shipping rules" sub="Who pays is recorded per order" titleAs="h3">
          {freeQ.isLoading ? (
            <SkeletonLines rows={3} />
          ) : freeQ.isError ? (
            <LoadError error={freeQ.error} onRetry={() => void freeQ.refetch()} />
          ) : freeRules.length ? (
            <ul className="list">
              {freeRules.map((r) => (
                <li key={r.key}>
                  <span className="grow stack gap-0">
                    <span className="small strong">{r.title}</span>
                    <span className="xs muted">{r.sub}</span>
                  </span>
                  <StatusBadge status={r.status} />
                </li>
              ))}
            </ul>
          ) : (
            <span className="small muted">No free-shipping rules.</span>
          )}
          <Link className="small strong" to={href('admin/promotions')}>
            Manage shipping promotions
          </Link>
        </Card>
      </div>

      <Dialog
        open={open}
        onClose={close}
        title="Add service notice"
        size="lg"
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="secondary" disabled={save.isPending} onClick={() => submit(false)}>
              Save as draft
            </Button>
            <Button icon="megaphone" disabled={save.isPending} onClick={() => submit(true)}>
              Publish notice
            </Button>
          </>
        }
      >
        <p className="small sub">Service notices adjust delivery estimates and show a short message to customers where they make delivery decisions.</p>
        {save.isError && !isStepUpCancel(save.error) && (
          <Alert tone="danger" title="We couldn’t save the notice">
            {errorMessage(save.error)}
          </Alert>
        )}
        <div className="grid md2 gap-3">
          <Field label="Notice title" error={errors.title}>
            <TextInput id="aa-sn-t" value={draft.title} error={!!errors.title} onChange={(e) => set('title', e.target.value)} placeholder="" />
          </Field>
          <Field label="Type">
            <Select id="aa-sn-type" options={NOTICE_TYPES} value={draft.type} onChange={(e) => set('type', e.target.value as NoticeKind)} />
          </Field>
          <Field label="Carriers and services">
            <Select id="aa-sn-c" options={carrierOptions(carriers)} value={draft.carrier} onChange={(e) => set('carrier', e.target.value)} />
          </Field>
          <Field label="Affected area" hint="ZIP prefixes, states or zones" error={errors.area}>
            <TextInput id="aa-sn-a" value={draft.area} error={!!errors.area} onChange={(e) => set('area', e.target.value)} placeholder="" />
          </Field>
          <Field label="From" error={errors.from}>
            <TextInput id="aa-sn-from" type="date" value={draft.from} error={!!errors.from} onChange={(e) => set('from', e.target.value)} placeholder="" />
          </Field>
          <Field label="Until" hint="Ends automatically. You can end it early." error={errors.until}>
            <TextInput id="aa-sn-to" type="date" min={draft.from} value={draft.until} error={!!errors.until} onChange={(e) => set('until', e.target.value)} placeholder="" />
          </Field>
          <Field label="Add to delivery estimate">
            <Select id="aa-sn-add" options={NOTICE_DELAYS.map((x) => ({ value: x.value, label: x.label }))} value={draft.delay} onChange={(e) => set('delay', e.target.value)} />
          </Field>
          <Field label="Applies to">
            <Select id="aa-sn-who" options={NOTICE_AUDIENCE} value={draft.audience} onChange={(e) => set('audience', e.target.value as NoticeDraft['audience'])} />
          </Field>
        </div>
        <Field label="Message to customers" hint="Plain language. Under 200 characters." error={errors.message}>
          <Textarea id="aa-sn-msg" value={draft.message} onChange={(e) => set('message', e.target.value)} placeholder="" />
        </Field>
        <div className="stack gap-2">
          <span className="label">Show on</span>
          <div className="grid md3 gap-2">
            {NOTICE_PLACES.map((p) => (
              <Checkbox key={p.id} id={p.id} label={p.label} checked={draft.places[p.id]} onChange={(e) => set('places', { ...draft.places, [p.id]: e.target.checked })} />
            ))}
          </div>
          {errors.places && (
            <span className="error-text">
              <Icon name="circle-alert" className="ic-sm" />
              {errors.places}
            </span>
          )}
        </div>
        <div className="aa-preview stack gap-2">
          <span className="xs strong muted">{`Preview · checkout, ${postal}`}</span>
          <Alert tone="warning" icon="truck" title={paused ? 'Delivery paused' : 'Possible delay'}>
            {draft.message.trim() || 'Your message to customers appears here.'}
          </Alert>
          {preview.isError ? (
            <span className="xs muted">{`Preview unavailable: ${errorMessage(preview.error)}`}</span>
          ) : preview.data && !preview.data.applies ? (
            <span className="xs muted">{`This notice doesn’t apply to ${postal} on these dates.`}</span>
          ) : estimate ? (
            <span className="small">
              <b>{estimate.carrierService ?? estimate.methodName}</b> · {estimate.arrivalLabel}
            </span>
          ) : (
            <span className="xs muted">Enter a title and dates to see the adjusted estimate.</span>
          )}
        </div>
        <span className="xs muted">
          {preview.data?.affectedSellers ? `${preview.data.affectedSellers} seller${preview.data.affectedSellers === 1 ? '' : 's'} shipping to this area get a Seller Center notice. ` : 'Sellers shipping to this area get a Seller Center notice. '}
          {preview.data?.dispatchChanges ? 'Dispatch deadlines change too.' : 'Dispatch deadlines do not change; only arrival estimates do.'}
        </span>
      </Dialog>
      {stepUp.dialog}
    </AdminLayout>
  );
}
