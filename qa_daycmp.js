#!/usr/bin/env node
/* qa_daycmp.js — 同じODを 平日/土曜/休日 で引き比べ、運転日ダイヤの穴を可視化する
 *
 * Usage: node qa_daycmp.js [probes.json]
 *        node qa_daycmp.js --od 渋谷 浅草 10
 */
'use strict';
const fs = require('fs');
const R = require('./router_v3.js');
const graph = JSON.parse(fs.readFileSync(__dirname + '/graph_v2.json', 'utf8'));
const meta = JSON.parse(fs.readFileSync(__dirname + '/trains_v3_meta.json', 'utf8'));
const fares = JSON.parse(fs.readFileSync(__dirname + '/fares.json', 'utf8'));
const buf = fs.readFileSync(__dirname + '/trains_v3.bin');
R.loadBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta, graph.stations, fares);
const S = graph.stations;

const strip = s => s.replace(/[（(].*?[）)]/g, '');
function idsOf(name) {
  const exact = [], loose = [];
  for (let i = 0; i < S.length; i++) {
    if (S[i].n === name) exact.push(i);
    else if (strip(S[i].n) === strip(name)) loose.push(i);
  }
  const rail = a => a.filter(i => !S[i].m);
  for (const c of [rail(exact), rail(loose), exact, loose]) if (c.length) return c;
  return [];
}

// アプリの doSearch と同じ「同名駅を総当たりして到着順」
function best(from, to, hh, day) {
  const ss = idsOf(from), gg = idsOf(to);
  if (!ss.length || !gg.length) return { error: `駅なし ${!ss.length ? from : to}` };
  let out = null;
  for (const s of ss) for (const g of gg) {
    if (s === g) continue;
    for (const j of R.findJourneys(s, g, hh * 60, day == null ? {} : { day })) {
      if (!out || j.arr < out.arr) out = j;
    }
  }
  if (!out) return { error: 'NO_ROUTE' };
  const fr = R.journeyFare(out);
  return {
    dep: out.dep, arr: out.arr, min: out.arr - out.dep, transfers: out.transfers,
    fare: fr.total,
    lines: out.legs.filter(l => l.kind === 'ride').map(l => (l.lineLabel || l.line || '').replace(/^ＪＲ/, '')),
  };
}
const fmt = t => `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
const show = r => r.error ? `  ${r.error}` : `  ${fmt(r.dep)}→${fmt(r.arr)} ${String(r.min).padStart(3)}分 乗換${r.transfers} ¥${r.fare}  ${r.lines.join(' / ')}`;

const DAYN = ['平日', '土曜', '休日'];

if (process.argv[2] === '--od') {
  const [from, to, hh] = process.argv.slice(3);
  console.log(`### ${from} → ${to} @${hh || 10}時`);
  for (let d = 0; d < 3; d++) console.log(DAYN[d] + '\n' + show(best(from, to, +(hh || 10), d)));
  process.exit(0);
}

const probes = JSON.parse(fs.readFileSync(process.argv[2] || (__dirname + '/qa_day_probes.json'), 'utf8'));
let bad = 0;
for (const p of probes) {
  const [from, to, hh, note] = p;
  const rs = [0, 1, 2].map(d => best(from, to, hh, d));
  // 平日に出るのに土/休で NO_ROUTE、または 20分以上遅くなる = 要確認
  const w = rs[0];
  const flag = !w.error && rs.slice(1).some(r => r.error || r.min - w.min >= 20);
  if (!flag) continue;
  bad++;
  console.log(`\n### ${from} → ${to} @${hh}時  ${note || ''}`);
  for (let d = 0; d < 3; d++) console.log(DAYN[d] + '\n' + show(rs[d]));
}
console.log(`\n=== ${probes.length}件中 要確認 ${bad}件 ===`);
