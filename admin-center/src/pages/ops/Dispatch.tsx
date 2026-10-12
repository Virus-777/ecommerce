import { useState } from 'react';
import { Link } from 'react-router';
import { OpsLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { money } from '@marketly/web-shared/lib/format';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Card, Checkbox, Deadline, Dialog, Field, Icon, IconButton, PageHeader, SearchInput, Select, StatusBadge, TableWrap, Textarea, TextInput, announce } from '@marketly/web-shared/ui';
import { ACTIONS, CARRIERS, CLAIMS, OWNERS, ROWS, SELLER_FILTERS, TABS, type ActionKey, type Claim, type DispatchView, type ExceptionRow } from './data/dispatch';
import { EDGE_RISK, EDGE_URGENT, OpsLegend } from './data/shared';

// Design: pages/ops/ops-dispatch.html (Late dispatch) and the views seller-cannot-fulfill,
// missing-tracking, lost-or-damaged, delivery-failed: one exception queue per tab.

const NOW = 'Oct 8, 10:05 AM';
const CLAIM_PREFIX: Record<string, string> = { UPS: 'UPS', USPS: 'USPS', FedEx: 'FDX' };

interface ClaimDraft {
  order: string;
  carrier: string;
  amount: string;
  what: string;
  /** Exception row the claim was opened from, if any. */
  from?: { view: DispatchView; order: string };
}
const BLANK_CLAIM: ClaimDraft = { order: '', carrier: CARRIERS[0], amount: '', what: '' };

function validateClaim(d: ClaimDraft) {
  const e: Partial<Record<keyof ClaimDraft, string>> = {};
  if (!/^MK-\d{6}-\d{5}$/.test(d.order.trim())) e.order = 'Enter an order number, like MK-260929-30126.';
  if (!(Number(d.amount) > 0)) e.amount = 'Enter the claim amount.';
  if (!d.what.trim()) e.what = 'Describe what happened to the package.';
  return e;
}

function Notified({ v }: { v: ExceptionRow['notified'] }) {
  if (v === 'no')
    return (
      <Badge tone="danger" icon="bell-off">
        Not notified
      </Badge>
    );
  if (v === 'not-yet') return <span className="xs muted">Not yet</span>;
  if (v === 'not-needed') return <span className="xs muted">Not needed</span>;
  return (
    <span className="stack gap-0">
      <Badge tone="success" icon="check">
        Notified
      </Badge>
      <span className="xs muted nowrap">{v}</span>
    </span>
  );
}

const notifiedText = (v: ExceptionRow['notified']) => (v === 'no' ? 'No' : v === 'not-yet' ? 'Not yet' : v === 'not-needed' ? 'Not needed' : `Yes · ${v}`);

function SellerCell({ r }: { r: ExceptionRow }) {
  return (
    <span className="stack gap-1 items-start">
      <span className="small nowrap">{r.seller}</span>
      {r.official ? (
        <Badge tone="brand" icon="badge-check">
          Official
        </Badge>
      ) : (
        <Badge tone="outline">Marketplace</Badge>
      )}
    </span>
  );
}

