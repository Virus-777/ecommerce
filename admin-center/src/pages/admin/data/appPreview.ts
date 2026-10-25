// Data behind Admin › Marketing and content › App preview: the Store API as the Android app calls it.
//
// The Android app (the `app/` module, against android-customer-app/screens/*.md) reads the Store API with a store
// token, which the staff session is not: every /api/store endpoint needs a visitor or customer token of the store
// app. The preview therefore starts a store visitor session of its own (the same POST /api/public/identity/
// app-sessions the website uses) and calls the store endpoints with it, so the screens draw the live content and
// prices customers get, not an admin-side copy of them. The session is read-only: nothing here writes, adds to a
// cart or signs anyone in, the request carries no cookies (credentials: 'omit'), so it cannot disturb the staff
// member's own store session, and ad decisions are asked for without ever sending a display or click event, so
// advertisers are not billed for a preview.
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { toApiError } from '@marketly/web-shared/api';
import { formatMoney, initials, num, tileTint } from '@marketly/web-shared/lib/format';
import type { IconName } from '@marketly/web-shared/ui';

// ---------------------------------------------------------------- the store session

const PUBLIC = '/api/public/identity';
/** One id per page load: the store sees the preview as one device, and no device record piles up per screen. */
const INSTALLATION_ID = crypto.randomUUID();
/** The visit the ad decisions belong to (the app sends its AdsController.visitId). */
export const PREVIEW_VISIT_ID = crypto.randomUUID();

let token: string | null = null;
let expiresAt = 0;
let starting: Promise<string> | null = null;

async function start(): Promise<string> {
  const res = await fetch(`${PUBLIC}/app-sessions`, {
    method: 'POST',
    // No cookies: the answer's refresh cookie is dropped, so the preview never replaces the store session this
    // browser may already hold (a staff member who also shops here stays signed in).
    credentials: 'omit',
    // The same app proof the web apps send (web-shared api/session.ts, SessionOptions.appProof).
    headers: { 'Content-Type': 'application/json', 'X-Client': 'web', 'X-App-Proof': 'dev' },
    body: JSON.stringify({ audience: 'store', device: { kind: 'web', name: 'Admin Center app preview', installationId: INSTALLATION_ID } }),
  });
  if (!res.ok) throw await toApiError(res);
  const tokens = (await res.json()) as { accessToken: string; accessTokenExpiresAt?: string };
  token = tokens.accessToken;
  expiresAt = tokens.accessTokenExpiresAt ? Date.parse(tokens.accessTokenExpiresAt) : Date.now() + 10 * 60_000;
  return token;
}

/** A valid store visitor token, starting the session (once, shared by concurrent callers) when there is none. */
async function storeToken(): Promise<string> {
  if (token && expiresAt - Date.now() > 30_000) return token;
  return (starting ??= start().finally(() => (starting = null)));
}

/** Forgets the token: the next call starts a fresh visitor session (the Reload button). */
export function resetStoreSession(): void {
  token = null;
  expiresAt = 0;
}

async function send(path: string, init: RequestInit, bearer: string): Promise<Response> {
  return fetch(path, { ...init, credentials: 'omit', headers: { ...init.headers, 'X-Client': 'web', Authorization: `Bearer ${bearer}` } });
}

