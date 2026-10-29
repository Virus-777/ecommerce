import type { Store } from '../../kernel/store/index.js';
import type { OperationRow, OperationState, UploadRow } from './ports.js';

/**
 * The backups module's two tables: operations and uploads. Written against `ctx.store`, so the module's data
 * runs in either database (docs/10 §10.5); every read here is a key, a list or a sort, so there is nothing
 * this module needs a per-store query for.
 *
 * What a *backup* is made of is another question entirely, and not this module's: the dump and restore
 * commands are the server's backup service (deploy/linux), reached through BACKUP_OPS_DIR, and they change
 * with the database at the cutover (docs/10 §23 Y4) rather than here.
 */
export class BackupsRepository {
  readonly #operations;
  readonly #uploads;

  constructor(private readonly store: Store) {
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
    return this.#operations.find({ state: [...states], ...(kinds ? { kind: [...kinds] } : {}) }, { sort: { requested_at: 1, id: 1 } });
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
