import { useState } from 'react';
import { Link } from 'react-router';
import { SellerLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { money } from '@/lib/format';
import { href } from '@/routes/href';
import { Alert, announce, Badge, Button, Card, Dialog, Field, Icon, KeyValue, PageHeader, Pager, SegmentedControl, Select, Stat, StatusBadge, SummaryRow, TableWrap, TextInput } from '@/ui';
import { BALANCES, HOLD, PAYOUTS, TRANSACTIONS, signedMoney, type TxFilter } from './data/finance';

// Design: pages/seller/seller-finance.html (no views). Transactions segment filters the ledger;
// "Change payout account" opens a local dialog (owner-only change, verified then reviewed by Finance).

const FILTERS: Array<{ label: string; value: TxFilter }> = [
  { label: 'All', value: 'all' },
  { label: 'Sales', value: 'sales' },
  { label: 'Fees', value: 'fees' },
  { label: 'Refunds', value: 'refunds' },
  { label: 'Payouts', value: 'payouts' },
];

const BANKS = ['Pacific Coast Credit Union', 'Cascade Federal Bank', 'Northwest Community Bank', 'Other bank'];

interface AccountForm {
  holder: string;
  bank: string;
  routing: string;
  account: string;
  confirm: string;
}
const EMPTY_FORM: AccountForm = { holder: 'Northwind Audio LLC', bank: BANKS[0], routing: '', account: '', confirm: '' };

function validate(f: AccountForm) {
  const e: Partial<Record<keyof AccountForm, string>> = {};
  if (!f.holder.trim()) e.holder = 'Enter the account holder name. It must match your business name.';
  if (!/^\d{9}$/.test(f.routing.trim())) e.routing = 'Enter the 9-digit routing number.';
  if (!/^\d{4,17}$/.test(f.account.trim())) e.account = 'Enter an account number of 4 to 17 digits.';
  else if (f.confirm.trim() !== f.account.trim()) e.confirm = "Account numbers don't match.";
  return e;
}

export default function Finance() {
  const [filter, setFilter] = useState<TxFilter>('all');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState(false);
  const [form, setForm] = useState<AccountForm>(EMPTY_FORM);
  const [attempted, setAttempted] = useState(false);
  const [change, setChange] = useState<{ bank: string; last4: string } | null>(null);

  const rows = filter === 'all' ? TRANSACTIONS : TRANSACTIONS.filter((t) => t.group === filter);
  const filterLabel = FILTERS.find((f) => f.value === filter)!.label.toLowerCase();
  const errors = attempted ? validate(form) : {};
  const set = <K extends keyof AccountForm>(k: K, v: AccountForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const openDialog = () => {
    setForm(EMPTY_FORM);
    setAttempted(false);
    setDialog(true);
  };
  const submit = () => {
    setAttempted(true);
    if (Object.keys(validate(form)).length) return;
    setChange({ bank: form.bank, last4: form.account.trim().slice(-4) });
    setDialog(false);
    announce('Payout account change submitted for review');
  };

  return (
    <SellerLayout active="finance">
      <PageHeader
        title="Finance"
        sub="Balances as of Thu, Oct 8, 2026, 9:40 AM PT. Example settlement rules: weekly payouts on Mondays, earnings become available 3 days after delivery."
        actions={
          <>
            <Button variant="secondary" size="sm" icon="file-text" to={href('seller/statement')}>
              Statements
            </Button>
            <Button variant="secondary" size="sm" icon="download" onClick={() => announce('Ledger export started. The CSV downloads when it is ready.')}>
              Export ledger
            </Button>
          </>
        }
      />
      <div className="sb-kpis">
        {BALANCES.map((b) => (
          <div key={b.key} className={cx('card pad sb-bal', b.className)}>
            <Stat label={b.label} icon={b.icon} value={money(b.amount)} />
            <span className="why">{b.why}</span>
            {b.key === 'held' && (
              <div className="panel stack gap-1">
                <span className="xs strong">
                  <Link className="mono" to={href('seller/order')}>
                    {HOLD.order}
                  </Link>{' '}
                  · {money(HOLD.amount)}
                </span>
                <span className="xs sub">Reason: {HOLD.reason}</span>
                <span className="xs sub">Review date: {HOLD.review}</span>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="sb-main">
        <div className="stack gap-5">
          <Card
            flush
            title="Transactions"
            sub={
              filter === 'all'
                ? `Latest ${rows.length} of 64 this month · balance after = pending + available + held`
                : `${rows.length} ${filterLabel} in the latest ${TRANSACTIONS.length} · balance after = pending + available + held`
            }
            actions={<SegmentedControl items={FILTERS} active={filter} onChange={setFilter} label="Transaction type" />}
            foot={
              <>
                <span className="xs muted grow">Ad charges are billed separately from sales commission.</span>
                <Pager page={page} total={6} onPage={setPage} />
              </>
            }
          >
            <TableWrap label="Transactions table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Type</th>
                    <th scope="col">Reference</th>
                    <th scope="col">Details</th>
                    <th className="r" scope="col">
                      Amount
                    </th>
                    <th className="r col-pin" scope="col">
                      Balance after
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <span className="xs sub nowrap">{t.date}</span>
                      </td>
                      <td>
                        <span className="row gap-2 nowrap small">
                          <Icon name={t.icon} className="ic-sm" />
                          {t.type}
                        </span>
                      </td>
                      <td>
                        {t.refTo ? (
                          <Link className="mono nowrap" to={href(t.refTo)} title={t.ref}>
                            {t.ref}
                          </Link>
                        ) : (
                          <span className="mono nowrap" title={t.ref}>
                            {t.ref}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="small minw-220 inline-block">{t.details}</span>
                      </td>
                      <td className="r">
                        <span className={cx('num', t.amount < 0 && 'sb-neg')}>{signedMoney(t.amount)}</span>
                      </td>
                      <td className="r col-pin">
                        <span className="num small">{money(t.balanceAfter)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Card>

          <Card
            flush
            titleAs="h3"
            title="Payouts"
            sub="Pending → Processing → Paid, or Failed with the reason"
            foot={<span className="xs muted grow">Processing means the bank transfer has been sent and is not yet confirmed. A failed payout stays in your balance until it is paid to a verified account.</span>}
          >
            <TableWrap label="Payouts table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Payout</th>
                    <th scope="col">Requested</th>
                    <th scope="col">Arrived</th>
                    <th className="r" scope="col">
                      Amount
                    </th>
                    <th scope="col">Status</th>
                    <th className="col-pin" scope="col">
                      Result
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {PAYOUTS.map((p) => {
                    const failed = p.status === 'Failed';
                    return (
                      <tr key={p.ref} className={cx(failed && 'is-flagged')}>
                        <td>
                          {failed && <span className="sr-only">Urgent: </span>}
                          {p.statement ? (
                            <Link className="mono nowrap" to={href('seller/statement')} title={p.ref}>
                              {p.ref}
                            </Link>
                          ) : (
                            <span className="mono nowrap" title={p.ref}>
                              {p.ref}
                            </span>
                          )}
                        </td>
                        <td>
                          <span className="small nowrap">{p.requested}</span>
                        </td>
                        <td>
                          <span className="small nowrap">{p.arrived}</span>
                        </td>
                        <td className="r">
                          <span className="num strong">{money(p.amount)}</span>
                        </td>
                        <td>
                          <StatusBadge status={p.status} />
                        </td>
                        <td className="col-pin">
                          <span className="xs sub minw-200 inline-block">{p.result}</span>
                        </td>
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
            </p>
          </Card>
        </div>

        <div className="stack gap-5">
          <Card
            titleAs="h3"
            title="Next payout"
            sub="Weekly, every Monday (example schedule)"
            foot={
              <Button variant="secondary" size="sm" icon="landmark" onClick={openDialog} disabled={!!change}>
                {change ? 'Account change in review' : 'Change payout account'}
              </Button>
            }
          >
            <div className="row between base">
              <span className="h2 num">{money(PAYOUTS[0].amount)}</span>
              <StatusBadge status={PAYOUTS[0].status} />
            </div>
            <KeyValue
              pairs={[
                ['Date', 'Mon, Oct 12, 2026'],
                ['Cutoff', 'Sun, Oct 11, 11:59 PM PT'],
                [
                  'Destination',
                  <>
                    Pacific Coast Credit Union •••• 6620{' '}
                    <Badge tone="info" icon="shield-check">
                      Verified
                    </Badge>
                  </>,
                ],
                ['Arrives', 'Usually 1 business day after sending'],
                ...(change ? ([['Requested change', `${change.bank} •••• ${change.last4} · in review`]] as Array<[string, string]>) : []),
              ]}
            />
            <span className="xs muted">Estimate. Earnings that become available before the cutoff are added. New holds or refunds reduce it.</span>
          </Card>
          {change ? (
            <Alert tone="success" title="Payout account change submitted">
              We sent a test deposit to {change.bank} •••• {change.last4}. Marketly Finance reviews the change (example: up to 2 business days). Payouts continue to the current account until the review is done, and you get an email about every change.
            </Alert>
          ) : (
            <Alert tone="info" title="Changing the payout account">
              Only the store owner can change it. We verify the new account with a test deposit and Marketly Finance reviews the change (example: up to 2 business days). Payouts continue to the current account until the review is done, and you get an email about every change.
            </Alert>
          )}
          <Card titleAs="h3" title="When your balance goes negative" sub="Example from Sep 30">
            <p className="small sub">A refund approved after a payout can't come out of money already sent. It is deducted from your next earnings instead.</p>
            <div className="sb-recon">
              <SummaryRow k="Available on Sep 30, 9:00 AM" v="$120.00" />
              <SummaryRow
                k={
                  <>
                    Refund after payout <span className="mono">RT-260924-0533</span>
                  </>
                }
                v={<span className="sb-neg">−$165.60</span>}
              />
              <SummaryRow
                className="total"
                k="Balance"
                v={
                  <span className="row gap-2">
                    <b className="sb-neg">−$45.60</b>
                    <StatusBadge status="Negative" />
                  </span>
                }
              />
            </div>
            <p className="xs muted">
              $184.00 refunded to the customer, less the $18.40 fee returned to you. Covered by sales on Oct 1 and shown on statement Sep 28 – Oct 4. If a negative balance isn't covered within 30 days, it becomes an amount you owe (example terms; see the seller agreement).
            </p>
          </Card>
        </div>
      </div>

      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="Change payout account"
        foot={
          <>
            <Button variant="ghost" onClick={() => setDialog(false)}>
              Cancel
            </Button>
            <Button onClick={submit}>Submit for review</Button>
          </>
        }
      >
        {Object.keys(errors).length > 0 && <Alert tone="danger" title="Check the highlighted fields">The new account can't be submitted until every field is valid.</Alert>}
        <p className="small sub">Payouts continue to Pacific Coast Credit Union •••• 6620 until the new account is verified and reviewed.</p>
        <Field label="Account holder" hint="Must match the business name on your seller account." error={errors.holder}>
          <TextInput id="po-holder" value={form.holder} error={!!errors.holder} onChange={(e) => set('holder', e.target.value)} />
        </Field>
        <Field label="Bank">
          <Select id="po-bank" options={BANKS} value={form.bank} onChange={(e) => set('bank', e.target.value)} />
        </Field>
        <div className="grid md2 gap-3">
          <Field label="Routing number" error={errors.routing}>
            <TextInput id="po-routing" inputMode="numeric" value={form.routing} error={!!errors.routing} onChange={(e) => set('routing', e.target.value)} />
          </Field>
          <Field label="Account number" error={errors.account}>
            <TextInput id="po-account" inputMode="numeric" value={form.account} error={!!errors.account} onChange={(e) => set('account', e.target.value)} />
          </Field>
        </div>
        <Field label="Confirm account number" error={errors.confirm}>
          <TextInput id="po-confirm" inputMode="numeric" value={form.confirm} error={!!errors.confirm} onChange={(e) => set('confirm', e.target.value)} />
        </Field>
        <span className="xs muted">We verify the account with a test deposit. You get an email about every change.</span>
      </Dialog>
    </SellerLayout>
  );
}
