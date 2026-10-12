/**
 * The embedded replica set (development without MONGODB_URI, tests) runs a mongod binary. mongodb-memory-server
 * downloads one on first use; when MongoDB is installed in its standard place, that one is used instead
 * (MONGOMS_SYSTEM_BINARY, unless already set).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = process.platform === 'win32' ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'MongoDB', 'Server')] : ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];

/** An installed mongod (newest server version on Windows), if any */
export function installedMongod(): string | undefined {
  if (process.platform !== 'win32') return ROOTS.map((r) => join(r, 'mongod')).find((p) => existsSync(p));
  const root = ROOTS[0]!;
  if (!existsSync(root)) return undefined;
  const versions = readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return versions.map((v) => join(root, v, 'bin', 'mongod.exe')).find((p) => existsSync(p));
}

/** Points mongodb-memory-server at an installed mongod when no binary was chosen */
export function useInstalledMongod(): void {
  if (process.env.MONGOMS_SYSTEM_BINARY) return;
  const found = installedMongod();
  if (found) process.env.MONGOMS_SYSTEM_BINARY = found;
}
