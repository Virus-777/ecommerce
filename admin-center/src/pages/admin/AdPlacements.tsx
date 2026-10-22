import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { fromZonedInput } from '@marketly/web-shared/lib/dates';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Button, Checkbox, DateTimeField, Field, Icon, PageHeader, Switch, TextInput } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { date, LoadError, SkeletonLines, TZ } from '@/app/parts';
import { AVAILABILITY, type GlobalRules, type Placement, type PlacementPatch } from './data/ads';
import { codeOf, fieldErrorsOf } from './data/departments';

// Admin › Advertisements › Slot settings (designed from the Marketly canvas: AdminSlotSettings; route /ads/placements).
// How each ad slot behaves, grouped like the Advertisements tabs: Full-screen | Carousels (Home, the four department
// carousels as one card, Deals) | Other (Category banner, Pop-up). Each card says in plain words what the placement
// does (built from its formats, frequency cap, rotation, trigger and dismissal) and edits inline: carousels the seconds
// per ad and live ads at most, overlays how often, pages and closing. Every change needs a reason (Action history).
// The department card changes the four department placements together (one PATCH each, same reason). Global rules:
// GET /rules, Edit rules sends PUT /rules, which always waits for Business Owner approval. Seller-ad and later-phase
// placements (inUse false) sit under Not in use. Data: GET/PATCH /api/admin/advertising/placements.

type Variant = 'fullscreen' | 'carousel' | 'category' | 'popup' | 'generic';
interface Slot {
  id: string;
  name: string;
  placements: Placement[];
  variant: Variant;
  /** The Advertisements tab or filter with the slot's ads */
  adsLink: string;
}

const DEPTS: Array<{ key: Placement['key']; name: string }> = [
  { key: 'software_top', name: 'Softwares' },
  { key: 'food_top', name: 'Food delivery' },
  { key: 'companies_top', name: 'Companies' },
  { key: 'play_top', name: 'Play center' },
];
const CAROUSELS = new Set<string>(['home_banner', 'deals_top', ...DEPTS.map((d) => d.key)]);
const variantOf = (p: Placement): Variant => (p.key === 'opening_fullscreen' ? 'fullscreen' : CAROUSELS.has(p.key) || p.rotation.mode === 'carousel' ? 'carousel' : p.key === 'category_banner' ? 'category' : p.key === 'popup' ? 'popup' : 'generic');

