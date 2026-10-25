const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Store } = require('../src/store');
const { Game } = require('../src/game');
const { Delivery, downloadPhoto } = require('../src/delivery');

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
test('long notes are delivered in chunks and retries resume after acknowledged chunks',async t=>{
  const {store,game,id}=await setup(t), calls=[];
  const text='x'.repeat(3799)+'🙂'+'A long introductory note.\n'.repeat(500);
  await store.update(s=>{s.jobs[id].items=[{userId:'1',text,status:'pending',attempts:0}];});
  let attempt=0;
  const worker=new Delivery(store,{sendMessage:async(user,chunk)=>{
    if (++attempt===2) throw {response:{error_code:403}};
    calls.push(chunk);
  }},{sleep:async()=>{}});
  await worker.kick();
  assert.equal(store.read().jobs[id].items[0].status,'failed');
  assert.equal(calls[0].length,3799);
  await game.retry('admin',id);
  await worker.kick();
  assert.equal(store.read().jobs[id].items[0].status,'sent');
  assert.ok(calls.every(chunk=>chunk.length<=3800));
  assert.equal(calls.join(''),text);
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
test('photo delivery transfers bytes between bots, persists the new file ID, and retries failed recipients',async t=>{
  const {store,game}=await setup(t),calls=[],downloads=[];
  // Keep the legacy text job to verify mixed queues remain compatible.
  await game.confirm('admin',await game.stage('admin','broadcast',{text:'Photo caption',photo:'admin-photo-id'}));
  const photoJob=Object.values(store.read().jobs).find(j=>j.photo);
  const bytes=Buffer.from('image bytes');
  const options={sleep:async()=>{},sourceTelegram:{getFileLink:async id=>{
    downloads.push(id);return new URL('https://example.com/private-photo');
  }},fetch:async()=>new Response(bytes)};
  const telegram={sendMessage:async(user,text)=>calls.push(['text',user,text]),sendPhoto:async(user,photo,extra)=>{
    calls.push(['photo',user,photo,extra]);
    if(user==='2')throw {response:{error_code:403}};
    return {photo:[{file_id:'participant-small'},{file_id:'participant-photo-id'}]};
  }};
  await new Delivery(store,telegram,options).kick();
  const photos=calls.filter(c=>c[0]==='photo');
  assert.deepEqual(photos[0][2].source,bytes);
  assert.deepEqual(photos[0][3],{caption:'Photo caption',protect_content:true});
  assert.equal(photos[1][2],'participant-photo-id');
  assert.deepEqual(downloads,['admin-photo-id']);
  assert.equal(calls.filter(c=>c[0]==='text').length,2);
  assert.deepEqual(store.read().jobs[photoJob.id].items.map(i=>i.status),['sent','failed']);
  const reloaded=await new Store(store.directory).init();
  assert.equal(reloaded.read().jobs[photoJob.id].photoFileId,'participant-photo-id');
  await new Game(reloaded).retry('admin',photoJob.id);
  const retryCalls=[];
  await new Delivery(reloaded,{sendPhoto:async(...args)=>{retryCalls.push(args);}},{sleep:async()=>{}}).kick();
  assert.deepEqual(retryCalls,[['2','participant-photo-id',{caption:'Photo caption',protect_content:true}]]);
});
test('photo download failures are retryable failures and upload ambiguity is uncertain',async t=>{
  const {store,game}=await setup(t);
  await game.confirm('admin',await game.stage('admin','broadcast',{text:'',photo:'admin-photo'}));
  const id=Object.values(store.read().jobs).find(j=>j.photo).id;
  let downloads=0,sends=0;
  const worker=new Delivery(store,{
    sendMessage:async()=>{},sendPhoto:async()=>{sends++;throw Error('network');}
  },{sleep:async()=>{},sourceTelegram:{getFileLink:async()=>new URL('https://example.com/photo')},fetch:async()=>{
    if(downloads++===0)throw Error('download failed');return new Response('image bytes');
  }});
  await worker.kick();
  assert.deepEqual(store.read().jobs[id].items.map(i=>i.status),['failed','uncertain']);
  assert.equal(sends,1);
  await game.retry('admin',id);
  await worker.kick();
  assert.equal(sends,2);
  assert.deepEqual(store.read().jobs[id].items.map(i=>i.status),['uncertain','uncertain']);
});
test('photo upload rate limits wait and retry without resending successful recipients',async t=>{
  const {store,game}=await setup(t),waits=[],sent=[];
  await game.confirm('admin',await game.stage('admin','broadcast',{text:'',photo:'admin-photo'}));
  const id=Object.values(store.read().jobs).find(j=>j.photo).id;
  const worker=new Delivery(store,{sendMessage:async()=>{},sendPhoto:async user=>{
    sent.push(user);
    if(sent.length===1)throw {response:{error_code:429,parameters:{retry_after:3}}};
    return {photo:[{file_id:'participant-photo'}]};
  }},{sleep:async ms=>waits.push(ms),sourceTelegram:{getFileLink:async()=>new URL('https://example.com/photo')},fetch:async()=>new Response('image bytes')});
  await worker.kick();
  assert.deepEqual(sent,['1','1','2']);
  assert.ok(waits.includes(3000));
  assert.deepEqual(store.read().jobs[id].items.map(i=>i.status),['sent','sent']);
});
test('photo downloads reject HTTP errors, empty files, and oversized streams',async()=>{
  const source={getFileLink:async()=>new URL('https://example.com/photo')};
  await assert.rejects(downloadPhoto(source,'photo',async()=>new Response('',{status:500})),/download failed/);
  await assert.rejects(downloadPhoto(source,'photo',async()=>new Response('')),/empty/);
  await assert.rejects(downloadPhoto(source,'photo',async()=>new Response(Buffer.alloc(10*1024*1024+1))),/10 MB/);
});
