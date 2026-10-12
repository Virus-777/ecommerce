import { cx } from '../lib/cx';
import { initials } from '../lib/format';
import type { Tint } from '../data/fixtures';
import { Icon, type IconName } from './Icon';

export type { Tint };
export const tintClass = (t?: Tint | string) => (t ? `tint-${t}` : 'tint-1');

/** Product/media image placeholder (.imgph): a tinted tile with an icon. Real images come from Media later. */
export function Img({ icon, tint, className, src, alt = '' }: { icon: IconName; tint?: Tint | string; className?: string; src?: string; alt?: string }) {
  return (
    <div className={cx('imgph', tintClass(tint), className)}>
      {src ? <img src={src} alt={alt} /> : <Icon name={icon} />}
    </div>
  );
}

/** Initials avatar (.avatar). size: 'sm' | 'lg' | 'xl' as in the design CSS. */
export function Avatar({ name, size, className }: { name: string; size?: string; className?: string }) {
  return (
    <span className={cx('avatar', size, className)} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** Seller/brand logo tile (.logo-tile) with initials. size: xs | sm | md (default large). */
export function LogoTile({ initials: text, tint, size, className }: { initials: string; tint?: Tint | string; size?: 'xs' | 'sm' | 'md'; className?: string }) {
  return (
    <span className={cx('logo-tile', size, tintClass(tint), className)} aria-hidden="true">
      {text}
    </span>
  );
}
