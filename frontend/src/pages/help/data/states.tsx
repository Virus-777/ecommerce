import { iconFor as sharedIconFor } from '@marketly/web-shared/ui';
import { LoadError as SharedLoadError } from '@marketly/web-shared/ui';
import { type IconName } from '@marketly/web-shared/ui';

// Loading and error states shared by the help, policy and seller-entry screens (web-shared/docs/API.md, rule 4).

/** A failed read: the server's message and a Try again button. */
export function LoadError({ error, retry, title = 'We couldn’t load this' }: { error: unknown; retry?: () => void; title?: string }) {
  return <SharedLoadError error={error} onRetry={retry} title={title} />;
}

/** Skeleton lines (e.g. a paragraph or a list while loading). */
export function SkLines({ n = 3, className }: { n?: number; className?: string }) {
  return (
    <div className={className ?? 'stack gap-2'} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={i === n - 1 ? 'sk sk-line short' : 'sk sk-line'} />
      ))}
    </div>
  );
}

/** Skeleton rows with a thumbnail (lists of orders, cases, articles). */
export function SkRows({ n = 3 }: { n?: number }) {
  return (
    <div className="sk-list pad" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="sk-row">
          <span className="sk sk-thumb" />
          <span className="sk-lines">
            <span className="sk sk-line" />
            <span className="sk sk-line short" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Screen-reader status while a page loads. */
export const Loading = ({ label = 'Loading' }: { label?: string }) => (
  <span className="sr-only" role="status">
    {label}…
  </span>
);

// Category slugs map to the design's icons; any other name the icon set has is used as it is (web-shared iconFor).
const CATEGORY_ICONS: Record<string, IconName> = {
  electronics: 'headphones', computers: 'monitor', 'home-and-kitchen': 'cooking-pot', home: 'cooking-pot', fashion: 'shirt', 'sports-and-outdoors': 'tent', sports: 'tent',
  beauty: 'sparkles', 'toys-and-games': 'puzzle', toys: 'puzzle', 'pet-supplies': 'paw-print', pets: 'paw-print',
};

/** An API icon name if the icon set has it, else the fallback. Category slugs map to the design's icons. */
export function iconFor(name: string | null | undefined, fallback: IconName = 'circle-help'): IconName {
  if (!name) return fallback;
  return CATEGORY_ICONS[name] ?? sharedIconFor(name, fallback);
}
