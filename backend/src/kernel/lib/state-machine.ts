/**
 * Explicit transition tables (architecture §5 "State machines"). The tables come from each
 * spec's `stateMachines`; an illegal move throws ILLEGAL_TRANSITION (409) with details.from and details.event.
 *
 * A few spec transitions are guarded: the same event leads to different states depending on the
 * record (e.g. Ad campaign `paused --resume--> live | scheduled`). For those the service passes the
 * target it chose, and the machine checks the choice is one the spec allows.
 */
import { AppError } from '../errors/index.js';
import type { StateMachineDef } from '../spec/define.js';

type StatesOf<D extends StateMachineDef> = D['transitions'][number][0] | D['transitions'][number][2];
type EventsOf<D extends StateMachineDef> = D['transitions'][number][1];

export interface StateMachine<S extends string, E extends string> {
  readonly name: string;
  /** Spec field the machine governs, e.g. Product.reviewState */
  readonly field: string;
  readonly initial: S;
  readonly states: readonly S[];
  readonly events: readonly E[];
  can(from: S, event: E): boolean;
  /** Allowed target states of an event (more than one only for guarded transitions) */
  targets(from: S, event: E): S[];
  /** The state after `event`, or throws ILLEGAL_TRANSITION. `to` is required when the event is guarded. */
  next(from: S, event: E, to?: S): S;
  /** Events allowed from a state (e.g. which action buttons to show) */
  eventsFrom(from: S): E[];
  isState(value: unknown): value is S;
}

export function createStateMachine<const D extends StateMachineDef>(name: string, def: D): StateMachine<StatesOf<D> & string, EventsOf<D> & string> {
  type S = StatesOf<D> & string;
  type E = EventsOf<D> & string;
  const table = new Map<string, S[]>();
  const states = new Set<S>();
  const events = new Set<E>();
  const key = (from: string, event: string) => `${from}\u0000${event}`;
  for (const [from, event, to] of def.transitions) {
    const list = table.get(key(from, event)) ?? [];
    if (!list.includes(to as S)) list.push(to as S);
    table.set(key(from, event), list);
    states.add(from as S).add(to as S);
    events.add(event as E);
  }
  const initial = (def.initial ?? def.transitions[0]?.[0]) as S;
  const machine: StateMachine<S, E> = {
    name,
    field: def.field,
    initial,
    states: [...states],
    events: [...events],
    can: (from, event) => table.has(key(from, event)),
    targets: (from, event) => [...(table.get(key(from, event)) ?? [])],
    next(from, event, to) {
      const targets = table.get(key(from, event));
      const illegal = (why: string) =>
        new AppError('ILLEGAL_TRANSITION', `${name}: ${why}`, { machine: name, from, event, ...(to ? { to } : {}), allowed: machine.eventsFrom(from) });
      if (!targets) throw illegal(`"${event}" is not allowed from "${from}"`);
      if (to !== undefined) {
        if (!targets.includes(to)) throw illegal(`"${event}" from "${from}" cannot lead to "${to}"`);
        return to;
      }
      if (targets.length > 1) throw new Error(`${name}: "${event}" from "${from}" is guarded (${targets.join(' | ')}); pass the target state`);
      return targets[0]!;
    },
    eventsFrom: (from) => [...events].filter((e) => table.has(key(from, e))),
    isState: (v): v is S => typeof v === 'string' && states.has(v as S),
  };
  return machine;
}
