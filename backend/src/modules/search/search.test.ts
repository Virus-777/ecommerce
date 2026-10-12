import { describeModule } from '../../testing/module-suite.js';

// Boots search with its dependencies on in-memory MongoDB and checks it against its spec:
// routes, auth, tables and wiring. Add behaviour tests below as the module is built.
describeModule('search');
