import { Link } from 'react-router';
import { BRAND } from '../config';
import { href } from '../routes/href';
import type { ScreenId } from '../routes/catalogue';
import { LogoMark } from '../ui';

/**
 * Brand logo; `area` adds the app label (Seller Center, Admin Center…). It links to `home`, the app's own
 * home screen (the store home by default; the back-office apps link to their own home, not the store).
 */
export function Logo({ area, home = 'store/home' }: { area?: string; home?: ScreenId }) {
  return (
    <Link className="logo" to={href(home)}>
      <LogoMark />
      <span>{BRAND}</span>
      {area && <span className="area">{area}</span>}
    </Link>
  );
}
