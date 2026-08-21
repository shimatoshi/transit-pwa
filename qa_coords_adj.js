#!/usr/bin/env node
/* qa_coords_adj.js — 「隣の駅から極端に離れた座標」を持つ駅を洗い出す。
 *
 * PR#5 の fix_coords3.py は駅名一致で座標を補完し、暴走止めに「隣接駅から80km以内」
 * というゲートを掛けた。関西のように同名駅が80km圏に密集する地域ではこのゲートを
 * 素通りしてしまい、別の同名駅の座標が入る。
 * 症状は座標の誤りに留まらない: 誤座標どうしが近接判定で徒歩連絡(≤400m/1.2km)に
 * なると、探索が数十km を数分で飛ぶ「ワームホール」ができる。
 *
 * ここでは graph_v2.edges(実在する駅間区間)を使い、隣接駅までの距離を見る。
 * 新幹線や特急の長距離区間があるので、判定は「最も近い隣接駅までの距離」で行う。
 */
'use strict';
const fs = require('fs');
const g = JSON.parse(fs.readFileSync(__dirname + '/graph_v2.json', 'utf8'));
const m = JSON.parse(fs.readFileSync(__dirname + '/trains_v3_meta.json', 'utf8'));
const S = g.stations;
const hav = (a, b) => {
  const r = x => x * Math.PI / 180;
  const dla = r(b.la - a.la), dlo = r(b.lo - a.lo);
  const h = Math.sin(dla / 2) ** 2 + Math.cos(r(a.la)) * Math.cos(r(b.la)) * Math.sin(dlo / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

// 隣接リスト(無向)
const adj = new Map();
for (const [k, list] of Object.entries(g.edges)) {
  const i = +k;
  for (const [j] of list) {
    if (!adj.has(i)) adj.set(i, new Set());
    if (!adj.has(j)) adj.set(j, new Set());
    adj.get(i).add(j); adj.get(j).add(i);
  }
}

const THRESH = +(process.argv[2] || 15);   // km
const bad = [];
for (const [i, ns] of adj) {
  const a = S[i];
  if (!a || a.la == null || a.m) continue;
  let min = Infinity, who = -1;
  for (const j of ns) {
    const b = S[j];
    if (!b || b.la == null) continue;
    const d = hav(a, b);
    if (d < min) { min = d; who = j; }
  }
  if (min !== Infinity && min > THRESH) bad.push({ i, min, who, n: ns.size });
}
bad.sort((a, b) => b.min - a.min);
console.log(`=== 最寄りの隣接駅まで ${THRESH}km 超の駅: ${bad.length} ===`);
console.log('(新幹線単独駅など正当なものも混ざる。路線名で判断すること)');
for (const r of bad.slice(0, 50)) {
  const a = S[r.i];
  console.log(`  ${r.min.toFixed(1)}km  ${a.n} [${(a.l || []).slice(0, 3).join(',')}] ${a.p || ''} (${a.la},${a.lo})`);
  console.log(`        最寄隣接=${S[r.who].n} (${S[r.who].la},${S[r.who].lo})  隣接数=${r.n}`);
}

// --- 都道府県と座標の突き合わせ ---
// 県境の駅で1つずれる程度は誤差だが、数百km離れているなら座標か p のどちらかが壊れている。
const PREF_CENTER = JSON.parse(fs.readFileSync(__dirname + '/qa_pref_center.json', 'utf8'));
console.log('\n=== 都道府県(p)の代表点から 80km 以上離れた鉄道駅 ===');
const pbad = [];
for (let i = 0; i < S.length; i++) {
  const s = S[i];
  if (s.m || s.la == null || !s.p) continue;
  const c = PREF_CENTER[s.p];
  if (!c) continue;
  const d = hav(s, { la: c[0], lo: c[1] });
  if (d > 80) pbad.push({ i, d });
}
pbad.sort((a, b) => b.d - a.d);
console.log(`  該当 ${pbad.length}駅`);
for (const r of pbad.slice(0, 40)) {
  const s = S[r.i];
  console.log(`  ${r.d.toFixed(0)}km  ${s.n} p=${s.p} [${(s.l || []).slice(0, 2).join(',')}] (${s.la},${s.lo})`);
}

// --- ワームホール: 徒歩連絡の両端が「互いの隣接駅から見て」遠すぎないか ---
console.log('\n=== 徒歩連絡のうち、両端の路線網が大きく離れているもの ===');
const fps = m.footpaths || [];
let worm = 0;
for (const [i, j, w] of fps) {
  const A = adj.get(i), B = adj.get(j);
  if (!A || !B) continue;
  const near = (set, s) => {
    let mn = Infinity;
    for (const k of set) if (S[k] && S[k].la != null) mn = Math.min(mn, hav(S[k], s));
    return mn;
  };
  // i の隣接駅群から見た j、j の隣接駅群から見た i
  const d1 = near(A, S[j]), d2 = near(B, S[i]);
  if (Math.min(d1, d2) > 12) {
    worm++;
    console.log(`  ${S[i].n} ⇄ ${S[j].n} (${w}分)  隣接網からの距離 ${d1.toFixed(1)}km / ${d2.toFixed(1)}km`);
  }
}
console.log(`  該当 ${worm}件`);
