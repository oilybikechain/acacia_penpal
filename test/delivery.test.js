const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Store } = require('../src/store');
const { Game } = require('../src/game');
const { Delivery } = require('../src/delivery');

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'acacia-delivery-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=await new Store(dir).init(),game=new Game(store);
  await game.register({id:1});await game.register({id:2});
  await game.confirm('admin',await game.stage('admin','broadcast',{text:'Announcement'}));
  return {store,game,id:Object.keys(store.read().jobs)[0]};
}
test('partial failures and retries do not resend successful recipients',async t=>{
  const {store,game,id}=await setup(t), calls=[];let fail=true;
  const worker=new Delivery(store,{sendMessage:async user=>{calls.push(user);if(user==='2'&&fail)throw {response:{error_code:403}};}},{sleep:async()=>{}});
  await Promise.all([worker.kick(),worker.kick()]);
  assert.deepEqual(store.read().jobs[id].items.map(i=>i.status),['sent','failed']);
  fail=false;await game.retry('admin',id);await worker.kick();
  assert.deepEqual(calls,['1','2','2']);
});
test('rate limiting waits and retries; network ambiguity requires explicit uncertain retry',async t=>{
  const {store,game,id}=await setup(t), waits=[];let attempt=0;
  const worker=new Delivery(store,{sendMessage:async user=>{
    if(user==='1'&&attempt++===0)throw {response:{error_code:429,parameters:{retry_after:2}}};
    if(user==='2')throw new Error('network');
  }},{sleep:async ms=>waits.push(ms)});
  await worker.kick();assert.ok(waits.includes(2000));
  assert.deepEqual(store.read().jobs[id].items.map(i=>i.status),['sent','uncertain']);
  await game.retry('admin',id);assert.equal(store.read().jobs[id].items[1].status,'uncertain');
  await game.retry('admin',id,true);assert.equal(store.read().jobs[id].items[1].status,'pending');
});
test('restart marks interrupted sends uncertain and resumes only pending messages',async t=>{
  const {store,id}=await setup(t),calls=[];
  await store.update(s=>{s.jobs[id].items[0].status='sending';});
  const worker=new Delivery(store,{sendMessage:async user=>calls.push(user)},{sleep:async()=>{}});
  await worker.recover();await worker.kick();
  assert.deepEqual(calls,['2']);assert.equal(store.read().jobs[id].items[0].status,'uncertain');
});
test('serialised storage rolls back failed mutations and persists concurrent registrations',async t=>{
  const {store,game}=await setup(t);
  await assert.rejects(store.update(s=>{s.phase='invalid';throw Error('rejected');}));
  assert.equal(store.read().phase,'draft');
  await Promise.all(Array.from({length:20},(_,i)=>game.register({id:100+i})));
  assert.equal(Object.keys(store.read().accounts).length,22);
});
