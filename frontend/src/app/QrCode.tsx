import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * A QR code drawn in the browser from text the API sends (a return drop-off code, a 2-step `otpauth://` link).
 * The API sends the text, not an image (G26a, G35). Shows an empty square of the same size while it draws.
 */
export function QrCode({ value, size = 168, label, className }: { value: string; size?: number; label: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    QRCode.toDataURL(value, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => live && setSrc(url))
      .catch(() => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [value, size]);
  return src ? (
    <img className={className} src={src} width={size} height={size} alt={label} />
  ) : (
    <span className={className} role="img" aria-label={label} style={{ display: 'inline-block', width: size, height: size }} />
  );
}
