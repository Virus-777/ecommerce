import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Fulfilled by Marketly (decision D12): fulfillment-service.warehouseAddress was removed; the inbound destination is
 * the service location's address (fulfillment-service.serviceLocationId). Its stored values go, and open changes no
 * longer hold its key. Its definition is marked unavailable by the definitions sync (no module declares it).
 */
export const m0004RemovedFsWarehouseAddress: Migration = {
  id: '0004_removed_fs_warehouse_address',
  sql: /* sql */ `
delete from settings.values where key = 'fulfillment-service.warehouseAddress';
delete from settings.change_keys where key = 'fulfillment-service.warehouseAddress';
`,
};
