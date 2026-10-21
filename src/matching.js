const blossom = require('./vendor/blossom');
const { randomInt } = require('node:crypto');

function compatible(a, b) {
  return a.id !== b.id && a.house !== b.house &&
    (a.preference === 'Any' || a.preference === b.gender) &&
    (b.preference === 'Any' || b.preference === a.gender);
}
function match(profiles, table, random = randomInt) {
  if (!table) throw new Error('Upload the MBTI compatibility table first');
  const shuffled = [...profiles];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = random(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  // One compatibility point outweighs every possible random tie-break combined.
  const scale = Math.floor(profiles.length / 2) * 1000 + 1;
  const edges = [];
  for (let i = 0; i < shuffled.length; i++) for (let j = i + 1; j < shuffled.length; j++) {
    if (compatible(shuffled[i], shuffled[j]))
      edges.push([i, j, table[shuffled[i].mbti][shuffled[j].mbti] * scale + random(1000) + 1]);
  }
  if (!edges.length) return [];
  const mates = blossom(edges, true), pairs = [];
  mates.forEach((j, i) => { if (j > i) pairs.push([shuffled[i].id, shuffled[j].id]); });
  return pairs;
}
module.exports = { compatible, match };
