const { setTimeout: sleep } = require('node:timers/promises');
const { textChunks } = require('./messages');

async function downloadPhoto(telegram, fileId, fetcher = fetch) {
  const link = await telegram.getFileLink(fileId);
  const response = await fetcher(String(link), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Photo download failed');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw new Error('Photo exceeds 10 MB');
    chunks.push(Buffer.from(chunk));
  }
  if (!size) throw new Error('Photo is empty');
  return Buffer.concat(chunks);
}

class Delivery {
  constructor(store, telegram, options = {}) {
    this.store = store; this.telegram = telegram; this.sleep = options.sleep || sleep;
    this.delay = options.delay ?? 60; this.running = null; this.stopping = false;
    this.sourceTelegram = options.sourceTelegram; this.fetch = options.fetch || fetch;
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
        const jobs = Object.values(s.jobs).sort((a, b) => String(a.created).localeCompare(String(b.created)));
        for (const j of jobs) {
          const index = j.items.findIndex(i => i.status === 'pending');
          if (index >= 0) { const item = j.items[index]; item.status = 'sending'; item.attempts++; return { jobId: j.id, index, photo: j.photo, photoFileId: j.photoFileId, ...item }; }
        }
        return null;
      });
      if (!claimed) return;
      let status = 'sent', errorCode = null, sending = false, photoFileId;
      try {
        if (claimed.photo) {
          // File IDs belong to one bot. Upload bytes from the admin bot once,
          // then reuse the participant bot's file ID for later recipients/retries.
          const photo = claimed.photoFileId || { source: await downloadPhoto(this.sourceTelegram, claimed.photo, this.fetch), filename: 'broadcast.jpg' };
          sending = true;
          const sent = await this.telegram.sendPhoto(claimed.userId, photo, { caption: claimed.text, protect_content: true });
          photoFileId = sent?.photo?.at(-1)?.file_id;
        } else {
          sending = true;
          for (const chunk of textChunks(claimed.text, claimed.textOffset || 0)) {
            await this.telegram.sendMessage(claimed.userId, chunk.text, { protect_content: true });
            await this.store.update(s => {
              s.jobs[claimed.jobId].items[claimed.index].textOffset = chunk.end;
            });
            if (chunk.end < claimed.text.length) await this.sleep(this.delay);
          }
        }
      }
      catch (error) {
        const code = error.response?.error_code;
        errorCode = code || 'NETWORK';
        // Network failures may occur after Telegram accepted a message.
        status = (code || !sending) ? 'failed' : 'uncertain';
        if (code === 429) {
          status = 'pending';
          await this.sleep(Math.max(1, error.response.parameters?.retry_after || 1) * 1000);
        }
      }
      await this.store.update(s => {
        const i = s.jobs[claimed.jobId]?.items[claimed.index];
        if (i) { i.status = status; i.errorCode = errorCode; }
        if (photoFileId) s.jobs[claimed.jobId].photoFileId = photoFileId;
      });
      await this.sleep(this.delay);
    }
  }
  async stop() { this.stopping = true; await this.running; }
}
module.exports = { Delivery, downloadPhoto };
