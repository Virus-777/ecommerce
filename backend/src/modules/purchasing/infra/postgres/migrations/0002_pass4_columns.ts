import type { Migration } from '../../../../../kernel/migrations/index.js';

/**
 * Gap pass 4.
 * 1. supplier_claims.supplier_reference: the supplier's reference, kept until now as a "Supplier reference: …" line
 *    in the claim notes. The last such line moves to the column and leaves the notes.
 * 2. suppliers.return_authorization_required: whether the supplier needs an RMA before units go back (unknown for
 *    existing suppliers: false, as getPreferredSupplier answered so far).
 */
export const m0002Pass4Columns: Migration = {
  id: '0002_pass4_columns',
  sql: /* sql */ `
alter table purchasing.supplier_claims add column supplier_reference text;
update purchasing.supplier_claims
  set supplier_reference = (
    select nullif(btrim(t.m[1]), '') from regexp_matches(notes, 'Supplier reference: ([^\\n]*)', 'g') with ordinality as t(m, n)
    order by t.n desc limit 1)
  where notes like '%Supplier reference: %';
update purchasing.supplier_claims
  set notes = nullif(btrim(regexp_replace(notes, '(^|\\n)Supplier reference: [^\\n]*', '', 'g'), E'\\n'), '')
  where supplier_reference is not null;

alter table purchasing.suppliers add column return_authorization_required bool not null default false;
alter table purchasing.suppliers alter column return_authorization_required drop default;
`,
};
