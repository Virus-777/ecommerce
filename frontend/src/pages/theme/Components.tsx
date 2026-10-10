import { useEffect, useRef, useState } from 'react';
import { products } from '@/data/fixtures';
import { cx } from '@/lib/cx';
import { money } from '@/lib/format';
import { href } from '@/routes/href';
import {
  Alert, Badge, Breadcrumbs, Button, Checkbox, Chip, Deadline, Dialog, Drawer, EmptyState, Field, Icon, Legend, LineChart,
  OptionCard, ProductCard, QuantityStepper, Radio, SegmentedControl, Select, Sponsored, Stat, StatusBadge, StatusLegend, Steps,
  Switch, TableWrap, Tabs, Textarea, TextInput, Timeline, Track,
} from '@/ui';
import { DEMO_ORDERS, SALES_CHART, STATUS_ROWS } from './data/components';

// Design: pages/theme/theme-components.html (design-system reference page, no store chrome).
// Demos render the real src/ui components, so this page documents the library as built.

const CONDITIONS = ['New', 'Used – Like new', 'Used – Good', 'Refurbished'];
const COLOURS: Array<{ name: string; unavailable?: boolean }> = [{ name: 'Midnight black' }, { name: 'Stone' }, { name: 'Sage' }, { name: 'Coral', unavailable: true }];
const SHIP_OPTIONS = [
  { id: 'c-s1', title: 'Standard · Thu, Oct 15', price: 'Free', body: 'UPS Ground. Ships today from Reno, NV.' },
  { id: 'c-s2', title: 'Express · Tue, Oct 13', price: '$12.99', body: 'UPS 2nd Day Air.' },
];
const ORDER_TABS = [
  { value: 'new', label: 'New', count: 4 },
  { value: 'preparing', label: 'Preparing', count: 2 },
  { value: 'shipped', label: 'Shipped', count: 18 },
  { value: 'completed', label: 'Completed' },
];
const FILTER_CHIPS = ['Brand: Halden', 'Under $200', 'Free delivery', 'Official Store', '4★ & up'];
const CARD_PRODUCTS = ['aurora', 'kestrel27', 'duvet', 'serum'].map((id) => products.find((p) => p.id === id)!);
const k = (v: number) => `$${Math.round(v / 1000)}k`;

function emailError(v: string) {
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v.trim())) return undefined;
  return v.includes('@') ? 'Check the domain. Did you mean example.com?' : 'Enter an email address like name@example.com.';
}

