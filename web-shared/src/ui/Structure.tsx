import { Fragment, useEffect, useRef, type CSSProperties, type ElementType, type ReactNode } from 'react';
import { Link } from 'react-router';
import { cx } from '../lib/cx';
import { useScrollRegion } from '../lib/hooks';
import { Icon, type IconName } from './Icon';

/* ---------------- Card ---------------- */

interface CardProps {
  title?: ReactNode;
  sub?: ReactNode;
  /** Right side of the head (links, buttons). */
  actions?: ReactNode;
  foot?: ReactNode;
  footClassName?: string;
  /** Children go straight into the card (no .card-body): tables, lists. */
  flush?: boolean;
  /** Plain padded card (.card.pad) with no head. */
  pad?: boolean;
  /** Heading element for the title (default h2, styled .h4). */
  titleAs?: 'h2' | 'h3';
  titleClassName?: string;
  className?: string;
  bodyClassName?: string;
  id?: string;
  'aria-labelledby'?: string;
  children?: ReactNode;
}

/** .card with optional head (title, sub, actions), body and foot. */
export function Card({ title, sub, actions, foot, footClassName, flush, pad, titleAs: H = 'h2', titleClassName = 'h4', className, bodyClassName, children, ...rest }: CardProps) {
  if (pad) {
    return (
      <div className={cx('card pad', className)} {...rest}>
        {children}
      </div>
    );
  }
  return (
    <section className={cx('card', className)} {...rest}>
      {title !== undefined && (
        <div className="card-head">
          <div className="stack gap-0">
            <H className={titleClassName}>{title}</H>
            {sub && <span className="xs muted">{sub}</span>}
          </div>
          {actions && <div className="row gap-2">{actions}</div>}
        </div>
      )}
      {flush ? children : <div className={cx('card-body', bodyClassName)}>{children}</div>}
      {foot && <div className={cx('card-foot', footClassName)}>{foot}</div>}
    </section>
  );
}

/* ---------------- Headings ---------------- */

export interface Crumb {
  label: ReactNode;
  to?: string;
}

/** Breadcrumbs (website only: hidden on the phone app layout by the store CSS). */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav className={cx('crumbs', className)} aria-label="Breadcrumb">
      {items.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <Icon name="chevron-right" />}
          {c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
        </Fragment>
      ))}
    </nav>
  );
}

