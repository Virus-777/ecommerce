/**
 * Seed data applied on boot (docs/04-mongodb-migration.md: every install starts from the seed in code).
 * Idempotent: a schedule with the example's version is never inserted twice, and its state (superseded once staff
 * publish a real schedule) is left as it is.
 */
import type { FulfillmentServiceRepository, ScheduleRec } from '../ports.js';
import { EXAMPLE_SCHEDULE } from './rules.js';

/** The example fee schedule in force until staff publish a real one (FeeSchedule.isExample) */
export const exampleScheduleRow = (): ScheduleRec => ({
  id: EXAMPLE_SCHEDULE.id,
  version: EXAMPLE_SCHEDULE.version,
  effective_at: new Date(EXAMPLE_SCHEDULE.effectiveAt),
  rates: EXAMPLE_SCHEDULE.rates,
  state: 'current',
  approval_request_id: null,
});

export async function seed(repo: FulfillmentServiceRepository): Promise<void> {
  await repo.insertIfNew('fee_schedules', exampleScheduleRow());
}
