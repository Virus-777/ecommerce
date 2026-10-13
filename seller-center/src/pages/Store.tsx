import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { ApiError, call, errorMessage, uploadMedia, useApi, useUploads, type components } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { initials } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Field, Icon, IconButton, Img, PageHeader, SegmentedControl, Select, Switch, Tabs, Textarea, TextInput, type IconName } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { fmtDay } from './data/finance';

// Design: pages/seller/seller-store.html (no views). Store profile: GET/PATCH sellers/store-profile (store
// name and tagline go to staff review as change requests; the rest is live on save), logo and banner
// uploads (media purposes store_logo / store_banner, sent as logoId / bannerId), featured collections
// (POST/PATCH/DELETE sellers/store-profile/collections), the brand-affiliation claim (POST
// sellers/store-profile/claims with the brand and evidence, reviewed by staff) and the return policy
// (GET/PUT returns/terms). Categories are derived from offers and restrictions (read only).

type StoreProfile = components['schemas']['sellers.StoreProfile'];
type StoreProfileInput = components['schemas']['sellers.StoreProfileInput'];
type ReturnTerms = components['schemas']['returns.SellerReturnTerms'];
type Collection = components['schemas']['sellers.FeaturedCollection'];

interface Category {
  categoryId: string;
  name: string;
  state: 'active' | 'paused';
  reason?: string | null;
}

interface Profile {
  name: string;
  tagline: string;
  location: string;
  intro: string;
  returnWindow: number;
  returnShipping: 'customer' | 'seller';
  warranty: string;
  brand: string;
  brandId: string;
  msg: boolean;
  questions: boolean;
  phone: boolean;
  replyTarget: 'within_24h' | 'within_12h';
}

// The design's "Notifications" tab links to the staff page (notification preferences live there).
const TABS = [
  { label: 'Store profile', value: 'store', to: href('seller/store') },
  { label: 'Staff and permissions', value: 'staff', to: href('seller/staff') },
  { label: 'Notifications', value: 'notifications', to: href('seller/staff') },
  { label: 'Shipping', value: 'shipping', to: href('seller/shipping') },
];

const RETURN_SHIPPING = [
  { value: 'customer', label: 'Customer pays' },
  { value: 'seller', label: 'You pay (free returns)' },
];
const REPLY_TARGETS = [
  { value: 'within_24h', label: 'Within 24 hours' },
  { value: 'within_12h', label: 'Within 12 hours' },
];
const INTRO_MAX = 400;
const TAGLINE_MAX = 80;
const IMG_MAX_MB = 10;
const IMG_FILL: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' };
const TINTS = ['2', '6', '3', '4', '5', '1'];

type Errors = Partial<Record<'name' | 'tagline' | 'location' | 'intro' | 'warranty' | 'logo' | 'banner' | 'brand', string>>;

const brandClaimOf = (p: StoreProfile) =>
  [...p.claims].filter((c) => c.kind === 'brand_affiliation' && (c.state === 'pending' || c.state === 'approved')).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];

function fromApi(p: StoreProfile, t?: ReturnTerms): Profile {
  const claim = brandClaimOf(p);
  return {
    name: p.storeName,
    tagline: p.tagline ?? '',
    location: p.location ?? '',
    intro: p.introduction ?? '',
    returnWindow: t?.windowDays ?? 30,
    returnShipping: t?.changeOfMindPaidBy === 'seller' ? 'seller' : 'customer',
    warranty: p.warranty ?? '',
    brand: claim?.text ?? '',
    brandId: claim?.brandId ?? '',
    msg: p.contactOptions.orderMessages,
    questions: p.contactOptions.productQuestions,
    phone: p.contactOptions.showPhone,
    replyTarget: p.contactOptions.replyTarget,
  };
}

