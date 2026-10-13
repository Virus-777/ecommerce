import type { ScreenId } from '@marketly/web-shared/routes';
import type { IconName } from '@marketly/web-shared/ui';

// Seller help articles (sample content until the help CMS is wired: admin/help-content).
// Shaped like API rows: plain data, links as screen ids, never literal paths.
// Rules quoted here match the other Seller Center screens: 10% example fee on the fee basis, weekly
// Monday payouts with a Sunday 11:59 PM PT cutoff and a 3-day hold after delivery, dispatch by 5:00 PM
// on the last day of the handling time, 2-business-day return responses, 14-day appeal windows.
// Text supports **bold**.

export type HelpCategoryKey = 'fees' | 'listings' | 'shipping' | 'returns' | 'health' | 'ads';

export interface HelpCategory {
  key: HelpCategoryKey;
  label: string;
  icon: IconName;
  desc: string;
  /** Topic preselected in the Contact seller support form. */
  supportTopic: string;
}

/** A link to a Seller Center screen or to another article. */
export type HelpLink = { label: string; screen: ScreenId; view?: string; params?: Record<string, string> } | { label: string; article: string };

export interface HelpStep {
  title: string;
  text: string;
  link?: HelpLink;
}

export interface HelpSummaryRow {
  k: string;
  v: string;
  tone?: 'neg' | 'deal';
  strong?: boolean;
  total?: boolean;
}

export interface HelpSection {
  id: string;
  heading: string;
  text?: string[];
  steps?: HelpStep[];
  bullets?: string[];
  table?: { label: string; head: string[]; rows: string[][]; note?: string };
  /** A worked calculation (fee example), rendered with summary rows. */
  calc?: { rows: HelpSummaryRow[]; note?: string };
  links?: HelpLink[];
}

export type HelpFacts =
  | { kind: 'kv'; title: string; pairs: Array<[string, string]> }
  | { kind: 'ticks'; title: string; noLabel: string; no: string[]; okLabel: string; ok: string[]; note?: string };

export interface HelpArticle {
  slug: string;
  category: HelpCategoryKey;
  /** Short name used in lists (the Help page's article links). */
  label: string;
  /** The page title, phrased as the seller's question. */
  title: string;
  /** One-line answer shown first. */
  summary: string;
  /** ISO date of the last content change. */
  updated: string;
  /** Who in the seller account can do what the article describes. */
  who?: string;
  /** Recent rule change, shown above the content. */
  change?: { date: string; text: string };
  facts?: HelpFacts;
  sections: HelpSection[];
  /** Main screen for this task (the "Go to" card). */
  action?: { title: string; text: string; link: HelpLink };
  related: string[];
  keywords?: string[];
}

export const HELP_CATEGORIES: HelpCategory[] = [
  { key: 'fees', label: 'Fees and payouts', icon: 'wallet', desc: 'How commission is calculated, when earnings become available, holds and statements.', supportTopic: 'Fees and payouts' },
  { key: 'listings', label: 'Listing rules and rejected submissions', icon: 'file-check', desc: 'What reviewers check and how to fix a submission.', supportTopic: 'Listing rules and rejected submissions' },
  { key: 'shipping', label: 'Shipping and dispatch targets', icon: 'truck', desc: 'Dispatch deadlines, valid tracking and late shipments.', supportTopic: 'Shipping and dispatch' },
  { key: 'returns', label: 'Returns and disputes', icon: 'undo-2', desc: 'Response targets, who pays return shipping and how disputes are decided.', supportTopic: 'Returns and disputes' },
  { key: 'health', label: 'Account health and restrictions', icon: 'gauge', desc: 'Targets, warnings, restrictions and how to appeal.', supportTopic: 'Account health and restrictions' },
  { key: 'ads', label: 'Advertising', icon: 'megaphone', desc: 'Sponsored products and stores, billing and review.', supportTopic: 'Advertising' },
];

