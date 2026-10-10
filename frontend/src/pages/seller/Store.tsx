import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { SellerLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { href } from '@/routes/href';
import { Alert, Badge, Button, Card, Field, Icon, IconButton, Img, PageHeader, SegmentedControl, Select, Stars, Switch, Tabs, Textarea, TextInput, type IconName } from '@/ui';

// Design: pages/seller/seller-store.html (no views).

interface Category {
  name: string;
  active: boolean;
  paused?: boolean;
}

interface Collection {
  id: string;
  name: string;
  offers: number;
  icon: IconName;
  tint: string;
}

interface Profile {
  name: string;
  location: string;
  intro: string;
  returnWindow: string;
  returnShipping: string;
  warranty: string;
  brand: string;
  msg: boolean;
  questions: boolean;
  phone: boolean;
  replyTarget: string;
}

const SAVED: Profile = {
  name: 'Northwind Audio',
  location: 'Portland, OR',
  intro: 'Independent audio shop in Portland since 2014. We test every speaker and headphone before it ships and answer messages 7 days a week.',
  returnWindow: '30 days (platform baseline)',
  returnShipping: 'Customer pays',
  warranty: '1-year Northwind warranty on top of the manufacturer warranty. We repair or replace faulty items.',
  brand: 'Authorized Halden retailer',
  msg: true,
  questions: true,
  phone: false,
  replyTarget: 'Within 24 hours',
};

const CATEGORIES: Category[] = [
  { name: 'Headphones', active: true },
  { name: 'Speakers', active: true },
  { name: 'Accessories', active: true },
  { name: 'Cameras', active: false, paused: true },
];

const COLLECTIONS: Collection[] = [
  { id: 'c1', name: 'Portable speakers', offers: 6, icon: 'speaker', tint: '2' },
  { id: 'c2', name: 'Noise-cancelling picks', offers: 3, icon: 'headphones', tint: '6' },
];

// The design's "Notifications" tab links to the staff page (notification preferences live there).
const TABS = [
  { label: 'Store profile', value: 'store', to: href('seller/store') },
  { label: 'Staff and permissions', value: 'staff', to: href('seller/staff') },
  { label: 'Notifications', value: 'notifications', to: href('seller/staff') },
  { label: 'Shipping', value: 'shipping', to: href('seller/shipping') },
];

const RETURN_WINDOWS = ['30 days (platform baseline)', '45 days', '60 days'];
const RETURN_SHIPPING = ['Customer pays', 'You pay (free returns)'];
const REPLY_TARGETS = ['Within 24 hours', 'Within 12 hours'];
const INTRO_MAX = 400;
const IMG_MAX_MB = 10;
const IMG_FILL: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' };

type Errors = Partial<Record<'name' | 'location' | 'intro' | 'warranty' | 'logo' | 'banner', string>>;

function validate(p: Profile): Errors {
  const e: Errors = {};
  if (!p.name.trim()) e.name = 'Enter a store name.';
  else if (p.name.trim().length < 3) e.name = 'Store names need at least 3 characters.';
  if (!p.location.trim()) e.location = 'Enter the city and state customers see.';
  if (!p.intro.trim()) e.intro = 'Write a short introduction for your storefront.';
  else if (p.intro.length > INTRO_MAX) e.intro = `Shorten the introduction to ${INTRO_MAX} characters or fewer.`;
  if (!p.warranty.trim()) e.warranty = 'Describe your warranty, or write "Manufacturer warranty only".';
  return e;
}

/** Picked image as an object URL for the preview; rejects non-images and files over 10 MB. */
function useImagePick(onError: (msg: string) => void) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return onError('Choose a JPG, PNG or WebP image.');
    if (f.size > IMG_MAX_MB * 1024 * 1024) return onError(`Images can be up to ${IMG_MAX_MB} MB.`);
    onError('');
    setUrl(URL.createObjectURL(f));
  };
  return [url, pick] as const;
}

/** .imgph tile that shows the picked image when there is one. */
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

