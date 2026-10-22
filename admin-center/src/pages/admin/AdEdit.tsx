import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { assetPreview, call, errorMessage, exactImageSpec, uploadMedia, useApi } from '@marketly/web-shared/api';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { fromZonedInput, zonedInput } from '@marketly/web-shared/lib/dates';
import { useDebounced } from '@marketly/web-shared/lib/hooks';
import { Alert, announce, Badge, Button, DateTimeField, EmptyState, Field, Icon, ImageCropper, OptionCard, PageHeader, Radio, sameOriginFile, Select, Switch, Textarea, TextInput, type CropWording } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { actorLabel, dateTime, LoadError, SkeletonLines, TZ } from '@/app/parts';
import { codeOf, fieldErrorsOf } from './data/departments';
import {
  ADS_KEY, ADS_LIST, adHref, adReviewHref, failedChecks, isRunning, KINDS, kindChip, kindOf, sizeText, slotOf, SLOTS, STATUS, STEP_LABEL,
  type AdDestination, type AdImage, type AdReview, type DestKind, type Size, type Slot, type SlotKey, type StaffAd, type StaffAdInput, type StaffAdPatch,
} from './data/staff-ads';

// Admin › Advertisements › Add / edit ad (designed from the Marketly canvas: AdminAdEdit). One page for a new ad
// (/ads/new, ?slot=<placement key> presets where it shows) and an existing one (/ads/:id, the id or the AD- ref).
// Cards: 1 Where it shows (the slot is fixed once saved) · 2 Image (phone image cropped to the slot's exact size,
// purpose ad_creative; full-screen ads may add a website image) · 3 What it opens (picked from GET /ads/destinations;
// only a web address is typed) · 4 When. Right: Preview (the slot in a phone frame) and Review (the two review steps,
// Submit for review / Save draft; reviewers approve, ask for changes or reject here). Editing a scheduled, live or
// paused ad saves a pending change that goes through the same reviews (the review of a change has its own page,
// AdReview.tsx); its end date applies at once.

type Card = 'opening_fullscreen' | 'home_banner' | 'department' | 'deals_top' | 'category_banner' | 'popup';
type Picked = { kind: DestKind; targetId?: string | null; label: string; meta?: string | null; available?: boolean };
type Img = AdImage & { fileName?: string; bytes?: number };
type Draft = {
  card: Card | ''; dept: SlotKey | ''; categoryId: string; image: Img | null; webImage: Img | null; alt: string; name: string;
  kind: DestKind; dest: Picked | null; url: string; startMode: 'approval' | 'date'; startsAt: string; endsAt: string; stopWithDeal: boolean; deal: { id: string; name: string } | null;
};
type Errors = Partial<Record<'card' | 'dept' | 'categoryId' | 'image' | 'webImage' | 'alt' | 'name' | 'destination' | 'startsAt' | 'endsAt' | 'deal', string>>;

const CARDS: Array<{ value: Card; name: string; where: string; size: string }> = [
  { value: 'opening_fullscreen', name: 'Full-screen', where: 'After the splash, when the app opens', size: 'Phone 1080 × 1920 (+ website 1600 × 900, optional)' },
  { value: 'home_banner', name: 'Home carousel', where: 'Top of Home', size: '750 × 400' },
  { value: 'department', name: 'Department carousel', where: 'Top of a department page', size: '750 × 400' },
  { value: 'deals_top', name: 'Deals carousel', where: 'Top of the Deals tab', size: '750 × 150' },
  { value: 'category_banner', name: 'Category banner', where: 'Top of category pages', size: '750 × 300' },
  { value: 'popup', name: 'Pop-up', where: 'Over Home, search and product pages', size: '600 × 600' },
];
const DEPTS = SLOTS.filter((s) => s.tab === 'departments');
const cardOf = (key?: string | null): Card | '' => (!key ? '' : DEPTS.some((s) => s.key === key) ? 'department' : CARDS.some((c) => c.value === key) ? (key as Card) : '');
const placementOf = (d: Pick<Draft, 'card' | 'dept'>): SlotKey | '' => (d.card === 'department' ? d.dept : d.card);
const MAX_BYTES = 1024 * 1024;
const DAY = 86_400_000;
const cropWording = (what: string): CropWording => ({ what, place: 'frame the ad', detail: ['Ad image', 'the ad'], thumbnail: ['Preview', 'the ad list'] });
const pickedOf = (d?: AdDestination | null): Picked | null => (d && d.kind !== 'url' ? { kind: d.kind, targetId: d.targetId, label: d.label, meta: d.meta, available: d.available } : null);

/** The form's values: the ad, with its pending change on top (a running ad's edit) */
function draftOf(ad: StaffAd | undefined, preset: string): Draft {
  const pc = ad?.pendingChange;
  const has = (f: string) => !!pc && pc.changedFields.includes(f);
  const destination = has('destination') ? pc!.destination : ad?.destination;
  const startsAt = has('startsAt') ? pc!.startsAt : ad?.startsAt;
  const dealId = has('deal') ? pc!.dealId : ad?.dealId;
  const dealName = has('deal') ? pc!.dealName : ad?.dealName;
  const key = ad?.placementKey ?? preset;
  return {
    card: cardOf(key),
    dept: DEPTS.some((s) => s.key === key) ? (key as SlotKey) : '',
    categoryId: ad?.categoryId ?? '',
    image: (has('image') ? pc!.image : ad?.image) ?? null,
    webImage: (has('webImage') ? pc!.webImage : ad?.webImage) ?? null,
    alt: (has('alt') ? pc!.alt : ad?.alt) ?? '',
    name: (has('name') ? pc!.name : ad?.name) ?? '',
    kind: destination?.kind ?? 'product',
    dest: pickedOf(destination),
    url: destination?.kind === 'url' ? destination.path : '',
    startMode: startsAt ? 'date' : 'approval',
    startsAt: zonedInput(startsAt, TZ),
    endsAt: zonedInput(ad?.endsAt, TZ),
    stopWithDeal: (has('deal') ? pc!.stopWithDeal : ad?.stopWithDeal) ?? false,
    deal: dealId ? { id: dealId, name: dealName ?? 'Deal' } : null,
  };
}

