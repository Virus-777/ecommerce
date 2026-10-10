import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { money } from '@/lib/format';
import type { ScreenId } from '@/routes/catalogue';
import { href } from '@/routes/href';
import { Alert, announce, Button, Card, KeyValue, PageHeader, StatusBadge, SummaryRow, TableWrap } from '@/ui';
import { signedMoney } from './data/finance';

// Design: pages/seller/seller-statement.html (no views). Every section total and the
// reconciliation are computed from the line arrays, so they always add up to the payout.

interface RefCell {
  ref: string;
  to?: ScreenId;
  view?: string;
}

interface SaleLine {
  product: string;
  note?: string;
  sku?: string;
  units?: number;
  amount: number;
}
const SALES: SaleLine[] = [
  { product: 'Halden Pocket Bluetooth Speaker', sku: 'HAL-PKT-TEAL / SND', units: 38, amount: 2242 },
  { product: 'Halden Aurora ANC Wireless Headphones', sku: 'HAL-AUR-BLK', units: 9, amount: 1656 },
  { product: 'Studio Cable Kit', sku: 'NWA-CBL-KIT', units: 12, amount: 288 },
  { product: 'Ardent USB Desk Microphone', sku: 'ARD-USB-MIC', units: 1, amount: 100 },
  { product: 'Seller-funded discount: Fall audio markdown', note: '10% off 22 Pocket Speakers. You fund this discount.', amount: -129.8 },
  { product: 'Shipping charged to customers', note: '9 orders × $6.99', amount: 62.91 },
];

const FEE_RATE = 0.1;
const ITEMS = SALES.filter((s) => s.units).reduce((n, s) => n + s.amount, 0);
const SELLER_DISCOUNT = -SALES.filter((s) => !s.units && s.amount < 0).reduce((n, s) => n + s.amount, 0);
const FEE_BASIS = ITEMS - SELLER_DISCOUNT;
const FEE = -Math.round(FEE_BASIS * FEE_RATE * 100) / 100;

/** A line in the four-column sections (refunds, holds, adjustments, ads). An empty date marks a sub-line. */
interface Line {
  date?: string;
  ref?: RefCell;
  text: ReactNode;
  sub?: ReactNode;
  /** Sub-line shown as .xs.sub (fee refunded under a refund). */
  minor?: boolean;
  amount: number;
}

const REFUNDS: Line[] = [
  { date: 'Oct 2', ref: { ref: 'RT-260930-0718', to: 'seller/return' }, text: 'Halden Pocket Bluetooth Speaker · defective, full refund', amount: -59 },
  { text: 'Fee refunded, 10% of $59.00', minor: true, amount: 5.9 },
  { date: 'Oct 3', ref: { ref: 'RT-261002-0804', to: 'seller/return' }, text: 'Studio Cable Kit · missing adapter, partial refund', amount: -8 },
  { text: 'Fee refunded, 10% of $8.00', minor: true, amount: 0.8 },
  {
    date: 'Sep 30',
    ref: { ref: 'RT-260924-0533', to: 'seller/return' },
    text: (
      <>
        <b>Refund after payout.</b> Halden Aurora ANC Wireless Headphones · sold Sep 12, paid out in PO-260921-2954
      </>
    ),
    amount: -184,
  },
  { text: 'Fee refunded, 10% of $184.00. Net −$165.60 deducted from this payout.', minor: true, amount: 18.4 },
];

const HOLDS: Line[] = [
  { date: 'Oct 3', ref: { ref: 'MK-261003-07712', to: 'seller/order' }, text: 'Held: carrier shows no delivery scan. Review Oct 12.', amount: -172.59 },
  { date: 'Oct 1', ref: { ref: 'MK-260924-03987', to: 'seller/order' }, text: 'Released: delivery confirmed by carrier Sep 30', amount: 106.2 },
];

const ADJUSTMENTS: Line[] = [
  { date: 'Sep 30', ref: { ref: 'ADJ-260930-0112' }, text: 'Duplicate shipping label charge reversed for MK-260929-05518', sub: 'Label billed twice by carrier · recorded by Priya Nair, Finance', amount: 4.35 },
  { date: 'Oct 2', ref: { ref: 'ADJ-261002-0127' }, text: 'Late dispatch goodwill credit for MK-261001-03321', sub: 'Dispatched 2 days late; seller agreement section 7.3 · recorded by Isabel Cruz, Support', amount: -5 },
];

const ADS: Line[] = [
  { date: 'Sep 28 – Oct 4', ref: { ref: 'AD-260915-0044', to: 'seller/marketing', view: 'sponsored-ads' }, text: 'Pocket Speaker search boost · sponsored product · 236 clicks × $0.35', amount: -82.6 },
];

