# Marketplace-specific UX/UI patterns (multi-seller), 2025–2026 — for Marketly

Researched 2026-10-12. About 20 search/fetch calls. Source quality varies a lot. Primary or near-primary sources: aboutamazon.com, Mercado Libre developer docs, Zalando partner docs, Etsy community and handbook, Baker McKenzie legal brief, Marketplace Pulse. Secondary or vendor blogs: Mercur, Rigby, Sharetribe, Zentail, amzdudes, Shopappy, Ginee, racklify. These are flagged inline where they matter. Baymard's detailed marketplace guidelines are paywalled, so only their public benchmark scope could be cited.

## 1. Offer selection: who sells it, multiple offers, condition, delivery, returns

### Takeaway
Every major marketplace shows one default offer with a short **"Sold by / Shipped by" line placed right under the buy button**. Other offers sit behind a secondary "other sellers / new & used" entry point, which opens a comparison list (price, condition, delivery date, seller rating). Fulfilment by the platform is signalled separately from who the seller is, and shoppers can filter by it.

### Cited Findings
- **Amazon**: the Buy Box sits on the right of the product page. "Ships from" and "Sold by" fields are shown under the buy button. When several sellers offer the item, a "New & Used" option shows the conditions and prices separately and opens a full seller list. Shoppers compare there by price, delivery date, condition and seller rating. — [AMZScout blog (secondary)](https://amzscout.net/blog/sold-by-amazon/)
- Amazon has a customer help page titled "Ordering from an Amazon Seller", which shows the platform explains third-party selling to shoppers. The page returned HTTP 503 when fetched, so its content was not verified. — [Amazon Customer Service](https://www.amazon.com/gp/help/customer/display.html?nodeId=GEF528GN65XSJ7V8)
- **Zalando Partner Program**: "Customers can see who is selling and shipping an item on the Product Detail Page, directly under the add to cart button ('sold and shipped by partner: xyz')". Customers can also **filter to show only products shipped by Zalando** (wholesale plus Zalando Fulfilment Solutions stock). — [Zalando partner webinar Q&A PDF](https://corporate.zalando.com/sites/default/files/media-download/Questions_Webinar1.pdf) (via search snippet)
- A trade press source says Zalando partner items sit alongside Zalando-shipped items and that "only the sharpest consumers will notice the difference, through a little icon under the product". This is a critique that seller disclosure can be too subtle. — [SGI Europe](https://www.sgieurope.com/zalando-expands-its-partnership-program/61587.article) (via search snippet; date not confirmed)
- **Target Plus**: the product page shows "sold and shipped by [partner]" for third-party items. That label decides who answers questions, how returns work and what shipping options apply. — [racklify encyclopedia (low-quality SEO source)](https://racklify.com/encyclopedia/query/target-plus-sold-and-shipped-by/). Treat as indicative only.
- **eBay condition model**: eBay stopped sellers outside its eBay Refurbished program from labelling items "refurbished". Those sellers must list them as "used". Inside the program there are four grades: Certified (eligible for a 2-year warranty), Excellent (like new), Very Good (minimal visible wear) and Good (moderate wear). eBay enforces the guarantees at platform level. — [SlashGear](https://www.slashgear.com/1616483/ebay-certified-refurbished-is-it-worth-buying)
- **Delivery estimate near the CTA**: showing an estimated delivery date near "Add to Cart" reduces uncertainty at the moment of decision. The cart is called the highest-value place for delivery estimates and the product page the second. — [ninety9.dev blog (vendor)](https://ninety9.dev/blog/estimated-delivery-date-shopify.html); [GemPages help](https://help.gempages.net/articles/design-shipping-estimation-with-delivery-date-element)

### Inferences
- For Marketly, put one line directly under Add to Cart: **"Sold by [Seller name ›] · Ships from [Official Store / Seller]"**, with the seller name linking to the storefront. Fulfilment ("Ships from Marketly") and seller identity ("Sold by Marketly Official Store") are separate facts and should get separate labels, as Amazon and Zalando do.
- Below the main offer, add an entry point such as "N other offers from R price". It should open a sheet (on phone) or a panel listing each offer's price, condition, delivery date, seller rating and return terms. This matches Amazon's "New & Used" list.
- Use controlled condition grades with plain-language definitions, following eBay Refurbished. Do not let sellers write "refurbished" freely. Tie "Certified refurbished" to a platform-backed warranty.
- Add a search/listing filter "Sold by Marketly Official Store" (and/or "Shipped by Marketly"), like Zalando's "shipped by Zalando" filter.
- Avoid Zalando's criticised subtlety. The seller line should be readable text, not just an icon.

### Gaps
- No primary source in 2025–2026 described a redesign of Amazon's "Other sellers on Amazon" module, or its exact current layout. The "Ships from / Sold by" placement is confirmed only by a secondary blog.
- Walmart's exact "Sold and shipped by" / "Fulfilled by Walmart" wording on the product page, and its "Compare all sellers" panel, were not confirmed by a primary source.
- How Mercado Libre, Rakuten and Shopee lay out multiple offers for one product (Mercado Libre's "Otras opciones de compra" and similar) was not researched successfully.
- No source covered how per-offer return terms are shown in the offer list.

## 2. Seller trust: ratings, badges, storefronts, policies

### Takeaway
The most effective seller badges are **earned from measurable service metrics**: on-time delivery, cancellations, response rate, ratings and free returns. They are shown **consistently across search results, the product page, the other-sellers list, the seller profile and the cart**, and **a hover or tap explains what the badge promises**. Brand-verified "Mall/Official Store" tiers are kept apart from performance badges.

### Cited Findings
- **Walmart Pro Seller badge**: it appears in search results, product pages and the shopping cart, and its design resembles social-network verified badges. On hover, Walmart lists three advantages: "quality service provider, consistent on-time delivery, and free online or in-store returns." — [Marketplace Pulse](https://www.marketplacepulse.com/articles/walmart-marketplace-pro-sellers)
- The badge also shows on Item, Additional Sellers and Seller Profile pages and in the cart. Criteria: high on-time delivery, low cancellations, high listing quality, free online and in-store returns, and policy compliance. Pro Sellers see 1.7x the conversion of the average Walmart Marketplace seller (Walmart first-party data, Feb–Apr 2025). — [Zentail](https://www.zentail.com/blog/walmart-marketplace-pro-seller-badge); [Modern Retail, 2023, on criteria being tightened](https://www.modernretail.co/technology/why-walmart-is-making-it-tougher-for-merchants-to-receive-its-pro-seller-badge-ahead-of-the-holidays/)
- **Etsy Star Seller** is awarded monthly based on the last 3 months. It requires a 95% message response rate, 95% on-time shipping (with tracking), a 4.8 average rating, at least 10 orders and $300 in sales, and 90 days since first sale. The badge is shown on the shop and listings. — [Etsy Seller Handbook (Aug 2024)](https://www.etsy.com/seller-handbook/article/476775452989); [Etsy Community announcement](https://community.etsy.com/forum/announcements-290/topic/updated-104-introducing-star-seller-22542/)
- Criticism: sellers say Etsy effectively treats 4-star reviews like failures for the badge, because buyers often give 4 stars when satisfied. — [Gelato blog summary](https://gelato.com/blog/etsy-star-seller)
- **Mercado Libre** shows reputation as a **5-colour thermometer** (red, orange, yellow, light green, green), not stars. It is computed over the last 3 months plus the current month from three metrics: claims, seller cancellations and late shipments. A separate **MercadoLíder** medal (Silver/Gold/Platinum) marks top sellers. — [Mercado Libre developer docs: seller reputation](https://developers.mercadolibre.com.ar/en_us/sellers-reputation); [Mercado Libre Global Selling help](https://global-selling.mercadolibre.com/help/1045)
- **Shopee Mall / Lazada LazMall** are tiers for official, brand-verified stores. Shopee Mall promises 100% authentic products with a "2x money back" guarantee if not authentic. LazMall offers up to 5x return for non-authentic items (2018 source). — [Newswav PSA](https://newswav.com/article/A2011_97jFWp); [SoyaCincau, Sep 2018](https://www.soyacincau.com/2018/09/05/you-wont-have-to-worry-about-fakes-when-you-shop-on-lazmall-lazada)
- **Shopee "Preferred" / "Preferred Seller"** is an orange tag earned on performance (shipping speed, ratings, response time). Sources stress it is **not** the same as Mall: Preferred signals service reliability, while Mall carries brand-authenticity verification. — [Shopappy (secondary)](https://shopappy.com/ecommerce/shopee/shopee-mall); [Ginee](https://ginee.com/ph/insights/preferred-seller-shopee)
- **eBay** shows Detailed Seller Ratings (accurate description, shipping cost, shipping speed, communication) plus individual feedback comments. Top Rated Seller requires consistent 4–5 star ratings and at least $1,000 / 100 transactions per year. eBay Stores pages show headline counts such as "49K items sold" (observed on /str/ store URLs). — [eBay store example](https://ebay.com/str/outofthisworldelectronics/Cell-Phones-Accessories/_i.html); [SlashGear](https://www.slashgear.com/1616483/ebay-certified-refurbished-is-it-worth-buying)
- Generic marketplace guidance (Rigby, June 2025): a seller profile should carry a logo/photo, verification status, public reviews and ratings, and a **report option**. Visible policies are part of trust signals. Wishlists should support **following sellers** as well as products. — [Rigby, 2025-06-05](https://www.rigbyjs.com/blog/marketplace-ux)

### Inferences
- Marketly needs **two badge axes, never merged into one**:
  1. *Identity tier*: "Marketly Official Store" for first-party sellers and optionally "Official Brand Store" for verified brands, like Shopee Mall/LazMall.
  2. *Performance badge* for approved third parties: earned monthly from on-time delivery, cancellation rate, response rate, rating floor and a free-returns policy, like Walmart Pro Seller, Etsy Star Seller and Shopee Preferred.
- Every badge should be tappable and open a short explanation of what it guarantees (Walmart's hover pattern). On phone this means a bottom sheet.
- Show the badge in the same places everywhere: search card, product page seller line, other-offers list, storefront header and cart seller group.
- Set rating floors with care. Etsy's 4.8 threshold drew criticism for treating 4 stars as failure.
- A metric-based or colour indicator like Mercado Libre's thermometer is easy to read at a glance. Pair it with a plain "98% on-time" percentage rather than only a colour, for accessibility.
- Storefront page contents: header (logo, name, badges, rating with count, items sold, "member since", response time), Follow button, policy tabs (returns, shipping), "All items" with search inside the store, categories, and a Report seller link.

### Gaps
- No primary 2025–2026 description was found for the layout of Amazon's storefront and seller profile ("Visit the X Store" link versus the seller profile with feedback %), or for eBay's current store header.
- No source covered how sellers' return and shipping policies appear on the product page (for example an Amazon "Returns" link next to Ships from/Sold by).

## 3. Multi-seller cart and checkout

### Takeaway
The cart should be **grouped by seller (package)**, with each group having its own delivery option, cost, date, free-shipping progress and return path. Checkout should be **one combined payment**. Tell the buyer up front that they will receive separate packages and invoices, and give them one order number to quote to support.

### Cited Findings
- "A cart must group items per seller because the delivery cost, the delivery date and the return path each belong to one seller and mean nothing averaged across the cart." — [Mercur marketplace academy (vendor, undated)](https://www.mercurjs.com/marketplace-academy/multi-vendor-shopping-cart-marketplace)
- "You cannot pick a single delivery method for the whole cart, because there is nobody to carry it out." Checkout therefore has one delivery section per seller: three choices, three costs, three dates. — [Mercur: checkout with several sellers](https://www.mercurjs.com/marketplace-academy/marketplace-checkout-several-sellers)
- **Free-delivery thresholds work per seller group**, with a progress bar inside each group showing what is missing *from that seller*. — [Mercur](https://www.mercurjs.com/marketplace-academy/multi-vendor-shopping-cart-marketplace)
- Stock that disappears at checkout is a partial-failure case. The platform must choose between atomic (reject the whole order) and partial (charge only what is available, drop the rest), and either way tell the buyer clearly. One cart can produce one master order or per-seller orders, but "the buyer needs one number to quote to support". Say in the checkout summary that separate invoices or packages will arrive, rather than letting the buyer find out later. — [Mercur](https://www.mercurjs.com/marketplace-academy/marketplace-checkout-several-sellers)
- A lower-cost option is a multi-vendor cart with single-vendor checkout (one checkout per vendor), which trades UX simplicity for payout simplicity. — [Sharetribe Academy](https://www.sharetribe.com/academy/multivendor-shopping-cart/)
- Showing seller-specific pricing, taxes and shipping in the cart in real time is said to reduce abandonment (vendor claim, no data). — [Sharetribe](https://www.sharetribe.com/academy/multivendor-shopping-cart/)
- Walmart's Pro Seller badge appears **inside the cart**, so seller trust signals carry into checkout. — [Marketplace Pulse](https://www.marketplacepulse.com/articles/walmart-marketplace-pro-sellers)

### Inferences
- Marketly cart layout: group header "Package 1 of 2 · Sold by Marketly Official Store [badge]", then items, then delivery option, date and cost, then a "Add R X more for free delivery from this seller" bar. Show one total, one Pay button and one parent order number. Per-seller sub-orders can appear later in order tracking.
- Price change or out-of-stock between add-to-cart and checkout: show an inline notice on the affected line ("Price changed from R A to R B since you added this", "Only 1 left: quantity updated", "No longer available from this seller: see N other offers"). Never change the total silently. This is an inference; no 2025–2026 primary source on how Amazon or Walmart word it was found.
- If the same product has a cheaper or faster offer from another seller, the cart could offer a switch. This is an inference with no source.

### Gaps
- No primary source showed how Amazon, Walmart, Etsy or Shopee actually render seller groups in the cart. Shopee groups the cart by shop with a per-shop voucher row, but this was not confirmed by a source in this session. The cited guidance is from marketplace-software vendors, not observed marketplaces.
- No sources found on the wording of price-change or out-of-stock notices at major marketplaces.

## 4. Reviews and Q&A

### Takeaway
Amazon's 2023–2026 direction is an **AI review summary ("Customers say") with aspect chips** above the reviews, built only from verified purchases and clearly labelled as AI-generated. Product Q&A is being **folded into the Rufus AI assistant**, so browsing community Q&A becomes secondary. Marketplaces keep **product reviews** (about the item) separate from **seller feedback or ratings** (about service).

### Cited Findings
- **Amazon "Customers say"** (launched 2023): a short paragraph on the product page sums up shared positive, neutral and negative opinions. It sits under a bold "Customers say" heading with the caption "AI-generated from the text of customer reviews". — [About Amazon](https://www.aboutamazon.com/news/amazon-ai/amazon-ai-generated-review-highlights); [Search Engine Land](https://searchengineland.com/amazon-ai-generated-customer-review-highlights-430693)
- Below it are **tappable aspect tabs/chips** (for example performance, ease of use) that surface reviews mentioning that attribute. Summaries use **verified purchase reviews only**. — [Thurrott](https://www.thurrott.com/amazon/287113/amazon-expands-ai-generated-review-summaries); [About Amazon](https://aboutamazon.com/news/retail/amazon-ai-generated-review-highlights)
- **Amazon Q&A replaced by Rufus (2026, user-forum report)**: the scrollable customer Q&A feed is reportedly gone. It was replaced by Rufus and a "Looking for specific info?" keyword box. Human Q&A is reached only through a "Show related customer Q&As and reviews" link under Rufus's answer. Voluntary answering of pending questions was removed in favour of emailed "Can you help this fellow customer?" requests. — [Motley Fool discussion board (user forum, low authority)](https://discussion.fool.com/t/amazon-continues-to-frustrate-consumers-looking-for-product-info/124607); see also [Amazon Seller Central EU forum thread on unanswered questions](https://sellercentral-europe.amazon.com/seller-forums/discussions/t/abf1ebc7-aa70-41bb-b6bd-aea8206ffdf2). The forum thread itself is titled "Amazon continues to frustrate consumers looking for product info", which is evidence of user pushback.
- Amazon's own Rufus page describes Rufus as the shopping assistant. — [About Amazon: Rufus](https://www.aboutamazon.com/news/retail/amazon-rufus)
- **Seller feedback is separate from product reviews on eBay**: Detailed Seller Ratings cover accuracy, shipping cost, shipping speed and communication. — [eBay store pages](https://ebay.com/str/outofthisworldelectronics/Cell-Phones-Accessories/_i.html)
- Etsy's Star Seller uses shop-level rating averages (4.8), distinct from item content. — [Etsy Seller Handbook](https://www.etsy.com/seller-handbook/article/476775452989)

### Inferences
- Marketly product page order: rating summary (stars, count, distribution bars), then an "Customers say" AI summary with aspect chips and an explicit AI label, then filters (stars, with photos, verified purchase, variant), then sort (most helpful, most recent), then a review photo strip, then the review list with a "Verified purchase" tag and the seller it was bought from.
- Keep product reviews pooled across all offers for the same product. Seller ratings (delivery, as described, communication) belong to the seller's storefront and the other-offers list, never mixed into product stars.
- Q&A: keep a visible human Q&A section with "Answered by seller" / "Answered by Marketly" / "Answered by a customer" labels. An AI assistant can sit on top, but hiding human Q&A behind it drew user frustration at Amazon.

### Gaps
- No 2025–2026 primary source on review filtering/sorting UI, review photos galleries, or "verified purchase" labelling outside Amazon.
- The Amazon Q&A-to-Rufus change is sourced only to a user forum. It is plausible and consistent with the seller forum thread, but Amazon has not documented it.
- No source on whether Etsy or eBay show AI review summaries.

## 5. Coupons and deals

### Takeaway
Amazon's clippable coupon is a **small green/orange tag next to the price with a "Clip" checkbox/button**. It is often **variant- or seller-specific**, and that is a known source of confusion. Price pressure tactics (fake countdowns, fake scarcity) are now **being fined in the EU**.

### Cited Findings
- Amazon coupons appear as small green or orange badges near the price on eligible listings (percentage or fixed amount). The shopper taps "Clip" to attach the coupon to their account and sees the deduction as a line at checkout. — [amzdudes (secondary)](https://amzdudes.com/what-are-amazon-coupons-and-how-do-amazon-coupons-work/); [QuerySprout](https://querysprout.com/clip-and-save-amazon/)
- Coupons often apply to one size, colour or seller only, for example only to items sold by Amazon. Switching variant after clipping can make the cart item ineligible, a common confusion. — [thetoolstrunk (secondary)](https://thetoolstrunk.com/amazon-clip-coupon-not-working/)
- Merchants ask for clippable coupons "like Amazon" on other platforms, which shows the pattern has become a standard expectation. — [Shopify Community](https://community.shopify.com/t/clippable-coupons-on-product-page-like-amazon/54880)
- **Italy AGCM, 26 June 2026**: a home-goods e-retailer was fined EUR 2M for (1) a **fake countdown timer** whose time-limited discounts "were in fact renewed identically upon expiry", (2) a **stock-count indicator** reinforcing perceived scarcity, and (3) misleading promotional price presentation. Legal basis: Italian Consumer Code art. 23(1)(g). — [Baker McKenzie, June 2026](https://www.bakermckenzie.com/en/insight/publications/2026/06/italy-agcm-eur-2m-fine-for-e-commerce-dark-patterns)

### Inferences
- Marketly coupon pattern: tag next to the price ("Save 10% with coupon [Clip]"). Once clipped it reads "Coupon clipped ✓ applied at checkout". The coupon text should name what it covers ("This size only · Sold by X") and link to an "Eligible items" page. If a variant switch drops eligibility, show it inline.
- Flash sales: only show countdowns that are real and end the deal, and only show stock counts that come from real inventory. The AGCM ruling shows reset-on-expiry timers are actionable.

### Gaps
- No source found on the design of Amazon's "eligible items" coupon landing page, Today's Deals page structure, Lightning Deal "% claimed" bars, or Shopee flash-sale UI in 2025–2026.

## 6. Delivery location / address picker

### Takeaway
No sourced 2025–2026 material was found in this session. See Gaps.

### Cited Findings
- Delivery estimates are most valuable in the cart and second most on the product page. Put them near the CTA. — [ninety9.dev (vendor)](https://ninety9.dev/blog/estimated-delivery-date-shopify.html)

### Inferences
- Marketly should have a persistent "Deliver to [suburb / postcode]" control: in the header on desktop, under the search bar on phone. It opens a sheet with saved addresses and a postcode field, and changing it re-computes every offer's delivery date and availability. This follows the widely known Amazon pattern but is **not sourced here**.

### Gaps
- No source was retrieved that describes Amazon's "Deliver to" popover (saved addresses, ZIP entry, how estimates refresh). This needs a dedicated lookup or a screenshot-based teardown.

## 7. Mobile app specifics

### Takeaway
Sticky add-to-cart on mobile product pages is widely recommended. Supporting stats come only from vendor sources.

### Cited Findings
- A sticky add-to-cart bar keeps the buy button pinned while the shopper scrolls, which matters most on long mobile pages. Vendor-reported figures: 73% of mobile users scroll past the buy button within 3 seconds, and the average conversion lift is 7.9%. These are vendor claims with unclear methodology. — [WiserReview glossary](https://wiserreview.com/glossary/sticky-add-to-cart/); [EasyApps stats](https://easyappsecom.com/guides/shopify-sticky-cart-conversion-data)
- Mobile product galleries should be swipeable, with zoom and multiple angles. — [Rigby, June 2025](https://www.rigbyjs.com/blog/marketplace-ux)

### Inferences
- The Marketly phone product page should have a sticky bottom bar with price, delivery date and Add to Cart, plus Buy Now if used. The "Sold by" line stays visible in the main buy area. Keep a persistent search bar at the top of Home and listing screens. These are standard app conventions and are not sourced here.

### Gaps
- No 2025–2026 NN/g or Baymard citation was retrieved on bottom tab bars (count and labels) or persistent search for marketplace apps.

## 8. Known criticisms and what to avoid

### Takeaway
Regulators and consumer groups are now acting against marketplace dark patterns: fake timers, fake scarcity, nagging pop-ups, gamified discounts and notification spam. Hiding useful information behind AI also draws complaints.

### Cited Findings
- BEUC (June 2025) filed a complaint to the European Commission against Shein over: pop-ups urging users not to leave or risk losing promotions, countdown timers creating time pressure, infinite scroll, and heavy notifications (12 in one day on one phone). BEUC had previously complained about Temu. Shein and Temu apps use games to win discounts. — [BNN Bloomberg, 2025-06-05](https://www.bnnbloomberg.ca/business/company-news/2025/06/05/shein-hit-with-complaint-from-eu-consumer-group-over-dark-patterns/)
- Italy AGCM fined a retailer EUR 2M (June 2026) for fake renewing countdowns, scarcity counters and misleading promo prices. — [Baker McKenzie](https://www.bakermckenzie.com/en/insight/publications/2026/06/italy-agcm-eur-2m-fine-for-e-commerce-dark-patterns)
- A 2023 European Commission sweep found about 40% of online shops used manipulative practices such as fake countdowns. Dated 2023. — [Malwarebytes, Jan 2023](https://www.malwarebytes.com/blog/news/2023/01/european-commission-goes-after-dark-patterns-in-web-shops)
- Seller disclosure that is too subtle (a small icon under the product on Zalando) means shoppers may not realise they are buying from a third party. — [SGI Europe](https://www.sgieurope.com/zalando-expands-its-partnership-program/61587.article)
- Amazon users report frustration that human Q&A is now hidden behind Rufus. — [Motley Fool discussion (forum)](https://discussion.fool.com/t/amazon-continues-to-frustrate-consumers-looking-for-product-info/124607)
- Coupon eligibility limited by variant or seller, without clear labels, causes "coupon not working" confusion. — [thetoolstrunk](https://thetoolstrunk.com/amazon-clip-coupon-not-working/)

### Inferences
- Marketly should avoid: timers that reset, stock counts that are not real inventory, exit-intent "you'll lose your discount" modals, gamified spin-to-win discounts, notification spam, and strike-through prices without a real reference price. These are now regulatory risks, not just UX risks.
- Avoid Amazon-style clutter: one primary offer, one secondary "other offers" entry, and no stacked sponsored carousels inside the buy area. The clutter criticism was not sourced directly in this session.

### Gaps
- No 2025–2026 credible teardown specifically documenting Amazon product-page clutter (sponsored placements count, etc.) was retrieved.
- Temu-specific enforcement details (the BEUC 2024 complaint and EU DSA proceedings) were not fetched.