export const HELP_ARTICLES: HelpArticle[] = [
  /* ---------------- Fees and payouts ---------------- */
  {
    slug: 'how-the-fee-basis-works',
    category: 'fees',
    label: 'How the fee basis works',
    title: 'How is my marketplace fee calculated?',
    summary: 'The fee is a percentage of the fee basis: the item price minus any discount you fund. Shipping you charge, sales tax and discounts Marketly funds are never part of it.',
    updated: '2026-09-21',
    who: 'Owners and staff with Finance access can see fees on statements.',
    facts: {
      kind: 'kv',
      title: 'Key facts',
      pairs: [
        ['Fee basis', 'Item price minus seller-funded discount'],
        ['Rate', '10% in these examples. Your rate per category is in your seller agreement.'],
        ['No fee on', 'Shipping you charge, sales tax, Marketly-funded discounts and coupons'],
        ['When it’s taken', 'When the order is accepted. Earnings stay pending until delivery plus 3 days.'],
        ['Refunds', 'The fee on the refunded amount is returned to you'],
      ],
    },
    sections: [
      {
        id: 'example',
        heading: 'A worked example',
        text: ['A customer buys a $100.00 item. You run a 10% discount and charge $6.99 shipping.'],
        calc: {
          rows: [
            { k: 'Item price', v: '$100.00' },
            { k: 'Your discount (seller-funded)', v: '−$10.00', tone: 'deal' },
            { k: 'Fee basis', v: '$90.00', strong: true },
            { k: 'Marketplace fee, 10% of fee basis', v: '−$9.00', tone: 'neg' },
            { k: 'Shipping you charged (no fee)', v: '$6.99' },
            { k: 'Your earnings', v: '$87.99', total: true },
          ],
          note: 'Without the discount, the fee basis is $100.00 and the fee is $10.00. If Marketly had funded the same discount in a platform campaign, the fee basis would stay $100.00 and Marketly would pay you the $10.00 difference.',
        },
      },
      {
        id: 'what-changes-it',
        heading: 'What changes the fee basis',
        bullets: [
          '**Discounts you create** in Marketing lower the fee basis, so you pay less fee on a discounted sale.',
          '**Platform campaigns and Marketly coupons** are funded by Marketly. They don’t lower your fee basis or your earnings.',
          '**Price changes** apply to orders placed after you save them. Orders already placed keep the price the customer paid.',
          '**Partial refunds** recalculate the fee on what the customer kept paying, and the difference is returned to you.',
        ],
        links: [{ label: 'Open discounts in Marketing', screen: 'seller/marketing' }],
      },
      {
        id: 'check',
        heading: 'Check the fee on an order',
        steps: [
          { title: 'Open the order', text: 'The earnings panel on the order shows the fee basis, the fee and what you receive.', link: { label: 'Open an order', screen: 'seller/order' } },
          { title: 'Find it on your statement', text: 'Each payout statement lists the sales, fees, refunds and holds behind the payout, line by line.', link: { label: 'Open a payout statement', screen: 'seller/statement' } },
          { title: 'Report a fee that looks wrong', text: 'Contact seller support with the order number. Corrections appear as an adjustment on your next statement.' },
        ],
      },
    ],
    action: { title: 'See it on a real statement', text: 'Fees are listed for every order in the payout.', link: { label: 'Open payout statement', screen: 'seller/statement' } },
    related: ['payout-schedule-and-cutoffs', 'refunds-after-payout-and-negative-balances', 'how-ad-charges-are-billed', 'partial-refunds-and-reasons'],
    keywords: ['commission', 'fee', 'rate', 'discount', 'earnings'],
  },
  {
    slug: 'payout-schedule-and-cutoffs',
    category: 'fees',
    label: 'Payout schedule and cutoffs',
    title: 'When do I get paid?',
    summary: 'Payouts go out every Monday. Earnings become available 3 days after delivery, and everything available by the Sunday 11:59 PM PT cutoff is in that Monday’s payout.',
    updated: '2026-09-28',
    who: 'Only the store owner can change the payout account.',
    facts: {
      kind: 'kv',
      title: 'Key facts',
      pairs: [
        ['Schedule', 'Weekly, on Mondays'],
        ['Cutoff', 'Sunday, 11:59 PM PT'],
        ['Available', '3 days after delivery (the hold period)'],
        ['Arrives', 'Usually 1–2 business days after we send it, depending on your bank'],
        ['Holds', 'Earnings for one order can be withheld, always with a reason and a review date'],
      ],
    },
    sections: [
      {
        id: 'stages',
        heading: 'How earnings move',
        steps: [
          { title: 'Pending', text: 'After the order is accepted, your earnings (after fees) wait for delivery plus the 3-day hold.' },
          { title: 'Available', text: 'They move to available on their own. Refunds and holds are taken off first.' },
          { title: 'Paid out', text: 'At the Sunday cutoff, the whole available balance is set as Monday’s payout and sent to your bank account.', link: { label: 'View balances in Finance', screen: 'seller/finance' } },
        ],
      },
      {
        id: 'holds',
        heading: 'When earnings are held',
        text: ['A hold applies to a specific order, for example when the carrier shows no delivery scan. Finance and the statement show the amount, the reason and the review date. When the reason is resolved, the hold is released into your available balance.'],
      },
      {
        id: 'bank',
        heading: 'Changing the payout account',
        text: ['Only the owner can change it. We verify the new account with a test deposit and Marketly Finance reviews the change (example: up to 2 business days). Payouts continue to the current account until the review is done.'],
      },
    ],
    action: { title: 'Next payout', text: 'See the estimate and what is still pending.', link: { label: 'Open Finance', screen: 'seller/finance' } },
    related: ['how-the-fee-basis-works', 'refunds-after-payout-and-negative-balances', 'uploading-valid-tracking'],
    keywords: ['payout', 'paid', 'bank', 'hold', 'cutoff', 'monday', 'available'],
  },
  {
    slug: 'refunds-after-payout-and-negative-balances',
    category: 'fees',
    label: 'Refunds after payout and negative balances',
    title: 'What happens if I refund an order that was already paid out?',
    summary: 'The refund, less the fee returned to you, comes out of your available earnings. If they don’t cover it, your balance goes negative and future earnings cover it first.',
    updated: '2026-09-28',
    sections: [
      {
        id: 'how',
        heading: 'How it’s taken',
        bullets: [
          'The refunded amount is deducted from your **available** balance, and the fee on that amount is returned to you.',
          'If available earnings aren’t enough, the balance goes **negative** and your next earnings cover it before any payout.',
          'If a negative balance isn’t covered within **30 days**, it becomes an amount you owe (example terms; see the seller agreement).',
        ],
      },
      {
        id: 'example',
        heading: 'Example',
        text: ['You refund $184.00 on an order paid out last week. The fee returned is $18.40, so $165.60 comes off your available earnings. It shows on your statement under refunds, next to the original order.'],
        links: [{ label: 'Open Finance', screen: 'seller/finance' }],
      },
    ],
    related: ['payout-schedule-and-cutoffs', 'how-the-fee-basis-works', 'partial-refunds-and-reasons'],
    keywords: ['refund', 'negative', 'balance', 'owe', 'deduct'],
  },

  /* ---------------- Listing rules ---------------- */
  {
    slug: 'photo-and-title-rules',
    category: 'listings',
    label: 'Photo and title rules',
    title: 'What do product photos and titles need to follow?',
    summary: 'Use your own photos of the real product on a plain background, and a title that says brand, product, model and key variant, with no promotional words.',
    updated: '2026-08-30',
    sections: [
      {
        id: 'photos',
        heading: 'Photos',
        bullets: [
          'Your own photos, or the brand’s official images when you can show you’re authorized to use them.',
          'The main photo shows only the product on a white or light plain background, filling most of the frame.',
          'No watermarks, logos of other stores, borders, text or prices on the image.',
          'At least 1,000 px on the longest side, JPG or PNG, up to 10 MB each.',
          'Show what’s in the box. Accessories that aren’t included must not appear in the main photo.',
        ],
      },
      {
        id: 'titles',
        heading: 'Titles',
        bullets: [
          'Order: brand, product name, model, then the variant that matters (color, size, capacity).',
          'No words like “best”, “sale”, “free shipping”, or “authorized dealer” unless you have proof on file.',
          'No other brands’ names, unless the product really is compatible and you say “for” or “compatible with”.',
          'Up to 150 characters. Use normal capitalization, not all capitals.',
        ],
      },
    ],
    related: ['fix-a-rejected-or-changes-requested-product', 'brand-claims-and-proof-documents', 'why-an-ad-was-not-approved'],
    keywords: ['photo', 'image', 'title', 'watermark', 'picture'],
  },
  {
    slug: 'brand-claims-and-proof-documents',
    category: 'listings',
    label: 'Brand claims and proof documents',
    title: 'What proof do I need to say I’m an authorized seller of a brand?',
    summary: 'An invoice from the brand or an approved distributor, or an authorization letter from the brand, dated within the last 12 months and in your business’s name.',
    updated: '2026-10-02',
    who: 'Owners and staff with Products and inventory access.',
    facts: {
      kind: 'kv',
      title: 'Key facts',
      pairs: [
        ['Accepted proof', 'Invoice from the brand or an approved distributor, or an authorization letter from the brand'],
        ['Dated', 'Within the last 12 months'],
        ['Must show', 'Your registered business name, the brand, and the products you list'],
        ['Format', 'PDF, JPG or PNG, up to 10 MB each. Prices can be covered.'],
        ['Review', 'Within 3 business days (example)'],
        ['Rule', 'Seller rules section 4.2, brand claims'],
      ],
    },
    sections: [
      {
        id: 'what-counts',
        heading: 'What counts as a brand claim',
        text: ['You need proof on file before you use any of these:'],
        bullets: [
          'Words like “authorized dealer”, “official reseller” or “brand partner” in titles, descriptions or your store profile.',
          'The brand’s campaign photos, logos or marketing videos.',
          'A brand affiliation shown on your store profile.',
        ],
      },
      {
        id: 'steps',
        heading: 'Add proof for a brand',
        steps: [
          { title: 'Find where you make the claim', text: 'Check product titles and descriptions, photos, and the About and brand fields of your store profile.', link: { label: 'Open Products and offers', screen: 'seller/products' } },
          { title: 'Get the right document', text: 'Ask your distributor for a recent invoice that names your business and the brand, or ask the brand for an authorization letter. Cover prices if you like; we only check names, dates and products.' },
          { title: 'Upload it where the claim is checked', text: 'For a restriction, choose **Upload documents** on the notice in Account health. For a new product, add the document to the submission. For your store profile, saving the brand claim asks for it.', link: { label: 'Open Account health', screen: 'seller/performance' } },
          { title: 'Wait for the review', text: 'Marketly staff review documents within 3 business days (example). We tell you the result in Seller Center and by email.' },
          { title: 'If you can’t get proof', text: 'Remove the claim and replace brand photos with your own. That resolves a brand-claim restriction too, and you don’t need to wait for documents.' },
        ],
      },
      {
        id: 'not-accepted',
        heading: 'Documents we don’t accept',
        bullets: [
          'Receipts from a retail store or another marketplace.',
          'Invoices older than 12 months, or in another business’s name.',
          'Screenshots of emails or chats instead of the document itself.',
        ],
      },
      {
        id: 'without-proof',
        heading: 'What happens without proof',
        text: ['A product with an unproven claim gets **Changes requested**. Live listings with unproven claims can be hidden and new listings for that brand or category paused until the claim is proven or removed.'],
        links: [{ label: 'What a restriction affects', article: 'what-a-restriction-affects' }],
      },
    ],
    action: { title: 'Upload proof for a restriction', text: 'The notice shows what to upload and the appeal deadline.', link: { label: 'Open Account health', screen: 'seller/performance' } },
    related: ['what-a-restriction-affects', 'how-to-appeal-a-decision', 'photo-and-title-rules', 'fix-a-rejected-or-changes-requested-product'],
    keywords: ['brand', 'authorized', 'dealer', 'invoice', 'letter', 'documents', 'proof', 'distributor'],
  },
  {
    slug: 'fix-a-rejected-or-changes-requested-product',
    category: 'listings',
    label: 'Fix a rejected or changes-requested product',
    title: 'How do I fix a rejected or changes-requested product?',
    summary: 'Open the submission, fix only the fields the reviewer flagged, and resubmit. Review usually takes up to 2 business days.',
    updated: '2026-09-14',
    who: 'Owners and staff with Products and inventory access.',
    sections: [
      {
        id: 'steps',
        heading: 'Fix and resubmit',
        steps: [
          { title: 'Find the submission', text: 'In Products and offers, filter by Changes requested or Rejected. Each one shows the reviewer and the date.', link: { label: 'Open Products and offers', screen: 'seller/products' } },
          { title: 'Read each reviewer note', text: 'Notes are attached to the field that needs work, such as a photo, the title or a specification. Common reasons: watermarked or borrowed photos, missing required attributes, brand claims without proof, a duplicate of an existing product.', link: { label: 'Open a product with changes requested', screen: 'seller/product-new', view: 'changes-requested' } },
          { title: 'Fix the flagged fields', text: 'Only flagged fields need changes. For a duplicate, add your offer to the existing product instead.', link: { label: 'Find the product in the catalog', screen: 'seller/catalog-match' } },
          { title: 'Resubmit', text: 'The status goes back to Submitted. Review usually takes up to 2 business days (example).' },
          { title: 'If it was rejected', text: 'The rejection explains the rule that applies. You can submit a corrected version or appeal the decision.' },
        ],
      },
    ],
    related: ['photo-and-title-rules', 'brand-claims-and-proof-documents', 'how-to-appeal-a-decision'],
    keywords: ['rejected', 'changes-requested', 'changes requested', 'submission', 'resubmit', 'review'],
  },

  /* ---------------- Shipping ---------------- */
  {
    slug: 'dispatch-deadline-rules',
    category: 'shipping',
    label: 'Dispatch deadline rules',
    title: 'When do I have to dispatch an order?',
    summary: 'By 5:00 PM PT on the last day of your handling time. Orders placed before your same-day cutoff count today as day one; later orders start on your next working day.',
    updated: '2026-10-05',
    who: 'Owners and staff with Shipping access.',
    facts: {
      kind: 'kv',
      title: 'Key facts',
      pairs: [
        ['Deadline', '5:00 PM PT on the last day of your handling time'],
        ['Handling time', 'Same business day to 3 business days, set in Shipping settings'],
        ['Day one', 'Today if the order arrives before your cutoff on a working day, otherwise your next working day'],
        ['Dispatched means', 'Valid tracking recorded, and the carrier scans the package within 24 hours'],
        ['Target', 'At least 95% dispatched on time over 30 days'],
      ],
    },
    sections: [
      {
        id: 'examples',
        heading: 'Examples',
        text: ['With a 1 business day handling time, a 12:00 PM PT cutoff and Monday to Friday working days:'],
        table: {
          label: 'Dispatch deadline examples',
          head: ['Order placed', 'Day one', 'Dispatch by'],
          rows: [
            ['Thu, 10:30 AM PT', 'Thursday', 'Thu, 5:00 PM PT'],
            ['Thu, 2:15 PM PT (after cutoff)', 'Friday', 'Fri, 5:00 PM PT'],
            ['Sat, 9:00 AM PT (not a working day)', 'Monday', 'Mon, 5:00 PM PT'],
            ['Wed, Nov 25, 3:00 PM PT (closed Nov 26–27)', 'Mon, Nov 30', 'Mon, Nov 30, 5:00 PM PT'],
          ],
          note: 'A 2 business day handling time adds one more working day. The exact deadline is always shown on the order.',
        },
      },
      {
        id: 'steps',
        heading: 'Keep your deadlines accurate',
        steps: [
          { title: 'Set handling time, cutoff and working days', text: 'Choose the handling time you can meet on a normal day. Changes apply to orders placed after you save.', link: { label: 'Open Shipping settings', screen: 'seller/shipping' } },
          { title: 'Add closures ahead of time', text: 'Add holidays and closures before they start (for the holiday season, by Nov 15) so arrival estimates stay accurate. Closures move day one; they don’t pause orders already due.' },
          { title: 'Work the New and Preparing tabs', text: 'Orders are sorted by dispatch deadline. Red edges are overdue, amber edges are due today.', link: { label: 'Open Orders', screen: 'seller/orders' } },
          { title: 'Record the shipment', text: 'Enter the carrier and tracking number on the order before the deadline. The customer gets the tracking right away.', link: { label: 'Open an order to ship', screen: 'seller/order' } },
        ],
      },
      {
        id: 'late',
        heading: 'If you miss the deadline',
        bullets: [
          'The order shows as overdue and the customer is told it is running late. They can contact support.',
          'Late dispatches lower your dispatch reliability. Several in one week can lead to a warning.',
          'If you can’t ship at all, cancel the items instead of leaving them open.',
        ],
        links: [{ label: 'When you can’t fulfill an order', article: 'when-you-cant-fulfill-an-order' }],
      },
    ],
    action: { title: 'Orders due today', text: 'Sorted by dispatch deadline.', link: { label: 'Open Orders', screen: 'seller/orders' } },
    related: ['uploading-valid-tracking', 'when-you-cant-fulfill-an-order', 'what-each-metric-measures'],
    keywords: ['dispatch', 'deadline', 'late', 'handling', 'cutoff', 'ship by', 'holiday'],
  },
  {
    slug: 'uploading-valid-tracking',
    category: 'shipping',
    label: 'Uploading valid tracking',
    title: 'What counts as valid tracking?',
    summary: 'A tracking number from the carrier that actually has the package, in that carrier’s format, which the carrier scans within 24 hours.',
    updated: '2026-09-18',
    who: 'Owners and staff with Shipping access.',
    sections: [
      {
        id: 'formats',
        heading: 'Tracking formats we check',
        table: {
          label: 'Tracking number formats',
          head: ['Carrier', 'Format'],
          rows: [
            ['UPS', 'Starts with 1Z, 18 characters'],
            ['USPS', '20 to 22 digits'],
            ['FedEx', '12 or 15 digits'],
            ['OnTrac', 'C or D, then 14 digits'],
            ['Other carriers', 'At least 6 letters or digits'],
          ],
          note: 'Spaces and hyphens are ignored.',
        },
      },
      {
        id: 'rules',
        heading: 'Rules',
        bullets: [
          'Record tracking for every package. For a partial shipment, the rest keeps its own dispatch deadline.',
          'A number with no carrier scan within 24 hours doesn’t count as dispatched, and earnings for the order can be held.',
          'To fix a typo or a relabelled package, use **Edit tracking** on the order and give a reason. The customer gets the new number.',
        ],
        links: [{ label: 'Open an order', screen: 'seller/order', view: 'shipped' }],
      },
    ],
    related: ['dispatch-deadline-rules', 'payout-schedule-and-cutoffs', 'when-you-cant-fulfill-an-order'],
    keywords: ['tracking', 'carrier', 'ups', 'usps', 'fedex', 'ontrac', 'scan'],
  },
  {
    slug: 'when-you-cant-fulfill-an-order',
    category: 'shipping',
    label: 'When you can’t fulfill an order',
    title: 'What should I do if I can’t fulfill an order?',
    summary: 'Cancel only the items you can’t ship, as soon as you know. The customer is refunded right away, and the cancellation counts toward your cancellation rate.',
    updated: '2026-09-18',
    who: 'Owners and staff with Shipping access.',
    sections: [
      {
        id: 'steps',
        heading: 'Cancel the items',
        steps: [
          { title: 'Open the order', text: 'Ship what you can first. Shipping fewer than ordered creates a partial shipment.', link: { label: 'Open the order', screen: 'seller/order' } },
          { title: 'Cancel the rest', text: 'Choose the quantity and a reason: out of stock, damaged in storage, pricing error, can’t ship to this address, or other.' },
          { title: 'Fix the cause', text: 'Correct the stock count so the item can’t be sold again before you have it.', link: { label: 'Open Inventory', screen: 'seller/inventory' } },
        ],
      },
      {
        id: 'effects',
        heading: 'What it affects',
        bullets: [
          'Seller cancellations count toward your cancellation rate (target: at most 2.5% over 30 days).',
          'Cancellations the customer asks for before dispatch don’t count. Answer them in the Cancellation requests tab of Orders.',
        ],
        links: [{ label: 'Open cancellation requests', screen: 'seller/orders', view: 'cancellation-requests' }],
      },
    ],
    related: ['dispatch-deadline-rules', 'what-each-metric-measures', 'uploading-valid-tracking'],
    keywords: ['cancel', 'out of stock', 'fulfill', 'cancellation'],
  },

  /* ---------------- Returns ---------------- */
  {
    slug: 'responding-to-a-return-request',
    category: 'returns',
    label: 'Responding to a return request',
    title: 'How do I respond to a return request?',
    summary: 'Approve it, ask for information or reject it with a reason before the respond-by time, 2 business days after the request. If you miss it, Marketly support may decide.',
    updated: '2026-10-06',
    who: 'Owners and staff with Customer service access.',
    change: { date: 'Nov 1, 2026', text: 'Electronics return windows stay at 30 days. Restocking fees for opened headphones are no longer allowed.' },
    facts: {
      kind: 'kv',
      title: 'Key facts',
      pairs: [
        ['Respond by', '2 business days after the request'],
        ['Asking for information', 'Pauses the clock until the customer replies, up to 3 days'],
        ['Return window', 'At least 30 days after delivery (Electronics: 30 days)'],
        ['Inspect and refund', 'Within 2 days of receiving the item (example target)'],
        ['Refund arrives', 'Customers are told 3–5 business days after you confirm'],
      ],
    },
    sections: [
      {
        id: 'steps',
        heading: 'Respond to the request',
        steps: [
          { title: 'Open the request', text: 'Return requests are sorted by respond-by time. Check the reason, photos and the terms the customer accepted at purchase.', link: { label: 'Open Returns and cases', screen: 'seller/returns' } },
          { title: 'Choose a response', text: '**Approve** sends return instructions. **Request information** asks the customer a question. **Reject** is only for requests that break your published terms, for example outside the return window, and needs a reason.', link: { label: 'Open a return case', screen: 'seller/return' } },
          { title: 'Send the label if you pay', text: 'For defective, damaged or wrong items you pay return shipping and the customer gets a prepaid label. Your return address comes from Shipping settings.', link: { label: 'Check your return address', screen: 'seller/shipping' } },
          { title: 'Inspect and refund', text: 'When the item arrives, record its condition and refund within 2 days. A partial refund needs a recorded reason.', link: { label: 'Inspect and refund', screen: 'seller/return', view: 'inspect-and-refund' } },
        ],
      },
      {
        id: 'shipping',
        heading: 'Who pays return shipping',
        table: {
          label: 'Who pays return shipping table',
          head: ['Return reason', 'Who pays return shipping', 'Original shipping refunded'],
          rows: [
            ['Damaged in delivery', 'You · prepaid label', 'Yes'],
            ['Incorrect item sent', 'You · prepaid label', 'Yes'],
            ['Defective or not working', 'You · prepaid label', 'Yes'],
            ['Changed mind', 'The customer, unless you offer free returns', 'No'],
          ],
          note: 'These are platform rules. Your own terms can be more generous, never stricter.',
        },
      },
      {
        id: 'escalation',
        heading: 'When Marketly support steps in',
        bullets: [
          'You don’t respond by the respond-by time.',
          'You reject the return and the customer disagrees.',
          'The refund isn’t sent within 3 business days after you receive the item.',
        ],
        links: [{ label: 'Disputes, evidence and appeals', article: 'disputes-evidence-and-appeals' }],
      },
    ],
    action: { title: 'Requests waiting for you', text: 'Sorted by respond-by time.', link: { label: 'Open Returns and cases', screen: 'seller/returns' } },
    related: ['partial-refunds-and-reasons', 'disputes-evidence-and-appeals', 'refunds-after-payout-and-negative-balances', 'what-each-metric-measures'],
    keywords: ['return', 'respond', 'approve', 'reject', 'label', 'restocking', 'window'],
  },
  {
    slug: 'partial-refunds-and-reasons',
    category: 'returns',
    label: 'Partial refunds and reasons',
    title: 'When can I give a partial refund?',
    summary: 'Only when the returned item isn’t in the condition it was sold, such as missing parts or damage after delivery, and you record the reason for the customer.',
    updated: '2026-10-06',
    change: { date: 'Nov 1, 2026', text: 'Restocking fees for opened headphones are no longer allowed.' },
    sections: [
      {
        id: 'allowed',
        heading: 'Allowed',
        bullets: [
          'Missing parts or accessories: deduct the replacement cost, for example $6.00 for a charging cable that wasn’t returned.',
          'Damage caused after delivery, shown in your inspection photos.',
        ],
      },
      {
        id: 'not-allowed',
        heading: 'Not allowed',
        bullets: [
          'Deductions on defective, damaged-in-delivery or wrong items.',
          'Restocking fees for opened headphones (from Nov 1, 2026).',
          'Refunding more than the customer paid, or less with no explanation.',
        ],
      },
      {
        id: 'how',
        heading: 'How to record it',
        text: ['On the return case, choose the item condition, then **Partial refund**, enter the amount and an explanation the customer will see. The customer can ask Marketly to review it.'],
        links: [{ label: 'Inspect and refund', screen: 'seller/return', view: 'inspect-and-refund' }],
      },
    ],
    related: ['responding-to-a-return-request', 'disputes-evidence-and-appeals', 'refunds-after-payout-and-negative-balances'],
    keywords: ['partial', 'refund', 'deduction', 'missing parts', 'restocking'],
  },
  {
    slug: 'disputes-evidence-and-appeals',
    category: 'returns',
    label: 'Disputes, evidence and appeals',
    title: 'How are disputes decided, and how do I add evidence?',
    summary: 'Marketly support reviews the purchase terms, shipment records, photos and messages on the case, then records a decision you can appeal within 14 days.',
    updated: '2026-09-25',
    who: 'Owners and staff with Customer service access.',
    sections: [
      {
        id: 'steps',
        heading: 'Add your side',
        steps: [
          { title: 'Open the dispute', text: 'Disputes have their own tab, with the next deadline on each row.', link: { label: 'Open disputes', screen: 'seller/returns', view: 'disputes' } },
          { title: 'Add evidence', text: 'Attach tracking, delivery confirmation, inspection photos and anything the customer sent you. Add files early so they’re on record when support reviews.', link: { label: 'Open a return case', screen: 'seller/return' } },
          { title: 'Reply to support', text: 'Answer questions on the case before the deadline shown. Unanswered questions are decided on the evidence already there.' },
          { title: 'Read the decision', text: 'The decision explains what was found, any refund you are charged, and the appeal deadline.' },
        ],
      },
      {
        id: 'appeal',
        heading: 'Appealing',
        text: ['You can appeal within 14 days of the decision, once. A different reviewer decides.'],
        links: [{ label: 'How to appeal a decision', article: 'how-to-appeal-a-decision' }],
      },
    ],
    related: ['responding-to-a-return-request', 'how-to-appeal-a-decision', 'partial-refunds-and-reasons'],
    keywords: ['dispute', 'evidence', 'case', 'decision', 'appeal', 'escalated'],
  },

  /* ---------------- Account health ---------------- */
  {
    slug: 'what-each-metric-measures',
    category: 'health',
    label: 'What each metric measures',
    title: 'What does each account health metric measure?',
    summary: 'Five targets over the last 30 days: dispatch reliability, cancellations, returns, unresolved cases and policy violations. They update daily at 6:00 AM PT.',
    updated: '2026-09-30',
    sections: [
      {
        id: 'targets',
        heading: 'Targets',
        table: {
          label: 'Account health targets',
          head: ['Metric', 'What it counts', 'Target'],
          rows: [
            ['Dispatch reliability', 'Orders with valid tracking by the dispatch deadline', 'At least 95%'],
            ['Cancellation rate', 'Orders you cancelled, of all orders', 'At most 2.5%'],
            ['Return rate', 'Units returned, of units sold, by category', 'At most 8% for Electronics'],
            ['Unresolved cases', 'Return requests and cases past their deadline', '0 past their deadline'],
            ['Policy violations', 'Confirmed breaks of the seller rules', '0 in 90 days'],
          ],
          note: 'Message response time (within 24 hours) is shown on your dashboard as a guide, not a target.',
        },
      },
      {
        id: 'missing',
        heading: 'If you miss a target',
        text: ['Missing targets repeatedly can lead to warnings, restrictions or suspension. We always tell you the reason, what is affected and how to appeal.'],
        links: [{ label: 'What a restriction affects', article: 'what-a-restriction-affects' }],
      },
    ],
    action: { title: 'Your account health', text: 'Your numbers against each target.', link: { label: 'Open Account health', screen: 'seller/performance' } },
    related: ['what-a-restriction-affects', 'dispatch-deadline-rules', 'when-you-cant-fulfill-an-order'],
    keywords: ['metric', 'target', 'health', 'rate', 'performance'],
  },
  {
    slug: 'what-a-restriction-affects',
    category: 'health',
    label: 'What a restriction affects',
    title: 'What does a restriction affect?',
    summary: 'Only the activity named in the notice, such as new listings in one category. Existing orders, returns, customer messages and payouts keep working unless the notice says otherwise.',
    updated: '2026-10-02',
    facts: {
      kind: 'ticks',
      title: 'What this affects',
      noLabel: 'Paused by a category restriction',
      no: ['Creating new offers in that category', 'Reactivating listings the restriction hid', 'Sponsored campaigns for those listings'],
      okLabel: 'Keeps working',
      ok: ['Existing orders, dispatch and shipping', 'Returns, refunds and cases', 'Customer messages and questions', 'Payouts and statements', 'All listings in other categories'],
      note: 'Example: the Cameras restriction RS-261002-0019. Your notice lists exactly what yours affects.',
    },
    sections: [
      {
        id: 'types',
        heading: 'Types of action',
        table: {
          label: 'Types of account action',
          head: ['Action', 'What stops', 'Ends when'],
          rows: [
            ['Warning', 'Nothing. It tells you about a problem before it affects selling.', 'The problem doesn’t repeat, usually 7 days'],
            ['Restriction', 'One activity, such as new listings in a category', 'You resolve the cause or win an appeal'],
            ['Payout hold', 'Earnings for one order, with a reason and review date', 'The reason is resolved'],
            ['Suspension', 'Selling on the whole account. Open orders must still be shipped.', 'An appeal or review lifts it'],
          ],
        },
      },
      {
        id: 'notice',
        heading: 'What every notice tells you',
        bullets: ['The reason, and the seller rule it’s based on.', 'Exactly which activity is affected, and what still works.', 'How to resolve it, and the appeal deadline (14 days after the notice).', 'Who applied it, and a reference like RS-261002-0019 to quote to support.'],
      },
      {
        id: 'steps',
        heading: 'Resolve or appeal a restriction',
        steps: [
          { title: 'Read the notice', text: 'Open Account health. The notice shows the reason, the affected activity and the deadline.', link: { label: 'Open Account health', screen: 'seller/performance' } },
          { title: 'Fix the cause', text: 'For example, remove an unproven brand claim and replace the photos, or upload documents that prove it.', link: { label: 'Brand claims and proof documents', article: 'brand-claims-and-proof-documents' } },
          { title: 'Upload documents', text: 'Choose **Upload documents** on the notice. Marketly reviews within 3 business days (example) and lifts the restriction if it is resolved.' },
          { title: 'Or appeal', text: 'If you think the restriction is wrong, choose **Appeal restriction** before the deadline. A second reviewer decides.', link: { label: 'How to appeal a decision', article: 'how-to-appeal-a-decision' } },
          { title: 'After it’s lifted', text: 'Listings the restriction hid return to their previous status on their own. Offers you paused yourself stay paused.' },
        ],
      },
    ],
    action: { title: 'Check your restrictions', text: 'Open notices, deadlines and what is affected.', link: { label: 'Open Account health', screen: 'seller/performance' } },
    related: ['how-to-appeal-a-decision', 'brand-claims-and-proof-documents', 'what-each-metric-measures', 'payout-schedule-and-cutoffs'],
    keywords: ['restriction', 'restricted', 'paused', 'suspension', 'warning', 'blocked', 'health'],
  },
  {
    slug: 'how-to-appeal-a-decision',
    category: 'health',
    label: 'How to appeal a decision',
    title: 'How do I appeal a decision?',
    summary: 'Choose Appeal on the decision within 14 days and explain what you changed or why it was wrong. A second reviewer, not the person who made the decision, decides.',
    updated: '2026-10-02',
    facts: {
      kind: 'kv',
      title: 'Key facts',
      pairs: [
        ['Deadline', '14 days after the decision, shown on it'],
        ['Who decides', 'A second Seller Manager reviewer, not the person who decided'],
        ['Decision time', 'Within 3 business days (example)'],
        ['During review', 'The decision stays in place until the appeal is decided'],
        ['How many', 'One appeal per decision. After that, contact support with new evidence.'],
      ],
    },
    sections: [
      {
        id: 'what',
        heading: 'What you can appeal',
        bullets: ['Restrictions and suspensions (Account health).', 'Rejected product submissions (Products and offers).', 'Dispute decisions on returns and cases (Returns and cases).'],
      },
      {
        id: 'steps',
        heading: 'Send an appeal',
        steps: [
          { title: 'Open the decision', text: 'Restrictions are on Account health, dispute decisions on the case, rejections on the product.', link: { label: 'Open Account health', screen: 'seller/performance' } },
          { title: 'Choose Appeal', text: 'Check the deadline first. After it passes, the decision is final.' },
          { title: 'Explain your case', text: 'Say what you changed, or why the decision was based on wrong information. Be specific: listings, order numbers, dates. Attach documents that support it.' },
          { title: 'Confirm and submit', text: 'Confirm the information is accurate. The appeal shows in Warnings and actions, and we email you the decision.' },
        ],
      },
      {
        id: 'strong',
        heading: 'What makes an appeal succeed',
        bullets: ['It addresses the reason in the notice, not the impact on your business.', 'The cause is fixed already, for example the claim removed or the photos replaced.', 'Evidence is attached: invoices, tracking, photos, messages.'],
      },
    ],
    action: { title: 'Decisions you can appeal', text: 'Restrictions show their appeal deadline.', link: { label: 'Open Account health', screen: 'seller/performance' } },
    related: ['what-a-restriction-affects', 'disputes-evidence-and-appeals', 'brand-claims-and-proof-documents', 'fix-a-rejected-or-changes-requested-product'],
    keywords: ['appeal', 'decision', 'review', 'restriction', 'dispute', 'reject'],
  },

  /* ---------------- Advertising ---------------- */
  {
    slug: 'requesting-a-sponsored-campaign',
    category: 'ads',
    label: 'Requesting a sponsored campaign',
    title: 'How do I request a sponsored campaign?',
    summary: 'Choose what to promote, the placement, dates and billing, then submit for review. Nothing runs or is charged until Marketly approves and schedules it.',
    updated: '2026-09-10',
    sections: [
      {
        id: 'steps',
        heading: 'Request a campaign',
        steps: [
          { title: 'Start a request', text: 'Pick a product or your store to promote, and where the ad appears.', link: { label: 'Request a sponsored campaign', screen: 'seller/ad-request' } },
          { title: 'Choose billing', text: '**Per click** ($0.35 per click in this example) with a daily limit of at least $5.00, or **fixed** ($45.00 per day in this example).' },
          { title: 'Submit for review', text: 'Marketly checks that the offer is available, the claims and links, and the Sponsored label, usually within 2 business days (example). Editing sends it back to the start of review.', link: { label: 'See a request in review', screen: 'seller/ad-request', view: 'in-review' } },
          { title: 'Track it', text: 'Live campaigns show spend against your limit in Marketing.', link: { label: 'Open sponsored ads', screen: 'seller/marketing', view: 'sponsored-ads' } },
        ],
      },
    ],
    related: ['how-ad-charges-are-billed', 'why-an-ad-was-not-approved', 'how-the-fee-basis-works'],
    keywords: ['ad', 'sponsored', 'campaign', 'promote', 'advertising'],
  },
  {
    slug: 'how-ad-charges-are-billed',
    category: 'ads',
    label: 'How ad charges are billed',
    title: 'How are ad charges billed?',
    summary: 'Ad charges are a separate line on your payout statement, not part of the sales commission. You pay only for clicks or days delivered, never unused budget.',
    updated: '2026-09-10',
    sections: [
      {
        id: 'rules',
        heading: 'How charges work',
        bullets: [
          '**Per click**: each click is charged, up to your daily limit.',
          '**Fixed**: each day the placement runs is charged.',
          'Unused budget is never charged.',
          'If Marketly pauses or cancels a campaign, you pay only for delivery so far.',
          'Charges come out of your earnings and appear under Ads on each statement.',
        ],
        links: [{ label: 'Open a payout statement', screen: 'seller/statement' }],
      },
    ],
    related: ['requesting-a-sponsored-campaign', 'why-an-ad-was-not-approved', 'payout-schedule-and-cutoffs'],
    keywords: ['ad', 'charge', 'billing', 'click', 'budget', 'statement'],
  },
  {
    slug: 'why-an-ad-was-not-approved',
    category: 'ads',
    label: 'Why an ad was not approved',
    title: 'Why was my ad not approved?',
    summary: 'The review note names the reason. Most often the offer is out of stock, a claim has no proof, or the ad has links or contact details. Fix it and submit again.',
    updated: '2026-09-10',
    sections: [
      {
        id: 'reasons',
        heading: 'Common reasons',
        bullets: [
          'The promoted offer is out of stock or not live.',
          'A claim such as “best price” or “authorized dealer” without proof on file.',
          'Outside links, phone numbers or email addresses in the ad text or image.',
          'The product is in a category you are restricted from.',
          'The image covers or imitates the Sponsored label.',
        ],
      },
      {
        id: 'fix',
        heading: 'Fix and resubmit',
        text: ['Open the request in Marketing, change what the note names, and submit again. Review starts over and nothing is charged until it is approved.'],
        links: [{ label: 'Open sponsored ads', screen: 'seller/marketing', view: 'sponsored-ads' }],
      },
    ],
    related: ['requesting-a-sponsored-campaign', 'brand-claims-and-proof-documents', 'what-a-restriction-affects'],
    keywords: ['ad', 'rejected', 'not approved', 'review', 'declined'],
  },
];

