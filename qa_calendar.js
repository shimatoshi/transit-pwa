#!/usr/bin/env node
/* qa_calendar.js — 運転日(平日/土曜/休日)ダイヤのカバレッジ検査
 *
 * router_v3.query() は opts.day で trips.c の運転日bit(1平日/2土/4休)を見て
 * 列車を絞る。ある路線の休日便が0本だと、日曜に検索したときだけ NO_ROUTE に
 * なる — 平日にしかテストしていないと絶対に見つからない穴なので専用に見る。
 *
 * Usage: node qa_calendar.js [lines|stations]
 */
'use strict';
const fs = require('fs');
const m = JSON.parse(fs.readFileSync(__dirname + '/trains_v3_meta.json', 'utf8'));
const g = JSON.parse(fs.readFileSync(__dirname + '/graph_v2.json', 'utf8'));
const cal = m.trips.c, lineOf = m.trips.l, modeOf = m.trips.m;

if (!cal) { console.log('trips.c(運転日bit)が無い'); process.exit(0); }

const DAYS = [['平日', 1], ['土曜', 2], ['休日', 4]];

console.log(`trips: ${cal.length}`);
const dist = new Map();
for (const v of cal) dist.set(v, (dist.get(v) || 0) + 1);
console.log('=== 運転日bitの分布 (1=平日 2=土 4=休) ===');
[...dist.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
  const lbl = DAYS.filter(([, b]) => k & b).map(([n]) => n).join('+') || '(どの日も走らない)';
  console.log(`  bits=${k} ${lbl.padEnd(12)} ${v}本`);
});

// --- 路線ごとの運転日カバレッジ ---
const perLine = new Map();
for (let t = 0; t < cal.length; t++) {
  const n = m.lines[lineOf[t]];
  let p = perLine.get(n);
  if (!p) perLine.set(n, p = { tot: 0, wd: 0, sa: 0, ho: 0, mode: modeOf ? modeOf[t] : 0 });
  p.tot++;
  if (cal[t] & 1) p.wd++;
  if (cal[t] & 2) p.sa++;
  if (cal[t] & 4) p.ho++;
}

for (const [label, key] of [['休日(日祝)', 'ho'], ['土曜', 'sa'], ['平日', 'wd']]) {
  const bad = [...perLine].filter(([, p]) => p[key] === 0).sort((a, b) => b[1].tot - a[1].tot);
  const rail = bad.filter(([, p]) => p.mode !== 1);
  console.log(`\n=== ${label}に走る便が0本の路線: ${bad.length} (うち鉄道 ${rail.length}) ===`);
  for (const [n, p] of bad.slice(0, 60)) {
    console.log(`  ${p.mode === 1 ? '[bus] ' : '[rail]'} ${n}  計${p.tot}本 平日${p.wd}/土${p.sa}/休${p.ho}`);
  }
  if (bad.length > 60) console.log(`  … 他 ${bad.length - 60}件`);
}

// --- 駅ごとの運転日カバレッジ(鉄道のみ) ---
// 「平日は発車があるのに休日は0本」の駅 = その日だけ孤立する駅
if (process.argv[2] === 'stations') {
  const buf = fs.readFileSync(__dirname + '/trains_v3.bin');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dv = new DataView(ab);
  const ntrips = dv.getUint32(4, true), nstops = dv.getUint32(8, true);
  let off = 12; const a4 = x => (x + 3) & ~3;
  const tripOff = new Uint32Array(ab, off, ntrips + 1); off = a4(off + (ntrips + 1) * 4);
  const rawS = new Uint16Array(ab, off, nstops);

  const ns = g.stations.length;
  const dep = [new Int32Array(ns), new Int32Array(ns), new Int32Array(ns)];
  for (let t = 0; t < ntrips; t++) {
    if (modeOf && modeOf[t] === 1) continue;      // バスは除く
    for (let d = 0; d < 3; d++) {
      if (!(cal[t] & (1 << d))) continue;
      for (let i = tripOff[t]; i < tripOff[t + 1]; i++) dep[d][rawS[i]]++;
    }
  }
  for (let d = 1; d < 3; d++) {
    const lost = [];
    for (let s = 0; s < ns; s++) if (dep[0][s] > 0 && dep[d][s] === 0) lost.push(s);
    console.log(`\n=== 平日は停車があるのに ${DAYS[d][0]} は0本の鉄道駅: ${lost.length} ===`);
    console.log('  ' + lost.slice(0, 80).map(s => `${g.stations[s].n}(${(g.stations[s].l || [])[0] || '?'})`).join(' '));
    if (lost.length > 80) console.log(`  … 他 ${lost.length - 80}駅`);
  }
}