export default function Store() {
  const [saved, setSaved] = useState<Profile>(SAVED);
  const [p, setP] = useState<Profile>(SAVED);
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<'' | 'saved' | 'error'>('');
  const [cats, setCats] = useState(CATEGORIES);
  const [collections, setCollections] = useState(COLLECTIONS);
  const [editing, setEditing] = useState<string | null>(null);
  const [device, setDevice] = useState<'desktop' | 'phone'>('phone');
  // Waiting for staff review: the brand claim is already submitted; a store name change joins it on save.
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [pendingBrand, setPendingBrand] = useState<string | null>(SAVED.brand);
  const [fileErr, setFileErr] = useState<Pick<Errors, 'logo' | 'banner'>>({});
  const [logo, pickLogo] = useImagePick((m) => setFileErr((f) => ({ ...f, logo: m || undefined })));
  const [banner, pickBanner] = useImagePick((m) => setFileErr((f) => ({ ...f, banner: m || undefined })));
  const logoInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);

  const errors: Errors = { ...(attempted ? validate(p) : {}), ...fileErr };
  const nErrors = Object.values(errors).filter(Boolean).length;
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => {
    setP((d) => ({ ...d, [k]: v }));
    setNotice('');
  };

  const save = () => {
    setAttempted(true);
    if (Object.keys(validate(p)).length || fileErr.logo || fileErr.banner) {
      setNotice('error');
      return;
    }
    const name = p.name.trim();
    const brand = p.brand.trim();
    if (name !== saved.name) setPendingName(name);
    if (brand !== (pendingBrand ?? saved.brand)) setPendingBrand(brand || null);
    // Reviewed fields keep their live value until staff approve them.
    setSaved({ ...p, name: saved.name, brand: saved.brand });
    setNotice('saved');
  };

  const pending = [pendingName, pendingBrand].filter((x): x is string => !!x);
  const days = p.returnWindow.split(' ')[0];
  const freeReturns = p.returnShipping.startsWith('You pay');

  const addCollection = () => {
    const id = `c${Date.now()}`;
    setCollections((l) => [...l, { id, name: `New collection ${l.length + 1}`, offers: 0, icon: 'package', tint: String(((l.length + 2) % 6) + 1) }]);
    setEditing(id);
  };
  const renameCollection = (id: string, name: string) => setCollections((l) => l.map((c) => (c.id === id ? { ...c, name } : c)));
  const removeCollection = (id: string) => setCollections((l) => l.filter((c) => c.id !== id));
  const toggleCat = (name: string) => setCats((l) => l.map((x) => (x.name === name ? { ...x, active: !x.active } : x)));

  const logoTile = (
    <span className="logo-tile lg tint-2" aria-hidden="true">
      {logo ? <img src={logo} alt="" style={IMG_FILL} /> : 'NA'}
    </span>
  );

  return (
    <SellerLayout active="store">
      <PageHeader
        title="Store and settings"
        sub="What customers see on your storefront."
        actions={
          <>
            <Button variant="secondary" size="sm" icon="external-link" to={href('store/seller')}>
              View storefront
            </Button>
            <Button size="sm" onClick={save}>
              Save changes
            </Button>
          </>
        }
      />
      <div>
        <Tabs items={TABS} active="store" />
      </div>

      {notice === 'saved' && (
        <Alert tone="success" title="Changes saved">
          {pending.length ? 'Your other changes are live on your storefront. Reviewed changes stay pending until staff approve them.' : 'Your changes are live on your storefront.'}
        </Alert>
      )}
      {notice === 'error' && nErrors > 0 && (
        <Alert tone="danger" title={`Check ${nErrors} field${nErrors > 1 ? 's' : ''}`}>
          Fix the highlighted fields to save your store profile.
        </Alert>
      )}
      {pending.length > 0 && (
        <Alert tone="warning" title={`${pending.length} change${pending.length > 1 ? 's' : ''} waiting for staff review`}>
          Changes to public claims or brand affiliation are checked by Marketly staff before they go live (example: within 2 business days). Your other changes publish when you save.
        </Alert>
      )}

      <div className="sb-main">
        <div className="stack gap-5">
          <Card title="Identity">
            <div className="sb-form-grid">
              <Field label="Store name" hint={pendingName ? `“${pendingName}” is waiting for review.` : 'Changing your store name needs review.'} error={errors.name}>
                <TextInput id="st-name" value={p.name} error={!!errors.name} placeholder="" onChange={(e) => set('name', e.target.value)} />
              </Field>
              <Field label="Location shown" error={errors.location}>
                <TextInput id="st-loc" icon="map-pin" value={p.location} error={!!errors.location} placeholder="" onChange={(e) => set('location', e.target.value)} />
              </Field>
              <div className="stack gap-2">
                <span className="label">Logo</span>
                <div className="row gap-3">
                  {logoTile}
                  <input ref={logoInput} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="Logo image" onChange={pickLogo} />
                  <Button variant="secondary" size="sm" icon="upload" onClick={() => logoInput.current?.click()}>
                    Replace logo
                  </Button>
                </div>
                {errors.logo ? <FileError msg={errors.logo} /> : <span className="hint">Square, at least 400 × 400 px</span>}
              </div>
              <div className="stack gap-2">
                <span className="label">Banner</span>
                <Pic src={banner} icon="audio-lines" className="wide" />
                <span className="row gap-2">
                  <input ref={bannerInput} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="Banner image" onChange={pickBanner} />
                  <Button variant="secondary" size="sm" icon="upload" onClick={() => bannerInput.current?.click()}>
                    Replace banner
                  </Button>
                  {errors.banner ? <FileError msg={errors.banner} /> : <span className="hint">2400 × 800 px</span>}
                </span>
              </div>
              <div className="full">
                <Field label="Introduction" hint={`${p.intro.length} of ${INTRO_MAX} characters`} error={errors.intro}>
                  <Textarea id="st-intro" placeholder="" className={cx(errors.intro && 'is-error')} value={p.intro} onChange={(e) => set('intro', e.target.value)} />
                </Field>
              </div>
            </div>
          </Card>

          <Card title="Categories and featured collections" titleAs="h3">
            <div className="stack gap-2">
              <span className="label">Categories you sell in</span>
              <div className="hscroll gap-2">
                {cats.map((c) =>
                  c.paused ? (
                    <a key={c.name} className="chip" href="#" aria-disabled="true" onClick={(e) => e.preventDefault()}>
                      <Icon name="ban" />
                      {c.name} · paused
                    </a>
                  ) : (
                    <a
                      key={c.name}
                      className={cx('chip', c.active && 'is-active')}
                      href="#"
                      aria-current={c.active ? 'true' : undefined}
                      onClick={(e) => {
                        e.preventDefault();
                        toggleCat(c.name);
                      }}
                    >
                      {c.name}
                    </a>
                  ),
                )}
              </div>
              <span className="hint">Cameras: new listings paused. See Account health.</span>
            </div>
            <ul className="list">
              {collections.map((c) => (
                <li key={c.id}>
                  <Icon name="grip-vertical" className="ic-sm" />
                  <Img icon={c.icon} tint={c.tint} className="tiny" />
                  <span className="grow stack gap-0">
                    {editing === c.id ? (
                      <TextInput
                        id={`st-col-${c.id}`}
                        ctl="sm"
                        aria-label="Collection name"
                        value={c.name}
                        autoFocus
                        onChange={(e) => renameCollection(c.id, e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && setEditing(null)}
                      />
                    ) : (
                      <span className="small strong">{c.name}</span>
                    )}
                    <span className="xs muted">
                      {c.offers} offer{c.offers === 1 ? '' : 's'}
                    </span>
                  </span>
                  <IconButton icon={editing === c.id ? 'check' : 'pencil'} label={`${editing === c.id ? 'Done editing' : 'Edit'} ${c.name}`} onClick={() => setEditing(editing === c.id ? null : c.id)} />
                  {c.offers === 0 && <IconButton icon="trash-2" label={`Remove ${c.name}`} onClick={() => removeCollection(c.id)} />}
                </li>
              ))}
            </ul>
            <div>
              <Button variant="soft" size="sm" icon="plus" onClick={addCollection}>
                Add collection
              </Button>
            </div>
          </Card>

          <Card title="Store policies" sub="Shown on every offer and before checkout" titleAs="h3">
            <div className="sb-form-grid">
              <Field label="Return window" hint="You can offer more than the baseline, not less.">
                <Select id="st-ret" options={RETURN_WINDOWS} value={p.returnWindow} onChange={(e) => set('returnWindow', e.target.value)} />
              </Field>
              <Field label="Return shipping for change of mind">
                <Select id="st-retship" options={RETURN_SHIPPING} value={p.returnShipping} onChange={(e) => set('returnShipping', e.target.value)} />
              </Field>
              <div className="full">
                <Field label="Warranty" error={errors.warranty}>
                  <Textarea id="st-warr" placeholder="" className={cx(errors.warranty && 'is-error')} value={p.warranty} onChange={(e) => set('warranty', e.target.value)} />
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
              ) : undefined
            }
            titleAs="h3"
          >
            <Field label="Brand affiliation" hint={pendingBrand ? 'Submitted Oct 7 with a Halden distributor letter. Not shown until approved.' : 'Saving a brand claim sends it to Marketly staff for review.'}>
              <TextInput id="st-brand" value={p.brand} placeholder="" onChange={(e) => set('brand', e.target.value)} />
            </Field>
            <div className="panel stack gap-1">
              <span className="xs strong">
                <Icon name="shield-check" className="ic-sm" /> About your Verified seller label
              </span>
              <span className="xs sub">Marketly checked your business registration and the owner’s identity in July 2026. The label does not certify product authenticity beyond that check.</span>
            </div>
          </Card>

          <Card title="Contact options" titleAs="h3">
            <div className="stack gap-3">
              <Switch id="st-msg" label="Order messages (always on for buyers with an order)" checked={p.msg} aria-checked={p.msg} onChange={(e) => set('msg', e.target.checked)} />
              <Switch id="st-q" label="Product questions from shoppers" checked={p.questions} aria-checked={p.questions} onChange={(e) => set('questions', e.target.checked)} />
              <Switch id="st-phone" label="Show a phone number for order questions" checked={p.phone} aria-checked={p.phone} onChange={(e) => set('phone', e.target.checked)} />
              <Field label="Reply target shown to customers">
                <Select id="st-target" options={REPLY_TARGETS} value={p.replyTarget} onChange={(e) => set('replyTarget', e.target.value)} />
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
            <Pic src={banner} icon="audio-lines" className="wide sb-banner" />
            <div className="body">
              <div className="row gap-3 u-items-flex-end">
                {logoTile}
                <div className="stack gap-0" style={{ paddingBottom: '4px' }}>
                  <span className="h3">{saved.name}</span>
                  <span className="row gap-2">
                    <Badge tone="info" icon="shield-check">
                      Verified seller
                    </Badge>
                    <span className="xs muted">
                      <Icon name="map-pin" className="ic-sm" /> {p.location}
                    </span>
                  </span>
                </div>
              </div>
              <span className="row gap-2 xs sub">
                <Stars rating={4.9} />
                <span>98% positive · 4,812 ratings · ships in 1 business day</span>
              </span>
              <p className="small sub">{p.intro}</p>
              {pending.map((label) => (
                <span key={label} className="sb-pending row gap-2" style={{ alignSelf: 'flex-start', padding: '2px 6px' }}>
                  <Badge tone="outline" icon="badge-check">
                    {label}
                  </Badge>
                  <span className="xs muted">Shown after approval</span>
                </span>
              ))}
              {collections.length > 0 && (
                <div className="stack gap-2">
                  <span className="xs strong">Featured</span>
                  <div className="grid c2 gap-2" style={device === 'desktop' ? { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' } : undefined}>
                    {collections.map((c) => (
                      <div key={c.id} className="stack gap-1">
                        <Img icon={c.icon} tint={c.tint} className="r43" />
                        <span className="xs strong">{c.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="panel xs sub">
                {days}-day returns · {freeReturns ? 'free return shipping' : 'free return shipping on defective items'} · 1-year Northwind warranty on top of the manufacturer’s
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
