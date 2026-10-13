import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { call, useApi } from '@marketly/web-shared/api';
import { StoreLayout } from '@/layouts';
import { money } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Badge, Button, Field, Icon, Select, SummaryRow, TableWrap, TextInput, Timeline, type IconName, type TimelineEvent } from '@marketly/web-shared/ui';
import { humanize } from '../help/data/format';
import { iconFor, LoadError, SkLines } from '../help/data/states';
import { useSellerProgram } from './data/program';

// Design: pages/store/sell-landing.html · the "How a sale works out" card is a live fee calculator
// (client-side, from the example rates).
// Data: GET /api/store/sellers/program (categories, not allowed, requirements, example fees and notes, payout
// timing, fulfilment models, service targets, FAQ, contact, estimated minutes, applicationsOpen);
// GET /api/public/finance/fee-schedule (default commission rate for the calculator).
// Static marketing copy (no API source): the hero headline and lead, the "How to join" steps (the API's
// `steps` are the application form steps, used on sell/apply) and the payout timeline's step wording.

const EXAMPLE = 'example';

const REQ_ICON: Array<[RegExp, IconName]> = [
  [/bank/i, 'landmark'],
  [/address/i, 'map-pin'],
  [/tax|w-9/i, 'file-check'],
  [/identity|owner|\bid\b/i, 'user-round-check'],
  [/business|proprietor/i, 'building-2'],
  [/ship|track/i, 'truck'],
  [/answer|message|repl/i, 'message-square'],
];
const reqIcon = (t: string): IconName => REQ_ICON.find(([re]) => re.test(t))?.[1] ?? 'circle-check';

const METRIC: Record<string, string> = {
  dispatch_reliability: 'Dispatch on time',
  valid_tracking: 'Tracking',
  response_time: 'Customer messages',
  cancellation_rate: 'Seller cancellations',
  return_rate: 'Return rate',
  unresolved_cases: 'Unresolved cases',
  policy_violations: 'Policy violations',
};

const STEPS: Array<[string, string]> = [
  ['Create your seller account', 'Contact, business and store details.'],
  ['Verify your business', 'Identity, tax details, payout account and return address.'],
  ['Accept the agreement', 'Seller agreement, product rules, fee schedule and service standards.'],
  ['We review your application', 'We may ask for more information.'],
  ['Set up your store', 'Shipping coverage, store profile and your first products or offers.'],
  ['Go live', 'We check launch readiness. Only approved products and offers are published.'],
];

