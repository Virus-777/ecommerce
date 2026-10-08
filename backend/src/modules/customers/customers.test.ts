import { describeModule } from '../../testing/module-suite.js';

// Boots customers with its dependencies on in-memory PostgreSQL and checks it against its spec:
// routes, auth, tables and wiring. Add behaviour tests below as the module is built.
describeModule('customers');
