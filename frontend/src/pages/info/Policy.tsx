import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError, call, useApi } from '@marketly/web-shared/api';
import { StoreLayout } from '@/layouts';
import { cx } from '@marketly/web-shared/lib/cx';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Alert, Breadcrumbs, Button, Dialog, EmptyState, Field, Icon, Select } from '@marketly/web-shared/ui';
import { dateLong } from '../help/data/format';
import { LoadError, Loading, SkLines } from '../help/data/states';
import { PolicyBody, policyIcon, policyShort, VIEW_KEYS, type PolicySlug } from './data/policies';

// Design: pages/store/info-policy.html (Returns) · views shipping, seller-rules, privacy, purchase-terms.
// Data: GET /api/store/content/policies (nav), GET /api/store/content/policies/{key} (current version: body,
// effective date, version, previous/upcoming version, orders note, owner), GET …/policies/{key}/versions
// (previous versions dialog), GET /api/store/content/policy-versions/{id} (?version=<id>: an older version).
// The ?view slugs map to policy keys; other published policies open with ?key=<key>.

export default function Policy() {
  const { api } = useApi();
  const navigate = useNavigate();
  const [view] = useView<Exclude<PolicySlug, ''>>();
  const [params, setParams] = useSearchParams();
  const key = params.get('key') ?? VIEW_KEYS.find((v) => v.slug === view)?.key ?? 'returns';
  const versionId = params.get('version');
  const [versionsOpen, setVersionsOpen] = useState(false);

  const list = useQuery({ queryKey: ['content', 'policies'], queryFn: () => call(api.GET('/api/store/content/policies')), staleTime: 300_000 });
  const current = useQuery({
    queryKey: ['content', 'policy', key],
    queryFn: () => call(api.GET('/api/store/content/policies/{key}', { params: { path: { key } } })),
  });
  const older = useQuery({
    queryKey: ['content', 'policy-version', versionId],
    queryFn: () => call(api.GET('/api/store/content/policy-versions/{id}', { params: { path: { id: versionId! } } })),
    enabled: Boolean(versionId),
  });
  const versions = useQuery({
    queryKey: ['content', 'policy-versions', key],
    queryFn: () => call(api.GET('/api/store/content/policies/{key}/versions', { params: { path: { key } } })),
  });
  const config = useQuery({ queryKey: ['settings', 'app-config'], queryFn: () => call(api.GET('/api/public/settings/app-config')), staleTime: 300_000 });

  const p = versionId ? older.data : current.data;
  const loading = versionId ? older.isPending : current.isPending;
  const error = versionId ? older.error : current.error;
  const notFound = error instanceof ApiError && error.status === 404;

  // Nav: the design's five policies first (when published), then any other published policy.
  const published = list.data ?? [];
  const nav = [
    ...VIEW_KEYS.filter((v) => published.some((x) => x.key === v.key)).map((v) => {
      const x = published.find((y) => y.key === v.key)!;
      return { key: v.key, to: href('info/policy', v.slug), kind: x.kind, title: x.title };
    }),
    ...published.filter((x) => !VIEW_KEYS.some((v) => v.key === x.key)).map((x) => ({ key: x.key, to: href('info/policy', '', undefined, { key: x.key }), kind: x.kind, title: x.title })),
  ];
  const summary = published.find((x) => x.key === key);
  const title = p?.title ?? summary?.title ?? '';
  const short = policyShort(key, title || 'Policy');
  const prev = versions.data?.filter((v) => v.versionId !== summary?.current?.versionId) ?? [];
  const latestBefore = p?.previousVersion ?? prev[0];
  const legal = config.data?.market.legalName ?? 'Marketly, Inc.';
  const showVersion = (id: string | null) => {
    setVersionsOpen(false);
    setParams(
      (sp) => {
        const n = new URLSearchParams(sp);
        if (id) n.set('version', id);
        else n.delete('version');
        return n;
      },
      { preventScrollReset: true },
    );
  };

  return (
    <StoreLayout appbar={{ title: short, back: href('help/center') }}>
      <div className="container page">
        <Breadcrumbs items={[{ label: 'Home', to: href('store/home') }, { label: 'Policies', to: href('info/policy') }, { label: short }]} />
        <div className="buy-policy">
          <aside className="only-desktop stack gap-3">
            <span className="eyebrow">Policies</span>
            <nav className="side-nav" aria-label="Policies">
              {list.isPending ? (
                <SkLines n={5} />
              ) : (
                nav.map((n) => (
                  <Link key={n.key} to={n.to} className={cx(n.key === key && 'is-active')} aria-current={n.key === key ? 'page' : undefined}>
                    <Icon name={policyIcon(n.kind)} />
                    <span>{n.title}</span>
                  </Link>
                ))
              )}
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
                <Select id="pol-pick" options={nav.length ? nav.map((n) => ({ value: n.to, label: policyShort(n.key, n.title) })) : [{ value: '', label: short }]} value={nav.find((n) => n.key === key)?.to ?? ''} onChange={(e) => navigate(e.target.value)} />
              </Field>
            </div>
            {notFound ? (
              <EmptyState icon="file-text" title="This policy isn’t published" as="h1" action={<Button to={href('info/policy')}>See the returns policy</Button>}>
                It may have been renamed. Pick a policy from the list.
              </EmptyState>
            ) : error ? (
              <LoadError error={error} retry={() => void (versionId ? older.refetch() : current.refetch())} title="We couldn’t load this policy" />
            ) : loading || !p ? (
              <>
                <Loading label="Loading the policy" />
                <span className="sk sk-line h-30" aria-hidden="true" />
                <SkLines n={10} />
              </>
            ) : (
              <>
                <div className="stack gap-3">
                  <h1 className="h1">{p.title}</h1>
                  <div className="buy-meta-strip">
                    <span>
                      <Icon name="calendar-check" />
                      Effective {dateLong(p.effectiveAt)}
                    </span>
                    <span>
                      <Icon name="file-text" />
                      Version {p.version}
                    </span>
                    {(prev.length > 0 || versionId) && (
                      <span>
                        <Icon name="history" />
                        <a href="#" className="link-inline" onClick={(e) => (e.preventDefault(), setVersionsOpen(true))}>
                          Previous versions
                        </a>
                        {latestBefore && !versionId && (
                          <>
                            {' '}
                            (latest before this: v{latestBefore.version}, {dateLong(latestBefore.effectiveAt)})
                          </>
                        )}
                      </span>
                    )}
                  </div>
                  {versionId ? (
                    <Alert tone="warning" title={`You’re reading version ${p.version}, an earlier version`}>
                      <a href="#" className="link-inline" onClick={(e) => (e.preventDefault(), showVersion(null))}>
                        Read the current version
                      </a>
                    </Alert>
                  ) : (
                    <Alert tone="info" title="Orders keep the terms accepted at purchase">
                      {p.ordersNote}
                    </Alert>
                  )}
                  {!versionId && p.upcoming && (
                    <Alert tone="info" title={`A new version takes effect ${dateLong(p.upcoming.effectiveAt)}`}>
                      {p.upcomingSummary ?? `Version ${p.upcoming.version} replaces this one on that date.`}
                    </Alert>
                  )}
                </div>
                <PolicyBody title={p.title} body={p.body} tables={p.tables} />
                <p className="xs muted">
                  {legal} · Policy owner: {p.owner} · Published {dateLong(p.effectiveAt)}
                </p>
              </>
            )}
          </article>
        </div>
      </div>

      <Dialog open={versionsOpen} onClose={() => setVersionsOpen(false)} title={`${title}: versions`} foot={<Button variant="secondary" onClick={() => setVersionsOpen(false)}>Close</Button>}>
        <ul className="list">
          {(versions.data ?? []).map((v) => {
            const isCurrent = v.versionId === summary?.current?.versionId;
            const reading = versionId ? v.versionId === versionId : isCurrent;
            return (
              <li key={v.versionId} className="row between">
                {reading ? (
                  <span className="small strong">Version {v.version}</span>
                ) : (
                  <a href="#" className="small link-inline" onClick={(e) => (e.preventDefault(), showVersion(isCurrent ? null : v.versionId))}>
                    Version {v.version}
                  </a>
                )}
                <span className="xs muted">
                  Effective {dateLong(v.effectiveAt)}
                  {isCurrent ? ' · current' : ''}
                </span>
              </li>
            );
          })}
        </ul>
        <span className="xs muted">Each order keeps the version that was in effect when it was placed. Find it in your order details.</span>
      </Dialog>
    </StoreLayout>
  );
}
