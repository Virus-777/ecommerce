import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { href } from '@marketly/web-shared/routes';

// API content links (content.LinkRef: help breadcrumbs, article actions, policy links, banner CTAs) carry
// site paths such as /help/articles/late-package or /policies/purchase_terms. These map them onto the
// store's routes (href ids), so links keep working if a route changes, and policy keys become ?view slugs.

/** Policy key (content) → ?view slug of info/policy (design views). Other keys use ?key=. */
export const POLICY_VIEW: Record<string, string> = { returns: '', shipping: 'shipping', seller_rules: 'seller-rules', privacy: 'privacy', purchase_terms: 'purchase-terms' };

/** Link to a policy by its content key. */
export function policyHref(key: string): string {
  const k = key.replace(/-/g, '_');
  return k in POLICY_VIEW ? href('info/policy', POLICY_VIEW[k]) : href('info/policy', '', undefined, { key: k });
}

/** Store route for an API path, or null when it is external (http(s) elsewhere, mailto:, tel:). */
export function appHref(url: string): string | null {
  let u = url.trim();
  if (/^(mailto:|tel:)/i.test(u)) return null;
  if (/^https?:\/\//i.test(u)) {
    try {
      const parsed = new URL(u);
      if (typeof window === 'undefined' || parsed.origin !== window.location.origin) return null;
      u = parsed.pathname + parsed.search + parsed.hash;
    } catch {
      return null;
    }
  }
  if (u.startsWith('#')) return u;
  const [pathAndQuery, hash = ''] = u.split('#');
  const [path, qs = ''] = pathAndQuery.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs));
  const p = path.replace(/\/+$/, '') || '/';
  const seg = p.split('/').filter(Boolean).map(decodeURIComponent);
  const withHash = (s: string) => (hash ? `${s}#${hash}` : s);
  const q = Object.keys(query).length ? query : undefined;
  if (p === '/') return href('store/home');
  if (seg[0] === 'help') {
    if (seg.length === 1) return withHash(href('help/center', '', undefined, q));
    if (seg[1] === 'topics' && seg[2]) return href('help/center', '', undefined, { ...query, topic: seg[2] });
    if (seg[1] === 'articles' && seg[2]) return withHash(href('help/article', '', { slug: seg[2] }));
    if (seg[1] === 'contact') return href('help/contact', '', undefined, q);
    if (seg[1] === 'order-problem') return href('help/order-problem', '', undefined, q);
    if (seg[1] === 'cases') return seg[2] ? href('help/case', '', { ref: seg[2] }) : href('help/cases');
  }
  if (seg[0] === 'policies') return seg[1] ? withHash(policyHref(seg[1])) : href('info/policy');
  if (p === '/about') return href('info/about');
  if (p === '/sell') return href('sell/landing');
  if (p === '/sell/apply') return href('sell/apply');
  if (p === '/sell/status') return href('sell/status');
  if (seg[0] === 'account' && seg[1] === 'orders') return seg[2] ? href('account/order', '', { ref: seg[2] }) : href('account/orders');
  return withHash(qs ? `${p}?${qs}` : p);
}

/** An API link: a router Link for store paths, a plain anchor for external, mailto: and tel: links. */
export function ApiLink({ url, className, children }: { url: string; className?: string; children: ReactNode }) {
  const to = appHref(url);
  if (to !== null) {
    return (
      <Link to={to} className={className}>
        {children}
      </Link>
    );
  }
  const external = /^https?:/i.test(url);
  return (
    <a href={url} className={className} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
      {children}
    </a>
  );
}
