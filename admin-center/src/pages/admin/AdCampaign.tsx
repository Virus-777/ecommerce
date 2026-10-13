import { Fragment, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, call, errorMessage, uploadMedia, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useScrollRegion, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Breadcrumbs, Button, Card, EmptyState, Field, Icon, Img, SegmentedControl, Select, Textarea, TextInput, type IconName } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { dateTime, LoadError, shortDate, SkeletonLines, time } from '@/app/parts';
import { runCampaignAction, CampaignActionDialog, type CampaignAction, type PendingAction } from './data/ad-actions';
import {
  AVAILABILITY, checkTone, fromZonedInput, num, pageLabel, placementIcon, statusLabel, toPacificInput,
  reviewRolesOf, REVIEW_ROLE_LABEL, type ReviewRole, type AdCampaign as Campaign, type AdCampaignInput, type AdImpression, type AdPreview as Preview, type CampaignCheckResult, type Creative, type Page, type Placement, type ReviewCheck,
} from './data/ads';

// Design: pages/admin/admin-ad-campaign.html (step 1) and --placement-audience, --schedule-limits,
// --creative-preview, --approval (steps 2–5). One draft object is kept across the steps; the step is the view.
// A new campaign is created as a draft on the first save (POST /api/admin/advertising/campaigns) and then
// edited with PATCH {changes, version}; the URL carries ?ref=AD-… (resolved through the list search) or ?id=.
// Creatives: images uploaded through media (purpose ad_creative) + POST …/creatives; the ad text is a text creative.
// Step 4 runs POST …/check and GET …/preview; step 5 submits, and reviewers approve or send back from there.

type Step = '' | 'placement-audience' | 'schedule-limits' | 'creative-preview' | 'approval';
const STEPS: Array<{ view: Step; label: string; next?: string }> = [
  { view: '', label: 'Goal & advertiser', next: 'Continue to placement & audience' },
  { view: 'placement-audience', label: 'Placement & audience', next: 'Continue to schedule & limits' },
  { view: 'schedule-limits', label: 'Schedule & limits', next: 'Continue to creative & preview' },
  { view: 'creative-preview', label: 'Creative & preview', next: 'Continue to approval' },
  { view: 'approval', label: 'Approval' },
];

type AdvKind = 'platform' | 'seller' | 'brand' | 'official_store';
const ADVERTISERS: Array<{ kind: AdvKind; title: string; body: string; summary: string; short: string }> = [
  { kind: 'platform', title: 'Marketly (own promotion)', body: 'No charge. Owned by Advertising.', summary: 'Marketly · own promotion', short: 'own promotion' },
  { kind: 'seller', title: 'Seller (paid)', body: 'Seller request with spending limit and billing', summary: 'Seller · paid', short: 'seller paid' },
  { kind: 'brand', title: 'Brand (paid)', body: 'Brand campaign across sellers', summary: 'Brand · paid', short: 'brand paid' },
  { kind: 'official_store', title: 'Official Store product', body: 'Company product promotion', summary: 'Official Store product', short: 'Official Store product' },
];
const GOALS: Array<{ value: AdCampaignInput['goal']; label: string }> = [
  { value: 'company_promotion', label: 'Company promotion' },
  { value: 'platform_event', label: 'Platform event' },
  { value: 'seller_offer', label: 'Seller offer' },
  { value: 'brand_campaign', label: 'Brand campaign' },
];
const REGIONS = [
  { value: 'us', label: 'All of the United States', regions: [] as string[] },
  { value: 'west', label: 'West Coast: CA, OR, WA', regions: ['CA', 'OR', 'WA'] },
  { value: 'mountain', label: 'Mountain: CO, ID, NV, UT', regions: ['CO', 'ID', 'NV', 'UT'] },
];
const VISITORS = [
  { value: 'all', label: 'New and returning' },
  { value: 'new', label: 'New visitors only' },
  { value: 'returning', label: 'Returning visitors only' },
];
const SIGN_IN = [
  { value: 'signed_in', label: 'Signed-in customers only' },
  { value: 'everyone', label: 'Everyone, including guests' },
];
const TIME_ZONES = [
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)', short: 'PT' },
  { value: 'America/New_York', label: 'Eastern Time (ET)', short: 'ET' },
];
const FREQUENCIES = [
  { value: 'session', label: 'Once per session', cap: { perSession: 1, label: 'Once per session' } },
  { value: 'day', label: 'Once per day', cap: { perDay: 1, label: 'Once a day' } },
  { value: 'campaign', label: 'Once per campaign', cap: { perCampaign: 1, label: 'Once per campaign' } },
  { value: 'week2', label: 'Twice per week', cap: { perWindow: { count: 2, days: 7 }, label: 'Twice per week' } },
];
const DISMISS = [
  { value: 'days7', label: 'Do not show again for 7 days', rule: { mode: 'days' as const, days: 7, label: 'Closing hides that campaign for 7 days' } },
  { value: 'campaign', label: 'Do not show again this campaign', rule: { mode: 'campaign' as const, label: 'Closing hides that campaign until it ends' } },
  { value: 'session', label: 'Show again next session', rule: { mode: 'session' as const, label: 'Closing hides it for the rest of the visit' } },
];
const PRIORITIES = [
  { value: '3', label: 'High (3)' },
  { value: '2', label: 'Normal (2)' },
  { value: '1', label: 'Low (1)' },
];

const HEADLINE_MAX = 60;
type Errors = Partial<Record<string, string>>;

interface Draft {
  advertiser: AdvKind;
  sellerId: string;
  brandId: string;
  goal: AdCampaignInput['goal'];
  name: string;
  promoId: string;
  dest: string;
  ownerId: string;
  placementKey: string;
  pages: string[];
  audience: 'all' | 'selected';
  region: string;
  visitors: string;
  signIn: string;
  interest: string;
  start: string;
  end: string;
  tz: string;
  freq: string;
  dismiss: string;
  priority: string;
  cap: string;
  stopWithPromo: boolean;
  desktop: Creative | null;
  phone: Creative | null;
  textId: string;
  headline: string;
  text: string;
  button: string;
  link: string;
  note: string;
  afterApproval: 'schedule' | 'activate';
}

function emptyDraft(): Draft {
  const startAt = new Date(Date.now() + 86_400_000);
  const s = toPacificInput(startAt.toISOString()).slice(0, 10);
  const endAt = new Date(startAt.getTime() + 7 * 86_400_000);
  const e = toPacificInput(endAt.toISOString()).slice(0, 10);
  return {
    advertiser: 'platform', sellerId: '', brandId: '', goal: 'platform_event', name: '', promoId: '', dest: '', ownerId: '',
    placementKey: '', pages: [], audience: 'all', region: 'us', visitors: 'all', signIn: 'everyone', interest: '',
    start: `${s}T00:00`, end: `${e}T23:59`, tz: 'America/Los_Angeles', freq: 'session', dismiss: 'days7', priority: '2', cap: '', stopWithPromo: true,
    desktop: null, phone: null, textId: '', headline: '', text: '', button: '', link: '', note: '', afterApproval: 'schedule',
  };
}

