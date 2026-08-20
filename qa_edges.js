#!/usr/bin/env node
/* qa_edges.js — graph_v2 の駅間エッジのうち、実列車が1本も走っていない区間を検出。
 * = 「駅リスト上は繋がっているのに、時刻表では繋がらない」穴。
 */
'use strict';
const C = require('./qa_coverage.js');
const { g, m, ntrips, tripOff, rawS } = C;
const nm = i => g.stations[i].n;

// 実列車が張るエッジ(無向)
const covered = new Set();
for (let t = 0; t < ntrips; t++) {
  for (let i = tripOff[t]; i < tripOff[t + 1] - 1; i++) {
    const a = rawS[i], b = rawS[i + 1];
    covered.add(a < b ? `${a}_${b}` : `${b}_${a}`);
  }
}
// footpath も接続とみなす
for (const [a, b] of m.footpaths) covered.add(a < b ? `${a}_${b}` : `${b}_${a}`);

const byLine = new Map();
let total = 0, miss = 0;
const seen = new Set();
for (const [k, arr] of Object.entries(g.edges)) {
  const a = +k;
  for (const [b, w, line] of arr) {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total++;
    if (!covered.has(key)) {
      miss++;
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(`${nm(a)}〜${nm(b)}`);
    }
  }
}
console.log(`=== 駅間エッジ ${total}本中、実列車が1本も走っていない区間: ${miss}本 ===`);
[...byLine.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([L, arr]) => {
  console.log(`  ${L} (${arr.length}): ${arr.join(' ')}`);
});
