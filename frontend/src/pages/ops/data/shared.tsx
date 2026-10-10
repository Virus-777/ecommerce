import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { Icon } from '@/ui';

/** Shared legend copy for row edges in the Operations tables. */
export const EDGE_URGENT = 'Red edge = urgent: overdue or past target';
export const EDGE_RISK = 'Amber edge = at risk: due soon or near target';

/**
 * Status legend as the design renders it, including the screen-reader "Legend: " prefix
 * (the shared StatusLegend component omits that prefix).
 */
export function OpsLegend({ items, kind = 'edge', className }: { items: Array<{ tone: 'danger' | 'warning'; label: ReactNode }>; kind?: 'edge' | 'number'; className?: string }) {
  return (
    <p className={cx('status-legend', `status-legend--${kind}`, className)}>
      <span className="sr-only">Legend: </span>
      {items.map((it, i) => (
        <span key={i} className={cx('sl', `sl-${it.tone}`)}>
          <i aria-hidden="true" />
          {it.label}
        </span>
      ))}
    </p>
  );
}

/** Before → after pair (.ac-ba). */
export function BeforeAfter({ b, a }: { b: ReactNode; a: ReactNode }) {
  return (
    <span className="ac-ba">
      <span className="b">{b}</span>
      <Icon name="arrow-right" />
      <span className="a">{a}</span>
    </span>
  );
}
