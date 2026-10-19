import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/style.css';
import { cx } from '../lib/cx';
import { Button } from './Button';
import { Icon } from './Icon';

/*
 * Date and time field: a calendar (react-day-picker) next to a list of times, in a panel under the field. The value
 * is a wall time "YYYY-MM-DDTHH:mm" with no time zone, the same string as <input type="datetime-local">, so callers
 * convert it with the time zone they show (Content: the section's time zone).
 *
 * The panel is position: fixed inside the field's own markup (not a portal), so it is not clipped by a scrolling
 * drawer and stays inside the drawer's dialog for focus and screen readers. Escape closes the panel only.
 */

const pad = (n: number) => String(n).padStart(2, '0');

interface Wall {
  date: Date;
  /** minutes after midnight */
  minutes: number;
}

function parse(v: string | null | undefined): Wall | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v ?? '');
  return m ? { date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), minutes: Number(m[4]) * 60 + Number(m[5]) } : null;
}
const toValue = (date: Date, minutes: number) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const timeLabel = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  return `${h % 12 || 12}:${pad(minutes % 60)} ${h < 12 ? 'AM' : 'PM'}`;
};
const dateLabel = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const startOfToday = () => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
};

const POP_GAP = 6;
const EDGE = 8;

interface DateTimeFieldProps {
  id: string;
  /** "" or "YYYY-MM-DDTHH:mm" */
  value: string;
  onChange: (value: string) => void;
  /** Times must be later than this (same format), e.g. a removal time after the start. Earlier days are disabled. */
  after?: string;
  /** Minutes between the listed times (default 15) */
  step?: number;
  placeholder?: string;
  error?: boolean;
  disabled?: boolean;
  /** Set by Field */
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

export function DateTimeField({ id, value, onChange, after, step = 15, placeholder = 'Pick a date and time', error, disabled, ...aria }: DateTimeFieldProps) {
  const popId = useId();
  const sel = parse(value);
  const min = parse(after);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState<Date>(() => sel?.date ?? startOfToday());
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });
  const wrap = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // the day a time is set on: the chosen day, else the earliest allowed day, else today
  const day = sel?.date ?? (min && min.date > startOfToday() ? min.date : startOfToday());
  const tooEarly = (d: Date, minutes: number) => !!min && (d < min.date || (sameDay(d, min.date) && minutes <= min.minutes));
  const slots = [...new Set([...Array.from({ length: Math.ceil(1440 / step) }, (_, i) => i * step), ...(sel ? [sel.minutes] : [])])].sort((a, b) => a - b);
  const enabled = slots.filter((m) => !tooEarly(day, m));

  /** A time for a newly picked day: the current time kept, else the next free slot today, else 9:00 AM */
  const defaultMinutes = (d: Date) => {
    const now = new Date();
    const base = sel?.minutes ?? (sameDay(d, now) ? Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / step) * step : 9 * 60);
    const ok = (m: number) => m < 1440 && !tooEarly(d, m);
    if (ok(base)) return base;
    return slots.find((m) => m > base && ok(m)) ?? slots.find(ok) ?? base;
  };

  const show = () => {
    setMonth(sel?.date ?? (min && min.date > startOfToday() ? min.date : startOfToday()));
    setPos({ visibility: 'hidden' });
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  const pickDate = (d: Date | undefined) => d && onChange(toValue(d, defaultMinutes(d)));
  const pickTime = (minutes: number) => !tooEarly(day, minutes) && onChange(toValue(day, minutes));

  // place the panel under the field (above it when there is no room), inside the viewport
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = group.current?.getBoundingClientRect();
      const p = pop.current;
      if (!r || !p) return;
      const w = Math.min(p.offsetWidth, window.innerWidth - 2 * EDGE);
      const h = p.offsetHeight;
      const below = r.bottom + POP_GAP;
      const top = below + h > window.innerHeight - EDGE && r.top - POP_GAP - h >= EDGE ? r.top - POP_GAP - h : Math.max(EDGE, Math.min(below, window.innerHeight - EDGE - h));
      const left = Math.max(EDGE, Math.min(r.right - w, window.innerWidth - EDGE - w));
      setPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // a press outside the field and its panel closes the panel
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && close(false);
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [open]);

  // show the chosen time (or 9:00 AM) in the middle of the time list
  useLayoutEffect(() => {
    if (!open || !list.current) return;
    const target = list.current.querySelector<HTMLElement>('[aria-selected="true"]') ?? list.current.querySelector<HTMLElement>(`[data-m="${9 * 60}"]`);
    if (target) list.current.scrollTop = target.offsetTop - list.current.clientHeight / 2 + target.offsetHeight / 2;
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      // the panel only: a surrounding drawer or dialog stays open
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = sel ? enabled.indexOf(sel.minutes) : -1;
    const go = (j: number) => {
      e.preventDefault();
      const m = enabled[Math.max(0, Math.min(enabled.length - 1, j))];
      if (m === undefined) return;
      pickTime(m);
      list.current?.querySelector<HTMLElement>(`[data-m="${m}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') go(i < 0 ? Math.max(0, enabled.findIndex((m) => m >= 9 * 60)) : i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? Math.max(0, enabled.findIndex((m) => m >= 9 * 60)) : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(enabled.length - 1);
    else if (e.key === 'Enter' && sel) {
      e.preventDefault();
      close();
    }
  };

  return (
    <div
      className="dtp"
      ref={wrap}
      onKeyDown={onKey}
      // Tab out of the field and its panel closes the panel (a press elsewhere is handled above)
      onBlur={(e) => open && e.relatedTarget && !wrap.current?.contains(e.relatedTarget as Node) && close(false)}
    >
      <span ref={group} className={cx('input-group dtp-field', error && 'is-error', disabled && 'is-disabled')}>
        <Icon name="calendar" className="ic-sm" />
        <button
          ref={trigger}
          type="button"
          id={id}
          className="dtp-trigger"
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popId : undefined}
          aria-describedby={aria['aria-describedby']}
          aria-invalid={aria['aria-invalid'] || error || undefined}
          onClick={() => (open ? close() : show())}
        >
          {sel ? `${dateLabel(sel.date)}, ${timeLabel(sel.minutes)}` : <span className="dtp-ph">{placeholder}</span>}
        </button>
        {sel && !disabled && (
          <button type="button" className="input-picker" aria-label="Clear the date and time" onClick={() => onChange('')}>
            <Icon name="x" className="ic-sm" />
          </button>
        )}
      </span>
      {open && (
        <div ref={pop} id={popId} className="dtp-pop" role="dialog" aria-label="Choose a date and time" style={pos}>
          <div className="dtp-body">
            <DayPicker
              mode="single"
              required
              selected={sel?.date}
              onSelect={pickDate}
              month={month}
              onMonthChange={setMonth}
              disabled={min ? { before: min.date } : undefined}
              showOutsideDays
              navLayout="after"
              autoFocus
            />
            <div className="dtp-times">
              <span className="dtp-times-h" id={`${popId}-t`}>
                <Icon name="clock" className="ic-sm" /> Time
              </span>
              <div ref={list} className="dtp-list" role="listbox" tabIndex={0} aria-labelledby={`${popId}-t`} aria-activedescendant={sel ? `${popId}-m${sel.minutes}` : undefined} onKeyDown={onListKey}>
                {slots.map((m) => {
                  const off = tooEarly(day, m);
                  return (
                    <div key={m} id={`${popId}-m${m}`} data-m={m} role="option" aria-selected={sel?.minutes === m} aria-disabled={off || undefined} className={cx('dtp-slot', sel?.minutes === m && 'is-on', off && 'is-off')} onClick={() => pickTime(m)}>
                      {timeLabel(m)}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="dtp-foot">
            <span className="xs muted grow">{sel ? `${dateLabel(sel.date)}, ${timeLabel(sel.minutes)}` : 'No date chosen'}</span>
            {sel && (
              <Button variant="ghost" size="sm" onClick={() => onChange('')}>
                Clear
              </Button>
            )}
            <Button size="sm" onClick={() => close()}>
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