const BY_SLUG = new Map(HELP_ARTICLES.map((a) => [a.slug, a]));
const BY_LABEL = new Map(HELP_ARTICLES.map((a) => [a.label, a.slug]));

export const getArticle = (slug: string | undefined) => (slug ? BY_SLUG.get(slug) : undefined);
/** Slug of the article listed under this name on the Help page. */
export const articleSlug = (label: string) => BY_LABEL.get(label) ?? '';
export const getCategory = (key: HelpCategoryKey) => HELP_CATEGORIES.find((c) => c.key === key)!;

/** Articles whose title, list name, summary, category or keywords contain every word of the query. */
export function searchArticles(query: string): HelpArticle[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return HELP_ARTICLES.filter((a) => {
    const hay = [a.title, a.label, a.summary, getCategory(a.category).label, ...(a.keywords ?? [])].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Rough reading time from the article's text, in minutes. */
export function readMinutes(a: HelpArticle): number {
  const parts: string[] = [a.summary];
  if (a.facts) parts.push(...(a.facts.kind === 'kv' ? a.facts.pairs.flat() : [...a.facts.no, ...a.facts.ok]));
  for (const s of a.sections) {
    parts.push(...(s.text ?? []), ...(s.bullets ?? []), ...(s.steps ?? []).map((x) => `${x.title} ${x.text}`), ...(s.table?.rows.flat() ?? []));
  }
  const words = parts.join(' ').split(/\s+/).length;
  return Math.max(1, Math.ceil(words / 180));
}
