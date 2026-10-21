const { setTimeout: sleep } = require('node:timers/promises');

// Own the polling loop so framework error logs cannot print submitted passwords
// or token-bearing network URLs. Process updates sequentially and retain offsets.
async function initialiseBot(bot) {
  const info = await bot.telegram.getMe();
  bot.options.username = info.username;
  bot.context.botInfo = info;
  await bot.telegram.deleteWebhook();
}
async function poll(bot, label, store, control, wait = sleep) {
  while (!control.stopped) {
    try {
      const offset = store.read().offsets?.[label] || 0;
      const updates = await bot.telegram.getUpdates(15, 100, offset, ['message', 'callback_query']);
      for (const update of updates) {
        if (control.stopped) break;
        await bot.handleUpdate(update);
        await store.update(s => { s.offsets ||= {}; s.offsets[label] = update.update_id + 1; });
      }
    } catch (error) {
      const code = error.response?.error_code || error.code;
      if (code === 401 || code === 409) throw new Error(`${label} polling stopped; check token and ensure only one instance is running`);
      console.error(`${label} polling interrupted; retrying. Details omitted to protect credentials.`);
      await wait(Math.max(1,error.response?.parameters?.retry_after || 3) * 1000);
    }
  }
}
module.exports = { initialiseBot, poll };
