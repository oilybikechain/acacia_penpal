const { Telegraf } = require('telegraf');
const { parseRoster, csv, FIELDS } = require('./imports');
const { participantStatus, partnerFor, batchProfiles, broadcastRecipients } = require('./game');
const { textChunks } = require('./messages');

const PARTICIPANT_HELP = 'Welcome to ACACIA Penpal!\n/start — register, even before survey data is uploaded\n/status — check your registration or penpal assignment\n/hint <password> — unlock a penpal hint during the game\n/help — show this help\n\nThe organisers will start the game later. This bot does not relay messages.';
const ADMIN_HELP = `ACACIA admin console
/menu — management buttons
/summary — game and registration counts
/import — upload a survey CSV next (replaces the draft roster after confirmation)
/addpeople <batch> — upload a CSV of new people; preserve existing pairs
/batches — list imported batches and registered recipients
/pairnew <batch> — preview pairs within a batch, preserving existing pairs
/list [search] — participant profiles
/accounts [search] — registered Telegram accounts, including pending accounts
/edit <code> <field> <value> — correct a draft profile
/link <telegram_id> <code> — link a registered account to a profile
/unlink <telegram_id> — remove a mistaken account binding
/generate — generate or regenerate draft pairs
/pairs — review pairs, introductory notes, and waitlist
/pair <code> <code> — manually pair; previous partners become waitlisted
/approve — approve the current pairing preview
/sethint <house|major|year|gender|name> <password> — configure a distinct hint password
/launch — preview game launch
/pause, /resume, /end — control the game
/broadcast <text> — preview text, or reply to a photo with an optional caption
/broadcast — upload a single photo next, with an optional caption
/broadcastbatch <batch> [text] — text/photo announcement to one batch only
/jobs — delivery results
/retry <job_id> — retry failed deliveries only
/retryuncertain <job_id> — explicitly retry uncertain deliveries; duplicates are possible
/export — roster and assignment CSV
/backup — complete private game backup, including password hashes
/audit — recent management actions
/reset — download backup, then confirm game reset; registrations are preserved
/confirm <token> — confirm the latest preview (expires in 15 minutes)
/cancel — discard the latest preview or upload request`;

