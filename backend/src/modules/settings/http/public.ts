import { routes } from '../../../kernel/http/index.js';
import { endpoints } from '../../../spec/settings.js';
import type { SettingsService } from '../service.js';

/**
 * Public API: /api/public/settings/…  (docs/api/modules/settings.md)
 * One handler per endpoint of this area in the spec; the compiler rejects missing or extra ones.
 */
export const publicRoutes = (service: SettingsService) =>
  routes(endpoints, 'public', {
    /**
     * GET /app-config: Configuration for the website and Android app.
     * Kept by the client for appConfigCacheSeconds, then revalidated: the ETag is the configVersion, and a
     * matching If-None-Match answers 304. (The kernel leaves a /api/public endpoint's own Cache-Control alone;
     * every other API answer is private, no-store.)
     */
    getAppConfig: async ({ query, request, reply }) => {
      const { config, maxAgeSeconds } = await service.appConfig(query);
      const etag = `"${config.configVersion}"`;
      reply.header('etag', etag).header('cache-control', `private, max-age=${maxAgeSeconds}`);
      const match = request.headers['if-none-match'];
      if (match && match.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
        await reply.code(304).send();
      }
      return config;
    },
  });
