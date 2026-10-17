import { useMutation } from '@tanstack/react-query';
import { call, useApi, type components } from '@marketly/web-shared/api';
import { Alert, Button } from '@marketly/web-shared/ui';
import type { Address } from './checkout-api';

// Address check before saving (POST /api/store/customers/addresses/validate), shared by Account › Addresses
// and the checkout address forms. The backend applies its format rules (ZIP, state, PO box, service region)
// and, when an address provider is configured, returns a normalised suggestion. Offline there is no provider:
// the answer then only carries format issues and `suggestion` is null, so the address is saved as typed.

export type AddressValidation = components['schemas']['customers.AddressValidation'];
type Issue = components['schemas']['customers.AddressIssue'];

/** What the check means for the form. */
export type AddressCheck =
  /** Saving would fail: show these field problems (keyed by API field: name, line1, city, region, postalCode…). */
  | { kind: 'fix'; issues: Issue[] }
  /** The provider suggests a different address or couldn't find it: the customer picks. */
  | { kind: 'ask'; typed: Address; suggestion: Address | null; warning: string | null }
  /** Fine as typed (also when the check itself failed: the save validates again). */
  | { kind: 'ok' };

/** Same address ignoring case and spacing (the backend's sameAddress rule, ZIP+4 ignored). */
const key = (a: Address) => [a.name, a.line1, a.line2 ?? '', a.city, a.region, a.postalCode.slice(0, 5), a.country].map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase()).join('|');

export function useAddressCheck() {
  const { api } = useApi();
  const m = useMutation({ mutationFn: (a: Address) => call(api.POST('/api/store/customers/addresses/validate', { body: a })) });
  const check = async (a: Address): Promise<AddressCheck> => {
    let v: AddressValidation;
    try {
      v = await m.mutateAsync(a);
    } catch {
      return { kind: 'ok' };
    }
    // Blocking: format problems, and addresses outside the service region or PO boxes (the save would refuse them).
    const hard = v.issues.filter((i) => i.code === 'missing' || i.code === 'invalid_format' || i.code === 'outside_service_region' || i.code === 'po_box_not_allowed');
    if (!v.valid || !v.deliverable || hard.length) return { kind: 'fix', issues: hard.length ? hard : v.issues };
    const suggestion = v.suggestion && key(v.suggestion) !== key(a) ? { ...v.suggestion, phone: v.suggestion.phone ?? a.phone ?? null } : null;
    const warning = v.issues.find((i) => i.code === 'not_found')?.message ?? null;
    return suggestion || warning ? { kind: 'ask', typed: a, suggestion, warning } : { kind: 'ok' };
  };
  return { check, checking: m.isPending };
}

const lines = (a: Address) => (
  <>
    {a.line1}
    {a.line2 && `, ${a.line2}`}
    <br />
    {a.city}, {a.region} {a.postalCode}
  </>
);

/** "Did you mean …?" with Use suggested / Keep what I entered (or, with no suggestion, the provider's warning). */
export function AddressSuggestion({ ask, busy, onUse, onKeep }: { ask: Extract<AddressCheck, { kind: 'ask' }>; busy?: boolean; onUse: (a: Address) => void; onKeep: () => void }) {
  const s = ask.suggestion;
  return (
    <Alert tone={s ? 'info' : 'warning'} title={s ? 'Did you mean this address?' : 'We couldn’t verify this address'}>
      <span className="stack gap-2">
        {s ? (
          <span className="grid md2 gap-3">
            <span className="stack gap-0">
              <span className="xs strong">Suggested</span>
              <span className="small">{lines(s)}</span>
            </span>
            <span className="stack gap-0">
              <span className="xs strong">You entered</span>
              <span className="small sub">{lines(ask.typed)}</span>
            </span>
          </span>
        ) : (
          <span className="small">{ask.warning} You can still use it if you’re sure it’s right.</span>
        )}
        <span className="row gap-2">
          {s && (
            <Button size="sm" disabled={busy} onClick={() => onUse(s)}>
              Use suggested address
            </Button>
          )}
          <Button variant="secondary" size="sm" disabled={busy} onClick={onKeep}>
            Keep what I entered
          </Button>
        </span>
      </span>
    </Alert>
  );
}
