import { useState } from 'react';
import { Link } from 'react-router';
import { STAFF } from '@/app/session';
import { sellers, type SellerId } from '@/data/fixtures';
import { AdminLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { money } from '@/lib/format';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import {
  Alert, Avatar, Badge, Button, Card, Deadline, Dialog, Field, Icon, Img, KeyValue, LogoTile, PageHeader, Select, StatusBadge, SummaryRow, TableWrap, Textarea, TextInput, announce,
  type TimelineEvent,
} from '@/ui';
import {
  FEE_RATE, FUNDING, HISTORY, ITEMS, NOTES, ORDER_META as O, PACKAGES, REFUND_DESTINATIONS, REFUND_NOTE_SAMPLE, REFUND_ORDER, REFUND_REASONS,
  type AdminOrderItem, type InternalNote, type ItemId,
} from './data/order';

// Design: pages/admin/admin-order.html · view "issue-refund" = the refund dialog with the
// pour-over and duvet selected. Submitting sends the refund to Finance for approval.

type View = 'issue-refund';

/** Refund dialog form: selected items, typed amounts, reason, destination and note. */
interface RefundForm {
  selected: Partial<Record<ItemId, boolean>>;
  amounts: Partial<Record<ItemId, string>>;
  reason: string;
  dest: string;
  note: string;
}

const DESIGN_FORM: RefundForm = {
  selected: { pourover: true, duvet: true },
  amounts: { pourover: '34.65', duvet: '114.54' },
  reason: 'Seller cannot fulfil',
  dest: REFUND_DESTINATIONS[0],
  note: REFUND_NOTE_SAMPLE,
};
const CANCEL_FORM: RefundForm = { selected: { duvet: true }, amounts: { duvet: '114.54' }, reason: 'Seller cannot fulfil', dest: REFUND_DESTINATIONS[0], note: '' };

const parseAmount = (s: string | undefined) => (s && /^\d+(\.\d{1,2})?$/.test(s.trim()) ? Number(s.trim()) : NaN);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Timeline with the design's "At risk:" note on warning events (shared Timeline lacks it). */
function History({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="timeline">
      {events.map((e, i) => (
        <li key={i} className={cx('ev', e.state && `is-${e.state}`)}>
          {e.state === 'warn' && <span className="sr-only">At risk: </span>}
          <span className="dot" aria-hidden="true" />
          <div className="stack gap-1">
            <span className="t">{e.t}</span>
            {e.d && <span className="d">{e.d}</span>}
            {e.body && <div className="small sub">{e.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function SellerCell({ id }: { id: SellerId }) {
  const s = sellers[id];
  return (
    <span className="row nowrap gap-2">
      <LogoTile initials={s.initials} tint={s.tint} size="sm" />
      <span className="stack gap-0">
        <span className="small strong nowrap">{s.name}</span>
        <span className="xs muted nowrap">{'official' in s && s.official ? 'Official Store' : 'Marketplace seller'}</span>
      </span>
    </span>
  );
}

export default function Order() {
  const [view, setView] = useView<View>();
  const [form, setForm] = useState<RefundForm>(DESIGN_FORM);
  const [attempted, setAttempted] = useState(false);
  /** Refunds sent to Finance, per item (approval is not money arrived). */
  const [requested, setRequested] = useState<Partial<Record<ItemId, number>>>({});
  const [history, setHistory] = useState(HISTORY);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);
  const [notes, setNotes] = useState<InternalNote[]>(NOTES);
  const [draftNote, setDraftNote] = useState('');
  const [noteError, setNoteError] = useState('');

  const open = view === 'issue-refund';
  const pending = round2(Object.values(requested).reduce((a, b) => a + (b ?? 0), 0));
  const remaining = round2(O.total - pending);
  const isCancelled = (id: ItemId) => ITEMS[id].request.kind === 'cancel' && requested[id] !== undefined;
  const refundable = (it: AdminOrderItem) => !it.blocked && requested[it.id] === undefined;

  // ----- Refund dialog -----
  const chosen = REFUND_ORDER.map((id) => ITEMS[id]).filter((it) => refundable(it) && form.selected[it.id]);
  const amountError = (it: AdminOrderItem) => {
    const v = parseAmount(form.amounts[it.id]);
    if (Number.isNaN(v) || v <= 0) return 'Enter an amount, like 34.65.';
    if (v > it.paid) return `Enter ${money(it.paid)} or less. That's all that is still refundable for this item.`;
    return '';
  };
  const errors = {
    items: chosen.length === 0 ? 'Choose at least one item to refund.' : '',
    amounts: Object.fromEntries(chosen.map((it) => [it.id, amountError(it)])) as Partial<Record<ItemId, string>>,
    reason: form.reason === REFUND_REASONS[0] ? 'Choose a reason for this refund.' : '',
    note: form.note.trim() ? '' : 'Add a note for the record. Finance reads it before approving.',
  };
  const nErrors = (errors.items ? 1 : 0) + Object.values(errors.amounts).filter(Boolean).length + (errors.reason ? 1 : 0) + (errors.note ? 1 : 0);
  const shown = attempted ? errors : { items: '', amounts: {} as Partial<Record<ItemId, string>>, reason: '', note: '' };
  const valid = chosen.filter((it) => !amountError(it));
  const refundTotal = round2(valid.reduce((a, it) => a + parseAmount(form.amounts[it.id]), 0));

  // Effect per seller: the refunded share of the item price comes off earnings and fee; the coupon share goes back to the budget.
  const effect = Object.values(
    valid.reduce<Record<string, { seller: SellerId; refund: number; gross: number; coupon: number }>>((acc, it) => {
      const amt = parseAmount(form.amounts[it.id]);
      const ratio = amt / it.paid;
      const row = (acc[it.seller] ??= { seller: it.seller, refund: 0, gross: 0, coupon: 0 });
      row.refund += amt;
      row.gross += it.unit * it.qty * ratio;
      row.coupon += (it.unit * it.qty - it.paid) * ratio;
      return acc;
    }, {}),
  );

  const openRefund = (initial: RefundForm) => {
    setForm({
      ...initial,
      selected: Object.fromEntries(Object.entries(initial.selected).filter(([id]) => requested[id as ItemId] === undefined)),
    });
    setAttempted(false);
    setView('issue-refund');
  };
  const close = () => setView('');
  const setField = <K extends keyof RefundForm>(k: K, v: RefundForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleItem = (id: ItemId) => setForm((f) => ({ ...f, selected: { ...f.selected, [id]: !f.selected[id] } }));
  const setAmount = (id: ItemId, v: string) => setForm((f) => ({ ...f, amounts: { ...f.amounts, [id]: v }, selected: v.trim() ? { ...f.selected, [id]: true } : f.selected }));

  const submit = () => {
    setAttempted(true);
    if (nErrors) return;
    const add = Object.fromEntries(chosen.map((it) => [it.id, parseAmount(form.amounts[it.id])]));
    setRequested((r) => ({ ...r, ...add }));
    const cancels = chosen.filter((it) => it.request.kind === 'cancel');
    const who = `${STAFF.admin.name}, ${STAFF.admin.role}`;
    setHistory((h) => [
      { t: `Refund of ${money(refundTotal)} sent to Finance for approval`, d: `Oct 8, 10:15 AM · ${who}`, state: 'current', body: `Reason: ${form.reason.toLowerCase()}. ${form.note.trim()}` },
      ...h.map((e) => (e.state === 'current' ? { ...e, state: 'done' as const } : e)),
    ]);
    const title = `Refund of ${money(refundTotal)} sent to Finance for approval`;
    const body = `${O.financeApprover.replace(' · ', ' ')} approves it, then the money goes to ${form.dest.startsWith('Store') ? 'store credit' : O.card}. The customer sees "Refund requested" until Finance sends it.${cancels.length ? ` ${cancels.map((c) => c.short).join(', ')} cancelled and the overdue task closed.` : ''}`;
    setNotice({ title, body });
    announce(title);
    close();
  };

  // ----- Notes -----
  const saveNote = () => {
    if (!draftNote.trim()) {
      setNoteError('Write a note before saving.');
      return;
    }
    setNotes((n) => [{ who: STAFF.admin.name, when: 'Just now', text: draftNote.trim() }, ...n]);
    setDraftNote('');
    setNoteError('');
    announce('Note saved');
  };

  // ----- Item display after refunds -----
  const itemStatus = (it: AdminOrderItem) => (isCancelled(it.id) ? 'Cancelled' : it.status);
  const pkgStatus = (p: (typeof PACKAGES)[number]) => (p.items.every(isCancelled) ? 'Cancelled' : p.status);
  const package3Overdue = !isCancelled('duvet');

  return (
    <AdminLayout active="orders">
      <PageHeader
        crumbs={[{ label: 'Commerce' }, { label: 'Orders', to: href('admin/orders') }, { label: O.ref }]}
        title={
          <>
            Order <span className="mono">{O.ref}</span>
          </>
        }
        sub={
          <>
            Placed {O.placed} · 3 sellers · 3 packages · <StatusBadge status={O.status} /> <StatusBadge status={O.payment} />
          </>
        }
        actions={
          <>
            <Button variant="secondary" size="sm" icon="circle-x" onClick={() => openRefund(CANCEL_FORM)} disabled={!package3Overdue}>
              Cancel items
            </Button>
            <Button variant="secondary" size="sm" icon="undo-2" onClick={() => openRefund(DESIGN_FORM)}>
              Issue refund
            </Button>
            <Button variant="secondary" size="sm" icon="message-square" onClick={() => announce('Message to sellers opened')}>
              Contact seller
            </Button>
            <Button size="sm" icon="life-buoy" to={href('admin/case')}>
              Open case
            </Button>
          </>
        }
      />
      {notice && (
        <Alert tone="success" title={notice.title}>
          {notice.body}
        </Alert>
      )}
      {package3Overdue && (
        <Alert tone="danger" title="Package 3 is 16 days past its dispatch deadline">
          Casa Verde Home has not shipped the duvet cover. Case CS-261007-0412 is open with Isabel Cruz. Grace Kim set a final date of Oct 12; after that, cancel the item and refund it in full.
        </Alert>
      )}
      <div className="aa-split">
        <div className="stack gap-5">
          {PACKAGES.map((p, pi) => {
            const s = sellers[p.seller];
            const official = 'official' in s && s.official;
            const status = pkgStatus(p);
            return (
              <Card
                key={p.label}
                titleAs={pi === 0 ? 'h2' : 'h3'}
                title={
                  <span className="row gap-2">
                    <LogoTile initials={s.initials} tint={s.tint} size="sm" />
                    <span>{s.name}</span>
                    {official ? (
                      <Badge tone="brand" icon="badge-check">
                        Official
                      </Badge>
                    ) : (
                      <Badge tone="info" icon="shield-check">
                        Verified
                      </Badge>
                    )}
                  </span>
                }
                sub={p.sub}
                actions={<StatusBadge status={status} />}
                foot={
                  p.foot === 'tracking' ? (
                    <>
                      <Button variant="ghost" size="sm" icon="history" onClick={() => announce(`Shipment history for ${p.label}`)}>
                        Shipment history
                      </Button>
                      <Button variant="ghost" size="sm" icon="pencil" onClick={() => announce(`Correct tracking for ${p.label}`)}>
                        Correct tracking
                      </Button>
                    </>
                  ) : status !== 'Cancelled' ? (
                    <>
                      <Button variant="secondary" size="sm" icon="message-square" onClick={() => announce(`Message to ${s.name} opened`)}>
                        Contact seller
                      </Button>
                      <Button variant="danger-soft" size="sm" icon="circle-x" onClick={() => openRefund(CANCEL_FORM)}>
                        Cancel item
                      </Button>
                    </>
                  ) : undefined
                }
              >
                {p.items.map((id) => {
                  const it = ITEMS[id];
                  const req = requested[id];
                  return (
                    <div key={id} className="aa-item">
                      <Img icon={it.icon} tint={it.tint} />
                      <div className="stack gap-1">
                        <Link className="small strong" to={href('admin/catalog')}>
                          {it.name}
                        </Link>
                        <span className="xs muted">
                          {it.variant} · SKU <span className="mono">{it.sku}</span> · Qty {it.qty} · {money(it.unit)} each
                        </span>
                        <div className="aa-item-r">
                          <span className="row gap-2">
                            <StatusBadge status={itemStatus(it)} />
                            {req !== undefined ? (
                              <>
                                <span className="xs muted">Refund</span>
                                <StatusBadge status="Requested" />
                              </>
                            ) : (
                              it.sub && (
                                <>
                                  <span className="xs muted">{it.sub.label}</span>
                                  <StatusBadge status={it.sub.status} />
                                </>
                              )
                            )}
                          </span>
                          <span className="small num">
                            <span className="muted xs">Paid after coupon </span>
                            <b>{money(it.paid)}</b>
                          </span>
                        </div>
                        <span className="xs sub">{req !== undefined ? `Refund of ${money(req)} requested · waiting for Finance approval` : it.note}</span>
                      </div>
                    </div>
                  );
                })}
                <div className="aa-ship">
                  <Icon name="truck" className="ic-sm" />
                  <span className="strong">{p.carrier}</span>
                  {p.tracking ? <span className="mono">{p.tracking}</span> : <span className="muted">{p.trackingNote}</span>}
                  <span className="muted">{p.eta}</span>
                  <span className="grow" />
                  {status === 'Cancelled' ? <Deadline tone="ok">Item cancelled · overdue task closed</Deadline> : <Deadline tone={p.deadline.tone}>{p.deadline.text}</Deadline>}
                </div>
              </Card>
            );
          })}

          <Card titleAs="h3" title="Cancellations and refunds" sub={pending ? `Tracked per item · ${money(pending)} waiting for Finance approval` : 'Tracked per item · nothing refunded yet'} flush>
            <TableWrap label="Cancellations and refunds table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col">Seller</th>
                    <th scope="col">Request</th>
                    <th className="r" scope="col">Amount</th>
                    <th scope="col">Status</th>
                    <th className="col-pin" scope="col">Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {REFUND_ORDER.map((id) => {
                    const it = ITEMS[id];
                    const r = it.request;
                    const req = requested[id];
                    const edge = req === undefined && r.kind !== 'none' ? r.edge : undefined;
                    return (
                      <tr key={id} className={edge === 'flagged' ? 'is-flagged' : edge === 'warn' ? 'is-warn' : ''}>
                        <td>
                          {edge && <span className="sr-only">{edge === 'flagged' ? 'Urgent: ' : 'At risk: '}</span>}
                          <span className="row nowrap gap-2">
                            <Img icon={it.icon} tint={it.tint} className="tiny" />
                            <span className="small">{it.short}</span>
                          </span>
                        </td>
                        <td>{sellers[it.seller].name}</td>
                        <td>
                          {req !== undefined ? (
                            <>
                              Refund requested
                              <br />
                              <span className="xs muted">Waiting for Finance · Priya Nair</span>
                            </>
                          ) : r.kind === 'return' ? (
                            <>
                              Return{' '}
                              <Link className="mono nowrap" to={href('admin/returns')} title={r.ref}>
                                {r.ref}
                              </Link>
                              <br />
                              <span className="xs muted">{r.note}</span>
                            </>
                          ) : r.kind === 'cancel' ? (
                            <>
                              Cancellation eligible
                              <br />
                              <span className="xs muted">{r.note}</span>
                            </>
                          ) : (
                            <span className="muted">None</span>
                          )}
                        </td>
                        <td className="r">{req !== undefined ? money(req) : r.kind !== 'none' ? money(it.paid) : <span className="muted">—</span>}</td>
                        <td>
                          {req !== undefined ? (
                            <span className="stack gap-1">
                              <StatusBadge status={itemStatus(it)} />
                              <StatusBadge status="Refund requested" tone="info" />
                            </span>
                          ) : it.sub ? (
                            <span className="stack gap-1">
                              <StatusBadge status={it.status} />
                              <StatusBadge status={it.sub.status} />
                            </span>
                          ) : (
                            <StatusBadge status={it.status} />
                          )}
                        </td>
                        <td className="col-pin">{r.kind !== 'none' ? r.owner : <span className="muted">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            <p className="status-legend status-legend--edge">
              <span className="sr-only">Legend: </span>
              <span className="sl sl-danger">
                <i aria-hidden="true" />
                Red edge = urgent: overdue or past target
              </span>
              <span className="sl sl-warning">
                <i aria-hidden="true" />
                Amber edge = at risk: due soon or near target
              </span>
            </p>
          </Card>

          <Card titleAs="h3" title="Coupon funding and money by seller" sub={`${O.coupon} · −${money(O.discount)} · allocated by item value`} flush>
            <TableWrap label="Coupon funding and money by seller table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Seller group</th>
                    <th className="r" scope="col">Items</th>
                    <th className="r" scope="col">Platform-funded</th>
                    <th className="r" scope="col">Seller-funded</th>
                    <th className="r" scope="col">Customer paid</th>
                    <th className="r" scope="col">Marketplace fee</th>
                    <th className="r col-pin" scope="col">Seller earnings</th>
                  </tr>
                </thead>
                <tbody>
                  {FUNDING.map((f) => (
                    <tr key={f.seller}>
                      <td>
                        <SellerCell id={f.seller} />
                      </td>
                      <td className="r">{money(f.items)}</td>
                      <td className="r">{money(f.platform)}</td>
                      <td className="r">{money(f.sellerFunded)}</td>
                      <td className="r">{money(f.paid)}</td>
                      <td className="r">{f.fee === null ? <span className="muted">—</span> : money(f.fee)}</td>
                      <td className="r col-pin">{f.earnings === null ? <span className="xs muted">Company sales</span> : money(f.earnings)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>
                      <span className="strong">Order</span>
                    </td>
                    {[
                      FUNDING.reduce((a, f) => a + f.items, 0),
                      FUNDING.reduce((a, f) => a + f.platform, 0),
                      FUNDING.reduce((a, f) => a + f.sellerFunded, 0),
                      FUNDING.reduce((a, f) => a + f.paid, 0),
                      FUNDING.reduce((a, f) => a + (f.fee ?? 0), 0),
                    ].map((v, i) => (
                      <td key={i} className="r">
                        <span className="strong">{money(v)}</span>
                      </td>
                    ))}
                    <td className="r col-pin">
                      <span className="strong">{money(FUNDING.reduce((a, f) => a + (f.earnings ?? 0), 0))}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </TableWrap>
            <div className="card-body u-pt-0">
              <span className="xs muted">
                Pixel &amp; Port's markdown on the SSD (was $119.99) is seller-funded and already in the item price. Example fee: 10% of item price after seller-funded discounts, excluding shipping. Final fees are in the seller agreement.
              </span>
            </div>
          </Card>

          <Card
            titleAs="h3"
            title="Action history"
            sub="Every change with staff name and reason"
            actions={
              <Link className="small strong" to={href('admin/audit')}>
                Full log
              </Link>
            }
          >
            <History events={history} />
          </Card>
        </div>

        <div className="stack gap-5">
          <Card
            titleAs="h3"
            title="Customer"
            actions={
              <Link className="small strong" to={href('admin/customers')}>
                Profile
              </Link>
            }
          >
            <div className="row gap-3">
              <Avatar name="Jordan Lee" />
              <div className="stack gap-0">
                <span className="strong">Jordan Lee</span>
                <span className="xs muted">Customer since Aug 2026 · 5 orders</span>
              </div>
            </div>
            <KeyValue
              pairs={[
                ['Email', 'jordan.lee@example.com'],
                ['Phone', '(503) 555-0148'],
                ['Ship to', '2140 Alder St, Apt 5, Portland, OR 97205'],
                [
                  'Open cases',
                  <Link key="c" to={href('admin/case')} className="mono">
                    {O.caseRef}
                  </Link>,
                ],
              ]}
            />
          </Card>

          <Card titleAs="h3" title="Payment" actions={<StatusBadge status={O.payment} />}>
            <KeyValue
              pairs={[
                ['Method', O.card],
                ['Authorized', O.authorized],
                ['Captured', O.captured],
                ['Processor ref', <span key="r" className="mono">{O.processorRef}</span>],
              ]}
            />
            <div className="stack gap-2">
              <SummaryRow k="Items" v={money(O.subtotal)} />
              <SummaryRow k={`Coupon ${O.coupon}`} v={`−${money(O.discount)}`} className="discount" />
              <SummaryRow k="Shipping" v="Free" />
              <SummaryRow k="Sales tax" v="$0.00" />
              <SummaryRow k="Captured" v={money(O.total)} className="total" />
              {pending > 0 && <SummaryRow k="Refund requested" v={money(pending)} />}
              <SummaryRow k="Refunded" v="$0.00" />
            </div>
            <span className="xs muted">Sales tax: Oregon has no sales tax.</span>
          </Card>

          <Card titleAs="h3" title="Internal notes" sub="Staff only · never shown to customer or sellers">
            {notes.map((n, i) => (
              <div key={i} className="aa-note">
                <span className="row between xs">
                  <b>{n.who}</b>
                  <span className="muted">{n.when}</span>
                </span>
                <span>{n.text}</span>
              </div>
            ))}
            <Field label="Add a note" error={noteError}>
              <Textarea id="aa-od-note" placeholder="Write a note for the team" value={draftNote} onChange={(e) => (setDraftNote(e.target.value), noteError && setNoteError(''))} />
            </Field>
            <Button variant="secondary" size="sm" onClick={saveNote}>
              Save note
            </Button>
          </Card>
        </div>
      </div>

      <Dialog
        open={open}
        onClose={close}
        size="lg"
        title={`Issue refund · ${O.ref}`}
        foot={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button icon="send" onClick={submit}>
              Send {money(refundTotal)} to Finance for approval
            </Button>
          </>
        }
      >
        <div className="row between small">
          <span className="sub">
            Customer paid {money(O.total)} · refunded so far $0.00
            {pending > 0 && ` · ${money(pending)} waiting for Finance`}
          </span>
          <span className="strong">Remaining refundable {money(remaining)}</span>
        </div>
        {attempted && nErrors > 0 && (
          <Alert tone="danger" title={`Check ${nErrors} field${nErrors > 1 ? 's' : ''}`}>
            {errors.items || 'Fix the highlighted fields to send this refund.'}
          </Alert>
        )}
        <div className="stack gap-2">
          <span className="label">Items and amounts</span>
          {REFUND_ORDER.map((id) => {
            const it = ITEMS[id];
            const s = sellers[it.seller];
            const sent = requested[id];
            const disabled = !refundable(it);
            const on = !disabled && !!form.selected[id];
            return (
              <div key={id} className={cx('aa-rf', on && 'is-selected', disabled && 'is-disabled')}>
                <div className="row nowrap top gap-3">
                  <input type="checkbox" id={`aa-rf-${id}`} aria-label={`Refund ${it.name}`} className="check-input" checked={on} disabled={disabled} onChange={() => toggleItem(id)} />
                  <Img icon={it.icon} tint={it.tint} className="tiny" />
                  <label className="stack gap-0" htmlFor={`aa-rf-${id}`}>
                    <span className="small strong">{it.name}</span>
                    <span className="xs muted">
                      {s.name} · {it.variant} · <StatusBadge status={itemStatus(it)} />
                    </span>
                    {sent !== undefined ? (
                      <span className="xs t-warning-text strong">Refund of {money(sent)} already requested · a second refund for this item is blocked</span>
                    ) : it.blocked ? (
                      <span className="xs t-warning-text strong">{it.refundNote}</span>
                    ) : (
                      <span className="xs sub">{it.refundNote}</span>
                    )}
                  </label>
                </div>
                {disabled ? (
                  <span className="xs muted">Refundable remaining {money(sent !== undefined ? round2(it.paid - sent) : it.paid)}</span>
                ) : (
                  <Field
                    label={
                      <>
                        Amount <span className="xs muted">· up to {money(it.paid)}</span>
                      </>
                    }
                    error={on ? shown.amounts[id] : undefined}
                  >
                    <TextInput id={`aa-rf-amt-${id}`} prefix="$" inputMode="decimal" value={form.amounts[id] ?? ''} error={on && !!shown.amounts[id]} onChange={(e) => setAmount(id, e.target.value)} />
                  </Field>
                )}
              </div>
            );
          })}
          {shown.items && (
            <span className="error-text">
              <Icon name="circle-alert" className="ic-sm" />
              {shown.items}
            </span>
          )}
        </div>
        <Alert tone="info" title="Over-refund check">
          Amounts are capped at what is still refundable per item, after the coupon share. A second refund for the same item and reason is blocked. Shipping was free, so there is no shipping to refund.
        </Alert>
        <div className="grid md2 gap-3">
          <Field label="Reason" hint={shown.reason ? undefined : 'Each item keeps its own reason in the record.'} error={shown.reason}>
            <Select id="aa-rf-reason" options={REFUND_REASONS} value={form.reason} onChange={(e) => setField('reason', e.target.value)} />
          </Field>
          <Field label="Refund to" hint="Card refunds usually arrive 3–5 business days after we send them.">
            <Select id="aa-rf-dest" options={REFUND_DESTINATIONS} value={form.dest} onChange={(e) => setField('dest', e.target.value)} />
          </Field>
        </div>
        <Field label="Note for the record" hint="Required. Shown in Action history and to Finance." error={shown.note}>
          <Textarea id="aa-rf-note" placeholder="" value={form.note} onChange={(e) => setField('note', e.target.value)} />
        </Field>
        <div className="stack gap-2">
          <span className="label">Effect on seller earnings and fees</span>
          <TableWrap label={`Issue refund · ${O.ref} table`}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Seller</th>
                  <th className="r" scope="col">Refund</th>
                  <th className="r" scope="col">Seller earnings</th>
                  <th className="r" scope="col">Marketplace fee</th>
                  <th className="r col-pin" scope="col">Coupon (platform-funded)</th>
                </tr>
              </thead>
              <tbody>
                {effect.length === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      <span className="xs muted">Choose items and amounts to see the effect.</span>
                    </td>
                  </tr>
                ) : (
                  effect.map((e) => {
                    const official = e.seller === 'official';
                    return (
                      <tr key={e.seller}>
                        <td>
                          <SellerCell id={e.seller} />
                        </td>
                        <td className="r">{money(e.refund)}</td>
                        <td className="r">{official ? <span className="xs muted">Company sales −{money(e.gross)}</span> : `−${money(e.gross * (1 - FEE_RATE))}`}</td>
                        <td className="r">{official ? <span className="muted">Not charged</span> : `−${money(e.gross * FEE_RATE)} reversed`}</td>
                        <td className="r col-pin">{money(e.coupon)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </TableWrap>
          <span className="xs muted">
            Example fee: 10% of item price after seller-funded discounts, excluding shipping. Final fees are in the seller agreement. Platform-funded coupon shares are returned to the WELCOME20 budget and never charged to sellers.
          </span>
        </div>
        <div className="well stack gap-2">
          <div className="row between">
            <span className="strong">Refund total</span>
            <span className="h3 num">{money(refundTotal)}</span>
          </div>
          <SummaryRow k="Approval route" v={refundTotal > O.financeLimit ? `${O.financeApprover} + second reviewer` : O.financeApprover} />
          <SummaryRow k="Your refund authority" v="None · Platform Administrator role" />
          <SummaryRow k="Finance limit" v={`Up to ${money(O.financeLimit)} · one approval`} />
          <span className="xs muted">
            Refunds above {money(O.financeLimit)} also need a second Finance reviewer. The customer sees "Refund requested" until Finance sends it; approval is not money arrived.
          </span>
        </div>
      </Dialog>
    </AdminLayout>
  );
}