/** Back-office page title row: crumbs, eyebrow, h1, sub and actions. */
export function PageHeader({ title, sub, actions, crumbs, eyebrow, className }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; crumbs?: Crumb[]; eyebrow?: ReactNode; className?: string }) {
  return (
    <div className={cx('page-head', className)}>
      <div className="t">
        {crumbs && <Breadcrumbs items={crumbs} />}
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1 className="h1">{title}</h1>
        {sub && <p className="sub small">{sub}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

/** Section title row with an optional "see all" link. */
export function SectionHeader({ title, link, to = '#', display, id, as: H = 'h2' }: { title: ReactNode; link?: ReactNode; to?: string; display?: boolean; id?: string; as?: ElementType }) {
  return (
    <div className="row between base">
      <H className={display ? 'display d-lg' : 'h2'}>{id ? <span id={id}>{title}</span> : title}</H>
      {link && (
        <Link className="small strong" to={to}>
          {link} <Icon name="arrow-right" className="ic-sm" />
        </Link>
      )}
    </div>
  );
}

/* ---------------- Navigation in a page ---------------- */

export interface TabItem<V extends string = string> {
  label: ReactNode;
  /** Value passed to onChange / compared with `active`. Defaults to the index as a string. */
  value?: V;
  count?: number | string;
  icon?: IconName;
  /** Make the tab a link instead of a button. */
  to?: string;
}

/** Tabs (.tabs). Use `active` + `onChange` (buttons), or give items `to` (links). */
export function Tabs<V extends string = string>({ items, active, onChange, label, className }: { items: TabItem<V>[]; active: V | string; onChange?: (v: V) => void; label?: string; className?: string }) {
  return (
    <div className={cx('tabs', className)} role="tablist" aria-label={label}>
      {items.map((t, i) => {
        const v = (t.value ?? String(i)) as V;
        const on = v === active;
        const inner = (
          <>
            {t.icon && <Icon name={t.icon} className="ic-sm" />}
            {t.label}
            {t.count !== undefined && <span className="count">{t.count}</span>}
          </>
        );
        return t.to ? (
          <Link key={v} className={cx('tab', on && 'is-active')} role="tab" aria-selected={on} to={t.to} preventScrollReset>
            {inner}
          </Link>
        ) : (
          <button key={v} type="button" className={cx('tab', on && 'is-active')} role="tab" aria-selected={on} onClick={() => onChange?.(v)}>
            {inner}
          </button>
        );
      })}
    </div>
  );
}

/** Segmented control (.seg): one-of-many toggle. */
export function SegmentedControl<V extends string = string>({ items, active, onChange, label, className }: { items: Array<{ label: ReactNode; value: V; icon?: IconName }>; active: V; onChange: (v: V) => void; label?: string; className?: string }) {
  return (
    <div className={cx('seg', className)} role="group" aria-label={label}>
      {items.map((it) => (
        <button key={it.value} type="button" className={cx(it.value === active && 'is-active')} aria-pressed={it.value === active} onClick={() => onChange(it.value)}>
          {it.icon && <Icon name={it.icon} className="ic-sm" />}
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** Filter chip (.chip). `removable` shows the × for an applied filter. */
export function Chip({ active, removable, icon, onClick, to, className, children }: { active?: boolean; removable?: boolean; icon?: IconName; onClick?: () => void; to?: string; className?: string; children: ReactNode }) {
  const cls = cx('chip', active && 'is-active', className);
  const inner = (
    <>
      {icon && <Icon name={icon} />}
      {children}
      {removable && <Icon name="x" className="ic-sm" />}
    </>
  );
  if (to) {
    return (
      <Link className={cls} to={to} aria-current={active ? 'true' : undefined}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" className={cls} aria-pressed={active} onClick={onClick}>
      {inner}
    </button>
  );
}

/** Horizontal scroller row of chips. */
export function ChipRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('hscroll gap-2', className)}>{children}</div>;
}

/** Progress steps (checkout, wizards). `current` is the 0-based current step. */
export function Steps({ items, current, label = 'Progress' }: { items: ReactNode[]; current: number; label?: string }) {
  const ref = useScrollRegion<HTMLOListElement>();
  return (
    <ol className="steps" aria-label={label} ref={ref} data-scroll-region="">
      {items.map((s, i) => (
        <Fragment key={i}>
          {i > 0 && <li className="bar" aria-hidden="true" />}
          <li className={cx('step', i < current && 'is-done', i === current && 'is-current')} aria-current={i === current ? 'step' : undefined}>
            {i < current && <span className="sr-only">Completed: </span>}
            <span className="n">{i < current ? <Icon name="check" className="ic-sm" /> : i + 1}</span>
            {i === current && <span className="sr-only">Step {i + 1} of {items.length}: </span>}
            {s}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

/** Segmented delivery progress bar with labels. `done` = number of completed segments. */
export function Track({ labels, done, tone }: { labels: ReactNode[]; done: number; tone?: 'warning' | 'danger' }) {
  const n = { '--n': labels.length } as CSSProperties;
  return (
    <div className="stack gap-2">
      <div className="track" style={n}>
        {labels.map((_, i) => (
          <span key={i} className={cx('seg-bar', i < done && (i === done - 1 && tone === 'warning' ? 'is-warn' : i === done - 1 && tone === 'danger' ? 'is-danger' : 'is-done'))}>
            {i === done - 1 && tone === 'warning' && <span className="sr-only">At risk: </span>}
          </span>
        ))}
      </div>
      <div className="track-labels" style={n}>
        {labels.map((l, i) => (
          <span key={i} className={cx(i === done - 1 && 'is-current')}>
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface TimelineEvent {
  t: ReactNode;
  d?: ReactNode;
  state?: 'done' | 'current' | 'warn' | 'danger' | '';
  body?: ReactNode;
}

/** Vertical event timeline (.timeline). */
export function Timeline({ events, className }: { events: TimelineEvent[]; className?: string }) {
  return (
    <ol className={cx('timeline', className)}>
      {events.map((e, i) => (
        <li key={i} className={cx('ev', e.state && `is-${e.state}`)}>
          {e.state === 'warn' && <span className="sr-only">At risk: </span>}
          <span className="dot" aria-hidden="true" />
          <div className="stack gap-1">
            <span className="t">{e.t}</span>
            {e.d && <span className="d">{e.d}</span>}
            {e.body && <div className="small sub">{e.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ---------------- Data display ---------------- */

/** Key/value list (.kv). */
export function KeyValue({ pairs, className }: { pairs: Array<[ReactNode, ReactNode]>; className?: string }) {
  return (
    <dl className={cx('kv', className)}>
      {pairs.map(([k, v], i) => (
        <Fragment key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Summary row (totals): label left, value right. className: discount | total | … */
export function SummaryRow({ k, v, className }: { k: ReactNode; v: ReactNode; className?: string }) {
  return (
    <div className={cx('sum-row', className)}>
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
}

/** KPI tile content (.stat). dir drives the arrow; good/bad overrides the colour. */
export function Stat({ label, value, delta, dir, good, note, icon }: { label: ReactNode; value: ReactNode; delta?: ReactNode; dir?: 'up' | 'down'; good?: boolean; note?: ReactNode; icon?: IconName }) {
  return (
    <div className="stat">
      <span className="k">
        {icon && <Icon name={icon} className="ic-sm" />}
        {label}
      </span>
      <span className="v">{value}</span>
      {(delta || note) && (
        <span className={cx('d', dir, good === true && 'good', good === false && 'bad')}>
          {delta && dir && <span aria-hidden="true">{dir === 'down' ? '▼ ' : '▲ '}</span>}
          {delta && dir && <span className="sr-only">{dir} </span>}
          {delta}
          {delta && note ? ' · ' : ''}
          {note}
        </span>
      )}
    </div>
  );
}

const ALERT_ICONS: Record<string, IconName> = { info: 'info', success: 'circle-check', warning: 'triangle-alert', danger: 'circle-alert', brand: 'sparkles' };

/** Inline alert (.alert). Danger/warning are announced (role=alert). */
export function Alert({ tone, title, icon, className, children }: { tone: 'info' | 'success' | 'warning' | 'danger' | 'brand'; title?: ReactNode; icon?: IconName; className?: string; children?: ReactNode }) {
  return (
    <div className={cx('alert', `t-${tone}`, className)} role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}>
      <Icon name={icon ?? ALERT_ICONS[tone] ?? 'info'} />
      <div className="stack gap-1 grow">
        {title && <span className="alert-title">{title}</span>}
        {children && <span>{children}</span>}
      </div>
    </div>
  );
}

/** Empty state: icon ring, title, text and an action. */
export function EmptyState({ icon, title, children, action, as: H = 'h3' }: { icon: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode; as?: ElementType }) {
  return (
    <div className="empty">
      <span className="ring">
        <Icon name={icon} />
      </span>
      <H className="h3">{title}</H>
      {children && <p className="small muted measure-md">{children}</p>}
      {action}
    </div>
  );
}

/** Deadline chip (dispatch-by, reply-by). */
export function Deadline({ tone = 'ok', children }: { tone?: 'ok' | 'warning' | 'danger'; children: ReactNode }) {
  return (
    <span className={cx('deadline', `t-${tone}`)}>
      <Icon name={tone === 'danger' ? 'alarm-clock' : 'clock'} />
      {children}
    </span>
  );
}

/* ---------------- Lists: website pages vs app lazy loading ---------------- */

/** Phone (Android app) list footer: skeletons + "Loading more", or the end-of-list note. */
export function LazyLoad({ grid, end }: { grid?: boolean; end?: boolean }) {
  if (end) {
    return (
      <div className="lazy-load only-phone is-end" role="status">
        <Icon name="circle-check" className="ic-sm" />
        <span>You've reached the end</span>
      </div>
    );
  }
  return (
    <div className="lazy-load only-phone" role="status" aria-live="polite">
      {grid ? (
        <div className="sk-grid" aria-hidden="true">
          {[0, 1].map((i) => (
            <div className="sk-card" key={i}>
              <span className="sk sk-img" />
              <span className="sk sk-line" />
              <span className="sk sk-line short" />
            </div>
          ))}
        </div>
      ) : (
        <div className="sk-list" aria-hidden="true">
          {[0, 1].map((i) => (
            <div className="sk-row" key={i}>
              <span className="sk sk-thumb" />
              <span className="sk-lines">
                <span className="sk sk-line" />
                <span className="sk sk-line short" />
              </span>
            </div>
          ))}
        </div>
      )}
      <span className="lazy-note">
        <span className="spinner" aria-hidden="true" />
        Loading more
      </span>
    </div>
  );
}

/**
 * List paging for both platforms: numbered pages on the website (tablet/desktop) and
 * lazy loading on the phone app. Controlled with page/onPage, or self-contained.
 */
export function Pager({ page = 1, total = 8, onPage, grid, end, only }: { page?: number; total?: number; onPage?: (p: number) => void; grid?: boolean; end?: boolean; /** Render only the website page numbers or only the phone lazy-load row. */ only?: 'website' | 'phone' }) {
  const nums: Array<number | '…'> = total <= 5 ? Array.from({ length: total }, (_, i) => i + 1) : page <= 3 ? [1, 2, 3, '…', total] : page >= total - 2 ? [1, '…', total - 2, total - 1, total] : [1, '…', page, '…', total];
  const go = (p: number) => onPage?.(Math.min(total, Math.max(1, p)));
  return (
    <>
      {only !== 'website' && <LazyLoad grid={grid} end={end} />}
      {only !== 'phone' && (
      <nav className="pager no-phone" aria-label="Pagination">
        <a href="#" aria-label="Previous page" onClick={(e) => (e.preventDefault(), go(page - 1))}>
          <Icon name="chevron-left" className="ic-sm" />
        </a>
        {nums.map((n, i) =>
          n === '…' ? (
            <span key={`e${i}`}>…</span>
          ) : (
            <a key={n} className={cx(n === page && 'is-active')} href="#" aria-current={n === page ? 'page' : undefined} onClick={(e) => (e.preventDefault(), go(n))}>
              {n}
            </a>
          ),
        )}
        <a href="#" aria-label="Next page" onClick={(e) => (e.preventDefault(), go(page + 1))}>
          <Icon name="chevron-right" className="ic-sm" />
        </a>
      </nav>
      )}
    </>
  );
}

/* ---------------- Tables ---------------- */

/**
 * Horizontally scrollable table region (.table-wrap). Adds the scroll cues (.is-scrollable,
 * .at-start, .at-end) that drive the edge fade and the pinned (.col-pin) column shadow.
 */
export function TableWrap({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  const ref = useScrollRegion<HTMLDivElement>();
  return (
    <div className={cx('table-wrap', className)} role="region" aria-label={label} ref={ref} data-scroll-region="">
      {children}
    </div>
  );
}

/** Legend for colour-only cues (row edges, coloured counts), REVIEW #4. */
export function StatusLegend({ kind = 'edge', items }: { kind?: 'edge' | 'number'; items: Array<{ tone: 'danger' | 'warning'; label: ReactNode }> }) {
  return (
    <p className={cx('status-legend', `status-legend--${kind}`)}>
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

/** Search field inside toolbars (.search-in). */
export function SearchInput({ id, placeholder, value, defaultValue, onChange, label, className }: { id: string; placeholder: string; value?: string; defaultValue?: string; onChange?: (v: string) => void; label?: string; className?: string }) {
  return (
    <label className={cx('search-in', className)} htmlFor={id}>
      <Icon name="search" className="ic-sm" />
      {label && <span className="sr-only">{label}</span>}
      <input id={id} type="search" placeholder={placeholder} value={value} defaultValue={defaultValue} onChange={onChange ? (e) => onChange(e.target.value) : undefined} />
    </label>
  );
}

/**
 * <details> that is open on tablet/desktop and starts closed on the phone layout
 * (design: data-phone-collapse).
 */
export function PhoneCollapse({ summary, className, summaryClassName, children }: { summary: ReactNode; className?: string; summaryClassName?: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (ref.current && window.matchMedia('(max-width: 767.98px)').matches) ref.current.open = false;
  }, []);
  return (
    <details ref={ref} className={className} open data-phone-collapse="">
      <summary className={summaryClassName}>{summary}</summary>
      {children}
    </details>
  );
}
