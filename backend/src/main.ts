import { buildApp } from './app.js';
import { startHealthServer } from './kernel/http/health.js';

const app = await buildApp();
const { host, port, healthPort, launchPhase } = app.kernel.config;

await app.listen({ host, port });
const health = await startHealthServer(() => app.kernel.health(), healthPort, host);

const shutdown = async (signal: string) => {
  app.log.info(`${signal}: shutting down`);
  health.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

app.log.info(`Marketly API on http://localhost:${port} · ${app.kernel.modules.length} modules · launch phase ${launchPhase} · health on :${healthPort}/health`);
