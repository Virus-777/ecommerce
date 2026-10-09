/**
 * Performance math: raw counts from performance_events → metrics against targets, status and overall.
 */
import type { PerformanceMetric, PerformanceTarget } from '../../../spec/sellers.js';
import { METRIC_INFO, METRICS, targetDisplay, type MetricKey } from './catalogue.js';
import { pct } from './rules.js';

export interface PerformanceCounts {
  orders: number;
  units: number;
  dispatchedOnTime: number;
  dispatchedLate: number;
  trackingValid: number;
  trackingMissing: number;
  sellerCancelled: number;
  returns: number;
  replies: number;
  replyHoursTotal: number;
  unresolvedPastDeadline: number;
  violations: number;
}

export const emptyCounts = (): PerformanceCounts => ({
  orders: 0,
  units: 0,
  dispatchedOnTime: 0,
  dispatchedLate: 0,
  trackingValid: 0,
  trackingMissing: 0,
  sellerCancelled: 0,
  returns: 0,
  replies: 0,
  replyHoursTotal: 0,
  unresolvedPastDeadline: 0,
  violations: 0,
});

type Status = PerformanceMetric['status'];

/** meets / watch (met, close to the line) / below / action_needed (far off) */
export function metricStatus(value: number, t: { comparator: string; threshold: number; unit: string }): Status {
  const th = t.threshold;
  if (t.comparator === 'gte') {
    if (value >= th) return value < th + 1 && th < 100 ? 'watch' : 'meets';
    return value >= th - 5 ? 'below' : 'action_needed';
  }
  if (t.unit === 'count') {
    if (value <= th) return 'meets';
    return value <= th + 1 ? 'below' : 'action_needed';
  }
  if (value <= th) return th > 0 && value > th * 0.8 ? 'watch' : 'meets';
  return value <= th * 1.5 ? 'below' : 'action_needed';
}

export const isMiss = (s: Status) => s === 'below' || s === 'action_needed';

export function overallOf(statuses: readonly Status[]): 'good' | 'at_risk' | 'action_needed' {
  if (statuses.includes('action_needed')) return 'action_needed';
  if (statuses.includes('below')) return 'at_risk';
  return 'good';
}

const fmt = (v: number, unit: string) => (unit === 'percent' ? `${v}%` : unit === 'hours' ? `${v} h` : `${v}`);

/** Metric rows from counts and the targets in force (by metric key) */
export function computeMetrics(c: PerformanceCounts, targets: Record<MetricKey, PerformanceTarget>): PerformanceMetric[] {
  const dispatchDen = c.dispatchedOnTime + c.dispatchedLate;
  const trackingDen = c.trackingValid + c.trackingMissing;
  const rows: Record<MetricKey, { value: number; num: number | null; den: number | null; detail: string }> = {
    dispatch_reliability: {
      value: dispatchDen ? pct(c.dispatchedOnTime, dispatchDen) : 100,
      num: c.dispatchedOnTime,
      den: dispatchDen,
      detail: dispatchDen ? `${c.dispatchedOnTime} of ${dispatchDen} orders on time` : 'No dispatched orders yet',
    },
    cancellation_rate: {
      value: pct(c.sellerCancelled, c.orders),
      num: c.sellerCancelled,
      den: c.orders,
      detail: c.orders ? `${c.sellerCancelled} of ${c.orders} orders cancelled by the seller` : 'No orders yet',
    },
    valid_tracking: {
      value: trackingDen ? pct(c.trackingValid, trackingDen) : 100,
      num: c.trackingValid,
      den: trackingDen,
      detail: trackingDen ? `${c.trackingValid} of ${trackingDen} shipments with valid tracking` : 'No shipments yet',
    },
    return_rate: {
      value: pct(c.returns, c.orders),
      num: c.returns,
      den: c.orders,
      detail: c.orders ? `${c.returns} return requests for ${c.orders} orders` : 'No orders yet',
    },
    response_time: {
      value: c.replies ? Math.round((c.replyHoursTotal / c.replies) * 10) / 10 : 0,
      num: null,
      den: c.replies,
      detail: c.replies ? `Average over ${c.replies} replied conversations` : 'No buyer messages yet',
    },
    unresolved_cases: { value: c.unresolvedPastDeadline, num: c.unresolvedPastDeadline, den: null, detail: `${c.unresolvedPastDeadline} open past the deadline` },
    policy_violations: { value: c.violations, num: c.violations, den: null, detail: `${c.violations} confirmed in the window` },
  };
  return METRICS.map((key) => {
    const r = rows[key];
    const target = targets[key];
    return {
      key,
      label: METRIC_INFO[key].label,
      value: r.value,
      display: fmt(r.value, target.unit),
      target: { ...target, display: targetDisplay(target) },
      status: metricStatus(r.value, target),
      numerator: r.num,
      denominator: r.den,
      detail: r.detail,
      definition: METRIC_INFO[key].definition,
    };
  });
}
