import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { call, errorMessage, exactImageSpec, uploadMedia, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Badge, Breadcrumbs, Button, Dialog, Drawer, Field, Icon, ImageCropper, Img, KeyValue, SearchInput, SegmentedControl, Select, StatusBadge, TableWrap, Tabs, Textarea } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { dateTime, LoadError, shortDate, SkeletonLines } from '@/app/parts';
import { CHECK_STYLE, fileLabel, groupCreatives, previewShape, REASONS, reasonLabel, ROLE_LABEL, sizeLine, type CreativeGroup } from './data/ad-assets';
import { checkTone, CREATIVE_STATUS, reviewRolesOf, REVIEW_ROLE_LABEL, type ReviewRole, statusLabel, type AdCampaign, type Creative, type CreativeStatus, type CreativeSummary, type Page, type Placement } from './data/ads';

// Design: pages/admin/admin-ad-assets.html · view "review-creative" = review drawer for a campaign's creatives.
// Data: GET /api/admin/advertising/creatives (+ /summary for the tab counts), GET …/campaigns/{id} for the
// drawer's campaign facts, POST …/creatives/{id}/review per creative in review, uploads through media
// (purpose ad_creative / ad_video) and POST …/creatives.

const TAB_STATUSES: Array<CreativeStatus | ''> = ['', 'in_review', 'changes_requested', 'approved', 'rejected'];
const TAB_COUNT: Record<string, keyof CreativeSummary> = { '': 'all', in_review: 'inReview', changes_requested: 'changesRequested', approved: 'approved', rejected: 'rejected' };
const ADVERTISERS = [
  { value: '', label: 'Own and seller' },
  { value: 'own', label: 'Own promotions' },
  { value: 'seller', label: 'Seller paid' },
  { value: 'brand', label: 'Brand' },
];
const LINKS = [
  { value: '', label: 'Any link check' },
  { value: 'ok', label: 'Link works' },
  { value: 'warn', label: 'Needs attention' },
  { value: 'fail', label: 'Broken' },
];

function Preview({ c }: { c: Creative }) {
  if (c.kind === 'text') return <div className="pv"><span className="txt">{c.headline}</span></div>;
  if (c.kind === 'video') return <div className="pv"><Img icon="video" tint="4" className="wide" /></div>;
  return (
    <div className="pv">
      <span className="ab-adtag">{c.formatLabel.toLowerCase().includes('sponsored') ? 'Sponsored' : 'Ad'}</span>
      <Img icon="image" tint="1" className={previewShape(c)} src={c.media?.url} alt={c.media?.alt ?? ''} />
    </div>
  );
}

function CheckLine({ c }: { c: Creative }) {
  const s = CHECK_STYLE[c.linkCheck?.state ?? 'none'];
  return (
    <span className={cx('xs row nowrap gap-1', s.cls)}>
      <Icon name={s.icon} className="ic-sm" />
      <span className="wrap">{c.linkCheck?.detail ?? 'Add it to a campaign to run the checks'}</span>
    </span>
  );
}

interface AdCopy { headline: string; text: string; button: string; desk?: string; phone?: string }

function AdMock({ g, desk }: { g: AdCopy; desk?: boolean }) {
  const img = desk ? g.desk : g.phone;
  return (
    <div className="ab-scrim">
      <div className={cx('ab-ad', desk && 'desk')}>
        <span className="ab-adtag">Ad</span>
        <button type="button" className="ab-adx" aria-label="Close advertisement">
          <Icon name="x" />
        </button>
        <div className="art">{img ? <Img icon="image" tint="1" src={img} /> : <Img icon="image" tint="1" />}</div>
        <div className="copy">
          <b>{g.headline}</b>
          <span>{g.text}</span>
          <span className="cta">{g.button}</span>
        </div>
      </div>
    </div>
  );
}

/** Reads an image's pixel size so the upload can name the device format it fits. */
function imageSize(file: File): Promise<{ w: number; h: number } | null> {
  if (!file.type.startsWith('image/')) return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => (resolve({ w: img.naturalWidth, h: img.naturalHeight }), URL.revokeObjectURL(url));
    img.onerror = () => (resolve(null), URL.revokeObjectURL(url));
    img.src = url;
  });
}