export default function Dispatch() {
  const [view] = useView<Exclude<DispatchView, ''>>();
  const [rows, setRows] = useState(ROWS);
  const [claims, setClaims] = useState<Claim[]>(CLAIMS);
  const [q, setQ] = useState('');
  const [sellerF, setSellerF] = useState(SELLER_FILTERS[0]);
  const [ownerF, setOwnerF] = useState(OWNERS[0]);
  const [notNotified, setNotNotified] = useState(false);
  const [done, setDone] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [claim, setClaim] = useState<ClaimDraft | null>(null);
  const [claimTried, setClaimTried] = useState(false);
  const [claimSeq, setClaimSeq] = useState(1);

  const tab = TABS.find((t) => t.view === view) ?? TABS[1];
  const list = rows[tab.view];
  const filtered = list.filter((r) => {
    const s = q.trim().toLowerCase();
    if (s && ![r.order, r.seller, r.item].some((x) => x.toLowerCase().includes(s))) return false;
    if (sellerF === 'Official Store' && !r.official) return false;
    if (sellerF === 'Marketplace sellers' && r.official) return false;
    if (ownerF !== OWNERS[0] && r.owner !== ownerF) return false;
    if (notNotified && r.notified !== 'no') return false;
    return true;
  });
  const legend = [
    ...(filtered.some((r) => r.edge === 'flagged') ? [{ tone: 'danger' as const, label: EDGE_URGENT }] : []),
    ...(filtered.some((r) => r.edge === 'warn') ? [{ tone: 'warning' as const, label: EDGE_RISK }] : []),
  ];

  const patch = (order: string, fn: (r: ExceptionRow) => ExceptionRow | null) =>
    setRows((all) => ({ ...all, [tab.view]: all[tab.view].flatMap((r) => (r.order === order ? (fn(r) ?? []) : [r])) }));
  const finish = (msg: string) => {
    setDone(msg);
    announce(msg);
  };
  const drop = (actions: ActionKey[], a: ActionKey) => actions.filter((x) => x !== a);

  const run = (r: ExceptionRow, a: ActionKey) => {
    setMenuFor(null);
    switch (a) {
      case 'contact':
        patch(r.order, (x) => ({ ...x, notified: x.notified === 'no' || x.notified === 'not-yet' ? NOW : x.notified }));
        finish(`Message sent to the customer on ${r.order}. It is logged on the order.`);
        break;
      case 'notify':
        patch(r.order, (x) => ({ ...x, actions: drop(x.actions, 'notify'), response: 'Seller notified, waiting for reply' }));
        finish(`${r.seller} notified about ${r.order}. Their reply comes to this queue.`);
        break;
      case 'escalate':
        patch(r.order, (x) => ({ ...x, actions: drop(x.actions, 'escalate'), owner: 'Grace Kim', response: 'Escalated to Seller Manager' }));
        finish(`${r.order} escalated to Grace Kim, Seller Manager.`);
        break;
      case 'track':
        patch(r.order, (x) => ({ ...x, actions: drop(x.actions, 'track'), response: 'Tracking requested from seller', deadline: { tone: 'ok', text: 'Seller reply by Oct 9, 10:05 AM' }, edge: '' }));
        finish(`Valid tracking requested from ${r.seller} for ${r.order}. The customer keeps seeing "Shipped, tracking pending".`);
        break;
      case 'cancel':
        setCancelFor(r.order);
        break;
      case 'claim':
        setClaimTried(false);
        setClaim({ order: r.order, carrier: r.carrier ?? CARRIERS[0], amount: r.refund ? String(r.refund) : '', what: r.item.split(' · ')[1] ?? '', from: { view: tab.view, order: r.order } });
        break;
    }
  };

  const resolve = (r: ExceptionRow) => {
    setMenuFor(null);
    patch(r.order, () => null);
    finish(`${r.order} marked resolved and removed from ${tab.label}.`);
  };

  const confirmCancel = () => {
    const r = list.find((x) => x.order === cancelFor);
    setCancelFor(null);
    if (!r) return;
    patch(r.order, () => null);
    finish(`Item cancelled on ${r.order}. ${r.refund ? money(r.refund) : 'The'} refund goes to the customer's original payment method.`);
  };

  const submitClaim = () => {
    if (!claim) return;
    setClaimTried(true);
    if (Object.keys(validateClaim(claim)).length) return;
    const amount = Number(claim.amount);
    const id = `${CLAIM_PREFIX[claim.carrier]}-CLM-${String(90000 + claimSeq)}`;
    setClaimSeq((n) => n + 1);
    setClaims((c) => [{ id, carrier: claim.carrier, order: claim.order.trim(), amount, filed: 'Oct 8', status: amount > 1000 ? 'Pending' : 'Submitted', owner: 'Theo Grant' }, ...c]);
    if (claim.from) {
      const from = claim.from;
      setRows((all) => ({ ...all, [from.view]: all[from.view].map((r) => (r.order === from.order ? { ...r, actions: drop(r.actions, 'claim'), response: `Carrier claim ${id} filed` } : r)) }));
    }
    setClaim(null);
    finish(amount > 1000 ? `Claim ${id} sent to Finance for approval.` : `Carrier claim ${id} filed with ${claim.carrier}.`);
  };

  const claimErrors = claim && claimTried ? validateClaim(claim) : {};
  const menuRow = list.find((r) => r.order === menuFor);
  const cancelRow = list.find((r) => r.order === cancelFor);

  const actionButton = (r: ExceptionRow) => {
    if (!r.actions.length) return <span className="xs muted">No action needed</span>;
    const a = ACTIONS[r.actions[0]];
    const more = r.actions.length > 1;
    return (
      <>
        <button type="button" className={cx('btn btn-sm', more ? 'btn-primary' : 'btn-ghost')} onClick={() => run(r, r.actions[0])}>
          <Icon name={a.icon} />
          <span>{a.label}</span>
          <span className="sr-only"> {r.order}</span>
        </button>
        {more && <IconButton icon="ellipsis" size="sm" label={`More actions for ${r.order}`} aria-haspopup="dialog" onClick={() => setMenuFor(r.order)} />}
      </>
    );
  };

  return (
    <OpsLayout active="dispatch">
      <PageHeader
        title="Dispatch and delivery exceptions"
        sub="Official Store and marketplace orders that are late, unclear or failed. Shipping owns these; seller problems go to the Seller Manager when performance action is needed."
        actions={
          <Button variant="secondary" size="sm" icon="download">
            Export
          </Button>
        }
      />
      <OpsLegend
        kind="number"
        items={[
          { tone: 'danger', label: 'Red number = urgent: overdue or past target' },
          { tone: 'warning', label: 'Amber number = at risk: due soon or near target' },
        ]}
      />
      <div className="tabs" role="tablist">
        {TABS.map((t) => {
          const on = t.view === tab.view;
          const n = rows[t.view].length + t.hidden;
          return (
            <Link key={t.label} className={cx('tab', on && 'is-active')} role="tab" aria-selected={on} to={href('ops/dispatch', t.view)} preventScrollReset onClick={() => setDone('')}>
              <Icon name={t.icon} className="ic-sm" />
              {t.label}
              {t.hot ? (
                <span className="count t-danger-soft">
                  {n}
                  <span className="sr-only"> overdue</span>
                </span>
              ) : (
                <span className="count">{n}</span>
              )}
            </Link>
          );
        })}
      </div>
      <div className="panel row gap-3 nowrap top">
        <Icon name="clipboard-list" />
        <span className="stack gap-0">
          <span className="small strong">Required response: {tab.label}</span>
          <span className="small sub">{tab.response}</span>
        </span>
      </div>
      {tab.view === 'missing-tracking' && (
        <Alert tone="info" title={'Customers see "Shipped, tracking pending"'}>
          The order page does not show In transit or Delivered until the carrier confirms a scan.
        </Alert>
      )}
      {done && <Alert tone="success" title={done} />}
      <div className="toolbar">
        <SearchInput id="dp-q" placeholder="Search order, seller or tracking number" value={q} onChange={setQ} />
        <label className="sr-only" htmlFor="dp-seller">
          Seller
        </label>
        <Select id="dp-seller" options={SELLER_FILTERS} value={sellerF} onChange={(e) => setSellerF(e.target.value)} />
        <label className="sr-only" htmlFor="dp-owner">
          Owner
        </label>
        <Select id="dp-owner" options={OWNERS} value={ownerF} onChange={(e) => setOwnerF(e.target.value)} />
        <Checkbox id="dp-notn" label="Customer not notified" checked={notNotified} onChange={(e) => setNotNotified(e.target.checked)} />
      </div>
      <Card title={tab.label} sub={`${list.length + tab.hidden} open · showing ${filtered.length}`} flush>
        <div className="no-phone">
          <TableWrap label={`${tab.label} table`}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Seller</th>
                  <th scope="col">Item and situation</th>
                  <th scope="col">Customer notified</th>
                  <th scope="col">Required response</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Deadline</th>
                  <th className="col-pin" scope="col">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.order} className={cx(r.edge === 'flagged' && 'is-flagged', r.edge === 'warn' && 'is-warn')}>
                    <td>
                      {r.edge === 'flagged' && <span className="sr-only">Urgent: </span>}
                      {r.edge === 'warn' && <span className="sr-only">At risk: </span>}
                      <Link className="mono nowrap" to={href('admin/order')} title={r.order}>
                        {r.order}
                      </Link>
                    </td>
                    <td>
                      <SellerCell r={r} />
                    </td>
                    <td>
                      <span className="small minw-200 cell-text">{r.item}</span>
                    </td>
                    <td>
                      <Notified v={r.notified} />
                    </td>
                    <td>
                      <span className="small minw-160 cell-text">{r.response}</span>
                    </td>
                    <td>
                      <span className="small nowrap">{r.owner}</span>
                    </td>
                    <td>
                      <Deadline tone={r.deadline.tone}>{r.deadline.text}</Deadline>
                    </td>
                    <td className="col-pin">
                      <div className="ac-acts">{actionButton(r)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          {legend.length > 0 && <OpsLegend items={legend} />}
        </div>
        <div className="ac-mlist only-phone">
          {filtered.map((r) => (
            <div key={r.order} className={cx('ac-mi', r.edge === 'flagged' && 'is-flagged', r.edge === 'warn' && 'is-warn')}>
              {r.edge === 'flagged' && <span className="sr-only">Urgent: </span>}
              {r.edge === 'warn' && <span className="sr-only">At risk: </span>}
              <div className="row between gap-2 nowrap top">
                <span className="small strong min-w-0">
                  <Link className="mono nowrap" to={href('admin/order')}>
                    {r.order}
                  </Link>
                </span>
                <Deadline tone={r.deadline.tone}>{r.deadline.text}</Deadline>
              </div>
              <div className="xs sub">
                {r.seller} · {r.official ? 'Official' : 'Marketplace'}
              </div>
              <div className="xs sub">{r.item}</div>
              <div className="xs sub">
                Customer notified: {notifiedText(r.notified)} · Owner {r.owner}
              </div>
              <div className="xs sub">
                <b>{r.response}</b>
              </div>
              {r.actions.length > 0 && (
                <div className="row gap-2 mt-1-5">
                  {r.actions.slice(0, 2).map((a) => (
                    <Button key={a} variant="ghost" size="sm" icon={ACTIONS[a].icon} onClick={() => run(r, a)}>
                      {ACTIONS[a].label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        {legend.length > 0 && <OpsLegend className="only-phone" items={legend} />}
        {filtered.length === 0 && (
          <div className="card-body">
            <p className="small muted">{list.length ? 'No exceptions match these filters.' : `No open ${tab.label.toLowerCase()} exceptions.`}</p>
          </div>
        )}
      </Card>
      <Card
        title="Carrier claims"
        titleAs="h3"
        sub="Claims over $1,000 need Finance approval"
        flush
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon="file-plus"
            onClick={() => {
              setClaimTried(false);
              setClaim({ ...BLANK_CLAIM });
            }}
          >
            Open carrier claim
          </Button>
        }
      >
        <div className="no-phone">
          <TableWrap label="Carrier claims table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Claim</th>
                  <th scope="col">Carrier</th>
                  <th scope="col">Order</th>
                  <th className="r" scope="col">
                    Amount
                  </th>
                  <th scope="col">Filed</th>
                  <th scope="col">Status</th>
                  <th className="col-pin" scope="col">
                    Owner
                  </th>
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className="mono small nowrap" title={c.id}>
                        {c.id}
                      </span>
                    </td>
                    <td>{c.carrier}</td>
                    <td>
                      <Link className="mono nowrap" to={href('admin/order')} title={c.order}>
                        {c.order}
                      </Link>
                    </td>
                    <td className="r">{money(c.amount)}</td>
                    <td>{c.filed}</td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="col-pin">
                      <span className="small">{c.owner}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </div>
        <div className="ac-mlist only-phone">
          {claims.map((c) => (
            <div key={c.id} className="ac-mi">
              <div className="row between gap-2 nowrap top">
                <span className="small strong min-w-0">
                  <span className="mono">{c.id}</span>
                </span>
                <StatusBadge status={c.status} />
              </div>
              <div className="xs sub">
                {c.carrier} · {money(c.amount)} · filed {c.filed}
              </div>
              <div className="xs sub">
                Order <span className="mono">{c.order}</span> · {c.owner}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Dialog open={!!menuRow} onClose={() => setMenuFor(null)} title={menuRow ? `Actions for ${menuRow.order}` : 'Actions'} size="sm">
        {menuRow && (
          <div className="menu-list">
            {menuRow.actions.map((a) => (
              <button key={a} type="button" onClick={() => run(menuRow, a)}>
                <Icon name={ACTIONS[a].icon} />
                {ACTIONS[a].label}
              </button>
            ))}
            <Link to={href('admin/order')}>
              <Icon name="external-link" />
              Open order
            </Link>
            <button type="button" onClick={() => resolve(menuRow)}>
              <Icon name="circle-check" />
              Mark resolved
            </button>
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!cancelRow}
        onClose={() => setCancelFor(null)}
        title="Cancel item and refund"
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setCancelFor(null)}>
              Keep item
            </Button>
            <Button variant="danger" icon="circle-x" onClick={confirmCancel}>
              Cancel and refund{cancelRow?.refund ? ` ${money(cancelRow.refund)}` : ''}
            </Button>
          </>
        }
      >
        {cancelRow && (
          <>
            <p className="small">
              {cancelRow.item} on <span className="mono">{cancelRow.order}</span>, sold by {cancelRow.seller}.
            </p>
            <Alert tone="info" title="The customer is told right away">
              The refund goes to the original payment method. The seller's cancellation rate updates.
            </Alert>
          </>
        )}
      </Dialog>

      <Dialog
        open={!!claim}
        onClose={() => setClaim(null)}
        title="Open carrier claim"
        foot={
          <>
            <Button variant="ghost" onClick={() => setClaim(null)}>
              Cancel
            </Button>
            <Button icon={Number(claim?.amount) > 1000 ? 'send' : 'file-plus'} onClick={submitClaim}>
              {Number(claim?.amount) > 1000 ? 'Send to Finance' : 'File claim'}
            </Button>
          </>
        }
      >
        {claim && (
          <>
            <div className="ac-fgrid">
              <Field label="Order" error={claimErrors.order}>
                <TextInput id="cl-order" value={claim.order} error={!!claimErrors.order} onChange={(e) => setClaim({ ...claim, order: e.target.value })} className="mono" />
              </Field>
              <Field label="Carrier">
                <Select id="cl-carrier" options={CARRIERS} value={claim.carrier} onChange={(e) => setClaim({ ...claim, carrier: e.target.value })} />
              </Field>
              <Field label="Claim amount" error={claimErrors.amount}>
                <TextInput id="cl-amount" type="number" min={0} prefix="$" value={claim.amount} error={!!claimErrors.amount} onChange={(e) => setClaim({ ...claim, amount: e.target.value })} />
              </Field>
              <div className="full">
                <Field label="What happened" error={claimErrors.what}>
                  <Textarea id="cl-what" value={claim.what} onChange={(e) => setClaim({ ...claim, what: e.target.value })} />
                </Field>
              </div>
            </div>
            {Number(claim.amount) > 1000 && (
              <Alert tone="warning" title="Finance approval needed">
                Claims over $1,000 go to Finance before they are filed with the carrier.
              </Alert>
            )}
          </>
        )}
      </Dialog>
    </OpsLayout>
  );
}
