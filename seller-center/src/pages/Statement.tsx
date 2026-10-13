import { useMutation, useQuery } from '@tanstack/react-query';
import type { CSSProperties, ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { SellerLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, announce, Button, Card, EmptyState, KeyValue, PageHeader, StatusBadge, SummaryRow, TableWrap } from '@marketly/web-shared/ui';
import { useSellerSession } from '@/app/session';
import { amt, download, findStatementId, fmtDay, fmtPeriod, fmtTime, PAYOUT_STATUS, refHref, signed, type Statement as StatementData, type StatementLine } from './data/finance';

// Design: pages/seller/seller-statement.html (no views). Route /finance/statements/:ref takes the
// statement ref (ST-…) or the payout ref (PO-…) it settles; REST reads statements by id, so the ref is
// looked up in GET finance/statements (or finance/payouts) first, then GET finance/statements/{id} gives
// the sections, their totals and the reconciliation to the payout. Download: GET …/{id}/download
// (PDF or CSV, issued statements only). The SellerStatement screen query fails on the running server
// (Money.formatted, BACKEND-REQUESTS G13).

type Section = StatementData['sections'][number];

const COLS: Record<string, [string, string, string]> = {
  refunds: ['Date', 'Return', 'Details'],
  holds: ['Date', 'Order', 'Reason'],
  adjustments: ['Date', 'Reference', 'Adjustment and reason'],
  ads: ['Period', 'Campaign', 'Details'],
};

function Amount({ m, className }: { m?: { amount: number; currency: string } | null; className?: string }) {
  return <span className={cx('num', className, (m?.amount ?? 0) < 0 && 'sb-neg')}>{signed(m)}</span>;
}

function RefLink({ line }: { line: StatementLine }) {
  const r = line.reference;
  if (!r?.ref) return null;
  const to = refHref(r);
  return to ? (
    <Link className="mono nowrap" to={to} title={r.ref}>
      {r.ref}
    </Link>
  ) : (
    <span className="mono nowrap" title={r.ref}>
      {r.ref}
    </span>
  );
}

const lineSub = (l: StatementLine) => [l.detail, l.reason].filter(Boolean).join(' · ');

function NoLines({ cols, title }: { cols: number; title: string }) {
  return (
    <tr>
      <td colSpan={cols}>
        <span className="small muted">No {title.toLowerCase()} in this period.</span>
      </td>
    </tr>
  );
}

/** Card for a statement section: header total on the right, four-column table, total row. */
function LineSection({ s, cols }: { s: Section; cols: [string, string, string] }) {
  return (
    <Card flush titleAs="h3" title={s.title} sub={s.subtitle ?? undefined} actions={<span className={cx('num strong', s.total.amount < 0 && 'sb-neg')}>{signed(s.total)}</span>}>
      <TableWrap label={`${s.title} table`}>
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
            {s.lines.length === 0 && <NoLines cols={4} title={s.title} />}
            {s.lines.map((l, i) => {
              const sub = lineSub(l);
              return (
                <tr key={i}>
                  <td>{l.date && <span className="small nowrap">{fmtDay(l.date, {})}</span>}</td>
                  <td>
                    <RefLink line={l} />
                  </td>
                  <td>
                    <span className="small">{l.description}</span>
                    {sub && (
                      <>
                        <br />
                        <span className="xs muted">{sub}</span>
                      </>
                    )}
                  </td>
                  <td className="r">
                    <Amount m={l.amount} />
                  </td>
                </tr>
              );
            })}
            <tr className="sb-total">
              <td>
                <span>{s.totalLabel}</span>
              </td>
              <td />
              <td />
              <td className="r">
                <Amount m={s.total} />
              </td>
            </tr>
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}

const Frame = ({ children }: { children: ReactNode }) => <SellerLayout active="finance">{children}</SellerLayout>;

export default function Statement() {
  const { api } = useApi();
  const { sellerId, can } = useSellerSession();
  const { ref = '' } = useParams();
  const canView = can('finance.balances.view');

  const statement = useQuery({
    queryKey: ['finance', 'statement', sellerId, ref],
    queryFn: async () => {
      const id = await findStatementId(api, ref);
      if (!id) return null;
      return call(api.GET('/api/seller/finance/statements/{id}', { params: { path: { id } } }));
    },
    enabled: canView && !!ref,
  });

  const dl = useMutation({
    mutationFn: async ({ id, format }: { id: string; format: 'pdf' | 'csv' }) => {
      const r = await call(api.GET('/api/seller/finance/statements/{id}/download', { params: { path: { id }, query: { format } } }));
      download(r.url);
      return format;
    },
    onSuccess: (format) => announce(`Downloading statement ${ref} as ${format.toUpperCase()}`),
  });

  const crumbs = (last?: string) => [{ label: 'Finance', to: href('seller/finance') }, { label: 'Statements' }, ...(last ? [{ label: last }] : [])];

  if (!canView) {
    return (
      <Frame>
        <PageHeader crumbs={crumbs()} title="Statement" />
        <Alert tone="info" title="Statements are visible to the store owner">
          Ask the store owner for access to balances, payouts and statements.
        </Alert>
      </Frame>
    );
  }

  if (statement.isError) {
    return (
      <Frame>
        <PageHeader crumbs={crumbs(ref)} title="Statement" />
        <Alert tone="danger" title="We couldn’t load this statement">
          {errorMessage(statement.error)}{' '}
          <Button variant="ghost" size="sm" onClick={() => void statement.refetch()}>
            Try again
          </Button>
        </Alert>
      </Frame>
    );
  }

  if (statement.data === null) {
    return (
      <Frame>
        <PageHeader crumbs={crumbs(ref)} title="Statement" />
        <EmptyState
          icon="file-text"
          title="Statement not found"
          as="h2"
          action={
            <Button variant="secondary" size="sm" to={href('seller/finance')}>
              Back to Finance
            </Button>
          }
        >
          There is no statement {ref} for this store.
        </EmptyState>
      </Frame>
    );
  }

  const s = statement.data;
  if (!s) {
    return (
      <Frame>
        <PageHeader crumbs={crumbs()} title="Statement" sub={<span className="sk sk-line short" />} />
        <div className="sb-main">
          <div className="stack gap-5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card pad stack gap-2">
                <span className="sk sk-line short" />
                <span className="sk sk-line" />
                <span className="sk sk-line" />
              </div>
            ))}
          </div>
          <div className="stack gap-5">
            <div className="card pad stack gap-2">
              <span className="sk sk-line short" />
              <span className="sk sk-line" />
              <span className="sk sk-line" />
            </div>
          </div>
        </div>
      </Frame>
    );
  }

  const period = fmtPeriod(s.period);
  const issued = s.status === 'issued';
  const payout = s.payout;
  const sales = s.sections.find((x) => x.key === 'sales');
  const fees = s.sections.find((x) => x.key === 'fees');
  const others = s.sections.filter((x) => x.key !== 'sales' && x.key !== 'fees');
  const r = s.reconciliation;

  return (
    <Frame>
      <PageHeader
        crumbs={crumbs(period)}
        title={`Statement: ${fmtPeriod(s.period, true)}`}
        sub={
          <>
            {s.sellerName} · seller ID {s.sellerCode}
            {payout && (
              <>
                {' '}
                · payout <span className="mono">{payout.ref}</span>
              </>
            )}{' '}
            · {issued ? `issued ${fmtDay(s.issuedAt, { year: true })}` : 'open: issued at the payout cutoff'}
          </>
        }
        actions={
          <>
            <Button variant="secondary" size="sm" icon="file-down" onClick={() => dl.mutate({ id: s.id, format: 'pdf' })} disabled={!issued || dl.isPending} title={issued ? undefined : 'Available once the statement is issued'}>
              Download PDF
            </Button>
            <Button variant="secondary" size="sm" icon="sheet" onClick={() => dl.mutate({ id: s.id, format: 'csv' })} disabled={!issued || dl.isPending} title={issued ? undefined : 'Available once the statement is issued'}>
              Download CSV
            </Button>
          </>
        }
      />
      {dl.isError && (
        <Alert tone="danger" title="The download didn’t start">
          {errorMessage(dl.error)}
        </Alert>
      )}
      {!issued && (
        <Alert tone="info" title="This statement is still open">
          Lines are added until the payout cutoff, when the statement is issued and can be downloaded.
        </Alert>
      )}
      <div className="sb-main">
        <div className="stack gap-5">
          {sales && (
            <Card flush title={sales.title} sub={sales.subtitle ?? undefined} actions={<span className="num strong">{signed(sales.total)}</span>}>
              <TableWrap label="Sales table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Product</th>
                      <th scope="col">Order</th>
                      <th className="r" scope="col">
                        Units
                      </th>
                      <th className="r" scope="col">
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sales.lines.length === 0 && <NoLines cols={4} title="sales" />}
                    {sales.lines.map((l, i) => {
                      const sub = lineSub(l);
                      return (
                        <tr key={i}>
                          <td>
                            <span className={l.amount.amount > 0 && l.units !== 0 ? 'small strong' : 'small'}>{l.description}</span>
                            {sub && (
                              <>
                                <br />
                                <span className="xs muted">{sub}</span>
                              </>
                            )}
                          </td>
                          <td>
                            <RefLink line={l} />
                          </td>
                          <td className="r">{l.units != null && <span className="num">{l.units}</span>}</td>
                          <td className="r">
                            <Amount m={l.amount} />
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="sb-total">
                      <td>
                        <span>{sales.totalLabel}</span>
                      </td>
                      <td />
                      <td className="r" />
                      <td className="r">
                        <Amount m={sales.total} />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </TableWrap>
            </Card>
          )}

          {fees && (
            <Card flush titleAs="h3" title={fees.title} sub={fees.subtitle ?? undefined} actions={<span className={cx('num strong', fees.total.amount < 0 && 'sb-neg')}>{signed(fees.total)}</span>}>
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
                    {fees.lines.length === 0 && <NoLines cols={3} title="fees" />}
                    {fees.lines.map((l, i) => (
                      <tr key={i}>
                        <td>
                          <span className="small strong">{l.description}</span>
                          {l.reference?.ref && (
                            <>
                              <br />
                              <RefLink line={l} />
                            </>
                          )}
                        </td>
                        <td>
                          {l.basis && <span className="small num">{formatMoney(l.basis)}</span>}
                          {lineSub(l) && (
                            <>
                              {l.basis && <br />}
                              <span className="xs muted">{lineSub(l)}</span>
                            </>
                          )}
                        </td>
                        <td className="r">
                          <Amount m={l.amount} />
                        </td>
                      </tr>
                    ))}
                    <tr className="sb-total">
                      <td>
                        <span>{fees.totalLabel}</span>
                      </td>
                      <td />
                      <td className="r">
                        <Amount m={fees.total} />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </TableWrap>
              <div className="panel" style={{ margin: 'var(--sp-3) var(--sp-4) var(--sp-4)' } as CSSProperties}>
                <span className="xs sub">
                  <b>How the fee basis works:</b> {s.feeBasisNote} Fees are refunded in proportion when an item is refunded. Final rates are in your seller agreement.
                </span>
              </div>
            </Card>
          )}

          {others.map((x) => (
            <LineSection key={x.key} s={x} cols={COLS[x.key] ?? ['Date', 'Reference', 'Details']} />
          ))}
        </div>

        <div className="stack gap-5">
          <Card titleAs="h3" title="Reconciliation" sub="Every line on this page adds up to the payout">
            <div className="sb-recon">
              <SummaryRow k={`Opening available balance, ${fmtDay(s.period.from, { weekday: false, year: false })}`} v={formatMoney(r.openingAvailable)} />
              {r.lines.map((l) => (
                <SummaryRow key={l.label} k={l.label} v={signed(l.amount)} />
              ))}
              <SummaryRow className="total" k={payout ? `Payout ${payout.ref}` : 'Payout'} v={formatMoney(r.payout)} />
              <SummaryRow k={`Closing available balance, ${fmtDay(s.period.to, { weekday: false, year: false })}`} v={amt(r.closingAvailable) < 0 ? <span className="sb-neg">{signed(r.closingAvailable, false)}</span> : formatMoney(r.closingAvailable)} />
            </div>
          </Card>
          <Card titleAs="h3" title="Payout" sub={payout ? <span className="mono">{payout.ref}</span> : undefined}>
            {payout ? (
              <>
                <div className="row between base">
                  <span className="h2 num">{formatMoney(payout.amount)}</span>
                  <StatusBadge status={PAYOUT_STATUS[payout.status]} />
                </div>
                <KeyValue
                  pairs={[
                    ['Sent', payout.releasedAt ? `${fmtTime(payout.releasedAt, { weekday: true })} PT` : '—'],
                    ['Arrived', payout.arrivedOn ? fmtDay(payout.arrivedOn, { weekday: true }) : '—'],
                    ['Destination', payout.destination.label],
                    ...(payout.bankReference ? ([['Bank reference', <span className="mono">{payout.bankReference}</span>]] as Array<[string, ReactNode]>) : []),
                    ...(payout.status === 'failed' && payout.failureReason ? ([['Result', `${payout.failureReason}${payout.failureCode ? ` (${payout.failureCode})` : ''}`]] as Array<[string, string]>) : []),
                  ]}
                />
              </>
            ) : (
              <span className="small sub">{issued ? 'No payout for this period: the available balance was below the minimum or nothing was due.' : 'The payout is set when the statement is issued at the cutoff.'}</span>
            )}
          </Card>
          {s.afterPayoutNotices.map((n, i) => (
            <Alert key={i} tone="warning" title="Includes a refund after payout">
              {n}
            </Alert>
          ))}
          <p className="xs muted">
            Fee rules {s.ruleVersion}. Final fees and settlement terms are in the seller agreement. Questions about a line?{' '}
            <Button variant="link" to={href('seller/help', 'contact-seller-support')}>
              Contact seller support
            </Button>
          </p>
        </div>
      </div>
    </Frame>
  );
}
