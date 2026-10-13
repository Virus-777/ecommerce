import { Fragment, type ReactNode } from 'react';
import { TableWrap } from '@marketly/web-shared/ui';
import { ApiLink } from './links';

// Renders rich text from the API (help article, policy and content page bodies are HTML authored by staff)
// without dangerouslySetInnerHTML: the HTML is parsed with DOMParser and rebuilt as React elements from an
// allowlist of basic tags. Everything else is dropped (scripts, styles, iframes, forms, event handlers,
// inline styles, classes, ids); links keep only http(s), mailto, tel and site-relative targets and go
// through ApiLink (internal links become router links). Tables are lifted out of the prose block into the
// design's TableWrap + .table markup.

const BLOCK_TAGS = new Set(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'hr', 'pre']);
const INLINE_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'small', 'code', 'br', 'span', 'sub', 'sup', 'mark']);
const TABLE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption']);
/** Dropped with their content. */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math', 'form', 'input', 'button', 'select', 'textarea', 'head', 'title', 'link', 'meta']);

const SAFE_URL = /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i;

function parse(html: string): Node[] | null {
  if (typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return Array.from(doc.body.childNodes);
}

function convert(node: Node, key: string): ReactNode {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (DROP_WITH_CONTENT.has(tag)) return null;
  const kids = Array.from(el.childNodes).map((c, i) => convert(c, `${key}.${i}`));
  if (tag === 'a') {
    const h = (el.getAttribute('href') ?? '').trim();
    if (!SAFE_URL.test(h)) return <Fragment key={key}>{kids}</Fragment>;
    return (
      <ApiLink key={key} url={h} className="link-inline">
        {kids}
      </ApiLink>
    );
  }
  if (tag === 'br' || tag === 'hr') return tag === 'br' ? <br key={key} /> : <hr key={key} />;
  if (TABLE_TAGS.has(tag)) {
    if (tag === 'table') return <table key={key} className="table">{kids}</table>;
    // key goes to JSX directly: React warns when a spread props object carries it
    const props: Record<string, unknown> = {};
    if (tag === 'th') props.scope = el.getAttribute('scope') === 'row' ? 'row' : el.closest('thead') ? 'col' : undefined;
    for (const a of ['colspan', 'rowspan'] as const) {
      const n = Number(el.getAttribute(a));
      if (Number.isInteger(n) && n > 1 && n < 50) props[a === 'colspan' ? 'colSpan' : 'rowSpan'] = n;
    }
    const T = tag as 'thead';
    return <T key={key} {...props}>{kids.filter((k) => !(typeof k === 'string' && !k.trim() && tag !== 'td' && tag !== 'th'))}</T>;
  }
  if (BLOCK_TAGS.has(tag) || INLINE_TAGS.has(tag)) {
    // h1 is the page's own heading; anything authored as h1/h5/h6 is folded into the allowed levels below.
    const T = tag as 'p';
    return <T key={key}>{kids}</T>;
  }
  if (tag === 'h1') return <h2 key={key}>{kids}</h2>;
  if (tag === 'h5' || tag === 'h6') return <h4 key={key}>{kids}</h4>;
  // div, section, article, img, … : keep the text content, drop the element.
  if (tag === 'img') return null;
  return <Fragment key={key}>{kids}</Fragment>;
}

/** Plain text of an HTML string (for search snippets, SSR fallback). */
export function htmlToText(html: string): string {
  const nodes = parse(html);
  if (nodes) return nodes.map((n) => n.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

/**
 * API HTML as the design's blocks: runs of text in `<div className="prose">`, each table in
 * `<TableWrap><table className="table">` between them (as on the help article and policy pages).
 */
export function RichText({ html, tableLabel = 'Table', proseClassName = 'prose' }: { html: string | null | undefined; tableLabel?: string; proseClassName?: string }) {
  if (!html) return null;
  const nodes = parse(html);
  if (!nodes) {
    return (
      <div className={proseClassName}>
        <p>{htmlToText(html)}</p>
      </div>
    );
  }
  const out: ReactNode[] = [];
  let run: ReactNode[] = [];
  let n = 0;
  const flush = () => {
    if (run.some((r) => r !== null && !(typeof r === 'string' && !r.trim()))) {
      out.push(
        <div key={`p${n++}`} className={proseClassName}>
          {run}
        </div>,
      );
    }
    run = [];
  };
  nodes.forEach((node, i) => {
    if (node.nodeType === 1 && (node as Element).tagName.toLowerCase() === 'table') {
      flush();
      const caption = (node as Element).querySelector('caption')?.textContent?.trim();
      out.push(
        <TableWrap key={`t${i}`} label={caption || tableLabel}>
          {convert(node, `t${i}`)}
        </TableWrap>,
      );
    } else run.push(convert(node, `n${i}`));
  });
  flush();
  return <>{out}</>;
}

/** Inline API HTML (no block wrapper): for short bodies inside an existing element. */
export function InlineHtml({ html }: { html: string | null | undefined }) {
  if (!html) return null;
  const nodes = parse(html);
  if (!nodes) return <>{htmlToText(html)}</>;
  return <>{nodes.map((node, i) => convert(node, `i${i}`))}</>;
}

/** A table from a structured `tables` entry ({ title?, columns|head, rows }); other shapes are skipped. */
export function DataTable({ table, label }: { table: unknown; label: string }) {
  const t = table as { title?: unknown; caption?: unknown; columns?: unknown; head?: unknown; headers?: unknown; rows?: unknown };
  const head = [t.columns, t.head, t.headers].find(Array.isArray) as unknown[] | undefined;
  const rows = Array.isArray(t.rows) ? (t.rows as unknown[]).filter(Array.isArray) as unknown[][] : null;
  if (!rows) return null;
  const title = typeof t.title === 'string' ? t.title : typeof t.caption === 'string' ? t.caption : label;
  const cell = (c: unknown) => (typeof c === 'string' || typeof c === 'number' ? String(c) : '');
  return (
    <TableWrap label={title}>
      <table className="table">
        {head && (
          <thead>
            <tr>
              {head.map((h, i) => (
                <th key={i} scope="col">
                  {cell(typeof h === 'object' && h ? (h as { label?: unknown }).label : h)}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{cell(c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}
