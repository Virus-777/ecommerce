import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { components } from '@marketly/web-shared/api';
import { call, errorMessage, useApi } from '@marketly/web-shared/api';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { Alert, Button, Dialog, Field, OptionCard, StatusBadge, TableWrap, TextInput, Textarea, announce } from '@marketly/web-shared/ui';
import { useStaffSession } from '@/app/session';
import { SkeletonLines, dateTime } from '@/app/parts';
import type { Campaign } from './data/promotions';

// Section 8 "Seller participation" of admin/promotion-new (review §2a #7, A18 and B18). Seller- and shared-funded
// campaigns include a seller's offers only after that seller consents, and invitations go out only when Marketing
// sends them: POST /api/admin/promotions/campaigns/{id}/invitations {respondBy} (every seller with eligible offers in
// scope). Sellers who ask to leave a live campaign (from Seller Center) wait for
// POST /participations/{id}/decide-withdrawal {approve, reason}; Marketing can also take a seller out with
// POST /participations/{id}/remove {reason}. All need promotions.campaigns.manage.

type Participation = components['schemas']['promotions.Participation'];

const PARTICIPATION_LABEL: Record<string, string> = { invited: 'Pending', accepted: 'Accepted', declined: 'Declined', withdrawal_requested: 'Withdrawal requested', withdrawn: 'Withdrawn', removed: 'Removed', expired: 'Expired' };
/** Campaign statuses that can still invite sellers (backend OPEN_CAMPAIGN). */
const OPEN = ['draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'live', 'paused'];

/** datetime-local value (browser time) → ISO, and a default answer-by time: 3 days from now, before the campaign ends. */
const localValue = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
function defaultRespondBy(c: Campaign): string {
  const end = new Date(c.period.endsAt).getTime() - 3_600_000;
  return localValue(new Date(Math.min(Date.now() + 3 * 86_400_000, end)));
}

type Act = { kind: 'invite' } | { kind: 'withdrawal' | 'remove'; p: Participation };

export function PromotionParticipants({ c, sellers, pending, inviteChecked }: { c: Campaign; sellers: Participation[]; pending: boolean; inviteChecked: boolean }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { can } = useStaffSession();
  const canManage = can('promotions.campaigns.manage');
  const [act, setAct] = useState<Act | null>(null);
  const [respondBy, setRespondBy] = useState('');
  const [approve, setApprove] = useState(true);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Invitations need the saved campaign to have them turned on (participation.inviteSellers), not just the checkbox.
  const invitesOn = !!c.participation?.inviteSellers;
  const canInvite = canManage && c.ownerKind === 'platform' && invitesOn && OPEN.includes(c.status);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['promotions'] });
    void qc.invalidateQueries({ queryKey: ['workqueues', 'queues'] });
  };
  const run = useMutation({
    mutationFn: async (a: Act) => {
      if (a.kind === 'invite') {
        const out = await call(api.POST('/api/admin/promotions/campaigns/{id}/invitations', { params: { path: { id: c.id } }, body: { respondBy: new Date(respondBy).toISOString() } }));
        return out.length ? `${out.length} ${out.length === 1 ? 'seller was' : 'sellers were'} invited to answer by ${dateTime(new Date(respondBy).toISOString())}. They see the invitation in Seller Center.` : 'No seller with eligible offers was left to invite.';
      }
      if (a.kind === 'withdrawal') {
        await call(api.POST('/api/admin/promotions/participations/{id}/decide-withdrawal', { params: { path: { id: a.p.id } }, body: { approve, reason: reason.trim() } }));
        return approve ? `${a.p.sellerName} leaves the campaign; its offers stop getting the campaign price.` : `${a.p.sellerName} stays in the campaign. The seller sees your reason.`;
      }
      await call(api.POST('/api/admin/promotions/participations/{id}/remove', { params: { path: { id: a.p.id } }, body: { reason: reason.trim() } }));
      return `${a.p.sellerName} is removed from the campaign. The seller sees your reason.`;
    },
    onSuccess: (text) => {
      setAct(null);
      setNotice(text);
      announce(text);
      refresh();
    },
  });

  const open = (a: Act) => {
    setAct(a);
    setApprove(true);
    setReason('');
    setTried(false);
    setRespondBy(defaultRespondBy(c));
    run.reset();
  };
  const respondErr = !respondBy ? 'Choose when sellers must answer by.' : new Date(respondBy).getTime() <= Date.now() ? 'Choose a time in the future.' : new Date(respondBy).getTime() >= new Date(c.period.endsAt).getTime() ? 'Sellers must answer before the campaign ends.' : undefined;
  const submit = () => {
    if (!act) return;
    setTried(true);
    if (act.kind === 'invite' ? respondErr : !reason.trim()) return;
    run.mutate(act);
  };

  return (
    <>
      {notice && (
        <Alert tone="success" title="Seller participation updated">
          {notice}
        </Alert>
      )}
      {sellers.length ? (
        <TableWrap label="8 Seller participation table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Seller</th>
                <th scope="col">Offers</th>
                <th scope="col">Consent</th>
                <th className="r" scope="col">
                  Seller earns per $100 sale
                </th>
                {canManage && (
                  <th className="col-pin" scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {sellers.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="ab-cell">
                      <span>{s.sellerName}</span>
                      {s.state === 'withdrawal_requested' && s.reason && <span className="xs muted">Asked to leave: {s.reason}</span>}
                      {s.state === 'invited' && s.respondBy && <span className="xs muted">Answer by {dateTime(s.respondBy)}</span>}
                    </span>
                  </td>
                  <td>{s.offerCount}</td>
                  <td>
                    <StatusBadge status={PARTICIPATION_LABEL[s.state] ?? s.state} />
                  </td>
                  <td className="r">
                    {s.earningsExample ? (
                      <span className="num">
                        {formatMoney(s.earningsExample.sellerEarns)} <span className="xs muted">(was {formatMoney(s.earningsExample.regularSellerEarns)})</span>
                      </span>
                    ) : (
                      <span className="xs muted">—</span>
                    )}
                  </td>
                  {canManage && (
                    <td className="col-pin">
                      <span className="row gap-1 nowrap">
                        {s.state === 'withdrawal_requested' && (
                          <Button size="sm" variant="secondary" onClick={() => open({ kind: 'withdrawal', p: s })} srLabel={s.sellerName}>
                            Decide request
                          </Button>
                        )}
                        {(s.state === 'invited' || s.state === 'accepted') && (
                          <Button size="sm" variant="ghost" onClick={() => open({ kind: 'remove', p: s })} srLabel={s.sellerName}>
                            Remove
                          </Button>
                        )}
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : pending ? (
        <SkeletonLines rows={2} />
      ) : (
        <span className="xs muted">
          No sellers invited yet.
          {canInvite
            ? ' Invite sellers to send the invitations; each seller must consent before its offers are included.'
            : inviteChecked && !invitesOn
              ? ' Save the campaign with “Invite sellers” on, then invite them here.'
              : c.funding.owner !== 'platform'
                ? ' Seller and shared funding need sellers’ consent: turn on “Invite sellers” and save.'
                : ''}
        </span>
      )}
      {canInvite && (
        <span className="row gap-2">
          <Button size="sm" variant="secondary" icon="send" onClick={() => open({ kind: 'invite' })}>
            {sellers.length ? 'Invite more sellers' : 'Invite sellers'}
          </Button>
          <span className="xs muted">Invites every seller with eligible offers in the campaign’s scope who hasn’t been invited.</span>
        </span>
      )}

      <Dialog
        open={act !== null}
        onClose={() => setAct(null)}
        title={act?.kind === 'invite' ? 'Invite sellers' : act?.kind === 'withdrawal' ? `${act.p.sellerName} asks to leave` : act ? `Remove ${act.p.sellerName}` : ''}
        foot={
          <>
            <Button variant="ghost" onClick={() => setAct(null)}>
              Cancel
            </Button>
            <Button variant={act?.kind === 'remove' ? 'danger' : 'primary'} onClick={submit} disabled={run.isPending}>
              {act?.kind === 'invite' ? 'Send invitations' : act?.kind === 'withdrawal' ? 'Record decision' : 'Remove seller'}
            </Button>
          </>
        }
      >
        {run.isError && (
          <Alert tone="danger" title="That didn’t work">
            {errorMessage(run.error)}
          </Alert>
        )}
        {act?.kind === 'invite' ? (
          <>
            <p className="small sub">Sellers see the discount, who funds it and their earnings per sale, and accept or decline in Seller Center. Offers join only after consent.</p>
            <Field label="Sellers answer by" hint="Your local time. Must be before the campaign ends." error={tried ? respondErr : undefined}>
              <TextInput id="pp-respond" type="datetime-local" icon="calendar" value={respondBy} onChange={(e) => setRespondBy(e.target.value)} placeholder="" />
            </Field>
          </>
        ) : act ? (
          <>
            {act.kind === 'withdrawal' && (
              <>
                {act.p.reason && <p className="small sub">Their reason: {act.p.reason}</p>}
                <fieldset className="stack gap-2 fieldset-reset">
                  <legend className="label">Decision</legend>
                  <OptionCard id="pp-approve" name="pp-dec" title="Let them leave" body="Their offers stop getting the campaign price now." checked={approve} onChange={() => setApprove(true)} />
                  <OptionCard id="pp-keep" name="pp-dec" title="Keep them in" body="They stay in the campaign as agreed." checked={!approve} onChange={() => setApprove(false)} />
                </fieldset>
              </>
            )}
            {act.kind === 'remove' && <p className="small sub">All of the seller’s offers leave the campaign now. The seller sees the reason.</p>}
            <Field label="Reason" hint="The seller sees it; it is also written to Action history" error={tried && !reason.trim() ? 'Give a reason.' : undefined}>
              <Textarea id="pp-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </>
        ) : null}
      </Dialog>
    </>
  );
}
