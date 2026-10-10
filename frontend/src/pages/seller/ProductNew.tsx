import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import {
  Alert, Badge, Button, Card, Checkbox, Chip, Field, FileDrop, Icon, Img, KeyValue, Meter, PageHeader, Select, StatusLegend, Switch, TableWrap, Textarea, TextInput, Timeline, announce, type IconName,
} from '@/ui';

// Design: pages/seller/seller-product-new.html (a draft with missing fields) · view "changes-requested"
// = the same submission returned by the Catalog team with 3 marked fields.

type View = 'changes-requested';

interface Variation {
  color: string;
  sku: string;
  price: string;
  qty: string;
  gtin: string;
}
interface Photo {
  id: string;
  icon: IconName;
  tint: string;
  src?: string;
  /** Flagged by the reviewer (text overlay). */
  flagged?: boolean;
}
interface Accessory {
  id: string;
  label: string;
  checked: boolean;
}

const ORIGINAL_FREQ = '15 Hz – 28 kHz';

const SPEC_FIELDS = [
  { key: 'type', label: 'Headphone type', id: 'pn-type', options: ['Over-ear, closed-back', 'Over-ear, open-back', 'On-ear'] },
  { key: 'conn', label: 'Connectivity', id: 'pn-conn', options: ['Wired', 'Bluetooth', 'Wired and Bluetooth'] },
  { key: 'driver', label: 'Driver size', id: 'pn-driver' },
  { key: 'imp', label: 'Impedance', id: 'pn-imp' },
  { key: 'freq', label: 'Frequency response', id: 'pn-freq' },
  { key: 'cable', label: 'Cable', id: 'pn-cable' },
  { key: 'weight', label: 'Weight', id: 'pn-weight', placeholder: 'e.g. 285 g', error: 'Add the weight without cables.' },
  { key: 'mic', label: 'Microphone', id: 'pn-mic', options: ['Select', 'No microphone', 'Inline microphone', 'Boom microphone'], error: 'Choose an option.' },
  { key: 'anc', label: 'Noise cancellation', id: 'pn-anc', options: ['None (passive isolation)', 'Active (ANC)'] },
] as const;
type SpecKey = (typeof SPEC_FIELDS)[number]['key'];

function initialState(cr: boolean) {
  return {
    brand: 'Ferro',
    model: 'HD-60',
    name: 'Ferro HD-60 Studio Monitor Headphones',
    desc: 'Closed-back studio monitor headphones tuned for accurate mixing and tracking. 40 mm drivers, detachable cables and memory-foam ear pads for long sessions.',
    features: ['Closed-back design isolates sound for tracking', '40 mm neodymium drivers, 32 Ω, easy to drive from laptops', 'Detachable 3 m coiled and 1.2 m straight cables', 'Swivel ear cups fold flat for travel', ''],
    specs: { type: 'Over-ear, closed-back', conn: 'Wired', driver: '40 mm', imp: '32 Ω', freq: ORIGINAL_FREQ, cable: 'Detachable, 3.5 mm', weight: cr ? '285 g' : '', mic: cr ? 'No microphone' : 'Select', anc: 'None (passive isolation)' } as Record<SpecKey, string>,
    hasVariations: true,
    variations: [
      { color: 'Black', sku: 'NWA-FER-HD60-BLK', price: '129.00', qty: '12', gtin: '0 75213 66001 8' },
      { color: 'White', sku: 'NWA-FER-HD60-WHT', price: cr ? '129.00' : '', qty: '8', gtin: '0 75213 66002 5' },
    ] as Variation[],
    photos: (cr
      ? [
          { id: 'p1', icon: 'headphones', tint: '4', flagged: true },
          { id: 'p2', icon: 'headphones', tint: '1' },
          { id: 'p3', icon: 'package-open', tint: '3' },
          { id: 'p4', icon: 'cable', tint: '6' },
        ]
      : [
          { id: 'p1', icon: 'headphones', tint: '4' },
          { id: 'p2', icon: 'headphones', tint: '1' },
        ]) as Photo[],
    gtin: cr ? '0 75213 66001 8' : '',
    noGtin: false,
    mpn: 'FER-HD60-01',
    accessories: [
      { id: 'pn-acc1', label: '3 m coiled cable, 3.5 mm', checked: true },
      { id: 'pn-acc2', label: '1.2 m straight cable, 3.5 mm', checked: true },
      { id: 'pn-acc3', label: '6.35 mm (1/4 in) screw-on adapter', checked: true },
      { id: 'pn-acc4', label: 'Carry pouch', checked: false },
    ] as Accessory[],
  };
}
type Form = ReturnType<typeof initialState>;

