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

let updateId=1;
function message(id,text,username='person_0',type='private') {
  const entity=text.startsWith('/')?[{type:'bot_command',offset:0,length:text.split(' ')[0].length}]:[];
  return {update_id:updateId++,message:{message_id:updateId,date:1,chat:{id,type},from:{id,username,first_name:'Test'},text,entities:entity}};
}
async function setup(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'acacia-bot-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=await new Store(dir).init(),game=new Game(store),calls=[];
  const original=Telegram.prototype.callApi;
  Telegram.prototype.callApi=async function(method,payload){calls.push({method,payload});return {message_id:1};};
  t.after(()=>{Telegram.prototype.callApi=original;});
  const bots=createBots({game,store,delivery:{kick:()=>Promise.resolve()},participantToken:'123:test',adminToken:'456:test',adminIds:new Set(['99'])});
  return {...bots,store,game,calls};
}
test('real Telegram command routing registers before CSV and sends only waiting/help messages',async t=>{
  const {participant,store,calls}=await setup(t);
  await participant.handleUpdate(message(1,'/start'));
  assert.equal(Object.keys(store.read().accounts).length,1);
  assert.match(calls.at(-1).payload.text,/registered/);
  await participant.handleUpdate(message(1,'/status')); assert.match(calls.at(-1).payload.text,/survey profile/);
  await participant.handleUpdate(message(1,'/help')); assert.equal(calls.at(-1).payload.text,PARTICIPANT_HELP);
  await participant.handleUpdate(message(1,'/hint example-password'));
  assert.ok(calls.some(c=>c.method==='deleteMessage'));
  assert.ok(calls.filter(c=>c.method==='sendMessage').every(c=>!c.payload.text.includes('example-password')));
  await participant.handleUpdate(message(2,'/start','other_handle','group'));
  assert.equal(Object.keys(store.read().accounts).length,1);
  for(const call of calls.filter(c=>c.method==='sendMessage')) assert.doesNotMatch(call.payload.text,/third digit|Aeon|Genesis|Nous|Telos|Zenith/i);
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