/** Short page names for the plain-words lines (Home, Category, Search…) */
const PAGE: Record<string, string> = { home: 'Home', category: 'Category', search: 'Search', product: 'Product pages', campaign: 'Campaign pages', collection: 'Collections', deals: 'Deals', brand: 'Brand pages', seller_store: 'Seller stores', official_store: 'Official Store', cart: 'Cart', account: 'Account', help: 'Help' };
const pageName = (p: string) => PAGE[p] ?? p.replace(/_/g, ' ');
const listOf = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const hasWeb = (p: Placement) => p.formats.some((f) => f.device === 'desktop');
function imageSize(p: Placement): string {
  const webOptional = !p.requiredDevices.includes('desktop');
  return (
    p.formats
      .map((f) => (f.device === 'phone' ? `Phone ${f.width} × ${f.height}` : f.device === 'desktop' ? `website ${f.width} × ${f.height}${webOptional ? ' (optional)' : ''}` : `${f.width} × ${f.height}`))
      .join(' · ') || '—'
  );
}
function whereOf(p: Placement): string {
  switch (p.key) {
    case 'opening_fullscreen':
      return `Right after the splash when the app opens${hasWeb(p) && p.eligiblePages.length ? ` · website: ${listOf(p.eligiblePages.map(pageName))}` : ''}`;
    case 'home_banner':
      return 'Top of the app’s Home';
    case 'deals_top':
      return 'Top of the Deals tab';
    case 'category_banner':
      return `Top of category pages${hasWeb(p) ? ' · app and website' : ''}`;
    case 'popup':
      return `Over ${listOf(p.eligiblePages.map(pageName)) || 'the pages it is set for'}`;
    default:
      return p.description;
  }
}
function howOften(p: Placement, v: Variant): string {
  const c = p.frequencyCap;
  const parts = [
    c?.perSession && !(v === 'fullscreen' && c.perSession === 1) ? (c.perSession === 1 ? 'once per visit' : `at most ${c.perSession} per visit`) : '',
    c?.perDay ? (c.perDay === 1 ? 'once a day' : `at most ${c.perDay} a day`) : '',
    c?.perWindow ? `at most ${c.perWindow.count} per person every ${c.perWindow.days} days` : '',
    c?.perCampaign ? `at most ${c.perCampaign} of each ad per person` : '',
  ].filter(Boolean);
  if (v === 'fullscreen') return ['One each time the app opens', ...parts].join(' · ');
  return parts.length ? cap(parts.join(' · ')) : 'No limit';
}
function closing(p: Placement, v: Variant): string {
  const d = p.dismissal;
  if (d.mode === 'not_dismissible') return v === 'carousel' || v === 'category' ? 'Banners can’t be closed' : 'Can’t be closed';
  if (d.mode === 'session') return v === 'fullscreen' ? 'Hides full-screen ads for the rest of the visit' : 'Hides that ad for the rest of the visit';
  if (d.mode === 'days') return `Hides that ad for ${plural(d.days ?? 1, 'day')}`;
  return 'Hides that ad until it ends';
}
function when(p: Placement): string {
  const t = p.trigger;
  if (!t) return 'As the page opens';
  const at = [t.afterSeconds ? `after ${t.afterSeconds} s` : '', t.scrollPct ? `${t.scrollPct}% scroll` : ''].filter(Boolean).join(' or ');
  return cap([at || 'as the page opens', t.skipIfOverlayShownThisSession ? 'never after a full-screen ad' : ''].filter(Boolean).join(' · '));
}
/** One value for every department, or each department's own */
const perDept = (ps: Placement[], f: (p: Placement) => string, suffix = '') => {
  const vals = ps.map(f);
  return vals.every((x) => x === vals[0]) ? `${vals[0]}${suffix}` : ps.map((p, i) => `${DEPTS.find((d) => d.key === p.key)?.name ?? p.name} ${vals[i]}`).join(' · ');
};
function rowsOf(s: Slot): Array<[string, string]> {
  const p = s.placements[0]!;
  const v = s.variant;
  if (v === 'fullscreen') return [['Image size', imageSize(p)], ['How often', howOften(p, v)], ['Order', p.rotation.label], ['Closing', closing(p, v)]];
  if (v === 'carousel')
    return [
      ['Image size', imageSize(p)],
      ['Rotation', perDept(s.placements, (x) => x.rotation.label)],
      ['Live ads at most', perDept(s.placements, (x) => String(x.maxPerPage ?? 10), s.placements.length > 1 ? ' per department' : '')],
      ['Closing', closing(p, v)],
    ];
  if (v === 'category') return [['Image size', imageSize(p)], ['Which ad', p.rotation.mode === 'category_match_then_priority' ? 'Ads for that category first, then the rest take turns in order' : p.rotation.label], ['Per page', (p.maxPerPage ?? 1) === 1 ? 'One banner' : `${p.maxPerPage} banners`], ['Closing', closing(p, v)]];
  if (v === 'popup') return [['Image size', imageSize(p)], ['When', when(p)], ['How often', howOften(p, v)], ['Order', p.rotation.label], ['Closing', closing(p, v)]];
  return [['Pages', p.pagesLabel], ['Image size', imageSize(p)], ['How often', howOften(p, v)], ['Order', p.rotation.label], ['Closing', closing(p, v)]];
}

/* ---------------- Edit form ---------------- */

type Draft = { seconds: string; max: string; perSession: string; perDay: string; windowCount: string; windowDays: string; days: string; after: string; scroll: string; perPage: string; pages: string[]; reason: string };
type DraftErrors = Partial<Record<keyof Draft, string>>;
const txt = (n?: number | null) => (n == null ? '' : String(n));
const int = (s: string) => (s.trim() === '' ? null : Number(s.trim()));
const draftOf = (p: Placement): Draft => ({
  seconds: txt(p.rotation.carouselSeconds ?? 6),
  max: txt(p.maxPerPage ?? 10),
  perSession: txt(p.frequencyCap?.perSession),
  perDay: txt(p.frequencyCap?.perDay),
  windowCount: txt(p.frequencyCap?.perWindow?.count),
  windowDays: txt(p.frequencyCap?.perWindow?.days ?? 7),
  days: txt(p.dismissal.days ?? 7),
  after: txt(p.trigger?.afterSeconds),
  scroll: txt(p.trigger?.scrollPct),
  perPage: txt(p.maxPerPage ?? 1),
  pages: p.eligiblePages,
  reason: '',
});
const rotationInput = (p: Placement, seconds?: number | null) => ({ mode: p.rotation.mode, carouselSeconds: seconds ?? p.rotation.carouselSeconds ?? null, maxInRotation: p.rotation.maxInRotation ?? null, pauseOnHoverAndFocus: p.rotation.pauseOnHoverAndFocus });

