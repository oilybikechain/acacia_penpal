const path = require('node:path');
const { Store } = require('./store');
const { Game } = require('./game');
const { Delivery } = require('./delivery');
const { createBots } = require('./bots');
const { initialiseBot, poll } = require('./polling');
const fs = require('node:fs/promises');

async function main() {
  const { PARTICIPANT_BOT_TOKEN, ADMIN_BOT_TOKEN, ADMIN_TELEGRAM_IDS } = process.env;
  const ids = (ADMIN_TELEGRAM_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  if (!PARTICIPANT_BOT_TOKEN || !ADMIN_BOT_TOKEN || PARTICIPANT_BOT_TOKEN === ADMIN_BOT_TOKEN ||
      !ids.length || ids.some(id => !/^[1-9]\d*$/.test(id)))
    throw new Error('Configure two distinct bot tokens and numeric ADMIN_TELEGRAM_IDS in .env');
  const directory = path.resolve(process.env.DATA_DIR || './data');
  await fs.mkdir(directory, { recursive: true });
  // Deliberately retain a stale lock after an unclean crash: verify no process is
  // running before removing it. This avoids two processes overwriting game data.
  const lockPath = path.join(directory, 'process.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); await lock.writeFile(String(process.pid)); }
  catch { throw new Error('Storage is locked; check for an existing process or stale process.lock'); }
  const control = { stopped: false };
  let timer, delivery, stop;
  const release = async () => { await lock.close(); await fs.unlink(lockPath); };
  try {
    const store = await new Store(directory).init();
    const game = new Game(store);
    delivery = new Delivery(store, null);
    const { participant, admin } = createBots({ game, store, delivery, participantToken: PARTICIPANT_BOT_TOKEN,
      adminToken: ADMIN_BOT_TOKEN, adminIds: new Set(ids) });
    delivery.telegram = participant.telegram;
    await delivery.recover();
    await Promise.all([initialiseBot(participant), initialiseBot(admin)]);
    delivery.kick()?.catch(() => console.error('Delivery worker stopped. Restart to recover.'));
    timer = setInterval(() => delivery.kick()?.catch(() => console.error('Delivery worker stopped. Check storage.')), 5000);
    stop = () => { control.stopped = true; clearInterval(timer); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    console.log('ACACIA participant and admin bots started.');
    const guardedPoll = (bot, label) => poll(bot, label, store, control).catch(error => { stop(); throw error; });
    const results = await Promise.allSettled([guardedPoll(participant, 'participant'), guardedPoll(admin, 'admin')]);
    const failure = results.find(r => r.status === 'rejected');
    if (failure) throw failure.reason;
  } finally {
    control.stopped = true; clearInterval(timer);
    if (stop) { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    if (delivery) await delivery.stop();
    await release();
  }
}
if (require.main === module) main().catch(() => { console.error('Startup failed. Check .env, storage, and Telegram connectivity.'); process.exitCode = 1; });
module.exports = { main };
