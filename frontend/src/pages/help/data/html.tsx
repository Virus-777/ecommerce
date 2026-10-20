import type { ComponentProps } from 'react';
import { DataTable, htmlToText, InlineHtml as SharedInlineHtml, RichText as SharedRichText } from '@marketly/web-shared/ui';
import { ApiLink } from './links';

// Rich text from the API (help articles, policies, content pages, news) with the store's links: the shared renderer
// (web-shared ui/RichText) with ApiLink, which turns site paths into store routes.

export function RichText(p: Omit<ComponentProps<typeof SharedRichText>, 'link'>) {
  return <SharedRichText {...p} link={ApiLink} />;
}

/** Inline API HTML (no block wrapper): for short bodies inside an existing element. */
export function InlineHtml(p: Omit<ComponentProps<typeof SharedInlineHtml>, 'link'>) {
  return <SharedInlineHtml {...p} link={ApiLink} />;
}

export { DataTable, htmlToText };