function problemsOf(d: Draft, v: Variant, p: Placement): DraftErrors {
  const e: DraftErrors = {};
  const range = (k: keyof Draft, lo: number, hi: number, optional = false) => {
    const s = (d[k] as string).trim();
    if (!s && optional) return;
    if (!/^\d+$/.test(s) || Number(s) < lo || Number(s) > hi) e[k] = optional ? `${lo} to ${hi}, or leave it empty.` : `${lo} to ${hi}.`;
  };
  if (v === 'carousel') {
    range('seconds', 2, 15);
    range('max', 1, 20);
  }
  if (v === 'category') range('perPage', 1, 5);
  if (v === 'fullscreen' || v === 'popup' || v === 'generic') {
    range('perSession', 1, 20, true);
    if (v !== 'fullscreen') range('perDay', 1, 50, true);
    if (v === 'fullscreen') {
      range('windowCount', 1, 50, true);
      if (d.windowCount.trim()) range('windowDays', 1, 90);
    }
    if (p.dismissal.mode === 'days') range('days', 1, 90);
  }
  if (v === 'popup') {
    range('after', 0, 120, true);
    range('scroll', 1, 100, true);
  }
  if ((v === 'popup' || v === 'generic' || (v === 'fullscreen' && p.pageOptions.length > 0)) && p.pageOptions.length > 0 && !d.pages.length) e.pages = 'Pick at least one page.';
  if (!d.reason.trim()) e.reason = 'Enter a reason. It is kept in Action history.';
  return e;
}
function bodyOf(d: Draft, v: Variant, p: Placement): Omit<PlacementPatch, 'version' | 'reason'> {
  const fc = p.frequencyCap;
  const pages = p.pageOptions.length ? { eligiblePages: d.pages } : {};
  const dismissal = p.dismissal.mode === 'days' ? { dismissal: { mode: 'days' as const, days: int(d.days) } } : {};
  if (v === 'carousel') return { rotation: rotationInput(p, int(d.seconds)), maxPerPage: int(d.max) };
  if (v === 'category') return { maxPerPage: int(d.perPage) };
  if (v === 'fullscreen') return { ...pages, ...dismissal, frequencyCap: { perSession: int(d.perSession), perDay: fc?.perDay ?? null, perWindow: d.windowCount.trim() ? { count: Number(d.windowCount), days: Number(d.windowDays) } : null, perCampaign: fc?.perCampaign ?? null } };
  const freq = { frequencyCap: { perSession: int(d.perSession), perDay: int(d.perDay), perWindow: fc?.perWindow ?? null, perCampaign: fc?.perCampaign ?? null } };
  if (v === 'popup') return { ...pages, ...dismissal, ...freq, trigger: { afterSeconds: int(d.after), scrollPct: int(d.scroll), skipIfOverlayShownThisSession: p.trigger?.skipIfOverlayShownThisSession ?? true } };
  return { ...pages, ...dismissal, ...freq, maxPerPage: d.perPage.trim() ? int(d.perPage) : (p.maxPerPage ?? null) };
}
/** API issue paths → the form's fields */
const FIELD: Record<string, keyof Draft> = { 'rotation.carouselSeconds': 'seconds', maxPerPage: 'max', eligiblePages: 'pages', 'frequencyCap.perSession': 'perSession', 'frequencyCap.perDay': 'perDay', 'frequencyCap.perWindow': 'windowCount', 'trigger.afterSeconds': 'after', 'trigger.scrollPct': 'scroll', 'dismissal.days': 'days', reason: 'reason' };
const fieldOf = (path: string, v: Variant): keyof Draft => {
  const k = FIELD[path] ?? FIELD[path.split('.').slice(0, 2).join('.')] ?? FIELD[path.split('.')[0] ?? ''] ?? 'reason';
  return k === 'max' && v === 'category' ? 'perPage' : k;
};

