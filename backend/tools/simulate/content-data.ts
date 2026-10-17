/**
 * The store content the content flow publishes: the five policies the store links to, the help center, the About
 * page and the homepage promises. Plain lists, like data.ts, so the owner can change them without touching the flow.
 *
 * SAMPLE TEXTS ONLY. They come from the frontend team's seed (web-shared/tools/seed/data.mjs), adapted to the
 * simulator's world (the Official Store ships from Portland). The real legal texts (purchase terms, privacy,
 * returns, shipping, seller rules) are the owner's to write before launch; the simulator only needs something
 * published so the store's sign-up, footer and policy pages work.
 */

/** The market's time zone (homepage sections and pages are scheduled in it) */
export const CONTENT_TZ = 'America/Los_Angeles';

export interface PolicySeed {
  /** The URL slug: /policies/{key} */
  key: 'returns' | 'shipping' | 'privacy' | 'purchase_terms' | 'seller_rules';
  title: string;
  audience: 'customer' | 'seller' | 'both';
  /** Sanitized HTML (the server sanitizes again) */
  body: string;
}

/** HTML written over several lines for reading, sent as one line */
const h = (s: string) => s.trim().replace(/\n\s*/g, '');

/**
 * The five policies the store links to: sign-up and checkout load purchase_terms, the footer links privacy, returns,
 * shipping and seller_rules. Checked after every run (checks.ts: each has a version in force).
 */
