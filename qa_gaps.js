#!/usr/bin/env node
/* qa_gaps.js — 路線内の「駅リストにあるが時刻表に無い駅」= 穴 を列挙 */
'use strict';
const C = require('./qa_coverage.js');
const { g, lineStations, lineTTStations, lineTrips, stDepTimes } = C;
const nm = i => g.stations[i].n;
const fmt = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

const rows = [];
for (const [L, gs] of lineStations) {
  const ts = lineTTStations.get(L) || new Set();
  const missing = [...gs].filter(i => !ts.has(i));
  if (missing.length) rows.push({ L, tot: gs.size, missing });
}
rows.sort((a, b) => b.missing.length / b.tot - a.missing.length / a.tot);
console.log(`=== 路線内で時刻表に現れない駅がある路線: ${rows.length} ===`);
console.log('(その路線の列車が一度も停まらない駅。他路線の列車では停まる場合もある)');
for (const r of rows) {
  const wholly = r.missing.filter(i => {
    // その駅に「どの路線でも」発時刻が無いか
    return !stDepTimes.has(i);
  });
  console.log(`  ${r.L}: ${r.missing.length}/${r.tot}駅欠  trips=${lineTrips.get(r.L) || 0}`);
  console.log(`     ${r.missing.map(nm).join(' ')}`);
  if (wholly.length) console.log(`     ★全路線で時刻表無し: ${wholly.map(nm).join(' ')}`);
}
