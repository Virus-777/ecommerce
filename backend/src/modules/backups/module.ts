import { defineModule } from '../../kernel/module-system/index.js';
import { spec } from '../../spec/backups.js';
import { adminRoutes } from './http/admin.js';
import { backupFiles } from './http/files.js';
import { fileOps, unavailableOps } from './providers/ops.js';
import { BackupsRepository } from './repository.js';
import { schemas } from './schema.js';
import { BackupsService } from './service.js';

/**
 * Backups: Backups of the whole system (database, uploaded files, settings and keys) from the Admin Center: the list of backups on the server, a backup now, downloads, uploads and restores with two-person approval. The server's root backup service (deploy/linux ops.sh) does the work; this module asks it through request files and reports what it did.
 *
 * Name, launch phase, dependencies, permissions, events, jobs, settings and endpoints come from
 * docs/api/spec/modules/backups.json through `spec`; the server refuses to start if they drift.
 */
export default defineModule({
  spec,
  version: '0.1.0',
  schemas,
  register(ctx) {
    // the server's backup service (deploy/linux) is reached through BACKUP_OPS_DIR; without it (development
    // machines) the screen explains that backups are made by the production server
    const ops = ctx.config.backups
      ? fileOps(ctx.config.backups)
      : unavailableOps('Backups are made by the production server’s backup service (deploy/linux). This server has none (BACKUP_OPS_DIR is not set).');
    const service = new BackupsService({ repo: new BackupsRepository(ctx.mongo), ctx, ops });
    ctx.provide(service);
    ctx.http.routes(adminRoutes(service));
    if (ops.available) ctx.http.files(backupFiles(service));

    // Events this module reacts to (spec events.consumes)
    ctx.events.on("access.approval.decided", (e) => service.onApprovalDecidedFromAccess(e.payload));
    ctx.events.on("settings.setting.changed", (e) => service.onSettingChangedFromSettings(e.payload));

    // Background jobs (spec jobs)
    ctx.jobs.handle("backups.watch-operations", () => service.watchOperations());
    // after a restore the database is the backup's: rebuild the operations it doesn't have from the status files
    ctx.afterBoot(() => service.watchOperations().catch((err) => ctx.log.warn({ err }, 'backups: backup service status not read at boot')));
  },
});
