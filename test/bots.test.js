const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Telegram } = require('telegraf');
const { Store } = require('../src/store');
const { Game } = require('../src/game');
const { createBots, downloadCsv, PARTICIPANT_HELP } = require('../src/bots');
const { initialiseBot, poll } = require('../src/polling');
const { parseRoster, csv, FIELDS } = require('../src/imports');

let updateId=1;
function message(id,text,username='person_0',type='private') {
  const entity=text.startsWith('/')?[{type:'bot_command',offset:0,length:text.split(' ')[0].length}]:[];
  return {update_id:updateId++,message:{message_id:updateId,date:1,chat:{id,type},from:{id,username,first_name:'Test'},text,entities:entity}};
}
function photoMessage(id,caption='',extra={}) {
  const update=message(id,'');
  delete update.message.text; delete update.message.entities;
  Object.assign(update.message,{caption,photo:[
    {file_id:'admin-small',width:90,height:90,file_size:100},
    {file_id:'admin-large',width:800,height:600,file_size:1000}
  ]},extra);
  return update;
}
async function setup(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'acacia-bot-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=await new Store(dir).init(),game=new Game(store),calls=[],kicks=[];
  const original=Telegram.prototype.callApi;
  Telegram.prototype.callApi=async function(method,payload){calls.push({method,payload});return {message_id:1};};
  t.after(()=>{Telegram.prototype.callApi=original;});
  const bots=createBots({game,store,delivery:{kick:()=>{kicks.push(Date.now());return Promise.resolve();}},participantToken:'123:test',adminToken:'456:test',adminIds:new Set(['99'])});
  return {...bots,store,game,calls,kicks};
}
test('real Telegram command routing registers before CSV and sends only waiting/help messages',async t=>{
  const {participant,store,calls,kicks}=await setup(t);
  await participant.handleUpdate(message(1,'/start'));
  assert.equal(Object.keys(store.read().accounts).length,1);
  assert.match(calls.at(-1).payload.text,/registered/);
  assert.equal(kicks.length,1);
  await participant.handleUpdate(message(1,'/status')); assert.match(calls.at(-1).payload.text,/survey profile/);
  await participant.handleUpdate(message(1,'/help')); assert.equal(calls.at(-1).payload.text,PARTICIPANT_HELP);
  await participant.handleUpdate(message(1,'/hint example-password'));
  assert.ok(calls.some(c=>c.method==='deleteMessage'));
  assert.ok(calls.filter(c=>c.method==='sendMessage').every(c=>!c.payload.text.includes('example-password')));
  await participant.handleUpdate(message(2,'/start','other_handle','group'));
  assert.equal(Object.keys(store.read().accounts).length,1);
  for(const call of calls.filter(c=>c.method==='sendMessage')) assert.doesNotMatch(call.payload.text,/third digit|Aeon|Genesis|Nous|Telos|Zenith/i);
});
test('Forms signup CSV supports launch delivery and both participants retrieving their own assignment with /start',async t=>{
  const {participant,admin,store,game,calls}=await setup(t);
  const source=await fs.readFile(path.join(__dirname,'fixtures','forms-signups.csv'),'utf8');
  // The acknowledgement never substitutes for actually starting the bot.
  for (const answer of ['I have registered!!','I will register!!','Aiken Duit!!!']) {
    const profiles=await parseRoster('\uFEFF'+source.replace('I have registered!!',answer));
    assert.equal(profiles.length,2);
    assert.deepEqual(profiles[0],{
      name:'Alex Example',house:'Aeon',year:'Y1',mbti:'intj',major:'Computing',
      gender:'Male',telegram:'alex_example',nickname:'Cookie dough',preference:'Any',
      note:'Hello, penpal! I like books.'
    });
  }
  await participant.handleUpdate(message(1,'/start','alex_example'));
  assert.match(calls.at(-1).payload.text,/registered/);
  await game.confirm('99',await game.stage('99','roster',{profiles:await parseRoster(source)}));
  const [alex,jamie]=store.read().profiles;
  await admin.handleUpdate(message(99,'/generate'));
  assert.equal(store.read().pairs.length,1);
  await game.approve('99');
  for (const field of ['house','major','year','gender','name']) {
    await admin.handleUpdate(message(99,`/sethint ${field} secret_${field}`));
    assert.equal(calls.at(-1).payload.text,`Password configured for ${field}.`);
  }
  await participant.handleUpdate(message(1,'/start','alex_example'));
  assert.match(calls.at(-1).payload.text,/start later/);
  assert.doesNotMatch(calls.at(-1).payload.text,/Sunflower|drawing/);
  await admin.handleUpdate(message(99,'/launch'));
  await admin.handleUpdate(message(99,`/confirm ${store.read().pending['99'].token}`));
  const expected=(own,partner)=>`Your nickname: ${own.nickname}\nYour code: ${own.code}\n\nYour penpal: ${partner.nickname}\nPenpal code: ${partner.code}\n\nTheir note:\n${partner.note}`;
  const job=Object.values(store.read().jobs).find(j=>j.kind==='launch');
  assert.equal(job.items.length,1);
  assert.equal(job.items[0].userId,'1');
  assert.equal(job.items[0].text,expected(alex,jamie));
  for (const [id,own,partner] of [[1,alex,jamie],[2,jamie,alex]]) {
    // Includes late registration and repeated /start calls.
    for (let attempt=0;attempt<2;attempt++) {
      await participant.handleUpdate(message(id,'/start',own.telegram));
      assert.equal(calls.at(-1).payload.text,expected(own,partner));
    }
    await participant.handleUpdate(message(id,'/status',own.telegram));
    assert.equal(calls.at(-1).payload.text,expected(own,partner));
  }
  assert.equal(Object.keys(store.read().accounts).length,2);
  const longNote = 'Hello! '.repeat(2000);
  await store.update(s => { s.profiles.find(p => p.id === jamie.id).note = longNote; });
  for (const command of ['/start', '/status']) {
    const before = calls.length;
    await participant.handleUpdate(message(1,command,alex.telegram));
    const texts = calls.slice(before).filter(c => c.method === 'sendMessage').map(c => c.payload.text);
    assert.ok(texts.length > 1);
    assert.ok(texts.every(text => text.length <= 3800));
    assert.equal(texts.join(''), expected(alex, { ...jamie, note: longNote }));
  }
});

