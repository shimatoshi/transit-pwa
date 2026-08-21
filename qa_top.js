#!/usr/bin/env node
/* qa_top.js FROM TO [hh] [day] — findJourneys の上位候補をランキング順に全部出す(調査用) */
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
    if (S[i].n === name) exact.push(i); else if (strip(S[i].n) === strip(name)) loose.push(i);
  }
  const rail = a => a.filter(i => !S[i].m);
  for (const c of [rail(exact), rail(loose), exact, loose]) if (c.length) return c;
  return [];
}
const fmt = t => `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
const [from, to, hh, day] = process.argv.slice(2);
const ss = idsOf(from), gg = idsOf(to);
if (!ss.length || !gg.length) { console.log('駅なし', from, to); process.exit(1); }
const all = [];
for (const s of ss) for (const g of gg) {
  if (s === g) continue;
  for (const j of R.findJourneys(s, g, (+(hh || 9)) * 60, day != null && day !== '' ? { day: +day } : {})) all.push(j);
}
all.sort((a, b) => a.arr - b.arr);
console.log(`${from} → ${to} @${hh || 9}時 day=${day ?? '(絞らず)'}  候補${all.length}件`);
all.slice(0, 12).forEach((j, i) => {
  const fr = R.journeyFare(j);
  console.log(`\n[${i + 1}] ${fmt(j.dep)}→${fmt(j.arr)} ${j.arr - j.dep}分 乗換${j.transfers} ¥${fr.total}`);
  j.legs.filter(l => l.kind === 'ride').forEach(l =>
    console.log(`    ${(l.lineLabel || l.line)}[${l.type}] ${S[l.from].n} ${fmt(l.dep)} → ${S[l.to].n} ${fmt(l.arr)}`));
  console.log('    運賃内訳: ' + fr.breakdown.map(b => `${b.company}¥${b.fare}`).join(' + '));
});
