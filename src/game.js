const { randomBytes, scryptSync, timingSafeEqual, createHash } = require('node:crypto');
const { freshState } = require('./store');
const { handle, assignCodes, validateProfile } = require('./imports');
const { match, compatible } = require('./matching');

const HINTS = ['house', 'major', 'year', 'gender', 'name'];
function draft(s) { if (s.phase !== 'draft') throw new Error('This change is available only before launch'); }
function audit(s, actor, action) {
  s.audit.push({ at: new Date().toISOString(), actor: String(actor), action });
  s.audit = s.audit.slice(-1000);
}
function fingerprint(s) {
  return createHash('sha256').update(JSON.stringify([s.profiles, s.pairs, s.pairingReady, s.compatibility, s.phase, s.hintSecrets, s.batches])).digest('hex');
}
function batchProfiles(s, batch) {
  if (!Object.hasOwn(s.batches, batch)) throw new Error('Unknown batch. Use /batches to list batches.');
  const ids = new Set(s.batches[batch].profileIds);
  return s.profiles.filter(p => ids.has(p.id));
}
function broadcastRecipients(s, batch) {
  if (batch === undefined) return Object.values(s.accounts);
  const ids = new Set(batchProfiles(s, batch).map(p => p.id));
  return Object.values(s.accounts).filter(a => ids.has(a.profileId));
}
function validateAddition(s, payload) {
  if (s.phase === 'ended') throw new Error('Game has ended');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(payload.batch || ''))
    throw new Error('Use a batch name of 1–40 letters, numbers, underscores or hyphens.');
  if (Object.hasOwn(s.batches, payload.batch)) throw new Error('Batch already exists. Choose a new batch name.');
  if (!Array.isArray(payload.profiles) || !payload.profiles.length) throw new Error('No new participants');
  const seen = new Set(s.profiles.map(p => p.telegram));
  return payload.profiles.map(raw => {
    const p = validateProfile(raw);
    if (seen.has(p.telegram)) throw new Error(`Telegram handle already exists or is duplicated: @${p.telegram}. Upload only new people.`);
    seen.add(p.telegram);
    return p;
  });
}
function autoLink(s) {
  const claimed = new Set(Object.values(s.accounts).map(a => a.profileId).filter(Boolean));
  for (const a of Object.values(s.accounts)) {
    if (a.profileId || !a.username) continue;
    const candidates = s.profiles.filter(p => p.telegram === a.username && !claimed.has(p.id));
    const accounts = Object.values(s.accounts).filter(b => b.username === a.username && !b.profileId);
    if (candidates.length === 1 && accounts.length === 1) {
      a.profileId = candidates[0].id; claimed.add(a.profileId);
    }
  }
}
function profileFor(s, userId) { return s.profiles.find(p => p.id === s.accounts[String(userId)]?.profileId); }
function partnerFor(s, profileId) {
  const pair = s.pairs.find(pair => pair.includes(profileId));
  return pair && s.profiles.find(p => p.id === pair.find(id => id !== profileId));
}
function participantStatus(s, userId) {
  const a = s.accounts[String(userId)];
  if (!a) return 'Please use /start to register.';
  const p = profileFor(s, userId);
  if (!p) return 'You are registered! Your survey profile has not been linked yet. Please wait for the organisers.';
  if (s.phase === 'draft') return 'You are registered and your survey profile is linked. The game will start later.';
  const penpal = partnerFor(s, p.id);
  if (!penpal) return 'You are registered but currently unpaired. Please contact the organisers.';
  return `Your nickname: ${p.nickname}\nYour code: ${p.code}\n\nYour penpal: ${penpal.nickname}\nPenpal code: ${penpal.code}\n\nTheir note:\n${penpal.note}`;
}
function createJob(s, kind, recipients, text) {
  const id = randomBytes(5).toString('hex');
  s.jobs[id] = { id, kind, created: new Date().toISOString(), items: recipients.map(a => ({
    userId: a.id, text: typeof text === 'function' ? text(a) : text, status: 'pending', attempts: 0
  })) };
  return id;
}
class Game {
  constructor(store) { this.store = store; }
  async register(user) {
    return this.store.update(s => {
      const id = String(user.id);
      s.accounts[id] ||= { id, profileId: null, hints: [], hintFailures: 0, hintBlockedUntil: 0 };
      s.accounts[id].username = handle(user.username);
      autoLink(s);
      return participantStatus(s, id);
    });
  }
  status(id) { return participantStatus(this.store.read(), id); }
  async stage(actor, action, payload = {}) {
    return this.store.update(s => {
      if (action === 'addpeople') payload = { batch: payload.batch, profiles: validateAddition(s, payload) };
      if (action === 'pairnew') {
        if (s.phase === 'ended') throw new Error('Game has ended');
        const paired = new Set(s.pairs.flat());
        const pairs = match(batchProfiles(s, payload.batch).filter(p => !paired.has(p.id)));
        if (!pairs.length) throw new Error('No new compatible pairs within this batch. Existing pairs are preserved.');
        payload = { batch: payload.batch, pairs };
      }
      if (['roster','launch','reset'].includes(action)) {
        if (action === 'roster') draft(s);
        if (action === 'launch') this.checkLaunch(s);
      }
      if (action === 'broadcast') {
        broadcastRecipients(s, payload.batch);
        if (payload.photo !== undefined && (typeof payload.photo !== 'string' || !payload.photo)) throw new Error('Broadcast photo is invalid');
        if (payload.photo) {
          if (typeof payload.text !== 'string' || payload.text.length > 1024) throw new Error('Photo captions must contain at most 1024 characters');
        } else if (typeof payload.text !== 'string' || !payload.text || payload.text.length > 4000) {
          throw new Error('Broadcast must contain 1–4000 characters');
        }
      }
      const token = randomBytes(8).toString('hex');
      s.pending[String(actor)] = { token, action, payload, fingerprint: fingerprint(s), expires: Date.now() + 15 * 60_000 };
      return token;
    });
  }
  checkLaunch(s) {
    draft(s);
    if (!s.pairingReady || !s.pairs.length) throw new Error('Generate, review, and approve at least one pair first');
    if (HINTS.some(h => !s.hintSecrets[h])) throw new Error('Configure all five hint passwords first');
    this.validatePairs(s);
  }
  validatePairs(s) {
    const seen = new Set();
    for (const pair of s.pairs) {
      const [a, b] = pair.map(id => s.profiles.find(p => p.id === id));
      if (!a || !b || !compatible(a, b) || seen.has(a.id) || seen.has(b.id)) throw new Error('Invalid pair assignments');
      seen.add(a.id); seen.add(b.id);
    }
  }
  async confirm(actor, token) {
    return this.store.update(s => {
      const pending = s.pending[String(actor)];
      if (!pending || pending.token !== token || pending.expires < Date.now()) throw new Error('Confirmation missing or expired');
      if (pending.fingerprint !== fingerprint(s)) throw new Error('Game configuration changed; preview this action again');
      const { action, payload } = pending;
      delete s.pending[String(actor)];
      let result = 'Done.';
      if (action === 'roster') {
        draft(s);
        s.profiles = assignCodes(payload.profiles, s.profiles);
        const ids = new Set(s.profiles.map(p => p.id));
        for (const a of Object.values(s.accounts)) if (!ids.has(a.profileId)) { a.profileId = null; a.hints = []; }
        autoLink(s); s.pairs = []; s.pairingReady = false;
        s.batches = {};
        result = `Imported ${s.profiles.length} profiles. Registrations preserved.`;
      } else if (action === 'addpeople') {
        const profiles = assignCodes(validateAddition(s, payload), s.profiles);
        s.profiles.push(...profiles);
        s.batches[payload.batch] = { profileIds: profiles.map(p => p.id), created: new Date().toISOString() };
        autoLink(s);
        result = `Added ${profiles.length} people to batch ${payload.batch}. Existing pairs preserved. Use /pairnew ${payload.batch} to preview pairs within this batch.`;
      } else if (action === 'pairnew') {
        if (s.phase === 'ended') throw new Error('Game has ended');
        s.pairs.push(...payload.pairs);
        this.validatePairs(s);
        const ids = new Set(payload.pairs.flat());
        result = `Added ${payload.pairs.length} pairs for batch ${payload.batch}. Existing pairs preserved.`;
        if (s.phase === 'draft') {
          s.pairingReady = false;
          result += ' Review /pairs, then /approve before launch.';
        } else {
          const recipients = Object.values(s.accounts).filter(a => ids.has(a.profileId));
          const id = createJob(s, 'late-assignments', recipients, a => participantStatus(s, a.id));
          s.jobs[id].batch = payload.batch;
          result += ` Assignment delivery job: ${id}`;
        }
      } else if (action === 'launch') {
        this.checkLaunch(s); s.phase = 'running';
        const recipients = Object.values(s.accounts).filter(a => {
          const p = profileFor(s, a.id); return p && partnerFor(s, p.id);
        });
        result = `Game started. Delivery job: ${createJob(s, 'launch', recipients, a => participantStatus(s, a.id))}`;
      } else if (action === 'broadcast') {
        const id = createJob(s, 'broadcast', broadcastRecipients(s, payload.batch), payload.text);
        if (payload.batch !== undefined) s.jobs[id].batch = payload.batch;
        if (payload.photo) s.jobs[id].photo = payload.photo;
        result = `Broadcast queued. Delivery job: ${id}`;
      } else if (action === 'reset') {
        if (Object.values(s.jobs).some(j => j.items.some(i => ['pending','sending'].includes(i.status))))
          throw new Error('Wait for delivery jobs to finish before resetting');
        // Preserve registrations so a new round does not lose the audience.
        const registrations = s.accounts, history = s.audit, offsets = s.offsets;
        Object.assign(s, freshState()); s.accounts = registrations; s.audit = history; s.offsets = offsets || {};
        for (const a of Object.values(s.accounts)) { a.profileId = null; a.hints = []; a.hintFailures = 0; a.hintBlockedUntil = 0; }
        result = 'Game reset. Telegram registrations preserved.';
      } else throw new Error('Unknown action');
      audit(s, actor, action); return result;
    });
  }
  async generate(actor) {
    return this.store.update(s => { draft(s); s.pairs = match(s.profiles); s.pairingReady = false; audit(s, actor, 'pairings generated'); });
  }
  async approve(actor) {
    return this.store.update(s => { draft(s); this.validatePairs(s); if (!s.pairs.length) throw new Error('No pairs to approve'); s.pairingReady = true; audit(s, actor, 'pairings approved'); });
  }
  async pair(actor, code1, code2) {
    return this.store.update(s => {
      draft(s);
      const a = s.profiles.find(p => p.code === code1), b = s.profiles.find(p => p.code === code2);
      if (!a || !b || !compatible(a, b)) throw new Error('Pair violates house/gender rules or code is unknown');
      s.pairs = s.pairs.filter(pair => !pair.includes(a.id) && !pair.includes(b.id));
      s.pairs.push([a.id,b.id]); s.pairingReady = false; audit(s, actor, 'manual pair');
    });
  }
  async edit(actor, code, field, value) {
    return this.store.update(s => {
      draft(s);
      const p = s.profiles.find(p => p.code === code);
      if (!p) throw new Error('Unknown code');
      const valid = validateProfile({ ...p, [field]: value });
      if (!(field in valid)) throw new Error('Unknown profile field');
      if (s.profiles.some(other => other.id !== p.id && other.telegram === valid.telegram)) throw new Error('Duplicate Telegram handle');
      const nextCode = p.house === valid.house ? p.code : assignCodes([valid], s.profiles)[0].code;
      // A handle edit must preserve the existing participant identity and binding.
      Object.assign(p, valid, { code: nextCode });
      s.pairs = []; s.pairingReady = false; autoLink(s); audit(s, actor, 'profile edited');
    });
  }
  async link(actor, userId, code) {
    return this.store.update(s => {
      const a = s.accounts[String(userId)], p = s.profiles.find(p => p.code === code);
      if (!a || !p) throw new Error('Account or profile not found');
      if (Object.values(s.accounts).some(other => other.id !== a.id && other.profileId === p.id)) throw new Error('Profile is already linked; unlink the old account first');
      for (const j of Object.values(s.jobs)) if (j.kind !== 'broadcast') for (const item of j.items)
        if (item.userId === a.id && item.status === 'pending') item.status = 'cancelled';
      a.profileId = p.id; a.hints = []; audit(s, actor, 'account linked');
      return s.phase !== 'draft' ? createJob(s, 'assignment', [a], participantStatus(s, a.id)) : null;
    });
  }
  async unlink(actor, userId) {
    return this.store.update(s => {
      const a = s.accounts[String(userId)]; if (!a) throw new Error('Unknown registered account');
      for (const j of Object.values(s.jobs)) if (j.kind !== 'broadcast') for (const item of j.items)
        if (item.userId === a.id && item.status === 'pending') item.status = 'cancelled';
      a.profileId = null; a.username = ''; a.hints = []; audit(s, actor, 'account unlinked');
    });
  }
  async setHint(actor, field, password) {
    if (!HINTS.includes(field) || password.length < 4 || password.length > 128 || /\s/.test(password))
      throw new Error('Use a valid hint field and a 4–128 character password without spaces');
    return this.store.update(s => {
      if (s.phase === 'ended') throw new Error('Game has ended');
      for (const [other, secret] of Object.entries(s.hintSecrets)) {
        if (other !== field && timingSafeEqual(scryptSync(password, secret.salt, 32), Buffer.from(secret.hash,'hex')))
          throw new Error('Each hint must have a different password');
      }
      const salt = randomBytes(16).toString('hex');
      s.hintSecrets[field] = { salt, hash: scryptSync(password, salt, 32).toString('hex') };
      audit(s, actor, `hint configured: ${field}`);
    });
  }
  async hint(userId, password) {
    return this.store.update(s => {
      const a = s.accounts[String(userId)], p = profileFor(s, userId);
      if (!a) return 'Please use /start to register.';
      if (s.phase !== 'running') return 'Hints are available only while the game is active.';
      const partner = p && partnerFor(s, p.id);
      if (!partner) return 'You do not have a penpal assignment yet.';
      if (a.hintBlockedUntil > Date.now()) return 'Too many incorrect passwords. Please try again in a minute.';
      let field;
      if (password && password.length <= 128) for (const [key, secret] of Object.entries(s.hintSecrets)) {
        if (timingSafeEqual(scryptSync(password, secret.salt, 32), Buffer.from(secret.hash,'hex'))) { field = key; break; }
      }
      if (!field) {
        a.hintFailures++;
        if (a.hintFailures >= 5) { a.hintBlockedUntil = Date.now() + 60_000; a.hintFailures = 0; }
        return 'Incorrect hint password.';
      }
      a.hintFailures = 0;
      if (!a.hints.includes(field)) a.hints.push(field);
      return `${field[0].toUpperCase() + field.slice(1)}: ${partner[field]}`;
    });
  }
  async phase(actor, next) {
    return this.store.update(s => {
      const allowed = { running: ['paused','ended'], paused: ['running','ended'] };
      if (!allowed[s.phase]?.includes(next)) throw new Error('Invalid game state transition');
      s.phase = next; audit(s, actor, `game ${next}`);
    });
  }
  async retry(actor, id, includeUncertain = false) {
    return this.store.update(s => {
      const job = s.jobs[id]; if (!job) throw new Error('Unknown delivery job');
      for (const i of job.items) if (i.status === 'failed' || (includeUncertain && i.status === 'uncertain')) i.status = 'pending';
      audit(s, actor, `retry job ${id}`);
    });
  }
}
module.exports = { Game, HINTS, participantStatus, profileFor, partnerFor, autoLink, createJob, batchProfiles, broadcastRecipients };
