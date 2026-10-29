/**
 * Marketing consent: email and SMS preferences with their consent log, and one-click unsubscribe.
 */
import type { Scope } from '../../../kernel/auth/scope.js';
import { AppError } from '../../../kernel/errors/index.js';
import { isUuid, newId } from '../../../kernel/lib/ids.js';
import type { MarketingPreferences, MarketingPreferencesInput } from '../../../spec/customers.js';
import * as map from '../mappers.js';
import type { ConsentRow, CustomerRow, PreferencesRow } from '../ports.js';
import { type Core, type By, type PrefKey, PREFS, PROMOTIONAL_OFF, notFound } from './core.js';
import type { Profiles } from './profiles.js';

export class Marketing {
  constructor(
    readonly core: Core,
    readonly profiles: Profiles,
  ) {}

  defaultPrefs(customerId: string, at: Date): PreferencesRow {
    return {
      customer_id: customerId,
      email_promotions: false,
      sms_promotions: false,
      push_promotions: false,
      wishlist_alerts: false,
      personalized_recommendations: true,
      recent_searches: true,
      updated_at: at,
    };
  }

  async prefsOf(c: CustomerRow): Promise<PreferencesRow> {
    return (await this.core.repo.getPreferences(c.id)) ?? this.defaultPrefs(c.id, c.created_at);
  }

  async getMarketingPreferences(scope: Scope): Promise<MarketingPreferences> {
    const c = await this.profiles.ownCustomer(scope);
    return map.preferences(await this.prefsOf(c), c.phone);
  }

  /** Promotional consent per channel plus the personalisation switches. Essential order messages ignore it. */
  async getMarketingConsent(customerId: string): Promise<MarketingPreferences> {
    if (!isUuid(customerId)) throw notFound('Customer');
    const [c, p] = await Promise.all([this.core.repo.getCustomer(customerId), this.core.repo.getPreferences(customerId)]);
    if (!c) throw notFound('Customer');
    return map.preferences(p ?? this.defaultPrefs(c.id, c.created_at), c.phone);
  }

  async updateMarketingPreferences(scope: Scope, body: MarketingPreferencesInput, by: By): Promise<MarketingPreferences> {
    const c = await this.profiles.ownCustomer(scope);
    const patch: Partial<Record<PrefKey, boolean>> = {};
    for (const k of Object.keys(PREFS) as PrefKey[]) if (typeof body[k] === 'boolean') patch[k] = body[k] as boolean;
    return this.changePreferences(c, patch, body.source ?? 'profile', { kind: 'customer', id: c.user_id, ip: by.ip ?? null }, by);
  }

  /** Only the fields sent change; every change is appended to the consent log */
  private async changePreferences(
    c: CustomerRow,
    patch: Partial<Record<PrefKey, boolean>>,
    source: string,
    who: { kind: string; id: string | null; ip?: string | null },
    by: By,
    publish = true,
  ): Promise<MarketingPreferences> {
    const now = this.core.now();
    const { prefs, changed } = await this.core.repo.transaction(async (repo) => {
      // read for update: `next` is this row with the changes, written back below (§11.2 rule 1)
      const cur = (await repo.getPreferences(c.id, { forUpdate: true })) ?? this.defaultPrefs(c.id, c.created_at);
      const next: PreferencesRow = { ...cur };
      const rows: ConsentRow[] = [];
      for (const k of Object.keys(PREFS) as PrefKey[]) {
        const v = patch[k];
        const [col, channel] = PREFS[k];
        if (typeof v !== 'boolean' || cur[col] === v) continue;
        next[col] = v;
        rows.push({ id: newId(), customer_id: c.id, channel, granted: v, source, actor_kind: who.kind, actor_id: who.id, ip: who.ip ?? null, at: now });
      }
      if (!rows.length) return { prefs: cur, changed: false };
      next.updated_at = now;
      const saved = await repo.upsertPreferences(next);
      await repo.insertConsent(rows);
      return { prefs: saved, changed: true };
    });
    if (changed && publish) {
      this.core.ctx.events.publish(
        'customers.marketing_preferences.changed',
        {
          customerId: c.id,
          emailPromotions: prefs.email_promotions,
          smsPromotions: prefs.sms_promotions,
          pushPromotions: prefs.push_promotions,
          wishlistAlerts: prefs.wishlist_alerts,
          personalizedRecommendations: prefs.personalized_recommendations,
          recentSearches: prefs.recent_searches,
          source,
        },
        this.core.meta(by),
      );
    }
    return map.preferences(prefs, c.phone);
  }

  /** POST /api/public/customers/unsubscribe: one-click stop from an email or SMS link (token signed by notifications) */
  async unsubscribe(body: { token: string; channel?: 'email' | 'sms' | 'push' | 'all' | null }, by: By): Promise<MarketingPreferences> {
    const refuse = () => new AppError('UNSUBSCRIBE_TOKEN_INVALID', 'This unsubscribe link is invalid or has expired');
    const notifications = this.core.ctx.tryUse('notifications');
    if (!notifications || typeof body.token !== 'string' || !body.token) throw refuse();
    const t = await notifications.verifyUnsubscribeToken(body.token);
    if (!t || t.audience !== 'customer' || !t.accountId) throw refuse();
    const c = await this.core.repo.getCustomerByUserId(t.accountId);
    if (!c) throw refuse();
    const channel = body.channel ?? t.channel;
    const patch: Partial<Record<PrefKey, boolean>> =
      channel === 'all' ? { ...PROMOTIONAL_OFF } : channel === 'sms' ? { smsPromotions: false } : channel === 'push' ? { pushPromotions: false } : { emailPromotions: false };
    return this.changePreferences(c, patch, 'unsubscribe_link', { kind: 'customer', id: c.user_id, ip: by.ip ?? null }, by);
  }
}
