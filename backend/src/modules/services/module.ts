import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/services.js';
import { storeRoutes } from './http/store.js';
import { mongoMigrations } from './migrations.js';
import { adminRoutes } from './http/admin.js';
import { ServicesRepository } from './repository.js';
import { schemas } from './schema.js';
import { ServicesService } from './service.js';

/**
 * Services: Services customers request or book in the app's department pages: OS installs and post-sale repairs (Phones), welfare services and time-slot bookings. Staff keep the providers, their services and opening hours, and handle every request in Admin › Departments. No online payment at this phase: customers pay the provider.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/services.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '1.1.0',
  schemas,
  mongoMigrations,
  register(ctx) {
    const service = new ServicesService({ repo: new ServicesRepository(ctx.mongo), ctx });
    ctx.provide(service);
    ctx.http.routes(storeRoutes(service), adminRoutes(service));
  },
});
