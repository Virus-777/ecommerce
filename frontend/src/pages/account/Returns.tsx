import { useState } from 'react';
import { Link } from 'react-router';
import { P } from '@marketly/web-shared/data/fixtures';
import { AccountLayout } from '@/layouts';
import { money } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Badge, Button, Card, Icon, Img, Stat, Tabs, type Tone } from '@marketly/web-shared/ui';

// Design: pages/store/account-returns.html (one view). Return status tracks the item, refund status the money.

interface ReturnRow {
  ref: string;
  opened: string;
  order: string;
  p: string;
  seller: string;
  refund: number;
  ret: [string, Tone];
  money: [string, Tone];
  next: string;
  open: boolean;
}

const RETURNS: ReturnRow[] = [
  { ref: 'RT-261007-0533', opened: 'Oct 7', order: 'MK-260927-52240', p: 'speaker', seller: 'Northwind Audio', refund: 59, ret: ['Requested', 'info'], money: ['Requested', 'info'], next: 'Northwind Audio responds by Fri, Oct 9, 5:00 PM PT. Marketly steps in if they miss it.', open: true },
  { ref: 'RT-260921-0457', opened: 'Sep 21', order: 'MK-260914-48213', p: 'pourover', seller: 'Marketly Official', refund: 34.65, ret: ['Approved', 'success'], money: ['Requested', 'info'], next: 'Drop it off at any UPS location by Thu, Oct 15. Use the QR code.', open: true },
  { ref: 'RT-261002-0520', opened: 'Oct 2', order: 'MK-260920-33018', p: 'keyboard', seller: 'Pixel & Port', refund: 109, ret: ['Received', 'info'], money: ['Processing', 'info'], next: 'Nothing to do. The refund should reach your card by Oct 14.', open: true },
  { ref: 'RT-260823-0311', opened: 'Aug 23', order: 'MK-260818-07352', p: 'backpack', seller: 'Trailhead Outfitters', refund: 139, ret: ['Refunded', 'success'], money: ['Sent', 'success'], next: 'Refund sent Sep 4 to Visa •••• 4417.', open: false },
  { ref: 'RT-260709-0144', opened: 'Jul 9', order: 'MK-260702-00418', p: 'sweater', seller: 'Marketly Official', refund: 84, ret: ['Refunded', 'success'], money: ['Sent', 'success'], next: 'Refund sent Jul 16 to Visa •••• 4417.', open: false },
];

type TabKey = 'open' | 'completed' | 'all';

function ReturnRowLink({ r }: { r: ReturnRow }) {
  const p = P[r.p];
  return (
    <Link className="acct-row" to={href('account/return')}>
      <Img icon={p.icon} tint={p.tint} className="thumb" />
      <span className="stack gap-2 grow">
        <span className="row between gap-2">
          <span className="mono small strong">{r.ref}</span>
          <span className="xs muted">
            Opened {r.opened} · Order <span className="mono">{r.order}</span>
          </span>
        </span>
        <span className="stack gap-0">
          <span className="small strong">{p.name}</span>
          <span className="xs muted">
            {r.seller} · Refund {money(r.refund)}
          </span>
        </span>
        <span className="row gap-4">
          <span className="row gap-2">
            <span className="acct-k">Return</span>
            <Badge tone={r.ret[1]}>{r.ret[0]}</Badge>
          </span>
          <span className="row gap-2">
            <span className="acct-k">Refund</span>
            <Badge tone={r.money[1]}>{r.money[0]}</Badge>
          </span>
        </span>
        <span className="row gap-2 nowrap xs sub top">
          <Icon name="arrow-right" className="ic-sm" />
          <span>{r.next}</span>
        </span>
      </span>
    </Link>
  );
}

export default function Returns() {
  const [tab, setTab] = useState<TabKey>('open');
  const open = RETURNS.filter((r) => r.open);
  const done = RETURNS.filter((r) => !r.open);
  const onTheWay = open.filter((r) => r.money[0] === 'Processing');
  const refunded = done.reduce((s, r) => s + r.refund, 0);

  return (
    <AccountLayout active="returns" title="Returns and refunds">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Returns and refunds</h1>
          <p className="small sub">Return status tracks the item. Refund status tracks the money. They move separately.</p>
        </div>
        <div className="acts">
          <Button size="sm" icon="plus" to={href('account/return-new')}>
            Start a return
          </Button>
        </div>
      </div>
      <div className="grid md3 gap-3">
        <div className="card pad">
          <Stat label="Open returns" value={open.length} note="1 needs drop-off by Oct 15" />
        </div>
        <div className="card pad">
          <Stat label="Refunds on the way" value={money(onTheWay.reduce((s, r) => s + r.refund, 0))} note={onTheWay.map((r) => `${r.ref} · ${r.money[0]}`).join(', ')} />
        </div>
        <div className="card pad">
          <Stat label="Refunded in 2026" value={money(refunded)} note={`${done.length} completed returns`} />
        </div>
      </div>
      <Tabs
        active={tab}
        onChange={setTab}
        items={[
          { value: 'open', label: 'Open', count: open.length },
          { value: 'completed', label: 'Completed', count: done.length },
          { value: 'all', label: 'All', count: RETURNS.length },
        ]}
      />
      {tab === 'all' ? (
        <section className="card">
          {RETURNS.map((r) => (
            <ReturnRowLink key={r.ref} r={r} />
          ))}
        </section>
      ) : (
        <>
          {tab === 'open' && (
            <section className="card">
              {open.map((r) => (
                <ReturnRowLink key={r.ref} r={r} />
              ))}
            </section>
          )}
          <h2 className="h3">Completed</h2>
          <section className="card">
            {done.map((r) => (
              <ReturnRowLink key={r.ref} r={r} />
            ))}
          </section>
        </>
      )}
      <Card title="How refunds work" titleAs="h3">
        <div className="grid md3 gap-4">
          <div className="stack gap-1">
            <span className="small strong">
              <Icon name="clock" className="ic-sm" /> Timing
            </span>
            <span className="xs sub">We send the refund after the item is received and inspected, usually within 2 business days. Banks take 3–5 business days more.</span>
          </div>
          <div className="stack gap-1">
            <span className="small strong">
              <Icon name="credit-card" className="ic-sm" /> Destination
            </span>
            <span className="xs sub">Refunds go back to the original payment method unless you chose store credit.</span>
          </div>
          <div className="stack gap-1">
            <span className="small strong">
              <Icon name="life-buoy" className="ic-sm" /> If a seller doesn't respond
            </span>
            <span className="xs sub">
              Marketly support steps in when a seller misses a deadline.{' '}
              <Link to={href('help/cases')} className="link-inline">
                See your cases
              </Link>
              .
            </span>
          </div>
        </div>
      </Card>
    </AccountLayout>
  );
}
