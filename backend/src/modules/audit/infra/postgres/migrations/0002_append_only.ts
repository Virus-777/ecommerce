import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Entries are append-only (spec: "cannot be edited or deleted by anyone; only purged after retention").
 * Production also withholds UPDATE/DELETE grants from the app role; this trigger enforces the same rule
 * wherever the app runs. Only the purge job may delete, inside a transaction that sets audit.purging.
 */
export const m0002AppendOnly: Migration = {
  id: '0002_append_only',
  sql: /* sql */ `
create function audit.entries_append_only() returns trigger language plpgsql as $fn$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('audit.purging', true), '') = 'on' then
    return old;
  end if;
  raise exception 'audit.entries is append-only (% refused)', tg_op using errcode = '42501';
end
$fn$;
create trigger entries_append_only before update or delete on audit.entries
  for each row execute function audit.entries_append_only();
create trigger entries_no_truncate before truncate on audit.entries
  for each statement execute function audit.entries_append_only();
`,
};
