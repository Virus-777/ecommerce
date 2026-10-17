# Evidence-based UX patterns for seven customer-facing ecommerce pages (Marketly, 2025–2026)

Scope note: Research done 2026-10-12. Several primary sources could not be fetched (Amazon help pages returned 503, Etsy Help returned 403), so some marketplace examples rely on secondary sources and are flagged as such. Baymard articles are dated where the date was visible; several core Baymard findings are older (2015–2023) but are still the most-cited evidence.

## 1. Full product reviews page (all reviews)

### Takeaway
The ratings distribution histogram is the most-used part of the reviews section. Users rely on it more than on the review text, and they expect to click a bar to filter. The research-backed baseline: a bar-chart breakdown that is always visible and clickable, with single-select star filters; sorting that accounts for how many reviews there are; easy browsing of reviewer photos; and visible staff or seller replies to negative reviews. AI summaries are now an established pattern (Amazon's "Customers say" with aspect chips). Academic studies say shoppers treat them as a starting point, not a replacement for reading reviews.

### Cited Findings
- 95% of users relied on reviews to learn about products. The ratings distribution UI was the most-used feature of the reviews section, used even more than the review content. 43% of the top-60 grossing sites have no ratings distribution UI. 39% of the sites that have one miss at least one key requirement. (Article says "updated with new data in 2024") — [Baymard: User ratings distribution summary](https://baymard.com/blog/user-ratings-distribution-summary)
- Without a distribution summary, users who see mostly positive reviews first suspect the reviews are fake. Users who see mostly negative reviews first misjudge the product's overall rating — [Baymard](https://baymard.com/blog/user-ratings-distribution-summary)
- 90% of test subjects tried to filter reviews by clicking the rating bars. 61% of benchmarked sites make the star bars clickable filters. 53% of users actively look for negative reviews. When the filter was collapsed by default, only 7% filtered (11% at Home Depot) — [Baymard](https://baymard.com/blog/user-ratings-distribution-summary)
- Baymard's five requirements: (1) a graphical bar breakdown, not text only; (2) bars clickable to filter; (3) expanded by default, never collapsed; (4) mutually exclusive filtering (radio logic, not checkboxes); (5) consider hiding the breakdown when there are 5 or fewer reviews — [Baymard](https://baymard.com/blog/user-ratings-distribution-summary)
- Sorting: 64% of sites sort by rating average alone and ignore the number of ratings. In surveys, 56% chose a 4.5-star product with 12 ratings over a 5-star product with 2, and 62% chose 4.5 stars with 57 ratings over 5 stars with 4. Users begin trusting averages at about 5+ ratings, and some want 100+. Recommendation: weight sorting by both average and volume, with a minimum threshold — [Baymard: Sort by customer ratings](https://baymard.com/research-articles/sort-by-customer-ratings)
- 89% of sites don't respond to negative reviews. Staff replies to critical reviews show care and improve how users see the company — [Baymard: Product Page UX 2026 (updated Mar 18, 2026)](https://baymard.com/blog/current-state-ecommerce-product-page-ux)
- 63% of sites don't let users move smoothly across reviewer-submitted images. Users have to open and close each review one at a time. Guideline: allow continuous navigation through all review images — [Baymard: Product Page UX 2026](https://baymard.com/blog/current-state-ecommerce-product-page-ux)
- Product page benchmark (2026): 52% of desktop, 62% of mobile and 64% of app sites have "mediocre or worse" product page UX. Apps score worst — [Baymard 2026](https://baymard.com/blog/current-state-ecommerce-product-page-ux)
- **Example: Amazon AI review highlights.** A paragraph headed "Customers say" sits at the top of the reviews section. Below it are clickable aspect chips. A green check means most mentions are positive, an orange minus means mostly negative, and grey means neither. Tapping a chip shows how many customers mentioned that aspect, plus review snippets. It is generated only from text reviews by Amazon Verified Purchasers, and only when several customers share the same opinion. Available in the US, UK, AU, IN, SG and UAE — [About Amazon](https://www.aboutamazon.com/news/amazon-ai/amazon-ai-generated-review-highlights)
- In University of Missouri interviews and shop-alongs, shoppers found AI summaries useful as a starting point but still did their own detailed research. Their distrust came partly from not knowing how the summary was made — [MOspace (U. Missouri)](https://mospace.umsystem.edu/items/6ab57eb6-96fd-4f63-aff8-f2e7408e1ab2). In a 2x3 experiment (n=291), AI summaries alone did not significantly change trust or perceived helpfulness — [Católica Portuguesa thesis "Lost in summarization"](https://ciencia.ucp.pt/en/studentTheses/lost-in-summarization/)
- Pagination vs scroll: Baymard found "Load more" plus lazy loading worked best for product lists on mobile and desktop (older study, circa 2016) — [Baymard](https://Baymard.com/blog/external-load-more-vs-pagination-vs-infinite-scrolling). NN/g (Sept 2022): with infinite scroll it is hard to find an item again, and pressing Back often returns users to the top. Infinite scroll can make the footer unreachable. "Load more" stops the stream and keeps the footer reachable. Pagination and integrated pagination give landmarks for finding things again — [NN/g: Infinite scrolling tips](https://www.nngroup.com/articles/infinite-scrolling-tips/). NN/g: infinite scroll suits exploring uniform content, not tasks where users look for a specific item — [NN/g video](https://www.nngroup.com/videos/infinite-scrolling-when/)

### Inferences
- Marketly reviews page layout:
  - **Header:** average rating, total count, and a 5-row histogram. Each bar is a radio-style filter, expanded by default.
  - **Below the header:** an AI "Customers say" block. Label it as AI-generated from verified-purchase reviews. Each aspect chip shows its sentiment and a mention count, and opens the matching snippets.
  - **Filter row:** chips for Verified purchase, With photos/video, Variant (size/colour), and keyword search.
  - **Sort:** Most helpful (default), Most recent, Highest rating, Lowest rating.
  - **Review cards:** "Helpful" vote and "Report" actions. Show seller or Official Store replies inline, labelled with the role.
- On the phone/app layout, use "Load more" rather than pure infinite scroll. It keeps the user's place, gives a stopping point, and matches the NN/g and Baymard evidence. Because the phone layout has no footer, the footer-access argument matters less. Keeping position on return and finding a review again still favour "Load more".
- Hide the histogram, or show a "few reviews" note, when a listing has 5 or fewer reviews. Never rank a 5.0 product with 1–2 reviews above well-reviewed items.
- Marketplace twist: show whether a review is about the product or the seller's service. Show which seller fulfilled the order, since the same product may have multiple sellers.

### Gaps
- No 2025–2026 Baymard numbers were found for review keyword search, "with photos" filters or variant filters specifically. The researched filter evidence is about star filters.
- No study was found comparing pagination and "Load more" specifically for review lists on mobile.
- Helpful-vote and report-flow UX: no primary research found in this session.
- Unverified claim: a May 2026 Motley Fool forum post says Amazon's browsable Q&A and review feed changed under Rufus. It is sourced from a Gemini chat, so treat it as unreliable — [forum](https://discussion.fool.com/t/amazon-continues-to-frustrate-consumers-looking-for-product-info/124607)

## 2. Product Q&A page

### Takeaway
Users find answers from other customers more credible than site-written copy. The strongest setup combines a curated FAQ with community Q&A. Common failures are unanswered questions, empty Q&A on new products, and duplicate questions. The market is moving toward AI answer assistants that pull from reviews and Q&A (Amazon Rufus). Evidence on whether these replace browsable Q&A is weak.

### Cited Findings
- 55% of sites have no community Q&A on product pages. 70% lack both site FAQs and community Q&A together. Only 28% offer the "hybrid". 40% of test subjects used community Q&A when it was available, and 25% scanned Q&A to learn about the product without having a specific question. (Published July 4, 2017 — old but the main source) — [Baymard: Product page FAQ and Q&A](https://baymard.com/research-articles/product-page-faq-and-qa)
- Community content is seen as more credible than manufacturer or site claims. Q&A brings up questions sites can't anticipate, such as scent or weight. Failures: unanswered questions, empty sections, duplicate questions, poor answers. Fixes: prompt past buyers and reviewers to answer, reward good contributions, monitor and reply — [Baymard](https://baymard.com/research-articles/product-page-faq-and-qa)
- **Example: Amazon Rufus.** Answers product questions using the catalog, customer reviews, community Q&A, product page content and web information — [WebFX on Rufus](https://www.webfx.com/blog/marketing/amazon-rufus/) (secondary source). A 2026 forum post claims the browsable Q&A feed was replaced by a keyword box ("Looking for specific info?") plus Rufus, with a "Show related customer Q&As and reviews" link under the AI answer. It is unverified and the poster sourced it from a Gemini chat — [Motley Fool forum, May 3 2026](https://discussion.fool.com/t/amazon-continues-to-frustrate-consumers-looking-for-product-info/124607)

### Inferences
- Marketly Q&A page layout:
  - **Search box at the top:** "Have a question? Search Q&A and reviews". Search runs across Q&A, reviews and specs before the user is offered "Ask a question". This cuts duplicate questions.
  - **AI answer:** optional, clearly labelled, and citing the Q&A and review snippets it used. Always offer "See all questions" so users can keep browsing.
  - **Answer role badges:** "Seller", "Official Store", "Marketly staff", "Verified buyer". A seller's answer should not outrank verified-buyer answers by default.
  - **Voting and moderation:** "Helpful" votes on answers, plus "Report".
  - **Asking:** route new questions to the seller and to recent buyers ("Can you help?"). Show the expected answer time.
- Show an empty state that suggests reviews or contacting the seller, so new products don't show an empty Q&A section.

### Gaps
- No 2024–2026 research was found on role labels for answers or on AI Q&A assistants' effect on trust or conversion.
- Amazon's current Q&A UI could not be confirmed from a primary source.

## 3. Delivery address / location picker

### Takeaway
Users strongly prefer concrete delivery dates over shipping speeds. Address entry fails often without lookup (typos in 9% of manual entries). Address autocomplete must tolerate typos, rank suggestions by proximity, and always show the manual fields as a fallback. The "Deliver to" selector should change prices, availability and delivery estimates to match the chosen location.

### Cited Findings
- 55% of sites lack fully automatic address lookup. 9% of manually entered shipping addresses had typos. 69% of participants fell back to manual entry when suggestions failed. (Mar 24, 2023) — [Baymard: Automatic address lookup](https://baymard.com/blog/automatic-address-lookup)
- Requirements: tolerate misspellings; always show all standard address fields by default as a fallback; rank results by proximity (IP geotargeting), not alphabetically. If lookup isn't feasible, detect city and state from the ZIP/postal code — [Baymard](https://baymard.com/blog/automatic-address-lookup)
- Users prefer delivery dates to shipping speeds. With only a speed, participants stop to work out the arrival date, which leads to hesitation and abandonment. 41% of benchmarked sites don't give a delivery date — [Baymard: Shipping speed vs delivery date](https://baymard.com/blog/shipping-speed-vs-delivery-date); [guideline 543](https://baymard.com/guidelines/543-delivery-date-vs-delivery-speed)
- 67% of sites don't show estimated shipping or total cost near the buy button. Guideline: show estimated shipping and total cost on the product page — [Baymard 2026](https://baymard.com/blog/current-state-ecommerce-product-page-ux)
- **Example: Amazon "Choose your location".** Users enter a ZIP and tap "Apply". Sellers shown, shipping rates and prices can vary by location. Signed-in users can pick from saved addresses — [Repricer support (secondary)](https://support.repricer.com/troubleshooting-changing-location-see-all-competitors-amazon)
- Practitioner claim: address autocomplete matters most on mobile, where typing addresses is hard — [Smarty / Speedway Motors case study](https://www.smarty.com/documents/speedway-motors-case-study.pdf)

### Inferences
- Header "Deliver to [City ZIP]" pill (on phone, in the app's top bar).
- Tapping it opens a bottom sheet with:
  - (a) saved addresses as radio cards, with the default first;
  - (b) "Use my current location", which asks for geolocation only on tap;
  - (c) ZIP/postcode entry with "Apply";
  - (d) "Add new address", which opens autocomplete with manual fields always visible.
- After the user applies a location, update in place: the delivery date ("Arrives Thu, Oct 16"), shipping cost, stock and which sellers or offers can deliver. Flag any items that can't ship to the new location. Don't silently change prices without a short notice.
- Validate addresses at save time (suggest the standardised version, let the user keep theirs) rather than blocking.

### Gaps
- No primary Amazon, Walmart or Zalando documentation of the current location-picker UI could be fetched.
- No research found on geolocation-permission prompts in ecommerce, or on how users react when a location change alters prices.

## 4. Coupon "eligible items" page

### Takeaway
The best-documented pattern is Amazon's clip-to-apply coupon. The user taps "Clip coupon" on the product or coupon page, sees a clipped state, and the discount is applied at checkout, not necessarily in the cart. There is no Baymard or NN/g research specifically on eligible-items pages. The closest evidence supports showing the remaining amount needed ("$14 away") and dates over vague rules.

### Cited Findings
- Amazon: users clip coupons, and the discount is applied at checkout "now or later". It may not appear in the cart. There is a coupons hub with search, categories, "Your coupons" (clipped list) and sorting by biggest savings, expiry and popularity — [Yahoo Lifestyle](https://www.yahoo.com/lifestyle/amazon-secret-coupons-091514031.html); [Yahoo News](https://news.yahoo.com/what-are-amazon-coupons-173157340.html)
- Amazon coupons are mostly single-use per customer, and many end early once the seller's budget runs out — [QuerySprout (secondary)](https://querysprout.com/clip-and-save-amazon/)
- Practitioner guidance (not peer-reviewed research): state the remaining amount ("You're $14 away") rather than the rule ("Free shipping over $70"). Change the copy for empty, in-progress and unlocked states. Use money remaining, not percentages, because it matches what checkout shows — [ninety9.dev](https://ninety9.dev/blog/free-shipping-bar-copy.html); [Gropulse](https://gropulse.com/?p=5238)

### Inferences
- Marketly eligible-items page layout:
  - **Coupon header card:** discount, minimum spend, which seller or Official Store it is from, expiry date and time, terms link, and a button with Clip/Clipped states that changes to "Clipped ✓ — applies at checkout".
  - **Sticky progress bar:** "Add ₹X more to unlock" → "Coupon unlocked". It is computed from eligible items already in the cart.
  - **Product grid of eligible items:** standard filters and sort, a quick add-to-cart on each card, and an "in cart" indicator.
  - **On product pages and in the cart:** label eligible items "Coupon applies" and show the discount line in the cart, avoiding Amazon's "shows only at checkout" confusion.
  - **Ending states:** say clearly when the coupon is exhausted or expired, or only partly applies.
- Marketplace: coupons are seller-scoped or platform-scoped. Show who funds the coupon and whether it stacks with other offers.

### Gaps
- No Baymard or NN/g research was found on coupon eligible-items pages or clipped-coupon UX. Amazon's coupon help page returned 503. The Walmart, eBay and Temu coupon-page patterns were not researched.

## 5. Seller storefront "see all items" and store policies pages

### Takeaway
Users look for return and shipping policies on the product page (60%) and in the footer. They abandon over poor return policies (15%). On marketplaces, seller credibility varies, so per-seller policies and contact must be easy to find. Etsy shows per-shop policies (shipping, returns and exchanges, cancellations, privacy) with a "last updated" timestamp and lets sellers set return policies per listing. Amazon standardised returns under Amazon's own policy and removed custom seller return policies in 2022.

### Cited Findings
- 60% of users look for the return policy on the product page, and 44% of sites don't put it there. 15% abandoned at least one order due to an unsatisfactory return policy — [Baymard 2026](https://baymard.com/blog/current-state-ecommerce-product-page-ux); [guideline 803](https://baymard.com/guidelines/803-return-policy-discoverability)
- Users consistently look in the footer for shipping and return information, but it should also be reachable from the header, the product page and site search — [Baymard: footer needs return/shipping links](https://baymard.com/blog/footer-needs-return-shipping-links)
- **Example: Etsy.** Policies are split into Returns and Exchanges, Cancellations, Privacy and similar sections. Buyers see return policies on listings, and return policies are set per listing. Policies list the contact window, the return-shipping window and who pays return shipping, and a timestamp shows when they were last updated. Secondary sources; the Etsy Help Center returned 403 — [Craftybase](https://app.craftybase.com/blog/how-to-set-up-etsy-shop-policies); [Etsy Help: return policies on listings](https://help.etsy.com/hc/en-us/articles/7869401615255-How-do-I-Set-Return-Policies-on-My-Listings-)
- **Example: Amazon seller profile.** It has an "About Seller" section and a logo shown on the profile and offer listings. Since Aug 1, 2022, the returns section on seller profiles points to Amazon's Return and Refund policies, and sellers can no longer post custom return policies — [Feedvisor](https://feedvisor.com/university//creating_a_seller_profile); [SellerEngine](https://sellerengine.com/mastering-returns-and-refunds-a-guide-to-amazons-latest-guidance/amp/)

### Inferences
- Marketly storefront:
  - **Header:** logo, name, an "Official Store" badge or "Third-party seller", rating, number of ratings, years on Marketly, response time, a "Contact seller" button and "Follow".
  - **Tabs:** Home, All items, Reviews (seller feedback), Policies, About.
  - **"All items" view:** reuse the product-list component (search within store, categories, filters, sort, item count).
- Store policies page: separate sections for Shipping (processing time, carriers, regions, costs, free-shipping threshold), Returns (window, condition, who pays, refund method) and Contact (in-platform messaging, hours, response SLA). Add a "Last updated" date.
- Show the Marketly guarantee alongside each seller's policy so buyers know what applies regardless of seller. Amazon's move to a platform-standard return policy suggests platform-level rules lower the burden of comparing sellers.
- On the product page, summarise the seller's returns and shipping next to the buy box, linking to the full policy.

### Gaps
- No primary research found on storefront "see all" pages or seller-profile layouts specifically. The eBay Store, Walmart Marketplace seller pages and Zalando partner pages were not researched.

## 6. Sign-in with a backup/recovery code; 2SV alternatives and account recovery

### Takeaway
NIST SP 800-63B-4 (final, July 2025) does four things relevant here. It recognises syncable passkeys at AAL2. It requires at least one phishing-resistant option at AAL2. It treats SMS/PSTN as "restricted" and says alternatives must exist. It requires look-up (recovery) codes to be single-use. Leading UIs (Google, GitHub) put a "Try another way" or alternate-method link on the 2FA screen that leads to recovery codes, an authenticator app, security keys or passkeys, and SMS. Passkey guidance says to prompt users to create a passkey right after they recover their account.

### Cited Findings
- SP 800-63-4 final was released in July 2025 and recognises syncable passkeys for AAL2. 800-63Bsup1 is superseded by 800-63B-4 — [Intercede](https://www.intercede.com/from-draft-to-final-whats-new-in-nists-latest-password-guidance/); [NIST CSRC](https://csrc.nist.gov/pubs/sp/800/63/b/sup/final)
- Look-up secrets (recovery codes) must come from an approved random bit generator and be at least 6 decimal digits or equivalent. A look-up secret "SHALL be used successfully only once" (Sec. 3.1.2) — [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)
- Using PSTN/SMS for out-of-band authentication is "restricted". Verifiers SHOULD consider risk signals (SIM swap, porting, device swap) and SHALL make alternative authenticator types available (Sec. 3.1.3.3) — [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)
- Verifiers SHALL offer at least one phishing-resistant option at AAL2 and SHOULD encourage it (Sec. 2.2.2). Manually entered codes are not phishing-resistant. Syncable authenticators SHALL NOT be used at AAL3 — [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)
- Failed-attempt limit of no more than 100 consecutive failures per authenticator. Throttling via bot challenges and increasing wait times. Verifiers SHALL allow password managers and autofill and SHOULD allow paste. A non-biometric alternative SHALL always be available — [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)
- **Example: Google.** On the 2SV screen the user taps "Try another way" and then "Enter one of your 8-digit backup codes". Each code works once. Users can generate a new set of 10 at any time. Google never asks for a backup code anywhere except at sign-in — [Google Account Help](https://support.google.com/accounts/answer/1187538?hl=en)
- **Example: GitHub.** The 2FA step offers a TOTP app, security keys, passkeys (which satisfy both password and 2FA), SMS and GitHub Mobile push. If the authenticator is lost, sign in with a recovery code. A 28-day check after setup lets users reconfigure 2FA before getting locked out — [GitHub Docs](https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/accessing-github-using-two-factor-authentication)
- Google passkey UX guidance:
  - Offer passkeys through browser autofill (conditional UI) or Credential Manager as early as possible.
  - After account recovery, prompt the user to create a passkey, because security is top of mind then.
  - Keep backup options for passkey-first accounts (phone, email, social sign-in).
  - Show where each passkey is stored (Google Password Manager, iCloud Keychain, etc.) and number duplicates.
  - Use the words "create" and "delete".

  — [Google for Developers: Passkey user journeys](https://developers.google.com/identity/passkeys/ux/user-journeys)
- The FIDO Alliance Design Guidelines contain 14 research-backed patterns, made with a third-party UX research firm and Google's UX team. Recovery methods are themselves authentication: if users can fall back to phishable methods, the account is not phishing-resistant — [FIDO Design Guidelines](https://fidoalliance.org/design-guidelines); [FIDO Alliance](https://fidoalliance.org/?p=79746)
- If users lose their recovery codes, delete their passkey and have no other factor, they may need support to get back in — [Authsignal](https://authsignal.com/blog/articles/synced-vs-device-bound-passkeys-convenience-and-authentication-experiences)

### Inferences
- Marketly sign-in flow:
  - **First step:** passkey via autofill or "Sign in with passkey". Password plus 2SV is the alternative.
  - **2SV screen:** shows the user's default method (authenticator app, passkey or security key, then SMS last) and a "Try another way" link. That link lists every enrolled method plus "Use a recovery code".
  - **Recovery-code screen:** a single field that ignores spaces and hyphens and accepts paste. Copy explains what a recovery code is and where it was saved. After success, say "This code is now used; you have N left". Email a security notification. Prompt the user to regenerate codes and add a passkey.
  - **"Lost access to everything?" link:** a slower, verified account-recovery path through support, with a waiting period. It must not be an instant bypass.
- Sellers have access to money and payouts, so require a phishing-resistant method (passkey) for sellers or high-value actions. Keep SMS as a restricted fallback, consistent with NIST.
- Rate-limit code entry and show neutral error copy. Never ask for recovery codes outside sign-in (copy Google's statement in help text to reduce phishing).

### Gaps
- Amazon's 2SV help page returned 503, so Amazon's backup-method UI is not documented here. Shopify's sign-in recovery UI was not researched.
- No usability study with numbers (success rates, drop-off) on recovery-code entry was found.

## 7. Help Center article page (customers and sellers)

### Takeaway
Evidence is thin and older. NN/g's core guidance (Dec 2020): make search strong, keep content task-focused with concrete numbered steps, open with a short summary, and make it easy to scan. Help that appears in context, pulled up by the user while doing a task, beats pushed help. Common practice adds related articles, a "Was this helpful?" control and escalation to contact. These are widespread but not backed by research found in this session.

### Cited Findings
- "Optimize for search." Group topics by category or experience level. Help should focus on the user's task and "list concrete steps". Avoid long overviews, though a high-level summary at the top is fine. Pull revelations (triggered by user action) beat push revelations. Use chunking, headings, bullets and numbered lists so rushed users can scan. Use visuals or video as secondary aids. (Dec 13, 2020) — [NN/g: Help and documentation](https://www.nngroup.com/articles/help-and-documentation/)
- Practitioner guidance (vendor blogs, not research): write from the customer's problem, not the product's features. Use 2–3 sentence paragraphs and headers that answer questions. Target more than 80% positive helpfulness ratings and track search success — [Chaindesk blog, Aug 2026](https://www.chaindesk.ai/blog/help-articles-self-service-guide)

### Inferences
- Marketly article page layout:
  - **Top of page:** search box and breadcrumb (breadcrumb hidden on phone, per project rules). Title phrased as the user's question. One-line answer or summary. "Applies to: Buyers / Sellers" tag. "Last updated" date.
  - **Body:** numbered steps with screenshots. Deep links into the right app screen ("Open Returns") — this is the pull-revelation principle.
  - **After the body:** related articles (3–5 in the same task cluster), then "Was this helpful? Yes/No". "No" asks for a reason and offers to contact support.
  - **Contact:** escalation (chat, message, ticket) after the article content, not hidden. For order-specific issues, link to the order's help flow with the order already selected.
- Separate Buyer and Seller help centers, or use a strong audience switch, so sellers don't land on buyer articles and the reverse.

### Gaps
- No 2024–2026 Baymard or NN/g research was found on help-article layout, the effectiveness of "Was this helpful?", or contact-escalation placement.
- Best-in-class live examples (Amazon Help, Shopify Help Center, Apple Support, eBay Help) were not fetched in this session, so no verified layout descriptions are included.
