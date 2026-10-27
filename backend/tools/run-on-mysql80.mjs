/**
 * Runs the test suite against MySQL 8.0 instead of 8.4 (docs/10-mysql-migration.md §19, §20.1).
 *
 * The production server runs Ubuntu's own `mysql-server-8.0`, so "it passes on 8.4" is not the question Y1
 * has to answer. This finds an unzipped 8.0 under ~/.cache/mysql, points MYSQLD_PATH at it, and runs the
 * suite; everything else — one server for the run, a database per worker — is unchanged.
 *
 *   npm run test:mysql80                 # the whole suite
 *   npm run test:mysql80 src/kernel      # part of it
 *
 * To make 8.0 available, unzip the MySQL Community Server 8.0 **ZIP Archive** (8.0.36 or later, never
 * 8.0.29) into ~/.cache/mysql, so that ~/.cache/mysql/mysql-8.0.xx-winx64/bin/mysqld exists beside the 8.4
 * one. Nothing else changes: the portable server picks the newest it finds unless MYSQLD_PATH says otherwise,
 * so 8.4 stays the default and 8.0 is what this script asks for.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EXE = process.platform === 'win32' ? 'mysqld.exe' : 'mysqld';
const cache = join(homedir(), '.cache', 'mysql');

const found = (existsSync(cache) ? readdirSync(cache) : [])
  .filter((dir) => /8\.0\./.test(dir) && existsSync(join(cache, dir, 'bin', EXE)))
  .sort();

const refused = found.filter((dir) => dir.includes('8.0.29'));
const usable = found.filter((dir) => !dir.includes('8.0.29'));

if (!usable.length) {
  console.error(
    `No MySQL 8.0 found under ${cache}.\n\n` +
      'The production server runs Ubuntu\'s mysql-server-8.0, so the suite has to pass on 8.0 as well as 8.4\n' +
      '(docs/10-mysql-migration.md §20.1). Unzip the MySQL Community Server 8.0 "ZIP Archive" — 8.0.36 or\n' +
      `later, never 8.0.29 — into ${cache}, so that\n` +
      `  ${join(cache, 'mysql-8.0.xx-winx64', 'bin', EXE)}\n` +
      'exists. Then run this again.' +
      (refused.length ? `\n\nFound ${refused.join(', ')}, which the backend refuses: its instant ADD COLUMN is broken.` : ''),
  );
  process.exit(1);
}

// the newest 8.0, so a machine with several only ever tests the one it would ship
const chosen = usable[usable.length - 1];
const mysqld = join(cache, chosen, 'bin', EXE);
console.log(`running the suite on ${chosen}\n`);

const args = process.argv.slice(2);
const r = spawnSync('npx', ['vitest', 'run', ...args], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, MYSQLD_PATH: mysqld },
});
process.exit(r.status ?? 1);
