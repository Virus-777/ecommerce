/**
 * The maintainer's views (docs/10-mysql-migration.md §9.1–9.2, docs/MAINTAINING.md).
 *
 * One person maintains this server, offline, with no second pair of eyes. When something looks wrong the first
 * move is a SELECT, and the shapes below are the five questions that get asked: what is this order, what does a
 * seller have coming, what is on the shelf, what is the queue doing, who changed what. Without them each answer
 * is a join over tables named `<module>_<table>` whose keys have to be remembered correctly under pressure.
 *
 * They differ from the module views of §9.2 in three ways, and each is deliberate:
 *
 *  - **They cross modules.** A module view joins its own tables only (§6.2), because a module can be switched off
 *    and must not break another. These are not read by any module's code, so that rule does not apply to them.
 *  - **They are skipped rather than failed when a table is missing.** A switched-off module's tables do not
 *    exist, and `CREATE VIEW` over a missing table is an error. Migrate creates the ones it can and says which it
 *    left out, so a server running half the modules still gets the views for that half.
 *  - **They are not asked to merge.** A module view is a join shape in the path of a request, so §9.1 insists
 *    MySQL folds it into the reading query. These answer one question for one person at a keyboard; what matters
 *    is that the SQL is right, not that the plan is optimal.
 */
import type { PoolConnection } from 'mysql2/promise';

export interface OpsView {
  name: string;
  /** Every table it reads: all of them must exist, or the view is skipped */
  needs: readonly string[];
  sql: string;
  desc: string;
}

export const OPS_VIEWS: readonly OpsView[] = [
  {
    name: 'ops_v_orders',
    needs: ['orders_orders'],
    desc: 'One row per order: who it is for, what it came to, where it got to',
    sql: `SELECT o.\`ref\`, o.\`id\`, o.\`placed_at\`, o.\`lifecycle\`, o.\`display_status\`, o.\`channel\`,
       o.\`contact_name\`, o.\`contact_email\`, o.\`contact_phone\`, o.\`customer_id\`,
       o.\`currency\`, o.\`items_total\`, o.\`discount_total\`, o.\`shipping_total\`, o.\`tax_total\`, o.\`total\`,
       o.\`payment_state\`, o.\`payment_method_label\`, o.\`captured_total\`, o.\`refunded_total\`,
       o.\`accepted_at\`, o.\`completed_at\`
FROM \`orders_orders\` o`,
  },
  {
    name: 'ops_v_seller_money',
    needs: ['finance_seller_accounts'],
    desc: "A seller's account: pending, available and held, and why payouts are stopped if they are",
    sql: `SELECT a.\`seller_id\`, a.\`currency\`, a.\`pending\`, a.\`available\`, a.\`held\`,
       a.\`negative_since\`, a.\`payouts_blocked_reason\`, a.\`new_seller_until\`, a.\`updated_at\`
FROM \`finance_seller_accounts\` a`,
  },
  {
    name: 'ops_v_stock',
    needs: ['inventory_stock_levels', 'inventory_stock_items', 'inventory_locations'],
    desc: 'One stock item at one location: what is on hand, reserved, incoming, held',
    sql: `SELECT si.\`sku\`, si.\`label\`, si.\`condition\`, si.\`owner_type\`, si.\`seller_id\`,
       l.\`code\` AS \`location_code\`, l.\`name\` AS \`location_name\`, l.\`sellable\`,
       sl.\`available\`, sl.\`reserved\`, sl.\`incoming\`, sl.\`damaged_held\`, sl.\`returned\`,
       si.\`low_stock_threshold\`, si.\`primary_bin_code\`, si.\`archived\`, sl.\`updated_at\`
FROM \`inventory_stock_levels\` sl
JOIN \`inventory_stock_items\` si ON si.\`id\` = sl.\`stock_item_id\`
JOIN \`inventory_locations\` l ON l.\`id\` = sl.\`location_id\``,
  },
  {
    name: 'ops_v_jobs',
    needs: ['kernel_jobs', 'kernel_job_schedules'],
    desc: 'The job queue as it stands: state, when it is due, how many attempts, the last error',
    sql: `SELECT j.\`name\`, j.\`state\`, j.\`run_at\`, j.\`attempts\`, j.\`max_attempts\`,
       j.\`lease_until\`, j.\`started_at\`, j.\`finished_at\`, j.\`error\`, j.\`created_at\`, j.\`id\`,
       s.\`schedule\`, s.\`next_run_at\`
FROM \`kernel_jobs\` j
LEFT JOIN \`kernel_job_schedules\` s ON s.\`job\` = j.\`name\``,
  },
  {
    name: 'ops_v_audit_recent',
    needs: ['audit_entries'],
    desc: 'The audit trail, newest first: who did what to which thing, and why',
    sql: `SELECT e.\`at\`, e.\`seq\`, e.\`actor_kind\`, e.\`actor_name\`, e.\`action_label\`, e.\`action\`,
       e.\`module\`, e.\`category\`, e.\`target_type\`, e.\`target_label\`, e.\`target_ref\`, e.\`target_id\`,
       e.\`seller_id\`, e.\`reason\`, e.\`approval_request_id\`, e.\`request_id\`, e.\`ip\`, e.\`id\`
FROM \`audit_entries\` e`,
  },
];

/**
 * Creates the maintainer views whose tables are all present, and answers the names of the ones left out.
 *
 * `needs` names every table the view reads, kernel tables included — a list that is almost right is worse than
 * none, because the view it wrongly keeps is the one that stops the migration.
 */
export async function createOpsViews(conn: PoolConnection, existingTables: ReadonlySet<string>): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const view of OPS_VIEWS) {
    const missing = view.needs.filter((t) => !existingTables.has(t));
    if (missing.length) {
      skipped.push(`${view.name} (no ${missing.join(', ')})`);
      continue;
    }
    await conn.query(`CREATE OR REPLACE SQL SECURITY INVOKER VIEW \`${view.name}\` AS\n${view.sql}`);
    created.push(view.name);
  }
  return { created, skipped };
}
