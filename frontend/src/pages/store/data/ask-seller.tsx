// "Ask the seller": a private pre-sale message about one of a seller's products (BACKEND-REQUESTS G4),
// POST /api/store/messaging/product-conversations { offerId, body }. Signed-in customers only (a visitor
// is sent to sign-in first); one conversation per customer, seller and product, so asking again adds to
// it. New conversations are capped per day (429 RATE_LIMITED). After sending, the conversation opens
// in Messages.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { ApiError, call, errorMessage, newIdempotencyKey, useApi } from '@marketly/web-shared/api';
import { href } from '@marketly/web-shared/routes';
import { Alert, Button, Dialog, Field, Select, Textarea, announce } from '@marketly/web-shared/ui';

export interface AskOffer {
  offerId: string;
  /** Product title shown in the dialog (and in the product picker on a storefront). */
  title: string;
}

const MAX = 2000;

/** The API's error as the dialog shows it: the daily cap gets its own words. */
const sendError = (e: unknown) =>
  e instanceof ApiError && (e.status === 429 || e.code === 'RATE_LIMITED')
    ? 'You’ve started too many new conversations with sellers today. Try again tomorrow, or reply in a conversation you already have.'
    : e instanceof ApiError && e.fieldErrors.body
      ? e.fieldErrors.body
      : errorMessage(e);

/**
 * Dialog to message a seller before buying. `offers` holds one offer on a product page, or the store's
 * products on a storefront (the customer picks which product the question is about).
 */
export function AskSellerDialog({ open, onClose, sellerName, offers }: { open: boolean; onClose: () => void; sellerName: string; offers: AskOffer[] }) {
  const { api } = useApi();
  const navigate = useNavigate();
  const [offerId, setOfferId] = useState(offers[0]?.offerId ?? '');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [clientMessageId, setClientMessageId] = useState(() => newIdempotencyKey());
  const send = useMutation({
    mutationFn: () => call(api.POST('/api/store/messaging/product-conversations', { body: { offerId, body: body.trim(), clientMessageId } })),
    onSuccess: (r) => {
      announce(`Message sent to ${sellerName}.`);
      onClose();
      navigate(href('account/messages', '', undefined, { conversation: r.conversation.id }));
    },
    onError: (e) => setError(sendError(e)),
  });

  useEffect(() => {
    if (!open) return;
    setError('');
    setClientMessageId(newIdempotencyKey());
    send.reset();
    if (!offers.some((o) => o.offerId === offerId)) setOfferId(offers[0]?.offerId ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = () => {
    if (!body.trim()) return setError('Write your question for the seller.');
    if (!offerId) return setError('Choose the product your question is about.');
    send.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Ask ${sellerName}`}
      foot={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="send" onClick={submit} disabled={send.isPending}>
            Send message
          </Button>
        </>
      }
    >
      {offers.length > 1 ? (
        <Field label="Product">
          <Select id="ask-offer" options={offers.map((o) => ({ value: o.offerId, label: o.title }))} value={offerId} onChange={(e) => setOfferId(e.target.value)} />
        </Field>
      ) : (
        offers[0] && <p className="small strong">{offers[0].title}</p>
      )}
      <Field label="Your message" hint={`${body.length}/${MAX}. Only you and the seller see this conversation.`} error={error || undefined}>
        <Textarea
          id="ask-body"
          rows={4}
          maxLength={MAX}
          placeholder="For example: Does it come with a carrying case?"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setError('');
          }}
        />
      </Field>
      <Alert tone="info">Questions other shoppers may have too are better asked in Questions and answers, where everyone sees the answer.</Alert>
    </Dialog>
  );
}
