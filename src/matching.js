const blossom = require('./vendor/blossom');
const { randomInt } = require('node:crypto');

function compatible(a, b) {
  return a.id !== b.id && a.house !== b.house &&
    (a.preference === 'Any' || a.preference === b.gender) &&
    (b.preference === 'Any' || b.preference === a.gender);
}
function match(profiles, random = randomInt) {
  const shuffled = [...profiles];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = random(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  // Maximise the number paired, with random tie-breaking among valid pairs.
  // MBTI does not affect eligibility or edge weights.
  const edges = [];
  for (let i = 0; i < shuffled.length; i++) for (let j = i + 1; j < shuffled.length; j++) {
    if (compatible(shuffled[i], shuffled[j]))
      edges.push([i, j, random(1000) + 1]);
  }
  if (!edges.length) return [];
  const mates = blossom(edges, true), pairs = [];
  mates.forEach((j, i) => { if (j > i) pairs.push([shuffled[i].id, shuffled[j].id]); });
  return pairs;
}
module.exports = { compatible, match };
