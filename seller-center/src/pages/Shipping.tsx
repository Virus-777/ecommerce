import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, money, parseCents } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Checkbox, Dialog, Field, Icon, KeyValue, OptionCard, PageHeader, PhoneInput, Select, Switch, TableWrap, TextInput, Timeline, announce, type TimelineEvent } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { addDays, dayKey, dayRange, phoneText, ptDateTime, ptInstant, weekdayDay, type Carrier, type PlatformMethod, type ProfileMethod, type ReturnTerms, type ShippingSettings } from './data/orders';

// Design: pages/seller/seller-shipping.html (single view).
// Data: GET/PUT /api/seller/shipping/settings (coverage, dispatch schedule, label preference, preview, history),
// PUT …/profiles/{id} (methods, rates, free-shipping threshold; one new version, now or from a date),
// POST/DELETE …/closures (apply at once), GET …/methods (platform methods to add), GET …/carrier-services
// (carrier names), GET/PUT /api/seller/returns/terms (return address; the rest of the terms is sent back unchanged).

type Excl = 'po_box' | 'military' | 'alaska' | 'hawaii' | 'territories';
type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

const EXCLUSIONS: Array<{ id: string; key: Excl; label: string }> = [
  { id: 'sh-ex1', key: 'po_box', label: 'PO boxes' },
  { id: 'sh-ex2', key: 'military', label: 'APO / FPO / DPO military addresses' },
  { id: 'sh-ex3', key: 'alaska', label: 'Alaska' },
  { id: 'sh-ex4', key: 'hawaii', label: 'Hawaii' },
  { id: 'sh-ex5', key: 'territories', label: 'Puerto Rico, Guam and US Virgin Islands' },
];
const DAYS: Array<{ key: Day; label: string }> = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];
const handlingLabel = (n: number) => (n === 0 ? 'Same business day' : `${n} business day${n === 1 ? '' : 's'}`);
const cutoffLabel = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'} PT`;
};
const RATE_TYPE: Record<string, string> = { by_weight: 'By weight', flat_per_package: 'Flat per package', by_order_value: 'By order value', free: 'Free' };

interface Draft {
  area: 'contiguous_48_dc' | 'all_50' | 'custom';
  excluded: Record<Excl, boolean>;
  handlingDays: number;
  cutoff: string;
  days: Record<Day, boolean>;
  labels: boolean;
  methods: ProfileMethod[];
  free: string;
}

const dollars = (amount?: number | null) => (amount == null ? '' : (amount / 100).toFixed(2));
const isAmount = (v: string) => /^\d+(\.\d{1,2})?$/.test(v.trim());
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
const freeError = (v: string) => (!v.trim() || (isAmount(v) && Number(v) > 0) ? '' : 'Enter an amount in dollars, like 49.00, or leave it empty for no free shipping.');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sentence = (l: string[]) => l.join(', ').replace(/^./, (c) => c.toUpperCase());
const lbs = (g: number) => `${Math.round((g / 453.592) * 10) / 10} lb`;
const toCents = (v: string) => parseCents(v) ?? NaN;

function fromServer(st: ShippingSettings, profileId: string): Draft {
  const p = st.profiles.find((x) => x.id === profileId) ?? st.profiles[0];
  return {
    area: st.coverage.area,
    excluded: Object.fromEntries(EXCLUSIONS.map((e) => [e.key, st.coverage.excluded.includes(e.key)])) as Record<Excl, boolean>,
    handlingDays: st.dispatch.handlingDays,
    cutoff: st.dispatch.sameDayCutoff,
    days: Object.fromEntries(DAYS.map((d) => [d.key, st.dispatch.businessDays.includes(d.key)])) as Record<Day, boolean>,
    labels: st.labels.buyLabelsInSellerCenter,
    methods: p?.methods ?? [],
    free: dollars(p?.freeShippingThreshold?.amount),
  };
}

/** Human names of the settings that differ from the saved ones, in page order. */
function changes(d: Draft, s: Draft): { settings: string[]; profile: string[] } {
  const settings: string[] = [];
  const profile: string[] = [];
  if (d.area !== s.area) settings.push('coverage');
  if (!same(d.excluded, s.excluded)) settings.push('excluded areas');
  if (!same(d.methods, s.methods)) profile.push('methods and rates');
  if (d.free.trim() !== s.free.trim() && !(isAmount(d.free) && isAmount(s.free) && Number(d.free) === Number(s.free))) profile.push('free shipping threshold');
  if (d.handlingDays !== s.handlingDays) settings.push('handling time');
  if (d.cutoff !== s.cutoff) settings.push('order cutoff');
  if (!same(d.days, s.days)) settings.push('business days');
  if (d.labels !== s.labels) settings.push('shipping labels');
  return { settings, profile };
}

