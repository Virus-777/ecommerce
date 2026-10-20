import { date } from '@marketly/web-shared/lib/dates';
import { Link } from 'react-router';
import { cx } from '@marketly/web-shared/lib/cx';
import { href } from '@marketly/web-shared/routes';
import { Badge } from '@marketly/web-shared/ui';
import { Pic } from './cards';
import { tintOf } from './catalog';
import { contentIcon } from './content';
import type { NewsCard } from './news';

// News cards (designed in React from docs/06-news.md §5): the 16 : 9 cover, or the category's icon on a tint
// when a post has no cover; category · date (market time zone, PT); title; summary. Used by the News list,
// "More news" on a post and the home "Latest news" section. Styles: the News block in marketly.css.

/** "Oct 6, 2026" in the market time zone. */
export const newsDate = (iso: string | null | undefined) => {
  const d = iso ? new Date(iso) : null;
  return iso && d && !Number.isNaN(d.getTime()) ? date(iso) : '';
};

export const newsHref = (slug: string) => href('store/news-post', '', { slug });

/** Cover image, else the category icon on its tint. */
export function NewsArt({ post, className }: { post: Pick<NewsCard, 'cover' | 'category'>; className?: string }) {
  return <Pic image={post.cover} icon={contentIcon(post.category.icon, 'newspaper')} tint={tintOf(post.category.slug)} className={cx('wide', className)} alt="" />;
}

/** Category · date line. */
export function NewsMeta({ post }: { post: Pick<NewsCard, 'category'> & { publishedAt?: string | null } }) {
  return (
    <span className="news-meta xs">
      <span className="news-cat">{post.category.name}</span>
      <span aria-hidden="true">·</span>
      <time dateTime={post.publishedAt ?? undefined}>{newsDate(post.publishedAt)}</time>
    </span>
  );
}

/** A news card; `large` is the pinned layout (picture beside the text from tablet up). */
export function NewsCardLink({ post, large, headingLevel = 'h3' }: { post: NewsCard; large?: boolean; headingLevel?: 'h2' | 'h3' }) {
  const H = headingLevel;
  return (
    <Link className={cx('news-card', large && 'is-large')} to={newsHref(post.slug)}>
      <NewsArt post={post} />
      <span className="news-card-body">
        <span className="row gap-2">
          {large && post.pinned && <Badge tone="brand">Pinned</Badge>}
          <NewsMeta post={post} />
        </span>
        <H className="news-title">{post.title}</H>
        {post.summary && <span className={cx('small sub', large ? 'news-sum-lg' : 'clamp-2')}>{post.summary}</span>}
      </span>
    </Link>
  );
}

/** Skeleton cards while news loads. */
export function NewsGridSkeleton({ n = 6, className = 'news-grid' }: { n?: number; className?: string }) {
  return (
    <div className={className} aria-busy="true" aria-label="Loading news">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="news-card" aria-hidden="true">
          <span className="sk sk-img news-sk-img" />
          <span className="sk sk-line short" />
          <span className="sk sk-line" />
          <span className="sk sk-line" />
        </div>
      ))}
    </div>
  );
}
