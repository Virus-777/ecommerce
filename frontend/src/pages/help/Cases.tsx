import { useState } from 'react';
import { Link } from 'react-router';
import type { Tint } from '@/data/fixtures';
import { AccountLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { href } from '@/routes/href';
import { Alert, Button, Icon, Img, StatusBadge, TableWrap, Tabs, type IconName } from '@/ui';

// Design: pages/store/help-cases.html · Open / Closed / All tabs filter the list (All is the design's state).

interface SupportCase {
  ref: string;
  subject: string;
  icon: IconName;
  tint: Tint;
  order: string;
  status: string;
  handler: string;
  handlerKind: string;
  next: string;
  /** The next action is the customer's. */
  yours?: boolean;
  expected: string;
  atRisk?: boolean;
  closed?: boolean;
}

const CASES: SupportCase[] = [
  { ref: 'CS-104882', subject: "Linen duvet cover hasn't arrived", icon: 'bed-double', tint: '1', order: 'MK-260914-48213', status: 'Waiting on seller', handler: 'Casa Verde Home', handlerKind: 'Seller', next: 'Casa Verde Home confirms a ship date or offers a refund', expected: 'By Fri, Oct 9, 5:00 PM PT' },
  { ref: 'CS-104860', subject: 'Pour-over carafe arrived chipped', icon: 'coffee', tint: '3', order: 'MK-260914-48213', status: 'Open', handler: 'Marketly Official returns team', handlerKind: 'Official Store', next: 'Returns team reviews your photos', expected: 'Today by 8:00 PM PT' },
  { ref: 'CS-104731', subject: 'Charged twice for one order?', icon: 'cup-soda', tint: '6', order: 'MK-261006-90127', status: 'Waiting on customer', handler: 'Isabel Cruz, Marketly support', handlerKind: 'Marketly', next: 'You: send a screenshot of the two charges', yours: true, expected: 'We reply within 1 business day of your message', atRisk: true },
  { ref: 'CS-103977', subject: 'Refund for returned backpack', icon: 'backpack', tint: '5', order: 'MK-260818-07352', status: 'Resolved', handler: 'Trailhead Outfitters', handlerKind: 'Seller', next: 'None. Refund sent Aug 27', expected: 'Closed Aug 28', closed: true },
  { ref: 'CS-103502', subject: 'Cancel running shoes before shipping', icon: 'footprints', tint: '4', order: 'MK-260811-03309', status: 'Resolved', handler: 'Trailhead Outfitters', handlerKind: 'Seller', next: 'None. Item cancelled, refund sent Aug 12', expected: 'Closed Aug 12', closed: true },
];

type Filter = 'open' | 'closed' | 'all';

export default function Cases() {
  const [filter, setFilter] = useState<Filter>('all');
  const open = CASES.filter((c) => !c.closed);
  const closed = CASES.filter((c) => c.closed);
  const rows = filter === 'open' ? open : filter === 'closed' ? closed : CASES;
  const caseTo = (ref: string) => href('help/case', '', { ref });

  return (
    <AccountLayout active="cases" title="Support cases">
      <div className="row between">
        <div className="stack gap-1">
          <h1 className="h1">Support cases</h1>
          <p className="small sub">{open.length} open · Replies from sellers and Marketly support appear here and by email.</p>
        </div>
        <Button icon="plus" to={href('help/center')}>
          Get help with an order
        </Button>
      </div>
      <Alert tone="warning" title="CS-104731 needs your reply">
        Isabel from Marketly support asked for a screenshot of the two charges.{' '}
        <Link to={caseTo('CS-104731')} className="link-inline">
          Reply now
        </Link>
      </Alert>
      <Tabs<Filter>
        label="Case status"
        active={filter}
        onChange={setFilter}
        items={[
          { label: 'Open', value: 'open', count: open.length },
          { label: 'Closed', value: 'closed', count: closed.length },
          { label: 'All', value: 'all', count: CASES.length },
        ]}
      />
      <div className="card no-phone">
        <TableWrap label="Support cases table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Case</th>
                <th scope="col">Subject</th>
                <th scope="col">Order</th>
                <th scope="col">Status</th>
                <th scope="col">Handled by</th>
                <th scope="col">Next action</th>
                <th className="col-pin" scope="col">
                  Expected reply
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.ref} className={cx(c.atRisk && 'is-warn')}>
                  <td>
                    {c.atRisk && <span className="sr-only">At risk: </span>}
                    <Link className="mono strong nowrap" to={caseTo(c.ref)} title={c.ref}>
                      {c.ref}
                    </Link>
                  </td>
                  <td>
                    <span className="cell-main">
                      <Img icon={c.icon} tint={c.tint} className="tiny" />
                      <span className="small">{c.subject}</span>
                    </span>
                  </td>
                  <td>
                    <Link className="mono xs nowrap" to={href('account/order', '', { ref: c.order })} title={c.order}>
                      {c.order}
                    </Link>
                  </td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td>
                    <span className="stack gap-0">
                      <span className="small">{c.handler}</span>
                      <span className="xs muted">{c.handlerKind}</span>
                    </span>
                  </td>
                  <td>
                    <span className={cx('small', c.yours && 'strong')}>{c.next}</span>
                  </td>
                  <td className="col-pin">
                    <span className="xs">{c.expected}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        {rows.some((r) => r.atRisk) && (
          <p className="status-legend status-legend--edge">
            <span className="sr-only">Legend: </span>
            <span className="sl sl-warning">
              <i aria-hidden="true" />
              Amber edge = at risk: due soon or near target
            </span>
          </p>
        )}
      </div>
      <div className="stack gap-3 only-phone">
        {rows.map((c) => (
          <Link key={c.ref} className="card pad stack gap-2 link-plain" to={caseTo(c.ref)}>
            <div className="row between">
              <span className="mono strong small">{c.ref}</span>
              <StatusBadge status={c.status} />
            </div>
            <div className="row gap-3 nowrap">
              <Img icon={c.icon} tint={c.tint} className="tiny" />
              <span className="small strong">{c.subject}</span>
            </div>
            <span className="xs muted">
              Order <span className="mono">{c.order}</span> · {c.handler} ({c.handlerKind})
            </span>
            <span className={cx('xs', c.yours && 'strong t-warning-text')}>
              <Icon name="arrow-right" className="ic-sm" /> {c.next}
            </span>
            <span className="xs muted">
              <Icon name="clock" className="ic-sm" /> {c.expected}
            </span>
          </Link>
        ))}
      </div>
      <p className="xs muted">Closed cases can be reopened within 30 days if the promised remedy didn't happen. Decisions can be appealed within 14 days.</p>
    </AccountLayout>
  );
}
