/**
 * The flows in the order they run; each builds on what the earlier ones made (sim.world). `needs` names the
 * flows whose output a flow uses: when one of them failed, the flow is skipped instead of failing on missing data.
 */
import type { Sim } from '../sim.js';
import { adminReadsFlow, screensFlow } from './admin.js';
import { cancellationFlow, messagesFlow, returnFlow, reviewFlow, supportFlow, trustFlow } from './aftersales.js';
import { catalogFlow, officialStoreFlow, searchFlow } from './catalog.js';
import { fulfilmentFlow } from './fulfilment.js';
import { financeFlow, paymentsFlow } from './money.js';
import { sellersFlow } from './sellers.js';
import { customersFlow, promotionFlow } from './shopping.js';
import { staffFlow } from './staff.js';

export interface FlowDef {
  name: string;
  needs: string[];
  run(sim: Sim): Promise<void>;
}

export const FLOWS: FlowDef[] = [
  { name: '1 staff', needs: [], run: staffFlow },
  { name: '2 sellers', needs: ['1 staff'], run: sellersFlow },
  { name: '3a catalog', needs: ['2 sellers'], run: catalogFlow },
  { name: '3b official store', needs: ['1 staff'], run: officialStoreFlow },
  { name: '3c search', needs: ['3a catalog'], run: searchFlow },
  { name: '4a promotion', needs: ['1 staff'], run: promotionFlow },
  { name: '4b customers', needs: ['3a catalog'], run: customersFlow },
  { name: '5 fulfilment', needs: ['4b customers'], run: fulfilmentFlow },
  { name: '6a cancellation', needs: ['4b customers'], run: cancellationFlow },
  { name: '6b return', needs: ['5 fulfilment'], run: returnFlow },
  { name: '6c messages', needs: ['5 fulfilment'], run: messagesFlow },
  { name: '6d review', needs: ['5 fulfilment'], run: reviewFlow },
  { name: '6e support case', needs: ['4b customers'], run: supportFlow },
  { name: '6f trust report', needs: ['4b customers'], run: trustFlow },
  { name: '7a payments', needs: ['4b customers'], run: paymentsFlow },
  { name: '7b finance', needs: ['5 fulfilment'], run: financeFlow },
  { name: '8 admin reads', needs: ['4b customers'], run: adminReadsFlow },
  { name: '9 app screens (GraphQL)', needs: ['4b customers'], run: screensFlow },
];
