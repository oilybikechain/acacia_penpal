const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { Game, participantStatus } = require('../src/game');
const { HOUSES, TYPES, FIELDS, parseRoster, parseCompatibility, assignCodes, csv } = require('../src/imports');
const { match, compatible } = require('../src/matching');

function profile(i, overrides = {}) {
  return { name: `Person ${i}`, house: HOUSES[i % 5], year: 'Y1', mbti: TYPES[i % 16], major: 'Computing',
    gender: i % 2 ? 'Female' : 'Male', telegram: `person_${i}`, nickname: `Cookie ${i}`, preference: 'Any', note: 'Hello!', ...overrides };
}
function table() { return Object.fromEntries(TYPES.map(a => [a,Object.fromEntries(TYPES.map(b => [b,50]))])); }
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acacia-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new Store(dir).init(), game = new Game(store);
  return { dir, store, game };
}
async function importProfiles(game, profiles) { await game.confirm('admin', await game.stage('admin','roster',{ profiles })); }
async function prepare(game, profiles = [profile(0), profile(1)]) {
  await importProfiles(game, profiles); await game.generate('admin');
  await game.approve('admin');
  for (const hint of ['house','major','year','gender','name']) await game.setHint('admin', hint, `secret_${hint}`);
}

test('registration works before CSV; import links accounts without erasing pending registrations', async t => {
  const { store, game, dir } = await setup(t);
  assert.match(await game.register({id: 101,username:'PERSON_0'}), /registered.*survey profile has not/s);
  await game.register({id:102});
  await importProfiles(game,[profile(0), profile(1)]);
  const s = store.read();
  assert.equal(Object.keys(s.accounts).length,2);
  assert.equal(s.accounts['101'].profileId,s.profiles[0].id);
  assert.equal(s.accounts['102'].profileId,null);
  assert.equal(s.phase,'draft'); assert.equal(Object.keys(s.jobs).length,0);
  assert.match(game.status(101), /start later/);
  await game.register({id:101,username:'changed_handle'});
  assert.equal(store.read().accounts['101'].profileId,s.profiles[0].id);
  const reloaded = await new Store(dir).init();
  assert.equal(reloaded.read().accounts['101'].profileId,s.profiles[0].id);
});

test('ambiguous accounts are not automatically linked; manual links are exclusive', async t => {
  const { store,game } = await setup(t);
  await game.register({id:1,username:'person_0'}); await game.register({id:2,username:'person_0'});
  await importProfiles(game,[profile(0)]);
  assert.equal(store.read().accounts['1'].profileId,null);
  const code = store.read().profiles[0].code;
  await game.link('admin',1,code);
  await assert.rejects(game.link('admin',2,code),/already linked/);
});

test('roster replacement preserves account registrations and stable profile codes', async t => {
  const { store,game } = await setup(t);
  await game.register({id:1,username:'person_0'}); await importProfiles(game,[profile(0),profile(1)]);
  const before = store.read().profiles[0];
  await importProfiles(game,[profile(0,{nickname:'New nickname'})]);
  assert.equal(store.read().profiles[0].code,before.code);
  assert.equal(store.read().profiles[0].id,before.id);
  assert.equal(store.read().accounts['1'].profileId,before.id);
});

test('survey question headers, BOM, quoted commas/newlines and normalised fields import correctly', async () => {
  const headers = ["What's your name",'What house are you from','What year are you',"What's your MBTI","What's your Major","What's your gender","What's your telegram handle with the @",'Give yourself a nickname (e.g. Cookie dough)','Any preference for the gender of your penpal?','Anything you would want your penpal to know before the event starts?'];
  const p = profile(0,{note:'Hello, friend!\nI like "cookies".',telegram:'@PERSON_0',mbti:'intj'});
  const data = csv([Object.fromEntries(headers.map((h,i)=>[h,p[FIELDS[i]]]))],headers);
  const [parsed] = await parseRoster('\uFEFF'+data);
  assert.equal(parsed.note,p.note); assert.equal(parsed.telegram,'person_0'); assert.equal(parsed.mbti,'INTJ');
  await assert.rejects(parseRoster(csv([p,p],FIELDS)),/Duplicate Telegram/);
  await assert.rejects(parseRoster(csv([profile(0,{house:'Unknown'})],FIELDS)),/Invalid house/);
  await assert.rejects(parseRoster('name,name\nA,B'),/Duplicate CSV columns/);
  await assert.rejects(parseRoster('name,house\nA'),/Row length/);
  const withMetadata = csv([{'Name':'Responder metadata',...Object.fromEntries(headers.map((h,i)=>[h,p[FIELDS[i]]]))}],['Name',...headers]);
  assert.equal((await parseRoster(withMetadata))[0].name,p.name);
  await assert.rejects(parseRoster(csv([profile(0)],FIELDS).replace('Hello!','"Hello!')),/unterminated/);
});

