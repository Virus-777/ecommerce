import { useRef } from 'react';
import { useMarket } from '../api/appConfig';
import { DEFAULT_PHONE_FORMAT, phoneEdit, phoneExample } from '../lib/phone';
import { TextInput, type TextInputProps } from './Forms';

/**
 * A phone number field masked as the customer types with the market's phone format (app-config
 * market.phoneFormat, e.g. (###) ###-####; rules in lib/phone), with an example number in that format as its
 * placeholder ((201) 555-0123). Same props as TextInput; `onChange` gets the event with the formatted value already
 * in the field.
 *   <PhoneInput id="pf-phone" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
 */
export function PhoneInput({ value, onChange, ...rest }: Omit<TextInputProps, 'type' | 'placeholder'>) {
  const { market } = useMarket();
  const pattern = market?.phoneFormat?.includes('#') ? market.phoneFormat : DEFAULT_PHONE_FORMAT;
  const last = useRef('');
  if (value !== undefined) last.current = String(value);
  return (
    <TextInput
      {...rest}
      type="tel"
      placeholder={phoneExample(pattern)}
      value={value}
      onChange={(e) => {
        const el = e.currentTarget;
        const r = phoneEdit(last.current, el.value, el.selectionStart ?? el.value.length, pattern);
        if (r.value !== el.value) {
          el.value = r.value;
          el.setSelectionRange(r.caret, r.caret);
        }
        last.current = r.value;
        onChange?.(e);
      }}
    />
  );
}
