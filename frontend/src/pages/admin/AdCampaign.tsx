import { Fragment, useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { useScrollRegion, useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, announce, Badge, Breadcrumbs, Button, Card, Field, Icon, Img, SegmentedControl, Select, Textarea, TextInput, type IconName } from '@/ui';

// Design: pages/admin/admin-ad-campaign.html (step 1) and --placement-audience, --schedule-limits,
// --creative-preview, --approval (steps 2–5). One draft object is kept across the steps; the step is the view.

type Step = '' | 'placement-audience' | 'schedule-limits' | 'creative-preview' | 'approval';
const STEPS: Array<{ view: Step; label: string; next?: string }> = [
  { view: '', label: 'Goal & advertiser', next: 'Continue to placement & audience' },
  { view: 'placement-audience', label: 'Placement & audience', next: 'Continue to schedule & limits' },
  { view: 'schedule-limits', label: 'Schedule & limits', next: 'Continue to creative & preview' },
  { view: 'creative-preview', label: 'Creative & preview', next: 'Continue to approval' },
  { view: 'approval', label: 'Approval' },
];

const ADVERTISERS = [
  { title: 'Marketly (own promotion)', body: 'No charge. Owned by Advertising.', summary: 'Marketly · own promotion', short: 'own promotion' },
  { title: 'Seller (paid)', body: 'Seller request with spending limit and billing', summary: 'Seller · paid', short: 'seller paid' },
  { title: 'Brand (paid)', body: 'Brand campaign across sellers', summary: 'Brand · paid', short: 'brand paid' },
  { title: 'Official Store product', body: 'Company product promotion', summary: 'Official Store product', short: 'Official Store product' },
];
const GOALS = ['Company promotion', 'Platform event', 'Seller offer', 'Brand campaign'];
const PROMOS = ['Fall Home Sale (FALLHOME20)', 'Home Week markdowns', 'None'];
const OWNERS = ['Jamie Brooks · Advertising', 'Noor Aziz · Content'];

const AD_TYPES: Array<{ label: string; icon: IconName; body: string; badge?: { text: string; tone?: 'brand' | 'info' }; disabled?: boolean }> = [
  { label: 'Opening full-screen', icon: 'app-window', body: 'Appears when a visitor opens the site. Close or skip always visible.', badge: { text: 'Launch', tone: 'brand' } },
  { label: 'Banner', icon: 'rectangle-horizontal', body: 'Image or message on home, category and campaign pages.', badge: { text: 'Launch', tone: 'brand' } },
  { label: 'Pop-up', icon: 'message-square', body: 'Dismissible window after a set trigger.', badge: { text: 'Launch', tone: 'brand' } },
  { label: 'Sponsored product', icon: 'package', body: 'Labeled product card in search and categories.', badge: { text: 'Pilot', tone: 'info' } },
  { label: 'Sponsored store or brand', icon: 'store', body: 'Labeled feature linking to a seller store or brand.' },
  { label: 'Floating panel', icon: 'panel-bottom', body: 'Compact dismissible strip while browsing.' },
  { label: 'Interstitial', icon: 'layers', body: 'Between selected browsing steps, never in checkout.' },
  { label: 'Video', icon: 'video', body: 'Promotional video with playback and mute controls.', badge: { text: 'Later' }, disabled: true },
];
const PAGES = [
  { label: 'Home page', short: 'Home' },
  { label: 'Category pages: Home & Kitchen', short: 'Home & Kitchen' },
  { label: 'Campaign pages', short: 'Campaign pages' },
  { label: 'Search results', short: 'Search' },
  { label: 'Product pages', short: 'Product pages' },
];
const REGIONS = ['All of the United States', 'West Coast: CA, OR, WA', 'Mountain: CO, ID, NV, UT'];
const VISITORS = ['New and returning', 'New visitors only', 'Returning visitors only'];
const SIGN_IN = ['Signed-in customers only', 'Everyone, including guests'];
const INTERESTS = ['Home & Kitchen', 'Any category'];
const TIME_ZONES = ['Pacific Time (PT)', 'Eastern Time (ET)'];
const FREQUENCIES = ['Once per session', 'Once per day', 'Once per campaign', 'Twice per week'];
const DISMISS = ['Do not show again for 7 days', 'Do not show again this campaign', 'Show again next session'];
const PRIORITIES = ['High (3)', 'Normal (2)', 'Low (1)'];

interface Creative { name: string; meta: string }
interface Draft {
  advertiser: number;
  goal: number;
  name: string;
  promo: string;
  dest: string;
  owner: string;
  type: number;
  pages: boolean[];
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
  headline: string;
  text: string;
  button: string;
  link: string;
  note: string;
}

const INITIAL: Draft = {
  advertiser: 0,
  goal: 1,
  name: 'Fall Home Sale opening ad',
  promo: PROMOS[0],
  dest: '/campaign/fall-home-sale',
  owner: OWNERS[0],
  type: 0,
  pages: [true, true, false, false, false],
  audience: 'selected',
  region: REGIONS[0],
  visitors: VISITORS[0],
  signIn: SIGN_IN[0],
  interest: INTERESTS[0],
  start: 'Oct 16, 2026, 12:00 AM',
  end: 'Oct 25, 2026, 11:59 PM',
  tz: TIME_ZONES[0],
  freq: FREQUENCIES[0],
  dismiss: DISMISS[0],
  priority: PRIORITIES[0],
  cap: '250,000',
  stopWithPromo: true,
  desktop: { name: 'fall-home-desktop.jpg', meta: '1600 × 900 · 412 KB · uploaded Oct 8' },
  phone: { name: 'fall-home-mobile.jpg', meta: '1080 × 1920 · 538 KB · uploaded Oct 8' },
  headline: 'Fall Home Sale: 20% off bedding and lighting',
  text: 'Oct 16–25 · Casa Verde Home, Mosswood and the Official Store',
  button: 'Shop the sale',
  link: 'marketly.com/campaign/fall-home-sale',
  note: 'Runs alongside the Fall Home Sale promotion. Same creative as the campaign page banner.',
};

const HEADLINE_MAX = 60;
type Errors = Partial<Record<string, string>>;

/** "Oct 16, 2026, 12:00 AM" -> { m: 'Oct', d: 16 } */
function parseDate(s: string) {
  const m = s.trim().match(/^([A-Z][a-z]{2})\s+(\d{1,2})\b/);
  return m ? { m: m[1], d: Number(m[2]) } : null;
}
const tzShort = (tz: string) => tz.match(/\((\w+)\)/)?.[1] ?? '';
function period(d: Draft) {
  const a = parseDate(d.start);
  const b = parseDate(d.end);
  if (!a || !b) return '—';
  return `${a.m} ${a.d}–${a.m === b.m ? '' : `${b.m} `}${b.d} ${tzShort(d.tz)}`.trim();
}

function validate(step: number, d: Draft): Errors {
  const e: Errors = {};
  if (step === 0) {
    if (!d.name.trim()) e.name = 'Enter a campaign name.';
    if (!d.dest.trim()) e.dest = 'Enter the page the ad links to.';
  } else if (step === 1) {
    if (!d.pages.some(Boolean)) e.pages = 'Choose at least one page.';
  } else if (step === 2) {
    if (!parseDate(d.start)) e.start = 'Enter a start date, like Oct 16, 2026, 12:00 AM.';
    if (!parseDate(d.end)) e.end = 'Enter an end date, like Oct 25, 2026, 11:59 PM.';
    if (!/^[\d,]+$/.test(d.cap.trim())) e.cap = 'Enter a number of displays.';
  } else if (step === 3) {
    if (!d.headline.trim()) e.headline = 'Enter a headline.';
    else if (d.headline.length > HEADLINE_MAX) e.headline = `Shorten the headline to ${HEADLINE_MAX} characters.`;
    if (!d.button.trim()) e.button = 'Enter the button text.';
    if (!d.desktop || !d.phone) e.creative = 'Add a desktop and a phone image.';
  }
  return e;
}

function summaryRows(d: Draft, step: number): Array<[string, string]> {
  const at = (n: number, v: string) => (step >= n && v ? v : '—');
  const pages = PAGES.filter((_, i) => d.pages[i]).map((p) => p.short).join(', ');
  const audience = d.audience === 'all' ? 'All shoppers' : [d.signIn === SIGN_IN[0] ? 'Signed-in' : 'Everyone', d.interest !== 'Any category' ? `${d.interest} interest` : ''].filter(Boolean).join(' · ');
  const creative = d.desktop && d.phone ? 'Desktop + phone' : d.desktop ? 'Desktop only' : d.phone ? 'Phone only' : '';
  return [
    ['Advertiser', ADVERTISERS[d.advertiser].summary],
    ['Goal', GOALS[d.goal]],
    ['Linked promotion', d.promo === 'None' ? '—' : d.promo.replace(/\s*\(.*\)$/, '')],
    ['Ad type', at(1, AD_TYPES[d.type].label)],
    ['Pages', at(1, pages)],
    ['Audience', at(1, audience)],
    ['Period', at(2, period(d))],
    ['Frequency', at(2, d.freq)],
    ['Priority', at(2, d.priority)],
    ['Creative', at(3, creative)],
  ];
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

type Check = { tone: 'ok' | 'warn' | 'info'; t: string; d?: string };
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

function AdPreview({ d, desk }: { d: Draft; desk?: boolean }) {
  return (
    <div className="ab-scrim">
      <div className={cx('ab-ad', desk && 'desk')}>
        <span className="ab-adtag">Ad</span>
        <button type="button" className="ab-adx" aria-label="Close advertisement">
          <Icon name="x" />
        </button>
        <div className="art">
          <Img icon="bed-double" tint="1" />
          <Img icon="lamp-desk" tint="5" />
        </div>
        <div className="copy">
          <b>{d.headline || 'Headline'}</b>
          <span>{d.text}</span>
          <span className="cta">{d.button || 'Button'}</span>
        </div>
      </div>
    </div>
  );
}

const nowTime = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export default function AdCampaign() {
  const [view, setView] = useView<Exclude<Step, ''>>();
  const stepIdx = Math.max(0, STEPS.findIndex((s) => s.view === view));
  const [d, setD] = useState<Draft>(INITIAL);
  const [errors, setErrors] = useState<Errors>({});
  const [savedAt, setSavedAt] = useState('9:41 AM');
  const [submitted, setSubmitted] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const deskFile = useRef<HTMLInputElement>(null);
  const phoneFile = useRef<HTMLInputElement>(null);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((p) => ({ ...p, [k]: v }));
    if (errors[k as string]) setErrors((e) => ({ ...e, [k]: undefined }));
  };
  const go = (i: number) => {
    setErrors({});
    setView(STEPS[i].view);
    window.scrollTo({ top: 0 });
  };
  const next = () => {
    const e = validate(stepIdx, d);
    setErrors(e);
    if (Object.keys(e).length) {
      announce('Check the highlighted fields before you continue.');
      return;
    }
    go(stepIdx + 1);
  };
  const saveDraft = () => {
    const t = nowTime();
    setSavedAt(t);
    announce(`Draft saved at ${t}`);
  };
  const pickFile = (k: 'desktop' | 'phone') => (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      set(k, { name: f.name, meta: `${k === 'desktop' ? '1600 × 900' : '1080 × 1920'} · ${Math.round(f.size / 1024)} KB · uploaded just now` });
      setErrors((x) => ({ ...x, creative: undefined }));
    }
  };

  const onApproval = stepIdx === 4;
  const nErr = Object.values(errors).filter(Boolean).length;
  const claim = d.headline.match(/\d+% off/i)?.[0];
  const creativeChecks: Check[] = [
    { tone: 'ok', t: 'Label: "Ad" shown on desktop and phone' },
    { tone: 'ok', t: 'Close control visible, 44 px on phone, reachable with the keyboard' },
    !claim || claim.toLowerCase() === '20% off'
      ? { tone: 'ok', t: 'Claims: "20% off" matches the Fall Home Sale discount' }
      : { tone: 'warn', t: `Claims: "${claim}" does not match the Fall Home Sale discount`, d: 'The linked promotion gives 20% off.' },
    { tone: 'warn', t: 'Availability: 2 Mosswood offers are out of stock', d: 'They are hidden from the campaign page. 212 offers remain.' },
    { tone: 'ok', t: 'Link: campaign page publishes Oct 16, 12:00 AM, same as ad start' },
    { tone: 'ok', t: 'Text contrast meets 4.5:1 on both images' },
  ];

  return (
    <AdminLayout active="ads">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Advertisements', to: href('admin/ads') }, { label: 'New campaign' }]} />
          <h1 className="h1">{d.name || 'New campaign'}</h1>
          <p className="sub small">
            {AD_TYPES[d.type].label} · {ADVERTISERS[d.advertiser].short} · owner {d.owner.split(' · ')[0]}
          </p>
        </div>
        <div className="actions">{onApproval ? <Badge tone="info">In review</Badge> : <Badge>Draft</Badge>}</div>
      </div>

      <div className="card pad">
        <WizardSteps current={stepIdx} />
      </div>

      <div className="ab-main">
        <div className="stack gap-4">
          {nErr > 0 && (
            <Alert tone="danger" title={`Check ${nErr} field${nErr > 1 ? 's' : ''}`}>
              Fix the highlighted fields to continue.
            </Alert>
          )}

          {stepIdx === 0 && (
            <Card title="Goal and advertiser">
              <fieldset className="stack gap-2 fieldset-reset">
                <legend className="label">Advertiser</legend>
                <div className="ab-checkgrid">
                  {ADVERTISERS.map((a, i) => (
                    <label key={a.title} className={cx('opt-card', d.advertiser === i && 'is-selected')} htmlFor={`ac-adv-${i + 1}`}>
                      <input type="radio" name="ac-adv" id={`ac-adv-${i + 1}`} checked={d.advertiser === i} onChange={() => set('advertiser', i)} />
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
                    <label key={g} className="check" htmlFor={`ac-goal-${i + 1}`}>
                      <input type="radio" name="ac-goal" id={`ac-goal-${i + 1}`} checked={d.goal === i} onChange={() => set('goal', i)} />
                      <span>{g}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="ab-form-grid">
                <Field label="Campaign name" error={errors.name}>
                  <TextInput id="ac-name" value={d.name} error={!!errors.name} onChange={(e) => set('name', e.target.value)} />
                </Field>
                <Field label="Linked promotion" hint="The ad brings attention; the promotion changes the price">
                  <Select id="ac-promo" options={PROMOS} value={d.promo} onChange={(e) => set('promo', e.target.value)} />
                </Field>
                <Field label="Destination" error={errors.dest}>
                  <TextInput id="ac-dest" prefix="marketly.com" value={d.dest} error={!!errors.dest} onChange={(e) => set('dest', e.target.value)} />
                </Field>
                <Field label="Campaign owner">
                  <Select id="ac-own" options={OWNERS} value={d.owner} onChange={(e) => set('owner', e.target.value)} />
                </Field>
              </div>
            </Card>
          )}

          {stepIdx === 1 && (
            <>
              <Card title="Ad type">
                <div className="ab-types">
                  {AD_TYPES.map((t, i) => (
                    <label key={t.label} className={cx('opt-card', d.type === i && 'is-selected', t.disabled && 'is-disabled')} htmlFor={`ac-type-${i}`}>
                      <input type="radio" name="ac-type" id={`ac-type-${i}`} checked={d.type === i} disabled={t.disabled} onChange={() => set('type', i)} />
                      <span className="stack gap-1 grow">
                        <span className="row gap-2">
                          <Icon name={t.icon} className="ic-sm" />
                          <span className="small strong">{t.label}</span>
                          {t.badge && <Badge tone={t.badge.tone}>{t.badge.text}</Badge>}
                        </span>
                        <span className="small sub">{t.body}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </Card>
              <Card title="Pages" titleAs="h3">
                <div className="ab-checkgrid">
                  {PAGES.map((p, i) => (
                    <label key={p.label} className="check" htmlFor={`ac-pg${i + 1}`}>
                      <input
                        type="checkbox"
                        id={`ac-pg${i + 1}`}
                        checked={d.pages[i]}
                        aria-invalid={errors.pages ? true : undefined}
                        onChange={(e) => set('pages', d.pages.map((v, j) => (j === i ? e.target.checked : v)))}
                      />
                      <span>{p.label}</span>
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
                    <Field label="Sign-in" hint="Matches the promotion, which needs sign-in">
                      <Select id="ac-sign" options={SIGN_IN} value={d.signIn} onChange={(e) => set('signIn', e.target.value)} />
                    </Field>
                    <Field label="Interested in categories" hint="Based on browsing in this store only">
                      <Select id="ac-cat" options={INTERESTS} value={d.interest} onChange={(e) => set('interest', e.target.value)} />
                    </Field>
                  </div>
                )}
                <p className="ab-note">
                  <Icon name="info" className="ic-sm" /> Targeting uses only information customers gave us or that their privacy choices allow. Estimated reach: {d.audience === 'all' ? '96,000' : '41,000'} visitors per week.
                </p>
              </Card>
            </>
          )}

          {stepIdx === 2 && (
            <>
              <Card title="Schedule">
                <div className="ab-form-grid c3">
                  <Field label="Start" error={errors.start}>
                    <TextInput id="ac-start" icon="calendar" value={d.start} error={!!errors.start} onChange={(e) => set('start', e.target.value)} />
                  </Field>
                  <Field label="End" error={errors.end}>
                    <TextInput id="ac-end" icon="calendar" value={d.end} error={!!errors.end} onChange={(e) => set('end', e.target.value)} />
                  </Field>
                  <Field label="Publication time zone">
                    <Select id="ac-tz" options={TIME_ZONES} value={d.tz} onChange={(e) => set('tz', e.target.value)} />
                  </Field>
                </div>
                {d.pages[0] && (
                  <Alert tone="warning" title="Overlaps with Home Week opening ad on Oct 16–19">
                    Both target the home page. Only one overlay shows at a time. The higher priority shows first and the other waits for the next session.
                  </Alert>
                )}
              </Card>
              <Card title="Display limits and priority" titleAs="h3">
                <div className="ab-form-grid">
                  <Field label="Display frequency" hint="Default for opening ads">
                    <Select id="ac-freq" options={FREQUENCIES} value={d.freq} onChange={(e) => set('freq', e.target.value)} />
                  </Field>
                  <Field label="After a visitor closes it">
                    <Select id="ac-dis" options={DISMISS} value={d.dismiss} onChange={(e) => set('dismiss', e.target.value)} />
                  </Field>
                  <Field label="Priority when several ads qualify" hint="Equal priority rotates evenly">
                    <Select id="ac-pri" options={PRIORITIES} value={d.priority} onChange={(e) => set('priority', e.target.value)} />
                  </Field>
                  <Field label="Delivery cap" hint="Own promotion, no budget charge" error={errors.cap}>
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
                      ['desktop', 'Desktop image · 1600 × 900', deskFile],
                      ['phone', 'Phone image · 1080 × 1920', phoneFile],
                    ] as const
                  ).map(([k, label, ref]) => (
                    <div className="field" key={k}>
                      <span className="label">{label}</span>
                      <div className="panel row gap-3">
                        <Img icon="image" tint="1" className="thumb" />
                        <span className="grow stack gap-0">
                          <span className="small strong">{d[k]?.name ?? 'No image yet'}</span>
                          <span className="xs muted">{d[k]?.meta ?? 'JPG or PNG'}</span>
                        </span>
                        <input ref={ref} type="file" hidden accept="image/jpeg,image/png" onChange={pickFile(k)} />
                        <Button variant="ghost" size="sm" onClick={() => ref.current?.click()}>
                          {d[k] ? 'Replace' : 'Upload'}
                        </Button>
                      </div>
                    </div>
                  ))}
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
                      <Icon name="monitor" className="ic-sm" /> Desktop · 1600 × 900
                    </span>
                    <div className="ab-dframe">
                      <div className="ab-dbar">
                        <i />
                        <i />
                        <i />
                        <span>marketly.com</span>
                      </div>
                      <div className="ab-screen desk">
                        <div className="sk h-18" />
                        <div className="sk h-46" />
                        <div className="sk u-h-12px" style={{ width: '60%' }} />
                        <div className="sk h-30" />
                        <div className="sk h-30" />
                        <AdPreview d={d} desk />
                      </div>
                    </div>
                  </div>
                  <div className="stack gap-2">
                    <span className="xs strong sub">
                      <Icon name="smartphone" className="ic-sm" /> Phone · 1080 × 1920
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
                        <AdPreview d={d} />
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
              <Card title="Checks" titleAs="h3">
                <Checks items={creativeChecks} />
              </Card>
            </>
          )}

          {stepIdx === 4 && (
            <>
              {submitted && (
                <Alert tone="success" title="Submitted for approval">
                  Noor Aziz (Content) has been asked to review the creative, claims and links. You'll get a notification when it's approved.
                </Alert>
              )}
              <Card title="Reviewers" sub="Own promotions need Advertising and Content or Marketing approval">
                <ul className="ab-approvals">
                  <li>
                    <span className="n is-done">
                      <Icon name="check" className="ic-sm" />
                    </span>
                    <span className="ab-cell">
                      <span className="strong">Jamie Brooks · Advertising</span>
                      <span className="xs muted">Placement, schedule and limits · approved Oct 8, 9:20 AM</span>
                    </span>
                    <Badge tone="success">Approved</Badge>
                  </li>
                  <li>
                    <span className="n is-wait">2</span>
                    <span className="ab-cell">
                      <span className="strong">Noor Aziz · Content</span>
                      <span className="xs muted">Creative, claims and links</span>
                    </span>
                    <Badge tone="info">In review</Badge>
                  </li>
                </ul>
                <Field label="Note to reviewers" optional>
                  <Textarea id="ac-note" value={d.note} onChange={(e) => set('note', e.target.value)} disabled={submitted} />
                </Field>
              </Card>
              <Card title="After approval" titleAs="h3">
                <div className="stack gap-2">
                  <label className="opt-card is-selected" htmlFor="ac-pub-1">
                    <input type="radio" name="ac-pub" id="ac-pub-1" defaultChecked />
                    <span className="stack gap-1 grow">
                      <span className="small strong">Schedule</span>
                      <span className="small sub">
                        Goes live {d.start} {tzShort(d.tz)} and ends {d.end.replace(/,\s*\d{4}/, '')} {tzShort(d.tz)}
                      </span>
                    </span>
                  </label>
                  <label className="opt-card is-disabled" htmlFor="ac-pub-2">
                    <input type="radio" name="ac-pub" id="ac-pub-2" disabled />
                    <span className="stack gap-1 grow">
                      <span className="small strong">Activate as soon as approved</span>
                      <span className="small sub">Not available: the linked promotion starts Oct 16</span>
                    </span>
                  </label>
                </div>
                <Alert tone="info" title="You can pause at any time">
                  Pause from Advertisements if details change. The ad leaves the site within 1 minute and can be resumed.
                </Alert>
              </Card>
            </>
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
              <Button variant="secondary" onClick={saveDraft} disabled={submitted}>
                Save draft
              </Button>
              {onApproval ? (
                <Button
                  icon={submitted ? 'check' : 'send'}
                  disabled={submitted}
                  onClick={() => {
                    setSubmitted(true);
                    announce('Submitted for approval');
                  }}
                >
                  {submitted ? 'Submitted' : 'Submit for approval'}
                </Button>
              ) : (
                <Button iconRight="arrow-right" onClick={next}>
                  {STEPS[stepIdx].next}
                </Button>
              )}
            </span>
          </div>
          {submitted && (
            <p className="small">
              <Link to={href('admin/ads')}>Back to Advertisements</Link>
            </p>
          )}
        </div>

        <div className="stack gap-4 ab-sticky">
          <Card title="Campaign summary" titleAs="h3" sub={onApproval ? 'Submitted Oct 8, 9:12 AM' : `Draft · saved ${savedAt}`}>
            <div className="ab-sumlist">
              {summaryRows(d, stepIdx).map(([k, v]) => (
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
    </AdminLayout>
  );
}
