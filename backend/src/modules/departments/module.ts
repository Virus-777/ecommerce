import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/departments.js';
import { storeRoutes } from './http/store.js';
import { adminRoutes } from './http/admin.js';
import { gameKeyVerifier, webhooksRoutes } from './http/webhooks.js';
import { mongoMigrations } from './migrations.js';
import { DepartmentsRepository } from './repository.js';
import { schemas } from './schema.js';
import { DepartmentsService } from './service.js';

/**
 * Departments: The app's department pages opened from the home Departments rail: the Phones picks, Blogs (topics, staff authors, posts, reactions, replies and reports), the Companies directory (industries, company pages, inquiries) and the Play center (games and ranking tables). Staff manage all of it in Admin › Departments.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/departments.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.2.0',
  schemas,
  mongoMigrations,
  register(ctx) {
    const service = new DepartmentsService({ repo: new DepartmentsRepository(ctx.mongo), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), adminRoutes(service), webhooksRoutes(service));
    // game partners post scores with their game's server key (X-Game-Key), not a signature
    ctx.http.webhookVerifier(gameKeyVerifier(service));
    ctx.jobs.handle('departments.award-prize-weeks', () => service.awardPrizeWeeks());
  },
});
