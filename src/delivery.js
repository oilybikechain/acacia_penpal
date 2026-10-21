const { setTimeout: sleep } = require('node:timers/promises');

class Delivery {
  constructor(store, telegram, options = {}) {
    this.store = store; this.telegram = telegram; this.sleep = options.sleep || sleep;
    this.delay = options.delay ?? 60; this.running = null; this.stopping = false;
  }
  async recover() {
    await this.store.update(s => {
      for (const j of Object.values(s.jobs)) for (const i of j.items)
        if (i.status === 'sending') i.status = 'uncertain';
    });
  }
  kick() {
    if (!this.running && !this.stopping) this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }
  async drain() {
    while (!this.stopping) {
      if (!Object.values(this.store.read().jobs).some(j => j.items.some(i => i.status === 'pending'))) return;
      const claimed = await this.store.update(s => {
        for (const j of Object.values(s.jobs)) {
          const index = j.items.findIndex(i => i.status === 'pending');
          if (index >= 0) { const item = j.items[index]; item.status = 'sending'; item.attempts++; return { jobId: j.id, index, ...item }; }
        }
        return null;
      });
      if (!claimed) return;
      let status = 'sent', errorCode = null;
      try { await this.telegram.sendMessage(claimed.userId, claimed.text, { protect_content: true }); }
      catch (error) {
        const code = error.response?.error_code;
        errorCode = code || 'NETWORK';
        // Network failures may occur after Telegram accepted a message.
        status = code ? 'failed' : 'uncertain';
        if (code === 429) {
          status = 'pending';
          await this.sleep(Math.max(1, error.response.parameters?.retry_after || 1) * 1000);
        }
      }
      await this.store.update(s => {
        const i = s.jobs[claimed.jobId]?.items[claimed.index];
        if (i) { i.status = status; i.errorCode = errorCode; }
      });
      await this.sleep(this.delay);
    }
  }
  async stop() { this.stopping = true; await this.running; }
}
module.exports = { Delivery };
