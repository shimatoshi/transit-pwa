#!/usr/bin/env node
/* qa_baseline_diff.js — test_rail_baseline.json と現データの差分を人が読める形で出す。
 * baseline を作り直す前に「変化が全て改善か」を目視するため。
 * sig の作り方は test_bus_router.js と同じにしてある(ずれると全件差分に見える)。 */
'use strict';
const fs = require('fs');
const R = require('./router_v3.js');
const graph = JSON.parse(fs.readFileSync(__dirname + '/graph_v2.json', 'utf8'));
const meta = JSON.parse(fs.readFileSync(__dirname + '/trains_v3_meta.json', 'utf8'));
const fares = JSON.parse(fs.readFileSync(__dirname + '/fares.json', 'utf8'));
const buf = fs.readFileSync(__dirname + '/trains_v3.bin');
R.loadBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta, graph.stations, fares);
const S = graph.stations;
const base = JSON.parse(fs.readFileSync(__dirname + '/test_rail_baseline.json', 'utf8'));

const railId = n => S.findIndex(s => !s.m && s.n === n);
const fmt = t => `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
// test_bus_router.js の sig() と同一
const sig = j => j.legs.map(l => l.kind === 'walk'
  ? `w${l.from}>${l.to}:${l.min}`
  : `${l.line}/${l.type}/${l.from}>${l.to}@${l.dep}-${l.arr}`).join('|');
const DAYN = ['平日', '土曜', '休日'];

let same = 0, better = 0, eq = 0, worse = 0, appeared = 0;
const rows = [];
for (const [k, b] of Object.entries(base.results)) {
  if (b === 'NOSTATION') continue;
  const m = /^(.+?)>(.+?)@(\d+)d(\d)$/.exec(k);
  if (!m) continue;
  const [, from, to, at, d] = m;
  const s = railId(from), g = railId(to);
  if (s < 0 || g < 0) continue;
  const j = R.query(s, g, +at, { day: +d });
  const nsig = j ? sig(j) : null;
  if ((b && b.sig) === nsig) { same++; continue; }
  if (!j) { worse++; rows.push({ k, note: '経路なしに退化', b, j: null }); continue; }
  if (!b) { appeared++; rows.push({ k, note: '★新たに経路が出るように', b: null, j, from, to, day: DAYN[+d] }); continue; }
  const note = j.arr < b.arr ? `★${b.arr - j.arr}分 短縮` : j.arr === b.arr ? '同着(経路のみ変化)' : `✗${j.arr - b.arr}分 悪化`;
  if (j.arr < b.arr) better++; else if (j.arr === b.arr) eq++; else worse++;
  rows.push({ k, note, b, j, from, to, day: DAYN[+d] });
}
console.log(`同一 ${same} / 短縮 ${better} / 新たに経路 ${appeared} / 同着だが経路変化 ${eq} / 悪化 ${worse}`);
const dayOf = k => DAYN[+(/d(\d)$/.exec(k)[1])];
const wd = rows.filter(r => /d0$/.test(r.k));
console.log(`変化 ${rows.length}件 (平日 ${wd.length}件 / 土休 ${rows.length - wd.length}件)`);
console.log('\n=== 変化した経路 ===');
for (const r of rows) {
  console.log(`\n■ ${r.from}→${r.to} ${dayOf(r.k)} [${r.note}]`);
  if (r.b) console.log(`  旧 →${fmt(r.b.arr)}  ${r.b.sig.split('|').map(x => x.split('/').slice(0, 2).join(' ')).join(' / ')}`);
  if (r.j) console.log(`  新 →${fmt(r.j.arr)}  ${r.j.legs.filter(l => l.kind === 'ride').map(l => `${l.lineLabel || l.line}[${l.type}] ${S[l.from].n}${fmt(l.dep)}→${S[l.to].n}${fmt(l.arr)}`).join(' / ')}`);
}
