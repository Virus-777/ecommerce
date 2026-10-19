import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { Alert, Button, Dialog, Field, OptionCard, TextInput } from '@marketly/web-shared/ui';

// "Deliver to … · Change" on the product page (designed in React; the design has no address picker): a saved address
// (signed-in customers) or a ZIP code sets the cart's delivery location, so delivery estimates and shipping follow it.
// API: GET /api/store/customers/addresses; PUT /api/store/cart/cart/destination { addressId } | { postalCode, country }.

type SavedAddress = components['schemas']['customers.SavedAddress'];

const ZIP = /^\d{5}(-\d{4})?$/;

export function DeliverToDialog({ open, onClose, signedIn, current }: { open: boolean; onClose: () => void; signedIn: boolean; current?: { postalCode: string; label: string } }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const addresses = useQuery({
    queryKey: ['customers', 'addresses'],
    queryFn: () => call(api.GET('/api/store/customers/addresses')) as Promise<SavedAddress[] | { items: SavedAddress[] }>,
    enabled: open && signedIn,
  });
  const list: SavedAddress[] = Array.isArray(addresses.data) ? addresses.data : (addresses.data?.items ?? []);
  const [pick, setPick] = useState<string>('');
  const [zip, setZip] = useState('');
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: () =>
      call(
        api.PUT('/api/store/cart/cart/destination', {
          body: pick && pick !== 'zip' ? { addressId: pick } : { postalCode: zip.trim(), country: 'US' },
        }),
      ),
    onSuccess: () => {
      // Delivery estimates and shipping depend on the destination.
      void qc.invalidateQueries({ queryKey: ['offers'] });
      void qc.invalidateQueries({ queryKey: ['cart'] });
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const usingZip = !signedIn || pick === 'zip' || (!pick && !list.length);
  const submit = () => {
    setError('');
    if (usingZip && !ZIP.test(zip.trim())) return setError('Enter a 5-digit US ZIP code.');
    if (!usingZip && !pick) return setError('Choose an address.');
    save.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Choose where to deliver"
      foot={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Deliver here'}
          </Button>
        </>
      }
    >
      <p className="small sub">Delivery dates and shipping costs depend on where the order goes.{current ? ` Now: ${current.label}.` : ''}</p>
      {error && <Alert tone="danger">{error}</Alert>}
      {signedIn && list.length > 0 && (
        <div className="stack gap-2" role="radiogroup" aria-label="Saved addresses">
          {list.map((a) => (
            <OptionCard
              key={a.id}
              id={`dt-${a.id}`}
              name="deliver-to"
              title={`${a.label || 'Address'}${a.isDefault ? ' · default' : ''}`}
              body={[a.address.line1, a.address.city, a.address.postalCode].filter(Boolean).join(', ')}
              checked={pick === a.id}
              onChange={() => setPick(a.id)}
            />
          ))}
          <OptionCard id="dt-zip" name="deliver-to" title="Use a ZIP code" body="See dates for another place" checked={pick === 'zip'} onChange={() => setPick('zip')} />
        </div>
      )}
      {usingZip && (
        <Field label="ZIP code">
          <TextInput id="dt-zip-code" inputMode="numeric" autoComplete="postal-code" maxLength={10} value={zip} onChange={(e) => setZip(e.target.value)} placeholder="97205" autoFocus={!signedIn || !list.length} />
        </Field>
      )}
    </Dialog>
  );
}
