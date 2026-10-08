import { notImplemented } from '../../kernel/errors/index.js';
import type { EventPayload } from '../../kernel/events/index.js';
import type { ModuleContext } from '../../kernel/module-system/index.js';
import type * as common from '../../spec/common.js';
import type { ContentPublicApi, ProductTile, Homepage, PageInput, StorePage, HelpArticleSummary, HelpArticle, HelpHome, PolicyVersionRef, PolicyVersion, PreviewRequest } from '../../spec/content.js';
import type { ContentRepository } from './ports.js';

export interface ContentServiceDeps {
  repo: ContentRepository;
  ctx: ModuleContext<'content'>;
}

/**
 * Content use cases. Depends only on ports, the event bus, the clock and other modules' public APIs.
 * Each method maps to a publicApi function, a consumed event or a job in docs/api/spec/modules/content.json.
 */
export class ContentService implements ContentPublicApi {
  readonly #deps: ContentServiceDeps;

  constructor(deps: ContentServiceDeps) {
    this.#deps = deps;
  }

  protected get deps(): ContentServiceDeps {
    return this.#deps;
  }

  /* ---------------- public API (in-process) */

  /** Policy versions in effect at a moment. Checkout and orders store these ids on the order so the order keeps the purchase terms and return policy accepted at purchase (plan ch. 3, 8). */
  async currentPolicyVersions(keys: string[], at?: string): Promise<PolicyVersionRef[]> {
    throw notImplemented('content.currentPolicyVersions');
  }

  /** Exact text of a version, e.g. for order details and disputes. */
  async getPolicyVersion(versionId: string): Promise<PolicyVersion> {
    throw notImplemented('content.getPolicyVersion');
  }

  /** Suggested articles for an order problem or case category. */
  async helpArticlesFor(topic: string, limit: number): Promise<HelpArticleSummary[]> {
    throw notImplemented('content.helpArticlesFor');
  }

  /** Public URL and status of a campaign page, used for ad destination link checks. */
  async pageLink(pageId: string): Promise<{ url: string, status: string, publishAt?: string, unpublishAt?: string } | null> {
    throw notImplemented('content.pageLink');
  }

  /** Published homepage sections in order with schedules applied (showFrom/removeAt), unavailable products hidden and ended promotions removed (GET /home). Product, offer, deal and stock data are resolved by their owning modules. */
  async getHomePage(ctx: { customerId?: string, device?: string, at?: string }): Promise<Homepage> {
    throw notImplemented('content.getHomePage');
  }

  /** The draft or live homepage as customers will see it at a given time on desktop or phone (POST /homepage/preview, a read). */
  async previewHomePage(req: PreviewRequest): Promise<Homepage> {
    throw notImplemented('content.previewHomePage');
  }

  /** A published campaign page, collection, About or landing page by slug, with blocks resolved (GET /pages/{slug}). */
  async getStorePage(slug: string): Promise<StorePage | null> {
    throw notImplemented('content.getStorePage');
  }

  /** The draft of a page as customers will see it (POST /pages/{id}/preview, a read). */
  async previewPage(pageId: string): Promise<StorePage> {
    throw notImplemented('content.previewPage');
  }

  /** Products of a collection page by its selection rule or manual list, page by page, optionally limited to a category tab (GET /pages/{slug}/products). */
  async collectionProducts(pageId: string, opts: { categoryId?: string, paging: PageInput }): Promise<common.Page<ProductTile>> {
    throw notImplemented('content.collectionProducts');
  }

  /** Help Center home: topics, popular articles, popular searches, contact channels and the seller-first note (GET /help). */
  async getHelpCenter(audience: 'customer' | 'seller'): Promise<HelpHome> {
    throw notImplemented('content.getHelpCenter');
  }

  /** A published help article with effective and updated dates, related articles and actions (GET /help/articles/{slug}). */
  async getHelpArticle(slug: string): Promise<HelpArticle | null> {
    throw notImplemented('content.getHelpArticle');
  }

