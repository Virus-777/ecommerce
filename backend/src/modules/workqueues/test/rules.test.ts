import { describe, expect, it } from 'vitest';
import type { EscalationStep } from '../../../spec/workqueues.js';
import { ageLabel, conditionApplies, coverageGaps, deadlineState, durationLabel, escalationLabel, nextStep, oldestLabel, parseDuration, routeIssues, runsOn } from '../domain/rules.js';
import { PLACEHOLDER_BACKUP, PLACEHOLDER_LEAD } from '../domain/catalog.js';

const now = new Date('2026-10-09T17:00:00Z');
const step = (afterMinutes: number, key: string, condition?: string, notify = true): EscalationStep => ({ afterMinutes, to: { kind: 'role', key, name: key }, condition, notify });

describe('deadline and labels', () => {
  it('moves on_time → due_soon → overdue', () => {
    expect(deadlineState(new Date(now.getTime() + 2 * 3_600_000), now, 60)).toBe('on_time');
    expect(deadlineState(new Date(now.getTime() + 30 * 60_000), now, 60)).toBe('due_soon');
    expect(deadlineState(now, now, 60)).toBe('overdue');
  });

  it('labels ages and durations', () => {
    expect(ageLabel(new Date(now.getTime() - 16 * 86_400_000), now)).toBe('16 d');
    expect(ageLabel(new Date(now.getTime() - 5 * 3_600_000), now)).toBe('5 h');
    expect(oldestLabel(new Date(now.getTime() - 2 * 86_400_000), now)).toBe('oldest 2 days');
    expect(durationLabel(2880)).toBe('48 h');
    expect(durationLabel(43200)).toBe('30 d');
    expect(durationLabel(90)).toBe('90 min');
  });

  it('parses durations of saved filters', () => {
    expect(parseDuration('24h')).toBe(1440);
    expect(parseDuration('1h30m')).toBe(90);
    expect(parseDuration('2d')).toBe(2880);
    expect(parseDuration('45')).toBe(45);
    expect(parseDuration('soon')).toBeNull();
  });
});

describe('escalation routes', () => {
  const route = [step(0, 'seller_manager', 'seller items only'), step(240, 'order_manager'), step(2880, 'business_owner')];

  it('reads as a label', () => {
    expect(escalationLabel(route)).toBe('seller_manager (seller items only), order_manager after 4 h, business_owner after 48 h');
    expect(routeIssues([])).toHaveLength(1);
    expect(routeIssues([{ afterMinutes: -1, to: { kind: 'team' }, notify: true }])).toHaveLength(2);
  });

  it('applies conditions', () => {
    expect(conditionApplies('seller items only', { sellerId: 'x', amountMinor: null, priority: 'normal' })).toBe(true);
    expect(conditionApplies('seller items only', { sellerId: null, amountMinor: null, priority: 'normal' })).toBe(false);
    expect(conditionApplies('amount over $1,000', { sellerId: null, amountMinor: 100_001, priority: 'normal' })).toBe(true);
    expect(conditionApplies('amount over $1,000', { sellerId: null, amountMinor: 100_000, priority: 'normal' })).toBe(false);
    expect(conditionApplies('urgent only', { sellerId: null, amountMinor: null, priority: 'urgent' })).toBe(true);
  });

  it('finds the next step reached (sweep) or the next one at all (manual), skipping steps whose condition fails', () => {
    const seller = { sellerId: 's', amountMinor: null, priority: 'normal' };
    const official = { sellerId: null, amountMinor: null, priority: 'normal' };
    expect(nextStep(route, 0, seller, 0)?.level).toBe(1);
    expect(nextStep(route, 1, seller, 100)).toBeNull();
    expect(nextStep(route, 1, seller, 240)?.level).toBe(2);
    expect(nextStep(route, 0, official, 0)).toBeNull();
    expect(nextStep(route, 0, official)?.level).toBe(2);
    expect(nextStep(route, 3, seller)).toBeNull();
  });
});

describe('coverage gaps and weekdays', () => {
  it('reports placeholders, lead = backup, a lead away without cover and one backup for many queues', () => {
    const staff = new Map([
      ['a', { known: true, away: true, name: 'Ann' }],
      ['b', { known: true, away: true, name: 'Ben' }],
      ['c', { known: true, away: false, name: 'Cy' }],
    ]);
    const q = (key: string, leadId: string, backupId: string) => ({ key, name: key, leadId, backupId, active: true });
    const gaps = coverageGaps([q('p', PLACEHOLDER_LEAD, PLACEHOLDER_BACKUP), q('same', 'c', 'c'), q('away', 'a', 'b'), q('m1', 'a', 'c'), q('m2', 'b', 'c'), q('m3', 'a', 'c'), { ...q('off', 'x', 'y'), active: false }], staff);
    const problems = (key: string) => gaps.filter((g) => g.queueKey === key).map((g) => g.problem);
    expect(problems('p')).toEqual(['no_lead', 'no_backup']);
    expect(problems('same')).toContain('lead_is_backup');
    expect(problems('away')).toEqual(['lead_away_no_cover']);
    expect(problems('m1')).toEqual(['same_backup_for_many']);
    expect(problems('off')).toEqual([]);
  });

  it('runs templates on ISO weekdays (0 also means Sunday)', () => {
    expect(runsOn([5], '2026-10-09')).toBe(true); // Friday
    expect(runsOn([0], '2026-10-11')).toBe(true); // Sunday
    expect(runsOn([1, 2, 3, 4, 5], '2026-10-10')).toBe(false);
  });
});
