import { cloneElement, isValidElement, type InputHTMLAttributes, type Ref, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cx } from '@/lib/cx';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';

/**
 * Form field: label + control + hint or error. The control must carry `id`; Field wires
 * `htmlFor`, `aria-describedby` and `aria-invalid` from it.
 */
export function Field({ label, hint, error, optional, className, children, labelClassName }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; optional?: boolean; className?: string; labelClassName?: string; children: ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }> }) {
  const id = isValidElement(children) ? children.props.id : undefined;
  const msgId = id ? `${id}-${error ? 'err' : 'hint'}` : undefined;
  const control = isValidElement(children) && (hint || error) ? cloneElement(children, { 'aria-describedby': msgId, ...(error ? { 'aria-invalid': true } : {}) }) : children;
  return (
    <div className={cx('field', className)}>
      <label className={cx('label', labelClassName)} htmlFor={id}>
        {label}
        {optional && (
          <>
            {' '}
            <span className="opt">(optional)</span>
          </>
        )}
      </label>
      {control}
      {error ? (
        <span className="error-text" id={msgId}>
          <Icon name="circle-alert" className="ic-sm" />
          {error}
        </span>
      ) : hint ? (
        <span className="hint" id={msgId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  id: string;
  /** Leading/trailing text inside the field ($, %, kg). */
  prefix?: ReactNode;
  suffix?: ReactNode;
  icon?: IconName;
  error?: boolean;
  size?: never;
  /** Control height: sm | md. */
  ctl?: 'sm' | 'md';
  ref?: Ref<HTMLInputElement>;
}

/** .input, optionally inside an .input-group with prefix/suffix/icon. Uncontrolled unless `value` is given. */
export function TextInput({ id, prefix, suffix, icon, error, ctl, className, type = 'text', ...rest }: TextInputProps) {
  const input = <input className={cx('input', error && 'is-error', ctl, className)} id={id} type={type} aria-invalid={error || undefined} {...rest} />;
  if (!prefix && !suffix && !icon) return input;
  return (
    <span className="input-group">
      {icon && <Icon name={icon} className="ic-sm" />}
      {prefix && <span className="affix">{prefix}</span>}
      {input}
      {suffix && <span className="affix">{suffix}</span>}
    </span>
  );
}

/** .select from a list of options (strings or {value,label}). */
export function Select({ id, options, className, ctl, ...rest }: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & { id: string; options: Array<string | { value: string; label: string }>; ctl?: 'sm' | 'md' }) {
  return (
    <select className={cx('select', ctl, className)} id={id} {...rest}>
      {options.map((o) => (typeof o === 'string' ? <option key={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
    </select>
  );
}

export function Textarea({ id, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { id: string; ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea className={cx('textarea', className)} id={id} {...rest} />;
}

type CheckProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { id: string; label: ReactNode; className?: string };

/** Checkbox with label (.check). */
export function Checkbox({ id, label, className, ...rest }: CheckProps) {
  return (
    <label className={cx('check', className)} htmlFor={id}>
      <input type="checkbox" id={id} {...rest} />
      <span>{label}</span>
    </label>
  );
}

/** Radio with label (.check). */
export function Radio({ id, label, className, ...rest }: CheckProps & { name: string }) {
  return (
    <label className={cx('check', className)} htmlFor={id}>
      <input type="radio" id={id} {...rest} />
      <span>{label}</span>
    </label>
  );
}

/** On/off switch (.switch): a checkbox with role=switch. */
export function Switch({ id, label, className, labelClassName = 'small', ...rest }: CheckProps & { labelClassName?: string }) {
  return (
    <label className={cx('switch', className)} htmlFor={id}>
      <input type="checkbox" role="switch" id={id} {...rest} />
      <span className={labelClassName}>{label}</span>
    </label>
  );
}

/** Radio card (.opt-card): title, body text and optional right-hand content. */
export function OptionCard({ id, name, title, body, right, checked, defaultChecked, disabled, onChange, className }: { id: string; name: string; title: ReactNode; body?: ReactNode; right?: ReactNode; checked?: boolean; defaultChecked?: boolean; disabled?: boolean; onChange?: () => void; className?: string }) {
  return (
    <label className={cx('opt-card', checked && 'is-selected', disabled && 'is-disabled', className)} htmlFor={id}>
      <input type="radio" name={name} id={id} checked={checked} defaultChecked={defaultChecked} disabled={disabled} onChange={onChange} />
      <span className="stack gap-1 grow">
        {title}
        {body && <span className="small sub">{body}</span>}
      </span>
      {right && <span className="none">{right}</span>}
    </label>
  );
}

/** File drop zone with a browse button. Calls onFiles with picked/dropped files. */
export function FileDrop({ title = 'Drag photos here or browse', hint = 'JPG or PNG, up to 10 MB each', accept = 'image/jpeg,image/png', multiple = true, onFiles }: { title?: ReactNode; hint?: ReactNode; accept?: string; multiple?: boolean; onFiles?: (files: File[]) => void }) {
  let input: HTMLInputElement | null = null;
  return (
    <div
      className="dropzone"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onFiles?.(Array.from(e.dataTransfer.files));
      }}
    >
      <Icon name="image-plus" className="ic-lg" />
      <span className="small strong u-c-text">{title}</span>
      <span className="xs">{hint}</span>
      <input ref={(el) => { input = el; }} type="file" hidden accept={accept} multiple={multiple} onChange={(e) => onFiles?.(Array.from(e.target.files ?? []))} />
      <Button variant="secondary" size="sm" onClick={() => input?.click()}>
        Browse files
      </Button>
    </div>
  );
}
