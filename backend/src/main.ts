import { buildApp } from './app.js';
import { startHealthServer } from './kernel/http/health.js';
import { startRedirectServer } from './kernel/http/redirect.js';

const app = await buildApp();
const config = app.kernel.config;
const { host, port, healthPort, healthHost, launchPhase } = config;

await app.listen({ host, port });
const health = await startHealthServer(() => app.kernel.health(), healthPort, healthHost);
// HTTPS only: plain http://… answers 301 to the https address
const redirect = config.tls && config.httpRedirectPort !== undefined ? await startRedirectServer(config, config.httpRedirectPort, host) : undefined;

const shutdown = async (signal: string) => {
  app.log.info(`${signal}: shutting down`);
  health.close();
  redirect?.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

const scheme = config.tls ? 'https' : 'http';
app.log.info(
  `Marketly API on ${scheme}://${host}:${port} · ${app.kernel.modules.length} modules · launch phase ${launchPhase} · health on ${healthHost}:${healthPort}/health` +
    (redirect ? ` · http :${config.httpRedirectPort} redirects to https` : '') +
    (config.adminAppDir ? ` · Admin Center from ${config.adminAppDir}` : ''),
);