  /** Published Help articles whose policyKeys include the policy (e.g. returns), so a policy change preview can say how many need review. */
  async countHelpArticlesForPolicy(policyKey: string): Promise<{ count: number, articleIds: string[] }> {
    throw notImplemented('content.countHelpArticlesForPolicy');
  }

  /* ---------------- events consumed */

  /** promotions.campaign.ended: Hide homepage sections linked to the promotion; flag linked campaign pages whose removal time is later */
  async onCampaignEndedFromPromotions(event: EventPayload<"promotions.campaign.ended">): Promise<void> {
    void event;
    throw notImplemented('content consumer of promotions.campaign.ended');
  }

  /** promotions.campaign.started: Refresh cached sections and pages linked to the promotion */
  async onCampaignStartedFromPromotions(event: EventPayload<"promotions.campaign.started">): Promise<void> {
    void event;
    throw notImplemented('content consumer of promotions.campaign.started');
  }

  /** catalog.product.publication_changed: Drop hidden or suspended products from manual selections (recorded in the next version) */
  async onProductPublicationChangedFromCatalog(event: EventPayload<"catalog.product.publication_changed">): Promise<void> {
    void event;
    throw notImplemented('content consumer of catalog.product.publication_changed');
  }

  /** catalog.product.merged: Replace the duplicate product id in sections and collections */
  async onProductMergedFromCatalog(event: EventPayload<"catalog.product.merged">): Promise<void> {
    void event;
    throw notImplemented('content consumer of catalog.product.merged');
  }

  /** offers.offer.status_changed: Invalidate cached product tiles */
  async onOfferStatusChangedFromOffers(event: EventPayload<"offers.offer.status_changed">): Promise<void> {
    void event;
    throw notImplemented('content consumer of offers.offer.status_changed');
  }

  /** inventory.stock.changed: Invalidate availability on curated collections */
  async onStockChangedFromInventory(event: EventPayload<"inventory.stock.changed">): Promise<void> {
    void event;
    throw notImplemented('content consumer of inventory.stock.changed');
  }

  /** sellers.seller.suspended: Remove the seller from Featured sellers and seller features */
  async onSellerSuspendedFromSellers(event: EventPayload<"sellers.seller.suspended">): Promise<void> {
    void event;
    throw notImplemented('content consumer of sellers.seller.suspended');
  }

  /** access.approval.decided: Complete Business Owner approval of a policy version or a short-notice schedule */
  async onApprovalDecidedFromAccess(event: EventPayload<"access.approval.decided">): Promise<void> {
    void event;
    throw notImplemented('content consumer of access.approval.decided');
  }

  /* ---------------- jobs */

  /** Job content.run-schedules (every 1 min): Publish and unpublish sections, pages and articles whose publishAt / unpublishAt has passed; record a homepage version when the visible layout changes */
  async runSchedules(): Promise<void> {
    throw notImplemented('job content.run-schedules');
  }

  /** Job content.policy-effective (every 1 min): Scheduled policy versions past effectiveAt → current; previous → superseded */
  async policyEffective(): Promise<void> {
    throw notImplemented('job content.policy-effective');
  }

  /** Job content.refresh-collections (hourly): Rebuild rule-based collections (best sellers hourly, new arrivals daily) and re-check availability of curated items, replacing or removing sold-out ones */
  async refreshCollections(): Promise<void> {
    throw notImplemented('job content.refresh-collections');
  }

  /** Job content.article-review-due (daily 07:00 market time): Flag articles not reviewed for articleReviewDays; notify their owners */
  async articleReviewDue(): Promise<void> {
    throw notImplemented('job content.article-review-due');
  }

  /** Job content.cache-warm (every 5 min): Rebuild the resolved homepage for desktop, phone and app */
  async cacheWarm(): Promise<void> {
    throw notImplemented('job content.cache-warm');
  }
}
