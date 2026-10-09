/**
 * Secrets for links and tokens a module signs itself (unsubscribe and reply-to tokens, signed storage
 * URLs, audit checkpoints). One root secret (APP_SECRET) is configured; each purpose gets its own key
 * derived with HKDF, so a leaked or rotated purpose key never exposes another.
 */
import { hkdfSync } from 'node:crypto';
import type { Config } from '../config/index.js';

/** 32-byte key for one purpose, e.g. secretFor(ctx.config, 'notifications.unsubscribe'), hex encoded */
export function secretFor(config: Pick<Config, 'appSecret'>, purpose: string): string {
  if (!config.appSecret) throw new Error('APP_SECRET is not configured');
  return Buffer.from(hkdfSync('sha256', config.appSecret, 'marketly', purpose, 32)).toString('hex');
}
