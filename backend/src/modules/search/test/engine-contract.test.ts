/** The engine contract (engine-contract.ts) on the MongoDB engine and on the OpenSearch adapter with the in-memory fake. */
import { engineContract } from './engine-contract.js';

engineContract('mongo');
engineContract('opensearch');