const sum = (l: Array<{ amount: number }>) => Math.round(l.reduce((n, x) => n + x.amount, 0) * 100) / 100;

const TOTALS = {
  sales: sum(SALES),
  fees: FEE,
  refunds: sum(REFUNDS),
  holds: sum(HOLDS),
  adjustments: sum(ADJUSTMENTS),
  ads: sum(ADS),
};
const OPENING = 0;
const NET = Math.round((OPENING + Object.values(TOTALS).reduce((a, b) => a + b, 0)) * 100) / 100;
/** The whole available balance is paid out, so the closing balance is 0. */
const PAYOUT = NET;
const CLOSING = 0;
const PAYOUT_REF = 'PO-261005-3381';

function Amount({ n, className }: { n: number; className?: string }) {
  return <span className={cx('num', className, n < 0 && 'sb-neg')}>{signedMoney(n)}</span>;
}

function RefLink({ r }: { r?: RefCell }) {
  if (!r) return null;
  return r.to ? (
    <Link className="mono nowrap" to={href(r.to, r.view)} title={r.ref}>
      {r.ref}
    </Link>
  ) : (
    <span className="mono nowrap" title={r.ref}>
      {r.ref}
    </span>
  );
}

/** Card for a statement section: header total on the right, four-column table, total row. */
function LineSection({ title, sub, cols, lines, totalLabel }: { title: string; sub: string; cols: [string, string, string]; lines: Line[]; totalLabel: string }) {
  const total = sum(lines);
  return (
    <Card flush titleAs="h3" title={title} sub={sub} actions={<span className={cx('num strong', total < 0 && 'sb-neg')}>{signedMoney(total)}</span>}>
      <TableWrap label={`${title} table`}>
        <table className="table">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
              <th className="r" scope="col">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>{l.date && <span className="small nowrap">{l.date}</span>}</td>
                <td>
                  <RefLink r={l.ref} />
                </td>
                <td>
                  <span className={l.minor ? 'xs sub' : 'small'}>{l.text}</span>
                  {l.sub && (
                    <>
                      <br />
                      <span className="xs muted">{l.sub}</span>
                    </>
                  )}
                </td>
                <td className="r">
                  <Amount n={l.amount} />
                </td>
              </tr>
            ))}
            <tr className="sb-total">
              <td>
                <span>{totalLabel}</span>
              </td>
              <td />
              <td />
              <td className="r">
                <Amount n={total} />
              </td>
            </tr>
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}

