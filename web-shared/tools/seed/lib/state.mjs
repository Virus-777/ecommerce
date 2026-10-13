// The seed's memory between runs: ids by stable keys and completed steps (web-shared/.seed/state.json, git-ignored).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class State {
  constructor(file) {
    this.file = file;
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    this.data.version ??= 1;
    this.data.done ??= {};
    this.data.ids ??= {};
  }

  /** Id (or record) stored under a dotted key, e.g. "category.electronics" */
  get(key) {
    return this.data.ids[key];
  }

  set(key, value) {
    this.data.ids[key] = value;
    this.save();
    return value;
  }

  /** A section of free-form data (owners, customers…) */
  section(name) {
    this.data[name] ??= {};
    return this.data[name];
  }

  isDone(step) {
    return Boolean(this.data.done[step]);
  }

  markDone(step) {
    this.data.done[step] = new Date().toISOString();
    this.save();
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}

/** Get a stored id or create the record once: `remember(state, key, async () => id)` */
export async function remember(state, key, create) {
  const known = state.get(key);
  if (known) return known;
  const id = await create();
  if (id !== undefined && id !== null) state.set(key, id);
  return id;
}
