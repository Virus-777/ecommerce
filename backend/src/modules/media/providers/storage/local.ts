/**
 * Local file-system storage (MEDIA_STORAGE=local, the default outside tests): the production store,
 * files on the server's disk under MEDIA_STORAGE_DIR (default .data/media).
 *
 *   <dir>/<bucket>/<key>              the bytes (buckets are folders, key segments sub-folders)
 *   <dir>/.meta/<bucket>/<key>.json   content type, etag (md5), sha256 and version of each object
 *   <dir>/.tmp/                       writes in progress
 *
 * - Keys are checked (keys.ts) and every path is resolved and confirmed inside <dir>: no key reaches
 *   another bucket, the metadata or anything outside the folder.
 * - Writes are atomic: the bytes stream into a temp file in <dir>/.tmp (same file system), are flushed,
 *   then renamed over the object; readers see the old file or the new one, never a partial one. The
 *   metadata follows the same way, just after the bytes.
 * - Large files stream in both directions (putStream, open) and are never held in memory; putStream
 *   stops reading as soon as more than maxBytes arrive and stores nothing.
 * - Uploads and downloads go through the API (viaApi): PUT /api/{area}/media/uploads/{id}/content and
 *   signed GET /files/{bucket}/{key} links (links.ts), verified by the auth middleware.
 *
 * Back up <dir> with the database; on more than one server it must be a shared volume.
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { InvalidObjectKeyError, ObjectTooLargeError, type OpenedObject, type StorageProvider, type StoredObject } from '../../ports.js';
import { checkKey, isValidBucket, isValidKey } from './keys.js';
import { DEFAULT_BUCKETS, fileLinks, type FileLinkOptions } from './links.js';

export interface LocalStorage extends StorageProvider {
  /** The absolute folder the objects live in */
  readonly dir: string;
}

interface Meta {
  contentType: string | null;
  etag: string;
  sha256: string | null;
  versionId: string | null;
}

const code = (err: unknown) => (err as NodeJS.ErrnoException)?.code;
const missing = (err: unknown) => ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(code(err) ?? '');