function args(ctx) { return (ctx.message?.text || '').replace(/^\/\w+(?:@\w+)?\s*/, ''); }
async function replyLong(ctx, text) {
  for (const chunk of textChunks(text)) await ctx.reply(chunk.text);
}
function privateOnly(ctx, next) { return ctx.chat?.type === 'private' ? next() : Promise.resolve(); }
function adminOnly(ids) {
  return (ctx, next) => ids.has(String(ctx.from?.id)) ? next() : ctx.reply('Not authorised.');
}
function summary(s) {
  const accounts = Object.values(s.accounts), linked = accounts.filter(a => a.profileId).length;
  return `Game: ${s.phase}\nRegistered accounts: ${accounts.length}\nLinked accounts: ${linked}\nPending accounts: ${accounts.length - linked}\nSurvey profiles: ${s.profiles.length}\nPairs: ${s.pairs.length}\nUnpaired profiles: ${s.profiles.length - s.pairs.length * 2}\nPairings approved: ${s.pairingReady ? 'yes' : 'no'}\nMatching: equal MBTI weights\nHint passwords configured: ${Object.keys(s.hintSecrets).length}/5`;
}
function pairPreview(s, heading = summary(s)) {
  const byId = id => s.profiles.find(p => p.id === id);
  const lines = [heading, '\nPAIRS — review notes for identifying information before sending'];
  for (const [aId,bId] of s.pairs) {
    const a = byId(aId), b = byId(bId);
    lines.push(`\n${a.code} ${a.name} (${a.nickname}, ${a.house}, ${a.gender}, wants ${a.preference}, ${a.mbti}) ↔ ${b.code} ${b.name} (${b.nickname}, ${b.house}, ${b.gender}, wants ${b.preference}, ${b.mbti})\n${a.nickname}'s note: ${a.note}\n${b.nickname}'s note: ${b.note}`);
  }
  lines.push('\nWAITLIST');
  for (const p of s.profiles.filter(p => !partnerFor(s, p.id))) lines.push(`${p.code} ${p.name} — no valid partner assigned`);
  lines.push('\nPENDING ACCOUNTS');
  for (const a of Object.values(s.accounts).filter(a => !a.profileId)) lines.push(`${a.id} @${a.username || '(no handle)'} — profile not linked`);
  return lines.join('\n');
}
async function downloadCsv(ctx, fetcher = fetch) {
  const doc = ctx.message.document;
  if (!/\.csv$/i.test(doc.file_name || '')) throw new Error('Please upload a .csv file');
  if (doc.file_size > 2 * 1024 * 1024) throw new Error('CSV must be at most 2 MB');
  const link = await ctx.telegram.getFileLink(doc.file_id);
  const response = await fetcher(String(link), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('CSV download failed');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('CSV must be at most 2 MB');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
function createBots({ game, store, delivery, participantToken, adminToken, adminIds, Bot = Telegraf }) {
  const participant = new Bot(participantToken), admin = new Bot(adminToken), uploads = new Map();
  for (const bot of [participant, admin]) {
    bot.use(privateOnly);
    bot.catch(() => console.error('Telegram update failed; update contents omitted.'));
  }
  participant.start(async ctx => replyLong(ctx, await game.register(ctx.from)));
  participant.help(ctx => ctx.reply(PARTICIPANT_HELP));
  participant.command('status', ctx => replyLong(ctx, game.status(ctx.from.id)));
  participant.command('hint', async ctx => {
    const password = args(ctx).trim();
    // Best effort: avoid retaining submitted passwords in chat history.
    try { await ctx.deleteMessage(); } catch {}
    return ctx.reply(password ? await game.hint(ctx.from.id, password) : 'Usage: /hint <password>');
  });
  participant.on('message', ctx => ctx.reply('Use /start to register, /status to check your assignment, or /help for commands.'));

  admin.use(adminOnly(adminIds));
  // Report only application validation errors, never raw Telegram/network errors.
  const command = (name, fn) => admin.command(name, async ctx => {
    try { await fn(ctx); }
    catch (error) {
      if (error.response || error.name === 'AbortError' || error.name === 'TypeError') return ctx.reply('The request failed. Check configuration and try again.');
      return replyLong(ctx, error.message.slice(0, 3500));
    }
  });
  const menu = ctx => ctx.reply('ACACIA admin console — use /help for all commands.', { reply_markup: { inline_keyboard: [
    [{ text: 'Overview', callback_data: 'summary' }, { text: 'Registered accounts', callback_data: 'accounts' }],
    [{ text: 'Import survey CSV', callback_data: 'import' }],
    [{ text: 'Generate pairs', callback_data: 'generate' }, { text: 'Review pairs', callback_data: 'pairs' }],
    [{ text: 'Approve pairs', callback_data: 'approve' }, { text: 'Launch preview', callback_data: 'launch' }],
    [{ text: 'Broadcast help', callback_data: 'broadcasthelp' }, { text: 'Delivery results', callback_data: 'jobs' }]
  ] } });
  admin.start(menu); command('menu', menu); command('help', ctx => replyLong(ctx, ADMIN_HELP));
  const operations = {
    summary: ctx => ctx.reply(summary(store.read())),
    accounts: async ctx => {
      const q = args(ctx).toLowerCase(), s = store.read();
      const rows = Object.values(s.accounts).filter(a => `${a.id} ${a.username}`.toLowerCase().includes(q));
      await replyLong(ctx, rows.map(a => `${a.id} @${a.username || '(no handle)'} — ${s.profiles.find(p => p.id === a.profileId)?.code || 'pending profile'}`).join('\n') || 'No accounts.');
    },
    import: ctx => { uploads.set(String(ctx.from.id), 'roster'); return ctx.reply('Upload the survey .csv file. Existing registrations will be preserved.'); },
    compatibility: ctx => ctx.reply('MBTI scoring is disabled. All MBTI types are treated equally; use /generate without uploading a matrix.'),
    generate: async ctx => { await game.generate(ctx.from.id); await replyLong(ctx, pairPreview(store.read())); },
    pairs: ctx => replyLong(ctx, pairPreview(store.read())),
    approve: async ctx => { await game.approve(ctx.from.id); await ctx.reply('Current pairings approved. Use /launch to review and start later.'); },
    launch: async ctx => {
      const token = await game.stage(ctx.from.id, 'launch');
      await replyLong(ctx, pairPreview(store.read()));
      await ctx.reply(`Launch will freeze these assignments and send nicknames, codes, and notes to registered paired participants. Confirm: /confirm ${token}`);
    },
    jobs: ctx => {
      const lines = Object.values(store.read().jobs).map(j => {
        const counts = j.items.reduce((acc,i) => { acc[i.status] = (acc[i.status] || 0) + 1; return acc; }, {});
        return `${j.id} ${j.kind}${j.batch ? ` [${j.batch}]` : ''}: ${JSON.stringify(counts)} (${j.items.length} total)`;
      });
      return replyLong(ctx, lines.join('\n') || 'No delivery jobs.');
    },
    broadcasthelp: ctx => ctx.reply('Use /broadcast <announcement text> for text. For an image, send /broadcast then upload a single photo with an optional caption, or reply to a photo with /broadcast [caption]. Photo captions can contain up to 1024 characters. Review the preview, then /confirm to send to all registered accounts, including those waiting for survey profiles. Use /cancel to discard.')
  };
  for (const [name, operation] of Object.entries(operations)) command(name, operation);
  admin.action(/^(summary|accounts|import|compatibility|generate|pairs|approve|launch|jobs|broadcasthelp)$/, async ctx => {
    await ctx.answerCbQuery();
    try { await operations[ctx.match[1]](ctx); } catch (error) { await ctx.reply(error.response ? 'Telegram request failed.' : error.message.slice(0, 3500)); }
  });
  command('list', ctx => {
    const q = args(ctx).toLowerCase();
    return replyLong(ctx, store.read().profiles.filter(p => `${p.name} ${p.nickname} ${p.code} ${p.telegram}`.toLowerCase().includes(q))
      .map(p => `${p.code} ${p.name} / ${p.nickname} — ${p.house}, ${p.year}, ${p.major}, ${p.mbti}, ${p.gender}, prefers ${p.preference}, @${p.telegram}`).join('\n') || 'No profiles.');
  });
  command('addpeople', async ctx => {
    const batch = args(ctx).trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(batch)) throw new Error('Usage: /addpeople <batch> (1–40 letters, numbers, underscores or hyphens)');
    if (store.read().phase === 'ended') throw new Error('Game has ended');
    if (Object.hasOwn(store.read().batches, batch)) throw new Error('Batch already exists. Choose a new batch name.');
    await store.update(s => { delete s.pending[String(ctx.from.id)]; });
    uploads.set(String(ctx.from.id), { addBatch: batch });
    await ctx.reply(`Upload a survey CSV containing only the new people for batch ${batch}. Existing people and pairs will be preserved. You will review and confirm before adding them.`);
  });
  command('batches', ctx => {
    const s = store.read();
    return replyLong(ctx, Object.keys(s.batches).map(batch => {
      const profiles = batchProfiles(s, batch);
      return `${batch}: ${profiles.length} profiles, ${broadcastRecipients(s, batch).length} registered recipients, ${profiles.filter(p => !partnerFor(s, p.id)).length} unpaired`;
    }).join('\n') || 'No batches. Use /addpeople <batch> to import new people.');
  });
  command('pairnew', async ctx => {
    const batch = args(ctx).trim();
    const token = await game.stage(ctx.from.id, 'pairnew', { batch });
    const s = store.read(), pairs = s.pending[String(ctx.from.id)].payload.pairs;
    const paired = new Set(s.pairs.flat());
    await replyLong(ctx, pairPreview({ ...s, profiles: batchProfiles(s, batch).filter(p => !paired.has(p.id)), pairs, accounts: {} }, `Batch ${batch} — proposed additional pairs; existing pairs preserved`));
    await ctx.reply(`PREVIEW — ${pairs.length} new pairs within ${batch}. Existing pairs will be preserved. ${s.phase === 'draft' ? 'Approve and launch later.' : 'Confirmation sends assignments only to newly paired registered participants.'} Confirm: /confirm ${token}`);
  });
  command('edit', async ctx => {
    const [code, field, ...value] = args(ctx).split(/\s+/);
    await game.edit(ctx.from.id, code, field, value.join(' ')); await ctx.reply('Profile updated. Generate and approve pairings again.');
  });
  command('link', async ctx => {
    const [id, code] = args(ctx).split(/\s+/); await game.link(ctx.from.id, id, code); delivery.kick()?.catch(reportWorkerError);
    await ctx.reply('Account linked. If the game has started, assignment delivery is queued.');
  });
  command('unlink', async ctx => { await game.unlink(ctx.from.id, args(ctx).trim()); await ctx.reply('Account unlinked.'); });
  command('pair', async ctx => { await game.pair(ctx.from.id, ...args(ctx).split(/\s+/)); await ctx.reply('Pair updated. Review /pairs and /approve again.'); });
  command('sethint', async ctx => {
    const [field, password = '', ...extra] = args(ctx).split(/\s+/);
    try { await ctx.deleteMessage(); } catch {}
    if (extra.length) throw new Error('Usage: /sethint <field> <password>');
    await game.setHint(ctx.from.id, field, password); await ctx.reply(`Password configured for ${field}.`);
  });
  for (const [name, phase] of [['pause','paused'],['resume','running'],['end','ended']])
    command(name, async ctx => { await game.phase(ctx.from.id, phase); await ctx.reply(`Game ${phase}.`); });
  const previewBroadcast = async (ctx, text, message, batch) => {
    if (message?.media_group_id) throw new Error('Broadcast supports one photo at a time. Send a single photo instead of an album.');
    const photo = message?.photo?.at(-1);
    if (photo?.file_size > 10 * 1024 * 1024) throw new Error('Broadcast photos must be at most 10 MB');
    const token = await game.stage(ctx.from.id, 'broadcast', { text, ...(batch !== undefined ? { batch } : {}), ...(photo ? { photo: photo.file_id } : {}) });
    uploads.delete(String(ctx.from.id));
    const s = store.read(), recipients = broadcastRecipients(s, batch);
    const audience = batch === undefined ? 'all registered accounts' : `batch ${batch} only (${batchProfiles(s, batch).length - recipients.length} profiles not linked to registered accounts)`;
    await replyLong(ctx, `PREVIEW — currently ${recipients.length} registered recipients; ${audience}; accounts registering before confirmation will also be included.${photo ? '' : `\n\n${text}`}`);
    if (photo) await ctx.replyWithPhoto(photo.file_id, { caption: text });
    await ctx.reply(`Send this announcement: /confirm ${token}`);
  };
  command('broadcast', async ctx => {
    const text = args(ctx), replied = ctx.message.reply_to_message;
    if (replied?.photo?.length) return previewBroadcast(ctx, text || replied.caption || '', replied);
    if (text) return previewBroadcast(ctx, text);
    await store.update(s => { delete s.pending[String(ctx.from.id)]; });
    uploads.set(String(ctx.from.id), 'broadcast');
    await ctx.reply('Upload a single photo with an optional caption (up to 1024 characters). You will receive a preview before confirming. Use /cancel to discard.');
  });
  command('broadcastbatch', async ctx => {
    const input = args(ctx).trim(), separator = input.search(/\s/);
    const batch = separator < 0 ? input : input.slice(0, separator);
    const text = separator < 0 ? '' : input.slice(separator).trim();
    batchProfiles(store.read(), batch);
    const replied = ctx.message.reply_to_message;
    if (replied?.photo?.length) return previewBroadcast(ctx, text || replied.caption || '', replied, batch);
    if (text) return previewBroadcast(ctx, text, undefined, batch);
    await store.update(s => { delete s.pending[String(ctx.from.id)]; });
    uploads.set(String(ctx.from.id), { broadcastBatch: batch });
    await ctx.reply(`Upload a single photo with an optional caption for batch ${batch} only. Review and confirm before sending. Use /cancel to discard.`);
  });
  command('confirm', async ctx => { await ctx.reply(await game.confirm(ctx.from.id, args(ctx).trim())); delivery.kick()?.catch(reportWorkerError); });
  command('cancel', async ctx => {
    uploads.delete(String(ctx.from.id)); await store.update(s => { delete s.pending[String(ctx.from.id)]; }); await ctx.reply('Pending action cancelled.');
  });
  command('retry', async ctx => { await game.retry(ctx.from.id, args(ctx).trim()); delivery.kick()?.catch(reportWorkerError); await ctx.reply('Failed deliveries queued for retry.'); });
  command('retryuncertain', async ctx => {
    await game.retry(ctx.from.id, args(ctx).trim(), true); delivery.kick()?.catch(reportWorkerError); await ctx.reply('Uncertain deliveries also queued. These messages may arrive twice.');
  });
  command('export', ctx => {
    const s = store.read();
    const records = s.profiles.map(p => ({ ...p, account_id: Object.values(s.accounts).find(a => a.profileId === p.id)?.id || '', penpal_code: partnerFor(s, p.id)?.code || '' }));
    return ctx.replyWithDocument({ source: Buffer.from(csv(records, [...FIELDS, 'code', 'account_id', 'penpal_code'])), filename: 'acacia-roster.csv' });
  });
  const backup = ctx => ctx.replyWithDocument({ source: Buffer.from(JSON.stringify(store.read(), null, 2)), filename: `acacia-backup-${Date.now()}.json` });
  command('backup', backup);
  command('reset', async ctx => {
    await backup(ctx);
    const token = await game.stage(ctx.from.id, 'reset');
    await ctx.reply(`Backup sent. Reset clears survey profiles, links, assignments, hints, and jobs while preserving registered Telegram accounts. Confirm: /confirm ${token}`);
  });
  command('audit', ctx => replyLong(ctx, store.read().audit.slice(-40).map(a => `${a.at} ${a.actor}: ${a.action}`).join('\n') || 'No management actions.'));
  admin.on('photo', async ctx => {
    try {
      const mode = uploads.get(String(ctx.from.id));
      if (mode !== 'broadcast' && mode?.broadcastBatch === undefined) return ctx.reply('Use /broadcast or /broadcastbatch <batch> before uploading a photo.');
      await previewBroadcast(ctx, ctx.message.caption || '', ctx.message, mode?.broadcastBatch);
    } catch (error) { await replyLong(ctx, error.response || error.name === 'AbortError' || error.name === 'TypeError' ? 'Photo preview failed. Try /broadcast again.' : error.message.slice(0, 3500)); }
  });
  admin.on('document', async ctx => {
    try {
      const mode = uploads.get(String(ctx.from.id));
      if (!mode) return ctx.reply('Use /import before uploading a survey CSV.');
      if (mode === 'broadcast' || mode?.broadcastBatch !== undefined) return ctx.reply('Please send the image as a photo, rather than a file. Use /cancel to discard.');
      const text = await downloadCsv(ctx);
      if (mode?.addBatch !== undefined) {
        const profiles = await parseRoster(text), token = await game.stage(ctx.from.id, 'addpeople', { profiles, batch: mode.addBatch });
        await replyLong(ctx, `PREVIEW — add ${profiles.length} people to batch ${mode.addBatch}. Existing profiles and pairs will be preserved.\n${profiles.map(p => `${p.name} / ${p.nickname} — @${p.telegram}`).join('\n')}`);
        await ctx.reply(`Confirm: /confirm ${token}`);
      } else if (mode === 'roster') {
        const profiles = await parseRoster(text), token = await game.stage(ctx.from.id, 'roster', { profiles });
        await ctx.reply(`Validated ${profiles.length} profiles. This replaces the draft survey roster and clears draft pairings; Telegram registrations remain. Confirm: /confirm ${token}`);
      }
      uploads.delete(String(ctx.from.id));
    } catch (error) { await replyLong(ctx, error.response || error.name === 'TypeError' ? 'CSV download failed.' : error.message.slice(0, 3500)); }
  });
  admin.on('message', ctx => ctx.reply('Use /menu or /help for management commands.'));
  return { participant, admin };
}
function reportWorkerError() { console.error('Delivery worker failed. Check local storage and restart to recover queued messages.'); }
module.exports = { createBots, adminOnly, privateOnly, downloadCsv, PARTICIPANT_HELP, ADMIN_HELP, summary, pairPreview };