function SlotEditor({ slot, onCancel, onSaved }: { slot: Slot; onCancel: () => void; onSaved: (msg: string) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const p = slot.placements[0]!;
  const v = slot.variant;
  const [d, setD] = useState<Draft>(() => draftOf(p));
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<DraftErrors>({});
  const [error, setError] = useState('');
  const client = tried ? problemsOf(d, v, p) : {};
  const err = (k: keyof Draft) => client[k] || server[k] || '';
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const id = (k: string) => `ss-${slot.id}-${k}`;

  const save = useMutation({
    mutationFn: () => Promise.all(slot.placements.map((x) => call(api.PATCH('/api/admin/advertising/placements/{id}', { params: { path: { id: x.id } }, body: { ...bodyOf(d, v, x), reason: d.reason.trim(), version: x.version } as PlacementPatch })) as Promise<Placement>)),
    onSuccess: (updated) => {
      qc.setQueryData<Placement[]>(['advertising', 'placements'], (l) => l?.map((x) => updated.find((u) => u.id === x.id) ?? x));
      void qc.invalidateQueries({ queryKey: ['advertising', 'staff-ads'] });
      onSaved(`${slot.name} saved. New displays use it now; the change is in Action history.`);
    },
    onError: (e) => {
      const fe = fieldErrorsOf(e);
      const mapped: DraftErrors = {};
      Object.entries(fe).forEach(([path, msg]) => (mapped[fieldOf(path, v)] ||= msg));
      if (codeOf(e) === 'PAGE_NOT_ELIGIBLE') mapped.pages ||= errorMessage(e);
      setServer(mapped);
      if (codeOf(e) === 'CONFLICT') void qc.invalidateQueries({ queryKey: ['advertising', 'placements'] });
      setError(codeOf(e) === 'CONFLICT' ? 'Someone changed this slot meanwhile. The page shows their version now: check it and save again.' : Object.keys(fe).length || codeOf(e) === 'PAGE_NOT_ELIGIBLE' ? 'Fix the fields marked below.' : errorMessage(e));
    },
  });
  const submit = () => {
    setTried(true);
    setError('');
    if (Object.values(problemsOf(d, v, p)).some(Boolean)) return;
    setServer({});
    save.mutate();
  };
  const num = (k: keyof Draft, label: string, unit: string, hint?: string, optional?: boolean) => (
    <Field label={label} hint={hint} error={err(k)} optional={optional}>
      <TextInput id={id(k)} inputMode="numeric" suffix={unit} value={d[k] as string} error={!!err(k)} onChange={(e) => set({ [k]: e.target.value })} />
    </Field>
  );
  const pages = p.pageOptions.length > 0 && v !== 'carousel' && v !== 'category' && (
    <div className="field">
      <span className="label">{v === 'fullscreen' ? 'Website pages' : 'Shows on'}</span>
      <div className="row gap-3">
        {p.pageOptions.map((o) => (
          <Checkbox key={o} id={id(`page-${o}`)} label={pageName(o)} checked={d.pages.includes(o)} onChange={(e) => set({ pages: e.target.checked ? p.pageOptions.filter((x) => x === o || d.pages.includes(x)) : d.pages.filter((x) => x !== o) })} />
        ))}
      </div>
      {err('pages') ? <span className="error-text">{err('pages')}</span> : <span className="hint">Only the pages this slot can show on are listed</span>}
    </div>
  );

  return (
    <>
      <div className="card-body" style={{ gap: 16 }}>
        {error && <Alert tone="danger" title={error} />}
        {v === 'carousel' && (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
            {num('seconds', 'Each ad shows for', 'seconds', '2 to 15 seconds; a swipe restarts the timer')}
            {num('max', 'Live ads at most', 'ads', `1 to 20; more can be scheduled${slot.placements.length > 1 ? ' · for each department' : ''}`)}
          </div>
        )}
        {v === 'category' && <div className="grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>{num('perPage', 'Banners per page', 'banners', '1 to 5')}</div>}
        {v === 'fullscreen' && (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
            {num('perSession', 'At most per visit', 'ads', 'Empty: one each time the app opens', true)}
            {num('windowCount', 'At most per person', 'ads', 'Empty: no limit', true)}
            {d.windowCount.trim() && num('windowDays', 'In every', 'days', '1 to 90')}
            {p.dismissal.mode === 'days' && num('days', 'Closing hides it for', 'days', '1 to 90')}
          </div>
        )}
        {(v === 'popup' || v === 'generic') && (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
            {v === 'popup' && num('after', 'Shows after', 'seconds', 'Empty: not by time', true)}
            {v === 'popup' && num('scroll', 'Or after scrolling', '%', 'Empty: not by scrolling', true)}
            {num('perSession', 'At most per visit', 'times', 'Empty: no limit', true)}
            {num('perDay', 'At most per day', 'times', 'Empty: no limit', true)}
            {v === 'generic' && num('perPage', 'Most ads per page', 'ads', 'Empty: no limit', true)}
            {p.dismissal.mode === 'days' && num('days', 'Closing hides that ad for', 'days', '1 to 90')}
          </div>
        )}
        {pages}
        <div className="field">
          <span className="label">Image size</span>
          <span className="small muted">{imageSize(p)} (set by the slot)</span>
        </div>
        <Field label="Reason for the change" hint="Kept in Action history" error={err('reason')}>
          <TextInput id={id('reason')} value={d.reason} maxLength={200} error={!!err('reason')} onChange={(e) => set({ reason: e.target.value })} />
        </Field>
      </div>
      <div className="card-foot">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </>
  );
}

/* ---------------- Global rules ---------------- */

const BASE_BLOCKED = new Set(['checkout', 'payment_result', 'order_tracking', 'returns']);
function ruleLines(r: GlobalRules): Array<{ t: string; d: string; locked?: boolean }> {
  const extra = r.blockedPages.filter((p) => !BASE_BLOCKED.has(p)).map(pageName);
  return [
    { t: 'Never cover checkout, payment results, tracking or returns', d: `Full-screen ads and pop-ups don’t show on those screens${extra.length ? ` or on ${listOf(extra)}` : ''}` },
    { t: r.overlaysPerPageView === 0 ? 'No overlays' : r.overlaysPerPageView === 1 ? 'One overlay at a time' : `At most ${r.overlaysPerPageView} overlays per page`, d: r.overlaysPerPageView === 0 ? 'Full-screen ads and pop-ups are turned off' : r.overlaysPerPageView === 1 ? 'A full-screen ad and a pop-up never stack' : 'Full-screen ads and pop-ups on the same page view' },
    { t: 'Ad label on every ad', d: '“Ad” on banners and overlays, “Sponsored” on product and store cards', locked: true },
    { t: 'A visible close button', d: `At least ${r.closeControlMinPx} px on phones and reachable with the keyboard` },
    ...(r.removeUnavailable ? [{ t: 'Remove unavailable or expired ads', d: 'Ads stop when the promoted offer sells out or the ad ends' }] : []),
    ...(r.dismissStopsForSession ? [{ t: 'Closing an overlay stops overlays for the visit', d: 'After someone closes a full-screen ad or pop-up, no other one shows until they come back' }] : []),
  ];
}

function RulesEditor({ rules, onCancel, onSent }: { rules: GlobalRules; onCancel: () => void; onSent: (r: GlobalRules) => void }) {
  const { api } = useApi();
  const [overlays, setOverlays] = useState(String(rules.overlaysPerPageView));
  const [px, setPx] = useState(String(rules.closeControlMinPx));
  const [stops, setStops] = useState(rules.dismissStopsForSession);
  const [attribution, setAttribution] = useState(String(rules.attributionDays));
  const [effective, setEffective] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const send = useMutation({
    mutationFn: () =>
      call(
        api.PUT('/api/admin/advertising/rules', {
          body: { overlaysPerPageView: Number(overlays), closeControlMinPx: Number(px), dismissStopsForSession: stops, attributionDays: Number(attribution), effectiveAt: effective ? fromZonedInput(effective, TZ) : null, reason: reason.trim() },
        }),
      ),
    onSuccess: onSent,
    onError: (e) => setErrors({ ...Object.fromEntries(Object.entries(fieldErrorsOf(e)).map(([k, m]) => [k.split('.')[0], m])), form: errorMessage(e) }),
  });
  const submit = () => {
    const e: Record<string, string> = {};
    if (!/^\d+$/.test(overlays) || Number(overlays) > 2) e.overlaysPerPageView = '0 to 2.';
    if (!/^\d+$/.test(px) || Number(px) < 44) e.closeControlMinPx = 'At least 44 px.';
    if (!/^\d+$/.test(attribution) || Number(attribution) < 1 || Number(attribution) > 30) e.attributionDays = '1 to 30 days.';
    if (!reason.trim()) e.reason = 'Enter a reason. The Business Owner sees it.';
    setErrors(e);
    if (!Object.keys(e).length) send.mutate();
  };
  return (
    <>
      <div className="card-body" style={{ gap: 16 }}>
        {errors.form && <Alert tone="danger" title={errors.form} />}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
          <Field label="Overlays per page at most" hint="0 turns full-screen ads and pop-ups off · 1 keeps one overlay at a time" error={errors.overlaysPerPageView}>
            <TextInput id="gr-overlays" inputMode="numeric" value={overlays} error={!!errors.overlaysPerPageView} onChange={(e) => setOverlays(e.target.value)} />
          </Field>
          <Field label="Close button size on phones" hint="44 px at least" error={errors.closeControlMinPx}>
            <TextInput id="gr-px" inputMode="numeric" suffix="px" value={px} error={!!errors.closeControlMinPx} onChange={(e) => setPx(e.target.value)} />
          </Field>
          <Field label="A purchase counts for an ad within" hint="Days after a click" error={errors.attributionDays}>
            <TextInput id="gr-attr" inputMode="numeric" suffix="days" value={attribution} error={!!errors.attributionDays} onChange={(e) => setAttribution(e.target.value)} />
          </Field>
          <Field label="Effective from" optional hint="Empty: as soon as it’s approved · Pacific time" error={errors.effectiveAt}>
            <DateTimeField id="gr-eff" value={effective} onChange={setEffective} />
          </Field>
        </div>
        <Switch id="gr-stops" label="Closing an overlay stops overlays for the rest of the visit" checked={stops} onChange={(e) => setStops(e.target.checked)} />
        <span className="xs muted">The Ad label rule is always on. Checkout, payment results, tracking and returns are always kept free of overlays.</span>
        <Field label="Reason for the change" hint="The Business Owner sees it; kept in Action history" error={errors.reason}>
          <TextInput id="gr-reason" value={reason} maxLength={200} error={!!errors.reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <div className="card-foot">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={send.isPending}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={send.isPending}>
          {send.isPending ? 'Sending…' : 'Send for approval'}
        </Button>
      </div>
    </>
  );
}

/* ---------------- Page ---------------- */

export default function AdPlacements() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const canManage = can('advertising.placements.manage');
  const canRules = can('advertising.rules.manage');
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const list = useQuery({ queryKey: ['advertising', 'placements'], queryFn: () => call(api.GET('/api/admin/advertising/placements')) as Promise<Placement[]> });
  const rules = useQuery({ queryKey: ['advertising', 'rules'], queryFn: () => call(api.GET('/api/admin/advertising/rules')) as Promise<GlobalRules> });

  const toggle = useMutation({
    mutationFn: ({ slot, on }: { slot: Slot; on: boolean }) =>
      Promise.all(slot.placements.filter((p) => p.enabled !== on).map((p) => call(api.PATCH('/api/admin/advertising/placements/{id}', { params: { path: { id: p.id } }, body: { enabled: on, reason: on ? 'Turned on in Slot settings' : 'Turned off in Slot settings', version: p.version } })) as Promise<Placement>)),
    onSuccess: (updated, { slot, on }) => {
      qc.setQueryData<Placement[]>(['advertising', 'placements'], (l) => l?.map((x) => updated.find((u) => u.id === x.id) ?? x));
      void qc.invalidateQueries({ queryKey: ['advertising', 'staff-ads'] });
      const msg = `${slot.name} turned ${on ? 'on' : 'off'}. ${on ? 'Its live ads show again' : 'Its ads stop showing'} for new displays; the change is in Action history.`;
      setNotice(msg);
      announce(msg);
    },
    onError: (e) => {
      if (codeOf(e) === 'CONFLICT') void list.refetch();
    },
  });
  const saved = (msg: string) => {
    setEditing(null);
    setNotice(msg);
    announce(msg);
  };

  const all = list.data ?? [];
  const byKey = new Map(all.map((p) => [p.key as string, p]));
  const single = (key: string, tab?: string): Slot | null => {
    const p = byKey.get(key);
    return p && p.inUse ? { id: p.id, name: p.name, placements: [p], variant: variantOf(p), adsLink: href('admin/ads', '', undefined, tab ? { tab } : { placement: p.key }) } : null;
  };
  const deptPlacements = DEPTS.map((d) => byKey.get(d.key)).filter((p): p is Placement => !!p && p.inUse);
  const deptSlot: Slot | null = deptPlacements.length ? { id: 'departments', name: 'Department carousels', placements: deptPlacements, variant: 'carousel', adsLink: href('admin/ads', '', undefined, { tab: 'departments' }) } : null;
  const groups: Array<{ name: string; slots: Slot[] }> = [
    { name: 'Full-screen', slots: [single('opening_fullscreen', 'fullscreen')] },
    { name: 'Carousels', slots: [single('home_banner', 'home'), deptSlot, single('deals_top', 'deals')] },
    { name: 'Other', slots: [single('category_banner'), single('popup')] },
  ].map((g) => ({ name: g.name, slots: g.slots.filter((s): s is Slot => !!s) }));
  // a slot in use that no group names (a new one) goes under Other
  const grouped = new Set(groups.flatMap((g) => g.slots.flatMap((s) => s.placements.map((p) => p.id))));
  all.filter((p) => p.inUse && !grouped.has(p.id)).forEach((p) => groups[2]!.slots.push({ id: p.id, name: p.name, placements: [p], variant: variantOf(p), adsLink: href('admin/ads') }));
  const unused = all.filter((p) => !p.inUse);

  const card = (s: Slot) => {
    const isEditing = editing === s.id;
    const on = s.placements.every((p) => p.enabled);
    const some = !on && s.placements.some((p) => p.enabled);
    const live = s.placements.reduce((n, p) => n + p.liveCampaigns, 0);
    const where = s.id === 'departments' ? 'Top of Softwares, Food delivery, Companies and Play center' : whereOf(s.placements[0]!);
    const breakdown = s.placements.length > 1 ? s.placements.map((p) => `${DEPTS.find((d) => d.key === p.key)?.name ?? p.name} ${p.liveCampaigns}${p.enabled ? '' : ' (off)'}`).join(' · ') : '';
    return (
      <section key={s.id} className="card" style={{ display: 'flex', flexDirection: 'column', ...(isEditing ? { boxShadow: '0 0 0 3px var(--brand-soft-2)' } : {}), ...(!on && !some ? { opacity: 0.85 } : {}) }}>
        <div className="card-head" style={{ flexWrap: 'nowrap' }}>
          <div className="stack gap-0" style={{ minWidth: 0, gap: 2 }}>
            <h3 className="h4">{s.name}</h3>
            <span className="xs muted">{where}</span>
          </div>
          <Switch id={`ss-on-${s.id}`} label={on ? 'On' : some ? 'Some on' : 'Off'} checked={on} disabled={!canManage || toggle.isPending} onChange={(e) => toggle.mutate({ slot: s, on: e.target.checked })} className="none" />
        </div>
        {isEditing ? (
          <SlotEditor slot={s} onCancel={() => setEditing(null)} onSaved={saved} />
        ) : (
          <>
            <div className="card-body" style={{ gap: 0, paddingTop: 4, paddingBottom: 4 }}>
              {rowsOf(s).map(([k, v]) => (
                <div key={k} style={{ display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                  <span className="muted">{k}</span>
                  <span>{v}</span>
                </div>
              ))}
            </div>
            <div className="card-foot" style={{ justifyContent: 'space-between', marginTop: 'auto' }}>
              <span className="stack gap-0" style={{ minWidth: 0 }}>
                <Link className="xs strong" to={s.adsLink} title={breakdown || undefined}>
                  {plural(live, 'live ad')} →
                </Link>
                {breakdown && <span className="xs muted">{breakdown}</span>}
              </span>
              {canManage && (
                <Button variant="secondary" size="sm" onClick={() => setEditing(s.id)}>
                  Edit<span className="sr-only"> {s.name}</span>
                </Button>
              )}
            </div>
          </>
        )}
      </section>
    );
  };

  return (
    <AdminLayout active="ads">
      <PageHeader
        crumbs={[{ label: 'Admin' }, { label: 'Advertisements', to: href('admin/ads') }]}
        title="Slot settings"
        sub="How each ad slot behaves. Changes apply to new displays at once and are recorded in Action history."
        actions={
          <Button variant="secondary" size="sm" icon="history" to={href('admin/audit')}>
            Action history
          </Button>
        }
      />
      {notice && <Alert tone="success" title={notice} />}
      {toggle.error && (
        <Alert tone="danger" title="The slot wasn’t switched">
          {codeOf(toggle.error) === 'CONFLICT' ? 'Someone changed it meanwhile. The page shows their version now: try again.' : errorMessage(toggle.error)}
        </Alert>
      )}
      {!canManage && <Alert tone="info" title="View only">Changing slots needs the placement management permission (Advertising Manager).</Alert>}
      {list.error && <LoadError error={list.error} onRetry={() => void list.refetch()} />}
      {!list.data && !list.error && <SkeletonLines rows={8} />}

      {list.data &&
        groups
          .filter((g) => g.slots.length)
          .map((g) => (
            <section key={g.name} className="stack" style={{ gap: 12 }}>
              <h2 className="h3" style={{ margin: '4px 0 0' }}>
                {g.name}
              </h2>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 420px), 1fr))', gap: 16, alignItems: 'start' }}>
                {g.slots.map(card)}
              </div>
            </section>
          ))}

      <section className="card">
        <div className="card-head">
          <div className="stack gap-0" style={{ gap: 2 }}>
            <h2 className="h4">Rules for every ad</h2>
            {rules.data && (
              <span className="xs muted">
                Version {rules.data.version}, effective {date(rules.data.effectiveAt)} · changing them needs Business Owner approval
                {rules.data.approval?.required ? ' · a change is waiting for approval' : ''}
              </span>
            )}
          </div>
          {canRules && rules.data && editing !== 'rules' && (
            <Button variant="secondary" size="sm" onClick={() => setEditing('rules')} disabled={!!rules.data.approval?.required}>
              Edit rules
            </Button>
          )}
        </div>
        {rules.error ? (
          <div className="card-body">
            <LoadError error={rules.error} onRetry={() => void rules.refetch()} />
          </div>
        ) : !rules.data ? (
          <div className="card-body">
            <SkeletonLines rows={4} />
          </div>
        ) : editing === 'rules' ? (
          <RulesEditor
            rules={rules.data}
            onCancel={() => setEditing(null)}
            onSent={(r) => {
              qc.setQueryData(['advertising', 'rules'], r);
              saved('Sent for Business Owner approval. The new rules take effect once approved.');
            }}
          />
        ) : (
          <ul className="list pad">
            {ruleLines(rules.data).map((r) => (
              <li key={r.t}>
                <Icon name="check" className="ic-sm t-success-text" />
                <span className="stack gap-0 grow" style={{ minWidth: 0 }}>
                  <span className="small strong">{r.t}</span>
                  <span className="xs muted">{r.d}</span>
                </span>
                {r.locked && <Badge tone="outline">Always on</Badge>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {list.data && unused.length > 0 && (
        <details className="card" style={{ padding: 0 }}>
          <summary style={{ padding: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, listStyle: 'none' }}>
            <Icon name="chevron-right" className="ic-sm" />
            <span className="h4">Not in use</span>
            <span className="count">{unused.length}</span>
            <span className="xs muted" style={{ marginLeft: 8 }}>
              {unused.map((p) => p.name).join(', ')} — for seller ads and later phases
            </span>
          </summary>
          <div className="stack" style={{ gap: 12, padding: '0 16px 16px' }}>
            {unused.map((p) => {
              const s: Slot = { id: p.id, name: p.name, placements: [p], variant: 'generic', adsLink: href('admin/ads') };
              const stage = AVAILABILITY[p.availability];
              return (
                <section key={p.id} className="card" style={editing === p.id ? { boxShadow: '0 0 0 3px var(--brand-soft-2)' } : undefined}>
                  <div className="card-head" style={{ flexWrap: 'nowrap' }}>
                    <div className="stack gap-0" style={{ minWidth: 0, gap: 2 }}>
                      <h3 className="h4">
                        {p.name} <Badge tone={stage.tone}>{stage.label}</Badge>
                      </h3>
                      <span className="xs muted">{p.description}</span>
                    </div>
                    <Switch id={`ss-on-${p.id}`} label={p.enabled ? 'Enabled' : 'Off'} checked={p.enabled} disabled={!canManage || toggle.isPending || p.availability === 'later'} onChange={(e) => toggle.mutate({ slot: s, on: e.target.checked })} />
                  </div>
                  {editing === p.id ? (
                    <SlotEditor slot={s} onCancel={() => setEditing(null)} onSaved={saved} />
                  ) : (
                    <>
                      <div className="card-body" style={{ gap: 0, paddingTop: 4, paddingBottom: 4 }}>
                        {rowsOf(s).map(([k, v]) => (
                          <div key={k} style={{ display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr)', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                            <span className="muted">{k}</span>
                            <span>{v}</span>
                          </div>
                        ))}
                      </div>
                      <div className="card-foot" style={{ justifyContent: 'space-between' }}>
                        <span className="xs muted">{p.enabled ? plural(p.liveCampaigns, 'live campaign') : p.availability === 'later' ? 'Turn on when approval and billing are ready' : 'Off: no new displays'}</span>
                        {canManage && p.availability !== 'later' && (
                          <Button variant="ghost" size="sm" icon="pencil" onClick={() => setEditing(p.id)}>
                            Edit rules<span className="sr-only"> of {p.name}</span>
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </section>
              );
            })}
            {rules.data && (
              <p className="xs muted" style={{ margin: 0 }}>
                Paid seller ads are {rules.data.paidSellerAdsEnabled ? 'on' : 'off'} · a purchase counts for an ad within {plural(rules.data.attributionDays, 'day')} of a click
                {rules.data.sellerNamedOnPromotedOffers ? ' · the seller behind a promoted offer is always named, and seller ad content is reviewed before it runs' : ''}
              </p>
            )}
          </div>
        </details>
      )}
    </AdminLayout>
  );
}

