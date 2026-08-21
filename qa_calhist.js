#!/usr/bin/env node
/* qa_calhist.js — 路線ごとの休日タグ率のヒストグラム。
 * 「突合が効いた路線」と「効かなかった路線」が分離できるかを見る。 */
'use strict';
const fs = require('fs');
const m = JSON.parse(fs.readFileSync(__dirname + '/trains_v3_meta.json', 'utf8'));
const cal = m.trips.c, lineOf = m.trips.l, modeOf = m.trips.m;
const per = new Map();
for (let t = 0; t < cal.length; t++) {
  if (modeOf && modeOf[t] === 1) continue;
  const n = m.lines[lineOf[t]];
  let p = per.get(n); if (!p) per.set(n, p = { tot: 0, ho: 0 });
  p.tot++; if (cal[t] & 4) p.ho++;
}
const H = new Array(11).fill(0), HT = new Array(11).fill(0);
for (const [, p] of per) { const b = Math.min(10, Math.floor(p.ho / p.tot * 10)); H[b]++; HT[b] += p.tot; }
console.log('休日タグ率  路線数  列車数');
for (let i = 0; i <= 10; i++) {
  const lo = i * 10, hi = i === 10 ? 100 : i * 10 + 10;
  console.log(`${String(lo).padStart(3)}-${String(hi).padStart(3)}%  ${String(H[i]).padStart(5)}  ${String(HT[i]).padStart(6)}  ${'#'.repeat(Math.round(H[i] / 4))}`);
}
const tot = [...per.values()].reduce((a, p) => a + p.tot, 0);
const ho = [...per.values()].reduce((a, p) => a + p.ho, 0);
console.log(`\n鉄道 計${tot}本 / 休日タグ付き ${ho}本 (${(ho / tot * 100).toFixed(1)}%)`);
for (const th of [0.0001, 0.1, 0.2, 0.3, 0.4, 0.5]) {
  const ls = [...per].filter(([, p]) => p.ho / p.tot < th);
  console.log(`  閾値${(th * 100).toFixed(0)}%未満を毎日扱いに戻すと: ${ls.length}路線 ${ls.reduce((a, [, p]) => a + p.tot, 0)}本が対象`);
}
