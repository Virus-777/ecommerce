import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError, call, errorMessage, uploadMedia, useApi, type components } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import {
  Alert, Badge, Button, Card, Checkbox, Chip, EmptyState, Field, FileDrop, Icon, IconButton, Img, KeyValue, Meter, PageHeader, Select, StatusLegend, Switch, TableWrap, Textarea, TextInput, Timeline, announce, type IconName, type TimelineEvent,
} from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { FormSkeleton, LoadError, fmtDay, fmtFull, fmtWhen, inputAmount, reviewLabel, toMinor } from './data/catalog-parts';
import { CATEGORIES, SELLER_PRODUCT, flattenCategories, offerHref, productHref, type CategoryAttribute, type CategoryNode, type SellerProduct } from './data/products';

// Design: pages/seller/seller-product-new.html (a draft with missing fields) · view "changes-requested" = the
// submission returned by the Catalog team with marked fields (shown when the product's review state is
// changes requested; the review feedback comes from the review log). URL: ?id=<productId> edits one of the
// seller's own products; without it the first save creates the draft.
// Data: GraphQL myProduct (content, submission, review log, own offers) and the category tree;
// GET catalog/brands; GET catalog/categories/{id}/attributes (attributes and image standards);
// GET shipping/profiles (default profile for the variation offers). Writes: POST/PATCH catalog/products,
// POST catalog/products/{id}/submit, media uploads (product_image), and per variation with a SKU and price
// a draft offer that publishes on approval (POST offers/offers, PATCH offers/offers/{id}).

type View = 'changes-requested';
type ProductAdmin = components['schemas']['catalog.ProductAdmin'];
type ImageRule = components['schemas']['catalog.ImageRule'];

const NEW_BRAND = '__new';
const MIN_DESCRIPTION = 40; // catalog setting minDescriptionLength (seller-visible; no seller settings read in this app)
const MAX_FEATURES = 5;

interface VarRow {
  key: string;
  value: string;
  sku: string;
  price: string;
  qty: string;
  gtin: string;
  variantId?: string;
  offerId?: string;
  /** Saved offer values, to send only what changed. */
  saved?: { sku: string; price: number };
  error?: string;
}
interface Photo {
  key: string;
  assetId?: string;
  url?: string;
  name?: string;
  status: 'ready' | 'uploading' | 'failed';
  error?: string;
}
interface Accessory {
  id: string;
  label: string;
  checked: boolean;
}
interface Form {
  categoryId: string;
  brand: string;
  requestedBrand: string;
  model: string;
  name: string;
  desc: string;
  features: string[];
  specs: Array<{ name: string; value: string }>;
  hasVariations: boolean;
  varAttr: string;
  variations: VarRow[];
  photos: Photo[];
  gtin: string;
  noGtin: boolean;
  mpn: string;
  accessories: Accessory[];
}

let seq = 0;
const key = () => `k${++seq}`;
const gtinOk = (g: string) => /^\d{8}$|^\d{12,14}$/.test(g.replace(/\s/g, ''));
const pad = (list: string[], n: number) => [...list, ...Array(Math.max(0, n - list.length)).fill('')].slice(0, Math.max(n, list.length));

function initialForm(p: SellerProduct | null | undefined): Form {
  if (!p) {
    return {
      categoryId: '',
      brand: '',
      requestedBrand: '',
      model: '',
      name: '',
      desc: '',
      features: pad([], MAX_FEATURES),
      specs: [],
      hasVariations: false,
      varAttr: 'Color',
      variations: [{ key: key(), value: '', sku: '', price: '', qty: '', gtin: '' }],
      photos: [],
      gtin: '',
      noGtin: false,
      mpn: '',
      accessories: [],
    };
  }
  const withOptions = p.variants.filter((v) => v.options.length);
  const hasVariations = withOptions.length > 0;
  const varAttr = withOptions[0]?.options[0]?.name ?? p.category?.attributes.find((a) => a.variantDefining)?.name ?? 'Color';
  const rows: VarRow[] = hasVariations
    ? p.variants.map((v) => {
        const offer = p.myOffers.find((o) => o.variant.id === v.id && o.condition === 'NEW') ?? p.myOffers.find((o) => o.variant.id === v.id);
        return {
          key: key(),
          value: v.options.find((o) => o.name === varAttr)?.value ?? v.options[0]?.value ?? '',
          sku: offer?.sellerSku ?? '',
          price: offer ? inputAmount(offer.price) : '',
          qty: offer?.stock ? String(offer.stock.quantities.available) : '',
          gtin: v.gtin ?? '',
          variantId: v.id,
          offerId: offer?.id,
          saved: offer ? { sku: offer.sellerSku ?? '', price: offer.price.amount } : undefined,
        };
      })
    : [{ key: key(), value: '', sku: '', price: '', qty: '', gtin: '' }];
  return {
    categoryId: p.category?.id ?? '',
    brand: p.brand?.id ?? (p.requestedBrandName ? NEW_BRAND : ''),
    requestedBrand: p.requestedBrandName ?? '',
    model: p.modelNumber ?? '',
    name: p.title,
    desc: p.description,
    features: pad(p.keyFeatures, MAX_FEATURES),
    specs: p.specs.map((s) => ({ ...s })),
    hasVariations,
    varAttr,
    variations: rows,
    photos: p.images.map((i) => ({ key: key(), assetId: i.id, url: i.url, status: 'ready' as const })),
    gtin: hasVariations ? '' : (p.variants[0]?.gtin ?? ''),
    noGtin: !!p.noGtin,
    mpn: p.manufacturerPartNumber ?? '',
    accessories: p.includedItems.map((label, i) => ({ id: `pn-acc${i + 1}`, label, checked: true })),
  };
}

