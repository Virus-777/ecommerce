import { describeModule } from '../../testing/module-suite.js';

// Boots warehouse with its dependencies on the in-memory MongoDB and checks it against its spec:
// routes, auth, collections and wiring. Add behaviour tests below as the module is built.
describeModule('warehouse');