export default function Landing() {
  const { api } = useApi();
  const program = useSellerProgram();
  const fees = useQuery({ queryKey: ['finance', 'fee-schedule'], queryFn: () => call(api.GET('/api/public/finance/fee-schedule')), staleTime: 300_000 });
  const [price, setPrice] = useState('100.00');
  const [cat, setCat] = useState(EXAMPLE);

  const p = program.data;
  const examples = p?.feeExamples ?? [];
  const defaultRate = fees.data?.current ? fees.data.current.defaultRateBps / 100 : (examples[0]?.ratePct ?? 10);
  const rate = cat === EXAMPLE ? defaultRate : (examples.find((f) => f.categoryName === cat)?.ratePct ?? defaultRate);
  const amount = Number(price.replace(/[$,]/g, ''));
  const valid = price.trim() !== '' && Number.isFinite(amount) && amount >= 0;
  const commission = valid ? Math.round(amount * rate) / 100 : 0;
  const rates = examples.map((f) => f.ratePct);
  const rateRange = rates.length ? (Math.min(...rates) === Math.max(...rates) ? `${rates[0]}%` : `${Math.min(...rates)}–${Math.max(...rates)}%`) : '';
  const noMonthlyFee = p?.feeNotes.some((n) => /no monthly fee/i.test(n));
  const anyExample = examples.some((f) => f.isExample);
  const pt = p?.payoutTiming;
  const payout: TimelineEvent[] = pt
    ? [
        { t: 'Customer receives the order', state: 'done', body: 'Earnings show as Pending in Seller Center.' },
        { t: `${pt.holdDaysAfterDelivery}-day hold after delivery`, state: 'done', body: 'Covers early returns and delivery problems.' },
        { t: 'Earnings become Available', state: 'done' },
        { t: `${pt.schedule} payout`, state: 'current', body: `Sent to your verified bank account; arrives ${pt.arrival.replace(/^./, (c) => c.toLowerCase())}.` },
      ]
    : [];

  return (
    <StoreLayout appbar={{ title: 'Sell on Marketly', back: href('store/home') }}>
      <div className="container page gap-8">
        <section className="buy-sell-hero">
          <div className="stack gap-4">
            <span className="eyebrow u-c-text-inverse u-o-_7">Sell on Marketly</span>
            <h1 className="display d-xl">Reach shoppers in one store, next to our own products</h1>
            <p className="h-sub">List your offers on our shared catalog, ship your own orders and get paid {pt ? pt.schedule.toLowerCase() : 'regularly'}. We review every seller so customers trust who they buy from.</p>
            <div className="row gap-2">
              <Button size="lg" iconRight="arrow-right" to={href('sell/apply')}>
                Start your application
              </Button>
              <a
                className="btn btn-lg btn-ghost u-c-text-inverse"
                href="#sell-fees"
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById('sell-fees')?.scrollIntoView({ behavior: 'smooth' });
                }}
              >
                <span>See fees</span>
              </a>
            </div>
            <span className="xs u-o-_7">
              {p && !p.applicationsOpen ? 'Applications are by invitation during our controlled launch: have your invitation code ready. ' : ''}
              {p ? `Takes about ${p.estimatedMinutes} minutes. ` : ''}Save a draft anytime. Already applied?{' '}
              <Link to={href('sell/status')} className="link-inline u-c-text-inverse">
                Check your status
              </Link>
            </span>
          </div>
          <div className="buy-sell-stats">
            <div>
              <span className="xs u-o-_75">Launch categories</span>
              <b>{p ? p.launchCategories.length : '–'}</b>
            </div>
            <div>
              <span className="xs u-o-_75">{anyExample ? 'Example commission' : 'Commission'}</span>
              <b>{rateRange || '–'}</b>
            </div>
            <div>
              <span className="xs u-o-_75">{pt?.isExample ? 'Example payouts' : 'Payouts'}</span>
              <b>{pt?.schedule ?? '–'}</b>
            </div>
            {noMonthlyFee && (
              <div>
                <span className="xs u-o-_75">Monthly fee at launch</span>
                <b>$0</b>
              </div>
            )}
          </div>
        </section>
        {program.isError && <LoadError error={program.error} retry={() => void program.refetch()} title="We couldn’t load the seller programme" />}
        <div className="grid lg2 gap-6">
          <section className="stack gap-3">
            <h2 className="h2">What you can sell</h2>
            {!p ? (
              <SkLines n={4} />
            ) : (
              <>
                <div className="grid m2 gap-2">
                  {p.launchCategories.map((c) => (
                    <div key={c.id} className="row gap-2 nowrap panel">
                      <Icon name={iconFor(c.icon, 'package')} className="ic-sm" />
                      <span className="small grow">{c.name}</span>
                      {c.needsExtraApproval && <Badge tone="warning">Extra approval</Badge>}
                    </div>
                  ))}
                </div>
                {p.notAllowed.length > 0 && <p className="xs muted">Physical goods in these categories. Not at launch: {p.notAllowed.join(', ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}.</p>}
              </>
            )}
          </section>
          <section className="stack gap-3">
            <h2 className="h2">Seller requirements</h2>
            {!p ? (
              <SkLines n={5} />
            ) : (
              <ul className="stack gap-3">
                {p.requirements.map((r) => (
                  <li key={r.title} className="buy-feature">
                    <Icon name={reqIcon(r.title)} />
                    <span className="stack gap-0">
                      <span className="small strong">{r.title}</span>
                      <span className="xs muted">{r.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <section className="stack gap-4" id="sell-fees">
          <h2 className="h2">Fees</h2>
          <div className="split">
            <div className="card">
              <TableWrap label="Fees table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Category</th>
                      <th className="r" scope="col">
                        Commission{anyExample ? ' (example)' : ''}
                      </th>
                      <th scope="col">Charged on</th>
                    </tr>
                  </thead>
                  <tbody>
                    {examples.map((f) => (
                      <tr key={f.categoryName}>
                        <td>{f.categoryName}</td>
                        <td className="r">
                          <span className="strong">{f.ratePct}%</span>
                        </td>
                        <td>{f.basis}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              {!p && <SkLines n={4} className="stack gap-2 pad" />}
            </div>
            <div className="card pad stack gap-3">
              <span className="small strong">How a sale works out</span>
              <div className="grid m2 gap-2">
                <Field label="Item price" error={valid ? undefined : 'Enter a price, like 100.00.'}>
                  <TextInput id="fee-price" prefix="$" inputMode="decimal" ctl="sm" value={price} error={!valid} onChange={(e) => setPrice(e.target.value)} />
                </Field>
                <Field label="Category">
                  <Select
                    id="fee-cat"
                    ctl="sm"
                    options={[{ value: EXAMPLE, label: `${anyExample ? 'Example' : 'Standard'} (${defaultRate}%)` }, ...examples.map((f) => ({ value: f.categoryName, label: `${f.categoryName} (${f.ratePct}%)` }))]}
                    value={cat}
                    onChange={(e) => setCat(e.target.value)}
                  />
                </Field>
              </div>
              <div className="buy-sum" aria-live="polite">
                <SummaryRow k="Item sold" v={money(valid ? amount : 0)} />
                <SummaryRow k={`Commission at ${rate}%${cat === EXAMPLE && anyExample ? ' (example)' : ''}`} v={`−${money(commission)}`} />
                <SummaryRow className="total" k="Your earnings" v={money(valid ? amount - commission : 0)} />
              </div>
              {fees.data?.current?.treatment?.text && <span className="xs muted">{fees.data.current.treatment.text}</span>}
            </div>
          </div>
          {p && p.feeNotes.length > 0 && <p className="xs muted">{p.feeNotes.join(' ')}</p>}
        </section>
        <div className="grid lg2 gap-6">
          <section className="card pad stack gap-3">
            <h2 className="h3">When you get paid</h2>
            {pt ? <Timeline events={payout} /> : <SkLines n={4} />}
            {pt?.isExample && <p className="xs muted">Example schedule. Final payout timing is in the seller agreement. Holds always show a reason and review date.</p>}
          </section>
          <section className="card pad stack gap-3">
            <h2 className="h3">Who ships</h2>
            {!p ? (
              <SkLines n={3} />
            ) : (
              p.fulfillmentModels.map((m) => (
                <div key={m.name} className="buy-feature">
                  <Icon name={m.availability === 'launch' ? 'package' : 'warehouse'} />
                  <span className="stack gap-1">
                    <span className="row gap-2">
                      <span className="small strong">{m.name}</span>
                      {m.availability === 'launch' ? <Badge tone="success">At launch</Badge> : <Badge>{humanize(m.availability)}</Badge>}
                    </span>
                    <span className="xs muted">{m.detail}</span>
                  </span>
                </div>
              ))
            )}
          </section>
        </div>
        <section className="stack gap-4">
          <h2 className="h2">Service expectations</h2>
          <div className="card">
            <TableWrap label="Service expectations table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Measure</th>
                    <th scope="col">Target</th>
                  </tr>
                </thead>
                <tbody>
                  {(p?.serviceTargets ?? []).map((t) => (
                    <tr key={t.metric}>
                      <td>{METRIC[t.metric] ?? humanize(t.metric)}</td>
                      <td>
                        {t.display} · over {t.windowDays} days
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            {!p && <SkLines n={4} className="stack gap-2 pad" />}
          </div>
          {p?.serviceTargets.some((t) => t.isExample) && <p className="xs muted">Example targets. Final targets are in the service standards. You see your results in Seller Center under Account health.</p>}
        </section>
        <section className="stack gap-4">
          <h2 className="h2">How to join</h2>
          <ol className="buy-steps-list grid md2 lg3">
            {STEPS.map(([t, d]) => (
              <li key={t}>
                <span className="stack gap-1">
                  <span className="small strong">{t}</span>
                  <span className="xs muted">{d}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
        <section className="split">
          <div className="stack gap-3">
            <h2 className="h2">Questions sellers ask</h2>
            <div className="card pad buy-faq">
              {!p ? (
                <SkLines n={4} />
              ) : (
                p.faq.map((f, i) => (
                  <details key={f.q} open={i === 0}>
                    <summary>
                      {f.q}
                      <Icon name="chevron-down" className="ic-sm" />
                    </summary>
                    <p>{f.a}</p>
                  </details>
                ))
              )}
            </div>
          </div>
          <aside className="card pad stack gap-3" style={{ alignSelf: 'start' }}>
            <h2 className="h3">Ready to apply?</h2>
            <p className="small sub">Have your business registration, tax ID, bank details and return address ready{p && !p.applicationsOpen ? ', and your invitation code' : ''}.</p>
            <Button block to={href('sell/apply')}>
              Start your application
            </Button>
            {p?.contact && (
              <span className="xs muted">
                Questions first? Email {p.contact.email}
                {p.contact.phone ? ` or call ${p.contact.phone}` : ''}
                {p.contact.hours ? `, ${p.contact.hours}` : ''}.
              </span>
            )}
          </aside>
        </section>
      </div>
    </StoreLayout>
  );
}
