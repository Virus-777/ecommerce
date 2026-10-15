/**
 * The embedded replica set with MONGO_DATA_DIR keeps its data between restarts (R2): the replica set config stored
 * in the folder names the set and host:port, so both are fixed and the second start finds itself in it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { connectMongo, EMBEDDED_REPLICA_SET } from './index.js';

/** Listens on a free port until closed */
const listen = () =>
  new Promise<{ server: Server; port: number }>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
  });

const freePort = async () => {
  const { server, port } = await listen();
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const dir = mkdtempSync(join(tmpdir(), 'marketly-mongo-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('embedded MongoDB with a data folder', () => {
  it('starts again on the same folder and keeps the data', async () => {
    const port = await freePort();
    const first = await connectMongo({ dataDir: dir, port, dbName: 'restart' });
    expect(first.connection.port).toBe(port);
    await first.db.collection('notes').insertOne({ text: 'kept' });
    await first.close();

    // a real restart is a new process; in this one, mongodb-memory-server remembers the ports it handed out for 10 s
    await sleep(10_500);
    const second = await connectMongo({ dataDir: dir, port, dbName: 'restart' });
    try {
      expect(second.connection.port).toBe(port);
      expect(await second.db.collection('notes').findOne({}, { projection: { _id: 0 } })).toEqual({ text: 'kept' });
      expect((await second.db.admin().command({ replSetGetStatus: 1 })).set).toBe(EMBEDDED_REPLICA_SET);
    } finally {
      await second.close();
    }
  }, 120_000);

  it('says so when the port is taken, instead of starting on another one', async () => {
    const busy = await listen();
    try {
      await expect(connectMongo({ dataDir: dir, port: busy.port })).rejects.toThrow(`MONGO_PORT ${busy.port} is in use`);
    } finally {
      busy.server.close();
    }
  });
});
