import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';
import { TableWrap } from '@marketly/web-shared/ui';
import { helpLinkTo } from './help-articles';

// Help article bodies are HTML authored by staff (sanitized by the API). They are rebuilt as React elements
// from an allowlist of basic tags (no dangerouslySetInnerHTML): scripts, styles, frames, forms, event handlers,
// classes and inline styles are dropped; links keep http(s), mailto, tel and site-relative targets, and links
// to Seller Center screens or help articles become router links. Tables are lifted out of the prose block into
// the design's TableWrap + .table markup.

const BLOCK_TAGS = new Set(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'hr', 'pre']);
const INLINE_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'small', 'code', 'br', 'span', 'sub', 'sup', 'mark']);
const TABLE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption']);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math', 'form', 'input', 'button', 'select', 'textarea', 'head', 'title', 'link', 'meta']);
const SAFE_URL = /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i;

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
    if (!SAFE_URL.test(h) || h.startsWith('#')) return <Fragment key={key}>{kids}</Fragment>;
    return (
      <HelpLink key={key} url={h} className="link-inline">
        {kids}
      </HelpLink>
    );
  }
  if (tag === 'br') return <br key={key} />;
  if (tag === 'hr') return <hr key={key} />;
  if (TABLE_TAGS.has(tag)) {
    if (tag === 'table') return <table key={key} className="table">{kids}</table>;
    const props: Record<string, unknown> = { key };
    if (tag === 'th') props.scope = el.getAttribute('scope') === 'row' ? 'row' : el.closest('thead') ? 'col' : undefined;
    for (const a of ['colspan', 'rowspan'] as const) {
      const n = Number(el.getAttribute(a));
      if (Number.isInteger(n) && n > 1 && n < 50) props[a === 'colspan' ? 'colSpan' : 'rowSpan'] = n;
    }
    const T = tag as 'thead';
    return <T {...props}>{kids.filter((k) => !(typeof k === 'string' && !k.trim() && tag !== 'td' && tag !== 'th'))}</T>;
  }
  if (BLOCK_TAGS.has(tag) || INLINE_TAGS.has(tag)) {
    const T = tag as 'p';
    return <T key={key}>{kids}</T>;
  }
  // The page has its own h1; other heading levels fold into the allowed ones.
  if (tag === 'h1') return <h2 key={key}>{kids}</h2>;
  if (tag === 'h5' || tag === 'h6') return <h4 key={key}>{kids}</h4>;
  if (tag === 'img') return null;
  return <Fragment key={key}>{kids}</Fragment>;
}

/** Plain text of an HTML string. */
export function htmlToText(html: string): string {
  const nodes = parse(html);
  if (nodes) return nodes.map((n) => n.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

/** Article HTML as the design's blocks: text runs in `.prose`, each table in TableWrap between them. */
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

/** A table from a structured `tables` entry ({ title?, columns|head, rows, note? }); other shapes are skipped. */
export function DataTable({ table, label }: { table: unknown; label: string }) {
  const t = table as { title?: unknown; caption?: unknown; label?: unknown; columns?: unknown; head?: unknown; headers?: unknown; rows?: unknown; note?: unknown };
  const head = [t.columns, t.head, t.headers].find(Array.isArray) as unknown[] | undefined;
  const rows = Array.isArray(t.rows) ? ((t.rows as unknown[]).filter(Array.isArray) as unknown[][]) : null;
  if (!rows) return null;
  const title = [t.title, t.caption, t.label].find((x): x is string => typeof x === 'string') ?? label;
  const cell = (c: unknown) => (typeof c === 'string' || typeof c === 'number' ? String(c) : '');
  return (
    <>
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
                {r.map((c, j) =>
                  j === 0 ? (
                    <th key={j} scope="row" className="small strong">
                      {cell(c)}
                    </th>
                  ) : (
                    <td key={j}>{cell(c)}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {typeof t.note === 'string' && <p className="xs muted">{t.note}</p>}
    </>
  );
}