interface Item {
  state: 'ok' | 'warn' | 'miss';
  text: ReactNode;
}
const ITEM_ICON: Record<Item['state'], IconName> = { ok: 'circle-check', warn: 'circle-dashed', miss: 'circle-alert' };
const ITEM_SR: Record<Item['state'], string> = { ok: 'Done: ', warn: 'Incomplete: ', miss: 'Missing: ' };
const LOG_LABEL: Record<string, string> = {
  submitted: 'Submitted for review',
  approved: 'Approved',
  changes_requested: 'Changes requested',
  rejected: 'Rejected',
  publication_changed: 'Publication changed',
  merged: 'Merged into another product',
  check_dismissed: 'Check dismissed',
  correction_accepted: 'Correction accepted',
  variant_details_changed: 'Variant details changed',
};

export default function ProductNew() {
  const { api, gql } = useApi();
  const { sellerId } = useSellerSession();
  const [params] = useSearchParams();
  const id = params.get('id') ?? '';
  const [version, setVersion] = useState(0);

  const product = useQuery({
    queryKey: ['catalog', 'seller-product', sellerId, id],
    queryFn: async () => (await gql<{ myProduct: SellerProduct | null }>(SELLER_PRODUCT, { id })).data?.myProduct ?? null,
    enabled: !!id,
  });
  const categories = useQuery({
    queryKey: ['catalog', 'categories', 'seller'],
    queryFn: async () => (await gql<{ categories: CategoryNode[] }>(CATEGORIES)).data?.categories ?? [],
    staleTime: 10 * 60_000,
  });
  const brands = useQuery({
    queryKey: ['catalog', 'brands', 'seller'],
    queryFn: () => call(api.GET('/api/seller/catalog/brands', { params: { query: { limit: 100 } } })),
    staleTime: 10 * 60_000,
  });
  const profiles = useQuery({ queryKey: ['shipping', 'profiles', sellerId], queryFn: () => call(api.GET('/api/seller/shipping/profiles')) });

  const failed = [product, categories, brands].find((q) => q.isError);
  const loading = (!!id && product.data === undefined) || !categories.data || !brands.data;
  let body: ReactNode;
  if (failed) body = <LoadError error={failed.error} onRetry={() => void failed.refetch()} />;
  else if (loading) body = <FormSkeleton cards={4} />;
  else if (id && (!product.data || product.data.submittedByMe === false))
    body = (
      <section className="card">
        <EmptyState
          icon="search-x"
          as="h2"
          title={product.data ? 'You didn’t submit this product' : 'Product not found'}
          action={product.data ? <Button to={href('seller/offer', '', undefined, { product: id })}>Create an offer on it</Button> : <Button to={href('seller/products')}>Back to products and offers</Button>}
        >
          {product.data ? 'Its content is managed by the seller or team that submitted it. You can still sell it with your own offer.' : 'This product isn’t one of your submissions, or it was merged into another product.'}
        </EmptyState>
      </section>
    );
  else
    return (
      <ProductForm
        key={`${id}|${version}`}
        product={product.data ?? null}
        tree={categories.data!}
        brands={brands.data!.items}
        defaultProfileId={(profiles.data?.find((p) => p.isDefault && p.status !== 'archived') ?? profiles.data?.find((p) => p.status !== 'archived'))?.id}
        onSaved={async () => {
          await product.refetch();
          setVersion((v) => v + 1);
        }}
      />
    );

  return (
    <SellerLayout active="products">
      <PageHeader crumbs={[{ label: 'Products and offers', to: href('seller/products') }, { label: id ? 'Product submission' : 'Create a new product' }]} title={id ? 'Product submission' : 'New product'} sub="Complete every section; you can save a draft at any time." />
      {body}
    </SellerLayout>
  );
}

