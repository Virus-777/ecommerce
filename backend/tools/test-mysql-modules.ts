/**
 * Runs the test suite with the pilot modules' data, and the kernel's own data, in **MySQL** instead of MongoDB
 * (docs/10-mysql-migration.md §10.5a, §12). A store-neutral module has to pass its own tests either way, and
 * this is how that is known rather than argued: the same files, the same assertions, the other database.
 *
 *   npm run test:mysql-modules                              # the whole suite, the pilots and the kernel on MySQL
 *   npm run test:mysql-modules -- src/modules/settings      # part of it
 *   TEST_MYSQL_MODULES=access npm run test:mysql-modules    # another set of modules
 *   TEST_KERNEL_STORE=mongo npm run test:mysql-modules      # the modules only, to tell the two apart
 *
 * Combine it with the 8.0 gate by hand when a release is near: `npm run test:mysql80` reads the same variables
 * (it passes the environment through), so `TEST_MYSQL_MODULES=settings npm run test:mysql80` is the pilots on
 * the version the server actually runs.
 */
import { spawnSync } from 'node:child_process';

/**
 * The modules this run keeps in MySQL: everything converted so far, so that a plain run is the whole of what
 * has moved. Y1's two pilots, then a tranche at a time (§23); the list ends as all forty at the cutover.
 */
const CONVERTED = ['settings', 'access', 'identity', 'audit', 'media', 'notifications', 'backups', 'customers'];
const MODULES = process.env.TEST_MYSQL_MODULES || CONVERTED.join(',');
/** And the kernel's own tables, unless this run is only about the modules */
const KERNEL = process.env.TEST_KERNEL_STORE || 'mysql';

console.log(`running the suite with these modules' data in MySQL: ${MODULES}`);
console.log(`the kernel's own data: ${KERNEL}\n`);

const r = spawnSync('npx', ['vitest', 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, TEST_MYSQL_MODULES: MODULES, TEST_KERNEL_STORE: KERNEL },
});
process.exit(r.status ?? 1);