export default function AdAssets() {
  const { api, session } = useApi();
  const qc = useQueryClient();
  const { can, roleKeys } = useStaffSession();
  const myRoles = reviewRolesOf(roleKeys).filter((r, _, l) => !(r === 'marketing' && l.includes('content')));
  const [reviewAs, setReviewAs] = useState<ReviewRole | ''>('');
  const role = myRoles.includes(reviewAs as ReviewRole) ? (reviewAs as ReviewRole) : myRoles[0];
  const [view, setView] = useView<'review-creative'>();
  const [tab, setTab] = useState<CreativeStatus | ''>('');
  const [q, setQ] = useState('');
  const [adv, setAdv] = useState('');
  const [fmt, setFmt] = useState('');
  const [link, setLink] = useState('');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [sel, setSel] = useState<string | null>(null);
  const [decision, setDecision] = useState<'approve' | 'changes'>('approve');
  const [reason, setReason] = useState(REASONS[0].code);
  const [comment, setComment] = useState('');
  const [reasonErr, setReasonErr] = useState('');
  const [notice, setNotice] = useState('');
  const upload = useRef<HTMLInputElement>(null);

  const placements = useQuery({ queryKey: ['advertising', 'placements'], queryFn: () => call(api.GET('/api/admin/advertising/placements')) as Promise<Placement[]> });
  const formatOptions = [{ value: '', label: 'All formats' }, ...(placements.data ?? []).map((p) => ({ value: `p:${p.key}`, label: p.name })), { value: 'k:text', label: 'Ad text' }, { value: 'k:video', label: 'Video' }];
  const placementKey = fmt.startsWith('p:') ? fmt.slice(2) : undefined;
  const kind = fmt.startsWith('k:') ? (fmt.slice(2) as 'text' | 'video') : undefined;
  const needle = q.trim() || undefined;
  const source = (adv || undefined) as 'own' | undefined;

  const filters = { q: needle, source, placementKey, kind, linkCheck: (link || undefined) as 'ok' | undefined };
  const list = useQuery({
    queryKey: ['advertising', 'creatives', { ...filters, tab }],
    queryFn: () => call(api.GET('/api/admin/advertising/creatives', { params: { query: { ...filters, status: tab || undefined, limit: 100 } } })) as Promise<Page<Creative>>,
    placeholderData: keepPreviousData,
  });
  const summary = useQuery({
    queryKey: ['advertising', 'creatives', 'summary', { q: needle, source, placementKey, kind }],
    queryFn: () => call(api.GET('/api/admin/advertising/creatives/summary', { params: { query: { q: needle, source, placementKey, kind } } })) as Promise<CreativeSummary>,
    placeholderData: keepPreviousData,
  });

  const groups = groupCreatives(list.data?.items ?? []);
  const group: CreativeGroup | undefined = groups.find((g) => g.id === sel) ?? (view === 'review-creative' ? groups.find((g) => g.creatives.some((c) => c.status === 'in_review')) : undefined);
  const open = view === 'review-creative' && !!group;
  const inReview = group?.creatives.filter((c) => c.status === 'in_review') ?? [];

  const campaign = useQuery({
    queryKey: ['advertising', 'campaign', group?.campaignId],
    queryFn: () => call(api.GET('/api/admin/advertising/campaigns/{id}', { params: { path: { id: group!.campaignId! } } })) as Promise<AdCampaign>,
    enabled: open && !!group?.campaignId,
  });

  const review = useMutation({
    mutationFn: async (d: 'approve' | 'changes') => {
      for (const c of inReview) {
        await call(
          api.POST('/api/admin/advertising/creatives/{id}/review', {
            params: { path: { id: c.id } },
            body: { role: myRoles.length > 1 ? role : undefined, decision: d === 'approve' ? 'approved' : 'changes_requested', reasonCode: d === 'approve' ? (reason === 'no_changes' ? 'no_changes' : reason) : reason, comment: comment.trim() || undefined },
          }),
        );
      }
    },
    onSuccess: (_, d) => {
      const msg = d === 'approve' ? `${group?.name}: creative approved` : `${group?.name}: changes requested from the campaign owner`;
      setNotice(msg);
      announce(msg);
      setView('');
      void qc.invalidateQueries({ queryKey: ['advertising'] });
      void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
    },
  });

  /** device: the format an image was cropped to (images); videos are matched by size */
  const add = useMutation({
    mutationFn: async ({ f, device }: { f: File; device?: 'any' | 'desktop' | 'phone' }) => {
      const isVideo = f.type.startsWith('video');
      const key = isVideo ? 'video' : placementKey;
      if (!key) throw new Error('Choose the format (placement) in the Format filter first, so the file is checked against its sizes.');
      const p = placements.data?.find((x) => x.key === key);
      const size = device ? null : await imageSize(f);
      const match = size && p?.formats.find((x) => x.width === size.w && x.height === size.h);
      const asset = await uploadMedia(session, f, isVideo ? 'ad_video' : 'ad_creative');
      return call(api.POST('/api/admin/advertising/creatives', { body: { kind: isVideo ? 'video' : 'image', device: device ?? (match ? match.device : 'any'), placementKey: key, mediaId: asset.id } })) as Promise<Creative>;
    },
    onSuccess: (c) => {
      const msg = `${fileLabel(c)} uploaded as a draft`;
      setNotice(msg);
      announce(msg);
      void qc.invalidateQueries({ queryKey: ['advertising', 'creatives'] });
    },
  });

  // Images go through the cropper at one of the placement's formats (asked first when it has several), so they are
  // saved at exactly that size; videos upload as they are.
  const [crop, setCrop] = useState<{ file: File; formats: Placement['formats']; format: Placement['formats'][number] | null } | null>(null);
  const pickUpload = (f: File) => {
    add.reset();
    if (f.type.startsWith('video') || !placementKey) return add.mutate({ f });
    const formats = placements.data?.find((x) => x.key === placementKey)?.formats ?? [];
    if (!formats.length) return add.mutate({ f });
    setCrop({ file: f, formats, format: formats.length === 1 ? formats[0]! : null });
  };

  const openReview = (g: CreativeGroup) => {
    setSel(g.id);
    setDecision(g.creatives.some((c) => c.status === 'changes_requested') && !g.creatives.some((c) => c.status === 'in_review') ? 'changes' : 'approve');
    setReason(REASONS[0].code);
    setComment('');
    setReasonErr('');
    review.reset();
    setView('review-creative');
  };
  const close = () => setView('');
  const decide = (d: 'approve' | 'changes') => {
    setDecision(d);
    if (d === 'changes' && reason === 'no_changes') {
      setReasonErr('Choose what needs to change.');
      return;
    }
    review.mutate(d);
  };

  const canReview = can('advertising.campaigns.review');
  const canManage = can('advertising.campaigns.manage');
  const text = group?.creatives.find((c) => c.kind === 'text');
  const copy: AdCopy = {
    headline: text?.headline ?? campaign.data?.creatives.find((c) => c.headline)?.headline ?? group?.name ?? '',
    text: text?.body ?? '',
    button: text?.buttonText ?? 'Learn more',
    desk: group?.creatives.find((c) => c.kind === 'image' && c.device !== 'phone')?.media?.url,
    phone: group?.creatives.find((c) => c.kind === 'image' && c.device !== 'desktop')?.media?.url,
  };
  const checks = group
    ? [...new Map(group.creatives.flatMap((c) => [...c.autoChecks, { state: c.linkCheck.state, label: c.linkCheck.detail, detail: null }]).map((x) => [x.label, x])).values()]
    : [];
  const notes = group ? group.creatives.flatMap((c) => c.reviews.map((r) => ({ ...r, file: fileLabel(c) }))).sort((a, b) => a.at.localeCompare(b.at)) : [];
  const dedupNotes = [...new Map(notes.map((n) => [`${n.reviewer.name}|${n.at.slice(0, 16)}|${n.decision}`, n])).values()];
  const c0 = campaign.data;

  return (
    <AdminLayout active="ad-assets">
      <div className="page-head">
        <div className="t">
          <Breadcrumbs items={[{ label: 'Advertisements', to: href('admin/ads') }, { label: 'Creative library' }]} />
          <h1 className="h1">Ad creative library</h1>
          <p className="sub small">Images, ad text, video and destination links for every campaign · reviewed by Advertising and Content</p>
        </div>
        <div className="actions">
          <input ref={upload} type="file" hidden accept="image/jpeg,image/png,image/webp,video/mp4" onChange={(e) => (e.target.files?.[0] && pickUpload(e.target.files[0]), (e.target.value = ''))} />
          {canManage && (
            <Button size="sm" icon="upload" onClick={() => (add.reset(), upload.current?.click())} disabled={add.isPending}>
              {add.isPending ? 'Uploading…' : 'Upload creative'}
            </Button>
          )}
        </div>
      </div>

      <Tabs items={TAB_STATUSES.map((s) => ({ label: s ? CREATIVE_STATUS[s] : 'All', value: s, count: summary.data ? summary.data[TAB_COUNT[s]] : undefined }))} active={tab} onChange={setTab} />

      <div className="toolbar">
        <SearchInput id="aa-q" placeholder="Search file name, campaign or advertiser" value={q} onChange={setQ} />
        <Select id="aa-adv" aria-label="Advertiser" options={ADVERTISERS} value={adv} onChange={(e) => setAdv(e.target.value)} />
        <Select id="aa-fmt" aria-label="Format" options={formatOptions} value={fmt} onChange={(e) => setFmt(e.target.value)} />
        <Select id="aa-link" aria-label="Link type" options={LINKS} value={link} onChange={(e) => setLink(e.target.value)} />
        <SegmentedControl
          items={[
            { label: 'Grid', value: 'grid', icon: 'layout-grid' },
            { label: 'List', value: 'list', icon: 'list' },
          ]}
          active={layout}
          onChange={setLayout}
          label="Layout"
        />
      </div>
      <p className="ab-note">
        <Icon name="info" className="ic-sm" />{' '}
        {placements.data
          ? `Required sizes: ${placements.data
              .filter((p) => p.enabled)
              .map((p) => `${p.name.toLowerCase()} ${p.formats.map((f) => `${f.width} × ${f.height}`).join(' and ')}`)
              .join('; ')}; JPG or PNG up to 1 MB. Video is stored but not shown until video placements are turned on.`
          : 'Video is stored but not shown until video placements are turned on.'}
      </p>

      {notice && <Alert tone="success" title={notice} />}
      {add.error && <Alert tone="danger" title="Upload failed">{errorMessage(add.error)}</Alert>}
      {list.error && <LoadError error={list.error} onRetry={() => void list.refetch()} />}

      <div className="stack gap-4">
        {!list.data && !list.error && (
          <div className="card pad">
            <SkeletonLines rows={4} />
          </div>
        )}
        {list.data && groups.length === 0 && (
          <div className="card pad">
            <p className="small muted">{tab || needle || adv || fmt || link ? 'No creatives match these filters.' : 'No creatives yet. Upload one, or add creatives while creating a campaign.'}</p>
          </div>
        )}
        {groups.map((g, gi) => {
          const H = gi === 0 ? 'h2' : 'h3';
          const reviewable = g.creatives.some((c) => c.status === 'in_review' || c.status === 'changes_requested');
          return (
            <section className="card" key={g.id}>
              <div className="card-head">
                <div className="stack gap-0">
                  <H className="h4">{g.name}</H>
                  <span className="xs muted">
                    {g.advertiser} · used in: {g.usedIn}
                    {g.campaignStatus ? ` · ${statusLabel(g.campaignStatus)}` : ''}
                  </span>
                </div>
                <div className="row gap-2">{g.source === 'own' ? <Badge tone="brand">Own</Badge> : <Badge tone="info">Paid</Badge>}</div>
              </div>
              {layout === 'grid' ? (
                <div className="card-body">
                  <div className="ab-tiles">
                    {g.creatives.map((c) => (
                      <article key={c.id} className={cx('ab-tile', open && group?.id === g.id && c.status === 'in_review' && 'is-sel')}>
                        <Preview c={c} />
                        <div className="bd">
                          <div className="row between gap-1-5">
                            <span className="small strong truncate">{fileLabel(c)}</span>
                            <StatusBadge status={CREATIVE_STATUS[c.status]} />
                          </div>
                          <span className="xs muted">{c.formatLabel}</span>
                          <span className="xs num">{sizeLine(c)}</span>
                          <CheckLine c={c} />
                          {c.reviews.length > 0 && (
                            <span className="note">
                              {(() => {
                                const r = c.reviews[c.reviews.length - 1];
                                return `${r.reviewer.name ?? ROLE_LABEL[r.role]}: ${r.comment || reasonLabel(r.reasonCode) || CREATIVE_STATUS[c.status]}`;
                              })()}
                            </span>
                          )}
                          <span className="row gap-2 mt-auto">
                            {reviewable && canReview ? (
                              <Button variant="secondary" size="sm" onClick={() => openReview(g)}>
                                Review
                              </Button>
                            ) : (
                              <Button variant="ghost" size="sm" to={g.campaignId && c.usedIn[0] ? href('admin/ad-campaign', 'creative-preview', undefined, { id: g.campaignId }) : undefined}>
                                View
                              </Button>
                            )}
                            {c.media?.url && <Button variant="ghost" size="sm" icon="download" label={`Download ${fileLabel(c)}`} href={c.media.url} />}
                          </span>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              ) : (
                <TableWrap label={`${g.name} creatives table`}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">File</th>
                        <th scope="col">Format</th>
                        <th scope="col">Size</th>
                        <th scope="col">Check</th>
                        <th scope="col">Status</th>
                        <th className="col-pin" scope="col">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.creatives.map((c) => (
                        <tr key={c.id}>
                          <td className="strong">{fileLabel(c)}</td>
                          <td>{c.formatLabel}</td>
                          <td className="num nowrap">{sizeLine(c)}</td>
                          <td>
                            <CheckLine c={c} />
                          </td>
                          <td>
                            <StatusBadge status={CREATIVE_STATUS[c.status]} />
                          </td>
                          <td className="col-pin">
                            {reviewable && canReview ? (
                              <Button variant="secondary" size="sm" onClick={() => openReview(g)}>
                                Review
                              </Button>
                            ) : c.media?.url ? (
                              <Button variant="ghost" size="sm" icon="download" label={`Download ${fileLabel(c)}`} href={c.media.url} />
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
            </section>
          );
        })}
      </div>

      {group && (
        <Drawer
          open={open}
          onClose={close}
          title={`Review creative: ${group.name}`}
          foot={
            inReview.length && canReview ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => decide('changes')} disabled={review.isPending}>
                  Request changes
                </Button>
                <Button size="sm" icon="check" onClick={() => decide('approve')} disabled={review.isPending}>
                  Approve creative
                </Button>
              </>
            ) : (
              <span className="xs muted">{canReview ? 'Nothing in this campaign is waiting for review. The owner resubmits after changes.' : 'Reviewing creatives needs the campaign review permission.'}</span>
            )
          }
        >
          {review.error && (
            <Alert tone="danger" title="The decision wasn’t saved">
              {errorMessage(review.error)}
            </Alert>
          )}
          <KeyValue
            pairs={[
              ['Advertiser', `${group.advertiser} · ${group.source === 'own' ? 'own promotion' : 'paid'}`],
              ['Files', group.creatives.map((c) => (c.kind === 'text' ? 'ad text' : fileLabel(c))).join(' · ')],
              ['Destination', c0?.destination.url ?? text?.link ?? group.creatives.find((c) => c.link)?.link ?? '—'],
              [
                'Campaign',
                group.campaignId ? (
                  <>
                    <Link to={c0 ? href('admin/ad-campaign', 'approval', undefined, { ref: c0.ref }) : href('admin/ad-campaign', 'approval', undefined, { id: group.campaignId })} className="link-inline">
                      {group.usedIn}
                    </Link>
                    {c0?.startsAt && c0.endsAt ? ` · ${shortDate(c0.startsAt)}–${shortDate(c0.endsAt)}` : ''}
                  </>
                ) : (
                  'Not used yet'
                ),
              ],
            ]}
          />
          {group.source === 'own' && (
            <div className="ab-dpair ab-sm">
              <div className="stack gap-1">
                <span className="xs strong sub">
                  <Icon name="monitor" className="ic-sm" /> Desktop
                </span>
                <div className="ab-dframe">
                  <div className="ab-dbar">
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className="ab-screen desk">
                    <div className="sk h-18" />
                    <div className="sk h-46" />
                    <div className="sk u-h-12px" style={{ width: '60%' }} />
                    <div className="sk h-30" />
                    <AdMock g={copy} desk />
                  </div>
                </div>
              </div>
              <div className="stack gap-1">
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
                    <AdMock g={copy} />
                  </div>
                </div>
              </div>
            </div>
          )}
          <div className="panel stack gap-1">
            <span className="small strong">{copy.headline}</span>
            <span className="xs sub">
              {copy.text} · button "{copy.button}"
            </span>
          </div>
          <span className="h4">Checks</span>
          <ul className="ab-checks">
            {checks.map((c) => {
              const tone = checkTone(c.state);
              return (
                <li key={c.label} className={`t-${tone}`}>
                  <span className="sr-only">{tone === 'ok' ? 'Passed: ' : tone === 'warn' ? 'Warning: ' : ''}</span>
                  <Icon name={tone === 'ok' ? 'circle-check' : tone === 'warn' ? 'triangle-alert' : 'info'} className="ic-sm" />
                  <span className="stack gap-0">
                    <span>{c.label}</span>
                    {c.detail && <span className="xs muted">{c.detail}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
          <span className="h4">Reviewer notes</span>
          <div className="ab-conv">
            {dedupNotes.map((n) => (
              <div key={`${n.reviewer.name}${n.at}${n.file}`} className={cx('ab-msg', n.role === 'content' ? 'is-note' : 'is-staff')}>
                <span className="who">
                  <b>{n.reviewer.name ?? 'Reviewer'}</b>
                  <Badge tone={n.role === 'advertising' ? 'brand' : 'warning'}>{ROLE_LABEL[n.role] ?? n.role}</Badge>
                  <span>
                    {dateTime(n.at)} · {n.decision === 'changes_requested' ? 'changes requested' : n.decision}
                  </span>
                </span>
                <p>{n.comment || reasonLabel(n.reasonCode) || '—'}</p>
              </div>
            ))}
            {dedupNotes.length === 0 && <p className="xs muted">No reviewer notes yet.</p>}
          </div>
          {myRoles.length > 1 && (
            <Field label="Review as" hint="Your roles cover more than one review step">
              <Select id="aa-role" options={myRoles.map((r) => ({ value: r, label: REVIEW_ROLE_LABEL[r] }))} value={role} onChange={(e) => setReviewAs(e.target.value as ReviewRole)} />
            </Field>
          )}
          <fieldset className="stack gap-2 fieldset-reset">
            <legend className="label">Decision</legend>
            {(
              [
                ['approve', 'Approve', 'Campaign can be scheduled once all reviewers approve'],
                ['changes', 'Request changes', 'Sent to the campaign owner with your reason'],
              ] as const
            ).map(([v, t, b], i) => (
              <label key={v} className={cx('opt-card', decision === v && 'is-selected')} htmlFor={`aa-dec-${i + 1}`}>
                <input type="radio" name="aa-dec" id={`aa-dec-${i + 1}`} checked={decision === v} onChange={() => (setDecision(v), setReasonErr(''))} />
                <span className="stack gap-1 grow">
                  <span className="small strong">{t}</span>
                  <span className="small sub">{b}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Field label="Reason or note" error={reasonErr}>
            <Select id="aa-reason" options={REASONS.map((r) => ({ value: r.code, label: r.label }))} value={reason} onChange={(e) => (setReason(e.target.value as typeof reason), setReasonErr(''))} />
          </Field>
          <Field label="Comment for the owner" optional>
            <Textarea id="aa-note" value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
        </Drawer>
      )}
      <Dialog open={!!crop && !crop.format} onClose={() => setCrop(null)} title="Which size is this image for?" size="sm">
        <span className="small">The image is cropped to the size you choose and saved at exactly that size.</span>
        <span className="stack gap-2">
          {crop?.formats.map((f) => (
            <Button key={`${f.device}-${f.width}`} variant="secondary" onClick={() => setCrop((c) => (c ? { ...c, format: f } : c))}>
              {f.label}
            </Button>
          ))}
        </span>
      </Dialog>
      {crop?.format && (
        <ImageCropper
          files={[crop.file]}
          spec={exactImageSpec(crop.format.width, crop.format.height)}
          wording={{ what: `${crop.format.label} ad images`, place: 'frame the ad', detail: ['Ad', 'the ad'], thumbnail: ['Preview', 'the creative library'] }}
          onProcessed={(img) => crop.format && add.mutate({ f: img.file, device: crop.format.device })}
          onClose={() => setCrop(null)}
        />
      )}
    </AdminLayout>
  );
}