function draftOf(c: Campaign): Draft {
  const text = c.creatives.find((x) => x.kind === 'text');
  const fc = c.frequencyCap;
  const reg = REGIONS.find((r) => r.regions.join() === c.audience.regions.join())?.value ?? 'us';
  return {
    advertiser: c.advertiser.kind,
    sellerId: c.advertiser.sellerId ?? '',
    brandId: c.advertiser.brandId ?? '',
    goal: (GOALS.find((g) => g.value === c.goal)?.value ?? 'platform_event') as Draft['goal'],
    name: c.name,
    promoId: c.linkedPromotion?.id ?? '',
    dest: c.destination.url,
    ownerId: c.owner?.id ?? '',
    placementKey: c.placement.key,
    pages: c.pages,
    audience: c.audience.mode,
    region: reg,
    visitors: c.audience.visitors,
    signIn: c.audience.signIn,
    interest: c.audience.categoryIds[0] ?? '',
    start: toPacificInput(c.startsAt),
    end: toPacificInput(c.endsAt),
    tz: c.timeZone,
    freq: fc.perCampaign ? 'campaign' : fc.perWindow ? 'week2' : fc.perDay && !fc.perSession ? 'day' : 'session',
    dismiss: c.dismissal.mode === 'campaign' ? 'campaign' : c.dismissal.mode === 'session' ? 'session' : 'days7',
    priority: String(c.priority),
    cap: c.budget.deliveryCap != null ? c.budget.deliveryCap.toLocaleString('en-US') : '',
    stopWithPromo: c.stopWithPromotion,
    desktop: c.creatives.find((x) => x.kind === 'image' && x.device === 'desktop') ?? null,
    phone: c.creatives.find((x) => x.kind === 'image' && x.device === 'phone') ?? null,
    textId: text?.id ?? '',
    headline: text?.headline ?? '',
    text: text?.body ?? '',
    button: text?.buttonText ?? '',
    link: text?.link ?? '',
    note: c.noteToReviewers ?? '',
    afterApproval: c.afterApproval,
  };
}

const tzShort = (tz: string) => TIME_ZONES.find((t) => t.value === tz)?.short ?? '';
const fmtInput = (v: string) => {
  const iso = fromZonedInput(v);
  return iso ? dateTime(iso) : '';
};
function period(d: Draft) {
  const a = fromZonedInput(d.start, d.tz);
  const b = fromZonedInput(d.end, d.tz);
  if (!a || !b) return '—';
  return `${shortDate(a)}–${shortDate(b)} ${tzShort(d.tz)}`.trim();
}

function validate(step: number, d: Draft): Errors {
  const e: Errors = {};
  if (step === 0) {
    if (!d.name.trim()) e.name = 'Enter a campaign name.';
    if (!d.dest.trim()) e.dest = 'Enter the page the ad links to.';
    if (d.advertiser === 'seller' && !d.sellerId) e.sellerId = 'Choose the seller.';
    if (d.advertiser === 'brand' && !d.brandId) e.brandId = 'Choose the brand.';
  } else if (step === 1) {
    if (!d.placementKey) e.type = 'Choose an ad type.';
    if (!d.pages.length) e.pages = 'Choose at least one page.';
  } else if (step === 2) {
    const a = fromZonedInput(d.start, d.tz);
    const b = fromZonedInput(d.end, d.tz);
    if (!a) e.start = 'Enter a start date and time.';
    if (!b) e.end = 'Enter an end date and time.';
    else if (a && new Date(b) <= new Date(a)) e.end = 'The end must be after the start.';
    if (d.cap.trim() && !/^[\d,]+$/.test(d.cap.trim())) e.cap = 'Enter a number of displays.';
  } else if (step === 3) {
    if (!d.headline.trim()) e.headline = 'Enter a headline.';
    else if (d.headline.length > HEADLINE_MAX) e.headline = `Shorten the headline to ${HEADLINE_MAX} characters.`;
    if (!d.button.trim()) e.button = 'Enter the button text.';
    if (!d.desktop || !d.phone) e.creative = 'Add a desktop and a phone image.';
  }
  return e;
}

