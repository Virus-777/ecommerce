import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from 'react';
import { Link } from 'react-router';
import { cx } from '@/lib/cx';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'soft' | 'ghost' | 'danger' | 'danger-soft' | 'deal' | 'link';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  variant?: ButtonVariant;
  size?: 'sm' | 'lg';
  icon?: IconName;
  iconRight?: IconName;
  /** Internal route: renders a router <Link>. */
  to?: string;
  /** External URL: renders a plain <a>. */
  href?: string;
  block?: boolean;
  /** Accessible name for icon-only buttons (no children). */
  label?: string;
  /** Extra screen-reader text after the visible label (e.g. the row's order number). */
  srLabel?: ReactNode;
  onClick?: MouseEventHandler<HTMLElement>;
  children?: ReactNode;
}

/** .btn: the design's button, as a <button>, router <Link> (to) or <a> (href). */
export function Button({ variant = 'primary', size, icon, iconRight, to, href, block, label, srLabel, className, children, type = 'button', onClick, ...rest }: ButtonProps) {
  const iconOnly = children === undefined || children === null || children === false;
  const cls = cx('btn', `btn-${variant}`, size && `btn-${size}`, block && 'btn-block', iconOnly && 'btn-icon', className);
  const inner = (
    <>
      {icon && <Icon name={icon} />}
      {!iconOnly && <span>{children}</span>}
      {srLabel && <span className="sr-only"> {srLabel}</span>}
      {iconRight && <Icon name={iconRight} />}
    </>
  );
  const aria = iconOnly ? (label ?? icon) : rest['aria-label'];
  if (to) {
    return (
      <Link className={cls} to={to} aria-label={aria} onClick={onClick} aria-current={rest['aria-current']}>
        {inner}
      </Link>
    );
  }
  if (href) {
    return (
      <a className={cls} href={href} aria-label={aria} onClick={onClick}>
        {inner}
      </a>
    );
  }
  return (
    <button type={type} className={cls} onClick={onClick} {...rest} aria-label={aria}>
      {inner}
    </button>
  );
}

export interface IconButtonProps {
  icon: IconName;
  /** Accessible name (required: the button shows only an icon). */
  label: string;
  to?: string;
  /** Count bubble (.dot-count). */
  count?: number | string;
  size?: 'sm';
  className?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  disabled?: boolean;
  'aria-expanded'?: boolean;
  'aria-pressed'?: boolean;
  'aria-haspopup'?: 'dialog' | 'menu' | boolean;
  'aria-controls'?: string;
}

/** .icon-btn: square icon-only control with an optional count bubble. */
export function IconButton({ icon, label, to, count, size, className, onClick, ...rest }: IconButtonProps) {
  const cls = cx('icon-btn', size, className);
  const inner = (
    <>
      <Icon name={icon} />
      {count ? <span className="dot-count">{count}</span> : null}
    </>
  );
  if (to) {
    return (
      <Link className={cls} to={to} aria-label={label} onClick={onClick}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" className={cls} aria-label={label} onClick={onClick} {...rest}>
      {inner}
    </button>
  );
}

/** Copy-to-clipboard button: shows "Copied" for 2 s and announces it (design: data-copy). */
export { CopyButton } from './CopyButton';
