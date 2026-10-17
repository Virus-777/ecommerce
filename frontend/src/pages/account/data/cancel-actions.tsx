// Withdraw a pending cancellation request: POST orders/orders/{id}/cancellations/{cancellationId}/withdraw
// (no body, no Idempotency-Key). The backend allows it only for a request the customer made that is still
// REQUESTED (orders/http/store.ts withdrawCancellation); the items then go back to the state they had.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, call, errorMessage, useApi } from '@marketly/web-shared/api';
import { announce, Button, Dialog, type ButtonVariant } from '@marketly/web-shared/ui';
import type { Cancellation, OrderDetail } from './orders';

/** A cancellation the customer can still withdraw: theirs and waiting for the seller. */
export const canWithdrawCancellation = (c: Cancellation) => c.initiatedBy.toUpperCase() === 'CUSTOMER' && c.status.toUpperCase() === 'REQUESTED';

/** The order's withdrawable requests that cover this item. */
export const withdrawableFor = (order: OrderDetail, itemId: string) =>
  order.groups.flatMap((g) => g.cancellations).filter((c) => canWithdrawCancellation(c) && c.items.some((l) => l.itemId === itemId));

/** "Withdraw request" with a confirmation; withdraws every given request (one per seller package). */
export function WithdrawCancellationButton({ orderId, requests, variant = 'secondary', size, block }: { orderId: string; requests: Cancellation[]; variant?: ButtonVariant; size?: 'sm' | 'lg'; block?: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const withdraw = useMutation({
    mutationFn: async () => {
      for (const c of requests) await call(api.POST('/api/store/orders/orders/{id}/cancellations/{cancellationId}/withdraw', { params: { path: { id: orderId, cancellationId: c.id } } }));
    },
    onSuccess: () => {
      setOpen(false);
      announce('Cancellation request withdrawn. Your items continue as normal.');
    },
    // Refresh on failure too: a request that was withdrawn before the error, or one the seller already decided, shows its new state.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['customers', 'overview'] });
    },
  });
  if (!requests.length) return null;
  const items = requests.flatMap((c) => c.items);
  // A decided request can't be withdrawn (the state machine refuses it): say so plainly.
  const error = withdraw.error instanceof ApiError && withdraw.error.status === 409 ? 'The seller already answered this request. Reload the page to see the result.' : withdraw.isError ? errorMessage(withdraw.error) : '';
  return (
    <>
      <Button variant={variant} size={size} block={block} icon="undo-2" onClick={() => setOpen(true)}>
        Withdraw request
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Withdraw your cancellation request?"
        foot={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Keep the request
            </Button>
            <Button icon="undo-2" onClick={() => withdraw.mutate()} disabled={withdraw.isPending}>
              {withdraw.isPending ? 'Withdrawing…' : 'Withdraw request'}
            </Button>
          </>
        }
      >
        <p className="small sub">
          {items.length === 1 ? `${items[0]!.title} stays` : `These ${items.length} items stay`} in your order and ship as normal. No refund is made. You can ask to cancel again while it hasn't shipped.
        </p>
        {error && <span className="xs t-danger-text">{error}</span>}
      </Dialog>
    </>
  );
}
