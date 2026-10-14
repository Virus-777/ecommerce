/**
 * Health check on an internal port (HEALTH_PORT, plain HTTP, on HEALTH_HOST: this machine only by default). The
 * public API answers nothing without a token, so GET /health lives on its own listener: deploy/linux/check.sh and any
 * monitoring on the server read it; it is never exposed to the network.
 */
import { createServer, type Server } from 'node:http';

export function startHealthServer(health: () => unknown, port: number, host: string): Promise<Server> {
  const server = createServer((req, res) => {
    const ok = req.method === 'GET' && req.url === '/health';
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? health() : { error: 'not found' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