function validate(p: Profile, saved: Profile, evidence: number, brandsLoaded: boolean): Errors {
  const e: Errors = {};
  if (!p.name.trim()) e.name = 'Enter a store name.';
  else if (p.name.trim().length < 3) e.name = 'Store names need at least 3 characters.';
  if (p.tagline.length > TAGLINE_MAX) e.tagline = `Shorten the tagline to ${TAGLINE_MAX} characters or fewer.`;
  if (!p.location.trim()) e.location = 'Enter the city and state customers see.';
  if (!p.intro.trim()) e.intro = 'Write a short introduction for your storefront.';
  else if (p.intro.length > INTRO_MAX) e.intro = `Shorten the introduction to ${INTRO_MAX} characters or fewer.`;
  if (!p.warranty.trim()) e.warranty = 'Describe your warranty, or write "Manufacturer warranty only".';
  if (p.brand.trim() && p.brand.trim() !== saved.brand) {
    if (p.brand.trim().length > 120) e.brand = 'Keep the claim to 120 characters or fewer.';
    else if (brandsLoaded && !p.brandId) e.brand = 'Choose the brand this claim is about.';
    else if (!evidence) e.brand = 'Attach evidence, e.g. the brand’s authorization letter.';
  }
  return e;
}

/** .imgph tile that shows the image when there is one. */
function Pic({ src, icon, className }: { src: string | null; icon: IconName; className: string }) {
  return <div className={cx('imgph tint-2', className)}>{src ? <img src={src} alt="" style={IMG_FILL} /> : <Icon name={icon} />}</div>;
}

function FileError({ msg }: { msg: string }) {
  return (
    <span className="error-text" role="alert">
      <Icon name="circle-alert" className="ic-sm" />
      {msg}
    </span>
  );
}

/** Picked logo or banner: preview right away, uploaded through media; the asset id goes into the save. */
function useImageUpload(purpose: 'store_logo' | 'store_banner', onError: (msg: string) => void) {
  const { session } = useApi();
  const [state, setState] = useState<{ url: string | null; assetId: string | null; uploading: boolean }>({ url: null, assetId: null, uploading: false });
  useEffect(
    () => () => {
      if (state.url) URL.revokeObjectURL(state.url);
    },
    [state.url],
  );
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return onError('Choose a JPG, PNG or WebP image.');
    if (f.size > IMG_MAX_MB * 1024 * 1024) return onError(`Images can be up to ${IMG_MAX_MB} MB.`);
    onError('');
    setState({ url: URL.createObjectURL(f), assetId: null, uploading: true });
    uploadMedia(session, f, purpose).then(
      (a) => setState((s) => ({ ...s, assetId: a.id, uploading: false })),
      (err) => {
        setState({ url: null, assetId: null, uploading: false });
        onError(errorMessage(err));
      },
    );
  };
  const reset = () => setState({ url: null, assetId: null, uploading: false });
  return { ...state, pick, reset };
}

