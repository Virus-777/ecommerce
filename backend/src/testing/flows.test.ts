/**
 * flows.code: 2-step codes for staff step-up. The server accepts the current 30-second step or one either side
 * (identity domain/crypto.ts verifyTotp) and never a step already used. The code must be made at the clock time the
 * request is checked at, or a code made at the end of a step lands two steps behind and is refused (STEP_UP_REQUIRED).
 */
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { flows, type Staff } from './flows.js';
import { totp } from './totp.js';

const STEP = 30_000;
const staff: Staff = { accountId: 'a', key: 'JBSWY3DPEHPK3PXP', accessToken: 't' };
const noApp = { kernel: { events: { subscribe() {} } } } as unknown as FastifyInstance;

function fixedClock(at: number) {
  let t = at;
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}

/** The steps the server accepts for a check at `at`: the code must be one of them */
const accepted = (at: number) => [at - STEP, at, at + STEP].map((t) => totp(staff.key, new Date(t)));

describe('flows.code', () => {
  it('is accepted when made in the last millisecond of a step and checked a little later', () => {
    const boundary = Math.ceil(Date.UTC(2026, 9, 11, 12) / STEP) * STEP;
    const clock = fixedClock(boundary - 1);
    const f = flows(noApp, clock);
    const code = f.code(staff);
    const checkedAt = clock.now().getTime() + 5; // the request reaches the server 5 ms later
    expect(accepted(checkedAt)).toContain(code);
  });

  it('gives every code its own step, so the server never sees a step reused', () => {
    const clock = fixedClock(Date.UTC(2026, 9, 11, 12, 0, 10));
    const f = flows(noApp, clock);
    const steps = Array.from({ length: 4 }, () => {
      f.code(staff);
      return Math.floor(clock.now().getTime() / STEP);
    });
    expect(new Set(steps).size).toBe(4);
  });
});