/** GET a store endpoint as a visitor; a 401 starts a new session once and retries. */
export async function storeGet<T>(path: string): Promise<T> {
  let res = await send(path, { method: 'GET' }, await storeToken());
  if (res.status === 401) {
    resetStoreSession();
    res = await send(path, { method: 'GET' }, await storeToken());
  }
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

async function storePost<T>(path: string, body: unknown): Promise<T> {
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  let res = await send(path, init, await storeToken());
  if (res.status === 401) {
    resetStoreSession();
    res = await send(path, init, await storeToken());
  }
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

/** A store call as a query: `useStore(['home'], '/api/store/content/home?device=app')`. */
export function useStore<T>(key: readonly unknown[], path: string | null): UseQueryResult<T> {
  return useQuery<T>({
    queryKey: ['app-preview', ...key],
    enabled: path !== null,
    queryFn: () => storeGet<T>(path!),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------- types (the app's models, core/model + feature/*)

export interface MediaRef {
  id?: string | null;
  url?: string | null;
  alt?: string | null;
  thumbUrl?: string | null;
  detailUrl?: string | null;
}
export interface Money {
  amount: number;
  currency?: string;
  formatted?: string | null;
}
export interface LinkRef {
  label?: string | null;
  url?: string | null;
  kind?: string | null;
}
export interface Page<T> {
  items: T[];
  nextCursor?: string | null;
  total?: number | null;
}

export interface ProductTile {
  productId: string;
  slug?: string | null;
  offerId?: string | null;
  title: string;
  image?: MediaRef | null;
  price?: Money | null;
  wasPrice?: Money | null;
  fromPrice?: boolean;
  sellerName?: string | null;
  officialStore?: boolean;
  rating?: number | null;
  ratingCount?: number | null;
  availability?: string | null;
  badge?: string | null;
}

export interface ProductCard {
  productId: string;
  slug?: string;
  title?: string;
  brandName?: string | null;
  image?: MediaRef | null;
  variantId?: string | null;
  variantCue?: string | null;
  rating?: number | null;
  ratingCount?: number;
  price?: Money | null;
  priceIsFrom?: boolean;
  offerId?: string | null;
  sellerName?: string | null;
  sellerId?: string | null;
  sellerSlug?: string | null;
  official?: boolean;
  wasPrice?: Money | null;
  discountPct?: number | null;
  deliveryCue?: string | null;
  freeDelivery?: boolean;
  availability?: string | null;
  offerCount?: number;
  sponsored?: boolean;
}

export interface CategoryTile {
  categoryId: string;
  slug?: string | null;
  name: string;
  image?: MediaRef | null;
}
export interface DepartmentTile {
  id: string;
  title: string;
  label?: string | null;
  icon?: string | null;
  image?: MediaRef | null;
  tint?: number | null;
  link?: LinkRef | null;
}
export interface SellerTile {
  sellerId: string;
  sellerSlug?: string | null;
  name: string;
  logo?: MediaRef | null;
  verified?: boolean;
  positivePct?: number | null;
  location?: string | null;
  dispatchLabel?: string | null;
}
export interface BrandTile {
  brandId: string;
  slug?: string | null;
  pageSlug?: string | null;
  name: string;
  logo?: MediaRef | null;
  productCount?: number;
}
export interface PromiseItem {
  icon?: string | null;
  title: string;
  body: string;
}
export interface BannerBlock {
  eyebrow?: string | null;
  headline: string;
  body?: string | null;
  images?: MediaRef[];
  primaryCta?: LinkRef | null;
  secondaryCta?: LinkRef | null;
  theme?: string | null;
}
export interface NewsCategoryRef {
  id: string;
  slug: string;
  name: string;
  icon?: string | null;
}
export interface NewsCard {
  id: string;
  slug: string;
  url?: string | null;
  title: string;
  summary?: string | null;
  category: NewsCategoryRef;
  cover?: MediaRef | null;
  pinned?: boolean;
  publishedAt: string;
}
export interface FlashItem {
  id: string;
  offerId?: string | null;
  productId: string;
  title: string;
  image?: MediaRef | null;
  sellerId?: string | null;
  sellerName?: string;
  sellerSlug?: string | null;
  dealPrice?: Money | null;
  regularPrice?: Money | null;
  percentOffBps?: number | null;
  claimedPct?: number;
  purchaseLimit?: number | null;
  state?: string;
  soldOutAt?: string | null;
}
export interface SchedulePeriod {
  startsAt?: string | null;
  endsAt?: string | null;
  timeZone?: string | null;
  display?: string;
}
export interface FlashSaleBlock {
  campaignId: string;
  name: string;
  state: string;
  secondsLeft: number;
  period?: SchedulePeriod;
  items: FlashItem[];
}

export interface HomeSection {
  id: string;
  kind: string;
  heading?: string | null;
  subheading?: string | null;
  link?: LinkRef | null;
  news?: NewsCard[];
  banner?: BannerBlock | null;
  products?: ProductTile[];
  categories?: CategoryTile[];
  departments?: DepartmentTile[];
  sellers?: SellerTile[];
  brands?: BrandTile[];
  deals?: FlashSaleBlock[] | null;
  promiseItems?: PromiseItem[];
  adPlacementKey?: string | null;
}
export interface Homepage {
  version: number;
  generatedAt?: string | null;
  sections: HomeSection[];
}

export interface Category {
  id: string;
  parentId?: string | null;
  name: string;
  slug: string;
  visible?: boolean;
  comingSoon?: boolean;
  productCount?: number;
  image?: MediaRef | null;
  children?: Category[];
}
export interface CategoryDetail {
  category: Category;
  breadcrumb?: Category[];
}

export interface SearchHit {
  position?: number;
  kind?: string;
  product: ProductCard;
}
export interface SortOption {
  key: string;
  label: string;
  available?: boolean;
  selected?: boolean;
}
export interface SearchContext {
  searchId?: string | null;
  total?: number;
  totalLabel?: string;
  sorts?: SortOption[];
  fromPriceNote?: string | null;
  rankingNote?: string | null;
}

export interface Brand {
  id: string;
  slug: string;
  name: string;
  logo?: MediaRef | null;
  productCount?: number;
}

export interface CatalogVariant {
  id: string;
  options?: Record<string, string>;
  images?: MediaRef[];
}
export interface CatalogProduct {
  id: string;
  ref?: string | null;
  title: string;
  slug: string;
  brand?: { id?: string | null; name: string; slug?: string | null } | null;
  categoryPath?: string[];
  description?: string;
  keyFeatures?: string[];
  specs?: Record<string, unknown>;
  includedItems?: string[];
  images?: MediaRef[];
  variants?: CatalogVariant[];
  listedAt?: string | null;
  isNewListing?: boolean | null;
}

export interface OfferView {
  offerId: string;
  seller?: { name?: string; official?: boolean; verified?: boolean; storeSlug?: string | null; positivePct?: number | null; location?: string | null };
  conditionLabel?: string;
  price: Money;
  compareAt?: { amount: Money } | null;
  discountPct?: number | null;
  promotion?: { label?: string; endsAt?: string | null } | null;
  delivery?: { label?: string; free?: boolean; shippingCost?: Money | null; shipsFrom?: string; dispatchLabel?: string | null };
  total?: Money | null;
  availability?: { state?: string; label?: string | null; quantity?: number | null };
  returns?: { summary?: string };
  warranty?: { summary?: string };
}
export interface VariantAvailability {
  variantId: string;
  options?: Record<string, string>;
  label?: string;
  lowestPrice?: Money | null;
  inStock?: boolean;
  summary?: string;
}
export interface PurchaseBox {
  variantId?: string | null;
  deliverTo?: { label?: string } | null;
  selected?: OfferView | null;
  otherOffers?: { count?: number; lowestPrice?: Money | null; label?: string | null };
  variants?: VariantAvailability[];
  unavailable?: { title?: string | null; message?: string | null } | null;
}
export interface RatingSummary {
  hasReviews?: boolean;
  average?: number | null;
  ratingCount?: number;
  answeredQuestions?: number;
}

export interface CouponCard {
  campaignId: string;
  code?: string | null;
  title: string;
  amountLabel?: string;
  unitLabel?: string;
  conditions?: string;
  fundedBy?: string;
  expiresAt?: string | null;
  state?: string;
  autoApply?: boolean;
}
export interface DealProduct {
  productId: string;
  offerId?: string | null;
  title: string;
  image?: MediaRef | null;
  sellerName?: string | null;
  sellerSlug?: string | null;
  price?: Money | null;
  wasPrice?: Money | null;
  endsAt?: string | null;
  stockLeft?: number | null;
}
export interface UpcomingEvent {
  campaignId: string;
  name: string;
  period?: SchedulePeriod;
  summary?: string;
}
export interface DealsPage {
  serverTime?: string;
  tabs: Array<{ key: string; label: string; count?: number }>;
  flashSales: FlashSaleBlock[];
  coupons: CouponCard[];
  clearance: DealProduct[];
  upcomingEvents: UpcomingEvent[];
  rules?: string[];
}

export interface CampaignPageCard {
  id: string;
  slug: string;
  url?: string | null;
  title: string;
  eyebrow?: string | null;
  image?: MediaRef | null;
  endsAt?: string | null;
}
export interface PageBlock {
  type: string;
  id: string;
  title?: string | null;
  icon?: string | null;
  body?: string | null;
  banner?: BannerBlock | null;
  products?: ProductTile[];
  link?: LinkRef | null;
}
export interface StorePage {
  id?: string;
  kind?: string;
  collectionKind?: string | null;
  title: string;
  slug: string;
  eyebrow?: string | null;
  intro?: string | null;
  curator?: { name?: string; updatedAt?: string | null; productCount?: number } | null;
  endsInSeconds?: number | null;
  blocks?: PageBlock[];
  notes?: string[];
}

export interface AdImpression {
  impressionToken: string;
  label?: string;
  advertiserName?: string;
  eyebrow?: string | null;
  headline: string;
  body?: string | null;
  footnote?: string | null;
  buttonText?: string;
  image?: MediaRef | null;
  destination?: string;
}
export interface AdDecision {
  slots?: Record<string, AdImpression[]>;
  rotationSeconds?: number | null;
}

/**
 * The ads of one page's inline slots, as the app asks for them (`POST advertising/decisions`, device `app`).
 * `isEntryPage` stays false and `overlayShownThisSession` true so the preview is never served an opening ad or a
 * pop-up, and no display or click event is ever sent: a preview must not be billed to an advertiser.
 */
export function adDecision(page: string, slots: string[], context: { categoryId?: string } = {}): Promise<AdDecision> {
  return storePost<AdDecision>('/api/store/advertising/decisions', {
    page,
    context,
    device: 'app',
    visitorId: INSTALLATION_ID,
    sessionId: PREVIEW_VISIT_ID,
    isEntryPage: false,
    slots,
    overlayShownThisSession: true,
    personalizationAllowed: false,
  });
}

// ---------------------------------------------------------------- the app's small helpers

/** `MoneyFormat.format`: the server's text when it sends one, else "$149.00". */
export const price = (m?: Money | null): string => (!m ? '' : (m.formatted ?? formatMoney({ amount: m.amount, currency: m.currency ?? 'USD' })));

/** `MoneyFormat.percentOffBps`: 2100 → "−21%". */
export const percentOffBps = (bps?: number | null): string | null => (bps && bps > 0 ? `−${Math.round(bps / 100)}%` : null);

/** `ProductCardModel.discountLabel`: the percentage badge on a card, from the two prices or a given percentage. */
export function discountLabel(p?: Money | null, was?: Money | null, pct?: number | null): string | null {
  if (pct && pct > 0) return `−${pct}%`;
  if (!p || !was || was.amount <= p.amount || was.amount === 0) return null;
  const n = Math.trunc(((was.amount - p.amount) * 100) / was.amount);
  return n > 0 ? `−${n}%` : null;
}

export { initials, num, tileTint };

/** The app's plurals with `grouped()`: "1 item", "1,284 items". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${num(n)} ${n === 1 ? one : many}`;

/** `String.decodeEntities()`: content text may carry HTML entities ("Pixel &amp; Port"). */
export function decodeEntities(text: string | null | undefined): string {
  const s = text ?? '';
  if (!s.includes('&')) return s;
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

/** What a product card shows, whatever it came from (`ProductCardModel`). */
export interface CardModel {
  productId: string;
  slug: string;
  title: string;
  image?: MediaRef | null;
  price?: Money | null;
  wasPrice?: Money | null;
  priceIsFrom: boolean;
  rating?: number | null;
  ratingCount: number;
  deliveryCue?: string | null;
  freeDelivery: boolean;
  sellerName?: string | null;
  sellerSlug?: string | null;
  official: boolean;
  offerId?: string | null;
  outOfStock: boolean;
  discountLabel: string | null;
  sponsored: boolean;
  variantId?: string | null;
}

const OFFICIAL_SELLER_ID = '00000000-0000-7000-8000-000000000001';

/** `ProductCardModel.fromCard`: a search / listing card. */
export function cardOf(c: ProductCard): CardModel {
  return {
    productId: c.productId,
    slug: c.slug ?? '',
    title: c.title ?? '',
    image: c.image,
    price: c.price,
    wasPrice: c.wasPrice,
    priceIsFrom: !!c.priceIsFrom || (c.offerCount ?? 0) > 1,
    rating: c.rating,
    ratingCount: c.ratingCount ?? 0,
    deliveryCue: c.deliveryCue,
    freeDelivery: !!c.freeDelivery,
    sellerName: c.sellerName,
    sellerSlug: c.sellerSlug,
    official: !!c.official || c.sellerId === OFFICIAL_SELLER_ID,
    offerId: c.offerId,
    outOfStock: c.availability === 'out_of_stock',
    discountLabel: discountLabel(c.price, c.wasPrice, c.discountPct),
    sponsored: !!c.sponsored,
    variantId: c.variantId,
  };
}

/** `ProductCardModel.from`: a section tile, with the card details (delivery, seller slug, offer, stock) over it. */
export function tileOf(t: ProductTile, card?: ProductCard): CardModel {
  return {
    productId: t.productId,
    slug: t.slug ?? card?.slug ?? '',
    title: t.title || (card?.title ?? ''),
    image: t.image ?? card?.image,
    price: t.price ?? card?.price,
    wasPrice: t.wasPrice ?? card?.wasPrice,
    priceIsFrom: !!t.fromPrice || !!card?.priceIsFrom || (card?.offerCount ?? 0) > 1,
    rating: t.rating ?? card?.rating,
    ratingCount: t.ratingCount ?? card?.ratingCount ?? 0,
    deliveryCue: card?.deliveryCue,
    freeDelivery: card?.freeDelivery === true,
    sellerName: t.sellerName ?? card?.sellerName,
    sellerSlug: card?.sellerSlug,
    official: !!t.officialStore || card?.official === true || card?.sellerId === OFFICIAL_SELLER_ID,
    offerId: t.offerId ?? card?.offerId,
    outOfStock: (t.availability ?? card?.availability) === 'out_of_stock',
    discountLabel: t.badge ?? discountLabel(t.price, t.wasPrice, card?.discountPct),
    sponsored: false,
    variantId: null,
  };
}

// ---------------------------------------------------------------- the department pages (feature/{phones,farm,software,services,food,blogs,companies,play,rewards})

export interface PhoneCard {
  id: string;
  slug: string;
  brand?: string;
  name: string;
  /** First storage · first colour, e.g. "256 GB · Titanium Gray". */
  meta?: string;
  price: Money;
  was?: Money | null;
  dealPercent?: number | null;
  image?: MediaRef | null;
}
export interface PhonesPage {
  phones: PhoneCard[];
  brands: string[];
}

export interface FarmType {
  id: string;
  name: string;
  slug?: string;
}
export interface FarmMachineCard {
  product: ProductCard;
  typeId?: string;
  highlights?: string[];
}
export interface FarmPage {
  types: FarmType[];
  machines: FarmMachineCard[];
}
export interface DealerCard {
  id: string;
  name: string;
  addressLabel?: string;
  city?: string;
  distanceLabel?: string | null;
  metaLabel?: string;
  hours?: string;
  phone?: string;
}

export interface AppPrice {
  free?: boolean;
  current?: Money | null;
  label?: string;
  wasLabel?: string | null;
  offPercent?: number | null;
}
export interface AppCard {
  id: string;
  slug: string;
  title: string;
  company?: { name?: string; companySlug?: string | null };
  brief?: string;
  icon?: MediaRef | null;
  category?: { slug?: string; name?: string };
  rating?: number | null;
  ratingCount?: number;
  sizeLabel?: string;
  price?: AppPrice;
  owned?: boolean;
}
export interface SoftwareRail {
  key: string;
  title: string;
  /** manual | newest | category | platform | top_rated */
  source?: string;
  /** carousel | list */
  style?: string;
  apps: AppCard[];
  seeAll?: string | null;
}
export interface PackCard {
  id: string;
  slug: string;
  name: string;
  apps?: Array<{ id: string; slug: string; title: string; icon?: MediaRef | null }>;
  count?: number;
  priceLabel?: string;
  totalLabel?: string;
  savePercent?: number;
  licenceLabel?: string | null;
  summary?: string | null;
  owned?: boolean;
}
export interface SoftwareHome {
  rails: SoftwareRail[];
  featuredPack?: PackCard | null;
}
export interface SoftwareCategory {
  id: string;
  slug: string;
  name: string;
  icon?: string | null;
  position?: number;
  visible?: boolean;
  appCount?: number;
}
export interface SoftwareDeals {
  packs: PackCard[];
  discounts: AppCard[];
  discountsUntilLabel?: string | null;
}

export interface RatingSummary {
  average?: number | null;
  count?: number;
}
export interface ServiceCategory {
  id: string;
  slug: string;
  name: string;
  icon?: string | null;
  visible?: boolean;
  position?: number;
}
export interface ServiceCard {
  id: string;
  slug: string;
  area?: string;
  title: string;
  summary?: string | null;
  image?: MediaRef | null;
  category?: { slug?: string; name?: string } | null;
  provider?: { id?: string; slug?: string; name?: string; verified?: boolean } | null;
  badge?: string | null;
  fromPrice?: Money | null;
  /** fixed | hour | visit | night | free */
  priceUnit?: string;
  coverage?: string | null;
  tags?: string[];
  rating?: RatingSummary;
  distance?: string | null;
}
export interface ProviderCard {
  id: string;
  slug: string;
  name: string;
  logo?: MediaRef | null;
  cover?: MediaRef | null;
  kind?: string | null;
  category?: { id?: string; slug?: string; name?: string } | null;
  city?: string | null;
  verified?: boolean;
  rating?: RatingSummary;
  fromPrice?: Money | null;
  nextFree?: string | null;
  distance?: string | null;
}
/** `services.CustomerArea`: where the customer is; a guest is never located, so the preview hides what needs it. */
export interface CustomerArea {
  located?: boolean;
  city?: string | null;
}

export interface FoodCategory {
  id: string;
  slug: string;
  name: string;
  icon?: string | null;
  image?: MediaRef | null;
  position?: number;
  visible?: boolean;
  restaurantCount?: number;
}
export interface RestaurantCard {
  id: string;
  slug: string;
  name: string;
  cuisine?: string;
  image?: MediaRef | null;
  logo?: MediaRef | null;
  city?: string | null;
  rating?: number | null;
  ratingCount?: number;
  deliveryLabel?: string;
  feeLabel?: string;
  promoBadge?: string | null;
  open?: boolean;
  openLabel?: string;
  distanceLabel?: string | null;
}
export interface MenuItemCard {
  id: string;
  restaurantId?: string;
  restaurantName?: string;
  restaurantSlug?: string;
  name: string;
  description?: string | null;
  image?: MediaRef | null;
  price?: Money | null;
  priceLabel?: string;
  wasLabel?: string | null;
  badge?: string | null;
  rating?: number | null;
  ratingCount?: number;
  available?: boolean;
}

export interface BlogTopic {
  id: string;
  slug: string;
  name: string;
  visible?: boolean;
  postCount?: number;
}
export interface BlogPostCard {
  id: string;
  slug: string;
  title: string;
  summary?: string;
  cover?: MediaRef | null;
  topic?: { slug?: string; name?: string } | null;
  author?: { slug?: string; name?: string; avatar?: MediaRef | null } | null;
  publishedAt?: string | null;
  readMinutes?: number;
  likeCount?: number;
  replyCount?: number;
  featured?: boolean;
}

export interface Industry {
  id: string;
  slug: string;
  name: string;
  visible?: boolean;
  companyCount?: number;
}
export interface CompanyCard {
  id: string;
  slug: string;
  name: string;
  logo?: MediaRef | null;
  industry?: { slug?: string; name?: string } | null;
  city?: string | null;
  tagline?: string | null;
  verified?: boolean;
  rating?: number | null;
  ratingCount?: number;
}

export interface GameCard {
  id: string;
  slug: string;
  title: string;
  genre?: string;
  icon?: MediaRef | null;
  cover?: MediaRef | null;
  playersLabel?: string | null;
  featured?: boolean;
  hasPrizes?: boolean;
  rating?: number | null;
  ratingCount?: number;
}
export interface PlayGames {
  games: GameCard[];
  genres: string[];
}
export interface RankingEntry {
  rank: number;
  name: string;
  score: number;
  change?: number | null;
  mine?: boolean | null;
}
export interface RankingTable {
  game?: GameCard | null;
  period?: string;
  entries: RankingEntry[];
  updatedAt?: string | null;
  week?: { endsOn?: string | null } | null;
}

// ---------------------------------------------------------------- the department sub-pages

export interface PhoneStorage {
  size: string;
  price: Money;
  was?: Money | null;
}
export interface PhoneColor {
  name: string;
  short?: string | null;
  hex?: string;
}
export interface PhonePhoto {
  id: string;
  url: string;
  thumbUrl?: string | null;
  alt?: string | null;
}
export interface PhoneSpecGroup {
  name?: string;
  rows: Array<{ name?: string; value?: string }>;
}
export interface Phone {
  id: string;
  slug: string;
  brand?: string;
  name: string;
  overview?: string | null;
  storage?: PhoneStorage[];
  colors?: PhoneColor[];
  photos?: PhonePhoto[];
  adImages?: PhonePhoto[];
  specGroups?: PhoneSpecGroup[];
  showServices?: boolean;
}

export interface FarmMachine {
  product: ProductCard;
  typeId?: string;
  highlights?: string[];
  attachments?: ProductCard[];
}

export interface SoftwareApp extends AppCard {
  subcategory?: string | null;
  screenshots?: MediaRef[];
  description?: string;
  moreDescription?: string | null;
  whatYouGet?: string[];
  licenceLabel?: string | null;
  licenceDevices?: string | null;
  version?: string | null;
  whatsNew?: string | null;
  platformLabels?: string[];
  minRequirements?: string[];
  notice?: string | null;
  views?: number;
  downloads?: number;
  ratings?: RatingSummary & { stars?: number[] };
}

export interface PriceTableRow {
  label?: string;
  detail?: string | null;
  price?: string;
}
export interface ServiceDetail extends ServiceCard {
  photos?: MediaRef[];
  description?: string | null;
  included?: string[];
  requirements?: string[];
  priceTable?: PriceTableRow[];
  priceTableTitle?: string | null;
  terms?: string[];
  steps?: string[];
  firstAvailable?: string | null;
}

export interface OpenDay {
  weekday: string;
  open?: boolean;
  from?: string | null;
  to?: string | null;
}
export interface ProviderDetail extends ProviderCard {
  photos?: MediaRef[];
  description?: string | null;
  since?: number | null;
  address?: string | null;
  openLabel?: string | null;
  replyTime?: string | null;
  contacts?: { phone?: string | null; email?: string | null; website?: string | null; address?: string | null } | null;
  hours?: { days?: OpenDay[] } | null;
  staff?: Array<{ id: string; name: string; role?: string | null }>;
  services?: ServiceCard[];
}

export interface MenuSection {
  name?: string;
  items: MenuItemCard[];
}
export interface RestaurantDetail extends RestaurantCard {
  photos?: MediaRef[];
  address?: string | null;
  phone?: string | null;
  ratings?: RatingSummary;
  minOrderLabel?: string | null;
  promoText?: string | null;
  hours?: OpenDay[];
  sections?: MenuSection[];
}

export interface FoodItemDetail {
  id: string;
  restaurant?: RestaurantCard | null;
  name: string;
  description?: string | null;
  photos?: MediaRef[];
  price?: Money | null;
  priceLabel?: string;
  wasLabel?: string | null;
  badge?: string | null;
  dietTags?: string[];
  rating?: number | null;
  ratingCount?: number;
  available?: boolean;
  optionGroups?: Array<{ id: string; name?: string; required?: boolean; options?: Array<{ id: string; name?: string; priceLabel?: string | null }> }>;
}

export interface BlogPost extends BlogPostCard {
  body?: string;
  dislikeCount?: number;
  authorPostCount?: number;
  authorLikeCount?: number;
  previous?: { slug: string; title: string } | null;
  next?: { slug: string; title: string } | null;
}
export interface BlogAuthor {
  id: string;
  slug: string;
  name: string;
  avatar?: MediaRef | null;
  bio?: string | null;
  postCount?: number;
  likeCount?: number;
  followerCount?: number;
}

export interface CompanyDetail extends CompanyCard {
  description?: string | null;
  photos?: MediaRef[];
  founded?: number | null;
  employees?: string | null;
  contacts?: { phone?: string | null; email?: string | null; website?: string | null; address?: string | null } | null;
  ratingSummary?: RatingSummary;
}

export interface GameDetail extends GameCard {
  description?: string | null;
  howToPlay?: string[];
  prizes?: Array<{ ranks?: string; reward?: string }>;
  prizeNote?: string | null;
  week?: { endsOn?: string | null } | null;
  ratingSummary?: RatingSummary;
}

/** Card details for section tiles, in one call like the app's `GET search/cards?ids=`. */
export function useCards(ids: string[]): Record<string, ProductCard> {
  const key = [...new Set(ids)].sort();
  const q = useStore<ProductCard[]>(['cards', key.join(',')], key.length ? `/api/store/search/cards?${key.map((id) => `ids=${encodeURIComponent(id)}`).join('&')}` : null);
  const out: Record<string, ProductCard> = {};
  for (const c of q.data ?? []) out[c.productId] = c;
  return out;
}

// ---------------------------------------------------------------- placeholder art (frontend/src/api/catalog.ts, core/ui/Art.kt)

const CATEGORY_ART: Record<string, { icon: IconName; tint: string }> = {
  electronics: { icon: 'headphones', tint: '2' },
  headphones: { icon: 'headphones', tint: '2' },
  speakers: { icon: 'speaker', tint: '2' },
  'smart-home': { icon: 'house', tint: '2' },
  cameras: { icon: 'camera', tint: '2' },
  wearables: { icon: 'watch', tint: '2' },
  computers: { icon: 'monitor', tint: '6' },
  monitors: { icon: 'monitor', tint: '6' },
  storage: { icon: 'hard-drive', tint: '6' },
  keyboards: { icon: 'keyboard', tint: '6' },
  laptops: { icon: 'laptop', tint: '6' },
  accessories: { icon: 'usb', tint: '6' },
  'home-and-kitchen': { icon: 'cooking-pot', tint: '3' },
  cookware: { icon: 'cooking-pot', tint: '3' },
  bedding: { icon: 'bed-double', tint: '3' },
  lighting: { icon: 'lamp-desk', tint: '3' },
  'coffee-and-tea': { icon: 'coffee', tint: '3' },
  cleaning: { icon: 'bot', tint: '3' },
  fashion: { icon: 'shirt', tint: '4' },
  knitwear: { icon: 'shirt', tint: '4' },
  shoes: { icon: 'footprints', tint: '4' },
  bags: { icon: 'shopping-bag', tint: '4' },
  outerwear: { icon: 'shirt', tint: '4' },
  'accessories-2': { icon: 'watch', tint: '4' },
  'sports-and-outdoors': { icon: 'tent', tint: '1' },
  hiking: { icon: 'backpack', tint: '1' },
  running: { icon: 'footprints', tint: '1' },
  yoga: { icon: 'activity', tint: '1' },
  cycling: { icon: 'gauge', tint: '1' },
  camping: { icon: 'tent', tint: '1' },
  beauty: { icon: 'sparkles', tint: '5' },
  skincare: { icon: 'droplet', tint: '5' },
  hair: { icon: 'scissors', tint: '5' },
  fragrance: { icon: 'flower-2', tint: '5' },
  bath: { icon: 'sparkles', tint: '5' },
  'toys-and-games': { icon: 'puzzle', tint: '3' },
  puzzles: { icon: 'puzzle', tint: '3' },
  'board-games': { icon: 'layout-grid', tint: '3' },
  'building-sets': { icon: 'boxes', tint: '3' },
  'pet-supplies': { icon: 'paw-print', tint: '2' },
  dog: { icon: 'paw-print', tint: '2' },
  cat: { icon: 'paw-print', tint: '2' },
  'small-pets': { icon: 'paw-print', tint: '2' },
  'garden-and-outdoor': { icon: 'flower-2', tint: '1' },
  automotive: { icon: 'car', tint: '6' },
};

/** Icon and tint for a category tile with no image: its own art, else its parent's, else a package (`Art.category`). */
export const categoryArt = (slug?: string | null, parentSlug?: string | null): { icon: IconName; tint: string } =>
  CATEGORY_ART[slug ?? ''] ?? { icon: CATEGORY_ART[parentSlug ?? '']?.icon ?? 'package', tint: CATEGORY_ART[parentSlug ?? '']?.tint ?? '1' };

// ---------------------------------------------------------------- the preview's router (core/nav/Links.kt)

/** The department pages, which exist only in the app (the same ten as DEPARTMENT_PAGES in ContentDepartments.tsx). */
export type DeptKey = 'phones' | 'farm' | 'software' | 'welfare' | 'food' | 'booking' | 'blogs' | 'companies' | 'play' | 'rewards';

export type Route =
  | { kind: 'home' }
  | { kind: 'categories' }
  | { kind: 'category'; slug: string }
  | { kind: 'product'; slug: string; id: string }
  | { kind: 'deals' }
  | { kind: 'news' }
  | { kind: 'news-post'; slug: string }
  | { kind: 'page'; slug: string }
  | { kind: 'department'; dept: DeptKey; query: URLSearchParams }
  | { kind: 'dept-phone'; slug: string }
  | { kind: 'dept-service'; area: 'os_install' | 'post_sale' | 'welfare'; slug: string }
  | { kind: 'dept-machine'; productId: string }
  | { kind: 'dept-app'; slug: string }
  | { kind: 'dept-apps'; query: URLSearchParams }
  | { kind: 'dept-provider'; slug: string }
  | { kind: 'dept-restaurant'; slug: string }
  | { kind: 'dept-food-item'; id: string }
  | { kind: 'dept-food-list'; what: 'restaurants' | 'items'; query: URLSearchParams }
  | { kind: 'dept-post'; slug: string }
  | { kind: 'dept-author'; slug: string }
  | { kind: 'dept-company'; slug: string }
  | { kind: 'dept-game'; slug: string }
  | { kind: 'elsewhere'; path: string };

/** Screens the preview draws, in the order of the picker. */
export const PREVIEW_SCREENS: Array<{ path: string; label: string }> = [
  { path: '/', label: 'Home' },
  { path: '/categories', label: 'Categories' },
  { path: '/deals', label: 'Deals' },
  { path: '/news', label: 'News' },
];

/**
 * The department pages in the Departments rail's order, with the titles and icons the Admin Center's Departments
 * section uses (DEPARTMENT_PAGES in ContentDepartments.tsx, itself the API's content domain rule).
 */
export const PREVIEW_DEPARTMENTS: Array<{ key: DeptKey; path: string; label: string; icon: IconName }> = [
  { key: 'phones', path: '/phones', label: 'Phones', icon: 'smartphone' },
  { key: 'farm', path: '/farm-machines', label: 'Farm machines', icon: 'tractor' },
  { key: 'software', path: '/software', label: 'Softwares', icon: 'app-window' },
  { key: 'welfare', path: '/welfare', label: 'Welfare services', icon: 'hand-heart' },
  { key: 'food', path: '/food', label: 'Food delivery', icon: 'utensils' },
  { key: 'booking', path: '/booking', label: 'Booking', icon: 'calendar-check' },
  { key: 'blogs', path: '/blogs', label: 'Blogs', icon: 'newspaper' },
  { key: 'companies', path: '/companies', label: 'Companies', icon: 'building-2' },
  { key: 'play', path: '/play', label: 'Play center', icon: 'gamepad-2' },
  { key: 'rewards', path: '/rewards', label: 'Daily rewards', icon: 'gift' },
];
const DEPT_BY_PATH = new Map(PREVIEW_DEPARTMENTS.map((d) => [d.path, d.key]));
export const deptLabel = (key: DeptKey): string => PREVIEW_DEPARTMENTS.find((d) => d.key === key)?.label ?? '';

/** A store path (what `Links.open` takes) as the screen that draws it. */
export function routeOf(path: string): Route {
  const [raw, search] = path.split('?');
  const clean = (raw || '/').replace(/\/+$/, '') || '/';
  const parts = clean.split('/').filter(Boolean);
  const query = new URLSearchParams(search ?? '');
  if (clean === '/') return { kind: 'home' };
  if (clean === '/categories') return { kind: 'categories' };
  if (clean === '/deals') return { kind: 'deals' };
  if (clean === '/news') return { kind: 'news' };
  const dept = DEPT_BY_PATH.get(clean);
  if (dept) return { kind: 'department', dept, query };
  // /play/rankings opens the Play center on its Rankings tab, like the app's deep link.
  if (clean === '/play/rankings') return { kind: 'department', dept: 'play', query: new URLSearchParams('tab=rankings') };

  // The department sub-pages a card or tile opens. The longer paths are matched before the shorter ones
  // (/blogs/authors/{slug} before /blogs/{slug}, /food/restaurants/{slug} before the restaurants list).
  if (parts[0] === 'phones' && parts.length === 3 && (parts[1] === 'os-install' || parts[1] === 'post-sale')) {
    return { kind: 'dept-service', area: parts[1] === 'os-install' ? 'os_install' : 'post_sale', slug: parts[2] };
  }
  // /phones/os-install and /phones/post-sale without a service are the Phones page on that tab.
  if (parts[0] === 'phones' && parts.length === 2 && (parts[1] === 'os-install' || parts[1] === 'post-sale')) {
    return { kind: 'department', dept: 'phones', query: new URLSearchParams(`tab=${parts[1]}`) };
  }
  if (parts[0] === 'phones' && parts.length === 2) return { kind: 'dept-phone', slug: parts[1] };
  if (parts[0] === 'welfare' && parts.length === 2) return { kind: 'dept-service', area: 'welfare', slug: parts[1] };
  if (parts[0] === 'farm-machines' && parts.length === 2) return { kind: 'dept-machine', productId: parts[1] };
  if (parts[0] === 'software' && parts[1] === 'app' && parts[2]) return { kind: 'dept-app', slug: parts[2] };
  if (parts[0] === 'software' && parts[1] === 'apps') return { kind: 'dept-apps', query };
  if ((parts[0] === 'booking' || parts[0] === 'providers') && parts.length === 2) return { kind: 'dept-provider', slug: parts[1] };
  if (parts[0] === 'food' && parts[1] === 'restaurants' && parts[2]) return { kind: 'dept-restaurant', slug: parts[2] };
  if (parts[0] === 'food' && parts[1] === 'restaurants') return { kind: 'dept-food-list', what: 'restaurants', query };
  if (parts[0] === 'food' && parts[1] === 'items' && parts[2]) return { kind: 'dept-food-item', id: parts[2] };
  if (parts[0] === 'food' && parts[1] === 'items') return { kind: 'dept-food-list', what: 'items', query };
  if (parts[0] === 'blogs' && parts[1] === 'authors' && parts[2]) return { kind: 'dept-author', slug: parts[2] };
  if (parts[0] === 'blogs' && parts.length === 2) return { kind: 'dept-post', slug: parts[1] };
  if (parts[0] === 'companies' && parts.length === 2) return { kind: 'dept-company', slug: parts[1] };
  if (parts[0] === 'play' && parts[1] === 'games' && parts[2]) return { kind: 'dept-game', slug: parts[2] };
  if (parts[0] === 'c' && parts[1]) return { kind: 'category', slug: parts[1] };
  if (parts[0] === 'p' && parts[1] && parts[2]) return { kind: 'product', slug: parts[1], id: parts[2] };
  if (parts[0] === 'news' && parts[1]) return { kind: 'news-post', slug: parts[1] };
  if ((parts[0] === 'pages' || parts[0] === 'collection') && parts[1]) return { kind: 'page', slug: parts[1] };
  return { kind: 'elsewhere', path: clean };
}

/** The tab that is lit for a screen; null where the app draws no tab bar. */
export function tabOf(route: Route): 'home' | 'categories' | 'deals' | null {
  return route.kind === 'home' ? 'home' : route.kind === 'categories' ? 'categories' : route.kind === 'deals' ? 'deals' : null;
}

export const productPath = (slug: string | null | undefined, id: string): string => (slug ? `/p/${slug}/${id}` : `/p/-/${id}`);
export const categoryPath = (slug: string): string => `/c/${slug}`;

// ---------------------------------------------------------------- the department pages' own formatting

/** `MoneyFormat.formatShort`: "$35" when there are no cents, else "$35.50" (farm, services, booking). */
export const priceShort = (m?: Money | null): string => {
  const s = price(m);
  return s.endsWith('.00') ? s.slice(0, -3) : s;
};

/** `priceText` of the services screens: "$24/hr", "$90/visit", "Free". */
export function servicePrice(m?: Money | null, unit = 'fixed'): string {
  if (unit === 'free' || (m != null && m.amount === 0 && unit !== 'fixed')) return 'Free';
  if (!m) return '';
  const p = priceShort(m);
  return unit === 'hour' ? `${p}/hr` : unit === 'visit' ? `${p}/visit` : unit === 'night' ? `${p}/night` : p;
}

/** "4.6", or null without ratings (`ratingText` of the departments). */
export const ratingValue = (r?: number | null): string | null => (r == null ? null : r.toFixed(1));

/** `BlogCards.compact`: 950 → "950", 3104 → "3.1k", 12000 → "12k". */
export function compactCount(n: number): string {
  if (n < 1000) return num(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
