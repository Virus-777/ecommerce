/**
 * Runs the test suite against MySQL 8.0 instead of 8.4 (docs/10-mysql-migration.md §19, §20.1).
 *
 * The production server runs Ubuntu's own `mysql-server-8.0`, so "it passes on 8.4" is not the question Y1
 * has to answer. This finds an 8.0 on the machine, points `MYSQLD_PATH` at it and runs the suite; everything
 * else — one server for the run, a database per worker — is unchanged.
 *
 *   npm run test:mysql80                 # the whole suite
 *   npm run test:mysql80 src/kernel      # part of it
 *
 * It looks wherever `findMysqld` would: an unzipped build under `~/.cache/mysql` (the offline form — copy
 * the zip across once) and an installed server under `C:\Program Files\MySQL`, so a ZIP and an MSI install
 * both work. Candidates are sorted out by asking each one its **version**, not by reading the folder name:
 * an MSI installs into `MySQL Server 8.0`, which does not say whether it is 8.0.29 (refused) or 8.0.45.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MYSQL_FLOOR, MYSQL_REFUSED, parseVersion } from '../src/kernel/mysql/portable.js';

const EXE = process.platform === 'win32' ? 'mysqld.exe' : 'mysqld';
const CACHE = join(homedir(), '.cache', 'mysql');

/** Every mysqld on this machine, wherever the portable server would look for one */
function candidates(): string[] {
  const dirs: string[] = [];
  const under = (root: string) => {
    if (!existsSync(root)) return;
    for (const d of readdirSync(root)) {
      const exe = join(root, d, 'bin', EXE);
      if (existsSync(exe)) dirs.push(exe);
    }
  };
  under(CACHE);
  if (process.platform === 'win32') under(join(process.env.ProgramFiles ?? 'C:\\Program Files', 'MySQL'));
  else for (const p of ['/usr/sbin/mysqld', '/usr/local/mysql/bin/mysqld', '/opt/homebrew/opt/mysql/bin/mysqld']) if (existsSync(p)) dirs.push(p);
  return dirs;
}

const versionOf = (mysqld: string): [number, number, number] | undefined => {
  const r = spawnSync(mysqld, ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? parseVersion(`${r.stdout}${r.stderr}`) : undefined;
};

const found = candidates()
  .map((mysqld) => ({ mysqld, version: versionOf(mysqld) }))
  .filter((c): c is { mysqld: string; version: [number, number, number] } => Boolean(c.version));

const eightOh = found.filter((c) => c.version[0] === 8 && c.version[1] === 0);
const text = (v: readonly number[]) => v.join('.');
const usable = eightOh
  .filter((c) => text(c.version) !== MYSQL_REFUSED && c.version[2] >= MYSQL_FLOOR[2])
  .sort((a, b) => a.version[2] - b.version[2]);

if (!usable.length) {
  const rejected = eightOh.map((c) => `  ${text(c.version)} at ${c.mysqld} — ${text(c.version) === MYSQL_REFUSED ? 'refused: its instant ADD COLUMN is broken' : `older than the ${MYSQL_FLOOR.join('.')} floor`}`);
  console.error(
    `No usable MySQL 8.0 on this machine.\n\n` +
      "The production server runs Ubuntu's mysql-server-8.0, so the suite has to pass on 8.0 as well as 8.4\n" +
      `(docs/10-mysql-migration.md §20.1). Get MySQL 8.0 — ${MYSQL_FLOOR.join('.')} or later, never ${MYSQL_REFUSED} — either way:\n\n` +
      `  · the ZIP Archive, unzipped into ${CACHE}\n` +
      `    so that ${join(CACHE, 'mysql-8.0.xx-winx64', 'bin', EXE)} exists; or\n` +
      `  · the MSI installer, which puts it under ${join(process.env.ProgramFiles ?? 'C:\\Program Files', 'MySQL')}.\n\n` +
      'The ZIP is tidier for this: the suite starts its own server on its own port and data directory, so the\n' +
      'Windows service an MSI installs would sit there unused.' +
      (rejected.length ? `\n\nFound but not usable:\n${rejected.join('\n')}` : '') +
      (found.length ? `\n\nAlso on the machine: ${found.map((c) => text(c.version)).join(', ')}.` : ''),
  );
  process.exit(1);
}

// the newest 8.0, so a machine with several only tests the one it would ship
const chosen = usable[usable.length - 1]!;
console.log(`running the suite on MySQL ${text(chosen.version)}\n  ${chosen.mysqld}\n`);

const r = spawnSync('npx', ['vitest', 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, MYSQLD_PATH: chosen.mysqld },
});
process.exit(r.status ?? 1);