test('batch commands import a CSV, preserve pairs, and scope text and photo broadcasts', async t => {
  const { admin, participant, store, game, calls } = await setup(t);
  const original = await parseRoster(await fs.readFile(path.join(__dirname, 'fixtures', 'forms-signups.csv'), 'utf8'));
  await game.confirm('99', await game.stage('99', 'roster', { profiles: original }));
  await game.generate('99'); await game.approve('99');
  const oldPairs = store.read().pairs;
  const newcomers = original.map(p => ({ ...p, telegram: `${p.telegram}_late` }));
  t.mock.method(admin.telegram, 'getFileLink', async () => new URL('https://example.com/late.csv'));
  t.mock.method(globalThis, 'fetch', async () => new Response(csv(newcomers, FIELDS)));
  await admin.handleUpdate(message(1, '/addpeople late8'));
  assert.equal(calls.at(-1).payload.text, 'Not authorised.');
  await admin.handleUpdate(message(99, '/addpeople late8'));
  const document = message(99, '');
  document.message.document = { file_name: 'late.csv', file_size: 500, file_id: 'csv' };
  await admin.handleUpdate(document);
  assert.equal(store.read().profiles.length, 2);
  assert.equal(store.read().pending['99'].action, 'addpeople');
  await admin.handleUpdate(message(99, `/confirm ${store.read().pending['99'].token}`));
  assert.equal(store.read().profiles.length, 4);
  assert.deepEqual(store.read().pairs, oldPairs);
  await admin.handleUpdate(message(99, '/batches'));
  assert.match(calls.at(-1).payload.text, /late8: 2 profiles, 0 registered recipients/);
  await admin.handleUpdate(message(99, '/pairnew late8'));
  assert.equal(store.read().pending['99'].action, 'pairnew');
  await admin.handleUpdate(message(99, '/cancel'));
  assert.deepEqual(store.read().pairs, oldPairs);
  await admin.handleUpdate(message(99, '/pairnew late8'));
  await admin.handleUpdate(message(99, `/confirm ${store.read().pending['99'].token}`));
  assert.equal(store.read().pairs.length, 2);
  assert.deepEqual(store.read().pairs[0], oldPairs[0]);
  await participant.handleUpdate(message(1, '/start', original[0].telegram));
  await participant.handleUpdate(message(2, '/start', newcomers[0].telegram));
  await admin.handleUpdate(message(99, '/broadcastbatch late8 Welcome, late joiners!'));
  assert.match(calls.at(-2).payload.text, /1 registered recipients; batch late8 only \(1 profiles not linked/);
  assert.equal(Object.keys(store.read().jobs).length, 0);
  await admin.handleUpdate(message(99, `/confirm ${store.read().pending['99'].token}`));
  const job = Object.values(store.read().jobs).at(-1);
  assert.deepEqual(job.items.map(i => i.userId), ['2']);
  assert.equal(job.items[0].text, 'Welcome, late joiners!');
  await admin.handleUpdate(message(99, '/broadcastbatch late8'));
  await admin.handleUpdate(photoMessage(99, 'Instructions'));
  assert.equal(store.read().pending['99'].payload.batch, 'late8');
  assert.equal(store.read().pending['99'].payload.photo, 'admin-large');
  await admin.handleUpdate(message(99, `/confirm ${store.read().pending['99'].token}`));
  const photoJob = Object.values(store.read().jobs).at(-1);
  assert.equal(photoJob.photo, 'admin-large');
  assert.deepEqual(photoJob.items.map(i => i.userId), ['2']);
  const reply = message(99, '/broadcastbatch late8 Custom caption');
  reply.message.reply_to_message = photoMessage(99, 'Original caption').message;
  await admin.handleUpdate(reply);
  assert.equal(store.read().pending['99'].payload.text, 'Custom caption');
  assert.equal(store.read().pending['99'].payload.batch, 'late8');
  await admin.handleUpdate(message(99, '/cancel'));
  assert.equal(store.read().pending['99'], undefined);
  await admin.handleUpdate(message(1, '/broadcastbatch late8 Intruder'));
  assert.equal(calls.at(-1).payload.text, 'Not authorised.');
});

test('admin commands and menus require numeric ID authorization',async t=>{
  const {admin,store,calls}=await setup(t);
  await admin.handleUpdate(message(1,'/broadcast bad','admin_username'));
  assert.equal(calls.at(-1).payload.text,'Not authorised.');assert.deepEqual(store.read().pending,{});
  await admin.handleUpdate(message(99,'/menu'));
  assert.ok(calls.at(-1).payload.reply_markup.inline_keyboard.length>0);
  await admin.handleUpdate({update_id:updateId++,callback_query:{id:'cb',from:{id:1},data:'generate',message:{message_id:1,chat:{id:1,type:'private'}}}});
  assert.equal(calls.at(-1).payload.text,'Not authorised.');
});
test('admin broadcast preview/confirmation includes CSV-less registered accounts and is not sent immediately',async t=>{
  const {participant,admin,store,calls}=await setup(t);
  await participant.handleUpdate(message(1,'/start'));
  await admin.handleUpdate(message(99,'/broadcast Welcome to ACACIA!'));
  assert.equal(Object.keys(store.read().jobs).length,0);
  const {token}=store.read().pending['99'];
  await admin.handleUpdate(message(99,`/confirm ${token}`));
  const job=Object.values(store.read().jobs)[0];
  assert.equal(job.items[0].userId,'1');assert.equal(job.items[0].text,'Welcome to ACACIA!');
  assert.ok(calls.some(c=>c.payload?.text?.includes('PREVIEW')));
});
test('photo broadcast upload previews the largest photo and queues only after confirmation',async t=>{
  const {participant,admin,store,calls}=await setup(t);
  await participant.handleUpdate(message(1,'/start'));
  await admin.handleUpdate(message(99,'/broadcast'));
  assert.match(calls.at(-1).payload.text,/Upload a single photo/);
  await admin.handleUpdate(photoMessage(99,'Welcome to ACACIA!'));
  const {token,payload}=store.read().pending['99'];
  assert.deepEqual(payload,{text:'Welcome to ACACIA!',photo:'admin-large'});
  assert.deepEqual(Object.values(store.read().jobs),[]);
  const preview=calls.find(c=>c.method==='sendPhoto');
  assert.equal(preview.payload.photo,'admin-large');
  assert.equal(preview.payload.caption,'Welcome to ACACIA!');
  assert.equal(preview.payload.chat_id,99);
  await participant.handleUpdate(message(2,'/start','late_account'));
  await admin.handleUpdate(message(99,`/confirm ${token}`));
  const job=Object.values(store.read().jobs)[0];
  assert.equal(job.photo,'admin-large');
  assert.deepEqual(job.items.map(i=>[i.userId,i.text]),[['1','Welcome to ACACIA!'],['2','Welcome to ACACIA!']]);
  await admin.handleUpdate(message(99,`/confirm ${token}`));
  assert.equal(Object.keys(store.read().jobs).length,1);
});
test('replying to a photo preserves, overrides, or omits its caption',async t=>{
  const {admin,store,calls}=await setup(t);
  for (const [command,original,expected] of [
    ['/broadcast','Original caption','Original caption'],
    ['/broadcast Replacement caption','Original caption','Replacement caption'],
    ['/broadcast','','']
  ]) {
    const update=message(99,command);
    update.message.reply_to_message=photoMessage(99,original).message;
    await admin.handleUpdate(update);
    assert.deepEqual(store.read().pending['99'].payload,{text:expected,photo:'admin-large'});
    assert.equal(calls.filter(c=>c.method==='sendPhoto').at(-1).payload.caption,expected);
  }
  assert.equal(Object.keys(store.read().jobs).length,0);
});
test('photo broadcasts enforce admin/private access and cancellation',async t=>{
  const {admin,store,calls}=await setup(t);
  await admin.handleUpdate(message(99,'/broadcast'));
  await admin.handleUpdate(photoMessage(1,'Unauthorised'));
  assert.equal(calls.at(-1).payload.text,'Not authorised.');
  assert.deepEqual(store.read().pending,{});
  const group=photoMessage(99); group.message.chat.type='group';
  await admin.handleUpdate(group);
  assert.deepEqual(store.read().pending,{});
  await admin.handleUpdate(message(99,'/cancel'));
  await admin.handleUpdate(photoMessage(99));
  assert.match(calls.at(-1).payload.text,/Use \/broadcast/);
  assert.deepEqual(store.read().pending,{});
  await admin.handleUpdate(message(99,'/broadcast'));
  await admin.handleUpdate(photoMessage(99));
  const {token}=store.read().pending['99'];
  await admin.handleUpdate(message(99,'/cancel'));
  await admin.handleUpdate(message(99,`/confirm ${token}`));
  assert.equal(Object.keys(store.read().jobs).length,0);
});
test('photo upload rejects albums, oversized photos, files, and overlong captions before staging',async t=>{
  const {admin,store,calls}=await setup(t);
  await admin.handleUpdate(message(99,'/broadcast'));
  await admin.handleUpdate(photoMessage(99,'',{media_group_id:'album'}));
  assert.match(calls.at(-1).payload.text,/single photo/);
  await admin.handleUpdate(photoMessage(99,'',{photo:[{file_id:'huge',file_size:11*1024*1024}]}));
  assert.match(calls.at(-1).payload.text,/10 MB/);
  const doc=message(99,'');delete doc.message.text;
  doc.message.document={file_id:'image',file_name:'image.jpg'};
  await admin.handleUpdate(doc);
  assert.match(calls.at(-1).payload.text,/send the image as a photo/);
  await admin.handleUpdate(photoMessage(99,'x'.repeat(1025)));
  assert.match(calls.at(-1).payload.text,/1024/);
  assert.deepEqual(store.read().pending,{});
  await admin.handleUpdate(photoMessage(99,'x'.repeat(1024)));
  assert.equal(store.read().pending['99'].payload.text.length,1024);
});
test('CSV download validates extensions, declared size, and streamed size',async()=>{
  const ctx={message:{document:{file_name:'survey.csv',file_size:10,file_id:'file'}},telegram:{getFileLink:async()=>new URL('https://example.com/file')}};
  assert.equal(await downloadCsv(ctx,async()=>new Response('name,house\nA,Aeon')),'name,house\nA,Aeon');
  ctx.message.document.file_name='survey.exe';await assert.rejects(downloadCsv(ctx),/\.csv/);
  ctx.message.document.file_name='survey.csv';ctx.message.document.file_size=3*1024*1024;
  await assert.rejects(downloadCsv(ctx),/2 MB/);
  ctx.message.document.file_size=0;
  await assert.rejects(downloadCsv(ctx,async()=>new Response(Buffer.alloc(3*1024*1024))),/2 MB/);
});
test('safe polling initialises bot info, persists offsets, and stops on token conflict',async t=>{
  const {store}=await setup(t),control={stopped:false};const requests=[];
  const bot={options:{},context:{},telegram:{getMe:async()=>({id:1,username:'test_bot'}),deleteWebhook:async()=>{},getUpdates:async(_timeout,_limit,offset)=>{requests.push(offset);return [{update_id:17}];}},handleUpdate:async()=>{control.stopped=true;}};
  await initialiseBot(bot);assert.equal(bot.context.botInfo.username,'test_bot');
  await poll(bot,'test',store,control);assert.deepEqual(requests,[0]);assert.equal(store.read().offsets.test,18);
  bot.telegram.getUpdates=async()=>{throw {response:{error_code:409}};};control.stopped=false;
  await assert.rejects(poll(bot,'test',store,control),/only one instance/);
});
