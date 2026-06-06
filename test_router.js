#!/usr/bin/env node
/* test_router.js — offline sanity tests for router.js + graph_v2.json.
 * Usage: node test_router.js [出発駅 到着駅 [HH:MM]]
 * With no args, runs the built-in test matrix with expected-time ranges.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Router = require('./router.js');

const BASE = __dirname;
function load(name) {
  return JSON.parse(fs.readFileSync(path.join(BASE, name), 'utf8'));
}

const graph = load('graph_v2.json');
Router.setData('graph', graph);
Router.setData('freq', load('frequency.json'));
Router.setData('trainTypes', load('train_types.json'));
Router.setData('fares', load('fares.json'));
Router.setData('timetable', load('timetable_v2.json'));
Router.setData('through', load('through_service.json'));

function findAllByName(name) {
  const strip = s => s.replace(/[（(].*?[）)]/g, '');
  const ids = [];
  for (let i = 0; i < graph.stations.length; i++) {
    if (graph.stations[i].n === name) ids.push(i);
  }
  if (!ids.length) { // fallback: match with paren suffix stripped (札幌(ＪＲ) etc.)
    for (let i = 0; i < graph.stations.length; i++) {
      if (strip(graph.stations[i].n) === strip(name)) ids.push(i);
    }
  }
  return ids;
}

function fmt(min) {
  const h = Math.floor(min / 60) % 24, m = Math.round(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function describeRoute(r, startMinutes) {
  const segs = Router.detectLineSegments(r.path);
  const times = Router.calculateTimes(r.path, segs, startMinutes);
  const fare = Router.calculateFare(r.path, segs);
  const dep = times[0].depTime, arr = times[times.length - 1].arrTime;
  let transfers = 0;
  for (let i = 1; i < segs.length; i++) {
    if (!Router.isThroughService(segs[i - 1].line, segs[i].line)) transfers++;
  }
  const km = Router.pathKm(r.path, 0, r.path.length - 1);
  const lines = segs.map((s, i) => {
    const t = times[i];
    const type = t.trainType ? `[${t.trainType}]` : '';
    const tt = t.fromTimetable ? '' : '≈';
    return `${s.line}${type}(${fmt(t.depTime)}${tt}→${fmt(t.arrTime)}, ${s.to - s.from}駅${t.waitTime ? `, 待${t.waitTime}` : ''})`;
  }).join(' / ');
  return {
    summary: `${fmt(dep)}→${fmt(arr)} ${arr - dep}分 乗換${transfers} ${km.toFixed(1)}km ¥${fare ? fare.total : '?'}`,
    lines, totalMin: arr - dep, transfers, km, fare: fare ? fare.total : null,
    segCount: segs.length,
  };
}

function searchBest(fromName, toName, startMinutes) {
  const fids = findAllByName(fromName), tids = findAllByName(toName);
  if (!fids.length) throw new Error(`station not found: ${fromName}`);
  if (!tids.length) throw new Error(`station not found: ${toName}`);
  const all = [];
  for (const f of fids) for (const t of tids) {
    if (f === t) continue;
    all.push(...Router.findKRoutes(f, t, 6));
  }
  const seen = new Set();
  const unique = [];
  for (const r of all) {
    const segs = Router.detectLineSegments(r.path);
    const sig = segs.map(s => s.line).join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    const d = describeRoute(r, startMinutes);
    unique.push({ r, d });
  }
  unique.sort((a, b) => {
    const td = a.d.totalMin - b.d.totalMin;
    if (Math.abs(td) > 5) return td;
    return a.d.transfers - b.d.transfers;
  });
  return unique;
}

// --- CLI mode ---
const args = process.argv.slice(2);
if (args.length >= 2) {
  const t = args[2] ? args[2].split(':') : ['9', '0'];
  const start = (+t[0]) * 60 + (+t[1] || 0);
  const routes = searchBest(args[0], args[1], start);
  if (!routes.length) { console.log('経路なし'); process.exit(1); }
  for (const { d } of routes.slice(0, 4)) {
    console.log(d.summary);
    console.log('   ' + d.lines);
  }
  process.exit(0);
}

// --- built-in test matrix ---
// expectMin: plausible total-minutes range (generous: includes waits)
const CASES = [
  { from: '柏', to: '東京', at: 9 * 60, expectMin: [25, 70], maxTransfers: 2 },
  { from: '北千住', to: 'つくば', at: 9 * 60, expectMin: [30, 80], maxTransfers: 1 },   // TX: v1で欠けてた接続
  { from: '新宿', to: '横浜', at: 9 * 60, expectMin: [25, 70], maxTransfers: 2 },
  { from: '我孫子', to: '成田', at: 9 * 60, expectMin: [30, 90], maxTransfers: 1 },     // 成田線直通
  { from: '東京', to: '新大阪', at: 9 * 60, expectMin: [140, 240], maxTransfers: 1 },   // 新幹線
  { from: '渋谷', to: '吉祥寺', at: 9 * 60, expectMin: [15, 50], maxTransfers: 1 },     // 井の頭線
  { from: '札幌', to: '小樽', at: 9 * 60, expectMin: [30, 90], maxTransfers: 1 },
  { from: '上野', to: '日暮里', at: 9 * 60, expectMin: [2, 20], maxTransfers: 1 },
  // 方面グループ混在の回帰テスト: 深夜検索で柏方面始発05:13を拾うこと
  // （旧データは船橋行04:50を誤って返していた）
  { from: '高柳', to: '北千住', at: 1 * 60 + 40, expectMin: [25, 60], maxTransfers: 2,
    expectDep: [5 * 60 + 10, 5 * 60 + 20] },
];

let fail = 0;
for (const c of CASES) {
  let routes;
  try {
    routes = searchBest(c.from, c.to, c.at);
  } catch (e) {
    console.log(`✗ ${c.from}→${c.to}: ${e.message}`);
    fail++;
    continue;
  }
  if (!routes.length) {
    console.log(`✗ ${c.from}→${c.to}: 経路なし`);
    fail++;
    continue;
  }
  const best = routes[0].d;
  const okTime = best.totalMin >= c.expectMin[0] && best.totalMin <= c.expectMin[1];
  const okTr = best.transfers <= c.maxTransfers;
  const dep = parseInt(best.summary.slice(0, 2), 10) * 60 + parseInt(best.summary.slice(3, 5), 10);
  const okDep = !c.expectDep || (dep >= c.expectDep[0] && dep <= c.expectDep[1]);
  const mark = okTime && okTr && okDep ? '✓' : '✗';
  if (!(okTime && okTr && okDep)) fail++;
  console.log(`${mark} ${c.from}→${c.to}: ${best.summary}` +
    (okTime ? '' : `  [時間が範囲外 ${c.expectMin[0]}-${c.expectMin[1]}分]`) +
    (okTr ? '' : `  [乗換多すぎ >${c.maxTransfers}]`) +
    (okDep ? '' : `  [発時刻が範囲外 ${fmt(c.expectDep[0])}-${fmt(c.expectDep[1])}]`));
  console.log(`   ${best.lines}`);
}

console.log(fail === 0 ? '\nALL OK' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
