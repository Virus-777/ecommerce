import { useState } from 'react';
import { Link } from 'react-router';
import { AdminLayout } from '@marketly/web-shared/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { money } from '@marketly/web-shared/lib/format';
import { href } from '@marketly/web-shared/routes';
import { Alert, Badge, Button, Dialog, EmptyState, Field, Icon, LogoTile, Meter, Pager, SearchInput, Select, Stat, StatusBadge, TableWrap, Tabs, TextInput, announce } from '@marketly/web-shared/ui';
import type { Tint } from '@marketly/web-shared/data/fixtures';

// Design: pages/admin/admin-sellers.html (single view). Status tabs link to "#" in the design;
// here they filter the list, in sync with the Status filter.

type Status = 'Approved' | 'Applied' | 'Information required' | 'Under review' | 'Restricted' | 'Suspended' | 'Closed';

interface SellerRow {
  slug: string;
  name: string;
  initials: string;
  tint: Tint;
  city: string;
  status: Status;
  verified: boolean;
  rating?: string;
  onTime?: number;
  cases: number;
  balance: number;
  held?: number;
  category: string;
  restriction?: string;
  /** Restriction text styled as a warning (performance notices). */
  restrictionWarn?: boolean;
  /** Applications open the application review instead of the seller page. */
  application?: boolean;
}

const ROWS: SellerRow[] = [
  { slug: 'northwind-audio', name: 'Northwind Audio', initials: 'NA', tint: '2', city: 'Portland, OR', status: 'Approved', verified: true, rating: '98% · 4,812', onTime: 97.8, cases: 1, balance: 4862.1, category: 'Electronics' },
  { slug: 'pixel-and-port', name: 'Pixel & Port', initials: 'PP', tint: '6', city: 'Austin, TX', status: 'Approved', verified: true, rating: '96% · 2,391', onTime: 95.1, cases: 2, balance: 3118.44, category: 'Computers' },
  { slug: 'casa-verde-home', name: 'Casa Verde Home', initials: 'CV', tint: '1', city: 'Sacramento, CA', status: 'Approved', verified: true, rating: '97% · 1,730', onTime: 88.4, cases: 3, balance: 2240.9, category: 'Home & Kitchen', restriction: 'Performance warning sent Oct 2', restrictionWarn: true },
  { slug: 'trailhead-outfitters', name: 'Trailhead Outfitters', initials: 'TO', tint: '5', city: 'Boulder, CO', status: 'Approved', verified: true, rating: '95% · 980', onTime: 96.2, cases: 0, balance: 1906.3, category: 'Sports & Outdoors' },
  { slug: 'harbor-and-pine', name: 'Harbor & Pine', initials: 'HP', tint: '1', city: 'Portland, ME', status: 'Approved', verified: true, rating: '99% · 611', onTime: 99.1, cases: 0, balance: 812, category: 'Home & Kitchen' },
  { slug: 'gadget-grove', name: 'Gadget Grove', initials: 'GG', tint: '3', city: 'Phoenix, AZ', status: 'Restricted', verified: false, rating: '89% · 412', onTime: 81.5, cases: 4, balance: 1372.15, held: 640, category: 'Electronics', restriction: 'Refurbished offers and new listings paused' },
  { slug: 'bolt-street-supply', name: 'Bolt Street Supply', initials: 'BS', tint: '4', city: 'Newark, NJ', status: 'Suspended', verified: false, rating: '71% · 208', onTime: 64.0, cases: 2, balance: -212.4, category: 'Computers', restriction: 'All new sales stopped · appeal closed Sep 29' },
  { slug: 'lumen-cycle-co', name: 'Lumen Cycle Co.', initials: 'LC', tint: '5', city: 'Bend, OR', status: 'Under review', verified: false, cases: 0, balance: 0, category: 'Sports & Outdoors', restriction: 'Application · decision due Oct 9', application: true },
  { slug: 'fernhill-tea-co', name: 'Fernhill Tea Co.', initials: 'FT', tint: '3', city: 'Seattle, WA', status: 'Information required', verified: false, cases: 0, balance: 0, category: 'Home & Kitchen', restriction: 'Waiting on tax form · due Oct 15', application: true },
  { slug: 'old-mill-goods', name: 'Old Mill Goods', initials: 'OM', tint: '2', city: 'Lancaster, PA', status: 'Closed', verified: false, rating: '94% · 120', cases: 0, balance: 0, category: 'Home & Kitchen', restriction: 'Closed by seller Aug 31' },
];

