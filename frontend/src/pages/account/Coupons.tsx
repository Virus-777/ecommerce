import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AccountLayout } from '@/layouts';
import { call, errorMessage, useApi, type components } from '@marketly/web-shared/api';
import { cx } from '@marketly/web-shared/lib/cx';
import { formatMoney } from '@marketly/web-shared/lib/format';
import { Alert, announce, Badge, Button, CopyButton, Dialog } from '@marketly/web-shared/ui';
import { date } from './data/when';

// Design: pages/store/account-coupons.html (one view): store credit + history, coupons to clip
// (or copy the code to type at checkout), and used/expired coupons.
// API: GET /api/store/promotions/coupons, POST …/coupons/{campaignId}/clip. Store credit is the wallet module,
// which is off at launch (its routes answer 404), so the store credit card and history are not shown.

type Coupon = components['schemas']['promotions.CouponCard'];

function CouponCard({ c, onClip, clipping, onTerms }: { c: Coupon; onClip?: () => void; clipping?: boolean; onTerms?: () => void }) {
  const done = c.state === 'used' ? 'Completed' : c.state === 'expired' ? 'Expired' : null;
  const meta = c.state === 'used' ? 'Used' : `${c.state === 'expired' ? 'Expired' : 'Expires'} ${date(c.expiresAt)}`;
  return (
    <article className={cx('acct-coupon', done && 'is-muted')}>
      <div className="amt">
        <span>{c.amountLabel}</span>
        <small>{c.unitLabel}</small>
      </div>
      <div className="bd">
        <div className="row between top gap-2">
          <span className="small strong">{c.title}</span>
          {done ? (
            <Badge>{done}</Badge>
          ) : c.state === 'clipped' ? (
            <Badge tone="success" icon="check">
              Clipped
            </Badge>
          ) : c.autoApply ? (
            <Badge tone="info">Applies automatically</Badge>
          ) : (
            <Button size="sm" icon="scissors" onClick={onClip} disabled={clipping}>
              Clip
            </Button>
          )}
        </div>
        <span className="xs sub">
          {c.usedOn ? (
            <>
              Used {date(c.usedOn.at)} on order <span className="mono">{c.usedOn.orderRef}</span>. Saved {formatMoney(c.usedOn.saved)}.
            </>
          ) : c.state === 'expired' ? (
            'Not used.'
          ) : (
            `${c.conditions.charAt(0).toUpperCase()}${c.conditions.slice(1)}.`
          )}
        </span>
        <span className="row gap-3 xs muted">
          {c.code && (
            <span className="row gap-1 nowrap">
              <span className="mono">{c.code}</span>
              {!done && <CopyButton text={c.code} label={`Copy code ${c.code}`} className="icon-btn sm" />}
            </span>
          )}
          <span>{meta}</span>
          {!done && c.terms && (
            <a
              href="#"
              className="link-inline"
              onClick={(e) => {
                e.preventDefault();
                onTerms?.();
              }}
            >
              Terms
            </a>
          )}
        </span>
      </div>
    </article>
  );
}

export default function Coupons() {
  const { api } = useApi();
  const qc = useQueryClient();
  const [terms, setTerms] = useState<Coupon | null>(null);
  const coupons = useQuery({ queryKey: ['promotions', 'coupons'], queryFn: () => call(api.GET('/api/store/promotions/coupons')) });
  const clip = useMutation({
    mutationFn: (c: Coupon) => call(api.POST('/api/store/promotions/coupons/{campaignId}/clip', { params: { path: { campaignId: c.campaignId } } })),
    onSuccess: (next) => {
      qc.setQueryData(['promotions', 'coupons'], (d: typeof coupons.data) => (d ? { ...d, available: d.available.map((x) => (x.campaignId === next.campaignId ? next : x)) } : d));
      announce(`Coupon ${next.code ?? next.title} clipped. It applies at checkout.`);
    },
  });

  const available = coupons.data?.available ?? [];
  const used = coupons.data?.usedOrExpired ?? [];
  const skeleton = (
    <div className="grid md2 gap-3" aria-hidden="true">
      {[0, 1].map((i) => (
        <div key={i} className="card pad stack gap-2">
          <span className="sk sk-line short" />
          <span className="sk sk-line" />
          <span className="sk sk-line short" />
        </div>
      ))}
    </div>
  );

  return (
    <AccountLayout active="coupons" title="Coupons and credit">
      <div className="acct-head">
        <div className="stack gap-1">
          <h1 className="h1 acct-h1">Coupons and credit</h1>
          <p className="small sub">Clipped coupons apply at checkout to the items they cover. You see each discount before you pay.</p>
        </div>
      </div>
      {coupons.isError ? (
        <Alert tone="danger" title="We couldn't load your coupons">
          {errorMessage(coupons.error)}{' '}
          <Button variant="ghost" size="sm" onClick={() => void coupons.refetch()}>
            Try again
          </Button>
        </Alert>
      ) : (
        <>
          <section className="stack gap-3" aria-labelledby="cp-avail">
            <h2 className="h3" id="cp-avail">
              Available coupons
            </h2>
            {clip.isError && <Alert tone="danger" title="We couldn't clip that coupon">{errorMessage(clip.error)}</Alert>}
            {coupons.isPending ? (
              skeleton
            ) : available.length ? (
              <div className="grid md2 gap-3">
                {available.map((c) => (
                  <CouponCard key={c.campaignId} c={c} onClip={() => clip.mutate(c)} clipping={clip.isPending && clip.variables?.campaignId === c.campaignId} onTerms={() => setTerms(c)} />
                ))}
              </div>
            ) : (
              <p className="small muted">No coupons right now. Coupons from Marketly and sellers you buy from show up here.</p>
            )}
            <span className="xs muted">{coupons.data?.rules.join(' ') || 'One coupon per seller package. Some coupons can’t be combined with sale prices; checkout tells you which.'}</span>
          </section>
          {used.length > 0 && (
            <section className="stack gap-3" aria-labelledby="cp-used">
              <h2 className="h3" id="cp-used">
                Used and expired
              </h2>
              <div className="grid md2 gap-3">
                {used.map((c) => (
                  <CouponCard key={`${c.campaignId}-${c.codeId ?? ''}`} c={c} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <Dialog
        open={!!terms}
        onClose={() => setTerms(null)}
        title={terms?.title ?? 'Terms'}
        size="sm"
        foot={<Button onClick={() => setTerms(null)}>Close</Button>}
      >
        <p className="small sub">{terms?.terms}</p>
        <p className="xs muted">
          {terms?.conditions} · Funded by {terms?.fundedBy}
        </p>
      </Dialog>
    </AccountLayout>
  );
}
