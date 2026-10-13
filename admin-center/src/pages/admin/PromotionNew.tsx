import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney, num } from '@marketly/web-shared/lib/format';
import { useScrollRegion, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, Field, Icon, Img, PageHeader, Price, Radio, Select, StatusBadge, TableWrap, Textarea, TextInput, announce, type IconName } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { LoadError, SkeletonLines, dateTime, shortDate } from '@/app/parts';
import { STATUS_LABEL, kindLabel, type Campaign, type CampaignInput } from './data/promotions';

// Design: pages/admin/admin-promotion-new.html (step 1, set up) · view "finance-confirmation" = after "Send to Finance":
// step 2, the setup locked (.ab-locked) and the Finance confirmation card. QA m-9 (locked text at 2.48:1) is fixed in
// marketly.css (.ab-locked has no opacity); here the locked controls are read-only/disabled without dimming the text.
// Data: ?id=<campaign id> opens a saved campaign (GET /api/admin/promotions/campaigns/{id}); without it the form starts
// empty. Save draft = POST /campaigns (then PATCH); Send to Finance = save + POST /campaigns/{id}/submit; Finance
// confirms with POST /confirm-funding or sends it back with /request-changes. Categories come from
// GET /api/admin/catalog/categories; seller participation from /campaigns/{id}/participations; the price preview from
// POST /campaigns/{id}/price-preview (once the campaign is saved).

/* ---------------- Options ---------------- */

type Kind = 'markdown' | 'percent_coupon' | 'fixed_coupon' | 'min_spend' | 'free_shipping' | 'flash_sale';
const TYPES: Array<{ value: Kind; label: string }> = [
  { value: 'markdown', label: 'Item markdown' },
  { value: 'percent_coupon', label: 'Percentage coupon' },
  { value: 'fixed_coupon', label: 'Fixed-amount coupon' },
  { value: 'min_spend', label: 'Minimum-spend discount' },
  { value: 'free_shipping', label: 'Free shipping' },
  { value: 'flash_sale', label: 'Flash sale' },
];
const typeLabel = (k: string) => TYPES.find((t) => t.value === k)?.label ?? kindLabel(k);
const PERCENT_TYPES: Kind[] = ['markdown', 'percent_coupon', 'flash_sale'];
const CODE_TYPES: Kind[] = ['percent_coupon', 'fixed_coupon', 'min_spend'];
const TIME_ZONES = [
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)', short: 'PT' },
  { value: 'America/Denver', label: 'Mountain Time (MT)', short: 'MT' },
  { value: 'America/Chicago', label: 'Central Time (CT)', short: 'CT' },
  { value: 'America/New_York', label: 'Eastern Time (ET)', short: 'ET' },
];

type Audience = 'everyone' | 'signed_in' | 'new_customers' | 'regions';
const CUSTOMERS: Array<{ value: Audience; label: string; short: string }> = [
  { value: 'everyone', label: 'All customers, including guests', short: 'Everyone' },
  { value: 'signed_in', label: 'Signed-in customers', short: 'Signed-in' },
  { value: 'new_customers', label: 'New customers (first order)', short: 'New customers' },
  { value: 'regions', label: 'Customers in selected regions', short: 'Selected regions' },
];

type Funding = 'platform' | 'seller' | 'shared';
const FUNDING: Array<{ value: Funding; label: string; body: string; platformShare: number }> = [
  { value: 'platform', label: 'Platform', body: 'Marketly pays the full discount. Seller proceeds are unchanged.', platformShare: 1 },
  { value: 'seller', label: 'Seller', body: 'Each participating seller pays for its own offers.', platformShare: 0 },
  { value: 'shared', label: 'Shared', body: 'Platform 50% · sellers 50% of the discount on seller offers', platformShare: 0.5 },
];

type ComboKey = 'withSellerMarkdowns' | 'withOtherCoupons' | 'withFreeShipping' | 'withFlashSalePrices';
const COMBOS: Array<{ key: ComboKey; label: string; short: string }> = [
  { key: 'withSellerMarkdowns', label: 'Combines with seller markdowns', short: 'markdowns' },
  { key: 'withOtherCoupons', label: 'Combines with other coupons', short: 'other coupons' },
  { key: 'withFreeShipping', label: 'Combines with free shipping offers', short: 'free shipping' },
  { key: 'withFlashSalePrices', label: 'Applies to items already in a flash sale', short: 'flash sales' },
];

const STEPS = ['Set up', 'Finance confirmation', 'Content and pages', 'Scheduled'];

/* ---------------- Form ---------------- */

interface Cat {
  id: string;
  name: string;
  offers: number;
}

interface Form {
  name: string;
  type: Kind;
  code: string;
  note: string;
  /** datetime-local values (wall time in the campaign's time zone) */
  start: string;
  end: string;
  tz: string;
  scope: 'categories' | 'products';
  cats: Cat[];
  customers: Audience;
  value: string;
  max: string;
  budget: string;
  cap: string;
  perCustomer: string;
  perOrder: string;
  funding: Funding;
  combos: Record<ComboKey, boolean>;
  invite: boolean;
}

const EMPTY: Form = {
  name: '',
  type: 'percent_coupon',
  code: '',
  note: '',
  start: '',
  end: '',
  tz: TIME_ZONES[0].value,
  scope: 'categories',
  cats: [],
  customers: 'everyone',
  value: '',
  max: '',
  budget: '',
  cap: '',
  perCustomer: '1',
  perOrder: '1',
  funding: 'platform',
  combos: { withSellerMarkdowns: true, withOtherCoupons: false, withFreeShipping: true, withFlashSalePrices: false },
  invite: false,
};