test('MBTI matrix requires every score, symmetry, unique rows, and integers', async () => {
  const records = TYPES.map(type => ({ MBTI:type,...table()[type] }));
  assert.deepEqual(await parseCompatibility(csv(records,['MBTI',...TYPES])),table());
  records[0][TYPES[1]]=99;
  await assert.rejects(parseCompatibility(csv(records,['MBTI',...TYPES])),/symmetric/);
  records[0][TYPES[1]]='';
  await assert.rejects(parseCompatibility(csv(records,['MBTI',...TYPES])),/integer/);
});

test('codes are unique strings with correct private mapping, support leading zeroes, and detect exhaustion', () => {
  const people = assignCodes(Array.from({length:300},(_,i)=>profile(i)));
  assert.equal(new Set(people.map(p=>p.code)).size,300);
  for (const p of people) {
    assert.match(p.code,/^\d{4}$/); assert.equal(Math.floor(Number(p.code[2])/2),HOUSES.indexOf(p.house));
  }
  const allAeon = [];
  for(let i=0;i<10000;i++) { const code=String(i).padStart(4,'0'); if(Number(code[2])<2) allAeon.push({code}); }
  assert.throws(()=>assignCodes([profile(0)],allAeon),/capacity/);
  const available = allAeon.filter(p=>p.code!=='0000');
  assert.equal(assignCodes([profile(0)],available)[0].code,'0000');
});

test('mutual preferences and different houses are strict, with impossible/odd rosters waitlisted', () => {
  const profiles = assignCodes([profile(0),profile(1,{preference:'Female'}),profile(2),profile(3),profile(4)]);
  const pairs=match(profiles);
  for(const pair of pairs) assert.ok(compatible(...pair.map(id=>profiles.find(p=>p.id===id))));
  assert.ok(pairs.length<=2);
  assert.equal(match(assignCodes([profile(0),profile(1,{house:'Aeon'})])).length,0);
  assert.equal(match(assignCodes([profile(0),profile(1,{preference:'Female'})])).length,0);
});

function optimum(profiles) {
  function solve(remaining) {
    if (!remaining.length) return 0;
    const [a,...rest]=remaining;
    let best=solve(rest);
    for(let i=0;i<rest.length;i++) if(compatible(a,rest[i])) {
      const candidate=1+solve(rest.filter((_,j)=>j!==i));
      best=Math.max(best,candidate);
    }
    return best;
  }
  return solve(profiles);
}
test('equal MBTI matching agrees with exhaustive matching on 120 varied small general graphs', () => {
  let seed=12345; const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  for(let run=0;run<120;run++) {
    const profiles=assignCodes(Array.from({length:3+random(6)},(_,i)=>profile(i,{house:HOUSES[random(5)],gender:random(2)?'Male':'Female',preference:['Any','Male','Female'][random(3)]})));
    const pairs=match(profiles,random), seen=new Set();
    for(const [aId,bId] of pairs) {
      assert.ok(!seen.has(aId)&&!seen.has(bId)); seen.add(aId);seen.add(bId);
      const a=profiles.find(p=>p.id===aId), b=profiles.find(p=>p.id===bId);
      assert.ok(compatible(a,b));
    }
    assert.equal(pairs.length,optimum(profiles));
  }
});

test('nested blossom expansion handles a valid five-person roster', () => {
  const people=assignCodes([profile(0),profile(1,{preference:'Female'}),profile(2),profile(3),profile(4)]);
  let seed=17;
  const rng=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  const pairs=match(people,rng);
  assert.equal(pairs.length,optimum(people));
  for (const pair of pairs) assert.ok(compatible(...pair.map(id=>people.find(p=>p.id===id))));
});

test('MBTI answers and legacy saved scores do not affect matching', async t => {
  const {game,store}=await setup(t);
  const people=assignCodes(Array.from({length:8},(_,i)=>profile(i)));
  const rng=()=>{let seed=42;return n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};};
  assert.deepEqual(match(people,rng()),match(people.map(p=>({...p,mbti:'INTJ'})),rng()));
  await importProfiles(game,[profile(0),profile(1)]);
  await store.update(s=>{s.compatibility={broken:'obsolete table'};});
  await game.generate('admin');
  assert.equal(store.read().pairs.length,1);
});

