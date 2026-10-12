import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { StoreLayout } from '@/layouts';
import { href } from '@marketly/web-shared/routes';
import { Badge, Button, Icon, KeyValue, Sponsored, TableWrap, type IconName } from '@marketly/web-shared/ui';

// Design: pages/store/info-about.html

const CHECKS: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'file-check', title: 'Application review', body: 'We review the business, its products and where it ships from before approving it.' },
  { icon: 'user-round-check', title: 'Identity and bank checks', body: 'We confirm who owns the business and that payouts go to a verified US bank account.' },
  { icon: 'gauge', title: 'Ongoing performance', body: 'We track on-time dispatch, cancellations, replies and unresolved cases.' },
  { icon: 'shield-alert', title: 'Restrictions when needed', body: 'Sellers who miss our standards can be restricted. Your existing orders are still looked after.' },
];

const LABELS: Array<{ label: ReactNode; key: string; means: string; not: string }> = [
  {
    key: 'official',
    label: (
      <Badge tone="brand" icon="badge-check">
        Official Store
      </Badge>
    ),
    means: 'Sold and shipped by Marketly. We own the stock and handle service.',
    not: "It isn't a ranking. Other sellers may offer a better price.",
  },
  {
    key: 'verified',
    label: (
      <Badge tone="info" icon="shield-check">
        Verified seller
      </Badge>
    ),
    means: 'We checked the business registration, owner identity, payout account and return address.',
    not: "We don't inspect every product a seller sends.",
  },
  { key: 'sponsored', label: <Sponsored />, means: "A seller or brand paid for this position. It's always labelled.", not: "It isn't a recommendation from us, and it doesn't change the price." },
];

const ph = (v: string) => (
  <>
    {v} <span className="xs muted">(placeholder)</span>
  </>
);

export default function About() {
  return (
    <StoreLayout appbar={{ title: 'About us', back: href('store/home') }}>
      <div className="container page">
        <section className="stack gap-3" style={{ maxWidth: 760 }}>
          <span className="eyebrow">About Marketly</span>
          <h1 className="display d-xl">One store for our own products and approved independent sellers</h1>
          <p className="lead">You can buy from us and from sellers we've checked, in one cart and one checkout. Every item tells you who sells it, when it arrives and how returns work.</p>
        </section>
        <div className="grid md2">
          <div className="card pad stack gap-3">
            <Badge tone="brand" icon="badge-check">
              Official Store
            </Badge>
            <h2 className="h3">Products we sell ourselves</h2>
            <p className="small sub">We buy the stock, set the price, pack it in our Reno, NV warehouse and handle returns. Free returns on every Official Store item.</p>
            <Link className="small strong" to={href('store/official')}>
              Visit the Official Store
            </Link>
          </div>
          <div className="card pad stack gap-3">
            <Badge tone="info" icon="shield-check">
              Verified seller
            </Badge>
            <h2 className="h3">Products from approved sellers</h2>
            <p className="small sub">Independent businesses list their offers on our catalog and ship their own orders. They follow our seller rules, and we step in when something goes wrong.</p>
            <Link className="small strong" to={href('info/policy', 'seller-rules')}>
              Read the seller rules
            </Link>
          </div>
        </div>
        <section className="stack gap-4">
          <h2 className="h2">How we check sellers</h2>
          <div className="grid md2 lg4">
            {CHECKS.map((c) => (
              <div key={c.title} className="buy-feature card pad">
                <Icon name={c.icon} />
                <div className="stack gap-1">
                  <span className="small strong">{c.title}</span>
                  <span className="xs muted">{c.body}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="stack gap-4">
          <h2 className="h2">What the labels mean</h2>
          <TableWrap label="What the labels mean table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Label</th>
                  <th scope="col">What it means</th>
                  <th scope="col">What it doesn't mean</th>
                </tr>
              </thead>
              <tbody>
                {LABELS.map((l) => (
                  <tr key={l.key}>
                    <td>{l.label}</td>
                    <td>{l.means}</td>
                    <td>{l.not}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </section>
        <div className="split">
          <section className="card pad stack gap-3">
            <h2 className="h3">Company facts</h2>
            <KeyValue
              pairs={[
                ['Company', ph('Marketly, Inc.')],
                ['Founded', ph('2026')],
                ['Headquarters', ph('Portland, Oregon')],
                ['Warehouse', 'Reno, Nevada'],
                ['Service region', 'United States, prices in USD'],
                ['Approved sellers', ph('120+')],
              ]}
            />
          </section>
          <section className="card pad stack gap-3">
            <h2 className="h3">Contact us</h2>
            <KeyValue
              pairs={[
                ['Customer support', '1-800-555-0136'],
                ['Hours', 'Mon–Sat, 8 AM–8 PM PT'],
                ['Email', 'help@marketly.example'],
                ['Mail', '1000 SW Broadway, Suite 1200, Portland, OR 97205'],
                ['Sellers', 'sellers@marketly.example'],
                ['Press', 'press@marketly.example'],
              ]}
            />
            <Button variant="secondary" to={href('help/contact')}>
              Contact support
            </Button>
          </section>
        </div>
      </div>
    </StoreLayout>
  );
}
