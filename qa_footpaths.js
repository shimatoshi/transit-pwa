#!/usr/bin/env node
/* qa_footpaths.js — 徒歩連絡(footpaths)の妥当性検査。
 *
 * make_trains_v3.build_footpaths() は必ず haversine で 400m/1.2km/600m のゲートを
 * 掛けているので、これを大きく超える連絡が meta に載っているなら、それは
 * 生成時に使った座標が今の graph_v2 の座標と違う(= 片方の座標が壊れている/直された)
 * ことを意味する。実距離とweightが噛み合わない連絡は経路探索の「ワームホール」になる。
 */
'use strict';
const fs = require('fs');
const g = JSON.parse(fs.readFileSync(__dirname + '/graph_v2.json', 'utf8'));
const m = JSON.parse(fs.readFileSync(__dirname + '/trains_v3_meta.json', 'utf8'));
const S = g.stations;
const R = 6371;
const hav = (a, b) => {
  const r = x => x * Math.PI / 180;
  const dla = r(b.la - a.la), dlo = r(b.lo - a.lo);
  const h = Math.sin(dla / 2) ** 2 + Math.cos(r(a.la)) * Math.cos(r(b.la)) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const fps = m.footpaths || [];
console.log(`footpaths: ${fps.length}`);
const rows = [];
let noCoord = 0;
for (const [i, j, w] of fps) {
  const a = S[i], b = S[j];
  if (a.la == null || b.la == null) { noCoord++; continue; }
  const km = hav(a, b);
  rows.push({ i, j, w, km });
}
console.log(`座標が無くて検証できない連絡: ${noCoord}`);

// 生成時の上限は最大1.2km。weightは round(km*15)+3 のはず。
const over = rows.filter(r => r.km > 1.3).sort((a, b) => b.km - a.km);
console.log(`\n=== 実距離が生成上限(1.2km)を超える徒歩連絡: ${over.length} ===`);
for (const r of over.slice(0, 40)) {
  const a = S[r.i], b = S[r.j];
  console.log(`  ${r.km.toFixed(1)}km を ${r.w}分で連絡  ${a.n}[${(a.l || a.sys || []).slice(0, 2)}] ⇄ ${b.n}[${(b.l || b.sys || []).slice(0, 2)}]`);
  console.log(`      (${a.la},${a.lo}) / (${b.la},${b.lo})`);
}

// weight と実距離の不整合(座標が後から直された連絡)
const mism = rows.filter(r => Math.abs(r.w - (Math.round(r.km * 15) + 3)) > 3).sort((a, b) => b.km - a.km);
console.log(`\n=== weight が実距離と噛み合わない連絡(±3分超): ${mism.length} ===`);
for (const r of mism.slice(0, 25)) {
  const a = S[r.i], b = S[r.j];
  console.log(`  ${a.n} ⇄ ${b.n}: weight=${r.w}分 だが実距離${r.km.toFixed(2)}km(=${Math.round(r.km * 15) + 3}分相当)`);
}

// 参考: 同名で遠い駅ペア(連絡が張られていなくても、座標破損の兆候)
console.log('\n=== 同名(括弧除去)なのに 5km 以上離れている駅ペア(座標破損の兆候・上位20) ===');
const strip = s => s.replace(/[（(].*?[）)]/g, '');
const by = new Map();
S.forEach((s, i) => { if (s.m || s.la == null) return; const k = strip(s.n); if (!by.has(k)) by.set(k, []); by.get(k).push(i); });
const far = [];
for (const [k, ids] of by) {
  if (ids.length < 2 || ids.length > 8) continue;
  for (let x = 0; x < ids.length; x++) for (let y = x + 1; y < ids.length; y++) {
    const d = hav(S[ids[x]], S[ids[y]]);
    if (d >= 5) far.push([k, ids[x], ids[y], d]);
  }
}
far.sort((a, b) => b[3] - a[3]);
far.slice(0, 20).forEach(([k, x, y, d]) => console.log(`  ${d.toFixed(0)}km  ${S[x].n}[${(S[x].l || [])[0]}] ⇄ ${S[y].n}[${(S[y].l || [])[0]}]`));
console.log(`  (計 ${far.length}組)`);