export default function Statement() {
  const recon: Array<[string, number]> = [
    ['Sales proceeds', TOTALS.sales],
    ['Marketplace fees', TOTALS.fees],
    ['Refunds, incl. after payout', TOTALS.refunds],
    ['Holds and releases', TOTALS.holds],
    ['Adjustments', TOTALS.adjustments],
    ['Advertising charges', TOTALS.ads],
  ];

  return (
    <SellerLayout active="finance">
      <PageHeader
        crumbs={[{ label: 'Finance', to: href('seller/finance') }, { label: 'Statements' }, { label: 'Sep 28 – Oct 4' }]}
        title="Statement: Sep 28 – Oct 4, 2026"
        sub={
          <>
            Northwind Audio · seller ID NWA-20714 · payout <span className="mono">{PAYOUT_REF}</span> · issued Oct 5, 2026
          </>
        }
        actions={
          <>
            <Button variant="secondary" size="sm" icon="file-down" onClick={() => announce(`Downloading statement ${PAYOUT_REF} as PDF`)}>
              Download PDF
            </Button>
            <Button variant="secondary" size="sm" icon="sheet" onClick={() => announce(`Downloading statement ${PAYOUT_REF} as CSV`)}>
              Download CSV
            </Button>
          </>
        }
      />
      <div className="sb-main">
        <div className="stack gap-5">
          <Card flush title="Sales" sub="60 units in 51 orders accepted Sep 28 – Oct 4" actions={<span className="num strong">{signedMoney(TOTALS.sales)}</span>}>
            <TableWrap label="Sales table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">SKU</th>
                    <th className="r" scope="col">
                      Units
                    </th>
                    <th className="r" scope="col">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {SALES.map((s) => (
                    <tr key={s.product}>
                      <td>
                        <span className={s.units ? 'small strong' : 'small'}>{s.product}</span>
                        {s.note && (
                          <>
                            <br />
                            <span className="xs muted">{s.note}</span>
                          </>
                        )}
                      </td>
                      <td>
                        {s.sku && (
                          <span className="mono nowrap" title={s.sku}>
                            {s.sku}
                          </span>
                        )}
                      </td>
                      <td className="r">{s.units !== undefined && <span className="num">{s.units}</span>}</td>
                      <td className="r">
                        <Amount n={s.amount} />
                      </td>
                    </tr>
                  ))}
                  <tr className="sb-total">
                    <td>
                      <span>Sales proceeds</span>
                    </td>
                    <td />
                    <td className="r" />
                    <td className="r">
                      <Amount n={TOTALS.sales} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </TableWrap>
          </Card>

          <Card flush titleAs="h3" title="Marketplace fees" sub="Commission on item price after your discounts" actions={<span className="num strong sb-neg">{signedMoney(TOTALS.fees)}</span>}>
            <TableWrap label="Marketplace fees table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Fee</th>
                    <th scope="col">Basis</th>
                    <th className="r" scope="col">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <span className="small strong">Commission, {FEE_RATE * 100}% (example rate)</span>
                    </td>
                    <td>
                      <span className="small num">{money(FEE_BASIS)}</span>
                      <br />
                      <span className="xs muted">
                        {money(ITEMS)} items − {money(SELLER_DISCOUNT)} seller-funded discount
                      </span>
                    </td>
                    <td className="r">
                      <Amount n={TOTALS.fees} />
                    </td>
                  </tr>
                  <tr className="sb-total">
                    <td>
                      <span>Fees total</span>
                    </td>
                    <td />
                    <td className="r">
                      <Amount n={TOTALS.fees} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </TableWrap>
            <div className="panel" style={{ margin: 'var(--sp-3) var(--sp-4) var(--sp-4)' } as CSSProperties}>
              <span className="xs sub">
                <b>How the fee basis works:</b> commission applies to the item price after seller-funded discounts. Shipping is not charged commission. Platform-funded discounts don't lower your proceeds or your fee basis. Fees are refunded in proportion when an item is refunded. Final rates are in your seller agreement.
              </span>
            </div>
          </Card>

          <LineSection title="Refunds" sub="Refunds sent this period and the fee returned to you" cols={['Date', 'Return', 'Details']} lines={REFUNDS} totalLabel="Refunds total" />
          <LineSection title="Holds and releases" sub="Earnings withheld with a reason and review date, and earlier holds released" cols={['Date', 'Order', 'Reason']} lines={HOLDS} totalLabel="Holds net" />
          <LineSection title="Adjustments" sub="Every adjustment has a recorded reason and owner" cols={['Date', 'Reference', 'Adjustment and reason']} lines={ADJUSTMENTS} totalLabel="Adjustments net" />
          <LineSection title="Advertising charges" sub="Billed separately from sales commission" cols={['Period', 'Campaign', 'Details']} lines={ADS} totalLabel="Ad charges total" />
        </div>

        <div className="stack gap-5">
          <Card titleAs="h3" title="Reconciliation" sub="Every line on this page adds up to the payout">
            <div className="sb-recon">
              <SummaryRow k="Opening available balance, Sep 28" v={money(OPENING)} />
              {recon.map(([k, v]) => (
                <SummaryRow key={k} k={k} v={signedMoney(v)} />
              ))}
              <SummaryRow className="total" k={`Payout ${PAYOUT_REF}`} v={money(PAYOUT)} />
              <SummaryRow k="Closing available balance, Oct 4" v={money(CLOSING)} />
            </div>
          </Card>
          <Card titleAs="h3" title="Payout" sub={<span className="mono">{PAYOUT_REF}</span>}>
            <div className="row between base">
              <span className="h2 num">{money(PAYOUT)}</span>
              <StatusBadge status="Paid" />
            </div>
            <KeyValue
              pairs={[
                ['Sent', 'Mon, Oct 5, 6:00 AM PT'],
                ['Arrived', 'Tue, Oct 6'],
                ['Destination', 'Pacific Coast Credit Union •••• 6620'],
                ['Bank reference', <span className="mono">PCCU-77810452</span>],
              ]}
            />
          </Card>
          <Alert tone="warning" title="Includes a refund after payout">
            <span className="mono">RT-260924-0533</span> was refunded after its earnings were paid out on Sep 21. The net $165.60 was deducted here, not charged to your bank account.
          </Alert>
          <p className="xs muted">
            Example fee rate and schedule. Final fees and settlement terms are in the seller agreement. Questions about a line?{' '}
            <Button variant="link" to={href('seller/help', 'contact-seller-support')}>
              Contact seller support
            </Button>
          </p>
        </div>
      </div>
    </SellerLayout>
  );
}
