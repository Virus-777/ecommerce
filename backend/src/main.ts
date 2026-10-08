import { buildApp } from './app.js';

const app = await buildApp();
const { host, port, launchPhase } = app.kernel.config;

const shutdown = async (signal: string) => {
  app.log.info(`${signal}: shutting down`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host, port });
app.log.info(`Marketly API on http://localhost:${port} · ${app.kernel.modules.length} modules · launch phase ${launchPhase} · docs at /docs`);
