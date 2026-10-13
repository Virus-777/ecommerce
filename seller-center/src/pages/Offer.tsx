import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ApiError, call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, EmptyState, Field, Icon, Img, PageHeader, Select, Steps, SummaryRow, Textarea, TextInput, announce } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { CONDITIONS, CONDITION_LABEL, FormSkeleton, LoadError, conditionLabel, iconFor, inputAmount, optionsLabel, toMinor, useDebounced, type Condition, type Money } from './data/catalog-parts';
import { SELLER_PRODUCT, offerHref, type SellerProduct } from './data/products';

// Design: pages/seller/seller-offer.html (New condition) · view "used-condition" = the same form with a
// used condition: missing-items alert, required condition notes, seller warranties.
// URL: ?offer=<id> edits an offer; ?product=<id>[&variant=<id>] creates one. Data: product card and the
// seller's offers on it from GraphQL myProduct; GET offers/offers/{id} (edit); GET shipping/profiles;
// GET finance/fee-schedule (fee preview); POST offers/offers/preview (delivery, price context, return
// baseline). Writes: POST offers/offers, PATCH offers/offers/{id}, POST …/{id}/publish,
// PATCH inventory/stock-items/{id} (low-stock alert).

type View = 'used-condition';
type Detail = components['schemas']['offers.SellerOfferDetail'];
type Profile = components['schemas']['shipping.ShippingProfile'];
type FeeSchedule = components['schemas']['finance.FeeSchedule'];
type Preview = components['schemas']['offers.OfferPreview'];
type ReturnKey = 'base' | 'ext' | 'extfree';
type WarrantyInput = { kind: 'manufacturer' | 'seller' | 'none'; months?: number | null };

const isUsed = (c: string) => c !== 'new';
const WARRANTY_NEW: Array<{ key: string; label: string; input: WarrantyInput }> = [
  { key: 'manufacturer-24', label: '2-year manufacturer warranty', input: { kind: 'manufacturer', months: 24 } },
  { key: 'seller-12', label: '1-year seller warranty', input: { kind: 'seller', months: 12 } },
  { key: 'none', label: 'No warranty', input: { kind: 'none' } },
];
const WARRANTY_USED: Array<{ key: string; label: string; input: WarrantyInput }> = [
  { key: 'seller-3', label: '3-month seller warranty', input: { kind: 'seller', months: 3 } },
  { key: 'seller-6', label: '6-month seller warranty', input: { kind: 'seller', months: 6 } },
  { key: 'none', label: 'No warranty', input: { kind: 'none' } },
];
const DISPATCH = [
  { value: '0', label: 'Same business day' },
  { value: '1', label: '1 business day' },
  { value: '2', label: '2 business days' },
  { value: '3', label: '3 business days' },
];
const NOTES_MAX = 500;
const EXTENDED_DAYS = 60;

const warrantyKey = (w: WarrantyInput) => (w.kind === 'none' ? 'none' : `${w.kind}-${w.months ?? ''}`);

interface Form {
  variantId: string;
  condition: Condition;
  notes: string;
  price: string;
  was: string;
  qty: string;
  sku: string;
  low: string;
  dispatch: string;
  profileId: string;
  ret: ReturnKey;
  warranty: string;
}
type Errors = Partial<Record<keyof Form | 'form', string>>;

function validate(f: Form, editing: boolean): Errors {
  const e: Errors = {};
  if (!f.variantId) e.variantId = 'Choose the variation you sell.';
  if (toMinor(f.price) === null) e.price = 'Enter a price, like 189.00.';
  if (f.was.trim() && toMinor(f.was) === null) e.was = 'Enter a price, like 229.00, or leave it empty.';
  else if (f.was.trim() && (toMinor(f.was) ?? 0) <= (toMinor(f.price) ?? 0)) e.was = 'The was price must be higher than your price.';
  const q = Number(f.qty);
  if (!editing && (f.qty.trim() === '' || !Number.isInteger(q) || q < 0)) e.qty = 'Enter a whole number of 0 or more.';
  if (!f.sku.trim()) e.sku = 'Enter your seller SKU.';
  if (f.low.trim() !== '' && (!Number.isInteger(Number(f.low)) || Number(f.low) < 0)) e.low = 'Enter a whole number, or leave it empty.';
  if (isUsed(f.condition) && !f.notes.trim()) e.notes = 'Describe the condition, including anything missing from the box.';
  if (f.notes.length > NOTES_MAX) e.notes = `Keep the notes to ${NOTES_MAX} characters.`;
  if (!f.profileId) e.profileId = 'Choose a shipping profile.';
  return e;
}

