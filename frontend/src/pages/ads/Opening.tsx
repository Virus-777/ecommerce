import { Link, useNavigate } from 'react-router';
import { useView } from '@marketly/web-shared/lib/hooks';
import { href } from '@marketly/web-shared/routes';
import { Button, Icon, Img, LogoTile, Price } from '@marketly/web-shared/ui';
import Home from '@/pages/store/Home';
import { AdOverlay } from './data/overlay';

// Design: pages/store/ads-opening.html: the store home page with the opening full-screen ad on top.
// view "sponsored-brand" = an advertiser's ad instead of Marketly's own campaign.
// Skip, Close ad, Esc and "Continue to home page" dismiss the ad and land on the home page.

export default function Opening() {
  const [view] = useView<'sponsored-brand'>();
  const navigate = useNavigate();
  const toHome = () => navigate(href('store/home'));
  const brand = view === 'sponsored-brand';

  return (
    <>
      <Home />
      <AdOverlay open onClose={toHome} overlayClassName="shop-oa" className="ad" label={brand ? 'Sponsored: Halden Aurora headphones' : 'Ad: Home Week campaign'}>
        <div className="top">
          <span className="shop-adtag">{brand ? 'Sponsored' : 'Ad · Marketly campaign'}</span>
          <Link className="shop-skip" to={href('store/home')} data-dialog-close="">
            {brand ? 'Close ad' : 'Skip'} <Icon name="x" className="ic-sm" />
          </Link>
        </div>
        {brand ? (
          <>
            <div className="art alt" aria-hidden="true">
              <Img icon="headphones" tint="surface" className="big" />
              <Img icon="briefcase" tint="5" />
              <Img icon="battery-charging" tint="surface" />
            </div>
            <div className="copy">
              <span className="row gap-2">
                <LogoTile initials="H" tint="2" />
                <span className="stack gap-0">
                  <span className="strong">Halden Audio</span>
                  <span className="xs muted">Advertiser</span>
                </span>
              </span>
              <h2 className="display d-xl">Aurora ANC. Forty hours of quiet.</h2>
              <p className="sub">Hybrid noise cancelling, multipoint Bluetooth and a hard travel case in the box.</p>
              <div className="row gap-2 base">
                <Price amount={189} was={229} lg />
              </div>
              <span className="small sub">Sold and shipped by Marketly Official · Sale ends Oct 19, 11:59 PM PT</span>
              <div className="row gap-2">
                <Button size="lg" to={href('store/product')} iconRight="arrow-right">
                  Shop Aurora
                </Button>
                <Button variant="ghost" to={href('store/home')}>
                  Continue to home page
                </Button>
              </div>
              <span className="xs muted">Sponsored by Halden Audio. Shown once per visit.</span>
            </div>
          </>
        ) : (
          <>
            <div className="art" aria-hidden="true">
              <Img icon="bed-double" tint="1" className="big" />
              <Img icon="lamp-desk" tint="5" />
              <Img icon="cooking-pot" tint="3" />
            </div>
            <div className="copy">
              <span className="eyebrow">Home Week · Oct 6–19</span>
              <h2 className="display d-xl">Up to 30% off bedding, lighting and cookware</h2>
              <p className="sub">Linen from Casa Verde Home, cast iron from the Official Store and smart lamps that charge your phone.</p>
              <div className="row gap-2">
                <Button size="lg" to={href('store/collection', 'seasonal')} iconRight="arrow-right">
                  Shop Home Week
                </Button>
                <Button variant="ghost" to={href('store/home')}>
                  Continue to home page
                </Button>
              </div>
              <span className="xs muted">Offers end Oct 19, 11:59 PM PT. Shown once per visit.</span>
            </div>
          </>
        )}
      </AdOverlay>
    </>
  );
}