const toNum = (s: string) => Number(s.replace(/[$,\s]/g, ''));
const isInt = (s: string) => /^\d[\d,]*$/.test(s.trim()) && toNum(s) > 0;
const cents = (s: string) => Math.round(toNum(s) * 100);
const usd = (amount: number) => ({ amount, currency: 'USD' });

type Errors = Partial<Record<'name' | 'code' | 'start' | 'end' | 'cats' | 'value' | 'max' | 'budget' | 'cap' | 'perCustomer' | 'perOrder', string>>;

function validate(f: Form): Errors {
  const e: Errors = {};
  const pct = PERCENT_TYPES.includes(f.type);
  if (!f.name.trim()) e.name = 'Enter a campaign name.';
  if (CODE_TYPES.includes(f.type) && f.code.trim() && !/^[A-Z0-9]{4,20}$/.test(f.code.trim())) e.code = 'Use 4–20 capital letters or digits, like FALLHOME20.';
  if (!f.start.trim()) e.start = 'Enter a start date and time.';
  if (!f.end.trim()) e.end = 'Enter an end date and time.';
  else if (f.start && f.end <= f.start) e.end = 'The end must be after the start.';
  if (f.scope === 'categories' && !f.cats.length) e.cats = 'Add at least one category.';
  if (f.type !== 'free_shipping') {
    const v = toNum(f.value);
    if (!f.value.trim() || Number.isNaN(v) || v <= 0) e.value = 'Enter the discount value.';
    else if (pct && v > 90) e.value = 'Enter a discount between 1% and 90%.';
  }
  if (f.max.trim() && (Number.isNaN(toNum(f.max)) || toNum(f.max) <= 0)) e.max = 'Enter an amount, or leave it empty for no maximum.';
  if (!(toNum(f.budget) > 0)) e.budget = 'Enter the total budget.';
  if (f.cap.trim() && !isInt(f.cap)) e.cap = 'Enter a whole number of redemptions, or leave it empty.';
  if (!isInt(f.perCustomer)) e.perCustomer = 'Enter a whole number.';
  if (f.perOrder.trim() !== '1') e.perOrder = 'A campaign applies at most once per order: enter 1.';
  return e;
}

/** Offset of a time zone from UTC at an instant, in minutes. */
function tzOffset(tz: string, at: Date): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return (asUtc - at.getTime()) / 60000;
}
/** "2026-10-16T00:00" in tz → ISO instant. */
function wallToIso(wall: string, tz: string): string {
  const guess = new Date(`${wall}:00Z`);
  return new Date(guess.getTime() - tzOffset(tz, guess) * 60000).toISOString();
}
/** ISO instant → "2026-10-16T00:00" wall time in tz. */
function isoToWall(iso: string, tz: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() + tzOffset(tz, d) * 60000).toISOString().slice(0, 16);
}