/** Field errors from the API (VALIDATION_FAILED and the offer error codes). */
function apiErrors(err: unknown): Errors {
  if (!(err instanceof ApiError)) return { form: errorMessage(err) };
  const map: Record<string, keyof Form> = { price: 'price', 'price.amount': 'price', compareAt: 'was', 'compareAt.amount': 'was', sellerSku: 'sku', conditionNotes: 'notes', missingItems: 'notes', quantity: 'qty', lowStockThreshold: 'low', shippingProfileId: 'profileId', variantId: 'variantId', returnTerms: 'ret', 'returnTerms.windowDays': 'ret', warranty: 'warranty' };
  const out: Errors = {};
  Object.entries(err.fieldErrors).forEach(([k, v]) => {
    const f = map[k];
    if (f) out[f] = v;
  });
  const min = err.details.minimum as Money | undefined;
  if (err.code === 'PRICE_BELOW_MINIMUM') out.price = min ? `The minimum price in this category is ${formatMoney(min)}.` : err.message;
  else if (err.code === 'WAS_PRICE_NOT_VERIFIED') out.was = 'We can’t verify this was price from your price history or the list price on file. Leave it empty or enter a verified price.';
  else if (err.code === 'DUPLICATE_OFFER') out.sku = err.message;
  else if (err.code === 'SHIPPING_PROFILE_INVALID') out.profileId = err.message;
  else if (err.code === 'RETURN_TERMS_BELOW_BASELINE') out.ret = err.message;
  else if (err.code === 'MISSING_ITEMS_REQUIRED' && !out.notes) out.notes = err.message;
  if (!Object.keys(out).length) out.form = errorMessage(err);
  return out;
}

export default function Offer() {
  const { api, gql } = useApi();
  const { sellerId } = useSellerSession();
  const [params] = useSearchParams();
  const offerId = params.get('offer') ?? '';

  const detail = useQuery({
    queryKey: ['offers', 'detail', sellerId, offerId],
    queryFn: () => call(api.GET('/api/seller/offers/offers/{id}', { params: { path: { id: offerId } } })),
    enabled: !!offerId,
  });
  const productId = params.get('product') ?? detail.data?.offer.productId ?? '';
  const product = useQuery({
    queryKey: ['catalog', 'seller-product', sellerId, productId],
    queryFn: async () => (await gql<{ myProduct: SellerProduct | null }>(SELLER_PRODUCT, { id: productId })).data?.myProduct ?? null,
    enabled: !!productId,
  });
  const profiles = useQuery({ queryKey: ['shipping', 'profiles', sellerId], queryFn: () => call(api.GET('/api/seller/shipping/profiles')) });
  const fees = useQuery({ queryKey: ['finance', 'fee-schedule', sellerId], queryFn: () => call(api.GET('/api/seller/finance/fee-schedule')), staleTime: 10 * 60_000 });

  const failed = [detail, product, profiles].find((q) => q.isError);
  const loading = (!!offerId && !detail.data) || (!!productId && product.data === undefined) || !profiles.data;
  const editing = !!offerId;

  let body: ReactNode;
  if (!offerId && !productId) {
    body = (
      <section className="card">
        <EmptyState icon="search" as="h2" title="Choose a product first" action={<Button to={href('seller/catalog-match')}>Find the product</Button>}>
          Offers are added to a product in the catalog. Search for it by name, model number or GTIN.
        </EmptyState>
      </section>
    );
  } else if (failed && !(failed.error instanceof ApiError && failed.error.status === 404)) {
    body = <LoadError error={failed.error} onRetry={() => void failed.refetch()} />;
  } else if ((failed && failed.error instanceof ApiError && failed.error.status === 404) || (product.data === null && !loading)) {
    body = (
      <section className="card">
        <EmptyState icon="search-x" as="h2" title={editing ? 'Offer not found' : 'Product not found'} action={<Button to={href('seller/products')}>Back to products and offers</Button>}>
          {editing ? 'This offer isn’t one of yours, or it was deleted.' : 'This product isn’t available for new offers. It may be hidden, suspended or still in review by another seller.'}
        </EmptyState>
      </section>
    );
  } else if (loading || !product.data) {
    body = <FormSkeleton cards={4} />;
  } else {
    return <OfferForm key={`${offerId}|${product.data.id}|${detail.data?.offer.updatedAt ?? ''}`} product={product.data} detail={detail.data} profiles={profiles.data!} fees={fees.data} />;
  }

  return (
      <SellerLayout active="products">
        <PageHeader
          crumbs={[{ label: 'Products and offers', to: href('seller/products') }, { label: 'Find product', to: href('seller/catalog-match') }, { label: editing ? 'Edit offer' : 'Create offer' }]}
          title={editing ? 'Edit your offer' : 'Create your offer'}
          sub="You set the terms of your offer. Product content is shared by every seller."
        />
        {body}
      </SellerLayout>
    );
}