/** Account totals across all 48 sellers (the sample rows are one page of them). */
const TAB_COUNTS: Array<{ status: '' | Status; label: string; count: number }> = [
  { status: '', label: 'All', count: 48 },
  { status: 'Approved', label: 'Approved', count: 38 },
  { status: 'Applied', label: 'Applied', count: 4 },
  { status: 'Information required', label: 'Information required', count: 1 },
  { status: 'Under review', label: 'Under review', count: 2 },
  { status: 'Restricted', label: 'Restricted', count: 1 },
  { status: 'Suspended', label: 'Suspended', count: 1 },
  { status: 'Closed', label: 'Closed', count: 1 },
];

const STATUS_OPTS = ['Any status', 'Applied', 'Information required', 'Under review', 'Approved', 'Restricted', 'Suspended', 'Closed'];
const VER_OPTS = ['Any', 'Verified seller', 'Not verified'];
const PERF_OPTS = ['Any', 'Below 95% target', 'Below 90%'];
const CAT_OPTS = ['Any category', 'Electronics', 'Computers', 'Home & Kitchen', 'Sports & Outdoors'];
const BAL_OPTS = ['Any balance', 'Has held amounts', 'Negative balance'];

const TARGET = 95;
const signedMoney = (n: number) => (n < 0 ? `−${money(-n)}` : money(n));
const rowEdge = (r: SellerRow) => (r.status === 'Suspended' ? 'flagged' : r.onTime !== undefined && r.onTime < TARGET ? 'warn' : '');
const sellerTo = (r: SellerRow) => (r.application ? href('admin/seller-application') : href('admin/seller', '', { slug: r.slug }));

