const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Telegram } = require('telegraf');
const { Store } = require('../src/store');
const { Game, CHAT_NOTICE } = require('../src/game');
const { Delivery } = require('../src/delivery');
const { createBots } = require('../src/bots');
const { parseRoster } = require('../src/imports');

let sequence = 100;
function update(id, text, extra = {}) {
  const message_id = sequence++;
  return { update_id: sequence++, message: { message_id, date: 1,
    from: { id, first_name: 'Test' }, chat: { id, type: 'private' }, text,
    entities: text?.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : [], ...extra } };
}
const chatJobs = store => Object.values(store.read().jobs).filter(j => j.kind === 'chat');
async function setup(t, registerPartner = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acacia-chat-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init(), game = new Game(store), calls = [];
  t.mock.method(Telegram.prototype, 'callApi', async (method, payload) => {
    calls.push({ method, payload }); return { message_id: sequence++ };
  });
  const profiles = await parseRoster(await fs.readFile(path.join(__dirname, 'fixtures', 'forms-signups.csv'), 'utf8'));
  await game.confirm('99', await game.stage('99', 'roster', { profiles }));
  await game.generate('99');
  await game.register({ id: 1, username: profiles[0].telegram });
  if (registerPartner) await game.register({ id: 2, username: profiles[1].telegram });
  // Start from frozen assignments; the launch workflow has its own integration tests.
  await store.update(s => { s.phase = 'running'; });
  const bots = createBots({ game, store, delivery: { kick: () => Promise.resolve() },
    participantToken: '123:test', adminToken: '456:test', adminIds: new Set(['99']) });
  const delivery = new Delivery(store, bots.participant.telegram, { sleep: async () => {} });
  return { store, game, calls, delivery, ...bots };
}

test('allowchatting requires an admin, notifies participants once, and relays both ways with private commands', async t => {
  const { store, game, calls, admin, participant, delivery } = await setup(t);
  await participant.handleUpdate(update(1, 'Before chatting'));
  assert.match(calls.at(-1).payload.text, /not been enabled/);
  await admin.handleUpdate(update(1, '/allowchatting'));
  assert.equal(calls.at(-1).payload.text, 'Not authorised.');
  assert.equal(store.read().chattingAllowed, false);
  await admin.handleUpdate(update(99, '/allowchatting'));
  assert.equal(store.read().chattingAllowed, true);
  const notice = Object.values(store.read().jobs).find(j => j.text === CHAT_NOTICE);
  assert.deepEqual(notice.items.map(i => i.userId), ['1', '2']);
  assert.match(CHAT_NOTICE, /messages you send here from now on will go to your penpal/);
  await admin.handleUpdate(update(99, '/allowchatting'));
  assert.match(calls.at(-1).payload.text, /already enabled/);
  assert.equal(Object.keys(store.read().jobs).length, 1);
  const hello = update(1, 'Hello, penpal!'), photo = update(2, undefined, { photo: [{ file_id: 'photo' }], caption: 'Hi!' });
  await participant.handleUpdate(hello);
  await participant.handleUpdate(hello); // replayed polling update
  await participant.handleUpdate(photo);
  assert.equal(chatJobs(store).length, 2);
  for (const command of ['/start', '/status', '/help', '/hint private-password', '/unknown'])
    await participant.handleUpdate(update(1, command));
  await participant.handleUpdate(update(1, 'Group text', { chat: { id: -50, type: 'group' } }));
  assert.equal(chatJobs(store).length, 2);
  await delivery.kick();
  assert.deepEqual(calls.filter(c => c.method === 'copyMessage').map(c => c.payload), [
    { chat_id: '2', from_chat_id: '1', message_id: hello.message.message_id, protect_content: true },
    { chat_id: '1', from_chat_id: '2', message_id: photo.message.message_id, protect_content: true }
  ]);
  assert.ok(calls.every(c => c.method !== 'forwardMessage'));
  assert.ok(chatJobs(store).every(j => j.items[0].status === 'sent'));
  await game.register({ id: 3 });
  await delivery.kick();
  assert.equal(calls.filter(c => c.method === 'sendMessage' && c.payload.chat_id === '3' && c.payload.text === CHAT_NOTICE).length, 1);
  assert.equal(chatJobs(store).length, 2); // chats never replay to late registrants
});