function OfferForm({ product, detail, profiles, fees }: { product: SellerProduct; detail?: Detail; profiles: Profile[]; fees?: FeeSchedule }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { can } = useSellerSession();
  const [params] = useSearchParams();
  const [view, setView] = useView<View>();
  const o = detail?.offer;
  const editing = !!o;
  const isDraft = !o || o.status === 'draft';
  const purchasable = product.reviewState === 'APPROVED' && product.publication === 'ACTIVE';
  const activeProfiles = profiles.filter((p) => p.status !== 'archived');

  const [f, setF] = useState<Form>(() => {
    if (o) {
      const used = isUsed(o.condition);
      const wk = warrantyKey(o.warranty);
      return {
        variantId: o.variantId,
        condition: o.condition,
        notes: o.conditionNotes ?? '',
        price: inputAmount(o.price),
        was: o.compareAt ? inputAmount(o.compareAt.amount) : '',
        qty: String(detail!.stock.available),
        sku: o.sellerSku,
        low: detail!.stock.lowStockThreshold == null ? '' : String(detail!.stock.lowStockThreshold),
        dispatch: String(Math.min(3, o.dispatch.businessDays)),
        profileId: o.shippingProfileId,
        ret: o.returnTerms.kind === 'baseline' ? 'base' : o.returnTerms.freeReturnShipping ? 'extfree' : 'ext',
        warranty: wk || (used ? WARRANTY_USED[0].key : WARRANTY_NEW[0].key),
      };
    }
    const used = view === 'used-condition';
    const want = params.get('variant');
    const variantId = product.variants.find((v) => v.id === want)?.id ?? product.variants.find((v) => !product.myOffers.some((m) => m.variant.id === v.id))?.id ?? product.variants[0]?.id ?? '';
    return {
      variantId,
      condition: used ? 'used_good' : 'new',
      notes: '',
      price: '',
      was: '',
      qty: '',
      sku: '',
      low: '3',
      dispatch: '1',
      profileId: (activeProfiles.find((p) => p.isDefault) ?? activeProfiles[0])?.id ?? '',
      ret: 'base',
      warranty: used ? WARRANTY_USED[0].key : WARRANTY_NEW[0].key,
    };
  });
  const [attempted, setAttempted] = useState(false);
  const [server, setServer] = useState<Errors>({});
  const [result, setResult] = useState<'' | 'draft' | 'published' | 'saved'>('');
  const [confirmLarge, setConfirmLarge] = useState<null | { publish: boolean }>(null);

  const used = isUsed(f.condition);
  const errors: Errors = { ...(attempted ? validate(f, editing) : {}), ...server };
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setF((s) => ({ ...s, [k]: v }));
    setServer((e) => ({ ...e, [k]: undefined, form: undefined }));
  };

  const warrantyOptions = useMemo(() => {
    const base = used ? WARRANTY_USED : WARRANTY_NEW;
    if (o && !base.some((w) => w.key === warrantyKey(o.warranty)) && isUsed(o.condition) === used) return [{ key: warrantyKey(o.warranty), label: o.warranty.summary, input: o.warranty as WarrantyInput }, ...base];
    return base;
  }, [used, o]);
  const warrantyInput = warrantyOptions.find((w) => w.key === f.warranty)?.input ?? warrantyOptions[0].input;

  const changeCondition = (c: Condition) => {
    setF((s) => {
      const wasUsed = isUsed(s.condition);
      const nowUsed = isUsed(c);
      const warranty = wasUsed === nowUsed ? s.warranty : nowUsed ? WARRANTY_USED[0].key : WARRANTY_NEW[0].key;
      return { ...s, condition: c, warranty };
    });
    setView(isUsed(c) ? 'used-condition' : '', { replace: true });
  };

  const variant = product.variants.find((v) => v.id === f.variantId);
  const priceMinor = toMinor(f.price) ?? 0;
  const wasMinor = toMinor(f.was);
  const currency = o?.price.currency ?? 'USD';
  const listPrice = variant?.listPrice?.amount ?? toMinor(product.specs.find((s) => /^(list price|msrp|rrp)$/i.test(s.name))?.value ?? '');
  const returnInput = (k: ReturnKey) => (k === 'base' ? { kind: 'baseline' as const } : { kind: 'extended' as const, windowDays: Math.max(EXTENDED_DAYS, baselineDays), freeReturnShipping: k === 'extfree' });

  // Preview: delivery a customer would see, price context and the return baseline for this variant and condition.
  const previewKey = useDebounced(JSON.stringify([f.variantId, f.condition, priceMinor, f.dispatch, f.profileId]), 400);
  const preview = useQuery({
    queryKey: ['offers', 'preview', product.id, previewKey],
    queryFn: () =>
      call(
        api.POST('/api/seller/offers/offers/preview', {
          body: {
            productId: product.id,
            variantId: f.variantId,
            condition: f.condition,
            conditionNotes: used ? f.notes || 'Condition notes' : null,
            price: { amount: priceMinor || 100, currency },
            sellerSku: f.sku || 'preview',
            quantity: 1,
            dispatchBusinessDays: Number(f.dispatch),
            shippingProfileId: f.profileId,
            returnTerms: { kind: 'baseline' },
            warranty: { kind: 'none' },
          },
        }),
      ) as Promise<Preview>,
    enabled: !!f.variantId && !!f.profileId,
    retry: false,
  });
  const pv = preview.data;
  const baselineDays = pv?.returnBaseline.windowDays ?? o?.returnTerms.windowDays ?? 30;
  const extDays = Math.max(EXTENDED_DAYS, baselineDays);
  const lowestNew = pv?.lowestNewPrice ?? detail?.lowestNewPrice;
  const official = pv?.officialStorePrice ?? detail?.officialStorePrice;

  // Fee preview from the published fee rules (category rate or the default rate; shipping excluded).
  const rule = fees?.current;
  const rateBps = rule ? (rule.categoryRates.find((r) => r.categoryId === product.category?.id)?.rateBps ?? rule.defaultRateBps) : null;
  const fee = rateBps === null ? 0 : Math.round((priceMinor * rateBps) / 10000);
  const money = (n: number) => formatMoney({ amount: n, currency });
  const ratePct = rateBps === null ? '' : `${(rateBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

  const profile = activeProfiles.find((p) => p.id === f.profileId);
  const freeOver = profile?.freeShippingThreshold ?? profile?.methods.find((m) => m.enabled && m.freeOver)?.freeOver ?? null;
  const profileHint = profile ? [freeOver ? `Free ${profile.freeShippingMethodCode ?? 'shipping'} over ${formatMoney(freeOver)}` : profile.methods.filter((m) => m.enabled).map((m) => m.name).join(' and ')].filter(Boolean).join('') : '';

  const save = useMutation({
    mutationFn: async ({ publish, confirm }: { publish: boolean; confirm?: boolean }) => {
      const compareAt = wasMinor ? { amount: { amount: wasMinor, currency }, basis: (listPrice && wasMinor === listPrice ? 'list_price' : 'lowest_30_days') as 'list_price' | 'lowest_30_days' } : null;
      const common = {
        conditionNotes: f.notes.trim() || null,
        price: { amount: priceMinor, currency },
        compareAt,
        sellerSku: f.sku.trim(),
        dispatchBusinessDays: Number(f.dispatch),
        shippingProfileId: f.profileId,
        returnTerms: returnInput(f.ret),
        warranty: warrantyInput,
      };
      if (!o) {
        const created = await call(
          api.POST('/api/seller/offers/offers', {
            body: {
              ...common,
              compareAt: compareAt ?? undefined,
              productId: product.id,
              variantId: f.variantId,
              condition: f.condition,
              quantity: Number(f.qty),
              lowStockThreshold: f.low.trim() === '' ? null : Number(f.low),
              publish: publish && purchasable,
              publishOnApproval: publish && !purchasable,
            },
          }),
        );
        return { d: created, published: publish && purchasable };
      }
      // Only what changed: an unchanged price or was-price is left out, so it doesn't add price history.
      const sameReturns = JSON.stringify(returnInput(f.ret)) === JSON.stringify(o.returnTerms.kind === 'baseline' ? { kind: 'baseline' } : { kind: 'extended', windowDays: o.returnTerms.windowDays, freeReturnShipping: o.returnTerms.freeReturnShipping });
      const patch = {
        ...(isDraft && f.variantId !== o.variantId ? { variantId: f.variantId } : {}),
        ...(isDraft && f.condition !== o.condition ? { condition: f.condition } : {}),
        ...(common.conditionNotes !== (o.conditionNotes ?? null) ? { conditionNotes: common.conditionNotes } : {}),
        ...(priceMinor !== o.price.amount ? { price: common.price } : {}),
        ...((wasMinor ?? null) !== (o.compareAt?.amount.amount ?? null) ? { compareAt } : {}),
        ...(common.sellerSku !== o.sellerSku ? { sellerSku: common.sellerSku } : {}),
        ...(common.dispatchBusinessDays !== o.dispatch.businessDays ? { dispatchBusinessDays: common.dispatchBusinessDays } : {}),
        ...(f.profileId !== o.shippingProfileId ? { shippingProfileId: f.profileId } : {}),
        ...(!sameReturns ? { returnTerms: common.returnTerms } : {}),
        ...(warrantyKey(warrantyInput) !== warrantyKey(o.warranty) ? { warranty: warrantyInput } : {}),
        ...(isDraft && publish && !purchasable ? { publishOnApproval: true } : {}),
        ...(confirm ? { confirmLargeChange: true } : {}),
      };
      let d: Detail = detail!;
      if (Object.keys(patch).length) d = await call(api.PATCH('/api/seller/offers/offers/{id}', { params: { path: { id: o.id } }, body: patch }));
      const low = f.low.trim() === '' ? null : Number(f.low);
      if (low !== (detail!.stock.lowStockThreshold ?? null) && can('inventory.stock.adjust'))
        await call(api.PATCH('/api/seller/inventory/stock-items/{id}', { params: { path: { id: o.stockItemId } }, body: { lowStockThreshold: low } }));
      let published = false;
      if (publish && isDraft && purchasable) {
        d = await call(api.POST('/api/seller/offers/offers/{id}/publish', { params: { path: { id: o.id } } }));
        published = true;
      }
      return { d, published };
    },
    onSuccess: ({ d, published }, { publish }) => {
      setConfirmLarge(null);
      const state = published ? 'published' : editing && !(publish && isDraft) ? 'saved' : 'draft';
      setResult(state);
      announce(state === 'published' ? 'Offer published' : state === 'saved' ? 'Offer saved' : 'Draft saved');
      void qc.invalidateQueries({ queryKey: ['offers'] });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: ['catalog', 'seller-product'] });
      if (!editing) navigate(offerHref(d.offer.id) + (isUsed(d.offer.condition) ? '&view=used-condition' : ''), { replace: true, state: { saved: state } });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    onError: (err, { publish }) => {
      if (err instanceof ApiError && err.code === 'LARGE_PRICE_CHANGE_UNCONFIRMED') return setConfirmLarge({ publish });
      if (err instanceof ApiError && err.code === 'PRODUCT_NOT_PURCHASABLE') return setServer({ form: err.message });
      setServer(apiErrors(err));
      announce('Check the highlighted fields');
    },
  });

  const submit = (publish: boolean) => {
    setAttempted(true);
    setServer({});
    if (Object.keys(validate(f, editing)).length) {
      announce('Check the highlighted fields');
      return;
    }
    save.mutate({ publish });
  };

  const canManage = can('offers.offers.manage');
  const canPrice = !editing || can('offers.prices.manage') || can('offers.offers.manage');
  const status = o?.status;
  const pr = product;
  const gtin = variant?.gtin;
  const otherOffers = Math.max(0, pr.offerCount - (o && o.status === 'active' ? 1 : 0));
  const priceHint = [lowestNew ? `Lowest New offer today: ${formatMoney(lowestNew)}` : null, official ? `Official Store ${formatMoney(official)}` : null].filter(Boolean).join(' · ') || 'Set the price customers pay for one unit.';
  const savedFlag = (location.state as { saved?: string } | null)?.saved;
  const shownResult = result || (savedFlag === 'published' || savedFlag === 'draft' ? savedFlag : '');
  const variationLabel = optionsLabel(variant?.options) || 'Standard';

  return (
    <SellerLayout active="products">
      <PageHeader
        crumbs={[{ label: 'Products and offers', to: href('seller/products') }, { label: 'Find product', to: href('seller/catalog-match') }, { label: editing ? 'Edit offer' : 'Create offer' }]}
        title={editing ? 'Edit your offer' : 'Create your offer'}
        sub="You set the terms of your offer. Product content is shared by every seller."
      />
      <Steps items={['Find the product', <><span className="sr-only">Step 2 of 3: </span>{editing ? 'Edit your offer' : 'Create your offer'}</>, 'Publish']} current={shownResult === 'published' || status === 'active' ? 3 : 1} />
      {shownResult === 'published' && (
        <Alert tone="success" title="Your offer is live">
          {variationLabel}, {CONDITION_LABEL[f.condition]} at {money(priceMinor)} · {f.qty} available. {Number(f.qty) === 0 ? 'It shows to customers once you add stock. ' : ''}
          <Link to={href('seller/products')}>View products and offers</Link>
        </Alert>
      )}
      {shownResult === 'draft' && (
        <Alert tone="info" title="Draft saved">
          {purchasable ? 'Customers don’t see a draft. Publish it when you’re ready.' : (o?.publishOnApproval ?? false) ? 'Your offer goes live when the Catalog team approves the product.' : 'Customers don’t see a draft. It can go live once the product is approved.'}
        </Alert>
      )}
      {shownResult === 'saved' && (
        <Alert tone="success" title="Offer saved">
          Customers see the new terms now. <Link to={href('seller/products')}>View products and offers</Link>
        </Alert>
      )}
      {o?.statusReason && (status === 'ineligible' || status === 'removed' || status === 'paused') && (
        <Alert tone={status === 'paused' ? 'info' : 'danger'} title={status === 'paused' ? 'This offer is hidden' : status === 'removed' ? 'This offer was removed' : 'This offer is not shown to customers'}>
          {[o.statusReason.text, o.statusReason.affectedActivity && `Affects: ${o.statusReason.affectedActivity}.`, o.statusReason.appealRoute].filter(Boolean).join(' ')}
        </Alert>
      )}
      {detail?.fulfillmentNote && <Alert tone="info">{detail.fulfillmentNote}</Alert>}
      {errors.form && (
        <Alert tone="danger" title="We couldn’t save your offer">
          {errors.form}
        </Alert>
      )}
      {confirmLarge && (
        <Alert tone="warning" title="That’s a large price change">
          The new price differs from the current price by more than the large-change limit. Check the amount, then confirm.{' '}
          <Button size="sm" variant="secondary" onClick={() => save.mutate({ publish: confirmLarge.publish, confirm: true })} disabled={save.isPending}>
            Confirm and save
          </Button>
        </Alert>
      )}
      <div className="sa-split">
        <div className="stack gap-5">
          <Card
            title="Product"
            sub="Shared catalog content · read-only"
            actions={
              <Link className="small strong row gap-1" to={href('seller/help', 'contact-seller-support')}>
                <Icon name="pencil-line" className="ic-sm" />
                Suggest a correction
              </Link>
            }
          >
            <div className="row top gap-4 nowrap">
              <Img icon={iconFor(pr.title, ...pr.categoryPath)} tint="2" src={variant?.images[0]?.url ?? pr.images[0]?.url} alt={pr.images[0]?.alt ?? ''} className="xl" />
              <div className="stack gap-1">
                <span className="row gap-2">
                  <Badge tone={pr.reviewState === 'APPROVED' ? 'success' : pr.reviewState === 'REJECTED' ? 'danger' : pr.reviewState === 'CHANGES_REQUESTED' ? 'warning' : 'info'}>{pr.reviewState ? pr.reviewState.charAt(0) + pr.reviewState.slice(1).toLowerCase().replace('_', ' ') : 'Approved'}</Badge>
                  {pr.publication && <Badge tone={pr.publication === 'ACTIVE' ? 'success' : pr.publication === 'SUSPENDED' ? 'danger' : ''}>{pr.publication.charAt(0) + pr.publication.slice(1).toLowerCase()}</Badge>}
                </span>
                {purchasable ? (
                  <Link className="strong" to={href('store/product', '', { slug: pr.slug, id: pr.id })}>
                    {pr.title}
                  </Link>
                ) : (
                  <span className="strong">{pr.title}</span>
                )}
                <span className="xs muted">
                  {[
                    pr.brand?.name ?? pr.requestedBrandName,
                    pr.modelNumber ? (
                      <span key="m">
                        Model <span className="mono">{pr.modelNumber}</span>
                      </span>
                    ) : null,
                    gtin ? (
                      <span key="g">
                        GTIN <span className="mono">{gtin}</span>
                      </span>
                    ) : null,
                  ]
                    .filter(Boolean)
                    .flatMap((x, j) => (j ? [' · ', x] : [x]))}
                </span>
                <span className="xs muted">
                  {pr.categoryPath.join(' › ')}
                  {pr.categoryPath.length ? ' · ' : ''}
                  {otherOffers} other offer{otherOffers === 1 ? '' : 's'}
                </span>
              </div>
            </div>
            <div className="grid md2">
              <Field label="Variation" error={errors.variantId} hint={!isDraft ? 'To sell another variation, create a new offer.' : undefined}>
                <Select
                  id="of-var"
                  options={pr.variants.map((v) => ({ value: v.id, label: optionsLabel(v.options) || 'Standard' }))}
                  value={f.variantId}
                  disabled={!isDraft}
                  onChange={(e) => set('variantId', e.target.value)}
                />
              </Field>
              <div className="stack gap-1">
                <span className="label">In the box (new)</span>
                <span className="small sub">{pr.includedItems.length ? pr.includedItems.join(', ') : 'Not listed'}</span>
              </div>
            </div>
            <p className="xs muted row gap-1 nowrap top">
              <Icon name="info" className="ic-sm" />
              <span className="wrap">Corrections to shared content are reviewed by the Catalog team because they affect every seller on this product.</span>
            </p>
          </Card>

          <Card title="Condition" titleAs="h3">
            <div className="grid md2">
              <Field label="Condition" hint={!isDraft ? 'To sell another condition, end this offer and create a new one.' : undefined}>
                <Select id="of-cond" options={CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABEL[c] }))} value={f.condition} disabled={!isDraft} onChange={(e) => changeCondition(e.target.value as Condition)} />
              </Field>
              <div />
            </div>
            {used && (
              <Alert tone="warning" title="List anything missing from the box">
                {pr.includedItems.length ? `This product normally includes: ${pr.includedItems.join(', ')}.` : 'Describe exactly what is in your box.'} Customers see your notes next to the price.
              </Alert>
            )}
            <Field
              label="Condition notes"
              optional={!used}
              hint={used ? `Required for used and refurbished items. ${f.notes.length} of ${NOTES_MAX} characters.` : 'Shown to customers beside your price.'}
              error={errors.notes}
            >
              <Textarea id="of-notes" placeholder={used ? '' : 'e.g. Factory sealed, US retail version'} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </Card>

          <Card title="Price and stock" titleAs="h3">
            <div className="grid md2">
              <Field label="Price" hint={priceHint} error={errors.price}>
                <TextInput id="of-price" prefix="$" inputMode="decimal" value={f.price} error={!!errors.price} disabled={!canPrice} onChange={(e) => set('price', e.target.value)} onBlur={() => priceMinor > 0 && set('price', (priceMinor / 100).toFixed(2))} />
              </Field>
              <Field label="Quantity available" hint={editing ? <>Change stock in <Link to={href('seller/inventory')} className="link-inline">Inventory</Link>, with a reason.</> : 'Customers cannot buy more than this.'} error={errors.qty}>
                <TextInput id="of-qty" type="number" min={0} value={f.qty} error={!!errors.qty} disabled={editing} onChange={(e) => set('qty', e.target.value)} />
              </Field>
              <Field label="Seller SKU" hint="Your own code. Customers don't see it." error={errors.sku}>
                <TextInput id="of-sku" value={f.sku} error={!!errors.sku} onChange={(e) => set('sku', e.target.value)} />
              </Field>
              <Field label="Low-stock alert at" optional error={errors.low}>
                <TextInput id="of-low" type="number" min={0} suffix="units" value={f.low} error={!!errors.low} onChange={(e) => set('low', e.target.value)} />
              </Field>
              <Field label="Was price" optional hint={listPrice ? `Shown only when verified: your lowest price in the last 30 days, or the list price on file (${money(listPrice)}).` : 'Shown only when verified against your lowest price in the last 30 days.'} error={errors.was}>
                <TextInput id="of-was" prefix="$" inputMode="decimal" value={f.was} error={!!errors.was} disabled={!canPrice} onChange={(e) => set('was', e.target.value)} onBlur={() => wasMinor && set('was', (wasMinor / 100).toFixed(2))} />
              </Field>
            </div>
          </Card>

          <Card title="Delivery" titleAs="h3">
            <div className="grid md2">
              <Field label="Dispatch time" hint="Missing this deadline counts as a late dispatch.">
                <Select id="of-disp" options={DISPATCH} value={f.dispatch} onChange={(e) => set('dispatch', e.target.value)} />
              </Field>
              <Field
                label="Shipping profile"
                error={errors.profileId}
                hint={
                  <>
                    {profileHint ? `${profileHint} · ` : ''}
                    <Link to={href('seller/shipping')} className="link-inline">
                      Edit profiles
                    </Link>
                  </>
                }
              >
                <Select
                  id="of-ship"
                  options={activeProfiles.length ? activeProfiles.map((p) => ({ value: p.id, label: `${p.name}${p.isDefault ? ' (default)' : ''}` })) : [{ value: '', label: 'No shipping profile yet' }]}
                  value={f.profileId}
                  onChange={(e) => set('profileId', e.target.value)}
                />
              </Field>
            </div>
            {pv && (
              <div className="panel small">
                {pv.delivery.shipsToLocation ? (
                  <>
                    Customers in the default delivery area see: <b>{pv.delivery.label}</b>
                    {pv.delivery.service ? ` with ${pv.delivery.service}` : ''} if ordered today{pv.delivery.shippingCost && !pv.delivery.free ? ` · shipping ${formatMoney(pv.delivery.shippingCost)}` : pv.delivery.free ? ' · free shipping' : ''}.
                  </>
                ) : (
                  <>This shipping profile doesn’t deliver to the market default location. Choose another profile.</>
                )}
              </div>
            )}
            {pv?.warnings.map((w) => (
              <p key={w} className="xs t-warning-text row gap-1 nowrap top">
                <Icon name="triangle-alert" className="ic-sm" />
                <span className="wrap">{w}</span>
              </p>
            ))}
          </Card>

          <Card title="Returns and warranty" titleAs="h3">
            <div className="stack gap-2">
              <span className="label">Return policy</span>
              {(
                [
                  { id: 'base' as const, title: `${baselineDays}-day returns`, baseline: true, body: pv?.returnBaseline.summary ?? `Customer can return within ${baselineDays} days of delivery. Return shipping: buyer pays unless the item is faulty or not as described.` },
                  { id: 'ext' as const, title: `${extDays}-day returns`, body: 'More generous than the baseline. Shown as a benefit on your offer.' },
                  { id: 'extfree' as const, title: `${extDays}-day returns with free return shipping`, body: 'You pay return shipping for every return.' },
                ]
              ).map((r) => (
                <label key={r.id} className={cx('opt-card', f.ret === r.id && 'is-selected')} htmlFor={`of-ret-${r.id}`}>
                  <input type="radio" name="of-ret" id={`of-ret-${r.id}`} checked={f.ret === r.id} aria-describedby={r.baseline ? 'of-ret30-hint' : undefined} onChange={() => set('ret', r.id)} />
                  <span className="stack gap-1 grow">
                    <b>{r.title}</b>
                    {r.baseline && (
                      <>
                        {' '}
                        <span className="xs muted">Platform baseline</span>
                      </>
                    )}
                    <span className="small sub">{r.body}</span>
                  </span>
                </label>
              ))}
              {pv?.returnBaseline.categoryException && <span className="hint">{pv.returnBaseline.categoryException}</span>}
              <span className={errors.ret ? 'error-text' : 'hint'} id="of-ret30-hint">
                {errors.ret ?? "You can't offer less than the platform baseline for this category."}
              </span>
            </div>
            <Field label="Warranty" error={errors.warranty} hint={used ? 'Manufacturer warranty does not transfer for used items sold here.' : 'Only choose a manufacturer warranty if the product is new and sold in the US.'}>
              <Select id="of-war" options={warrantyOptions.map((w) => ({ value: w.key, label: w.label }))} value={f.warranty} onChange={(e) => set('warranty', e.target.value)} />
            </Field>
          </Card>
        </div>

        <aside className="stack gap-5 sa-sticky">
          <Card title="Fee and earnings preview" titleAs="h3" sub="Per unit sold, before shipping and tax">
            <SummaryRow k="Sale price" v={money(priceMinor)} />
            <SummaryRow k={`Platform fee${ratePct ? ` (${ratePct})` : ''}`} v={rateBps === null ? '—' : `−${money(fee)}`} />
            <div className="divider" />
            <SummaryRow className="total" k="Your earnings" v={rateBps === null ? '—' : money(priceMinor - fee)} />
            <Badge tone="outline">Example</Badge>
            <p className="xs muted row gap-1 nowrap top">
              <Icon name="info" className="ic-sm" />
              <span className="wrap">
                {rule
                  ? `${rule.includeShipping ? 'Fee includes shipping.' : 'Shipping is not included in the fee.'} Fee rules ${rule.version}, seller agreement ${rule.agreementVersion}. Earnings show as pending until delivery and the hold period end.`
                  : 'Fee rules couldn’t be loaded. Final fees by category are in your seller agreement.'}
              </span>
            </p>
          </Card>
          <Card
            title="Publish"
            titleAs="h3"
            foot={
              canManage ? (
                <>
                  {isDraft && (
                    <Button variant="secondary" onClick={() => submit(false)} disabled={save.isPending}>
                      Save draft
                    </Button>
                  )}
                  <Button icon="check" onClick={() => submit(isDraft)} disabled={save.isPending}>
                    {save.isPending ? 'Saving…' : !isDraft ? 'Save changes' : purchasable ? 'Publish offer' : 'Publish when approved'}
                  </Button>
                </>
              ) : (
                <span className="xs muted">Your role can view offers but not change them.</span>
              )
            }
          >
            <p className="small sub">
              {purchasable
                ? isDraft
                  ? 'This product is already approved, so your offer goes live when you publish and have stock.'
                  : `Status: ${status === 'out_of_stock' ? 'out of stock' : (status ?? '').replace('_', ' ')}. Changes apply to your live offer when you save.`
                : 'This product is waiting for catalog review. Your offer is saved as a draft and goes live when the product is approved.'}
            </p>
            <Alert tone="info">
              Product approval and offer availability are separate. If your quantity reaches 0 or your offer is hidden or restricted, only your offer stops showing. Other sellers' offers on this product stay up.
            </Alert>
            {pv && !pv.featuredEligibility.eligible && pv.featuredEligibility.reasons.length > 0 && (
              <p className="xs muted row gap-1 nowrap top">
                <Icon name="info" className="ic-sm" />
                <span className="wrap">{pv.featuredEligibility.reasons.map((r) => r.howToFix ?? r.message).join(' ')}</span>
              </p>
            )}
            {o && <span className="xs muted">Condition {conditionLabel(o.condition)} · SKU {o.sellerSku}</span>}
          </Card>
        </aside>
      </div>
    </SellerLayout>
  );
}
