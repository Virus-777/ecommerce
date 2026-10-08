import { notImplemented, routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/settings.js';
import type { SettingsService } from '../service.js';

/**
 * Public API: /api/public/settings/…  (docs/api/modules/settings.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const publicRoutes = (service: SettingsService) => {
  void service;
  return routes(endpoints, 'public', {
    /** GET /app-config: Configuration for the website and Android app */
    getAppConfig: notImplemented,
  });
};
