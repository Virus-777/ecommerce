/**
 * Moderation outcomes are target states; the spec's machines only allow certain moves. walk() finds the
 * shortest chain of allowed events from the current state to the target (e.g. a published response is
 * rejected through edit → hold → reject), so every step is a transition the spec lists.
 */
import { AppError } from '../../../kernel/errors/index.js';
import type { StateMachine } from '../../../kernel/lib/state-machine.js';

export function walk<S extends string, E extends string>(machine: StateMachine<S, E>, from: S, to: S, allowed: readonly string[]): E[] {
  if (from === to) return [];
  const seen = new Set<string>([from]);
  const queue: { state: S; path: E[] }[] = [{ state: from, path: [] }];
  while (queue.length) {
    const { state, path } = queue.shift()!;
    for (const event of machine.eventsFrom(state)) {
      if (!allowed.includes(event)) continue;
      for (const next of machine.targets(state, event)) {
        if (seen.has(next)) continue;
        const p = [...path, event];
        if (next === to) return p;
        seen.add(next);
        queue.push({ state: next, path: p });
      }
    }
  }
  throw new AppError('ILLEGAL_TRANSITION', `${machine.name}: cannot move from "${from}" to "${to}"`, { machine: machine.name, from, to, allowed: machine.eventsFrom(from) });
}

/** Applies a chain of events, checking each step against the machine */
export function apply<S extends string, E extends string>(machine: StateMachine<S, E>, from: S, events: readonly E[]): S {
  return events.reduce<S>((s, e) => machine.next(s, e), from);
}

/** Events a moderator's decision may use (author-only events like submit, resubmit and delete are excluded) */
export const MODERATION_EVENTS = ['publish', 'hold', 'hide', 'keep', 'remove', 'requestEdit', 'reinstate', 'reject'] as const;
/** Seller responses have no direct way from published to rejected: the response is taken back first (edit) */
export const RESPONSE_MODERATION_EVENTS = [...MODERATION_EVENTS, 'edit'] as const;
/** An overturned appeal brings content back to published by any non-adverse path */
export const RESTORE_EVENTS = ['publish', 'keep', 'reinstate', 'resubmit', 'submit', 'edit'] as const;
