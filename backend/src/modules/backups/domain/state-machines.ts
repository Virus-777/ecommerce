/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/backups.js';

/** Backup operation: BackupOperation.state. A restore starts in waiting_approval; a backup and a schedule change start queued. start, finish and fail come from the backup service's status file. */
export const backupOperationMachine = createStateMachine("Backup operation", spec.stateMachines["Backup operation"]);