export const POLICIES: PolicySeed[] = [
  {
    key: 'returns',
    title: 'Returns policy',
    audience: 'customer',
    body: h(`
      <p>Every item on Marketly can be returned for at least 30 days after delivery unless a category exception below applies. Sellers can offer longer or free returns; their terms are shown on the product page before you buy.</p>
      <h2>Return window</h2><ul><li>30 days from delivery for most items.</li><li>Official Store items: 30 days, free return shipping for every reason.</li><li>Seller items: at least 30 days. Longer windows are shown on the offer.</li></ul>
      <h2>Who pays return shipping</h2><ul><li>Damaged, incorrect or defective items: the seller, with a prepaid label.</li><li>Changed your mind: you, unless the seller offers free returns.</li></ul>
      <h2>Category exceptions</h2><ul><li>Opened bedding, personal care and beauty items can be returned only if they are faulty.</li></ul>
      <h2>Refunds</h2><ul><li>Refunds go back to your original payment method. You see each step: Requested, Under review, Approved, Processing, Sent.</li><li>Approved doesn't mean the money has arrived. Banks take 3–5 business days after we send it.</li><li>Partial returns refund only the returned items and their share of any discount.</li></ul>
      <h2>When Marketly steps in</h2><p>If a seller doesn't answer a return request within 2 business days, rejects it and you disagree, or doesn't refund within 3 business days of receiving the item, ask Marketly to help from the return page. In some cases we refund without asking you to send the item back, and we record why.</p>`),
  },
  {
    key: 'shipping',
    title: 'Shipping policy',
    audience: 'customer',
    body: h(`
      <p>Every item shows who ships it, where it ships from, the shipping cost and a delivery estimate for your address before you pay.</p>
      <h2>Who ships your order</h2><ul><li>Official Store items ship from our Portland, OR fulfillment center.</li><li>Marketplace items ship from the seller's own location.</li><li>One order can arrive in several packages, one per seller or ship-from location.</li></ul>
      <h2>Costs</h2><ul><li>Official Store: free standard delivery on orders over $35, otherwise $5.99.</li><li>Sellers set their own rates. You see each package's cost at checkout.</li></ul>
      <h2>Delivery estimates</h2><p>Estimates combine the seller's dispatch time and the carrier's transit time to your ZIP code. If a package is late, we tell you and show your options on the order page.</p>
      <h2>Where we deliver</h2><p>We deliver to street addresses in the contiguous 48 states and DC. Some sellers also ship to Alaska, Hawaii and PO boxes; the product page tells you before checkout.</p>
      <h2>Late, lost or damaged packages</h2><ul><li>Report it from the order page. The seller responds first; Marketly steps in after 2 business days.</li><li>If an item doesn't ship within 14 days of its estimate, you can cancel it for a full refund.</li></ul>`),
  },
  {
    key: 'privacy',
    title: 'Privacy',
    audience: 'both',
    body: h(`
      <p>This policy explains what personal information Marketly collects, why, and the choices you have.</p>
      <h2>What we collect</h2><ul><li>Account details: name, email, phone and password (stored encrypted).</li><li>Order details: addresses, items, payment results. Card numbers are handled by our payment processor; we keep only the last 4 digits.</li><li>Support messages and photos you send.</li><li>Basic device and usage data to keep the site secure and working.</li></ul>
      <h2>What sellers see</h2><p>Sellers get only what they need to deliver and support your order: your name, delivery address, phone for the carrier and the items you bought. They can't see your payment details or other orders.</p>
      <h2>Marketing</h2><p>We only send marketing emails if you opt in. Order, delivery and refund updates are always sent. Change this in Profile at any time.</p>
      <h2>How long we keep it</h2><p>Order records are kept for 7 years for tax and accounting. You can close your account and ask us to delete other data.</p>
      <h2>Your rights</h2><p>You can ask for a copy of your data, correct it or delete it from your account, or write to the address on our About page.</p>`),
  },
  {
    key: 'purchase_terms',
    title: 'Purchase terms',
    audience: 'customer',
    body: h(`
      <p>These terms apply when you buy on Marketly. Your order keeps the terms, and each seller's return terms, that were shown when you placed it.</p>
      <h2>Who you're buying from</h2><p>Each item names its seller. Official Store items are sold by Marketly, Inc. Marketplace items are sold by the named seller; Marketly operates the store, takes payment and provides support.</p>
      <h2>Prices and total</h2><p>You see the full total, including shipping and tax, before you place an order. If a price, stock level, delivery date or coupon changes before you pay, we show the change and ask you to choose.</p>
      <h2>When an order is accepted</h2><p>An order is accepted when your payment is accepted. We email a confirmation only then. If the payment result is uncertain, we tell you and don't charge you twice.</p>
      <h2>Cancellations</h2><p>You can cancel an item until its seller ships it. Cancelling one item doesn't cancel the rest of the order.</p>
      <h2>Returns, refunds and help</h2><p>Returns follow the Returns policy and the seller's terms shown at purchase. If something goes wrong, the seller answers first and Marketly steps in when needed.</p>
      <h2>Changes to these terms</h2><p>We publish new versions with an effective date. Changes never apply to orders placed before that date.</p>`),
  },
  {
    key: 'seller_rules',
    title: 'Seller rules policy',
    audience: 'both',
    body: h(`
      <p>These rules apply to every outside seller on Marketly. Sellers accept them in the seller agreement. Customers can rely on them when buying from any seller.</p>
      <h2>Listing accuracy</h2><ul><li>Offers must match the catalog product exactly: model, variation, bundle contents and condition.</li><li>Used and refurbished items must describe wear and missing accessories.</li><li>Prices and discounts must be real. A "was" price must have been charged in the last 90 days.</li></ul>
      <h2>Dispatch and response targets</h2><ul><li>Ship within the dispatch time shown on the offer.</li><li>Answer customer messages and return requests within 2 business days.</li></ul>
      <h2>What the Verified seller label means</h2><p>We checked the seller's business registration, the identity of its owner, a US bank account for payouts and a US return address. It does not mean we inspected each product. Report anything that looks wrong from the product or order page.</p>
      <h2>Restricted products</h2><p>Sellers can't list weapons, recalled items, prescription drugs, counterfeit goods or items outside our launch categories. Some categories need approval first.</p>
      <h2>Restrictions and appeals</h2><ul><li>When we restrict a seller, we tell them the reason, which activity is affected (for example, new sales or new listings) and how to appeal.</li><li>Existing orders, returns and customer cases continue while a seller is restricted.</li><li>Sellers can appeal within 14 days. A different team member reviews the appeal.</li></ul>`),
  },
];

/** The policy keys the store links to (sign-up, checkout, footer): each must have a version in force */
export const STORE_POLICY_KEYS = POLICIES.map((p) => p.key);

/** The homepage "Shopping on Marketly" strip (2–4 promises) */
export const PROMISE_ITEMS = [
  { icon: 'calendar-check', title: 'Delivery date first', body: 'See arrival dates and the full total before you pay.' },
  { icon: 'undo-2', title: '30-day returns', body: 'Every seller accepts returns for at least 30 days after delivery.' },
  { icon: 'shield-check', title: 'Checked sellers', body: 'We verify each seller’s business, owner, bank account and return address.' },
  { icon: 'headset', title: 'We step in', body: 'If a seller doesn’t answer within 2 business days, Marketly helps.' },
];

