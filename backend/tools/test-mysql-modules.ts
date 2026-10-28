/**
 * Runs the test suite with the pilot modules' data in **MySQL** instead of MongoDB (docs/10-mysql-migration.md
 * §10.5a). A store-neutral module has to pass its own tests either way, and this is how that is known rather
 * than argued: the same files, the same assertions, the other database.
 *
 *   npm run test:mysql-modules                              # the whole suite, the pilots on MySQL
 *   npm run test:mysql-modules -- src/modules/settings      # part of it
 *   TEST_MYSQL_MODULES=access npm run test:mysql-modules    # another set of modules
 *
 * Combine it with the 8.0 gate by hand when a release is near: `npm run test:mysql80` reads the same variable
 * (it passes the environment through), so `TEST_MYSQL_MODULES=settings npm run test:mysql80` is the pilots on
 * the version the server actually runs.
 */
import { spawnSync } from 'node:child_process';

/** The modules this run keeps in MySQL. Each pilot joins the list as it is converted */
const MODULES = process.env.TEST_MYSQL_MODULES || 'settings';

console.log(`running the suite with these modules' data in MySQL: ${MODULES}\n`);

const r = spawnSync('npx', ['vitest', 'run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, TEST_MYSQL_MODULES: MODULES },
});
process.exit(r.status ?? 1);
