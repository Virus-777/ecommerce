import { Link } from 'react-router';
import { BRAND } from '../config';
import { href } from '../routes/href';
import { LogoMark } from '../ui';

/** Brand logo linking to the store home; `area` adds the app label (Seller Center, Admin Center…). */
export function Logo({ area }: { area?: string }) {
  return (
    <Link className="logo" to={href('store/home')}>
      <LogoMark />
      <span>{BRAND}</span>
      {area && <span className="area">{area}</span>}
    </Link>
  );
}
