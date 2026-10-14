#!/usr/bin/env tsx
/**
 * npm run package [-- --admin <admin-center/dist>]
 *
 * Builds a release for the offline Linux server (deploy/linux/README.md) on a computer with internet access:
 *
 *   release/marketly-<version>-<commit>/        dist/ (server + production tools, compiled)
 *                                               package.json, package-lock.json
 *                                               node_modules/ (production dependencies only: npm ci --omit=dev)
 *                                               deploy/linux/ (install, certificate, backup and check scripts)
 *                                               .env.production.example
 *                                               admin/ (the built Admin Center, or a placeholder page)
 *                                               RELEASE (name, commit, date)
 *   release/marketly-<version>-<commit>.tar.gz  the same folder, to copy to the server
 *
 * The dependencies are plain JavaScript (no compiled add-ons), so node_modules installed here on Windows runs on
 * Linux. They are installed inside the release folder only; the project's own node_modules is not touched.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { backendDir } from './lib/spec.js';

const { values } = parseArgs({ options: { admin: { type: 'string' } } });

/** Runs a command (npm, tar), showing its output; stops on failure */
function run(command: string, args: string[], cwd: string) {
  // npm: the npm that runs this script (npm_execpath, its JavaScript entry) with this node; npm.cmd on Windows
  // would need a shell
  const npm = command === 'npm' && process.env.npm_execpath ? [process.execPath, [process.env.npm_execpath, ...args]] as const : undefined;
  const r = npm ? spawnSync(npm[0], npm[1], { cwd, stdio: 'inherit' }) : spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm' });
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${r.status ?? r.signal})`);
}

function output(command: string, args: string[], cwd: string): string {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** Total size of a folder in bytes */
function sizeOf(path: string): number {
  const s = statSync(path);
  if (!s.isDirectory()) return s.size;
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0);
}
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Shell scripts and systemd units must have Unix line endings, or bash and systemd fail on the server */
function checkLineEndings(dir: string) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) checkLineEndings(file);
    else if (readFileSync(file).includes(13)) throw new Error(`${relative(backendDir, file)} has Windows line endings (CRLF); .gitattributes asks git for LF: re-check it out (git rm --cached -r deploy && git checkout -- deploy)`);
  }
}

const pkg = JSON.parse(readFileSync(join(backendDir, 'package.json'), 'utf8')) as { version: string };
const commit = output('git', ['rev-parse', '--short', 'HEAD'], backendDir) || 'nogit';
// uncommitted changes in the backend make a release no commit can reproduce: say so in its name
const dirty = output('git', ['status', '--porcelain', '--', '.'], backendDir) ? '-dirty' : '';
const name = `marketly-${pkg.version}-${commit}${dirty}`;
const releases = join(backendDir, 'release');
const out = join(releases, name);
const adminDir = values.admin ? resolve(values.admin) : undefined;
if (adminDir && !existsSync(join(adminDir, 'index.html'))) {
  console.error(`--admin ${adminDir} has no index.html: build the Admin Center first (npm run build in admin-center) and pass its dist folder.`);
  process.exit(1);
}

checkLineEndings(join(backendDir, 'deploy', 'linux'));
console.log(`Building ${name} …`);
run('npm', ['run', 'build'], backendDir);

rmSync(out, { recursive: true, force: true });
rmSync(`${out}.tar.gz`, { force: true });
mkdirSync(out, { recursive: true });
for (const item of ['dist', 'package.json', 'package-lock.json', '.env.production.example', join('deploy', 'linux')]) {
  cpSync(join(backendDir, item), join(out, item), { recursive: true });
}

console.log('Installing the production dependencies into the release (npm ci --omit=dev) …');
// --ignore-scripts: no install script of any dependency runs (none is needed: plain JavaScript)
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], out);

if (adminDir) cpSync(adminDir, join(out, 'admin'), { recursive: true });
else {
  // the server refuses to start without ADMIN_APP_DIR/index.html: a page that says what is missing
  mkdirSync(join(out, 'admin'), { recursive: true });
  writeFileSync(
    join(out, 'admin', 'index.html'),
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Marketly</title>' +
      '<p>This Marketly release was packaged without the Admin Center. Build it (<code>npm run build</code> in admin-center) and package again with ' +
      '<code>npm run package -- --admin &lt;admin-center/dist&gt;</code>.</p></html>\n',
  );
}
writeFileSync(join(out, 'RELEASE'), `name=${name}\nversion=${pkg.version}\ncommit=${commit}${dirty}\nbuilt=${new Date().toISOString()}\nadmin=${adminDir ? 'included' : 'placeholder'}\n`);

console.log('Packing …');
// tar is built into Windows 10+ and Linux; -C keeps the paths relative (marketly-…/dist/…)
run('tar', ['-czf', `${name}.tar.gz`, name], releases);

console.log(`
Release ${name}
  folder   ${out} (${mb(sizeOf(out))})
  archive  ${out}.tar.gz (${mb(statSync(`${out}.tar.gz`).size)})
  Admin Center: ${adminDir ? `included from ${adminDir}` : 'NOT included (placeholder page); add it with --admin <admin-center/dist>'}

Next (deploy/linux/README.md):
  1. Copy ${name}.tar.gz to the server (USB stick, scp on the LAN).
  2. On the server:  tar -xzf ${name}.tar.gz && sudo bash ${name}/deploy/linux/install.sh
  3. First install only: the certificate and the first owners, as the README says (steps 5 to 7).
`);
