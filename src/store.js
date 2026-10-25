const fs = require('node:fs/promises');
const path = require('node:path');
const { prepareBroadcastHistory } = require('./broadcasts');

function freshState() {
  return { version: 1, revision: 0, accounts: {}, profiles: [], batches: {}, compatibility: null,
    pairs: [], pairingReady: false, phase: 'draft', hintSecrets: {}, jobs: {}, pending: {}, audit: [], offsets: {} };
}

class Store {
  constructor(directory) { this.directory = directory; this.tail = Promise.resolve(); }
  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    try { this.state = JSON.parse(await fs.readFile(path.join(this.directory, 'state.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.state = freshState(); }
    if (this.state.version !== 1) throw new Error('Unsupported storage version');
    this.state.batches ||= {};
    prepareBroadcastHistory(this.state);
    return this;
  }
  read() { return structuredClone(this.state); }
  update(fn) {
    const task = this.tail.then(async () => {
      const next = this.read();
      const result = await fn(next);
      next.revision++;
      const target = path.join(this.directory, 'state.json');
      const temporary = path.join(this.directory, 'state.tmp');
      const file = await fs.open(temporary, 'w', 0o600);
      try { await file.writeFile(JSON.stringify(next, null, 2)); await file.sync(); }
      finally { await file.close(); }
      await fs.rename(temporary, target);
      this.state = next;
      return result;
    });
    this.tail = task.catch(() => {});
    return task;
  }
}
module.exports = { Store, freshState };
