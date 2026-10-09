/**
 * Load-balancer health check on an internal port. The public API answers nothing without a token,
 * so GET /health lives on its own listener (HEALTH_PORT), never exposed through the proxy.
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
