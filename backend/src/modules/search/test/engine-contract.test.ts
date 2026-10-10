/** The engine contract (engine-contract.ts) on the Postgres engine and on the OpenSearch adapter with the in-memory fake. */
import { engineContract } from './engine-contract.js';

engineContract('postgres');
engineContract('opensearch');
