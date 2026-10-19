import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@marketly/web-shared/api';
import { StoreLayout } from '@/layouts';
import { href } from '@marketly/web-shared/routes';
import { Alert, Breadcrumbs, Button, Icon, SectionHeader } from '@marketly/web-shared/ui';
import { LoadError, Pic } from '@/api/cards';
import { isExternal, safeContentLinkTo } from '@/api/content';
import { useMarkNewsSeen, useNewsPost, type NewsPost as Post } from '@/api/news';
import { NewsCardLink, newsDate, newsHref, NewsMeta } from '@/api/news-cards';
import NotFound from '../store/NotFound';
import { RichText } from '../help/data/html';
import { Loading, SkLines } from '../help/data/states';

// Design: News post, /news/:slug (designed in React from docs/06-news.md §5). Data: GET /api/store/content/news/{slug}
// (404 unless published → the store's not-found page; an old slug answers the post with its current `slug`, and
// the address is replaced with the current one; `archived` = past its archive time, still readable with a note).
// The body is staff-authored HTML rendered through the allowlist renderer (help/data/html.tsx, as on help
// articles); the optional button goes through the content link check (api/content.ts). "More news" = `related`.
// Website: breadcrumb News › title. Phone: app bar with back to the News list, no breadcrumb.

function CtaButton({ cta }: { cta: NonNullable<Post['cta']> }) {
  const to = safeContentLinkTo(cta.url);
  if (!to) return null;
  if (isExternal(to)) {
    return (
      <a className="btn btn-primary" href={to} target="_blank" rel="noopener noreferrer">
        <span>{cta.label}</span>
        <Icon name="external-link" />
      </a>
    );
  }
  return (
    <Button to={to} iconRight="arrow-right">
      {cta.label}
    </Button>
  );
}

export default function NewsPost() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useNewsPost(slug);
  const p = q.data;
  const notFound = q.error instanceof ApiError && q.error.status === 404;
  useMarkNewsSeen(p ? [p.publishedAt] : []);

  // Old address (the slug changed): show the current one, without another request.
  useEffect(() => {
    if (!p || p.slug === slug) return;
    qc.setQueryData(['content', 'news', 'post', p.slug], p);
    navigate(newsHref(p.slug), { replace: true });
  }, [p, slug, qc, navigate]);

  if (notFound) return <NotFound />;

  const updated = p && p.publishedAt && newsDate(p.updatedAt) !== newsDate(p.publishedAt) ? newsDate(p.updatedAt) : '';
  const related = (p?.related ?? []).slice(0, 3);

  return (
    <StoreLayout appbar={{ title: 'News', back: href('store/news') }}>
      <div className="container page gap-7">
        <div className="stack gap-5">
          <Breadcrumbs className="no-phone" items={[{ label: 'News', to: href('store/news') }, { label: p?.title ?? '…' }]} />
          {q.isError ? (
            <LoadError error={q.error} onRetry={() => void q.refetch()} title="We couldn’t load this news" />
          ) : !p ? (
            <div className="news-post stack gap-4">
              <Loading label="Loading the news" />
              <span className="sk sk-line short" aria-hidden="true" />
              <span className="sk sk-line h-30" aria-hidden="true" />
              <span className="sk sk-img news-sk-img" aria-hidden="true" />
              <SkLines n={6} />
            </div>
          ) : (
            <article className="news-post stack gap-5">
              <header className="stack gap-2">
                <span className="row gap-2">
                  <NewsMeta post={p} />
                  {updated && <span className="xs muted">· Updated {updated}</span>}
                </span>
                <h1 className="h1">{p.title}</h1>
              </header>
              {p.archived && (
                <Alert tone="info" icon="archive" title="This news is archived">
                  It is no longer listed with current news, so some details may be out of date.
                </Alert>
              )}
              {p.cover && <Pic image={p.cover} icon="newspaper" className="wide news-cover" />}
              <RichText html={p.body} tableLabel={`${p.title} table`} />
              {p.cta && (
                <div>
                  <CtaButton cta={p.cta} />
                </div>
              )}
            </article>
          )}
        </div>

        {related.length > 0 && (
          <section className="stack gap-4" aria-labelledby="news-more">
            <SectionHeader title="More news" id="news-more" link="All news" to={href('store/news')} />
            <div className="news-row">
              {related.map((r) => (
                <NewsCardLink key={r.id} post={r} />
              ))}
            </div>
          </section>
        )}
      </div>
    </StoreLayout>
  );
}
