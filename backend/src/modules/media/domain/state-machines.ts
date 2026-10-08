/** Status flows from the spec (stateMachines). Illegal moves throw ILLEGAL_TRANSITION (409). */
import { createStateMachine } from '../../../kernel/lib/state-machine.js';
import { spec } from '../../../spec/media.js';

/** Asset: MediaAsset.status. complete is called by the client (POST /uploads/{id}/complete) or by the storage notification webhook, whichever comes first; size and sha256 are verified. fail covers malware, unreadable or mismatched files and hard limits (status rejected with rejectionReason). delete is refused while the asset has active usages (ASSET_IN_USE) or before retainUntil (ASSET_RETAINED). remove (staff takedown) works even when in use: public URLs serve a placeholder, the original stays private for evidence, and media.asset.removed tells the using modules. Storage objects of deleted assets are erased after deletedGraceDays. */
export const assetMachine = createStateMachine("Asset", spec.stateMachines["Asset"]);