/** The API body of a draft (every field; a PATCH sends the ones that changed) */
function inputOf(d: Draft): Omit<StaffAdInput, 'placementKey'> {
  const dest = d.kind === 'url' ? (d.url.trim() ? { kind: 'url' as const, url: d.url.trim() } : null) : d.dest ? { kind: d.dest.kind, targetId: d.dest.targetId ?? null } : null;
  return {
    name: d.name.trim(),
    categoryId: d.card === 'category_banner' ? d.categoryId || null : null,
    imageId: d.image?.id ?? null,
    webImageId: d.card === 'opening_fullscreen' ? (d.webImage?.id ?? null) : null,
    alt: d.alt.trim() || null,
    destination: dest,
    startsAt: d.startMode === 'date' ? fromZonedInput(d.startsAt, TZ) : null,
    endsAt: d.endsAt ? fromZonedInput(d.endsAt, TZ) : null,
    dealId: d.stopWithDeal ? (d.deal?.id ?? null) : null,
    stopWithDeal: d.stopWithDeal,
  };
}

/** What is missing: for a draft only the name and the slot; for a submit everything the API checks */
function problemsOf(d: Draft, submit: boolean): Errors {
  const e: Errors = {};
  if (!d.card) e.card = 'Pick where the ad shows.';
  else if (d.card === 'department' && !d.dept) e.dept = 'Pick the department.';
  if (!d.name.trim()) e.name = 'Name the ad (only staff see it).';
  if (!submit) return e;
  if (!d.image) e.image = 'Add the phone image.';
  if (!d.alt.trim()) e.alt = 'Describe the image.';
  if (d.kind === 'url' ? !/^https:\/\/\S+\.\S+/.test(d.url.trim()) : !d.dest) e.destination = d.kind === 'url' ? 'Enter a web address starting with https://' : 'Pick what the ad opens.';
  else if (d.kind !== 'url' && d.dest && d.dest.available === false) e.destination = 'This target is no longer shown in the store. Pick another.';
  const start = d.startMode === 'date' ? fromZonedInput(d.startsAt, TZ) : null;
  if (d.startMode === 'date' && !start) e.startsAt = 'Pick the start date.';
  const end = d.endsAt ? fromZonedInput(d.endsAt, TZ) : null;
  if (!end) e.endsAt = 'Pick the end date.';
  else {
    const from = start ? Date.parse(start) : Date.now();
    if (Date.parse(end) <= Math.max(from, Date.now())) e.endsAt = 'The end must be after the start and in the future.';
    else if (Date.parse(end) - from > 90 * DAY) e.endsAt = 'At most 90 days after it starts.';
  }
  if (d.stopWithDeal && !d.deal) e.deal = 'Pick the deal it stops with.';
  return e;
}
/** API field paths → the form's fields */
const fieldOf = (path: string): keyof Errors => {
  const head = path.split(/[.[]/)[0] ?? '';
  return ({ placementKey: 'card', imageId: 'image', webImageId: 'webImage', dealId: 'deal', stopWithDeal: 'deal' } as Record<string, keyof Errors>)[head] ?? (head as keyof Errors);
};

export default function AdEdit() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const { api } = useApi();
  const { can } = useStaffSession();
  const canView = can('advertising.campaigns.view') || can('advertising.campaigns.manage') || can('advertising.campaigns.review');
  const ad = useQuery({ queryKey: ['advertising', 'staff-ad', id], enabled: canView && !isNew, queryFn: () => call(api.GET('/api/admin/advertising/ads/{id}', { params: { path: { id } } })) });
  const crumbs = [{ label: 'Admin' }, { label: 'Advertisements', to: ADS_LIST }];
  return (
    <AdminLayout active="ads">
      {!canView ? (
        <>
          <PageHeader crumbs={crumbs} title={isNew ? 'Add ad' : 'Edit ad'} />
          <Alert tone="info" title="You don’t have access to Advertisements">
            Seeing ads needs an advertising permission (view, manage or review ads). A Platform Administrator can change your roles in Staff and roles.
          </Alert>
        </>
      ) : isNew || ad.data ? (
        <AdEditor key={ad.data?.id ?? 'new'} ad={ad.data} routeId={id} />
      ) : ad.isError ? (
        <>
          <PageHeader crumbs={crumbs} title="Edit ad" />
          {codeOf(ad.error) === 'NOT_FOUND' ? (
            <section className="card">
              <div className="card-body">
                <EmptyState icon="megaphone" title="This ad doesn’t exist" as="h2" action={<Button to={ADS_LIST}>Back to Advertisements</Button>}>
                  It may have been deleted.
                </EmptyState>
              </div>
            </section>
          ) : (
            <LoadError error={ad.error} onRetry={() => void ad.refetch()} />
          )}
        </>
      ) : (
        <>
          <PageHeader crumbs={crumbs} title="Edit ad" />
          <SkeletonLines rows={10} />
        </>
      )}
    </AdminLayout>
  );
}

