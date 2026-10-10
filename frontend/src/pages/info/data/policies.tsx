import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { href } from '@/routes/href';
import { TableWrap, type IconName } from '@/ui';

// Policy documents (design: pages/store/info-policy*.html). The API phase serves these as
// versioned policy records; the page renders the current version.

export type PolicySlug = '' | 'shipping' | 'seller-rules' | 'privacy' | 'purchase-terms';

export interface Policy {
  slug: PolicySlug;
  /** Short name: crumbs, phone picker, app-bar title. */
  short: string;
  /** Side-nav label. */
  nav: string;
  title: string;
  icon: IconName;
  effective: string;
  version: string;
  prevVersion: string;
  prevDate: string;
  body: ReactNode;
}

function SimpleTable({ label, head, rows }: { label: string; head: string[]; rows: string[][] }) {
  return (
    <TableWrap label={label}>
      <table className="table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]}>
              {r.map((c, i) => (
                <td key={i}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

export const POLICIES: Policy[] = [
  {
    slug: '',
    short: 'Returns',
    nav: 'Returns policy',
    title: 'Returns policy',
    icon: 'undo-2',
    effective: 'Sep 1, 2026',
    version: '3.2',
    prevVersion: 'v3.1',
    prevDate: 'Jun 1, 2026',
    body: (
      <>
        <div className="prose">
          <p>Every item on Marketly can be returned for at least 30 days after delivery unless a category exception below applies. Sellers can offer longer or free returns; their terms are shown on the product page before you buy.</p>
          <h2>Return window</h2>
          <ul>
            <li>30 days from delivery for most items.</li>
            <li>Official Store items: 30 days, free return shipping for every reason.</li>
            <li>Seller items: at least 30 days. Longer windows are shown on the offer.</li>
          </ul>
          <h2>Who pays return shipping</h2>
        </div>
        <SimpleTable
          label="Who pays return shipping table"
          head={['Return reason', 'Official Store items', 'Marketplace seller items', 'Original shipping refunded']}
          rows={[
            ['Damaged in delivery', 'Free', 'Seller pays', 'Yes'],
            ['Incorrect item sent', 'Free', 'Seller pays', 'Yes'],
            ['Defective or not working', 'Free', 'Seller pays', 'Yes'],
            ['Change of mind', 'Free', 'Customer pays, unless the seller offers free returns', 'No'],
          ]}
        />
        <div className="prose">
          <h2>Category exceptions</h2>
        </div>
        <SimpleTable
          label="Category exceptions table"
          head={['Category', 'Return window', 'Condition for change-of-mind returns']}
          rows={[
            ['Bedding and linens', '30 days', 'Unopened, in original packaging'],
            ['Beauty and personal care', '30 days', 'Unopened and sealed'],
            ['Electronics', '30 days', 'All accessories and packaging included'],
            ['Final sale items', 'No change-of-mind returns', 'Marked "Final sale" on the product page'],
            ['Damaged, wrong or defective items', '30 days in every category', 'No condition required'],
          ]}
        />
        <div className="prose">
          <h2>Refunds</h2>
          <ul>
            <li>Refunds go back to your original payment method. You see each step: Requested, Under review, Approved, Processing, Sent.</li>
            <li>Approved doesn't mean the money has arrived. Banks take 3–5 business days after we send it.</li>
            <li>Partial returns refund only the returned items and their share of any discount.</li>
          </ul>
          <h2>When Marketly steps in</h2>
          <p>If a seller doesn't answer a return request within 2 business days, rejects it and you disagree, or doesn't refund within 3 business days of receiving the item, ask Marketly to help from the return page. In some cases we refund without asking you to send the item back, and we record why.</p>
        </div>
      </>
    ),
  },
  {
    slug: 'shipping',
    short: 'Shipping',
    nav: 'Shipping policy',
    title: 'Shipping policy',
    icon: 'truck',
    effective: 'Aug 15, 2026',
    version: '2.1',
    prevVersion: 'v2.0',
    prevDate: 'May 20, 2026',
    body: (
      <div className="prose">
        <p>Every item shows who ships it, where it ships from, the shipping cost and a delivery estimate for your address before you pay.</p>
        <h2>Who ships your order</h2>
        <ul>
          <li>
            <b>Official Store items</b> ship from the Marketly warehouse in Reno, NV.
          </li>
          <li>
            <b>Marketplace seller items</b> are shipped by the seller from their own location. Fulfillment by Marketly for sellers will come later; sellers will still be named as the seller.
          </li>
          <li>One order can arrive in several packages, one per seller or ship-from location.</li>
        </ul>
        <h2>Costs</h2>
        <ul>
          <li>Official Store: free standard delivery on orders over $35, otherwise $5.99.</li>
          <li>Sellers set their own rates. You see each package's cost at checkout.</li>
        </ul>
        <h2>Delivery estimates</h2>
        <p>Estimates combine the seller's dispatch time and the carrier's transit time to your ZIP code. If a package is late, we tell you and show your options on the order page.</p>
        <h2>Where we deliver</h2>
        <p>We deliver to street addresses and PO boxes in the 50 US states. Some large items can't ship to PO boxes, Alaska or Hawaii; the product page tells you before checkout.</p>
        <h2>Late, lost or damaged packages</h2>
        <ul>
          <li>Report it from the order page. The seller responds first; Marketly steps in after 2 business days.</li>
          <li>If an item doesn't ship within 14 days of its estimate, you can cancel it for a full refund.</li>
        </ul>
      </div>
    ),
  },
  {
    slug: 'seller-rules',
    short: 'Seller rules',
    nav: 'Seller rules policy',
    title: 'Seller rules policy',
    icon: 'store',
    effective: 'Sep 15, 2026',
    version: '1.4',
    prevVersion: 'v1.3',
    prevDate: 'Jul 1, 2026',
    body: (
      <>
        <div className="prose">
          <p>These rules apply to every outside seller on Marketly. Sellers accept them in the seller agreement. Customers can rely on them when buying from any seller.</p>
          <h2>Listing accuracy</h2>
          <ul>
            <li>Offers must match the catalog product exactly: model, variation, bundle contents and condition.</li>
            <li>Used and refurbished items must describe wear and missing accessories.</li>
            <li>Prices and discounts must be real. A "was" price must have been charged in the last 90 days.</li>
          </ul>
          <h2>Dispatch and response targets</h2>
        </div>
        <SimpleTable
          label="Dispatch and response targets table"
          head={['Measure', 'Target', 'Measured over']}
          rows={[
            ['On-time dispatch', 'At least 95% of orders', '30 days'],
            ['Valid tracking added', 'At least 95% of packages', '30 days'],
            ['Reply to customer messages', 'Within 1 business day', '30 days'],
            ['Seller cancellations', 'Below 2.5% of orders', '30 days'],
            ['Return requests answered', 'Within 2 business days', '30 days'],
          ]}
        />
        <p className="xs muted">Example targets. Final targets are published in the seller service standards.</p>
        <div className="prose">
          <h2>What the Verified seller label means</h2>
          <p>We checked the seller's business registration, the identity of its owner, a US bank account for payouts and a US return address. It does not mean we inspected each product. Report anything that looks wrong from the product or order page.</p>
          <h2>Restricted products</h2>
          <p>Sellers can't list weapons, recalled items, prescription drugs, counterfeit goods or items outside our launch categories. Some categories need approval first.</p>
          <h2>Restrictions and appeals</h2>
          <ul>
            <li>When we restrict a seller, we tell them the reason, which activity is affected (for example, new sales or new listings) and how to appeal.</li>
            <li>Existing orders, returns and customer cases continue while a seller is restricted.</li>
            <li>Sellers can appeal within 14 days. A different team member reviews the appeal.</li>
          </ul>
        </div>
      </>
    ),
  },
  {
    slug: 'privacy',
    short: 'Privacy',
    nav: 'Privacy',
    title: 'Privacy',
    icon: 'lock',
    effective: 'Aug 1, 2026',
    version: '2.0',
    prevVersion: 'v1.2',
    prevDate: 'Apr 10, 2026',
    body: (
      <div className="prose">
        <p>This policy explains what personal information Marketly collects, why, and the choices you have.</p>
        <h2>What we collect</h2>
        <ul>
          <li>Account details: name, email, phone and password (stored encrypted).</li>
          <li>Order details: addresses, items, payment results. Card numbers are handled by our payment processor; we keep only the last 4 digits.</li>
          <li>Support messages and photos you send.</li>
          <li>Basic device and usage data to keep the site secure and working.</li>
        </ul>
        <h2>What sellers see</h2>
        <p>Sellers get only what they need to deliver and support your order: your name, delivery address, phone for the carrier and the items you bought. They can't see your payment details or other orders.</p>
        <h2>Marketing</h2>
        <p>We only send marketing emails if you opt in. Order, delivery and refund updates are always sent. Change this in Profile at any time.</p>
        <h2>How long we keep it</h2>
        <p>Order records are kept for 7 years for tax and accounting. You can close your account and ask us to delete other data.</p>
        <h2>Your rights</h2>
        <p>You can ask for a copy of your data, correct it or delete it. Email privacy@marketly.example or write to the address on our About page.</p>
      </div>
    ),
  },
  {
    slug: 'purchase-terms',
    short: 'Purchase terms',
    nav: 'Purchase terms',
    title: 'Purchase terms',
    icon: 'file-text',
    effective: 'Sep 1, 2026',
    version: '1.3',
    prevVersion: 'v1.2',
    prevDate: 'Jun 1, 2026',
    body: (
      <div className="prose">
        <p>These terms apply when you buy on Marketly. Your order keeps the terms, and each seller's return terms, that were shown when you placed it.</p>
        <h2>Who you're buying from</h2>
        <p>Each item names its seller. Official Store items are sold by Marketly, Inc. Marketplace items are sold by the named seller; Marketly operates the store, takes payment and provides support.</p>
        <h2>Prices and total</h2>
        <p>You see the full total, including shipping and tax, before you place an order. If a price, stock level, delivery date or coupon changes before you pay, we show the change and ask you to choose.</p>
        <h2>When an order is accepted</h2>
        <p>An order is accepted when your payment is accepted. We email a confirmation only then. If the payment result is uncertain, we tell you and don't charge you twice.</p>
        <h2>Cancellations</h2>
        <p>You can cancel an item until its seller ships it. Cancelling one item doesn't cancel the rest of the order.</p>
        <h2>Returns, refunds and help</h2>
        <p>
          Returns follow the{' '}
          <Link to={href('info/policy')} className="link-inline">
            Returns policy
          </Link>{' '}
          and the seller's stated terms. If a seller doesn't resolve a problem, Marketly reviews it and decides. You can appeal a decision within 14 days.
        </p>
        <h2>Changes to these terms</h2>
        <p>We publish new versions with an effective date. Changes never apply to orders placed before that date.</p>
      </div>
    ),
  },
];