const gtinOk = (g: string) => /^\d{12,13}$/.test(g.replace(/\s/g, ''));

interface Item {
  state: 'ok' | 'warn' | 'miss';
  text: ReactNode;
}
const ITEM_ICON: Record<Item['state'], IconName> = { ok: 'circle-check', warn: 'circle-dashed', miss: 'circle-alert' };
const ITEM_SR: Record<Item['state'], string> = { ok: 'Done: ', warn: 'Incomplete: ', miss: 'Missing: ' };

export default function ProductNew() {
  const [view] = useView<View>();
  const cr = view === 'changes-requested';
  return <ProductForm key={cr ? 'cr' : 'draft'} cr={cr} />;
}

function ProductForm({ cr }: { cr: boolean }) {
  const [f, setF] = useState<Form>(() => initialState(cr));
  const [newAcc, setNewAcc] = useState('');
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState(cr ? 'Oct 8, 9:58 AM by Avery Stone' : 'Oct 8, 10:42 AM by Avery Stone');
  const [submitted, setSubmitted] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((s) => ({ ...s, [k]: v }));
  const setSpec = (k: SpecKey, v: string) => setF((s) => ({ ...s, specs: { ...s.specs, [k]: v } }));
  const setVar = (i: number, k: keyof Variation, v: string) => setF((s) => ({ ...s, variations: s.variations.map((x, j) => (j === i ? { ...x, [k]: v } : x)) }));

  // ---- validation (live: the design shows the open problems straight away) ----
  const specMissing = SPEC_FIELDS.filter((s) => {
    const v = f.specs[s.key].trim();
    return !v || v === 'Select';
  });
  const specError = (k: SpecKey) => {
    const def = SPEC_FIELDS.find((s) => s.key === k)!;
    if (specMissing.includes(def)) return 'error' in def ? def.error : 'Required.';
    if (cr && k === 'freq' && f.specs.freq.trim() === ORIGINAL_FREQ) return 'Manufacturer lists 10 Hz – 30 kHz. Update the value or attach the spec sheet.';
    return undefined;
  };
  const priceMissing = f.hasVariations ? f.variations.map((v, i) => ({ v, i })).filter(({ v }) => !(Number(v.price) > 0)) : [];
  const basicsOk = !!(f.brand && f.name.trim() && f.desc.trim());
  const flaggedPhoto = f.photos.some((p) => p.flagged);
  const photoCountOk = f.photos.length >= 3;
  const gtinError = f.noGtin ? undefined : !f.gtin.trim() ? 'Enter the barcode number, or confirm the product has none.' : !gtinOk(f.gtin) ? 'A GTIN/UPC has 12 or 13 digits.' : undefined;
  const freqFlag = cr && f.specs.freq.trim() === ORIGINAL_FREQ;
  const pouch = f.accessories.find((a) => a.id === 'pn-acc4');
  const pouchFlag = cr && !!pouch && !pouch.checked;

  const specItem: Item | null = specMissing.length
    ? { state: 'warn', text: <a href={`#${specMissing[0].id}`}>Specifications: {SPEC_FIELDS.length - specMissing.length} of {SPEC_FIELDS.length} required (add {specMissing.map((s) => s.label).join(' and ')})</a> }
    : null;
  const varItems: Item[] = priceMissing.map(({ v, i }) => ({ state: 'miss', text: <a href={`#pn-vp${i}`}>Variation {v.color} has no price</a> }));
  const photoItem: Item | null = photoCountOk ? null : { state: 'miss', text: <a href="#pn-images">Images: {f.photos.length} of 3 required</a> };
  const gtinItem: Item | null = gtinError ? { state: 'miss', text: <a href="#pn-gtin">GTIN/UPC missing, or confirm the product has none</a> } : null;
  const nVar = f.variations.length;

  const items: Item[] = cr
    ? [
        { state: basicsOk ? 'ok' : 'miss', text: 'Category and basic details' },
        ...(specItem ? [specItem] : []),
        ...(flaggedPhoto ? [{ state: 'miss' as const, text: 'Main image has a text overlay. Replace image 1.' }] : []),
        ...(photoItem ? [photoItem] : []),
        ...(freqFlag ? [{ state: 'miss' as const, text: 'Frequency response does not match the manufacturer spec.' }] : []),
        ...(pouchFlag ? [{ state: 'miss' as const, text: 'Carry pouch shown in photos but not listed in the box.' }] : []),
        ...(varItems.length ? varItems : [{ state: 'ok' as const, text: `Variations: ${nVar} of ${nVar} complete` }]),
        gtinItem ?? { state: 'ok', text: 'Identifiers: GTIN and model number' },
      ]
    : [
        { state: 'ok', text: 'Category: Over-ear headphones' },
        { state: basicsOk ? 'ok' : 'miss', text: basicsOk ? 'Brand, name and description' : <a href="#pn-name">Add the brand, name and description</a> },
        specItem ?? { state: 'ok', text: `Specifications: ${SPEC_FIELDS.length} of ${SPEC_FIELDS.length} required` },
        ...(varItems.length ? varItems : [{ state: 'ok' as const, text: `Variations: ${nVar} of ${nVar} complete` }]),
        photoItem ?? { state: 'ok', text: `Images: ${f.photos.length} added` },
        gtinItem ?? { state: 'ok', text: 'Identifiers: GTIN and model number' },
        { state: 'ok', text: 'Included accessories' },
      ];
  const issues = items.filter((i) => i.state !== 'ok').length;
  // Completion: each open item costs a share of the bar (draft 9 points, returned submission 6).
  const pct = Math.max(0, 100 - issues * (cr ? 6 : 9));

  const status = submitted ? 'Submitted' : cr ? 'Changes requested' : 'Draft';
  const statusTone = submitted ? 'info' : cr ? 'warning' : '';

  const addFiles = (files: File[]) => {
    const imgs = files.filter((x) => /^image\//.test(x.type));
    if (!imgs.length) return;
    setF((s) => {
      const added: Photo[] = imgs.map((file, i) => ({ id: `u${Date.now()}${i}`, icon: 'image', tint: 'surface-3', src: URL.createObjectURL(file) }));
      // A returned submission's flagged main image is replaced by the first new photo.
      const idx = s.photos.findIndex((p) => p.flagged);
      if (idx >= 0) {
        const photos = [...s.photos];
        photos[idx] = added.shift()!;
        return { ...s, photos: [...photos, ...added] };
      }
      return { ...s, photos: [...s.photos, ...added] };
    });
    announce(`${imgs.length} image${imgs.length > 1 ? 's' : ''} added`);
  };
  const addAccessory = () => {
    const label = newAcc.trim();
    if (!label) return;
    set('accessories', [...f.accessories, { id: `pn-acc${f.accessories.length + 1}`, label, checked: true }]);
    setNewAcc('');
  };
  const saveDraft = () => {
    const t = '10:46 AM'; // mock session clock
    setSaved(`Oct 8, ${t} by Avery Stone`);
    announce('Draft saved');
  };
  const submit = () => {
    if (issues) return;
    setSubmitted(true);
    announce(cr ? 'Resubmitted for review' : 'Submitted for review');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const specField = (s: (typeof SPEC_FIELDS)[number]) => {
    const err = specError(s.key);
    const control =
      'options' in s ? (
        <Select id={s.id} options={[...s.options]} value={f.specs[s.key]} className={cx(err && 'is-error')} onChange={(e) => setSpec(s.key, e.target.value)} />
      ) : (
        <TextInput id={s.id} value={f.specs[s.key]} placeholder={'placeholder' in s ? s.placeholder : ''} error={!!err} onChange={(e) => setSpec(s.key, e.target.value)} />
      );
    const field = (
      <Field key={s.key} label={s.label} error={err}>
        {control}
      </Field>
    );
    return cr && s.key === 'freq' ? (
      <div className="sa-hl" key={s.key}>
        {field}
      </div>
    ) : (
      field
    );
  };

  return (
    <SellerLayout active="products">
      <PageHeader
        crumbs={[{ label: 'Products and offers', to: href('seller/products') }, { label: cr ? 'Fix submission' : 'Create a new product' }]}
        title={cr ? 'Ferro HD-60 Studio Monitor Headphones' : 'New product'}
        sub={cr ? 'Submission SUB-20417 · fix the marked fields and resubmit' : 'Not in the catalog yet. Complete every section; you can save a draft at any time.'}
        actions={<Badge tone={statusTone}>{status}</Badge>}
      />
      {submitted && (
        <Alert tone="success" title={cr ? 'Resubmitted for review' : 'Submitted for review'}>
          The Catalog team usually reviews new products within 2 business days. We'll notify you when it's approved or if anything needs changing. <Link to={href('seller/products')}>Back to products</Link>
        </Alert>
      )}
      {cr && !submitted && (
        <div className="alert t-warning" role="alert">
          <Icon name="message-square-warning" />
          <div className="stack gap-2 grow">
            <span className="alert-title">Changes requested by the Catalog team</span>
            <span>Omar Haddad, Catalog Manager · Oct 6, 2026, 2:18 PM PT</span>
            <span>
              <b>Reason:</b> Inaccurate details and image standards not met. Fix the 3 fields marked below, then resubmit. Other sellers will rely on this shared product content.
            </span>
            <ol className="ol small">
              <li>Image 1: remove the "Studio grade" text overlay. Main images must show only the product on a plain background.</li>
              <li>Frequency response: manufacturer lists 10 Hz – 30 kHz.</li>
              <li>Included accessories: photo 3 shows a carry pouch that is not listed.</li>
            </ol>
          </div>
        </div>
      )}
      <div className="sa-split">
        <div className="stack gap-5">
          <Card title="Category" sub="Sets the specifications this product needs">
            <div className="row between">
              <span className="row gap-2">
                <Icon name="folder-tree" className="ic-sm" />
                <nav className="crumbs" aria-label="Breadcrumb">
                  <span>Electronics</span>
                  <Icon name="chevron-right" />
                  <span>Headphones</span>
                  <Icon name="chevron-right" />
                  <span>Over-ear and on-ear</span>
                </nav>
              </span>
              <Button variant="ghost" size="sm" onClick={() => announce('Changing the category resets the specifications. Contact seller support to move a submitted product.')}>
                Change category
              </Button>
            </div>
          </Card>

          <Card title="Basic details" titleAs="h3">
            <div className="grid md2">
              <Field label="Brand" hint="Missing a brand? Request it and we review it with the product.">
                <Select id="pn-brand" options={['Ferro', 'Halden', 'Kestrel', 'Lumen', 'Brand not listed']} value={f.brand} onChange={(e) => set('brand', e.target.value)} />
              </Field>
              <Field label="Model number">
                <TextInput id="pn-model" value={f.model} onChange={(e) => set('model', e.target.value)} />
              </Field>
            </div>
            <Field label="Product name" hint={`Brand + model + product type. No prices, promotions or seller names. ${f.name.length} of 150 characters.`} error={!f.name.trim() ? 'Enter the product name.' : undefined}>
              <TextInput id="pn-name" value={f.name} maxLength={150} error={!f.name.trim()} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Description" hint="Describe the product, not your offer. Shipping and return terms go in your offer." error={!f.desc.trim() ? 'Describe the product.' : undefined}>
              <Textarea id="pn-desc" value={f.desc} onChange={(e) => set('desc', e.target.value)} />
            </Field>
            <div className="field">
              <span className="label">Key features</span>
              <div className="stack gap-2">
                {f.features.map((v, i) => (
                  <div className="sa-feat" key={i}>
                    <span className="xs muted num u-w-16px">{i + 1}</span>
                    <label className="sr-only" htmlFor={`pn-f${i}`}>
                      Key feature {i + 1}
                    </label>
                    <input
                      className="input"
                      id={`pn-f${i}`}
                      type="text"
                      value={v}
                      placeholder="Add a feature (optional)"
                      aria-describedby={i === 0 ? 'pn-f0-hint' : undefined}
                      onChange={(e) => set('features', f.features.map((x, j) => (j === i ? e.target.value : x)))}
                    />
                  </div>
                ))}
              </div>
              <span className="hint" id="pn-f0-hint">
                Up to 5 short facts customers can scan.
              </span>
            </div>
          </Card>

          <Card title="Specifications" titleAs="h3" sub="Required for Over-ear and on-ear headphones">
            <div className="grid md2">{SPEC_FIELDS.map(specField)}</div>
          </Card>

          <Card
            title="Variations"
            titleAs="h3"
            sub="Each variation gets its own SKU, price and stock for your offer"
            actions={<Switch id="pn-hasvar" label="Has variations" checked={f.hasVariations} aria-checked={f.hasVariations} onChange={(e) => set('hasVariations', e.target.checked)} />}
          >
            {f.hasVariations ? (
              <>
                <div className="row gap-2">
                  <span className="small strong">Varies by</span>
                  <div className="hscroll gap-2">
                    <Chip active>Color</Chip>
                    <Chip icon="plus" onClick={() => announce('Size and capacity attributes are not used in this category')}>
                      Add attribute
                    </Chip>
                  </div>
                </div>
                <div className="card">
                  <TableWrap label="Variations table">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Color</th>
                          <th scope="col">Seller SKU</th>
                          <th scope="col">Price</th>
                          <th scope="col">Quantity</th>
                          <th className="col-pin" scope="col">
                            GTIN / UPC
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {f.variations.map((v, i) => {
                          const bad = priceMissing.some((p) => p.i === i);
                          return (
                            <tr key={v.color} className={bad ? 'is-flagged' : ''}>
                              <td>
                                {bad && <span className="sr-only">Urgent: </span>}
                                <span className="small strong">{v.color}</span>
                              </td>
                              <td>
                                <label className="sr-only" htmlFor={`pn-vs${i}`}>
                                  SKU for {v.color}
                                </label>
                                <input className="input sa-sku" id={`pn-vs${i}`} value={v.sku} onChange={(e) => setVar(i, 'sku', e.target.value)} />
                              </td>
                              <td>
                                <label className="sr-only" htmlFor={`pn-vp${i}`}>
                                  Price for {v.color}
                                </label>
                                <input
                                  className={cx('input sa-num', bad && 'is-error')}
                                  id={`pn-vp${i}`}
                                  value={v.price}
                                  inputMode="decimal"
                                  placeholder={bad ? 'Price' : '0.00'}
                                  aria-invalid={bad || undefined}
                                  aria-describedby={bad ? `pn-vp${i}-err` : undefined}
                                  onChange={(e) => setVar(i, 'price', e.target.value)}
                                />
                                {bad && (
                                  <div className="error-text" id={`pn-vp${i}-err`}>
                                    Add a price
                                  </div>
                                )}
                              </td>
                              <td>
                                <label className="sr-only" htmlFor={`pn-vq${i}`}>
                                  Quantity for {v.color}
                                </label>
                                <input className="input sa-num" id={`pn-vq${i}`} value={v.qty} inputMode="numeric" onChange={(e) => setVar(i, 'qty', e.target.value)} />
                              </td>
                              <td className="col-pin">
                                <span className="mono xs nowrap" title={v.gtin}>
                                  {v.gtin}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </TableWrap>
                  {priceMissing.length > 0 && <StatusLegend items={[{ tone: 'danger', label: 'Red edge = urgent: overdue or past target' }]} />}
                </div>
                <p className="xs muted row gap-1 nowrap top">
                  <Icon name="info" className="ic-sm" />
                  <span className="wrap">Customers pick a color on one product page. Your price and quantity are your offer; other sellers set their own.</span>
                </p>
              </>
            ) : (
              <p className="small sub">This product is sold in one version. Your price and quantity are set on your offer.</p>
            )}
          </Card>

          <Card id="pn-images" title="Images" titleAs="h3" sub="At least 3 · first image is the main image">
            <div className={cx(cr && 'sa-hl', 'stack gap-2')}>
              <div className="sa-thumbs">
                {f.photos.map((p, i) => (
                  <div className={cx('sa-thumb', p.flagged && 'is-error')} key={p.id}>
                    <Img icon={p.icon} tint={p.tint} src={p.src} alt={p.src ? `Product image ${i + 1}` : ''} />
                    {i === 0 && <Badge tone={p.flagged ? 'danger' : 'solid'}>Main</Badge>}
                  </div>
                ))}
              </div>
              {flaggedPhoto ? (
                <span className="error-text">
                  <Icon name="circle-alert" className="ic-sm" />
                  Image 1 has a text overlay. Replace it with a clean product photo.
                </span>
              ) : (
                !photoCountOk && (
                  <span className="error-text">
                    <Icon name="circle-alert" className="ic-sm" />
                    Add at least {3 - f.photos.length} more image{3 - f.photos.length > 1 ? 's' : ''}.
                  </span>
                )
              )}
            </div>
            <FileDrop title="Drag images here or browse" hint="JPG or PNG · at least 1600 px on the longest side · up to 10 MB each" onFiles={addFiles} />
            <div className="well stack gap-2">
              <span className="small strong">Image standards</span>
              <ul className="ul small sub stack gap-1">
                <li>Main image: product only, plain white or light gray background, fills 85% of the frame.</li>
                <li>No text, logos, watermarks, borders or prices.</li>
                <li>Show every included accessory in at least one image.</li>
                <li>Use your own photos or ones you have rights to.</li>
              </ul>
            </div>
          </Card>

          <Card title="Identifiers" titleAs="h3">
            <div className="grid md2">
              <Field label="GTIN / UPC" error={gtinError} hint={!gtinError && !f.noGtin ? 'Matches the barcode on the retail box.' : undefined}>
                <TextInput id="pn-gtin" value={f.gtin} placeholder="12 or 13 digits" inputMode="numeric" error={!!gtinError} disabled={f.noGtin} onChange={(e) => set('gtin', e.target.value)} />
              </Field>
              <Field label="Manufacturer part number" optional>
                <TextInput id="pn-mpn" value={f.mpn} onChange={(e) => set('mpn', e.target.value)} />
              </Field>
            </div>
            <Checkbox id="pn-nogtin" label="This product has no GTIN (custom-made or private label). We may ask for proof." checked={f.noGtin} onChange={(e) => set('noGtin', e.target.checked)} />
          </Card>

          <Card title="Included accessories" titleAs="h3" sub="Everything in a new, sealed box">
            <div className={cx(cr && 'sa-hl', 'stack gap-2')}>
              {f.accessories.map((a) => (
                <Checkbox
                  key={a.id}
                  id={a.id}
                  label={a.label}
                  checked={a.checked}
                  aria-describedby={pouchFlag && a.id === 'pn-acc1' ? 'pn-acc1-err' : undefined}
                  onChange={(e) => set('accessories', f.accessories.map((x) => (x.id === a.id ? { ...x, checked: e.target.checked } : x)))}
                />
              ))}
              {pouchFlag && (
                <span className="error-text" id="pn-acc1-err">
                  <Icon name="circle-alert" className="ic-sm" />
                  Photo 3 shows a carry pouch. Tick it if it ships in the box, or remove the photo.
                </span>
              )}
            </div>
            <div className="row gap-2">
              <label className="sr-only" htmlFor="pn-accn">
                Add accessory
              </label>
              <span className="grow">
                <input className="input" id="pn-accn" type="text" value={newAcc} placeholder="Add another item in the box" onChange={(e) => setNewAcc(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addAccessory())} />
              </span>
              <Button variant="secondary" onClick={addAccessory}>
                Add
              </Button>
            </div>
          </Card>
        </div>

        <aside className="stack gap-5 sa-sticky">
          <section className="card">
            <div className="card-head">
              <div className="stack gap-0">
                <h3 className="h4">Ready to submit?</h3>
                <span className="xs muted">{pct}% complete</span>
              </div>
            </div>
            <div className="card-body">
              <Meter pct={pct} tone={cr && issues ? 'warning' : undefined} label="Ready to submit?" />
              {cr && issues > 0 && <span className="xs strong meter-note t-warning-text">Near target</span>}
              <ul className="sa-checklist">
                {items.map((it, i) => (
                  <li key={i} className={it.state}>
                    <span className="sr-only">{ITEM_SR[it.state]}</span>
                    <Icon name={ITEM_ICON[it.state]} />
                    <span>{it.text}</span>
                  </li>
                ))}
              </ul>
              <div className="divider" />
              <KeyValue
                pairs={[
                  ['Status', <Badge tone={statusTone}>{status}</Badge>],
                  ['Last saved', saved],
                  ['Review time', 'Usually 2 business days'],
                ]}
              />
              {cr && (
                <Field label="Note to the reviewer" optional>
                  <Textarea id="pn-note" placeholder="Explain what you changed" value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
              )}
            </div>
            <div className="card-foot">
              {!cr && issues > 0 && (
                <p className="small t-danger-text strong card-foot-note" id="pn-block">
                  Fix {issues} item{issues > 1 ? 's' : ''} to submit. Your draft is kept for 90 days.
                </p>
              )}
              <Button variant="secondary" onClick={saveDraft} disabled={submitted}>
                Save draft
              </Button>
              <Button className={cx(issues > 0 && 'is-disabled')} disabled={issues > 0 || submitted} aria-describedby={issues ? 'pn-block' : undefined} onClick={submit}>
                {cr ? 'Resubmit for review' : 'Submit for review'}
              </Button>
            </div>
          </section>
          {cr && issues > 0 && (
            <p className="xs muted" id="pn-block">
              Fix the {issues} marked item{issues > 1 ? 's' : ''} to resubmit.
            </p>
          )}
          {cr ? (
            <Card title="Review history" titleAs="h3">
              <Timeline
                events={[
                  ...(submitted ? [{ t: 'Resubmitted for review', d: 'Oct 8 · Avery Stone', state: 'current' as const }] : []),
                  { t: <><span className="sr-only">At risk: </span>Changes requested</>, d: 'Oct 6, 2:18 PM · Omar Haddad, Catalog', state: 'warn', body: 'Image standards and inaccurate details. 3 fields.' },
                  { t: 'Submitted for review', d: 'Oct 3, 2:40 PM · Avery Stone', state: 'done' },
                  { t: 'Draft created', d: 'Oct 2, 4:05 PM · Avery Stone', state: 'done' },
                ]}
              />
            </Card>
          ) : (
            <Card title="Before you submit" titleAs="h3">
              <p className="small sub">
                Searched the catalog and found no match for <b>Ferro HD-60</b>. If a duplicate is found during review, your offer is attached to the existing product instead.
              </p>
              <Link className="small strong" to={href('seller/catalog-match')}>
                Search the catalog again
              </Link>
            </Card>
          )}
        </aside>
      </div>
    </SellerLayout>
  );
}
