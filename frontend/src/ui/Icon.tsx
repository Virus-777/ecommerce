import type { SVGProps } from 'react';
import { ICONS, type IconName } from './icons.generated';

export type { IconName };

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  /** Lucide name, kebab-case as in the design (data-lucide). */
  name: IconName;
  /** Size utility from the design: ic-sm, ic-lg, ic-xl, ic-2xl (default is the md size). */
  className?: string;
}

/** Lucide icon. Decorative by default (aria-hidden); size and stroke come from the design CSS. */
export function Icon({ name, className, ...rest }: IconProps) {
  const C = ICONS[name];
  return <C aria-hidden="true" className={className} {...rest} />;
}

const LOGO_PATHS = (
  <>
    <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--brand)" />
    <path d="M7 12.5 9 7.5h14l2 5" fill="none" stroke="var(--on-brand)" strokeWidth="2" strokeLinejoin="round" />
    <path d="M7 12.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" fill="none" stroke="var(--on-brand)" strokeWidth="2" strokeLinecap="round" />
    <path d="M9.5 16.5v8h13v-8" fill="none" stroke="var(--on-brand)" strokeWidth="2" strokeLinejoin="round" />
    <path d="M14 24.5v-4h4v4" fill="none" stroke="var(--on-brand)" strokeWidth="2" strokeLinejoin="round" />
  </>
);

/** The Marketly mark (storefront in a rounded square). */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      {LOGO_PATHS}
    </svg>
  );
}
