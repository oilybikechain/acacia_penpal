const csvParser = require('csv-parser');
const { Readable } = require('node:stream');
const { randomInt } = require('node:crypto');

const HOUSES = ['Aeon', 'Genesis', 'Nous', 'Telos', 'Zenith'];
const TYPES = ['INTJ','INTP','ENTJ','ENTP','INFJ','INFP','ENFJ','ENFP','ISTJ','ISFJ','ESTJ','ESFJ','ISTP','ISFP','ESTP','ESFP'];
const FIELDS = ['name','house','year','mbti','major','gender','telegram','nickname','preference','note'];
function handle(value) { return String(value || '').trim().replace(/^@/, '').toLowerCase(); }
function header(raw) {
  const h = raw.trim().toLowerCase().replace(/[’']/g, '');
  if (FIELDS.includes(h)) return h;
  if (h.includes('preference') && h.includes('gender')) return 'preference';
  if (h.includes('nickname')) return 'nickname';
  if (h.includes('penpal to know')) return 'note';
  // Only the handle question identifies a participant. The registration
  // acknowledgement also mentions Telegram and must remain an ignored column.
  if (h.includes('telegram') && h.includes('handle')) return 'telegram';
  if (h.includes('mbti')) return 'mbti';
  if (h.includes('house')) return 'house';
  if (h.includes('major')) return 'major';
  if (h.includes('year')) return 'year';
  if (h.includes('gender')) return 'gender';
  if (h.includes('your name')) return 'name';
  return h;
}
async function rows(text, mapHeader = h => h.trim()) {
  const parser = csvParser({ strict: true, maxRowBytes: 64 * 1024,
    mapHeaders: ({ header }) => header.replace(/^\uFEFF/, '').trim(),
    mapValues: ({ value }) => value.trim() });
  let duplicate = false;
  parser.on('headers', heads => {
    const questionName = mapHeader === header && heads.some(h => header(h) === 'name' && h.toLowerCase() !== 'name');
    const mapped = heads.map(h => {
      // Microsoft Forms exports may include a responder "Name" metadata column
      // as well as the actual name question. Prefer the survey answer.
      if (questionName && h.toLowerCase() === 'name') return null;
      const key = mapHeader(h);
      return mapHeader === header && !FIELDS.includes(key) ? null : key;
    });
    const retained = mapped.filter(h => h !== null);
    duplicate = new Set(retained).size !== retained.length;
    parser.headers = mapped;
  });
  const records = [];
  for await (const record of Readable.from([text]).pipe(parser)) {
    if (duplicate) throw new Error('Duplicate CSV columns');
    if (Object.values(record).some(Boolean)) records.push(record);
  }
  if (parser.state.quoted) throw new Error('CSV contains an unterminated quoted field');
  return records;
}
function canonical(value, allowed, label) {
  const found = allowed.find(v => v.toLowerCase() === String(value || '').trim().toLowerCase());
  if (!found) throw new Error(`Invalid ${label}`);
  return found;
}
function validateProfile(raw) {
  const p = {};
  for (const f of FIELDS) {
    p[f] = String(raw[f] || '').trim();
    if (!p[f]) throw new Error(`Missing ${f}`);
    if (p[f].length > (f === 'note' ? 1000 : 150)) throw new Error(`${f} is too long`);
  }
  p.house = canonical(p.house, HOUSES, 'house');
  p.year = canonical(p.year, ['Y1','Y2','Y3','Y4'], 'year');
  p.mbti = canonical(p.mbti, TYPES, 'MBTI');
  p.gender = canonical(p.gender, ['Male','Female'], 'gender');
  p.preference = canonical(p.preference, ['Any','Male','Female'], 'gender preference');
  p.telegram = handle(p.telegram);
  if (!/^[a-z0-9_]{5,32}$/.test(p.telegram)) throw new Error('Invalid Telegram handle');
  return p;
}
async function parseRoster(text) {
  const records = await rows(text, header);
  if (!records.length) throw new Error('CSV contains no participants');
  const errors = [], seen = new Set(), profiles = [];
  records.forEach((raw, i) => {
    try {
      const p = validateProfile(raw);
      if (seen.has(p.telegram)) throw new Error('Duplicate Telegram handle');
      seen.add(p.telegram); profiles.push(p);
    } catch (error) { errors.push(`Row ${i + 2}: ${error.message}`); }
  });
  if (errors.length) throw new Error(errors.slice(0, 30).join('\n'));
  return profiles;
}
async function parseCompatibility(text) {
  const records = await rows(text, h => h.trim().toUpperCase());
  if (records.length !== 16) throw new Error('Compatibility CSV must have 16 rows');
  const table = {};
  for (const r of records) {
    const type = canonical(r.MBTI, TYPES, 'row MBTI');
    if (table[type]) throw new Error('Duplicate MBTI row');
    table[type] = {};
    for (const other of TYPES) {
      const score = Number(r[other]);
      if (r[other] === undefined || r[other] === '' || !Number.isFinite(score) || score < 0 || score > 100 || !Number.isInteger(score))
        throw new Error(`Score ${type}/${other} must be an integer from 0 to 100`);
      table[type][other] = score;
    }
  }
  for (const a of TYPES) for (const b of TYPES)
    if (table[a][b] !== table[b][a]) throw new Error(`Scores must be symmetric: ${a}/${b}`);
  return table;
}
function assignCodes(profiles, previous = []) {
  const used = new Set(previous.map(p => p.code).filter(Boolean));
  return profiles.map(p => {
    const old = previous.find(o => o.telegram === p.telegram);
    if (old && old.house === p.house && old.code) return { ...p, id: old.id, code: old.code };
    const house = HOUSES.indexOf(p.house), available = [];
    for (let i = 0; i < 10000; i++) {
      const code = String(i).padStart(4, '0');
      if (Math.floor(Number(code[2]) / 2) === house && !used.has(code)) available.push(code);
    }
    if (!available.length) throw new Error(`Code capacity exhausted for ${p.house}`);
    const code = available[randomInt(available.length)]; used.add(code);
    return { ...p, id: old?.id || require('node:crypto').randomUUID(), code };
  });
}
function csv(records, fields) {
  const cell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  return [fields, ...records.map(r => fields.map(f => r[f]))].map(r => r.map(cell).join(',')).join('\r\n');
}
module.exports = { HOUSES, TYPES, FIELDS, handle, validateProfile, parseRoster, parseCompatibility, assignCodes, csv };