export interface HelpCategorySeed {
  key: string;
  name: string;
  icon: string;
  description: string;
  audience: 'customer' | 'seller';
}

export const HELP_CATEGORIES: HelpCategorySeed[] = [
  { key: 'shopping', name: 'Shopping', icon: 'shopping-bag', description: 'Offers, sellers, product questions', audience: 'customer' },
  { key: 'delivery', name: 'Delivery', icon: 'truck', description: 'Estimates, tracking, late packages', audience: 'customer' },
  { key: 'payment', name: 'Payment', icon: 'credit-card', description: 'Methods, failed or pending payments', audience: 'customer' },
  { key: 'cancellations', name: 'Cancellations', icon: 'circle-x', description: 'Cancel items before they ship', audience: 'customer' },
  { key: 'returns', name: 'Returns', icon: 'undo-2', description: 'Windows, labels, who pays shipping', audience: 'customer' },
  { key: 'refunds', name: 'Refunds', icon: 'banknote', description: 'Refund timing and status', audience: 'customer' },
  { key: 'account', name: 'Account', icon: 'user-round', description: 'Sign-in, security, addresses', audience: 'customer' },
  { key: 'selling', name: 'Selling on Marketly', icon: 'store', description: 'Listings, product review and launch', audience: 'seller' },
  { key: 'payouts', name: 'Payouts', icon: 'landmark', description: 'Payout schedule, holds and bank accounts', audience: 'seller' },
];

export interface HelpArticleSeed {
  /** The URL slug: /help/articles/{key} */
  key: string;
  /** HELP_CATEGORIES key */
  category: string;
  title: string;
  summary: string;
  body: string;
  audience?: 'customer' | 'seller';
  /** The featured guide on the help home of its audience (one per audience) */
  featured?: boolean;
  /** A chip under the help search */
  popularSearch?: string;
  policyKeys?: string[];
}

