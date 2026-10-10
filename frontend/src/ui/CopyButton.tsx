import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { Icon, type IconName } from './Icon';
import { announce } from './announce';

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  Object.assign(ta.style, { position: 'fixed', top: '-1000px', opacity: '0' });
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

interface CopyButtonProps {
  /** Text placed on the clipboard. */
  text: string;
  /** Visible label; omit for an icon-only button (then `label` is the accessible name). */
  children?: ReactNode;
  label?: string;
  icon?: IconName;
  /** Classes for the button (default: an .icon-btn when icon-only, otherwise a small secondary .btn). */
  className?: string;
}

/** Copies `text`; the label reads "Copied" for 2 s (.is-copied), as in the design's data-copy behaviour. */
export function CopyButton({ text, children, label = 'Copy', icon = 'copy', className }: CopyButtonProps) {
  const [state, setState] = useState<'' | 'ok' | 'fail'>('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const iconOnly = children === undefined;
  const msg = state === 'ok' ? 'Copied' : state === 'fail' ? 'Press Ctrl+C to copy' : '';
  const onClick = async () => {
    const ok = await copyText(text);
    setState(ok ? 'ok' : 'fail');
    announce(ok ? `Copied ${text} to the clipboard` : `Could not copy automatically. Select ${text} and press Ctrl+C.`);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(''), 2000);
  };
  return (
    <button
      type="button"
      className={cx(className ?? (iconOnly ? 'icon-btn' : 'btn btn-secondary btn-sm'), state === 'ok' && 'is-copied', state === 'fail' && 'is-copy-failed')}
      data-copy={text}
      data-copy-feedback={msg || undefined}
      aria-label={iconOnly ? msg || label : undefined}
      onClick={onClick}
    >
      <Icon name={state === 'ok' ? 'check' : icon} />
      {!iconOnly && <span>{msg || children}</span>}
    </button>
  );
}
