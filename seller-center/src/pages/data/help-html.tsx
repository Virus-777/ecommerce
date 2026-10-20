import type { ComponentProps, ReactNode } from 'react';
import { Link } from 'react-router';
import { DataTable as SharedDataTable, htmlToText, RichText as SharedRichText } from '@marketly/web-shared/ui';
import { helpLinkTo } from './help-articles';

// Help article bodies (HTML authored by staff, sanitized by the API) through the shared renderer (web-shared
// ui/RichText) with HelpLink: links to Seller Center screens or help articles become router links.

/** A content link: router link inside the Seller Center, plain anchor outside, text when it goes nowhere here. */
export function HelpLink({ url, className, children }: { url: string; className?: string; children: ReactNode }) {
  const t = helpLinkTo(url);
  if (t.to) {
    return (
      <Link to={t.to} className={className}>
        {children}
      </Link>
    );
  }
  if (t.external) {
    return (
      <a href={t.external} className={className} {...(/^https?:/.test(t.external) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
        {children}
      </a>
    );
  }
  return <>{children}</>;
}

export function RichText(p: Omit<ComponentProps<typeof SharedRichText>, 'link'>) {
  return <SharedRichText {...p} link={HelpLink} />;
}

/** A table from a structured `tables` entry; the first column names each row. */
export const DataTable = (p: { table: unknown; label: string }) => <SharedDataTable {...p} rowHeaders />;

export { htmlToText };
