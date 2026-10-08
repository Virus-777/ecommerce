/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/search.js';

/** Reindex job: ReindexJob.state. One full reindex at a time (REINDEX_ALREADY_RUNNING). Scoped jobs only mark documents dirty. The live index keeps serving during a full rebuild (new rows swap in per product). */
export const reindexJobMachine = createStateMachine("Reindex job", spec.stateMachines["Reindex job"]);
