#!/usr/bin/env node
/* oneroute.js "FROM" "TO" [hh] — 自作エンジンの最速経路を1行JSONで出力。比較用。 */
'use strict';
const fs = require('fs');
const R = require('./router_v3.js');
const graph = JSON.parse(fs.readFileSync('graph_v2.json', 'utf8'));
const meta = JSON.parse(fs.readFileSync('trains_v3_meta.json', 'utf8'));
const fares = JSON.parse(fs.readFileSync('fares.json', 'utf8'));
const buf = fs.readFileSync('trains_v3.bin');
R.loadBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta, graph.stations, fares);
const S = graph.stations;

function id(n) {
  let i = S.findIndex(s => s.n === n);
  if (i < 0) i = S.findIndex(s => s.n.startsWith(n + '('));      // 同名は最初の(地名)
  if (i < 0) { const b = n.replace(/[（(].*?[）)]/g, ''); i = S.findIndex(s => s.n === b || s.n.startsWith(b + '(')); }
  return i;
}

const [from, to, hh] = process.argv.slice(2);
const s = id(from), g = id(to);
const out = { from, to };
if (s < 0 || g < 0) { out.error = `駅なし s=${s} g=${g}`; console.log(JSON.stringify(out)); process.exit(0); }
const dep0 = (hh ? parseInt(hh) : 9) * 60;
// アプリと同じランキング1位(特急/新幹線ペナルティ込み)を採用
const js = R.findJourneys(s, g, dep0, {});
const best = js[0];
if (!best) { out.error = '経路なし'; console.log(JSON.stringify(out)); process.exit(0); }
const fr = R.journeyFare(best);
out.dep = best.dep; out.arr = best.arr; out.min = best.arr - best.dep;
out.transfers = best.transfers; out.fare = fr.total;
out.express = fr.breakdown.filter(b => /料金$/.test(b.company)).reduce((a, b) => a + b.fare, 0);
out.lines = best.legs.filter(l => l.kind === 'ride').map(l => (l.line || '').replace(/^ＪＲ/, '') + '[' + l.type + ']');
console.log(JSON.stringify(out));
