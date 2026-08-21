#!/usr/bin/env node
/* qa_neighbors.js 駅名... — その駅の隣接駅と座標を出す(座標修正の裏取り用) */
'use strict';
const fs = require('fs');
const g = JSON.parse(fs.readFileSync(__dirname + '/graph_v2.json', 'utf8'));
const S = g.stations;
const hav = (a, b) => {
  const r = x => x * Math.PI / 180;
  const dla = r(b.la - a.la), dlo = r(b.lo - a.lo);
  const h = Math.sin(dla / 2) ** 2 + Math.cos(r(a.la)) * Math.cos(r(b.la)) * Math.sin(dlo / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
const adj = new Map();
for (const [k, list] of Object.entries(g.edges)) {
  const i = +k;
  for (const [j, w, L] of list) {
    if (!adj.has(i)) adj.set(i, []);
    if (!adj.has(j)) adj.set(j, []);
    adj.get(i).push([j, L]); adj.get(j).push([i, L]);
  }
}
for (const q of process.argv.slice(2)) {
  const i = S.findIndex(s => s.n === q);
  if (i < 0) { console.log(`\n### ${q} 見つからず`); continue; }
  const a = S[i];
  console.log(`\n### ${a.n} idx=${i} (${a.la},${a.lo}) p=${a.p} 路線=${(a.l || []).join(',')}`);
  const seen = new Set();
  for (const [j, L] of adj.get(i) || []) {
    if (seen.has(j + '|' + L)) continue; seen.add(j + '|' + L);
    const b = S[j];
    console.log(`   ${L}: ${b.n} (${b.la},${b.lo})  ${b.la != null ? hav(a, b).toFixed(2) + 'km' : 'no-coord'}`);
  }
}
