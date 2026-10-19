import { useSearchParams } from 'react-router';
import { StoreLayout } from '@/layouts';
import { href } from '@marketly/web-shared/routes';
import { Breadcrumbs, Button, Chip, ChipRow, EmptyState, Pager } from '@marketly/web-shared/ui';
import { InfiniteRow, LoadError } from '@/api/cards';
import { useMarkNewsSeen, useNewsCategories, useNewsList } from '@/api/news';
import { NewsCardLink, NewsGridSkeleton } from '@/api/news-cards';

// Design: News list, /news (designed in React from docs/06-news.md §5). Data: GET /api/store/content/news
// (?category=<slug>, pinned first then newest; website ?page= numbered pages, phone ?cursor= lazy loading) and
// GET /api/store/content/news/categories (the chips: visible categories with posts, in staff order).
// Pinned posts show as large cards above the grid. Viewing the list records the newest post shown as seen on
// this device (the Account tab's "new" dot, api/news.ts). Phone: app bar with back, no breadcrumb.

export default function News() {
  const [params, setParams] = useSearchParams();
  const category = params.get('category') || null;
  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);
  const cats = useNewsCategories();
  const list = useNewsList(category, page);
  useMarkNewsSeen(list.items.map((p) => p.publishedAt));

  const setPage = (n: number) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (n > 1) p.set('page', String(n));
        else p.delete('page');
        return p;
      },
      { preventScrollReset: true },
    );
    window.scrollTo({ top: 0 });
  };

  const chips = cats.data ?? [];
  const current = chips.find((c) => c.slug === category);
  const pinned = list.items.filter((p) => p.pinned);
  const rest = list.items.filter((p) => !p.pinned);
  const showSkeleton = list.isPending && !list.error;

  return (
    <StoreLayout appbar={{ title: 'News' }}>
      <div className="container page gap-6">
        <div className="stack gap-2">
          <Breadcrumbs className="no-phone" items={[{ label: 'Home', to: href('store/home') }, { label: 'News' }]} />
          <h1 className="h1 acct-h1">News</h1>
          <p className="sub no-phone">Announcements, service updates, events and policy changes from Marketly.</p>
        </div>

        {chips.length > 0 && (
          <nav aria-label="News categories">
            <ChipRow>
              <Chip to={href('store/news')} active={!category}>
                All
              </Chip>
              {chips.map((c) => (
                <Chip key={c.id} to={href('store/news', '', undefined, { category: c.slug })} active={c.slug === category}>
                  {c.name}
                </Chip>
              ))}
            </ChipRow>
          </nav>
        )}

        {list.error ? (
          <LoadError error={list.error} onRetry={list.refetch} title="We couldn’t load the news" />
        ) : showSkeleton ? (
          <NewsGridSkeleton n={6} />
        ) : list.items.length === 0 ? (
          <EmptyState
            icon="newspaper"
            title={category ? `No news in ${current?.name ?? 'this category'} right now` : 'No news yet'}
            action={
              category ? (
                <Button variant="secondary" to={href('store/news')}>
                  See all news
                </Button>
              ) : (
                <Button variant="secondary" to={href('store/home')}>
                  Back to shopping
                </Button>
              )
            }
          >
            {category ? 'Posts in this category have ended or moved. Other news is under All.' : 'Announcements, service updates and events from Marketly will appear here.'}
          </EmptyState>
        ) : (
          <div className="stack gap-6" aria-busy={list.isFetching || undefined}>
            {pinned.length > 0 && (
              <div className="news-pinned">
                {pinned.map((p) => (
                  <NewsCardLink key={p.id} post={p} large headingLevel="h2" />
                ))}
              </div>
            )}
            {rest.length > 0 && (
              <ul className="news-grid">
                {rest.map((p) => (
                  <li key={p.id}>
                    <NewsCardLink post={p} headingLevel="h2" />
                  </li>
                ))}
              </ul>
            )}
            {list.phone && <InfiniteRow listing={list} />}
            {!list.phone && list.totalPages > 1 && <Pager page={list.page} total={list.totalPages} onPage={setPage} only="website" />}
          </div>
        )}
      </div>
    </StoreLayout>
  );
}
