import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { DayPicker, type DateRange } from 'react-day-picker';
import 'react-day-picker/style.css';
import { useSearchParams } from 'react-router';
import { cx } from '../lib/cx';
import { dayKey } from '../lib/dates';
import { usePopoverPosition } from '../lib/hooks';
import {
  COMPARE_LABEL, DEFAULT_PRESETS, GRAIN_LABEL, MAX_RANGE_DAYS, PRESET_LABEL, addDays, daysIn, grainAllowed, rangeLabel, readPeriod, writePeriod,
  type DayRange, type Period, type PeriodChange, type PeriodCompare, type PeriodDefaults, type PeriodGrain, type PeriodPreset,
} from '../lib/period';
import { Button } from './Button';
import { Select } from './Forms';
import { Icon } from './Icon';

// The one period control of every statistics page (docs/09 §4.1): a preset (or a custom range picked on a
// calendar), the grain (day / week / month; no day past 92 days) and the comparison. The state lives in the URL
// (?preset=&from=&to=&grain=&compare=) so a period can be linked and survives reloads; usePeriod() reads it and
// gives the ReportQuery fields: `{ ...period.query }` in the query body.

export type { Period, PeriodCompare, PeriodGrain, PeriodPreset, PeriodQuery } from '../lib/period';

/** The page's period from the URL, and a setter. Call it once per page and pass the result to PeriodControl. */
export function usePeriod(defaults: PeriodDefaults = {}): Period & { set: (change: PeriodChange) => void } {
  const [params, setParams] = useSearchParams();
  const today = dayKey(new Date());
  const { preset: dp, compare: dc } = defaults;
  const period = useMemo(() => readPeriod(params, today, { preset: dp, compare: dc }), [params, today, dp, dc]);
  const set = (change: PeriodChange) => setParams((p) => writePeriod(p, readPeriod(p, today, { preset: dp, compare: dc }), change, { preset: dp, compare: dc }), { replace: true, preventScrollReset: true });
  return { ...period, set };
}

export interface PeriodControlProps {
  period: Period & { set: (change: PeriodChange) => void };
  /** Presets to offer (default: Today … 12 months and Custom). */
  presets?: PeriodPreset[];
  /** Hide the grain switch (pages whose report has no series). */
  noGrain?: boolean;
  /** Hide the comparison choice. */
  noCompare?: boolean;
  /** Prefix for element ids when a page has two controls. */
  idPrefix?: string;
  className?: string;
}

export function PeriodControl({ period, presets = DEFAULT_PRESETS, noGrain, noCompare, idPrefix = 'period', className }: PeriodControlProps) {
  const options = presets.includes(period.preset) ? presets : [...presets, period.preset];
  return (
    <div className={cx('period-control', className)} role="group" aria-label="Period">
      <label className="sr-only" htmlFor={`${idPrefix}-preset`}>
        Period
      </label>
      <Select
        id={`${idPrefix}-preset`}
        ctl="sm"
        options={options.map((p) => ({ value: p, label: PRESET_LABEL[p] }))}
        value={period.preset}
        onChange={(e) => period.set({ preset: e.target.value as PeriodPreset, range: period.range })}
      />
      {period.preset === 'custom' ? (
        <DateRangeField id={`${idPrefix}-range`} value={period.range} onChange={(range) => period.set({ preset: 'custom', range })} />
      ) : (
        <span className="period-range xs muted">{period.label}</span>
      )}
      {!noGrain && (
        <div className="seg period-grain" role="group" aria-label="Show per">
          {(Object.keys(GRAIN_LABEL) as PeriodGrain[]).map((g) => {
            const ok = grainAllowed(g, period.days);
            return (
              <button key={g} type="button" className={cx(g === period.grain && 'is-active')} aria-pressed={g === period.grain} disabled={!ok} title={ok ? undefined : 'Too many days to show one by one'} onClick={() => period.set({ grain: g })}>
                {GRAIN_LABEL[g]}
              </button>
            );
          })}
        </div>
      )}
      {!noCompare && (
        <>
          <label className="sr-only" htmlFor={`${idPrefix}-compare`}>
            Compare with
          </label>
          <Select
            id={`${idPrefix}-compare`}
            ctl="sm"
            options={(Object.keys(COMPARE_LABEL) as PeriodCompare[]).map((c) => ({ value: c, label: COMPARE_LABEL[c] }))}
            value={period.compare}
            onChange={(e) => period.set({ compare: e.target.value as PeriodCompare })}
          />
        </>
      )}
    </div>
  );
}

/* ----- custom range: a field that opens a range calendar (react-day-picker, the DateTimeField styles) ----- */

const toDate = (d: string) => new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const toDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function DateRangeField({ id, value, onChange }: { id: string; value: DayRange; onChange: (r: DayRange) => void }) {
  const popId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>();
  const wrap = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const pos = usePopoverPosition(open, group, pop);
  const today = dayKey(new Date());

  const show = () => {
    setDraft({ from: toDate(value.from), to: toDate(value.to) });
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const picked = draft?.from ? { from: toDay(draft.from), to: toDay(draft.to ?? draft.from) } : null;
  const tooLong = !!picked && daysIn(picked) > MAX_RANGE_DAYS;
  const apply = () => {
    if (!picked || tooLong) return;
    onChange(picked);
    close();
  };

  // a press outside the field and its panel closes the panel without applying
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && close(false);
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <div className="dtp period-dates" ref={wrap} onKeyDown={onKey}>
      <span ref={group} className="input-group dtp-field">
        <Icon name="calendar" className="ic-sm" />
        <button ref={trigger} type="button" id={id} className="dtp-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popId : undefined} aria-label={`Dates: ${rangeLabel(value)}`} onClick={() => (open ? close() : show())}>
          {rangeLabel(value)}
        </button>
      </span>
      {open && (
        <div ref={pop} id={popId} className="dtp-pop" role="dialog" aria-label="Choose the first and last day" style={pos}>
          <DayPicker
            mode="range"
            selected={draft}
            onSelect={setDraft}
            defaultMonth={draft?.to ?? toDate(today)}
            disabled={{ after: toDate(today), before: toDate(addDays(today, -(MAX_RANGE_DAYS * 2))) }}
            showOutsideDays
            navLayout="after"
            autoFocus
          />
          <div className="dtp-foot">
            <span className={cx('xs grow', tooLong ? 't-danger-text' : 'muted')}>{!picked ? 'Pick the first day' : tooLong ? `At most ${MAX_RANGE_DAYS} days` : `${rangeLabel(picked)} · ${daysIn(picked)} day${daysIn(picked) === 1 ? '' : 's'}`}</span>
            <Button variant="ghost" size="sm" onClick={() => close()}>
              Cancel
            </Button>
            <Button size="sm" onClick={apply} disabled={!picked || tooLong}>
              Apply
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