test('launch is explicit, freezes assignments, and supports late registration without identity leaks', async t => {
  const {game,store}=await setup(t); await prepare(game);
  await game.register({id:1,username:'person_0'}); await game.register({id:3});
  const before=store.read();
  assert.doesNotMatch(game.status(1),/Person 1|Cookie 1|Computing/);
  await game.confirm('admin',await game.stage('admin','launch'));
  assert.equal(store.read().phase,'running');
  const launch=Object.values(store.read().jobs)[0]; assert.equal(launch.items.length,1);
  assert.match(launch.items[0].text,/Cookie 1/); assert.doesNotMatch(launch.items[0].text,/Person 1|Genesis|Female|Computing/);
  assert.match(await game.register({id:2,username:'person_1'}),/Cookie 0/);
  assert.match(game.status(3),/profile has not been linked/);
  assert.deepEqual(store.read().pairs,before.pairs);
  await assert.rejects(game.generate('admin'),/before launch/);
  await assert.rejects(game.stage('admin','roster',{profiles:[]}),/before launch/);
  await assert.rejects(game.stage('admin','launch'),/before launch/);
});

test('five independent hint passwords, replay, cooldown, pause/end and persistence', async t => {
  const {game,store,dir}=await setup(t); await prepare(game); await game.register({id:1,username:'person_0'});
  assert.match(await game.hint(1,'secret_name'),/only while/);
  await assert.rejects(game.setHint('admin','house','secret_name'),/different password/);
  await game.confirm('admin',await game.stage('admin','launch'));
  assert.equal(await game.hint(1,'secret_name'),'Name: Person 1');
  assert.equal(await game.hint(1,'secret_name'),'Name: Person 1');
  assert.deepEqual(store.read().accounts['1'].hints,['name']);
  for(const field of ['house','major','year','gender']) assert.match(await game.hint(1,`secret_${field}`),new RegExp(`^${field[0].toUpperCase()+field.slice(1)}:`));
  const disk=await fs.readFile(path.join(dir,'state.json'),'utf8'); assert.ok(!disk.includes('secret_name'));
  const reloaded=await new Store(dir).init(); assert.equal(reloaded.read().accounts['1'].hints.length,5);
  for(let i=0;i<5;i++) assert.equal(await game.hint(1,'wrong'),'Incorrect hint password.');
  assert.match(await game.hint(1,'secret_name'),/Too many/);
  await game.phase('admin','paused'); assert.match(await game.hint(1,'secret_name'),/only while/);
  await game.phase('admin','running'); await game.phase('admin','ended');
  assert.match(await game.hint(1,'secret_name'),/only while/);
});

test('broadcast includes accounts without CSV; confirmations are scoped, single use, and stale-safe', async t => {
  const {game,store}=await setup(t);
  await game.register({id:1}); const token=await game.stage('admin','broadcast',{text:'Hello all'});
  await game.register({id:2});
  await assert.rejects(game.confirm('other',token),/missing/);
  await game.confirm('admin',token);
  assert.equal(Object.values(store.read().jobs)[0].items.length,2);
  await assert.rejects(game.confirm('admin',token),/missing/);
  const stale=await game.stage('admin','roster',{profiles:[profile(0)]});
  await game.confirm('another-admin',await game.stage('another-admin','roster',{profiles:[profile(0)]}));
  await assert.rejects(game.confirm('admin',stale),/changed/);
});

test('broadcast validates text and photo captions and preserves photo previews across restart', async t => {
  const {game,store,dir}=await setup(t);
  for (const payload of [{}, {text:''}, {text:'x'.repeat(4001)}, {text:42}])
    await assert.rejects(game.stage('admin','broadcast',payload),/1–4000/);
  for (const photo of ['',null,42])
    await assert.rejects(game.stage('admin','broadcast',{text:'Caption',photo}),/photo is invalid/);
  await assert.rejects(game.stage('admin','broadcast',{text:'x'.repeat(1025),photo:'admin-photo'}),/1024/);
  await game.register({id:1});
  const token=await game.stage('admin','broadcast',{text:'',photo:'admin-photo'});
  assert.equal(Object.keys(store.read().jobs).length,0);
  const reloaded=await new Store(dir).init();
  await new Game(reloaded).confirm('admin',token);
  const job=Object.values(reloaded.read().jobs)[0];
  assert.equal(job.photo,'admin-photo');
  assert.equal(job.items[0].text,'');
});

test('draft edits keep identity binding and enforce constraints; reset preserves registrations', async t=>{
  const {game,store}=await setup(t); await prepare(game); await game.register({id:1,username:'person_0'});
  const original=store.read().profiles[0];
  await game.edit('admin',original.code,'telegram','new_handle');
  assert.equal(store.read().profiles[0].id,original.id); assert.equal(store.read().accounts['1'].profileId,original.id);
  await assert.rejects(game.edit('admin',original.code,'house','Invalid'),/Invalid/);
  await assert.rejects(game.pair('admin',original.code,original.code),/violates/);
  await game.confirm('admin',await game.stage('admin','reset'));
  assert.equal(Object.keys(store.read().accounts).length,1); assert.equal(store.read().profiles.length,0);
  assert.equal(store.read().accounts['1'].profileId,null);
});

module.exports={ profile, table };
