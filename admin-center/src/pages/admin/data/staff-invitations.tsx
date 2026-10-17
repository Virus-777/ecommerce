import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { Alert, announce, Button, CopyButton, Dialog, Field, StatusBadge, TableWrap, Textarea } from '@marketly/web-shared/ui';
import { LoadError, SkeletonLines, date, shortDate } from '@/app/parts';
import { isStepUpCancel, reauthField, useStepUp } from './step-up';
import { INVITATION_STATUS, INVITATIONS_KEY, staffLinkCommand, useInvitations, type Invitation } from './staff-member';

// Admin › Staff and roles › Staff members › Invited: the staff invitations not accepted yet (identity), with Resend
// and Cancel. Both ask for the password again (step-up purpose staff-account). Offline there is no email and the API
// never returns the pass code, so after a resend the person still needs the server operator to print their link
// and pass code with npm run staff-link (which itself issues a fresh link: the one from Resend can't be shown).

type Ask = { kind: 'resend' | 'revoke'; inv: Invitation };

export function StaffInvitations({ onDone }: { onDone: (title: string, text: string) => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const stepUp = useStepUp();
  const q = useInvitations();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);

  const act = useMutation({
    mutationFn: async ({ kind, inv }: Ask) => {
      const path = { params: { path: { id: inv.id } } };
      if (kind === 'resend') {
        const r = (await stepUp.run((t) => call(api.POST('/api/admin/identity/invitations/{id}/resend', { ...path, body: { ...reauthField(t) } })))) as Invitation;
        return {
          title: `New invitation for ${inv.name}`,
          text: `Valid until ${date(r.expiresAt)}; the old link and pass code no longer work. No email is sent from this server: ask the server operator to run ${staffLinkCommand(inv.email)} to print the link and pass code to hand over.`,
        };
      }
      await stepUp.run((t) => call(api.POST('/api/admin/identity/invitations/{id}/revoke', { ...path, body: { reason: reason.trim(), ...reauthField(t) } })));
      return { title: `Invitation for ${inv.name} cancelled`, text: 'The link stops working and the roles waiting for it have ended.' };
    },
    onSuccess: (msg) => {
      void qc.invalidateQueries({ queryKey: INVITATIONS_KEY });
      void qc.invalidateQueries({ queryKey: ['access'] });
      void qc.invalidateQueries({ queryKey: ['identity', 'account'] });
      setAsk(null);
      onDone(msg.title, msg.text);
      announce(msg.title);
    },
  });

  const start = (a: Ask) => {
    setAsk(a);
    setReason('');
    setTried(false);
    act.reset();
  };
  const submit = () => {
    if (!ask) return;
    setTried(true);
    if (ask.kind === 'revoke' && !reason.trim()) return;
    act.mutate(ask);
  };
  const err = act.error && !isStepUpCancel(act.error) ? act.error : null;
  const items = q.data ?? [];

  const actions = (i: Invitation) => (
    <span className="row gap-1 nowrap">
      <Button variant="ghost" size="sm" onClick={() => start({ kind: 'resend', inv: i })} srLabel={` invitation for ${i.name}`}>
        Resend
      </Button>
      {i.status === 'pending' && (
        <Button variant="ghost" size="sm" onClick={() => start({ kind: 'revoke', inv: i })} srLabel={` invitation for ${i.name}`}>
          Cancel
        </Button>
      )}
    </span>
  );
  const empty = <span className="small muted">No open invitations.</span>;

  return (
    <>
      {q.isError ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <div className="no-phone">
            <TableWrap label="Staff invitations table">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Sent</th>
                    <th scope="col">Valid until</th>
                    <th scope="col">Status</th>
                    <th className="col-pin" scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {q.isPending && (
                    <tr>
                      <td colSpan={5}>
                        <SkeletonLines rows={3} />
                      </td>
                    </tr>
                  )}
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <span className="stack gap-0">
                          <span className="small strong">{i.name}</span>
                          <span className="xs muted">{i.email}</span>
                        </span>
                      </td>
                      <td>
                        <span className="small">
                          {shortDate(i.sentAt)}
                          {i.invitedBy.name ? ` by ${i.invitedBy.name}` : ''}
                        </span>
                      </td>
                      <td>
                        <span className="small">{shortDate(i.expiresAt)}</span>
                      </td>
                      <td>
                        <StatusBadge status={INVITATION_STATUS[i.status]} />
                      </td>
                      <td className="col-pin">{actions(i)}</td>
                    </tr>
                  ))}
                  {!q.isPending && !items.length && (
                    <tr>
                      <td colSpan={5}>{empty}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </TableWrap>
          </div>
          <div className="ac-mlist only-phone">
            {q.isPending && <SkeletonLines rows={3} />}
            {items.map((i) => (
              <div className="ac-mi" key={i.id}>
                <div className="row between gap-2 nowrap top">
                  <span className="small strong min-w-0">{i.name}</span>
                  <StatusBadge status={INVITATION_STATUS[i.status]} />
                </div>
                <div className="xs sub">
                  {i.email} · sent {shortDate(i.sentAt)} · valid until {shortDate(i.expiresAt)}
                </div>
                {actions(i)}
              </div>
            ))}
            {!q.isPending && !items.length && <div className="ac-mi">{empty}</div>}
          </div>
        </>
      )}

      <Dialog
        open={!!ask && !stepUp.waiting}
        onClose={() => setAsk(null)}
        title={ask?.kind === 'revoke' ? 'Cancel invitation' : 'Resend invitation'}
        foot={
          <>
            <Button variant="ghost" onClick={() => setAsk(null)} disabled={act.isPending}>
              Back
            </Button>
            <Button variant={ask?.kind === 'revoke' ? 'danger' : 'primary'} icon={ask?.kind === 'revoke' ? 'circle-x' : 'refresh-cw'} onClick={submit} disabled={act.isPending}>
              {act.isPending ? 'Working…' : ask?.kind === 'revoke' ? 'Cancel invitation' : 'Resend'}
            </Button>
          </>
        }
      >
        {ask && (
          <>
            {ask.kind === 'resend' ? (
              <span className="small">
                {ask.inv.name} gets a new invitation valid for 7 days; the old link and pass code stop working. No email is sent from this server and pass codes are never shown here: after this, the server operator prints the link and pass code to hand over.
              </span>
            ) : (
              <span className="small">The invitation link for {ask.inv.name} ({ask.inv.email}) stops working, and the roles waiting for it end. A cancelled invitation can’t be resent: invite the person again if needed.</span>
            )}
            {err != null && (
              <Alert tone="danger" title="That didn’t work">
                {errorMessage(err)}
              </Alert>
            )}
            {ask.kind === 'revoke' && (
              <Field label="Reason (required)" hint="Saved in Action history." error={tried && !reason.trim() ? 'Enter a reason.' : undefined}>
                <Textarea id="si-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
            )}
            {ask.kind === 'resend' && (
              <span className="xs muted row gap-2 wrap">
                On the server: <span className="mono">{staffLinkCommand(ask.inv.email)}</span>
                <CopyButton text={staffLinkCommand(ask.inv.email)} label="Copy the command" />
              </span>
            )}
          </>
        )}
      </Dialog>
      {stepUp.dialog}
    </>
  );
}
