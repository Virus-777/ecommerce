import { humanize } from '@marketly/web-shared/lib/format';
import type { ReactNode } from 'react';
import { cx } from '@marketly/web-shared/lib/cx';
import { Icon } from '@marketly/web-shared/ui';

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

/** A staff reference as the API sends it ({ staffId, name, role }); the placeholder staff are named "Not set". */
export interface StaffRef {
  staffId?: string | null;
  name?: string | null;
  role?: string | null;
}
export const staffName = (s?: StaffRef | null, none = 'Not set') => (s?.name && s.name.trim() ? s.name : none);

/** "order_manager" → "Order manager"; "in_progress" → "In progress". */
export { humanize };

/** Skeleton rows for a table body while it loads. */
export function SkeletonRows({ cols, rows = 4 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i} aria-hidden="true">
          {Array.from({ length: cols }, (_, j) => (
            <td key={j}>
              <span className="sk sk-line" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** A table row with one cell spanning the table: empty states inside tables. */
export function EmptyRow({ cols, children }: { cols: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={cols} className="muted small">
        {children}
      </td>
    </tr>
  );
}
