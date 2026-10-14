#!/usr/bin/env tsx
/**
 * npm run db-setup     (production: node --env-file=/etc/marketly/marketly.env dist/tools/db-setup.js)
 *
 * Makes the MongoDB server in MONGODB_URI a one-member replica set (transactions need a replica set), once:
 *   - connects straight to the host in the URI (directConnection: a set that does not exist yet has no primary);
 *   - not yet a replica set: replSetInitiate with the set name from the URI (replicaSet=…, default rs0) and that host;
 *   - waits until the member is PRIMARY and prints the state.
 * Harmless when the set is already initiated: it only prints the state. mongod itself must run with
 * replication.replSetName set (deploy/linux/mongod.conf); this tool tells you when it does not.
 */
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('Set MONGODB_URI (e.g. mongodb://127.0.0.1:27017/marketly?replicaSet=rs0), in .env.production or /etc/marketly/marketly.env.');
  process.exit(1);
}

let url: URL;
try {
  url = new URL(uri);
} catch {
  console.error('MONGODB_URI is not a single-host mongodb:// address; db-setup sets up one server (mongodb://host:port/db?replicaSet=rs0).');
  process.exit(1);
}
if (url.protocol !== 'mongodb:') {
  console.error(`MONGODB_URI must start with mongodb:// (got ${url.protocol}//)`);
  process.exit(1);
}
const setName = url.searchParams.get('replicaSet') || 'rs0';
// the member's address as the replica set will know it: the host in the URI, with the default port spelled out
const host = url.port ? url.host : `${url.host}:27017`;
// the same server and credentials, straight to it (no replica-set discovery), on the admin database
const direct = new URL(uri);
direct.pathname = '/';
direct.searchParams.delete('replicaSet');
direct.searchParams.set('directConnection', 'true');

const client = new mongoose.mongo.MongoClient(direct.toString(), { serverSelectionTimeoutMS: 10_000 });
const admin = () => client.db('admin');

/** replSetGetStatus, or the reason there is none: 94 = not initiated yet, 76 = mongod runs without a replica set name */
async function status(): Promise<{ ok: true; set: string; members: { name: string; stateStr: string }[] } | { ok: false; code: number; message: string }> {
  try {
    const s = await admin().command({ replSetGetStatus: 1 });
    return { ok: true, set: s.set as string, members: s.members as { name: string; stateStr: string }[] };
  } catch (err) {
    const e = err as { code?: number; message: string };
    return { ok: false, code: e.code ?? 0, message: e.message };
  }
}

try {
  try {
    await client.connect();
  } catch (err) {
    console.error(`Cannot reach MongoDB at ${host}: ${(err as Error).message}`);
    console.error('Is it running? On the server: systemctl status mongod');
    process.exit(1);
  }

  let s = await status();
  if (!s.ok && s.code === 76) {
    console.error(`MongoDB at ${host} does not run as a replica set member (${s.message}).`);
    console.error(`Add to /etc/mongod.conf:\n  replication:\n    replSetName: ${setName}\nthen: systemctl restart mongod, and run this again.`);
    process.exit(1);
  }
  if (!s.ok && s.code === 94) {
    console.log(`Initiating replica set ${setName} with the member ${host} …`);
    await admin().command({ replSetInitiate: { _id: setName, members: [{ _id: 0, host }] } });
  } else if (!s.ok) {
    throw new Error(`replSetGetStatus failed: ${s.message}`);
  } else if (s.set !== setName) {
    console.error(`MongoDB at ${host} belongs to replica set "${s.set}", but MONGODB_URI says replicaSet=${setName}. Make them the same.`);
    process.exit(1);
  } else {
    console.log(`Replica set ${s.set} is already initiated.`);
  }

  // a new set elects its primary within a few seconds
  const deadline = Date.now() + 60_000;
  for (;;) {
    const hello = await admin().command({ hello: 1 });
    if (hello.isWritablePrimary) break;
    if (Date.now() > deadline) throw new Error(`${host} did not become PRIMARY within 60 s; see: mongosh --eval "rs.status()"`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  s = await status();
  if (!s.ok) throw new Error(s.message);
  console.log(`Replica set ${s.set}:`);
  for (const m of s.members) console.log(`  ${m.name}  ${m.stateStr}`);
  const self = s.members.find((m) => m.stateStr === 'PRIMARY');
  console.log(self ? `OK: ${self.name} is PRIMARY. MONGODB_URI can connect with replicaSet=${s.set}.` : 'No member is PRIMARY yet.');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await client.close();
}
