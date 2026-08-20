#!/usr/bin/env node
/* qa_direction.js — 駅間ごとの上下方向の便数を数え、「片方向しか列車が無い区間」を検出。
 * 単線折返しの路線でデータが片道分しか取り込まれていない欠落を洗い出す。
 */
'use strict';
const C = require('./qa_coverage.js');
const { g, m, ntrips, tripOff, rawS } = C;
const nm = i => g.stations[i].n;
const N = g.stations.length;

// 有向エッジ -> 便数, および路線
const cnt = new Map(); // "a>b" -> n
const edgeLine = new Map();
for (let t = 0; t < ntrips; t++) {
  if (m.trips.m && m.trips.m[t] === 1) continue; // バス系統は除外
  const L = m.lines[m.trips.l[t]];
  for (let i = tripOff[t]; i < tripOff[t + 1] - 1; i++) {
    const a = rawS[i], b = rawS[i + 1];
    const k = `${a}>${b}`;
    cnt.set(k, (cnt.get(k) || 0) + 1);
    if (!edgeLine.has(k)) edgeLine.set(k, new Set());
    edgeLine.get(k).add(L);
  }
}
const oneway = [];
for (const [k, n] of cnt) {
  const [a, b] = k.split('>').map(Number);
  const rev = `${b}>${a}`;
  if (!cnt.has(rev)) oneway.push({ a, b, n, lines: [...edgeLine.get(k)] });
}
// 路線ごとに集計
const byLine = new Map();
for (const o of oneway) {
  const key = o.lines.join('/');
  if (!byLine.has(key)) byLine.set(key, []);
  byLine.get(key).push(o);
}
console.log(`=== 逆方向の列車が1本も無い有向区間: ${oneway.length} / 全${cnt.size}有向区間 ===`);
console.log('(環状運転・単線ループなら正常。往復する路線なら★データ欠落)');
[...byLine.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([L, arr]) => {
  console.log(`\n  【${L}】 ${arr.length}区間`);
  arr.slice(0, 40).forEach(o => console.log(`     ${nm(o.a)}→${nm(o.b)} ${o.n}本 (逆方向0本)`));
  if (arr.length > 40) console.log(`     … 他${arr.length - 40}区間`);
});
