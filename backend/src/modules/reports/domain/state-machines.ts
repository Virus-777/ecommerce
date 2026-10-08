/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/reports.js';

/** Metric definition: MetricDefinition.status. Revising a published metric creates a new draft version; the published version stays in use until the new one is published with an effective date. Reports always state the definitions version they used. */
export const metricDefinitionMachine = createStateMachine("Metric definition", spec.stateMachines["Metric definition"]);

/** Export job: ExportJob.state. Only the requester can download; the link expires after exportLinkHours and the file is deleted. Every export is audited with dataset, filters, row count and excluded columns. */
export const exportJobMachine = createStateMachine("Export job", spec.stateMachines["Export job"]);

/** Metric suggestion: MetricSuggestion.state. Accepting opens a new draft version of the metric for its owner. */
export const metricSuggestionMachine = createStateMachine("Metric suggestion", spec.stateMachines["Metric suggestion"]);
