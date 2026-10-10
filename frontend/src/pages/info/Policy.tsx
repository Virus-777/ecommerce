import { useState } from 'react';
import { Link } from 'react-router';
import { StoreLayout } from '@/layouts';
import { cx } from '@/lib/cx';
import { useView } from '@/lib/hooks';
import { href } from '@/routes/href';
import { Alert, Breadcrumbs, Button, Dialog, Field, Icon, Select } from '@/ui';
import { POLICIES, type PolicySlug } from './data/policies';

// Design: pages/store/info-policy.html (Returns) · views shipping, seller-rules, privacy, purchase-terms.
// The side nav (desktop) and the policy picker (phone/tablet) switch ?view.

export default function Policy() {
  const [view, setView] = useView<Exclude<PolicySlug, ''>>();
  const policy = POLICIES.find((p) => p.slug === view) ?? POLICIES[0];
  const [versionsOpen, setVersionsOpen] = useState(false);

  return (
    <StoreLayout appbar={{ title: policy.short, back: href('help/center') }}>
      <div className="container page">
        <Breadcrumbs items={[{ label: 'Home', to: href('store/home') }, { label: 'Policies', to: href('info/policy') }, { label: policy.short }]} />
        <div className="buy-policy">
          <aside className="only-desktop stack gap-3">
            <span className="eyebrow">Policies</span>
            <nav className="side-nav" aria-label="Policies">
              {POLICIES.map((p) => (
                <Link key={p.slug} to={href('info/policy', p.slug)} className={cx(p.slug === policy.slug && 'is-active')} aria-current={p.slug === policy.slug ? 'page' : undefined}>
                  <Icon name={p.icon} />
                  <span>{p.nav}</span>
                </Link>
              ))}
            </nav>
            <div className="panel xs muted">
              Questions about a policy?{' '}
              <Link to={href('help/contact')} className="link-inline">
                Contact us
              </Link>
            </div>
          </aside>
          <article className="stack gap-5">
            <div className="no-desktop">
              <Field label="Policy">
                <Select id="pol-pick" options={POLICIES.map((p) => ({ value: p.slug, label: p.short }))} value={policy.slug} onChange={(e) => setView(e.target.value as PolicySlug)} />
              </Field>
            </div>
            <div className="stack gap-3">
              <h1 className="h1">{policy.title}</h1>
              <div className="buy-meta-strip">
                <span>
                  <Icon name="calendar-check" />
                  Effective {policy.effective}
                </span>
                <span>
                  <Icon name="file-text" />
                  Version {policy.version}
                </span>
                <span>
                  <Icon name="history" />
                  <a href="#" className="link-inline" onClick={(e) => (e.preventDefault(), setVersionsOpen(true))}>
                    Previous versions
                  </a>{' '}
                  (latest before this: {policy.prevVersion}, {policy.prevDate})
                </span>
              </div>
              <Alert tone="info" title="Orders keep the terms accepted at purchase">
                If you ordered before {policy.effective}, the version shown in your order details applies to that order.
              </Alert>
            </div>
            {policy.body}
            <p className="xs muted">Marketly, Inc. · Policy owner: Content and Legal · Published {policy.effective}</p>
          </article>
        </div>
      </div>

      <Dialog open={versionsOpen} onClose={() => setVersionsOpen(false)} title={`${policy.title}: versions`} foot={<Button variant="secondary" onClick={() => setVersionsOpen(false)}>Close</Button>}>
        <ul className="list">
          <li className="row between">
            <span className="small strong">Version {policy.version}</span>
            <span className="xs muted">Effective {policy.effective} · current</span>
          </li>
          <li className="row between">
            <span className="small">Version {policy.prevVersion.replace(/^v/, '')}</span>
            <span className="xs muted">Effective {policy.prevDate}</span>
          </li>
        </ul>
        <span className="xs muted">Each order keeps the version that was in effect when it was placed. Find it in your order details.</span>
      </Dialog>
    </StoreLayout>
  );
}
