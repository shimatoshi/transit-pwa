#!/usr/bin/env node
/* test_router_v3.js — CSAルーターのオフラインテスト
 * Usage: node test_router_v3.js [出発駅 到着駅 [HH:MM]]
 * 引数なしでジョルダン照合込みのテストマトリクス実行
 */
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('./router_v3.js');

const BASE = __dirname;
const graph = JSON.parse(fs.readFileSync(path.join(BASE, 'graph_v2.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(BASE, 'trains_v3_meta.json'), 'utf8'));
const fares = JSON.parse(fs.readFileSync(path.join(BASE, 'fares.json'), 'utf8'));
const buf = fs.readFileSync(path.join(BASE, 'trains_v3.bin'));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const t0 = Date.now();
R.loadBinary(ab, meta, graph.stations, fares);
console.error(`[load ${Date.now() - t0}ms, ${R.data.nConn} connections]`);

function idOf(name) {
  const strip = s => s.replace(/[（(].*?[）)]/g, '');
  for (let i = 0; i < graph.stations.length; i++) {
    if (graph.stations[i].n === name) return i;
  }
  for (let i = 0; i < graph.stations.length; i++) {
    if (strip(graph.stations[i].n) === strip(name)) return i;
  }
  return -1;
}

const fmt = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function describe(j) {
  const fare = R.journeyFare(j);
  const km = R.journeyKm(j);
  const legsStr = j.legs.map(l => {
    if (l.kind === 'walk') return `徒歩${l.min}分`;
    const nm = i => graph.stations[i].n;
    return `${l.line}${l.type ? '[' + l.type + ']' : ''} ${nm(l.from)}${fmt(l.dep)}→${nm(l.to)}${fmt(l.arr)} (${l.stops.length - 1}駅, ${l.dest}行)`;
  }).join(' / ');
  return {
    summary: `${fmt(j.dep)}→${fmt(j.arr)} ${j.arr - j.dep}分 乗換${j.transfers} ${km.toFixed(1)}km ¥${fare.total}`,
    legsStr, dep: j.dep, arr: j.arr, transfers: j.transfers, fare: fare.total,
  };
}

// --- CLI ---
const args = process.argv.slice(2);
if (args.length >= 2) {
  const t = args[2] ? args[2].split(':') : ['9', '0'];
  const start = (+t[0]) * 60 + (+t[1] || 0);
  const s = idOf(args[0]), g = idOf(args[1]);
  if (s < 0 || g < 0) { console.log('駅が見つからない'); process.exit(1); }
  const js = R.findJourneys(s, g, start, {});
  if (!js.length) { console.log('経路なし'); process.exit(1); }
  for (const j of js.slice(0, 5)) {
    const d = describe(j);
    console.log(d.summary);
    console.log('   ' + d.legsStr);
  }
  process.exit(0);
}

// --- テストマトリクス (expectDep/expectArr はジョルダン照合) ---
const CASES = [
  // 04:58発総武快速経由05:58着はジョルダン1位(06:04着)より早い実在経路
  { from: '高柳', to: '上野', at: 100, expectDep: [290, 315], expectArr: [350, 365], note: 'ジョルダン1位: 05:13→06:04' },
  // TX 05:32は乗換4分で間に合わない(野田線は柏スイッチバック)→常磐線05:52が正
  { from: '高柳', to: '北千住', at: 100, expectDep: [313, 313], expectArr: [350, 354], note: '実勢: 05:13→05:52' },
  { from: '柏', to: '東京', at: 540, expectMin: [25, 50] },
  { from: '北千住', to: 'つくば', at: 540, expectMin: [30, 70] },
  { from: '新宿', to: '横浜', at: 540, expectMin: [25, 60] },
  { from: '東京', to: '新大阪', at: 540, expectMin: [140, 200] },
  { from: '渋谷', to: '吉祥寺', at: 540, expectMin: [15, 40] },
  { from: '札幌', to: '小樽', at: 540, expectMin: [30, 80] },
  { from: '上野', to: '日暮里', at: 540, expectMin: [2, 15] },
  { from: '鹿児島中央', to: '博多', at: 540, expectMin: [85, 130] },
];

let fail = 0;
for (const c of CASES) {
  const s = idOf(c.from), g = idOf(c.to);
  if (s < 0 || g < 0) { console.log(`✗ ${c.from}→${c.to}: 駅なし`); fail++; continue; }
  const js = R.findJourneys(s, g, c.at, {});
  if (!js.length) { console.log(`✗ ${c.from}→${c.to}: 経路なし`); fail++; continue; }
  const d = describe(js[0]);
  let ok = true, why = [];
  if (c.expectDep && (d.dep < c.expectDep[0] || d.dep > c.expectDep[1])) {
    ok = false; why.push(`発${fmt(d.dep)}≠${fmt(c.expectDep[0])}`);
  }
  if (c.expectArr && (d.arr < c.expectArr[0] || d.arr > c.expectArr[1])) {
    ok = false; why.push(`着${fmt(d.arr)}が範囲外`);
  }
  if (c.expectMin) {
    const tot = d.arr - d.dep;
    if (tot < c.expectMin[0] || tot > c.expectMin[1]) { ok = false; why.push(`${tot}分が範囲外`); }
  }
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${c.from}→${c.to}: ${d.summary}${why.length ? '  [' + why.join(', ') + ']' : ''}${c.note ? '  (' + c.note + ')' : ''}`);
  console.log('   ' + d.legsStr);
}
console.log(fail === 0 ? '\nALL OK' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