export default function Store() {
  const { api } = useApi();
  const qc = useQueryClient();
  const { sellerId, can } = useSellerSession();
  const canManage = can('sellers.store.manage');
  const canTerms = can('returns.terms.manage');

  const profileQ = useQuery({ queryKey: ['sellers', 'store-profile', sellerId], queryFn: () => call(api.GET('/api/seller/sellers/store-profile')) });
  const termsQ = useQuery({ queryKey: ['returns', 'terms', sellerId], queryFn: () => call(api.GET('/api/seller/returns/terms')) });
  const brandsQ = useQuery({ queryKey: ['catalog', 'brands', 'all'], queryFn: () => call(api.GET('/api/seller/catalog/brands', { params: { query: { limit: 100 } } })), enabled: canManage });

  const profile = profileQ.data;
  const terms = termsQ.data;
  const [p, setP] = useState<Profile | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<'' | 'saved' | 'error'>('');
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [device, setDevice] = useState<'desktop' | 'phone'>('phone');
  const [fileErr, setFileErr] = useState<Pick<Errors, 'logo' | 'banner'>>({});
  const logo = useImageUpload('store_logo', (m) => setFileErr((f) => ({ ...f, logo: m || undefined })));
  const banner = useImageUpload('store_banner', (m) => setFileErr((f) => ({ ...f, banner: m || undefined })));
  const evidence = useUploads('verification_document', { max: 3, accept: /\.(pdf|png|jpe?g)$|^(application\/pdf|image\/(png|jpeg))$/i });
  const logoInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);
  const evidenceInput = useRef<HTMLInputElement>(null);

  // The form starts from the saved profile (and return terms) once both are loaded.
  const saved = profile ? fromApi(profile, terms) : null;
  useEffect(() => {
    if (profile && (terms || termsQ.isError) && !p) setP(fromApi(profile, terms));
  }, [profile, terms, termsQ.isError, p]);

  const save = useMutation({
    mutationFn: async (draft: Profile) => {
      const s = saved!;
      const body: StoreProfileInput = {};
      if (draft.name.trim() !== s.name) body.storeName = draft.name.trim();
      if (draft.tagline.trim() !== s.tagline) body.tagline = draft.tagline.trim();
      if (draft.location.trim() !== s.location) body.location = draft.location.trim();
      if (draft.intro.trim() !== s.intro) body.introduction = draft.intro.trim();
      if (draft.warranty.trim() !== s.warranty) body.warranty = draft.warranty.trim();
      if (draft.msg !== s.msg || draft.questions !== s.questions || draft.phone !== s.phone || draft.replyTarget !== s.replyTarget)
        body.contactOptions = { ...profile!.contactOptions, orderMessages: draft.msg, productQuestions: draft.questions, showPhone: draft.phone, replyTarget: draft.replyTarget };
      if (logo.assetId) body.logoId = logo.assetId;
      if (banner.assetId) body.bannerId = banner.assetId;
      let next = profile!;
      if (Object.keys(body).length) next = await call(api.PATCH('/api/seller/sellers/store-profile', { body }));
      if (terms && canTerms && (draft.returnWindow !== s.returnWindow || draft.returnShipping !== s.returnShipping)) {
        const { sellerId: _s, version: _v, baseline: _b, effectiveFrom: _e, updatedAt: _u, ...input } = terms;
        await call(api.PUT('/api/seller/returns/terms', { body: { ...input, windowDays: draft.returnWindow, changeOfMindPaidBy: draft.returnShipping, freeReturns: draft.returnShipping === 'seller' } }));
      }
      const brand = draft.brand.trim();
      if (brand && brand !== s.brand) {
        await call(api.POST('/api/seller/sellers/store-profile/claims', { body: { kind: 'brand_affiliation', text: brand, brandId: draft.brandId || null, evidenceIds: evidence.assetIds } }));
      }
      return next;
    },
    onSuccess: async () => {
      logo.reset();
      banner.reset();
      evidence.clear();
      await Promise.all([qc.invalidateQueries({ queryKey: ['sellers', 'store-profile', sellerId] }), qc.invalidateQueries({ queryKey: ['returns', 'terms', sellerId] }), qc.invalidateQueries({ queryKey: ['sellers', 'account'] })]);
      setP(null); // re-initialised from the refreshed profile
      setAttempted(false);
      setNotice('saved');
    },
    onError: () => setNotice('error'),
  });

  const collectionMut = useMutation({
    mutationFn: async (a: { kind: 'add' } | { kind: 'rename'; c: Collection; title: string } | { kind: 'remove'; c: Collection }) => {
      if (a.kind === 'add') {
        const n = (profile?.collections.length ?? 0) + 1;
        return call(api.POST('/api/seller/sellers/store-profile/collections', { body: { title: `New collection ${n}`, offerIds: [] } }));
      }
      if (a.kind === 'rename') return call(api.PATCH('/api/seller/sellers/store-profile/collections/{id}', { params: { path: { id: a.c.id } }, body: { title: a.title, offerIds: a.c.offerIds, visible: a.c.visible } }));
      await call(api.DELETE('/api/seller/sellers/store-profile/collections/{id}', { params: { path: { id: a.c.id } } }));
      return null;
    },
    onSuccess: (c, a) => {
      if (a.kind === 'add' && c) setEditing({ id: c.id, title: c.title });
      if (a.kind !== 'add') setEditing(null);
      void qc.invalidateQueries({ queryKey: ['sellers', 'store-profile', sellerId] });
    },
  });

  const brands = brandsQ.data?.items ?? [];
  const errors: Errors = { ...(attempted && p && saved ? validate(p, saved, evidence.assetIds.length, brands.length > 0) : {}), ...fileErr };
  const nErrors = Object.values(errors).filter(Boolean).length;
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => {
    setP((d) => (d ? { ...d, [k]: v } : d));
    setNotice('');
  };

  const submit = () => {
    if (!p || !saved) return;
    setAttempted(true);
    if (Object.keys(validate(p, saved, evidence.assetIds.length, brands.length > 0)).length || fileErr.logo || fileErr.banner) {
      setNotice('error');
      return;
    }
    save.mutate(p);
  };

  const pendingChanges = (profile?.pendingChanges ?? []).filter((c) => c.state === 'pending');
  const proposed = (c: (typeof pendingChanges)[number]) => (c.proposed ?? {}) as { storeName?: string; tagline?: string; text?: string };
  const pendingName = pendingChanges.find((c) => c.kind === 'store_name');
  const pendingTagline = pendingChanges.find((c) => c.kind === 'tagline');
  const brandClaim = profile ? brandClaimOf(profile) : undefined;
  const pendingBrand = brandClaim?.state === 'pending' ? brandClaim : undefined;
  const pending = pendingChanges
    .map((c) => (c.kind === 'store_name' ? proposed(c).storeName : c.kind === 'tagline' ? proposed(c).tagline : c.kind === 'public_claim' ? proposed(c).text : undefined))
    .filter((x): x is string => !!x);
  const categories = (profile?.categories ?? []) as Category[];
  const paused = categories.filter((c) => c.state === 'paused');
  const collections = [...(profile?.collections ?? [])].sort((a, b) => a.position - b.position);
  const freeReturns = p?.returnShipping === 'seller';
  const windows = Array.from(new Set([terms?.baseline.windowDays ?? 30, 45, 60, p?.returnWindow ?? 30])).sort((a, b) => a - b);
  const baselineDays = terms?.baseline.windowDays ?? 30;
  const logoSrc = logo.url ?? profile?.logo?.url ?? null;
  const bannerSrc = banner.url ?? profile?.banner?.url ?? null;
  const verified = profile?.verification.state === 'verified';
  const busy = save.isPending || logo.uploading || banner.uploading || evidence.uploading;
  const chosenBrand = brands.find((b) => b.id === p?.brandId);

  const logoTile = (
    <span className="logo-tile lg tint-2" aria-hidden="true">
      {logoSrc ? <img src={logoSrc} alt="" style={IMG_FILL} /> : initials(profile?.storeName ?? '')}
    </span>
  );

  const header = (
    <>
      <PageHeader
        title="Store and settings"
        sub="What customers see on your storefront."
        actions={
          <>
            <Button variant="secondary" size="sm" icon="external-link" to={profile ? href('store/seller', undefined, { slug: profile.slug }) : undefined} disabled={!profile}>
              View storefront
            </Button>
            {canManage && (
              <Button size="sm" onClick={submit} disabled={!p || busy}>
                {save.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            )}
          </>
        }
      />
      <div>
        <Tabs items={TABS} active="store" />
      </div>
    </>
  );

  if (profileQ.isError) {
    return (
      <SellerLayout active="store">
        {header}
        <Alert tone="danger" title="We couldn’t load your store profile">
          {errorMessage(profileQ.error)}{' '}
          <Button variant="ghost" size="sm" onClick={() => void profileQ.refetch()}>
            Try again
          </Button>
        </Alert>
      </SellerLayout>
    );
  }

  if (!p || !profile) {
    return (
      <SellerLayout active="store">
        {header}
        <div className="sb-main">
          <div className="stack gap-5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card pad stack gap-2">
                <span className="sk sk-line short" />
                <span className="sk sk-line" />
                <span className="sk sk-line" />
                <span className="sk sk-line short" />
              </div>
            ))}
          </div>
          <div className="stack gap-3">
            <span className="sk h-46" />
            <span className="sk sk-line" />
          </div>
        </div>
      </SellerLayout>
    );
  }

  const saveError = save.error instanceof ApiError && save.error.code === 'VALIDATION_FAILED' ? Object.values(save.error.fieldErrors).join(' ') || save.error.message : errorMessage(save.error);

  return (
    <SellerLayout active="store">
      {header}

      {!canManage && (
        <Alert tone="info" title="View only">
          Ask the store owner for the storefront permission to change these settings.
        </Alert>
      )}
      {notice === 'saved' && (
        <Alert tone="success" title="Changes saved">
          {pending.length ? 'Your other changes are live on your storefront. Reviewed changes stay pending until staff approve them.' : 'Your changes are live on your storefront.'}
        </Alert>
      )}
      {notice === 'error' && save.isError && (
        <Alert tone="danger" title="We couldn’t save everything">
          {saveError}
        </Alert>
      )}
      {notice === 'error' && !save.isError && nErrors > 0 && (
        <Alert tone="danger" title={`Check ${nErrors} field${nErrors > 1 ? 's' : ''}`}>
          Fix the highlighted fields to save your store profile.
        </Alert>
      )}
      {pending.length > 0 && (
        <Alert tone="warning" title={`${pending.length} change${pending.length > 1 ? 's' : ''} waiting for staff review`}>
          Store names, taglines, public claims and brand affiliation are checked by Marketly staff before they go live. Your other changes publish when you save.
        </Alert>
      )}
      {collectionMut.isError && (
        <Alert tone="danger" title="That collection change didn’t work">
          {errorMessage(collectionMut.error)}
        </Alert>
      )}

      <div className="sb-main">
        <div className="stack gap-5">
          <Card title="Identity">
            <div className="sb-form-grid">
              <Field label="Store name" hint={pendingName ? `“${proposed(pendingName).storeName}” is waiting for review.` : 'Changing your store name needs review.'} error={errors.name}>
                <TextInput id="st-name" value={p.name} error={!!errors.name} placeholder="" disabled={!canManage} onChange={(e) => set('name', e.target.value)} />
              </Field>
              <Field label="Location shown" error={errors.location}>
                <TextInput id="st-loc" icon="map-pin" value={p.location} error={!!errors.location} placeholder="" disabled={!canManage} onChange={(e) => set('location', e.target.value)} />
              </Field>
              <div className="stack gap-2">
                <span className="label">Logo</span>
                <div className="row gap-3">
                  {logoTile}
                  <input ref={logoInput} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="Logo image" onChange={logo.pick} />
                  {canManage && (
                    <Button variant="secondary" size="sm" icon="upload" onClick={() => logoInput.current?.click()} disabled={logo.uploading}>
                      {logo.uploading ? 'Uploading…' : 'Replace logo'}
                    </Button>
                  )}
                </div>
                {errors.logo ? <FileError msg={errors.logo} /> : <span className="hint">Square, at least 400 × 400 px</span>}
              </div>
              <div className="stack gap-2">
                <span className="label">Banner</span>
                <Pic src={bannerSrc} icon="audio-lines" className="wide" />
                <span className="row gap-2">
                  <input ref={bannerInput} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="Banner image" onChange={banner.pick} />
                  {canManage && (
                    <Button variant="secondary" size="sm" icon="upload" onClick={() => bannerInput.current?.click()} disabled={banner.uploading}>
                      {banner.uploading ? 'Uploading…' : 'Replace banner'}
                    </Button>
                  )}
                  {errors.banner ? <FileError msg={errors.banner} /> : <span className="hint">2400 × 800 px</span>}
                </span>
              </div>
              <div className="full">
                <Field
                  label="Tagline"
                  optional
                  hint={pendingTagline ? `“${proposed(pendingTagline).tagline}” is waiting for review.` : `${p.tagline.length} of ${TAGLINE_MAX} characters. A new tagline needs review.`}
                  error={errors.tagline}
                >
                  <TextInput id="st-tagline" value={p.tagline} error={!!errors.tagline} placeholder="" disabled={!canManage} onChange={(e) => set('tagline', e.target.value)} />
                </Field>
              </div>
              <div className="full">
                <Field label="Introduction" hint={`${p.intro.length} of ${INTRO_MAX} characters`} error={errors.intro}>
                  <Textarea id="st-intro" placeholder="" className={cx(errors.intro && 'is-error')} value={p.intro} disabled={!canManage} onChange={(e) => set('intro', e.target.value)} />
                </Field>
              </div>
            </div>
          </Card>

          <Card title="Categories and featured collections" titleAs="h3">
            <div className="stack gap-2">
              <span className="label">Categories you sell in</span>
              <div className="hscroll gap-2">
                {categories.length === 0 && <span className="small muted">Categories appear when you have active offers.</span>}
                {categories.map((c) =>
                  c.state === 'paused' ? (
                    <a key={c.categoryId} className="chip" href="#" aria-disabled="true" onClick={(e) => e.preventDefault()}>
                      <Icon name="ban" />
                      {c.name} · paused
                    </a>
                  ) : (
                    <a key={c.categoryId} className="chip is-active" href="#" aria-current="true" onClick={(e) => e.preventDefault()}>
                      {c.name}
                    </a>
                  ),
                )}
              </div>
              <span className="hint">{paused.length ? `${paused.map((c) => `${c.name}: ${c.reason ?? 'new listings paused'}`).join('. ')}. See Account health.` : 'Categories come from your active offers.'}</span>
            </div>
            <ul className="list">
              {collections.map((c, i) => {
                const isEditing = editing?.id === c.id;
                return (
                  <li key={c.id}>
                    <Icon name="grip-vertical" className="ic-sm" />
                    <Img icon="package" tint={TINTS[i % TINTS.length]} src={c.image?.url} className="tiny" />
                    <span className="grow stack gap-0">
                      {isEditing ? (
                        <TextInput
                          id={`st-col-${c.id}`}
                          ctl="sm"
                          aria-label="Collection name"
                          value={editing.title}
                          autoFocus
                          onChange={(e) => setEditing({ id: c.id, title: e.target.value })}
                          onKeyDown={(e) => e.key === 'Enter' && editing.title.trim() && collectionMut.mutate({ kind: 'rename', c, title: editing.title.trim() })}
                        />
                      ) : (
                        <span className="small strong">{c.title}</span>
                      )}
                      <span className="xs muted">
                        {c.offerCount} offer{c.offerCount === 1 ? '' : 's'}
                        {c.visible ? '' : ' · hidden'}
                      </span>
                    </span>
                    {canManage && (
                      <IconButton
                        icon={isEditing ? 'check' : 'pencil'}
                        label={`${isEditing ? 'Done editing' : 'Edit'} ${c.title}`}
                        onClick={() =>
                          isEditing ? (editing.title.trim() && editing.title.trim() !== c.title ? collectionMut.mutate({ kind: 'rename', c, title: editing.title.trim() }) : setEditing(null)) : setEditing({ id: c.id, title: c.title })
                        }
                      />
                    )}
                    {canManage && c.offerCount === 0 && <IconButton icon="trash-2" label={`Remove ${c.title}`} onClick={() => collectionMut.mutate({ kind: 'remove', c })} />}
                  </li>
                );
              })}
            </ul>
            {canManage && (
              <div>
                <Button variant="soft" size="sm" icon="plus" onClick={() => collectionMut.mutate({ kind: 'add' })} disabled={collectionMut.isPending}>
                  Add collection
                </Button>
              </div>
            )}
          </Card>

          <Card title="Store policies" sub="Shown on every offer and before checkout" titleAs="h3">
            {termsQ.isError && (
              <Alert tone="danger" title="We couldn’t load your return terms">
                {errorMessage(termsQ.error)}
              </Alert>
            )}
            <div className="sb-form-grid">
              <Field label="Return window" hint="You can offer more than the baseline, not less.">
                <Select
                  id="st-ret"
                  options={windows.map((d) => ({ value: String(d), label: `${d} days${d === baselineDays ? ' (platform baseline)' : ''}` }))}
                  value={String(p.returnWindow)}
                  disabled={!canTerms || !terms}
                  onChange={(e) => set('returnWindow', Number(e.target.value))}
                />
              </Field>
              <Field label="Return shipping for change of mind">
                <Select id="st-retship" options={RETURN_SHIPPING} value={p.returnShipping} disabled={!canTerms || !terms} onChange={(e) => set('returnShipping', e.target.value as Profile['returnShipping'])} />
              </Field>
              <div className="full">
                <Field label="Warranty" error={errors.warranty}>
                  <Textarea id="st-warr" placeholder="" className={cx(errors.warranty && 'is-error')} value={p.warranty} disabled={!canManage} onChange={(e) => set('warranty', e.target.value)} />
                </Field>
              </div>
            </div>
            <span className="xs muted">Defective, damaged or wrong items: you always pay return shipping (platform rule).</span>
          </Card>

          <Card
            title="Public claims and brand affiliation"
            sub={
              pendingBrand ? (
                <Badge tone="warning" icon="clock">
                  Pending review
                </Badge>
              ) : brandClaim ? (
                <Badge tone="success" icon="badge-check">
                  Approved
                </Badge>
              ) : undefined
            }
            titleAs="h3"
          >
            <Field
              label="Brand affiliation"
              hint={pendingBrand ? `Submitted ${fmtDay(pendingBrand.submittedAt, { weekday: false })}. Not shown until approved.` : 'Saving a brand claim sends it to Marketly staff for review.'}
              error={errors.brand}
            >
              <TextInput id="st-brand" value={p.brand} placeholder="" error={!!errors.brand} disabled={!canManage || !!pendingBrand} onChange={(e) => set('brand', e.target.value)} />
            </Field>
            {canManage && !pendingBrand && p.brand.trim() && p.brand.trim() !== saved?.brand && (
              <div className="sb-form-grid">
                <Field label="Brand">
                  <Select id="st-brand-id" options={[{ value: '', label: 'Choose the brand' }, ...brands.map((b) => ({ value: b.id, label: b.name }))]} value={p.brandId} onChange={(e) => set('brandId', e.target.value)} />
                </Field>
                <div className="stack gap-2">
                  <span className="label">Evidence</span>
                  <input ref={evidenceInput} type="file" hidden multiple accept="application/pdf,image/png,image/jpeg" aria-label="Claim evidence" onChange={(e) => (evidence.add(Array.from(e.target.files ?? [])), (e.target.value = ''))} />
                  <span className="row gap-2">
                    <Button variant="secondary" size="sm" icon="paperclip" onClick={() => evidenceInput.current?.click()}>
                      Attach letter
                    </Button>
                    <span className="hint">{evidence.items.length ? evidence.items.map((f) => `${f.name}${f.status === 'uploading' ? ' (uploading)' : f.status === 'failed' ? ' (failed)' : ''}`).join(', ') : `PDF, JPG or PNG${chosenBrand ? `, e.g. a ${chosenBrand.name} distributor letter` : ''}`}</span>
                  </span>
                  {evidence.error && <FileError msg={evidence.error} />}
                </div>
              </div>
            )}
            <div className="panel stack gap-1">
              <span className="xs strong">
                <Icon name="shield-check" className="ic-sm" /> About your Verified seller label
              </span>
              <span className="xs sub">
                {verified
                  ? `Marketly checked: ${profile.verification.checked.join('; ')}${profile.verification.lastCheckedAt ? ` (${fmtDay(profile.verification.lastCheckedAt, { weekday: false })})` : ''}. ${profile.verification.notChecked.join('. ')}.`
                  : (profile.verification.reason ?? 'Your store doesn’t have the Verified seller label right now.')}
              </span>
            </div>
          </Card>

          <Card title="Contact options" titleAs="h3">
            <div className="stack gap-3">
              <Switch id="st-msg" label="Order messages (always on for buyers with an order)" checked={p.msg} aria-checked={p.msg} disabled={!canManage} onChange={(e) => set('msg', e.target.checked)} />
              <Switch id="st-q" label="Product questions from shoppers" checked={p.questions} aria-checked={p.questions} disabled={!canManage} onChange={(e) => set('questions', e.target.checked)} />
              <Switch id="st-phone" label="Show a phone number for order questions" checked={p.phone} aria-checked={p.phone} disabled={!canManage} onChange={(e) => set('phone', e.target.checked)} />
              <Field label="Reply target shown to customers">
                <Select id="st-target" options={REPLY_TARGETS} value={p.replyTarget} disabled={!canManage} onChange={(e) => set('replyTarget', e.target.value as Profile['replyTarget'])} />
              </Field>
            </div>
          </Card>
        </div>

        <div className="stack gap-3">
          <span className="row between">
            <span className="small strong">Live preview</span>
            <SegmentedControl
              label="Preview device"
              active={device}
              onChange={setDevice}
              items={[
                { label: 'Desktop', value: 'desktop', icon: 'monitor' },
                { label: 'Phone', value: 'phone', icon: 'smartphone' },
              ]}
            />
          </span>
          <div className="sb-prev">
            <Pic src={bannerSrc} icon="audio-lines" className="wide sb-banner" />
            <div className="body">
              <div className="row gap-3 u-items-flex-end">
                {logoTile}
                <div className="stack gap-0" style={{ paddingBottom: '4px' }}>
                  <span className="h3">{profile.storeName}</span>
                  <span className="row gap-2">
                    {verified && (
                      <Badge tone="info" icon="shield-check">
                        Verified seller
                      </Badge>
                    )}
                    {p.location && (
                      <span className="xs muted">
                        <Icon name="map-pin" className="ic-sm" /> {p.location}
                      </span>
                    )}
                  </span>
                </div>
              </div>
              {profile.tagline && <span className="small strong">{profile.tagline}</span>}
              <p className="small sub">{p.intro}</p>
              {pending.map((label) => (
                <span key={label} className="sb-pending row gap-2" style={{ alignSelf: 'flex-start', padding: '2px 6px' }}>
                  <Badge tone="outline" icon="badge-check">
                    {label}
                  </Badge>
                  <span className="xs muted">Shown after approval</span>
                </span>
              ))}
              {collections.filter((c) => c.visible).length > 0 && (
                <div className="stack gap-2">
                  <span className="xs strong">Featured</span>
                  <div className="grid c2 gap-2" style={device === 'desktop' ? { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' } : undefined}>
                    {collections
                      .filter((c) => c.visible)
                      .map((c, i) => (
                        <div key={c.id} className="stack gap-1">
                          <Img icon="package" tint={TINTS[i % TINTS.length]} src={c.image?.url} className="r43" />
                          <span className="xs strong">{c.title}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
              <div className="panel xs sub">
                {p.returnWindow}-day returns · {freeReturns ? 'free return shipping' : 'free return shipping on defective items'}
                {p.warranty.trim() ? ` · ${p.warranty.trim()}` : ''}
              </div>
              <Button variant="secondary" size="sm" block icon="message-square">
                Message the seller
              </Button>
            </div>
          </div>
          <span className="xs muted">Dashed outline: waiting for staff review.</span>
        </div>
      </div>
    </SellerLayout>
  );
}