function AdEditor({ ad, routeId }: { ad?: StaffAd; routeId: string }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useStaffSession();
  const canManage = can('advertising.campaigns.manage');
  const canReview = can('advertising.campaigns.review');
  const [params] = useSearchParams();
  const state = useLocation().state as { notice?: string; error?: string } | null;
  // ?slot=<placement key>, or ?slot=department (a department carousel, department still to pick)
  const raw = params.get('slot');
  const preset = slotOf(raw)?.key ?? (raw === 'department' ? 'department' : '');
  const base = useMemo(() => draftOf(ad, preset), [ad, preset]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const d = draft ?? base;
  const setD = (patch: Partial<Draft>) => setDraft((cur) => ({ ...(cur ?? base), ...patch }));
  const [tried, setTried] = useState<'draft' | 'submit' | null>(null);
  const [server, setServer] = useState<Errors>({});
  const [checks, setChecks] = useState<string[]>([]);
  const [error, setError] = useState(state?.error ?? '');
  const [notice, setNotice] = useState(state?.notice ?? '');
  const [note, setNote] = useState('');

  const editable = canManage && (!ad || ad.allowedActions.includes('edit'));
  const running = !!ad && isRunning(ad);
  const pc = ad?.pendingChange ?? null;
  const review: AdReview | undefined = pc ? pc.review : ad?.review;
  const reviewable = !!ad && canReview && ad.allowedActions.includes('review') && !!review?.canReview;
  const key = placementOf(d);
  const slot = slotOf(key);
  const client = tried ? problemsOf(d, tried === 'submit') : {};
  const err = (k: keyof Errors) => client[k] || server[k] || '';

  // the fields that differ from the saved ad (a PATCH sends only these, so a running ad's change holds only real edits)
  const now = inputOf(d);
  const was = inputOf(base);
  const diff = (Object.keys(now) as Array<keyof typeof now>).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(was[k]));
  // a running ad's pending change is replaced by the PATCH: send the fields it already changes again with the new edits
  const PC_FIELDS: Record<string, Array<keyof typeof now>> = { name: ['name'], image: ['imageId'], webImage: ['webImageId'], alt: ['alt'], destination: ['destination'], startsAt: ['startsAt'], deal: ['dealId', 'stopWithDeal'] };
  const kept = pc && diff.some((k) => k !== 'endsAt') ? pc.changedFields.flatMap((f) => PC_FIELDS[f] ?? []) : [];
  const changed = [...new Set([...diff, ...kept])];
  const dirty = !ad || diff.length > 0;
  const onlyEnd = running && diff.length > 0 && diff.every((k) => k === 'endsAt');
  const changeOpen = !!pc && pc.state !== 'in_review';

  const created = useRef<StaffAd | null>(null);
  const save = useMutation({
    mutationFn: async (mode: 'draft' | 'submit') => {
      let saved = ad;
      if (!ad) {
        saved = await call(api.POST('/api/admin/advertising/ads', { body: { ...now, placementKey: key } }));
        created.current = saved;
      } else if (changed.length) {
        const body = Object.fromEntries(changed.map((k) => [k, now[k]])) as Partial<StaffAdPatch>;
        saved = await call(api.PATCH('/api/admin/advertising/ads/{id}', { params: { path: { id: ad.id } }, body: { ...body, version: ad.version } }));
      }
      if (mode === 'submit') saved = await call(api.POST('/api/admin/advertising/ads/{id}/submit', { params: { path: { id: saved!.id } } }));
      return saved!;
    },
    onSuccess: (saved, mode) => {
      qc.setQueryData(['advertising', 'staff-ad', saved.id], saved);
      qc.setQueryData(['advertising', 'staff-ad', routeId], saved);
      void qc.invalidateQueries({ queryKey: ADS_KEY });
      const msg =
        mode === 'submit'
          ? running
            ? 'Change submitted for review. The current version keeps running until it’s approved.'
            : 'Submitted for review. Two other staff members review it; you’ll get a notification.'
          : onlyEnd
            ? 'End date saved: it applies now.'
            : running
              ? 'Change saved as a draft. Submit it for review to switch the live ad over.'
              : 'Draft saved.';
      announce(msg);
      setDraft(null);
      setTried(null);
      setServer({});
      setChecks([]);
      setError('');
      if (!ad) navigate(adHref(saved.id), { replace: true, state: { notice: msg } });
      else setNotice(msg);
    },
    onError: (e) => {
      const fe = fieldErrorsOf(e);
      const mapped: Errors = {};
      Object.entries(fe).forEach(([path, msg]) => (mapped[fieldOf(path)] ||= msg));
      const msg = codeOf(e) === 'CONFLICT' ? 'Someone else saved this ad meanwhile. Reload the page to see their version.' : codeOf(e) === 'CHECKS_FAILED' ? 'The ad isn’t ready for review yet.' : Object.keys(fe).length ? 'Fix the fields marked below.' : errorMessage(e);
      // a new ad that was created before the submit failed: continue on its own page
      if (!ad && created.current) return void navigate(adHref(created.current.id), { replace: true, state: { error: `Saved as a draft, but not submitted: ${[msg, ...failedChecks(e)].join(' ')}` } });
      setServer(mapped);
      setChecks(failedChecks(e));
      setNotice('');
      setError(msg);
    },
  });
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'request_changes' | 'reject') => call(api.POST('/api/admin/advertising/ads/{id}/review', { params: { path: { id: ad!.id } }, body: { decision, note: note.trim() || null } })),
    onSuccess: (saved, decision) => {
      qc.setQueryData(['advertising', 'staff-ad', saved.id], saved);
      qc.setQueryData(['advertising', 'staff-ad', routeId], saved);
      void qc.invalidateQueries({ queryKey: ADS_KEY });
      const msg = decision === 'approve' ? (saved.status === 'in_review' ? 'Approved: waiting for the other review.' : `Approved: the ad is ${STATUS[saved.status].label.toLowerCase()}.`) : decision === 'reject' ? 'Rejected. The author is told why.' : 'Changes asked. The author gets your note.';
      announce(msg);
      setNote('');
      setError('');
      setNotice(msg);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const go = (mode: 'draft' | 'submit') => {
    setTried(mode);
    setNotice('');
    if (Object.values(problemsOf(d, mode === 'submit')).some(Boolean)) {
      setError('');
      return;
    }
    save.mutate(mode);
  };
  const needsNote = (decision: 'request_changes' | 'reject') => {
    if (note.trim()) return decide.mutate(decision);
    setError(decision === 'reject' ? 'Write a note saying why you reject it.' : 'Write a note saying what should change.');
    document.getElementById('ad-rv-note')?.focus();
  };

  const firstProblem = Object.values(client).find(Boolean) || '';
  const busy = save.isPending || decide.isPending;

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Admin' }, { label: 'Advertisements', to: ADS_LIST }]}
        title={ad ? `Edit ad: ${ad.name}` : 'Add ad'}
        sub={
          ad
            ? `${ad.placementName} · ${STATUS[ad.status].label} · ${ad.ref} · added by ${actorLabel(ad.createdBy)}${ad.stats.views ? ` · ${ad.stats.views.toLocaleString('en-US')} views, ${ad.stats.taps.toLocaleString('en-US')} taps` : ''}${editable ? '' : ' · view only'}`
            : 'Pick where it shows, add the image and what it opens, then submit it for review. Editing an existing ad uses this same page.'
        }
      />
      {notice && <Alert tone="success" title={notice} />}
      {(error || firstProblem) && (
        <Alert tone="danger" title={error || firstProblem}>
          {checks.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {checks.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      {ad?.statusNote && (ad.status === 'changes_requested' || ad.status === 'rejected' || pc?.state === 'changes_requested') && <Alert tone="warning" title={ad.statusNote} />}

      <div className="ab-main">
        <fieldset className="stack gap-5" disabled={!editable} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <section className="card">
            <div className="card-head">
              <h2 className="h4">1 · Where it shows</h2>
            </div>
            <div className="card-body" style={{ gap: 14 }}>
              <div role="radiogroup" aria-label="Where it shows" className="grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
                {CARDS.map((c) => (
                  <OptionCard
                    key={c.value}
                    id={`ad-slot-${c.value}`}
                    name="ad-slot"
                    checked={d.card === c.value}
                    disabled={!!ad && d.card !== c.value}
                    onChange={() => setD({ card: c.value })}
                    title={<span className="small strong">{c.name}</span>}
                    body={
                      <span className="stack" style={{ gap: 2 }}>
                        <span className="xs muted">{c.where}</span>
                        <span className="xs strong" style={{ color: 'var(--text-2)' }}>
                          {c.size}
                        </span>
                      </span>
                    }
                  />
                ))}
              </div>
              {err('card') && <span className="xs t-danger-text">{err('card')}</span>}
              {d.card === 'department' && (
                <div className="grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
                  <Field label="Department" hint="Softwares, Food delivery, Companies or Play center" error={err('dept')}>
                    <Select id="ad-dept" value={d.dept} disabled={!!ad} options={[{ value: '', label: 'Pick a department…' }, ...DEPTS.map((s) => ({ value: s.key, label: s.dept! }))]} onChange={(e) => setD({ dept: e.target.value as SlotKey | '' })} />
                  </Field>
                </div>
              )}
              {d.card === 'category_banner' && <CategoryField value={d.categoryId} error={err('categoryId')} onChange={(categoryId) => setD({ categoryId })} />}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h2 className="h4">2 · Image</h2>
                <span className="xs muted">{slot ? `Phone image ${sizeText(slot.phone)} px · JPG, PNG or WebP · 1 MB at most · you crop it to the exact size after choosing it` : 'Pick where it shows first: the image size depends on it'}</span>
              </div>
            </div>
            <div className="card-body" style={{ gap: 16 }}>
              {slot ? (
                <ImageField id="ad-img" label="Phone image" size={slot.phone} value={d.image} disabled={!editable} error={err('image')} onChange={(image) => setD({ image })} />
              ) : (
                <span className="small muted">No slot picked yet.</span>
              )}
              {slot?.web && (
                <div className="stack gap-2">
                  <span className="label">
                    Website image <span className="opt">(optional)</span>
                  </span>
                  <span className="xs muted">{sizeText(slot.web)} px, for the full-screen ad on the website; without it the website shows no full-screen ad</span>
                  <ImageField id="ad-web" label="Website image" size={slot.web} value={d.webImage} disabled={!editable} error={err('webImage')} onChange={(webImage) => setD({ webImage })} optional />
                </div>
              )}
              <Field label="Describe the image" hint="Read out by screen readers, and shown if the image can’t load" error={err('alt')}>
                <TextInput id="ad-alt" value={d.alt} maxLength={200} error={!!err('alt')} onChange={(e) => setD({ alt: e.target.value })} />
              </Field>
              <Field label={<>Ad name <span className="opt">(staff only)</span></>} error={err('name')}>
                <TextInput id="ad-name" value={d.name} maxLength={120} error={!!err('name')} onChange={(e) => setD({ name: e.target.value })} />
              </Field>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h2 className="h4">3 · What it opens</h2>
                <span className="xs muted">The screen the app opens when someone taps the ad</span>
              </div>
            </div>
            <div className="card-body" style={{ gap: 14 }}>
              <div className="seg" role="group" aria-label="What it opens" style={{ flexWrap: 'wrap', alignSelf: 'flex-start' }}>
                {KINDS.map((k) => (
                  <button key={k.value} type="button" className={d.kind === k.value ? 'is-active' : undefined} aria-pressed={d.kind === k.value} onClick={() => setD({ kind: k.value })}>
                    {k.label}
                  </button>
                ))}
              </div>
              {d.kind === 'url' ? (
                <Field label="Web address" hint="Only for pages outside the app, e.g. a partner’s site. It opens in the browser." error={err('destination')}>
                  <TextInput id="ad-url" type="url" inputMode="url" placeholder="https://" value={d.url} error={!!err('destination')} onChange={(e) => setD({ url: e.target.value })} />
                </Field>
              ) : (
                <>
                  <DestinationPicker kind={d.kind} value={d.dest} disabled={!editable} onPick={(dest) => setD({ dest })} />
                  {err('destination') && <span className="xs t-danger-text">{err('destination')}</span>}
                </>
              )}
              <span className="hint">Product, category, department page, deal, store page or collection, seller store, brand and phone are picked from lists; a web address is only for pages outside the app.</span>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="h4">4 · When</h2>
            </div>
            <div className="card-body" style={{ gap: 14 }}>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
                <div className="field">
                  <span className="label">Starts</span>
                  <Radio id="ad-start-now" name="ad-start" label="As soon as it’s approved" checked={d.startMode === 'approval'} onChange={() => setD({ startMode: 'approval' })} />
                  <Radio id="ad-start-date" name="ad-start" label="On a date" checked={d.startMode === 'date'} onChange={() => setD({ startMode: 'date' })} />
                  {d.startMode === 'date' && <DateTimeField id="ad-start" value={d.startsAt} onChange={(startsAt) => setD({ startsAt })} error={!!err('startsAt')} disabled={!editable} />}
                  {err('startsAt') && <span className="xs t-danger-text">{err('startsAt')}</span>}
                </div>
                <Field label="Ends" hint={`At most 90 days after it starts${running ? ' · a new end date applies at once, without a review' : ''} · Pacific time`} error={err('endsAt')}>
                  <DateTimeField id="ad-end" value={d.endsAt} after={d.startMode === 'date' ? d.startsAt : undefined} onChange={(endsAt) => setD({ endsAt })} error={!!err('endsAt')} disabled={!editable} />
                </Field>
              </div>
              <Switch id="ad-deal" label="Tie it to a deal: stop when the deal ends" checked={d.stopWithDeal} onChange={(e) => setD({ stopWithDeal: e.target.checked, deal: d.deal ?? (d.dest?.kind === 'deal' && d.dest.targetId ? { id: d.dest.targetId, name: d.dest.label } : null) })} />
              {d.stopWithDeal &&
                (d.deal ? (
                  <div className="row nowrap" style={{ gap: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--brand-soft)' }}>
                    <Icon name="check" className="ic-sm" />
                    <span className="small grow">
                      Stops when <strong>{d.deal.name}</strong> ends
                    </span>
                    {editable && (
                      <Button variant="ghost" size="sm" onClick={() => setD({ deal: null })}>
                        Change
                      </Button>
                    )}
                  </div>
                ) : (
                  <DestinationPicker kind="deal" value={null} disabled={!editable} onPick={(p) => p.targetId && setD({ deal: { id: p.targetId, name: p.label } })} compact />
                ))}
              {err('deal') && <span className="xs t-danger-text">{err('deal')}</span>}
            </div>
          </section>
        </fieldset>

        <div className="stack gap-5">
          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h2 className="h4">Preview</h2>
                <span className="xs muted">{slot ? slot.previewSub : 'Pick where it shows'}</span>
              </div>
            </div>
            <div className="card-body" style={{ alignItems: 'center' }}>
              <AdPreview slot={slot} image={d.image} alt={d.alt} />
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="h4">Review</h2>
              {pc && <Badge tone="warning">{pc.state === 'in_review' ? 'Change in review' : pc.state === 'changes_requested' ? 'Change: changes asked' : 'Change not submitted'}</Badge>}
            </div>
            <div className="card-body" style={{ gap: 12 }}>
              <ReviewSteps review={review} />
              {ad?.statusNote && <span className="xs" style={{ color: 'var(--text-2)' }}>{ad.statusNote}</span>}
              <span className="xs muted">
                Two other staff members review it; you can’t review your own ad. When you edit a live ad, the current version keeps running until the change is approved. Only the end date and the carousel order change at once.
              </span>
              {reviewable && !pc && (
                <div className="stack gap-2">
                  <Field label="Your note" optional hint="Needed to ask for changes or reject">
                    <Textarea id="ad-rv-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change" />
                  </Field>
                </div>
              )}
              {!editable && !reviewable && ad && (
                <span className="xs" style={{ color: 'var(--text-2)' }}>
                  {!canManage
                    ? 'View only: editing ads needs the manage ads permission.'
                    : ad.status === 'in_review' || pc?.state === 'in_review'
                      ? 'Waiting for review: it can be edited again once the reviews are done.'
                      : ad.status === 'ended' || ad.status === 'rejected'
                        ? 'This ad can’t be edited any more. Duplicate it from the list to run it again.'
                        : 'This ad can’t be edited now.'}
                </span>
              )}
            </div>
            {(editable || reviewable) && (
              <div className="card-foot" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                {reviewable &&
                  (pc ? (
                    <Button size="sm" block to={adReviewHref(ad!.id)}>
                      Review the change
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" block onClick={() => decide.mutate('approve')} disabled={busy}>
                        Approve
                      </Button>
                      <Button variant="secondary" size="sm" block onClick={() => needsNote('request_changes')} disabled={busy}>
                        Ask for changes
                      </Button>
                      <Button variant="ghost" size="sm" block onClick={() => needsNote('reject')} disabled={busy} className="t-danger-text">
                        Reject
                      </Button>
                    </>
                  ))}
                {editable && (
                  <>
                    <Button size="sm" block onClick={() => go('submit')} disabled={busy || (running && !changeOpen && (!dirty || onlyEnd))}>
                      {save.isPending && save.variables === 'submit' ? 'Submitting…' : running ? 'Submit change for review' : 'Submit for review'}
                    </Button>
                    <Button variant="secondary" size="sm" block onClick={() => go('draft')} disabled={busy || (!!ad && !dirty)}>
                      {save.isPending && save.variables === 'draft' ? 'Saving…' : onlyEnd ? 'Save end date' : running ? 'Save change as draft' : 'Save draft'}
                    </Button>
                  </>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

/* ---------------- Review steps ---------------- */

/** The two review steps: who took them, when, and their notes ("after you submit" before the first submit) */
export function ReviewSteps({ review }: { review?: AdReview }) {
  const steps = review?.steps.length ? review.steps : (['advertising', 'content'] as const).map((step) => ({ step, state: 'waiting' as const, by: null, at: null, note: null }));
  const submitted = !!review?.steps.length;
  return (
    <ul className="list">
      {steps.map((s, i) => (
        <li key={s.step} style={{ alignItems: 'flex-start' }}>
          <Badge tone={s.state === 'approved' ? 'success' : s.state === 'waiting' ? 'outline' : s.state === 'rejected' ? 'danger' : 'warning'}>{s.state === 'approved' ? <Icon name="check" /> : i + 1}</Badge>
          <span className="stack gap-0 grow">
            <span className="small">{STEP_LABEL[s.step]}</span>
            {s.note && <span className="xs" style={{ color: 'var(--text-2)' }}>“{s.note}”</span>}
          </span>
          <span className="xs muted" style={{ textAlign: 'right' }}>
            {!submitted ? 'after you submit' : s.state === 'waiting' ? 'waiting' : `${s.state === 'approved' ? 'Approved' : s.state === 'rejected' ? 'Rejected' : 'Changes asked'}${s.by ? ` by ${actorLabel(s.by)}` : ''}`}
            {s.at && (
              <>
                <br />
                {dateTime(s.at)}
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ---------------- Category (category banner) ---------------- */

function CategoryField({ value, error, onChange }: { value: string; error: string; onChange: (v: string) => void }) {
  const { api } = useApi();
  const cats = useQuery({ queryKey: ['advertising', 'destinations', 'category', 'all'], queryFn: () => call(api.GET('/api/admin/advertising/ads/destinations', { params: { query: { kind: 'category', limit: 100 } } })) });
  const items = cats.data?.items ?? [];
  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
      <Field label="Category" optional hint={cats.isError ? 'Categories couldn’t be loaded' : 'Empty: the banner shows on every category page'} error={error}>
        <Select id="ad-cat" value={value} options={[{ value: '', label: 'Every category' }, ...(value && !items.some((c) => c.targetId === value) ? [{ value, label: 'The saved category' }] : []), ...items.map((c) => ({ value: c.targetId, label: c.label }))]} onChange={(e) => onChange(e.target.value)} />
      </Field>
    </div>
  );
}

/* ---------------- Destination picker ---------------- */

/** One search for every kind (GET /ads/destinations): results with Select, and the picked target with Change */
function DestinationPicker({ kind, value, disabled, onPick, compact }: { kind: DestKind; value: Picked | null; disabled: boolean; onPick: (p: Picked) => void; compact?: boolean }) {
  const { api } = useApi();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(!value);
  const term = useDebounced(q.trim(), 250);
  const k = kindOf(kind);
  const show = !disabled && (open || !value || value.kind !== kind);
  const results = useQuery({
    queryKey: ['advertising', 'destinations', kind, term],
    enabled: show,
    queryFn: () => call(api.GET('/api/admin/advertising/ads/destinations', { params: { query: { kind, q: term || null, limit: kind === 'department' ? 10 : 8 } } })),
  });
  const items = results.data?.items ?? [];
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="stack" style={{ gap: 12 }}>
      {show && (
        <>
          <TextInput id={`ad-dest-q-${kind}${compact ? '-c' : ''}`} ref={input} icon="search" aria-label={k.search} placeholder={k.search} value={q} onChange={(e) => setQ(e.target.value)} />
          {results.isError ? (
            <span className="xs t-danger-text">The list couldn’t be loaded: {errorMessage(results.error)}</span>
          ) : results.isPending ? (
            <SkeletonLines rows={2} />
          ) : items.length === 0 ? (
            <span className="small muted">{term ? `Nothing found for “${term}”.` : 'Nothing to pick yet.'}</span>
          ) : (
            <ul className="list" style={{ border: '1px solid var(--border)', borderRadius: 10 }}>
              {items.map((o) => {
                const on = value?.kind === o.kind && value.targetId === o.targetId;
                return (
                  <li key={o.targetId} style={{ padding: '10px 12px' }}>
                    <span className="imgph" style={{ width: 40, height: 40, borderRadius: 8, aspectRatio: 'auto', background: 'var(--img-1)' }}>
                      {o.image?.url ? <img src={sameOriginFile(o.image.url)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Icon name={k.icon} />}
                    </span>
                    <span className="stack gap-0 grow" style={{ minWidth: 0 }}>
                      <span className="small strong">{o.label}</span>
                      {o.meta && <span className="xs muted">{o.meta}</span>}
                    </span>
                    {on ? (
                      <Badge tone="brand">Selected</Badge>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          onPick({ kind: o.kind, targetId: o.targetId, label: o.label, meta: o.meta, available: true });
                          setOpen(false);
                          setQ('');
                          announce(`${o.label} selected`);
                        }}
                      >
                        Select<span className="sr-only"> {o.label}</span>
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {value && !compact && (
        <div className="row nowrap" style={{ gap: 10, padding: '10px 12px', borderRadius: 10, background: value.available === false ? 'var(--warning-soft)' : 'var(--brand-soft)' }}>
          <Icon name={value.available === false ? 'triangle-alert' : 'check'} className="ic-sm" />
          <span className="small grow">
            Opens{' '}
            <strong>
              {kindChip(value)} · {value.label}
            </strong>{' '}
            {value.meta && <span className="muted">({value.meta})</span>}
            {value.available === false && <span className="t-danger-text"> · no longer shown in the store: pick another</span>}
          </span>
          {!disabled && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(true);
                requestAnimationFrame(() => input.current?.focus());
              }}
            >
              Change
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Image ---------------- */

/** An ad image: choose a file, crop it to the slot's exact size, upload it (purpose ad_creative) */
function ImageField({ id, label, size, value, disabled, error, optional, onChange }: { id: string; label: string; size: Size; value: Img | null; disabled: boolean; error: string; optional?: boolean; onChange: (v: Img | null) => void }) {
  const { session } = useApi();
  const input = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<File | null>(null);
  const [cropping, setCropping] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const pick = (files: File[]) => {
    const f = files[0];
    if (!f) return;
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) return setProblem('Choose a JPG, PNG or WebP image.');
    setProblem('');
    setSource(f);
    setCropping(f);
  };
  const upload = async (file: File, name: string) => {
    if (file.size > MAX_BYTES) return setProblem(`The cropped image is ${Math.round(file.size / 1024)} KB: keep it to 1 MB. Try a simpler image.`);
    setBusy(true);
    setProblem('');
    try {
      const asset = await uploadMedia(session, file, 'ad_creative');
      const url = new URL(asset.url || assetPreview(asset), window.location.origin).href;
      onChange({ id: asset.id, url, width: asset.width ?? size.width, height: asset.height ?? size.height, fileName: name, bytes: asset.sizeBytes || file.size });
      announce(`${label} uploaded`);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    if (!disabled) pick([...e.dataTransfer.files]);
  };
  const exact = value && (!value.width || !value.height || (value.width === size.width && value.height === size.height));
  const w = Math.min(375, size.width / 2);
  return (
    <div className="stack gap-2">
      {value ? (
        <div className="row nowrap" style={{ gap: 16, alignItems: 'flex-start' }}>
          <div style={{ width: w, maxWidth: '60%', aspectRatio: `${size.width} / ${size.height}`, borderRadius: 14, overflow: 'hidden', position: 'relative', flex: 'none', background: 'var(--surface-2)' }}>
            <img src={sameOriginFile(value.url)} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            <span style={{ position: 'absolute', top: 10, right: 10 }}>
              <Badge tone={exact ? 'solid' : 'warning'}>
                {value.width && value.height ? `${value.width} × ${value.height}` : sizeText(size)} {exact ? '✓' : `· needs ${sizeText(size)}`}
              </Badge>
            </span>
          </div>
          {!disabled && (
            <div className="stack gap-2">
              <Button variant="secondary" size="sm" onClick={() => input.current?.click()} disabled={busy}>
                {busy ? 'Uploading…' : 'Replace image'}
              </Button>
              {source && (
                <Button variant="ghost" size="sm" onClick={() => setCropping(source)} disabled={busy}>
                  Crop again
                </Button>
              )}
              {optional && (
                <Button variant="ghost" size="sm" onClick={() => onChange(null)} disabled={busy}>
                  Remove
                </Button>
              )}
              {value.fileName && (
                <span className="xs muted">
                  {value.fileName}
                  {value.bytes ? ` · ${Math.round(value.bytes / 1024)} KB` : ''}
                </span>
              )}
            </div>
          )}
        </div>
      ) : disabled ? (
        <span className="small muted">No {label.toLowerCase()}.</span>
      ) : (
        <div className="dropzone" onDragOver={(e) => e.preventDefault()} onDrop={drop} style={{ borderColor: error ? 'var(--danger)' : undefined }}>
          <Icon name="image-plus" className="ic-lg" />
          <span>
            {busy ? 'Uploading…' : <>Drop the {label.toLowerCase()} here or </>}
            {!busy && (
              <button type="button" className="strong" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--brand-text)', font: 'inherit' }} onClick={() => input.current?.click()}>
                browse
              </button>
            )}
          </span>
          <span className="xs">
            {sizeText(size)} px after cropping · JPG, PNG or WebP · 1 MB at most
          </span>
        </div>
      )}
      {(problem || error) && <span className="xs t-danger-text">{problem || error}</span>}
      <input ref={input} id={id} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => (pick([...(e.target.files ?? [])]), (e.target.value = ''))} />
      {cropping && (
        <ImageCropper
          files={[cropping]}
          spec={exactImageSpec(size.width, size.height)}
          wording={cropWording(label.toLowerCase())}
          onProcessed={(img) => void upload(img.file, `${cropping.name.replace(/\.[^.]+$/, '')}-${size.width}x${size.height}.${img.file.type === 'image/jpeg' ? 'jpg' : 'webp'}`)}
          onClose={() => setCropping(null)}
        />
      )}
    </div>
  );
}

/* ---------------- Preview ---------------- */

/** The slot in a phone frame with the image: full screen, a carousel strip, a category banner or a pop-up */
export function AdPreview({ slot, image, alt }: { slot?: Slot; image: AdImage | null; alt?: string }) {
  const picture = (radius: number) =>
    image?.url ? (
      <img src={sameOriginFile(image.url)} alt={alt || ''} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', borderRadius: radius }} />
    ) : (
      <span style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', background: 'var(--surface-3)', borderRadius: radius }}>
        <Icon name="image" />
      </span>
    );
  const tag = <span style={{ position: 'absolute', top: 6, right: 6, fontSize: 8, fontWeight: 700, padding: '1px 4px', borderRadius: 4, background: '#13201C', color: '#FFFFFF' }}>Ad</span>;
  const lines = (
    <div style={{ padding: '6px 10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ height: 10, width: '60%', borderRadius: 4, background: 'var(--surface-3)' }} />
      <span style={{ height: 54, borderRadius: 8, background: 'var(--surface)' }} />
      <span style={{ height: 54, borderRadius: 8, background: 'var(--surface)' }} />
    </div>
  );
  const frame = { width: 236, borderRadius: 26, border: '6px solid #13201C', background: 'var(--bg)', overflow: 'hidden', position: 'relative' } as const;
  if (!slot) return <div style={{ ...frame, height: 420, display: 'flex', alignItems: 'center', justifyContent: 'center' }} className="xs muted">Pick where it shows</div>;
  const ratio = `${slot.phone.width} / ${slot.phone.height}`;
  if (slot.key === 'opening_fullscreen') {
    return (
      <div style={{ ...frame, aspectRatio: '9 / 16' }} aria-label="Preview: full-screen ad" role="img">
        {picture(0)}
        <span style={{ position: 'absolute', top: 10, right: 10, fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 999, background: 'rgba(19, 32, 28, .6)', color: '#FFFFFF' }}>Ad · Skip</span>
      </div>
    );
  }
  if (slot.key === 'popup') {
    return (
      <div style={{ ...frame, height: 420 }} aria-label="Preview: pop-up ad" role="img">
        <div style={{ height: 34, background: 'var(--surface)', borderBottom: '1px solid var(--border)' }} />
        {lines}
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(12, 22, 19, .52)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: '80%', aspectRatio: ratio, position: 'relative' }}>
            {picture(12)}
            {tag}
            <span style={{ position: 'absolute', top: -10, right: -10, width: 22, height: 22, borderRadius: 999, background: '#FFFFFF', color: '#13201C', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700 }}>×</span>
          </div>
        </div>
      </div>
    );
  }
  const carousel = slot.key !== 'category_banner';
  return (
    <div style={frame} aria-label={`Preview: ${slot.name}`} role="img">
      <div style={{ height: 34, background: 'var(--surface)', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', fontSize: 11, fontWeight: 700, borderBottom: '1px solid var(--border)' }}>{slot.bar}</div>
      <div style={{ padding: '8px 6px 4px' }}>
        <div style={{ aspectRatio: ratio, borderRadius: 10, position: 'relative', boxShadow: '0 2px 6px rgba(19, 32, 28, .14)' }}>
          {picture(10)}
          {tag}
          {carousel && (
            <span style={{ position: 'absolute', right: 7, bottom: 7, display: 'flex', gap: 3, padding: '3px 5px', borderRadius: 999, background: 'rgba(19, 32, 28, .45)' }}>
              <span style={{ width: 10, height: 4, borderRadius: 9, background: '#FFFFFF' }} />
              <span style={{ width: 4, height: 4, borderRadius: 9, background: 'rgba(255, 255, 255, .55)' }} />
              <span style={{ width: 4, height: 4, borderRadius: 9, background: 'rgba(255, 255, 255, .55)' }} />
            </span>
          )}
        </div>
      </div>
      {lines}
    </div>
  );
}