export function createLocalStorage(opts: {
  /** MEDIA_STORAGE_DIR */
  dir: string;
  /** Download links: the API's address and media's file-link key */
  links: Omit<FileLinkOptions, 'buckets'>;
  buckets?: { public: string; private: string };
}): LocalStorage {
  const buckets = opts.buckets ?? { ...DEFAULT_BUCKETS };
  const root = resolve(opts.dir);
  const tmpDir = join(root, '.tmp');
  const metaRoot = join(root, '.meta');

  /** A path under base built from checked segments, confirmed not to leave it */
  const inside = (base: string, bucket: string, key: string, parts: string[], suffix = '') => {
    const p = resolve(base, ...parts) + suffix;
    const rel = relative(base, p);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new InvalidObjectKeyError(bucket, key);
    return p;
  };
  const dataPath = (bucket: string, key: string) => inside(root, bucket, key, [bucket, ...checkKey(bucket, key)]);
  const metaPath = (bucket: string, key: string) => inside(metaRoot, bucket, key, [bucket, ...checkKey(bucket, key)], '.json');

  /**
   * rename over the target. Retried when a delete pruned the folder meanwhile. On Windows a file that is
   * open (a download in progress) can't be replaced, but it can be renamed: it moves aside to .tmp first
   * and is removed once the reader closes it; readers in between get 404 for a moment.
   */
  async function moveInto(from: string, to: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        await mkdir(dirname(to), { recursive: true });
        await rename(from, to);
        return;
      } catch (err) {
        const c = code(err) ?? '';
        if (attempt < 6 && ['EPERM', 'EBUSY', 'EACCES', 'ENOENT'].includes(c)) {
          if (c !== 'ENOENT' && attempt >= 1) {
            const aside = join(tmpDir, `${randomUUID()}.old`);
            if (await rename(to, aside).then(() => true, () => false)) {
              await rename(from, to).catch(async (e) => {
                await rename(aside, to).catch(() => {});
                await rm(from, { force: true }).catch(() => {});
                throw e;
              });
              await rm(aside, { force: true }).catch(() => {});
              return;
            }
          }
          await sleep(5 * 2 ** attempt);
          continue;
        }
        await rm(from, { force: true }).catch(() => {});
        throw err;
      }
    }
  }

  const tempFile = async () => {
    await mkdir(tmpDir, { recursive: true });
    return join(tmpDir, `${randomUUID()}.part`);
  };

  async function writeMeta(bucket: string, key: string, meta: Meta) {
    const tmp = await tempFile();
    await writeFile(tmp, JSON.stringify(meta));
    await moveInto(tmp, metaPath(bucket, key));
  }

  async function readMeta(bucket: string, key: string): Promise<Meta | null> {
    try {
      return JSON.parse(await readFile(metaPath(bucket, key), 'utf8')) as Meta;
    } catch (err) {
      if (err instanceof InvalidObjectKeyError) throw err;
      return null; // missing or unreadable: head() falls back to what the file itself tells
    }
  }

  /** Streams source into a temp file (hashing as it goes), then moves it over the object */
  async function writeObject(bucket: string, key: string, source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, contentType: string, maxBytes = Infinity): Promise<StoredObject> {
    const target = dataPath(bucket, key);
    const tmp = await tempFile();
    const md5 = createHash('md5');
    const sha = createHash('sha256');
    let size = 0;
    const fh = await open(tmp, 'wx');
    try {
      for await (const chunk of source) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new ObjectTooLargeError(maxBytes, size);
        md5.update(chunk);
        sha.update(chunk);
        for (let off = 0; off < chunk.byteLength; ) off += (await fh.write(chunk, off, chunk.byteLength - off)).bytesWritten;
      }
      await fh.sync();
    } catch (err) {
      await fh.close().catch(() => {});
      await rm(tmp, { force: true });
      throw err;
    }
    await fh.close();
    const meta: Meta = { contentType, etag: md5.digest('hex'), sha256: sha.digest('hex'), versionId: randomUUID() };
    await moveInto(tmp, target);
    await writeMeta(bucket, key, meta);
    return { sizeBytes: size, ...meta };
  }

  /** Removes now-empty folders from dir up to (not including) stop */
  async function prune(dir: string, stop: string) {
    while (dir.startsWith(stop) && dir !== stop) {
      try {
        await rmdir(dir);
      } catch {
        return; // not empty (or already gone)
      }
      dir = dirname(dir);
    }
  }

  const objectOf = (size: number, mtime: Date, meta: Meta | null): StoredObject => ({
    sizeBytes: size,
    etag: meta?.etag ?? `${size.toString(16)}-${Math.floor(mtime.getTime()).toString(16)}`,
    sha256: meta?.sha256 ?? null,
    versionId: meta?.versionId ?? null,
    contentType: meta?.contentType ?? null,
  });

  /** Keys of a bucket in ascending order: folders sort as "<name>/", which is exactly the order of the full keys */
  async function* walk(dir: string, base: string, prefix: string, after: string | undefined): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (missing(err)) return;
      throw err;
    }
    const items = entries
      .filter((e) => e.isFile() || e.isDirectory())
      .map((e) => ({ name: e.name, folder: e.isDirectory(), sort: e.isDirectory() ? `${e.name}/` : e.name }))
      .sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
    for (const item of items) {
      const key = base + item.name;
      if (item.folder) {
        const p = `${key}/`;
        if (!(p.startsWith(prefix) || prefix.startsWith(p))) continue;
        if (after && after > p && !after.startsWith(p)) continue; // every key below p sorts before `after`
        yield* walk(join(dir, item.name), p, prefix, after);
      } else if (isValidKey(key) && key.startsWith(prefix) && (!after || key > after)) {
        yield key;
      }
    }
  }

  return {
    buckets,
    viaApi: true,
    dir: root,
    ...fileLinks({ ...opts.links, buckets }),

    async head(bucket, key) {
      const path = dataPath(bucket, key);
      try {
        const st = await stat(path);
        if (!st.isFile()) return null;
        return objectOf(st.size, st.mtime, await readMeta(bucket, key));
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
    },

    async get(bucket, key) {
      try {
        return new Uint8Array(await readFile(dataPath(bucket, key)));
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
    },

    async put(bucket, key, body, contentType) {
      return writeObject(bucket, key, [body], contentType);
    },

    async putStream(bucket, key, body, contentType, o = {}) {
      return writeObject(bucket, key, body, contentType, o.maxBytes);
    },

    async open(bucket, key): Promise<OpenedObject | null> {
      const path = dataPath(bucket, key);
      let fh: FileHandle;
      try {
        fh = await open(path, 'r');
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
      try {
        const st = await fh.stat();
        if (!st.isFile()) {
          await fh.close();
          return null;
        }
        const meta = await readMeta(bucket, key);
        return {
          ...objectOf(st.size, st.mtime, meta),
          lastModified: st.mtime,
          // reads the file that was opened, even if a newer version replaces it meanwhile
          stream: (range) => fh.createReadStream({ autoClose: true, ...(range ? { start: range.start, end: range.end } : {}) }),
          close: () => fh.close(),
        };
      } catch (err) {
        await fh.close().catch(() => {});
        throw err;
      }
    },

    async copy(from, to) {
      const source = dataPath(from.bucket, from.key);
      const target = dataPath(to.bucket, to.key);
      const tmp = await tempFile();
      try {
        await copyFile(source, tmp);
      } catch (err) {
        await rm(tmp, { force: true });
        if (missing(err)) return false;
        throw err;
      }
      const meta = await readMeta(from.bucket, from.key);
      await moveInto(tmp, target);
      const st = await stat(target);
      await writeMeta(to.bucket, to.key, { ...(meta ?? { contentType: null, etag: objectOf(st.size, st.mtime, null).etag, sha256: null }), versionId: randomUUID() });
      return true;
    },

    async delete(bucket, key) {
      const path = dataPath(bucket, key);
      const metaFile = metaPath(bucket, key);
      await rm(path, { force: true });
      await rm(metaFile, { force: true });
      await prune(dirname(path), join(root, bucket));
      await prune(dirname(metaFile), join(metaRoot, bucket));
    },

    async list(bucket, { prefix = '', after, limit = 1000 } = {}) {
      if (!isValidBucket(bucket)) throw new InvalidObjectKeyError(bucket, prefix);
      const keys: string[] = [];
      if (limit <= 0) return keys;
      for await (const key of walk(join(root, bucket), '', prefix, after)) {
        keys.push(key);
        if (keys.length >= limit) break;
      }
      return keys;
    },
  };
}