test('text, photo and batch broadcasts show ANNOUNCEMENTS in previews and delivery after enabling chat', async t => {
  const { store, game, calls, admin } = await setup(t);
  await admin.handleUpdate(update(99, '/broadcast Earlier announcement'));
  const oldToken = store.read().pending['99'].token;
  assert.equal(store.read().pending['99'].payload.text, 'Earlier announcement');
  await admin.handleUpdate(update(99, '/allowchatting'));
  await assert.rejects(game.confirm('99', oldToken), /configuration changed/);
  await admin.handleUpdate(update(99, '/broadcast Hello everyone'));
  assert.match(calls.at(-2).payload.text, /\[ANNOUNCEMENTS\]\n\nHello everyone/);
  await admin.handleUpdate(update(99, `/confirm ${store.read().pending['99'].token}`));
  assert.equal(Object.values(store.read().jobs).at(-1).text, '[ANNOUNCEMENTS]\n\nHello everyone');
  await store.update(s => { s.batches.original = { profileIds: s.profiles.map(p => p.id) }; });
  await admin.handleUpdate(update(99, '/broadcastbatch original Batch update'));
  assert.equal(store.read().pending['99'].payload.text, '[ANNOUNCEMENTS]\n\nBatch update');
  await admin.handleUpdate(update(99, '/broadcast'));
  await admin.handleUpdate(update(99, undefined, { photo: [{ file_id: 'admin-photo' }], caption: 'Photo caption' }));
  assert.equal(calls.filter(c => c.method === 'sendPhoto').at(-1).payload.caption, '[ANNOUNCEMENTS]\n\nPhoto caption');
  await admin.handleUpdate(update(99, `/confirm ${store.read().pending['99'].token}`));
  assert.ok(Object.values(store.read().jobs).at(-1).items.every(i => i.text === '[ANNOUNCEMENTS]\n\nPhoto caption'));
  const prefix = '[ANNOUNCEMENTS]\n\n';
  await game.stage('99', 'broadcast', { photo: 'photo', text: 'x'.repeat(1024 - prefix.length) });
  await assert.rejects(game.stage('99', 'broadcast', { photo: 'photo', text: 'x'.repeat(1025 - prefix.length) }), /including \[ANNOUNCEMENTS\]/);
  await game.stage('99', 'broadcast', { photo: 'photo', text: '' });
  assert.equal(store.read().pending['99'].payload.text, '[ANNOUNCEMENTS]');
});

test('chat rejects missing assignments, unavailable partners, service messages, and inactive games', async t => {
  const { game, store } = await setup(t, false);
  await store.update(s => { s.phase = 'draft'; });
  await assert.rejects(game.allowChatting('99'), /running/);
  await store.update(s => { s.phase = 'running'; });
  await game.allowChatting('99');
  assert.match(await game.relay(50, update(50, 'Hello').message), /start/);
  await game.register({ id: 3 });
  assert.match(await game.relay(3, update(3, 'Hello').message), /assignment yet/);
  assert.match(await game.relay(1, update(1, 'Hello').message), /penpal has not registered/);
  await game.register({ id: 2, username: store.read().profiles[1].telegram });
  assert.match(await game.relay(1, update(1, undefined, { pinned_message: {} }).message), /message type/);
  await game.phase('99', 'paused');
  assert.match(await game.relay(1, update(1, 'Hello').message), /closed/);
  await game.phase('99', 'ended');
  assert.match(await game.relay(1, update(1, 'Hello').message), /closed/);
  assert.equal(chatJobs(store).length, 0);
});

test('queued chats persist, wait during pause, resume, and are cancelled when the round ends', async t => {
  const { game, store, calls, delivery } = await setup(t);
  await game.allowChatting('99');
  await game.relay(1, update(1, 'Queued hello').message);
  await game.phase('99', 'paused');
  await delivery.kick();
  assert.equal(calls.filter(c => c.method === 'copyMessage').length, 0);
  assert.equal(chatJobs(store)[0].items[0].status, 'pending');
  const reloaded = await new Store(store.directory).init(), resumed = new Game(reloaded);
  assert.equal(reloaded.read().chattingAllowed, true);
  await resumed.phase('99', 'running');
  const worker = new Delivery(reloaded, delivery.telegram, { sleep: async () => {} });
  await worker.kick();
  assert.equal(chatJobs(reloaded)[0].items[0].status, 'sent');
  await resumed.relay(2, update(2, 'Another message').message);
  await resumed.phase('99', 'ended');
  assert.equal(chatJobs(reloaded).at(-1).items[0].status, 'cancelled');
  await worker.kick();
  assert.equal(calls.filter(c => c.method === 'copyMessage').length, 1);
  await resumed.confirm('99', await resumed.stage('99', 'reset'));
  assert.equal(reloaded.read().chattingAllowed, false);
});

test('unlinking either account cancels chat and retries cannot deliver to a rebound recipient', async t => {
  const { game, store, calls, delivery } = await setup(t);
  await game.allowChatting('99');
  await game.relay(1, update(1, 'Outgoing').message);
  await game.relay(2, update(2, 'Incoming').message);
  await game.unlink('99', '1');
  assert.ok(chatJobs(store).every(j => j.items[0].status === 'cancelled'));
  const job = chatJobs(store)[0];
  // Simulate a failed chat being retried after the account's binding changed.
  await store.update(s => { s.jobs[job.id].items[0].status = 'failed'; });
  await game.retry('99', job.id);
  await delivery.kick();
  assert.equal(store.read().jobs[job.id].items[0].status, 'cancelled');
  assert.equal(calls.filter(c => c.method === 'copyMessage').length, 0);
});

test('copy delivery retries Telegram errors and preserves ambiguous network outcomes', async t => {
  const { game, store, delivery } = await setup(t);
  await game.allowChatting('99');
  await game.relay(1, update(1, 'Hello').message);
  let attempts = 0;
  t.mock.method(delivery.telegram, 'callApi', async () => {
    if (++attempts === 1) throw { response: { error_code: 429, parameters: { retry_after: 1 } } };
    throw new Error('network');
  });
  const worker = new Delivery(store, delivery.telegram, { sleep: async () => {} });
  // Deliver the enable notice separately so only copyMessage uses this mock.
  worker.telegram = { sendMessage: async () => {}, callApi: (...args) => delivery.telegram.callApi(...args) };
  await worker.kick();
  const job = chatJobs(store)[0];
  assert.equal(attempts, 2);
  assert.equal(job.items[0].status, 'uncertain');
  await game.retry('99', job.id);
  assert.equal(store.read().jobs[job.id].items[0].status, 'uncertain');
});
