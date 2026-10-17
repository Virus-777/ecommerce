import { useState } from 'react';
import { cx } from '../lib/cx';
import { initials } from '../lib/format';
import type { Tint } from '../data/fixtures';
import { Icon, type IconName } from './Icon';

export type { Tint };
export const tintClass = (t?: Tint | string) => (t ? `tint-${t}` : 'tint-1');

/**
 * A signed /files link as a same-origin path. The server builds file links from its API_URL, but staff may open the
 * app by another host (the server's IP on the office LAN): that host's CSP (img-src 'self') blocks the absolute URL,
 * and the API_URL host name may not even resolve there. The apps always reach the API on their own origin (the dev
 * servers and the production proxy serve /files), so the path and signature are all an <img> needs.
 */
export function sameOriginFile(src: string): string {
  if (!/^https?:\/\//i.test(src)) return src;
  try {
    const u = new URL(src);
    return u.pathname.startsWith('/files/') ? u.pathname + u.search : src;
  } catch {
    return src;
  }
}

/** Product/media image (.imgph): a tinted tile with the image, or with an icon when there is none or it fails to load. */
export function Img({ icon, tint, className, src, alt = '' }: { icon: IconName; tint?: Tint | string; className?: string; src?: string; alt?: string }) {
  // The src that failed to load (an expired link, a missing file): show the icon instead of a broken image.
  const [failed, setFailed] = useState<string | null>(null);
  const shown = src && src !== failed ? sameOriginFile(src) : undefined;
  return (
    <div className={cx('imgph', tintClass(tint), className)}>
      {shown ? <img src={shown} alt={alt} onError={() => setFailed(src ?? null)} /> : <Icon name={icon} />}
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
