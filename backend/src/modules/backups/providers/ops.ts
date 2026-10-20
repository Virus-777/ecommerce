/**
 * The server's backup service through files (deploy/linux/ops.sh is the other side):
 *
 *   BACKUP_DIR/<id>.archive.gz | .media.tar.gz | .config.tar.gz | .manifest.json   backups (read only here)
 *   BACKUP_OPS_DIR/requests/<operation id>.json   what the web asks (written here, atomically)
 *   BACKUP_OPS_DIR/status/<operation id>.json     what the service did (read here)
 *   BACKUP_OPS_DIR/schedule.json                  the schedule the service applied (read here)
 *   BACKUP_UPLOAD_DIR/<upload id>/                uploaded backups (written here; the service moves them on restore)
 *
 * The web process never runs a backup, a restore or a command: the root service does, and treats every request
 * file as untrusted. The settings and keys file (<id>.config.tar.gz) is root-only on the server: it can be seen in
 * the folder listing but not read, and it is never offered for download.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isUuid } from '../../../kernel/lib/ids.js';
import { BACKUP_FILE, byNewest, DOWNLOADABLE_FILE, fileNames } from '../domain/rules.js';
import { UploadTooLarge, type AppliedSchedule, type BackupOnDisk, type BackupOps, type OpsRequest, type OpsStatus } from '../ports.js';

const UPLOAD_FILE = { database: 'database.archive.gz', files: 'files.media.tar.gz' } as const;
const KINDS = new Set(['nightly', 'manual', 'safety', 'uploaded']);

const missing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null; // missing, unreadable or half-written: as if it weren't there yet
  }
}

/** The path of `name` inside `dir`, refusing anything that would leave it */
function inside(dir: string, name: string): string {
  const root = resolve(dir);
  const p = resolve(root, name);
  if (p !== root && !p.startsWith(root + sep)) throw new Error(`backups: ${name} is outside ${dir}`);
  return p;
}

export function fileOps(o: { dir: string; opsDir: string; uploadDir: string }): BackupOps {
  const requests = join(o.opsDir, 'requests');
  const statuses = join(o.opsDir, 'status');
  return {
    available: true,
    unavailableReason: null,

    async listBackups() {
      let names: string[];
      try {
        names = await readdir(o.dir);
      } catch (err) {
        if (missing(err)) return [];
        throw err;
      }
      const ids = new Map<string, Set<string>>();
      for (const n of names) {
        const m = BACKUP_FILE.exec(n);
        if (!m) continue;
        if (!ids.has(m[1]!)) ids.set(m[1]!, new Set());
        ids.get(m[1]!)!.add(m[2]!);
      }
      const out: BackupOnDisk[] = [];
      for (const [id, parts] of ids) {
        if (!parts.has('archive.gz')) continue; // a backup is its database file; the rest is optional
        const f = fileNames(id);
        const db = await stat(join(o.dir, f.database)).catch(() => null);
        if (!db) continue;
        const media = parts.has('media.tar.gz') ? await stat(join(o.dir, f.files)).catch(() => null) : null;
        const manifest = parts.has('manifest.json') ? await readJson<{ createdAt?: string; kind?: string; operationId?: string }>(join(o.dir, f.manifest)) : null;
        const created = manifest?.createdAt ? new Date(manifest.createdAt) : db.mtime;
        out.push({
          id,
          createdAt: Number.isNaN(created.getTime()) ? db.mtime : created,
          kind: id.endsWith('-uploaded') ? 'uploaded' : manifest?.kind && KINDS.has(manifest.kind) ? (manifest.kind as BackupOnDisk['kind']) : 'nightly',
          database: { name: f.database, sizeBytes: db.size },
          files: media ? { name: f.files, sizeBytes: media.size } : null,
          hasSettingsAndKeys: parts.has('config.tar.gz'),
          operationId: manifest?.operationId && isUuid(manifest.operationId) ? manifest.operationId : null,
        });
      }
      return out.sort(byNewest);
    },

    async openBackupFile(name, range) {
      if (!DOWNLOADABLE_FILE.test(name)) return null;
      const p = inside(o.dir, name);
      const s = await stat(p).catch(() => null);
      if (!s?.isFile()) return null;
      return { stream: createReadStream(p, range ? { start: range.start, end: range.end } : {}), sizeBytes: s.size, modifiedAt: s.mtime };
    },

    async writeRequest(request: OpsRequest) {
      if (!isUuid(request.id)) throw new Error('backups: a request needs a uuid id');
      await mkdir(requests, { recursive: true });
      // the service picks up *.json only: write aside, then rename (atomic on one file system)
      const tmp = join(requests, `.${request.id}.tmp`);
      await writeFile(tmp, `${JSON.stringify(request)}\n`, { mode: 0o640 });
      await rename(tmp, join(requests, `${request.id}.json`));
    },

    async readStatuses() {
      let names: string[];
      try {
        names = await readdir(statuses);
      } catch (err) {
        if (missing(err)) return [];
        throw err;
      }
      const out: OpsStatus[] = [];
      for (const n of names) {
        if (!/^[0-9a-f-]{36}\.json$/i.test(n)) continue;
        const s = await readJson<OpsStatus>(join(statuses, n));
        if (s && isUuid(s.id) && `${s.id}.json`.toLowerCase() === n.toLowerCase()) out.push(s);
      }
      return out;
    },

    readSchedule: () => readJson<AppliedSchedule>(join(o.opsDir, 'schedule.json')),

    async receiveUpload(uploadId, part, body, maxBytes) {
      if (!isUuid(uploadId)) throw new Error('backups: an upload needs a uuid id');
      const dir = inside(o.uploadDir, uploadId);
      await mkdir(dir, { recursive: true });
      const final = join(dir, UPLOAD_FILE[part]);
      const tmp = `${final}.part`;
      let size = 0;
      let head = Buffer.alloc(0);
      const count = new Transform({
        transform(chunk: Buffer, _enc, done) {
          size += chunk.length;
          if (head.length < 2) head = Buffer.concat([head, chunk.subarray(0, 2 - head.length)]);
          if (size > maxBytes) done(new UploadTooLarge(`more than ${maxBytes} bytes`));
          else done(null, chunk);
        },
      });
      try {
        await pipeline(body, count, createWriteStream(tmp, { mode: 0o640 }));
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
      // every file the backup service writes is gzip (1f 8b); anything else is not one of its backups
      const gzip = head.length === 2 && head[0] === 0x1f && head[1] === 0x8b;
      if (!gzip) {
        await unlink(tmp).catch(() => {});
        return { sizeBytes: size, gzip };
      }
      await rename(tmp, final);
      return { sizeBytes: size, gzip };
    },

    async removeUpload(uploadId) {
      if (!isUuid(uploadId)) return;
      await rm(inside(o.uploadDir, uploadId), { recursive: true, force: true });
    },
  };
}

/** Where the server has no backup service (development machines): nothing to list, every action refused */
export function unavailableOps(reason: string): BackupOps {
  const refuse = async () => {
    throw new Error(`backups: ${reason}`);
  };
  return {
    available: false,
    unavailableReason: reason,
    listBackups: async () => [],
    openBackupFile: async () => null,
    writeRequest: refuse,
    readStatuses: async () => [],
    readSchedule: async () => null,
    receiveUpload: refuse,
    removeUpload: async () => {},
  };
}

export const uploadFileName = (part: 'database' | 'files') => UPLOAD_FILE[part];