/** "Up to 1 lb $4.99", "1–5 lb $6.99", "$19.99" from a method's rate tiers. */
function rateLines(m: ProfileMethod): string[] {
  if (m.rateType === 'free') return ['Free'];
  if (m.rateType === 'flat_per_package') return m.tiers.slice(0, 1).map((t) => formatMoney(t.price));
  const byWeight = m.rateType === 'by_weight';
  const bound = (t: ProfileMethod['tiers'][number]) => (byWeight ? t.upToGrams : t.upToOrderValue?.amount) ?? null;
  const tiers = [...m.tiers].sort((a, b) => (bound(a) ?? Infinity) - (bound(b) ?? Infinity));
  let prev: number | null = null;
  return tiers.map((t) => {
    const up = bound(t);
    const f = (v: number) => (byWeight ? lbs(v) : formatMoney({ amount: v, currency: 'USD' }));
    const range = up == null ? (prev == null ? (byWeight ? 'Any weight' : 'Any order') : `Over ${f(prev)}`) : prev == null ? `Up to ${f(up)}` : byWeight ? `${lbs(prev).replace(' lb', '')}–${f(up)}` : `${f(prev)}–${f(up)}`;
    prev = up;
    return `${range} ${formatMoney(t.price)}`;
  });
}

function nextMonday(): string {
  const today = dayKey();
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addDays(today, ((8 - dow) % 7) || 7);
}