export default function Sellers() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | Status>('');
  const [ver, setVer] = useState(VER_OPTS[0]);
  const [perf, setPerf] = useState(PERF_OPTS[0]);
  const [cat, setCat] = useState(CAT_OPTS[0]);
  const [bal, setBal] = useState(BAL_OPTS[0]);
  const [page, setPage] = useState(1);
  const [invite, setInvite] = useState(false);
  const [email, setEmail] = useState('');
  const [inviteTried, setInviteTried] = useState(false);
  const [invited, setInvited] = useState('');

  const term = q.trim().toLowerCase();
  const rows = ROWS.filter(
    (r) =>
      (!term || `${r.name} ${r.city} ${r.slug}`.toLowerCase().includes(term)) &&
      (!status || r.status === status) &&
      (ver === VER_OPTS[0] || r.verified === (ver === 'Verified seller')) &&
      (perf === PERF_OPTS[0] || (r.onTime !== undefined && r.onTime < (perf === 'Below 90%' ? 90 : TARGET))) &&
      (cat === CAT_OPTS[0] || r.category === cat) &&
      (bal === BAL_OPTS[0] || (bal === 'Negative balance' ? r.balance < 0 : !!r.held)),
  );
  const filtered = !!(term || status || ver !== VER_OPTS[0] || perf !== PERF_OPTS[0] || cat !== CAT_OPTS[0] || bal !== BAL_OPTS[0]);
  const clear = () => {
    setQ('');
    setStatus('');
    setVer(VER_OPTS[0]);
    setPerf(PERF_OPTS[0]);
    setCat(CAT_OPTS[0]);
    setBal(BAL_OPTS[0]);
  };

  const emailError = inviteTried && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? 'Enter an email address, like owner@store.com.' : undefined;
  const sendInvite = () => {
    setInviteTried(true);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return;
    setInvited(email.trim());
    setInvite(false);
    setEmail('');
    setInviteTried(false);
    announce(`Invitation sent to ${email.trim()}`);
  };

  const legend = (
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
  );
  const empty = (
    <EmptyState icon="search-x" title="No sellers match" action={<Button variant="secondary" size="sm" onClick={clear}>Clear filters</Button>}>
      Try another name or remove a filter.
    </EmptyState>
  );

  return (
    <AdminLayout active="sellers">
      <div className="page-head">
        <div className="t">
          <nav className="crumbs" aria-label="Breadcrumb">
            <span>Sellers</span>
          </nav>
          <h1 className="h1">Sellers</h1>
          <p className="sub small">48 seller accounts · owner Grace Kim, Seller Manager · Official Store is managed under Official store</p>
        </div>
        <div className="actions">
          <Button variant="secondary" size="sm" icon="download" onClick={() => announce(`Exporting ${rows.length} sellers`)}>
            Export
          </Button>
          <Button variant="secondary" size="sm" icon="file-check" to={href('admin/seller-application')}>
            Applications · 7
          </Button>
          <Button size="sm" icon="send" onClick={() => setInvite(true)}>
            Invite seller
          </Button>
        </div>
      </div>

      {invited && (
        <Alert tone="success" title="Invitation sent">
          {invited} can now start a seller application. The link expires in 14 days.
        </Alert>
      )}

      <div className="aa-kpis">
        <div className="card pad">
          <Stat label="Selling now" value="38" note="5 added this month" />
        </div>
        <div className="card pad">
          <Stat label="Below dispatch target" value={<span className="t-warning-text">3</span>} note="Target 95% on time" />
        </div>
        <div className="card pad">
          <Stat label="Restricted or suspended" value="2" note="1 appeal under review" />
        </div>
        <div className="card pad">
          <Stat label="Seller balances" value="$84,210.66" note="$2,140.00 held · 1 negative" />
        </div>
      </div>

      <section className="card">
        <Tabs<'' | Status> items={TAB_COUNTS.map((t) => ({ label: t.label, value: t.status, count: t.count }))} active={status} onChange={setStatus} label="Seller status" />
        <div className="card-body">
          <div className="toolbar">
            <SearchInput id="aa-sl-q" placeholder="Search seller name, legal name or contact email" value={q} onChange={setQ} />
          </div>
          <div className="aa-filters c5">
            <Field label="Status" className="aa-flt">
              <Select id="aa-sl-st" options={STATUS_OPTS} value={status || STATUS_OPTS[0]} onChange={(e) => setStatus(e.target.value === STATUS_OPTS[0] ? '' : (e.target.value as Status))} />
            </Field>
            <Field label="Verification" className="aa-flt">
              <Select id="aa-sl-ver" options={VER_OPTS} value={ver} onChange={(e) => setVer(e.target.value)} />
            </Field>
            <Field label="On-time dispatch" className="aa-flt">
              <Select id="aa-sl-perf" options={PERF_OPTS} value={perf} onChange={(e) => setPerf(e.target.value)} />
            </Field>
            <Field label="Main category" className="aa-flt">
              <Select id="aa-sl-cat" options={CAT_OPTS} value={cat} onChange={(e) => setCat(e.target.value)} />
            </Field>
            <Field label="Balance" className="aa-flt">
              <Select id="aa-sl-bal" options={BAL_OPTS} value={bal} onChange={(e) => setBal(e.target.value)} />
            </Field>
          </div>
        </div>

        <div className="no-phone">
          {rows.length ? (
            <>
              <TableWrap label="Sellers table">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Seller</th>
                      <th scope="col">Status</th>
                      <th scope="col">Verified</th>
                      <th scope="col">Rating</th>
                      <th scope="col">On-time dispatch</th>
                      <th className="r" scope="col">Open cases</th>
                      <th className="r" scope="col">Balance</th>
                      <th scope="col">Restrictions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const edge = rowEdge(r);
                      const below = r.onTime !== undefined && r.onTime < TARGET;
                      return (
                        <tr key={r.slug} className={cx(edge && `is-${edge}`)}>
                          <td>
                            {edge && <span className="sr-only">{edge === 'flagged' ? 'Urgent: ' : 'At risk: '}</span>}
                            <Link className="row nowrap gap-2 link-inherit" to={sellerTo(r)}>
                              <LogoTile initials={r.initials} tint={r.tint} size="sm" />
                              <span className="stack gap-0">
                                <span className="small strong">{r.name}</span>
                                <span className="xs muted">{r.city}</span>
                              </span>
                            </Link>
                          </td>
                          <td>
                            <StatusBadge status={r.status} />
                          </td>
                          <td>
                            {r.verified ? (
                              <Badge tone="info" icon="shield-check">
                                Verified
                              </Badge>
                            ) : (
                              <span className="xs muted">Not verified</span>
                            )}
                          </td>
                          <td>{r.rating ? <span className="small num">{r.rating}</span> : <span className="muted">—</span>}</td>
                          <td>
                            {r.onTime !== undefined && r.status !== 'Closed' ? (
                              <span className="stack gap-1 minw-90">
                                <span className={cx('strong num', below && 't-danger-text')}>{r.onTime.toFixed(1)}%</span>
                                <Meter pct={r.onTime} tone={below ? 'danger' : 'success'} label={`On-time dispatch: ${r.name}`} />
                                {below && <span className="xs strong meter-note t-danger-text">Below target</span>}
                              </span>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td className="r">{r.cases ? <span className={cx('strong', r.cases >= 3 && 't-warning-text')}>{r.cases}</span> : 0}</td>
                          <td className="r">
                            <span className="stack gap-0">
                              <span className={cx('strong', r.balance < 0 && 't-danger-text')}>{signedMoney(r.balance)}</span>
                              {r.held ? <span className="xs t-warning-text strong">{money(r.held)} held</span> : null}
                              {r.balance < 0 && <Badge tone="danger">Negative</Badge>}
                            </span>
                          </td>
                          <td>
                            {!r.restriction ? (
                              <span className="xs muted">None</span>
                            ) : r.restrictionWarn ? (
                              <span className="xs t-warning-text strong">{r.restriction}</span>
                            ) : (
                              <span className="small u-maxw-28ch u-d-inline-block">{r.restriction}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
              {legend}
            </>
          ) : (
            empty
          )}
        </div>

        <div className="only-phone card-pad-phone">
          {rows.length ? (
            <>
              <div className="aa-mlist">
                {rows.map((r) => {
                  const edge = rowEdge(r);
                  return (
                    <Link key={r.slug} className={cx('aa-mcard', edge && `is-${edge}`)} to={sellerTo(r)}>
                      {edge && <span className="sr-only">{edge === 'flagged' ? 'Urgent: ' : 'At risk: '}</span>}
                      <span className="row nowrap gap-3">
                        <LogoTile initials={r.initials} tint={r.tint} size="sm" />
                        <span className="stack gap-0 grow">
                          <span className="small strong">{r.name}</span>
                          <span className="xs muted">{r.city}</span>
                        </span>
                        <StatusBadge status={r.status} />
                      </span>
                      <span className="row gap-3 xs">
                        <span>
                          On time <b>{r.onTime !== undefined && r.status !== 'Closed' ? `${r.onTime.toFixed(1)}%` : '—'}</b>
                        </span>
                        <span>
                          Cases <b>{r.cases}</b>
                        </span>
                        <span>
                          Balance <b>{signedMoney(r.balance)}</b>
                        </span>
                        {r.verified && (
                          <Badge tone="info" icon="shield-check">
                            Verified
                          </Badge>
                        )}
                      </span>
                      {r.restriction && !r.restrictionWarn && <span className="xs sub">{r.restriction}</span>}
                    </Link>
                  );
                })}
              </div>
              {legend}
            </>
          ) : (
            empty
          )}
        </div>

        <div className="card-foot between">
          <span className="xs muted">Balance is what we owe the seller after fees and refunds. It is not paid until a payout is sent.</span>
          <Pager page={page} total={filtered ? 1 : 5} onPage={setPage} end={filtered} />
        </div>
      </section>

      <Dialog
        open={invite}
        onClose={() => setInvite(false)}
        title="Invite seller"
        size="sm"
        foot={
          <>
            <Button variant="ghost" onClick={() => setInvite(false)}>
              Cancel
            </Button>
            <Button icon="send" onClick={sendInvite}>
              Send invitation
            </Button>
          </>
        }
      >
        <p className="small sub">The seller gets a link to start an application. They still go through verification and review.</p>
        <Field label="Contact email" error={emailError}>
          <TextInput id="aa-sl-invite" type="email" icon="mail" value={email} error={!!emailError} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <span className="xs muted">
          <Icon name="info" className="ic-sm" /> Invitations expire after 14 days.
        </span>
      </Dialog>
    </AdminLayout>
  );
}
