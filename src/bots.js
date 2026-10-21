const { Telegraf } = require('telegraf');
const { parseRoster, csv, FIELDS } = require('./imports');
const { participantStatus, partnerFor } = require('./game');

const PARTICIPANT_HELP = 'Welcome to ACACIA Penpal!\n/start — register, even before survey data is uploaded\n/status — check your registration or penpal assignment\n/hint <password> — unlock a penpal hint during the game\n/help — show this help\n\nThe organisers will start the game later. This bot does not relay messages.';
const ADMIN_HELP = `ACACIA admin console
/menu — management buttons
/summary — game and registration counts
/import — upload a survey CSV next (replaces the draft roster after confirmation)
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
/broadcast <text> — preview an announcement to all registered accounts
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
  for (let start = 0; start < text.length; start += 3800) await ctx.reply(text.slice(start, start + 3800));
}
function privateOnly(ctx, next) { return ctx.chat?.type === 'private' ? next() : Promise.resolve(); }
function adminOnly(ids) {
  return (ctx, next) => ids.has(String(ctx.from?.id)) ? next() : ctx.reply('Not authorised.');
}
function summary(s) {
  const accounts = Object.values(s.accounts), linked = accounts.filter(a => a.profileId).length;
  return `Game: ${s.phase}\nRegistered accounts: ${accounts.length}\nLinked accounts: ${linked}\nPending accounts: ${accounts.length - linked}\nSurvey profiles: ${s.profiles.length}\nPairs: ${s.pairs.length}\nUnpaired profiles: ${s.profiles.length - s.pairs.length * 2}\nPairings approved: ${s.pairingReady ? 'yes' : 'no'}\nMatching: equal MBTI weights\nHint passwords configured: ${Object.keys(s.hintSecrets).length}/5`;
}
function pairPreview(s) {
  const byId = id => s.profiles.find(p => p.id === id);
  const lines = [summary(s), '\nPAIRS — review notes for identifying information before launch'];
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
  participant.start(async ctx => ctx.reply(await game.register(ctx.from)));
  participant.help(ctx => ctx.reply(PARTICIPANT_HELP));
  participant.command('status', ctx => ctx.reply(game.status(ctx.from.id)));
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
        return `${j.id} ${j.kind}: ${JSON.stringify(counts)} (${j.items.length} total)`;
      });
      return replyLong(ctx, lines.join('\n') || 'No delivery jobs.');
    },
    broadcasthelp: ctx => ctx.reply('Use /broadcast <announcement text> to preview a message to all registered accounts, including those waiting for survey profiles.')
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
  command('broadcast', async ctx => {
    const text = args(ctx), token = await game.stage(ctx.from.id, 'broadcast', { text });
    await replyLong(ctx, `PREVIEW — currently ${Object.keys(store.read().accounts).length} registered recipients; accounts registering before confirmation will also be included.\n\n${text}`);
    await ctx.reply(`Send this announcement: /confirm ${token}`);
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
  admin.on('document', async ctx => {
    try {
      const mode = uploads.get(String(ctx.from.id));
      if (!mode) return ctx.reply('Use /import before uploading a survey CSV.');
      const text = await downloadCsv(ctx);
      if (mode === 'roster') {
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