export const HELP_ARTICLES: HelpArticleSeed[] = [
  {
    key: 'return-seller-item',
    category: 'returns',
    title: 'Returning an item bought from a marketplace seller',
    summary: 'How returns to outside sellers work, who pays shipping and when Marketly steps in.',
    featured: true,
    popularSearch: 'Return an item',
    body: `<p>Items sold by outside sellers on Marketly are returned to that seller, not to our warehouse. The seller's return terms are shown on the product page and in your order. Every seller must accept returns for at least 30 days after delivery, and many offer longer.</p>
<h2>How to return an item</h2>
<ol><li>Go to Orders and open the order.</li><li>Choose <b>Return items</b> next to the package, then select the item and quantity.</li><li>Pick a reason and add photos if the item is damaged, defective or not as described.</li><li>Check the summary: return deadline, where it goes, who pays shipping and your refund amount.</li><li>Submit. The seller approves, asks for details or explains a rejection within 2 business days.</li><li>Pack the item and drop it off with the label or instructions you receive. Track the return on your order page.</li></ol>
<h2>Who pays return shipping</h2>
<table><thead><tr><th>Reason for return</th><th>Who pays return shipping</th><th>Shipping refunded</th></tr></thead><tbody><tr><td>Damaged in delivery</td><td>Seller · prepaid label</td><td>Yes</td></tr><tr><td>Incorrect item sent</td><td>Seller · prepaid label</td><td>Yes</td></tr><tr><td>Defective or not working</td><td>Seller · prepaid label</td><td>Yes</td></tr><tr><td>Changed my mind</td><td>You, unless the seller offers free returns</td><td>No</td></tr></tbody></table>
<p>Official Store items always have free return shipping. Some categories have exceptions, such as opened bedding or personal care items. See the Returns policy.</p>
<h2>When Marketly steps in</h2>
<ul><li>The seller hasn't replied to your return request within 2 business days.</li><li>The seller rejected the return and you don't agree with the reason.</li><li>Your refund hasn't been sent within 3 business days after the seller received the item.</li></ul>
<p>Choose <b>Ask Marketly to help</b> on the return. Our team reviews the purchase terms, tracking, photos and messages, then makes a decision. You can appeal a decision within 14 days.</p>`,
    policyKeys: ['returns'],
  },
  {
    key: 'late-package',
    category: 'delivery',
    title: 'My package is late. What can I do?',
    summary: 'What to check first, and when you can cancel for a full refund.',
    popularSearch: 'Late package',
    body: `<p>Each package shows its own delivery estimate on the order page. Estimates combine the seller's dispatch time and the carrier's transit time to your ZIP code.</p>
<h2>What to check first</h2><ul><li>Open the order and check the tracking for that package.</li><li>If the seller reported a delay, the new dispatch date is shown on the package.</li></ul>
<h2>What you can do</h2><ul><li>Report the problem from the order page. The seller responds first; Marketly steps in after 2 business days.</li><li>If an item doesn't ship within 14 days of its estimate, you can cancel it for a full refund.</li></ul>`,
    policyKeys: ['shipping'],
  },
  {
    key: 'several-packages',
    category: 'delivery',
    title: 'Why did my order arrive in several packages?',
    summary: 'One order can have one package per seller or ship-from location.',
    body: `<p>One order can contain items from the Official Store and from several marketplace sellers. Each seller ships its own items, so you get one package per seller or ship-from location, each with its own tracking and delivery estimate.</p><p>Shipping costs are shown per package at checkout. Returns and cancellations work per item, so a problem with one package never affects the others.</p>`,
  },
  {
    key: 'payment-pending',
    category: 'payment',
    title: 'My payment is pending. Was I charged?',
    summary: 'What a pending payment means and why you are never charged twice.',
    popularSearch: 'Payment pending',
    body: `<p>Sometimes the bank doesn't answer right away. While the result is uncertain, your order shows <b>Payment pending</b> and we don't charge you twice if you try again.</p><ul><li>Most pending payments resolve within a few minutes.</li><li>If the payment fails, any hold on your card is released by your bank, usually within 3–5 business days.</li><li>An order is accepted only when the payment is accepted. We email a confirmation only then.</li></ul>`,
    policyKeys: ['purchase_terms'],
  },
  {
    key: 'refund-timing',
    category: 'refunds',
    title: 'How long do refunds take to reach my card?',
    summary: 'Refund steps from Requested to Sent, and bank processing times.',
    body: `<p>Refunds go back to your original payment method. You see each step on the return or cancellation: Requested, Under review, Approved, Processing, Sent.</p><ul><li>Approved doesn't mean the money has arrived. Banks take 3–5 business days after we send it.</li><li>Partial returns refund only the returned items and their share of any discount.</li></ul>`,
    policyKeys: ['returns'],
  },
  {
    key: 'official-verified',
    category: 'shopping',
    title: 'What do Official Store and Verified seller mean?',
    summary: 'The labels on offers and what we check before a seller can sell.',
    body: `<p><b>Official Store</b> items are sold and shipped by Marketly. We own the stock and handle service. It isn't a ranking: other sellers may offer a better price.</p><p><b>Verified seller</b> means we checked the business registration, owner identity, payout account and return address. We don't inspect every product a seller sends.</p><p><b>Sponsored</b> means a seller or brand paid for the position. It's always labelled and doesn't change the price.</p>`,
    policyKeys: ['seller_rules'],
  },
  {
    key: 'how-reviews-work',
    category: 'shopping',
    title: 'How reviews and ratings work',
    summary: 'Who can review, what we check, and when a review is removed.',
    body: `<p>Product reviews come from customers who bought the item on Marketly and received it. Those reviews carry the <b>Verified Purchase</b> label. Seller feedback (delivery, packing, service) is kept separate from product reviews, so a late package doesn't lower a product's rating.</p>
<h2>Writing a review</h2><ul><li>Open the order and choose <b>Write a review</b> next to the delivered item.</li><li>Give a rating, a headline and your experience. Photos are welcome.</li><li>You can edit or delete your review later from Account › Reviews.</li></ul>
<h2>What we remove</h2><p>We remove reviews that break the review rules: personal information, offensive language, reviews about something other than the product, and reviews paid for or written by someone with a stake in the product. Honest negative reviews are never removed.</p>
<h2>Reporting and appeals</h2><p>Choose <b>Report</b> on any review, answer or seller response you think breaks the rules. The reporter and the author both see the outcome, and the author can appeal a decision; a different moderator reviews the appeal.</p>`,
  },
  {
    key: 'why-you-see-ads',
    category: 'shopping',
    title: 'Why you see ads and sponsored products',
    summary: 'How ads are labelled, where they never appear, and what they use.',
    body: `<p>Some places in the store show ads: banners, sponsored products and sponsored stores. Every ad carries an <b>Ad</b> or <b>Sponsored</b> label, and a promoted offer always names the seller behind it. Paying for a position never changes the price you pay.</p>
<h2>Where ads never appear</h2><p>Ads never cover checkout, payment results, order tracking or returns. Only one overlay is shown at a time, always with a visible close control.</p>
<h2>What ads are based on</h2><p>On the Marketly website, ads are chosen from the page you are on (for example the category or your search), not from a personal profile.</p>
<p>Search results are ranked by relevance first. Choose <b>How results are ranked</b> under any search for the details.</p>`,
  },
  {
    key: 'cancel-before-ship',
    category: 'cancellations',
    title: 'Cancel items before they ship',
    summary: 'Cancelling one item never cancels the rest of the order.',
    body: `<p>You can cancel an item until its seller ships it. Open the order, choose <b>Cancel items</b> and select what to cancel. Items that are already being packed may need the seller to confirm.</p><p>Cancelling one item doesn't cancel the rest of the order. The refund for a cancelled item, including its share of any discount, goes back to your payment method.</p>`,
    policyKeys: ['purchase_terms'],
  },
  {
    key: 'account-security',
    category: 'account',
    title: 'Keep your account secure',
    summary: 'Passwords, 2-step verification and signed-in devices.',
    body: `<p>Use a password you don't use anywhere else and turn on 2-step verification in Security. You can see every device signed in to your account and sign out the ones you don't recognize.</p><p>Marketly never asks for your password or a verification code by phone or email.</p>`,
  },
  {
    key: 'seller-launch-review',
    category: 'selling',
    audience: 'seller',
    title: 'Fix a rejected or changes-requested product',
    summary: 'What the review notes mean and how to resubmit.',
    featured: true,
    popularSearch: 'Changes requested',
    body: `<p>Every new product is reviewed before it goes live. When we ask for changes, the product page in Seller Center lists each issue with the field it refers to.</p><ol><li>Open the product from Products → Changes requested.</li><li>Fix each listed issue: photos, title, key features or variant details.</li><li>Submit again. Most resubmissions are reviewed within one business day.</li></ol><p>Your offers on the product publish automatically once it is approved.</p>`,
  },
  {
    key: 'seller-payout-schedule',
    category: 'payouts',
    audience: 'seller',
    title: 'Payout schedule and holds',
    summary: 'When sales proceeds become available and how payouts are sent.',
    popularSearch: 'Payout schedule',
    body: `<p>Proceeds from a sale stay pending until the item is delivered and the hold period passes. Then they become available and are included in the next weekly payout to your verified bank account.</p><ul><li>New sellers may have a longer hold for their first orders.</li><li>Changing your payout account pauses payouts for 72 hours while we verify the change.</li></ul>`,
  },
];