export default function Components() {
  // Form controls
  const [name, setName] = useState('Jordan Lee');
  const [email, setEmail] = useState('jordan.lee@exmple');
  const [price, setPrice] = useState('189.00');
  const [cond, setCond] = useState('New');
  const [search, setSearch] = useState('');
  const [note, setNote] = useState('');
  const [updates, setUpdates] = useState(true);
  const [deals, setDeals] = useState(false);
  const [shipTo, setShipTo] = useState<'home' | 'work'>('home');
  const [priceAlerts, setPriceAlerts] = useState(true);
  const [ship, setShip] = useState('c-s1');
  const [colour, setColour] = useState('Midnight black');
  // Navigation
  const [tab, setTab] = useState('new');
  const [layout, setLayout] = useState<'list' | 'grid'>('list');
  const [range, setRange] = useState<'today' | '7d' | '30d'>('7d');
  const [chips, setChips] = useState<string[]>(['Brand: Halden', 'Under $200']);
  const [page, setPage] = useState(1);
  // Table
  const [selected, setSelected] = useState<string[]>([]);
  // Overlays
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(false);

  const emailErr = emailError(email);
  const toggleChip = (c: string) => setChips((l) => (l.includes(c) ? l.filter((x) => x !== c) : [...l, c]));
  const allSelected = selected.length === DEMO_ORDERS.length;
  const someSelected = selected.length > 0 && !allSelected;
  const selectAll = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = someSelected;
  }, [someSelected]);
  const toggleRow = (ref: string) => setSelected((l) => (l.includes(ref) ? l.filter((x) => x !== ref) : [...l, ref]));

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="container th-page">
        <header className="stack gap-3" id="main" tabIndex={-1}>
          <span className="eyebrow">Marketly design system · v0.1</span>
          <h1 className="display d-xl">Components</h1>
          <p className="lead mw-70ch">Buttons, form controls, status, cards, overlays and data display. Every helper maps 1:1 to a React component.</p>
        </header>

        {/* Buttons */}
        <section className="th-sec">
          <header>
            <h2 className="h2">Buttons</h2>
            <p className="small sub measure-lg">One primary action per view. Minimum 44 px tall for touch. Deal buttons only inside promotions.</p>
          </header>
          <div className="th-row">
            <Button icon="shopping-cart">Add to cart</Button>
            <Button variant="secondary">Buy now</Button>
            <Button variant="soft">Save for later</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="danger-soft" icon="trash-2">
              Remove
            </Button>
            <Button variant="danger">Suspend seller</Button>
            <Button variant="deal" icon="zap">
              Claim deal
            </Button>
            <Button variant="link" iconRight="arrow-right">
              View order
            </Button>
          </div>
          <div className="th-row">
            <Button size="lg">Large</Button>
            <Button>Default</Button>
            <Button size="sm">Small</Button>
            <Button variant="secondary" icon="heart" label="Save" />
            <Button disabled>Disabled</Button>
          </div>
        </section>

        {/* Form controls */}
        <section className="th-sec">
          <header>
            <h2 className="h2">Form controls</h2>
            <p className="small sub measure-lg">Labels sit above fields. Hints explain, errors say what to fix. Every field has an id.</p>
          </header>
          <div className="grid md2 lg3 gap-5">
            <Field label="Full name">
              <TextInput id="c-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Email" error={emailErr}>
              <TextInput id="c-email" value={email} error={!!emailErr} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Price" hint="Before shipping. Fees are taken from this amount.">
              <TextInput id="c-price" prefix="$" value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} />
            </Field>
            <Field label="Condition">
              <Select id="c-cond" options={CONDITIONS} value={cond} onChange={(e) => setCond(e.target.value)} />
            </Field>
            <Field label="Search">
              <TextInput id="c-search" icon="search" placeholder="Order number or product" value={search} onChange={(e) => setSearch(e.target.value)} />
            </Field>
            <Field label="Note to seller" optional>
              <Textarea id="c-note" placeholder="Leave at the side door, please." value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          <div className="th-row">
            <Checkbox id="c-c1" label="Email me order updates" checked={updates} onChange={(e) => setUpdates(e.target.checked)} />
            <Checkbox id="c-c2" label="Send me deals and promotions" checked={deals} onChange={(e) => setDeals(e.target.checked)} />
            <Radio id="c-r1" name="c-r" label="Ship to home" checked={shipTo === 'home'} onChange={() => setShipTo('home')} />
            <Radio id="c-r2" name="c-r" label="Ship to work" checked={shipTo === 'work'} onChange={() => setShipTo('work')} />
            <Switch id="c-t1" label="Price drop alerts" checked={priceAlerts} onChange={(e) => setPriceAlerts(e.target.checked)} />
            <QuantityStepper defaultValue={2} />
          </div>
          <div className="grid md2 gap-3">
            {SHIP_OPTIONS.map((o) => (
              <OptionCard
                key={o.id}
                id={o.id}
                name="c-ship"
                checked={ship === o.id}
                onChange={() => setShip(o.id)}
                title={
                  <span className="row between">
                    <span className="strong">{o.title}</span>
                    <span className="strong">{o.price}</span>
                  </span>
                }
                body={o.body}
              />
            ))}
          </div>
          <div className="th-row" role="group" aria-label="Colour">
            {COLOURS.map((c) => (
              <button
                key={c.name}
                type="button"
                className={cx('pill-opt', colour === c.name && 'is-selected', c.unavailable && 'is-unavailable')}
                aria-disabled={c.unavailable || undefined}
                aria-pressed={colour === c.name}
                onClick={() => !c.unavailable && setColour(c.name)}
              >
                {c.name}
              </button>
            ))}
          </div>
        </section>

        {/* Badges and status */}
        <section className="th-sec">
          <header>
            <h2 className="h2">Badges and status</h2>
            <p className="small sub measure-lg">Every status in the plan has one fixed colour. Colour never stands alone: the word is always there.</p>
          </header>
          <div className="stack gap-3">
            <div className="row top gap-3">
              <span className="xs strong muted u-w-190px u-pt-3px">Seller identity</span>
              <span className="row gap-2 grow">
                <Badge tone="brand" icon="badge-check">
                  Official Store
                </Badge>
                <Badge tone="info" icon="shield-check">
                  Verified seller
                </Badge>
                <Sponsored />
                <Badge tone="deal">−17%</Badge>
                {/* t-deal-soft is not in the Badge Tone type yet: plain markup. */}
                <span className="badge t-deal-soft">
                  <Icon name="clock" />
                  Limited time
                </span>
              </span>
            </div>
            {STATUS_ROWS.map((r) => (
              <div key={r.label} className="row top gap-3">
                <span className="xs strong muted u-w-190px u-pt-3px">{r.label}</span>
                <span className="row gap-2 grow">
                  {r.statuses.map((s) => (
                    <StatusBadge key={s} status={s} />
                  ))}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Product card */}
        <section className="th-sec">
          <header>
            <h2 className="h2">Product card</h2>
            <p className="small sub measure-lg">Image, name, rating, price, and a delivery cue. Discounts show the struck price. "From" prices belong to one eligible offer.</p>
          </header>
          <div className="grid-products">
            {CARD_PRODUCTS.map((p) => (
              <ProductCard key={p.id} p={p} from showSeller sponsored={p.id === 'kestrel27'} />
            ))}
          </div>
        </section>

        {/* Alerts, toasts, empty states */}
        <section className="th-sec">
          <header>
            <h2 className="h2">Alerts, toasts, empty states</h2>
          </header>
          <div className="grid md2 gap-3">
            <Alert tone="info" title="Packages may arrive separately">
              This order ships from 3 sellers. Each package has its own tracking.
            </Alert>
            <Alert tone="success" title="Refund sent">
              $36.00 to Visa •••• 4417. Banks usually post it within 5 business days.
            </Alert>
            <Alert tone="warning" title="Price changed">
              Kestrel 1 TB SSD is now $99.99 (was $94.99). Review before you pay.
            </Alert>
            <Alert tone="danger" title="Payment declined">
              Your bank declined the charge. Try another card or contact your bank.
            </Alert>
          </div>
          <div className="row gap-3">
            <span className="toast">
              <Icon name="circle-check" /> Added to cart
            </span>
            <span className="toast">
              <Icon name="undo-2" /> Return request sent
            </span>
          </div>
          <div className="card">
            <EmptyState icon="package-search" title="No orders match these filters" action={<Button variant="secondary">Clear filters</Button>}>
              Try a wider date range or clear the status filter.
            </EmptyState>
          </div>
        </section>

        {/* Overlays (not drawn in the design export; the page lead lists them) */}
        <section className="th-sec">
          <header>
            <h2 className="h2">Dialogs and drawers</h2>
            <p className="small sub measure-lg">Dialogs confirm one decision and become bottom sheets on the phone. Drawers hold filters and detail panels. Esc closes both and focus returns to the button that opened them.</p>
          </header>
          <div className="th-row">
            <Button variant="secondary" icon="message-square" onClick={() => setDialog(true)} aria-haspopup="dialog">
              Open dialog
            </Button>
            <Button variant="secondary" icon="sliders-horizontal" onClick={() => setDrawer(true)} aria-haspopup="dialog">
              Open drawer
            </Button>
          </div>
        </section>

        {/* Navigation */}
        <section className="th-sec">
          <header>
            <h2 className="h2">Navigation</h2>
            <p className="small sub measure-lg">Tabs for views of one list, segmented controls for modes, chips for filters, steppers for linear tasks.</p>
          </header>
          <Tabs items={ORDER_TABS} active={tab} onChange={setTab} />
          <div className="th-row">
            <SegmentedControl
              items={[
                { value: 'list', label: 'List' },
                { value: 'grid', label: 'Grid' },
              ]}
              active={layout}
              onChange={setLayout}
            />
            <SegmentedControl
              items={[
                { value: 'today', label: 'Today' },
                { value: '7d', label: '7 days' },
                { value: '30d', label: '30 days' },
              ]}
              active={range}
              onChange={setRange}
            />
          </div>
          <div className="hscroll gap-2">
            {FILTER_CHIPS.map((c) => (
              <Chip key={c} active={chips.includes(c)} removable={chips.includes(c)} onClick={() => toggleChip(c)}>
                {c}
              </Chip>
            ))}
          </div>
          <Steps items={['Sign in', 'Address', 'Delivery', 'Payment', 'Review']} current={2} />
          <Breadcrumbs items={[{ label: 'Electronics', to: href('store/category') }, { label: 'Headphones', to: href('store/category') }, { label: 'Over-ear' }]} />
          <div className="grid md2 gap-4">
            <div className="card pad stack gap-3">
              <span className="row gap-2">
                <Icon name="monitor" />
                <span className="h4">Website: numbered pages</span>
              </span>
              <p className="xs muted">Tablet and desktop. Customers can jump to a page and keep their place when they come back.</p>
              <DemoPager page={page} total={12} onPage={setPage} />
            </div>
            <div className="card pad stack gap-3">
              <span className="row gap-2">
                <Icon name="smartphone" />
                <span className="h4">Android app: loads as you scroll</span>
              </span>
              <p className="xs muted">Phone. The next batch loads before the user reaches the end. Skeletons hold the space, so nothing jumps. A short note marks the end of the list.</p>
              <div className="lazy-load" role="status" aria-live="polite">
                <div className="sk-grid" aria-hidden="true">
                  {[0, 1].map((i) => (
                    <div className="sk-card" key={i}>
                      <span className="sk sk-img" />
                      <span className="sk sk-line" />
                      <span className="sk sk-line short" />
                    </div>
                  ))}
                </div>
                <span className="lazy-note">
                  <span className="spinner" aria-hidden="true" />
                  Loading more
                </span>
              </div>
              <div className="lazy-load is-end" role="status">
                <Icon name="circle-check" className="ic-sm" />
                <span>You've reached the end</span>
              </div>
            </div>
          </div>
        </section>

        {/* Progress and history */}
        <section className="th-sec">
          <header>
            <h2 className="h2">Progress and history</h2>
            <p className="small sub measure-lg">Order progress uses a segmented track; case and refund history uses a timeline.</p>
          </header>
          <div className="grid md2 gap-6">
            <div className="card pad stack gap-4">
              <Track labels={['Ordered', 'Shipped', 'Out for delivery', 'Delivered']} done={2} />
              <Track labels={['Ordered', 'Preparing', 'Shipped', 'Delivered']} done={2} tone="warning" />
            </div>
            <div className="card pad">
              <Timeline
                events={[
                  { t: 'Refund sent', d: 'Oct 4, 2:10 PM · $36.00 to Visa •••• 4417', state: 'done' },
                  { t: 'Return inspected', d: 'Oct 3 · Condition: as described', state: 'done' },
                  { t: 'Waiting for bank', d: 'Usually 3–5 business days', state: 'current' },
                ]}
              />
            </div>
          </div>
        </section>

        {/* Tables */}
        <section className="th-sec">
          <header>
            <h2 className="h2">Tables</h2>
            <p className="small sub measure-lg">Back-office lists. Numbers are tabular and right-aligned. Rows that miss a promise carry a left severity stripe. Wide tables scroll inside their card.</p>
          </header>
          <div className="card">
            <TableWrap label="Tables table">
              <table className="table">
                <thead>
                  <tr>
                    <th className="col-check">
                      <input ref={selectAll} type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? [] : DEMO_ORDERS.map((o) => o.ref))} />
                    </th>
                    <th scope="col">Order</th>
                    <th scope="col">Customer</th>
                    <th className="r" scope="col">
                      Items
                    </th>
                    <th className="r" scope="col">
                      Total
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col">Dispatch by</th>
                  </tr>
                </thead>
                <tbody>
                  {DEMO_ORDERS.map((o) => (
                    <tr key={o.ref} className={cx(o.flagged && 'is-flagged', selected.includes(o.ref) && 'is-selected') || undefined}>
                      <td className="col-check">
                        {o.flagged && <span className="sr-only">Urgent: </span>}
                        <input type="checkbox" aria-label={`Select ${o.ref}`} checked={selected.includes(o.ref)} onChange={() => toggleRow(o.ref)} />
                      </td>
                      <td>
                        <span className="mono nowrap" title={o.ref}>
                          {o.ref}
                        </span>
                      </td>
                      <td>{o.customer}</td>
                      <td className="r">
                        <span className="num">{o.items}</span>
                      </td>
                      <td className="r">
                        <span className="num">{money(o.total)}</span>
                      </td>
                      <td>
                        <StatusBadge status={o.status} />
                      </td>
                      <td>
                        <Deadline tone={o.deadline.tone}>{o.deadline.text}</Deadline>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <StatusLegend items={[{ tone: 'danger', label: 'Red edge = urgent: overdue or past target' }]} />
          </div>
        </section>

        {/* Statistics and charts */}
        <section className="th-sec">
          <header>
            <h2 className="h2">Statistics and charts</h2>
            <p className="small sub measure-lg">Two-series charts compare the Official Store with marketplace sellers. Hover any point for exact values.</p>
          </header>
          <div className="grid md2 lg4 gap-3">
            <div className="card pad">
              <Stat label="Gross sales" value="$284.6k" delta="8.2%" dir="up" good />
            </div>
            <div className="card pad">
              <Stat label="Orders" value="3,418" delta="5.6%" dir="up" good />
            </div>
            <div className="card pad">
              <Stat label="On-time dispatch" value="96.4%" delta="0.8 pts" dir="down" good={false} />
            </div>
            <div className="card pad">
              <Stat label="Open cases" value="31" />
            </div>
          </div>
          <div className="card pad stack gap-3">
            <Legend items={['Official Store', 'Marketplace sellers']} />
            <LineChart labels={SALES_CHART.labels} series={SALES_CHART.series} fmt={k} />
          </div>
        </section>
      </div>

      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="Cancel this order?"
        foot={
          <>
            <Button variant="ghost" onClick={() => setDialog(false)}>
              Keep order
            </Button>
            <Button variant="danger" onClick={() => setDialog(false)}>
              Cancel order
            </Button>
          </>
        }
      >
        <p className="small sub">Items that haven't shipped are cancelled and refunded to the original payment method within 5 business days.</p>
      </Dialog>

      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        title="Filters"
        foot={
          <>
            <Button variant="ghost" onClick={() => setChips([])}>
              Clear all
            </Button>
            <Button onClick={() => setDrawer(false)}>Show results</Button>
          </>
        }
      >
        <div className="stack gap-2">
          {FILTER_CHIPS.map((c, i) => (
            <Checkbox key={c} id={`c-f${i}`} label={c} checked={chips.includes(c)} onChange={() => toggleChip(c)} />
          ))}
        </div>
      </Drawer>
    </>
  );
}

/**
 * Website pager shown on its own. The shared <Pager> pairs it with the phone lazy-load row and
 * hides it on the phone layout (.no-phone); this reference card shows it at every width.
 */
function DemoPager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const nums: Array<number | '…'> = page <= 3 ? [1, 2, 3, '…', total] : page >= total - 2 ? [1, '…', total - 2, total - 1, total] : [1, '…', page, '…', total];
  const go = (p: number) => onPage(Math.min(total, Math.max(1, p)));
  return (
    <nav className="pager" aria-label="Pagination">
      <a href="#" aria-label="Previous page" onClick={(e) => (e.preventDefault(), go(page - 1))}>
        <Icon name="chevron-left" className="ic-sm" />
      </a>
      {nums.map((n, i) =>
        n === '…' ? (
          <span key={`e${i}`}>…</span>
        ) : (
          <a key={n} className={cx(n === page && 'is-active')} href="#" aria-current={n === page ? 'page' : undefined} onClick={(e) => (e.preventDefault(), go(n))}>
            {n}
          </a>
        ),
      )}
      <a href="#" aria-label="Next page" onClick={(e) => (e.preventDefault(), go(page + 1))}>
        <Icon name="chevron-right" className="ic-sm" />
      </a>
    </nav>
  );
}