function ProductForm({
  product,
  tree,
  brands,
  defaultProfileId,
  onSaved,
}: {
  product: SellerProduct | null;
  tree: CategoryNode[];
  brands: Array<components['schemas']['catalog.Brand']>;
  defaultProfileId?: string;
  onSaved: () => Promise<void>;
}) {
  const { api, session } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useSellerSession();
  const [view, setView] = useView<View>();
  const [f, setF] = useState<Form>(() => initialForm(product));
  const [newAcc, setNewAcc] = useState('');
  const [note, setNote] = useState('');
  const [picking, setPicking] = useState(!product?.category);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger' | 'warning'; title: string; text: ReactNode } | null>(null);
  const fileSeq = useRef(0);

  const state = product?.reviewState ?? 'DRAFT';
  const cr = state === 'CHANGES_REQUESTED';
  const editable = state === 'DRAFT' || cr;
  const canSubmit = can('catalog.products.submit');
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((s) => ({ ...s, [k]: v }));
  const setVar = (i: number, k: keyof VarRow, v: string) => setF((s) => ({ ...s, variations: s.variations.map((x, j) => (j === i ? { ...x, [k]: v, error: undefined } : x)) }));

  // The URL view follows the data: a product with changes requested shows the returned-submission view.
  const wantView = cr ? 'changes-requested' : '';
  useEffect(() => {
    if (product && view !== wantView) setView(wantView, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantView]);

  const cats = useMemo(() => flattenCategories(tree), [tree]);
  const cat = cats.find((c) => c.id === f.categoryId);
  const attrsQ = useQuery({
    queryKey: ['catalog', 'category-attributes', f.categoryId],
    queryFn: () => call(api.GET('/api/seller/catalog/categories/{id}/attributes', { params: { path: { id: f.categoryId } } })),
    enabled: !!f.categoryId,
    staleTime: 10 * 60_000,
  });
  const attributes: CategoryAttribute[] = (attrsQ.data?.attributes ?? []).map((a) => ({ ...a, unit: a.unit ?? null, kind: a.kind.toUpperCase() as CategoryAttribute['kind'] }));
  const imageRules: ImageRule[] = attrsQ.data?.imageRules ?? [];
  const minImages = Math.max(1, ...imageRules.map((r) => Number((r.check as { minCount?: number } | null)?.minCount ?? 1)));
  const specAttrs = attributes.filter((a) => !a.variantDefining || a.name !== f.varAttr);
  const variantAttr = attributes.find((a) => a.variantDefining);

  // ---- review feedback (latest changes-requested entry) ----
  const log = product?.reviewLog ?? [];
  const lastCr = cr ? [...log].reverse().find((l) => l.action === 'changes_requested') : undefined;
  const comments = new Map((lastCr?.fields ?? []).map((x) => [x.name.toLowerCase(), x.value]));
  const comment = (...keys: string[]) => keys.map((k) => comments.get(k.toLowerCase())).find(Boolean);
  const specComment = (name: string) => comment(`specs.${name}`, name);

  // ---- validation (live, like the design) ----
  const specValue = (name: string) => f.specs.find((s) => s.name === name)?.value ?? '';
  const setSpec = (name: string, value: string) =>
    setF((s) => ({ ...s, specs: s.specs.some((x) => x.name === name) ? s.specs.map((x) => (x.name === name ? { ...x, value } : x)) : [...s.specs, { name, value }] }));
  const rows = f.hasVariations ? f.variations.filter((v) => v.value.trim()) : [];
  const required = attributes.filter((a) => a.required);
  const filled = (a: CategoryAttribute) => (a.variantDefining && f.hasVariations && a.name === f.varAttr ? rows.length > 0 : !!specValue(a.name).trim() && specValue(a.name) !== 'Select');
  const specMissing = required.filter((a) => !filled(a));
  const priceMissing = f.variations.map((v, i) => ({ v, i })).filter(({ v }) => f.hasVariations && v.value.trim() && !toMinor(v.price));
  const brandOk = f.brand === NEW_BRAND ? !!f.requestedBrand.trim() : !!f.brand;
  const descOk = f.desc.trim().length >= MIN_DESCRIPTION;
  const basicsOk = !!(brandOk && f.name.trim() && descOk);
  const readyPhotos = f.photos.filter((p) => p.status === 'ready');
  const photoCountOk = readyPhotos.length >= minImages;
  const gtins = f.hasVariations ? rows.map((r) => r.gtin) : [f.gtin];
  const gtinError = f.noGtin
    ? undefined
    : gtins.some((g) => !g.trim())
      ? f.hasVariations
        ? 'Add the barcode number for every variation, or confirm the product has none.'
        : 'Enter the barcode number, or confirm the product has none.'
      : gtins.some((g) => !gtinOk(g))
        ? 'A GTIN/UPC has 8, 12, 13 or 14 digits.'
        : undefined;
  const photoComment = comment('images', 'imageIds');
  const boxComment = comment('includedItems');

  const specItem: Item | null = specMissing.length
    ? { state: 'warn', text: <a href="#pn-specs">Specifications: {required.length - specMissing.length} of {required.length} required (add {specMissing.map((s) => s.name).join(' and ')})</a> }
    : null;
  const varItems: Item[] = priceMissing.map(({ v, i }) => ({ state: 'miss', text: <a href={`#pn-vp${i}`}>Variation {v.value} has no price</a> }));
  const photoItem: Item | null = photoCountOk ? null : { state: 'miss', text: <a href="#pn-images">Images: {readyPhotos.length} of {minImages} required</a> };
  const gtinItem: Item | null = gtinError ? { state: 'miss', text: <a href="#pn-gtin">GTIN/UPC missing, or confirm the product has none</a> } : null;
  const nVar = rows.length;
  const commentItems: Item[] = lastCr ? lastCr.fields.map((x) => ({ state: 'miss' as const, text: `${x.name}: ${x.value}` })) : [];

  const items: Item[] = [
    f.categoryId ? { state: 'ok', text: `Category: ${cat?.name ?? product?.category?.name ?? ''}` } : { state: 'miss', text: <a href="#pn-cat">Choose a category</a> },
    { state: basicsOk ? 'ok' : 'miss', text: basicsOk ? 'Brand, name and description' : <a href="#pn-name">{!descOk && f.desc.trim() ? `Description needs at least ${MIN_DESCRIPTION} characters` : 'Add the brand, name and description'}</a> },
    specItem ?? { state: 'ok', text: required.length ? `Specifications: ${required.length} of ${required.length} required` : 'Specifications' },
    ...(varItems.length ? varItems : [{ state: 'ok' as const, text: f.hasVariations ? `Variations: ${nVar} of ${nVar} complete` : 'One version' }]),
    photoItem ?? { state: 'ok', text: `Images: ${readyPhotos.length} added` },
    gtinItem ?? { state: 'ok', text: f.noGtin ? 'Identifiers: no GTIN (confirmed)' : 'Identifiers: GTIN and model number' },
    { state: f.accessories.some((a) => a.checked) ? 'ok' : 'warn', text: f.accessories.some((a) => a.checked) ? 'Included accessories' : <a href="#pn-accn">List what is in the box</a> },
    ...(cr ? commentItems : []),
  ];
  const blocking = items.filter((i) => i.state !== 'ok' && !(cr && commentItems.includes(i))).length;
  const issues = items.filter((i) => i.state !== 'ok').length;
  const pct = Math.max(0, 100 - issues * (cr ? 6 : 9));
  const uploading = f.photos.some((p) => p.status === 'uploading');

  const status = reviewLabel(state);
  const statusTone = state === 'SUBMITTED' ? 'info' : cr ? 'warning' : state === 'APPROVED' ? 'success' : state === 'REJECTED' ? 'danger' : '';

  const addFiles = (files: File[]) => {
    const imgs = files.filter((x) => /^image\//.test(x.type));
    if (!imgs.length) return;
    const added: Photo[] = imgs.map((file) => ({ key: `u${++fileSeq.current}`, name: file.name, url: URL.createObjectURL(file), status: 'uploading' }));
    setF((s) => ({ ...s, photos: [...s.photos, ...added] }));
    announce(`${imgs.length} image${imgs.length > 1 ? 's' : ''} uploading`);
    added.forEach((a, i) =>
      uploadMedia(session, imgs[i], 'product_image').then(
        (asset) => setF((s) => ({ ...s, photos: s.photos.map((p) => (p.key === a.key ? { ...p, status: 'ready', assetId: asset.id, url: asset.renditions?.find((r) => r.size === 'small')?.url ?? asset.url ?? p.url } : p)) })),
        (e) => setF((s) => ({ ...s, photos: s.photos.map((p) => (p.key === a.key ? { ...p, status: 'failed', error: errorMessage(e) } : p)) })),
      ),
    );
  };
  const removePhoto = (k: string) => setF((s) => ({ ...s, photos: s.photos.filter((p) => p.key !== k) }));
  const makeMain = (k: string) => setF((s) => ({ ...s, photos: [...s.photos.filter((p) => p.key === k), ...s.photos.filter((p) => p.key !== k)] }));
  const addAccessory = () => {
    const label = newAcc.trim();
    if (!label) return;
    set('accessories', [...f.accessories, { id: `pn-acc${f.accessories.length + 1}-${key()}`, label, checked: true }]);
    setNewAcc('');
  };

  /** ProductInput from the form. */
  const input = () => {
    const variants = f.hasVariations
      ? rows.map((r) => ({ options: { [f.varAttr]: r.value.trim() }, gtin: r.gtin.replace(/\s/g, '') || null }))
      : [{ options: {}, gtin: f.gtin.replace(/\s/g, '') || null }];
    return {
      title: f.name.trim(),
      ...(f.brand === NEW_BRAND ? { requestedBrand: { name: f.requestedBrand.trim() } } : f.brand ? { brandId: f.brand } : {}),
      categoryId: f.categoryId || null,
      description: f.desc,
      keyFeatures: f.features.map((x) => x.trim()).filter(Boolean),
      specs: Object.fromEntries(f.specs.filter((s) => s.name.trim() && s.value.trim() && s.value !== 'Select').map((s) => [s.name.trim(), s.value.trim()])),
      includedItems: f.accessories.filter((a) => a.checked).map((a) => a.label),
      imageIds: readyPhotos.map((p) => p.assetId!),
      modelNumber: f.model.trim() || null,
      manufacturerPartNumber: f.mpn.trim() || null,
      noGtin: f.noGtin,
      variants,
    };
  };

  /** Draft offers (publish on approval) for variations with a SKU and price; existing ones get the new SKU/price. */
  const syncOffers = async (saved: ProductAdmin): Promise<string[]> => {
    if (!f.hasVariations || !can('offers.offers.manage')) return [];
    const problems: string[] = [];
    const rowErrors: Record<string, string> = {};
    for (const r of rows) {
      const price = toMinor(r.price);
      if (!price || !r.sku.trim()) continue;
      const variant = saved.product.variants.find((v) => v.options[f.varAttr] === r.value.trim());
      if (!variant) continue;
      try {
        if (r.offerId) {
          const body = { ...(r.saved?.price !== price ? { price: { amount: price, currency: 'USD' } } : {}), ...(r.saved?.sku !== r.sku.trim() ? { sellerSku: r.sku.trim() } : {}) };
          if (Object.keys(body).length) await call(api.PATCH('/api/seller/offers/offers/{id}', { params: { path: { id: r.offerId } }, body }));
        } else {
          if (!defaultProfileId) throw new ApiError(400, 'SHIPPING_PROFILE_INVALID', 'Add a shipping profile in Shipping settings first.');
          await call(
            api.POST('/api/seller/offers/offers', {
              body: {
                productId: saved.product.id,
                variantId: variant.id,
                condition: 'new',
                price: { amount: price, currency: 'USD' },
                sellerSku: r.sku.trim(),
                quantity: Number.isInteger(Number(r.qty)) && Number(r.qty) > 0 ? Number(r.qty) : 0,
                dispatchBusinessDays: 1,
                shippingProfileId: defaultProfileId,
                returnTerms: { kind: 'baseline' },
                warranty: { kind: 'manufacturer' },
                publish: false,
                publishOnApproval: true,
              },
            }),
          );
        }
      } catch (e) {
        rowErrors[r.key] = errorMessage(e);
        problems.push(`${r.value}: ${errorMessage(e)}`);
      }
    }
    if (problems.length) setF((s) => ({ ...s, variations: s.variations.map((v) => (rowErrors[v.key] ? { ...v, error: rowErrors[v.key] } : v)) }));
    return problems;
  };

  const save = useMutation({
    mutationFn: async ({ submit }: { submit: boolean }) => {
      const body = input();
      let saved = product
        ? await call(api.PATCH('/api/seller/catalog/products/{id}', { params: { path: { id: product.id } }, body }))
        : await call(api.POST('/api/seller/catalog/products', { body }));
      const offerProblems = await syncOffers(saved);
      if (submit) saved = await call(api.POST('/api/seller/catalog/products/{id}/submit', { params: { path: { id: saved.product.id } }, body: { note: note.trim() || null } }));
      return { saved, offerProblems };
    },
    onSuccess: async ({ saved, offerProblems }, { submit }) => {
      setErrors({});
      void qc.invalidateQueries({ queryKey: ['offers'] });
      void qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
      const msg = submit ? (cr ? 'Resubmitted for review' : 'Submitted for review') : 'Draft saved';
      announce(msg);
      setBanner(
        offerProblems.length
          ? { tone: 'warning', title: `${msg}, but some offers weren’t saved`, text: offerProblems.join(' ') }
          : submit
            ? { tone: 'success', title: msg, text: <>The Catalog team usually reviews new products within 2 business days. We'll notify you when it's approved or if anything needs changing. <Link to={href('seller/products')}>Back to products</Link></> }
            : { tone: 'success', title: msg, text: saved.missing.length ? `Still missing before you can submit: ${saved.missing.join(', ')}.` : 'Everything needed for review is filled in.' },
      );
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (!product) navigate(productHref(saved.product.id), { replace: true });
      else await onSaved();
    },
    onError: (e) => {
      const fe = e instanceof ApiError ? e.fieldErrors : {};
      setErrors(fe);
      setBanner({ tone: 'danger', title: 'We couldn’t save the product', text: e instanceof ApiError && e.code === 'BRAND_NOT_ACTIVE' ? 'This brand is under review or blocked. Choose another brand or request it.' : `${errorMessage(e)}${Object.keys(fe).length ? ` ${Object.values(fe).join(' ')}` : ''}` });
      announce('The product wasn’t saved');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
  });

  const fieldErr = (...keys: string[]) => keys.map((k) => errors[k]).find(Boolean);
  const attrField = (a: CategoryAttribute) => {
    const v = specValue(a.name);
    const err = (a.required && !filled(a) ? 'Required.' : undefined) ?? specComment(a.name) ?? fieldErr(`specs.${a.name}`);
    const id = `pn-at-${a.id}`;
    const control =
      a.kind === 'ENUM' || a.kind === 'BOOL' ? (
        <Select id={id} options={['Select', ...(a.kind === 'BOOL' ? ['Yes', 'No'] : a.options)]} value={v || 'Select'} className={cx(err && 'is-error')} onChange={(e) => setSpec(a.name, e.target.value)} />
      ) : (
        <TextInput id={id} value={v} suffix={a.unit ?? undefined} inputMode={a.kind === 'NUMBER' ? 'decimal' : undefined} error={!!err} onChange={(e) => setSpec(a.name, e.target.value)} />
      );
    const field = (
      <Field key={a.id} label={a.name} optional={!a.required} error={err}>
        {control}
      </Field>
    );
    return specComment(a.name) ? (
      <div className="sa-hl" key={a.id}>
        {field}
      </div>
    ) : (
      field
    );
  };
  const otherSpecs = f.specs.map((s, i) => ({ s, i })).filter(({ s }) => !attributes.some((a) => a.name === s.name));

  const crumbs = cat?.path ?? product?.categoryPath ?? [];
  const firstRow = f.variations[0];
  const timeline: TimelineEvent[] = [...log]
    .reverse()
    .map((l, i) => ({
      t: l.action === 'changes_requested' ? <><span className="sr-only">At risk: </span>Changes requested</> : (LOG_LABEL[l.action] ?? l.action),
      d: `${fmtWhen(l.at)}${l.actor.name ? ` · ${l.actor.name}` : ''}`,
      state: l.action === 'changes_requested' || l.action === 'rejected' ? 'warn' : i === 0 && l.action === 'submitted' ? 'current' : 'done',
      body: l.reason ?? undefined,
    }));

  return (
    <SellerLayout active="products">
      <PageHeader
        crumbs={[{ label: 'Products and offers', to: href('seller/products') }, { label: cr ? 'Fix submission' : product ? 'Product submission' : 'Create a new product' }]}
        title={product ? product.title || 'Untitled product' : 'New product'}
        sub={
          cr
            ? `Submission ${product?.submission?.ref ?? product?.ref ?? ''} · fix the marked fields and resubmit`
            : state === 'SUBMITTED'
              ? `Submission ${product?.submission?.ref ?? ''} · waiting for the Catalog team`
              : product && state !== 'DRAFT'
                ? `${product.ref} · ${status}`
                : 'Not in the catalog yet. Complete every section; you can save a draft at any time.'
        }
        actions={<Badge tone={statusTone}>{status}</Badge>}
      />
      {banner && (
        <Alert tone={banner.tone} title={banner.title}>
          {banner.text}
        </Alert>
      )}
      {state === 'SUBMITTED' && !banner && (
        <Alert tone="info" title="Submitted for review">
          {product?.submission?.expectedReviewBy ? `The Catalog team expects to review it by ${fmtDay(product.submission.expectedReviewBy)}.` : 'The Catalog team usually reviews new products within 2 business days.'} You can’t edit it while it’s in review.
        </Alert>
      )}
      {state === 'APPROVED' && (
        <Alert tone="success" title="Approved and in the catalog">
          Changes to shared content now go through a correction reviewed by the Catalog team.{' '}
          {product?.myOffers[0] ? <Link to={offerHref(product.myOffers[0].id)}>Manage your offer</Link> : <Link to={href('seller/offer', '', undefined, { product: product!.id })}>Create your offer</Link>}
        </Alert>
      )}
      {state === 'REJECTED' && (
        <Alert tone="danger" title="Rejected by the Catalog team">
          {[...log].reverse().find((l) => l.action === 'rejected')?.reason ?? 'This product can’t be listed.'}
        </Alert>
      )}
      {cr && lastCr && (
        <div className="alert t-warning" role="alert">
          <Icon name="message-square-warning" />
          <div className="stack gap-2 grow">
            <span className="alert-title">Changes requested by the Catalog team</span>
            <span>
              {lastCr.actor.name ?? 'Catalog team'} · {fmtFull(lastCr.at)}
            </span>
            {lastCr.reason && (
              <span>
                <b>Reason:</b> {lastCr.reason}
              </span>
            )}
            {lastCr.fields.length > 0 && (
              <ol className="ol small">
                {lastCr.fields.map((x) => (
                  <li key={x.name}>
                    {x.name}: {x.value}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
      <div className="sa-split">
        <div className="stack gap-5">
          <Card title="Category" sub="Sets the specifications this product needs" id="pn-cat">
            <div className="row between">
              <span className="row gap-2">
                <Icon name="folder-tree" className="ic-sm" />
                {crumbs.length ? (
                  <nav className="crumbs" aria-label="Breadcrumb">
                    {crumbs.map((c, i) => (
                      <Fragment key={c}>
                        {i > 0 && <Icon name="chevron-right" />}
                        <span>{c}</span>
                      </Fragment>
                    ))}
                  </nav>
                ) : (
                  <span className="small sub">No category chosen yet</span>
                )}
              </span>
              {editable && (
                <Button variant="ghost" size="sm" onClick={() => setPicking((p) => !p)}>
                  {f.categoryId ? 'Change category' : 'Choose category'}
                </Button>
              )}
            </div>
            {editable && picking && (
              <Field label="Category" hint="Changing the category changes the specifications it needs." error={fieldErr('categoryId') ?? comment('category', 'categoryId')}>
                <Select
                  id="pn-category"
                  options={[{ value: '', label: 'Choose a category' }, ...cats.map((c) => ({ value: c.id, label: c.path.join(' › ') }))]}
                  value={f.categoryId}
                  onChange={(e) => {
                    set('categoryId', e.target.value);
                    if (e.target.value) setPicking(false);
                  }}
                />
              </Field>
            )}
          </Card>

          <Card title="Basic details" titleAs="h3">
            <div className="grid md2">
              <Field label="Brand" hint="Missing a brand? Request it and we review it with the product." error={fieldErr('brandId', 'requestedBrand', 'requestedBrand.name') ?? comment('brand', 'brandId')}>
                <Select id="pn-brand" options={[{ value: '', label: 'Choose a brand' }, ...brands.map((b) => ({ value: b.id, label: b.name })), { value: NEW_BRAND, label: 'Brand not listed' }]} value={f.brand} onChange={(e) => set('brand', e.target.value)} />
              </Field>
              <Field label="Model number" error={fieldErr('modelNumber') ?? comment('modelNumber')}>
                <TextInput id="pn-model" value={f.model} onChange={(e) => set('model', e.target.value)} />
              </Field>
            </div>
            {f.brand === NEW_BRAND && (
              <Field label="Brand name" hint="We create the brand when the Catalog team approves it." error={!f.requestedBrand.trim() ? 'Enter the brand name.' : undefined}>
                <TextInput id="pn-newbrand" value={f.requestedBrand} error={!f.requestedBrand.trim()} onChange={(e) => set('requestedBrand', e.target.value)} />
              </Field>
            )}
            <Field label="Product name" hint={`Brand + model + product type. No prices, promotions or seller names. ${f.name.length} of 150 characters.`} error={!f.name.trim() ? 'Enter the product name.' : (fieldErr('title') ?? comment('title'))}>
              <TextInput id="pn-name" value={f.name} maxLength={150} error={!f.name.trim()} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field
              label="Description"
              hint={`Describe the product, not your offer. Shipping and return terms go in your offer. ${f.desc.trim().length} of at least ${MIN_DESCRIPTION} characters.`}
              error={!f.desc.trim() ? 'Describe the product.' : !descOk ? `Add at least ${MIN_DESCRIPTION - f.desc.trim().length} more characters.` : (fieldErr('description') ?? comment('description'))}
            >
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
                {comment('keyFeatures') ?? 'Up to 5 short facts customers can scan.'}
              </span>
            </div>
          </Card>

          <Card id="pn-specs" title="Specifications" titleAs="h3" sub={f.categoryId ? (attributes.length ? `Required for ${cat?.name ?? 'this category'}` : `${cat?.name ?? 'This category'} has no fixed specifications. Add the facts customers compare.`) : 'Choose a category first'}>
            {specAttrs.length > 0 && <div className="grid md2">{specAttrs.map(attrField)}</div>}
            {(otherSpecs.length > 0 || (f.categoryId && !attrsQ.isLoading)) && (
              <div className="stack gap-2">
                {otherSpecs.map(({ s, i }) => (
                  <div className="grid md2" key={i}>
                    <Field label="Specification">
                      <TextInput id={`pn-sn${i}`} value={s.name} placeholder="e.g. Battery life" onChange={(e) => set('specs', f.specs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                    </Field>
                    <Field label="Value" error={specComment(s.name)}>
                      <TextInput id={`pn-sv${i}`} value={s.value} placeholder="e.g. 40 h" onChange={(e) => set('specs', f.specs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                    </Field>
                  </div>
                ))}
                <div className="row gap-2">
                  <Button variant="ghost" size="sm" icon="plus" onClick={() => set('specs', [...f.specs, { name: '', value: '' }])}>
                    Add specification
                  </Button>
                </div>
              </div>
            )}
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
                    <Chip active>{f.varAttr}</Chip>
                    {variantAttr && variantAttr.name !== f.varAttr && (
                      <Chip icon="plus" onClick={() => set('varAttr', variantAttr.name)}>
                        {variantAttr.name}
                      </Chip>
                    )}
                  </div>
                </div>
                <div className="card">
                  <TableWrap label="Variations table">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">{f.varAttr}</th>
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
                          const bad = priceMissing.some((p) => p.i === i) || !!v.error;
                          return (
                            <tr key={v.key} className={bad ? 'is-flagged' : ''}>
                              <td>
                                {bad && <span className="sr-only">Urgent: </span>}
                                <label className="sr-only" htmlFor={`pn-vv${i}`}>
                                  {f.varAttr} {i + 1}
                                </label>
                                {v.variantId && state !== 'DRAFT' && !cr ? (
                                  <span className="small strong">{v.value}</span>
                                ) : (
                                  <input className="input sa-sku" id={`pn-vv${i}`} value={v.value} placeholder={variantAttr?.options[0] ?? 'e.g. Black'} onChange={(e) => setVar(i, 'value', e.target.value)} />
                                )}
                                {v.error && <div className="error-text">{v.error}</div>}
                              </td>
                              <td>
                                <label className="sr-only" htmlFor={`pn-vs${i}`}>
                                  SKU for {v.value}
                                </label>
                                <input className="input sa-sku" id={`pn-vs${i}`} value={v.sku} onChange={(e) => setVar(i, 'sku', e.target.value)} />
                              </td>
                              <td>
                                <label className="sr-only" htmlFor={`pn-vp${i}`}>
                                  Price for {v.value}
                                </label>
                                <input
                                  className={cx('input sa-num', priceMissing.some((p) => p.i === i) && 'is-error')}
                                  id={`pn-vp${i}`}
                                  value={v.price}
                                  inputMode="decimal"
                                  placeholder={bad ? 'Price' : '0.00'}
                                  aria-invalid={priceMissing.some((p) => p.i === i) || undefined}
                                  aria-describedby={priceMissing.some((p) => p.i === i) ? `pn-vp${i}-err` : undefined}
                                  onChange={(e) => setVar(i, 'price', e.target.value)}
                                />
                                {priceMissing.some((p) => p.i === i) && (
                                  <div className="error-text" id={`pn-vp${i}-err`}>
                                    Add a price
                                  </div>
                                )}
                              </td>
                              <td>
                                <label className="sr-only" htmlFor={`pn-vq${i}`}>
                                  Quantity for {v.value}
                                </label>
                                <input className="input sa-num" id={`pn-vq${i}`} value={v.qty} inputMode="numeric" disabled={!!v.offerId} title={v.offerId ? 'Change stock in Inventory' : undefined} onChange={(e) => setVar(i, 'qty', e.target.value)} />
                              </td>
                              <td className="col-pin">
                                <div className="row gap-1 nowrap">
                                  <label className="sr-only" htmlFor={`pn-vg${i}`}>
                                    GTIN for {v.value}
                                  </label>
                                  <input className="input sa-sku mono" id={`pn-vg${i}`} value={v.gtin} inputMode="numeric" placeholder="12 or 13 digits" disabled={f.noGtin} onChange={(e) => setVar(i, 'gtin', e.target.value)} />
                                  {!v.variantId && f.variations.length > 1 && <IconButton icon="x" label={`Remove ${v.value || 'variation'}`} onClick={() => set('variations', f.variations.filter((x) => x.key !== v.key))} />}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </TableWrap>
                  {(priceMissing.length > 0 || f.variations.some((v) => v.error)) && <StatusLegend items={[{ tone: 'danger', label: 'Red edge = urgent: overdue or past target' }]} />}
                </div>
                {editable && (
                  <div className="row gap-2">
                    <Button variant="ghost" size="sm" icon="plus" onClick={() => set('variations', [...f.variations, { key: key(), value: '', sku: '', price: '', qty: '', gtin: '' }])}>
                      Add variation
                    </Button>
                  </div>
                )}
                <p className="xs muted row gap-1 nowrap top">
                  <Icon name="info" className="ic-sm" />
                  <span className="wrap">
                    Customers pick a {f.varAttr.toLowerCase()} on one product page. Your price and quantity are your offer (new condition, 1 business day dispatch, your default shipping profile); it goes live when the product is approved and you can change its terms on the offer page. Other sellers set their own.
                  </span>
                </p>
              </>
            ) : (
              <p className="small sub">This product is sold in one version. Your price and quantity are set on your offer.</p>
            )}
          </Card>

          <Card id="pn-images" title="Images" titleAs="h3" sub={`At least ${minImages} · first image is the main image`}>
            <div className={cx(photoComment && 'sa-hl', 'stack gap-2')}>
              {f.photos.length > 0 && (
                <div className="sa-thumbs">
                  {f.photos.map((p, i) => (
                    <div className={cx('sa-thumb', (p.status === 'failed' || (i === 0 && photoComment)) && 'is-error')} key={p.key}>
                      <Img icon="image" tint="surface-3" src={p.url} alt={`Product image ${i + 1}`} />
                      {i === 0 && <Badge tone={i === 0 && photoComment ? 'danger' : 'solid'}>Main</Badge>}
                      {p.status === 'uploading' && <span className="spinner" aria-label="Uploading" />}
                      {editable && p.status !== 'uploading' && (
                        <span className="row gap-1">
                          {i > 0 && p.status === 'ready' && <IconButton icon="star" label={`Make image ${i + 1} the main image`} onClick={() => makeMain(p.key)} />}
                          <IconButton icon="trash-2" label={`Remove image ${i + 1}`} onClick={() => removePhoto(p.key)} />
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {f.photos
                .filter((p) => p.status === 'failed')
                .map((p) => (
                  <span className="error-text" key={p.key}>
                    <Icon name="circle-alert" className="ic-sm" />
                    {p.name}: {p.error}
                  </span>
                ))}
              {photoComment ? (
                <span className="error-text">
                  <Icon name="circle-alert" className="ic-sm" />
                  {photoComment}
                </span>
              ) : (
                !photoCountOk && (
                  <span className="error-text">
                    <Icon name="circle-alert" className="ic-sm" />
                    Add at least {minImages - readyPhotos.length} more image{minImages - readyPhotos.length > 1 ? 's' : ''}.
                  </span>
                )
              )}
            </div>
            {editable && <FileDrop title="Drag images here or browse" hint="JPG, PNG, WebP or HEIC · up to 20 MB each" accept="image/jpeg,image/png,image/webp,image/heic" onFiles={addFiles} />}
            <div className="well stack gap-2">
              <span className="small strong">Image standards</span>
              <ul className="ul small sub stack gap-1">
                {imageRules.length ? (
                  imageRules.map((r) => <li key={r.text}>{r.text}</li>)
                ) : (
                  <>
                    <li>Main image: product only, plain white or light gray background, fills 85% of the frame.</li>
                    <li>No text, logos, watermarks, borders or prices.</li>
                    <li>Show every included accessory in at least one image.</li>
                    <li>Use your own photos or ones you have rights to.</li>
                  </>
                )}
              </ul>
            </div>
          </Card>

          <Card title="Identifiers" titleAs="h3">
            <div className="grid md2">
              <Field label="GTIN / UPC" error={gtinError ?? fieldErr('variants.gtin', 'variants[0].gtin') ?? comment('gtin', 'variants')} hint={!gtinError && !f.noGtin ? (f.hasVariations ? `Matches the barcode on the retail box. Each variation has its own; this is ${firstRow?.value || 'the first variation'}.` : 'Matches the barcode on the retail box.') : undefined}>
                <TextInput
                  id="pn-gtin"
                  value={f.hasVariations ? (firstRow?.gtin ?? '') : f.gtin}
                  placeholder="12 or 13 digits"
                  inputMode="numeric"
                  error={!!gtinError}
                  disabled={f.noGtin}
                  onChange={(e) => (f.hasVariations ? setVar(0, 'gtin', e.target.value) : set('gtin', e.target.value))}
                />
              </Field>
              <Field label="Manufacturer part number" optional>
                <TextInput id="pn-mpn" value={f.mpn} onChange={(e) => set('mpn', e.target.value)} />
              </Field>
            </div>
            <Checkbox id="pn-nogtin" label="This product has no GTIN (custom-made or private label). We may ask for proof." checked={f.noGtin} onChange={(e) => set('noGtin', e.target.checked)} />
          </Card>

          <Card title="Included accessories" titleAs="h3" sub="Everything in a new, sealed box">
            <div className={cx(boxComment && 'sa-hl', 'stack gap-2')}>
              {f.accessories.map((a) => (
                <Checkbox
                  key={a.id}
                  id={a.id}
                  label={a.label}
                  checked={a.checked}
                  onChange={(e) => set('accessories', f.accessories.map((x) => (x.id === a.id ? { ...x, checked: e.target.checked } : x)))}
                />
              ))}
              {!f.accessories.length && <span className="small sub">Nothing listed yet.</span>}
              {boxComment && (
                <span className="error-text">
                  <Icon name="circle-alert" className="ic-sm" />
                  {boxComment}
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
              {product?.missing && product.missing.length > 0 && (
                <p className="xs muted">Catalog check on the last save: missing {product.missing.join(', ')}.</p>
              )}
              <div className="divider" />
              <KeyValue
                pairs={[
                  ['Status', <Badge tone={statusTone}>{status}</Badge>],
                  ['Last saved', product ? `${fmtWhen(product.submission?.lastSavedAt ?? product.updatedAt)}${product.submission?.lastSavedBy?.name ? ` by ${product.submission.lastSavedBy.name}` : ''}` : 'Not saved yet'],
                  ['Review time', product?.submission?.expectedReviewBy && state === 'SUBMITTED' ? `Expected by ${fmtDay(product.submission.expectedReviewBy)}` : 'Usually 2 business days'],
                ]}
              />
              {cr && editable && (
                <Field label="Note to the reviewer" optional>
                  <Textarea id="pn-note" placeholder="Explain what you changed" value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
              )}
            </div>
            <div className="card-foot">
              {!cr && blocking > 0 && editable && (
                <p className="small t-danger-text strong card-foot-note" id="pn-block">
                  Fix {blocking} item{blocking > 1 ? 's' : ''} to submit. Your draft is kept for 90 days.
                </p>
              )}
              {editable && canSubmit ? (
                <>
                  <Button variant="secondary" onClick={() => save.mutate({ submit: false })} disabled={save.isPending || uploading || !f.name.trim()}>
                    {save.isPending && !save.variables?.submit ? 'Saving…' : 'Save draft'}
                  </Button>
                  <Button className={cx(blocking > 0 && 'is-disabled')} disabled={blocking > 0 || save.isPending || uploading} aria-describedby={blocking ? 'pn-block' : undefined} onClick={() => save.mutate({ submit: true })}>
                    {save.isPending && save.variables?.submit ? 'Submitting…' : cr ? 'Resubmit for review' : 'Submit for review'}
                  </Button>
                </>
              ) : (
                <span className="xs muted">{!canSubmit ? 'Your role can’t submit products.' : 'This submission can’t be edited now.'}</span>
              )}
            </div>
          </section>
          {cr && blocking > 0 && (
            <p className="xs muted" id="pn-block">
              Fix the {blocking} marked item{blocking > 1 ? 's' : ''} to resubmit.
            </p>
          )}
          {log.length > 0 ? (
            <Card title="Review history" titleAs="h3">
              <Timeline events={timeline} />
            </Card>
          ) : (
            <Card title="Before you submit" titleAs="h3">
              <p className="small sub">
                Search the catalog first{f.model || f.name ? (
                  <>
                    {' '}
                    for <b>{f.model || f.name}</b>
                  </>
                ) : null}
                . If a duplicate is found during review, your offer is attached to the existing product instead.
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