/** The About page (text blocks only: the simulator publishes no images) */
export const ABOUT_PAGE = {
  slug: 'about',
  title: 'About Marketly',
  eyebrow: 'About us',
  intro: 'Marketly is a US marketplace where you can buy from the Marketly Official Store and from checked independent sellers, with the delivery date, total price and return terms shown before you pay.',
  blocks: [
    { type: 'text' as const, id: 'who', title: 'Who we are', body: '<p>Marketly, Inc. runs the store, takes payment and provides customer support. The Official Store is our own shop: we buy the stock, keep it in our Portland, OR fulfillment center and ship it ourselves. Independent sellers list their own offers on the same product pages, so you can compare price, delivery and return terms side by side.</p>' },
    { type: 'text' as const, id: 'checks', title: 'How we check sellers', body: '<ul><li><b>Application review.</b> We review the business, its products and where it ships from before approving it.</li><li><b>Identity and bank checks.</b> We confirm who owns the business and that payouts go to a verified US bank account.</li><li><b>Ongoing performance.</b> We track on-time dispatch, cancellations, replies and unresolved cases.</li><li><b>Restrictions when needed.</b> Sellers who miss our standards can be restricted. Your existing orders are still looked after.</li></ul>' },
    { type: 'text' as const, id: 'labels', title: 'What our labels mean', body: '<ul><li><b>Official Store:</b> sold and shipped by Marketly. It isn’t a ranking: other sellers may offer a better price.</li><li><b>Verified seller:</b> we checked the business registration, owner identity, payout account and return address. We don’t inspect every product a seller sends.</li><li><b>Sponsored:</b> a seller or brand paid for the position. It’s always labelled and doesn’t change the price.</li></ul>' },
    { type: 'text' as const, id: 'contact', title: 'Contact', body: '<p>Marketly, Inc. · 500 Market St, Portland, OR 97204. For help with an order, use the Help Center.</p>' },
  ],
};
