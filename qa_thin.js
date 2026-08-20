#!/usr/bin/env node
/* qa_thin.js — 発着本数が異常に少ない駅 / 片方向しか無い駅を検出 */
'use strict';
const C = require('./qa_coverage.js');
const { g, m, ntrips, tripOff, rawS, rawA, rawD } = C;
const nm = i => g.stations[i].n;
const N = g.stations.length;
const dep = new Int32Array(N), arrv = new Int32Array(N);
const depTimes = new Map();
for (let t = 0; t < ntrips; t++) {
  if (m.trips.m && m.trips.m[t] === 1) continue; // バスは除外(鉄道のQA)
  const s = tripOff[t], e = tripOff[t + 1];
  for (let i = s; i < e; i++) {
    const st = rawS[i];
    if (i < e - 1) { dep[st]++; const d = rawD[i] === 65535 ? rawA[i] : rawD[i]; if (d !== 65535) { if (!depTimes.has(st)) depTimes.set(st, []); depTimes.get(st).push(d); } }
    if (i > s) arrv[st]++;
  }
}
const fmt = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
const THIN = +(process.argv[2] || 6);
const rows = [];
for (let i = 0; i < N; i++) {
  if (g.stations[i].m === 1) continue;   // バス停
  if (dep[i] + arrv[i] === 0) { rows.push({ i, kind: '★列車なし', dep: 0, arrv: 0 }); continue; }
  if (dep[i] < THIN || arrv[i] < THIN) rows.push({ i, kind: dep[i] === 0 ? '★出発便なし' : arrv[i] === 0 ? '★到着便なし' : '少便', dep: dep[i], arrv: arrv[i] });
}
rows.sort((a, b) => (a.dep + a.arrv) - (b.dep + b.arrv));
console.log(`=== 鉄道駅で1日の発 or 着が ${THIN}本未満: ${rows.length}駅 ===`);
for (const r of rows) {
  const ds = depTimes.get(r.i) || [];
  const span = ds.length ? `${fmt(Math.min(...ds))}〜${fmt(Math.max(...ds))}` : '-';
  console.log(`  ${r.kind}  ${nm(r.i)}  発${r.dep}/着${r.arrv}  ${span}  [${(g.stations[r.i].l || []).join(',')}]`);
}
// 始発が遅すぎ / 終発が早すぎ
console.log('\n=== 始発が09:00以降 または 終発が17:00以前の鉄道駅 ===');
const odd = [];
for (let i = 0; i < N; i++) {
  if (g.stations[i].m === 1) continue;
  const ds = depTimes.get(i); if (!ds || !ds.length) continue;
  const mn = Math.min(...ds), mx = Math.max(...ds);
  if (mn >= 540 || mx <= 1020) odd.push({ i, mn, mx, n: ds.length });
}
odd.sort((a, b) => b.mn - a.mn);
odd.forEach(o => console.log(`  ${nm(o.i)}  ${fmt(o.mn)}〜${fmt(o.mx)} (${o.n}本)  [${(g.stations[o.i].l || []).join(',')}]`));