/** Wizard progress (design markup, incl. "Step N of M" for screen readers, which the shared Steps lacks). */
function WizardSteps({ current }: { current: number }) {
  const ref = useScrollRegion<HTMLOListElement>();
  return (
    <ol className="steps" aria-label="Progress" ref={ref} data-scroll-region="">
      {STEPS.map((s, i) => (
        <Fragment key={s.label}>
          {i > 0 && <li className="bar" aria-hidden="true" />}
          <li className={cx('step', i < current && 'is-done', i === current && 'is-current')} aria-current={i === current ? 'step' : undefined}>
            {i < current && <span className="sr-only">Completed: </span>}
            <span className="n">{i < current ? <Icon name="check" className="ic-sm" /> : i + 1}</span>
            {i === current && <span className="sr-only">{`Step ${i + 1} of ${STEPS.length}: `}</span>}
            {s.label}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

type Check = { tone: 'ok' | 'warn' | 'info'; t: string; d?: string | null };
function Checks({ items }: { items: Check[] }) {
  return (
    <ul className="ab-checks">
      {items.map((c) => (
        <li key={c.t} className={`t-${c.tone}`}>
          {c.tone === 'ok' && <span className="sr-only">Passed: </span>}
          {c.tone === 'warn' && <span className="sr-only">Warning: </span>}
          <Icon name={c.tone === 'ok' ? 'circle-check' : c.tone === 'warn' ? 'triangle-alert' : 'info'} className="ic-sm" />
          <span className="stack gap-0">
            <span>{c.t}</span>
            {c.d && <span className="xs muted">{c.d}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
const toChecks = (l: ReviewCheck[]): Check[] => l.map((c) => ({ tone: checkTone(c.state), t: c.label, d: c.detail }));

function AdPreview({ d, imp, image, desk }: { d: Draft; imp?: AdImpression; image?: string; desk?: boolean }) {
  return (
    <div className="ab-scrim">
      <div className={cx('ab-ad', desk && 'desk')}>
        <span className="ab-adtag">{imp?.label ?? 'Ad'}</span>
        <button type="button" className="ab-adx" aria-label={imp?.closeLabel ?? 'Close advertisement'}>
          <Icon name="x" />
        </button>
        <div className="art">
          <Img icon="image" tint="1" src={imp?.image?.url ?? image} alt={imp?.image?.alt ?? ''} />
        </div>
        <div className="copy">
          <b>{imp?.headline ?? (d.headline || 'Headline')}</b>
          <span>{imp?.body ?? d.text}</span>
          <span className="cta">{imp?.buttonText ?? (d.button || 'Button')}</span>
        </div>
      </div>
    </div>
  );
}

const STEP_STATE: Record<string, { cls: string; badge: string; tone: 'success' | 'info' | 'warning' | 'danger' }> = {
  approved: { cls: 'is-done', badge: 'Approved', tone: 'success' },
  waiting: { cls: 'is-wait', badge: 'In review', tone: 'info' },
  changes_requested: { cls: 'is-wait', badge: 'Changes requested', tone: 'warning' },
  rejected: { cls: 'is-wait', badge: 'Rejected', tone: 'danger' },
};
const ROLE: Record<string, string> = { advertising: 'Advertising', content: 'Content', marketing: 'Marketing' };

export default function AdCampaign() {
  const { api, session } = useApi();
  const qc = useQueryClient();
  const { can, accountId, roleKeys } = useStaffSession();
  const [params, setParams] = useSearchParams();
  const ref = params.get('ref');
  const idParam = params.get('id');
  const [view, setView] = useView<Exclude<Step, ''>>();
  const stepIdx = Math.max(0, STEPS.findIndex((s) => s.view === view));
  const [d, setD] = useState<Draft>(emptyDraft);
  const [errors, setErrors] = useState<Errors>({});
  const [savedAt, setSavedAt] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; title: string; body?: string } | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [checkResult, setCheckResult] = useState<CampaignCheckResult | null>(null);
  const [loadedId, setLoadedId] = useState('');
  const [reviewAs, setReviewAs] = useState('');
  const deskFile = useRef<HTMLInputElement>(null);
  const phoneFile = useRef<HTMLInputElement>(null);

  // The record the URL names: ?id= directly, ?ref= through the campaign list search (refs are searchable).
  const resolved = useQuery({
    queryKey: ['advertising', 'campaign-ref', ref],
    queryFn: async () => {
      const page = (await call(api.GET('/api/admin/advertising/campaigns', { params: { query: { q: ref!, limit: 10 } } }))) as Page<{ id: string; ref: string }>;
      const hit = page.items.find((c) => c.ref === ref);
      if (!hit) throw new ApiError(404, "NOT_FOUND", `No campaign ${ref}.`);
      return hit.id;
    },
    enabled: !!ref && !idParam,
    retry: false,
  });
  const campaignId = idParam ?? resolved.data ?? null;
  const campaign = useQuery({
    queryKey: ['advertising', 'campaign', campaignId],
    queryFn: () => call(api.GET('/api/admin/advertising/campaigns/{id}', { params: { path: { id: campaignId! } } })) as Promise<Campaign>,
    enabled: !!campaignId,
    retry: false,
  });
  const c = campaign.data;
  useEffect(() => {
    if (c && c.id !== loadedId) {
      setD(draftOf(c));
      setLoadedId(c.id);
      setSavedAt(time(c.updatedAt));
    }
  }, [c, loadedId]);

  const placements = useQuery({ queryKey: ['advertising', 'placements'], queryFn: () => call(api.GET('/api/admin/advertising/placements')) as Promise<Placement[]> });
  const promos = useQuery({ queryKey: ['promotions', 'campaigns', 'for-ads'], queryFn: () => call(api.GET('/api/admin/promotions/campaigns', { params: { query: { limit: 100 } } })) as Promise<Page<{ id: string; name: string; code?: string | null; status: string }>>, retry: false });
  const members = useQuery({ queryKey: ['access', 'members', 'for-ads'], queryFn: () => call(api.GET('/api/admin/access/members', { params: { query: { limit: 100 } } as never })) as Promise<Page<{ account: { id: string; displayName: string }; roles: Array<{ name: string }> }>>, retry: false });
  const sellers = useQuery({ queryKey: ['sellers', 'list', 'for-ads'], queryFn: () => call(api.GET('/api/admin/sellers/sellers', { params: { query: { limit: 100 } } as never })) as Promise<Page<{ id: string; storeName: string }>>, enabled: d.advertiser === 'seller', retry: false });
  const brands = useQuery({ queryKey: ['catalog', 'brands', 'for-ads'], queryFn: () => call(api.GET('/api/admin/catalog/brands', { params: { query: { limit: 100 } } as never })) as Promise<Page<{ brand: { id: string; name: string } }>>, enabled: d.advertiser === 'brand', retry: false });
  const categories = useQuery({ queryKey: ['catalog', 'categories', 'admin'], queryFn: () => call(api.GET('/api/admin/catalog/categories')) as Promise<Array<{ id: string; name: string }>>, retry: false });

  // Default the ad type to the first enabled placement once placements arrive (new campaigns only).
  const enabled = (placements.data ?? []).filter((p) => p.enabled);
  useEffect(() => {
    if (!campaignId && !d.placementKey && enabled.length) setD((p) => ({ ...p, placementKey: enabled[0].key, pages: enabled[0].eligiblePages.slice(0, 1) }));
  }, [campaignId, d.placementKey, enabled]);
  const placement = placements.data?.find((p) => p.key === d.placementKey);

  const status = c?.status ?? 'draft';
  const editable = status === 'draft' && can('advertising.campaigns.manage');
  const onApproval = stepIdx === 4;

  const preview = useQuery({
    queryKey: ['advertising', 'campaign', campaignId, 'preview', theme, c?.version],
    queryFn: () => call(api.GET('/api/admin/advertising/campaigns/{id}/preview', { params: { path: { id: campaignId! }, query: { theme } } })) as Promise<Preview>,
    enabled: !!campaignId && stepIdx >= 3 && (!!c?.creatives.length),
    retry: false,
  });

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((p) => ({ ...p, [k]: v }));
    if (errors[k as string]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  function inputOf(x: Draft, creativeIds: string[]): AdCampaignInput {
    const f = FREQUENCIES.find((o) => o.value === x.freq)?.cap;
    const ds = DISMISS.find((o) => o.value === x.dismiss)?.rule;
    const cap = x.cap.trim() ? Number(x.cap.replace(/,/g, '')) : null;
    return {
      name: x.name.trim(),
      advertiser: { kind: x.advertiser, sellerId: x.advertiser === 'seller' ? x.sellerId : null, brandId: x.advertiser === 'brand' ? x.brandId : null },
      goal: x.goal,
      ownerStaffId: x.ownerId || null,
      linkedPromotionId: x.promoId || null,
      placementKey: x.placementKey,
      pages: x.pages,
      audience: {
        mode: x.audience,
        regions: x.audience === 'selected' ? (REGIONS.find((r) => r.value === x.region)?.regions ?? []) : [],
        visitors: (x.audience === 'selected' ? x.visitors : 'all') as 'all',
        signIn: (x.audience === 'selected' ? x.signIn : 'everyone') as 'everyone',
        categoryIds: x.audience === 'selected' && x.interest ? [x.interest] : [],
      },
      destination: { kind: 'url', url: x.dest.trim() },
      startsAt: fromZonedInput(x.start, x.tz)!,
      endsAt: fromZonedInput(x.end, x.tz)!,
      timeZone: x.tz,
      frequencyCap: f ?? null,
      dismissal: ds ?? null,
      priority: Number(x.priority),
      budget: cap != null ? ({ billing: 'none', deliveryCap: cap, spent: { amount: 0, currency: 'USD' } } as AdCampaignInput['budget']) : null,
      stopWithPromotion: !!x.promoId && x.stopWithPromo,
      creativeIds,
      afterApproval: x.afterApproval,
      noteToReviewers: x.note.trim() || null,
    } as AdCampaignInput;
  }

  /** Saves the draft: the ad text creative first (create or edit), then the campaign (create or PATCH). */
  const save = useMutation({
    mutationFn: async (x: Draft) => {
      let textId = x.textId;
      if (x.headline.trim() && x.placementKey) {
        const body = { headline: x.headline.trim(), body: x.text.trim() || undefined, buttonText: x.button.trim() || undefined, link: x.link.trim() || undefined };
        if (textId) await call(api.PATCH('/api/admin/advertising/creatives/{id}', { params: { path: { id: textId } }, body }));
        else {
          const cr = (await call(api.POST('/api/admin/advertising/creatives', { body: { ...body, kind: 'text', device: 'any', placementKey: x.placementKey, campaignId: campaignId ?? undefined } }))) as Creative;
          textId = cr.id;
        }
      }
      const ids = [x.desktop?.id, x.phone?.id, textId].filter(Boolean) as string[];
      const input = inputOf(x, ids);
      const saved = campaignId
        ? ((await call(api.PATCH('/api/admin/advertising/campaigns/{id}', { params: { path: { id: campaignId } }, body: { changes: input, version: c!.version } }))) as Campaign)
        : ((await call(api.POST('/api/admin/advertising/campaigns', { body: input }))) as Campaign);
      return { saved, textId };
    },
    onSuccess: ({ saved, textId }) => {
      qc.setQueryData(['advertising', 'campaign', saved.id], saved);
      setD((p) => ({ ...p, textId }));
      setLoadedId(saved.id);
      setSavedAt(time(saved.updatedAt));
      void qc.invalidateQueries({ queryKey: ['advertising', 'campaigns'] });
      void qc.invalidateQueries({ queryKey: ['advertising', 'dashboard'] });
      if (!campaignId) {
        setParams((prev) => {
          const p = new URLSearchParams(prev);
          p.set('id', saved.id);
          return p;
        }, { replace: true });
      }
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'CONFLICT') void campaign.refetch();
    },
  });

  const runCheck = useMutation({
    mutationFn: (id: string) => call(api.POST('/api/admin/advertising/campaigns/{id}/check', { params: { path: { id } } })) as Promise<CampaignCheckResult>,
    onSuccess: setCheckResult,
  });

  const go = (i: number) => {
    setErrors({});
    setView(STEPS[i].view);
    window.scrollTo({ top: 0 });
  };
  const next = async () => {
    const e = validate(stepIdx, d);
    setErrors(e);
    if (Object.keys(e).length) {
      announce('Check the highlighted fields before you continue.');
      return;
    }
    if (editable) {
      try {
        const { saved } = await save.mutateAsync(d);
        if (stepIdx >= 2) runCheck.mutate(saved.id);
      } catch {
        return;
      }
    }
    go(stepIdx + 1);
  };
  const saveDraft = () => {
    const e = validate(0, d);
    setErrors(e);
    if (Object.keys(e).length) return announce('Check the highlighted fields before you save.');
    save.mutate(d, { onSuccess: ({ saved }) => announce(`Draft saved at ${time(saved.updatedAt)}`) });
  };

  const upload = useMutation({
    mutationFn: async ({ k, f }: { k: 'desktop' | 'phone'; f: File }) => {
      if (!d.placementKey) throw new Error('Choose the ad type first.');
      const asset = await uploadMedia(session, f, 'ad_creative');
      return (await call(api.POST('/api/admin/advertising/creatives', { body: { kind: 'image', device: k, placementKey: d.placementKey, mediaId: asset.id, campaignId: campaignId ?? undefined, link: d.dest || undefined } }))) as Creative;
    },
    onSuccess: (cr, { k }) => {
      set(k, cr);
      setErrors((x) => ({ ...x, creative: undefined }));
      announce(`${k === 'desktop' ? 'Desktop' : 'Phone'} image uploaded`);
    },
  });
  const pickFile = (k: 'desktop' | 'phone') => (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) upload.mutate({ k, f });
    e.target.value = '';
  };

  const submit = useMutation({
    mutationFn: async () => {
      const { saved } = await save.mutateAsync(d);
      return call(api.POST('/api/admin/advertising/campaigns/{id}/submit', { params: { path: { id: saved.id } }, body: { noteToReviewers: d.note.trim() || undefined } })) as Promise<Campaign>;
    },
    onSuccess: (r) => {
      qc.setQueryData(['advertising', 'campaign', r.id], r);
      const waiting = r.approvals.filter((a) => a.state === 'waiting').map((a) => `${a.reviewer?.name ? `${a.reviewer.name} (${ROLE[a.role]})` : ROLE[a.role]}`);
      setNotice({ tone: 'success', title: r.status === 'in_review' ? 'Submitted for approval' : `Campaign ${statusLabel(r.status).toLowerCase()}`, body: waiting.length ? `Waiting for ${waiting.join(' and ')} to review. You'll get a notification when it's approved.` : undefined });
      announce('Submitted for approval');
      void qc.invalidateQueries({ queryKey: ['advertising'] });
      void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
    },
  });

  const act = useMutation({
    mutationFn: ({ p, body }: { p: PendingAction; body?: Record<string, unknown> }) => runCampaignAction(api, p.id, p.action, body),
    onSuccess: (r, { p }) => {
      setPending(null);
      qc.setQueryData(['advertising', 'campaign', r.id], r);
      const waiting = r.approvals.filter((a) => a.state === 'waiting').map((a) => ROLE[a.role]);
      const title =
        p.action === 'approve'
          ? r.status === 'in_review'
            ? `Your step is approved. Waiting for ${waiting.join(' and ') || 'the other reviewers'}.`
            : `Approved: ${statusLabel(r.status)}`
          : p.action === 'renew'
            ? `Renewal draft ${r.ref} created`
            : `${r.name}: ${statusLabel(r.status)}`;
      setNotice({ tone: 'success', title });
      announce(title);
      if (p.action === 'renew') setParams({ id: r.id }, { replace: false });
      void qc.invalidateQueries({ queryKey: ['advertising'] });
      void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
    },
  });
  const startAction = (action: CampaignAction) => {
    if (!c) return;
    act.reset();
    const p: PendingAction = { id: c.id, name: c.name, action, startsAt: c.startsAt, endsAt: c.endsAt };
    if (action === 'request-changes' || action === 'reject' || action === 'pause' || action === 'finish' || action === 'renew') setPending(p);
    else act.mutate({ p });
  };

  // ---------- loading / not found ----------
  if ((ref || idParam) && (resolved.error || campaign.error)) {
    const e = resolved.error ?? campaign.error;
    const nf = e instanceof ApiError && e.status === 404;
    return (
      <AdminLayout active="ads">
        <div className="page-head">
          <div className="t">
            <Breadcrumbs items={[{ label: 'Advertisements', to: href('admin/ads') }, { label: ref ?? 'Campaign' }]} />
            <h1 className="h1">{nf ? 'Campaign not found' : 'Campaign'}</h1>
          </div>
        </div>
        {nf ? (
          <div className="card pad">
            <EmptyState icon="megaphone" title="This campaign doesn’t exist" as="h2" action={<Button to={href('admin/ads')}>Back to Advertisements</Button>}>
              The link may be old, or the campaign was removed.
            </EmptyState>
          </div>
        ) : (
          <LoadError error={e} onRetry={() => void (resolved.error ? resolved.refetch() : campaign.refetch())} />
        )}
      </AdminLayout>
    );
  }
  const loading = (!!ref || !!idParam) && !c;

  const nErr = Object.values(errors).filter(Boolean).length;
  const adv = ADVERTISERS.find((a) => a.kind === d.advertiser) ?? ADVERTISERS[0];
  const typeLabel = placement?.name ?? 'Ad';
  const ownerName = members.data?.items.find((m) => m.account.id === d.ownerId)?.account.displayName ?? c?.owner?.name ?? '';
  const checks: Check[] = checkResult ? toChecks(checkResult.checks) : c ? toChecks(c.checks) : [];
  const conflicts = checkResult?.conflicts ?? c?.conflicts ?? [];
  const reach = checkResult?.estimatedWeeklyReach ?? c?.audience.estimatedWeeklyReach;
  const promoName = promos.data?.items.find((p) => p.id === d.promoId)?.name ?? c?.linkedPromotion?.name;
  const interestName = categories.data?.find((x) => x.id === d.interest)?.name;
  const pageNames = d.pages.map(pageLabel).join(', ');
  const audienceSummary = d.audience === 'all' ? 'All shoppers' : [d.signIn === 'signed_in' ? 'Signed-in' : 'Everyone', interestName ? `${interestName} interest` : ''].filter(Boolean).join(' · ');
  const creativeSummary = d.desktop && d.phone ? 'Desktop + phone' : d.desktop ? 'Desktop only' : d.phone ? 'Phone only' : '';
  const at = (n: number, v: string) => (stepIdx >= n && v ? v : '—');
  const summary: Array<[string, string]> = [
    ['Advertiser', adv.summary],
    ['Goal', GOALS.find((g) => g.value === d.goal)?.label ?? ''],
    ['Linked promotion', promoName ?? '—'],
    ['Ad type', at(1, typeLabel)],
    ['Pages', at(1, pageNames)],
    ['Audience', at(1, audienceSummary)],
    ['Period', at(2, period(d))],
    ['Frequency', at(2, FREQUENCIES.find((f) => f.value === d.freq)?.label ?? '')],
    ['Priority', at(2, PRIORITIES.find((p) => p.value === d.priority)?.label ?? '')],
    ['Creative', at(3, creativeSummary)],
  ];
  const submittedAt = c?.timeline.slice().reverse().find((t) => /submit/i.test(t.label))?.at;
  const imp = preview.data;
  const canReviewHere = status === 'in_review' && can('advertising.campaigns.review');
  const mine = reviewRolesOf(roleKeys);
  const stepOptions = (c?.approvals ?? []).filter((a) => a.state === 'waiting' && (mine.includes(a.role) || (a.role === 'content' && mine.includes('marketing')))).map((a) => (a.role === 'content' && !mine.includes('content') ? 'marketing' : a.role) as ReviewRole);
  const myRole = stepOptions.includes(reviewAs as ReviewRole) ? (reviewAs as ReviewRole) : stepOptions[0];
  const myStep = myRole ? { role: myRole } : undefined;
  const alreadyApprovedByMe = c?.approvals.some((a) => a.state === 'approved' && a.reviewer?.id === accountId);
  const writeError = save.error ?? submit.error ?? upload.error ?? runCheck.error ?? (pending ? null : act.error);
  const checkDetails = writeError instanceof ApiError && writeError.code === 'CHECKS_FAILED' ? ((writeError.details as { checks?: ReviewCheck[] } | undefined)?.checks ?? []) : [];

  return (
    <AdminLayout active="ads">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Advertisements', to: href('admin/ads') }, { label: c ? c.ref : 'New campaign' }]} />
          <h1 className="h1">{d.name || c?.name || 'New campaign'}</h1>
          <p className="sub small">
            {typeLabel} · {adv.short}
            {ownerName ? ` · owner ${ownerName}` : ''}
          </p>
        </div>
        <div className="actions">{status === 'draft' ? <Badge>Draft</Badge> : <Badge tone={status === 'rejected' ? 'danger' : status === 'live' || status === 'approved' || status === 'scheduled' ? 'success' : 'info'}>{statusLabel(status)}</Badge>}</div>
      </div>

      <div className="card pad">
        <WizardSteps current={stepIdx} />
      </div>

      <div className="ab-main">
        <div className="stack gap-4">
          {loading && (
            <div className="card pad">
              <SkeletonLines rows={6} />
            </div>
          )}
          {nErr > 0 && (
            <Alert tone="danger" title={`Check ${nErr} field${nErr > 1 ? 's' : ''}`}>
              Fix the highlighted fields to continue.
            </Alert>
          )}
          {writeError && (
            <Alert tone="danger" title="That didn’t work">
              {errorMessage(writeError)}
              {checkDetails.length > 0 && <Checks items={toChecks(checkDetails)} />}
            </Alert>
          )}
          {notice && (
            <Alert tone={notice.tone} title={notice.title}>
              {notice.body}
            </Alert>
          )}
          {c && status !== 'draft' && !onApproval && (
            <Alert tone="info" title={`This campaign is ${statusLabel(status).toLowerCase()}`}>
              {(status === 'approved' ? 'Editing an approved campaign returns it to draft.' : 'Only drafts can be edited.')} {c.pausedReason ? `Paused: ${c.pausedReason}.` : ''} {c.rejectedReason ? `Rejected: ${c.rejectedReason}.` : ''}
            </Alert>
          )}
          {!can('advertising.campaigns.manage') && status === 'draft' && <Alert tone="info" title="View only">Creating and editing campaigns needs the campaign management permission.</Alert>}

          {!loading && (
            <fieldset className="stack gap-4 fieldset-reset" disabled={!editable && !onApproval}>
              {stepIdx === 0 && (
                <Card title="Goal and advertiser">
                  <fieldset className="stack gap-2 fieldset-reset">
                    <legend className="label">Advertiser</legend>
                    <div className="ab-checkgrid">
                      {ADVERTISERS.map((a, i) => (
                        <label key={a.title} className={cx('opt-card', d.advertiser === a.kind && 'is-selected')} htmlFor={`ac-adv-${i + 1}`}>
                          <input type="radio" name="ac-adv" id={`ac-adv-${i + 1}`} checked={d.advertiser === a.kind} onChange={() => set('advertiser', a.kind)} />
                          <span className="stack gap-1 grow">
                            <span className="small strong">{a.title}</span>
                            <span className="small sub">{a.body}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset className="stack gap-2 fieldset-reset">
                    <legend className="label">Campaign goal</legend>
                    <div className="ab-checkgrid">
                      {GOALS.map((g, i) => (
                        <label key={g.value} className="check" htmlFor={`ac-goal-${i + 1}`}>
                          <input type="radio" name="ac-goal" id={`ac-goal-${i + 1}`} checked={d.goal === g.value} onChange={() => set('goal', g.value)} />
                          <span>{g.label}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="ab-form-grid">
                    <Field label="Campaign name" error={errors.name}>
                      <TextInput id="ac-name" value={d.name} error={!!errors.name} onChange={(e) => set('name', e.target.value)} />
                    </Field>
                    <Field label="Linked promotion" hint="The ad brings attention; the promotion changes the price">
                      <Select id="ac-promo" options={[...(promos.data?.items ?? []).filter((p) => p.status !== 'ended' && p.status !== 'archived').map((p) => ({ value: p.id, label: p.code ? `${p.name} (${p.code})` : p.name })), { value: '', label: 'None' }]} value={d.promoId} onChange={(e) => set('promoId', e.target.value)} />
                    </Field>
                    <Field label="Destination" error={errors.dest}>
                      <TextInput id="ac-dest" prefix="marketly.com" value={d.dest} error={!!errors.dest} onChange={(e) => set('dest', e.target.value)} />
                    </Field>
                    <Field label="Campaign owner">
                      <Select id="ac-own" options={[{ value: '', label: 'Me' }, ...(members.data?.items ?? []).map((m) => ({ value: m.account.id, label: `${m.account.displayName} · ${m.roles[0]?.name ?? 'Staff'}` }))]} value={d.ownerId} onChange={(e) => set('ownerId', e.target.value)} />
                    </Field>
                    {d.advertiser === 'seller' && (
                      <Field label="Seller" error={errors.sellerId}>
                        <Select id="ac-seller" options={[{ value: '', label: 'Choose a seller' }, ...(sellers.data?.items ?? []).map((s) => ({ value: s.id, label: s.storeName }))]} value={d.sellerId} onChange={(e) => set('sellerId', e.target.value)} />
                      </Field>
                    )}
                    {d.advertiser === 'brand' && (
                      <Field label="Brand" error={errors.brandId}>
                        <Select id="ac-brand" options={[{ value: '', label: 'Choose a brand' }, ...(brands.data?.items ?? []).map((b) => ({ value: b.brand.id, label: b.brand.name }))]} value={d.brandId} onChange={(e) => set('brandId', e.target.value)} />
                      </Field>
                    )}
                  </div>
                </Card>
              )}

              {stepIdx === 1 && (
                <>
                  <Card title="Ad type">
                    {!placements.data && <SkeletonLines rows={3} />}
                    <div className="ab-types">
                      {(placements.data ?? []).map((t) => {
                        const stage = AVAILABILITY[t.availability];
                        const off = !t.enabled;
                        return (
                          <label key={t.key} className={cx('opt-card', d.placementKey === t.key && 'is-selected', off && 'is-disabled')} htmlFor={`ac-type-${t.key}`}>
                            <input type="radio" name="ac-type" id={`ac-type-${t.key}`} checked={d.placementKey === t.key} disabled={off} onChange={() => (set('placementKey', t.key), set('pages', d.pages.filter((p) => t.eligiblePages.includes(p))))} />
                            <span className="stack gap-1 grow">
                              <span className="row gap-2">
                                <Icon name={placementIcon(t.key) as IconName} className="ic-sm" />
                                <span className="small strong">{t.name}</span>
                                {(t.availability !== 'later' || off) && <Badge tone={stage.tone || undefined}>{stage.label}</Badge>}
                              </span>
                              <span className="small sub">{t.description}</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    {errors.type && (
                      <span className="error-text">
                        <Icon name="circle-alert" className="ic-sm" />
                        {errors.type}
                      </span>
                    )}
                  </Card>
                  <Card title="Pages" titleAs="h3">
                    <div className="ab-checkgrid">
                      {(placement?.eligiblePages ?? []).map((p, i) => (
                        <label key={p} className="check" htmlFor={`ac-pg${i + 1}`}>
                          <input
                            type="checkbox"
                            id={`ac-pg${i + 1}`}
                            checked={d.pages.includes(p)}
                            aria-invalid={errors.pages ? true : undefined}
                            onChange={(e) => set('pages', e.target.checked ? [...d.pages, p] : d.pages.filter((x) => x !== p))}
                          />
                          <span>{pageLabel(p)}</span>
                        </label>
                      ))}
                    </div>
                    {errors.pages && (
                      <span className="error-text">
                        <Icon name="circle-alert" className="ic-sm" />
                        {errors.pages}
                      </span>
                    )}
                    <div className="panel stack gap-2">
                      <span className="small strong">
                        <Icon name="lock" className="ic-sm" /> Never shown on
                      </span>
                      <span className="small sub">Checkout, payment results, order tracking and return pages. This is a platform rule and cannot be changed per campaign.</span>
                    </div>
                  </Card>
                  <Card title="Audience" titleAs="h3">
                    <div className="ab-checkgrid">
                      {(['all', 'selected'] as const).map((a, i) => (
                        <label key={a} className="check" htmlFor={`ac-aud-${i + 1}`}>
                          <input type="radio" name="ac-aud" id={`ac-aud-${i + 1}`} checked={d.audience === a} onChange={() => set('audience', a)} />
                          <span>{a === 'all' ? 'All shoppers' : 'Selected audience'}</span>
                        </label>
                      ))}
                    </div>
                    {d.audience === 'selected' && (
                      <div className="ab-form-grid">
                        <Field label="Service regions">
                          <Select id="ac-reg" options={REGIONS} value={d.region} onChange={(e) => set('region', e.target.value)} />
                        </Field>
                        <Field label="Visitors">
                          <Select id="ac-vis" options={VISITORS} value={d.visitors} onChange={(e) => set('visitors', e.target.value)} />
                        </Field>
                        <Field label="Sign-in">
                          <Select id="ac-sign" options={SIGN_IN} value={d.signIn} onChange={(e) => set('signIn', e.target.value)} />
                        </Field>
                        <Field label="Interested in categories" hint="Based on browsing in this store only">
                          <Select id="ac-cat" options={[...(categories.data ?? []).map((x) => ({ value: x.id, label: x.name })), { value: '', label: 'Any category' }]} value={d.interest} onChange={(e) => set('interest', e.target.value)} />
                        </Field>
                      </div>
                    )}
                    <p className="ab-note">
                      <Icon name="info" className="ic-sm" /> Targeting uses only information customers gave us or that their privacy choices allow.
                      {reach != null ? ` Estimated reach: ${num(reach)} visitors per week.` : ' The reach estimate appears after the checks run.'}
                    </p>
                  </Card>
                </>
              )}

              {stepIdx === 2 && (
                <>
                  <Card title="Schedule">
                    <div className="ab-form-grid c3">
                      <Field label="Start" error={errors.start} hint={d.start ? fmtInput(d.start) : undefined}>
                        <TextInput id="ac-start" type="datetime-local" icon="calendar" value={d.start} error={!!errors.start} onChange={(e) => set('start', e.target.value)} />
                      </Field>
                      <Field label="End" error={errors.end}>
                        <TextInput id="ac-end" type="datetime-local" icon="calendar" value={d.end} error={!!errors.end} onChange={(e) => set('end', e.target.value)} />
                      </Field>
                      <Field label="Publication time zone">
                        <Select id="ac-tz" options={TIME_ZONES} value={d.tz} onChange={(e) => set('tz', e.target.value)} />
                      </Field>
                    </div>
                    {conflicts.map((x) => (
                      <Alert key={x.campaignId} tone="warning" title={`Overlaps with ${x.name} on ${shortDate(x.from)}–${shortDate(x.to)}`}>
                        {x.pages.length ? `Both target ${x.pages.map((p) => pageLabel(p).toLowerCase()).join(', ')}. ` : ''}
                        {x.resolution}
                      </Alert>
                    ))}
                  </Card>
                  <Card title="Display limits and priority" titleAs="h3">
                    <div className="ab-form-grid">
                      <Field label="Display frequency" hint={placement?.frequencyCap ? `Placement default: ${placement.frequencyCap.label}` : undefined}>
                        <Select id="ac-freq" options={FREQUENCIES} value={d.freq} onChange={(e) => set('freq', e.target.value)} />
                      </Field>
                      <Field label="After a visitor closes it">
                        <Select id="ac-dis" options={DISMISS} value={d.dismiss} onChange={(e) => set('dismiss', e.target.value)} />
                      </Field>
                      <Field label="Priority when several ads qualify" hint="Equal priority rotates evenly">
                        <Select id="ac-pri" options={PRIORITIES} value={d.priority} onChange={(e) => set('priority', e.target.value)} />
                      </Field>
                      <Field label="Delivery cap" hint={d.advertiser === 'platform' || d.advertiser === 'official_store' ? 'Own promotion, no budget charge' : 'Maximum displays'} error={errors.cap} optional>
                        <TextInput id="ac-cap" suffix="displays" inputMode="numeric" value={d.cap} error={!!errors.cap} onChange={(e) => set('cap', e.target.value)} />
                      </Field>
                    </div>
                    <label className="check" htmlFor="ac-stop">
                      <input type="checkbox" id="ac-stop" checked={d.stopWithPromo} onChange={(e) => set('stopWithPromo', e.target.checked)} />
                      <span>Stop the ad when the linked promotion ends or its budget runs out</span>
                    </label>
                  </Card>
                </>
              )}

              {stepIdx === 3 && (
                <>
                  <Card title="Creative">
                    <div className="ab-form-grid">
                      {(
                        [
                          ['desktop', `Desktop image · ${placement?.formats.find((f) => f.device === 'desktop' || f.device === 'any')?.label.replace(/^\w+\s/, '') ?? ''}`, deskFile],
                          ['phone', `Phone image · ${placement?.formats.find((f) => f.device === 'phone' || f.device === 'any')?.label.replace(/^\w+\s/, '') ?? ''}`, phoneFile],
                        ] as const
                      ).map(([k, label, fileRef]) => {
                        const cr = d[k];
                        return (
                          <div className="field" key={k}>
                            <span className="label">{label}</span>
                            <div className="panel row gap-3">
                              <Img icon="image" tint="1" className="thumb" src={cr?.media?.url} />
                              <span className="grow stack gap-0">
                                <span className="small strong">{cr ? (cr.fileName ?? 'Image') : 'No image yet'}</span>
                                <span className="xs muted">{cr ? [cr.width && cr.height ? `${cr.width} × ${cr.height}` : '', cr.bytes ? `${Math.round(cr.bytes / 1024)} KB` : '', `uploaded ${shortDate(cr.createdAt)}`].filter(Boolean).join(' · ') : 'JPG or PNG'}</span>
                              </span>
                              <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={pickFile(k)} />
                              <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
                                {upload.isPending && upload.variables?.k === k ? 'Uploading…' : cr ? 'Replace' : 'Upload'}
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                      <Field label="Headline" error={errors.headline} hint={`${d.headline.length} of ${HEADLINE_MAX} characters`}>
                        <TextInput id="ac-h" value={d.headline} error={!!errors.headline} onChange={(e) => set('headline', e.target.value)} />
                      </Field>
                      <Field label="Supporting text">
                        <TextInput id="ac-t" value={d.text} onChange={(e) => set('text', e.target.value)} />
                      </Field>
                      <Field label="Button text" error={errors.button}>
                        <TextInput id="ac-b" value={d.button} error={!!errors.button} onChange={(e) => set('button', e.target.value)} />
                      </Field>
                      <Field label="Link">
                        <TextInput id="ac-l" icon="link" value={d.link} onChange={(e) => set('link', e.target.value)} />
                      </Field>
                    </div>
                    {errors.creative && (
                      <span className="error-text">
                        <Icon name="circle-alert" className="ic-sm" />
                        {errors.creative}
                      </span>
                    )}
                    <div className="dropzone">
                      <Icon name="image-plus" className="ic-lg" />
                      <span className="small strong u-c-text">Add a video version</span>
                      <span className="xs">Video ads are not available yet</span>
                      <Button variant="secondary" size="sm" disabled>
                        Browse files
                      </Button>
                    </div>
                  </Card>
                  <Card
                    title="Preview"
                    titleAs="h3"
                    sub="Exactly as visitors see it, with the Ad label and close control"
                    actions={<SegmentedControl items={[{ label: 'Light', value: 'light' }, { label: 'Dark', value: 'dark' }]} active={theme} onChange={setTheme} label="Preview theme" />}
                  >
                    <div className="ab-previews">
                      <div className="stack gap-2">
                        <span className="xs strong sub">
                          <Icon name="monitor" className="ic-sm" /> Desktop
                        </span>
                        <div className="ab-dframe">
                          <div className="ab-dbar">
                            <i />
                            <i />
                            <i />
                            <span>{imp?.frame.desktop ?? 'marketly.com'}</span>
                          </div>
                          <div className="ab-screen desk">
                            <div className="sk h-18" />
                            <div className="sk h-46" />
                            <div className="sk u-h-12px" style={{ width: '60%' }} />
                            <div className="sk h-30" />
                            <div className="sk h-30" />
                            <AdPreview d={d} imp={imp?.desktop} image={d.desktop?.media?.url} desk />
                          </div>
                        </div>
                      </div>
                      <div className="stack gap-2">
                        <span className="xs strong sub">
                          <Icon name="smartphone" className="ic-sm" /> Phone
                        </span>
                        <div className="ab-mframe">
                          <div className="ab-screen mob">
                            <div className="sk h-18" />
                            <div className="sk h-46" />
                            <div className="sk u-h-12px" style={{ width: '60%' }} />
                            <div className="sk h-30" />
                            <div className="sk h-30" />
                            <div className="sk h-18" />
                            <div className="sk h-46" />
                            <AdPreview d={d} imp={imp?.phone} image={d.phone?.media?.url} />
                          </div>
                        </div>
                      </div>
                    </div>
                  </Card>
                  <Card
                    title="Checks"
                    titleAs="h3"
                    actions={
                      campaignId ? (
                        <Button variant="ghost" size="sm" icon="refresh-cw" onClick={() => runCheck.mutate(campaignId)} disabled={runCheck.isPending}>
                          Run checks
                        </Button>
                      ) : undefined
                    }
                  >
                    {runCheck.isPending ? <SkeletonLines rows={3} /> : checks.length ? <Checks items={checks} /> : <p className="small muted">Save the draft to run the checks: label, close control, claims, availability, link and contrast.</p>}
                  </Card>
                </>
              )}

              {onApproval && (
                <>
                  <Card title="Reviewers" sub="Own promotions need Advertising and Content or Marketing approval">
                    <ul className="ab-approvals">
                      {(c?.approvals ?? []).map((a, i) => {
                        const s = STEP_STATE[a.state] ?? STEP_STATE.waiting;
                        return (
                          <li key={a.role}>
                            <span className={cx('n', s.cls)}>{a.state === 'approved' ? <Icon name="check" className="ic-sm" /> : i + 1}</span>
                            <span className="ab-cell">
                              <span className="strong">
                                {a.reviewer?.name ? `${a.reviewer.name} · ` : ''}
                                {ROLE[a.role]}
                              </span>
                              <span className="xs muted">
                                {a.scope}
                                {a.decidedAt ? ` · ${a.state === 'approved' ? 'approved' : a.state.replace('_', ' ')} ${dateTime(a.decidedAt)}` : ''}
                                {a.note ? ` · ${a.note}` : ''}
                              </span>
                            </span>
                            <Badge tone={s.tone}>{status === 'draft' && a.state === 'waiting' ? 'Not started' : s.badge}</Badge>
                          </li>
                        );
                      })}
                      {!c?.approvals.length && (
                        <li>
                          <span className="ab-cell">
                            <span className="xs muted">Reviewers are asked when you submit: Advertising checks placement, schedule and limits; Content or Marketing checks the creative, claims and links.</span>
                          </span>
                        </li>
                      )}
                    </ul>
                    {canReviewHere && stepOptions.length > 1 && (
                      <Field label="Review step" hint="Your roles cover more than one step; a second person approves the other">
                        <Select id="ac-step" options={stepOptions.map((r) => ({ value: r, label: REVIEW_ROLE_LABEL[r] }))} value={myRole} onChange={(e) => setReviewAs(e.target.value)} />
                      </Field>
                    )}
                    <Field label="Note to reviewers" optional>
                      <Textarea id="ac-note" value={d.note} onChange={(e) => set('note', e.target.value)} disabled={!editable} />
                    </Field>
                  </Card>
                  <Card title="After approval" titleAs="h3">
                    <div className="stack gap-2">
                      <label className={cx('opt-card', d.afterApproval === 'schedule' && 'is-selected')} htmlFor="ac-pub-1">
                        <input type="radio" name="ac-pub" id="ac-pub-1" checked={d.afterApproval === 'schedule'} disabled={!editable} onChange={() => set('afterApproval', 'schedule')} />
                        <span className="stack gap-1 grow">
                          <span className="small strong">Schedule</span>
                          <span className="small sub">
                            Goes live {fmtInput(d.start)} {tzShort(d.tz)} and ends {fmtInput(d.end)} {tzShort(d.tz)}
                          </span>
                        </span>
                      </label>
                      <label className={cx('opt-card', d.afterApproval === 'activate' && 'is-selected', c && !c.activateAllowed && 'is-disabled')} htmlFor="ac-pub-2">
                        <input type="radio" name="ac-pub" id="ac-pub-2" checked={d.afterApproval === 'activate'} disabled={!editable || (!!c && !c.activateAllowed)} onChange={() => set('afterApproval', 'activate')} />
                        <span className="stack gap-1 grow">
                          <span className="small strong">Activate as soon as approved</span>
                          <span className="small sub">{c && !c.activateAllowed ? (c.activateBlockedReason ?? 'Not available for this campaign') : 'Goes live when the last reviewer approves'}</span>
                        </span>
                      </label>
                    </div>
                    <Alert tone="info" title="You can pause at any time">
                      Pause from Advertisements if details change. The ad leaves the site within 1 minute and can be resumed.
                    </Alert>
                  </Card>
                </>
              )}
            </fieldset>
          )}

          <div className="ab-wizard-foot">
            {stepIdx === 0 ? (
              <Button variant="ghost" to={href('admin/ads')}>
                Cancel
              </Button>
            ) : (
              <Button variant="ghost" icon="arrow-left" onClick={() => go(stepIdx - 1)}>
                Back
              </Button>
            )}
            <span className="row gap-2">
              {editable && (
                <Button variant="secondary" onClick={saveDraft} disabled={save.isPending}>
                  {save.isPending ? 'Saving…' : 'Save draft'}
                </Button>
              )}
              {onApproval ? (
                status === 'draft' ? (
                  <Button icon="send" disabled={!editable || submit.isPending} onClick={() => submit.mutate()}>
                    {submit.isPending ? 'Submitting…' : 'Submit for approval'}
                  </Button>
                ) : canReviewHere ? (
                  <>
                    <Button variant="ghost" onClick={() => startAction('reject')} disabled={act.isPending}>
                      Reject
                    </Button>
                    <Button variant="secondary" onClick={() => startAction('request-changes')} disabled={act.isPending}>
                      Request changes
                    </Button>
                    <Button icon="check" onClick={() => act.mutate({ p: { id: c!.id, name: c!.name, action: 'approve' }, body: myStep ? { role: myStep.role } : {} })} disabled={act.isPending || alreadyApprovedByMe}>
                      {alreadyApprovedByMe ? 'You approved a step' : 'Approve'}
                    </Button>
                  </>
                ) : status === 'approved' && can('advertising.campaigns.publish') ? (
                  <>
                    {c?.activateAllowed && (
                      <Button variant="secondary" onClick={() => startAction('activate')} disabled={act.isPending}>
                        Activate now
                      </Button>
                    )}
                    <Button icon="calendar" onClick={() => startAction('schedule')} disabled={act.isPending}>
                      Schedule
                    </Button>
                  </>
                ) : (
                  <Button icon="check" disabled>
                    {status === 'in_review' ? 'Submitted' : statusLabel(status)}
                  </Button>
                )
              ) : (
                <Button iconRight="arrow-right" onClick={() => void next()} disabled={save.isPending || loading}>
                  {STEPS[stepIdx].next}
                </Button>
              )}
            </span>
          </div>
          {status === 'in_review' && !can('advertising.campaigns.review') && onApproval && <p className="xs muted">Approving needs the campaign review permission (Advertising, Content or Marketing reviewers).</p>}
          {status !== 'draft' && (
            <p className="small">
              <Link to={href('admin/ads')}>Back to Advertisements</Link>
            </p>
          )}
        </div>

        <div className="stack gap-4 ab-sticky">
          <Card title="Campaign summary" titleAs="h3" sub={status !== 'draft' ? (submittedAt ? `Submitted ${dateTime(submittedAt)}` : statusLabel(status)) : savedAt ? `Draft · saved ${savedAt}` : 'Draft · not saved yet'}>
            <div className="ab-sumlist">
              {summary.map(([k, v]) => (
                <div key={k}>
                  <span>{k}</span>
                  <span>{v}</span>
                </div>
              ))}
            </div>
            <div className="divider" />
            <Checks
              items={[
                { tone: 'info', t: 'Never covers checkout, payment results, tracking or returns' },
                { tone: 'info', t: 'One overlay at a time' },
              ]}
            />
          </Card>
        </div>
      </div>

      <CampaignActionDialog
        pending={pending}
        busy={act.isPending}
        error={act.error}
        onClose={() => setPending(null)}
        onConfirm={(body) => pending && act.mutate({ p: pending, body: myStep && pending.action === 'request-changes' ? { ...body, role: myStep.role } : body })}
      />
    </AdminLayout>
  );
}
