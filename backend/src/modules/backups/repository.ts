import type { ModuleStore } from '../../kernel/mongo/index.js';
import type { OperationRow, OperationState, UploadRow } from './ports.js';

/**
 * The backups module's collections: backups.operations, backups.uploads. One Table per spec table
 * (store.table(name)); the kernel helpers are listed in backend/docs/BUILDING-MODULES.md §5b.
 */
export class BackupsRepository {
  readonly #operations;
  readonly #uploads;

  constructor(private readonly store: ModuleStore) {
    this.#operations = store.table<OperationRow>('operations');
    this.#uploads = store.table<UploadRow>('uploads');
  }

  /** fn with a repository bound to one transaction */
  transaction<T>(fn: (tx: BackupsRepository) => Promise<T>): Promise<T> {
    return this.store.transaction((tx) => fn(new BackupsRepository(tx)));
  }

  /** Serialises the transactions that start an operation (one backup or restore at a time) */
  lockOperations() {
    return this.store.lock('backups.operations');
  }

  getOperation(id: string, o?: { forUpdate?: boolean }) {
    return this.#operations.get(id, o);
  }

  operationByApproval(approvalRequestId: string) {
    return this.#operations.findOne({ approval_request_id: approvalRequestId });
  }

  operationsIn(states: readonly OperationState[], kinds?: readonly OperationRow['kind'][]) {
    return this.#operations.find({ state: { $in: [...states] }, ...(kinds ? { kind: { $in: [...kinds] } } : {}) }, { sort: { requested_at: 1, id: 1 } });
  }

  recentOperations(limit: number) {
    return this.#operations.find({}, { sort: { requested_at: -1, id: -1 }, limit });
  }

  operationsByIds(ids: readonly string[]) {
    return this.#operations.getMany(ids);
  }

  insertOperation(row: OperationRow) {
    return this.#operations.insert(row);
  }

  /** A row a restore removed, rebuilt from the service's status file (left as it is when it exists) */
  insertOperationIfAbsent(row: OperationRow) {
    return this.#operations.insertIfAbsent(row);
  }

  updateOperation(id: string, patch: Partial<OperationRow>) {
    return this.#operations.update(id, patch);
  }

  getUpload(id: string, o?: { forUpdate?: boolean }) {
    return this.#uploads.get(id, o);
  }

  listUploads() {
    return this.#uploads.find({}, { sort: { created_at: -1, id: -1 } });
  }

  insertUpload(row: UploadRow) {
    return this.#uploads.insert(row);
  }

  updateUpload(id: string, patch: Partial<UploadRow>) {
    return this.#uploads.update(id, patch);
  }

  deleteUpload(id: string) {
    return this.#uploads.delete(id);
  }
}
