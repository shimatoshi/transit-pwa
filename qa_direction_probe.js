#!/usr/bin/env node
/* qa_direction_probe.js — qa_direction.js (2) が挙げた「片方向しか列車が無い区間」を
 * 1件ずつルーターに掛け、その向きに実際に行けるかを見る。
 *
 * graph_v2.edges には「特急が通過駅を飛ばした結果できた見かけの隣接」
 * (例: 飯田線 平岡–伊那小沢。実際は間に鶯巣がある) も混ざっている。
 * そういう区間は隣駅経由で普通に行けるので欠落ではない。ここで両者を仕分ける。
 *
 * Usage: node qa_direction_probe.js
 */
'use strict';
const fs = require('fs');
const R = require('./router_v3.js');
const C = require('./qa_coverage.js');
const { g, m, ntrips, tripOff, rawS } = C;

const fares = JSON.parse(fs.readFileSync(__dirname + '/fares.json', 'utf8'));
const buf = fs.readFileSync(__dirname + '/trains_v3.bin');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
R.loadBinary(ab, m, g.stations, fares);

const cnt = new Set();
for (let t = 0; t < ntrips; t++) {
  if (m.trips.m && m.trips.m[t] === 1) continue;
  for (let i = tripOff[t]; i < tripOff[t + 1] - 1; i++) cnt.add(`${rawS[i]}>${rawS[i + 1]}`);
}
const seen = new Set(), gaps = [];
for (const [k, arr] of Object.entries(g.edges)) {
  const a = +k;
  for (const [b, , line] of arr) {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const f = cnt.has(`${a}>${b}`), r = cnt.has(`${b}>${a}`);
    if (f && r) continue;
    const [from, to] = f ? [a, b] : [b, a];
    gaps.push({ line, from: to, to: from });  // 列車が無い向き = to→from
  }
}

const nm = i => g.stations[i].n;
const fmt = x => `${String(Math.floor(x / 60) % 24).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
let ok = 0, ng = 0;
const bad = [];
for (const x of gaps) {
  // 平日10:00発。鉄道のみ(バス代行に逃げられると欠落が隠れる)
  const js = R.findJourneys(x.from, x.to, 600, { day: 0, noBus: true });
  const j = js && js[0];
  const rail = j && j.legs.some(l => l.kind === 'ride');
  if (rail) {
    ok++;
    console.log(`  OK   ${x.line} ${nm(x.from)}→${nm(x.to)}  ` +
      `${fmt(j.dep)}→${fmt(j.arr)} ${j.arr - j.dep}分 ` +
      j.legs.filter(l => l.kind === 'ride').map(l => l.line).join('/'));
  } else {
    ng++;
    bad.push(x);
  }
}
console.log(`\n=== 片方向欠落 ${gaps.length}件: 隣駅経由などで行ける ${ok} / 行けない ${ng} ===`);
bad.forEach(x => console.log(`  NG   ${x.line} ${nm(x.from)}→${nm(x.to)}`));
if (ng) {
  console.error(`\nNG: その向きに鉄道で行けない区間が ${ng}件あります。` +
    '\n    python3 gapfill_reverse.py で逆方向を取り直してください。');
  process.exit(1);
}
console.log('OK: 逆向きに行けない区間はありません。');
