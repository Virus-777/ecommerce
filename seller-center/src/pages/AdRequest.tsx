import { Fragment, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { ApiError, call, errorMessage, exactImageSpec, useApi, useUploads, type UploadItem } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { useScrollRegion, useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Breadcrumbs, Button, Card, Checkbox, EmptyState, Field, Icon, ImageCropper, Img, KeyValue, OptionCard, StatusBadge, TableWrap, TextInput, announce } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { adStatus, isAmount, isLaterPhase, parsePT, retryUnlessLater, stampPT, usd, type SellerAdCampaign } from './data/marketing';

// Design: pages/seller/seller-ad-request.html (set up) · view "in-review" (the request after "Submit for approval",
// opened with ?view=in-review&id=<campaign id>). Data: advertising GET /api/seller/advertising/promotable-offers,
// …/pricing?type=, POST …/creatives (images uploaded through media as ad_creative), POST/PATCH …/campaigns,
// …/campaigns/{id}/submit|withdraw, GET …/campaigns/{id}. Advertising is a launch-phase-3 module: while the API
// answers 501 NOT_IMPLEMENTED the form explains that and can't be sent.

type AdType = 'sponsored_product' | 'sponsored_store';
/**
 * The image size each seller ad type takes (the backend's placement formats, advertising domain/rules.ts: one "any"
 * format each). There is no seller endpoint for placements, so they are listed here; images are cropped to them.
 */
const AD_IMAGE: Record<AdType, { width: number; height: number }> = { sponsored_product: { width: 600, height: 600 }, sponsored_store: { width: 1200, height: 300 } };
type Billing = 'cpc' | 'fixed_daily';
type Page = 'search' | 'category' | 'product' | 'home';

interface Draft {
  type: AdType;
  products: Record<string, boolean>;
  pages: Record<Page, boolean>;
  start: string;
  end: string;
  daily: string;
  total: string;
  billing: Billing;
  headline: string;
}

const PAGES: Array<{ value: Page; label: string; short: string }> = [
  { value: 'search', label: 'Search results for related terms', short: 'Search' },
  { value: 'category', label: 'Category pages of your products', short: 'Categories' },
  { value: 'product', label: 'Related products on product pages', short: 'Related products' },
  { value: 'home', label: 'Home and discovery pages', short: 'Home' },
];
const STEPS = ['Draft', 'In review', 'Approved', 'Scheduled', 'Live'];
const STEP_OF: Record<string, number> = { draft: 0, in_review: 1, rejected: 1, approved: 2, scheduled: 3, live: 4, paused: 4, finished: 5, archived: 5 };

const DRAFT: Draft = { type: 'sponsored_product', products: {}, pages: { search: true, category: true, product: true, home: false }, start: '', end: '', daily: '', total: '', billing: 'cpc', headline: '' };
const money = formatMoney;
const sk = <span className="sk sk-line" aria-hidden="true" />;
const days = (s: string | null, e: string | null) => (s && e && e > s ? Math.max(1, Math.round((new Date(e).getTime() - new Date(s).getTime()) / 86_400_000)) : 0);
const dayOnly = (iso: string | null) => (iso ? stampPT(iso).replace(/,\s*\d{1,2}:\d{2}\s*[AP]M$/, '') : '');

function validate(d: Draft, minDaily: number | null) {
  const e: Partial<Record<'products' | 'pages' | 'start' | 'end' | 'daily' | 'total' | 'headline' | 'creative', string>> = {};
  if (d.type === 'sponsored_product' && !Object.values(d.products).some(Boolean)) e.products = 'Choose at least one product to promote.';
  if (!Object.values(d.pages).some(Boolean)) e.pages = 'Choose at least one placement.';
  const s = parsePT(d.start);
  const en = parsePT(d.end, { endOfDay: true });
  if (!s) e.start = 'Enter a start date like Nov 16, 2026, 12:00 AM.';
  else if (new Date(s).getTime() < Date.now()) e.start = 'Choose a start date in the future, after review.';
  if (!en) e.end = 'Enter an end date like Dec 20, 2026, 11:59 PM.';
  else if (s && en <= s) e.end = 'The end must be after the start.';
  if (!isAmount(d.daily)) e.daily = 'Enter a daily limit in dollars, like 20.00.';
  else if (minDaily !== null && Number(d.daily) * 100 < minDaily) e.daily = `A fixed placement costs ${money({ amount: minDaily, currency: 'USD' })} a day. Set the daily limit to at least that.`;
  if (!isAmount(d.total)) e.total = 'Enter a total limit in dollars, like 500.00.';
  else if (isAmount(d.daily) && Number(d.total) < Number(d.daily)) e.total = `The total limit can't be less than the daily limit (${money(usd(Number(d.daily)))}).`;
  if (!d.headline.trim()) e.headline = 'Enter a short headline.';
  else if (d.headline.trim().length > 40) e.headline = `Use 40 characters or fewer (now ${d.headline.trim().length}).`;
  return e;
}

/** Steps with the design's "Step n of m" screen-reader note. */
function AdSteps({ current }: { current: number }) {
  const ref = useScrollRegion<HTMLOListElement>();
  return (
    <ol className="steps" aria-label="Progress" ref={ref} data-scroll-region="">
      {STEPS.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && <li className="bar" aria-hidden="true" />}
          <li className={cx('step', i < current && 'is-done', i === current && 'is-current')} aria-current={i === current ? 'step' : undefined}>
            {i < current && <span className="sr-only">Completed: </span>}
            <span className="n">{i < current ? <Icon name="check" className="ic-sm" /> : i + 1}</span>
            {i === current && <span className="sr-only">{`Step ${i + 1} of ${STEPS.length}: `}</span>}
            {s}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

function Drop({ title, hint, item, onFile, disabled }: { title: string; hint: string; item?: UploadItem; onFile: (f: File) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const label = item ? (item.status === 'uploading' ? `Uploading ${item.name}…` : item.status === 'failed' ? (item.error ?? 'Upload failed') : item.name) : title;
  return (
    <div
      className="dropzone"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f && !disabled) onFile(f);
      }}
    >
      <Icon name={item?.status === 'ready' ? 'circle-check' : 'image-plus'} className="ic-lg" />
      <span className="small strong u-c-text">{label}</span>
      <span className="xs">{hint}</span>
      <input ref={input} type="file" hidden accept="image/jpeg,image/png" onChange={(e) => (e.target.files?.[0] && onFile(e.target.files[0]), (e.target.value = ''))} />
      <Button variant="secondary" size="sm" onClick={() => input.current?.click()} disabled={disabled}>
        {item ? 'Replace file' : 'Browse files'}
      </Button>
    </div>
  );
}

function Previews({ title, image, headline, storeName, desktop, phone }: { title: string; image?: string | null; headline: string; storeName: string; desktop?: string | null; phone?: string | null }) {
  const card = (
    <div className="stack gap-1">
      <span className="sponsored">
        <Icon name="info" className="ic-sm" />
        Sponsored
      </span>
      <span className="small strong clamp-2">{title}</span>
      <span className="xs sub">{headline}</span>
      <span className="seller-line">
        Sold by <b>{storeName}</b>
      </span>
    </div>
  );
  return (
    <div className="grid md2 gap-4">
      <div className="sb-device">
        <span className="xs muted row gap-1">
          <Icon name="monitor" className="ic-sm" />
          Desktop · search results
        </span>
        <div className="grid c2 gap-2">
          <div className="sb-adcard col">
            <Img icon="package" tint="2" className="r43" src={desktop ?? image ?? undefined} alt="" />
            {card}
          </div>
          <div className="sb-ghostcard u-fd-column" aria-hidden="true">
            <div className="imgph r43 tint-surface-3" />
            <i style={{ width: '80%' }} />
            <i className="u-w-50pct" />
          </div>
        </div>
      </div>
      <div className="sb-device phone">
        <span className="xs muted row gap-1">
          <Icon name="smartphone" className="ic-sm" />
          Mobile · search results
        </span>
        <div className="stack gap-2">
          <div className="sb-adcard">
            <Img icon="package" tint="2" src={phone ?? image ?? undefined} alt="" />
            {card}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChargesNote() {
  return (
    <div className="stack gap-2">
      <Alert tone="info" title="How you are charged">
        Ad charges appear on your statement as a separate line, not as part of the sales commission. Unused budget is not charged. If Marketly pauses or cancels the campaign, you are charged only for delivery so far.
      </Alert>
      <p className="xs muted">Paid campaigns bring attention to your offer. They never guarantee clicks or purchases.</p>
    </div>
  );
}

const crumbs = (label: string) => <Breadcrumbs items={[{ label: 'Marketing and ads', to: href('seller/marketing', 'sponsored-ads') }, { label }]} />;

/* ================================================================== in review (the created request) */

function InReview({ id }: { id: string }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [, setView] = useView<'in-review'>();
  const { storeName, can } = useSellerSession();
  const q = useQuery({ queryKey: ['advertising', 'campaign', id], queryFn: () => call(api.GET('/api/seller/advertising/campaigns/{id}', { params: { path: { id } } })), retry: retryUnlessLater });
  const withdraw = useMutation({
    mutationFn: () => call(api.POST('/api/seller/advertising/campaigns/{id}/withdraw', { params: { path: { id } } })),
    onSuccess: async () => {
      announce('Request withdrawn');
      await qc.invalidateQueries({ queryKey: ['advertising'] });
      setView('');
    },
  });
  const x: SellerAdCampaign | undefined = q.data;
  if (!x)
    return (
      <SellerLayout active="marketing">
        <div className="page-head">
          <div className="t">
            {crumbs('Request')}
            <h1 className="h1">Sponsored campaign request</h1>
          </div>
        </div>
        {q.isPending ? (
          <div className="stack gap-5" aria-busy="true">
            <div className="sk sk-card" />
            <div className="sk sk-card" />
          </div>
        ) : isLaterPhase(q.error) ? (
          <Alert tone="info" title="Sponsored ads aren’t available yet">
            Marketly opens sponsored campaigns in a later launch phase.
          </Alert>
        ) : q.error instanceof ApiError && q.error.status === 404 ? (
          <section className="card">
            <div className="card-body">
              <EmptyState icon="search-x" title="We couldn’t find this request" action={<Button to={href('seller/marketing', 'sponsored-ads')}>Back to sponsored ads</Button>} />
            </div>
          </section>
        ) : (
          <Alert tone="danger" title="We couldn’t load this request">
            {errorMessage(q.error)}{' '}
            <Button variant="secondary" size="sm" onClick={() => void q.refetch()}>
              Try again
            </Button>
          </Alert>
        )}
      </SellerLayout>
    );

  const c = x.campaign;
  const canManage = can('advertising.requests.manage');
  const desktop = x.creatives.find((cr) => cr.device === 'desktop') ?? x.creatives[0];
  const phone = x.creatives.find((cr) => cr.device === 'phone') ?? x.creatives[0];
  const submitted = x.timeline.find((t) => /submit/i.test(t.label));
  const checkIcon = (s: string): ReactNode => (s === 'ok' ? <Icon name="circle-check" className="ic-sm t-success-text" /> : s === 'fail' ? <Icon name="circle-x" className="ic-sm t-danger-text" /> : <Icon name="clock" className="ic-sm" />);
  const checkStatus = (s: string) => (s === 'ok' ? 'Approved' : s === 'fail' ? 'Rejected' : s === 'warn' ? 'Needs changes' : 'In review');

  return (
    <SellerLayout active="marketing">
      <div className="page-head">
        <div className="t">
          {crumbs(c.name)}
          <h1 className="h1">{c.name}</h1>
          <p className="sub small">
            Request <span className="mono">{c.ref}</span>
            {submitted ? ` · submitted ${stampPT(submitted.at)} PT` : ''}
          </p>
        </div>
        <div className="actions">
          <StatusBadge status={adStatus(c.status)} />
        </div>
      </div>
      <section className="card">
        <div className="card-body">
          <AdSteps current={STEP_OF[c.status] ?? 1} />
        </div>
      </section>
      <div className="sb-main">
        <div className="stack gap-5">
          {c.status === 'in_review' && (
            <Alert tone="info" title="Waiting for Marketly Advertising review">
              We check the offer is available, claims and links, and the Sponsored label. Editing the request now sends it back to the start of review.
            </Alert>
          )}
          {c.statusNote && <Alert tone={c.status === 'rejected' ? 'danger' : 'info'}>{c.statusNote}</Alert>}
          {withdraw.isError && <Alert tone="danger">{errorMessage(withdraw.error)}</Alert>}
          <Card
            title="Request summary"
            foot={
              canManage && (c.allowedActions.includes('withdraw') || c.allowedActions.includes('edit') || c.status === 'draft' || c.status === 'in_review') ? (
                <>
                  {c.allowedActions.includes('withdraw') && (
                    <Button variant="danger-soft" onClick={() => withdraw.mutate()} disabled={withdraw.isPending}>
                      Withdraw request
                    </Button>
                  )}
                  <Button variant="secondary" icon="pencil" to={href('seller/ad-request', '', undefined, { id })}>
                    Edit and resubmit
                  </Button>
                </>
              ) : undefined
            }
          >
            <KeyValue
              pairs={[
                ['Ad type', c.placementName],
                ['Promotes', x.promotes],
                ['Placements', c.pagesLabel],
                ['Schedule', c.periodLabel],
                ['Spending limit', `${money(x.dailyLimit)} per day · ${money(x.totalLimit)} total`],
                ['Billing', x.billingLabel],
                ['Creatives', x.creatives.map((cr) => `${cr.device === 'phone' ? 'Mobile' : cr.device === 'desktop' ? 'Desktop' : 'Any device'} ${cr.width && cr.height ? `${cr.width} × ${cr.height}` : cr.formatLabel}`).join(' · ') || '—'],
              ]}
            />
            <p className="xs muted">{x.audienceNote}</p>
          </Card>
          <Card title="Review checks" titleAs="h3" sub="Updated by the reviewer">
            {x.reviewChecks.length ? (
              <ul className="list">
                {x.reviewChecks.map((r) => (
                  <li key={r.label}>
                    {checkIcon(r.state)}
                    <span className="grow small">
                      {r.label}
                      {r.detail ? ` (${r.detail})` : ''}
                    </span>
                    <StatusBadge status={checkStatus(r.state)} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small sub">Checks appear once a reviewer picks up the request.</p>
            )}
          </Card>
          <Card title="Previews you submitted" titleAs="h3">
            <Previews title={x.promotes} headline={desktop?.headline ?? ''} storeName={storeName} desktop={desktop?.media?.url} phone={phone?.media?.url} />
          </Card>
        </div>
        <div className="stack gap-5">
          <Card title="Activity" titleAs="h3">
            <ol className="timeline">
              {[...x.timeline]
                .sort((a, b) => b.at.localeCompare(a.at))
                .map((e, i) => (
                  <li key={`${e.at}${i}`} className={cx('ev', i === 0 ? 'is-current' : 'is-done')}>
                    <span className="dot" aria-hidden="true" />
                    <div className="stack gap-1">
                      <span className="t">{e.label}</span>
                      <span className="d">{[stampPT(e.at), e.detail].filter(Boolean).join(' · ')}</span>
                    </div>
                  </li>
                ))}
            </ol>
          </Card>
          {x.nextSteps.length > 0 && (
            <Card title="What happens next" titleAs="h3">
              <ol className="ol small stack gap-1">
                {x.nextSteps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              <span className="xs muted">If it is not approved, we tell you which check failed and how to fix it.</span>
            </Card>
          )}
          <ChargesNote />
        </div>
      </div>
    </SellerLayout>
  );
}

/* ================================================================== set up */

export default function AdRequest() {
  const [view] = useView<'in-review'>();
  const [params] = useSearchParams();
  const id = params.get('id');
  if (view === 'in-review') {
    return id ? (
      <InReview id={id} />
    ) : (
      <SellerLayout active="marketing">
        <div className="page-head">
          <div className="t">
            {crumbs('Request')}
            <h1 className="h1">Sponsored campaign request</h1>
          </div>
        </div>
        <section className="card">
          <div className="card-body">
            <EmptyState icon="megaphone" title="Open a request from your sponsored ads" action={<Button to={href('seller/marketing', 'sponsored-ads')}>Sponsored ads</Button>}>
              Requests you submitted are listed on the Sponsored ads tab.
            </EmptyState>
          </div>
        </section>
      </SellerLayout>
    );
  }
  return <SetUp id={id} />;
}

function SetUp({ id }: { id: string | null }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [, setParams] = useSearchParams();
  const { sellerId, storeName, can } = useSellerSession();
  const canManage = can('advertising.requests.manage');
  const [d, setD] = useState<Draft>(DRAFT);
  const [tried, setTried] = useState(false);
  const [notice, setNotice] = useState(id ? 'Editing sends the request back to the start of review when you submit again.' : '');
  // the cropper saves WebP (or JPEG where the browser can't): both are accepted
  const desktop = useUploads('ad_creative', { max: 1, maxBytes: 5 * 1024 * 1024, accept: /\.(jpe?g|png|webp)$/i });
  const phone = useUploads('ad_creative', { max: 1, maxBytes: 5 * 1024 * 1024, accept: /\.(jpe?g|png|webp)$/i });
  /** The photo being cropped and where it goes */
  const [cropping, setCropping] = useState<{ target: 'desktop' | 'phone'; file: File } | null>(null);

  const offers = useQuery({ queryKey: ['advertising', 'promotable', sellerId], queryFn: () => call(api.GET('/api/seller/advertising/promotable-offers', { params: { query: { page: 1, limit: 50 } } })), retry: retryUnlessLater });
  const pricing = useQuery({ queryKey: ['advertising', 'pricing', d.type], queryFn: () => call(api.GET('/api/seller/advertising/pricing', { params: { query: { type: d.type } } })), retry: retryUnlessLater });
  const later = isLaterPhase(offers.error) || isLaterPhase(pricing.error);
  const disabled = later || !canManage;
  const rate = (b: Billing) => pricing.data?.find((p) => p.billing === b);
  const exampleRates = pricing.data?.some((p) => p.isExample) ?? true;
  const minDaily = d.billing === 'fixed_daily' ? (rate('fixed_daily')?.rate.amount ?? null) : null;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const errs = tried ? validate(d, minDaily) : {};
  const nErr = Object.keys(errs).length;

  const rows = offers.data?.items ?? [];
  const picked = rows.filter((o) => d.products[o.offerId]);
  const lead = d.type === 'sponsored_store' ? null : (picked[0] ?? null);
  const s = parsePT(d.start);
  const e = parsePT(d.end, { endOfDay: true });
  const n = days(s, e);
  const daily = isAmount(d.daily) ? Number(d.daily) : 0;
  const total = isAmount(d.total) ? Number(d.total) : 0;
  const most = n && daily ? Math.min(total, daily * n) : total;
  const billingLabel = (b: Billing) => {
    const r = rate(b);
    return r ? r.label : b === 'cpc' ? 'Per click' : 'Fixed placement fee';
  };
  const name = d.type === 'sponsored_store' ? `${storeName} store feature` : `${lead?.title ?? 'Product'} sponsored campaign`;

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const creativeIds: string[] = [];
      for (const [u, device] of [
        [desktop, 'desktop'],
        [phone, 'phone'],
      ] as const) {
        const mediaId = u.assetIds[0];
        if (!mediaId) continue;
        const cr = await call(api.POST('/api/seller/advertising/creatives', { body: { kind: 'image', device, placementKey: d.type, mediaId, headline: d.headline.trim() } }));
        creativeIds.push(cr.id);
      }
      const body = {
        name,
        type: d.type,
        offerIds: d.type === 'sponsored_store' ? [] : picked.map((o) => o.offerId),
        pages: PAGES.filter((p) => d.pages[p.value]).map((p) => p.value),
        startsAt: parsePT(d.start)!,
        endsAt: parsePT(d.end, { endOfDay: true })!,
        dailyLimit: usd(Number(d.daily)),
        totalLimit: usd(Number(d.total)),
        billing: d.billing,
        creativeIds,
        headline: d.headline.trim(),
      };
      const saved = id ? await call(api.PATCH('/api/seller/advertising/campaigns/{id}', { params: { path: { id } }, body })) : await call(api.POST('/api/seller/advertising/campaigns', { body }));
      return submit ? call(api.POST('/api/seller/advertising/campaigns/{id}/submit', { params: { path: { id: saved.campaign.id } } })) : saved;
    },
    onSuccess: async (x, submit) => {
      await qc.invalidateQueries({ queryKey: ['advertising'] });
      setParams((prev) => {
        const p = new URLSearchParams(prev);
        p.set('id', x.campaign.id);
        if (submit) p.set('view', 'in-review');
        return p;
      });
      if (submit) {
        window.scrollTo({ top: 0 });
        announce('Submitted for approval');
      } else {
        setNotice('Draft saved. Nothing is sent to Marketly until you submit.');
        announce('Draft saved');
      }
    },
  });
  const submit = (send: boolean) => {
    setTried(true);
    if (Object.keys(validate(d, minDaily)).length) return announce('Check the highlighted fields');
    if (desktop.uploading || phone.uploading) return announce('Wait for the images to finish uploading');
    save.mutate(send);
  };

  return (
    <SellerLayout active="marketing">
      <div className="page-head">
        <div className="t">
          {crumbs(id ? 'Edit request' : 'New request')}
          <h1 className="h1">Request a sponsored campaign</h1>
          <p className="sub small">Marketly reviews every request. Nothing runs or is charged until it is approved and scheduled.</p>
        </div>
        <div className="actions">
          <StatusBadge status="Draft" />
        </div>
      </div>
      <section className="card">
        <div className="card-body">
          <AdSteps current={0} />
        </div>
      </section>
      <div className="sb-main">
        <div className="stack gap-5">
          {later && (
            <Alert tone="info" title="Sponsored ads aren’t available yet">
              Marketly opens sponsored product and store campaigns in a later launch phase. You can’t send a request until then.
            </Alert>
          )}
          {!canManage && !later && <Alert tone="info">Your role can’t request sponsored campaigns.</Alert>}
          {notice && <Alert tone="info" title={notice} />}
          {save.isError && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
          {nErr > 0 && (
            <Alert tone="danger" title={`Check ${nErr} field${nErr > 1 ? 's' : ''}`}>
              Fix the highlighted fields to submit this request.
            </Alert>
          )}
          <Card title="1. Ad type">
            <div className="grid md2 gap-3">
              <OptionCard id="ad-type-prod" name="ad-type" title={<span className="strong">Sponsored product</span>} body="A labeled product card in search, category and related-product results." checked={d.type === 'sponsored_product'} onChange={() => set('type', 'sponsored_product')} disabled={disabled} />
              <OptionCard id="ad-type-store" name="ad-type" title={<span className="strong">Sponsored store</span>} body="A labeled feature linking to your store on home and discovery pages." checked={d.type === 'sponsored_store'} onChange={() => set('type', 'sponsored_store')} disabled={disabled} />
            </div>
          </Card>
          <Card title="2. Products" titleAs="h3" sub="Only active offers with stock can be promoted" flush>
            {errs.products && (
              <div className="card-body">
                <span className="error-text">
                  <Icon name="circle-alert" className="ic-sm" />
                  {errs.products}
                </span>
              </div>
            )}
            <TableWrap label="2. Products table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                    <th scope="col">Product</th>
                    <th scope="col">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {offers.isPending && (
                    <tr className="sk-row" aria-hidden="true">
                      <td colSpan={3}>{sk}</td>
                    </tr>
                  )}
                  {rows.map((p) => (
                    <tr key={p.offerId} className={cx(d.products[p.offerId] && d.type === 'sponsored_product' && 'is-selected')}>
                      <td>
                        <input type="checkbox" id={`ad-p-${p.offerId}`} aria-label={`Promote ${p.title}`} checked={!!d.products[p.offerId]} disabled={d.type === 'sponsored_store' || !p.eligible || disabled} onChange={(ev) => set('products', { ...d.products, [p.offerId]: ev.target.checked })} />
                      </td>
                      <td>
                        <label htmlFor={`ad-p-${p.offerId}`} className="row gap-3 nowrap minw-240">
                          <Img icon="package" tint="2" className="tiny" src={p.image?.url ?? undefined} alt="" />
                          <span className="stack gap-0">
                            <span className="small strong">{p.title}</span>
                            {p.sku && (
                              <span className="xs muted mono nowrap" title={p.sku}>
                                {p.sku}
                              </span>
                            )}
                          </span>
                        </label>
                      </td>
                      <td>
                        <span className="small">{p.stockLabel}</span>
                        {!p.eligible && p.reason && (
                          <>
                            <br />
                            <span className="xs muted">{p.reason}</span>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!offers.isPending && !rows.length && (
                    <tr>
                      <td colSpan={3}>
                        <span className="small sub">{later ? 'Your offers show here once sponsored ads open.' : offers.isError ? errorMessage(offers.error) : 'You have no offers that can be promoted.'}</span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </TableWrap>
          </Card>
          <Card title="3. Placement and pages" titleAs="h3">
            <div className="grid md2 gap-2">
              {PAGES.map((p) => (
                <Checkbox key={p.value} id={`ad-pl-${p.value}`} label={p.label} checked={d.pages[p.value]} disabled={disabled} onChange={(ev) => set('pages', { ...d.pages, [p.value]: ev.target.checked })} />
              ))}
            </div>
            {errs.pages && (
              <span className="error-text">
                <Icon name="circle-alert" className="ic-sm" />
                {errs.pages}
              </span>
            )}
            <span className="xs muted">Ads never appear in checkout, payment results, order tracking or return pages. Audience: all shoppers in the US service region.</span>
          </Card>
          <Card title="4. Schedule and spending limit" titleAs="h3">
            <div className="sb-form-grid">
              <Field label="Start" error={errs.start}>
                <TextInput id="ad-start" icon="calendar" value={d.start} error={!!errs.start} placeholder="Nov 16, 2026, 12:00 AM" disabled={disabled} onChange={(ev) => set('start', ev.target.value)} />
              </Field>
              <Field label="End" hint="Times in Pacific Time" error={errs.end}>
                <TextInput id="ad-end" icon="calendar" value={d.end} error={!!errs.end} placeholder="Dec 20, 2026, 11:59 PM" disabled={disabled} onChange={(ev) => set('end', ev.target.value)} />
              </Field>
              <Field label="Daily spending limit" hint="Ads stop for the day when reached." error={errs.daily}>
                <TextInput id="ad-daily" prefix="$" value={d.daily} error={!!errs.daily} placeholder="" inputMode="decimal" disabled={disabled} onChange={(ev) => set('daily', ev.target.value)} />
              </Field>
              <Field label="Total spending limit" hint="The campaign stops when reached." error={errs.total}>
                <TextInput id="ad-total" prefix="$" value={d.total} error={!!errs.total} placeholder="" inputMode="decimal" disabled={disabled} onChange={(ev) => set('total', ev.target.value)} />
              </Field>
            </div>
            <div className="stack gap-2">
              <span className="label">Billing model</span>
              <div className="grid md2 gap-3">
                <OptionCard
                  id="ad-bill-cpc"
                  name="ad-bill"
                  title={
                    <span className="row between">
                      <span className="strong small">Per click</span>
                      <span className="num small">{rate('cpc') ? money(rate('cpc')!.rate) : ''}</span>
                    </span>
                  }
                  body="You pay when a shopper clicks the ad."
                  checked={d.billing === 'cpc'}
                  disabled={disabled}
                  onChange={() => set('billing', 'cpc')}
                />
                <OptionCard
                  id="ad-bill-fixed"
                  name="ad-bill"
                  title={
                    <span className="row between">
                      <span className="strong small">Fixed placement fee</span>
                      <span className="num small">{rate('fixed_daily') ? `${money(rate('fixed_daily')!.rate)}/day` : ''}</span>
                    </span>
                  }
                  body="Flat daily fee for a reserved slot."
                  checked={d.billing === 'fixed_daily'}
                  disabled={disabled}
                  onChange={() => set('billing', 'fixed_daily')}
                />
              </div>
              <span className="xs muted">{pricing.data ? (exampleRates ? 'Example rates. Final pricing is in the advertising terms.' : 'Rates from the advertising terms.') : 'Rates show once sponsored ads open.'}</span>
            </div>
          </Card>
          <Card title="5. Creative" titleAs="h3" sub="Upload both sizes. Previews show the Sponsored label customers see.">
            <div className="grid md2 gap-4">
              <div className="stack gap-2">
                <span className="label">Desktop image</span>
                <Drop title="Upload desktop image" hint={`${AD_IMAGE[d.type].width} × ${AD_IMAGE[d.type].height} px (you crop it to fit), JPG or PNG, up to 5 MB`} item={desktop.items[0]} disabled={disabled} onFile={(f) => setCropping({ target: 'desktop', file: f })} />
              </div>
              <div className="stack gap-2">
                <span className="label">Mobile image</span>
                <Drop title="Upload mobile image" hint={`${AD_IMAGE[d.type].width} × ${AD_IMAGE[d.type].height} px (you crop it to fit), JPG or PNG, up to 5 MB`} item={phone.items[0]} disabled={disabled} onFile={(f) => setCropping({ target: 'phone', file: f })} />
              </div>
            </div>
            {(desktop.error || phone.error) && <span className="xs muted">{desktop.error || phone.error}</span>}
            {cropping && (
              <ImageCropper
                files={[cropping.file]}
                spec={exactImageSpec(AD_IMAGE[d.type].width, AD_IMAGE[d.type].height)}
                wording={{ what: d.type === 'sponsored_store' ? 'Store ad images' : 'Product ad images', place: 'frame the ad', detail: ['Ad', 'the ad'], thumbnail: ['Preview', 'previews'] }}
                onProcessed={(img) => {
                  const u = cropping.target === 'desktop' ? desktop : phone;
                  u.clear();
                  u.add([img.file]);
                }}
                onClose={() => setCropping(null)}
              />
            )}
            <Field label="Short headline" hint={`40 characters max. Claims must match the product page. ${d.headline.trim().length}/40`} error={errs.headline}>
              <TextInput id="ad-headline" value={d.headline} error={!!errs.headline} placeholder="" disabled={disabled} onChange={(ev) => set('headline', ev.target.value)} />
            </Field>
            <Previews title={lead?.title ?? (d.type === 'sponsored_store' ? storeName : 'Your product')} image={lead?.image?.url} headline={d.headline} storeName={storeName} desktop={desktop.items[0]?.url} phone={phone.items[0]?.url} />
          </Card>
        </div>
        <div className="stack gap-5">
          <Card
            title="Summary"
            titleAs="h3"
            foot={
              canManage ? (
                <>
                  <Button variant="ghost" onClick={() => submit(false)} disabled={disabled || save.isPending}>
                    Save draft
                  </Button>
                  <Button iconRight="arrow-right" onClick={() => submit(true)} disabled={disabled || save.isPending}>
                    Submit for approval
                  </Button>
                </>
              ) : undefined
            }
          >
            <KeyValue
              pairs={[
                ['Type', d.type === 'sponsored_product' ? 'Sponsored product' : 'Sponsored store'],
                ['Products', d.type === 'sponsored_store' ? 'Store page' : `${picked.length} selected`],
                ['Pages', PAGES.filter((p) => d.pages[p.value]).map((p) => p.short).join(', ') || '—'],
                ['Runs', n ? `${dayOnly(s)} – ${dayOnly(e)} (${n} days)` : '—'],
                ['Most you can spend', money(usd(most))],
                ['Billing', billingLabel(d.billing)],
              ]}
            />
          </Card>
          <ChargesNote />
        </div>
      </div>
    </SellerLayout>
  );
}