function period(f: Form, withYear: boolean) {
  const tz = TIME_ZONES.find((t) => t.value === f.tz)?.short ?? f.tz;
  if (!f.start || !f.end) return 'Not set';
  const fmt = (w: string, o: Intl.DateTimeFormatOptions) => new Date(`${w}:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
  const a = fmt(f.start, { month: 'short', day: 'numeric' });
  const b = fmt(f.end, { month: 'short', day: 'numeric' });
  return `${a} – ${b}${withYear ? `, ${fmt(f.end, { year: 'numeric' })}` : ''} ${tz}`;
}
const fmtCap = (n: number) => `$${Number.isInteger(n) ? num(n) : n.toFixed(2)}`;
const andList = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

function fromCampaign(c: Campaign, cats: Cat[]): Form {
  const d = c.discount;
  const pct = d.percentOffBps != null;
  const included = c.scope.include.filter((t) => t.kind === 'category').map((t) => cats.find((x) => x.id === t.id) ?? { id: t.id, name: t.label ?? 'Category', offers: 0 });
  return {
    name: c.name,
    type: (TYPES.some((t) => t.value === d.kind) ? d.kind : 'percent_coupon') as Kind,
    code: c.code ?? '',
    note: c.internalNote ?? '',
    start: isoToWall(c.period.startsAt, c.period.timeZone),
    end: isoToWall(c.period.endsAt, c.period.timeZone),
    tz: c.period.timeZone,
    scope: c.scope.mode === 'categories' || c.scope.mode === 'sitewide' ? 'categories' : 'products',
    cats: included,
    customers: c.eligibility.audience,
    value: pct ? String((d.percentOffBps ?? 0) / 100) : d.amountOff ? String(d.amountOff.amount / 100) : '',
    max: d.maxDiscountPerOrder ? String(d.maxDiscountPerOrder.amount / 100) : '',
    budget: c.limits.budget ? String(c.limits.budget.amount / 100) : '',
    cap: c.limits.usageCap != null ? String(c.limits.usageCap) : '',
    perCustomer: c.limits.perCustomer != null ? String(c.limits.perCustomer) : '1',
    perOrder: c.limits.perOrder != null ? String(c.limits.perOrder) : '1',
    funding: c.funding.owner,
    combos: {
      withSellerMarkdowns: c.stacking.withSellerMarkdowns,
      withOtherCoupons: c.stacking.withOtherCoupons,
      withFreeShipping: c.stacking.withFreeShipping,
      withFlashSalePrices: c.stacking.withFlashSalePrices,
    },
    invite: !!c.participation?.inviteSellers,
  };
}

function toInput(f: Form, exclude: CampaignInput['scope']['exclude']): CampaignInput {
  const pct = PERCENT_TYPES.includes(f.type);
  const v = toNum(f.value);
  return {
    name: f.name.trim(),
    internalNote: f.note.trim() || null,
    code: CODE_TYPES.includes(f.type) && f.code.trim() ? f.code.trim() : null,
    discount: {
      kind: f.type,
      percentOffBps: pct ? Math.round(v * 100) : null,
      amountOff: !pct && f.type !== 'free_shipping' && f.type !== 'min_spend' ? usd(cents(f.value)) : f.type === 'min_spend' ? usd(cents(f.value)) : null,
      maxDiscountPerOrder: f.max.trim() ? usd(cents(f.max)) : null,
      freeShipping: f.type === 'free_shipping' ? true : null,
    },
    startsAt: wallToIso(f.start, f.tz),
    endsAt: wallToIso(f.end, f.tz),
    timeZone: f.tz,
    scope: { mode: f.scope === 'categories' ? 'categories' : 'products', include: f.scope === 'categories' ? f.cats.map((c) => ({ kind: 'category' as const, id: c.id, label: c.name })) : [], exclude },
    eligibility: { audience: f.customers },
    limits: { budget: usd(cents(f.budget)), usageCap: f.cap.trim() ? toNum(f.cap) : null, perCustomer: toNum(f.perCustomer), perOrder: 1 },
    funding: { owner: f.funding, platformShareBps: f.funding === 'shared' ? 5000 : null },
    stacking: { ...f.combos },
    participation: { inviteSellers: f.invite, rules: [] },
  };
}

/* ---------------- Page-local helpers ---------------- */

/** Progress steps with the design's "Step N of M:" sr-only text on the current step (missing from the shared Steps). */
function WizardSteps({ items, current }: { items: string[]; current: number }) {
  const ref = useScrollRegion<HTMLOListElement>();
  return (
    <ol className="steps" aria-label="Progress" ref={ref} data-scroll-region="">
      {items.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && <li className="bar" aria-hidden="true" />}
          <li className={cx('step', i < current && 'is-done', i === current && 'is-current')} aria-current={i === current ? 'step' : undefined}>
            {i < current && <span className="sr-only">Completed: </span>}
            <span className="n">{i < current ? <Icon name="check" className="ic-sm" /> : i + 1}</span>
            {i === current && <span className="sr-only">{`Step ${i + 1} of ${items.length}: `}</span>}
            {s}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

function Section({ n, title, sub, children }: { n: number; title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <Card
      titleAs={n === 1 ? 'h2' : 'h3'}
      title={
        <span className="row gap-2">
          <Badge tone="outline">{n}</Badge>
          {title}
        </span>
      }
      sub={sub}
    >
      {children}
    </Card>
  );
}

type Check = { tone: 'ok' | 'info' | 'warn'; text: string; sub?: string };
const CHECK_ICON: Record<Check['tone'], IconName> = { ok: 'circle-check', info: 'info', warn: 'triangle-alert' };
const CHECK_SR: Record<Check['tone'], string> = { ok: 'Passed: ', info: '', warn: 'Warning: ' };

function Checks({ items }: { items: Check[] }) {
  return (
    <ul className="ab-checks">
      {items.map((c) => (
        <li key={c.text} className={`t-${c.tone}`}>
          {CHECK_SR[c.tone] && <span className="sr-only">{CHECK_SR[c.tone]}</span>}
          <Icon name={CHECK_ICON[c.tone]} className="ic-sm" />
          <span className="stack gap-0">
            <span>{c.text}</span>
            {c.sub && <span className="xs muted">{c.sub}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SumList({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <div className="ab-sumlist">
      {rows.map(([k, v]) => (
        <div key={k}>
          <span>{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}

const PARTICIPATION_LABEL: Record<string, string> = { invited: 'Pending', accepted: 'Accepted', declined: 'Declined', withdrawal_requested: 'Withdrawal requested', withdrawn: 'Withdrawn', removed: 'Removed', expired: 'Expired' };

/* ---------------- Page ---------------- */

interface CategoryNode {
  id: string;
  name: string;
  offerCount: number;
  children?: CategoryNode[];
}

export default function PromotionNew() {
  const [params] = useSearchParams();
  const id = params.get('id') ?? '';
  const { api } = useApi();
  const cats = useQuery({
    queryKey: ['catalog', 'categories', 'admin'],
    queryFn: async () => {
      const tree = (await call(api.GET('/api/admin/catalog/categories'))) as unknown as CategoryNode[];
      const out: Cat[] = [];
      for (const top of tree) for (const c of top.children?.length ? top.children : [top]) out.push({ id: c.id, name: c === top ? top.name : `${top.name} › ${c.name}`, offers: c.offerCount });
      return out;
    },
  });
  const campaign = useQuery({ queryKey: ['promotions', 'campaign', id], enabled: !!id, queryFn: () => call(api.GET('/api/admin/promotions/campaigns/{id}', { params: { path: { id } } })) });

  if (id && campaign.isError) {
    const notFound = campaign.error instanceof ApiError && campaign.error.status === 404;
    return (
      <AdminLayout active="promotions">
        <PageHeader crumbs={[{ label: 'Promotions and coupons', to: href('admin/promotions') }, { label: 'Campaign' }]} title={notFound ? 'Campaign not found' : 'Campaign'} />
        {notFound ? (
          <Card pad>
            <EmptyState icon="search-x" title="This campaign doesn’t exist" as="h2" action={<Button to={href('admin/promotions')}>Back to promotions</Button>}>
              It may have been removed. Open it again from Promotions and coupons.
            </EmptyState>
          </Card>
        ) : (
          <LoadError error={campaign.error} onRetry={() => void campaign.refetch()} />
        )}
      </AdminLayout>
    );
  }
  if ((id && !campaign.data) || (cats.isPending && !cats.isError)) {
    return (
      <AdminLayout active="promotions">
        <PageHeader crumbs={[{ label: 'Promotions and coupons', to: href('admin/promotions') }, { label: id ? 'Campaign' : 'New campaign' }]} title={id ? 'Campaign' : 'Create campaign'} />
        <div className="ab-main wide">
          <Card pad>
            <SkeletonLines rows={8} />
          </Card>
          <Card pad>
            <SkeletonLines rows={5} />
          </Card>
        </div>
      </AdminLayout>
    );
  }
  return <Editor key={campaign.data?.id ?? 'new'} campaign={campaign.data} categories={cats.data ?? []} categoriesError={cats.isError ? cats.error : null} />;
}

function Editor({ campaign: c, categories, categoriesError }: { campaign?: Campaign; categories: Cat[]; categoriesError: unknown }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [, setParams] = useSearchParams();
  const { can, name: me } = useStaffSession();
  const canManage = can('promotions.campaigns.manage');
  const canConfirm = can('promotions.funding.confirm');
  const canPublish = can('promotions.campaigns.publish');

  const [view, setView] = useView<'finance-confirmation'>();
  const [f, setF] = useState<Form>(() => (c ? fromCampaign(c, categories) : EMPTY));
  const [attempted, setAttempted] = useState(false);
  const [comment, setComment] = useState('');
  const [commentErr, setCommentErr] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; title: string; text: string } | null>(null);

  const status = c?.status ?? 'draft';
  const review = c?.fundingReview;
  const editable = canManage && (!c || ((status === 'draft' || status === 'changes_requested') && !c.locked));
  // The finance view follows the campaign: in review (or the view opened by hand on a campaign sent before).
  const finance = status === 'in_review' || (view === 'finance-confirmation' && !!c && status !== 'draft' && status !== 'changes_requested');
  const confirmed = !!c && ['approved', 'scheduled', 'live', 'paused', 'ended'].includes(status);
  const locked = !editable;
  const errors = attempted && editable ? validate(f) : {};
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    // Opening ?view=finance-confirmation on a draft has nothing to show: stay on setup.
    if (view === 'finance-confirmation' && (!c || status === 'draft' || status === 'changes_requested')) setView('', { replace: true });
  }, [view, c, status, setView]);

  const participations = useQuery({
    queryKey: ['promotions', 'participations', c?.id],
    enabled: !!c,
    queryFn: () => call(api.GET('/api/admin/promotions/campaigns/{id}/participations', { params: { path: { id: c!.id }, query: { limit: 50 } } })),
  });
  const preview = useQuery({
    queryKey: ['promotions', 'price-preview', c?.id, c?.version],
    enabled: !!c,
    retry: false,
    queryFn: () => call(api.POST('/api/admin/promotions/campaigns/{id}/price-preview', { params: { path: { id: c!.id } }, body: {} })),
  });

  // Derived values (summary).
  const pct = PERCENT_TYPES.includes(f.type);
  const value = f.type === 'free_shipping' ? 0 : toNum(f.value) || 0;
  const maxOff = toNum(f.max) || 0;
  const budget = toNum(f.budget) || 0;
  const cap = toNum(f.cap) || 0;
  const fund = FUNDING.find((x) => x.value === f.funding)!;
  const offers = c?.eligible.offers ?? f.cats.reduce((s, x) => s + x.offers, 0);
  const typeSummary =
    f.type === 'percent_coupon' ? `${value}% coupon${maxOff ? `, max ${fmtCap(maxOff)}` : ''}`
    : f.type === 'markdown' ? `${value}% markdown`
    : f.type === 'flash_sale' ? `${value}% flash sale`
    : f.type === 'fixed_coupon' ? `${fmtCap(value)} coupon`
    : f.type === 'min_spend' ? `${fmtCap(value)} off a minimum spend`
    : 'Free shipping';
  const fundSummary = f.funding === 'shared' ? 'Shared 50/50' : fund.label;
  const stacking = COMBOS.filter((x) => f.combos[x.key]).map((x) => x.short);
  const exclusions = c?.scope.exclude ?? [];
  const sellers = participations.data?.items ?? [];
  const example = sellers.find((s) => s.earningsExample)?.earningsExample;

  const refresh = (saved: Campaign) => {
    qc.setQueryData(['promotions', 'campaign', saved.id], saved);
    void qc.invalidateQueries({ queryKey: ['promotions'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const body = toInput(f, exclusions);
      let saved = c ? await call(api.PATCH('/api/admin/promotions/campaigns/{id}', { params: { path: { id: c.id } }, body: { ...body, version: c.version } })) : await call(api.POST('/api/admin/promotions/campaigns', { body }));
      if (submit) saved = await call(api.POST('/api/admin/promotions/campaigns/{id}/submit', { params: { path: { id: saved.id } }, body: {} }));
      return { saved, submit };
    },
    onSuccess: ({ saved, submit }) => {
      refresh(saved);
      if (!c) setParams((p) => ({ ...Object.fromEntries(p), id: saved.id, ...(submit ? { view: 'finance-confirmation' } : {}) }), { replace: true });
      else if (submit) setView('finance-confirmation');
      announce(submit ? 'Sent to Finance' : 'Draft saved');
      setNotice(submit ? null : { tone: 'success', title: 'Draft saved', text: `${saved.name} is saved as a draft.` });
    },
  });

  const decide = useMutation({
    mutationFn: async (kind: 'confirm' | 'changes' | 'schedule' | 'withdraw') => {
      if (!c) throw new Error('Save the campaign first.');
      const path = { params: { path: { id: c.id } } };
      if (kind === 'confirm') return call(api.POST('/api/admin/promotions/campaigns/{id}/confirm-funding', { ...path, body: { comment: comment.trim() || null } }));
      if (kind === 'changes') return call(api.POST('/api/admin/promotions/campaigns/{id}/request-changes', { ...path, body: { reason: comment.trim() } }));
      if (kind === 'withdraw') return call(api.POST('/api/admin/promotions/campaigns/{id}/withdraw', path));
      return call(api.POST('/api/admin/promotions/campaigns/{id}/schedule', path));
    },
    onSuccess: (saved, kind) => {
      refresh(saved);
      setComment('');
      void qc.invalidateQueries({ queryKey: ['notifications', 'summary', 'staff'] });
      if (kind === 'changes' || kind === 'withdraw') setView('');
      const approval = saved.fundingReview?.approval;
      if (kind === 'confirm' && approval?.required && saved.status === 'in_review') {
        setNotice({ tone: 'info', title: 'Sent for approval', text: `${approval.reason ?? 'This budget is above your approval limit.'} ${approval.approvers.length ? `Approvers: ${approval.approvers.join(', ')}.` : ''}` });
        announce('Funding confirmation sent for approval');
      } else {
        setNotice(null);
        announce(kind === 'confirm' ? 'Funding confirmed' : kind === 'changes' ? 'Changes requested' : kind === 'withdraw' ? 'Taken back to draft' : 'Campaign scheduled');
      }
    },
  });

  const send = () => {
    setAttempted(true);
    const e = validate(f);
    const first = Object.keys(e)[0];
    if (first) {
      const fid = { name: 'pn-name', code: 'pn-code', start: 'pn-start', end: 'pn-end', cats: 'pn-scope-1', value: 'pn-val', max: 'pn-max', budget: 'pn-bud', cap: 'pn-cap', perCustomer: 'pn-pc', perOrder: 'pn-po' }[first];
      if (fid) document.getElementById(fid)?.focus();
      return;
    }
    save.mutate(true);
  };
  const saveDraft = () => {
    if (!f.name.trim()) {
      setAttempted(true);
      document.getElementById('pn-name')?.focus();
      return;
    }
    if (!f.start || !f.end || !(toNum(f.budget) > 0)) {
      setAttempted(true);
      return;
    }
    save.mutate(false);
  };
  const requestChanges = () => {
    if (!comment.trim()) {
      setCommentErr('Add a comment so Marketing knows what to change.');
      return;
    }
    decide.mutate('changes');
  };

  const removeCat = (cid: string) => !locked && set('cats', f.cats.filter((x) => x.id !== cid));
  const [adding, setAdding] = useState(false);
  const choices = useMemo(() => categories.filter((x) => !f.cats.some((y) => y.id === x.id)), [categories, f.cats]);
  const lockedSub = locked && c ? (
    <span className="xs muted">
      <Icon name="lock" className="ic-sm" /> {status === 'in_review' ? 'Locked while Finance reviews' : !canManage ? 'Your role can view campaigns but not edit them' : `Locked: ${STATUS_LABEL[status] ?? status}`}
    </span>
  ) : undefined;

  const financeChecks: Check[] = (review?.checks ?? []).map((x) => ({ tone: x.state === 'fail' ? 'warn' : x.state, text: x.label, sub: x.detail ?? undefined }));
  const setupChecks: Check[] = (c?.readiness ?? []).map((r) => ({ tone: r.state === 'done' ? 'ok' : 'info', text: `${r.label}${r.owner ? `: ${r.owner}` : ''}` }));
  const sentLine = review?.sentAt ? `Sent ${dateTime(review.sentAt)}` : 'Sent';
  const reviewer = (review?.reviewer as { name?: string } | null | undefined)?.name;
  const createdBy = (c?.createdBy as { name?: string } | undefined)?.name;
  const step = confirmed ? (status === 'scheduled' || status === 'live' || status === 'paused' || status === 'ended' ? 3 : 2) : finance ? 1 : 0;
  const card = preview.data?.productCard;

  return (
    <AdminLayout active="promotions">
      <PageHeader
        crumbs={[{ label: 'Promotions and coupons', to: href('admin/promotions') }, { label: c ? c.name : 'New campaign' }]}
        title={c ? c.name : 'Create campaign'}
        sub={c ? `${typeLabel(c.discount.kind)} · ${c.period.display}${createdBy ? ` · created by ${createdBy}` : ''}` : 'Marketing sets up the campaign. Finance confirms funding before it can go live.'}
        actions={c ? <StatusBadge status={STATUS_LABEL[status] ?? status} /> : undefined}
      />
      <WizardSteps items={STEPS} current={step} />
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.text}
        </Alert>
      )}
      {categoriesError != null && <LoadError error={categoriesError} onRetry={() => void qc.invalidateQueries({ queryKey: ['catalog', 'categories', 'admin'] })} title="We couldn’t load the categories" />}
      {finance &&
        (confirmed ? null : (
          <Alert tone="info" title="Waiting for Finance">
            Edits are locked while Finance reviews the funding{reviewer ? ` (${reviewer})` : ''}. You get a notification when it is confirmed or sent back.
          </Alert>
        ))}
      {confirmed && (
        <Alert tone="success" title="Funding confirmed">
          {review?.decidedAt ? `Finance confirmed the funding ${dateTime(review.decidedAt)}${reviewer ? ` (${reviewer})` : ''}. ` : 'Finance confirmed the funding. '}
          {status === 'approved' ? 'Content can now prepare the banner and campaign page, then schedule it.' : `The campaign is ${STATUS_LABEL[status]?.toLowerCase() ?? status}.`}
        </Alert>
      )}
      {status === 'changes_requested' && (
        <Alert tone="warning" title="Finance requested changes">
          {review?.comment ?? 'Finance sent the campaign back. Update it and send it again.'}
        </Alert>
      )}
      <div className="ab-main wide">
        <div className={cx('stack gap-4', locked && c && 'ab-locked')}>
          <Section n={1} title="Basics" sub={lockedSub}>
            <div className="ab-form-grid">
              <Field label="Campaign name" error={errors.name}>
                <TextInput id="pn-name" value={f.name} error={!!errors.name} readOnly={locked} onChange={(e) => set('name', e.target.value)} placeholder="" />
              </Field>
              <Field label="Promotion type">
                <Select id="pn-type" options={TYPES} value={f.type} disabled={locked} onChange={(e) => set('type', e.target.value as Kind)} />
              </Field>
              <Field label="Coupon code" optional hint={CODE_TYPES.includes(f.type) ? 'Leave empty for a clip-only coupon' : 'Not used for this type'} error={errors.code}>
                <TextInput id="pn-code" value={f.code} error={!!errors.code} readOnly={locked || !CODE_TYPES.includes(f.type)} onChange={(e) => set('code', e.target.value.toUpperCase())} placeholder="" />
              </Field>
              <Field label="Internal note" optional>
                <TextInput id="pn-note" value={f.note} readOnly={locked} onChange={(e) => set('note', e.target.value)} placeholder="" />
              </Field>
            </div>
          </Section>
          <Section n={2} title="Schedule">
            <div className="ab-form-grid c3">
              <Field label="Starts" error={errors.start}>
                <TextInput id="pn-start" type="datetime-local" icon="calendar" value={f.start} error={!!errors.start} readOnly={locked} onChange={(e) => set('start', e.target.value)} placeholder="" />
              </Field>
              <Field label="Ends" error={errors.end}>
                <TextInput id="pn-end" type="datetime-local" icon="calendar" value={f.end} error={!!errors.end} readOnly={locked} onChange={(e) => set('end', e.target.value)} placeholder="" />
              </Field>
              <Field label="Time zone">
                <Select id="pn-tz" options={TIME_ZONES} value={f.tz} disabled={locked} onChange={(e) => set('tz', e.target.value)} />
              </Field>
            </div>
            <p className="ab-note">
              <Icon name="info" className="ic-sm" /> Countdowns on the Deals page use these exact times.
            </p>
          </Section>
          <Section n={3} title="Products and offers">
            <fieldset className="stack gap-2 fieldset-reset">
              <legend className="sr-only">What the campaign covers</legend>
              <Radio id="pn-scope-1" name="pn-scope" label="Categories" checked={f.scope === 'categories'} disabled={locked} onChange={() => set('scope', 'categories')} />
              <Radio id="pn-scope-2" name="pn-scope" label="Selected products or offers" checked={f.scope === 'products'} disabled />
            </fieldset>
            <div className="hscroll gap-2">
              {f.cats.map((x) => (
                <a
                  key={x.id}
                  className="chip is-active"
                  href="#"
                  aria-current="true"
                  onClick={(e) => {
                    e.preventDefault();
                    removeCat(x.id);
                  }}
                >
                  {x.name}
                  {!locked && <Icon name="x" className="ic-sm" />}
                </a>
              ))}
              {!locked && choices.length > 0 && !adding && (
                <a
                  className="chip"
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setAdding(true);
                  }}
                >
                  <Icon name="plus" />
                  Add category
                </a>
              )}
            </div>
            {adding && !locked && (
              <Select
                id="pn-cat-add"
                aria-label="Add category"
                value=""
                options={[{ value: '', label: 'Choose a category' }, ...choices.map((x) => ({ value: x.id, label: `${x.name} (${x.offers} offers)` }))]}
                onChange={(e) => {
                  const pick = choices.find((x) => x.id === e.target.value);
                  if (pick) set('cats', [...f.cats, pick]);
                  setAdding(false);
                }}
              />
            )}
            {errors.cats && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                {errors.cats}
              </span>
            )}
            <span className="xs muted">
              {offers} eligible offers
              {c ? ` · ${c.eligible.sellers} sellers${c.eligible.officialStore ? ' + Official Store' : ''}${c.eligible.excludedOffers ? ` · ${c.eligible.excludedOffers} excluded` : ''}` : ' · exact count after saving'}
              {' · Selecting single products or offers is not available here yet.'}
            </span>
          </Section>
          <Section n={4} title="Eligible customers">
            <div className="ab-checkgrid">
              {CUSTOMERS.map((x, i) => (
                <Radio key={x.value} id={`pn-cust-${i + 1}`} name="pn-cust" label={x.label} checked={f.customers === x.value} disabled={locked || x.value === 'regions'} onChange={() => set('customers', x.value)} />
              ))}
            </div>
          </Section>
          <Section n={5} title="Discount and limits">
            <div className="ab-form-grid c3">
              <Field label="Discount value" error={errors.value}>
                {pct ? (
                  <TextInput id="pn-val" suffix="% off" value={f.value} error={!!errors.value} inputMode="decimal" readOnly={locked} onChange={(e) => set('value', e.target.value)} placeholder="" />
                ) : (
                  <TextInput id="pn-val" prefix="$" value={f.value} error={!!errors.value} inputMode="decimal" readOnly={locked || f.type === 'free_shipping'} onChange={(e) => set('value', e.target.value)} placeholder="" />
                )}
              </Field>
              <Field label="Maximum discount per order" optional error={errors.max}>
                <TextInput id="pn-max" prefix="$" value={f.max} error={!!errors.max} inputMode="decimal" readOnly={locked} onChange={(e) => set('max', e.target.value)} placeholder="" />
              </Field>
              <Field label="Total budget" hint="Campaign stops when the budget is used" error={errors.budget}>
                <TextInput id="pn-bud" prefix="$" value={f.budget} error={!!errors.budget} inputMode="decimal" readOnly={locked} onChange={(e) => set('budget', e.target.value)} placeholder="" />
              </Field>
              <Field label="Usage cap" optional error={errors.cap}>
                <TextInput id="pn-cap" suffix="redemptions" value={f.cap} error={!!errors.cap} inputMode="numeric" readOnly={locked} onChange={(e) => set('cap', e.target.value)} placeholder="" />
              </Field>
              <Field label="Per customer" error={errors.perCustomer}>
                <TextInput id="pn-pc" suffix="use" value={f.perCustomer} error={!!errors.perCustomer} inputMode="numeric" readOnly={locked} onChange={(e) => set('perCustomer', e.target.value)} placeholder="" />
              </Field>
              <Field label="Per order" error={errors.perOrder}>
                <TextInput id="pn-po" suffix="coupon" value={f.perOrder} error={!!errors.perOrder} inputMode="numeric" readOnly={locked} onChange={(e) => set('perOrder', e.target.value)} placeholder="" />
              </Field>
            </div>
          </Section>
          <Section n={6} title="Funding owner">
            <div className="ab-checkgrid">
              {/* Inline opt-cards: OptionCard's disabled state adds .is-disabled (opacity), which the lock must not use (m-9). */}
              {FUNDING.map((o, i) => (
                <label key={o.value} className={cx('opt-card', f.funding === o.value && 'is-selected')} htmlFor={`pn-fund-${i + 1}`}>
                  <input type="radio" name="pn-fund" id={`pn-fund-${i + 1}`} checked={f.funding === o.value} disabled={locked} onChange={() => set('funding', o.value)} />
                  <span className="stack gap-1 grow">
                    <span className="small strong">{o.label}</span>
                    <span className="small sub">{o.body}</span>
                  </span>
                </label>
              ))}
            </div>
            <span className="xs muted">Official Store items: the discount is a company cost and shows in company trading margin.</span>
          </Section>
          <Section n={7} title="Combination rules and exclusions">
            <div className="ab-checkgrid">
              {COMBOS.map((x, i) => (
                <Checkbox key={x.key} id={`pn-c${i + 1}`} label={x.label} checked={f.combos[x.key]} disabled={locked} onChange={(e) => set('combos', { ...f.combos, [x.key]: e.target.checked })} />
              ))}
            </div>
            <div className="field">
              <label className="label">Exclusions</label>
              <div className="row gap-2">
                {exclusions.map((x) => (
                  <Badge key={x.kind + x.id} tone="outline">
                    {x.label ?? x.kind}
                  </Badge>
                ))}
                {!exclusions.length && <span className="xs muted">None. Restricted sellers and products under review are left out automatically.</span>}
              </div>
            </div>
          </Section>
          <Section n={8} title="Seller participation">
            <Checkbox id="pn-sp" label="Invite sellers to join. Each seller must consent before its offers are included." checked={f.invite} disabled={locked} onChange={(e) => set('invite', e.target.checked)} />
            {c ? (
              sellers.length ? (
                <TableWrap label="8 Seller participation table">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Seller</th>
                        <th scope="col">Offers</th>
                        <th scope="col">Consent</th>
                        <th className="r" scope="col">
                          Seller earns per $100 sale
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sellers.map((s) => (
                        <tr key={s.id}>
                          <td>{s.sellerName}</td>
                          <td>{s.offerCount}</td>
                          <td>
                            <StatusBadge status={PARTICIPATION_LABEL[s.state] ?? s.state} />
                          </td>
                          <td className="r">
                            {s.earningsExample ? (
                              <span className="num">
                                {formatMoney(s.earningsExample.sellerEarns)} <span className="xs muted">(was {formatMoney(s.earningsExample.regularSellerEarns)})</span>
                              </span>
                            ) : (
                              <span className="xs muted">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              ) : participations.isPending ? (
                <SkeletonLines rows={2} />
              ) : (
                <span className="xs muted">No sellers invited yet.{f.invite ? ' Invitations go out once Finance confirms the funding.' : ''}</span>
              )
            ) : (
              <span className="xs muted">Sellers can be invited once the campaign is saved.</span>
            )}
            {example && <div className="panel small">{example.explanation}</div>}
            {example && (
              <p className="ab-note">
                <Icon name="info" className="ic-sm" /> {example.isExample ? 'Example rate. ' : ''}Sellers see this estimate on their invitation before they consent.
              </p>
            )}
          </Section>
          <Section n={9} title="Price preview">
            {card && preview.data ? (
              <div className="ab-pv">
                <div>
                  <span className="pcap">Product card</span>
                  <Img icon="package" tint="1" className="r43" src={card.image?.url} alt={card.image?.alt ?? ''} />
                  <span className="small">{card.productTitle}</span>
                  <Price amount={card.price.amount / 100} was={card.wasPrice ? card.wasPrice.amount / 100 : null} />
                  <span className="row gap-2">
                    <Badge className="t-deal-soft">{card.badge}</Badge>
                  </span>
                  <span className="xs muted">Sold by {card.sellerName}</span>
                </div>
                <div>
                  <span className="pcap">Cart</span>
                  <span className="small strong">{preview.data.cart.packageLabel}</span>
                  {preview.data.cart.lines.map((l, i) => (
                    <div key={i} className={cx('sum-row', l.kind === 'discount' && 'discount', l.kind === 'total' && 'total')}>
                      <span>{l.label}</span>
                      <span>{l.kind === 'discount' ? `−${formatMoney({ ...l.amount, amount: Math.abs(l.amount.amount) })}` : formatMoney(l.amount)}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <span className="pcap">Checkout</span>
                  {preview.data.checkout.lines.map((l, i) => (
                    <div key={i} className={cx('sum-row', l.kind === 'discount' && 'discount', l.kind === 'total' && 'total')}>
                      <span>{l.label}</span>
                      <span>{l.kind === 'discount' ? `−${formatMoney({ ...l.amount, amount: Math.abs(l.amount.amount) })}` : formatMoney(l.amount)}</span>
                    </div>
                  ))}
                  <span className="xs muted">{preview.data.checkout.appliedNote}</span>
                </div>
              </div>
            ) : c && preview.isPending ? (
              <SkeletonLines rows={3} />
            ) : (
              <span className="xs muted">{c ? (preview.isError ? `No preview: ${errorMessage(preview.error)}` : 'No eligible offer to preview.') : 'Save the draft to preview the product card, cart and checkout with a real offer.'}</span>
            )}
          </Section>
        </div>
        <div className="stack gap-4 ab-sticky">
          {finance || confirmed ? (
            <Card
              title="Finance confirmation"
              titleAs="h3"
              sub={confirmed ? `Confirmed${review?.decidedAt ? ` ${dateTime(review.decidedAt)}` : ''}${reviewer ? ` by ${reviewer}` : ''}` : `${sentLine} · waiting on Finance`}
              foot={
                confirmed ? (
                  <>
                    <Button variant="secondary" size="sm" to={href('admin/promotions')}>
                      Back to promotions
                    </Button>
                    {status === 'approved' && canPublish && (
                      <Button size="sm" icon="calendar" onClick={() => decide.mutate('schedule')} disabled={decide.isPending}>
                        Schedule
                      </Button>
                    )}
                  </>
                ) : canConfirm ? (
                  <>
                    <Button variant="secondary" size="sm" onClick={requestChanges} disabled={decide.isPending}>
                      Request changes
                    </Button>
                    <Button size="sm" icon="check" onClick={() => decide.mutate('confirm')} disabled={decide.isPending}>
                      Confirm funding
                    </Button>
                  </>
                ) : canManage ? (
                  <Button variant="secondary" size="sm" onClick={() => decide.mutate('withdraw')} disabled={decide.isPending}>
                    Take back to draft
                  </Button>
                ) : undefined
              }
            >
              {financeChecks.length > 0 && <Checks items={financeChecks} />}
              {review && (
                <SumList
                  rows={[
                    ['Platform maximum', formatMoney(review.platformMaximum)],
                    ['Sellers maximum', formatMoney(review.sellersMaximum)],
                    ['Expected sales', review.expectedSales ? formatMoney(review.expectedSales) : '—'],
                    ['Official Store margin impact', review.officialMarginImpactPts != null ? `${review.officialMarginImpactPts < 0 ? '−' : ''}${Math.abs(review.officialMarginImpactPts)} pts` : '—'],
                  ]}
                />
              )}
              {decide.isError && (
                <Alert tone="danger" title="That didn’t work">
                  {errorMessage(decide.error)}
                </Alert>
              )}
              {!confirmed && canConfirm && (
                <Field label="Finance comment" error={commentErr || undefined}>
                  <Textarea
                    id="pn-fin"
                    placeholder="Visible to Marketing"
                    className={cx(commentErr && 'is-error')}
                    value={comment}
                    onChange={(e) => {
                      setComment(e.target.value);
                      if (commentErr) setCommentErr('');
                    }}
                  />
                </Field>
              )}
              {!confirmed && !canConfirm && <span className="xs muted">Finance confirms the funding. Your role can’t confirm it.</span>}
            </Card>
          ) : (
            <Card
              title="Summary"
              titleAs="h3"
              sub={c ? `${STATUS_LABEL[status] ?? status} · last saved ${dateTime(c.updatedAt)}` : 'Not saved yet'}
              foot={
                editable ? (
                  <>
                    <Button variant="ghost" size="sm" onClick={saveDraft} disabled={save.isPending}>
                      Save draft
                    </Button>
                    <Button size="sm" icon="send" onClick={send} disabled={save.isPending}>
                      Send to Finance
                    </Button>
                  </>
                ) : undefined
              }
            >
              <SumList
                rows={[
                  ['Type', typeSummary],
                  ['Period', period(f, false)],
                  ['Covers', f.scope === 'categories' ? `${offers} offers in ${f.cats.length} ${f.cats.length === 1 ? 'category' : 'categories'}` : 'Selected products or offers'],
                  ['Customers', CUSTOMERS.find((x) => x.value === f.customers)?.short ?? f.customers],
                  ['Budget', `${fmtCap(budget)}${cap ? ` · ${num(cap)} uses` : ''}`],
                  ['Funding', fundSummary],
                  ['Stacking', stacking.length ? `With ${andList(stacking)}` : 'Does not combine'],
                ]}
              />
              <div className="divider" />
              <span className="small strong">Before publishing</span>
              {setupChecks.length ? (
                <Checks items={setupChecks} />
              ) : (
                <Checks items={[{ tone: 'ok', text: `Marketing: ${me || 'you'}` }, { tone: 'info', text: 'Finance confirms funding' }, { tone: 'info', text: 'Content prepares banner and campaign page' }]} />
              )}
              {!canManage && <span className="xs muted">Your role can view campaigns but not create or edit them.</span>}
              {save.isError && (
                <Alert tone="danger" title="The campaign wasn’t saved">
                  {errorMessage(save.error)}
                </Alert>
              )}
              {attempted && Object.keys(errors).length > 0 && (
                <Alert tone="danger" title="Fix the highlighted fields">
                  {`${Object.keys(errors).length} ${Object.keys(errors).length === 1 ? 'field needs' : 'fields need'} attention before Finance can review the campaign.`}
                </Alert>
              )}
            </Card>
          )}
          {status === 'approved' && (
            <p className="ab-note">
              <Icon name="info" className="ic-sm" /> Next: Content prepares the banner and campaign page. <Link to={href('admin/content')}>Open Homepage and pages</Link>
            </p>
          )}
          {c && <span className="xs muted">{`${c.ref} · ${shortDate(c.createdAt)}`}</span>}
        </div>
      </div>
    </AdminLayout>
  );
}