function Skeleton() {
  return (
    <div className="stack gap-5" role="status" aria-label="Loading shipping settings">
      {[3, 2, 3].map((n, i) => (
        <section key={i} className="card">
          <div className="sk-list pad" aria-hidden="true">
            {Array.from({ length: n }, (_, k) => (
              <div key={k} className="sk-row">
                <span className="sk-lines">
                  <span className="sk sk-line" />
                  <span className="sk sk-line short" />
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default function Shipping() {
  const { api } = useApi();
  const { sellerId } = useSellerSession();
  const settings = useQuery({ queryKey: ['shipping', 'settings', sellerId], queryFn: () => call(api.GET('/api/seller/shipping/settings')) });
  const methods = useQuery({ queryKey: ['shipping', 'methods', sellerId], queryFn: () => call(api.GET('/api/seller/shipping/methods')) });
  const carriers = useQuery({ queryKey: ['shipping', 'carrier-services'], queryFn: () => call(api.GET('/api/seller/shipping/carrier-services')) });
  const failed = [settings, methods].find((q) => q.isError);

  return (
    <SellerLayout active="shipping">
      <PageHeader
        title="Shipping settings"
        sub="These settings drive the delivery estimates and shipping prices customers see on your offers."
        actions={
          <Button variant="secondary" size="sm" icon="package-search" to={href('seller/orders', 'shipped')}>
            Shipment records
          </Button>
        }
      />
      {failed ? (
        <Alert tone="danger" title="We couldn't load your shipping settings">
          {errorMessage(failed.error)}{' '}
          <Button variant="secondary" size="sm" onClick={() => void failed.refetch()}>
            Try again
          </Button>
        </Alert>
      ) : settings.data && methods.data ? (
        <ShippingForm settings={settings.data} methods={methods.data} carriers={carriers.data ?? []} />
      ) : (
        <Skeleton />
      )}
    </SellerLayout>
  );
}

function ShippingForm({ settings: st, methods, carriers }: { settings: ShippingSettings; methods: PlatformMethod[]; carriers: Carrier[] }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { sellerId, can } = useSellerSession();
  const canManage = can('shipping.seller-settings.manage');
  const [profileId, setProfileId] = useState(() => (st.profiles.find((p) => p.isDefault) ?? st.profiles[0])?.id ?? '');
  const profile = st.profiles.find((p) => p.id === profileId) ?? st.profiles[0];
  const saved = fromServer(st, profileId);
  const [s, setS] = useState<Draft>(saved);
  const monday = nextMonday();
  const EFFECTIVE = ['Apply now (orders after saving)', `Apply from ${weekdayDay(monday)}, 12:00 AM PT`];
  const [effective, setEffective] = useState(EFFECTIVE[0]);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; title: string; body?: string } | null>(null);
  const [freeTouched, setFreeTouched] = useState(false);
  const [handlingErr, setHandlingErr] = useState('');

  const serviceName = (id: string) => carriers.flatMap((c) => c.services).find((x) => x.id === id)?.name;
  const methodOf = (id: string) => methods.find((m) => m.id === id);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setNotice(null);
    if (k === 'handlingDays') setHandlingErr('');
    setS((p) => ({ ...p, [k]: v }));
  };
  const dirty = changes(s, saved);
  const dirtyAll = [...dirty.settings.slice(0, 2), ...dirty.profile, ...dirty.settings.slice(2)];
  const fErr = freeTouched ? freeError(s.free) : '';
  const freeLabel = !s.free.trim() || freeError(s.free) ? 'Over —' : `Over $${Number(s.free) % 1 ? Number(s.free).toFixed(2) : Number(s.free)}`;
  const freeCode = profile?.freeShippingMethodCode ?? 'standard';

  const refresh = () => qc.invalidateQueries({ queryKey: ['shipping'] });

  const save = useMutation({
    mutationFn: async () => {
      const effectiveFrom = effective === EFFECTIVE[0] ? null : ptInstant(monday);
      let next: ShippingSettings | null = null;
      if (dirty.settings.length) {
        next = await call(
          api.PUT('/api/seller/shipping/settings', {
            body: {
              coverage: { area: s.area, zoneIds: st.coverage.zoneIds, excluded: EXCLUSIONS.filter((e) => s.excluded[e.key]).map((e) => e.key) },
              dispatch: { handlingDays: s.handlingDays, sameDayCutoff: s.cutoff, businessDays: DAYS.filter((d) => s.days[d.key]).map((d) => d.key) },
              buyLabelsInSellerCenter: s.labels,
              shipsFrom: null,
              defaultParcel: null,
              effectiveFrom,
            },
          }),
        );
      }
      if (dirty.profile.length && profile) {
        await call(
          api.PUT('/api/seller/shipping/profiles/{id}', {
            params: { path: { id: profile.id } },
            body: {
              name: profile.name,
              isDefault: profile.isDefault,
              methods: s.methods.map((m) => ({ methodId: m.methodId, enabled: m.enabled, rateType: m.rateType, tiers: m.tiers, minWeightGrams: m.minWeightGrams ?? null, maxWeightGrams: m.maxWeightGrams ?? null, carrierServiceIds: m.carrierServiceIds, freeOver: m.freeOver ?? null })),
              freeShippingThreshold: s.free.trim() ? { amount: toCents(s.free), currency: 'USD' } : null,
              freeShippingMethodCode: s.free.trim() ? freeCode : null,
              effectiveFrom,
            },
          }),
        );
        next = await call(api.GET('/api/seller/shipping/settings'));
      }
      return { next, now: effectiveFrom === null };
    },
    onSuccess: ({ next, now }) => {
      if (next) {
        qc.setQueryData(['shipping', 'settings', sellerId], next);
        setS(fromServer(next, profileId));
      }
      setFreeTouched(false);
      const title = now ? 'Shipping settings saved. They apply to orders placed from now on.' : `Shipping settings saved. They apply from ${weekdayDay(monday)}, 12:00 AM PT.`;
      setNotice({ tone: 'success', title });
      announce('Shipping settings saved');
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'HANDLING_OUT_OF_RANGE') {
        setHandlingErr(`Choose between ${handlingLabel(Number(e.details.min ?? st.allowedHandlingDays.min)).toLowerCase()} and ${handlingLabel(Number(e.details.max ?? st.allowedHandlingDays.max)).toLowerCase()}.`);
      }
      const fields = e instanceof ApiError ? Object.values(e.fieldErrors) : [];
      setNotice({ tone: 'danger', title: 'Your changes were not saved', body: fields.length ? fields.join(' ') : errorMessage(e) });
      announce('Your changes were not saved');
    },
    onSettled: refresh,
  });
  const doSave = () => {
    setFreeTouched(true);
    if (freeError(s.free)) return;
    if (!DAYS.some((d) => s.days[d.key])) return setNotice({ tone: 'danger', title: 'Choose at least one business day.' });
    save.mutate();
  };
  const discard = () => {
    setS(saved);
    setFreeTouched(false);
    setHandlingErr('');
    announce('Changes discarded');
  };
  const pickProfile = (id: string) => {
    setProfileId(id);
    const p = fromServer(st, id);
    setS((d) => ({ ...d, methods: p.methods, free: p.free }));
  };

  // Closures apply at once (the API has no draft for them).
  const [closureOpen, setClosureOpen] = useState(false);
  const [closure, setClosure] = useState({ name: '', from: '', to: '' });
  const [closureTried, setClosureTried] = useState(false);
  const [closureErr, setClosureErr] = useState('');
  const closureErrors = {
    name: closureTried && !closure.name.trim() ? 'Enter a name for the closure.' : '',
    from: closureTried && !closure.from ? 'Enter the first closed day.' : '',
    to: closureTried && closure.to && closure.from && closure.to < closure.from ? 'The last day is before the first day.' : '',
  };
  const addClosureM = useMutation({
    mutationFn: () => call(api.POST('/api/seller/shipping/closures', { body: { name: closure.name.trim(), from: closure.from, to: closure.to || closure.from } })),
    onSuccess: (c) => {
      setClosureOpen(false);
      announce(`${c.name} closure added`);
    },
    onError: (e) => setClosureErr(errorMessage(e)),
    onSettled: refresh,
  });
  const removeClosure = useMutation({
    mutationFn: (id: string) => call(api.DELETE('/api/seller/shipping/closures/{id}', { params: { path: { id } } })),
    onSuccess: () => announce('Closure removed'),
    onError: (e) => setNotice({ tone: 'danger', title: 'Could not remove the closure', body: errorMessage(e) }),
    onSettled: refresh,
  });
  const openClosure = () => {
    setClosure({ name: '', from: '', to: '' });
    setClosureTried(false);
    setClosureErr('');
    setClosureOpen(true);
  };
  const addClosure = () => {
    setClosureTried(true);
    if (!closure.name.trim() || !closure.from || (closure.to && closure.to < closure.from)) return;
    addClosureM.mutate();
  };

  // Return address: lives in the return terms (returns module); saved at once.
  const terms = useQuery({ queryKey: ['returns', 'terms', sellerId], queryFn: () => call(api.GET('/api/seller/returns/terms')) });
  const canAddr = can('returns.terms.manage');
  const [addrOpen, setAddrOpen] = useState(false);
  const [addr, setAddr] = useState({ name: '', line1: '', city: '', phone: '', email: '' });
  const [addrTried, setAddrTried] = useState(false);
  const [addrErr, setAddrErr] = useState('');
  const cityMatch = /^(.+?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(addr.city.trim());
  const addrBad = { name: !addr.name.trim(), line1: !addr.line1.trim(), city: !cityMatch, email: !!addr.email.trim() && !isEmail(addr.email) };
  const addrErrors = {
    name: addrTried && addrBad.name ? 'Enter the name on the return address.' : '',
    line1: addrTried && addrBad.line1 ? 'Enter a street address.' : '',
    city: addrTried && addrBad.city ? 'Enter the city, state and 5-digit ZIP code, like Portland, OR 97209.' : '',
    email: addrTried && addrBad.email ? 'Enter an email address, like returns@example.com.' : '',
  };
  const openAddr = (t: ReturnTerms) => {
    const a = t.returnAddress;
    setAddr({ name: a.name ?? '', line1: [a.line1, a.line2].filter(Boolean).join(', '), city: `${a.city}, ${a.region} ${a.postalCode}`, phone: phoneText(a.phone), email: t.returnContactEmail ?? '' });
    setAddrTried(false);
    setAddrErr('');
    setAddrOpen(true);
  };
  const saveAddrM = useMutation({
    mutationFn: (t: ReturnTerms) => {
      const digits = addr.phone.replace(/\D/g, '');
      const phone = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith('1') ? `+${digits}` : addr.phone.trim() || null;
      return call(
        api.PUT('/api/seller/returns/terms', {
          body: {
            windowDays: t.windowDays,
            changeOfMindPaidBy: t.changeOfMindPaidBy,
            freeReturns: t.freeReturns,
            remedies: t.remedies,
            returnAddress: { ...t.returnAddress, name: addr.name.trim(), line1: addr.line1.trim(), line2: null, city: cityMatch![1].trim(), region: cityMatch![2].toUpperCase(), postalCode: cityMatch![3], phone },
            returnContactEmail: addr.email.trim() || null,
            receivingHours: t.receivingHours ?? null,
            responseTargetBusinessDays: t.responseTargetBusinessDays,
            refundTargetDays: t.refundTargetDays,
          },
        }),
      );
    },
    onSuccess: (next) => {
      qc.setQueryData(['returns', 'terms', sellerId], next);
      setAddrOpen(false);
      announce('Return address saved');
    },
    onError: (e) => setAddrErr(errorMessage(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['returns', 'terms', sellerId] }),
  });
  const saveAddr = () => {
    setAddrTried(true);
    if (!terms.data || Object.values(addrBad).some(Boolean)) return;
    saveAddrM.mutate(terms.data);
  };

  // Add method: a platform method the profile doesn't have yet, with a flat rate.
  const available = methods.filter((m) => m.active && !s.methods.some((x) => x.methodId === m.id));
  const [methodOpen, setMethodOpen] = useState(false);
  const [method, setMethod] = useState({ id: '', rate: '' });
  const [methodTried, setMethodTried] = useState(false);
  const methodErrors = { rate: methodTried && !(isAmount(method.rate) && Number(method.rate) >= 0) ? 'Enter a flat rate in dollars, like 12.99.' : '' };
  const chosenMethod = methodOf(method.id);
  const openMethod = () => {
    setMethod({ id: available[0]?.id ?? '', rate: '' });
    setMethodTried(false);
    setMethodOpen(true);
  };
  const addMethod = () => {
    setMethodTried(true);
    if (!chosenMethod || !isAmount(method.rate)) return;
    set('methods', [
      ...s.methods,
      { methodId: chosenMethod.id, methodCode: chosenMethod.code, name: chosenMethod.name, enabled: true, rateType: 'flat_per_package', tiers: [{ upToGrams: null, upToOrderValue: null, price: { amount: toCents(method.rate), currency: 'USD' } }], minWeightGrams: null, maxWeightGrams: null, carrierServiceIds: chosenMethod.carrierServiceIds, freeOver: null },
    ]);
    setMethodOpen(false);
  };

  // The handling days the platform allows (setting sellerHandlingRange, 0 = same business day), plus the saved value.
  const { min: hMin, max: hMax } = st.allowedHandlingDays;
  const handlingOptions = [...new Set([...Array.from({ length: Math.max(0, hMax - hMin + 1) }, (_, i) => hMin + i), s.handlingDays])].sort((a, b) => a - b);
  const cutoffOptions = [...new Set(['10:00', '12:00', '14:00', s.cutoff])].sort();
  const preview = st.customerPreview;
  const history: TimelineEvent[] = [
    ...(st.pendingChange ? [{ t: 'Scheduled change', d: `From ${ptDateTime(st.pendingChange.effectiveFrom)} PT`, state: 'current' as const, body: st.pendingChange.summary }] : []),
    ...st.history.map((h, i) => ({ t: i === 0 ? `Last saved · ${h.label}` : h.label, d: [ptDateTime(h.at), h.actor?.name].filter(Boolean).join(' · '), state: 'done' as const, body: h.detail ?? undefined })),
  ];
  const lastSaved = st.history[0] ? `Last saved ${ptDateTime(st.history[0].at)}` : '';
  const ra = terms.data?.returnAddress;

  return (
    <>
      <div className="sa-split">
        <div className="stack gap-5">
          {notice && (
            <Alert tone={notice.tone} title={notice.title}>
              {notice.body}
            </Alert>
          )}
          {!canManage && <Alert tone="info">You can view the shipping settings. Ask the store owner for access to change them.</Alert>}
          <Card title="Coverage" sub="Where you ship">
            <div className="stack gap-2">
              <span className="label">Ship to</span>
              <OptionCard id="sh-cov1" name="sh-cov" title={<b>48 contiguous states and Washington, DC</b>} body="Recommended for launch." checked={s.area === 'contiguous_48_dc'} disabled={!canManage} onChange={() => set('area', 'contiguous_48_dc')} />
              <OptionCard id="sh-cov2" name="sh-cov" title={<b>All 50 states</b>} body="Alaska and Hawaii orders use separate rates." checked={s.area === 'all_50'} disabled={!canManage} onChange={() => set('area', 'all_50')} />
            </div>
            <div className="stack gap-2">
              <span className="label">Excluded areas</span>
              <div className="grid md2 gap-2">
                {EXCLUSIONS.map((e, i) => (
                  <Checkbox key={e.id} id={e.id} label={e.label} checked={s.excluded[e.key]} disabled={!canManage} aria-describedby={i === 0 ? 'sh-ex1-hint' : undefined} onChange={(ev) => set('excluded', { ...s.excluded, [e.key]: ev.target.checked })} />
                ))}
              </div>
              <span className="hint" id="sh-ex1-hint">
                Customers in excluded areas see "Doesn't ship to your address" before checkout.
              </span>
            </div>
          </Card>

          <Card
            title="Methods and rates"
            titleAs="h3"
            sub={st.profiles.length > 1 ? undefined : profile ? `Profile: ${profile.name} · used by ${profile.offersUsing} offer${profile.offersUsing === 1 ? '' : 's'}` : undefined}
            flush
            footClassName="card-foot--field"
            actions={
              <div className="row gap-2">
                {st.profiles.length > 1 && (
                  <>
                    <label className="sr-only" htmlFor="sh-profile">
                      Shipping profile
                    </label>
                    <Select id="sh-profile" ctl="sm" options={st.profiles.map((p) => ({ value: p.id, label: `${p.name} (${p.offersUsing} offers)` }))} value={profileId} onChange={(e) => pickProfile(e.target.value)} />
                  </>
                )}
                {canManage && available.length > 0 && (
                  <Button variant="secondary" size="sm" icon="plus" onClick={openMethod}>
                    Add method
                  </Button>
                )}
              </div>
            }
            foot={
              <>
                {/* QA M-2: on the phone layout the row, field and input keep a real width (the input used to collapse to 0 px). */}
                <div className="row gap-3 grow" style={{ minWidth: 'min(100%, 16rem)' }}>
                  <div className="field grow" style={{ minWidth: 'min(100%, 12rem)' }}>
                    <label className="label" htmlFor="sh-free">
                      Free {methods.find((m) => m.code === freeCode)?.name ?? 'Standard'} shipping on orders over
                    </label>
                    <span className="input-group" style={{ minWidth: '8rem' }}>
                      <span className="affix">$</span>
                      <input
                        className={cx('input', fErr && 'is-error')}
                        id="sh-free"
                        type="text"
                        inputMode="decimal"
                        value={s.free}
                        placeholder="No free shipping"
                        disabled={!canManage}
                        aria-invalid={fErr ? true : undefined}
                        aria-describedby={fErr ? 'sh-free-err' : undefined}
                        style={{ flex: '1 1 auto', minWidth: '4rem', width: '100%' }}
                        onChange={(e) => set('free', e.target.value)}
                        onBlur={() => setFreeTouched(true)}
                      />
                    </span>
                    {fErr && (
                      <span className="error-text" id="sh-free-err">
                        <Icon name="circle-alert" className="ic-sm" />
                        {fErr}
                      </span>
                    )}
                  </div>
                </div>
                <span className="xs muted u-maxw-40ch">Applies to your items in one order. Customers see "Free delivery" on qualifying offers.</span>
              </>
            }
          >
            <TableWrap label="Methods and rates table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Method</th>
                    <th scope="col">Transit</th>
                    <th scope="col">Rate type</th>
                    <th scope="col">Rates</th>
                    <th scope="col">Free shipping</th>
                    <th scope="col">On</th>
                  </tr>
                </thead>
                <tbody>
                  {s.methods.map((m) => {
                    const pm = methodOf(m.methodId);
                    const services = m.carrierServiceIds.map(serviceName).filter(Boolean);
                    return (
                      <tr key={m.methodId}>
                        <td>
                          <span className="small strong">{m.name}</span>
                          {services.length > 0 && <div className="xs muted">{services.join(' or ')}</div>}
                        </td>
                        <td>{pm?.customerLabel ?? (pm ? `${pm.transit.min}–${pm.transit.max} business days` : '—')}</td>
                        <td>{RATE_TYPE[m.rateType] ?? m.rateType}</td>
                        <td>
                          <span className="small num">
                            {rateLines(m).map((r, i) => (
                              <span key={r}>
                                {i > 0 && <br />}
                                {r}
                              </span>
                            ))}
                          </span>
                        </td>
                        <td>{m.methodCode === freeCode && s.free.trim() ? <Badge tone="success">{freeLabel}</Badge> : m.freeOver ? <Badge tone="success">Over {formatMoney(m.freeOver)}</Badge> : <span className="xs muted">No</span>}</td>
                        <td>
                          <Switch id={`sh-${m.methodId}`} label={<span className="sr-only">{m.name} on</span>} checked={m.enabled} aria-checked={m.enabled} disabled={!canManage} onChange={(e) => set('methods', s.methods.map((x) => (x.methodId === m.methodId ? { ...x, enabled: e.target.checked } : x)))} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
          </Card>

          <Card title="Dispatch schedule" titleAs="h3" sub="Used to set each order's dispatch deadline">
            <div className="grid md2">
              <Field label="Handling time" error={handlingErr}>
                <Select id="sh-handle" options={handlingOptions.map((n) => ({ value: String(n), label: handlingLabel(n) }))} value={String(s.handlingDays)} disabled={!canManage} onChange={(e) => set('handlingDays', Number(e.target.value))} />
              </Field>
              <Field label="Same-day order cutoff" hint="Orders before the cutoff are due by 5:00 PM the same day.">
                <Select id="sh-cut" options={cutoffOptions.map((c) => ({ value: c, label: cutoffLabel(c) }))} value={s.cutoff} disabled={!canManage} onChange={(e) => set('cutoff', e.target.value)} />
              </Field>
            </div>
            <div className="stack gap-2">
              <span className="label">Business days</span>
              <div className="sa-days" role="group" aria-label="Business days">
                {DAYS.map((d) => (
                  <button key={d.key} type="button" className={cx('pill-opt', s.days[d.key] && 'is-selected')} aria-pressed={s.days[d.key]} data-toggle="" disabled={!canManage} onClick={() => set('days', { ...s.days, [d.key]: !s.days[d.key] })}>
                    {s.days[d.key] && <Icon name="check" className="ic-sm" />}
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="stack gap-2">
              <div className="row between">
                <span className="label">Holiday closures</span>
                {canManage && (
                  <Button variant="ghost" size="sm" icon="plus" onClick={openClosure}>
                    Add closure
                  </Button>
                )}
              </div>
              {st.dispatch.closures.length ? (
                <ul className="list">
                  {st.dispatch.closures.map((c) => (
                    <li key={c.id}>
                      <span className="grow small">
                        <b>{c.name}</b> · {dayRange(c.from, c.to)}
                      </span>
                      {canManage && (
                        <button type="button" className="icon-btn" aria-label={`Remove ${c.name} closure`} disabled={removeClosure.isPending} onClick={() => removeClosure.mutate(c.id)}>
                          <Icon name="trash-2" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">No closures planned.</p>
              )}
              <span className="hint">Arrival estimates skip closed days, and customers see a note during closures. Closures apply as soon as you add or remove them.</span>
            </div>
          </Card>

          <Card
            title="Return address"
            titleAs="h3"
            actions={
              canAddr && terms.data ? (
                <Button variant="ghost" size="sm" icon="pencil" onClick={() => openAddr(terms.data!)}>
                  Edit
                </Button>
              ) : undefined
            }
          >
            {terms.isError ? (
              <Alert tone="danger">
                {errorMessage(terms.error)}{' '}
                <Button variant="secondary" size="sm" onClick={() => void terms.refetch()}>
                  Try again
                </Button>
              </Alert>
            ) : ra ? (
              <div className="stack gap-0 small">
                <span className="strong">{ra.name}</span>
                <span>{[ra.line1, ra.line2].filter(Boolean).join(', ')}</span>
                <span>
                  {ra.city}, {ra.region} {ra.postalCode}
                </span>
                {(ra.phone || terms.data?.returnContactEmail) && <span className="muted">{[phoneText(ra.phone), terms.data?.returnContactEmail].filter(Boolean).join(' · ')}</span>}
              </div>
            ) : (
              <div className="stack gap-1" aria-hidden="true">
                <span className="sk sk-line short" />
                <span className="sk sk-line" />
                <span className="sk sk-line short" />
              </div>
            )}
            <p className="xs muted row gap-1 nowrap top">
              <Icon name="info" className="ic-sm" />
              <span className="wrap">Return labels and buyer instructions use this address. Changing it affects only returns opened after the change.</span>
            </p>
          </Card>

          <Card title="Shipping labels" titleAs="h3" sub="Where supported">
            <Switch id="sh-labels" label="Buy labels in Seller Center" checked={s.labels} aria-checked={s.labels} disabled={!canManage} onChange={(e) => set('labels', e.target.checked)} />
            <ul className="list">
              {st.labels.services.map((c) => (
                <li key={c.carrierName}>
                  <span className="grow small">{c.services.length ? c.services.join(', ') : c.carrierName}</span>
                  {!c.supported ? <Badge>Enter tracking manually</Badge> : s.labels ? <Badge tone="success">Supported</Badge> : <Badge>Labels off</Badge>}
                </li>
              ))}
            </ul>
            <p className="xs muted row gap-1 nowrap top">
              <Icon name="info" className="ic-sm" />
              <span className="wrap">Label cost is deducted from your earnings and shown on your statement.</span>
            </p>
          </Card>

          {canManage && (
            <div className="sa-savebar">
              <div className="stack gap-1">
                <span className="small strong">{dirtyAll.length ? `${dirtyAll.length} unsaved change${dirtyAll.length > 1 ? 's' : ''}` : 'All changes saved'}</span>
                <span className="xs muted">{dirtyAll.length ? sentence(dirtyAll) : lastSaved}</span>
              </div>
              <div className="row gap-2">
                <label className="sr-only" htmlFor="sh-when">
                  Effective
                </label>
                <Select id="sh-when" options={EFFECTIVE} value={effective} onChange={(e) => setEffective(e.target.value)} />
                <Button variant="ghost" onClick={discard} disabled={!dirtyAll.length || save.isPending}>
                  Discard
                </Button>
                <Button onClick={doSave} disabled={!dirtyAll.length || save.isPending}>
                  Save changes
                </Button>
              </div>
            </div>
          )}
        </div>

        <aside className="stack gap-5 sa-sticky">
          <Card title="What customers see" titleAs="h3" sub={`Example: ${preview.example}`}>
            <KeyValue
              pairs={[
                ['Price', preview.price ? formatMoney(preview.price) : '—'],
                ['Shipping', preview.shippingLabel],
                ['Arrives', preview.arrivesLabel],
                ['Dispatch', preview.dispatchLabel],
              ]}
            />
            {preview.cutoffNote && <div className="panel xs sub">{preview.cutoffNote}</div>}
            {dirtyAll.length > 0 && <span className="xs muted">Shows your saved settings. Save to see the changes here.</span>}
          </Card>
          <Card title="When changes apply" titleAs="h3">
            <p className="small sub">{st.applyNote}</p>
            <Timeline events={history} />
          </Card>
        </aside>
      </div>

      <Dialog
        open={closureOpen}
        onClose={() => setClosureOpen(false)}
        title="Add closure"
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setClosureOpen(false)}>
              Cancel
            </Button>
            <Button onClick={addClosure} disabled={addClosureM.isPending}>
              Add closure
            </Button>
          </>
        }
      >
        {closureErr && <Alert tone="danger">{closureErr}</Alert>}
        <Field label="Name" error={closureErrors.name}>
          <TextInput id="sh-cl-name" value={closure.name} error={!!closureErrors.name} placeholder="Inventory count" onChange={(e) => setClosure({ ...closure, name: e.target.value })} />
        </Field>
        <div className="grid md2 gap-3">
          <Field label="First closed day" error={closureErrors.from}>
            <TextInput id="sh-cl-from" type="date" min={dayKey()} value={closure.from} error={!!closureErrors.from} onChange={(e) => setClosure({ ...closure, from: e.target.value })} />
          </Field>
          <Field label="Last closed day" optional error={closureErrors.to}>
            <TextInput id="sh-cl-to" type="date" min={closure.from || dayKey()} value={closure.to} error={!!closureErrors.to} onChange={(e) => setClosure({ ...closure, to: e.target.value })} />
          </Field>
        </div>
        <span className="xs muted">Arrival estimates skip closed days.</span>
      </Dialog>

      <Dialog
        open={addrOpen}
        onClose={() => setAddrOpen(false)}
        title="Edit return address"
        foot={
          <>
            <Button variant="ghost" onClick={() => setAddrOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveAddr} disabled={saveAddrM.isPending}>
              Save address
            </Button>
          </>
        }
      >
        {addrErr && <Alert tone="danger">{addrErr}</Alert>}
        <Field label="Name" error={addrErrors.name}>
          <TextInput id="sh-ad-name" value={addr.name} error={!!addrErrors.name} onChange={(e) => setAddr({ ...addr, name: e.target.value })} />
        </Field>
        <Field label="Street address" error={addrErrors.line1}>
          <TextInput id="sh-ad-line1" value={addr.line1} error={!!addrErrors.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} />
        </Field>
        <Field label="City, state and ZIP code" error={addrErrors.city}>
          <TextInput id="sh-ad-city" value={addr.city} error={!!addrErrors.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} />
        </Field>
        <div className="grid md2 gap-3">
          <Field label="Phone">
            <PhoneInput id="sh-ad-phone" value={addr.phone} onChange={(e) => setAddr({ ...addr, phone: e.target.value })} />
          </Field>
          <Field label="Email" optional error={addrErrors.email}>
            <TextInput id="sh-ad-email" type="email" value={addr.email} error={!!addrErrors.email} onChange={(e) => setAddr({ ...addr, email: e.target.value })} />
          </Field>
        </div>
        <span className="xs muted">Changing it affects only returns opened after the change.</span>
      </Dialog>

      <Dialog
        open={methodOpen}
        onClose={() => setMethodOpen(false)}
        title="Add method"
        foot={
          <>
            <Button variant="ghost" onClick={() => setMethodOpen(false)}>
              Cancel
            </Button>
            <Button onClick={addMethod}>Add method</Button>
          </>
        }
      >
        <div className="grid md2 gap-3">
          <Field label="Method">
            <Select id="sh-mt-name" options={available.map((m) => ({ value: m.id, label: m.name }))} value={method.id} onChange={(e) => setMethod({ ...method, id: e.target.value })} />
          </Field>
          <Field label="Flat rate per package" error={methodErrors.rate}>
            <TextInput id="sh-mt-rate" prefix="$" value={method.rate} error={!!methodErrors.rate} inputMode="decimal" onChange={(e) => setMethod({ ...method, rate: e.target.value })} />
          </Field>
        </div>
        {chosenMethod && (
          <span className="xs muted">
            {chosenMethod.customerLabel}
            {chosenMethod.carrierServiceIds.length ? ` · ${chosenMethod.carrierServiceIds.map(serviceName).filter(Boolean).join(' or ')}` : ''}. The method is added when you save your changes.
          </span>
        )}
        {method.rate && isAmount(method.rate) && <span className="xs muted">Customers pay {money(Number(method.rate))} per package.</span>}
      </Dialog>
    </>
  );
}
