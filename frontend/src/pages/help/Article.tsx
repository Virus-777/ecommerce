import { useMutation, useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { StoreLayout } from '@/layouts';
import { href } from '@marketly/web-shared/routes';
import { Breadcrumbs, Button, EmptyState, Field, Icon, Textarea } from '@marketly/web-shared/ui';
import { dateLong } from './data/format';
import { RichText, DataTable } from './data/html';
import { ApiLink, appHref } from './data/links';
import { LoadError, Loading, SkLines } from './data/states';

// Design: pages/store/help-article.html
// Data: GET /api/store/content/help/articles/{slug} (body is staff-authored HTML, rendered through the
// allowlist renderer in data/html.tsx); "Was this helpful?" → POST /api/store/content/help/articles/{id}/feedback.
// Support hours for the "Still need help?" card: GET /api/public/settings/app-config.

type Feedback = '' | 'yes' | 'no' | 'sent';

export default function Article() {
  const { api } = useApi();
  const { slug = '' } = useParams();
  const [feedback, setFeedback] = useState<Feedback>('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');

  const article = useQuery({
    queryKey: ['content', 'help-article', slug],
    queryFn: () => call(api.GET('/api/store/content/help/articles/{slug}', { params: { path: { slug } } })),
  });
  const config = useQuery({ queryKey: ['settings', 'app-config'], queryFn: () => call(api.GET('/api/public/settings/app-config')), staleTime: 300_000 });
  const send = useMutation({
    mutationFn: (body: { helpful: boolean; comment?: string }) => call(api.POST('/api/store/content/help/articles/{id}/feedback', { params: { path: { id: article.data!.id } }, body })),
  });

  const a = article.data;
  const notFound = article.error instanceof ApiError && article.error.status === 404;

  const vote = (helpful: boolean, text?: string) =>
    send.mutate(text ? { helpful, comment: text } : { helpful }, {
      onSuccess: () => setFeedback(helpful ? 'yes' : 'sent'),
    });
  const sendComment = () => {
    if (!comment.trim()) {
      setError('Tell us what was missing, or close this.');
      return;
    }
    vote(false, comment.trim());
  };

  if (notFound) {
    return (
      <StoreLayout tab="account" appbar={{ title: 'Help article', back: href('help/center') }}>
        <div className="container page">
          <EmptyState icon="file-text" title="We couldn’t find that article" as="h1" action={<Button to={href('help/center')}>Go to the Help Center</Button>}>
            It may have moved or been retired. Search the Help Center for the topic instead.
          </EmptyState>
        </div>
      </StoreLayout>
    );
  }

  const crumbs = a
    ? [...a.breadcrumb.map((c) => ({ label: c.label, to: appHref(c.url) ?? undefined })), { label: a.title }]
    : [{ label: 'Help Center', to: href('help/center') }, { label: '…' }];
  const contactAction = a?.actions.find((x) => appHref(x.url)?.startsWith(href('help/contact')));
  const otherActions = a?.actions.filter((x) => x !== contactAction) ?? [];

  return (
    <StoreLayout tab="account" appbar={{ title: 'Help article', back: href('help/center') }}>
      <div className="container page">
        <Breadcrumbs items={crumbs} />
        {article.isError ? (
          <LoadError error={article.error} retry={() => void article.refetch()} title="We couldn’t load this article" />
        ) : (
          <div className="split">
            <article className="stack gap-5">
              {!a ? (
                <>
                  <Loading label="Loading the article" />
                  <span className="sk sk-line h-30" aria-hidden="true" />
                  <SkLines n={8} />
                </>
              ) : (
                <>
                  <div className="stack gap-2">
                    <h1 className="h1">{a.title}</h1>
                    <div className="buy-meta-strip">
                      {a.effectiveAt && (
                        <span>
                          <Icon name="calendar" />
                          Effective {dateLong(a.effectiveAt)}
                        </span>
                      )}
                      <span>
                        <Icon name="history" />
                        Updated {dateLong(a.updatedAt)}
                      </span>
                      <span>
                        <Icon name="clock" />
                        {a.readMinutes} min read
                      </span>
                    </div>
                  </div>
                  <RichText html={a.body} tableLabel={`${a.title} table`} />
                  {(a.tables ?? []).map((t, i) => (
                    <DataTable key={i} table={t} label={`${a.title} table ${i + 1}`} />
                  ))}
                  {a.policyLinks.length > 0 && (
                    <p className="xs muted">
                      See the{' '}
                      {a.policyLinks.map((p, i) => (
                        <Fragment key={p.url}>
                          {i > 0 && (i === a.policyLinks.length - 1 ? ' and ' : ', ')}
                          <ApiLink url={p.url} className="link-inline">
                            {p.label}
                          </ApiLink>
                        </Fragment>
                      ))}
                      .
                    </p>
                  )}
                  {feedback === '' && (
                    <div className="card pad row between">
                      <span className="strong small">Was this helpful?</span>
                      <span className="row gap-2">
                        <Button variant="secondary" size="sm" icon="thumbs-up" onClick={() => vote(true)} disabled={send.isPending}>
                          Yes
                        </Button>
                        <Button variant="secondary" size="sm" icon="thumbs-down" onClick={() => (send.reset(), setFeedback('no'))} disabled={send.isPending}>
                          No
                        </Button>
                      </span>
                      {send.isError && (
                        <span className="error-text">
                          <Icon name="circle-alert" className="ic-sm" />
                          {errorMessage(send.error)}
                        </span>
                      )}
                    </div>
                  )}
                  {feedback === 'no' && (
                    <div className="card pad stack gap-3">
                      <span className="strong small">Sorry this didn't help. What was missing?</span>
                      <Field label="Your feedback" hint="We read every comment but can't reply here. For help with an order, contact us." error={error || (send.isError ? errorMessage(send.error) : undefined)}>
                        <Textarea
                          id="ha-fb"
                          value={comment}
                          maxLength={2000}
                          onChange={(e) => {
                            setComment(e.target.value);
                            setError('');
                          }}
                        />
                      </Field>
                      <span className="row gap-2">
                        <Button size="sm" onClick={sendComment} disabled={send.isPending}>
                          {send.isPending ? 'Sending…' : 'Send feedback'}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => vote(false)} disabled={send.isPending}>
                          Skip
                        </Button>
                      </span>
                    </div>
                  )}
                  {(feedback === 'yes' || feedback === 'sent') && (
                    <div className="card pad row gap-2" role="status">
                      <Icon name="circle-check" className="ic-sm" />
                      <span className="strong small">Thanks for your feedback.</span>
                    </div>
                  )}
                </>
              )}
            </article>
            <aside className="stack gap-4">
              {a && a.related.length > 0 && (
                <section className="card">
                  <div className="card-head">
                    <div className="stack gap-0">
                      <h3 className="h4">Related articles</h3>
                    </div>
                  </div>
                  <ul className="list pad">
                    {a.related.map((r) => (
                      <li key={r.id}>
                        <Link className="small" to={href('help/article', '', { slug: r.slug })}>
                          {r.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {otherActions.map((x) => {
                const to = appHref(x.url);
                return (
                  <div key={x.url} className="card pad stack gap-2">
                    {to !== null ? (
                      <Button variant="secondary" size="sm" to={to}>
                        {x.label}
                      </Button>
                    ) : (
                      <a className="btn btn-secondary btn-sm" href={x.url}>
                        <span>{x.label}</span>
                      </a>
                    )}
                  </div>
                );
              })}
              {(contactAction || a) && (
                <div className="card pad stack gap-2">
                  <span className="strong small">Still need help?</span>
                  {config.data?.support.hoursLabel && <span className="xs muted">{config.data.support.hoursLabel}</span>}
                  <Button variant="ghost" size="sm" icon="headset" to={href('help/contact')}>
                    {contactAction?.label ?? 'Contact us'}
                  </Button>
                </div>
              )}
            </aside>
          </div>
        )}
      </div>
    </StoreLayout>
  );
}
