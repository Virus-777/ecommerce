import { useState } from 'react';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Button, CopyButton, Icon, Img } from '@marketly/web-shared/ui';
import Category from '@/pages/store/Category';
import { AdOverlay } from './data/overlay';

// Design: pages/store/ads-popup.html: the category page with Marketly's welcome-coupon pop-up.
// view "announcement" = the non-modal corner announcement (also queued after the coupon pop-up is closed,
// since only one overlay shows at a time).
// The page behind the pop-up is the design's Headphones category: /ads/popup has no :slug of its own, and an
// empty slug asked GET /api/store/catalog/categories/ (not a category) and crashed on the missing `category`.
const BEHIND = 'headphones';

export default function Popup() {
  const [view, setView] = useView<'announcement'>();
  const [dismissed, setDismissed] = useState(false);
  const announcement = view === 'announcement';

  const closeCoupon = () => setView('announcement', { replace: true });

  return (
    <>
      <Category slug={BEHIND} />
      <AdOverlay open={!announcement} onClose={closeCoupon} className="shop-pop" labelledBy="pop-h" backdropCloses>
        <span className="x">
          <button type="button" className="icon-btn" aria-label="Close offer" data-dialog-close="" onClick={closeCoupon}>
            <Icon name="x" />
          </button>
        </span>
        <div className="band">
          <Icon name="ticket-percent" />
          <span className="eyebrow u-c-deal-text">Welcome offer from Marketly</span>
          <h2 className="display d-lg" id="pop-h">
            $10 off your first order over $50
          </h2>
        </div>
        <div className="body">
          <div className="shop-code">
            <span className="mono" id="copy-src-1">
              HELLO10
            </span>
            <CopyButton text="HELLO10">Copy code</CopyButton>
          </div>
          <p className="xs sub">
            Enter the code at checkout. Valid on your first Marketly order with items over $50 from any seller, before tax and shipping. Expires Oct 31, 2026. Marketly pays for the discount, so sellers’ prices don’t change.
          </p>
          <Button block to={href('store/category')}>
            Start shopping
          </Button>
          <Button variant="ghost" block data-dialog-close="" onClick={closeCoupon}>
            No thanks
          </Button>
          <span className="xs muted center">Shown once. We never show pop-ups during checkout.</span>
        </div>
      </AdOverlay>
      <AdOverlay open={announcement && !dismissed} onClose={() => setDismissed(true)} overlayClassName="shop-clear" className="shop-announce" label="Announcement from Marketly" modal={false}>
        <span className="x">
          <button type="button" className="icon-btn" aria-label="Dismiss announcement" data-dialog-close="" onClick={() => setDismissed(true)}>
            <Icon name="x" />
          </button>
        </span>
        <span className="row gap-2">
          <span className="shop-adtag">Announcement</span>
          <span className="xs muted">from Marketly</span>
        </span>
        <div className="row gap-3 top nowrap">
          <Img icon="store" tint="brand" className="thumb" />
          <div className="stack gap-1">
            <h2 className="h4">New: Official Store pickup in Portland</h2>
            <p className="small sub">From Oct 20, pick up Official Store orders at 1120 NW Couch St. Free, usually ready in 2 hours. Choose “Pickup” at checkout.</p>
          </div>
        </div>
        <div className="row gap-2">
          <Button size="sm" to={href('info/policy', 'shipping')}>
            See pickup details
          </Button>
          <Button variant="ghost" size="sm" data-dialog-close="" onClick={() => setDismissed(true)}>
            Dismiss
          </Button>
        </div>
        <span className="xs muted">You won’t see this again after you dismiss it.</span>
      </AdOverlay>
    </>
  );
}
