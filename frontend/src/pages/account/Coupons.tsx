import { useState, type ReactNode } from 'react';
import { AccountLayout } from '@/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { money } from '@marketly/web-shared/lib/format';
import { announce, Badge, Button, Card, CopyButton, Icon, TableWrap } from '@marketly/web-shared/ui';

// Design: pages/store/account-coupons.html (one view): store credit + history, coupons to clip
// (or copy the code to type at checkout), and used/expired coupons.

const CREDIT = [
  { date: 'Sep 4, 2026', what: 'Goodwill credit · case', ref: 'CS-260903-1876', note: ', late delivery', amount: 15 },
  { date: 'Aug 30, 2026', what: 'Used on order', ref: 'MK-260830-11764', note: '', amount: -10 },
  { date: 'Aug 2, 2026', what: 'Price adjustment · case', ref: 'CS-260801-0950', note: '', amount: 10 },
];

interface Coupon {
  code: string;
  amt: string;
  unit: string;
  title: string;
  body: ReactNode;
  meta: string;
  clipped?: boolean;
  /** Used or expired: muted card with a status badge. */
  done?: 'Completed' | 'Expired';
}

const AVAILABLE: Coupon[] = [
  { code: 'HOMEWEEK15', amt: '15%', unit: 'off', title: 'Home Week: 15% off Home & Kitchen', body: 'Min. spend $75 on eligible items. Applies to Official Store and Casa Verde Home items in Home & Kitchen.', meta: 'Expires Oct 19' },
  { code: 'NWA10', amt: '$10', unit: 'off', title: '$10 off Northwind Audio', body: 'Orders of $80 or more from Northwind Audio. Headphones, speakers and cables.', meta: 'Expires Oct 31', clipped: true },
  { code: 'PPSHIP50', amt: 'Free', unit: 'shipping', title: 'Free shipping from Pixel & Port', body: 'Any Pixel & Port order over $50. One use.', meta: 'Expires Nov 15' },
  { code: 'THANKS5', amt: '$5', unit: 'off', title: '$5 off your next Official Store order', body: 'Min. spend $35 on Official Store items. Not valid on gift cards.', meta: 'Expires Dec 31', clipped: true },
];

const USED: Coupon[] = [
  {
    code: 'WELCOME20', amt: '$20', unit: 'off', title: 'Welcome coupon', meta: 'Used', done: 'Completed',
    body: (
      <>
        Used Sep 14 on order <span className="mono">MK-260914-48213</span>. Saved $20.00.
      </>
    ),
  },
  { code: 'FALL5', amt: '$5', unit: 'off', title: 'Fall kickoff', body: 'Not used.', meta: 'Expired Sep 30', done: 'Expired' },
];

function CouponCard({ c, onClip }: { c: Coupon; onClip?: () => void }) {
  return (
    <article className={cx('acct-coupon', c.done && 'is-muted')}>
      <div className="amt">
        <span>{c.amt}</span>
        <small>{c.unit}</small>
      </div>
      <div className="bd">
        <div className="row between top gap-2">
          <span className="small strong">{c.title}</span>
          {c.done ? (
            <Badge>{c.done}</Badge>
          ) : c.clipped ? (
            <Badge tone="success" icon="check">
              Clipped
            </Badge>
          ) : (
            <Button size="sm" icon="scissors" onClick={onClip}>
              Clip
            </Button>
          )}
        </div>
        <span className="xs sub">{c.body}</span>
        <span className="row gap-3 xs muted">
          <span className="row gap-1 nowrap">
            <span className="mono">{c.code}</span>
            {!c.done && <CopyButton text={c.code} label={`Copy code ${c.code}`} className="icon-btn sm" />}
          </span>
          <span>{c.meta}</span>
          {!c.done && (
            <a href="#" className="link-inline">
              Terms
            </a>
          )}
        </span>
      </div>
    </article>
  );
}

export default function Coupons() {
  const [coupons, setCoupons] = useState(AVAILABLE);
  const balance = CREDIT.reduce((s, r) => s + r.amount, 0);
  const clip = (code: string) => {
    setCoupons((cs) => cs.map((c) => (c.code === code ? { ...c, clipped: true } : c)));
    announce(`Coupon ${code} clipped. It applies at checkout.`);
  };

  return (
    <AccountLayout active="coupons" title="Coupons and credit">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Coupons and credit</h1>
          <p className="small sub">Clipped coupons apply at checkout to the items they cover. You see each discount before you pay.</p>
        </div>
      </div>
      <div className="grid lg2 u-items-start">
        <section className="card pad stack gap-3" aria-labelledby="cp-credit">
          <div className="row between">
            <h2 className="h3" id="cp-credit">
              Store credit
            </h2>
            <Icon name="wallet" />
          </div>
          <span className="stack gap-0">
            <span className="display d-lg num">{money(balance)}</span>
            <span className="xs muted">Available now · expires Sep 4, 2027</span>
          </span>
          <p className="small sub">Choose to use it at the payment step of checkout. It covers any item from any seller.</p>
        </section>
        <Card title="Credit history" titleAs="h3" flush>
          <TableWrap label="Credit history table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Activity</th>
                  <th className="r" scope="col">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {CREDIT.map((r) => (
                  <tr key={r.ref}>
                    <td>{r.date}</td>
                    <td>
                      {r.what}{' '}
                      <span className="mono nowrap" title={r.ref}>
                        {r.ref}
                      </span>
                      {r.note}
                    </td>
                    <td className="r">{r.amount > 0 ? <span className="t-success-text strong">+{money(r.amount)}</span> : `−${money(-r.amount)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      </div>
      <section className="stack gap-3" aria-labelledby="cp-avail">
        <h2 className="h3" id="cp-avail">
          Available coupons
        </h2>
        <div className="grid md2 gap-3">
          {coupons.map((c) => (
            <CouponCard key={c.code} c={c} onClip={() => clip(c.code)} />
          ))}
        </div>
        <span className="xs muted">One coupon per seller package. Some coupons can't be combined with sale prices; checkout tells you which.</span>
      </section>
      <section className="stack gap-3" aria-labelledby="cp-used">
        <h2 className="h3" id="cp-used">
          Used and expired
        </h2>
        <div className="grid md2 gap-3">
          {USED.map((c) => (
            <CouponCard key={c.code} c={c} />
          ))}
        </div>
      </section>
    </AccountLayout>
  );
}
